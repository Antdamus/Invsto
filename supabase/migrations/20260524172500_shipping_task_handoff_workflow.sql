-- Make approved parent pending-order tasks historical, expose active shipping
-- tasks to workers/admins, and allow a shipping worker to hand off to the
-- packaging worker with audit notes/photos.

create or replace function public.assign_ebay_order_shipping_task(
  _parent_task_id uuid,
  _assigned_to_user_id uuid,
  _note text default null,
  _due_at timestamptz default null,
  _signed_by_email text default null
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent public.ebay_order_tasks;
  v_shipping public.ebay_order_tasks;
  v_employee public.employees;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.current_user_is_employee_admin() then
    raise exception 'Only admins can approve shipment tasks' using errcode = '42501';
  end if;

  if _assigned_to_user_id is null then
    raise exception 'Choose an employee for the shipping task' using errcode = '22023';
  end if;

  select * into v_parent
  from public.ebay_order_tasks
  where id = _parent_task_id
  for update;

  if not found then
    raise exception 'Parent pending order task not found' using errcode = 'P0002';
  end if;

  if v_parent.task_type in ('pending_subtask', 'pending_shipping') then
    raise exception 'Shipment must be assigned from the parent pending order task' using errcode = '22023';
  end if;

  if not public.ebay_order_required_subtasks_complete(v_parent.id) then
    raise exception 'All required subtasks must be completed before shipping approval' using errcode = '22023';
  end if;

  select * into v_employee
  from public.employees
  where user_id = _assigned_to_user_id
    and active is true
  limit 1;

  if not found then
    raise exception 'Assigned employee not found or inactive' using errcode = 'P0002';
  end if;

  insert into public.ebay_order_tasks (
    order_id, order_line_ids, parent_task_id, task_type, title, question, status, priority,
    assigned_to_user_id, assigned_to_employee_id, assigned_to_email, assigned_to_role,
    assigned_by, assigned_by_email, due_at, latest_note, created_by, created_by_email, metadata
  )
  values (
    v_parent.order_id,
    coalesce(v_parent.order_line_ids, '{}'::uuid[]),
    v_parent.id,
    'pending_shipping',
    concat('Ship ', coalesce(v_parent.title, 'pending order')),
    coalesce(v_note, 'Collect and verify the item(s), print the label, then ship or hand off for packaging.'),
    'assigned_for_shipping',
    v_parent.priority,
    v_employee.user_id,
    v_employee.id,
    v_employee.email,
    v_employee.role,
    auth.uid(),
    v_signed_email,
    _due_at,
    coalesce(v_note, 'Approved for shipment.'),
    auth.uid(),
    v_signed_email,
    coalesce(v_parent.metadata, '{}'::jsonb) || jsonb_build_object(
      'parent_task_id', v_parent.id,
      'workflow_type', 'pending_order_shipping'
    )
  )
  returning * into v_shipping;

  update public.ebay_order_tasks
  set status = 'approved_for_shipping',
      completed_at = now(),
      resolved_at = now(),
      resolved_by = auth.uid(),
      resolved_by_email = v_signed_email,
      resolution_notes = coalesce(v_note, concat('Shipping assigned to ', coalesce(v_employee.display_name, v_employee.email, 'employee'))),
      latest_note = coalesce(v_note, concat('Shipping assigned to ', coalesce(v_employee.display_name, v_employee.email, 'employee')))
  where id = v_parent.id
  returning * into v_parent;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, old_status, new_status, notes, signed_by, signed_by_email, payload
  )
  values (
    v_parent.id, v_parent.order_id, 'approved_for_shipping', 'completed_by_employee', v_parent.status,
    coalesce(v_note, 'Pending order approved for shipping.'), auth.uid(), v_signed_email,
    jsonb_build_object('shipping_task_id', v_shipping.id, 'assigned_to_user_id', v_shipping.assigned_to_user_id)
  );

  insert into public.ebay_order_task_events (
    task_id, order_id, action, new_status, new_assigned_to_user_id, notes, signed_by, signed_by_email, payload
  )
  values (
    v_shipping.id, v_shipping.order_id, 'shipment_assigned', v_shipping.status, v_shipping.assigned_to_user_id,
    coalesce(v_note, 'Shipping task assigned.'), auth.uid(), v_signed_email,
    jsonb_build_object('parent_task_id', v_parent.id)
  );

  return v_shipping;
end;
$$;

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
  v_employee public.employees;
  v_old_status text;
  v_old_assigned uuid;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_photo_attachments jsonb := coalesce(_photo_attachments, '[]'::jsonb);
begin
  if _assigned_to_user_id is null then
    raise exception 'Choose the packaging worker for this handoff' using errcode = '22023';
  end if;

  if v_note is null then
    raise exception 'Add a handoff note before assigning packaging' using errcode = '22023';
  end if;

  select * into v_task
  from public.ebay_order_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Shipping task not found' using errcode = 'P0002';
  end if;

  if v_task.task_type <> 'pending_shipping' then
    raise exception 'Only shipping tasks can be handed off for packaging' using errcode = '22023';
  end if;

  if v_task.status in ('shipped_completed', 'closed', 'cancelled') then
    raise exception 'This shipping task is already closed' using errcode = '22023';
  end if;

  if not (public.current_user_is_employee_admin() or v_task.assigned_to_user_id = auth.uid()) then
    raise exception 'Only the assigned shipping worker or an admin can hand off this task' using errcode = '42501';
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

  update public.ebay_order_tasks
  set assigned_to_user_id = v_employee.user_id,
      assigned_to_employee_id = v_employee.id,
      assigned_to_email = v_employee.email,
      assigned_to_role = v_employee.role,
      status = 'assigned_for_shipping',
      due_at = coalesce(_due_at, due_at),
      latest_note = v_note,
      latest_photo_count = jsonb_array_length(v_photo_attachments),
      metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
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
    v_old_assigned, v_task.assigned_to_user_id, v_note, v_photo_attachments,
    auth.uid(), v_signed_email,
    jsonb_build_object('handoff_type', 'packaging')
  );

  return v_task;
end;
$$;

create or replace function public.list_my_ebay_order_tasks(_limit integer default 8)
returns table (
  id uuid,
  order_id uuid,
  order_line_ids uuid[],
  task_type text,
  title text,
  question text,
  status text,
  priority text,
  assigned_to_email text,
  due_at timestamptz,
  created_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  order_number text,
  buyer_username text,
  ship_by_date timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id,
    t.order_id,
    t.order_line_ids,
    t.task_type,
    t.title,
    t.question,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.due_at,
    t.created_at,
    t.latest_note,
    t.latest_photo_count,
    o.order_number,
    o.buyer_username,
    o.ship_by_date
  from public.ebay_order_tasks t
  join public.ebay_orders o on o.id = t.order_id
  where t.assigned_to_user_id = auth.uid()
    and t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred', 'assigned_for_shipping')
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    o.ship_by_date nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 8), 50));
$$;

create or replace function public.list_admin_ebay_order_tasks(_limit integer default 8)
returns table (
  id uuid,
  order_id uuid,
  order_line_ids uuid[],
  task_type text,
  title text,
  question text,
  status text,
  priority text,
  assigned_to_email text,
  due_at timestamptz,
  created_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  order_number text,
  buyer_username text,
  ship_by_date timestamptz
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.current_user_is_employee_admin() then
    raise exception 'Only admins can list all eBay order coordination tasks' using errcode = '42501';
  end if;

  return query
  select
    t.id,
    t.order_id,
    t.order_line_ids,
    t.task_type,
    t.title,
    t.question,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.due_at,
    t.created_at,
    t.latest_note,
    t.latest_photo_count,
    o.order_number,
    o.buyer_username,
    o.ship_by_date
  from public.ebay_order_tasks t
  join public.ebay_orders o on o.id = t.order_id
  where t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred', 'assigned_for_shipping', 'completed_by_employee')
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    o.ship_by_date nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 8), 50));
end;
$$;

grant execute on function public.assign_ebay_order_shipping_task(uuid, uuid, text, timestamptz, text) to authenticated;
grant execute on function public.handoff_ebay_order_shipping_task(uuid, uuid, text, jsonb, timestamptz, text) to authenticated;
grant execute on function public.list_my_ebay_order_tasks(integer) to authenticated;
grant execute on function public.list_admin_ebay_order_tasks(integer) to authenticated;
