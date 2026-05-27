-- Queue SMS messages for task assignments and completion handoffs.
-- The actual Twilio send path already consumes public.sms_outbox.

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
    'task_ready_for_review'
  ));

create unique index if not exists sms_outbox_task_notification_once_idx
on public.sms_outbox ((meta->>'task_notification_id'))
where meta ? 'task_notification_id';

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
      nullif(regexp_replace(coalesce(_value, ''), '\s+', ' ', 'g'), ''),
      nullif(regexp_replace(coalesce(_fallback, ''), '\s+', ' ', 'g'), ''),
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

    select ep.phone_e164, 3 as priority
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

drop trigger if exists trg_enqueue_task_notification_sms on public.task_notifications;
create trigger trg_enqueue_task_notification_sms
after insert on public.task_notifications
for each row
execute function public.enqueue_task_notification_sms();

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
      'Details: ' || public.task_notification_brief_text(coalesce(new.description, new.latest_note, new.title), new.title, 140)
        || '. Due: ' || public.task_notification_due_text(new.due_at)
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
    'Details: ' || public.task_notification_brief_text(coalesce(new.question, new.latest_note, new.title), new.title, 140)
      || '. Due: ' || public.task_notification_due_text(new.due_at)
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
      'Details: ' || public.task_notification_brief_text(coalesce(new.question, new.title), new.title, 140)
        || '. Due: ' || public.task_notification_due_text(new.due_at)
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

  v_recipient_user_id := coalesce(new.assigned_by, new.created_by);
  v_recipient_email := coalesce(new.assigned_by_email, new.created_by_email);

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

drop trigger if exists trg_notify_team_task_ready_for_review on public.team_tasks;
create trigger trg_notify_team_task_ready_for_review
after update of status on public.team_tasks
for each row
execute function public.notify_team_task_ready_for_review();

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

  v_recipient_user_id := coalesce(new.assigned_by, new.created_by);
  v_recipient_email := coalesce(new.assigned_by_email, new.created_by_email);

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

drop trigger if exists trg_notify_ebay_order_task_ready_for_review on public.ebay_order_tasks;
create trigger trg_notify_ebay_order_task_ready_for_review
after update of status on public.ebay_order_tasks
for each row
execute function public.notify_ebay_order_task_ready_for_review();

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

  v_recipient_user_id := coalesce(new.assigned_by, new.created_by);
  v_recipient_email := coalesce(new.assigned_by_email, new.created_by_email);

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

drop trigger if exists trg_notify_ebay_return_task_ready_for_review on public.ebay_return_tasks;
create trigger trg_notify_ebay_return_task_ready_for_review
after update of status on public.ebay_return_tasks
for each row
execute function public.notify_ebay_return_task_ready_for_review();
