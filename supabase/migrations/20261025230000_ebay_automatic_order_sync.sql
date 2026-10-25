begin;
set local lock_timeout='3s';
set local statement_timeout='30s';

alter table public.ebay_order_sync_runs add column automatic boolean not null default false;
create table public.ebay_order_auto_sync (
 singleton boolean primary key default true check(singleton),
 enabled boolean not null default false,
 next_sync_at timestamptz not null default now(),
 last_started_at timestamptz, last_synced_at timestamptz, last_error text,
 last_run_id uuid references public.ebay_order_sync_runs(id),
 dispatch_token uuid, lease_until timestamptz, claimed boolean not null default false,
 automatic boolean not null default false
);
insert into public.ebay_order_auto_sync(singleton) values(true);
alter table public.ebay_order_auto_sync enable row level security;
revoke all on public.ebay_order_auto_sync from public,anon,authenticated;
grant select,update on public.ebay_order_auto_sync to service_role;

-- Recheck work state when the rows are locked, not only in the earlier API
-- snapshot. An import racing a staff checkout cannot reopen a completed line.
create function public.upsert_ebay_order_sync_lines(_rows jsonb) returns setof public.ebay_order_lines
language plpgsql security definer set search_path='' as $$
begin
 if jsonb_typeof(_rows) is distinct from 'array' or jsonb_array_length(_rows)>10000 then raise exception 'Invalid eBay line batch';end if;
 return query
 insert into public.ebay_order_lines as saved(order_id,item_number,transaction_id,item_title,custom_label,quantity,sold_for,
  shipping_and_handling,total_price,net_payout,line_status,internal_item_id,raw_payload)
 select x.order_id,x.item_number,x.transaction_id,x.item_title,x.custom_label,x.quantity,x.sold_for,
  x.shipping_and_handling,x.total_price,x.net_payout,'pending',x.internal_item_id,x.raw_payload
 from jsonb_populate_recordset(null::public.ebay_order_lines,_rows) x
 join public.ebay_orders o on o.id=x.order_id and o.status not in('fulfilled','cancelled','archived')
 on conflict(order_id,item_number,transaction_id) do update set
  item_title=excluded.item_title,custom_label=excluded.custom_label,quantity=greatest(excluded.quantity,saved.fulfilled_quantity),
  sold_for=excluded.sold_for,shipping_and_handling=excluded.shipping_and_handling,total_price=excluded.total_price,
  net_payout=coalesce(excluded.net_payout,saved.net_payout),
  internal_item_id=coalesce(saved.internal_item_id,excluded.internal_item_id),
  raw_payload=saved.raw_payload||excluded.raw_payload
 where saved.line_status not in('fulfilled','cancelled','skipped')
 returning saved.*;
end$$;
revoke all on function public.upsert_ebay_order_sync_lines(jsonb) from public,anon,authenticated;
grant execute on function public.upsert_ebay_order_sync_lines(jsonb) to service_role;

-- Manual imports and scheduled imports share one lease. Finance has its own
-- independent queue and never takes this order-import lease.
create function public.claim_ebay_order_sync(_token uuid,_automatic boolean) returns boolean
language plpgsql security definer set search_path='' as $$
begin
 if _token is null then return false;end if;
 if _automatic then
  update public.ebay_order_auto_sync set claimed=true,last_started_at=now()
  where singleton and enabled and automatic and dispatch_token=_token and lease_until>now() and not claimed;
 else
  update public.ebay_order_auto_sync set dispatch_token=_token,lease_until=now()+interval '10 minutes',claimed=true,automatic=false
  where singleton and (lease_until is null or lease_until<=now());
 end if;
 return found;
end$$;

create function public.finish_ebay_order_sync(_token uuid,_run_id uuid,_error text default null) returns boolean
language plpgsql security definer set search_path='' as $$
declare w public.ebay_order_auto_sync; r public.ebay_order_sync_runs; failure text;
begin
 select * into w from public.ebay_order_auto_sync where singleton and dispatch_token=_token and claimed for update;
 if not found then return false;end if;
 if w.automatic then
  select * into r from public.ebay_order_sync_runs where id=_run_id and automatic and not dry_run;
  failure:=case when _error is not null then left(_error,400) when r.status is distinct from 'completed' then 'The eBay sync did not finish. Automatic retry is scheduled.' else null end;
  update public.ebay_order_auto_sync set last_run_id=_run_id,last_error=failure,
   last_synced_at=case when failure is null then now() else last_synced_at end,
   next_sync_at=now()+interval '5 minutes' where singleton;
 end if;
 update public.ebay_order_auto_sync set dispatch_token=null,lease_until=null,claimed=false,automatic=false where singleton;
 return true;
end$$;

create function public.dispatch_ebay_order_sync() returns void
language plpgsql security definer set search_path='' as $$
declare w public.ebay_order_auto_sync; token uuid;
begin
 select * into w from public.ebay_order_auto_sync where singleton for update skip locked;
 if not found or not w.enabled or w.lease_until>now() or w.next_sync_at>now() then return;end if;
 token:=gen_random_uuid();
 update public.ebay_order_auto_sync set dispatch_token=token,lease_until=now()+interval '10 minutes',claimed=false,automatic=true,
  last_error=case when w.claimed and w.automatic then 'The previous eBay sync timed out. Retrying automatically.' else last_error end where singleton;
 perform net.http_post(url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-order-sync',
  headers:='{"Content-Type":"application/json"}'::jsonb,body:=jsonb_build_object('orderWorkerToken',token),timeout_milliseconds:=120000);
end$$;

create function public.get_ebay_order_auto_sync_status() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare w public.ebay_order_auto_sync;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 select * into w from public.ebay_order_auto_sync where singleton;
 return jsonb_build_object('enabled',w.enabled,'last_synced_at',w.last_synced_at,'last_error',w.last_error,
  'syncing',coalesce(w.lease_until>now(),false),'next_sync_at',w.next_sync_at,
  'can_control',exists(select 1 from public.employees where user_id=auth.uid() and role='admin' and active is distinct from false));
end$$;

create function public.control_ebay_order_auto_sync(_action text) returns void
language plpgsql security definer set search_path='' as $$
begin
 if not public.can_manage_inventory() then raise exception 'Inventory staff access required' using errcode='42501';end if;
 if _action not in('sync','pause','resume') or _action is null then raise exception 'Unknown eBay sync action';end if;
 if _action in('pause','resume') and not exists(select 1 from public.employees where user_id=auth.uid() and role='admin' and active is distinct from false)
 then raise exception 'Administrator access required' using errcode='42501';end if;
 update public.ebay_order_auto_sync set enabled=case when _action='pause' then false when _action='resume' then true else enabled end,
  next_sync_at=case when _action='pause' then next_sync_at else now() end where singleton;
 if _action<>'pause' then perform public.dispatch_ebay_order_sync();end if;
end$$;

revoke all on function public.claim_ebay_order_sync(uuid,boolean),public.finish_ebay_order_sync(uuid,uuid,text),public.dispatch_ebay_order_sync() from public,anon,authenticated;
grant execute on function public.claim_ebay_order_sync(uuid,boolean),public.finish_ebay_order_sync(uuid,uuid,text),public.dispatch_ebay_order_sync() to service_role;
revoke all on function public.get_ebay_order_auto_sync_status(),public.control_ebay_order_auto_sync(text) from public,anon;
grant execute on function public.get_ebay_order_auto_sync_status(),public.control_ebay_order_auto_sync(text) to authenticated;

-- One-minute dispatch checks allow a queued request to start promptly; completed
-- runs set next_sync_at five minutes ahead. Enable after deploying the handler.
select cron.schedule('invsto-ebay-orders','* * * * *','select public.dispatch_ebay_order_sync();');
commit;
