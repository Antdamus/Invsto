-- A correction changes worked time, never the original punch photo/location or breaks.
begin;

create or replace function public.admin_correct_shift_time(
  _time_entry_id uuid, _expected_clock_in timestamptz, _expected_clock_out timestamptz,
  _new_clock_in timestamptz, _new_clock_out timestamptz, _reason text
) returns public.time_entries
language plpgsql security definer set search_path = public
as $function$
declare
  v_before public.time_entries;
  v_after public.time_entries;
  v_employee uuid;
  v_changed text[] := '{}';
  v_expected record;
  v_grace_in integer;
  v_grace_out integer;
  v_codes text[];
  v_approval jsonb;
begin
  -- Authoritative role; user-editable JWT metadata is not sufficient.
  if auth.uid() is null or not exists (
    select 1 from public.employees where user_id = auth.uid() and role = 'admin' and active is true
  ) then raise exception 'Only an active administrator can correct time' using errcode = '42501'; end if;

  select employee_id into v_employee from public.time_entries where id = _time_entry_id;
  perform 1 from public.employees where id = v_employee for update;
  select * into v_before from public.time_entries where id = _time_entry_id for update;
  if v_before.id is null then raise exception 'Shift not found' using errcode = '22023'; end if;
  if v_before.clock_in is distinct from _expected_clock_in or v_before.clock_out is distinct from _expected_clock_out then
    raise exception 'This shift changed after you opened it. Close this form and reload the shift before correcting it.' using errcode = '40001';
  end if;
  if length(btrim(coalesce(_reason, ''))) < 3 or length(_reason) > 2000 then
    raise exception 'Explain the correction using 3 to 2000 characters' using errcode = '22023';
  end if;
  if _new_clock_in is null or not isfinite(_new_clock_in) or _new_clock_in > now() then
    raise exception 'Clock-in must be a valid time in the past' using errcode = '22023';
  end if;
  if v_before.clock_out is null and _new_clock_out is not null then
    raise exception 'This person is still clocked in. Use Close shift separately to clock them out.' using errcode = '22023';
  end if;
  if v_before.clock_out is not null and (_new_clock_out is null or not isfinite(_new_clock_out) or _new_clock_out > now() or _new_clock_out <= _new_clock_in) then
    raise exception 'Clock-out must be after clock-in and cannot be in the future' using errcode = '22023';
  end if;
  if _new_clock_in is distinct from v_before.clock_in then v_changed := array_append(v_changed, 'clock_in'); end if;
  if _new_clock_out is distinct from v_before.clock_out then v_changed := array_append(v_changed, 'clock_out'); end if;
  if cardinality(v_changed) = 0 then return v_before; end if;

  perform public.assert_unlocked_for_range(v_before.clock_in, coalesce(v_before.clock_out, now()), 'correct existing shift');
  perform public.assert_unlocked_for_range(_new_clock_in, coalesce(_new_clock_out, now()), 'correct new shift range');
  if exists (select 1 from public.time_entries t where t.employee_id = v_employee and t.id <> _time_entry_id
    and _new_clock_in < coalesce(t.clock_out, 'infinity'::timestamptz)
    and coalesce(_new_clock_out, 'infinity'::timestamptz) > t.clock_in) then
    raise exception 'These times overlap another shift for this employee' using errcode = '22023';
  end if;
  perform 1 from public.time_breaks where time_entry_id = _time_entry_id for update;
  if exists (select 1 from public.time_breaks b where b.time_entry_id = _time_entry_id and
    (b.started_at < _new_clock_in or (_new_clock_out is not null and (b.ended_at is null or b.ended_at > _new_clock_out or b.started_at > _new_clock_out)))) then
    raise exception 'The corrected shift must include all recorded breaks' using errcode = '22023';
  end if;

  select * into v_expected from public.resolve_expected_window(v_employee, _new_clock_in, v_before.store_id);
  select coalesce(schedule_grace_in_m, 5), coalesce(schedule_grace_out_m, 5)
    into v_grace_in, v_grace_out from public.store_locations where id = v_before.store_id;
  -- Recalculate time flags; retain unrelated flags such as location exceptions.
  select coalesce(array_agg(code), '{}'::text[]) into v_codes from unnest(coalesce(v_before.schedule_codes, '{}'::text[])) code
    where code not in ('UNSCHEDULED_DAY','EARLY_CLOCK_IN','LATE_CLOCK_IN','EARLY_CLOCK_OUT','LATE_CLOCK_OUT');
  if v_expected.expected_start_ts is null then v_codes := array_append(v_codes, 'UNSCHEDULED_DAY');
  elsif _new_clock_in < v_expected.expected_start_ts - make_interval(mins => coalesce(v_grace_in, 5)) then v_codes := array_append(v_codes, 'EARLY_CLOCK_IN');
  elsif _new_clock_in > v_expected.expected_start_ts + make_interval(mins => coalesce(v_grace_in, 5)) then v_codes := array_append(v_codes, 'LATE_CLOCK_IN'); end if;
  if _new_clock_out is not null and v_expected.expected_end_ts is not null then
    if _new_clock_out < v_expected.expected_end_ts - make_interval(mins => coalesce(v_grace_out, 5)) then v_codes := array_append(v_codes, 'EARLY_CLOCK_OUT');
    elsif _new_clock_out > v_expected.expected_end_ts + make_interval(mins => coalesce(v_grace_out, 5)) then v_codes := array_append(v_codes, 'LATE_CLOCK_OUT'); end if;
  end if;
  select to_jsonb(a) into v_approval from public.shift_approvals a where time_entry_id = _time_entry_id;
  update public.time_entries set clock_in = _new_clock_in, clock_out = _new_clock_out,
    expected_start_ts = v_expected.expected_start_ts, expected_end_ts = v_expected.expected_end_ts, schedule_codes = v_codes
    where id = _time_entry_id returning * into v_after;
  delete from public.shift_approvals where time_entry_id = _time_entry_id;
  insert into public.shift_adjustments(time_entry_id, editor_user_id, reason, fields_changed, old_value, new_value)
    values (_time_entry_id, auth.uid(), btrim(_reason), v_changed,
      to_jsonb(v_before) || jsonb_build_object('previous_approval', v_approval), to_jsonb(v_after));
  perform public.refresh_monthly_hours_all();
  perform public.refresh_payroll_period_hours();
  return v_after;
end;
$function$;
revoke all on function public.admin_correct_shift_time(uuid,timestamptz,timestamptz,timestamptz,timestamptz,text) from public;
grant execute on function public.admin_correct_shift_time(uuid,timestamptz,timestamptz,timestamptz,timestamptz,text) to authenticated;

-- Old clients and the existing Revert action receive the same validation/audit protections.
create or replace function public.admin_update_shift_time(
  _time_entry_id uuid, _new_clock_in timestamptz default null, _new_clock_out timestamptz default null, _reason text default null
) returns public.time_entries language plpgsql security definer set search_path = public
as $function$
declare v public.time_entries;
begin
  select * into v from public.time_entries where id = _time_entry_id;
  return public.admin_correct_shift_time(_time_entry_id, v.clock_in, v.clock_out,
    coalesce(_new_clock_in, v.clock_in), coalesce(_new_clock_out, v.clock_out), _reason);
end;
$function$;
revoke all on function public.admin_update_shift_time(uuid,timestamptz,timestamptz,text) from public;
grant execute on function public.admin_update_shift_time(uuid,timestamptz,timestamptz,text) to authenticated;

-- The employee can read only their own correction summary, not other workers' records.
create or replace function public.get_my_time_corrections(_entry_ids uuid[])
returns table(id uuid, time_entry_id uuid, edited_at timestamptz, editor_name text, reason text, old_value jsonb, new_value jsonb)
language sql stable security definer set search_path = public
as $function$
  select a.id, a.time_entry_id, a.edited_at, coalesce(editor.display_name, 'Administrator'), a.reason,
    jsonb_build_object('clock_in', a.old_value->'clock_in', 'clock_out', a.old_value->'clock_out'),
    jsonb_build_object('clock_in', a.new_value->'clock_in', 'clock_out', a.new_value->'clock_out')
  from public.shift_adjustments a
  join public.time_entries t on t.id = a.time_entry_id
  join public.employees owner on owner.id = t.employee_id and owner.user_id = auth.uid()
  left join public.employees editor on editor.user_id = a.editor_user_id
  where a.time_entry_id = any(_entry_ids[1:100])
  order by a.edited_at desc, a.id;
$function$;
revoke all on function public.get_my_time_corrections(uuid[]) from public;
grant execute on function public.get_my_time_corrections(uuid[]) to authenticated;

-- Corrections must go through the audited RPC. Punch/photo RPCs run as their owner.
revoke update, truncate on public.time_entries from authenticated, anon;
revoke insert, update, delete, truncate on public.shift_adjustments from authenticated, anon;
notify pgrst, 'reload schema';
commit;
