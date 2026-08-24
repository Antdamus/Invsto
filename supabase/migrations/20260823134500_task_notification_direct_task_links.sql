-- Keep task assignment notifications pointed at the unified task page,
-- and include a tappable task link in SMS notifications.

create or replace function public.task_notification_app_path(_source text, _task_id uuid)
returns text
language sql
stable
as $$
  select 'team-tasks.html?taskId=' || coalesce(_task_id::text, '')
$$;

create or replace function public.task_notification_sms_app_base_url()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select nullif(btrim(regexp_replace(coalesce(s.app_base_url, ''), '/+$', '')), '')
      from public.ebay_buyer_message_sms_settings s
      limit 1
    ),
    'https://antdamus.github.io/Invsto'
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
  v_should_sms boolean := false;
  v_open_url text;
  v_link_suffix text;
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
      channel, task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, status, error_message, metadata
    )
    values (
      'sms', new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, 'duplicate_prevented',
      'Duplicate notification prevented by dedupe key.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_phone := public.get_task_notification_sms_phone(new.recipient_user_id, new.recipient_email);
  if v_phone is null then
    insert into public.task_notification_attempts (
      channel, task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, status, error_message, metadata
    )
    values (
      'sms', new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, 'skipped',
      'No valid SMS phone number found for recipient.',
      coalesce(new.metadata, '{}'::jsonb)
    );
    return new;
  end if;

  v_should_sms := public.task_notification_should_sms(
    new.notification_type,
    new.recipient_user_id,
    new.recipient_email,
    new.priority
  );

  if v_should_sms is not true then
    insert into public.task_notification_attempts (
      channel, task_notification_id, dedupe_key, notification_type, source, task_id,
      event_id, recipient_user_id, recipient_email, to_phone, status, error_message, metadata
    )
    values (
      'sms', new.id, v_dedupe_key, new.notification_type, new.source, new.task_id,
      new.event_id, new.recipient_user_id, new.recipient_email, v_phone, 'skipped',
      'SMS delivery skipped by recipient notification preferences.',
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
  v_open_url := public.task_notification_sms_app_base_url()
    || '/'
    || public.task_notification_app_path(new.source, new.task_id);
  v_link_suffix := ' Open: ' || v_open_url;

  if v_open_url is not null and length(v_link_suffix) < 430 then
    v_body := left(regexp_replace(v_body, '\s+', ' ', 'g'), greatest(80, 480 - length(v_link_suffix)))
      || v_link_suffix;
  end if;

  v_body := left(regexp_replace(v_body, '\s+', ' ', 'g'), 480);

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
      'recipient_user_id', new.recipient_user_id,
      'app_path', public.task_notification_app_path(new.source, new.task_id),
      'open_url', v_open_url
    )
  );

  insert into public.task_notification_attempts (
    channel, task_notification_id, sms_outbox_id, dedupe_key, notification_type, source,
    task_id, event_id, recipient_user_id, recipient_email, to_phone, status, metadata
  )
  values (
    'sms', new.id, v_sms_id, v_dedupe_key, new.notification_type, new.source,
    new.task_id, new.event_id, new.recipient_user_id, new.recipient_email,
    v_phone, 'pending', coalesce(new.metadata, '{}'::jsonb) || jsonb_build_object(
      'app_path', public.task_notification_app_path(new.source, new.task_id),
      'open_url', v_open_url
    )
  );

  return new;
end;
$$;

grant execute on function public.task_notification_sms_app_base_url() to authenticated, service_role;

comment on function public.task_notification_app_path(text, uuid)
  is 'Returns the unified task-page path for direct task notification links.';

comment on function public.task_notification_sms_app_base_url()
  is 'Base URL used when task SMS notifications need a tappable task link.';
