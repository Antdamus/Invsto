alter table public.timeclock_day_exceptions
  add column if not exists allowed_clock_in_store_ids uuid[] not null default '{}'::uuid[],
  add column if not exists allowed_clock_out_store_ids uuid[] not null default '{}'::uuid[];

create index if not exists timeclock_day_exceptions_allowed_in_store_ids_idx
  on public.timeclock_day_exceptions using gin(allowed_clock_in_store_ids);

create index if not exists timeclock_day_exceptions_allowed_out_store_ids_idx
  on public.timeclock_day_exceptions using gin(allowed_clock_out_store_ids);

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
set search_path to 'public'
as $function$
declare
  v_user_id uuid;
  v_is_admin boolean := is_admin();
  v_today date := public.org_today_date();

  v_exc record;
  v_entry public.time_entries;

  v_target_store_id uuid;
  v_store record;
  v_dist numeric;
  v_geo_ok boolean;
begin
  select e.user_id into v_user_id
  from public.employees e
  where e.id = _employee_id;

  if v_user_id is null then
    raise exception 'Employee not found';
  end if;

  if (not v_is_admin) and (v_user_id <> auth.uid()) then
    raise exception 'Not allowed';
  end if;

  if (not v_is_admin) and (_store_id is not null) then
    raise exception 'Not allowed to choose store';
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

  select *
  into v_exc
  from public.timeclock_day_exceptions x
  where x.employee_id = _employee_id
    and x.work_date = v_today
  limit 1;

  if _store_id is not null then
    v_target_store_id := _store_id;

  elsif cardinality(coalesce(v_exc.allowed_clock_out_store_ids, '{}'::uuid[])) > 0 then
    select s.id, public.haversine_meters(_lat, _lng, s.lat, s.lng) as distance_m
      into v_target_store_id, v_dist
    from public.store_locations s
    where s.active is true
      and s.id = any(v_exc.allowed_clock_out_store_ids)
      and public.haversine_meters(_lat, _lng, s.lat, s.lng) <= s.radius_m
    order by distance_m asc
    limit 1;

    if v_target_store_id is null then
      raise exception 'Clock-out is only allowed at selected route stores today, and you are not inside one of them';
    end if;

  elsif v_exc.allow_clock_out_any_store is true then
    select store_id, distance_m into v_target_store_id, v_dist
    from public.pick_store_by_geo(_lat, _lng);

    if v_target_store_id is null then
      raise exception 'Clock-out allowed at any store today, but you are not inside any store geofence';
    end if;

  elsif v_exc.clock_out_store_id is not null then
    v_target_store_id := v_exc.clock_out_store_id;

  else
    if v_entry.store_id is null then
      raise exception 'Shift has no store_id; admin must fix this shift';
    end if;
    v_target_store_id := v_entry.store_id;
  end if;

  select * into v_store
  from public.store_locations s
  where s.id = v_target_store_id;

  if v_store.id is null then
    raise exception 'Store not found';
  end if;

  if (not v_is_admin) and (v_store.active is distinct from true) then
    raise exception 'Store is inactive';
  end if;

  if v_dist is null then
    v_dist := haversine_meters(_lat, _lng, v_store.lat, v_store.lng);
  end if;

  v_geo_ok := (v_dist <= v_store.radius_m);

  if not v_geo_ok then
    raise exception 'You are not at the required store (%). Distance %.0fm, allowed %.0fm',
      v_store.name, v_dist, v_store.radius_m;
  end if;

  update public.time_entries
  set clock_out = now(),
      clock_out_lat = _lat, clock_out_lng = _lng,
      clock_out_accuracy_m = _accuracy_m,
      clock_out_distance_m = v_dist,
      geo_ok_out = true,
      photo_out_path = _photo_path
  where id = v_entry.id
  returning * into v_entry;

  perform public.sync_shift_anomalies(v_entry.id);
  return v_entry;
end;
$function$;
