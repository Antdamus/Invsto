-- Correct shift and existing breaks atomically, preserving punch evidence.
begin;
create or replace function public.admin_correct_shift_with_breaks(
  _time_entry_id uuid, _expected_clock_in timestamptz, _expected_clock_out timestamptz,
  _new_clock_in timestamptz, _new_clock_out timestamptz, _reason text,
  _expected_breaks jsonb, _new_breaks jsonb
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
  v_breaks jsonb;
  v_new_breaks jsonb;
  v_break_evidence jsonb;
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
  perform 1 from public.time_breaks where time_entry_id = _time_entry_id order by id for update;
  select coalesce(jsonb_agg(jsonb_build_object('id',id,'started_at',started_at,'ended_at',ended_at) order by id),'[]'::jsonb),
    coalesce(jsonb_agg(to_jsonb(b) order by id),'[]'::jsonb)
    into v_breaks, v_break_evidence from public.time_breaks b where time_entry_id = _time_entry_id;
  if jsonb_typeof(_expected_breaks) is distinct from 'array' or jsonb_typeof(_new_breaks) is distinct from 'array' then
    raise exception 'Load the recorded breaks before correcting this shift' using errcode = '22023';
  end if;
  if v_breaks is distinct from (select coalesce(jsonb_agg(to_jsonb(b) order by id),'[]'::jsonb)
    from jsonb_to_recordset(_expected_breaks) as b(id uuid,started_at timestamptz,ended_at timestamptz)) then
    raise exception 'The breaks changed after you opened this form. Reload the shift.' using errcode = '40001';
  end if;
  select coalesce(jsonb_agg(to_jsonb(b) order by id),'[]'::jsonb) into v_new_breaks
    from jsonb_to_recordset(_new_breaks) as b(id uuid,started_at timestamptz,ended_at timestamptz);
  if jsonb_array_length(v_new_breaks) <> jsonb_array_length(v_breaks)
    or exists(select 1 from jsonb_to_recordset(v_new_breaks) as b(id uuid) group by id having count(*) > 1)
    or exists(select 1 from jsonb_to_recordset(v_new_breaks) as b(id uuid) where id is null or not exists(
      select 1 from public.time_breaks t where t.id=b.id and t.time_entry_id=_time_entry_id)) then
    raise exception 'Correct the existing breaks; break records cannot be added or removed here' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_to_recordset(v_new_breaks) as b(id uuid,started_at timestamptz,ended_at timestamptz)
    where started_at is null or not isfinite(started_at) or started_at > now() or started_at < _new_clock_in
      or (ended_at is not null and (not isfinite(ended_at) or ended_at <= started_at or ended_at > now()))
      or (_new_clock_out is not null and (ended_at is null or ended_at > _new_clock_out))) then
    raise exception 'Each break must end after it starts and stay within the shift, without future times' using errcode = '22023';
  end if;
  if exists(select 1 from jsonb_to_recordset(v_new_breaks) as a(id uuid,started_at timestamptz,ended_at timestamptz)
    join jsonb_to_recordset(v_new_breaks) as b(id uuid,started_at timestamptz,ended_at timestamptz)
    on a.id < b.id and a.started_at < coalesce(b.ended_at,'infinity'::timestamptz)
      and b.started_at < coalesce(a.ended_at,'infinity'::timestamptz)) then
    raise exception 'Breaks cannot overlap' using errcode = '22023';
  end if;
  if v_new_breaks is distinct from v_breaks then v_changed := array_append(v_changed,'breaks'); end if;
  if cardinality(v_changed) = 0 then return v_before; end if;

  perform public.assert_unlocked_for_range(v_before.clock_in, coalesce(v_before.clock_out, now()), 'correct existing shift');
  perform public.assert_unlocked_for_range(_new_clock_in, coalesce(_new_clock_out, now()), 'correct new shift range');
  if exists (select 1 from public.time_entries t where t.employee_id = v_employee and t.id <> _time_entry_id
    and _new_clock_in < coalesce(t.clock_out, 'infinity'::timestamptz)
    and coalesce(_new_clock_out, 'infinity'::timestamptz) > t.clock_in) then
    raise exception 'These times overlap another shift for this employee' using errcode = '22023';
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
  update public.time_breaks t set started_at=b.started_at, ended_at=b.ended_at
    from jsonb_to_recordset(v_new_breaks) as b(id uuid,started_at timestamptz,ended_at timestamptz)
    where t.id=b.id and t.time_entry_id=_time_entry_id;
  update public.time_entries set clock_in = _new_clock_in, clock_out = _new_clock_out,
    expected_start_ts = v_expected.expected_start_ts, expected_end_ts = v_expected.expected_end_ts, schedule_codes = v_codes
    where id = _time_entry_id returning * into v_after;
  delete from public.shift_approvals where time_entry_id = _time_entry_id;
  insert into public.shift_adjustments(time_entry_id, editor_user_id, reason, fields_changed, old_value, new_value)
    values (_time_entry_id, auth.uid(), btrim(_reason), v_changed,
      to_jsonb(v_before) || jsonb_build_object('previous_approval', v_approval, 'breaks', v_break_evidence),
      to_jsonb(v_after) || jsonb_build_object('breaks', (select coalesce(jsonb_agg(to_jsonb(b) order by id),'[]'::jsonb) from public.time_breaks b where time_entry_id=_time_entry_id)));
  perform public.refresh_monthly_hours_all();
  perform public.refresh_payroll_period_hours();
  return v_after;
end;
$function$;
revoke all on function public.admin_correct_shift_with_breaks(uuid,timestamptz,timestamptz,timestamptz,timestamptz,text,jsonb,jsonb) from public;
grant execute on function public.admin_correct_shift_with_breaks(uuid,timestamptz,timestamptz,timestamptz,timestamptz,text,jsonb,jsonb) to authenticated;


notify pgrst, 'reload schema';
commit;
