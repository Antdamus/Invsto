-- Let admins create audited team tasks from a specific eBay conversation message.
-- The task keeps enough message/conversation context to route workers back to the
-- exact customer-service thread without creating a separate task system.

create index if not exists team_tasks_metadata_source_idx
  on public.team_tasks ((metadata ->> 'source'));

drop function if exists public.create_ebay_conversation_message_task(uuid, uuid, text, text, uuid, text, timestamptz, text);

create or replace function public.create_ebay_conversation_message_task(
  _conversation_id uuid,
  _message_id uuid,
  _title text,
  _description text default null,
  _assigned_to_user_id uuid default null,
  _priority text default 'normal',
  _due_at timestamptz default null,
  _task_tag text default null,
  _refund_amount numeric default null,
  _signed_by_email text default null
)
returns public.team_tasks
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_task public.team_tasks;
  v_employee public.employees;
  v_conversation public.ebay_conversations;
  v_message public.ebay_conversation_messages;
  v_title text := nullif(btrim(coalesce(_title, '')), '');
  v_description text := nullif(btrim(coalesce(_description, '')), '');
  v_priority text := coalesce(nullif(btrim(coalesce(_priority, '')), ''), 'normal');
  v_task_tag text := nullif(lower(btrim(coalesce(_task_tag, ''))), '');
  v_refund_amount numeric := _refund_amount;
  v_signed_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_status text := 'open';
  v_message_text text;
  v_message_preview text;
  v_link text;
  v_metadata jsonb;
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to create eBay conversation tasks' using errcode = '42501';
  end if;

  if _conversation_id is null then
    raise exception 'A conversation id is required' using errcode = '22023';
  end if;

  if _message_id is null then
    raise exception 'A message id is required' using errcode = '22023';
  end if;

  if v_title is null then
    raise exception 'A task title is required' using errcode = '22023';
  end if;

  if v_priority not in ('low', 'normal', 'high', 'urgent') then
    raise exception 'Invalid team task priority: %', v_priority using errcode = '22023';
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

    v_status := case when v_employee.role = 'admin' then 'waiting_on_admin' else 'waiting_on_worker' end;
  end if;

  v_message_text := nullif(btrim(coalesce(v_message.message_body, v_message.message_body_preview, '')), '');
  v_message_preview := left(regexp_replace(coalesce(v_message_text, ''), '\s+', ' ', 'g'), 700);
  v_link := 'email-triage.html?ebayConversationDbId=' || v_conversation.id::text
    || '&ebayMessageDbId=' || v_message.id::text;

  v_metadata := jsonb_strip_nulls(jsonb_build_object(
    'source', 'ebay_conversation_message',
    'created_from', 'email_triage',
    'task_tag', v_task_tag,
    'task_tags', case when v_task_tag is null then null else jsonb_build_array(v_task_tag) end,
    'refund_amount', v_refund_amount,
    'conversation_id', v_conversation.id,
    'message_id', v_message.id,
    'ebay_conversation_id', v_conversation.ebay_conversation_id,
    'ebay_message_id', v_message.ebay_message_id,
    'conversation_type', v_conversation.conversation_type,
    'conversation_title', v_conversation.conversation_title,
    'buyer_username', v_conversation.other_party_username,
    'sender_username', v_message.sender_username,
    'recipient_username', v_message.recipient_username,
    'message_direction', v_message.direction,
    'message_created_at', coalesce(v_message.created_at_ebay, v_message.created_at),
    'message_preview', v_message_preview,
    'message_subject', v_message.subject,
    'conversation_link', v_link
  ));

  insert into public.team_tasks (
    task_type,
    title,
    description,
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
    'customer_service',
    v_title,
    v_description,
    v_status,
    v_priority,
    _assigned_to_user_id,
    case when _assigned_to_user_id is null then null else v_employee.id end,
    case when _assigned_to_user_id is null then null else v_employee.email end,
    case when _assigned_to_user_id is null then null else v_employee.role end,
    auth.uid(),
    v_signed_email,
    _due_at,
    coalesce(v_description, v_title),
    0,
    auth.uid(),
    v_signed_email,
    v_metadata
  )
  returning * into v_task;

  insert into public.team_task_events (
    task_id,
    action,
    new_status,
    new_assigned_to_user_id,
    notes,
    signed_by,
    signed_by_email,
    payload
  )
  values (
    v_task.id,
    'created',
    v_task.status,
    v_task.assigned_to_user_id,
    coalesce(v_description, v_title),
    auth.uid(),
    v_signed_email,
    jsonb_build_object(
      'source', 'ebay_conversation_message',
      'task_tag', v_task_tag,
      'refund_amount', v_refund_amount,
      'conversation_id', v_conversation.id,
      'message_id', v_message.id,
      'ebay_conversation_id', v_conversation.ebay_conversation_id,
      'ebay_message_id', v_message.ebay_message_id,
      'message_direction', v_message.direction,
      'message_preview', v_message_preview,
      'conversation_link', v_link
    )
  );

  return v_task;
end;
$$;

drop function if exists public.list_my_team_tasks(integer);
drop function if exists public.list_admin_team_tasks(integer);

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
  created_by_email text,
  metadata jsonb
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
    t.created_by_email,
    t.metadata
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
  created_by_email text,
  metadata jsonb
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
    t.created_by_email,
    t.metadata
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

revoke all on function public.create_ebay_conversation_message_task(uuid, uuid, text, text, uuid, text, timestamptz, text, numeric, text) from public;
revoke all on function public.list_my_team_tasks(integer) from public;
revoke all on function public.list_admin_team_tasks(integer) from public;

grant execute on function public.create_ebay_conversation_message_task(uuid, uuid, text, text, uuid, text, timestamptz, text, numeric, text) to authenticated;
grant execute on function public.list_my_team_tasks(integer) to authenticated;
grant execute on function public.list_admin_team_tasks(integer) to authenticated;

comment on function public.create_ebay_conversation_message_task(uuid, uuid, text, text, uuid, text, timestamptz, text, numeric, text)
  is 'Creates an audited customer-service team task from one canonical eBay conversation message.';
