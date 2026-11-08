begin;
set local lock_timeout='5s';
-- Exact sold-listing evidence can resolve overlapping scheduled show windows.
-- This affects report attribution only, never fulfillment or commissions.
create table public.weekly_ebay_verified_show_orders (
 order_number text primary key references public.ebay_orders(order_number),
 event_id text not null references public.weekly_ebay_show_catalog(event_id),
 source_url text not null check(source_url like 'https://www.ebay.com/ebaylive/host/events/%'),
 checked_at timestamptz not null, evidence jsonb not null check(jsonb_typeof(evidence)='object')
);
alter table public.weekly_ebay_verified_show_orders enable row level security;
revoke all on public.weekly_ebay_verified_show_orders from public,anon,authenticated;
grant select on public.weekly_ebay_verified_show_orders to service_role;
do $$declare f text; sig text; marker text;
begin
 foreach sig in array array['public.weekly_ebay_production(jsonb)','public.streamer_performance_orders(jsonb)'] loop
  f:=pg_get_functiondef(sig::regprocedure);
  marker:='select x.*,e.id order_id,';
  if strpos(f,marker)=0 then raise exception 'Unexpected show order base %',sig;end if;
  f:=replace(f,marker,marker||'verified.event_id verified_show,');
  marker:='from sales x join public.ebay_orders e using(order_number)';
  if strpos(f,marker)=0 then raise exception 'Unexpected show order join %',sig;end if;
  f:=replace(f,marker,marker||' left join public.weekly_ebay_verified_show_orders verified on verified.order_number=x.order_number');
  marker:='select b.*,case when event_count=1 and matched_count=line_count then exact_event';
  if strpos(f,marker)=0 then raise exception 'Unexpected show match %',sig;end if;
  f:=replace(f,marker,'select b.*,case when verified_show is not null then verified_show when event_count=1 and matched_count=line_count then exact_event');
  f:=replace(f,'case when event_count=1 and matched_count=line_count then ''captured''','case when verified_show is not null then ''captured'' when event_count=1 and matched_count=line_count then ''captured''');
  execute f;
 end loop;
end$$;
notify pgrst,'reload schema';
commit;
