begin;
set local lock_timeout='8s';
-- Line snapshots carry the order payment state. One earlier line snapshot
-- cannot turn a partially refunded multi-line order into a full refund.
do $$declare f text:=pg_get_functiondef('public.weekly_sales_order_rows(date,date)'::regprocedure);
 old text:='bool_or(upper(coalesce(raw_payload->>''orderPaymentStatus'','''')) in (''REFUNDED'',''FULLY_REFUNDED'')) line_full';
begin
 if strpos(f,old)=0 then raise exception 'Unexpected weekly line refund definition';end if;
 f:=replace(f,old,replace(old,'bool_or','bool_and')||',bool_or(upper(coalesce(raw_payload->>''orderPaymentStatus'','''')) in (''PARTIALLY_REFUNDED'',''REFUNDED'',''FULLY_REFUNDED'')) line_refund_signal');
 f:=replace(f,'coalesce(l.line_full,false) or o.pay','(coalesce(l.line_full,false) and o.pay<>''PARTIALLY_REFUNDED'') or o.pay');
 f:=replace(f,'o.pay=''PARTIALLY_REFUNDED'' or coalesce(l.finance_refund,false)','o.pay=''PARTIALLY_REFUNDED'' or coalesce(l.line_refund_signal,false) or coalesce(l.finance_refund,false)');
 execute f;
end$$;
create or replace function public.weekly_sales_proceeds(_start date,_end date)
returns table(market text,order_number text,posted numeric,complete boolean)
language sql stable set search_path='' as $$
with eb as materialized(
 select o.* from public.ebay_orders o where o.sale_date>=_start::timestamp at time zone 'America/New_York' and o.sale_date<_end::timestamp at time zone 'America/New_York'
), raw as materialized(
 select distinct on(o.order_number,t->>'transactionId') o.order_number as number,t->>'transactionId' as tid,t,
  o.raw_payload#>>'{order,pricingSummary,total,currency}' as order_currency,
  (o.raw_payload#>>'{ebayFinance,source}'='ebay_finances_api' and o.raw_payload#>>'{ebayFinance,orderNumber}'=o.order_number) as scoped
 from eb o cross join lateral jsonb_array_elements(coalesce(o.raw_payload#>'{ebayFinance,transactions}','[]')) t
 where nullif(t->>'transactionId','') is not null and coalesce(t->>'transactionStatus','')<>'FAILED'
 and t->>'transactionType' not in('PAYOUT','WITHDRAWAL','TRANSFER') order by o.order_number,t->>'transactionId'
), targets as (select distinct tid from raw), all_links as materialized (
 select k.tid,o.order_number as number,t->>'transactionType' kind,t->>'bookingEntry' entry,
  public.weekly_sales_money(trim(leading '-' from t->>'amount')) as amount,coalesce(t->>'currency',o.raw_payload#>>'{order,pricingSummary,total,currency}','USD') as currency
 from targets k join public.ebay_orders o on (o.raw_payload#>'{ebayFinance,transactionIds}') ? k.tid
 cross join lateral jsonb_array_elements(coalesce(o.raw_payload#>'{ebayFinance,transactions}','[]')) t
 where t->>'transactionId'=k.tid
 union
 select tid,number,t->>'transactionType',t->>'bookingEntry',public.weekly_sales_money(trim(leading '-' from t->>'amount')),coalesce(t->>'currency',order_currency,'USD') from raw
), allocation as (
 select tid,count(*) as n,count(distinct number)=count(*) and count(amount)=count(*) and min(amount)=max(amount) and min(kind)=max(kind)
  and min(entry)=max(entry) and bool_and(currency='USD') as consistent
 from all_links group by tid
), ranked as (
 select tid,number,row_number() over(partition by tid order by number) rank from(select distinct tid,number from all_links) d
), classified as (
 select r.number,r.t->>'transactionType' as kind,r.t->>'bookingEntry' as entry,r.t->>'transactionStatus' as state,
  a.consistent and (a.n=1 or r.t->>'transactionType'='SHIPPING_LABEL') and
  (r.t->>'orderNumber'=r.number or r.scoped and nullif(r.t->>'orderNumber','') is null) as linked,
  round(public.weekly_sales_money(trim(leading '-' from r.t->>'amount'))*100)::bigint as cents,a.n,ranked.rank
 from raw r join allocation a using(tid) join ranked on ranked.tid=r.tid and ranked.number=r.number
), entries as (
 select *,case when linked and entry in ('DEBIT','CREDIT') then
  (case when entry='DEBIT' then -1 else 1 end)*(cents/n+case when rank<=cents%n then 1 else 0 end)/100.0 end as signed
 from classified
), ledger as (
 select number,bool_or(kind='SALE' and entry='CREDIT') as sale,bool_or(kind='REFUND' and entry='DEBIT') as refund,
  -sum(signed) filter(where kind='REFUND' and entry='DEBIT') as refund_debits,
  bool_or(kind='SHIPPING_LABEL' and entry='DEBIT' and cents>0 and linked) as postage,
  bool_and(signed is not null and coalesce(state in('FUNDS_AVAILABLE_FOR_PAYOUT','PAYOUT','COMPLETED','PAID_OUT','FUNDS_ON_HOLD','FUNDS_PROCESSING','PAYOUT_INITIATED'),false)) as reliable,
  sum(signed) filter(where state in('FUNDS_AVAILABLE_FOR_PAYOUT','PAYOUT','COMPLETED','PAID_OUT','FUNDS_ON_HOLD','FUNDS_PROCESSING','PAYOUT_INITIATED')) balance
 from entries group by number
), evidence as (
 select o.order_number,l.balance,l.refund_debits,
  case when o.raw_payload#>>'{order,pricingSummary,deliveryCost,currency}'='USD' then public.weekly_sales_money(o.raw_payload#>>'{order,pricingSummary,deliveryCost,value}') end as shipping,
  coalesce(l.sale and l.reliable and
  (upper(coalesce(o.raw_payload->>'orderPaymentStatus','')) not in('REFUNDED','PARTIALLY_REFUNDED','FULLY_REFUNDED') or l.refund) and
  (l.postage or (upper(o.raw_payload->>'orderCancelStatus') in('CANCELED','CANCELLED') and upper(o.raw_payload->>'orderFulfillmentStatus')='NOT_STARTED')) and
  jsonb_array_length(coalesce(o.raw_payload#>'{ebayFinance,transactionIds}','[]'))<=jsonb_array_length(coalesce(o.raw_payload#>'{ebayFinance,transactions}','[]')) and
  not exists(select 1 from jsonb_array_elements(coalesce(o.raw_payload#>'{ebayFinance,transactions}','[]')) t where nullif(t->>'transactionId','') is null),false) as complete
 from eb o left join ledger l on l.number=o.order_number
), adjusted as (
 select e.*,o.booked-o.cancelled-o.refunded as remaining,o.cancelled+o.refunded as reversed,o.needs_review,
  official.earnings,abs(official.refunds) as official_refund
 from evidence e join public.weekly_sales_order_rows(_start,_end) o on o.market='ebay' and o.order_number=e.order_number
 left join public.weekly_ebay_order_earnings official on official.order_number=e.order_number
  and official.checked_at>=statement_timestamp()-interval '7 days'
), reconciled as (
 select *,
  -- A sale and a postage charge can remain in the ledger after the order has
  -- been reversed. Only release a positive balance supported by that reversal.
  not needs_review and earnings is not null and (reversed=0 or
   (official_refund>=reversed and earnings<=remaining+coalesce(shipping,0))) as official_ok,
  not needs_review and complete and (reversed=0 or
   (refund_debits>=reversed and balance<=remaining+coalesce(shipping,0))) as ledger_ok
 from adjusted
)
select 'ebay',order_number,case when official_ok then earnings when ledger_ok then balance
 else least(0,earnings,balance) end,coalesce(official_ok or ledger_ok,false) from reconciled
union all
select s.market,s.order_number,sum(s.amount),bool_and(s.currency='USD' and
 ((s.market='tiktok' and s.kind='order_statement' and s.checked_at>statement_timestamp()-interval '7 days') or
  (s.market='whatnot' and f.state='ready' and f.through_at>=statement_timestamp()-interval '1 day' and w.purchased_at>=(f.progress->>'coverage_start')::timestamptz)))
 and (s.market='tiktok' or bool_or(s.amount>0 and s.kind~*'sale|earn|order'))
from public.weekly_sales_settlements s left join public.weekly_sales_feed f on f.market=s.market
 left join public.whatnot_orders w on s.market='whatnot' and w.id=s.order_number group by s.market,s.order_number
$$;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);begin
 if strpos(f,'''previous_proceeds'',')=0 then raise exception 'Unexpected weekly comparison definition';end if;
 execute replace(f,'''previous_proceeds'',',$extra$
 'focus_unsettled',(select count(*) from orders where purchased>=anchor and purchased<=cutoff and not proceeds_complete),
 'previous_unsettled',(select count(*) from orders where purchased>=anchor-7 and purchased<anchor and purchased<=anchor::timestamp-interval '7 days'+elapsed and not proceeds_complete),
 'previous_proceeds',$extra$);
end$$;
notify pgrst,'reload schema';
commit;
