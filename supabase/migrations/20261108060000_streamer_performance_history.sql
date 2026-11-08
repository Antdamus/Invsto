begin;
set local lock_timeout='5s';

-- Visible Live Studio metrics, kept separate from reconciled merchandise sales.
alter table public.weekly_ebay_show_catalog add column insights jsonb;

-- Reuse exact order matching and monetary attribution. For historical analysis,
-- a long overnight stream must not be truncated by the usual eight-hour estimate.
-- This is only an estimated matching window, never a claimed actual show end.
do $$declare f text:=pg_get_functiondef('public.weekly_ebay_production(jsonb)'::regprocedure);
 marker text:='catalog as materialized (select * from public.weekly_ebay_production_shows())';
begin
 if strpos(f,marker)=0 or strpos(f,'s.starts_at+interval ''8 hours''')=0 then raise exception 'Unexpected production matcher definition';end if;
 f:=replace(f,'FUNCTION public.weekly_ebay_production(','FUNCTION public.streamer_performance_orders(');
 f:=replace(f,marker,$catalog$catalog as materialized (
  select s.*,greatest(s.starts_at+interval '8 hours',coalesce(k.starts_at,s.starts_at)+
   make_interval(secs=>coalesce(k.airtime_seconds,28800))) estimated_window_end
  from public.weekly_ebay_production_shows() s left join public.weekly_ebay_show_catalog k using(event_id))$catalog$);
 -- Replace only the two fallback windows in the original shows CTE.
 f:=replace(f,'coalesce(s.ends_at,s.starts_at+interval ''8 hours'')','coalesce(s.ends_at,s.estimated_window_end)');
 f:=replace(f,'n.starts_at>s.starts_at),s.starts_at+interval ''8 hours'')','n.starts_at>s.starts_at),s.estimated_window_end)');
 execute f;
end$$;
revoke all on function public.streamer_performance_orders(jsonb) from public,anon,authenticated;

create function public.get_streamer_performance_history(_from date,_until date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare cutoff timestamptz; production jsonb; result jsonb;
begin
 if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin') then
  raise exception 'Active admin access required' using errcode='42501';end if;
 if _from is null or _until is null or _until<=_from or _until-_from>370 or _from<'2000-01-01' then
  raise exception 'Choose a history range of at most 370 days';end if;
 -- Read an extra purchase day so an overnight show's sales are not cut at midnight.
 cutoff:=least(statement_timestamp(),(_until+1)::timestamp at time zone 'America/New_York');
 select public.streamer_performance_orders(coalesce(jsonb_agg(jsonb_build_object(
  'order_number',order_number,'purchased',purchased,'booked',booked,'cancelled',cancelled,'refunded',refunded,
  'held',case when needs_review then booked-cancelled-refunded else 0 end,
  'net',case when needs_review then 0 else booked-cancelled-refunded end)),'[]')) into production
 from public.weekly_sales_order_rows(_from-1,_until+1)
 where market='ebay' and purchased at time zone 'America/New_York'<cutoff;
 with orders as materialized (
  select * from jsonb_to_recordset(production->'orders') as r(
   "show" text,seller text,seller_source text,show_source text,lines integer,booked numeric,cancelled numeric,refunded numeric,held numeric,net numeric)
 ), totals as (
  select "show",count(*) orders,count(*) filter(where show_source='captured') confirmed_orders,
   count(*) filter(where show_source='time_window') estimated_orders,sum(lines) linked_lines,
   count(distinct seller) seller_count,min(seller) seller,
   bool_and(seller_source in ('recorded','override')) saved_seller,
   sum(booked) booked,sum(cancelled) cancelled,sum(refunded) refunded,sum(held) held,sum(net) net
  from orders where "show" is not null group by "show"
 ), shows as (
  select s.*,k.starts_at scheduled_start,k.airtime_seconds,k.airtime_provisional,k.airtime_checked_at,k.insights-'metrics' insights,
   coalesce(t.orders,0) orders,coalesce(t.linked_lines,0) linked_lines,coalesce(t.confirmed_orders,0) confirmed_orders,coalesce(t.estimated_orders,0) estimated_orders,
   coalesce(t.booked,0) booked,coalesce(t.cancelled,0) cancelled,coalesce(t.refunded,0) refunded,
   coalesce(t.held,0) held,coalesce(t.net,0) net,
   case when s.seller_override is not null then e.display_name
    when t.seller_count>1 then 'Multiple sellers — review'
    when t.saved_seller then t.seller
    when s.recorded_seller is not null then e.display_name
    when extract(hour from s.starts_at at time zone 'America/New_York')>=18
      or extract(hour from s.starts_at at time zone 'America/New_York')<8 then 'Otello'
    when (s.starts_at at time zone 'America/New_York')::date<'2026-09-15' then 'Historical seller unassigned'
    when extract(isodow from s.starts_at at time zone 'America/New_York') in (6,7) then 'Manuella'
    else 'Sydney' end seller,
   case when s.seller_override is not null then 'override'
    when t.seller_count>1 then 'multiple' when t.saved_seller or s.recorded_seller is not null then 'recorded'
    else 'time_rule' end seller_source
  from public.weekly_ebay_production_shows() s
  left join public.weekly_ebay_show_catalog k using(event_id)
  left join public.employees e on e.id=coalesce(s.seller_override,s.recorded_seller)
  left join totals t on t."show"=s.event_id
  where coalesce(k.starts_at,s.starts_at)>=_from::timestamp at time zone 'America/New_York'
   and coalesce(k.starts_at,s.starts_at)<_until::timestamp at time zone 'America/New_York'
 )
 select jsonb_build_object('from',_from,'until',_until,'as_of',statement_timestamp(),'purchase_cutoff',cutoff,
  'sydney_estimated_start','2026-09-15','shows',coalesce((select jsonb_agg(to_jsonb(s)-'seller'||jsonb_build_object(
   'seller',case when s.seller ilike 'Otello%' then 'Otello' when s.seller ilike 'Sydney%' then 'Sydney'
    when s.seller ilike 'Manuella%' then 'Manuella' else s.seller end) order by coalesce(s.scheduled_start,s.starts_at),s.event_id) from shows s),'[]'),
  'coverage',jsonb_build_object('orders',(select count(*) from orders),'unlinked_orders',(select count(*) from orders where "show" is null),
   'unlinked_net',(select coalesce(sum(net),0) from orders where "show" is null),
   'first_order',(select min(sale_date) from public.ebay_orders),
   'first_show',(select min(starts_at) from public.weekly_ebay_production_shows()))) into result;
 return result;
end$$;
revoke all on function public.get_streamer_performance_history(date,date) from public,anon;
grant execute on function public.get_streamer_performance_history(date,date) to authenticated;
notify pgrst,'reload schema';
commit;
