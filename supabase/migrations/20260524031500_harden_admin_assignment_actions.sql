-- Align admin assignment RPCs with the app's employee-role model.
-- Some accounts are recognized as admin through public.employees.role rather
-- than auth user_metadata.role.

create or replace function public.current_user_is_employee_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin()
    or exists (
      select 1
      from public.employees e
      where e.user_id = auth.uid()
        and e.active is true
        and lower(coalesce(e.role, '')) = 'admin'
    );
$$;

create or replace function public.prevent_non_admin_task_reassignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.assigned_to_user_id is distinct from new.assigned_to_user_id
    and not public.current_user_is_employee_admin()
  then
    raise exception 'Only admins can reassign tasks' using errcode = '42501';
  end if;

  return new;
end;
$$;

create or replace function public.admin_manage_task_assignment(
  _task_source text,
  _task_id uuid,
  _action text,
  _assigned_to_user_id uuid default null,
  _note text default null,
  _signed_by_email text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_source text := lower(nullif(btrim(coalesce(_task_source, '')), ''));
  v_action text := lower(nullif(btrim(coalesce(_action, '')), ''));
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_employee public.employees;
  v_team_task public.team_tasks;
  v_order_task public.ebay_order_tasks;
  v_old_status text;
  v_old_assigned uuid;
  v_new_status text;
  v_event_action text;
begin
  if not public.current_user_is_employee_admin() then
    raise exception 'Only admins can manage task assignments' using errcode = '42501';
  end if;

  if _task_id is null then
    raise exception 'A task is required' using errcode = '22023';
  end if;

  if v_source not in ('team', 'order') then
    raise exception 'Invalid task source: %', coalesce(v_source, '') using errcode = '22023';
  end if;

  if v_action not in ('reassign', 'decline_reassign', 'cancel_assignment') then
    raise exception 'Invalid assignment action: %', coalesce(v_action, '') using errcode = '22023';
  end if;

  if v_action = 'reassign' and _assigned_to_user_id is null then
    raise exception 'Choose the employee who should receive this task' using errcode = '22023';
  end if;

  if _assigned_to_user_id is not null then
    select *
      into v_employee
    from public.employees
    where user_id = _assigned_to_user_id
      and active is true
    limit 1;

    if not found then
      raise exception 'Assigned employee not found or inactive' using errcode = 'P0002';
    end if;
  end if;

  if v_source = 'team' then
    select * into v_team_task
    from public.team_tasks
    where id = _task_id
    for update;

    if not found then
      raise exception 'Team task not found' using errcode = 'P0002';
    end if;

    v_old_status := v_team_task.status;
    v_old_assigned := v_team_task.assigned_to_user_id;
    v_new_status := case
      when v_action = 'reassign' then case when v_employee.role = 'admin' then 'waiting_on_admin' else 'waiting_on_worker' end
      when v_action = 'decline_reassign' then case when v_team_task.assigned_to_user_id is null then 'open' else 'assigned' end
      when v_action = 'cancel_assignment' then 'open'
      else v_team_task.status
    end;

    update public.team_tasks
    set assigned_to_user_id = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.user_id else assigned_to_user_id end,
        assigned_to_employee_id = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.id else assigned_to_employee_id end,
        assigned_to_email = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.email else assigned_to_email end,
        assigned_to_role = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.role else assigned_to_role end,
        assigned_by = case when v_action in ('reassign', 'cancel_assignment') then auth.uid() else assigned_by end,
        assigned_by_email = case when v_action in ('reassign', 'cancel_assignment') then v_signed_email else assigned_by_email end,
        status = v_new_status,
        latest_note = case
          when v_action = 'cancel_assignment' then coalesce(v_note, 'Assignment cancelled by admin.')
          else coalesce(v_note, latest_note)
        end
    where id = v_team_task.id
    returning * into v_team_task;

    v_event_action := case when v_action in ('reassign', 'cancel_assignment') then 'assigned' else 'commented' end;

    insert into public.team_task_events (
      task_id, action, old_status, new_status, old_assigned_to_user_id,
      new_assigned_to_user_id, notes, signed_by, signed_by_email, payload
    )
    values (
      v_team_task.id, v_event_action, v_old_status, v_team_task.status,
      v_old_assigned, v_team_task.assigned_to_user_id,
      coalesce(v_note, case when v_action = 'cancel_assignment' then 'Assignment cancelled by admin.' else null end),
      auth.uid(), v_signed_email,
      jsonb_build_object('assignment_action', v_action)
    );

    return jsonb_build_object(
      'task_source', v_source,
      'task_id', v_team_task.id,
      'action', v_action,
      'assigned_to_user_id', v_team_task.assigned_to_user_id,
      'status', v_team_task.status
    );
  end if;

  select * into v_order_task
  from public.ebay_order_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Pending order task not found' using errcode = 'P0002';
  end if;

  v_old_status := v_order_task.status;
  v_old_assigned := v_order_task.assigned_to_user_id;
  v_new_status := case
    when v_action = 'reassign' then case when v_employee.role = 'admin' then 'waiting_on_admin' else 'waiting_on_worker' end
    when v_action = 'decline_reassign' then case when v_order_task.assigned_to_user_id is null then 'open' else 'assigned' end
    when v_action = 'cancel_assignment' then 'open'
    else v_order_task.status
  end;

  update public.ebay_order_tasks
  set assigned_to_user_id = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.user_id else assigned_to_user_id end,
      assigned_to_employee_id = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.id else assigned_to_employee_id end,
      assigned_to_email = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.email else assigned_to_email end,
      assigned_to_role = case when v_action = 'cancel_assignment' then null when v_action = 'reassign' then v_employee.role else assigned_to_role end,
      assigned_by = case when v_action in ('reassign', 'cancel_assignment') then auth.uid() else assigned_by end,
      assigned_by_email = case when v_action in ('reassign', 'cancel_assignment') then v_signed_email else assigned_by_email end,
      status = v_new_status,
      latest_note = case
        when v_action = 'cancel_assignment' then coalesce(v_note, 'Assignment cancelled by admin.')
        else coalesce(v_note, latest_note)
      end
  where id = v_order_task.id
  returning * into v_order_task;

  v_event_action := case when v_action in ('reassign', 'cancel_assignment') then 'assigned' else 'commented' end;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, old_status, new_status, old_assigned_to_user_id,
    new_assigned_to_user_id, notes, signed_by, signed_by_email, payload
  )
  values (
    v_order_task.id, v_order_task.order_id, v_event_action, v_old_status,
    v_order_task.status, v_old_assigned, v_order_task.assigned_to_user_id,
    coalesce(v_note, case when v_action = 'cancel_assignment' then 'Assignment cancelled by admin.' else null end),
    auth.uid(), v_signed_email,
    jsonb_build_object('assignment_action', v_action)
  );

  return jsonb_build_object(
    'task_source', v_source,
    'task_id', v_order_task.id,
    'action', v_action,
    'assigned_to_user_id', v_order_task.assigned_to_user_id,
    'status', v_order_task.status
  );
end;
$$;

grant execute on function public.current_user_is_employee_admin() to authenticated;
grant execute on function public.admin_manage_task_assignment(text, uuid, text, uuid, text, text) to authenticated;
