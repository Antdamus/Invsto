begin;
set local lock_timeout='5s';

-- Completed refunds are keyed by marketplace case/ledger ID, so retries and
-- later status changes revise the sale rather than creating a second deduction.
create table public.weekly_sales_refunds(
 market text not null check(market in ('tiktok','whatnot')),external_id text not null,order_number text not null,
 state text not null check(state in ('completed','pending','inactive')),item_amount numeric check(item_amount>=0),
 currency text,source_updated_at timestamptz not null,primary key(market,external_id)
);
create index weekly_refunds_by_order on public.weekly_sales_refunds(market,order_number);
create table public.weekly_sales_settlements(
 market text not null check(market in('tiktok','whatnot')),external_id text not null,order_number text not null,
 amount numeric not null,currency text not null,kind text not null,checked_at timestamptz not null,
 primary key(market,external_id)
);
create index weekly_settlements_by_order on public.weekly_sales_settlements(market,order_number);
create table public.weekly_sales_feed(
 market text primary key check(market in ('tiktok','whatnot')),state text not null default 'not_checked',
 checked_at timestamptz,through_at timestamptz,progress jsonb not null default '{}'
);
insert into public.weekly_sales_feed(market) values('tiktok'),('whatnot');
alter table public.weekly_sales_refunds enable row level security;
alter table public.weekly_sales_settlements enable row level security;
alter table public.weekly_sales_feed enable row level security;
revoke all on public.weekly_sales_refunds,public.weekly_sales_settlements,public.weekly_sales_feed from public,anon,authenticated;
grant select,insert,update on public.weekly_sales_refunds,public.weekly_sales_settlements,public.weekly_sales_feed to service_role;
alter table public.tiktok_order_lines add column api_cancelled_item_amount numeric check(api_cancelled_item_amount>=0);
do $$declare f text; old text:='update public.tiktok_order_imports set source=''api'' where id=imp;';begin
 f:=pg_get_functiondef('public.import_tiktok_api_order(uuid,jsonb,text)'::regprocedure);
 if strpos(f,old)=0 then raise exception 'Unexpected TikTok importer';end if;
 execute replace(f,old,old||$extra$
 update public.tiktok_order_lines l set api_cancelled_item_amount=(x->>'api_cancelled_item_amount')::numeric
 from jsonb_array_elements(_rows) x,public.tiktok_orders ord where ord.order_number=x->>'order_number'
 and ord.last_import_id=imp and l.order_id=ord.id and l.sku_id=x->>'sku_id' and x ? 'api_cancelled_item_amount';$extra$);
end$$;

create function public.weekly_sales_money(v text) returns numeric language sql immutable strict set search_path='' as $$
 select case when btrim(v) ~ '^[$]?[0-9]+(,[0-9]{3})*([.][0-9]{1,4})?$' then round(replace(replace(btrim(v),'$',''),',','')::numeric,2) end
$$;
revoke all on function public.weekly_sales_money(text) from public,anon,authenticated;
create function public.weekly_sales_local_time(v text) returns timestamp language plpgsql stable strict set search_path='' set datestyle='ISO, MDY' as $$
begin
 if v !~ '^([0-9]{4}-[0-9]{1,2}-[0-9]{1,2}|[0-9]{1,2}/[0-9]{1,2}/[0-9]{4})( |T|$)' then return null;end if;
 return v::timestamp;
exception when invalid_datetime_format or datetime_field_overflow then return null;
end$$;
revoke all on function public.weekly_sales_local_time(text) from public,anon,authenticated;

create function public.weekly_sales_order_rows(_start date,_end date)
returns table(market text,order_number text,purchased timestamp,booked numeric,cancelled numeric,refunded numeric,needs_review boolean)
language sql stable set search_path='' set datestyle='ISO, MDY' as $$
with ebay as materialized (
 select o.*,o.sale_date at time zone 'America/New_York' as purchased,
 upper(coalesce(nullif(o.raw_payload->>'orderPaymentStatus',''),o.raw_payload#>>'{order,orderPaymentStatus}',o.raw_payload#>>'{api_order_status,payment_status}','')) as pay,
 upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) in ('CANCELLED','CANCELED','CANCEL_CLOSED_WITH_REFUND') as voided
 from public.ebay_orders o where o.sale_date>=_start::timestamp at time zone 'America/New_York' and o.sale_date<_end::timestamp at time zone 'America/New_York'
), eb_lines as (
 select o.id,l.id as line_id,l.line_status,l.raw_payload,
 case when coalesce(l.raw_payload#>>'{line,discountedLineItemCost,currency}',l.raw_payload#>>'{line,lineItemCost,currency}',l.raw_payload->>'Currency',l.raw_payload->>'Sale Currency','USD')='USD' then
 coalesce(public.weekly_sales_money(l.raw_payload#>>'{line,discountedLineItemCost,value}'),public.weekly_sales_money(l.raw_payload#>>'{line,lineItemCost,value}'),
 public.weekly_sales_money(l.raw_payload->>'Sold For')*l.quantity,
 case when l.raw_payload#>>'{line,lineItemId}' is null and coalesce(l.raw_payload->>'source','')!~*'(api|sync)' then l.sold_for*l.quantity end) end as amount
 from ebay o join public.ebay_order_lines l on l.order_id=o.id
), eb_totals as (
 select id,sum(amount) gross,sum(amount) filter(where line_status='cancelled') cancelled_lines,
 bool_or(amount is null) missing,bool_or(upper(coalesce(raw_payload->>'orderPaymentStatus','')) in ('REFUNDED','FULLY_REFUNDED')) line_full,
 bool_or(jsonb_path_exists(raw_payload,'$.ebayFinance.transactions[*] ? (@.transactionType == "REFUND" && @.transactionStatus != "FAILED")')) finance_refund
 from eb_lines group by id
), cases as (
 select o.id,c.ebay_return_id,c.raw_payload#>'{ebayDetail,refundInfo,actualRefundDetail,actualRefund}' as actual
 from ebay o join public.ebay_return_cases c on (c.order_id=o.id or (c.order_id is null and c.order_number=o.order_number))
 where c.source_lane='return' and (nullif(c.buyer_username,'') is null or nullif(o.buyer_username,'') is null or lower(c.buyer_username)=lower(o.buyer_username))
 and public.customer_issue_return_refund(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload) in ('refunded','partial')
 and coalesce(c.raw_payload#>>'{ebayDetail,returnId}',c.raw_payload#>>'{ebaySummary,returnId}',c.raw_payload->>'ebayReturnId')=c.ebay_return_id
), case_totals as (
 select id,count(*) cases,sum(item_amount) item_amount,sum(checkout_amount) checkout_amount,bool_or(item_amount is null) unknown
 from (select distinct on(id,ebay_return_id) id,ebay_return_id,
 (select case when count(*)>0 and count(*) filter(where i->>'refundFeeType'='PURCHASE_PRICE' and (i#>>'{refundAmount,currency}' is distinct from 'USD' or public.weekly_sales_money(i#>>'{refundAmount,value}') is null))=0
 then coalesce(sum(public.weekly_sales_money(i#>>'{refundAmount,value}')) filter(where i->>'refundFeeType'='PURCHASE_PRICE'),0) end
 from jsonb_array_elements(case when jsonb_typeof(actual->'itemizedRefundDetail')='array' then actual->'itemizedRefundDetail' else '[]'::jsonb end) i) as item_amount,
 case when actual#>>'{totalAmount,currency}'='USD' then public.weekly_sales_money(actual#>>'{totalAmount,value}') end as checkout_amount
 from cases order by id,ebay_return_id) x group by id
), eb_facts as (
 select o.*,coalesce(l.gross,0) gross,case when o.voided then coalesce(l.gross,0)
 when coalesce(l.line_full,false) or o.pay in('FULLY_REFUNDED','REFUNDED') then 0
 when o.status='cancelled' then coalesce(l.gross,0) else coalesce(l.cancelled_lines,0) end cn,
 l.missing is distinct from false missing,coalesce(l.line_full,false) or o.pay in('FULLY_REFUNDED','REFUNDED') full_refund,
 o.pay='PARTIALLY_REFUNDED' or coalesce(l.finance_refund,false) or jsonb_path_exists(o.raw_payload,'$.ebayFinance.transactions[*] ? (@.transactionType == "REFUND" && @.transactionStatus != "FAILED")') possible_refund,
 c.item_amount,c.checkout_amount,c.unknown,pr.buyer_refund,pr.bad_refund,
 coalesce(public.weekly_sales_money(o.raw_payload#>>'{order,pricingSummary,total,value}'),o.total_price) checkout
 from ebay o left join eb_totals l using(id) left join case_totals c using(id)
 left join lateral (select sum(amt) buyer_refund,bool_or(amt is null) bad_refund from (
 select distinct on(coalesce(r->>'refundReferenceId',r->>'refundId',r::text)) case when r#>>'{amount,currency}'='USD' then public.weekly_sales_money(r#>>'{amount,value}') end amt
 from jsonb_array_elements(case when jsonb_typeof(o.raw_payload#>'{order,paymentSummary,refunds}')='array' then o.raw_payload#>'{order,paymentSummary,refunds}' else '[]'::jsonb end) r
 where upper(r->>'refundStatus') in ('REFUNDED','COMPLETED','SUCCESS','SUCCEEDED')) x) pr on true
 where o.voided or o.status='cancelled' or o.pay in('PAID','PARTIALLY_REFUNDED','FULLY_REFUNDED','REFUNDED') or (o.paid_on_date is not null and o.pay not in('FAILED','PENDING','UNPAID','NOT_PAID'))
), eb_result as (
 select *,case when full_refund or (checkout>0 and greatest(buyer_refund,checkout_amount)>=checkout) then gross-cn
 when item_amount is not null then least(gross-cn,item_amount)
 when buyer_refund is not null and checkout=gross and cn=0 then least(gross,buyer_refund)
 else 0 end as refund_amount from eb_facts
), tt_lines as (
 select o.id,o.order_number,public.weekly_sales_local_time(o.created_time) as purchased,
 o.marketplace_status in('Canceled','Cancelled') voided,l.line_amount,l.cancelled_at,l.api_cancelled_item_amount,
 l.id is null or l.line_amount is null or (o.cancel_return like '%partially cancelled quantity%' and l.api_cancelled_item_amount is null) as missing
 from public.tiktok_orders o left join public.tiktok_order_lines l on l.order_id=o.id
 where o.marketplace_status in('Canceled','Cancelled') or (nullif(trim(o.paid_time),'') is not null and o.marketplace_status not in('Unpaid','Failed'))
), other_orders as (
 select 'tiktok' market,order_number,purchased,coalesce(sum(line_amount),0) gross,
 coalesce(sum(case when voided or cancelled_at is not null then line_amount else least(line_amount,coalesce(api_cancelled_item_amount,0)) end),0) cn,bool_or(missing) missing from tt_lines
 where purchased>=_start and purchased<_end group by order_number,purchased
 union all
 select 'whatnot',id,purchased_at at time zone 'America/New_York',case when currency='USD' then greatest(0,least(subtotal,total-shipping-tax)) else 0 end,
 case when status='cancelled' and currency='USD' then greatest(0,least(subtotal,total-shipping-tax)) else 0 end,currency<>'USD'
 from public.whatnot_orders where status in ('pending_fulfillment','completed','cancelled') and purchased_at>=_start::timestamp at time zone 'America/New_York' and purchased_at<_end::timestamp at time zone 'America/New_York'
)
select 'ebay',e.order_number,e.purchased,e.gross,e.cn,e.refund_amount,
 e.missing or (e.gross>e.cn+e.refund_amount and jsonb_path_exists(e.raw_payload,'$.ebayFinance.transactions[*] ? ((@.transactionType == "DISPUTE" || @.transactionType == "ADJUSTMENT") && @.bookingEntry == "DEBIT" && @.transactionStatus != "FAILED")'))
 or (e.cn>0 and e.refund_amount>0 and not e.full_refund and e.refund_amount<e.gross-e.cn) or (e.cn<e.gross and not e.full_refund and e.refund_amount<e.gross-e.cn and (
  coalesce(e.bad_refund,false) or coalesce(e.unknown,false) or
  (e.possible_refund and e.item_amount is null and e.buyer_refund is null) or
  (e.buyer_refund>0 and (e.item_amount is null and e.checkout is distinct from e.gross or e.checkout_amount<e.buyer_refund)))) is true
from eb_result e
union all
select o.market,o.order_number,o.purchased,o.gross,o.cn,least(o.gross-o.cn,coalesce(r.known,0)),coalesce(o.missing,false) or (o.gross>o.cn and (coalesce(r.unknown,false) or o.cn>0 and r.known>0))
from other_orders o left join lateral (
 select sum(item_amount) filter(where currency='USD') known,bool_or(item_amount is null or currency is distinct from 'USD') unknown
 from public.weekly_sales_refunds f where f.market=o.market and f.order_number=o.order_number and f.state='completed'
) r on true
$$;
revoke all on function public.weekly_sales_order_rows(date,date) from public,anon,authenticated;

create function public.weekly_sales_proceeds(_start date,_end date)
returns table(market text,order_number text,posted numeric,complete boolean)
language sql stable set search_path='' as $$
with eb as materialized(select o.* from public.ebay_orders o where o.sale_date>=_start::timestamp at time zone 'America/New_York' and o.sale_date<_end::timestamp at time zone 'America/New_York'),
tx as (
 select distinct on(o.id,t->>'transactionId') o.id,t->>'transactionType' kind,t->>'bookingEntry' entry,
 t->>'transactionStatus' state,public.weekly_sales_money(trim(leading '-' from t->>'amount')) amount
 from eb o cross join lateral jsonb_array_elements(case when jsonb_typeof(o.raw_payload#>'{ebayFinance,transactions}')='array' then o.raw_payload#>'{ebayFinance,transactions}' else '[]'::jsonb end) t
 where nullif(t->>'transactionId','') is not null and t->>'orderNumber'=o.order_number and coalesce(t->>'transactionStatus','')<>'FAILED'
 and t->>'transactionType' not in('TRANSFER','PAYOUT','WITHDRAWAL')
 and coalesce(t->>'currency',o.raw_payload#>>'{order,pricingSummary,total,currency}',o.raw_payload#>>'{first_row,Currency}','USD')='USD'
 order by o.id,t->>'transactionId'
), figures as (
 select id,count(*) as nt,bool_and(entry in ('DEBIT','CREDIT') and amount is not null and state in ('FUNDS_AVAILABLE_FOR_PAYOUT','PAYOUT','COMPLETED','PAID_OUT')) as settled,
 bool_or(kind='SALE' and entry='CREDIT') as sale,bool_or(kind='SHIPPING_LABEL' and entry='DEBIT' and amount>0) as postage,
 sum(case when entry='CREDIT' then amount when entry='DEBIT' then -amount end) filter(where state in ('FUNDS_AVAILABLE_FOR_PAYOUT','PAYOUT','COMPLETED','PAID_OUT')) as balance
 from tx group by id
), evidence as (
 select o.order_number,f.balance,coalesce(f.sale and f.settled and (f.postage or
  (upper(o.raw_payload->>'orderCancelStatus') in('CANCELED','CANCELLED') and upper(o.raw_payload->>'orderFulfillmentStatus')='NOT_STARTED'))
  and jsonb_array_length(coalesce(o.raw_payload#>'{ebayFinance,transactionIds}','[]'))<=jsonb_array_length(coalesce(o.raw_payload#>'{ebayFinance,transactions}','[]'))
  and not exists(select 1 from jsonb_array_elements(coalesce(o.raw_payload#>'{ebayFinance,transactions}','[]')) t where t->>'orderNumber' is distinct from o.order_number or nullif(t->>'transactionId','') is null),false) complete
 from eb o left join figures f on f.id=o.id
)
select 'ebay',e.order_number,case when e.complete then e.balance else least(coalesce(e.balance,0),0) end,e.complete from evidence e
union all
select s.market,s.order_number,sum(s.amount),bool_and(s.currency='USD' and
 ((s.market='tiktok' and s.checked_at>statement_timestamp()-interval '7 days') or (s.market='whatnot' and f.state='ready' and f.through_at>=statement_timestamp()-interval '1 day')))
from public.weekly_sales_settlements s left join public.weekly_sales_feed f on f.market=s.market group by s.market,s.order_number
$$;
revoke all on function public.weekly_sales_proceeds(date,date) from public,anon,authenticated;

create function public.get_weekly_marketplace_sales(_month date default null) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare clock_et timestamp:=statement_timestamp() at time zone 'America/New_York';
 m date:=date_trunc('month',coalesce(_month,clock_et::date))::date; end_date date:=(m+interval '1 month')::date;
 cutoff timestamp:=least(clock_et,end_date::timestamp); anchor date; elapsed interval; result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin') then raise exception 'Active admin access required' using errcode='42501';end if;
 if m>clock_et::date or m<'2000-01-01' then raise exception 'Select the current month or a past month';end if;
 anchor:=date_trunc('week',case when cutoff=end_date::timestamp then cutoff-interval '1 microsecond' else cutoff end)::date;
 elapsed:=cutoff-anchor::timestamp;
 with classified as (select o.*,booked-cancelled-refunded as remaining,coalesce(p.complete,false) as proceeds_complete,
  case when p.complete then p.posted else least(coalesce(p.posted,0),0) end as proceeds,
  needs_review or (o.market<>'ebay' and (f.state is distinct from 'ready' or f.through_at is null or f.through_at<statement_timestamp()-interval '1 day'
     or f.progress->>'coverage_start' is null or o.purchased<(f.progress->>'coverage_start')::timestamptz at time zone 'America/New_York'
     or o.purchased>f.through_at at time zone 'America/New_York')) as unverified
  from public.weekly_sales_order_rows(least(m,anchor-7),end_date) o left join public.weekly_sales_feed f on f.market=o.market
  left join public.weekly_sales_proceeds(least(m,anchor-7),end_date) p on p.market=o.market and p.order_number=o.order_number where purchased<=cutoff),
 orders as materialized(select *,case when unverified then 0 else remaining end as net,case when unverified then remaining else 0 end as held from classified),
 spans as (
 select d::date as week,greatest(m,d::date) as first_day,least(end_date,d::date+7) as end_day
 from generate_series(date_trunc('week',m::timestamp),anchor::timestamp,interval '7 days') d
 ), rows as (
 select s.week,s.first_day,s.end_day,mk.market,count(o.order_number) as orders,coalesce(sum(booked),0) booked,coalesce(sum(cancelled),0) cancelled,
 coalesce(sum(refunded),0) refunded,coalesce(sum(net),0) net,coalesce(sum(held),0) held,count(*) filter(where needs_review) as review,
 coalesce(sum(proceeds),0) proceeds,count(*) filter(where proceeds_complete) as settled_orders,
 case when s.first_day=s.week and s.week::timestamp+elapsed<=s.end_day then coalesce(sum(proceeds) filter(where o.purchased<=s.week::timestamp+elapsed),0) end as comparable_proceeds,
 case when s.first_day=s.week and s.week::timestamp+elapsed<=s.end_day then coalesce(sum(net) filter(where o.purchased<=s.week::timestamp+elapsed),0) end as comparable
 from spans s cross join (values('ebay'),('tiktok'),('whatnot')) mk(market) left join orders o
 on o.market=mk.market and o.purchased>=s.first_day and o.purchased<s.end_day group by s.week,s.first_day,s.end_day,mk.market)
 select jsonb_build_object('month',m,'cutoff',cutoff,'as_of',statement_timestamp(),'anchor',anchor,'current_month',m=date_trunc('month',clock_et)::date,
 'focus_net',coalesce((select sum(net) from orders where purchased>=anchor and purchased<=cutoff),0),
 'previous_net',coalesce((select sum(net) from orders where purchased>=anchor-7 and purchased<anchor and purchased<=anchor::timestamp-interval '7 days'+elapsed),0),
 'focus_proceeds',coalesce((select sum(proceeds) from orders where purchased>=anchor and purchased<=cutoff),0),
 'previous_proceeds',coalesce((select sum(proceeds) from orders where purchased>=anchor-7 and purchased<anchor and purchased<=anchor::timestamp-interval '7 days'+elapsed),0),
 'rows',coalesce((select jsonb_agg(to_jsonb(r) order by week,market) from rows r),'[]'::jsonb),
 'feeds',(select jsonb_object_agg(f.market,jsonb_build_object('state',f.state,'through',f.through_at,'checked',f.checked_at)) from public.weekly_sales_feed f),
 'whatnot_backfill',(select full_in_progress from public.whatnot_api_connection where singleton))
 into result;
 return result;
end$$;
revoke all on function public.get_weekly_marketplace_sales(date) from public,anon;
grant execute on function public.get_weekly_marketplace_sales(date) to authenticated;
notify pgrst,'reload schema';
commit;
