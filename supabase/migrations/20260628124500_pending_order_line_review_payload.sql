-- Store per-line approval decisions for pending-order approval tasks without
-- changing the existing response function signature.

create or replace function public.respond_ebay_order_coordination_task_with_payload(
  _task_id uuid,
  _note text default null,
  _assigned_to_user_id uuid default null,
  _status text default null,
  _priority text default null,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null,
  _due_at timestamptz default null,
  _payload jsonb default '{}'::jsonb
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_order_tasks;
  v_parent public.ebay_order_tasks;
  v_employee public.employees;
  v_old_status text;
  v_old_assigned uuid;
  v_old_due_at timestamptz;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_status text := nullif(btrim(coalesce(_status, '')), '');
  v_priority text := nullif(btrim(coalesce(_priority, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_action text := 'commented';
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_payload jsonb := case
    when jsonb_typeof(coalesce(_payload, '{}'::jsonb)) = 'object'
      then coalesce(_payload, '{}'::jsonb)
    else '{}'::jsonb
  end;
begin
  select *
    into v_task
  from public.ebay_order_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'eBay order task not found' using errcode = 'P0002';
  end if;

  if not public.can_manage_inventory() then
    raise exception 'Only active staff can update this eBay order task' using errcode = '42501';
  end if;

  if v_status is not null and v_status not in (
    'open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker',
    'blocked', 'deferred', 'resolved', 'cancelled', 'pending_admin_review',
    'needs_subtasks', 'waiting_on_subtasks', 'ready_for_admin_approval',
    'approved_for_shipping', 'assigned_for_shipping', 'shipped_completed', 'closed',
    'completed_by_employee', 'sent_back_for_rework', 'approved_by_admin'
  ) then
    raise exception 'Invalid order task status: %', v_status using errcode = '22023';
  end if;

  if v_priority is not null and v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid order task priority: %', v_priority using errcode = '22023';
  end if;

  if v_status in ('completed_by_employee', 'shipped_completed') and v_note is null then
    raise exception 'A completion note is required' using errcode = '22023';
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

  v_old_status := v_task.status;
  v_old_assigned := v_task.assigned_to_user_id;
  v_old_due_at := v_task.due_at;

  if _assigned_to_user_id is not null and v_status is null then
    v_status := case
      when v_employee.role = 'admin' then 'waiting_on_admin'
      else 'waiting_on_worker'
    end;
  end if;

  update public.ebay_order_tasks
  set assigned_to_user_id = coalesce(_assigned_to_user_id, assigned_to_user_id),
      assigned_to_employee_id = case when _assigned_to_user_id is null then assigned_to_employee_id else v_employee.id end,
      assigned_to_email = case when _assigned_to_user_id is null then assigned_to_email else v_employee.email end,
      assigned_to_role = case when _assigned_to_user_id is null then assigned_to_role else v_employee.role end,
      assigned_by = case when _assigned_to_user_id is null then assigned_by else auth.uid() end,
      assigned_by_email = case when _assigned_to_user_id is null then assigned_by_email else v_signed_email end,
      priority = coalesce(v_priority, priority),
      status = coalesce(v_status, status),
      due_at = coalesce(_due_at, due_at),
      latest_note = coalesce(v_note, latest_note),
      latest_photo_count = case
        when jsonb_array_length(v_photo_attachments) > 0 then jsonb_array_length(v_photo_attachments)
        else latest_photo_count
      end,
      metadata = case
        when v_payload ? 'line_reviews' then
          coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
            'latest_line_reviews', v_payload->'line_reviews',
            'latest_line_review_summary', v_payload->'line_review_summary',
            'latest_line_reviewed_at', v_payload->>'reviewed_at',
            'latest_line_reviewed_by_email', v_payload->>'reviewed_by_email'
          )
        else metadata
      end,
      started_at = case
        when coalesce(v_status, status) in ('in_progress', 'assigned_for_shipping') and started_at is null then now()
        else started_at
      end,
      resolved_at = case
        when coalesce(v_status, status) in ('resolved', 'cancelled', 'shipped_completed', 'closed') then now()
        else resolved_at
      end,
      completed_at = case
        when coalesce(v_status, status) in ('completed_by_employee', 'approved_by_admin', 'shipped_completed', 'closed') then now()
        else completed_at
      end,
      resolved_by = case
        when coalesce(v_status, status) in ('resolved', 'cancelled', 'shipped_completed', 'closed') then auth.uid()
        else resolved_by
      end,
      resolved_by_email = case
        when coalesce(v_status, status) in ('resolved', 'cancelled', 'shipped_completed', 'closed') then v_signed_email
        else resolved_by_email
      end,
      resolution_notes = case
        when coalesce(v_status, status) in ('resolved', 'cancelled', 'completed_by_employee', 'approved_by_admin', 'shipped_completed', 'closed') then v_note
        else resolution_notes
      end
  where id = _task_id
  returning * into v_task;

  v_action := case
    when v_task.status = 'completed_by_employee' then 'completed_by_employee'
    when v_task.status = 'shipped_completed' then 'shipped_completed'
    when v_task.status = 'resolved' then 'resolved'
    when v_task.status = 'cancelled' then 'cancelled'
    when v_old_assigned is distinct from v_task.assigned_to_user_id then 'assigned'
    when v_old_status is distinct from v_task.status then 'status_changed'
    when v_payload ? 'line_reviews' then 'line_reviewed'
    else 'progress_update'
  end;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, old_status, new_status, old_assigned_to_user_id,
    new_assigned_to_user_id, notes, photo_attachments, signed_by, signed_by_email, payload
  )
  values (
    v_task.id, v_task.order_id, v_action, v_old_status, v_task.status,
    v_old_assigned, v_task.assigned_to_user_id, v_note, v_photo_attachments,
    auth.uid(), v_signed_email,
    v_payload || jsonb_build_object('old_due_at', v_old_due_at, 'due_at', v_task.due_at)
  );

  if v_task.parent_task_id is not null and v_task.task_type = 'pending_subtask' then
    select * into v_parent from public.ebay_order_tasks where id = v_task.parent_task_id for update;
    if found then
      update public.ebay_order_tasks
      set status = case
            when public.ebay_order_required_subtasks_complete(v_parent.id) then 'ready_for_admin_approval'
            else 'waiting_on_subtasks'
          end,
          latest_note = coalesce(v_note, latest_note)
      where id = v_parent.id
        and status not in ('assigned_for_shipping', 'shipped_completed', 'closed', 'cancelled');
    end if;
  elsif v_task.parent_task_id is not null and v_task.task_type = 'pending_shipping' and v_task.status = 'shipped_completed' then
    update public.ebay_order_tasks
    set status = 'shipped_completed',
        completed_at = now(),
        resolved_at = now(),
        resolved_by = auth.uid(),
        resolved_by_email = v_signed_email,
        resolution_notes = v_note,
        latest_note = coalesce(v_note, latest_note)
    where id = v_task.parent_task_id;
  end if;

  return v_task;
end;
$$;

revoke all on function public.respond_ebay_order_coordination_task_with_payload(uuid, text, uuid, text, text, jsonb, text, timestamptz, jsonb) from public;
grant execute on function public.respond_ebay_order_coordination_task_with_payload(uuid, text, uuid, text, text, jsonb, text, timestamptz, jsonb) to authenticated;
