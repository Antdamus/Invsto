-- Parent pending-order approval tasks should leave active worker queues once
-- shipping is assigned. Only pending_shipping tasks stay active for workers.

update public.ebay_order_tasks parent
set status = 'approved_for_shipping',
    completed_at = coalesce(parent.completed_at, now()),
    resolved_at = coalesce(parent.resolved_at, now()),
    resolution_notes = coalesce(parent.resolution_notes, parent.latest_note, 'Approved for shipping.'),
    latest_note = coalesce(parent.latest_note, 'Approved for shipping.')
where parent.parent_task_id is null
  and parent.task_type in ('coordination', 'admin_review', 'pending_admin_review', 'worker_follow_up', 'special_order')
  and parent.status = 'assigned_for_shipping'
  and exists (
    select 1
    from public.ebay_order_tasks shipping
    where shipping.parent_task_id = parent.id
      and shipping.task_type = 'pending_shipping'
  );

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
    and (
      t.status in ('open', 'assigned', 'in_progress', 'waiting_on_admin', 'waiting_on_worker', 'blocked', 'deferred')
      or (t.status = 'assigned_for_shipping' and t.task_type = 'pending_shipping')
    )
  order by
    case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
    t.due_at nulls last,
    o.ship_by_date nulls last,
    t.created_at asc
  limit greatest(1, least(coalesce(_limit, 8), 50));
$$;

grant execute on function public.list_my_ebay_order_tasks(integer) to authenticated;
