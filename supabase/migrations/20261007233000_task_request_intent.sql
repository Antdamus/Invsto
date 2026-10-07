begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- Only the explicit creation wrapper sets this transaction-local intent. Apply
-- it before assignment notifications/events, while reusing source validation.
create function public.apply_task_request_intent() returns trigger
language plpgsql security definer set search_path='' as $$
declare kind text:=nullif(current_setting('invsto.task_request_kind',true),'');
begin
 if kind is null then return new;end if;
 if kind not in ('work','decision') or new.assigned_to_user_id is null then
  raise exception 'Choose Work or Decision and the person responsible' using errcode='22023';end if;
 new.metadata:=coalesce(new.metadata,'{}')||jsonb_build_object('request_kind',kind);
 new.status:='assigned';
 return new;
end $$;
create trigger apply_task_request_intent before insert on public.team_tasks for each row execute function public.apply_task_request_intent();
create trigger apply_task_request_intent before insert on public.ebay_order_tasks for each row execute function public.apply_task_request_intent();

create function public.create_task_request(_source text,_request_kind text,_details jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb; previous text:=coalesce(current_setting('invsto.task_request_kind',true),'');
 owner_id uuid:=(_details->>'_assigned_to_user_id')::uuid;
 lines uuid[]:=array(select jsonb_array_elements_text(coalesce(_details->'_order_line_ids','[]'))::uuid);
 groups uuid[]:=array(select jsonb_array_elements_text(coalesce(_details->'_group_order_ids','[]'))::uuid);
 numbers text[]:=array(select jsonb_array_elements_text(coalesce(_details->'_group_order_numbers','[]')));
 photos jsonb:=coalesce(_details->'_photo_attachments','[]');
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Active staff access required' using errcode='42501';end if;
 if _request_kind is null or _request_kind not in ('work','decision') then raise exception 'Choose Work or Decision' using errcode='22023';end if;
 if owner_id is null or not exists(select 1 from public.employees where user_id=owner_id and active is true) then
  raise exception 'Choose the active person responsible for the next step' using errcode='22023';end if;
 if jsonb_typeof(photos) is distinct from 'array' or jsonb_array_length(photos)>30 then raise exception 'Invalid evidence attachments' using errcode='22023';end if;
 perform set_config('invsto.task_request_kind',_request_kind,true);
 case _source
 when 'team' then
  select to_jsonb(t) into result from public.create_team_task(_details->>'_title',_details->>'_description',coalesce(_details->>'_task_type','general'),owner_id,coalesce(_details->>'_priority','normal'),(_details->>'_due_at')::timestamptz,photos,_details->>'_signed_by_email') t;
 when 'order' then
  select to_jsonb(t) into result from public.create_ebay_order_coordination_task((_details->>'_order_id')::uuid,lines,owner_id,coalesce(_details->>'_priority','normal'),_details->>'_question',(_details->>'_due_at')::timestamptz,photos,_details->>'_signed_by_email') t;
 when 'history' then
  select to_jsonb(t) into result from public.create_ebay_order_history_task((_details->>'_order_id')::uuid,lines,owner_id,coalesce(_details->>'_priority','normal'),_details->>'_question',(_details->>'_due_at')::timestamptz,photos,_details->>'_signed_by_email',coalesce(_details->>'_task_scope','order'),groups,numbers) t;
 when 'message' then
  select to_jsonb(t) into result from public.create_ebay_conversation_message_task((_details->>'_conversation_id')::uuid,(_details->>'_message_id')::uuid,_details->>'_title',_details->>'_description',owner_id,coalesce(_details->>'_priority','normal'),(_details->>'_due_at')::timestamptz,_details->>'_task_tag',(_details->>'_refund_amount')::numeric,photos,_details->>'_signed_by_email') t;
 when 'linked_message' then
  select to_jsonb(t) into result from public.create_ebay_conversation_linked_order_task((_details->>'_conversation_id')::uuid,(_details->>'_message_id')::uuid,coalesce(_details->>'_target_source','pending_order'),(_details->>'_order_id')::uuid,lines,owner_id,coalesce(_details->>'_priority','normal'),_details->>'_title',_details->>'_question',(_details->>'_due_at')::timestamptz,_details->>'_task_tag',(_details->>'_refund_amount')::numeric,coalesce(_details->>'_task_scope','order'),groups,numbers,_details->>'_signed_by_email') t;
 else raise exception 'Invalid task source' using errcode='22023';end case;
 perform set_config('invsto.task_request_kind',previous,true);
 return result;
end $$;
revoke all on function public.create_task_request(text,text,jsonb) from public,anon,authenticated;
grant execute on function public.create_task_request(text,text,jsonb) to authenticated;

-- The recipient of an explicit decision need not be an administrator. Completed
-- work still goes to a different reviewer; metadata cannot approve one's own work.
create or replace function public.task_workflow_reviewer(t jsonb) returns uuid
language sql stable security definer set search_path='' as $$
 select e.user_id from public.employees e
 where e.active is true and e.user_id is not null
 and ((t->>'status'<>'completed_by_employee' and (e.role='admin' or t#>>'{metadata,request_kind}'='decision') and e.user_id=(t->>'assigned_to_user_id')::uuid)
 or (e.user_id is distinct from (t->>'assigned_to_user_id')::uuid
 and (e.user_id in ((t->>'assigned_by')::uuid,(t->>'created_by')::uuid) or e.role='admin')
 and (t->>'status'='completed_by_employee' or e.role='admin')))
 order by case when e.user_id=(t->>'assigned_to_user_id')::uuid then 0 when e.user_id=(t->>'assigned_by')::uuid then 1 when e.user_id=(t->>'created_by')::uuid then 2 else 3 end,e.user_id limit 1
$$;

-- An update never changes responsibility. Explicit Work/Decision handoffs reuse
-- the existing participant checks, assignment audit, followers and notification.
create function public.respond_task_request(_source text,_task_id uuid,_note text,_mode text,
 _expected_assignee uuid,_expected_assigner uuid,_expected_updated_at timestamptz,_photos jsonb default '[]')
returns jsonb language plpgsql security definer set search_path='' as $$
declare tbl text; evt text; t jsonb; result jsonb; next_task jsonb;
begin
 if _mode is null or _mode not in ('update','work','decision') then raise exception 'Invalid next step' using errcode='22023';end if;
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Active staff access required' using errcode='42501';end if;
 if jsonb_typeof(_photos) is distinct from 'array' or jsonb_array_length(_photos)>30 then raise exception 'Invalid evidence attachments' using errcode='22023';end if;
 case _source when 'team' then tbl:='team_tasks';evt:='team_task_events';when 'order' then tbl:='ebay_order_tasks';evt:='ebay_order_task_events';when 'return' then tbl:='ebay_return_tasks';evt:='ebay_return_task_events';else raise exception 'Invalid task source' using errcode='22023';end case;
 execute format('select to_jsonb(t) from public.%I t where id=$1 for update',tbl) into t using _task_id;
 if t is null then raise exception 'Task not found' using errcode='P0002';end if;
 if (t->>'updated_at')::timestamptz is distinct from _expected_updated_at then raise exception 'This task changed. Refresh it before taking the next step.' using errcode='40001';end if;
 result:=public.reply_to_task(_source,_task_id,_note,_mode<>'update',_expected_assignee,_expected_assigner);
 if _mode<>'update' then
  execute format('update public.%I set metadata=coalesce(metadata,''{}'')||jsonb_build_object(''request_kind'',$2) where id=$1 returning to_jsonb(%I)',tbl,tbl) into next_task using _task_id,_mode;
  result:=jsonb_set(result,'{task}',next_task);
 end if;
 execute format('update public.%I set photo_attachments=$2,payload=coalesce(payload,''{}'')||jsonb_build_object(''request_kind'',$3,''photo_attachments'',$2) where id=$1',evt)
 using (result->>'event_id')::uuid,_photos,case when _mode='update' then t#>>'{metadata,request_kind}' else _mode end;
 return result;
end $$;
revoke all on function public.respond_task_request(text,uuid,text,text,uuid,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.respond_task_request(text,uuid,text,text,uuid,uuid,timestamptz,jsonb) to authenticated;

-- The completion/acceptance function below is replaced without touching tasks.

create or replace function public.advance_task_workflow(
 _source text,_task_id uuid,_action text,_note text,_expected_status text,
 _expected_assignee uuid,_expected_updated_at timestamptz,_photos jsonb default '[]'
) returns jsonb language plpgsql security definer set search_path='' as $$
declare tbl text; evt text; t jsonb; result jsonb; actor public.employees; recipient public.employees;
 reviewer_id uuid; next_status text; v_event_id uuid; note text:=nullif(btrim(_note),''); workflow jsonb; notify_id uuid;
begin
 if auth.uid() is null or not public.can_manage_inventory() then raise exception 'Active staff access required' using errcode='42501';end if;
 select * into actor from public.employees where user_id=auth.uid() and active is true limit 1;
 if not found then raise exception 'Active employee not found' using errcode='42501';end if;
 if note is null or length(note)>10000 then raise exception 'Describe the next step (up to 10,000 characters)' using errcode='22023';end if;
 if jsonb_typeof(_photos) is distinct from 'array' or jsonb_array_length(_photos)>30 then raise exception 'Invalid evidence attachments' using errcode='22023';end if;
 case _source when 'team' then tbl:='team_tasks';evt:='team_task_events';
 when 'order' then tbl:='ebay_order_tasks';evt:='ebay_order_task_events';
 when 'return' then tbl:='ebay_return_tasks';evt:='ebay_return_task_events';
 else raise exception 'Invalid task source' using errcode='22023';end case;
 execute format('select to_jsonb(t) from public.%I t where id=$1 for update',tbl) into t using _task_id;
 if t is null then raise exception 'Task not found' using errcode='P0002';end if;
 if t->>'status' is distinct from _expected_status or (t->>'assigned_to_user_id')::uuid is distinct from _expected_assignee
 or (t->>'updated_at')::timestamptz is distinct from _expected_updated_at then
 raise exception 'This task changed. Refresh it before taking the next step.' using errcode='40001';end if;
 workflow:=coalesce(t#>'{metadata,task_workflow}','{}');
 if _action='decide' then
  if (t->>'assigned_to_user_id')::uuid is distinct from auth.uid() or public.task_workflow_reviewer(t) is distinct from auth.uid() then raise exception 'Only the responsible person can record this decision' using errcode='42501';end if;
  if not coalesce(t#>>'{metadata,request_kind}'='decision' or t->>'status'='waiting_on_admin',false)
   or t->>'status' not in ('open','assigned','in_progress','waiting_on_admin','waiting_on_worker','blocked','deferred','sent_back_for_rework')
   or t->>'task_type' in ('pending_admin_review','pending_shipping','pending_packaging','pending_subtask') then raise exception 'Use this task''s work, review or shipping action' using errcode='22023';end if;
  next_status:='resolved';notify_id:=coalesce((t->>'assigned_by')::uuid,(t->>'created_by')::uuid);
  workflow:=workflow||jsonb_build_object('decision_by',auth.uid(),'decision_at',now(),'decision','decide');
 elsif _action='complete' then
  if t#>>'{metadata,request_kind}'='decision' then raise exception 'Record the decision or send instructions back' using errcode='22023';end if;
  if (t->>'assigned_to_user_id')::uuid is distinct from auth.uid() then raise exception 'Only the responsible person can complete their part' using errcode='42501';end if;
  if t->>'status' not in ('open','assigned','in_progress','waiting_on_admin','waiting_on_worker','blocked','deferred','sent_back_for_rework','needs_subtasks','pending_admin_review')
   or t->>'task_type' in ('pending_shipping','pending_packaging') then raise exception 'Use this task''s review or shipping action' using errcode='22023';end if;
  workflow:=jsonb_build_object('completed_by',auth.uid(),'completed_at',now());
  reviewer_id:=public.task_workflow_reviewer(jsonb_set(t,'{status}','"completed_by_employee"'::jsonb));
  if reviewer_id is null then raise exception 'No active reviewer is available. Ask an admin to assign a reviewer.' using errcode='22023';end if;
  workflow:=workflow||jsonb_build_object('reviewer_user_id',reviewer_id);
  next_status:='completed_by_employee';notify_id:=reviewer_id;
 elsif _action in ('accept','return') then
  if t->>'status'<>'completed_by_employee' and not (_action='return' and t->>'status' in ('waiting_on_admin','pending_admin_review')) then raise exception 'This task is not awaiting acceptance' using errcode='22023';end if;
  reviewer_id:=public.task_workflow_reviewer(t);
  if reviewer_id is distinct from auth.uid() then raise exception 'Only the next reviewer can make this decision' using errcode='42501';end if;
  next_status:=case when _action='return' then 'sent_back_for_rework' when _source='order' and t->>'task_type'='pending_subtask' then 'approved_by_admin' else 'resolved' end;
  workflow:=workflow||jsonb_build_object('reviewer_user_id',reviewer_id,'reviewed_at',now(),'decision',_action);
  notify_id:=(t->>'assigned_to_user_id')::uuid;
 else raise exception 'Invalid task action' using errcode='22023';end if;
 -- Never update ebay_orders, fulfillment, labels, or return-case status here.
 execute format('update public.%I set status=$2,latest_note=$3,metadata=coalesce(metadata,''{}''::jsonb)||jsonb_build_object(''task_workflow'',$4)||case when $7=''return'' then jsonb_build_object(''request_kind'',''work'') else ''{}''::jsonb end,
 assigned_by=case when $7=''return'' then $5 else assigned_by end,assigned_by_email=case when $7=''return'' then $6 else assigned_by_email end,
 resolved_at=case when $2 in (''resolved'',''approved_by_admin'') then now() else null end,
 resolved_by=case when $2 in (''resolved'',''approved_by_admin'') then $5 else null end,
 resolved_by_email=case when $2 in (''resolved'',''approved_by_admin'') then $6 else null end,
 resolution_notes=$3,updated_at=now() where id=$1 returning to_jsonb(%I)',tbl,tbl)
 into result using _task_id,next_status,note,workflow,auth.uid(),actor.email,_action;
 execute format('insert into public.%I(task_id,action,old_status,new_status,old_assigned_to_user_id,new_assigned_to_user_id,notes,signed_by,signed_by_email,payload%s%s)
 values($1,''status_changed'',$2,$3,$4,$4,$5,$6,$7,$8%s%s) returning id',evt,
 case _source when 'order' then ',order_id' when 'return' then ',return_case_id' else '' end,
 ',photo_attachments',
 case when _source='team' then '' else ',$9' end,',$10')
 into v_event_id using _task_id,t->>'status',next_status,(t->>'assigned_to_user_id')::uuid,note,auth.uid(),actor.email,
 jsonb_build_object('source','task_next_action','action',_action,'reviewer_user_id',reviewer_id,'photo_attachments',_photos),
 case _source when 'order' then (t->>'order_id')::uuid when 'return' then (t->>'return_case_id')::uuid else null::uuid end,_photos;
 if _source='order' and t->>'task_type'='pending_subtask' and t->>'parent_task_id' is not null then
  perform 1 from public.ebay_order_tasks where id=(t->>'parent_task_id')::uuid for update;
  update public.ebay_order_tasks set status=case when public.ebay_order_required_subtasks_complete((t->>'parent_task_id')::uuid) then 'ready_for_admin_approval' else 'waiting_on_subtasks' end
   where id=(t->>'parent_task_id')::uuid and status not in ('assigned_for_shipping','shipped_completed','closed','resolved','cancelled');
 end if;
 select * into recipient from public.employees where user_id=notify_id and active is true limit 1;
 if found and recipient.user_id<>auth.uid() and not exists(select 1 from public.task_notifications n where n.source=_source and n.task_id=_task_id and n.event_id=v_event_id and n.recipient_user_id=notify_id) then
  perform public.create_task_notification(recipient.user_id,recipient.email,_source,_task_id,(t->>'parent_task_id')::uuid,'task_progress_update',
   case _action when 'complete' then 'Ready for your acceptance: ' when 'return' then 'Your next step: ' when 'decide' then 'Decision recorded: ' else 'Task accepted: ' end||coalesce(t->>'title','Task'),
   left(note,500),t->>'priority',(t->>'due_at')::timestamptz,jsonb_build_object('source','task_next_action','action',_action),v_event_id,auth.uid(),actor.email);
 end if;
 return jsonb_build_object('task',result,'event_id',v_event_id);
end $$;
revoke all on function public.advance_task_workflow(text,uuid,text,text,text,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.advance_task_workflow(text,uuid,text,text,text,uuid,timestamptz,jsonb) to authenticated;


commit;
