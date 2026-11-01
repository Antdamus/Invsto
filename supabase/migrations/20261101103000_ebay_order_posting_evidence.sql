begin;
set local lock_timeout='8s';
-- Original USD Order transactions in the Seller Hub transaction export.
-- A financial observation can exist without a matching Invsto fulfillment record.
create table public.weekly_ebay_posted_orders(
 order_number text primary key, posted_on date not null, item bigint not null, shipping bigint not null,
 fees bigint not null, other bigint not null, credit bigint not null,
 checked_at timestamptz not null, seller_sold_day date, seller_full_refund boolean,
 check(item+shipping+fees+other=credit)
);
create index weekly_ebay_posted_day on public.weekly_ebay_posted_orders(posted_on);
alter table public.weekly_ebay_posted_orders enable row level security;
revoke all on public.weekly_ebay_posted_orders from public,anon,authenticated;
grant select,insert,update on public.weekly_ebay_posted_orders to service_role;
do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);
 marker text:='''ebay_cash_statement'',';
begin
 if strpos(f,marker)=0 then raise exception 'Unexpected monthly cash report definition';end if;
 execute replace(f,marker,$add$'ebay_posted_orders',case when _market in ('ebay','all') then
 (select jsonb_agg(jsonb_build_object('id',p.order_number,'day',p.posted_on,'item',p.item,'shipping',p.shipping,
 'fees',p.fees,'other',p.other,'credit',p.credit,'sold',p.seller_sold_day,'refunded',p.seller_full_refund) order by p.posted_on,p.order_number)
 from public.weekly_ebay_posted_orders p where (p.posted_on>=m and p.posted_on<end_date) or
 p.order_number in (select e.order_number from public.ebay_orders e where e.sale_date>=m::timestamp at time zone 'America/New_York'
 and e.sale_date<end_date::timestamp at time zone 'America/New_York')) end,$add$||marker);
end$$;
notify pgrst,'reload schema';
commit;
