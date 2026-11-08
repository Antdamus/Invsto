begin;
set local lock_timeout='5s';

-- Staff annotations are independent of imported eBay metrics and sales.
alter table public.weekly_ebay_show_catalog
 add column push_labels jsonb not null default '{}' check(jsonb_typeof(push_labels)='object'),
 add column push_updated_at timestamptz;
create table public.weekly_ebay_show_push_audit (
 id bigint generated always as identity primary key,
 event_id text not null references public.weekly_ebay_show_catalog(event_id),
 before_labels jsonb not null,after_labels jsonb not null,
 actor uuid not null,created_at timestamptz not null default now()
);
alter table public.weekly_ebay_show_push_audit enable row level security;
revoke all on public.weekly_ebay_show_push_audit from public,anon,authenticated;

-- The owner's rule uses the actual Eastern calendar start date, even in
-- selling-night mode. Explicit per-show values (including unknown) take priority.
create function public.ebay_show_push_labels(_labels jsonb,_start timestamptz,_updated timestamptz)
returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object(
  'manual',case when _labels ? 'manual' then _labels->'manual'
   when (_start at time zone 'America/New_York')::date>='2026-08-25' then 'false'::jsonb else 'null'::jsonb end,
  'automatic',coalesce(_labels->'automatic','null'::jsonb),
  'manual_source',case when _labels ? 'manual' then 'recorded'
   when (_start at time zone 'America/New_York')::date>='2026-08-25' then 'date_rule' else 'not_recorded' end,
  'note',coalesce(_labels->>'note',''),'updated_at',_updated)
$$;
revoke all on function public.ebay_show_push_labels(jsonb,timestamptz,timestamptz) from public,anon,authenticated;

create function public.set_weekly_ebay_show_push_labels(_event_id text,_labels jsonb,_expected_updated_at timestamptz default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare old public.weekly_ebay_show_catalog; s record; stamp timestamptz;
begin
 if auth.uid() is null or not exists(select 1 from public.employees where user_id=auth.uid() and active and lower(role)='admin') then
  raise exception 'Active admin access required' using errcode='42501';end if;
 if _labels is null or jsonb_typeof(_labels)<>'object' then raise exception 'Choose valid push labels';end if;
 if exists(select 1 from jsonb_object_keys(_labels) k where k not in ('manual','automatic','note'))
  or (_labels ? 'manual' and jsonb_typeof(_labels->'manual') not in ('boolean','null'))
  or (_labels ? 'automatic' and jsonb_typeof(_labels->'automatic') not in ('boolean','null'))
  or (_labels ? 'note' and (jsonb_typeof(_labels->'note')<>'string' or length(_labels->>'note')>2000)) then
  raise exception 'Choose valid push labels and a note of at most 2000 characters';end if;
 perform pg_advisory_xact_lock(hashtextextended('weekly-show:'||coalesce(_event_id,''),0));
 select * into s from public.weekly_ebay_production_shows() where event_id=_event_id;
 if not found then raise exception 'Show not found';end if;
 select * into old from public.weekly_ebay_show_catalog where event_id=_event_id for update;
 if old.push_updated_at is distinct from _expected_updated_at then
  raise exception 'These labels changed. Close and reopen the report before saving.' using errcode='40001';end if;
 if old.event_id is not null and old.push_labels=_labels then
  return public.ebay_show_push_labels(old.push_labels,old.starts_at,old.push_updated_at);end if;
 stamp:=clock_timestamp();
 insert into public.weekly_ebay_show_catalog(event_id,title,starts_at,source,push_labels,push_updated_at)
 values(_event_id,s.title,s.starts_at,'recorded_show',_labels,stamp)
 on conflict(event_id) do update set push_labels=excluded.push_labels,push_updated_at=excluded.push_updated_at;
 insert into public.weekly_ebay_show_push_audit(event_id,before_labels,after_labels,actor)
 values(_event_id,coalesce(old.push_labels,'{}'),_labels,auth.uid());
 return public.ebay_show_push_labels(_labels,coalesce(old.starts_at,s.starts_at),stamp);
end$$;
revoke all on function public.set_weekly_ebay_show_push_labels(text,jsonb,timestamptz) from public,anon;
grant execute on function public.set_weekly_ebay_show_push_labels(text,jsonb,timestamptz) to authenticated;

do $$declare f text; marker text;
begin
 f:=pg_get_functiondef('public.get_streamer_performance_history(date,date)'::regprocedure);
 marker:='k.insights-''metrics'' insights,';
 if strpos(f,marker)=0 then raise exception 'Unexpected history function';end if;
 execute replace(f,marker,marker||'public.ebay_show_push_labels(k.push_labels,coalesce(k.starts_at,s.starts_at),k.push_updated_at) push,');
 f:=pg_get_functiondef('public.weekly_ebay_show_timing(date,date)'::regprocedure);
 marker:='''scheduled_start'',k.starts_at,';
 if strpos(f,marker)=0 then raise exception 'Unexpected show timing function';end if;
 execute replace(f,marker,marker||'''push'',public.ebay_show_push_labels(k.push_labels,coalesce(k.starts_at,s.starts_at),k.push_updated_at),');
end$$;
notify pgrst,'reload schema';
commit;
