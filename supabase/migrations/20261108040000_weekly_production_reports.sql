begin;
set local lock_timeout='5s';

-- Insights airtime is not an actual end timestamp. Never derive ends_at from a schedule.
alter table public.weekly_ebay_show_catalog
 add column airtime_seconds integer check(airtime_seconds between 0 and 604800),
 add column airtime_source text,
 add column airtime_checked_at timestamptz,
 add column airtime_provisional boolean not null default false;

create function public.weekly_ebay_show_timing(_from date,_until date) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(to_jsonb(s)||jsonb_build_object(
  'scheduled_start',k.starts_at,'schedule_source',k.source,
  'airtime_seconds',k.airtime_seconds,'airtime_source',k.airtime_source,
  'airtime_checked_at',k.airtime_checked_at,'airtime_provisional',k.airtime_provisional,
  'seller_name',case when coalesce(e.display_name,'') ilike 'Otello%' then 'Otello'
   when coalesce(e.display_name,'') ilike 'Sydney%' then 'Sydney' else e.display_name end
 ) order by s.starts_at),'[]')
 from public.weekly_ebay_production_shows() s
 left join public.weekly_ebay_show_catalog k using(event_id)
 left join public.employees e on e.id=coalesce(s.seller_override,s.recorded_seller)
 where s.starts_at >= (_from::timestamp at time zone 'America/New_York')-interval '8 hours'
  and s.starts_at < (_until::timestamp at time zone 'America/New_York')
$$;
revoke all on function public.weekly_ebay_show_timing(date,date) from public,anon,authenticated;

do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);marker text:='''ebay_item_orders'',';
begin
 if strpos(f,marker)=0 or strpos(f,'''ebay_show_timing''')>0 then raise exception 'Unexpected weekly report definition';end if;
 execute replace(f,marker,$extra$'ebay_show_timing',case when _market in ('all','ebay') then public.weekly_ebay_show_timing(m,least(end_date,cutoff::date+1)) end,
 'ebay_item_orders',$extra$);
end$$;

notify pgrst,'reload schema';
commit;
