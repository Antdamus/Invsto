begin;
set local lock_timeout='8s';
create table public.weekly_ebay_change_cursor(
 singleton boolean primary key default true check(singleton), through_at timestamptz not null,
 window_end timestamptz, page_offset integer not null default 0, next_at timestamptz not null default now(), last_success timestamptz, last_error text
);
insert into public.weekly_ebay_change_cursor(through_at)
values((date_trunc('month',now() at time zone 'America/New_York')-interval '1 month 7 days') at time zone 'America/New_York');
create table public.weekly_ebay_sale_updates(
 order_number text primary key,modified_at timestamptz not null,changes jsonb not null
);
alter table public.weekly_ebay_change_cursor enable row level security;
alter table public.weekly_ebay_sale_updates enable row level security;
revoke all on public.weekly_ebay_change_cursor,public.weekly_ebay_sale_updates from public,anon,authenticated;
grant select on public.weekly_ebay_change_cursor to service_role;

create function public.save_weekly_ebay_change_page(_ticket uuid,_from timestamptz,_until timestamptz,_orders jsonb,_advance boolean,_error boolean,_next_offset integer default 0)
returns void language plpgsql security definer set search_path='' as $$
declare affected text[];begin
 if not exists(select 1 from public.ebay_finance_worker where singleton and dispatch_token=_ticket and lease_until>now() and claimed_at is not null) then raise exception 'Expired finance worker';end if;
 perform 1 from public.weekly_ebay_change_cursor where singleton and through_at=_from for update;
 if not found then return;end if;
 if _until<=_from or _until>now() or jsonb_typeof(_orders) is distinct from 'array' or jsonb_array_length(_orders)>200 then raise exception 'Invalid adjustment window';end if;
 if _error or (not _advance and _next_offset=0) then
  update public.weekly_ebay_change_cursor set window_end=_until,next_at=now()+case when _error then interval '5 minutes' else interval '0' end,
   last_error=case when _error then 'eBay change check incomplete; retry scheduled' end where singleton;
  return;
 end if;
 with changed as (
  insert into public.weekly_ebay_sale_updates as saved(order_number,modified_at,changes)
  select r.order_number,r.modified_at,r.changes from jsonb_to_recordset(_orders) as r(order_number text,modified_at timestamptz,changes jsonb)
  join public.ebay_orders o on o.order_number=r.order_number
  where r.modified_at>=_from and r.modified_at<_until and (
   r.changes->>'orderPaymentStatus' in ('REFUNDED','FULLY_REFUNDED','PARTIALLY_REFUNDED')
   or r.changes->>'orderCancelStatus' in ('CANCELED','CANCELLED','CANCEL_CLOSED_WITH_REFUND')
   or jsonb_array_length(coalesce(r.changes->'refunds','[]'))>0
   or exists(select 1 from public.weekly_ebay_sale_updates prior where prior.order_number=r.order_number))
  on conflict(order_number) do update set modified_at=excluded.modified_at,changes=excluded.changes
  where excluded.modified_at>saved.modified_at or (excluded.modified_at=saved.modified_at and saved.changes is distinct from excluded.changes)
  returning order_number
 ) select array_agg(order_number) into affected from changed;
 if affected is not null then perform public.enqueue_ebay_finance_jobs(affected,false);end if;
 update public.weekly_ebay_change_cursor set through_at=case when not _advance then _from when _until>=now()-interval '4 minutes' then greatest(_from+interval '1 millisecond',_until-interval '2 minutes') else _until end,
  window_end=case when not _advance then _until end,page_offset=_next_offset,
  next_at=case when _advance and _until>=now()-interval '4 minutes' then now()+interval '5 minutes' else now() end,last_success=now(),last_error=null where singleton;
end$$;
revoke all on function public.save_weekly_ebay_change_page(uuid,timestamptz,timestamptz,jsonb,boolean,boolean,integer) from public,anon,authenticated;
grant execute on function public.save_weekly_ebay_change_page(uuid,timestamptz,timestamptz,jsonb,boolean,boolean,integer) to service_role;

-- Merge the newer eBay financial facts for reporting only. Packing, inventory,
-- and the saved original order stay untouched by the change scan.
create function public.weekly_ebay_adjusted_payload(original jsonb,modified timestamptz,changes jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare source_order jsonb:=coalesce(original->'order','{}');begin
 if modified is null or public.weekly_sales_local_time(source_order->>'lastModifiedDate')>modified at time zone 'UTC' then return original;end if;
 if jsonb_array_length(coalesce(changes->'refunds','[]'))>0 then
  source_order:=source_order||jsonb_build_object('paymentSummary',coalesce(source_order->'paymentSummary','{}')||jsonb_build_object('refunds',changes->'refunds'));
 end if;
 if changes ? 'total' then source_order:=source_order||jsonb_build_object('pricingSummary',coalesce(source_order->'pricingSummary','{}')||jsonb_build_object('total',changes->'total'));end if;
 return coalesce(original,'{}')||jsonb_strip_nulls(jsonb_build_object('orderPaymentStatus',changes->>'orderPaymentStatus','orderCancelStatus',changes->>'orderCancelStatus'))||jsonb_build_object('order',source_order);
end$$;
revoke all on function public.weekly_ebay_adjusted_payload(jsonb,timestamptz,jsonb) from public,anon,authenticated;
do $$declare f text:=pg_get_functiondef('public.weekly_sales_order_rows(date,date)'::regprocedure);
 old text:='from public.ebay_orders o where o.sale_date>=_start';begin
 if strpos(f,old)=0 then raise exception 'Unexpected weekly eBay order source';end if;
 execute replace(f,old,$src$from (select stored.id,stored.order_number,stored.status,stored.sale_date,stored.paid_on_date,stored.total_price,stored.buyer_username,
  case when changed.order_number is null then stored.raw_payload else public.weekly_ebay_adjusted_payload(stored.raw_payload,changed.modified_at,changed.changes) end as raw_payload
  from public.ebay_orders stored left join public.weekly_ebay_sale_updates changed using(order_number)) o where o.sale_date>=_start$src$);
end$$;

do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);begin
 if strpos(f,'''seller_hub'',')=0 then raise exception 'Unexpected monthly report source';end if;
 execute replace(f,'''seller_hub'',',$extra$'ebay_adjustments',case when _market in ('all','ebay') then (select jsonb_build_object('through',through_at,'checked',last_success,'error',last_error) from public.weekly_ebay_change_cursor where singleton) end,'seller_hub',$extra$);
end$$;

-- The existing finance cron and single-use lease also service this read-only
-- cursor when there are no individual finance jobs in the queue.
do $$declare f text:=pg_get_functiondef('public.dispatch_ebay_finance_worker()'::regprocedure);
 old text:='(state=''working'' and lease_until<=now())) then return';begin
 if strpos(f,old)=0 then raise exception 'Unexpected finance dispatcher';end if;
 execute replace(f,old,'(state=''working'' and lease_until<=now())) and not exists(select 1 from public.weekly_ebay_change_cursor where next_at<=now()) then return');
end$$;
notify pgrst,'reload schema';
commit;
