-- Use the explicit task_completed notification type and mirror SMS delivery
-- status changes back into the task notification attempt audit table.

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
    'task_completed',
    'Task completed: ' || coalesce(new.title, 'Team task'),
    public.task_notification_brief_text(coalesce(new.latest_note, new.description, new.title), new.title, 180),
    new.priority,
    new.due_at,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', new.task_type,
      'status', new.status,
      'worker_email', new.assigned_to_email,
      'actor_name', public.task_notification_display_name(new.assigned_to_user_id, new.assigned_to_email, 'Assigned user')
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
    'task_completed',
    'Order task completed: ' || coalesce(new.title, 'Pending order task'),
    public.task_notification_brief_text(coalesce(new.latest_note, new.question, new.title), new.title, 180),
    new.priority,
    new.due_at,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', new.task_type,
      'status', new.status,
      'order_id', new.order_id,
      'worker_email', new.assigned_to_email,
      'actor_name', public.task_notification_display_name(new.assigned_to_user_id, new.assigned_to_email, 'Assigned user')
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
    'task_completed',
    'Return task completed: ' || coalesce(new.title, 'eBay return task'),
    public.task_notification_brief_text(coalesce(new.resolution_notes, new.question, new.title), new.title, 180),
    new.priority,
    new.due_at,
    coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'task_type', new.task_type,
      'status', new.status,
      'return_case_id', new.return_case_id,
      'worker_email', new.assigned_to_email,
      'actor_name', public.task_notification_display_name(new.assigned_to_user_id, new.assigned_to_email, 'Assigned user')
    ),
    null,
    coalesce(new.resolved_by, new.assigned_to_user_id, auth.uid()),
    coalesce(new.resolved_by_email, new.assigned_to_email)
  );

  return new;
end;
$$;

create or replace function public.sync_task_notification_attempt_from_sms_outbox()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if coalesce(new.meta->>'type', '') <> 'task_notification' then
    return new;
  end if;

  if new.status in ('sent', 'failed') then
    update public.task_notification_attempts
    set status = new.status,
        error_message = case when new.status = 'failed' then new.last_error else error_message end,
        metadata = metadata || jsonb_build_object(
          'sms_status', new.status,
          'sms_attempts', new.attempts,
          'sms_updated_at', now()
        )
    where sms_outbox_id = new.id;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_sync_task_notification_attempt_from_sms_outbox on public.sms_outbox;
create trigger trg_sync_task_notification_attempt_from_sms_outbox
after update of status, last_error on public.sms_outbox
for each row
execute function public.sync_task_notification_attempt_from_sms_outbox();
