begin;
set local lock_timeout='5s';

-- Reporting evidence and overrides do not change commissions, orders or live bags.
create table public.weekly_ebay_show_catalog (
 event_id text primary key check(event_id ~ '^[A-Za-z0-9_-]{6,100}$'),
 title text not null, starts_at timestamptz not null,
 ends_at timestamptz check(ends_at>starts_at),
 observed_at timestamptz not null default now(),
 source text not null default 'ebay_live_studio',
 seller_override uuid references public.employees(id),
 assignment_updated_at timestamptz, assignment_updated_by uuid references auth.users(id)
);
create table public.weekly_ebay_show_assignment_audit (
 id bigint generated always as identity primary key,
 event_id text not null references public.weekly_ebay_show_catalog(event_id),
 old_seller uuid, new_seller uuid, actor uuid not null, created_at timestamptz not null default now()
);
alter table public.weekly_ebay_show_catalog enable row level security;
alter table public.weekly_ebay_show_assignment_audit enable row level security;
revoke all on public.weekly_ebay_show_catalog,public.weekly_ebay_show_assignment_audit from public,anon,authenticated;
grant select,insert,update on public.weekly_ebay_show_catalog to service_role;

create function public.weekly_ebay_production_shows() returns table(
 event_id text,title text,starts_at timestamptz,ends_at timestamptz,session_id uuid,
 seller_override uuid,recorded_seller uuid,assignment_updated_at timestamptz,history_state text
) language sql stable set search_path='' as $$
 select coalesce(c.event_id,k.event_id),coalesce(nullif(c.stream_metadata->>'title',''),s.title,k.title),
 coalesce(c.stream_start_at,k.starts_at),k.ends_at,c.session_id,k.seller_override,
 case when cardinality(coalesce(s.co_seller_employee_ids,'{}'))=0 then s.primary_seller_employee_id end,
 k.assignment_updated_at,c.history_recovery->>'phase'
 from public.ebay_live_connections c full join public.weekly_ebay_show_catalog k using(event_id)
 left join public.live_sale_sessions s on s.id=c.session_id
 where coalesce(c.stream_start_at,k.starts_at) is not null
$$;
revoke all on function public.weekly_ebay_production_shows() from public,anon,authenticated;

create function public.set_weekly_ebay_show_seller(_event_id text,_seller uuid,_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old public.weekly_ebay_show_catalog; show record; stamp timestamptz;
begin
 if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin') then
  raise exception 'Active admin access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('weekly-show:'||coalesce(_event_id,''),0));
 select * into show from public.weekly_ebay_production_shows() where event_id=_event_id;
 if not found then raise exception 'Show not found';end if;
 select * into old from public.weekly_ebay_show_catalog where event_id=_event_id;
 if old.assignment_updated_at is distinct from _expected_updated_at then raise exception 'This assignment changed. Refresh before saving.' using errcode='40001';end if;
 if _seller is not null and not exists(select 1 from public.employees where id=_seller and active is true) then raise exception 'Choose an active seller';end if;
 stamp:=clock_timestamp();
 insert into public.weekly_ebay_show_catalog(event_id,title,starts_at,source,seller_override,assignment_updated_at,assignment_updated_by)
 values(_event_id,show.title,show.starts_at,'recorded_show',_seller,stamp,auth.uid())
 on conflict(event_id) do update set seller_override=excluded.seller_override,assignment_updated_at=stamp,assignment_updated_by=auth.uid();
 insert into public.weekly_ebay_show_assignment_audit(event_id,old_seller,new_seller,actor) values(_event_id,old.seller_override,_seller,auth.uid());
 return jsonb_build_object('event_id',_event_id,'updated_at',stamp);
end$$;
revoke all on function public.set_weekly_ebay_show_seller(text,uuid,timestamptz) from public,anon;
grant execute on function public.set_weekly_ebay_show_seller(text,uuid,timestamptz) to authenticated;

-- Pass the already-classified order totals from the weekly report. Every order
-- belongs to exactly one reporting bucket, so every subtotal adds to the week.
-- Cross-show orders remain in a visible exception bucket instead of duplicating
-- their money or inventing a split of order-level refunds.
create function public.weekly_ebay_production(_sales jsonb) returns jsonb
language sql stable set search_path='' as $$
 with catalog as materialized (select * from public.weekly_ebay_production_shows()), shows as materialized (
  select s.*,least(coalesce(s.ends_at,s.starts_at+interval '8 hours'),
   coalesce((select min(n.starts_at) from catalog n where n.starts_at>s.starts_at),s.starts_at+interval '8 hours')) window_end
  from catalog s
 ), sales as (
  select * from jsonb_to_recordset(_sales) as x(order_number text,purchased timestamp,booked numeric,cancelled numeric,refunded numeric,held numeric,net numeric)
 ), base as materialized (
  select x.*,e.id order_id,
   coalesce(e.raw_payload#>>'{date_precision,sale_date}','')<>'day' and
    (e.raw_payload->>'source' ~ '(api|sync)' or e.raw_payload#>>'{date_precision,sale_date}'='timestamp'
     or e.raw_payload#>>'{order,creationDate}' ~ 'T[0-9]{2}:[0-9]{2}') as precise,
   a.line_count,a.event_count,a.matched_count,a.event_id exact_event,a.seller_count,a.seller_id,
   candidate.event_id time_event
  from sales x join public.ebay_orders e using(order_number)
  left join lateral (
   select count(l.id) line_count,count(distinct a.event_id) event_count,count(a.event_id) matched_count,min(a.event_id) event_id,
    count(distinct coalesce(l.assigned_seller_employee_id,a.seller_id)) seller_count,
    case when count(coalesce(l.assigned_seller_employee_id,a.seller_id))=count(l.id)
     then min(coalesce(l.assigned_seller_employee_id,a.seller_id)::text)::uuid end seller_id
   from public.ebay_order_lines l left join public.ebay_live_attempts a on a.order_line_id=l.id and a.merged_into is null and a.event_exclusion is null
   where l.order_id=e.id
  ) a on true
  left join lateral (
   select case when count(*)=1 then min(s.event_id) end event_id from shows s
   where x.purchased at time zone 'America/New_York'>=s.starts_at
    and x.purchased at time zone 'America/New_York'<s.window_end
  ) candidate on true
 ), matched as (
  select b.*,case when event_count=1 and matched_count=line_count then exact_event
   when event_count<=1 and precise and (exact_event is null or exact_event=time_event) then time_event end show_id,
   case when event_count=1 and matched_count=line_count then 'captured'
    when event_count<=1 and precise and time_event is not null and (exact_event is null or exact_event=time_event) then 'time_window'
    when event_count>1 then 'multiple' else 'unmatched' end show_source
  from base b
 ), attributed as (
  select b.*,s.title show_title,s.starts_at show_start,s.session_id,s.history_state,s.assignment_updated_at,
   coalesce(s.seller_override,case when b.seller_count=1 then b.seller_id end,
    case when b.seller_count<=1 then s.recorded_seller end) saved_seller,
   case when s.seller_override is not null then 'override' when b.seller_count=1 and b.seller_id is not null then 'recorded'
    when b.seller_count<=1 and s.recorded_seller is not null then 'recorded' when b.seller_count>1 then 'multiple'
    when s.starts_at is not null or b.precise then 'time_rule' else 'unknown' end seller_source,
   case when extract(hour from coalesce(s.starts_at at time zone 'America/New_York',b.purchased))>=18
     or extract(hour from coalesce(s.starts_at at time zone 'America/New_York',b.purchased))<8 then 'Otello' else 'Sydney' end rule_name
  from matched b left join shows s on s.event_id=b.show_id
 ), named as (
  select a.*,coalesce(nullif(e.display_name,''),case seller_source when 'time_rule' then rule_name
   when 'multiple' then 'Multiple sellers — review' else 'Seller unassigned' end) seller
  from attributed a left join public.employees e on e.id=a.saved_seller
 )
 select jsonb_build_object('orders',coalesce((select jsonb_agg(jsonb_build_object(
  'order',order_number,'day',purchased::date,'week',date_trunc('week',purchased)::date,'purchased',purchased,
  'booked',booked,'cancelled',cancelled,'refunded',refunded,'held',held,'net',net,'lines',line_count,
  'show',show_id,'show_title',show_title,'show_start',show_start,'show_source',show_source,'session',session_id,
  'seller',case when seller ilike 'Otello%' then 'Otello' when seller ilike 'Sydney%' then 'Sydney' else seller end,
  'seller_source',seller_source,'history_state',history_state,'assignment_updated_at',assignment_updated_at
 ) order by purchased,order_number) from named),'[]'),
 'shows',coalesce((select jsonb_agg(to_jsonb(s)-'window_end') from shows s
  where s.event_id in (select show_id from matched) or (s.starts_at at time zone 'America/New_York')::date
   between (select min(purchased::date) from sales) and (select max(purchased::date) from sales)),'[]'),
 'sellers',(select coalesce(jsonb_agg(jsonb_build_object('id',id,'name',display_name) order by display_name),'[]')
  from public.employees where active and nullif(display_name,'') is not null))
$$;
revoke all on function public.weekly_ebay_production(jsonb) from public,anon,authenticated;

do $$declare f text:=pg_get_functiondef('public.get_weekly_sales_for_market(date,text)'::regprocedure);marker text:='''ebay_item_orders'',';
begin
 if strpos(f,marker)=0 then raise exception 'Unexpected weekly sales report definition';end if;
 execute replace(f,marker,$extra$'ebay_production',case when _market in ('all','ebay') then
  public.weekly_ebay_production(coalesce((select jsonb_agg(jsonb_build_object('order_number',order_number,'purchased',purchased,
   'booked',booked,'cancelled',cancelled,'refunded',refunded,'held',held,'net',net)) from orders
   where market='ebay' and purchased>=m and purchased<end_date),'[]')) end,
  'ebay_item_orders',$extra$);
end$$;
notify pgrst,'reload schema';
commit;
