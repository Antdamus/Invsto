-- Keep worker dashboards scoped to tasks currently assigned to the worker.
-- Admin-created or worker-created tasks that are later unassigned should not stay
-- in the worker's active task list after an admin cancels the assignment.

create or replace function public.list_my_team_tasks(_limit integer default 12)
returns table (
  id uuid,
  task_type text,
  title text,
  description text,
  status text,
  priority text,
  assigned_to_email text,
  assigned_to_user_id uuid,
  due_at timestamptz,
  created_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  created_by_email text
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id,
    t.task_type,
    t.title,
    t.description,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.assigned_to_user_id,
    t.due_at,
    t.created_at,
    t.latest_note,
    t.latest_photo_count,
    t.created_by_email
  from public.team_tasks t
  where t.assigned_to_user_id = auth.uid()
    and t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
$$;

grant execute on function public.list_my_team_tasks(integer) to authenticated;
