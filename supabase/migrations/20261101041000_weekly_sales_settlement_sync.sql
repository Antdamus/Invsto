begin;
set local lock_timeout='5s';
alter table public.tiktok_orders add column weekly_statement_checked_at timestamptz;

create function public.save_weekly_sales_page(_market text,_expected timestamptz,_state text,_progress jsonb,_through timestamptz,_refunds jsonb,_settlements jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare current_check timestamptz;
begin
 if _market not in('tiktok','whatnot') or _state not in('permission','loading','error','ready') or jsonb_typeof(_progress) is distinct from 'object'
  or jsonb_typeof(_refunds) is distinct from 'array' or jsonb_typeof(_settlements) is distinct from 'array' then raise exception 'Invalid report page';end if;
 select checked_at into strict current_check from public.weekly_sales_feed where market=_market for update;
 if current_check is distinct from _expected then return;end if;
 insert into public.weekly_sales_refunds(market,external_id,order_number,state,item_amount,currency,source_updated_at)
 select _market,v.external_id,v.order_number,v.state,v.item_amount,v.currency,v.source_updated_at from jsonb_to_recordset(_refunds)
 as v(external_id text,order_number text,state text,item_amount numeric,currency text,source_updated_at timestamptz)
 on conflict(market,external_id) do update set state=excluded.state,item_amount=excluded.item_amount,currency=excluded.currency,source_updated_at=excluded.source_updated_at
 where public.weekly_sales_refunds.order_number=excluded.order_number and public.weekly_sales_refunds.source_updated_at<=excluded.source_updated_at;
 insert into public.weekly_sales_settlements(market,external_id,order_number,amount,currency,kind,checked_at)
 select _market,v.external_id,v.order_number,v.amount,v.currency,v.kind,v.checked_at from jsonb_to_recordset(_settlements)
 as v(external_id text,order_number text,amount numeric,currency text,kind text,checked_at timestamptz)
 on conflict(market,external_id) do update set amount=excluded.amount,currency=excluded.currency,kind=excluded.kind,checked_at=excluded.checked_at
 where public.weekly_sales_settlements.order_number=excluded.order_number and public.weekly_sales_settlements.checked_at<=excluded.checked_at;
 update public.weekly_sales_feed set state=_state,checked_at=clock_timestamp(),through_at=_through,progress=_progress where market=_market;
end$$;
create function public.save_weekly_tiktok_statement(_number text,_amount numeric) returns void language plpgsql security definer set search_path='' as $$
begin
 update public.tiktok_orders set weekly_statement_checked_at=now() where order_number=_number;
 if not found then raise exception 'Unknown TikTok order';end if;
 if _amount is null then
  update public.weekly_sales_settlements set kind='awaiting_recheck' where market='tiktok' and external_id=_number;
 else
  insert into public.weekly_sales_settlements values('tiktok',_number,_number,_amount,'USD','order_statement',now())
  on conflict(market,external_id) do update set amount=excluded.amount,kind=excluded.kind,checked_at=excluded.checked_at;
 end if;
end$$;
revoke all on function public.save_weekly_sales_page(text,timestamptz,text,jsonb,timestamptz,jsonb,jsonb),public.save_weekly_tiktok_statement(text,numeric) from public,anon,authenticated;
grant execute on function public.save_weekly_sales_page(text,timestamptz,text,jsonb,timestamptz,jsonb,jsonb),public.save_weekly_tiktok_statement(text,numeric) to service_role;

-- Marketplace holds affect payout timing. A recorded sale amount already
-- includes selling fees. Preserve the split between reconciled net earnings
-- and debits already incurred on orders whose other costs are still unknown.
do $$declare f text; old text:='(''FUNDS_AVAILABLE_FOR_PAYOUT'',''PAYOUT'',''COMPLETED'',''PAID_OUT'')';begin
 f:=pg_get_functiondef('public.weekly_sales_proceeds(date,date)'::regprocedure);
 if strpos(f,old)=0 then raise exception 'Unexpected proceeds formula';end if;
 f:=replace(f,old,'(''FUNDS_AVAILABLE_FOR_PAYOUT'',''PAYOUT'',''COMPLETED'',''PAID_OUT'',''FUNDS_ON_HOLD'',''FUNDS_PROCESSING'',''PAYOUT_INITIATED'')');
 f:=replace(f,'f.sale and f.settled and','f.sale and f.settled and
  (upper(coalesce(o.raw_payload->>''orderPaymentStatus'','''')) not in (''REFUNDED'',''PARTIALLY_REFUNDED'',''FULLY_REFUNDED'') or exists(select 1 from tx r where r.id=o.id and r.kind=''REFUND'' and r.entry=''DEBIT'')) and');
 f:=replace(f,'s.market=''tiktok'' and s.checked_at','s.market=''tiktok'' and s.kind=''order_statement'' and s.checked_at');
 execute f;
end$$;
notify pgrst,'reload schema';
commit;
