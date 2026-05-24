-- Split shipping preparation from packaging handoff.
-- A prep worker can mark the item ready for packaging and either keep the
-- packaging step or hand it off, which closes their prep task and creates a
-- packaging task for the next worker.

alter table public.ebay_order_tasks
  drop constraint if exists ebay_order_tasks_task_type_check;

alter table public.ebay_order_tasks
  add constraint ebay_order_tasks_task_type_check
  check (task_type in (
    'coordination',
    'admin_review',
    'worker_follow_up',
    'special_order',
    'pending_admin_review',
    'pending_subtask',
    'pending_shipping',
    'pending_packaging'
  ));

alter table public.ebay_order_task_events
  drop constraint if exists ebay_order_task_events_action_check;

alter table public.ebay_order_task_events
  add constraint ebay_order_task_events_action_check
  check (action in (
    'created',
    'assigned',
    'status_changed',
    'commented',
    'resolved',
    'cancelled',
    'subtask_created',
    'progress_update',
    'completed_by_employee',
    'sent_back_for_rework',
    'approved_by_admin',
    'approved_for_shipping',
    'shipment_assigned',
    'shipping_ready_for_packaging',
    'shipping_handoff',
    'packaging_assigned',
    'shipped_completed'
  ));

create or replace function public.handoff_ebay_order_shipping_task(
  _task_id uuid,
  _assigned_to_user_id uuid,
  _note text,
  _photo_attachments jsonb default '[]'::jsonb,
  _due_at timestamptz default null,
  _signed_by_email text default null
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_order_tasks;
  v_packaging public.ebay_order_tasks;
  v_employee public.employees;
  v_old_status text;
  v_old_assigned uuid;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_photo_attachments jsonb := coalesce(_photo_attachments, '[]'::jsonb);
  v_self_package boolean;
begin
  if _assigned_to_user_id is null then
    raise exception 'Choose who will package this shipment' using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'Add a ready-for-packaging note before continuing' using errcode = '22023';
  end if;

  if jsonb_typeof(v_photo_attachments) <> 'array' or jsonb_array_length(v_photo_attachments) = 0 then
    raise exception 'Add at least one audit photo before marking ready for packaging' using errcode = '22023';
  end if;

  select * into v_task
  from public.ebay_order_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Shipping task not found' using errcode = 'P0002';
  end if;

  if v_task.task_type not in ('pending_shipping', 'pending_packaging') then
    raise exception 'Only shipping or packaging tasks can be marked ready for packaging' using errcode = '22023';
  end if;

  if v_task.status in ('shipped_completed', 'closed', 'cancelled') then
    raise exception 'This shipping task is already closed' using errcode = '22023';
  end if;

  if not (public.current_user_is_employee_admin() or v_task.assigned_to_user_id = auth.uid()) then
    raise exception 'Only the assigned shipping worker or an admin can update this task' using errcode = '42501';
  end if;

  select * into v_employee
  from public.employees
  where user_id = _assigned_to_user_id
    and active is true
  limit 1;

  if not found then
    raise exception 'Packaging worker not found or inactive' using errcode = 'P0002';
  end if;

  v_old_status := v_task.status;
  v_old_assigned := v_task.assigned_to_user_id;
  v_self_package := v_employee.user_id = v_task.assigned_to_user_id;

  if v_self_package then
    update public.ebay_order_tasks
    set status = 'assigned_for_shipping',
        due_at = coalesce(_due_at, due_at),
        latest_note = v_note,
        latest_photo_count = jsonb_array_length(v_photo_attachments),
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'packaging_ready_at', now(),
          'packaging_ready_by', auth.uid(),
          'packaging_mode', 'self',
          'packaging_assigned_to_user_id', v_employee.user_id
        )
    where id = v_task.id
    returning * into v_task;

    insert into public.ebay_order_task_events (
      task_id, order_id, action, old_status, new_status, old_assigned_to_user_id,
      new_assigned_to_user_id, notes, photo_attachments, signed_by, signed_by_email, payload
    )
    values (
      v_task.id, v_task.order_id, 'shipping_ready_for_packaging', v_old_status, v_task.status,
      v_old_assigned, v_task.assigned_to_user_id, v_note, v_photo_attachments,
      auth.uid(), v_signed_email,
      jsonb_build_object('packaging_mode', 'self')
    );

    return v_task;
  end if;

  update public.ebay_order_tasks
  set status = 'closed',
      completed_at = now(),
      resolved_at = now(),
      resolved_by = auth.uid(),
      resolved_by_email = v_signed_email,
      resolution_notes = v_note,
      latest_note = v_note,
      latest_photo_count = jsonb_array_length(v_photo_attachments),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
        'packaging_ready_at', now(),
        'packaging_ready_by', auth.uid(),
        'packaging_mode', 'handoff',
        'packaging_handoff_at', now(),
        'packaging_handoff_by', auth.uid(),
        'packaging_assigned_to_user_id', v_employee.user_id
      )
  where id = v_task.id
  returning * into v_task;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, old_status, new_status, old_assigned_to_user_id,
    new_assigned_to_user_id, notes, photo_attachments, signed_by, signed_by_email, payload
  )
  values (
    v_task.id, v_task.order_id, 'shipping_handoff', v_old_status, v_task.status,
    v_old_assigned, v_employee.user_id, v_note, v_photo_attachments,
    auth.uid(), v_signed_email,
    jsonb_build_object('packaging_mode', 'handoff')
  );

  insert into public.ebay_order_tasks (
    order_id, order_line_ids, parent_task_id, task_type, title, question, status, priority,
    assigned_to_user_id, assigned_to_employee_id, assigned_to_email, assigned_to_role,
    assigned_by, assigned_by_email, due_at, latest_note, latest_photo_count,
    created_by, created_by_email, metadata
  )
  values (
    v_task.order_id,
    coalesce(v_task.order_line_ids, '{}'::uuid[]),
    coalesce(v_task.parent_task_id, v_task.id),
    'pending_packaging',
    concat('Package and ship ', coalesce(v_task.title, 'pending order')),
    v_note,
    'assigned_for_shipping',
    v_task.priority,
    v_employee.user_id,
    v_employee.id,
    v_employee.email,
    v_employee.role,
    auth.uid(),
    v_signed_email,
    _due_at,
    v_note,
    0,
    auth.uid(),
    v_signed_email,
    coalesce(v_task.metadata, '{}'::jsonb) || jsonb_build_object(
      'workflow_type', 'pending_order_packaging',
      'shipping_prep_task_id', v_task.id,
      'packaging_assigned_at', now(),
      'packaging_assigned_by', auth.uid()
    )
  )
  returning * into v_packaging;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, new_status, new_assigned_to_user_id,
    notes, signed_by, signed_by_email, payload
  )
  values (
    v_packaging.id, v_packaging.order_id, 'packaging_assigned',
    v_packaging.status, v_packaging.assigned_to_user_id,
    v_note, auth.uid(), v_signed_email,
    jsonb_build_object('shipping_prep_task_id', v_task.id)
  );

  return v_packaging;
end;
$$;

grant execute on function public.handoff_ebay_order_shipping_task(uuid, uuid, text, jsonb, timestamptz, text) to authenticated;
