-- ============================================================
-- Migration: Break-start watcher + admin fallback SMS
-- - Adds 'break_started' to time_exception_alerts allowed types
-- - Updates notify_break_started() to:
--    (1) dedupe via time_exception_alerts (one per break id)
--    (2) immediately enqueue SMS to watchers (or admins if none)
--    (3) keep existing employee "5 min left" reminder scheduling
-- ============================================================


-- ============================================================
-- 1) Allow new alert_type: break_started
-- ============================================================

alter table public.time_exception_alerts
  drop constraint if exists time_exception_alerts_type_check;
alter table public.time_exception_alerts
  add constraint time_exception_alerts_type_check
  check (
    alert_type = any (
      array[
        'late_in'::text,
        'early_out'::text,
        'overtime'::text,
        'break_long'::text,
        'break_open_too_long'::text,
        'no_show'::text,
        'break_started'::text
      ]
    )
  );
-- ============================================================
-- 2) Update notify_break_started() (trigger calls this on INSERT)
-- ============================================================

create or replace function public.notify_break_started(_time_break_id uuid)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v record;
  v_cap int;
  v_send_at timestamptz;
  v_employee_phone text;

  v_tz text;
  v_local_time text;
  v_store_name text;
  v_body text;
begin
  -- Load break + employee + store context
  select
      b.id as time_break_id,
      b.time_entry_id,
      b.started_at,
      t.employee_id,
      t.store_id,
      e.display_name,
      coalesce(s.timezone, 'America/New_York') as timezone,
      coalesce(s.name, 'N/A') as store_name,
      coalesce(s.paid_break_cap_min, 30) as cap_min
    into v
  from public.time_breaks b
  join public.time_entries t on t.id = b.time_entry_id
  join public.employees e on e.id = t.employee_id
  left join public.store_locations s on s.id = t.store_id
  where b.id = _time_break_id;

  if not found then
    return;
  end if;

  v_tz := coalesce(v.timezone, 'America/New_York');
  v_store_name := coalesce(v.store_name, 'N/A');
  v_local_time := to_char((v.started_at at time zone v_tz), 'Mon DD, YYYY HH12:MI AM');

  -- ----------------------------------------------------------
  -- Dedupe: only one "break_started" alert per break id
  -- ----------------------------------------------------------
  begin
    insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id)
    values ('break_started', v.employee_id, v.store_id, 'time_breaks', _time_break_id);
  exception when unique_violation then
    -- already processed
    return;
  end;

  -- ----------------------------------------------------------
  -- Immediate SMS to watchers (or admins if no watchers)
  -- ----------------------------------------------------------
  v_body :=
    '📣 BREAK STARTED — ' || v.display_name || ' started break at ' || v_local_time || E'\n' ||
    'Store: ' || v_store_name;

  perform public.enqueue_alert_sms(
    v.employee_id,
    v.store_id,
    v_body,
    jsonb_build_object(
      'type','break_started',
      'time_break_id', _time_break_id,
      'time_entry_id', v.time_entry_id,
      'employee_id', v.employee_id,
      'store_id', v.store_id
    )
  );

  -- ----------------------------------------------------------
  -- Keep existing behavior: schedule "5 minutes left" reminder
  -- (to the employee’s own verified phone)
  -- ----------------------------------------------------------
  v_cap := greatest(coalesce(v.cap_min, 30), 1);
  v_send_at := v.started_at + make_interval(mins => greatest(v_cap - 5, 1));

  select up.phone_e164 into v_employee_phone
  from public.user_phones up
  where up.user_id = (select user_id from public.employees where id = v.employee_id)
    and up.can_sms is true
    and up.verified_at is not null
  limit 1;

  if v_employee_phone is not null then
    perform public.enqueue_sms(
      v_employee_phone,
      '⏳ Break reminder: 5 minutes left.',
      v_send_at,
      jsonb_build_object('type','break_5_left','time_break_id',_time_break_id)
    );
  end if;
end;
$function$;
