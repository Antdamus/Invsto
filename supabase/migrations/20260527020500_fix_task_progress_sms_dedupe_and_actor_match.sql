-- Progress updates are repeatable events. The previous SMS dedupe fallback was
-- task/type/recipient scoped, which could suppress later progress texts on the
-- same task. Use the event/notification id for event-style notifications and
-- avoid over-strict assignee matching in progress triggers.

create or replace function public.task_notification_default_dedupe_key(
  _notification_id uuid,
  _notification_type text,
  _source text,
  _task_id uuid,
  _recipient_user_id uuid,
  _event_id uuid,
  _due_at timestamptz default null
)
returns text
language sql
stable
as $$
  select public.task_notification_dedupe_key(
    _notification_type,
    _source,
    _task_id,
    _recipient_user_id,
    case
      when _notification_type in ('task_progress_update', 'task_completed', 'task_ready_for_review')
        then coalesce(_event_id::text, _notification_id::text)
      else null
    end,
    case
      when _notification_type in ('task_due_tomorrow', 'task_due_today', 'task_overdue_assignee', 'task_overdue_assigner')
        then _due_at
      else null
    end
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
    public.task_notification_default_dedupe_key(
      new.id,
      new.notification_type,
      new.source,
      new.task_id,
      new.recipient_user_id,
      new.event_id,
      new.due_at
    )
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

  v_recipient_user_id := coalesce(v_task.assigned_by, v_task.created_by);
  v_recipient_email := coalesce(v_task.assigned_by_email, v_task.created_by_email);

  if v_recipient_user_id is null then
    return new;
  end if;

  if (new.signed_by is not null and new.signed_by = v_recipient_user_id)
    or (
      nullif(btrim(coalesce(new.signed_by_email, '')), '') is not null
      and lower(new.signed_by_email) = lower(coalesce(v_recipient_email, ''))
    )
  then
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
    coalesce(new.notes, v_task.latest_note, v_task.description, v_task.title, 'Progress update'),
    v_task.priority,
    v_task.due_at,
    coalesce(v_task.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', v_task.task_type,
      'status', v_status,
      'worker_email', v_task.assigned_to_email,
      'event_action', new.action,
      'actor_name', public.task_notification_display_name(new.signed_by, new.signed_by_email, new.signed_by_email)
    ),
    new.id,
    new.signed_by,
    new.signed_by_email
  );

  return new;
end;
$$;

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

  v_recipient_user_id := coalesce(v_task.assigned_by, v_task.created_by);
  v_recipient_email := coalesce(v_task.assigned_by_email, v_task.created_by_email);

  if v_recipient_user_id is null then
    return new;
  end if;

  if (new.signed_by is not null and new.signed_by = v_recipient_user_id)
    or (
      nullif(btrim(coalesce(new.signed_by_email, '')), '') is not null
      and lower(new.signed_by_email) = lower(coalesce(v_recipient_email, ''))
    )
  then
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
    coalesce(new.notes, v_task.latest_note, v_task.question, v_task.title, 'Progress update'),
    v_task.priority,
    v_task.due_at,
    coalesce(v_task.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', v_task.task_type,
      'status', v_status,
      'order_id', v_task.order_id,
      'order_line_ids', coalesce(to_jsonb(v_task.order_line_ids), '[]'::jsonb),
      'worker_email', v_task.assigned_to_email,
      'event_action', new.action,
      'actor_name', public.task_notification_display_name(new.signed_by, new.signed_by_email, new.signed_by_email)
    ),
    new.id,
    new.signed_by,
    new.signed_by_email
  );

  return new;
end;
$$;

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

  v_recipient_user_id := coalesce(v_task.assigned_by, v_task.created_by);
  v_recipient_email := coalesce(v_task.assigned_by_email, v_task.created_by_email);

  if v_recipient_user_id is null then
    return new;
  end if;

  if (new.signed_by is not null and new.signed_by = v_recipient_user_id)
    or (
      nullif(btrim(coalesce(new.signed_by_email, '')), '') is not null
      and lower(new.signed_by_email) = lower(coalesce(v_recipient_email, ''))
    )
  then
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
    coalesce(new.notes, v_task.resolution_notes, v_task.question, v_task.title, 'Progress update'),
    v_task.priority,
    v_task.due_at,
    coalesce(v_task.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', v_task.task_type,
      'status', v_status,
      'return_case_id', v_task.return_case_id,
      'worker_email', v_task.assigned_to_email,
      'event_action', new.action,
      'actor_name', public.task_notification_display_name(new.signed_by, new.signed_by_email, new.signed_by_email)
    ),
    new.id,
    new.signed_by,
    new.signed_by_email
  );

  return new;
end;
$$;
