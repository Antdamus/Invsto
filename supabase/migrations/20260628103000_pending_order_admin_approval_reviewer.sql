-- Allow the pending-order approval handoff to name the admin reviewer.
-- This replaces the approval RPC with a new signature instead of editing the
-- already-applied migration.

drop function if exists public.submit_pending_order_for_admin_approval(uuid, uuid[], text, text, timestamptz, jsonb, text);

create or replace function public.submit_pending_order_for_admin_approval(
  _order_id uuid,
  _order_line_ids uuid[] default '{}'::uuid[],
  _note text default null,
  _priority text default 'high',
  _due_at timestamptz default null,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null,
  _assigned_to_user_id uuid default null
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.ebay_orders;
  v_existing public.ebay_order_tasks;
  v_task public.ebay_order_tasks;
  v_assigned_employee public.employees;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_priority text := nullif(btrim(coalesce(_priority, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_line_ids uuid[] := '{}'::uuid[];
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_old_status text;
  v_old_assigned_to_user_id uuid;
begin
  if not public.can_manage_inventory() then
    raise exception 'Only active staff can submit pending orders for admin approval' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'Add a note for the admin approval request' using errcode = '22023';
  end if;

  if v_priority is null then
    v_priority := 'high';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid order task priority: %', v_priority using errcode = '22023';
  end if;

  if _assigned_to_user_id is not null then
    select *
      into v_assigned_employee
    from public.employees
    where user_id = _assigned_to_user_id
      and active is true
      and lower(coalesce(role, '')) = 'admin'
    limit 1;

    if not found then
      raise exception 'Assigned admin reviewer not found or inactive' using errcode = 'P0002';
    end if;
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = _order_id
  for update;

  if not found then
    raise exception 'Pending eBay order not found' using errcode = 'P0002';
  end if;

  if coalesce(array_length(_order_line_ids, 1), 0) > 0 then
    select coalesce(array_agg(l.id order by l.created_at), '{}'::uuid[])
      into v_line_ids
    from public.ebay_order_lines l
    where l.order_id = v_order.id
      and l.id = any(_order_line_ids);
  else
    select coalesce(array_agg(l.id order by l.created_at), '{}'::uuid[])
      into v_line_ids
    from public.ebay_order_lines l
    where l.order_id = v_order.id
      and l.line_status = 'pending';
  end if;

  if coalesce(array_length(v_line_ids, 1), 0) = 0 then
    raise exception 'No pending order lines were found for approval' using errcode = '22023';
  end if;

  select *
    into v_existing
  from public.ebay_order_tasks
  where order_id = v_order.id
    and parent_task_id is null
    and task_type = 'pending_admin_review'
    and coalesce(metadata->>'workflow_type', '') = 'pending_order_approval'
    and status not in (
      'approved_for_shipping',
      'assigned_for_shipping',
      'shipped_completed',
      'closed',
      'cancelled',
      'resolved',
      'approved_by_admin'
    )
  order by updated_at desc
  limit 1
  for update;

  if found then
    v_old_status := v_existing.status;
    v_old_assigned_to_user_id := v_existing.assigned_to_user_id;

    update public.ebay_order_tasks
    set order_line_ids = v_line_ids,
        status = 'ready_for_admin_approval',
        priority = v_priority,
        due_at = coalesce(_due_at, v_order.ship_by_date, due_at),
        latest_note = v_note,
        latest_photo_count = jsonb_array_length(v_photo_attachments),
        assigned_to_user_id = case when _assigned_to_user_id is null then null else v_assigned_employee.user_id end,
        assigned_to_employee_id = case when _assigned_to_user_id is null then null else v_assigned_employee.id end,
        assigned_to_email = case when _assigned_to_user_id is null then null else v_assigned_employee.email end,
        assigned_to_role = case when _assigned_to_user_id is null then null else v_assigned_employee.role end,
        assigned_by = auth.uid(),
        assigned_by_email = v_signed_email,
        metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
          'source', 'pending_orders',
          'workflow_type', 'pending_order_approval',
          'approval_kind', 'ready_for_shipping',
          'order_number', v_order.order_number,
          'buyer_username', v_order.buyer_username,
          'buyer_name', v_order.buyer_name,
          'order_status', v_order.status,
          'submitted_by_email', v_signed_email,
          'submitted_at', now(),
          'assigned_admin_user_id', case when _assigned_to_user_id is null then null else v_assigned_employee.user_id end,
          'assigned_admin_email', case when _assigned_to_user_id is null then null else v_assigned_employee.email end
        )
    where id = v_existing.id
    returning * into v_task;

    insert into public.ebay_order_task_events (
      task_id,
      order_id,
      action,
      old_status,
      new_status,
      old_assigned_to_user_id,
      new_assigned_to_user_id,
      notes,
      photo_attachments,
      signed_by,
      signed_by_email,
      payload
    )
    values (
      v_task.id,
      v_task.order_id,
      'status_changed',
      v_old_status,
      v_task.status,
      v_old_assigned_to_user_id,
      v_task.assigned_to_user_id,
      v_note,
      v_photo_attachments,
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'workflow_type', 'pending_order_approval',
        'line_ids', v_line_ids,
        'order_number', v_order.order_number,
        'assigned_admin_email', v_task.assigned_to_email
      )
    );
  else
    insert into public.ebay_order_tasks (
      order_id,
      order_line_ids,
      task_type,
      title,
      question,
      status,
      priority,
      assigned_to_user_id,
      assigned_to_employee_id,
      assigned_to_email,
      assigned_to_role,
      assigned_by,
      assigned_by_email,
      due_at,
      latest_note,
      latest_photo_count,
      created_by,
      created_by_email,
      metadata
    )
    values (
      v_order.id,
      v_line_ids,
      'pending_admin_review',
      concat('Approval needed - Order ', coalesce(v_order.order_number, 'eBay order'), ' - ', coalesce(v_order.buyer_username, 'unknown buyer')),
      v_note,
      'ready_for_admin_approval',
      v_priority,
      case when _assigned_to_user_id is null then null else v_assigned_employee.user_id end,
      case when _assigned_to_user_id is null then null else v_assigned_employee.id end,
      case when _assigned_to_user_id is null then null else v_assigned_employee.email end,
      case when _assigned_to_user_id is null then null else v_assigned_employee.role end,
      auth.uid(),
      v_signed_email,
      coalesce(_due_at, v_order.ship_by_date),
      v_note,
      jsonb_array_length(v_photo_attachments),
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'source', 'pending_orders',
        'workflow_type', 'pending_order_approval',
        'approval_kind', 'ready_for_shipping',
        'order_number', v_order.order_number,
        'buyer_username', v_order.buyer_username,
        'buyer_name', v_order.buyer_name,
        'order_status', v_order.status,
        'submitted_by_email', v_signed_email,
        'submitted_at', now(),
        'assigned_admin_user_id', case when _assigned_to_user_id is null then null else v_assigned_employee.user_id end,
        'assigned_admin_email', case when _assigned_to_user_id is null then null else v_assigned_employee.email end
      )
    )
    returning * into v_task;

    insert into public.ebay_order_task_events (
      task_id,
      order_id,
      action,
      new_status,
      new_assigned_to_user_id,
      notes,
      photo_attachments,
      signed_by,
      signed_by_email,
      payload
    )
    values (
      v_task.id,
      v_task.order_id,
      'created',
      v_task.status,
      v_task.assigned_to_user_id,
      v_note,
      v_photo_attachments,
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'workflow_type', 'pending_order_approval',
        'line_ids', v_line_ids,
        'order_number', v_order.order_number,
        'assigned_admin_email', v_task.assigned_to_email
      )
    );
  end if;

  return v_task;
end;
$$;

grant execute on function public.submit_pending_order_for_admin_approval(uuid, uuid[], text, text, timestamptz, jsonb, text, uuid) to authenticated;
