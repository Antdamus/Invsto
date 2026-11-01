begin;

-- Original sale credits are evidence of a charge, not a bank deposit or final earnings.
create table public.weekly_ebay_sale_credits (
 order_number text primary key, credit numeric not null check(credit>=0),
 items jsonb not null check(jsonb_typeof(items)='array'), checked_at timestamptz not null
);
alter table public.weekly_ebay_sale_credits enable row level security;
revoke all on public.weekly_ebay_sale_credits from public,anon,authenticated;
grant select,insert,update on public.weekly_ebay_sale_credits to service_role;

create function public.weekly_ebay_item_payments(_start date,_end date,_cutoff timestamp,_sales jsonb)
returns jsonb language sql stable set search_path='' as $$
with sales as (
 select * from jsonb_to_recordset(_sales) as s(order_number text,booked numeric,cancelled numeric,
  refunded numeric,needs_review boolean,proceeds numeric,proceeds_complete boolean)
), base as materialized (
 select e.id,e.order_number,e.sale_date,e.paid_on_date,e.buyer_username,e.status,
 public.weekly_ebay_adjusted_payload(e.raw_payload,u.modified_at,u.changes) as raw,
 h.funds,h.checked_at,c.credit,c.items as hub_items,c.checked_at as credit_at,
 s.booked,s.cancelled,s.refunded,s.needs_review,s.proceeds,s.proceeds_complete
 from public.ebay_orders e left join sales s using(order_number)
 left join public.weekly_ebay_sale_updates u using(order_number)
 left join public.weekly_ebay_payment_observations h using(order_number)
 left join public.weekly_ebay_sale_credits c using(order_number)
 where e.sale_date>=_start::timestamp at time zone 'America/New_York' and e.sale_date<_end::timestamp at time zone 'America/New_York'
 and e.sale_date at time zone 'America/New_York'<=_cutoff
), orders as materialized (
 select b.*,d->>'funds' as fund,d->>'source' as source,d->>'checked' as checked,
 case when d->>'buyer' not in ('date_only','unknown') then d->>'buyer'
 when pay in ('NOT_PAID','UNPAID') then 'unpaid' when pay='PENDING' then 'pending'
 when pay='FAILED' then 'failed' else d->>'buyer' end as buyer,
 (upper(coalesce(raw->>'orderCancelStatus',raw#>>'{order,cancelStatus,cancelState}','')) in ('CANCELED','CANCELLED','CANCEL_CLOSED_WITH_REFUND')
  or (booked>0 and cancelled=booked) or (status='cancelled' and booked is null)) as voided,
 -- A trusted order-scoped credit from the ongoing feed can supersede an older export.
 case when d->>'source'='Finances API' and a.amount is not null then a.amount else coalesce(credit,a.amount) end as amount,
 case when d->>'funds'='held' then case when d->>'source'='Seller Hub' and credit_at=checked_at then credit
   when d->>'source'='Finances API' then a.held end end as held
 from base b
 cross join lateral public.weekly_ebay_payment_detail(b.order_number,b.raw,b.paid_on_date,b.booked,b.refunded,b.funds,b.checked_at,false) d
 cross join lateral (select upper(coalesce(nullif(raw->>'orderPaymentStatus',''),raw#>>'{order,orderPaymentStatus}',raw#>>'{api_order_status,payment_status}','')) pay) ps
 left join lateral (
  select case when ok then total end amount,case when ok then on_hold end held from (
   select count(*)>0 and count(*)=count(distinct t->>'transactionId') and count(*)=count(amt)
    and coalesce(jsonb_array_length(b.raw#>'{ebayFinance,transactionIds}'),0)<=jsonb_array_length(coalesce(b.raw#>'{ebayFinance,transactions}','[]')) as ok,
    sum(amt) total,sum(amt) filter(where t->>'transactionStatus'='FUNDS_ON_HOLD') on_hold
   from jsonb_array_elements(coalesce(b.raw#>'{ebayFinance,transactions}','[]')) t
   cross join lateral (select case when t->>'currency'='USD' then public.weekly_sales_money(t->>'amount') end amt) v
   where t->>'transactionType'='SALE' and t->>'bookingEntry'='CREDIT' and t->>'transactionStatus'<>'FAILED'
   and (t->>'orderNumber'=b.order_number or (nullif(t->>'orderNumber','') is null and
    b.raw#>>'{ebayFinance,orderNumber}'=b.order_number and b.raw#>>'{ebayFinance,source}'='ebay_finances_api'))
  ) ledger
 ) a on true
), lines as (
 select o.order_number,l.id,l.item_title,l.item_number,l.transaction_id,l.quantity,l.line_status,
 count(*) over(partition by o.id) as n,count(*) over(partition by o.id,l.item_number) as same_item,
 case when coalesce(l.raw_payload#>>'{line,discountedLineItemCost,currency}',l.raw_payload#>>'{line,lineItemCost,currency}',l.raw_payload->>'Currency',l.raw_payload->>'Sale Currency','USD')='USD' then
 coalesce(public.weekly_sales_money(l.raw_payload#>>'{line,discountedLineItemCost,value}'),public.weekly_sales_money(l.raw_payload#>>'{line,lineItemCost,value}'),
 public.weekly_sales_money(l.raw_payload->>'Sold For')*l.quantity,case when l.raw_payload#>>'{line,lineItemId}' is null and coalesce(l.raw_payload->>'source','')!~*'(api|sync)' then l.sold_for*l.quantity end) end as sold
 from orders o join public.ebay_order_lines l on l.order_id=o.id
), item_lists as (
 select l.order_number,jsonb_agg(jsonb_build_object('title',l.item_title,'item',l.item_number,'line',l.transaction_id,'qty',l.quantity,
  'sold',l.sold,'cancel',coalesce(o.voided,false) or l.line_status='cancelled',
  'kept',case when o.voided or l.line_status='cancelled' or o.buyer in ('refunded','unpaid','failed','pending') then 0
   when o.needs_review or o.buyer not in ('paid','partial') or l.sold is null then null
   when l.n=1 and o.booked=l.sold then greatest(0,l.sold-o.cancelled-o.refunded)
   when o.buyer='paid' and coalesce(o.refunded,0)=0 and o.booked is not null then l.sold end,
  'credit',case when l.n=1 then o.amount when o.credit=o.amount then item.credit end)
  order by l.transaction_id,l.id) items
 from lines l join orders o using(order_number)
 left join lateral (select case when count(*)=1 then min(i.credit) end as credit
  from jsonb_to_recordset(coalesce(o.hub_items,'[]')) as i(item text,txn text,qty integer,sold numeric,credit numeric)
  where i.item=l.item_number and i.qty=l.quantity and i.sold=l.sold
   and (l.same_item=1 or i.txn=l.transaction_id)) item on true
 group by l.order_number
)
select coalesce(jsonb_agg(jsonb_build_object('id',o.order_number,'date',o.sale_date,'week',date_trunc('week',o.sale_date at time zone 'America/New_York')::date,
 'user',o.buyer_username,'buyer',o.buyer,'fund',o.fund,'source',o.source,'checked',o.checked,'credit',o.amount,'held',o.held,
 'final',case when o.proceeds_complete then o.proceeds end,'cancel',coalesce(o.voided,false),'items',coalesce(i.items,'[]'))
 order by o.sale_date desc,o.order_number),'[]') from orders o left join item_lists i using(order_number)
$$;
revoke all on function public.weekly_ebay_item_payments(date,date,timestamp,jsonb) from public,anon,authenticated;

do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 marker text:='''ebay_pending_payments'',';begin
 if strpos(f,marker)=0 then raise exception 'Unexpected weekly sales report definition';end if;
 execute replace(f,marker,$extra$'ebay_item_orders',case when _market in ('ebay','all') then
  public.weekly_ebay_item_payments(m,end_date,cutoff,coalesce((select jsonb_agg(jsonb_build_object('order_number',order_number,'booked',booked,'cancelled',cancelled,
  'refunded',refunded,'needs_review',needs_review,'proceeds',proceeds,'proceeds_complete',proceeds_complete)) from orders where market='ebay' and purchased>=m and purchased<end_date),'[]')) end,
  'ebay_pending_payments',$extra$);
end$$;
notify pgrst,'reload schema';
commit;
