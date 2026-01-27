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
  v_body text;
  v_shift_key text;
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
    where (ews.work_date = (now() at time zone sl.timezone)::date)
  loop
    v_shift_start := (r.work_date + r.start_local) at time zone r.timezone;

    -- EXACT no-show threshold: 10 minutes after scheduled start
    v_deadline := v_shift_start + interval '10 minutes';

    if now() < v_deadline then
      continue;
    end if;

    v_shift_key := public.make_shift_key(r.employee_id, r.work_date, r.start_local, r.end_local, r.store_id);

    -- already alerted for this shift
    if exists (
      select 1
      from public.time_exception_alerts a
      where a.alert_type = 'no_show'
        and a.shift_key = v_shift_key
    ) then
      continue;
    end if;

    -- if employee has clocked in for this store on this local date, not a no-show
    if exists (
      select 1
      from public.time_entries te
      where te.employee_id = r.employee_id
        and te.store_id = r.store_id
        and (te.clock_in at time zone r.timezone)::date = r.work_date
    ) then
      continue;
    end if;

    -- record dedupe + enqueue
    insert into public.time_exception_alerts(alert_type, employee_id, store_id, ref_table, shift_key)
    values ('no_show', r.employee_id, r.store_id, 'shift', v_shift_key);

    v_body :=
      'OG Jewelers exception' || E'\n' ||
      'No-show detected (10 min after scheduled start).' || E'\n\n' ||
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
        'shift_key', v_shift_key
      )
    );
  end loop;
end;
$$;