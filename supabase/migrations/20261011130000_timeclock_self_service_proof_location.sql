-- Self-service timeclock revamp:
-- - Employees can clock in/out and start/end breaks on their own time.
-- - Every punch requires a photo path and GPS coordinates.
-- - Schedule timing checks are recorded for admin verification, not used to
--   block the employee from recording the punch.
-- - Store geofence stays enforced, with a narrow admin-only saved test-location
--   allowance for testing from one approved spot.
-- - The first 30 minutes of break time per day are paid; only break time after
--   that daily cap is deducted from payable worked time.

alter table public.store_locations
  alter column paid_break_cap_min set default 30;

update public.store_locations
set paid_break_cap_min = 30
where paid_break_cap_min is null
   or paid_break_cap_min = 0;

create or replace function public.org_paid_break_minutes_per_day()
returns integer
language sql
stable
as $function$
  select 30::integer;
$function$;

create table if not exists public.timeclock_admin_test_locations (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references auth.users(id) on delete cascade,
  label text not null default 'Admin timeclock test location',
  lat numeric not null,
  lng numeric not null,
  radius_m numeric not null default 150,
  active boolean not null default true,
  expires_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid not null default auth.uid()
);

alter table public.timeclock_admin_test_locations enable row level security;

drop policy if exists timeclock_admin_test_locations_select_own on public.timeclock_admin_test_locations;
create policy timeclock_admin_test_locations_select_own
  on public.timeclock_admin_test_locations
  for select
  to authenticated
  using (public.is_admin() and admin_user_id = auth.uid());

drop policy if exists timeclock_admin_test_locations_insert_own on public.timeclock_admin_test_locations;
create policy timeclock_admin_test_locations_insert_own
  on public.timeclock_admin_test_locations
  for insert
  to authenticated
  with check (public.is_admin() and admin_user_id = auth.uid() and created_by = auth.uid());

drop policy if exists timeclock_admin_test_locations_update_own on public.timeclock_admin_test_locations;
create policy timeclock_admin_test_locations_update_own
  on public.timeclock_admin_test_locations
  for update
  to authenticated
  using (public.is_admin() and admin_user_id = auth.uid())
  with check (public.is_admin() and admin_user_id = auth.uid());

create or replace function public.admin_set_my_timeclock_test_location(
  _lat numeric,
  _lng numeric,
  _accuracy_m numeric,
  _radius_m numeric default 150,
  _label text default 'Admin timeclock test location',
  _expires_at timestamptz default now() + interval '14 days'
)
returns public.timeclock_admin_test_locations
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_radius numeric := least(greatest(coalesce(_radius_m, 150), 25), 300);
  v_row public.timeclock_admin_test_locations;
begin
  if not public.is_admin() then
    raise exception 'Admin permissions are required';
  end if;

  if _lat is null or _lng is null then
    raise exception 'Location required' using errcode = '22023';
  end if;

  if coalesce(_accuracy_m, 9999) > 150 then
    raise exception 'Location accuracy is too low to save this test location (accuracy=% m)', round(_accuracy_m, 1);
  end if;

  update public.timeclock_admin_test_locations
  set active = false
  where admin_user_id = auth.uid()
    and active is true;

  insert into public.timeclock_admin_test_locations (
    admin_user_id, label, lat, lng, radius_m, active, expires_at, created_by
  ) values (
    auth.uid(),
    coalesce(nullif(trim(_label), ''), 'Admin timeclock test location'),
    _lat,
    _lng,
    v_radius,
    true,
    _expires_at,
    auth.uid()
  )
  returning * into v_row;

  return v_row;
end;
$function$;

create or replace function public.timeclock_admin_test_location_allows(
  _lat numeric,
  _lng numeric,
  _accuracy_m numeric
)
returns boolean
language sql
stable
security definer
set search_path = public
as $function$
  select public.is_admin()
    and _lat is not null
    and _lng is not null
    and coalesce(_accuracy_m, 9999) <= 150
    and exists (
      select 1
      from public.timeclock_admin_test_locations l
      where l.admin_user_id = auth.uid()
        and l.active is true
        and (l.expires_at is null or l.expires_at > now())
        and public.haversine_meters(_lat, _lng, l.lat, l.lng) <= l.radius_m
    );
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
  v_store public.store_locations%rowtype;
  v_schedule_store_id uuid;
  v_target_store_id uuid;
  v_distance numeric;
  v_accuracy_max numeric := 150;
  v_row public.time_entries;
  v_now timestamptz := now();
  v_exp record;
  v_codes text[] := '{}'::text[];
  v_note text := null;
  v_geo_ok boolean := false;
  v_admin_test_ok boolean := false;
begin
  perform public.assert_unlocked_for_ts(v_now, 'clock-in');

  if coalesce(trim(_photo_path), '') = '' then
    raise exception 'Photo required' using errcode = '22023';
  end if;
  if _lat is null or _lng is null then
    raise exception 'Location required' using errcode = '22023';
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

  select ews.store_id
    into v_schedule_store_id
  from public.effective_work_shifts ews
  left join public.store_locations sl on sl.id = ews.store_id
  where ews.employee_id = _employee_id
    and ews.work_date = v_today
    and ews.start_local is not null
    and ews.end_local is not null
  order by abs(extract(epoch from (((ews.work_date::timestamp + ews.start_local) at time zone coalesce(sl.timezone, 'America/New_York')) - v_now))) asc
  limit 1;

  v_target_store_id := coalesce(_store_id, v_schedule_store_id);

  if v_target_store_id is null then
    select s.id, public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      into v_target_store_id, v_distance
    from public.store_locations s
    where s.active is true
    order by distance_m asc nulls last, s.created_at asc
    limit 1;
  end if;

  if v_target_store_id is not null then
    select * into v_store
    from public.store_locations s
    where s.id = v_target_store_id;
  end if;

  if v_store.id is not null and v_distance is null then
    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  if _accuracy_m is null then
    _accuracy_m := 9999;
  end if;

  v_geo_ok := (
    v_store.id is not null
    and v_store.active is true
    and v_distance <= coalesce(v_store.radius_m, 0)
    and _accuracy_m <= v_accuracy_max
  );

  v_admin_test_ok := public.timeclock_admin_test_location_allows(_lat, _lng, _accuracy_m);

  if not v_geo_ok and not v_admin_test_ok then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)', round(v_distance, 1), round(_accuracy_m, 1);
  end if;

  if v_admin_test_ok and not v_geo_ok then
    v_codes := array_append(v_codes, 'ADMIN_TEST_LOCATION');
    v_note := concat_ws(' ', v_note, 'Admin test location used outside store geofence.');
  end if;

  select * into v_exp
  from public.resolve_expected_window(_employee_id, v_now, v_store.id);

  if v_exp.expected_start_ts is null or v_exp.expected_end_ts is null then
    v_codes := array_append(v_codes, 'UNSCHEDULED_DAY');
    v_note := concat_ws(' ', v_note, 'No schedule (override/recurring) for this day. Punch accepted for admin review.');
  else
    if v_now < v_exp.expected_start_ts - (coalesce(v_store.schedule_grace_in_m, 5) || ' minutes')::interval then
      v_codes := array_append(v_codes, 'EARLY_CLOCK_IN');
    elsif v_now > v_exp.expected_start_ts + (coalesce(v_store.schedule_grace_in_m, 5) || ' minutes')::interval then
      v_codes := array_append(v_codes, 'LATE_CLOCK_IN');
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
      (v_geo_ok or v_admin_test_ok),
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

create or replace function public.clock_out_now_geo(
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
  v_user_id uuid;
  v_is_admin boolean := public.is_admin();
  v_entry public.time_entries;
  v_target_store_id uuid;
  v_store public.store_locations%rowtype;
  v_dist numeric;
  v_geo_ok boolean := false;
  v_admin_test_ok boolean := false;
  v_accuracy_max numeric := 150;
begin
  if coalesce(trim(_photo_path), '') = '' then
    raise exception 'Photo required' using errcode = '22023';
  end if;
  if _lat is null or _lng is null then
    raise exception 'Location required' using errcode = '22023';
  end if;

  select e.user_id into v_user_id
  from public.employees e
  where e.id = _employee_id;

  if v_user_id is null then
    raise exception 'Employee not found';
  end if;

  if (not v_is_admin) and (v_user_id <> auth.uid()) then
    raise exception 'Not allowed';
  end if;

  select *
  into v_entry
  from public.time_entries t
  where t.employee_id = _employee_id
    and t.clock_out is null
  order by t.clock_in desc
  limit 1;

  if v_entry.id is null then
    raise exception 'No open shift to clock out';
  end if;

  v_target_store_id := coalesce(_store_id, v_entry.store_id);

  if v_target_store_id is null then
    select s.id, public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      into v_target_store_id, v_dist
    from public.store_locations s
    where s.active is true
    order by distance_m asc nulls last, s.created_at asc
    limit 1;
  end if;

  if v_target_store_id is not null then
    select * into v_store
    from public.store_locations s
    where s.id = v_target_store_id;
  end if;

  if v_store.id is not null and v_dist is null then
    v_dist := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  if _accuracy_m is null then
    _accuracy_m := 9999;
  end if;

  v_geo_ok := (
    v_store.id is not null
    and v_store.active is true
    and v_dist <= coalesce(v_store.radius_m, 0)
    and _accuracy_m <= v_accuracy_max
  );

  v_admin_test_ok := public.timeclock_admin_test_location_allows(_lat, _lng, _accuracy_m);

  if not v_geo_ok and not v_admin_test_ok then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)', round(v_dist, 1), round(_accuracy_m, 1);
  end if;

  update public.time_entries
  set clock_out = now(),
      clock_out_lat = _lat,
      clock_out_lng = _lng,
      clock_out_accuracy_m = _accuracy_m,
      clock_out_distance_m = v_dist,
      geo_ok_out = (v_geo_ok or v_admin_test_ok),
      store_id = coalesce(store_id, v_store.id),
      photo_out_path = _photo_path,
      schedule_codes = case
        when v_admin_test_ok and not v_geo_ok
          then array(select distinct x from unnest(coalesce(schedule_codes, '{}'::text[]) || array['ADMIN_TEST_LOCATION']) as x)
        else schedule_codes
      end,
      schedule_note = case
        when v_admin_test_ok and not v_geo_ok
          then concat_ws(' ', schedule_note, 'Admin test location used outside store geofence.')
        else schedule_note
      end
  where id = v_entry.id
  returning * into v_entry;

  perform public.sync_shift_anomalies(v_entry.id);
  return v_entry;
end;
$function$;

create or replace function public.start_break_now_geo(
  _employee_id uuid,
  _lat numeric,
  _lng numeric,
  _accuracy_m numeric,
  _photo_path text,
  _store_id uuid default null::uuid
)
returns public.time_breaks
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_emp_user uuid;
  v_entry_id uuid;
  v_shift_store_id uuid;
  v_store public.store_locations%rowtype;
  v_distance numeric;
  v_break public.time_breaks;
  v_now timestamptz := now();
  v_geo_ok boolean := false;
  v_admin_test_ok boolean := false;
  v_accuracy_max numeric := 150;
begin
  perform public.assert_unlocked_for_ts(v_now, 'start break');

  if coalesce(trim(_photo_path), '') = '' then
    raise exception 'Photo required' using errcode = '22023';
  end if;
  if _lat is null or _lng is null then
    raise exception 'Location required' using errcode = '22023';
  end if;

  select e.user_id into v_emp_user
  from public.employees e
  where e.id = _employee_id;

  if v_emp_user is null then raise exception 'Employee not found'; end if;
  if v_emp_user <> auth.uid() and not public.is_admin() then raise exception 'Not allowed'; end if;

  v_entry_id := public.get_open_shift_id(_employee_id);
  if v_entry_id is null then
    raise exception 'No open shift to start a break';
  end if;

  if exists (
    select 1
    from public.time_breaks b
    where b.time_entry_id = v_entry_id
      and b.ended_at is null
  ) then
    raise exception 'A break is already in progress';
  end if;

  select coalesce(_store_id, t.store_id) into v_shift_store_id
  from public.time_entries t
  where t.id = v_entry_id;

  if v_shift_store_id is null then
    select s.id, public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      into v_shift_store_id, v_distance
    from public.store_locations s
    where s.active is true
    order by distance_m asc nulls last, s.created_at asc
    limit 1;
  end if;

  if v_shift_store_id is not null then
    select * into v_store
    from public.store_locations s
    where s.id = v_shift_store_id;
  end if;

  if v_store.id is not null and v_distance is null then
    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  if _accuracy_m is null then _accuracy_m := 9999; end if;

  v_geo_ok := (
    v_store.id is not null
    and v_store.active is true
    and v_distance <= coalesce(v_store.radius_m, 0)
    and _accuracy_m <= v_accuracy_max
  );

  v_admin_test_ok := public.timeclock_admin_test_location_allows(_lat, _lng, _accuracy_m);

  if not v_geo_ok and not v_admin_test_ok then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)', round(v_distance, 1), round(_accuracy_m, 1);
  end if;

  update public.time_entries
  set store_id = coalesce(store_id, v_store.id),
      schedule_codes = case
        when v_admin_test_ok and not v_geo_ok
          then array(select distinct x from unnest(coalesce(schedule_codes, '{}'::text[]) || array['ADMIN_TEST_LOCATION']) as x)
        else schedule_codes
      end,
      schedule_note = case
        when v_admin_test_ok and not v_geo_ok
          then concat_ws(' ', schedule_note, 'Admin test location used outside store geofence.')
        else schedule_note
      end
  where id = v_entry_id;

  insert into public.time_breaks (
    time_entry_id, started_at,
    start_lat, start_lng, start_accuracy_m,
    geo_ok_start, photo_start_path, break_codes
  ) values (
    v_entry_id, v_now,
    _lat, _lng, _accuracy_m,
    (v_geo_ok or v_admin_test_ok),
    _photo_path,
    case when v_admin_test_ok and not v_geo_ok then array['ADMIN_TEST_LOCATION'] else '{}'::text[] end
  )
  returning * into v_break;

  return v_break;
end;
$function$;

create or replace function public.end_break_now_geo(
  _employee_id uuid,
  _lat numeric,
  _lng numeric,
  _accuracy_m numeric,
  _photo_path text,
  _store_id uuid default null::uuid
)
returns public.time_breaks
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_emp_user uuid;
  v_entry_id uuid;
  v_shift_store_id uuid;
  v_store public.store_locations%rowtype;
  v_distance numeric;
  v_break public.time_breaks;
  v_break_id uuid;
  v_now timestamptz := now();
  v_geo_ok boolean := false;
  v_admin_test_ok boolean := false;
  v_accuracy_max numeric := 150;
begin
  perform public.assert_unlocked_for_ts(v_now, 'end break');

  if coalesce(trim(_photo_path), '') = '' then
    raise exception 'Photo required' using errcode = '22023';
  end if;
  if _lat is null or _lng is null then
    raise exception 'Location required' using errcode = '22023';
  end if;

  select e.user_id into v_emp_user
  from public.employees e
  where e.id = _employee_id;

  if v_emp_user is null then raise exception 'Employee not found'; end if;
  if v_emp_user <> auth.uid() and not public.is_admin() then raise exception 'Not allowed'; end if;

  v_entry_id := public.get_open_shift_id(_employee_id);
  if v_entry_id is null then
    raise exception 'No open shift to end a break';
  end if;

  select b.id into v_break_id
  from public.time_breaks b
  where b.time_entry_id = v_entry_id
    and b.ended_at is null
  order by b.started_at desc
  limit 1;

  if v_break_id is null then
    raise exception 'No active break to end';
  end if;

  select coalesce(_store_id, t.store_id) into v_shift_store_id
  from public.time_entries t
  where t.id = v_entry_id;

  if v_shift_store_id is null then
    select s.id, public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      into v_shift_store_id, v_distance
    from public.store_locations s
    where s.active is true
    order by distance_m asc nulls last, s.created_at asc
    limit 1;
  end if;

  if v_shift_store_id is not null then
    select * into v_store
    from public.store_locations s
    where s.id = v_shift_store_id;
  end if;

  if v_store.id is not null and v_distance is null then
    v_distance := public.haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  if _accuracy_m is null then _accuracy_m := 9999; end if;

  v_geo_ok := (
    v_store.id is not null
    and v_store.active is true
    and v_distance <= coalesce(v_store.radius_m, 0)
    and _accuracy_m <= v_accuracy_max
  );

  v_admin_test_ok := public.timeclock_admin_test_location_allows(_lat, _lng, _accuracy_m);

  if not v_geo_ok and not v_admin_test_ok then
    raise exception 'Outside geofence or poor accuracy (distance=% m, accuracy=% m)', round(v_distance, 1), round(_accuracy_m, 1);
  end if;

  update public.time_entries
  set store_id = coalesce(store_id, v_store.id),
      schedule_codes = case
        when v_admin_test_ok and not v_geo_ok
          then array(select distinct x from unnest(coalesce(schedule_codes, '{}'::text[]) || array['ADMIN_TEST_LOCATION']) as x)
        else schedule_codes
      end,
      schedule_note = case
        when v_admin_test_ok and not v_geo_ok
          then concat_ws(' ', schedule_note, 'Admin test location used outside store geofence.')
        else schedule_note
      end
  where id = v_entry_id;

  update public.time_breaks
  set ended_at = v_now,
      end_lat = _lat,
      end_lng = _lng,
      end_accuracy_m = _accuracy_m,
      geo_ok_end = (v_geo_ok or v_admin_test_ok),
      photo_end_path = _photo_path,
      break_codes = case
        when v_admin_test_ok and not v_geo_ok
          then array(select distinct x from unnest(coalesce(break_codes, '{}'::text[]) || array['ADMIN_TEST_LOCATION']) as x)
        else coalesce(break_codes, '{}'::text[])
      end
  where id = v_break_id
  returning * into v_break;

  return v_break;
end;
$function$;

grant execute on function public.org_paid_break_minutes_per_day() to authenticated;
grant execute on function public.admin_set_my_timeclock_test_location(numeric, numeric, numeric, numeric, text, timestamptz) to authenticated;
grant execute on function public.timeclock_admin_test_location_allows(numeric, numeric, numeric) to authenticated;
grant execute on function public.clock_in_now_geo(uuid, numeric, numeric, numeric, text, uuid) to authenticated;
grant execute on function public.clock_out_now_geo(uuid, numeric, numeric, numeric, text, uuid) to authenticated;
grant execute on function public.start_break_now_geo(uuid, numeric, numeric, numeric, text, uuid) to authenticated;
grant execute on function public.end_break_now_geo(uuid, numeric, numeric, numeric, text, uuid) to authenticated;
