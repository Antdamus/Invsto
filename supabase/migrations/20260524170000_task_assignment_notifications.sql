-- Persistent in-app task notifications for assignments, added subtasks,
-- and completed pending-order subtasks that need admin review.

create table if not exists public.task_notifications (
  id uuid primary key default gen_random_uuid(),
  recipient_user_id uuid not null references auth.users(id) on delete cascade,
  recipient_email text,
  actor_user_id uuid references auth.users(id) on delete set null,
  actor_email text,
  source text not null check (source in ('team', 'order', 'return')),
  task_id uuid not null,
  parent_task_id uuid,
  event_id uuid,
  notification_type text not null check (notification_type in (
    'task_assigned',
    'subtask_assigned',
    'shipment_assigned',
    'packaging_assigned',
    'return_task_assigned',
    'subtask_completed'
  )),
  title text not null,
  body text not null default '',
  priority text,
  due_at timestamptz,
  read_at timestamptz,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

alter table public.task_notifications enable row level security;

create index if not exists task_notifications_recipient_created_idx
  on public.task_notifications(recipient_user_id, created_at desc);

create index if not exists task_notifications_unread_idx
  on public.task_notifications(recipient_user_id, created_at desc)
  where read_at is null;

drop policy if exists "task_notifications_visible_to_recipient_or_admin"
on public.task_notifications;

create policy "task_notifications_visible_to_recipient_or_admin"
on public.task_notifications
for select
to authenticated
using (recipient_user_id = auth.uid() or public.is_admin());

drop policy if exists "task_notifications_recipient_mark_read"
on public.task_notifications;

create policy "task_notifications_recipient_mark_read"
on public.task_notifications
for update
to authenticated
using (recipient_user_id = auth.uid() or public.is_admin())
with check (recipient_user_id = auth.uid() or public.is_admin());

grant select, update on public.task_notifications to authenticated;

create or replace function public.task_notification_due_text(_due_at timestamptz)
returns text
language sql
stable
as $$
  select case
    when _due_at is null then 'No due date'
    else to_char(_due_at at time zone 'America/New_York', 'Mon DD, YYYY HH12:MI AM')
  end
$$;

create or replace function public.task_notification_priority_text(_priority text)
returns text
language sql
stable
as $$
  select initcap(coalesce(nullif(btrim(_priority), ''), 'normal'))
$$;

create or replace function public.create_task_notification(
  _recipient_user_id uuid,
  _recipient_email text,
  _source text,
  _task_id uuid,
  _parent_task_id uuid,
  _notification_type text,
  _title text,
  _body text,
  _priority text default null,
  _due_at timestamptz default null,
  _metadata jsonb default '{}'::jsonb,
  _event_id uuid default null,
  _actor_user_id uuid default auth.uid(),
  _actor_email text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if _recipient_user_id is null then
    return null;
  end if;

  insert into public.task_notifications (
    recipient_user_id,
    recipient_email,
    actor_user_id,
    actor_email,
    source,
    task_id,
    parent_task_id,
    event_id,
    notification_type,
    title,
    body,
    priority,
    due_at,
    metadata
  )
  values (
    _recipient_user_id,
    nullif(btrim(coalesce(_recipient_email, '')), ''),
    _actor_user_id,
    nullif(btrim(coalesce(_actor_email, '')), ''),
    _source,
    _task_id,
    _parent_task_id,
    _event_id,
    _notification_type,
    nullif(btrim(coalesce(_title, '')), ''),
    coalesce(_body, ''),
    nullif(btrim(coalesce(_priority, '')), ''),
    _due_at,
    coalesce(_metadata, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.notify_team_task_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.assigned_to_user_id is null then
    return new;
  end if;

  if tg_op = 'INSERT'
    or (tg_op = 'UPDATE' and old.assigned_to_user_id is distinct from new.assigned_to_user_id)
  then
    perform public.create_task_notification(
      new.assigned_to_user_id,
      new.assigned_to_email,
      'team',
      new.id,
      null,
      'task_assigned',
      'New task assigned: ' || coalesce(new.title, 'Team task'),
      'Due: ' || public.task_notification_due_text(new.due_at)
        || '. Urgency: ' || public.task_notification_priority_text(new.priority) || '.',
      new.priority,
      new.due_at,
      jsonb_build_object(
        'task_type', new.task_type,
        'status', new.status,
        'assigned_by_email', new.assigned_by_email
      ),
      null,
      coalesce(new.assigned_by, auth.uid()),
      new.assigned_by_email
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_team_task_assignment on public.team_tasks;
create trigger trg_notify_team_task_assignment
after insert or update of assigned_to_user_id on public.team_tasks
for each row
execute function public.notify_team_task_assignment();

create or replace function public.notify_ebay_order_task_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_type text;
  v_title text;
begin
  if new.assigned_to_user_id is null then
    return new;
  end if;

  if not (tg_op = 'INSERT'
    or (tg_op = 'UPDATE' and old.assigned_to_user_id is distinct from new.assigned_to_user_id))
  then
    return new;
  end if;

  v_type := case
    when new.task_type = 'pending_subtask' then 'subtask_assigned'
    when new.task_type = 'pending_shipping' then 'shipment_assigned'
    when new.task_type = 'pending_packaging' then 'packaging_assigned'
    else 'task_assigned'
  end;

  v_title := case
    when new.task_type = 'pending_subtask' then 'New pending-order subtask: '
    when new.task_type = 'pending_shipping' then 'Shipment task assigned: '
    when new.task_type = 'pending_packaging' then 'Packaging task assigned: '
    else 'Pending-order task assigned: '
  end || coalesce(new.title, 'Pending order task');

  perform public.create_task_notification(
    new.assigned_to_user_id,
    new.assigned_to_email,
    'order',
    new.id,
    new.parent_task_id,
    v_type,
    v_title,
    'Due: ' || public.task_notification_due_text(new.due_at)
      || '. Urgency: ' || public.task_notification_priority_text(new.priority) || '.',
    new.priority,
    new.due_at,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', new.task_type,
      'status', new.status,
      'order_id', new.order_id,
      'order_line_ids', coalesce(to_jsonb(new.order_line_ids), '[]'::jsonb),
      'assigned_by_email', new.assigned_by_email
    ),
    null,
    coalesce(new.assigned_by, auth.uid()),
    new.assigned_by_email
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_ebay_order_task_assignment on public.ebay_order_tasks;
create trigger trg_notify_ebay_order_task_assignment
after insert or update of assigned_to_user_id on public.ebay_order_tasks
for each row
execute function public.notify_ebay_order_task_assignment();

create or replace function public.notify_admins_ebay_subtask_completed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_admin record;
begin
  if new.task_type <> 'pending_subtask'
    or new.status <> 'completed_by_employee'
    or old.status is not distinct from new.status
  then
    return new;
  end if;

  for v_admin in
    select e.user_id, e.email
    from public.employees e
    where e.active is true
      and e.user_id is not null
      and lower(coalesce(e.role, '')) = 'admin'
  loop
    perform public.create_task_notification(
      v_admin.user_id,
      v_admin.email,
      'order',
      new.id,
      new.parent_task_id,
      'subtask_completed',
      'Subtask completed for admin review: ' || coalesce(new.title, 'Pending-order subtask'),
      coalesce(new.assigned_to_email, 'A worker') || ' completed a subtask. '
        || 'Due: ' || public.task_notification_due_text(new.due_at)
        || '. Urgency: ' || public.task_notification_priority_text(new.priority) || '.',
      new.priority,
      new.due_at,
      coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
        'task_type', new.task_type,
        'status', new.status,
        'order_id', new.order_id,
        'worker_email', new.assigned_to_email
      ),
      null,
      coalesce(new.resolved_by, auth.uid()),
      new.resolved_by_email
    );
  end loop;

  return new;
end;
$$;

drop trigger if exists trg_notify_admins_ebay_subtask_completed on public.ebay_order_tasks;
create trigger trg_notify_admins_ebay_subtask_completed
after update of status on public.ebay_order_tasks
for each row
execute function public.notify_admins_ebay_subtask_completed();

create or replace function public.notify_ebay_return_task_assignment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.assigned_to_user_id is null then
    return new;
  end if;

  if tg_op = 'INSERT'
    or (tg_op = 'UPDATE' and old.assigned_to_user_id is distinct from new.assigned_to_user_id)
  then
    perform public.create_task_notification(
      new.assigned_to_user_id,
      new.assigned_to_email,
      'return',
      new.id,
      null,
      'return_task_assigned',
      'Return task assigned: ' || coalesce(new.title, 'eBay return task'),
      'Due: ' || public.task_notification_due_text(new.due_at)
        || '. Urgency: ' || public.task_notification_priority_text(new.priority) || '.',
      new.priority,
      new.due_at,
      coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
        'task_type', new.task_type,
        'status', new.status,
        'return_case_id', new.return_case_id,
        'assigned_by_email', new.assigned_by_email
      ),
      null,
      coalesce(new.assigned_by, auth.uid()),
      new.assigned_by_email
    );
  end if;

  return new;
end;
$$;

drop trigger if exists trg_notify_ebay_return_task_assignment on public.ebay_return_tasks;
create trigger trg_notify_ebay_return_task_assignment
after insert or update of assigned_to_user_id on public.ebay_return_tasks
for each row
execute function public.notify_ebay_return_task_assignment();

do $$
begin
  alter publication supabase_realtime add table public.task_notifications;
exception
  when duplicate_object then null;
  when undefined_object then null;
end $$;
