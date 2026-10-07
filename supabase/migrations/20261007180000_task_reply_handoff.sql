begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Staff may return their own active work to its assigner. Arbitrary worker
-- reassignment remains forbidden; both identity and the next-step note matter.
create or replace function public.prevent_non_admin_task_reassignment()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if old.assigned_to_user_id is distinct from new.assigned_to_user_id and not public.is_admin() then
  if not coalesce(public.can_manage_inventory() and auth.uid()=old.assigned_to_user_id
   and new.assigned_to_user_id=coalesce(old.assigned_by,old.created_by)
   and new.assigned_to_user_id<>auth.uid() and new.assigned_by=auth.uid()
   and old.status in ('open','assigned','in_progress','waiting_on_admin','waiting_on_worker','blocked','deferred','sent_back_for_rework','needs_subtasks','waiting_on_subtasks')
   and new.status='assigned' and nullif(btrim(new.latest_note),'') is not null
   and exists(select 1 from public.employees e where e.user_id=new.assigned_to_user_id and e.active is true
    and e.id=new.assigned_to_employee_id and e.email is not distinct from new.assigned_to_email),false) then
   raise exception 'Only admins can reassign tasks; use Reply to return your task to its assigner' using errcode='42501';
  end if;
 end if;
 return new;
end $$;

create function public.reply_to_task(
 _task_source text,_task_id uuid,_note text,_request_action boolean default false,
 _expected_assignee uuid default null,_expected_assigner uuid default null
) returns jsonb language plpgsql security definer set search_path='' as $$
declare task_table text; event_table text; t jsonb; actor public.employees; recipient public.employees;
 owner_id uuid; assigner_id uuid; new_status text; reply_event_id uuid; reply_note text:=nullif(btrim(_note),'');
 payload jsonb; result jsonb;
begin
 if auth.uid() is null or not public.can_manage_inventory() then
  raise exception 'Active staff access required' using errcode='42501';end if;
 select * into actor from public.employees where user_id=auth.uid() and active is true limit 1;
 if not found then raise exception 'Active employee not found' using errcode='42501';end if;
 if reply_note is null or length(reply_note)>10000 then
  raise exception 'Write an update or explain the next step (up to 10,000 characters)' using errcode='22023';end if;
 case _task_source
  when 'team' then task_table:='team_tasks';event_table:='team_task_events';
  when 'order' then task_table:='ebay_order_tasks';event_table:='ebay_order_task_events';
  when 'return' then task_table:='ebay_return_tasks';event_table:='ebay_return_task_events';
  else raise exception 'Invalid task source' using errcode='22023';
 end case;
 execute format('select to_jsonb(t) from public.%I t where id=$1 for update',task_table) into t using _task_id;
 if t is null then raise exception 'Task not found' using errcode='P0002';end if;
 owner_id:=(t->>'assigned_to_user_id')::uuid;
 assigner_id:=coalesce((t->>'assigned_by')::uuid,(t->>'created_by')::uuid);
 if not coalesce(public.is_admin() or auth.uid()=owner_id or auth.uid()=assigner_id or auth.uid()=(t->>'created_by')::uuid,false) then
  raise exception 'Only task participants can reply' using errcode='42501';end if;
 if t->>'status' in ('resolved','cancelled','shipped_completed','closed','approved_by_admin')
  or t->>'resolved_at' is not null then raise exception 'This task is closed. Refresh your tasks.' using errcode='22023';end if;
 if owner_id is distinct from _expected_assignee or assigner_id is distinct from _expected_assigner then
  raise exception 'The assignment changed. Refresh the task before replying.' using errcode='40001';end if;
 new_status:=t->>'status';
 if coalesce(_request_action,false) then
  if owner_id is distinct from auth.uid() then raise exception 'Only the current assignee can hand this task back' using errcode='42501';end if;
  if assigner_id is null or assigner_id=owner_id then raise exception 'This task has no different assigner to hand it back to' using errcode='22023';end if;
  if new_status not in ('open','assigned','in_progress','waiting_on_admin','waiting_on_worker','blocked','deferred','sent_back_for_rework','needs_subtasks','waiting_on_subtasks') then
   raise exception 'Use the approval controls for completed work; you can still add an update' using errcode='22023';end if;
  select * into recipient from public.employees where user_id=assigner_id and active is true limit 1;
  if not found then raise exception 'The assigner is inactive. Ask an admin to reassign this task.' using errcode='22023';end if;
  new_status:='assigned';
  execute format('update public.%I set assigned_to_user_id=$2,assigned_to_employee_id=$3,assigned_to_email=$4,
   assigned_by=$5,assigned_by_email=$6,status=$7,latest_note=$8,updated_at=now()%s where id=$1 returning to_jsonb(%I)',
   task_table,case when _task_source='return' then '' else ',assigned_to_role=$9' end,task_table)
   into result using _task_id,recipient.user_id,recipient.id,recipient.email,auth.uid(),actor.email,new_status,reply_note,recipient.role;
 else
  -- A simple reply never changes status, ownership, dates, approvals or evidence.
  execute format('update public.%I set latest_note=$2,updated_at=now() where id=$1 returning to_jsonb(%I)',task_table,task_table)
   into result using _task_id,reply_note;
 end if;
 payload:=jsonb_build_object('source','task_reply','response_kind',case when coalesce(_request_action,false) then 'handoff' else 'update' end,
  'previous_assignee',owner_id,'next_assignee',result->>'assigned_to_user_id',
  'next_assignee_email',result->>'assigned_to_email','previous_assigner',assigner_id);
 execute format('insert into public.%I(task_id,action,old_status,new_status,old_assigned_to_user_id,new_assigned_to_user_id,
  notes,signed_by,signed_by_email,payload%s) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10%s) returning id',event_table,
  case _task_source when 'order' then ',order_id' when 'return' then ',return_case_id' else '' end,
  case when _task_source='team' then '' else ',$11' end)
  into reply_event_id using _task_id,case when coalesce(_request_action,false) then 'assigned' else 'commented' end,
   t->>'status',new_status,owner_id,(result->>'assigned_to_user_id')::uuid,reply_note,auth.uid(),actor.email,payload,
   case _task_source when 'order' then (t->>'order_id')::uuid when 'return' then (t->>'return_case_id')::uuid else null::uuid end;
 -- Existing assignment triggers notify handoff recipients. For a plain reply,
 -- also cover waiting-on-admin and replies in the opposite direction, which
 -- the legacy progress triggers skip. Do not duplicate a notification they made.
 if not coalesce(_request_action,false) then
  select * into recipient from public.employees where active is true
   and user_id=case when auth.uid()=owner_id then assigner_id else owner_id end limit 1;
  if found and recipient.user_id<>auth.uid() and not exists(select 1 from public.task_notifications n
   where n.source=_task_source and n.task_id=_task_id and n.event_id=reply_event_id and n.recipient_user_id=recipient.user_id) then
   perform public.create_task_notification(recipient.user_id,recipient.email,_task_source,_task_id,(t->>'parent_task_id')::uuid,
    'task_progress_update','Reply: '||coalesce(t->>'title','Task'),left(reply_note,500),t->>'priority',(t->>'due_at')::timestamptz,
    payload,reply_event_id,auth.uid(),actor.email);
  end if;
 end if;
 return jsonb_build_object('task',result,'event_id',reply_event_id,'handed_back',coalesce(_request_action,false));
end $$;
revoke all on function public.reply_to_task(text,uuid,text,boolean,uuid,uuid) from public,anon,authenticated;
grant execute on function public.reply_to_task(text,uuid,text,boolean,uuid,uuid) to authenticated;
commit;
