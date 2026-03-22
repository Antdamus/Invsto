-- ============================================================
-- 1) Watcher routing table (A watches B)
-- ============================================================

create table if not exists public.employee_watchers (
  watched_employee_id uuid not null references public.employees(id) on delete cascade,
  watcher_employee_id uuid not null references public.employees(id) on delete cascade,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid null default auth.uid(),
  constraint employee_watchers_pkey primary key (watched_employee_id, watcher_employee_id),
  constraint employee_watchers_no_self check (watched_employee_id <> watcher_employee_id)
);
create index if not exists idx_employee_watchers_watched
on public.employee_watchers (watched_employee_id)
where active = true;
create index if not exists idx_employee_watchers_watcher
on public.employee_watchers (watcher_employee_id)
where active = true;
-- ============================================================
-- 2) Exception alert log (dedupe so we never spam)
-- ============================================================

create table if not exists public.time_exception_alerts (
  id uuid not null default gen_random_uuid(),
  alert_type text not null, -- late_in, early_out, overtime, break_long, break_open_too_long, no_show
  employee_id uuid not null references public.employees(id) on delete cascade,
  store_id uuid null references public.store_locations(id),
  ref_table text null,      -- 'time_entries' | 'time_breaks' | 'shift'
  ref_id uuid null,         -- time_entries.id or time_breaks.id
  shift_key text null,      -- stable identity for split shifts
  created_at timestamptz not null default now(),
  constraint time_exception_alerts_pkey primary key (id),
  constraint time_exception_alerts_type_check check (
    alert_type = any (array[
      'late_in','early_out','overtime',
      'break_long','break_open_too_long',
      'no_show'
    ])
  )
);
-- Dedupe: event-row based alerts
create unique index if not exists uq_time_exception_alerts_ref
on public.time_exception_alerts (alert_type, ref_table, ref_id)
where ref_id is not null;
-- Dedupe: schedule/shift based alerts
create unique index if not exists uq_time_exception_alerts_shift
on public.time_exception_alerts (alert_type, shift_key)
where shift_key is not null;
-- ============================================================
-- Helper: recipients for a watched employee (watchers or admin fallback)
-- Returns phone_e164 values
-- ============================================================

create or replace function public.get_alert_recipient_phones(_employee_id uuid)
returns table (phone_e164 text)
language sql
security definer
set search_path = public
as $$
  with watcher_phones as (
    select distinct up.phone_e164
    from public.employee_watchers ew
    join public.employees w on w.id = ew.watcher_employee_id
    join public.user_phones up on up.user_id = w.user_id
    where ew.watched_employee_id = _employee_id
      and ew.active = true
      and w.active = true
      and up.can_sms = true
  ),
  admin_phones as (
    select distinct up.phone_e164
    from public.employees a
    join public.user_phones up on up.user_id = a.user_id
    where a.active = true
      and a.role = 'admin'
      and up.can_sms = true
  )
  select phone_e164 from watcher_phones
  union all
  select phone_e164 from admin_phones
  where not exists (select 1 from watcher_phones);
$$;
-- ============================================================
-- Helper: build stable shift_key for split shifts
-- ============================================================

create or replace function public.make_shift_key(
  _employee_id uuid,
  _work_date date,
  _start_local time,
  _end_local time,
  _store_id uuid
)
returns text
language sql
immutable
as $$
  select
    _employee_id::text || '|' ||
    _work_date::text || '|' ||
    _start_local::text || '|' ||
    _end_local::text || '|' ||
    coalesce(_store_id::text, 'null');
$$;
-- ============================================================
-- Helper: match scheduled shift using Rule A (nearest start time)
-- Finds effective shifts on the event's local date (store tz),
-- chooses the one whose start is closest to event_ts, within window.
-- ============================================================

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
  -- If store_id is known, use its timezone; else default (still works)
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
      ((ews.work_date + ews.start_local) at time zone sl.timezone) as shift_start_ts,
      ((ews.work_date + ews.end_local) at time zone sl.timezone) as shift_end_ts,
      ews.source,
      public.make_shift_key(ews.employee_id, ews.work_date, ews.start_local, ews.end_local, ews.store_id) as shift_key
    from public.effective_work_shifts ews
    join public.store_locations sl on sl.id = ews.store_id
    where ews.employee_id = _employee_id
      and ews.work_date = v_local_date
  ),
  ranked as (
    select *,
      abs(extract(epoch from (shift_start_ts - _event_ts))) as abs_sec
    from candidates
    where abs(extract(epoch from (shift_start_ts - _event_ts))) <= (_window_hours * 3600)
  )
  select *
  from ranked
  order by abs_sec asc
  limit 1;
end;
$$;
-- ============================================================
-- Helper: enqueue SMS to all recipients for an employee
-- (watchers OR admin fallback) with meta payload
-- ============================================================

create or replace function public.enqueue_alert_sms(
  _watched_employee_id uuid,
  _to_store_id uuid,
  _body text,
  _meta jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
begin
  for p in select phone_e164 from public.get_alert_recipient_phones(_watched_employee_id)
  loop
    insert into public.sms_outbox(to_phone, body, status, meta)
    values (p.phone_e164, _body, 'pending', coalesce(_meta, '{}'::jsonb));
  end loop;
end;
$$;
-- ============================================================
-- Trigger: time_entries AFTER INSERT (clock-in) → late clock-in alert
-- Uses store grace_in + scheduled shift start.
-- ============================================================

create or replace function public.tr_time_entries_exceptions_ai()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_grace_in integer;
  v_store_name text;
  v_body text;
begin
  -- Need store_id for timezone + grace; if null, skip (or you can enforce store_id in app)
  if new.store_id is null then
    return new;
  end if;

  select sl.schedule_grace_in_m, sl.name into v_grace_in, v_store_name
  from public.store_locations sl
  where sl.id = new.store_id;

  -- Match scheduled shift (Rule A)
  select * into s
  from public.match_effective_shift_rule_a(new.employee_id, new.store_id, new.clock_in, 6);

  if s.shift_key is null then
    return new; -- no scheduled shift matched → no exception alert (by design)
  end if;

  -- Late = clock_in > scheduled_start + grace
  if new.clock_in > (s.shift_start_ts + make_interval(mins => coalesce(v_grace_in, 0))) then
    -- Dedup by time_entry id
    begin
      insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id, shift_key)
      values ('late_in', new.employee_id, new.store_id, 'time_entries', new.id, s.shift_key);
    exception when unique_violation then
      return new;
    end;

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      'Late clock-in detected.' || E'\n\n' ||
      'Employee: ' || (select display_name from public.employees where id = new.employee_id) || E'\n' ||
      'Store: ' || coalesce(v_store_name, 'N/A') || E'\n' ||
      'Scheduled: ' || to_char(s.start_local, 'HH12:MI AM') || E'\n' ||
      'Actual: ' || to_char(new.clock_in at time zone s.timezone, 'HH12:MI AM');

    perform public.enqueue_alert_sms(
      new.employee_id,
      new.store_id,
      v_body,
      jsonb_build_object(
        'type','time_exception',
        'alert_type','late_in',
        'time_entry_id', new.id,
        'shift_key', s.shift_key
      )
    );
  end if;

  return new;
end;
$$;
drop trigger if exists trg_time_entries_exceptions_ai on public.time_entries;
create trigger trg_time_entries_exceptions_ai
after insert on public.time_entries
for each row execute function public.tr_time_entries_exceptions_ai();
-- ============================================================
-- Trigger: time_entries AFTER UPDATE (clock-out set) → early/out + overtime
-- Thresholds: 5 minutes for early and 5 minutes for overtime
-- ============================================================

create or replace function public.tr_time_entries_exceptions_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  s record;
  v_store_name text;
  v_body text;
  v_thresh interval := interval '5 minutes';
begin
  -- Only act when clock_out transitions from null → non-null
  if old.clock_out is not null or new.clock_out is null then
    return new;
  end if;

  if new.store_id is null then
    return new;
  end if;

  select sl.name into v_store_name
  from public.store_locations sl
  where sl.id = new.store_id;

  -- Match scheduled shift (Rule A) using clock_in as anchor if available; else clock_out
  select * into s
  from public.match_effective_shift_rule_a(new.employee_id, new.store_id, coalesce(new.clock_in, new.clock_out), 6);

  if s.shift_key is null then
    return new;
  end if;

  -- Early out
  if new.clock_out < (s.shift_end_ts - v_thresh) then
    begin
      insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id, shift_key)
      values ('early_out', new.employee_id, new.store_id, 'time_entries', new.id, s.shift_key);
    exception when unique_violation then
      null;
    end;

    if found then
      v_body :=
        'OG Jewelers exception' || E'\n' ||
        'Early clock-out detected.' || E'\n\n' ||
        'Employee: ' || (select display_name from public.employees where id = new.employee_id) || E'\n' ||
        'Store: ' || coalesce(v_store_name,'N/A') || E'\n' ||
        'Scheduled end: ' || to_char(s.end_local, 'HH12:MI AM') || E'\n' ||
        'Actual out: ' || to_char(new.clock_out at time zone s.timezone, 'HH12:MI AM');

      perform public.enqueue_alert_sms(
        new.employee_id,
        new.store_id,
        v_body,
        jsonb_build_object(
          'type','time_exception',
          'alert_type','early_out',
          'time_entry_id', new.id,
          'shift_key', s.shift_key
        )
      );
    end if;
  end if;

  -- Overtime
  if new.clock_out > (s.shift_end_ts + v_thresh) then
    begin
      insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id, shift_key)
      values ('overtime', new.employee_id, new.store_id, 'time_entries', new.id, s.shift_key);
    exception when unique_violation then
      null;
    end;

    if found then
      v_body :=
        'OG Jewelers exception' || E'\n' ||
        'Overtime detected.' || E'\n\n' ||
        'Employee: ' || (select display_name from public.employees where id = new.employee_id) || E'\n' ||
        'Store: ' || coalesce(v_store_name,'N/A') || E'\n' ||
        'Scheduled end: ' || to_char(s.end_local, 'HH12:MI AM') || E'\n' ||
        'Actual out: ' || to_char(new.clock_out at time zone s.timezone, 'HH12:MI AM');

      perform public.enqueue_alert_sms(
        new.employee_id,
        new.store_id,
        v_body,
        jsonb_build_object(
          'type','time_exception',
          'alert_type','overtime',
          'time_entry_id', new.id,
          'shift_key', s.shift_key
        )
      );
    end if;
  end if;

  return new;
end;
$$;
drop trigger if exists trg_time_entries_exceptions_au on public.time_entries;
create trigger trg_time_entries_exceptions_au
after update on public.time_entries
for each row execute function public.tr_time_entries_exceptions_au();
-- ============================================================
-- Trigger: time_breaks AFTER UPDATE when ended_at becomes non-null → break_long
-- Uses store_locations.paid_break_cap_min + 5 minutes
-- ============================================================

create or replace function public.tr_time_breaks_exceptions_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  te record;
  sl record;
  v_cap interval;
  v_body text;
  v_duration interval;
begin
  if old.ended_at is not null or new.ended_at is null then
    return new;
  end if;

  select * into te
  from public.time_entries
  where id = new.time_entry_id;

  if te.id is null or te.store_id is null then
    return new;
  end if;

  select * into sl
  from public.store_locations
  where id = te.store_id;

  v_cap := make_interval(mins => coalesce(sl.paid_break_cap_min, 30)) + interval '5 minutes';
  v_duration := new.ended_at - new.started_at;

  if v_duration > v_cap then
    begin
      insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id)
      values ('break_long', te.employee_id, te.store_id, 'time_breaks', new.id);
    exception when unique_violation then
      return new;
    end;

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      'Break too long.' || E'\n\n' ||
      'Employee: ' || (select display_name from public.employees where id = te.employee_id) || E'\n' ||
      'Store: ' || coalesce(sl.name,'N/A') || E'\n' ||
      'Duration: ' || trim(to_char(extract(epoch from v_duration)/60, '99990')) || ' min';

    perform public.enqueue_alert_sms(
      te.employee_id,
      te.store_id,
      v_body,
      jsonb_build_object(
        'type','time_exception',
        'alert_type','break_long',
        'time_break_id', new.id,
        'time_entry_id', te.id
      )
    );
  end if;

  return new;
end;
$$;
drop trigger if exists trg_time_breaks_exceptions_au on public.time_breaks;
create trigger trg_time_breaks_exceptions_au
after update on public.time_breaks
for each row execute function public.tr_time_breaks_exceptions_au();
create or replace function public.scan_no_show_exceptions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_deadline timestamptz;
  v_shift_start timestamptz;
  v_shift_end timestamptz;
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
      sl.timezone,
      sl.schedule_grace_in_m
    from public.effective_work_shifts ews
    join public.store_locations sl on sl.id = ews.store_id
    where (ews.work_date = (now() at time zone sl.timezone)::date)
  loop
    v_shift_start := (r.work_date + r.start_local) at time zone r.timezone;
    v_shift_end   := (r.work_date + r.end_local) at time zone r.timezone;

    v_deadline := v_shift_start
      + make_interval(mins => coalesce(r.schedule_grace_in_m, 0))
      + interval '10 minutes';

    -- only evaluate after deadline passed
    if now() < v_deadline then
      continue;
    end if;

    -- if already alerted for this shift, skip
    if exists (
      select 1
      from public.time_exception_alerts a
      where a.alert_type = 'no_show'
        and a.shift_key = public.make_shift_key(r.employee_id, r.work_date, r.start_local, r.end_local, r.store_id)
    ) then
      continue;
    end if;

    -- if employee has clocked in near this shift, not a no-show
    if exists (
      select 1
      from public.time_entries te
      where te.employee_id = r.employee_id
        and te.store_id = r.store_id
        and te.clock_in between (v_shift_start - interval '4 hours') and (v_shift_start + interval '4 hours')
    ) then
      continue;
    end if;

    -- record dedupe + enqueue
    insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, shift_key)
    values (
      'no_show',
      r.employee_id,
      r.store_id,
      'shift',
      public.make_shift_key(r.employee_id, r.work_date, r.start_local, r.end_local, r.store_id)
    );

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      'No-show detected.' || E'\n\n' ||
      'Employee: ' || (select display_name from public.employees where id = r.employee_id) || E'\n' ||
      'Store: ' || r.store_name || E'\n' ||
      'Scheduled: ' || to_char(r.start_local, 'HH12:MI AM') || ' – ' || to_char(r.end_local, 'HH12:MI AM');

    perform public.enqueue_alert_sms(
      r.employee_id,
      r.store_id,
      v_body,
      jsonb_build_object(
        'type','time_exception',
        'alert_type','no_show',
        'shift_key', public.make_shift_key(r.employee_id, r.work_date, r.start_local, r.end_local, r.store_id)
      )
    );
  end loop;
end;
$$;
create or replace function public.scan_open_break_too_long_exceptions()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  r record;
  v_cap interval;
  v_body text;
  v_minutes numeric;
begin
  for r in
    select
      tb.id as break_id,
      tb.started_at,
      te.id as time_entry_id,
      te.employee_id,
      te.store_id,
      sl.name as store_name,
      sl.paid_break_cap_min,
      sl.timezone
    from public.time_breaks tb
    join public.time_entries te on te.id = tb.time_entry_id
    join public.store_locations sl on sl.id = te.store_id
    where tb.ended_at is null
  loop
    -- Already alerted?
    if exists (
      select 1
      from public.time_exception_alerts a
      where a.alert_type = 'break_open_too_long'
        and a.ref_table = 'time_breaks'
        and a.ref_id = r.break_id
    ) then
      continue;
    end if;

    v_cap := make_interval(mins => coalesce(r.paid_break_cap_min, 30)) + interval '5 minutes';

    if now() <= (r.started_at + v_cap) then
      continue;
    end if;

    insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id)
    values ('break_open_too_long', r.employee_id, r.store_id, 'time_breaks', r.break_id);

    v_minutes := round(extract(epoch from (now() - r.started_at)) / 60.0, 1);

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      'Break over limit (still open).' || E'\n\n' ||
      'Employee: ' || (select display_name from public.employees where id = r.employee_id) || E'\n' ||
      'Store: ' || r.store_name || E'\n' ||
      'Open for: ' || v_minutes::text || ' min';

    perform public.enqueue_alert_sms(
      r.employee_id,
      r.store_id,
      v_body,
      jsonb_build_object(
        'type','time_exception',
        'alert_type','break_open_too_long',
        'time_break_id', r.break_id,
        'time_entry_id', r.time_entry_id
      )
    );
  end loop;
end;
$$;
