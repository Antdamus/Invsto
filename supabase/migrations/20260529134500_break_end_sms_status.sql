-- Notify management whenever a worker closes a break.
-- The prior trigger only texted for long breaks; this sends the close summary
-- every time and still logs break_long when the policy limit is exceeded.

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
        'break_started'::text,
        'break_ended'::text
      ]
    )
  );

create or replace function public.notify_break_ended(_time_break_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Legacy trigger compatibility. Break-close management SMS is handled by
  -- tr_time_breaks_exceptions_au below so every close gets one audited message.
  return;
end;
$$;

create or replace function public.tr_time_breaks_exceptions_au()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  te record;
  sl record;
  v_limit interval;
  v_body text;
  v_duration interval;
  v_duration_min numeric;
  v_limit_min numeric;
  v_over_min numeric;
  v_is_seller_shift boolean := false;
  v_status text;
  v_policy text;
  v_started_local text;
  v_ended_local text;
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

  select *
    into sl
  from public.store_locations
  where id = te.store_id;

  select exists (
    select 1
    from public.seller_sale_shifts s
    where s.seller_employee_id = te.employee_id
      and s.store_id = te.store_id
      and s.status = any (public.seller_sale_active_statuses())
      and te.clock_in between s.start_at - interval '30 minutes' and s.end_at + interval '30 minutes'
  ) into v_is_seller_shift;

  if v_is_seller_shift then
    v_limit := interval '5 minutes';
    v_policy := '5 min seller live break';
  else
    v_limit := make_interval(mins => coalesce(sl.paid_break_cap_min, 30)) + interval '5 minutes';
    v_policy := coalesce(sl.paid_break_cap_min, 30)::text || ' min paid break + 5 min grace';
  end if;

  v_duration := new.ended_at - new.started_at;
  v_duration_min := round(extract(epoch from v_duration) / 60.0, 1);
  v_limit_min := round(extract(epoch from v_limit) / 60.0, 1);
  v_over_min := greatest(round(extract(epoch from (v_duration - v_limit)) / 60.0, 1), 0);
  v_status := case when v_duration > v_limit then 'OVER LIMIT by ' || v_over_min::text || ' min' else 'OK' end;
  v_started_local := to_char(new.started_at at time zone coalesce(sl.timezone, 'America/New_York'), 'Mon DD, YYYY HH12:MI AM');
  v_ended_local := to_char(new.ended_at at time zone coalesce(sl.timezone, 'America/New_York'), 'HH12:MI AM');

  begin
    insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id)
    values ('break_ended', te.employee_id, te.store_id, 'time_breaks', new.id);
  exception when unique_violation then
    return new;
  end;

  if v_duration > v_limit then
    begin
      insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, ref_id)
      values ('break_long', te.employee_id, te.store_id, 'time_breaks', new.id);
    exception when unique_violation then
      null;
    end;
  end if;

  v_body :=
    'OG Jewelers break ended' || E'\n' ||
    'Employee: ' || (select display_name from public.employees where id = te.employee_id) || E'\n' ||
    'Store: ' || coalesce(sl.name, 'N/A') || E'\n' ||
    'Break: ' || v_started_local || ' - ' || v_ended_local || E'\n' ||
    'Duration: ' || v_duration_min::text || ' min' || E'\n' ||
    'Policy: ' || v_policy || E'\n' ||
    'Status: ' || v_status;

  perform public.enqueue_alert_sms(
    te.employee_id,
    te.store_id,
    v_body,
    jsonb_build_object(
      'type','timeclock_break_ended',
      'alert_type', case when v_duration > v_limit then 'break_long' else 'break_ended' end,
      'break_status', case when v_duration > v_limit then 'over_limit' else 'ok' end,
      'time_break_id', new.id,
      'time_entry_id', te.id,
      'employee_id', te.employee_id,
      'store_id', te.store_id,
      'duration_min', v_duration_min,
      'policy_limit_min', v_limit_min,
      'over_by_min', v_over_min,
      'seller_sale_shift', v_is_seller_shift
    )
  );

  return new;
end;
$$;

drop trigger if exists trg_time_breaks_exceptions_au on public.time_breaks;
create trigger trg_time_breaks_exceptions_au
after update on public.time_breaks
for each row execute function public.tr_time_breaks_exceptions_au();
