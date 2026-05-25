-- Admin-only controls for task history cleanup and reopening work.
-- History removals are soft-removals in metadata so audit data stays intact.

create or replace function public.admin_manage_task_history(
  _task_source text,
  _task_id uuid,
  _action text,
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
  v_team_task public.team_tasks;
  v_order_task public.ebay_order_tasks;
  v_return_task public.ebay_return_tasks;
  v_old_status text;
  v_new_status text;
begin
  if not public.current_user_is_employee_admin() then
    raise exception 'Only admins can manage task history' using errcode = '42501';
  end if;

  if _task_id is null then
    raise exception 'A task is required' using errcode = '22023';
  end if;

  if v_source not in ('team', 'order', 'return') then
    raise exception 'Invalid task source: %', coalesce(v_source, '') using errcode = '22023';
  end if;

  if v_action not in ('reopen', 'remove_history') then
    raise exception 'Invalid history action: %', coalesce(v_action, '') using errcode = '22023';
  end if;

  if v_action = 'remove_history' and v_note is null then
    raise exception 'Add a note explaining why this task is being removed from history' using errcode = '22023';
  end if;

  if v_source = 'team' then
    select * into v_team_task from public.team_tasks where id = _task_id for update;
    if not found then raise exception 'Team task not found' using errcode = 'P0002'; end if;

    v_old_status := v_team_task.status;
    v_new_status := case when v_team_task.assigned_to_user_id is null then 'open' else 'assigned' end;

    if v_action = 'reopen' then
      update public.team_tasks
      set status = v_new_status,
          resolved_at = null,
          resolved_by = null,
          resolved_by_email = null,
          resolution_notes = null,
          latest_note = coalesce(v_note, 'Task reopened by admin.'),
          metadata = coalesce(metadata, '{}'::jsonb) - 'history_removed_at' - 'history_removed_by' - 'history_removed_by_email' - 'history_removed_note'
      where id = v_team_task.id
      returning * into v_team_task;
    else
      update public.team_tasks
      set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'history_removed_at', now(),
            'history_removed_by', auth.uid(),
            'history_removed_by_email', v_signed_email,
            'history_removed_note', v_note
          ),
          latest_note = v_note
      where id = v_team_task.id
      returning * into v_team_task;
    end if;

    insert into public.team_task_events (
      task_id, action, old_status, new_status, notes, signed_by, signed_by_email, payload
    )
    values (
      v_team_task.id, 'commented', v_old_status, v_team_task.status,
      coalesce(v_note, case when v_action = 'reopen' then 'Task reopened by admin.' else 'Task removed from history.' end),
      auth.uid(), v_signed_email,
      jsonb_build_object('history_action', v_action)
    );

    return jsonb_build_object('task_source', v_source, 'task_id', v_team_task.id, 'action', v_action);
  end if;

  if v_source = 'order' then
    select * into v_order_task from public.ebay_order_tasks where id = _task_id for update;
    if not found then raise exception 'Pending order task not found' using errcode = 'P0002'; end if;

    v_old_status := v_order_task.status;
    v_new_status := case
      when v_order_task.task_type in ('pending_shipping', 'pending_packaging') then 'assigned_for_shipping'
      when v_order_task.assigned_to_user_id is null then 'open'
      else 'assigned'
    end;

    if v_action = 'reopen' then
      update public.ebay_order_tasks
      set status = v_new_status,
          completed_at = null,
          resolved_at = null,
          resolved_by = null,
          resolved_by_email = null,
          resolution_notes = null,
          latest_note = coalesce(v_note, 'Task reopened by admin.'),
          metadata = coalesce(metadata, '{}'::jsonb) - 'history_removed_at' - 'history_removed_by' - 'history_removed_by_email' - 'history_removed_note'
      where id = v_order_task.id
      returning * into v_order_task;
    else
      update public.ebay_order_tasks
      set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'history_removed_at', now(),
            'history_removed_by', auth.uid(),
            'history_removed_by_email', v_signed_email,
            'history_removed_note', v_note
          ),
          latest_note = v_note
      where id = v_order_task.id
      returning * into v_order_task;
    end if;

    insert into public.ebay_order_task_events (
      task_id, order_id, action, old_status, new_status, notes, signed_by, signed_by_email, payload
    )
    values (
      v_order_task.id, v_order_task.order_id, 'commented', v_old_status, v_order_task.status,
      coalesce(v_note, case when v_action = 'reopen' then 'Task reopened by admin.' else 'Task removed from history.' end),
      auth.uid(), v_signed_email,
      jsonb_build_object('history_action', v_action)
    );

    return jsonb_build_object('task_source', v_source, 'task_id', v_order_task.id, 'action', v_action);
  end if;

  select * into v_return_task from public.ebay_return_tasks where id = _task_id for update;
  if not found then raise exception 'Return task not found' using errcode = 'P0002'; end if;

  v_old_status := v_return_task.status;
  v_new_status := case when v_return_task.assigned_to_user_id is null then 'open' else 'assigned' end;

  if v_action = 'reopen' then
    update public.ebay_return_tasks
    set status = v_new_status,
        resolved_at = null,
        resolved_by = null,
        resolved_by_email = null,
        resolution_notes = null,
        metadata = coalesce(metadata, '{}'::jsonb) - 'history_removed_at' - 'history_removed_by' - 'history_removed_by_email' - 'history_removed_note'
    where id = v_return_task.id
    returning * into v_return_task;
  else
    update public.ebay_return_tasks
    set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'history_removed_at', now(),
          'history_removed_by', auth.uid(),
          'history_removed_by_email', v_signed_email,
          'history_removed_note', v_note
        )
    where id = v_return_task.id
    returning * into v_return_task;
  end if;

  insert into public.ebay_return_task_events (
    task_id, return_case_id, action, old_status, new_status, notes, signed_by, signed_by_email, payload
  )
  values (
    v_return_task.id, v_return_task.return_case_id, 'commented', v_old_status, v_return_task.status,
    coalesce(v_note, case when v_action = 'reopen' then 'Task reopened by admin.' else 'Task removed from history.' end),
    auth.uid(), v_signed_email,
    jsonb_build_object('history_action', v_action)
  );

  return jsonb_build_object('task_source', v_source, 'task_id', v_return_task.id, 'action', v_action);
end;
$$;

grant execute on function public.admin_manage_task_history(text, uuid, text, text, text) to authenticated;
