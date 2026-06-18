-- Read model for eBay conversation task badges and audit timeline.
-- New migration on purpose: Supabase will not replay edited prior migrations.

create index if not exists team_tasks_ebay_conversation_message_lookup_idx
  on public.team_tasks ((metadata ->> 'conversation_id'), status, created_at desc)
  where metadata ->> 'source' = 'ebay_conversation_message';

create or replace function public.list_ebay_conversation_message_task_status(
  _conversation_ids uuid[] default null
)
returns table (
  conversation_id uuid,
  task_id uuid,
  message_id uuid,
  title text,
  description text,
  status text,
  priority text,
  assigned_to_user_id uuid,
  assigned_to_email text,
  assigned_to_role text,
  assigned_to_display_name text,
  assigned_by_email text,
  created_by_email text,
  created_at timestamptz,
  updated_at timestamptz,
  due_at timestamptz,
  resolved_at timestamptz,
  latest_note text,
  task_tag text,
  refund_amount numeric,
  conversation_link text,
  message_preview text,
  events jsonb
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  with requested_conversations as (
    select distinct requested.conversation_id
    from unnest(coalesce(_conversation_ids, '{}'::uuid[])) as requested(conversation_id)
    where requested.conversation_id is not null
  ),
  task_rows as (
    select
      t.*,
      case
        when coalesce(t.metadata ->> 'conversation_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (t.metadata ->> 'conversation_id')::uuid
        else null
      end as metadata_conversation_id,
      case
        when coalesce(t.metadata ->> 'message_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (t.metadata ->> 'message_id')::uuid
        else null
      end as metadata_message_id
    from public.team_tasks t
    where public.can_manage_inventory()
      and t.metadata ->> 'source' = 'ebay_conversation_message'
      and t.metadata ->> 'history_removed_at' is null
  )
  select
    tr.metadata_conversation_id as conversation_id,
    tr.id as task_id,
    tr.metadata_message_id as message_id,
    tr.title,
    tr.description,
    tr.status,
    tr.priority,
    tr.assigned_to_user_id,
    coalesce(tr.assigned_to_email, assigned_employee.email) as assigned_to_email,
    coalesce(tr.assigned_to_role, assigned_employee.role) as assigned_to_role,
    assigned_employee.display_name as assigned_to_display_name,
    tr.assigned_by_email,
    tr.created_by_email,
    tr.created_at,
    tr.updated_at,
    tr.due_at,
    tr.resolved_at,
    tr.latest_note,
    nullif(tr.metadata ->> 'task_tag', '') as task_tag,
    case
      when coalesce(tr.metadata ->> 'refund_amount', '') ~ '^-?[0-9]+(\.[0-9]+)?$'
        then (tr.metadata ->> 'refund_amount')::numeric
      else null
    end as refund_amount,
    nullif(tr.metadata ->> 'conversation_link', '') as conversation_link,
    nullif(tr.metadata ->> 'message_preview', '') as message_preview,
    coalesce(event_rows.events, '[]'::jsonb) as events
  from task_rows tr
  left join lateral (
    select e.display_name, e.email, e.role
    from public.employees e
    where e.user_id = tr.assigned_to_user_id
       or e.id = tr.assigned_to_employee_id
    order by case when e.user_id = tr.assigned_to_user_id then 0 else 1 end
    limit 1
  ) assigned_employee on true
  left join lateral (
    select jsonb_agg(
      jsonb_strip_nulls(jsonb_build_object(
        'id', e.id,
        'action', e.action,
        'old_status', e.old_status,
        'new_status', e.new_status,
        'old_assigned_to_user_id', e.old_assigned_to_user_id,
        'new_assigned_to_user_id', e.new_assigned_to_user_id,
        'old_assigned_to_email', old_assignee.email,
        'old_assigned_to_display_name', old_assignee.display_name,
        'new_assigned_to_email', new_assignee.email,
        'new_assigned_to_display_name', new_assignee.display_name,
        'notes', e.notes,
        'signed_by', e.signed_by,
        'signed_by_email', coalesce(e.signed_by_email, actor.email),
        'signed_by_display_name', actor.display_name,
        'created_at', e.created_at,
        'payload', e.payload
      ))
      order by e.created_at desc
    ) as events
    from public.team_task_events e
    left join lateral (
      select emp.display_name, emp.email
      from public.employees emp
      where emp.user_id = e.signed_by
      limit 1
    ) actor on true
    left join lateral (
      select emp.display_name, emp.email
      from public.employees emp
      where emp.user_id = e.old_assigned_to_user_id
      limit 1
    ) old_assignee on true
    left join lateral (
      select emp.display_name, emp.email
      from public.employees emp
      where emp.user_id = e.new_assigned_to_user_id
      limit 1
    ) new_assignee on true
    where e.task_id = tr.id
  ) event_rows on true
  where tr.metadata_conversation_id is not null
    and (
      not exists (select 1 from requested_conversations)
      or tr.metadata_conversation_id in (select conversation_id from requested_conversations)
    )
  order by
    case when tr.status in ('resolved', 'cancelled') then 1 else 0 end,
    tr.created_at desc;
$$;

revoke all on function public.list_ebay_conversation_message_task_status(uuid[]) from public;
grant execute on function public.list_ebay_conversation_message_task_status(uuid[]) to authenticated;

comment on function public.list_ebay_conversation_message_task_status(uuid[])
  is 'Returns eBay-conversation-linked team tasks with status, assignment, and event history for preview badges and audit modals.';
