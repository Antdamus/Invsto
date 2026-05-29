-- Admin global schedule edits with recurring multi-store clock routes.

alter table public.work_schedules
  add column if not exists allow_clock_in_any_store boolean not null default false,
  add column if not exists allow_clock_out_any_store boolean not null default false,
  add column if not exists allowed_clock_in_store_ids uuid[] not null default '{}'::uuid[],
  add column if not exists allowed_clock_out_store_ids uuid[] not null default '{}'::uuid[];

create index if not exists work_schedules_allowed_in_store_ids_idx
  on public.work_schedules using gin (allowed_clock_in_store_ids);

create index if not exists work_schedules_allowed_out_store_ids_idx
  on public.work_schedules using gin (allowed_clock_out_store_ids);

alter table public.schedule_audit_log
  drop constraint if exists schedule_audit_log_schedule_table_check;

alter table public.schedule_audit_log
  add constraint schedule_audit_log_schedule_table_check
  check (schedule_table in ('work_schedules', 'work_schedule_overrides', 'timeclock_day_exceptions'));

drop trigger if exists trg_timeclock_day_exceptions_audit_log on public.timeclock_day_exceptions;
create trigger trg_timeclock_day_exceptions_audit_log
after insert or update or delete on public.timeclock_day_exceptions
for each row
execute function public.log_work_schedule_change();

create or replace view public.effective_work_shifts as
with override_days as (
  select distinct employee_id, work_date
  from public.work_schedule_overrides
),
override_shifts as (
  select
    o.employee_id,
    o.work_date,
    o.start_local,
    o.end_local,
    o.store_id,
    'override'::text as source,
    coalesce(x.allow_clock_in_any_store, false) as allow_clock_in_any_store,
    coalesce(x.allow_clock_out_any_store, false) as allow_clock_out_any_store,
    case
      when cardinality(coalesce(x.allowed_clock_in_store_ids, '{}'::uuid[])) > 0
        then x.allowed_clock_in_store_ids
      when x.clock_in_store_id is not null
        then array[x.clock_in_store_id]::uuid[]
      else '{}'::uuid[]
    end as allowed_clock_in_store_ids,
    case
      when cardinality(coalesce(x.allowed_clock_out_store_ids, '{}'::uuid[])) > 0
        then x.allowed_clock_out_store_ids
      when x.clock_out_store_id is not null
        then array[x.clock_out_store_id]::uuid[]
      else '{}'::uuid[]
    end as allowed_clock_out_store_ids
  from public.work_schedule_overrides o
  left join public.timeclock_day_exceptions x
    on x.employee_id = o.employee_id
   and x.work_date = o.work_date
  where o.off = false
),
regular_shifts as (
  select
    ws.employee_id,
    d.work_date,
    ws.start_local,
    ws.end_local,
    ws.store_id,
    'regular'::text as source,
    coalesce(x.allow_clock_in_any_store, ws.allow_clock_in_any_store, false) as allow_clock_in_any_store,
    coalesce(x.allow_clock_out_any_store, ws.allow_clock_out_any_store, false) as allow_clock_out_any_store,
    case
      when cardinality(coalesce(x.allowed_clock_in_store_ids, '{}'::uuid[])) > 0
        then x.allowed_clock_in_store_ids
      when x.clock_in_store_id is not null
        then array[x.clock_in_store_id]::uuid[]
      else coalesce(ws.allowed_clock_in_store_ids, '{}'::uuid[])
    end as allowed_clock_in_store_ids,
    case
      when cardinality(coalesce(x.allowed_clock_out_store_ids, '{}'::uuid[])) > 0
        then x.allowed_clock_out_store_ids
      when x.clock_out_store_id is not null
        then array[x.clock_out_store_id]::uuid[]
      else coalesce(ws.allowed_clock_out_store_ids, '{}'::uuid[])
    end as allowed_clock_out_store_ids
  from public.work_schedules ws
  join lateral (
    select generate_series(
      ws.effective_from,
      coalesce(ws.effective_to, ws.effective_from + interval '2 years'),
      interval '1 day'
    )::date as work_date
  ) d on true
  left join public.timeclock_day_exceptions x
    on x.employee_id = ws.employee_id
   and x.work_date = d.work_date
  where ws.active = true
    and extract(dow from d.work_date) = ws.weekday
    and not exists (
      select 1
      from override_days od
      where od.employee_id = ws.employee_id
        and od.work_date = d.work_date
    )
),
seller_shifts as (
  select
    s.seller_employee_id as employee_id,
    (s.start_at at time zone coalesce(sl.timezone, 'America/New_York'))::date as work_date,
    (s.start_at at time zone coalesce(sl.timezone, 'America/New_York'))::time as start_local,
    (s.end_at at time zone coalesce(sl.timezone, 'America/New_York'))::time as end_local,
    s.store_id,
    'seller_sale'::text as source,
    false as allow_clock_in_any_store,
    false as allow_clock_out_any_store,
    '{}'::uuid[] as allowed_clock_in_store_ids,
    '{}'::uuid[] as allowed_clock_out_store_ids
  from public.seller_sale_shifts s
  left join public.store_locations sl on sl.id = s.store_id
  where s.status = any (public.seller_sale_active_statuses())
)
select * from override_shifts
union all
select * from regular_shifts
union all
select * from seller_shifts;

create or replace function public.admin_set_weekday_slot_with_route(
  _employee_id uuid,
  _weekday smallint,
  _start_local time,
  _end_local time,
  _effective_from date default current_date,
  _effective_to date default null,
  _store_id uuid default null,
  _note text default null,
  _allow_clock_in_any_store boolean default false,
  _allow_clock_out_any_store boolean default false,
  _allowed_clock_in_store_ids uuid[] default null,
  _allowed_clock_out_store_ids uuid[] default null
)
returns public.work_schedules
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.work_schedules;
  v_day_before date := _effective_from - 1;
  v_in_ids uuid[] := coalesce(_allowed_clock_in_store_ids, case when _store_id is null then '{}'::uuid[] else array[_store_id]::uuid[] end);
  v_out_ids uuid[] := coalesce(_allowed_clock_out_store_ids, case when _store_id is null then '{}'::uuid[] else array[_store_id]::uuid[] end);
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if _weekday < 0 or _weekday > 6 then
    raise exception 'Invalid weekday' using errcode = '22023';
  end if;

  if _end_local <= _start_local then
    raise exception 'End must be after start' using errcode = '22023';
  end if;

  if _store_id is not null and not exists (
    select 1 from public.store_locations where id = _store_id and active is true
  ) then
    raise exception 'Selected store is not active' using errcode = '22023';
  end if;

  if exists (
    select 1
    from unnest(coalesce(v_in_ids, '{}'::uuid[]) || coalesce(v_out_ids, '{}'::uuid[])) as route_store(id)
    left join public.store_locations sl on sl.id = route_store.id and sl.active is true
    where route_store.id is not null
      and sl.id is null
  ) then
    raise exception 'One or more route stores are not active' using errcode = '22023';
  end if;

  delete from public.work_schedules ws
  where ws.employee_id = _employee_id
    and ws.weekday = _weekday
    and ws.active is true
    and ws.effective_from >= _effective_from
    and (ws.effective_to is null or ws.effective_to >= _effective_from);

  update public.work_schedules ws
  set effective_to = v_day_before
  where ws.employee_id = _employee_id
    and ws.weekday = _weekday
    and ws.active is true
    and ws.effective_from < _effective_from
    and (ws.effective_to is null or ws.effective_to >= _effective_from);

  insert into public.work_schedules (
    employee_id,
    weekday,
    start_local,
    end_local,
    effective_from,
    effective_to,
    store_id,
    note,
    active,
    allow_clock_in_any_store,
    allow_clock_out_any_store,
    allowed_clock_in_store_ids,
    allowed_clock_out_store_ids
  ) values (
    _employee_id,
    _weekday,
    _start_local,
    _end_local,
    _effective_from,
    _effective_to,
    _store_id,
    _note,
    true,
    coalesce(_allow_clock_in_any_store, false),
    coalesce(_allow_clock_out_any_store, false),
    v_in_ids,
    v_out_ids
  )
  returning * into v_row;

  return v_row;
end;
$function$;

drop function if exists public.get_schedule_range_all_with_routes(date, date);
create function public.get_schedule_range_all_with_routes(_start date, _end date)
returns table(
  work_date date,
  employee_id uuid,
  display_name text,
  start_ts timestamptz,
  end_ts timestamptz,
  source text,
  store_id uuid,
  allow_clock_in_any_store boolean,
  allow_clock_out_any_store boolean,
  allowed_clock_in_store_ids uuid[],
  allowed_clock_out_store_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    ews.work_date,
    ews.employee_id,
    e.display_name,
    ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as start_ts,
    case
      when ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
        <= ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York'))
      then ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York')) + interval '24 hours'
      else ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
    end as end_ts,
    ews.source,
    ews.store_id,
    coalesce(ews.allow_clock_in_any_store, false) as allow_clock_in_any_store,
    coalesce(ews.allow_clock_out_any_store, false) as allow_clock_out_any_store,
    case
      when coalesce(ews.allow_clock_in_any_store, false) then '{}'::uuid[]
      when cardinality(coalesce(ews.allowed_clock_in_store_ids, '{}'::uuid[])) > 0 then ews.allowed_clock_in_store_ids
      when ews.store_id is not null then array[ews.store_id]::uuid[]
      else '{}'::uuid[]
    end as allowed_clock_in_store_ids,
    case
      when coalesce(ews.allow_clock_out_any_store, false) then '{}'::uuid[]
      when cardinality(coalesce(ews.allowed_clock_out_store_ids, '{}'::uuid[])) > 0 then ews.allowed_clock_out_store_ids
      when ews.store_id is not null then array[ews.store_id]::uuid[]
      else '{}'::uuid[]
    end as allowed_clock_out_store_ids
  from public.effective_work_shifts ews
  join public.employees e on e.id = ews.employee_id and e.active is true
  left join public.store_locations sl on sl.id = ews.store_id
  where ews.work_date between _start and _end
    and ews.start_local is not null
    and ews.end_local is not null
    and public.is_admin()
  order by ews.work_date, e.display_name, start_ts;
$function$;

drop function if exists public.get_employee_schedule_with_routes(uuid, date, date);
create function public.get_employee_schedule_with_routes(_employee_id uuid, _start date, _end date)
returns table(
  work_date date,
  start_ts timestamptz,
  end_ts timestamptz,
  source text,
  store_id uuid,
  allow_clock_in_any_store boolean,
  allow_clock_out_any_store boolean,
  allowed_clock_in_store_ids uuid[],
  allowed_clock_out_store_ids uuid[]
)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  select
    ews.work_date,
    ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as start_ts,
    case
      when ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
        <= ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York'))
      then ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York')) + interval '24 hours'
      else ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
    end as end_ts,
    ews.source,
    ews.store_id,
    coalesce(ews.allow_clock_in_any_store, false) as allow_clock_in_any_store,
    coalesce(ews.allow_clock_out_any_store, false) as allow_clock_out_any_store,
    case
      when coalesce(ews.allow_clock_in_any_store, false) then '{}'::uuid[]
      when cardinality(coalesce(ews.allowed_clock_in_store_ids, '{}'::uuid[])) > 0 then ews.allowed_clock_in_store_ids
      when ews.store_id is not null then array[ews.store_id]::uuid[]
      else '{}'::uuid[]
    end as allowed_clock_in_store_ids,
    case
      when coalesce(ews.allow_clock_out_any_store, false) then '{}'::uuid[]
      when cardinality(coalesce(ews.allowed_clock_out_store_ids, '{}'::uuid[])) > 0 then ews.allowed_clock_out_store_ids
      when ews.store_id is not null then array[ews.store_id]::uuid[]
      else '{}'::uuid[]
    end as allowed_clock_out_store_ids
  from public.effective_work_shifts ews
  left join public.store_locations sl on sl.id = ews.store_id
  join public.employees e on e.id = ews.employee_id
  where ews.employee_id = _employee_id
    and ews.work_date between _start and _end
    and ews.start_local is not null
    and ews.end_local is not null
    and (public.is_admin() or e.user_id = auth.uid())
  order by ews.work_date, start_ts;
$function$;

create or replace function public.resolve_expected_window(_employee_id uuid, _ts timestamptz, _store_id uuid default null)
returns table(expected_start_ts timestamptz, expected_end_ts timestamptz)
language sql
stable
security definer
set search_path = public, pg_temp
as $function$
  with candidates as (
    select
      ews.employee_id,
      ews.work_date,
      ews.start_local,
      ews.end_local,
      ews.store_id,
      coalesce(sl.timezone, 'America/New_York') as timezone,
      ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) as shift_start_ts,
      case
        when ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
          <= ((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York'))
        then ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York')) + interval '24 hours'
        else ((ews.work_date::timestamp + ews.end_local) at time zone coalesce(sl.timezone, 'America/New_York'))
      end as shift_end_ts
    from public.effective_work_shifts ews
    left join public.store_locations sl on sl.id = ews.store_id
    where ews.employee_id = _employee_id
      and (
        _store_id is null
        or ews.store_id = _store_id
        or coalesce(ews.allow_clock_in_any_store, false)
        or coalesce(ews.allow_clock_out_any_store, false)
        or _store_id = any(coalesce(ews.allowed_clock_in_store_ids, '{}'::uuid[]))
        or _store_id = any(coalesce(ews.allowed_clock_out_store_ids, '{}'::uuid[]))
      )
      and ews.work_date = (_ts at time zone coalesce(sl.timezone, 'America/New_York'))::date
      and ews.start_local is not null
      and ews.end_local is not null
  )
  select
    shift_start_ts as expected_start_ts,
    shift_end_ts as expected_end_ts
  from candidates
  order by
    case when _store_id is not null and store_id = _store_id then 0 else 1 end,
    abs(extract(epoch from (shift_start_ts - _ts))) asc
  limit 1;
$function$;

create or replace function public.match_effective_shift_rule_a(
  _employee_id uuid,
  _store_id uuid,
  _event_ts timestamptz,
  _window_hours integer default 6
)
returns table (
  employee_id uuid,
  work_date date,
  start_local time,
  end_local time,
  store_id uuid,
  store_name text,
  timezone text,
  shift_start_ts timestamptz,
  shift_end_ts timestamptz,
  source text,
  shift_key text
)
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_tz text;
  v_local_date date;
begin
  select sl.timezone into v_tz
  from public.store_locations sl
  where sl.id = _store_id;

  if v_tz is null then
    v_tz := 'America/New_York';
  end if;

  v_local_date := (_event_ts at time zone v_tz)::date;

  return query
  with candidates as (
    select
      ews.employee_id,
      ews.work_date,
      ews.start_local,
      ews.end_local,
      ews.store_id,
      sl.name as store_name,
      coalesce(sl.timezone, v_tz) as timezone,
      ((ews.work_date + ews.start_local) at time zone coalesce(sl.timezone, v_tz)) as calc_start_ts,
      ((ews.work_date + ews.end_local) at time zone coalesce(sl.timezone, v_tz)) as calc_end_ts,
      ews.source,
      public.make_shift_key(
        ews.employee_id, ews.work_date, ews.start_local, ews.end_local, ews.store_id
      ) as shift_key
    from public.effective_work_shifts ews
    left join public.store_locations sl on sl.id = ews.store_id
    where ews.employee_id = _employee_id
      and ews.work_date = v_local_date
      and (
        _store_id is null
        or ews.store_id = _store_id
        or coalesce(ews.allow_clock_in_any_store, false)
        or coalesce(ews.allow_clock_out_any_store, false)
        or _store_id = any(coalesce(ews.allowed_clock_in_store_ids, '{}'::uuid[]))
        or _store_id = any(coalesce(ews.allowed_clock_out_store_ids, '{}'::uuid[]))
      )
  ),
  ranked as (
    select
      c.*,
      abs(extract(epoch from (c.calc_start_ts - _event_ts))) as abs_sec
    from candidates c
    where abs(extract(epoch from (c.calc_start_ts - _event_ts))) <= (_window_hours * 3600)
  )
  select
    r.employee_id,
    r.work_date,
    r.start_local,
    r.end_local,
    r.store_id,
    r.store_name,
    r.timezone,
    r.calc_start_ts as shift_start_ts,
    case
      when r.calc_end_ts is not null and r.calc_start_ts is not null and r.calc_end_ts <= r.calc_start_ts
        then r.calc_end_ts + interval '24 hours'
      else r.calc_end_ts
    end as shift_end_ts,
    r.source,
    r.shift_key
  from ranked r
  order by r.abs_sec asc
  limit 1;
end;
$function$;

create or replace function public.clock_in_now_geo(
  _employee_id uuid,
  _lat numeric,
  _lng numeric,
  _accuracy_m numeric,
  _photo_path text,
  _store_id uuid default null::uuid
)
returns public.time_entries
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_emp_user uuid;
  v_is_admin boolean := public.is_admin();
  v_today date := public.org_today_date();
  v_store record;
  v_exception record;
  v_schedule record;
  v_target_store_id uuid;
  v_distance numeric;
  v_accuracy_max numeric := 150;
  v_row public.time_entries;
  v_now timestamptz := now();
  v_exp record;
  v_codes text[] := '{}'::text[];
  v_note text := null;
begin
  perform public.assert_unlocked_for_ts(v_now, 'clock-in');

  if coalesce(trim(_photo_path), '') = '' then
    raise exception 'Photo required' using errcode = '22023';
  end if;

  select e.user_id into v_emp_user
  from public.employees e
  where e.id = _employee_id;

  if v_emp_user is null then
    raise exception 'Employee not found';
  end if;

  if v_emp_user <> auth.uid() and not v_is_admin then
    raise exception 'Not allowed';
  end if;

  if (not v_is_admin) and (_store_id is not null) then
    raise exception 'Not allowed to choose store';
  end if;

  select *
    into v_exception
  from public.timeclock_day_exceptions x
  where x.employee_id = _employee_id
    and x.work_date = v_today
  limit 1;

  select *
    into v_schedule
  from public.effective_work_shifts ews
  left join public.store_locations sl on sl.id = ews.store_id
  where ews.employee_id = _employee_id
    and ews.work_date = v_today
    and ews.start_local is not null
    and ews.end_local is not null
  order by abs(extract(epoch from (((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) - v_now))) asc
  limit 1;

  if _store_id is not null then
    v_target_store_id := _store_id;

  elsif cardinality(coalesce(v_exception.allowed_clock_in_store_ids, '{}'::uuid[])) > 0 then
    select s.id, public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      into v_target_store_id, v_distance
    from public.store_locations s
    where s.active is true
      and s.id = any(v_exception.allowed_clock_in_store_ids)
      and public.haversine_meters(_lat, _lng, s.lat, s.lng) <= s.radius_m
    order by distance_m asc
    limit 1;

    if v_target_store_id is null then
      raise exception 'Clock-in is only allowed at selected route stores today, and you are not inside one of them';
    end if;

  elsif v_exception.allow_clock_in_any_store is true then
    select store_id, distance_m into v_target_store_id, v_distance
    from public.pick_store_by_geo(_lat, _lng);

    if v_target_store_id is null then
      raise exception 'Clock-in allowed at any store today, but you are not inside any store geofence';
    end if;

  elsif v_exception.clock_in_store_id is not null then
    v_target_store_id := v_exception.clock_in_store_id;

  elsif v_schedule.allow_clock_in_any_store is true then
    select store_id, distance_m into v_target_store_id, v_distance
    from public.pick_store_by_geo(_lat, _lng);

    if v_target_store_id is null then
      raise exception 'Clock-in allowed at any store for this schedule, but you are not inside any store geofence';
    end if;

  elsif cardinality(coalesce(v_schedule.allowed_clock_in_store_ids, '{}'::uuid[])) > 0 then
    select s.id, public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      into v_target_store_id, v_distance
    from public.store_locations s
    where s.active is true
      and s.id = any(v_schedule.allowed_clock_in_store_ids)
      and public.haversine_meters(_lat, _lng, s.lat, s.lng) <= s.radius_m
    order by distance_m asc
    limit 1;

    if v_target_store_id is null then
      raise exception 'Clock-in is only allowed at this shift route stores, and you are not inside one of them';
    end if;

  elsif v_schedule.store_id is not null then
    v_target_store_id := v_schedule.store_id;

  else
    select store_id, distance_m into v_target_store_id, v_distance
    from public.pick_store_by_geo(_lat, _lng);

    if v_target_store_id is null then
      select s.id into v_target_store_id
      from public.store_locations s
      where s.active is true
      order by s.created_at asc
      limit 1;
    end if;
  end if;

  select * into v_store
  from public.store_locations s
  where s.id = v_target_store_id
    and s.active is true;

  if v_store.id is null then
    raise exception 'No active store configured';
  end if;

  if v_distance is null then
    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  if _accuracy_m is null then
    _accuracy_m := 9999;
  end if;

  if v_distance > v_store.radius_m or _accuracy_m > v_accuracy_max then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)',
      round(v_distance, 1), round(_accuracy_m, 1);
  end if;

  select * into v_exp
  from public.resolve_expected_window(_employee_id, v_now, v_store.id);

  if v_exp.expected_start_ts is null or v_exp.expected_end_ts is null then
    v_codes := array_append(v_codes, 'UNSCHEDULED_DAY');
    v_note := 'No schedule (override/recurring) for this day.';
    if v_store.schedule_enforce then
      raise exception 'Clock-in blocked: not scheduled today';
    end if;
  else
    if v_now < v_exp.expected_start_ts - (v_store.schedule_grace_in_m || ' minutes')::interval then
      v_codes := array_append(v_codes, 'EARLY_CLOCK_IN');
      if v_store.schedule_enforce then
        raise exception 'Clock-in blocked: too early for scheduled start';
      end if;
    elsif v_now > v_exp.expected_start_ts + (v_store.schedule_grace_in_m || ' minutes')::interval then
      v_codes := array_append(v_codes, 'LATE_CLOCK_IN');
      if v_store.schedule_enforce then
        raise exception 'Clock-in blocked: too late for scheduled start';
      end if;
    end if;
  end if;

  begin
    insert into public.time_entries (
      employee_id,
      clock_in,
      clock_in_lat,
      clock_in_lng,
      clock_in_accuracy_m,
      clock_in_distance_m,
      geo_ok_in,
      store_id,
      photo_in_path,
      expected_start_ts,
      expected_end_ts,
      schedule_codes,
      schedule_note
    ) values (
      _employee_id,
      v_now,
      _lat,
      _lng,
      _accuracy_m,
      v_distance,
      true,
      v_store.id,
      _photo_path,
      v_exp.expected_start_ts,
      v_exp.expected_end_ts,
      v_codes,
      v_note
    )
    returning * into v_row;
  exception when unique_violation then
    raise exception 'Open shift already exists';
  end;

  return v_row;
end;
$function$;

grant execute on function public.admin_set_weekday_slot_with_route(uuid, smallint, time, time, date, date, uuid, text, boolean, boolean, uuid[], uuid[]) to authenticated;
grant execute on function public.get_schedule_range_all_with_routes(date, date) to authenticated;
grant execute on function public.get_employee_schedule_with_routes(uuid, date, date) to authenticated;
