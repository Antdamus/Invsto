-- Let assigned workers/admins document delayed task progress, blocked work,
-- and the next follow-up date without losing the task audit trail.

alter table public.ebay_order_tasks
  drop constraint if exists ebay_order_tasks_status_check;

alter table public.ebay_order_tasks
  add constraint ebay_order_tasks_status_check
  check (status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred', 'resolved', 'cancelled'));

alter table public.team_tasks
  drop constraint if exists team_tasks_status_check;

alter table public.team_tasks
  add constraint team_tasks_status_check
  check (status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred', 'resolved', 'cancelled'));

alter table public.ebay_return_tasks
  drop constraint if exists ebay_return_tasks_status_check;

alter table public.ebay_return_tasks
  add constraint ebay_return_tasks_status_check
  check (status in ('open', 'assigned', 'in_progress', 'blocked', 'deferred', 'resolved', 'cancelled'));

drop function if exists public.respond_ebay_order_coordination_task(uuid, text, uuid, text, text, jsonb, text);

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
  v_employee public.employees;
  v_old_status text;
  v_old_assigned uuid;
  v_old_due_at timestamptz;
  v_note text := nullif(btrim(coalesce(_note, '')), '');
  v_status text := nullif(btrim(coalesce(_status, '')), '');
  v_priority text := nullif(btrim(coalesce(_priority, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_action text := 'commented';
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

  if v_status is not null and v_status not in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred', 'resolved', 'cancelled') then
    raise exception 'Invalid order task status: %', v_status using errcode = '22023';
  end if;

  if v_priority is not null and v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid order task priority: %', v_priority using errcode = '22023';
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
        when coalesce(v_status, status) = 'in_progress' and started_at is null then now()
        else started_at
      end,
      resolved_at = case
        when coalesce(v_status, status) in ('resolved', 'cancelled') then now()
        else resolved_at
      end,
      resolved_by = case
        when coalesce(v_status, status) in ('resolved', 'cancelled') then auth.uid()
        else resolved_by
      end,
      resolved_by_email = case
        when coalesce(v_status, status) in ('resolved', 'cancelled') then v_signed_email
        else resolved_by_email
      end,
      resolution_notes = case
        when coalesce(v_status, status) in ('resolved', 'cancelled') then v_note
        else resolution_notes
      end
  where id = _task_id
  returning * into v_task;

  v_action := case
    when v_task.status = 'resolved' then 'resolved'
    when v_task.status = 'cancelled' then 'cancelled'
    when v_old_assigned is distinct from v_task.assigned_to_user_id then 'assigned'
    when v_old_status is distinct from v_task.status then 'status_changed'
    else 'commented'
  end;

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
    v_action,
    v_old_status,
    v_task.status,
    v_old_assigned,
    v_task.assigned_to_user_id,
    v_note,
    v_photo_attachments,
    auth.uid(),
    v_signed_email,
    jsonb_build_object('old_due_at', v_old_due_at, 'due_at', v_task.due_at)
  );

  return v_task;
end;
$$;

drop function if exists public.respond_team_task(uuid, text, uuid, text, text, jsonb, text);

create or replace function public.respond_team_task(
  _task_id uuid,
  _note text default null,
  _assigned_to_user_id uuid default null,
  _status text default null,
  _priority text default null,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null,
  _due_at timestamptz default null
)
returns public.team_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.team_tasks;
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
  from public.team_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Team task not found' using errcode = 'P0002';
  end if;

  if not (public.is_admin() or v_task.assigned_to_user_id = auth.uid() or v_task.created_by = auth.uid()) then
    raise exception 'Not allowed to update this team task' using errcode = '42501';
  end if;

  if v_status is not null and v_status not in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred', 'resolved', 'cancelled') then
    raise exception 'Invalid team task status: %', v_status using errcode = '22023';
  end if;

  if v_priority is not null and v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid team task priority: %', v_priority using errcode = '22023';
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
    v_status := case when v_employee.role = 'admin' then 'waiting_on_admin' else 'waiting_on_worker' end;
  end if;

  update public.team_tasks
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
      started_at = case when coalesce(v_status, status) = 'in_progress' and started_at is null then now() else started_at end,
      resolved_at = case when coalesce(v_status, status) in ('resolved', 'cancelled') then now() else resolved_at end,
      resolved_by = case when coalesce(v_status, status) in ('resolved', 'cancelled') then auth.uid() else resolved_by end,
      resolved_by_email = case when coalesce(v_status, status) in ('resolved', 'cancelled') then v_signed_email else resolved_by_email end,
      resolution_notes = case when coalesce(v_status, status) in ('resolved', 'cancelled') then v_note else resolution_notes end
  where id = _task_id
  returning * into v_task;

  v_action := case
    when v_task.status = 'resolved' then 'resolved'
    when v_task.status = 'cancelled' then 'cancelled'
    when v_old_assigned is distinct from v_task.assigned_to_user_id then 'assigned'
    when v_old_status is distinct from v_task.status then 'status_changed'
    else 'commented'
  end;

  insert into public.team_task_events (
    task_id,
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
    v_action,
    v_old_status,
    v_task.status,
    v_old_assigned,
    v_task.assigned_to_user_id,
    v_note,
    v_photo_attachments,
    auth.uid(),
    v_signed_email,
    jsonb_build_object('old_due_at', v_old_due_at, 'due_at', v_task.due_at)
  );

  return v_task;
end;
$$;

drop function if exists public.update_ebay_return_task_status(uuid, text, text, text);

create or replace function public.update_ebay_return_task_status(
  _task_id uuid,
  _status text,
  _resolution_notes text default null,
  _signed_by_email text default null,
  _due_at timestamptz default null
)
returns public.ebay_return_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_return_tasks;
  v_old_status text;
  v_old_due_at timestamptz;
  v_status text := nullif(btrim(coalesce(_status, '')), '');
  v_notes text := nullif(btrim(coalesce(_resolution_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if v_status not in ('open', 'assigned', 'in_progress', 'blocked', 'deferred', 'resolved', 'cancelled') then
    raise exception 'Invalid return task status: %', coalesce(v_status, '<empty>') using errcode = '22023';
  end if;

  select *
    into v_task
  from public.ebay_return_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Return task not found' using errcode = 'P0002';
  end if;

  if not (public.is_admin() or v_task.assigned_to_user_id = auth.uid() or v_task.created_by = auth.uid()) then
    raise exception 'Not allowed to update this eBay return task' using errcode = '42501';
  end if;

  v_old_status := v_task.status;
  v_old_due_at := v_task.due_at;

  update public.ebay_return_tasks
  set status = v_status,
      due_at = coalesce(_due_at, due_at),
      started_at = case when v_status = 'in_progress' and started_at is null then now() else started_at end,
      resolved_at = case when v_status in ('resolved', 'cancelled') then now() else null end,
      resolved_by = case when v_status in ('resolved', 'cancelled') then auth.uid() else null end,
      resolved_by_email = case when v_status in ('resolved', 'cancelled') then v_signed_email else null end,
      resolution_notes = case when v_status in ('resolved', 'cancelled') then v_notes else resolution_notes end
  where id = _task_id
  returning * into v_task;

  insert into public.ebay_return_task_events (
    task_id,
    return_case_id,
    action,
    old_status,
    new_status,
    notes,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_task.id,
    v_task.return_case_id,
    case when v_status = 'resolved' then 'resolved' when v_status = 'cancelled' then 'cancelled' else 'status_changed' end,
    v_old_status,
    v_task.status,
    v_notes,
    auth.uid(),
    v_signed_email,
    jsonb_build_object('old_due_at', v_old_due_at, 'due_at', v_task.due_at)
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
    and t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
  order by
    case t.priority
      when 'urgent' then 0
      when 'high' then 1
      when 'normal' then 2
      else 3
    end,
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
  if not public.is_admin() then
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
  where t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
  order by
    case t.priority
      when 'urgent' then 0
      when 'high' then 1
      when 'normal' then 2
      else 3
    end,
    t.due_at nulls last,
    o.ship_by_date nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 8), 50));
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
  due_at timestamptz,
  created_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  created_by_email text
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
    t.due_at,
    t.created_at,
    t.latest_note,
    t.latest_photo_count,
    t.created_by_email
  from public.team_tasks t
  where (t.assigned_to_user_id = auth.uid() or t.created_by = auth.uid())
    and t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
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
  due_at timestamptz,
  created_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  created_by_email text
)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
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
    t.due_at,
    t.created_at,
    t.latest_note,
    t.latest_photo_count,
    t.created_by_email
  from public.team_tasks t
  where t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
end;
$$;

create or replace function public.list_my_ebay_return_tasks(_limit integer default 6)
returns table (
  id uuid,
  task_type text,
  title text,
  question text,
  status text,
  priority text,
  assigned_to_email text,
  due_at timestamptz,
  created_at timestamptz,
  return_case_id uuid,
  order_number text,
  ebay_return_id text,
  buyer_username text,
  return_reason text
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
    t.question,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.due_at,
    t.created_at,
    t.return_case_id,
    c.order_number,
    c.ebay_return_id,
    c.buyer_username,
    c.return_reason
  from public.ebay_return_tasks t
  left join public.ebay_return_cases c
    on c.id = t.return_case_id
  where t.assigned_to_user_id = auth.uid()
    and t.status in ('open', 'assigned', 'in_progress', 'blocked', 'deferred')
  order by
    case t.priority
      when 'urgent' then 0
      when 'high' then 1
      when 'normal' then 2
      else 3
    end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 6), 50));
$$;

revoke all on function public.respond_ebay_order_coordination_task(uuid, text, uuid, text, text, jsonb, text, timestamptz) from public;
revoke all on function public.respond_team_task(uuid, text, uuid, text, text, jsonb, text, timestamptz) from public;
revoke all on function public.update_ebay_return_task_status(uuid, text, text, text, timestamptz) from public;
revoke all on function public.list_my_ebay_order_tasks(integer) from public;
revoke all on function public.list_admin_ebay_order_tasks(integer) from public;
revoke all on function public.list_my_team_tasks(integer) from public;
revoke all on function public.list_admin_team_tasks(integer) from public;
revoke all on function public.list_my_ebay_return_tasks(integer) from public;

grant execute on function public.respond_ebay_order_coordination_task(uuid, text, uuid, text, text, jsonb, text, timestamptz) to authenticated;
grant execute on function public.respond_team_task(uuid, text, uuid, text, text, jsonb, text, timestamptz) to authenticated;
grant execute on function public.update_ebay_return_task_status(uuid, text, text, text, timestamptz) to authenticated;
grant execute on function public.list_my_ebay_order_tasks(integer) to authenticated;
grant execute on function public.list_admin_ebay_order_tasks(integer) to authenticated;
grant execute on function public.list_my_team_tasks(integer) to authenticated;
grant execute on function public.list_admin_team_tasks(integer) to authenticated;
grant execute on function public.list_my_ebay_return_tasks(integer) to authenticated;
