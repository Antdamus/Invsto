-- Keep soft-canceled tasks out of active worker/admin task feeds.

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
    and t.metadata ->> 'history_removed_at' is null
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
$$;

create or replace function public.list_admin_team_tasks(_limit integer default 12)
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
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if not public.current_user_is_employee_admin() then
    raise exception 'Only admins can list all team tasks' using errcode = '42501';
  end if;

  return query
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
  where t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
    and t.metadata ->> 'history_removed_at' is null
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 12), 100));
end;
$$;

create or replace function public.list_my_ebay_order_tasks(_limit integer default 8)
returns table (
  id uuid,
  order_id uuid,
  order_line_ids uuid[],
  task_type text,
  title text,
  question text,
  status text,
  priority text,
  assigned_to_email text,
  due_at timestamptz,
  created_at timestamptz,
  latest_note text,
  latest_photo_count integer,
  order_number text,
  buyer_username text,
  ship_by_date timestamptz
)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select
    t.id,
    t.order_id,
    t.order_line_ids,
    t.task_type,
    t.title,
    t.question,
    t.status,
    t.priority,
    t.assigned_to_email,
    t.due_at,
    t.created_at,
    t.latest_note,
    t.latest_photo_count,
    o.order_number,
    o.buyer_username,
    o.ship_by_date
  from public.ebay_order_tasks t
  join public.ebay_orders o on o.id = t.order_id
  where t.assigned_to_user_id = auth.uid()
    and t.metadata ->> 'history_removed_at' is null
    and (
      t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
      or (t.status = 'assigned_for_shipping' and t.task_type in ('pending_shipping', 'pending_packaging'))
    )
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    o.ship_by_date nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 8), 50));
$$;

grant execute on function public.list_my_team_tasks(integer) to authenticated;
grant execute on function public.list_admin_team_tasks(integer) to authenticated;
grant execute on function public.list_my_ebay_order_tasks(integer) to authenticated;
