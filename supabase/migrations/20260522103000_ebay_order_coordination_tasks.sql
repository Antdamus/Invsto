-- Internal coordination tasks for pending eBay orders.
-- Workers can raise a question with notes/photos, admins can reply or reassign,
-- and every handoff is preserved in an event trail.

create table if not exists public.ebay_order_tasks (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.ebay_orders(id) on delete cascade,
  order_line_ids uuid[] not null default '{}'::uuid[],
  task_type text not null default 'coordination'
    check (task_type in ('coordination', 'admin_review', 'worker_follow_up', 'special_order')),
  title text not null,
  question text,
  status text not null default 'open'
    check (status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'resolved', 'cancelled')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to_user_id uuid,
  assigned_to_employee_id uuid references public.employees(id) on delete set null,
  assigned_to_email text,
  assigned_to_role text
    check (assigned_to_role is null or assigned_to_role in ('admin', 'manager', 'employee')),
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_by_email text,
  due_at timestamptz,
  latest_note text,
  latest_photo_count integer not null default 0,
  started_at timestamptz,
  resolved_at timestamptz,
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_by_email text,
  resolution_notes text,
  created_by uuid references auth.users(id) on delete set null,
  created_by_email text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);

create table if not exists public.ebay_order_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.ebay_order_tasks(id) on delete cascade,
  order_id uuid not null references public.ebay_orders(id) on delete cascade,
  action text not null
    check (action in ('created', 'assigned', 'status_changed', 'commented', 'resolved', 'cancelled')),
  old_status text,
  new_status text,
  old_assigned_to_user_id uuid,
  new_assigned_to_user_id uuid,
  notes text,
  photo_attachments jsonb not null default '[]'::jsonb,
  signed_by uuid references auth.users(id) on delete set null,
  signed_by_email text,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

alter table public.ebay_order_tasks enable row level security;
alter table public.ebay_order_task_events enable row level security;

drop policy if exists "ebay_order_tasks_inventory_staff_select" on public.ebay_order_tasks;
create policy "ebay_order_tasks_inventory_staff_select"
on public.ebay_order_tasks
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_order_tasks_inventory_staff_insert" on public.ebay_order_tasks;
create policy "ebay_order_tasks_inventory_staff_insert"
on public.ebay_order_tasks
for insert
to authenticated
with check (public.can_manage_inventory());

drop policy if exists "ebay_order_tasks_admin_assignee_creator_update" on public.ebay_order_tasks;
create policy "ebay_order_tasks_admin_assignee_creator_update"
on public.ebay_order_tasks
for update
to authenticated
using (
  public.is_admin()
  or assigned_to_user_id = auth.uid()
  or created_by = auth.uid()
)
with check (
  public.is_admin()
  or assigned_to_user_id = auth.uid()
  or created_by = auth.uid()
);

drop policy if exists "ebay_order_task_events_inventory_staff_select" on public.ebay_order_task_events;
create policy "ebay_order_task_events_inventory_staff_select"
on public.ebay_order_task_events
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_order_task_events_inventory_staff_insert" on public.ebay_order_task_events;
create policy "ebay_order_task_events_inventory_staff_insert"
on public.ebay_order_task_events
for insert
to authenticated
with check (public.can_manage_inventory());

grant select, insert, update on table public.ebay_order_tasks to authenticated;
grant select, insert on table public.ebay_order_task_events to authenticated;

create index if not exists ebay_order_tasks_order_idx
  on public.ebay_order_tasks(order_id, created_at desc);

create index if not exists ebay_order_tasks_assignee_status_idx
  on public.ebay_order_tasks(assigned_to_user_id, status, due_at nulls last, created_at desc);

create index if not exists ebay_order_tasks_status_priority_idx
  on public.ebay_order_tasks(status, priority, created_at desc);

create index if not exists ebay_order_tasks_line_ids_idx
  on public.ebay_order_tasks using gin(order_line_ids);

create index if not exists ebay_order_task_events_task_idx
  on public.ebay_order_task_events(task_id, created_at desc);

create or replace function public.touch_ebay_order_task_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ebay_order_tasks_updated_at on public.ebay_order_tasks;
create trigger trg_ebay_order_tasks_updated_at
before update on public.ebay_order_tasks
for each row execute function public.touch_ebay_order_task_updated_at();

create or replace function public.list_ebay_order_task_assignees()
returns table (
  id uuid,
  user_id uuid,
  display_name text,
  email text,
  role text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    e.id,
    e.user_id,
    e.display_name,
    e.email,
    e.role
  from public.employees e
  where e.active is true
    and public.can_manage_inventory()
    and e.user_id is not null
  order by
    case e.role when 'admin' then 0 when 'manager' then 1 else 2 end,
    e.display_name;
$$;

create or replace function public.create_ebay_order_coordination_task(
  _order_id uuid,
  _order_line_ids uuid[] default '{}'::uuid[],
  _assigned_to_user_id uuid default null,
  _priority text default 'normal',
  _question text default null,
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
  v_order public.ebay_orders;
  v_task public.ebay_order_tasks;
  v_employee public.employees;
  v_priority text := coalesce(nullif(btrim(coalesce(_priority, '')), ''), 'normal');
  v_question text := nullif(btrim(coalesce(_question, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_status text := 'open';
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to create eBay order coordination tasks' using errcode = '42501';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid order task priority: %', v_priority using errcode = '22023';
  end if;

  if v_question is null then
    raise exception 'A task note/question is required' using errcode = '22023';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = _order_id;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
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

    v_status := case
      when v_employee.role = 'admin' then 'waiting_on_admin'
      else 'waiting_on_worker'
    end;
  end if;

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
    coalesce(_order_line_ids, '{}'::uuid[]),
    case when _assigned_to_user_id is not null and v_employee.role = 'admin' then 'admin_review' else 'coordination' end,
    concat('Order ', coalesce(v_order.order_number, 'coordination'), ' - ', coalesce(v_order.buyer_username, 'unknown buyer')),
    v_question,
    v_status,
    v_priority,
    _assigned_to_user_id,
    case when _assigned_to_user_id is null then null else v_employee.id end,
    case when _assigned_to_user_id is null then null else v_employee.email end,
    case when _assigned_to_user_id is null then null else v_employee.role end,
    auth.uid(),
    v_signed_email,
    _due_at,
    v_question,
    jsonb_array_length(v_photo_attachments),
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'order_number', v_order.order_number,
      'buyer_username', v_order.buyer_username,
      'source', 'pending_orders'
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
    signed_by_email
  )
  values (
    v_task.id,
    v_task.order_id,
    'created',
    v_task.status,
    v_task.assigned_to_user_id,
    v_question,
    v_photo_attachments,
    auth.uid(),
    v_signed_email
  );

  return v_task;
end;
$$;

create or replace function public.respond_ebay_order_coordination_task(
  _task_id uuid,
  _note text default null,
  _assigned_to_user_id uuid default null,
  _status text default null,
  _priority text default null,
  _photo_attachments jsonb default '[]'::jsonb,
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

  if v_status is not null and v_status not in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'resolved', 'cancelled') then
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
    signed_by_email
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
    v_signed_email
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
    and t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker')
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
  where t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker')
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

revoke all on function public.list_ebay_order_task_assignees() from public;
revoke all on function public.create_ebay_order_coordination_task(uuid, uuid[], uuid, text, text, timestamptz, jsonb, text) from public;
revoke all on function public.respond_ebay_order_coordination_task(uuid, text, uuid, text, text, jsonb, text) from public;
revoke all on function public.list_my_ebay_order_tasks(integer) from public;
revoke all on function public.list_admin_ebay_order_tasks(integer) from public;

grant execute on function public.list_ebay_order_task_assignees() to authenticated;
grant execute on function public.create_ebay_order_coordination_task(uuid, uuid[], uuid, text, text, timestamptz, jsonb, text) to authenticated;
grant execute on function public.respond_ebay_order_coordination_task(uuid, text, uuid, text, text, jsonb, text) to authenticated;
grant execute on function public.list_my_ebay_order_tasks(integer) to authenticated;
grant execute on function public.list_admin_ebay_order_tasks(integer) to authenticated;
