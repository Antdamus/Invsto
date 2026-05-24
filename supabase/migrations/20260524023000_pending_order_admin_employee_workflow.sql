-- Pending order admin/employee workflow.
-- Extends the existing ebay_order_tasks/event trail instead of creating a
-- parallel task system.

alter table public.ebay_order_tasks
  add column if not exists parent_task_id uuid references public.ebay_order_tasks(id) on delete cascade,
  add column if not exists completed_at timestamptz;

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
    'pending_shipping'
  ));

alter table public.ebay_order_tasks
  drop constraint if exists ebay_order_tasks_status_check;

alter table public.ebay_order_tasks
  add constraint ebay_order_tasks_status_check
  check (status in (
    'open',
    'assigned',
    'in_progress',
    'waiting_on_admin',
    'waiting_on_worker',
    'blocked',
    'deferred',
    'resolved',
    'cancelled',
    'pending_admin_review',
    'needs_subtasks',
    'waiting_on_subtasks',
    'ready_for_admin_approval',
    'approved_for_shipping',
    'assigned_for_shipping',
    'shipped_completed',
    'closed',
    'completed_by_employee',
    'sent_back_for_rework',
    'approved_by_admin'
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
    'shipped_completed'
  ));

create index if not exists ebay_order_tasks_parent_idx
  on public.ebay_order_tasks(parent_task_id, status, created_at);

create or replace function public.ebay_order_required_subtasks_complete(_parent_task_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select not exists (
    select 1
    from public.ebay_order_tasks st
    where st.parent_task_id = _parent_task_id
      and st.task_type = 'pending_subtask'
      and coalesce((st.metadata->>'required_for_shipping')::boolean, true) is true
      and st.status not in ('completed_by_employee', 'approved_by_admin')
  );
$$;

create or replace function public.create_ebay_order_subtask(
  _parent_task_id uuid,
  _title text,
  _description text,
  _assigned_to_user_id uuid,
  _priority text default 'normal',
  _due_at timestamptz default null,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_parent public.ebay_order_tasks;
  v_child public.ebay_order_tasks;
  v_employee public.employees;
  v_title text := nullif(btrim(coalesce(_title, '')), '');
  v_description text := nullif(btrim(coalesce(_description, '')), '');
  v_priority text := coalesce(nullif(btrim(coalesce(_priority, '')), ''), 'normal');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
begin
  if not public.is_admin() then
    raise exception 'Only admins can create pending order subtasks' using errcode = '42501';
  end if;

  if v_title is null then
    raise exception 'Subtask title is required' using errcode = '22023';
  end if;

  if v_description is null then
    raise exception 'Subtask instructions are required' using errcode = '22023';
  end if;

  if _assigned_to_user_id is null then
    raise exception 'Choose an employee for this subtask' using errcode = '22023';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid priority: %', v_priority using errcode = '22023';
  end if;

  select *
    into v_parent
  from public.ebay_order_tasks
  where id = _parent_task_id
  for update;

  if not found then
    raise exception 'Parent pending order task not found' using errcode = 'P0002';
  end if;

  if v_parent.task_type in ('pending_subtask', 'pending_shipping') then
    raise exception 'Subtasks must be created from the parent pending order task' using errcode = '22023';
  end if;

  if v_parent.status in ('assigned_for_shipping', 'shipped_completed', 'closed', 'cancelled') then
    raise exception 'This pending order is no longer open for subtasks' using errcode = '22023';
  end if;

  select *
    into v_employee
  from public.employees
  where user_id = _assigned_to_user_id
    and active is true
  limit 1;

  if not found then
    raise exception 'Assigned employee not found or inactive' using errcode = 'P0002';
  end if;

  insert into public.ebay_order_tasks (
    order_id,
    order_line_ids,
    parent_task_id,
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
    v_parent.order_id,
    coalesce(v_parent.order_line_ids, '{}'::uuid[]),
    v_parent.id,
    'pending_subtask',
    v_title,
    v_description,
    'assigned',
    v_priority,
    v_employee.user_id,
    v_employee.id,
    v_employee.email,
    v_employee.role,
    auth.uid(),
    v_signed_email,
    _due_at,
    v_description,
    jsonb_array_length(v_photo_attachments),
    auth.uid(),
    v_signed_email,
    coalesce(v_parent.metadata, '{}'::jsonb) || jsonb_build_object(
      'parent_task_id', v_parent.id,
      'required_for_shipping', true,
      'workflow_type', 'pending_order_subtask'
    )
  )
  returning * into v_child;

  update public.ebay_order_tasks
  set status = 'waiting_on_subtasks',
      latest_note = concat('Subtask created: ', v_title)
  where id = v_parent.id;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, new_status, new_assigned_to_user_id,
    notes, photo_attachments, signed_by, signed_by_email, payload
  )
  values (
    v_child.id, v_child.order_id, 'subtask_created', v_child.status, v_child.assigned_to_user_id,
    v_description, v_photo_attachments, auth.uid(), v_signed_email,
    jsonb_build_object('parent_task_id', v_parent.id)
  );

  insert into public.ebay_order_task_events (
    task_id, order_id, action, old_status, new_status, notes, signed_by, signed_by_email, payload
  )
  values (
    v_parent.id, v_parent.order_id, 'subtask_created', v_parent.status, 'waiting_on_subtasks',
    concat('Subtask created and assigned to ', coalesce(v_employee.display_name, v_employee.email, 'employee'), ': ', v_title),
    auth.uid(), v_signed_email,
    jsonb_build_object('subtask_id', v_child.id)
  );

  return v_child;
end;
$$;

drop function if exists public.respond_ebay_order_coordination_task(uuid, text, uuid, text, text, jsonb, text, timestamptz);

create or replace function public.respond_ebay_order_coordination_task(
  _task_id uuid,
  _note text default null,
  _assigned_to_user_id uuid default null,
  _status text default null,
  _priority text default null,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null,
  _due_at timestamptz default null
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
begin
  select *
    into v_task
  from public.ebay_order_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'eBay order task not found' using errcode = 'P0002';
  end if;

  if not (public.is_admin() or v_task.assigned_to_user_id = auth.uid() or v_task.created_by = auth.uid()) then
    raise exception 'Not allowed to update this eBay order task' using errcode = '42501';
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
      latest_photo_count = jsonb_array_length(v_photo_attachments),
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
    jsonb_build_object('old_due_at', v_old_due_at, 'due_at', v_task.due_at)
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

create or replace function public.approve_ebay_order_subtask(
  _task_id uuid,
  _note text default null,
  _signed_by_email text default null
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_order_tasks;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only admins can approve subtasks' using errcode = '42501';
  end if;

  select * into v_task
  from public.ebay_order_tasks
  where id = _task_id
  for update;

  if not found or v_task.task_type <> 'pending_subtask' then
    raise exception 'Subtask not found' using errcode = 'P0002';
  end if;

  update public.ebay_order_tasks
  set status = 'approved_by_admin',
      completed_at = coalesce(completed_at, now()),
      latest_note = coalesce(v_note, latest_note),
      resolution_notes = coalesce(v_note, resolution_notes)
  where id = v_task.id
  returning * into v_task;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, old_status, new_status, notes, signed_by, signed_by_email
  )
  values (
    v_task.id, v_task.order_id, 'approved_by_admin', 'completed_by_employee', v_task.status,
    v_note, auth.uid(), v_signed_email
  );

  if v_task.parent_task_id is not null then
    update public.ebay_order_tasks
    set status = case
          when public.ebay_order_required_subtasks_complete(v_task.parent_task_id) then 'ready_for_admin_approval'
          else 'waiting_on_subtasks'
        end,
        latest_note = coalesce(v_note, latest_note)
    where id = v_task.parent_task_id
      and status not in ('assigned_for_shipping', 'shipped_completed', 'closed', 'cancelled');
  end if;

  return v_task;
end;
$$;

create or replace function public.send_back_ebay_order_subtask(
  _task_id uuid,
  _note text,
  _assigned_to_user_id uuid default null,
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
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only admins can send subtasks back for rework' using errcode = '42501';
  end if;

  if v_note is null then
    raise exception 'Explain what needs to be fixed' using errcode = '22023';
  end if;

  select * into v_task
  from public.ebay_order_tasks
  where id = _task_id
  for update;

  if not found or v_task.task_type <> 'pending_subtask' then
    raise exception 'Subtask not found' using errcode = 'P0002';
  end if;

  if coalesce(_assigned_to_user_id, v_task.assigned_to_user_id) is not null then
    select * into v_employee
    from public.employees
    where user_id = coalesce(_assigned_to_user_id, v_task.assigned_to_user_id)
      and active is true
    limit 1;
  end if;

  update public.ebay_order_tasks
  set status = 'sent_back_for_rework',
      assigned_to_user_id = coalesce(_assigned_to_user_id, assigned_to_user_id),
      assigned_to_employee_id = coalesce(v_employee.id, assigned_to_employee_id),
      assigned_to_email = coalesce(v_employee.email, assigned_to_email),
      assigned_to_role = coalesce(v_employee.role, assigned_to_role),
      due_at = coalesce(_due_at, due_at),
      latest_note = v_note,
      completed_at = null,
      resolution_notes = null
  where id = v_task.id
  returning * into v_task;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, new_status, new_assigned_to_user_id, notes, signed_by, signed_by_email
  )
  values (
    v_task.id, v_task.order_id, 'sent_back_for_rework', v_task.status, v_task.assigned_to_user_id,
    v_note, auth.uid(), v_signed_email
  );

  if v_task.parent_task_id is not null then
    update public.ebay_order_tasks
    set status = 'waiting_on_subtasks',
        latest_note = v_note
    where id = v_task.parent_task_id
      and status not in ('assigned_for_shipping', 'shipped_completed', 'closed', 'cancelled');
  end if;

  return v_task;
end;
$$;

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
  if not public.is_admin() then
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
    coalesce(v_note, 'Approved for shipment. Complete the shipment and add final notes.'),
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
  set status = 'assigned_for_shipping',
      latest_note = coalesce(v_note, concat('Shipping assigned to ', coalesce(v_employee.display_name, v_employee.email, 'employee')))
  where id = v_parent.id;

  insert into public.ebay_order_task_events (
    task_id, order_id, action, new_status, notes, signed_by, signed_by_email
  )
  values (
    v_parent.id, v_parent.order_id, 'approved_for_shipping', 'approved_for_shipping',
    coalesce(v_note, 'Pending order approved for shipping.'), auth.uid(), v_signed_email
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

grant execute on function public.ebay_order_required_subtasks_complete(uuid) to authenticated;
grant execute on function public.create_ebay_order_subtask(uuid, text, text, uuid, text, timestamptz, jsonb, text) to authenticated;
grant execute on function public.respond_ebay_order_coordination_task(uuid, text, uuid, text, text, jsonb, text, timestamptz) to authenticated;
grant execute on function public.approve_ebay_order_subtask(uuid, text, text) to authenticated;
grant execute on function public.send_back_ebay_order_subtask(uuid, text, uuid, timestamptz, text) to authenticated;
grant execute on function public.assign_ebay_order_shipping_task(uuid, uuid, text, timestamptz, text) to authenticated;
