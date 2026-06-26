create or replace function public.create_ebay_order_history_task(
  _order_id uuid,
  _order_line_ids uuid[] default '{}'::uuid[],
  _assigned_to_user_id uuid default null,
  _priority text default 'normal',
  _question text default null,
  _due_at timestamptz default null,
  _photo_attachments jsonb default '[]'::jsonb,
  _signed_by_email text default null
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_order public.ebay_orders;
  v_task public.ebay_order_tasks;
  v_employee public.employees;
  v_priority text := coalesce(nullif(btrim(coalesce(_priority, '')), ''), 'normal');
  v_question text := nullif(btrim(coalesce(_question, '')), '');
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_photo_attachments jsonb := case
    when jsonb_typeof(coalesce(_photo_attachments, '[]'::jsonb)) = 'array'
      then coalesce(_photo_attachments, '[]'::jsonb)
    else '[]'::jsonb
  end;
  v_requested_line_ids uuid[] := '{}'::uuid[];
  v_line_ids uuid[] := '{}'::uuid[];
  v_status text := 'open';
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to create eBay order history tasks' using errcode = '42501';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid order task priority: %', v_priority using errcode = '22023';
  end if;

  if v_question is null then
    raise exception 'A task note/question is required' using errcode = '22023';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = _order_id;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
  end if;

  select coalesce(array_agg(distinct entry.line_id), '{}'::uuid[])
    into v_requested_line_ids
  from unnest(coalesce(_order_line_ids, '{}'::uuid[])) as entry(line_id)
  where entry.line_id is not null;

  if cardinality(v_requested_line_ids) > 0 then
    select coalesce(array_agg(line.id), '{}'::uuid[])
      into v_line_ids
    from public.ebay_order_lines line
    where line.order_id = v_order.id
      and line.id = any(v_requested_line_ids);

    if cardinality(v_line_ids) <> cardinality(v_requested_line_ids) then
      raise exception 'One or more selected order lines do not belong to this eBay order' using errcode = '22023';
    end if;
  else
    select coalesce(array_agg(line.id), '{}'::uuid[])
      into v_line_ids
    from public.ebay_order_lines line
    where line.order_id = v_order.id;
  end if;

  if _assigned_to_user_id is not null then
    select *
      into v_employee
    from public.employees
    where user_id = _assigned_to_user_id
      and active is true
    limit 1;

    if not found then
      raise exception 'Assigned employee not found or inactive' using errcode = 'P0002';
    end if;

    v_status := case
      when v_employee.role = 'admin' then 'waiting_on_admin'
      else 'waiting_on_worker'
    end;
  end if;

  insert into public.ebay_order_tasks (
    order_id,
    order_line_ids,
    task_type,
    title,
    question,
    status,
    priority,
    assigned_to_user_id,
    assigned_to_employee_id,
    assigned_to_email,
    assigned_to_role,
    assigned_by,
    assigned_by_email,
    due_at,
    latest_note,
    latest_photo_count,
    created_by,
    created_by_email,
    metadata
  )
  values (
    v_order.id,
    v_line_ids,
    case when _assigned_to_user_id is not null and v_employee.role = 'admin' then 'admin_review' else 'coordination' end,
    concat('Closed order ', coalesce(v_order.order_number, 'task'), ' - ', coalesce(v_order.buyer_username, 'unknown buyer')),
    v_question,
    v_status,
    v_priority,
    _assigned_to_user_id,
    case when _assigned_to_user_id is null then null else v_employee.id end,
    case when _assigned_to_user_id is null then null else v_employee.email end,
    case when _assigned_to_user_id is null then null else v_employee.role end,
    auth.uid(),
    v_signed_email,
    _due_at,
    v_question,
    jsonb_array_length(v_photo_attachments),
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'source', 'order_history',
      'created_from', 'ebay_order_history',
      'order_number', v_order.order_number,
      'order_status', v_order.status,
      'buyer_username', v_order.buyer_username,
      'buyer_name', v_order.buyer_name,
      'line_count', cardinality(v_line_ids),
      'order_total_price', v_order.total_price,
      'order_net_payout', v_order.net_payout
    )
  )
  returning * into v_task;

  insert into public.ebay_order_task_events (
    task_id,
    order_id,
    action,
    new_status,
    new_assigned_to_user_id,
    notes,
    photo_attachments,
    signed_by,
    signed_by_email
  )
  values (
    v_task.id,
    v_task.order_id,
    'created',
    v_task.status,
    v_task.assigned_to_user_id,
    v_question,
    v_photo_attachments,
    auth.uid(),
    v_signed_email
  );

  return v_task;
end;
$$;

revoke all on function public.create_ebay_order_history_task(uuid, uuid[], uuid, text, text, timestamptz, jsonb, text) from public;
grant execute on function public.create_ebay_order_history_task(uuid, uuid[], uuid, text, text, timestamptz, jsonb, text) to authenticated;
