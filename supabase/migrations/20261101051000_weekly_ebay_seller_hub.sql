begin;
create table public.weekly_ebay_seller_hub_periods (
 first_day date not null, last_day date not null, item_sales numeric(14,2) not null,
 shipping_collected numeric(14,2) not null, selling_fees numeric(14,2) not null, label_cost numeric(14,2) not null,
 reported_net numeric(14,2) not null, checked_at timestamptz not null, primary key(first_day,last_day),
 check(last_day>=first_day and last_day-first_day<31)
);
alter table public.weekly_ebay_seller_hub_periods enable row level security;
revoke all on public.weekly_ebay_seller_hub_periods from public,anon,authenticated;
grant select,insert,update on public.weekly_ebay_seller_hub_periods to service_role;
do $$declare def text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure); begin
 if strpos(def,'''whatnot_backfill'',')=0 then raise exception 'Unexpected sales report';end if;
 execute replace(def,'''whatnot_backfill'',',$part$'seller_hub',case when _market='ebay' then (select jsonb_agg(to_jsonb(h) order by first_day,last_day) from public.weekly_ebay_seller_hub_periods h where first_day>=m-7 and last_day>=m-7 and first_day<end_date and last_day<end_date) end, 'whatnot_backfill',$part$);
end$$;
notify pgrst,'reload schema';
commit;
