-- Admin-cancelled assignments are audit records, not active work items.
-- Keep the rows and events for traceability, but hide them from task feeds.

create or replace function public.is_task_hidden_from_task_page(
  _metadata jsonb default '{}'::jsonb,
  _latest_note text default null,
  _assigned_to_user_id uuid default null,
  _assigned_to_email text default null
)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
  select
    lower(coalesce(coalesce(_metadata, '{}'::jsonb) ->> 'hidden_from_task_board', '')) in ('true', '1', 'yes')
    or nullif(coalesce(_metadata, '{}'::jsonb) ->> 'assignment_cancelled_at', '') is not null
    or nullif(coalesce(_metadata, '{}'::jsonb) ->> 'assignment_canceled_at', '') is not null
    or (
      _assigned_to_user_id is null
      and nullif(btrim(coalesce(_assigned_to_email, '')), '') is null
      and concat_ws(
        ' ',
        _latest_note,
        coalesce(_metadata, '{}'::jsonb) ->> 'history_removed_note',
        coalesce(_metadata, '{}'::jsonb) ->> 'assignment_cancelled_note',
        coalesce(_metadata, '{}'::jsonb) ->> 'assignment_canceled_note'
      ) ~* 'assignment\s+(cancelled|canceled)'
    );
$$;

update public.team_tasks t
set metadata = coalesce(t.metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'assignment_cancelled_at', coalesce(t.updated_at, t.created_at, now()),
      'assignment_cancelled_by', t.assigned_by,
      'assignment_cancelled_by_email', t.assigned_by_email,
      'assignment_cancelled_note', coalesce(nullif(btrim(t.latest_note), ''), 'Assignment cancelled by admin.')
    ))
where t.assigned_to_user_id is null
  and nullif(btrim(coalesce(t.assigned_to_email, '')), '') is null
  and concat_ws(' ', t.latest_note, t.metadata ->> 'history_removed_note') ~* 'assignment\s+(cancelled|canceled)'
  and t.metadata ->> 'assignment_cancelled_at' is null;

update public.ebay_order_tasks t
set metadata = coalesce(t.metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
      'assignment_cancelled_at', coalesce(t.updated_at, t.created_at, now()),
      'assignment_cancelled_by', t.assigned_by,
      'assignment_cancelled_by_email', t.assigned_by_email,
      'assignment_cancelled_note', coalesce(nullif(btrim(t.latest_note), ''), 'Assignment cancelled by admin.')
    ))
where t.assigned_to_user_id is null
  and nullif(btrim(coalesce(t.assigned_to_email, '')), '') is null
  and concat_ws(' ', t.latest_note, t.metadata ->> 'history_removed_note') ~* 'assignment\s+(cancelled|canceled)'
  and t.metadata ->> 'assignment_cancelled_at' is null;

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
  v_cancel_note text;
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

  v_cancel_note := coalesce(v_note, 'Assignment cancelled by admin.');

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
          when v_action = 'cancel_assignment' then v_cancel_note
          else coalesce(v_note, latest_note)
        end,
        metadata = case
          when v_action = 'cancel_assignment' then coalesce(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
            'assignment_cancelled_at', now(),
            'assignment_cancelled_by', auth.uid(),
            'assignment_cancelled_by_email', v_signed_email,
            'assignment_cancelled_note', v_cancel_note
          ))
          when v_action = 'reassign' then coalesce(metadata, '{}'::jsonb)
            - 'assignment_cancelled_at'
            - 'assignment_canceled_at'
            - 'assignment_cancelled_by'
            - 'assignment_canceled_by'
            - 'assignment_cancelled_by_email'
            - 'assignment_canceled_by_email'
            - 'assignment_cancelled_note'
            - 'assignment_canceled_note'
          else metadata
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
        when v_action = 'cancel_assignment' then v_cancel_note
        else coalesce(v_note, latest_note)
      end,
      metadata = case
        when v_action = 'cancel_assignment' then coalesce(metadata, '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object(
          'assignment_cancelled_at', now(),
          'assignment_cancelled_by', auth.uid(),
          'assignment_cancelled_by_email', v_signed_email,
          'assignment_cancelled_note', v_cancel_note
        ))
        when v_action = 'reassign' then coalesce(metadata, '{}'::jsonb)
          - 'assignment_cancelled_at'
          - 'assignment_canceled_at'
          - 'assignment_cancelled_by'
          - 'assignment_canceled_by'
          - 'assignment_cancelled_by_email'
          - 'assignment_canceled_by_email'
          - 'assignment_cancelled_note'
          - 'assignment_canceled_note'
        else metadata
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

create or replace function public.list_my_team_tasks(_limit integer default 12)
returns table (
  id uuid,
  task_type text,
  title text,
  description text,
  status text,
  priority text,
  assigned_to_email text,
  assigned_to_user_id uuid,
  assigned_by uuid,
  assigned_by_email text,
  due_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  created_by uuid,
  created_by_email text,
  metadata jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id,
    t.task_type,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.assigned_to_user_id,
    t.assigned_by,
    t.assigned_by_email,
    t.due_at,
    t.created_at,
    t.updated_at,
    t.latest_note,
    t.latest_photo_count,
    t.created_by,
    t.created_by_email,
    t.metadata
  from public.team_tasks t
  where (
      t.assigned_to_user_id = auth.uid()
      or t.created_by = auth.uid()
      or t.assigned_by = auth.uid()
    )
    and t.status in (
      'open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker',
      'blocked', 'deferred', 'pending_admin_review', 'ready_for_admin_approval',
      'completed_by_employee', 'sent_back_for_rework'
    )
    and t.metadata ->> 'history_removed_at' is null
    and not public.is_task_hidden_from_task_page(t.metadata, t.latest_note, t.assigned_to_user_id, t.assigned_to_email)
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
$$;

create or replace function public.list_admin_team_tasks(_limit integer default 12)
returns table (
  id uuid,
  task_type text,
  title text,
  description text,
  status text,
  priority text,
  assigned_to_email text,
  assigned_to_user_id uuid,
  assigned_by uuid,
  assigned_by_email text,
  due_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  created_by uuid,
  created_by_email text,
  metadata jsonb
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.current_user_is_employee_admin() then
    raise exception 'Only admins can list all team tasks' using errcode = '42501';
  end if;

  return query
  select
    t.id,
    t.task_type,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.assigned_to_user_id,
    t.assigned_by,
    t.assigned_by_email,
    t.due_at,
    t.created_at,
    t.updated_at,
    t.latest_note,
    t.latest_photo_count,
    t.created_by,
    t.created_by_email,
    t.metadata
  from public.team_tasks t
  where t.status in (
      'open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker',
      'blocked', 'deferred', 'pending_admin_review', 'ready_for_admin_approval',
      'completed_by_employee', 'sent_back_for_rework'
    )
    and t.metadata ->> 'history_removed_at' is null
    and not public.is_task_hidden_from_task_page(t.metadata, t.latest_note, t.assigned_to_user_id, t.assigned_to_email)
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
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
    and t.metadata ->> 'history_removed_at' is null
    and not public.is_task_hidden_from_task_page(t.metadata, t.latest_note, t.assigned_to_user_id, t.assigned_to_email)
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
    and t.metadata ->> 'history_removed_at' is null
    and not public.is_task_hidden_from_task_page(t.metadata, t.latest_note, t.assigned_to_user_id, t.assigned_to_email)
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    o.ship_by_date nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 8), 50));
end;
$$;

revoke all on function public.is_task_hidden_from_task_page(jsonb, text, uuid, text) from public;
revoke all on function public.admin_manage_task_assignment(text, uuid, text, uuid, text, text) from public;
revoke all on function public.list_my_team_tasks(integer) from public;
revoke all on function public.list_admin_team_tasks(integer) from public;
revoke all on function public.list_my_ebay_order_tasks(integer) from public;
revoke all on function public.list_admin_ebay_order_tasks(integer) from public;

grant execute on function public.is_task_hidden_from_task_page(jsonb, text, uuid, text) to authenticated;
grant execute on function public.admin_manage_task_assignment(text, uuid, text, uuid, text, text) to authenticated;
grant execute on function public.list_my_team_tasks(integer) to authenticated;
grant execute on function public.list_admin_team_tasks(integer) to authenticated;
grant execute on function public.list_my_ebay_order_tasks(integer) to authenticated;
grant execute on function public.list_admin_ebay_order_tasks(integer) to authenticated;

comment on function public.is_task_hidden_from_task_page(jsonb, text, uuid, text)
  is 'Returns true for internal audit/order-evidence rows and admin-cancelled assignment shells that should not render as task-page work items.';
