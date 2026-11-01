begin;

-- Seller Hub observations supplement the Finance API when a receipt or a more
-- recent funds status is available there. They never contribute to proceeds.
create table public.weekly_ebay_payment_observations (
 order_number text primary key,
 funds text not null check (funds in ('available','held','processing','paid_out','initiated','mixed','unknown')),
 checked_at timestamptz not null
);
create table public.weekly_ebay_outbound_fedex (
 order_number text not null, tracking_number text not null, checked_at timestamptz not null,
 primary key(order_number,tracking_number)
);
alter table public.weekly_ebay_payment_observations enable row level security;
alter table public.weekly_ebay_outbound_fedex enable row level security;
revoke all on public.weekly_ebay_payment_observations,public.weekly_ebay_outbound_fedex from public,anon,authenticated;
grant select,insert,update on public.weekly_ebay_payment_observations,public.weekly_ebay_outbound_fedex to service_role;

create function public.weekly_ebay_payment_detail(
 _number text,_raw jsonb,_paid_on timestamptz,_booked numeric,_refunded numeric,
 _hub_state text,_hub_at timestamptz,_fedex boolean
) returns jsonb language sql stable set search_path='' as $$
 with sale as (
  select distinct case t->>'transactionStatus'
   when 'FUNDS_ON_HOLD' then 'held'
   when 'FUNDS_AVAILABLE_FOR_PAYOUT' then 'available'
   when 'FUNDS_PROCESSING' then 'processing'
   when 'PAYOUT_INITIATED' then 'initiated'
   when 'PAYOUT' then 'paid_out'
   when 'PAID_OUT' then 'paid_out'
   else 'unknown' end as state
  from jsonb_array_elements(case when jsonb_typeof(_raw#>'{ebayFinance,transactions}')='array'
   then _raw#>'{ebayFinance,transactions}' else '[]'::jsonb end) t
  where t->>'transactionType'='SALE' and t->>'bookingEntry'='CREDIT'
   and t->>'transactionStatus' is distinct from 'FAILED'
   and (t->>'orderNumber'=_number or (nullif(t->>'orderNumber','') is null
     and _raw#>>'{ebayFinance,orderNumber}'=_number and _raw#>>'{ebayFinance,source}'='ebay_finances_api'))
 ), facts as (
  select upper(coalesce(nullif(_raw->>'orderPaymentStatus',''),_raw#>>'{order,orderPaymentStatus}',
   _raw#>>'{api_order_status,payment_status}','')) as pay,
   coalesce(jsonb_path_exists(_raw,'$.order.paymentSummary.payments[*] ? (@.paymentStatus == "PAID")'),false) as payment_receipt,
   public.weekly_sales_local_time(_raw#>>'{ebayFinance,syncedAt}') at time zone 'UTC' as api_at,
   count(*)>0 as has_credit,
   case when bool_or(state='held') then 'held' when count(*)>1 then 'mixed' else coalesce(min(state),'unknown') end as api_state
  from sale
 ), resolved as (
  select *,_hub_at is not null and (api_at is null or _hub_at>=api_at or not has_credit) as use_hub from facts
 )
 select jsonb_build_object('id',_number,
  'buyer',case
   when pay in ('FULLY_REFUNDED','REFUNDED') or (_refunded>0 and _refunded>=_booked) then 'refunded'
   when pay='PARTIALLY_REFUNDED' or _refunded>0 then 'partial'
   when pay='PAID' or payment_receipt or has_credit or _hub_at is not null then 'paid'
   when _paid_on is not null and pay not in ('FAILED','PENDING','UNPAID','NOT_PAID') then 'date_only'
   else 'unknown' end,
  'funds',case when use_hub then _hub_state else api_state end,
  'checked',case when use_hub then _hub_at else api_at end,
  'source',case when use_hub then 'Seller Hub' when has_credit then 'Finances API' end,
  'fedex',_fedex) from resolved
$$;
revoke all on function public.weekly_ebay_payment_detail(text,jsonb,timestamptz,numeric,numeric,text,timestamptz,boolean) from public,anon,authenticated;

-- Reuse the original admin guard, order set, cutoff and reconciliation result.
do $$declare
 definition text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 marker text:='''ebay_adjustments'',';
begin
 if strpos(definition,marker)=0 then raise exception 'Unexpected weekly sales report definition';end if;
 execute replace(definition,marker,$add$
 'ebay_pending_payments',case when _market in ('ebay','all') then (
  select coalesce(jsonb_agg(detail || jsonb_build_object('week',date_trunc('week',o.purchased)::date)
   order by o.purchased,o.order_number),'[]'::jsonb)
  from orders o join public.ebay_orders e using(order_number)
  left join public.weekly_ebay_sale_updates u using(order_number)
  left join public.weekly_ebay_payment_observations h using(order_number)
  cross join lateral public.weekly_ebay_payment_detail(o.order_number,
   public.weekly_ebay_adjusted_payload(e.raw_payload,u.modified_at,u.changes),e.paid_on_date,
   o.booked,o.refunded,h.funds,h.checked_at,
   exists(select 1 from public.weekly_ebay_outbound_fedex f where f.order_number=e.order_number)
   or coalesce(e.label_metadata->>'carrier','') ~* 'fed[ ._-]*ex|federal express'
   or jsonb_path_exists(coalesce(e.raw_payload,'{}'),'$.shipping_reconciliation.shipments[*] ? (@.carrier like_regex "fed[ ._-]*ex|federal express" flag "i")')
  ) as detail
  where o.market='ebay' and not o.proceeds_complete and o.purchased>=m and o.purchased<end_date
 ) end,'ebay_adjustments',$add$);
end$$;
notify pgrst,'reload schema';
commit;
