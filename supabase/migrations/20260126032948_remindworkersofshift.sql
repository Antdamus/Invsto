-- ============================================================
-- VIEW: effective_work_shifts
-- Overrides fully replace regular schedules for that day
-- ============================================================

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
    'override'::text as source
  from public.work_schedule_overrides o
  where o.off = false
),
regular_shifts as (
  select
    ws.employee_id,
    d.work_date,
    ws.start_local,
    ws.end_local,
    ws.store_id,
    'regular'::text as source
  from public.work_schedules ws
  join lateral (
    select generate_series(
      ws.effective_from,
      coalesce(ws.effective_to, ws.effective_from + interval '2 years'),
      interval '1 day'
    )::date as work_date
  ) d on true
  where ws.active = true
    and extract(dow from d.work_date) = ws.weekday
    and not exists (
      select 1
      from override_days od
      where od.employee_id = ws.employee_id
        and od.work_date = d.work_date
    )
)
select * from override_shifts
union all
select * from regular_shifts;

-- ============================================================
-- TABLE: shift_sms_reminders
-- ============================================================

create table if not exists public.shift_sms_reminders (
  id uuid not null default gen_random_uuid(),
  employee_id uuid not null,
  work_date date not null,
  start_local time not null,
  end_local time not null,
  store_id uuid null,
  reminder_type text not null default 'shift_30_min',
  sent_at timestamptz not null default now(),
  constraint shift_sms_reminders_pkey primary key (id),
  constraint shift_sms_reminders_unique unique (
    employee_id,
    work_date,
    start_local,
    end_local,
    store_id,
    reminder_type
  )
);

-- ============================================================
-- FUNCTION: enqueue_upcoming_shift_reminders
-- ============================================================

create or replace function public.enqueue_upcoming_shift_reminders()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_user_id uuid;
  v_phone text;
  v_store_name text;
  v_tz text;
  v_shift_start timestamptz;
  v_send_after timestamptz;
  v_body text;
begin
  for r in
    select
      ews.employee_id,
      ews.work_date,
      ews.start_local,
      ews.end_local,
      ews.store_id,
      sl.name as store_name,
      sl.timezone
    from public.effective_work_shifts ews
    join public.store_locations sl on sl.id = ews.store_id
    where not exists (
      select 1
      from public.shift_sms_reminders sr
      where sr.employee_id = ews.employee_id
        and sr.work_date = ews.work_date
        and sr.start_local = ews.start_local
        and sr.end_local = ews.end_local
        and sr.store_id is not distinct from ews.store_id
        and sr.reminder_type = 'shift_30_min'
    )
  loop
    -- Compute shift start in store timezone
    v_shift_start :=
      (r.work_date + r.start_local)
      at time zone r.timezone;

    -- Only consider shifts starting now .. next 30 minutes OR already started (late create)
    if v_shift_start > now() + interval '30 minutes' then
      continue;
    end if;

    -- Resolve auth user
    select e.user_id into v_user_id
    from public.employees e
    where e.id = r.employee_id;

    if v_user_id is null then
      continue;
    end if;

    -- Resolve SMS-capable phone
    select up.phone_e164 into v_phone
    from public.user_phones up
    where up.user_id = v_user_id
      and up.can_sms = true;

    if v_phone is null then
      continue;
    end if;

    -- Send immediately if <30 min
    v_send_after := greatest(now(), v_shift_start - interval '30 minutes');

    -- Build message
    v_body :=
      'OG Jewelers reminder' || E'\n' ||
      'Your shift starts soon.' || E'\n\n' ||
      'Date: ' || to_char(r.work_date, 'Dy Mon DD, YYYY') || E'\n' ||
      'Time: ' ||
        to_char(r.start_local, 'HH12:MI AM') || ' – ' ||
        to_char(r.end_local, 'HH12:MI AM') || E'\n' ||
      'Location: ' || r.store_name;

    -- Enqueue SMS
    insert into public.sms_outbox (
      to_phone,
      body,
      send_after,
      status,
      meta
    )
    values (
      v_phone,
      v_body,
      v_send_after,
      'pending',
      jsonb_build_object(
        'type', 'shift_30_min_reminder',
        'employee_id', r.employee_id,
        'work_date', r.work_date,
        'start_local', r.start_local,
        'end_local', r.end_local,
        'store_id', r.store_id
      )
    );

    -- Log reminder
    insert into public.shift_sms_reminders (
      employee_id,
      work_date,
      start_local,
      end_local,
      store_id
    )
    values (
      r.employee_id,
      r.work_date,
      r.start_local,
      r.end_local,
      r.store_id
    );
  end loop;
end;
$$;

