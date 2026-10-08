begin;
set local lock_timeout = '2s';
set local statement_timeout = '60s';

create index if not exists team_tasks_conversation_workspace_idx
 on public.team_tasks ((metadata->>'conversation_id'))
 where metadata->>'source'='ebay_conversation_message' and metadata->>'history_removed_at' is null;
create index if not exists ebay_order_tasks_conversation_workspace_idx
 on public.ebay_order_tasks ((metadata->>'conversation_id'))
 where metadata ? 'conversation_id' and metadata->>'history_removed_at' is null;

-- Load only the requested conversations. Full event histories are needed only
-- when the operator opens updates, not for every row of the inbox.
create function public.list_ebay_conversation_task_workspace(_conversation_ids uuid[], _include_events boolean default false)
returns setof jsonb language sql stable security definer set search_path='' as $$
 with requested as (
  select distinct id::text from unnest(coalesce(_conversation_ids,'{}')) id
 ), tasks as materialized (
  select 'team'::text source,to_jsonb(t) task from public.team_tasks t
   where public.can_access_email_triage() and auth.uid() is not null
    and t.metadata->>'source'='ebay_conversation_message' and t.metadata->>'history_removed_at' is null
    and t.metadata->>'conversation_id' in (select id from requested)
  union all
  select 'order',to_jsonb(t) from public.ebay_order_tasks t
   where public.can_manage_inventory() and auth.uid() is not null
    and t.metadata ? 'conversation_id' and t.metadata->>'history_removed_at' is null
    and t.metadata->>'conversation_id' in (select id from requested)
 ), actions as (
  select *,case
    when task->>'status' in ('resolved','cancelled','approved_by_admin','approved_for_shipping','shipped_completed','closed') then 'history'
    when task->>'status'='waiting_on_subtasks' then 'subtasks'
    when task->>'status' in ('completed_by_employee','pending_admin_review','ready_for_admin_approval')
      or task#>>'{metadata,request_kind}'='decision'
      or (task->>'status'='waiting_on_admin' and task#>>'{metadata,request_kind}' is distinct from 'work') then 'decision'
    else 'work' end action from tasks
 ), owners as (
  select *,case when action='decision' then public.task_workflow_reviewer(task)
    when action='work' then (task->>'assigned_to_user_id')::uuid else null end next_id from actions
 )
 select jsonb_build_object(
  'conversation_id',task#>>'{metadata,conversation_id}','task_id',task->>'id','source',o.source,
  'message_id',task#>>'{metadata,message_id}','title',task->>'title',
  'description',coalesce(task->>'description',task->>'question'),'status',task->>'status','priority',task->>'priority',
  'assigned_to_user_id',task->'assigned_to_user_id','assigned_to_email',task->>'assigned_to_email',
  'assigned_to_role',task->>'assigned_to_role','assigned_by',task->'assigned_by','created_by',task->'created_by',
  'assigned_by_email',task->>'assigned_by_email','created_by_email',task->>'created_by_email',
  'created_at',task->'created_at','updated_at',task->'updated_at','due_at',task->'due_at','resolved_at',task->'resolved_at',
  'latest_note',task->>'latest_note','metadata',task->'metadata','task_tag',task#>>'{metadata,task_tag}',
  'refund_amount',task#>'{metadata,refund_amount}','conversation_link',task#>>'{metadata,conversation_link}',
  'message_preview',task#>>'{metadata,message_preview}',
  'next_actor_label',case when action='history' then case when task->>'status'='cancelled' then 'Canceled' else 'Finished' end
   when action='subtasks' then 'Waiting for subtasks'
   else (case when action='work' then 'Next: ' when task->>'status'='completed_by_employee' then 'Review: ' else 'Decision: ' end)
     ||coalesce(nullif(next_person.display_name,''),next_person.email,case when action='decision' then 'Reviewer needed' else 'Unassigned' end) end,
  'events',case when _include_events then coalesce((
   select jsonb_agg(event || jsonb_build_object('signed_by_display_name',actor.display_name,'signed_by_email',coalesce(event->>'signed_by_email',actor.email)) order by event->>'created_at' desc)
   from (
    select to_jsonb(e) event from public.team_task_events e where o.source='team' and e.task_id=(task->>'id')::uuid
    union all
    select to_jsonb(e) from public.ebay_order_task_events e where o.source='order' and e.task_id=(task->>'id')::uuid
   ) ev left join lateral (select e.display_name,e.email from public.employees e where e.user_id=(event->>'signed_by')::uuid limit 1) actor on true
  ),'[]'::jsonb) else '[]'::jsonb end
 ) from owners o left join lateral (select e.display_name,e.email from public.employees e where e.user_id=o.next_id and e.active is true limit 1) next_person on true
 order by (action='history'),task->>'created_at' desc;
$$;
revoke all on function public.list_ebay_conversation_task_workspace(uuid[],boolean) from public,anon;
grant execute on function public.list_ebay_conversation_task_workspace(uuid[],boolean) to authenticated;
commit;
