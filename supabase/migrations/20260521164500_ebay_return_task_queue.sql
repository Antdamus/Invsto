-- eBay return work queue and task assignment workflow.
-- Return cases are the audit record; tasks are the operational queue that lets
-- admins assign follow-up questions and workers see their pending return work.

create table if not exists public.ebay_return_tasks (
  id uuid primary key default gen_random_uuid(),
  return_case_id uuid not null references public.ebay_return_cases(id) on delete cascade,
  order_id uuid references public.ebay_orders(id) on delete cascade,
  order_line_ids uuid[] not null default '{}'::uuid[],
  task_type text not null default 'return_intake'
    check (task_type in ('return_intake', 'return_review', 'question', 'follow_up')),
  title text not null,
  question text,
  status text not null default 'open'
    check (status in ('open', 'assigned', 'in_progress', 'blocked', 'resolved', 'cancelled')),
  priority text not null default 'normal'
    check (priority in ('low', 'normal', 'high', 'urgent')),
  assigned_to_user_id uuid,
  assigned_to_employee_id uuid references public.employees(id) on delete set null,
  assigned_to_email text,
  assigned_by uuid references auth.users(id) on delete set null,
  assigned_by_email text,
  due_at timestamptz,
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

create table if not exists public.ebay_return_task_events (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.ebay_return_tasks(id) on delete cascade,
  return_case_id uuid references public.ebay_return_cases(id) on delete cascade,
  action text not null
    check (action in ('created', 'assigned', 'status_changed', 'commented', 'resolved', 'cancelled')),
  old_status text,
  new_status text,
  old_assigned_to_user_id uuid,
  new_assigned_to_user_id uuid,
  notes text,
  signed_by uuid references auth.users(id) on delete set null,
  signed_by_email text,
  created_at timestamptz not null default now(),
  payload jsonb not null default '{}'::jsonb
);

alter table public.ebay_return_tasks enable row level security;
alter table public.ebay_return_task_events enable row level security;

drop policy if exists "ebay_return_tasks_inventory_staff_select" on public.ebay_return_tasks;
create policy "ebay_return_tasks_inventory_staff_select"
on public.ebay_return_tasks
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_return_tasks_inventory_staff_insert" on public.ebay_return_tasks;
create policy "ebay_return_tasks_inventory_staff_insert"
on public.ebay_return_tasks
for insert
to authenticated
with check (public.can_manage_inventory());

drop policy if exists "ebay_return_tasks_admin_or_assignee_update" on public.ebay_return_tasks;
create policy "ebay_return_tasks_admin_or_assignee_update"
on public.ebay_return_tasks
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

drop policy if exists "ebay_return_task_events_inventory_staff_select" on public.ebay_return_task_events;
create policy "ebay_return_task_events_inventory_staff_select"
on public.ebay_return_task_events
for select
to authenticated
using (public.can_manage_inventory());

drop policy if exists "ebay_return_task_events_inventory_staff_insert" on public.ebay_return_task_events;
create policy "ebay_return_task_events_inventory_staff_insert"
on public.ebay_return_task_events
for insert
to authenticated
with check (public.can_manage_inventory());

grant select, insert, update on table public.ebay_return_tasks to authenticated;
grant select, insert on table public.ebay_return_task_events to authenticated;

create index if not exists ebay_return_tasks_case_idx
  on public.ebay_return_tasks(return_case_id, created_at desc);

create index if not exists ebay_return_tasks_assignee_status_idx
  on public.ebay_return_tasks(assigned_to_user_id, status, due_at nulls last, created_at desc);

create index if not exists ebay_return_tasks_status_priority_idx
  on public.ebay_return_tasks(status, priority, created_at desc);

create index if not exists ebay_return_tasks_line_ids_idx
  on public.ebay_return_tasks using gin(order_line_ids);

create index if not exists ebay_return_task_events_task_idx
  on public.ebay_return_task_events(task_id, created_at desc);

create or replace function public.touch_ebay_return_task_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists trg_ebay_return_tasks_updated_at on public.ebay_return_tasks;
create trigger trg_ebay_return_tasks_updated_at
before update on public.ebay_return_tasks
for each row execute function public.touch_ebay_return_task_updated_at();

insert into public.ebay_return_tasks (
  return_case_id,
  order_id,
  order_line_ids,
  task_type,
  title,
  question,
  status,
  priority,
  metadata
)
select
  c.id,
  c.order_id,
  coalesce(array_agg(distinct ri.order_line_id) filter (where ri.order_line_id is not null), '{}'::uuid[]),
  case when c.status in ('needs_review', 'partially_received') then 'return_review' else 'return_intake' end,
  case when c.status in ('needs_review', 'partially_received') then 'Review eBay return outcome' else 'Complete eBay return intake' end,
  case
    when c.status = 'needs_review' then 'This return needs admin review before it is fully closed.'
    when c.status = 'partially_received' then 'This return was only partially received. Verify what is missing.'
    else 'Inspect the returned item, attach evidence photos, choose the disposition, and save the return.'
  end,
  'open',
  case when c.status = 'needs_review' then 'high' else 'normal' end,
  jsonb_build_object(
    'source', 'return_task_migration_backfill',
    'order_number', c.order_number,
    'buyer_username', c.buyer_username,
    'ebay_return_id', c.ebay_return_id,
    'return_status', c.status
  )
from public.ebay_return_cases c
left join public.ebay_return_items ri on ri.return_case_id = c.id
where c.status in ('open', 'received', 'partially_received', 'needs_review')
  and not exists (
    select 1
    from public.ebay_return_tasks t
    where t.return_case_id = c.id
      and t.status not in ('resolved', 'cancelled')
  )
group by c.id;

create or replace function public.open_ebay_return_case(
  _order_id uuid,
  _order_line_ids uuid[],
  _order_number text default null,
  _ebay_return_id text default null,
  _buyer_username text default null,
  _return_reason text default null,
  _notes text default null,
  _raw_payload jsonb default '{}'::jsonb,
  _signed_by_email text default null
)
returns table (
  return_case_id uuid,
  task_id uuid
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.ebay_orders;
  v_case public.ebay_return_cases;
  v_task public.ebay_return_tasks;
  v_line_ids uuid[] := coalesce(_order_line_ids, '{}'::uuid[]);
  v_ebay_return_id text := nullif(btrim(coalesce(_ebay_return_id, '')), '');
  v_reason text := nullif(btrim(coalesce(_return_reason, '')), '');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_payload jsonb := case
    when jsonb_typeof(coalesce(_raw_payload, '{}'::jsonb)) = 'object'
      then coalesce(_raw_payload, '{}'::jsonb)
    else jsonb_build_object('payload', _raw_payload)
  end;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to open eBay return cases' using errcode = '42501';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = _order_id;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select *
    into v_case
  from public.ebay_return_cases
  where order_id = v_order.id
    and status not in ('closed', 'cancelled')
    and (
      v_ebay_return_id is null
      or ebay_return_id is null
      or ebay_return_id = v_ebay_return_id
    )
  order by opened_at desc
  limit 1;

  if not found then
    insert into public.ebay_return_cases (
      order_id,
      order_number,
      ebay_return_id,
      buyer_username,
      return_reason,
      status,
      opened_at,
      created_by,
      created_by_email,
      notes,
      raw_payload
    )
    values (
      v_order.id,
      coalesce(nullif(btrim(_order_number), ''), v_order.order_number),
      v_ebay_return_id,
      coalesce(nullif(btrim(_buyer_username), ''), v_order.buyer_username),
      v_reason,
      'open',
      now(),
      auth.uid(),
      v_signed_email,
      v_notes,
      v_payload || jsonb_build_object('source', 'ebay_return_extension')
    )
    returning * into v_case;

    insert into public.ebay_return_events (
      return_case_id,
      action,
      order_id,
      order_line_ids,
      notes,
      signed_by,
      signed_by_email,
      payload
    )
    values (
      v_case.id,
      'return_created',
      v_order.id,
      v_line_ids,
      v_notes,
      auth.uid(),
      v_signed_email,
      jsonb_build_object(
        'source', 'ebay_return_extension',
        'order_number', v_order.order_number,
        'buyer_username', v_case.buyer_username,
        'return_reason', v_reason,
        'ebay_return_id', v_ebay_return_id
      ) || v_payload
    );
  else
    update public.ebay_return_cases
    set ebay_return_id = coalesce(v_ebay_return_id, ebay_return_id),
        return_reason = coalesce(v_reason, return_reason),
        buyer_username = coalesce(nullif(btrim(_buyer_username), ''), buyer_username),
        notes = coalesce(v_notes, notes),
        raw_payload = coalesce(raw_payload, '{}'::jsonb) || v_payload || jsonb_build_object('source', 'ebay_return_extension')
    where id = v_case.id
    returning * into v_case;
  end if;

  select *
    into v_task
  from public.ebay_return_tasks
  where return_case_id = v_case.id
    and task_type = 'return_intake'
    and status not in ('resolved', 'cancelled')
  order by created_at desc
  limit 1;

  if not found then
    insert into public.ebay_return_tasks (
      return_case_id,
      order_id,
      order_line_ids,
      task_type,
      title,
      question,
      status,
      priority,
      created_by,
      created_by_email,
      metadata
    )
    values (
      v_case.id,
      v_order.id,
      v_line_ids,
      'return_intake',
      'Complete eBay return intake',
      'Inspect the returned item, attach evidence photos, choose the disposition, and save the return.',
      'open',
      case when v_reason ilike '%description%' or v_reason ilike '%authentic%' then 'high' else 'normal' end,
      auth.uid(),
      v_signed_email,
      v_payload || jsonb_build_object(
        'source', 'ebay_return_extension',
        'order_number', v_order.order_number,
        'buyer_username', v_case.buyer_username,
        'ebay_return_id', v_ebay_return_id,
        'return_reason', v_reason
      )
    )
    returning * into v_task;

    insert into public.ebay_return_task_events (
      task_id,
      return_case_id,
      action,
      new_status,
      notes,
      signed_by,
      signed_by_email,
      payload
    )
    values (
      v_task.id,
      v_case.id,
      'created',
      v_task.status,
      'Return intake task opened from eBay returns page.',
      auth.uid(),
      v_signed_email,
      v_task.metadata
    );
  else
    update public.ebay_return_tasks
    set order_line_ids = case when cardinality(v_line_ids) > 0 then v_line_ids else order_line_ids end,
        metadata = coalesce(metadata, '{}'::jsonb) || v_payload
    where id = v_task.id
    returning * into v_task;
  end if;

  return_case_id := v_case.id;
  task_id := v_task.id;
  return next;
end;
$$;

create or replace function public.assign_ebay_return_task(
  _task_id uuid,
  _assigned_to_user_id uuid,
  _priority text default null,
  _due_at timestamptz default null,
  _notes text default null,
  _signed_by_email text default null
)
returns public.ebay_return_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_return_tasks;
  v_employee public.employees;
  v_old_status text;
  v_old_assigned uuid;
  v_priority text := coalesce(nullif(btrim(coalesce(_priority, '')), ''), 'normal');
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only admins can assign eBay return tasks' using errcode = '42501';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid return task priority: %', v_priority using errcode = '22023';
  end if;

  select *
    into v_task
  from public.ebay_return_tasks
  where id = _task_id
  for update;

  if not found then
    raise exception 'Return task not found' using errcode = 'P0002';
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
  else
    null;
  end if;

  v_old_status := v_task.status;
  v_old_assigned := v_task.assigned_to_user_id;

  update public.ebay_return_tasks
  set assigned_to_user_id = _assigned_to_user_id,
      assigned_to_employee_id = case when _assigned_to_user_id is null then null else v_employee.id end,
      assigned_to_email = case when _assigned_to_user_id is null then null else v_employee.email end,
      assigned_by = auth.uid(),
      assigned_by_email = v_signed_email,
      priority = v_priority,
      due_at = _due_at,
      status = case
        when _assigned_to_user_id is null and status in ('assigned', 'in_progress') then 'open'
        when _assigned_to_user_id is not null and status = 'open' then 'assigned'
        else status
      end
  where id = _task_id
  returning * into v_task;

  insert into public.ebay_return_task_events (
    task_id,
    return_case_id,
    action,
    old_status,
    new_status,
    old_assigned_to_user_id,
    new_assigned_to_user_id,
    notes,
    signed_by,
    signed_by_email
  )
  values (
    v_task.id,
    v_task.return_case_id,
    'assigned',
    v_old_status,
    v_task.status,
    v_old_assigned,
    v_task.assigned_to_user_id,
    v_notes,
    auth.uid(),
    v_signed_email
  );

  return v_task;
end;
$$;

create or replace function public.create_ebay_return_question_task(
  _return_case_id uuid,
  _question text,
  _assigned_to_user_id uuid default null,
  _priority text default 'normal',
  _due_at timestamptz default null,
  _signed_by_email text default null
)
returns public.ebay_return_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.ebay_return_cases;
  v_task public.ebay_return_tasks;
  v_employee public.employees;
  v_question text := nullif(btrim(coalesce(_question, '')), '');
  v_priority text := coalesce(nullif(btrim(coalesce(_priority, '')), ''), 'normal');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if not public.is_admin() then
    raise exception 'Only admins can create eBay return question tasks' using errcode = '42501';
  end if;

  if v_question is null then
    raise exception 'A question or instruction is required' using errcode = '22023';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid return task priority: %', v_priority using errcode = '22023';
  end if;

  select *
    into v_case
  from public.ebay_return_cases
  where id = _return_case_id;

  if not found then
    raise exception 'Return case not found' using errcode = 'P0002';
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
  else
    null;
  end if;

  insert into public.ebay_return_tasks (
    return_case_id,
    order_id,
    task_type,
    title,
    question,
    status,
    priority,
    assigned_to_user_id,
    assigned_to_employee_id,
    assigned_to_email,
    assigned_by,
    assigned_by_email,
    due_at,
    created_by,
    created_by_email,
    metadata
  )
  values (
    v_case.id,
    v_case.order_id,
    'question',
    'Return question for ' || coalesce(v_case.order_number, v_case.ebay_return_id, 'eBay return'),
    v_question,
    case when _assigned_to_user_id is null then 'open' else 'assigned' end,
    v_priority,
    _assigned_to_user_id,
    case when _assigned_to_user_id is null then null else v_employee.id end,
    case when _assigned_to_user_id is null then null else v_employee.email end,
    auth.uid(),
    v_signed_email,
    _due_at,
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'source', 'og_return_queue',
      'order_number', v_case.order_number,
      'buyer_username', v_case.buyer_username,
      'ebay_return_id', v_case.ebay_return_id
    )
  )
  returning * into v_task;

  insert into public.ebay_return_task_events (
    task_id,
    return_case_id,
    action,
    new_status,
    new_assigned_to_user_id,
    notes,
    signed_by,
    signed_by_email
  )
  values (
    v_task.id,
    v_case.id,
    'created',
    v_task.status,
    v_task.assigned_to_user_id,
    v_question,
    auth.uid(),
    v_signed_email
  );

  return v_task;
end;
$$;

create or replace function public.update_ebay_return_task_status(
  _task_id uuid,
  _status text,
  _resolution_notes text default null,
  _signed_by_email text default null
)
returns public.ebay_return_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_return_tasks;
  v_old_status text;
  v_status text := nullif(btrim(coalesce(_status, '')), '');
  v_notes text := nullif(btrim(coalesce(_resolution_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
begin
  if v_status not in ('open', 'assigned', 'in_progress', 'blocked', 'resolved', 'cancelled') then
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

  update public.ebay_return_tasks
  set status = v_status,
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
    signed_by_email
  )
  values (
    v_task.id,
    v_task.return_case_id,
    case when v_status = 'resolved' then 'resolved' when v_status = 'cancelled' then 'cancelled' else 'status_changed' end,
    v_old_status,
    v_task.status,
    v_notes,
    auth.uid(),
    v_signed_email
  );

  return v_task;
end;
$$;

create or replace function public.sync_ebay_return_tasks_after_intake(
  _return_case_ids uuid[],
  _notes text default null,
  _signed_by_email text default null
)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_case public.ebay_return_cases;
  v_task public.ebay_return_tasks;
  v_notes text := nullif(btrim(coalesce(_notes, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_count integer := 0;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to sync eBay return tasks' using errcode = '42501';
  end if;

  for v_case in
    select *
    from public.ebay_return_cases
    where id = any(coalesce(_return_case_ids, '{}'::uuid[]))
  loop
    for v_task in
      update public.ebay_return_tasks
      set status = 'resolved',
          resolved_at = now(),
          resolved_by = auth.uid(),
          resolved_by_email = v_signed_email,
          resolution_notes = coalesce(v_notes, 'Return intake saved.'),
          updated_at = now()
      where return_case_id = v_case.id
        and task_type = 'return_intake'
        and status not in ('resolved', 'cancelled')
      returning *
    loop
      v_count := v_count + 1;
      insert into public.ebay_return_task_events (
        task_id,
        return_case_id,
        action,
        old_status,
        new_status,
        notes,
        signed_by,
        signed_by_email
      )
      values (
        v_task.id,
        v_case.id,
        'resolved',
        'open',
        'resolved',
        coalesce(v_notes, 'Return intake saved.'),
        auth.uid(),
        v_signed_email
      );
    end loop;

    if v_case.status in ('needs_review', 'partially_received') then
      select *
        into v_task
      from public.ebay_return_tasks
      where return_case_id = v_case.id
        and task_type = 'return_review'
        and status not in ('resolved', 'cancelled')
      order by created_at desc
      limit 1;

      if not found then
        insert into public.ebay_return_tasks (
          return_case_id,
          order_id,
          task_type,
          title,
          question,
          status,
          priority,
          created_by,
          created_by_email,
          metadata
        )
        values (
          v_case.id,
          v_case.order_id,
          'return_review',
          'Review eBay return outcome',
          case
            when v_case.status = 'needs_review' then 'This return was saved with an item marked for admin review or wrong item. Decide the next action.'
            else 'This return was only partially received. Verify what is missing and decide the next action.'
          end,
          'open',
          case when v_case.status = 'needs_review' then 'high' else 'normal' end,
          auth.uid(),
          v_signed_email,
          jsonb_build_object(
            'source', 'og_return_intake',
            'order_number', v_case.order_number,
            'buyer_username', v_case.buyer_username,
            'ebay_return_id', v_case.ebay_return_id,
            'return_status', v_case.status
          )
        )
        returning * into v_task;

        v_count := v_count + 1;
        insert into public.ebay_return_task_events (
          task_id,
          return_case_id,
          action,
          new_status,
          notes,
          signed_by,
          signed_by_email,
          payload
        )
        values (
          v_task.id,
          v_case.id,
          'created',
          v_task.status,
          'Review task opened after return intake.',
          auth.uid(),
          v_signed_email,
          v_task.metadata
        );
      end if;
    end if;
  end loop;

  return v_count;
end;
$$;

revoke all on function public.open_ebay_return_case(uuid, uuid[], text, text, text, text, text, jsonb, text) from public;
revoke all on function public.assign_ebay_return_task(uuid, uuid, text, timestamptz, text, text) from public;
revoke all on function public.create_ebay_return_question_task(uuid, text, uuid, text, timestamptz, text) from public;
revoke all on function public.update_ebay_return_task_status(uuid, text, text, text) from public;
revoke all on function public.sync_ebay_return_tasks_after_intake(uuid[], text, text) from public;

grant execute on function public.open_ebay_return_case(uuid, uuid[], text, text, text, text, text, jsonb, text) to authenticated;
grant execute on function public.assign_ebay_return_task(uuid, uuid, text, timestamptz, text, text) to authenticated;
grant execute on function public.create_ebay_return_question_task(uuid, text, uuid, text, timestamptz, text) to authenticated;
grant execute on function public.update_ebay_return_task_status(uuid, text, text, text) to authenticated;
grant execute on function public.sync_ebay_return_tasks_after_intake(uuid[], text, text) to authenticated;
