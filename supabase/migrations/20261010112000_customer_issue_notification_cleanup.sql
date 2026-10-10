begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Read-only inbox. The caller cannot choose another employee's recipient ID.
-- Explicit task assignments/replies remain Tasks even when the work is a return.
create or replace function public.notification_inbox(_category text default 'all', _view text default 'unread', _limit integer default 30)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; recipient uuid:=auth.uid(); page_limit integer:=greatest(coalesce(_limit,30),1);
begin
 if recipient is null then raise exception 'Sign in to see your updates'; end if;
 if _category is null or _category not in ('all','tasks','buyers','returns','system') or _view is null or _view not in ('unread','recent') then
  raise exception 'Unknown notification filter';
 end if;
 with notices as materialized (
  select n.id,n.recipient_user_id,n.source,n.task_id,n.notification_type,n.title,n.body,n.actor_email,n.priority,n.read_at,n.created_at,n.metadata,
   case when n.notification_type='customer_issue_sync' then 'system'
    when n.notification_type in ('customer_issue_action','customer_issue_deadline') then
     case when coalesce(c.issue_kind,c.source_lane)='return' then 'returns' else 'buyers' end
    else 'tasks' end category
  from public.task_notifications n
  left join public.ebay_return_tasks t on n.source='return' and t.id=n.task_id
  left join public.ebay_return_cases c on c.id=coalesce(
   case when n.metadata->>'case_id' ~* '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$' then (n.metadata->>'case_id')::uuid end,t.return_case_id)
   and n.notification_type in ('customer_issue_action','customer_issue_deadline')
  where n.recipient_user_id=recipient and (_view='recent' or n.read_at is null)
   -- Retain old notices in the audit data, but do not show synthetic task noise.
   and (t.id is null or public.customer_issue_is_employee_task(to_jsonb(t))
    or n.notification_type in ('customer_issue_action','customer_issue_deadline','customer_issue_sync'))
 ), visible as (select * from notices where (_category='all' or category=_category) and (_view='recent' or read_at is null))
 select jsonb_build_object(
  'unread_count',(select count(*) from notices where read_at is null),
  'counts',(select jsonb_build_object('all',count(*),'tasks',count(*) filter(where category='tasks'),'buyers',count(*) filter(where category='buyers'),
    'returns',count(*) filter(where category='returns'),'system',count(*) filter(where category='system')) from notices where read_at is null),
  'total',(select count(*) from visible),
  'entries',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from (select * from visible order by created_at desc,id desc limit page_limit)p),'[]'::jsonb),
  'unread',coalesce((select jsonb_agg(to_jsonb(p) order by created_at desc,id desc) from (select * from notices where read_at is null order by created_at desc,id desc limit 30)p),'[]'::jsonb)
 ) into result;
 return result;
end $$;
revoke all on function public.notification_inbox(text,text,integer) from public,anon;
grant execute on function public.notification_inbox(text,text,integer) to authenticated;
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
      and public.customer_issue_is_employee_task(to_jsonb(ebay_return_tasks))
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

notify pgrst,'reload schema';
commit;
