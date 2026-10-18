-- Keep the existing durable deletion audit, with authoritative admin checks and
-- optimistic concurrency for the live card confirmation. Older callers can
-- still supply only the entry ID and reason.
begin;

drop function public.admin_delete_shift_entry(uuid, text);
create function public.admin_delete_shift_entry(
  _time_entry_id uuid,
  _reason text default null,
  _expected_clock_in timestamptz default null,
  _expected_clock_out timestamptz default null
)
returns jsonb
language plpgsql security definer set search_path = public
as $function$
declare
  v_row public.time_entries;
  v_employee uuid;
  v_reason text := btrim(coalesce(_reason, ''));
  v_breaks jsonb;
  v_approval jsonb;
  v_adjustments jsonb;
  v_admin_audits jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.employees
    where user_id = auth.uid() and role = 'admin' and active is true
  ) then
    raise exception 'Only an active administrator can delete a shift' using errcode = '42501';
  end if;
  if length(v_reason) < 3 or length(v_reason) > 2000 then
    raise exception 'Explain the deletion using 3 to 2000 characters' using errcode = '22023';
  end if;

  -- Same employee -> shift lock order as corrections and manual creation.
  select employee_id into v_employee from public.time_entries where id = _time_entry_id;
  perform 1 from public.employees where id = v_employee for update;
  select * into v_row from public.time_entries where id = _time_entry_id for update;
  if v_row.id is null then
    raise exception 'Shift not found. It may already have been deleted.' using errcode = '22023';
  end if;
  if _expected_clock_in is not null and (
    v_row.clock_in is distinct from _expected_clock_in or
    v_row.clock_out is distinct from _expected_clock_out
  ) then
    raise exception 'This shift changed after you opened it. Cancel and reopen the form before deleting it.' using errcode = '40001';
  end if;
  perform public.assert_unlocked_for_range(v_row.clock_in, coalesce(v_row.clock_out, now()), 'delete shift');

  -- Off-site work has a restrictive FK: preserve those work/evidence records
  -- and give the administrator a useful error instead of a constraint failure.
  if exists (select 1 from public.work_outings where time_entry_id = v_row.id) then
    raise exception 'This shift has off-site work records and cannot be deleted. Use Correct time instead.' using errcode = '22023';
  end if;

  perform 1 from public.time_breaks where time_entry_id = v_row.id for update;
  perform 1 from public.shift_approvals where time_entry_id = v_row.id for update;
  perform 1 from public.shift_adjustments where time_entry_id = v_row.id for update;
  select coalesce(jsonb_agg(to_jsonb(b) order by b.started_at), '[]'::jsonb)
    into v_breaks from public.time_breaks b where b.time_entry_id = v_row.id;
  select to_jsonb(a) into v_approval from public.shift_approvals a where a.time_entry_id = v_row.id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.edited_at), '[]'::jsonb)
    into v_adjustments from public.shift_adjustments a where a.time_entry_id = v_row.id;
  select coalesce(jsonb_agg(to_jsonb(a) order by a.edited_at), '[]'::jsonb)
    into v_admin_audits from public.time_entry_admin_audits a where a.time_entry_id = v_row.id;

  -- No FK on this audit table: the snapshot survives cascaded shift deletion.
  insert into public.time_entry_admin_audits (
    time_entry_id, employee_id, action, editor_user_id, reason,
    fields_changed, old_value, new_value
  ) values (
    v_row.id, v_row.employee_id, 'manual_delete', auth.uid(), v_reason,
    array['deleted'], jsonb_build_object(
      'time_entry', to_jsonb(v_row), 'breaks', v_breaks,
      'approval', v_approval, 'adjustments', v_adjustments,
      'admin_audits', v_admin_audits
    ), '{}'::jsonb
  );
  delete from public.time_entries where id = v_row.id;
  perform public.refresh_monthly_hours_all();
  perform public.refresh_payroll_period_hours();
  return jsonb_build_object('deleted', true, 'time_entry_id', v_row.id, 'employee_id', v_row.employee_id);
end;
$function$;

revoke all on function public.admin_delete_shift_entry(uuid,text,timestamptz,timestamptz) from public, anon;
grant execute on function public.admin_delete_shift_entry(uuid,text,timestamptz,timestamptz) to authenticated;
-- Direct deletes must not bypass the audit, and clients must not forge or erase it.
revoke delete, truncate on public.time_entries from authenticated, anon;
revoke insert, update, delete, truncate on public.time_entry_admin_audits from authenticated, anon;

notify pgrst, 'reload schema';
commit;
