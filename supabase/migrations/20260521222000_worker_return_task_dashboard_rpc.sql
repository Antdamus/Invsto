-- Make assigned eBay return work reliably visible on the worker dashboard.
-- The direct dashboard query can be fragile because it embeds return cases through
-- PostgREST and depends on several RLS policies lining up. This RPC returns only
-- the current user's open assigned tasks, already flattened for the dashboard.

drop policy if exists "ebay_return_tasks_assigned_worker_select" on public.ebay_return_tasks;
create policy "ebay_return_tasks_assigned_worker_select"
on public.ebay_return_tasks
for select
to authenticated
using (
  assigned_to_user_id = auth.uid()
  or created_by = auth.uid()
);

drop policy if exists "ebay_return_cases_assigned_worker_select" on public.ebay_return_cases;
create policy "ebay_return_cases_assigned_worker_select"
on public.ebay_return_cases
for select
to authenticated
using (
  exists (
    select 1
    from public.ebay_return_tasks t
    where t.return_case_id = ebay_return_cases.id
      and (
        t.assigned_to_user_id = auth.uid()
        or t.created_by = auth.uid()
      )
  )
);

drop policy if exists "ebay_return_task_events_assigned_worker_select" on public.ebay_return_task_events;
create policy "ebay_return_task_events_assigned_worker_select"
on public.ebay_return_task_events
for select
to authenticated
using (
  exists (
    select 1
    from public.ebay_return_tasks t
    where t.id = ebay_return_task_events.task_id
      and (
        t.assigned_to_user_id = auth.uid()
        or t.created_by = auth.uid()
      )
  )
);

drop policy if exists "ebay_return_messages_assigned_worker_select" on public.ebay_return_messages;
create policy "ebay_return_messages_assigned_worker_select"
on public.ebay_return_messages
for select
to authenticated
using (
  exists (
    select 1
    from public.ebay_return_tasks t
    where t.return_case_id = ebay_return_messages.return_case_id
      and (
        t.assigned_to_user_id = auth.uid()
        or t.created_by = auth.uid()
      )
  )
);

create or replace function public.list_my_ebay_return_tasks(_limit integer default 6)
returns table (
  id uuid,
  task_type text,
  title text,
  question text,
  status text,
  priority text,
  assigned_to_email text,
  due_at timestamptz,
  created_at timestamptz,
  return_case_id uuid,
  order_number text,
  ebay_return_id text,
  buyer_username text,
  return_reason text
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
    t.question,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.due_at,
    t.created_at,
    t.return_case_id,
    c.order_number,
    c.ebay_return_id,
    c.buyer_username,
    c.return_reason
  from public.ebay_return_tasks t
  left join public.ebay_return_cases c
    on c.id = t.return_case_id
  where t.assigned_to_user_id = auth.uid()
    and t.status in ('open', 'assigned', 'in_progress', 'blocked')
  order by
    case t.priority
      when 'urgent' then 0
      when 'high' then 1
      when 'normal' then 2
      else 3
    end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 6), 50));
$$;

revoke all on function public.list_my_ebay_return_tasks(integer) from public;
grant execute on function public.list_my_ebay_return_tasks(integer) to authenticated;
