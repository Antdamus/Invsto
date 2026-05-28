-- Admin manual time-entry controls with durable audit records.
-- Adds audited RPCs for manual shift creation, closing open shifts, and deleting shifts.

create table if not exists public.time_entry_admin_audits (
  id uuid primary key default gen_random_uuid(),
  time_entry_id uuid,
  employee_id uuid,
  action text not null check (action in ('manual_create', 'manual_close', 'manual_delete')),
  editor_user_id uuid not null default auth.uid(),
  edited_at timestamptz not null default now(),
  reason text not null check (length(btrim(reason)) >= 3),
  fields_changed text[] not null default '{}'::text[],
  old_value jsonb not null default '{}'::jsonb,
  new_value jsonb not null default '{}'::jsonb
);

alter table public.time_entry_admin_audits enable row level security;

drop policy if exists "time_entry_admin_audits_admin_select" on public.time_entry_admin_audits;
create policy "time_entry_admin_audits_admin_select"
  on public.time_entry_admin_audits
  for select
  to authenticated
  using (public.is_admin());

create index if not exists time_entry_admin_audits_entry_idx
  on public.time_entry_admin_audits (time_entry_id, edited_at desc);

create index if not exists time_entry_admin_audits_employee_idx
  on public.time_entry_admin_audits (employee_id, edited_at desc);

grant select on public.time_entry_admin_audits to authenticated;
grant select, insert, update, delete on public.time_entry_admin_audits to service_role;

create or replace view public.v_shift_adjustments as
  select
    sa.id,
    sa.time_entry_id,
    sa.editor_user_id,
    coalesce(e.display_name, u.email::text) as editor_name,
    sa.edited_at,
    sa.reason,
    sa.fields_changed,
    sa.old_value,
    sa.new_value
  from public.shift_adjustments sa
  left join public.employees e on e.user_id = sa.editor_user_id
  left join auth.users u on u.id = sa.editor_user_id

  union all

  select
    aa.id,
    aa.time_entry_id,
    aa.editor_user_id,
    coalesce(e.display_name, u.email::text) as editor_name,
    aa.edited_at,
    aa.reason,
    array_prepend(aa.action, aa.fields_changed) as fields_changed,
    aa.old_value,
    aa.new_value
  from public.time_entry_admin_audits aa
  left join public.employees e on e.user_id = aa.editor_user_id
  left join auth.users u on u.id = aa.editor_user_id;

create or replace function public.admin_create_manual_shift(
  _employee_id uuid,
  _clock_in timestamptz,
  _clock_out timestamptz,
  _store_id uuid default null,
  _reason text default null
)
returns public.time_entries
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.time_entries;
  v_emp public.employees;
  v_store public.store_locations;
  v_exp record;
  v_reason text := btrim(coalesce(_reason, ''));
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if _employee_id is null then
    raise exception 'Employee is required' using errcode = '22023';
  end if;

  if _clock_in is null or _clock_out is null then
    raise exception 'Clock-in and clock-out are required' using errcode = '22023';
  end if;

  if length(v_reason) < 3 then
    raise exception 'Reason is required (min 3 characters)' using errcode = '22023';
  end if;

  if _clock_out <= _clock_in then
    raise exception 'Clock-out must be after clock-in' using errcode = '22023';
  end if;

  perform public.assert_unlocked_for_range(_clock_in, _clock_out, 'create manual shift');

  select * into v_emp
  from public.employees
  where id = _employee_id
  for update;

  if v_emp.id is null then
    raise exception 'Employee not found' using errcode = '22023';
  end if;

  if coalesce(v_emp.active, false) is not true then
    raise exception 'Employee is inactive' using errcode = '22023';
  end if;

  if _store_id is not null then
    select * into v_store
    from public.store_locations
    where id = _store_id
      and active is true;

    if v_store.id is null then
      raise exception 'Selected store is not active' using errcode = '22023';
    end if;
  end if;

  if exists (
    select 1
    from public.time_entries t
    where t.employee_id = _employee_id
      and _clock_in < coalesce(t.clock_out, 'infinity'::timestamptz)
      and _clock_out > t.clock_in
  ) then
    raise exception 'Manual shift overlaps another shift for this employee'
      using errcode = '22023';
  end if;

  select * into v_exp
  from public.resolve_expected_window(_employee_id, _clock_in, _store_id);

  insert into public.time_entries (
    employee_id,
    clock_in,
    clock_out,
    store_id,
    device_info,
    note,
    expected_start_ts,
    expected_end_ts,
    schedule_note
  ) values (
    _employee_id,
    _clock_in,
    _clock_out,
    _store_id,
    'admin_manual_entry',
    'Manual entry by admin: ' || v_reason,
    v_exp.expected_start_ts,
    v_exp.expected_end_ts,
    'Manual admin-created shift.'
  )
  returning * into v_row;

  insert into public.time_entry_admin_audits (
    time_entry_id,
    employee_id,
    action,
    editor_user_id,
    reason,
    fields_changed,
    old_value,
    new_value
  ) values (
    v_row.id,
    v_row.employee_id,
    'manual_create',
    auth.uid(),
    v_reason,
    array['created', 'clock_in', 'clock_out', 'store_id'],
    '{}'::jsonb,
    to_jsonb(v_row)
  );

  perform public.refresh_monthly_hours_all();
  perform public.refresh_payroll_period_hours();

  return v_row;
end;
$function$;

create or replace function public.admin_close_open_shift(
  _time_entry_id uuid,
  _clock_out timestamptz default now(),
  _reason text default null
)
returns public.time_entries
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_before public.time_entries;
  v_after public.time_entries;
  v_reason text := btrim(coalesce(_reason, ''));
  v_out timestamptz := coalesce(_clock_out, now());
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if length(v_reason) < 3 then
    raise exception 'Reason is required (min 3 characters)' using errcode = '22023';
  end if;

  select * into v_before
  from public.time_entries
  where id = _time_entry_id
  for update;

  if v_before.id is null then
    raise exception 'Shift not found' using errcode = '22023';
  end if;

  if v_before.clock_out is not null then
    raise exception 'Shift is already closed' using errcode = '22023';
  end if;

  if v_out <= v_before.clock_in then
    raise exception 'Clock-out must be after clock-in' using errcode = '22023';
  end if;

  perform public.assert_unlocked_for_range(v_before.clock_in, v_out, 'close open shift');

  if exists (
    select 1
    from public.time_entries t
    where t.employee_id = v_before.employee_id
      and t.id <> v_before.id
      and v_before.clock_in < coalesce(t.clock_out, 'infinity'::timestamptz)
      and v_out > t.clock_in
  ) then
    raise exception 'Closed shift overlaps another shift for this employee'
      using errcode = '22023';
  end if;

  update public.time_entries
  set clock_out = v_out,
      note = concat_ws(E'\n', nullif(note, ''), 'Closed by admin: ' || v_reason)
  where id = v_before.id
  returning * into v_after;

  delete from public.shift_approvals where time_entry_id = v_before.id;

  insert into public.time_entry_admin_audits (
    time_entry_id,
    employee_id,
    action,
    editor_user_id,
    reason,
    fields_changed,
    old_value,
    new_value
  ) values (
    v_after.id,
    v_after.employee_id,
    'manual_close',
    auth.uid(),
    v_reason,
    array['clock_out'],
    to_jsonb(v_before),
    to_jsonb(v_after)
  );

  perform public.refresh_monthly_hours_all();
  perform public.refresh_payroll_period_hours();

  return v_after;
end;
$function$;

create or replace function public.admin_delete_shift_entry(
  _time_entry_id uuid,
  _reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row public.time_entries;
  v_reason text := btrim(coalesce(_reason, ''));
  v_breaks jsonb := '[]'::jsonb;
  v_approval jsonb := 'null'::jsonb;
  v_adjustments jsonb := '[]'::jsonb;
  v_admin_audits jsonb := '[]'::jsonb;
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  if length(v_reason) < 3 then
    raise exception 'Reason is required (min 3 characters)' using errcode = '22023';
  end if;

  select * into v_row
  from public.time_entries
  where id = _time_entry_id
  for update;

  if v_row.id is null then
    raise exception 'Shift not found' using errcode = '22023';
  end if;

  perform public.assert_unlocked_for_range(
    v_row.clock_in,
    coalesce(v_row.clock_out, now()),
    'delete shift'
  );

  select coalesce(jsonb_agg(to_jsonb(b) order by b.started_at), '[]'::jsonb)
    into v_breaks
  from public.time_breaks b
  where b.time_entry_id = v_row.id;

  select coalesce(to_jsonb(sa), 'null'::jsonb)
    into v_approval
  from public.shift_approvals sa
  where sa.time_entry_id = v_row.id;

  select coalesce(jsonb_agg(to_jsonb(adj) order by adj.edited_at), '[]'::jsonb)
    into v_adjustments
  from public.shift_adjustments adj
  where adj.time_entry_id = v_row.id;

  select coalesce(jsonb_agg(to_jsonb(aa) order by aa.edited_at), '[]'::jsonb)
    into v_admin_audits
  from public.time_entry_admin_audits aa
  where aa.time_entry_id = v_row.id;

  insert into public.time_entry_admin_audits (
    time_entry_id,
    employee_id,
    action,
    editor_user_id,
    reason,
    fields_changed,
    old_value,
    new_value
  ) values (
    v_row.id,
    v_row.employee_id,
    'manual_delete',
    auth.uid(),
    v_reason,
    array['deleted'],
    jsonb_build_object(
      'time_entry', to_jsonb(v_row),
      'breaks', v_breaks,
      'approval', v_approval,
      'adjustments', v_adjustments,
      'admin_audits', v_admin_audits
    ),
    '{}'::jsonb
  );

  delete from public.time_entries
  where id = v_row.id;

  perform public.refresh_monthly_hours_all();
  perform public.refresh_payroll_period_hours();

  return jsonb_build_object(
    'deleted', true,
    'time_entry_id', v_row.id,
    'employee_id', v_row.employee_id
  );
end;
$function$;

revoke all on function public.admin_create_manual_shift(uuid, timestamptz, timestamptz, uuid, text) from public;
revoke all on function public.admin_close_open_shift(uuid, timestamptz, text) from public;
revoke all on function public.admin_delete_shift_entry(uuid, text) from public;

grant execute on function public.admin_create_manual_shift(uuid, timestamptz, timestamptz, uuid, text) to authenticated;
grant execute on function public.admin_close_open_shift(uuid, timestamptz, text) to authenticated;
grant execute on function public.admin_delete_shift_entry(uuid, text) to authenticated;

create or replace function public.admin_update_shift_time(
  _time_entry_id uuid,
  _new_clock_in timestamptz default null,
  _new_clock_out timestamptz default null,
  _reason text default null
)
returns public.time_entries
language plpgsql
security definer
set search_path = public
as $function$
declare
  v_row_before public.time_entries;
  v_row_after public.time_entries;
  v_emp_id uuid;
  v_new_in timestamptz;
  v_new_out timestamptz;
  v_changed text[] := '{}';
begin
  if not public.is_admin() then
    raise exception 'Not allowed' using errcode = '42501';
  end if;

  select * into v_row_before
  from public.time_entries
  where id = _time_entry_id
  for update;

  if v_row_before.id is null then
    raise exception 'Shift not found' using errcode = '22023';
  end if;

  if v_row_before.clock_out is null then
    raise exception 'Cannot edit an open shift' using errcode = '22023';
  end if;

  perform public.assert_unlocked_for_range(
    v_row_before.clock_in,
    v_row_before.clock_out,
    'edit existing shift'
  );

  v_emp_id := v_row_before.employee_id;
  v_new_in := coalesce(_new_clock_in, v_row_before.clock_in);
  v_new_out := coalesce(_new_clock_out, v_row_before.clock_out);

  if v_new_out <= v_new_in then
    raise exception 'Clock-out must be after clock-in' using errcode = '22023';
  end if;

  perform public.assert_unlocked_for_range(v_new_in, v_new_out, 'edit new shift range');

  if exists (
    select 1
    from public.time_entries t
    where t.employee_id = v_emp_id
      and t.id <> v_row_before.id
      and v_new_in < coalesce(t.clock_out, 'infinity'::timestamptz)
      and v_new_out > t.clock_in
  ) then
    raise exception 'Edited time range overlaps another shift for this employee'
      using errcode = '22023';
  end if;

  if v_new_in is distinct from v_row_before.clock_in then
    v_changed := array_append(v_changed, 'clock_in');
  end if;

  if v_new_out is distinct from v_row_before.clock_out then
    v_changed := array_append(v_changed, 'clock_out');
  end if;

  if length(btrim(coalesce(_reason, ''))) < 3 then
    raise exception 'Reason is required (min 3 characters)' using errcode = '22023';
  end if;

  if array_length(v_changed, 1) is null then
    return v_row_before;
  end if;

  update public.time_entries
  set clock_in = v_new_in,
      clock_out = v_new_out
  where id = v_row_before.id
  returning * into v_row_after;

  delete from public.shift_approvals where time_entry_id = v_row_before.id;

  insert into public.shift_adjustments (
    time_entry_id,
    editor_user_id,
    reason,
    fields_changed,
    old_value,
    new_value
  ) values (
    v_row_after.id,
    auth.uid(),
    btrim(_reason),
    v_changed,
    jsonb_build_object('clock_in', v_row_before.clock_in, 'clock_out', v_row_before.clock_out),
    jsonb_build_object('clock_in', v_row_after.clock_in, 'clock_out', v_row_after.clock_out)
  );

  perform public.refresh_monthly_hours_all();
  perform public.refresh_payroll_period_hours();

  return v_row_after;
end;
$function$;

revoke all on function public.admin_update_shift_time(uuid, timestamptz, timestamptz, text) from public;
grant execute on function public.admin_update_shift_time(uuid, timestamptz, timestamptz, text) to authenticated;
