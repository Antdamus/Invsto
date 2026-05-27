-- Notify the task owner/creator when an assigned worker posts progress.
-- The SMS trigger below queues through the existing sms_outbox dispatcher.

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
    'task_ready_for_review'
  ));

create or replace function public.task_notification_brief_text(
  _value text,
  _fallback text default 'Task',
  _max_length integer default 140
)
returns text
language sql
stable
as $$
  select case
    when length(v.clean_text) <= greatest(coalesce(_max_length, 140), 20)
      then v.clean_text
    else left(v.clean_text, greatest(coalesce(_max_length, 140), 20) - 3) || '...'
  end
  from (
    select coalesce(
      nullif(btrim(regexp_replace(coalesce(_value, ''), '\s+', ' ', 'g')), ''),
      nullif(btrim(regexp_replace(coalesce(_fallback, ''), '\s+', ' ', 'g')), ''),
      'Task'
    ) as clean_text
  ) v;
$$;

create or replace function public.get_task_notification_sms_phone(
  _user_id uuid,
  _email text default null
)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with candidates as (
    select up.phone_e164, 1 as priority
    from public.user_phones up
    where up.user_id = _user_id
      and up.can_sms is true
      and up.phone_e164 ~ '^\+\d{7,15}$'

    union all

    select ep.phone_e164, 2 as priority
    from public.employees e
    join public.employee_phones ep on ep.employee_id = e.id
    where e.user_id = _user_id
      and e.active is true
      and ep.can_sms is true
      and ep.phone_e164 ~ '^\+\d{7,15}$'

    union all

    select up.phone_e164, 3 as priority
    from public.employees e
    join public.user_phones up on up.user_id = e.user_id
    where _email is not null
      and lower(e.email) = lower(_email)
      and e.active is true
      and up.can_sms is true
      and up.phone_e164 ~ '^\+\d{7,15}$'

    union all

    select ep.phone_e164, 4 as priority
    from public.employees e
    join public.employee_phones ep on ep.employee_id = e.id
    where _email is not null
      and lower(e.email) = lower(_email)
      and e.active is true
      and ep.can_sms is true
      and ep.phone_e164 ~ '^\+\d{7,15}$'
  )
  select phone_e164
  from candidates
  order by priority
  limit 1;
$$;

create or replace function public.enqueue_task_notification_sms()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_phone text;
  v_title text;
  v_body text;
  v_due text;
begin
  if new.notification_type not in (
    'task_assigned',
    'subtask_assigned',
    'shipment_assigned',
    'packaging_assigned',
    'return_task_assigned',
    'task_progress_update',
    'task_ready_for_review'
  ) then
    return new;
  end if;

  v_phone := public.get_task_notification_sms_phone(new.recipient_user_id, new.recipient_email);
  if v_phone is null then
    return new;
  end if;

  v_title := public.task_notification_brief_text(new.title, 'Task', 140);
  v_due := public.task_notification_due_text(new.due_at);

  v_body := case
    when new.notification_type = 'task_ready_for_review' then
      'OG: Task completed and ready for review. '
      || v_title
      || '. '
      || public.task_notification_brief_text(new.body, 'Due: ' || v_due, 220)
    when new.notification_type = 'task_progress_update' then
      'OG: Task progress update. '
      || v_title
      || '. '
      || public.task_notification_brief_text(new.body, 'Due: ' || v_due, 220)
    else
      'OG: Task assigned. '
      || v_title
      || '. '
      || public.task_notification_brief_text(new.body, 'Due: ' || v_due, 220)
  end;

  perform public.enqueue_sms(
    v_phone,
    left(regexp_replace(v_body, '\s+', ' ', 'g'), 480),
    now(),
    jsonb_build_object(
      'type', 'task_notification',
      'task_notification_id', new.id,
      'notification_type', new.notification_type,
      'source', new.source,
      'task_id', new.task_id,
      'recipient_user_id', new.recipient_user_id
    )
  );

  return new;
end;
$$;

create or replace function public.notify_team_task_progress_to_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.team_tasks;
  v_recipient_user_id uuid;
  v_recipient_email text;
  v_status text;
  v_actor_is_assignee boolean;
begin
  select * into v_task
  from public.team_tasks
  where id = new.task_id;

  if not found or v_task.assigned_to_user_id is null then
    return new;
  end if;

  v_status := coalesce(nullif(new.new_status, ''), v_task.status);

  if new.action not in ('status_changed', 'commented') then
    return new;
  end if;

  if v_status in ('waiting_on_admin', 'resolved', 'cancelled') then
    return new;
  end if;

  v_actor_is_assignee :=
    (new.signed_by is not null and new.signed_by = v_task.assigned_to_user_id)
    or (
      nullif(btrim(coalesce(new.signed_by_email, '')), '') is not null
      and lower(new.signed_by_email) = lower(coalesce(v_task.assigned_to_email, ''))
    );

  if not v_actor_is_assignee then
    return new;
  end if;

  v_recipient_user_id := coalesce(v_task.assigned_by, v_task.created_by);
  v_recipient_email := coalesce(v_task.assigned_by_email, v_task.created_by_email);

  if v_recipient_user_id is null or v_recipient_user_id = v_task.assigned_to_user_id then
    return new;
  end if;

  perform public.create_task_notification(
    v_recipient_user_id,
    v_recipient_email,
    'team',
    v_task.id,
    null,
    'task_progress_update',
    'Task progress update: ' || coalesce(v_task.title, 'Team task'),
    coalesce(v_task.assigned_to_email, 'A worker') || ' updated the task. '
      || 'Status: ' || initcap(replace(coalesce(v_status, 'in_progress'), '_', ' ')) || '. '
      || 'Details: ' || public.task_notification_brief_text(coalesce(new.notes, v_task.latest_note, v_task.description, v_task.title), v_task.title, 160)
      || '. Due: ' || public.task_notification_due_text(v_task.due_at) || '.',
    v_task.priority,
    v_task.due_at,
    coalesce(v_task.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', v_task.task_type,
      'status', v_status,
      'worker_email', v_task.assigned_to_email,
      'event_action', new.action
    ),
    new.id,
    new.signed_by,
    new.signed_by_email
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_team_task_progress_to_owner on public.team_task_events;
create trigger trg_notify_team_task_progress_to_owner
after insert on public.team_task_events
for each row
execute function public.notify_team_task_progress_to_owner();

create or replace function public.notify_ebay_order_task_progress_to_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_order_tasks;
  v_recipient_user_id uuid;
  v_recipient_email text;
  v_status text;
  v_actor_is_assignee boolean;
begin
  select * into v_task
  from public.ebay_order_tasks
  where id = new.task_id;

  if not found or v_task.assigned_to_user_id is null then
    return new;
  end if;

  v_status := coalesce(nullif(new.new_status, ''), v_task.status);

  if new.action not in ('status_changed', 'progress_update', 'commented') then
    return new;
  end if;

  if v_status in (
    'waiting_on_admin',
    'resolved',
    'cancelled',
    'completed_by_employee',
    'approved_by_admin',
    'approved_for_shipping',
    'shipped_completed',
    'closed'
  ) then
    return new;
  end if;

  v_actor_is_assignee :=
    (new.signed_by is not null and new.signed_by = v_task.assigned_to_user_id)
    or (
      nullif(btrim(coalesce(new.signed_by_email, '')), '') is not null
      and lower(new.signed_by_email) = lower(coalesce(v_task.assigned_to_email, ''))
    );

  if not v_actor_is_assignee then
    return new;
  end if;

  v_recipient_user_id := coalesce(v_task.assigned_by, v_task.created_by);
  v_recipient_email := coalesce(v_task.assigned_by_email, v_task.created_by_email);

  if v_recipient_user_id is null or v_recipient_user_id = v_task.assigned_to_user_id then
    return new;
  end if;

  perform public.create_task_notification(
    v_recipient_user_id,
    v_recipient_email,
    'order',
    v_task.id,
    v_task.parent_task_id,
    'task_progress_update',
    'Order task progress: ' || coalesce(v_task.title, 'Pending order task'),
    coalesce(v_task.assigned_to_email, 'A worker') || ' updated the order task. '
      || 'Status: ' || initcap(replace(coalesce(v_status, 'in_progress'), '_', ' ')) || '. '
      || 'Details: ' || public.task_notification_brief_text(coalesce(new.notes, v_task.latest_note, v_task.question, v_task.title), v_task.title, 160)
      || '. Due: ' || public.task_notification_due_text(v_task.due_at) || '.',
    v_task.priority,
    v_task.due_at,
    coalesce(v_task.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', v_task.task_type,
      'status', v_status,
      'order_id', v_task.order_id,
      'order_line_ids', coalesce(to_jsonb(v_task.order_line_ids), '[]'::jsonb),
      'worker_email', v_task.assigned_to_email,
      'event_action', new.action
    ),
    new.id,
    new.signed_by,
    new.signed_by_email
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_ebay_order_task_progress_to_owner on public.ebay_order_task_events;
create trigger trg_notify_ebay_order_task_progress_to_owner
after insert on public.ebay_order_task_events
for each row
execute function public.notify_ebay_order_task_progress_to_owner();

create or replace function public.notify_ebay_return_task_progress_to_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_return_tasks;
  v_recipient_user_id uuid;
  v_recipient_email text;
  v_status text;
  v_actor_is_assignee boolean;
begin
  select * into v_task
  from public.ebay_return_tasks
  where id = new.task_id;

  if not found or v_task.assigned_to_user_id is null then
    return new;
  end if;

  v_status := coalesce(nullif(new.new_status, ''), v_task.status);

  if new.action not in ('status_changed', 'commented') then
    return new;
  end if;

  if v_status in ('resolved', 'cancelled') then
    return new;
  end if;

  v_actor_is_assignee :=
    (new.signed_by is not null and new.signed_by = v_task.assigned_to_user_id)
    or (
      nullif(btrim(coalesce(new.signed_by_email, '')), '') is not null
      and lower(new.signed_by_email) = lower(coalesce(v_task.assigned_to_email, ''))
    );

  if not v_actor_is_assignee then
    return new;
  end if;

  v_recipient_user_id := coalesce(v_task.assigned_by, v_task.created_by);
  v_recipient_email := coalesce(v_task.assigned_by_email, v_task.created_by_email);

  if v_recipient_user_id is null or v_recipient_user_id = v_task.assigned_to_user_id then
    return new;
  end if;

  perform public.create_task_notification(
    v_recipient_user_id,
    v_recipient_email,
    'return',
    v_task.id,
    null,
    'task_progress_update',
    'Return task progress: ' || coalesce(v_task.title, 'eBay return task'),
    coalesce(v_task.assigned_to_email, 'A worker') || ' updated the return task. '
      || 'Status: ' || initcap(replace(coalesce(v_status, 'in_progress'), '_', ' ')) || '. '
      || 'Details: ' || public.task_notification_brief_text(coalesce(new.notes, v_task.resolution_notes, v_task.question, v_task.title), v_task.title, 160)
      || '. Due: ' || public.task_notification_due_text(v_task.due_at) || '.',
    v_task.priority,
    v_task.due_at,
    coalesce(v_task.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', v_task.task_type,
      'status', v_status,
      'return_case_id', v_task.return_case_id,
      'worker_email', v_task.assigned_to_email,
      'event_action', new.action
    ),
    new.id,
    new.signed_by,
    new.signed_by_email
  );

  return new;
end;
$$;

drop trigger if exists trg_notify_ebay_return_task_progress_to_owner on public.ebay_return_task_events;
create trigger trg_notify_ebay_return_task_progress_to_owner
after insert on public.ebay_return_task_events
for each row
execute function public.notify_ebay_return_task_progress_to_owner();

create or replace function public.notify_team_task_ready_for_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipient_user_id uuid;
  v_recipient_email text;
begin
  if old.status is not distinct from new.status
    or new.status not in ('waiting_on_admin', 'resolved')
    or new.assigned_to_user_id is null
  then
    return new;
  end if;

  v_recipient_user_id := coalesce(new.created_by, new.assigned_by);
  v_recipient_email := coalesce(new.created_by_email, new.assigned_by_email);

  if v_recipient_user_id is null or v_recipient_user_id = new.assigned_to_user_id then
    return new;
  end if;

  perform public.create_task_notification(
    v_recipient_user_id,
    v_recipient_email,
    'team',
    new.id,
    null,
    'task_ready_for_review',
    'Task completed for review: ' || coalesce(new.title, 'Team task'),
    coalesce(new.assigned_to_email, 'A worker') || ' completed the task. '
      || 'Details: ' || public.task_notification_brief_text(coalesce(new.latest_note, new.description, new.title), new.title, 140)
      || '. Due: ' || public.task_notification_due_text(new.due_at) || '.',
    new.priority,
    new.due_at,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', new.task_type,
      'status', new.status,
      'worker_email', new.assigned_to_email
    ),
    null,
    coalesce(new.resolved_by, new.assigned_to_user_id, auth.uid()),
    coalesce(new.resolved_by_email, new.assigned_to_email)
  );

  return new;
end;
$$;

create or replace function public.notify_ebay_order_task_ready_for_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipient_user_id uuid;
  v_recipient_email text;
begin
  if old.status is not distinct from new.status
    or new.status not in ('completed_by_employee', 'waiting_on_admin', 'shipped_completed')
    or new.assigned_to_user_id is null
  then
    return new;
  end if;

  v_recipient_user_id := coalesce(new.created_by, new.assigned_by);
  v_recipient_email := coalesce(new.created_by_email, new.assigned_by_email);

  if v_recipient_user_id is null or v_recipient_user_id = new.assigned_to_user_id then
    return new;
  end if;

  perform public.create_task_notification(
    v_recipient_user_id,
    v_recipient_email,
    'order',
    new.id,
    new.parent_task_id,
    'task_ready_for_review',
    'Order task completed for review: ' || coalesce(new.title, 'Pending order task'),
    coalesce(new.assigned_to_email, 'A worker') || ' completed the task. '
      || 'Details: ' || public.task_notification_brief_text(coalesce(new.latest_note, new.question, new.title), new.title, 140)
      || '. Due: ' || public.task_notification_due_text(new.due_at) || '.',
    new.priority,
    new.due_at,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', new.task_type,
      'status', new.status,
      'order_id', new.order_id,
      'worker_email', new.assigned_to_email
    ),
    null,
    coalesce(new.resolved_by, new.assigned_to_user_id, auth.uid()),
    coalesce(new.resolved_by_email, new.assigned_to_email)
  );

  return new;
end;
$$;

create or replace function public.notify_ebay_return_task_ready_for_review()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_recipient_user_id uuid;
  v_recipient_email text;
begin
  if old.status is not distinct from new.status
    or new.status <> 'resolved'
    or new.assigned_to_user_id is null
  then
    return new;
  end if;

  v_recipient_user_id := coalesce(new.created_by, new.assigned_by);
  v_recipient_email := coalesce(new.created_by_email, new.assigned_by_email);

  if v_recipient_user_id is null or v_recipient_user_id = new.assigned_to_user_id then
    return new;
  end if;

  perform public.create_task_notification(
    v_recipient_user_id,
    v_recipient_email,
    'return',
    new.id,
    null,
    'task_ready_for_review',
    'Return task completed for review: ' || coalesce(new.title, 'eBay return task'),
    coalesce(new.assigned_to_email, 'A worker') || ' completed the return task. '
      || 'Details: ' || public.task_notification_brief_text(coalesce(new.resolution_notes, new.question, new.title), new.title, 140)
      || '. Due: ' || public.task_notification_due_text(new.due_at) || '.',
    new.priority,
    new.due_at,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', new.task_type,
      'status', new.status,
      'return_case_id', new.return_case_id,
      'worker_email', new.assigned_to_email
    ),
    null,
    coalesce(new.resolved_by, new.assigned_to_user_id, auth.uid()),
    coalesce(new.resolved_by_email, new.assigned_to_email)
  );

  return new;
end;
$$;
