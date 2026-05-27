-- Complete task SMS notification workflow.
-- Existing task triggers create rows in task_notifications; this migration keeps
-- that pattern and adds centralized SMS formatting, audit logging, dedupe, and
-- scheduled due/overdue reminder generation.

alter table public.task_notifications
  drop constraint if exists task_notifications_notification_type_check;

alter table public.task_notifications
  add constraint task_notifications_notification_type_check
  check (notification_type in (
    'task_assigned',
    'subtask_assigned',
    'shipment_assigned',
    'packaging_assigned',
    'return_task_assigned',
    'subtask_completed',
    'task_progress_update',
    'task_completed',
    'task_ready_for_review',
    'task_due_tomorrow',
    'task_due_today',
    'task_overdue_assignee',
    'task_overdue_assigner'
  ));

create table if not exists public.task_notification_dedupe (
  dedupe_key text primary key,
  notification_type text not null,
  source text not null,
  task_id uuid not null,
  recipient_user_id uuid,
  created_at timestamptz not null default now()
);

create table if not exists public.task_notification_attempts (
  id uuid primary key default gen_random_uuid(),
  task_notification_id uuid references public.task_notifications(id) on delete set null,
  sms_outbox_id uuid references public.sms_outbox(id) on delete set null,
  dedupe_key text,
  notification_type text not null,
  source text not null,
  task_id uuid,
  event_id uuid,
  recipient_user_id uuid,
  recipient_email text,
  recipient_role text,
  to_phone text,
  status text not null check (status in ('pending', 'sent', 'failed', 'skipped', 'duplicate_prevented')),
  error_message text,
  metadata jsonb not null default '{}'::jsonb,
  attempted_at timestamptz not null default now()
);

create index if not exists task_notification_attempts_task_idx
  on public.task_notification_attempts(source, task_id, notification_type, attempted_at desc);

create index if not exists task_notification_attempts_recipient_idx
  on public.task_notification_attempts(recipient_user_id, attempted_at desc);

alter table public.task_notification_dedupe enable row level security;
alter table public.task_notification_attempts enable row level security;

drop policy if exists "task_notification_attempts_admin_select" on public.task_notification_attempts;
create policy "task_notification_attempts_admin_select"
on public.task_notification_attempts
for select
to authenticated
using (public.is_admin());

grant select on public.task_notification_attempts to authenticated;

create or replace function public.task_notification_display_name(
  _user_id uuid default null,
  _email text default null,
  _fallback text default 'Someone'
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select nullif(btrim(e.display_name), '')
      from public.employees e
      where (_user_id is not null and e.user_id = _user_id)
        or (_email is not null and lower(e.email) = lower(_email))
      order by e.active desc, e.created_at desc
      limit 1
    ),
    nullif(btrim(coalesce(_email, '')), ''),
    _fallback
  );
$$;

create or replace function public.task_notification_status_text(_status text)
returns text
language sql
stable
as $$
  select initcap(replace(coalesce(nullif(btrim(_status), ''), 'open'), '_', ' '))
$$;

create or replace function public.task_notification_time_text(_value timestamptz)
returns text
language sql
stable
as $$
  select case
    when _value is null then ''
    else to_char(_value at time zone 'America/New_York', 'Mon DD, YYYY HH12:MI AM')
  end
$$;

create or replace function public.format_task_sms_message(
  _notification_type text,
  _title text,
  _body text,
  _actor_name text default null,
  _priority text default null,
  _due_at timestamptz default null,
  _status text default null,
  _happened_at timestamptz default now()
)
returns text
language plpgsql
stable
as $$
declare
  v_title text := public.task_notification_brief_text(_title, 'Task', 120);
  v_body text := public.task_notification_brief_text(_body, 'No note provided', 180);
  v_actor text := public.task_notification_brief_text(_actor_name, 'Someone', 80);
  v_priority text := public.task_notification_priority_text(_priority);
  v_due text := public.task_notification_due_text(_due_at);
  v_status text := public.task_notification_status_text(_status);
  v_time text := public.task_notification_time_text(_happened_at);
begin
  return left(regexp_replace(case
    when _notification_type in ('task_assigned', 'subtask_assigned', 'shipment_assigned', 'packaging_assigned', 'return_task_assigned') then
      'You have been assigned a new task: ' || v_title
      || '. Note: ' || v_body
      || '. Assigned by: ' || v_actor
      || '. Urgency: ' || v_priority
      || '. Due: ' || v_due || '.'
    when _notification_type = 'task_progress_update' then
      v_actor || ' posted a progress update on task: ' || v_title
      || '. Update: ' || v_body
      || '. Status: ' || v_status
      || '. Updated: ' || v_time || '.'
    when _notification_type in ('task_completed', 'task_ready_for_review') then
      v_actor || ' marked the task completed: ' || v_title
      || '. Completed at: ' || v_time || '.'
    when _notification_type = 'task_due_tomorrow' then
      'Reminder: task due tomorrow: ' || v_title
      || '. Urgency: ' || v_priority
      || '. Due: ' || v_due
      || '. Status: ' || v_status || '.'
    when _notification_type = 'task_due_today' then
      'Reminder: task due today: ' || v_title
      || '. Urgency: ' || v_priority
      || '. Due: ' || v_due
      || '. Status: ' || v_status || '.'
    when _notification_type = 'task_overdue_assignee' then
      'Overdue task: ' || v_title
      || '. Urgency: ' || v_priority
      || '. Due: ' || v_due
      || '. Status: ' || v_status || '.'
    when _notification_type = 'task_overdue_assigner' then
      'Task overdue: ' || v_title
      || '. Assigned user: ' || v_actor
      || '. Urgency: ' || v_priority
      || '. Due: ' || v_due
      || '. Status: ' || v_status || '.'
    else
      v_title || '. ' || v_body
  end, '\s+', ' ', 'g'), 480);
end;
$$;

create or replace function public.task_notification_dedupe_key(
  _notification_type text,
  _source text,
  _task_id uuid,
  _recipient_user_id uuid,
  _stage text default null,
  _due_at timestamptz default null
)
returns text
language sql
stable
as $$
  select concat_ws(
    ':',
    'task_sms',
    coalesce(_notification_type, 'notification'),
    coalesce(_source, 'task'),
    coalesce(_task_id::text, 'no-task'),
    coalesce(_recipient_user_id::text, 'no-recipient'),
    coalesce(_stage, ''),
    coalesce(extract(epoch from _due_at)::bigint::text, '')
  )
$$;

create or replace function public.enqueue_task_notification_sms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text;
  v_body text;
  v_sms_id uuid;
  v_dedupe_key text;
  v_claimed boolean := false;
  v_actor_name text;
  v_status text;
begin
  if new.notification_type not in (
    'task_assigned',
    'subtask_assigned',
    'shipment_assigned',
    'packaging_assigned',
    'return_task_assigned',
    'task_progress_update',
    'task_completed',
    'task_ready_for_review',
    'task_due_tomorrow',
    'task_due_today',
    'task_overdue_assignee',
    'task_overdue_assigner'
  ) then
    return new;
  end if;

  v_dedupe_key := coalesce(
    nullif(new.metadata->>'dedupe_key', ''),
    public.task_notification_dedupe_key(new.notification_type, new.source, new.task_id, new.recipient_user_id)
  );

  insert into public.task_notification_dedupe (
    dedupe_key,
    notification_type,
    source,
    task_id,
    recipient_user_id
  )
  values (
    v_dedupe_key,
    new.notification_type,
    new.source,
    new.task_id,
    new.recipient_user_id
  )
  on conflict do nothing
  returning true into v_claimed;

  if coalesce(v_claimed, false) is not true then
    insert into public.task_notification_attempts (
      task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, status, error_message, metadata
    )
    values (
      new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, 'duplicate_prevented',
      'Duplicate notification prevented by dedupe key.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_phone := public.get_task_notification_sms_phone(new.recipient_user_id, new.recipient_email);
  if v_phone is null then
    insert into public.task_notification_attempts (
      task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, status, error_message, metadata
    )
    values (
      new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, 'skipped',
      'No valid SMS phone number found for recipient.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_actor_name := coalesce(
    nullif(new.metadata->>'actor_name', ''),
    public.task_notification_display_name(new.actor_user_id, new.actor_email, new.actor_email)
  );
  v_status := coalesce(nullif(new.metadata->>'status', ''), nullif(new.metadata->>'task_status', ''));
  v_body := public.format_task_sms_message(
    new.notification_type,
    new.title,
    new.body,
    v_actor_name,
    new.priority,
    new.due_at,
    v_status,
    new.created_at
  );

  v_sms_id := public.enqueue_sms(
    v_phone,
    v_body,
    now(),
    jsonb_build_object(
      'type', 'task_notification',
      'task_notification_id', new.id,
      'dedupe_key', v_dedupe_key,
      'notification_type', new.notification_type,
      'source', new.source,
      'task_id', new.task_id,
      'recipient_user_id', new.recipient_user_id
    )
  );

  insert into public.task_notification_attempts (
    task_notification_id, sms_outbox_id, dedupe_key, notification_type, source,
    task_id, event_id, recipient_user_id, recipient_email, to_phone, status, metadata
  )
  values (
    new.id, v_sms_id, v_dedupe_key, new.notification_type, new.source,
    new.task_id, new.event_id, new.recipient_user_id, new.recipient_email,
    v_phone, 'pending', coalesce(new.metadata, '{}'::jsonb)
  );

  return new;
end;
$$;

drop trigger if exists trg_enqueue_task_notification_sms on public.task_notifications;
create trigger trg_enqueue_task_notification_sms
after insert on public.task_notifications
for each row
execute function public.enqueue_task_notification_sms();

create or replace function public.create_task_notification_if_new(
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
  _actor_user_id uuid default null,
  _actor_email text default null,
  _dedupe_key text default null
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_dedupe_key text := coalesce(
    nullif(_dedupe_key, ''),
    nullif(_metadata->>'dedupe_key', ''),
    public.task_notification_dedupe_key(_notification_type, _source, _task_id, _recipient_user_id)
  );
  v_id uuid;
begin
  if _recipient_user_id is null then
    insert into public.task_notification_attempts (
      dedupe_key, notification_type, source, task_id, event_id, recipient_email,
      status, error_message, metadata
    )
    values (
      v_dedupe_key, _notification_type, _source, _task_id, _event_id, _recipient_email,
      'skipped', 'Notification skipped because recipient_user_id is null.',
      coalesce(_metadata, '{}'::jsonb)
    );
    return null;
  end if;

  if exists (select 1 from public.task_notification_dedupe where dedupe_key = v_dedupe_key) then
    insert into public.task_notification_attempts (
      dedupe_key, notification_type, source, task_id, event_id, recipient_user_id,
      recipient_email, status, error_message, metadata
    )
    values (
      v_dedupe_key, _notification_type, _source, _task_id, _event_id, _recipient_user_id,
      _recipient_email, 'duplicate_prevented',
      'Duplicate notification prevented before creating task notification.',
      coalesce(_metadata, '{}'::jsonb)
    );
    return null;
  end if;

  v_id := public.create_task_notification(
    _recipient_user_id,
    _recipient_email,
    _source,
    _task_id,
    _parent_task_id,
    _notification_type,
    _title,
    _body,
    _priority,
    _due_at,
    coalesce(_metadata, '{}'::jsonb) || jsonb_build_object('dedupe_key', v_dedupe_key),
    _event_id,
    _actor_user_id,
    _actor_email
  );

  return v_id;
end;
$$;

create or replace function public.task_is_active_for_notifications(_source text, _status text)
returns boolean
language sql
stable
as $$
  select case
    when _source = 'team' then coalesce(_status, '') not in ('resolved', 'cancelled')
    when _source = 'order' then coalesce(_status, '') not in (
      'resolved', 'cancelled', 'completed_by_employee', 'approved_by_admin',
      'approved_for_shipping', 'shipped_completed', 'closed'
    )
    when _source = 'return' then coalesce(_status, '') not in ('resolved', 'cancelled')
    else false
  end
$$;

create or replace function public.enqueue_task_due_reminders(_now timestamptz default now())
returns table(stage text, notifications_created integer, duplicates_prevented integer, skipped integer)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_now timestamptz := coalesce(_now, now());
  v_today date := (coalesce(_now, now()) at time zone 'America/New_York')::date;
  v_task record;
  v_stage text;
  v_type text;
  v_recipient_user_id uuid;
  v_recipient_email text;
  v_recipient_role text;
  v_actor_user_id uuid;
  v_actor_email text;
  v_actor_name text;
  v_dedupe_key text;
  v_id uuid;
  v_created integer := 0;
  v_duplicate integer := 0;
  v_skipped integer := 0;
begin
  create temporary table if not exists pg_temp.task_due_reminder_counts (
    stage text primary key,
    notifications_created integer not null default 0,
    duplicates_prevented integer not null default 0,
    skipped integer not null default 0
  ) on commit drop;
  truncate table pg_temp.task_due_reminder_counts;

  for v_task in
    select 'team'::text as source, id, null::uuid as parent_task_id, title,
      coalesce(description, latest_note, title) as note, status, priority, due_at,
      assigned_to_user_id, assigned_to_email, coalesce(created_by, assigned_by) as owner_user_id,
      coalesce(created_by_email, assigned_by_email) as owner_email, assigned_by, assigned_by_email
    from public.team_tasks
    where due_at is not null and assigned_to_user_id is not null
      and public.task_is_active_for_notifications('team', status)
    union all
    select 'order'::text as source, id, parent_task_id, title,
      coalesce(question, latest_note, title) as note, status, priority, due_at,
      assigned_to_user_id, assigned_to_email, coalesce(created_by, assigned_by) as owner_user_id,
      coalesce(created_by_email, assigned_by_email) as owner_email, assigned_by, assigned_by_email
    from public.ebay_order_tasks
    where due_at is not null and assigned_to_user_id is not null
      and public.task_is_active_for_notifications('order', status)
    union all
    select 'return'::text as source, id, null::uuid as parent_task_id, title,
      coalesce(question, resolution_notes, title) as note, status, priority, due_at,
      assigned_to_user_id, assigned_to_email, coalesce(created_by, assigned_by) as owner_user_id,
      coalesce(created_by_email, assigned_by_email) as owner_email, assigned_by, assigned_by_email
    from public.ebay_return_tasks
    where due_at is not null and assigned_to_user_id is not null
      and public.task_is_active_for_notifications('return', status)
  loop
    for v_stage, v_type, v_recipient_user_id, v_recipient_email, v_recipient_role, v_actor_user_id, v_actor_email, v_actor_name in
      select 'due_tomorrow', 'task_due_tomorrow', v_task.assigned_to_user_id, v_task.assigned_to_email,
        'assignee', v_task.owner_user_id, v_task.owner_email,
        public.task_notification_display_name(v_task.owner_user_id, v_task.owner_email, 'Task owner')
      where (v_task.due_at at time zone 'America/New_York')::date = v_today + 1

      union all

      select 'due_today', 'task_due_today', v_task.assigned_to_user_id, v_task.assigned_to_email,
        'assignee', v_task.owner_user_id, v_task.owner_email,
        public.task_notification_display_name(v_task.owner_user_id, v_task.owner_email, 'Task owner')
      where (v_task.due_at at time zone 'America/New_York')::date = v_today

      union all

      select 'overdue_assignee', 'task_overdue_assignee', v_task.assigned_to_user_id, v_task.assigned_to_email,
        'assignee', v_task.owner_user_id, v_task.owner_email,
        public.task_notification_display_name(v_task.owner_user_id, v_task.owner_email, 'Task owner')
      where v_task.due_at < v_now

      union all

      select 'overdue_assigner', 'task_overdue_assigner', v_task.owner_user_id, v_task.owner_email,
        'assigner', v_task.assigned_to_user_id, v_task.assigned_to_email,
        public.task_notification_display_name(v_task.assigned_to_user_id, v_task.assigned_to_email, 'Assigned user')
      where v_task.due_at < v_now and v_task.owner_user_id is not null
    loop
      v_dedupe_key := public.task_notification_dedupe_key(
        v_type,
        v_task.source,
        v_task.id,
        v_recipient_user_id,
        v_stage,
        v_task.due_at
      );

      v_id := public.create_task_notification_if_new(
        v_recipient_user_id,
        v_recipient_email,
        v_task.source,
        v_task.id,
        v_task.parent_task_id,
        v_type,
        case
          when v_type = 'task_due_tomorrow' then 'Task due tomorrow: '
          when v_type = 'task_due_today' then 'Task due today: '
          when v_type = 'task_overdue_assigner' then 'Task overdue: '
          else 'Overdue task: '
        end || coalesce(v_task.title, 'Task'),
        case
          when v_type = 'task_overdue_assigner' then
            'Assigned user: ' || public.task_notification_display_name(v_task.assigned_to_user_id, v_task.assigned_to_email, 'Assigned user')
          else
            'Reminder for assigned task.'
        end,
        v_task.priority,
        v_task.due_at,
        jsonb_build_object(
          'dedupe_key', v_dedupe_key,
          'reminder_stage', v_stage,
          'status', v_task.status,
          'recipient_role', v_recipient_role,
          'actor_name', v_actor_name,
          'assigned_to_email', v_task.assigned_to_email,
          'owner_email', v_task.owner_email
        ),
        null,
        v_actor_user_id,
        v_actor_email,
        v_dedupe_key
      );

      if v_id is null then
        if v_recipient_user_id is null then
          v_skipped := 1;
          v_duplicate := 0;
        else
          v_skipped := 0;
          v_duplicate := 1;
        end if;
        v_created := 0;
      else
        v_created := 1;
        v_duplicate := 0;
        v_skipped := 0;
      end if;

      insert into pg_temp.task_due_reminder_counts(stage, notifications_created, duplicates_prevented, skipped)
      values (v_stage, v_created, v_duplicate, v_skipped)
      on conflict (stage) do update
      set notifications_created = task_due_reminder_counts.notifications_created + excluded.notifications_created,
          duplicates_prevented = task_due_reminder_counts.duplicates_prevented + excluded.duplicates_prevented,
          skipped = task_due_reminder_counts.skipped + excluded.skipped;
    end loop;
  end loop;

  return query
  select c.stage, c.notifications_created, c.duplicates_prevented, c.skipped
  from pg_temp.task_due_reminder_counts c
  order by c.stage;
end;
$$;

grant execute on function public.enqueue_task_due_reminders(timestamptz) to authenticated, service_role;
grant execute on function public.format_task_sms_message(text, text, text, text, text, timestamptz, text, timestamptz) to authenticated, service_role;
