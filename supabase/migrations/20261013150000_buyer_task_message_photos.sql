begin;
set local lock_timeout = '3s';
set local statement_timeout = '60s';

-- Snapshot only trusted stored message fields; the caller cannot invent context.
create function public.buyer_followup_message_context(_buyer text, _conversation_id uuid, _message_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare c public.ebay_conversations; m public.ebay_conversation_messages; buyer text := lower(btrim(_buyer));
begin
 if auth.uid() is null or not coalesce(public.can_access_email_triage(),false) then
  raise exception 'Message access required' using errcode='42501';
 end if;
 select * into c from public.ebay_conversations where id=_conversation_id;
 if not found then raise exception 'Conversation not found' using errcode='22023'; end if;
 if _message_id is not null then
  select * into m from public.ebay_conversation_messages where id=_message_id and conversation_id=c.id;
  if not found then raise exception 'Message does not belong to this conversation' using errcode='22023'; end if;
 end if;
 if lower(btrim(coalesce(c.other_party_username,''))) <> buyer and not exists (
  select 1 from public.ebay_conversation_messages cm where cm.conversation_id=c.id
   and lower(btrim(case when cm.direction='inbound' then cm.sender_username when cm.direction='outbound' then cm.recipient_username end))=buyer
 ) then raise exception 'Conversation does not belong to this exact customer' using errcode='22023'; end if;
 return jsonb_strip_nulls(jsonb_build_object(
  'conversation_id',c.id,'message_id',m.id,'ebay_conversation_id',c.ebay_conversation_id,'ebay_message_id',m.ebay_message_id,
  'conversation_title',c.conversation_title,'sender_username',m.sender_username,'recipient_username',m.recipient_username,
  'message_direction',m.direction,'message_created_at',coalesce(m.created_at_ebay,m.created_at),'message_subject',m.subject,
  'message_preview',left(regexp_replace(coalesce(m.message_body,m.message_body_preview,''),'\s+',' ','g'),700),
  'conversation_link','email-triage.html?ebayConversationDbId='||c.id::text||case when m.id is null then '' else '&ebayMessageDbId='||m.id::text end));
end $$;
revoke all on function public.buyer_followup_message_context(text,uuid,uuid) from public,anon,authenticated;

-- Repair a previously created promise without recreating or reassigning it.
create function public.attach_buyer_followup_message(_task_id uuid,_conversation_id uuid,_message_id uuid default null)
returns jsonb language plpgsql security definer set search_path='' as $$
declare t public.team_tasks; context jsonb; result jsonb; actor_email text;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then
  raise exception 'Active staff access required' using errcode='42501';
 end if;
 select * into t from public.team_tasks where id=_task_id;
 if not found or t.metadata->>'source' is distinct from 'buyer_followup' then raise exception 'Customer task not found'; end if;
 if t.created_by is distinct from auth.uid() and not coalesce(public.is_admin(),false) then
  raise exception 'Only the creator or an admin can link this task' using errcode='42501';
 end if;
 perform pg_advisory_xact_lock(hashtextextended('buyer-promise:' || (t.metadata->>'buyer_username'),0));
 select * into t from public.team_tasks where id=_task_id for update;
 context:=public.buyer_followup_message_context(t.metadata->>'buyer_username',_conversation_id,_message_id);
 if t.metadata ? 'conversation_id' then
  if t.metadata->>'conversation_id'=_conversation_id::text and t.metadata->>'message_id' is not distinct from _message_id::text then return to_jsonb(t); end if;
  raise exception 'This task already has an original conversation';
 end if;
 update public.team_tasks set metadata=metadata||context,updated_at=now() where id=t.id returning to_jsonb(team_tasks) into result;
 select email into actor_email from public.employees where user_id=auth.uid() and active limit 1;
 insert into public.team_task_events(task_id,action,notes,signed_by,signed_by_email,payload)
 values(t.id,'commented','Original conversation linked to this customer promise.',auth.uid(),actor_email,
  context||jsonb_build_object('source','buyer_followup_message_link'));
 return result;
end $$;
revoke all on function public.attach_buyer_followup_message(uuid,uuid,uuid) from public,anon;
grant execute on function public.attach_buyer_followup_message(uuid,uuid,uuid) to authenticated;

create or replace function public.create_buyer_followup_task(_buyer_username text, _details jsonb, _request_id uuid)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  buyer text := lower(btrim(_buyer_username));
  actor public.employees;
  details jsonb;
  result jsonb;
  existing public.team_tasks;
  context jsonb := '{}'::jsonb;
  photos jsonb := coalesce(_details->'_photo_attachments','[]'::jsonb);
begin
  if auth.uid() is null or not coalesce(public.can_manage_inventory(), false) then
    raise exception 'Active staff access required' using errcode = '42501';
  end if;
  select * into actor from public.employees where user_id = auth.uid() and active is true limit 1;
  if not found then raise exception 'Active employee not found' using errcode = '42501'; end if;
  if buyer is null or buyer = '' or length(buyer) > 100 or buyer ~ '[[:space:]<>/@]' then
    raise exception 'Enter the exact eBay username, without a name, @ sign or profile URL' using errcode = '22023';
  end if;
  if _request_id is null or jsonb_typeof(_details) is distinct from 'object' then
    raise exception 'Task details and request ID are required' using errcode = '22023';
  end if;
  if nullif(btrim(_details->>'_title'), '') is null or length(_details->>'_title') > 200
    or nullif(btrim(_details->>'_description'), '') is null or length(_details->>'_description') > 10000 then
    raise exception 'Add a title (up to 200 characters) and specific instructions (up to 10,000 characters)' using errcode = '22023';
  end if;
  if jsonb_typeof(photos) is distinct from 'array' or jsonb_array_length(photos)>10 then
    raise exception 'Choose up to 10 photos' using errcode='22023';
  end if;
  if exists(select 1 from jsonb_array_elements(photos) p where jsonb_typeof(p)<>'object'
    or p->>'bucket' is distinct from 'team-task-evidence' or nullif(p->>'path','') is null
    or coalesce(p->>'mime_type','') not like 'image/%'
    or coalesce((p->>'size_bytes')::bigint,0) not between 1 and 20971520) then
    raise exception 'Invalid task photo attachment' using errcode='22023';
  end if;
  details := jsonb_build_object(
    '_title', btrim(_details->>'_title'), '_description', btrim(_details->>'_description'),
    '_task_type', 'customer_service', '_assigned_to_user_id', _details->'_assigned_to_user_id',
    '_priority', coalesce(_details->>'_priority', 'normal'), '_due_at', _details->'_due_at',
    '_photo_attachments', photos, '_signed_by_email', actor.email);
  if nullif(_details->>'_conversation_id','') is not null then
    details:=details||jsonb_build_object('_conversation_id',(_details->>'_conversation_id')::uuid,
      '_message_id',nullif(_details->>'_message_id','')::uuid);
  elsif nullif(_details->>'_message_id','') is not null then
    raise exception 'A source message requires its conversation';
  end if;
  -- Retry the same save safely, including after a lost response.
  perform pg_advisory_xact_lock(hashtextextended('buyer-promise:' || buyer, 0));
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text || ':' || _request_id::text, 0));
  select * into existing from public.team_tasks where created_by = auth.uid()
    and metadata->>'source' = 'buyer_followup' and metadata->>'buyer_followup_request_id' = _request_id::text;
  if found then
    if existing.metadata->>'buyer_username' is distinct from buyer
      or existing.metadata->'buyer_followup_request' is distinct from details then
      raise exception 'This save already created a different task. Open a new customer task to save these changes.' using errcode = '22023';
    end if;
    return to_jsonb(existing);
  end if;

  if details ? '_conversation_id' then
    context:=public.buyer_followup_message_context(buyer,(details->>'_conversation_id')::uuid,(details->>'_message_id')::uuid);
  end if;
  result := public.create_task_request('team', 'work', details);
  update public.team_tasks set metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
    'source', 'buyer_followup', 'buyer_username', buyer,
    'buyer_followup_request_id', _request_id, 'buyer_followup_request', details) || context
  where id = (result->>'id')::uuid returning to_jsonb(team_tasks) into result;
  update public.team_task_events set payload = coalesce(payload, '{}'::jsonb)
    || jsonb_build_object('source', 'buyer_followup', 'buyer_username', buyer) || context
  where task_id = (result->>'id')::uuid and action = 'created';
  return result;
end $$;
revoke all on function public.create_buyer_followup_task(text,jsonb,uuid) from public, anon;
grant execute on function public.create_buyer_followup_task(text,jsonb,uuid) to authenticated;


-- Include linked promises beside the originating message.
create or replace function public.list_ebay_conversation_task_workspace(_conversation_ids uuid[], _include_events boolean default false)
returns setof jsonb language sql stable security definer set search_path='' as $$
 with requested as (
  select distinct id::text from unnest(coalesce(_conversation_ids,'{}')) id
 ), tasks as materialized (
  select 'team'::text source,to_jsonb(t) task from public.team_tasks t
   where public.can_access_email_triage() and auth.uid() is not null
    and t.metadata->>'source' in ('ebay_conversation_message','buyer_followup') and t.metadata->>'history_removed_at' is null
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

create index if not exists team_tasks_buyer_message_idx on public.team_tasks ((metadata->>'conversation_id')) where metadata->>'source'='buyer_followup';
notify pgrst, 'reload schema';
commit;
