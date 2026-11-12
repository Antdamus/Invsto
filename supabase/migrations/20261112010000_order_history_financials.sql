begin;
set local lock_timeout='8s';

-- Keep one implementation of the dashboard formulas, adding an optional
-- order scope so a completion-date search does not reconcile months of
-- unrelated purchases. The existing two-argument dashboard entry points
-- continue to request the entire period.
do $$declare sales text:=pg_get_functiondef('public.weekly_sales_order_rows(date,date)'::regprocedure);
 proceeds text:=pg_get_functiondef('public.weekly_sales_proceeds(date,date)'::regprocedure);
begin
 if strpos(sales,'FUNCTION public.weekly_sales_order_rows(_start date, _end date)')=0
  or strpos(sales,'where o.sale_date>=_start')=0
  or strpos(proceeds,'FUNCTION public.weekly_sales_proceeds(_start date, _end date)')=0
  or strpos(proceeds,'where o.sale_date>=_start')=0
  or strpos(proceeds,'public.weekly_sales_order_rows(_start,_end)')=0
  or strpos(sales,'from other_orders o left join lateral')=0
  or strpos(proceeds,'group by s.market,s.order_number')=0 then
  raise exception 'Unexpected dashboard financial definition';
 end if;
 sales:=replace(sales,'FUNCTION public.weekly_sales_order_rows(_start date, _end date)',
  'FUNCTION public.weekly_sales_order_rows_scoped(_start date, _end date, _orders text[])');
 sales:=replace(sales,'where o.sale_date>=_start','where (_orders is null or o.order_number=any(_orders)) and o.sale_date>=_start');
 sales:=replace(sales,'from other_orders o left join lateral','from (select * from other_orders where _orders is null) o left join lateral');
 execute sales;
 proceeds:=replace(proceeds,'FUNCTION public.weekly_sales_proceeds(_start date, _end date)',
  'FUNCTION public.weekly_sales_proceeds_scoped(_start date, _end date, _orders text[])');
 proceeds:=replace(proceeds,'where o.sale_date>=_start','where (_orders is null or o.order_number=any(_orders)) and o.sale_date>=_start');
 proceeds:=replace(proceeds,'public.weekly_sales_order_rows(_start,_end)','public.weekly_sales_order_rows_scoped(_start,_end,_orders)');
 proceeds:=replace(proceeds,'group by s.market,s.order_number','where _orders is null group by s.market,s.order_number');
 execute proceeds;
end$$;
revoke all on function public.weekly_sales_order_rows_scoped(date,date,text[]),public.weekly_sales_proceeds_scoped(date,date,text[]) from public,anon,authenticated;

create or replace function public.weekly_sales_order_rows(_start date,_end date)
returns table(market text,order_number text,purchased timestamp,booked numeric,cancelled numeric,refunded numeric,needs_review boolean)
language sql stable set search_path='' as $$
 select * from public.weekly_sales_order_rows_scoped(_start,_end,null)
$$;
create or replace function public.weekly_sales_proceeds(_start date,_end date)
returns table(market text,order_number text,posted numeric,complete boolean)
language sql stable set search_path='' as $$
 select * from public.weekly_sales_proceeds_scoped(_start,_end,null)
$$;

-- History is filtered by completion date, not purchase date. Reuse the
-- dashboard's current purchase/refund/earnings reconciliation for these orders.
create function public.get_order_history_financials(_orders text[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin') then
  raise exception 'Active admin access required' using errcode='42501';
 end if;
 if coalesce(cardinality(_orders),0)>5000 then raise exception 'Too many orders';end if;
 with selected as materialized (
  select o.id,o.order_number,o.sale_date,coalesce(o.seller_collected_tax,0) seller_tax
  from public.ebay_orders o where o.order_number=any(_orders)
 ), bounds as (
  select min((sale_date at time zone 'America/New_York')::date) first_day,
   max((sale_date at time zone 'America/New_York')::date)+1 last_day from selected
 ), sales as materialized (
  select r.* from bounds b cross join lateral public.weekly_sales_order_rows_scoped(b.first_day,b.last_day,_orders) r
  where r.market='ebay'
 ), proceeds as materialized (
  select p.* from bounds b cross join lateral public.weekly_sales_proceeds_scoped(b.first_day,b.last_day,_orders) p
  where p.market='ebay'
 )
 select coalesce(jsonb_agg(jsonb_build_object(
  'order_number',o.order_number,
  'line_ids',(select coalesce(jsonb_agg(l.id order by l.id),'[]') from public.ebay_order_lines l where l.order_id=o.id),
  'original',s.booked,'cancelled',s.cancelled,'refunded',s.refunded,
  'net_sales',case when not s.needs_review then greatest(0,s.booked-s.cancelled-s.refunded) end,
  'sales_complete',coalesce(not s.needs_review,false),
  -- Seller-collected tax is a separate liability. Do not call an amount net
  -- when its remaining tax after refunds has not been reconciled.
  'earnings',case when o.seller_tax=0 then p.posted end,
  'earnings_complete',coalesce(p.complete and o.seller_tax=0,false),
  'review_reason',case when o.seller_tax<>0 then 'Seller-collected tax needs reconciliation'
    when s.order_number is null or s.needs_review then 'Sales or refunds need verification'
    when not coalesce(p.complete,false) then 'Order deductions need verification' end
 ) order by o.order_number),'[]') into result
 from selected o left join sales s using(order_number) left join proceeds p using(order_number);
 return result;
end$$;
revoke all on function public.get_order_history_financials(text[]) from public,anon,authenticated;
grant execute on function public.get_order_history_financials(text[]) to authenticated;
notify pgrst,'reload schema';
commit;
