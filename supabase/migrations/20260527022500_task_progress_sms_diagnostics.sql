-- Admin diagnostics for the task progress SMS path. These functions do not
-- replace the normal triggers; they make it easy to verify each hop:
-- task -> event -> task_notifications -> task_notification_attempts -> sms_outbox.

create or replace function public.get_task_progress_sms_diagnostics(
  _source text,
  _task_id uuid
)
returns table (
  source text,
  task_id uuid,
  task_title text,
  task_status text,
  assigned_to_user_id uuid,
  assigned_to_email text,
  assigned_by uuid,
  assigned_by_email text,
  assigned_by_phone text,
  latest_progress_event_id uuid,
  latest_progress_event_at timestamptz,
  latest_progress_note text,
  latest_progress_actor_user_id uuid,
  latest_progress_actor_email text,
  latest_notification_id uuid,
  latest_notification_at timestamptz,
  latest_attempt_status text,
  latest_attempt_error text,
  latest_sms_outbox_id uuid,
  latest_sms_status text,
  latest_sms_error text
)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.is_admin() then
    raise exception 'Only admins can inspect task notification diagnostics' using errcode = '42501';
  end if;

  if _source = 'team' then
    return query
    with task_row as (
      select t.id, t.title, t.status, t.assigned_to_user_id, t.assigned_to_email,
        t.assigned_by, t.assigned_by_email
      from public.team_tasks t
      where t.id = _task_id
    ),
    latest_event as (
      select e.id, e.created_at, e.notes, e.signed_by, e.signed_by_email
      from public.team_task_events e
      where e.task_id = _task_id
        and e.action in ('status_changed', 'commented')
        and coalesce(e.new_status, '') not in ('waiting_on_admin', 'resolved', 'cancelled')
      order by e.created_at desc
      limit 1
    ),
    latest_notification as (
      select n.*
      from public.task_notifications n
      where n.source = 'team'
        and n.task_id = _task_id
        and n.notification_type = 'task_progress_update'
      order by n.created_at desc
      limit 1
    ),
    latest_attempt as (
      select a.*
      from public.task_notification_attempts a
      where a.source = 'team'
        and a.task_id = _task_id
        and a.notification_type = 'task_progress_update'
      order by a.attempted_at desc
      limit 1
    )
    select 'team'::text, tr.id, tr.title, tr.status, tr.assigned_to_user_id, tr.assigned_to_email,
      tr.assigned_by, tr.assigned_by_email,
      public.get_task_notification_sms_phone(tr.assigned_by, tr.assigned_by_email),
      le.id, le.created_at, le.notes, le.signed_by, le.signed_by_email,
      ln.id, ln.created_at,
      la.status, la.error_message, la.sms_outbox_id,
      so.status, so.last_error
    from task_row tr
    left join latest_event le on true
    left join latest_notification ln on true
    left join latest_attempt la on true
    left join public.sms_outbox so on so.id = la.sms_outbox_id;

  elsif _source = 'order' then
    return query
    with task_row as (
      select t.id, t.title, t.status, t.assigned_to_user_id, t.assigned_to_email,
        t.assigned_by, t.assigned_by_email
      from public.ebay_order_tasks t
      where t.id = _task_id
    ),
    latest_event as (
      select e.id, e.created_at, e.notes, e.signed_by, e.signed_by_email
      from public.ebay_order_task_events e
      where e.task_id = _task_id
        and e.action in ('status_changed', 'progress_update', 'commented')
        and coalesce(e.new_status, '') not in (
          'waiting_on_admin', 'resolved', 'cancelled', 'completed_by_employee',
          'approved_by_admin', 'approved_for_shipping', 'shipped_completed', 'closed'
        )
      order by e.created_at desc
      limit 1
    ),
    latest_notification as (
      select n.*
      from public.task_notifications n
      where n.source = 'order'
        and n.task_id = _task_id
        and n.notification_type = 'task_progress_update'
      order by n.created_at desc
      limit 1
    ),
    latest_attempt as (
      select a.*
      from public.task_notification_attempts a
      where a.source = 'order'
        and a.task_id = _task_id
        and a.notification_type = 'task_progress_update'
      order by a.attempted_at desc
      limit 1
    )
    select 'order'::text, tr.id, tr.title, tr.status, tr.assigned_to_user_id, tr.assigned_to_email,
      tr.assigned_by, tr.assigned_by_email,
      public.get_task_notification_sms_phone(tr.assigned_by, tr.assigned_by_email),
      le.id, le.created_at, le.notes, le.signed_by, le.signed_by_email,
      ln.id, ln.created_at,
      la.status, la.error_message, la.sms_outbox_id,
      so.status, so.last_error
    from task_row tr
    left join latest_event le on true
    left join latest_notification ln on true
    left join latest_attempt la on true
    left join public.sms_outbox so on so.id = la.sms_outbox_id;

  elsif _source = 'return' then
    return query
    with task_row as (
      select t.id, t.title, t.status, t.assigned_to_user_id, t.assigned_to_email,
        t.assigned_by, t.assigned_by_email
      from public.ebay_return_tasks t
      where t.id = _task_id
    ),
    latest_event as (
      select e.id, e.created_at, e.notes, e.signed_by, e.signed_by_email
      from public.ebay_return_task_events e
      where e.task_id = _task_id
        and e.action in ('status_changed', 'commented')
        and coalesce(e.new_status, '') not in ('resolved', 'cancelled')
      order by e.created_at desc
      limit 1
    ),
    latest_notification as (
      select n.*
      from public.task_notifications n
      where n.source = 'return'
        and n.task_id = _task_id
        and n.notification_type = 'task_progress_update'
      order by n.created_at desc
      limit 1
    ),
    latest_attempt as (
      select a.*
      from public.task_notification_attempts a
      where a.source = 'return'
        and a.task_id = _task_id
        and a.notification_type = 'task_progress_update'
      order by a.attempted_at desc
      limit 1
    )
    select 'return'::text, tr.id, tr.title, tr.status, tr.assigned_to_user_id, tr.assigned_to_email,
      tr.assigned_by, tr.assigned_by_email,
      public.get_task_notification_sms_phone(tr.assigned_by, tr.assigned_by_email),
      le.id, le.created_at, le.notes, le.signed_by, le.signed_by_email,
      ln.id, ln.created_at,
      la.status, la.error_message, la.sms_outbox_id,
      so.status, so.last_error
    from task_row tr
    left join latest_event le on true
    left join latest_notification ln on true
    left join latest_attempt la on true
    left join public.sms_outbox so on so.id = la.sms_outbox_id;
  else
    raise exception 'Unknown task source: %', _source using errcode = '22023';
  end if;
end;
$$;

grant execute on function public.get_task_progress_sms_diagnostics(text, uuid) to authenticated;
