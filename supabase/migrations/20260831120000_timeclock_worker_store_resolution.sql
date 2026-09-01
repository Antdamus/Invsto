-- Let the time clock page rely on the database for store resolution.
-- Older mobile clients may still send _store_id on clock-in; accept it only
-- when it matches the worker's effective route/schedule/exception, then still
-- enforce the active store geofence and schedule rules.

drop policy if exists "store_locations_timeclock_worker_select" on public.store_locations;
create policy "store_locations_timeclock_worker_select"
on public.store_locations
for select
to authenticated
using (
  active is true
  and exists (
    select 1
    from public.employees e
    where e.user_id = auth.uid()
      and coalesce(e.active, true) is true
  )
);

grant select on table public.store_locations to authenticated;

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

    if not v_is_admin then
      if cardinality(coalesce(v_exception.allowed_clock_in_store_ids, '{}'::uuid[])) > 0 then
        if not coalesce(_store_id = any(v_exception.allowed_clock_in_store_ids), false) then
          raise exception 'Selected clock-in store is not allowed for today''s route';
        end if;
      elsif v_exception.allow_clock_in_any_store is true then
        null;
      elsif v_exception.clock_in_store_id is not null then
        if _store_id <> v_exception.clock_in_store_id then
          raise exception 'Selected clock-in store does not match today''s exception store';
        end if;
      elsif v_schedule.allow_clock_in_any_store is true then
        null;
      elsif cardinality(coalesce(v_schedule.allowed_clock_in_store_ids, '{}'::uuid[])) > 0 then
        if not coalesce(_store_id = any(v_schedule.allowed_clock_in_store_ids), false) then
          raise exception 'Selected clock-in store is not allowed for this shift route';
        end if;
      elsif v_schedule.store_id is not null then
        if _store_id <> v_schedule.store_id then
          raise exception 'Selected clock-in store does not match your assigned shift store';
        end if;
      end if;
    end if;

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
