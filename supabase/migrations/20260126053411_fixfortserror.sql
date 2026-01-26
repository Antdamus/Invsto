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
as $$
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
      sl.timezone,

      -- IMPORTANT: use unique internal names to avoid collisions
      ((ews.work_date + ews.start_local) at time zone sl.timezone) as calc_start_ts,
      ((ews.work_date + ews.end_local)   at time zone sl.timezone) as calc_end_ts,

      ews.source,
      public.make_shift_key(
        ews.employee_id, ews.work_date, ews.start_local, ews.end_local, ews.store_id
      ) as shift_key
    from public.effective_work_shifts ews
    join public.store_locations sl on sl.id = ews.store_id
    where ews.employee_id = _employee_id
      and ews.work_date = v_local_date
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

    -- only here do we expose the final column names
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
$$;
