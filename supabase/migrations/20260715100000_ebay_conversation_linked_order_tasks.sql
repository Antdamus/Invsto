-- Create pending/order-history tasks directly from an eBay conversation message.
-- The task stays in the normal order task queue, but carries the conversation
-- metadata so workers can open the source chat from the task detail.

create or replace function public.create_ebay_conversation_linked_order_task(
  _conversation_id uuid,
  _message_id uuid,
  _target_source text default 'pending_order',
  _order_id uuid default null,
  _order_line_ids uuid[] default '{}'::uuid[],
  _assigned_to_user_id uuid default null,
  _priority text default 'normal',
  _title text default null,
  _question text default null,
  _due_at timestamptz default null,
  _task_tag text default null,
  _refund_amount numeric default null,
  _task_scope text default 'order',
  _group_order_ids uuid[] default '{}'::uuid[],
  _group_order_numbers text[] default '{}'::text[],
  _signed_by_email text default null
)
returns public.ebay_order_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.ebay_order_tasks;
  v_order public.ebay_orders;
  v_employee public.employees;
  v_conversation public.ebay_conversations;
  v_message public.ebay_conversation_messages;
  v_priority text := coalesce(nullif(btrim(coalesce(_priority, '')), ''), 'normal');
  v_title text := nullif(btrim(coalesce(_title, '')), '');
  v_question text := nullif(btrim(coalesce(_question, '')), '');
  v_target_source text := lower(coalesce(nullif(btrim(coalesce(_target_source, '')), ''), 'pending_order'));
  v_source text;
  v_scope text := lower(coalesce(nullif(btrim(coalesce(_task_scope, '')), ''), 'order'));
  v_task_tag text := nullif(lower(btrim(coalesce(_task_tag, ''))), '');
  v_refund_amount numeric := _refund_amount;
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_status text := 'open';
  v_requested_line_ids uuid[] := '{}'::uuid[];
  v_requested_group_order_ids uuid[] := '{}'::uuid[];
  v_line_ids uuid[] := '{}'::uuid[];
  v_order_ids uuid[] := '{}'::uuid[];
  v_order_numbers text[] := '{}'::text[];
  v_provided_order_numbers text[] := '{}'::text[];
  v_order_count integer := 0;
  v_group_total_price numeric := 0;
  v_group_net_payout numeric := 0;
  v_message_text text;
  v_message_preview text;
  v_link text;
  v_metadata jsonb;
begin
  if not (public.can_access_email_triage() and public.can_manage_inventory()) then
    raise exception 'Not allowed to create eBay conversation order tasks' using errcode = '42501';
  end if;

  if _conversation_id is null then
    raise exception 'A conversation id is required' using errcode = '22023';
  end if;

  if _message_id is null then
    raise exception 'A message id is required' using errcode = '22023';
  end if;

  if _order_id is null then
    raise exception 'A local eBay order id is required' using errcode = '22023';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid order task priority: %', v_priority using errcode = '22023';
  end if;

  if v_scope not in ('group', 'order', 'line') then
    v_scope := 'order';
  end if;

  if v_task_tag is not null and v_task_tag not in ('refunds') then
    raise exception 'Invalid task tag: %', v_task_tag using errcode = '22023';
  end if;

  if v_task_tag = 'refunds' and (v_refund_amount is null or v_refund_amount <= 0) then
    raise exception 'A refund amount is required for refund tasks' using errcode = '22023';
  end if;

  if v_task_tag is distinct from 'refunds' then
    v_refund_amount := null;
  end if;

  if v_question is null then
    raise exception 'Task instructions are required' using errcode = '22023';
  end if;

  v_source := case
    when v_target_source in ('order_history', 'history', 'closed_order') then 'order_history'
    else 'pending_orders'
  end;

  select *
    into v_conversation
  from public.ebay_conversations
  where id = _conversation_id
  limit 1;

  if not found then
    raise exception 'eBay conversation not found' using errcode = 'P0002';
  end if;

  select *
    into v_message
  from public.ebay_conversation_messages
  where id = _message_id
    and conversation_id = _conversation_id
  limit 1;

  if not found then
    raise exception 'eBay conversation message not found' using errcode = 'P0002';
  end if;

  select *
    into v_order
  from public.ebay_orders
  where id = _order_id;

  if not found then
    raise exception 'eBay order not found' using errcode = 'P0002';
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

  select coalesce(array_agg(distinct entry.line_id), '{}'::uuid[])
    into v_requested_line_ids
  from unnest(coalesce(_order_line_ids, '{}'::uuid[])) as entry(line_id)
  where entry.line_id is not null;

  select coalesce(array_agg(distinct entry.order_id), '{}'::uuid[])
    into v_requested_group_order_ids
  from unnest(coalesce(_group_order_ids, '{}'::uuid[]) || array[_order_id]) as entry(order_id)
  where entry.order_id is not null;

  select coalesce(array_agg(distinct nullif(btrim(entry.order_number), '')), '{}'::text[])
    into v_provided_order_numbers
  from unnest(coalesce(_group_order_numbers, '{}'::text[])) as entry(order_number)
  where nullif(btrim(entry.order_number), '') is not null;

  if cardinality(v_requested_line_ids) > 0 then
    select
      coalesce(array_agg(distinct line.id), '{}'::uuid[]),
      coalesce(array_agg(distinct line.order_id), '{}'::uuid[])
      into v_line_ids, v_order_ids
    from public.ebay_order_lines line
    where line.id = any(v_requested_line_ids);

    if cardinality(v_line_ids) <> cardinality(v_requested_line_ids) then
      raise exception 'One or more selected order lines were not found' using errcode = '22023';
    end if;

    if v_scope <> 'group' and exists (
      select 1
      from unnest(v_order_ids) as selected(order_id)
      where selected.order_id is distinct from v_order.id
    ) then
      raise exception 'One or more selected order lines do not belong to this eBay order' using errcode = '22023';
    end if;

    if v_scope = 'group' and exists (
      select 1
      from unnest(v_order_ids) as selected(order_id)
      where selected.order_id <> all(v_requested_group_order_ids)
    ) then
      raise exception 'One or more selected order lines do not belong to the selected order group' using errcode = '22023';
    end if;
  elsif v_scope = 'group' then
    select
      coalesce(array_agg(distinct line.id), '{}'::uuid[]),
      coalesce(array_agg(distinct line.order_id), '{}'::uuid[])
      into v_line_ids, v_order_ids
    from public.ebay_order_lines line
    where line.order_id = any(v_requested_group_order_ids);
  else
    select
      coalesce(array_agg(distinct line.id), '{}'::uuid[]),
      coalesce(array_agg(distinct line.order_id), '{}'::uuid[])
      into v_line_ids, v_order_ids
    from public.ebay_order_lines line
    where line.order_id = v_order.id;
  end if;

  if cardinality(v_line_ids) = 0 then
    raise exception 'Choose at least one item line for this task' using errcode = '22023';
  end if;

  select
    coalesce(array_agg(distinct o.order_number) filter (where nullif(btrim(o.order_number), '') is not null), '{}'::text[]),
    coalesce(count(distinct o.id), 0),
    coalesce(sum(coalesce(o.total_price, 0)), 0),
    coalesce(sum(coalesce(o.net_payout, 0)), 0)
    into v_order_numbers, v_order_count, v_group_total_price, v_group_net_payout
  from public.ebay_orders o
  where o.id = any(v_order_ids);

  v_order_numbers := (
    select coalesce(array_agg(distinct entry.order_number), '{}'::text[])
    from unnest(v_order_numbers || v_provided_order_numbers) as entry(order_number)
    where nullif(btrim(entry.order_number), '') is not null
  );

  if v_scope = 'group' and v_order_count <= 1 then
    v_scope := 'order';
  end if;

  v_message_text := nullif(btrim(coalesce(v_message.message_body, v_message.message_body_preview, '')), '');
  v_message_preview := left(regexp_replace(coalesce(v_message_text, ''), '\s+', ' ', 'g'), 700);
  v_link := 'email-triage.html?ebayConversationDbId=' || v_conversation.id::text
    || '&ebayMessageDbId=' || v_message.id::text;

  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source', v_source,
    'created_from', 'email_triage',
    'conversation_task', true,
    'task_tag', v_task_tag,
    'task_tags', case when v_task_tag is null then null else jsonb_build_array(v_task_tag) end,
    'refund_amount', v_refund_amount,
    'task_scope', v_scope,
    'scope', v_scope,
    'primary_order_id', v_order.id,
    'order_id', v_order.id,
    'order_ids', to_jsonb(v_order_ids),
    'order_number', v_order.order_number,
    'order_numbers', to_jsonb(v_order_numbers),
    'order_status', v_order.status,
    'buyer_username', coalesce(v_order.buyer_username, v_conversation.other_party_username),
    'buyer_name', v_order.buyer_name,
    'line_count', cardinality(v_line_ids),
    'order_count', greatest(v_order_count, 1),
    'order_total_price', case when v_scope = 'group' then v_group_total_price else v_order.total_price end,
    'order_net_payout', case when v_scope = 'group' then v_group_net_payout else v_order.net_payout end,
    'conversation_id', v_conversation.id,
    'message_id', v_message.id,
    'ebay_conversation_id', v_conversation.ebay_conversation_id,
    'ebay_message_id', v_message.ebay_message_id,
    'conversation_type', v_conversation.conversation_type,
    'conversation_title', v_conversation.conversation_title,
    'sender_username', v_message.sender_username,
    'recipient_username', v_message.recipient_username,
    'message_direction', v_message.direction,
    'message_created_at', coalesce(v_message.created_at_ebay, v_message.created_at),
    'message_preview', v_message_preview,
    'message_subject', v_message.subject,
    'conversation_link', v_link
  ));

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
    coalesce(v_title, case
      when v_source = 'order_history' and v_scope = 'group'
        then concat('Closed order group ', coalesce(array_to_string(v_order_numbers, ', '), coalesce(v_order.order_number, 'task')), ' - ', coalesce(v_order.buyer_username, v_conversation.other_party_username, 'unknown buyer'))
      when v_source = 'order_history'
        then concat('Closed order ', coalesce(v_order.order_number, 'task'), ' - ', coalesce(v_order.buyer_username, v_conversation.other_party_username, 'unknown buyer'))
      else concat('Order ', coalesce(v_order.order_number, 'task'), ' - ', coalesce(v_order.buyer_username, v_conversation.other_party_username, 'unknown buyer'))
    end),
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
    0,
    auth.uid(),
    v_signed_email,
    v_metadata
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
    signed_by_email,
    payload
  )
  values (
    v_task.id,
    v_task.order_id,
    'created',
    v_task.status,
    v_task.assigned_to_user_id,
    v_question,
    '[]'::jsonb,
    auth.uid(),
    v_signed_email,
    jsonb_strip_nulls(jsonb_build_object(
      'source', v_source,
      'created_from', 'email_triage',
      'conversation_task', true,
      'task_tag', v_task_tag,
      'refund_amount', v_refund_amount,
      'task_scope', v_scope,
      'order_ids', to_jsonb(v_order_ids),
      'order_numbers', to_jsonb(v_order_numbers),
      'order_line_ids', to_jsonb(v_line_ids),
      'conversation_id', v_conversation.id,
      'message_id', v_message.id,
      'ebay_conversation_id', v_conversation.ebay_conversation_id,
      'ebay_message_id', v_message.ebay_message_id,
      'message_direction', v_message.direction,
      'message_preview', v_message_preview,
      'conversation_link', v_link
    ))
  );

  return v_task;
end;
$$;

create index if not exists ebay_order_tasks_conversation_lookup_idx
  on public.ebay_order_tasks ((metadata ->> 'conversation_id'), status, created_at desc)
  where metadata ? 'conversation_id';

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
  team_task_rows as (
    select
      t.id,
      t.title,
      t.description,
      t.status,
      t.priority,
      t.assigned_to_user_id,
      t.assigned_to_employee_id,
      t.assigned_to_email,
      t.assigned_to_role,
      t.assigned_by_email,
      t.created_by_email,
      t.created_at,
      t.updated_at,
      t.due_at,
      t.resolved_at,
      t.latest_note,
      t.metadata,
      case
        when coalesce(t.metadata ->> 'conversation_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (t.metadata ->> 'conversation_id')::uuid
        else null
      end as metadata_conversation_id,
      case
        when coalesce(t.metadata ->> 'message_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (t.metadata ->> 'message_id')::uuid
        else null
      end as metadata_message_id,
      coalesce(event_rows.events, '[]'::jsonb) as events
    from public.team_tasks t
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
      where e.task_id = t.id
    ) event_rows on true
    where public.can_access_email_triage()
      and t.metadata ->> 'source' = 'ebay_conversation_message'
      and t.metadata ->> 'history_removed_at' is null
  ),
  order_task_rows as (
    select
      t.id,
      t.title,
      t.question as description,
      t.status,
      t.priority,
      t.assigned_to_user_id,
      t.assigned_to_employee_id,
      t.assigned_to_email,
      t.assigned_to_role,
      t.assigned_by_email,
      t.created_by_email,
      t.created_at,
      t.updated_at,
      t.due_at,
      t.resolved_at,
      t.latest_note,
      t.metadata,
      case
        when coalesce(t.metadata ->> 'conversation_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (t.metadata ->> 'conversation_id')::uuid
        else null
      end as metadata_conversation_id,
      case
        when coalesce(t.metadata ->> 'message_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
          then (t.metadata ->> 'message_id')::uuid
        else null
      end as metadata_message_id,
      coalesce(event_rows.events, '[]'::jsonb) as events
    from public.ebay_order_tasks t
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
      from public.ebay_order_task_events e
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
      where e.task_id = t.id
    ) event_rows on true
    where public.can_manage_inventory()
      and t.metadata ? 'conversation_id'
      and t.metadata ->> 'history_removed_at' is null
  ),
  all_task_rows as (
    select * from team_task_rows
    union all
    select * from order_task_rows
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
    tr.events
  from all_task_rows tr
  left join lateral (
    select e.display_name, e.email, e.role
    from public.employees e
    where e.user_id = tr.assigned_to_user_id
       or e.id = tr.assigned_to_employee_id
    order by case when e.user_id = tr.assigned_to_user_id then 0 else 1 end
    limit 1
  ) assigned_employee on true
  where tr.metadata_conversation_id is not null
    and (
      not exists (select 1 from requested_conversations)
      or tr.metadata_conversation_id in (select conversation_id from requested_conversations)
    )
  order by
    case when tr.status in ('resolved', 'cancelled') then 1 else 0 end,
    tr.created_at desc;
$$;

revoke all on function public.create_ebay_conversation_linked_order_task(uuid, uuid, text, uuid, uuid[], uuid, text, text, text, timestamptz, text, numeric, text, uuid[], text[], text) from public;
grant execute on function public.create_ebay_conversation_linked_order_task(uuid, uuid, text, uuid, uuid[], uuid, text, text, text, timestamptz, text, numeric, text, uuid[], text[], text) to authenticated;

revoke all on function public.list_ebay_conversation_message_task_status(uuid[]) from public;
grant execute on function public.list_ebay_conversation_message_task_status(uuid[]) to authenticated;

comment on function public.create_ebay_conversation_linked_order_task(uuid, uuid, text, uuid, uuid[], uuid, text, text, text, timestamptz, text, numeric, text, uuid[], text[], text)
  is 'Creates a pending/order-history task from an eBay conversation message while preserving a link back to the source chat.';

comment on function public.list_ebay_conversation_message_task_status(uuid[])
  is 'Returns eBay-conversation-linked standalone and order-linked tasks with status, assignment, and event history.';
