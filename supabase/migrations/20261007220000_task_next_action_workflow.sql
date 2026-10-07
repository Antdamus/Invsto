begin;
set local lock_timeout='2s';
set local statement_timeout='60s';

-- Keep previous participants following the same task through repeated handoffs.
-- Backfill this separate table, leaving task ownership, timestamps and orders alone.
create table public.task_followers (
 source text not null check(source in ('team','order','return')),
 task_id uuid not null, user_id uuid not null,
 primary key(user_id,source,task_id)
);
alter table public.task_followers enable row level security;
create policy task_followers_read on public.task_followers for select to authenticated
 using (public.can_manage_inventory() and (user_id=auth.uid() or public.is_admin()));
grant select on public.task_followers to authenticated;

create function public.task_workflow_reviewer(t jsonb) returns uuid
language sql stable security definer set search_path='' as $$
 select e.user_id from public.employees e
 where e.active is true and e.user_id is not null
 and ((t->>'status'<>'completed_by_employee' and e.role='admin' and e.user_id=(t->>'assigned_to_user_id')::uuid)
 or (e.user_id is distinct from (t->>'assigned_to_user_id')::uuid
 and (e.user_id in ((t->>'assigned_by')::uuid,(t->>'created_by')::uuid) or e.role='admin')
 and (t->>'status'='completed_by_employee' or e.role='admin')))
 order by case when e.user_id=(t->>'assigned_to_user_id')::uuid then 0 when e.user_id=(t->>'assigned_by')::uuid then 1 when e.user_id=(t->>'created_by')::uuid then 2 else 3 end,e.user_id
 limit 1
$$;
revoke all on function public.task_workflow_reviewer(jsonb) from public,anon,authenticated;

create function public.track_task_followers() returns trigger
language plpgsql security definer set search_path='' as $$
declare t jsonb:=to_jsonb(new); previous jsonb:='{}';
begin
 if tg_op='UPDATE' then previous:=to_jsonb(old);end if;
 insert into public.task_followers(source,task_id,user_id)
 select tg_argv[0],new.id,x::uuid from jsonb_array_elements_text(jsonb_build_array(
 t->>'assigned_to_user_id',t->>'assigned_by',t->>'created_by',t->>'resolved_by',t#>>'{metadata,task_workflow,reviewer_user_id}',
 previous->>'assigned_to_user_id',previous->>'assigned_by')) x where x is not null
 on conflict do nothing;
 return new;
end $$;

do $$ declare s text; tbl text; evt text;begin
 foreach s in array array['team','order','return'] loop
  tbl:=case s when 'team' then 'team_tasks' when 'order' then 'ebay_order_tasks' else 'ebay_return_tasks' end;
  evt:=case s when 'team' then 'team_task_events' when 'order' then 'ebay_order_task_events' else 'ebay_return_task_events' end;
  execute format('insert into public.task_followers select %L,id,p from public.%I t cross join lateral unnest(array[t.assigned_to_user_id,t.assigned_by,t.created_by,t.resolved_by]) p where p is not null on conflict do nothing',s,tbl);
  execute format('insert into public.task_followers select %L,task_id,p from public.%I e cross join lateral unnest(array[e.old_assigned_to_user_id,e.new_assigned_to_user_id]) p where p is not null on conflict do nothing',s,evt);
  execute format('create trigger track_task_followers after insert or update on public.%I for each row execute function public.track_task_followers(%L)',tbl,s);
 end loop;
end $$;
-- Following grants read access only; it never grants reassignment or approval.
create policy team_tasks_followers_read on public.team_tasks for select to authenticated
 using(public.can_manage_inventory() and exists(select 1 from public.task_followers f where f.source='team' and f.task_id=team_tasks.id and f.user_id=auth.uid()));
create policy team_task_events_followers_read on public.team_task_events for select to authenticated
 using(public.can_manage_inventory() and exists(select 1 from public.task_followers f where f.source='team' and f.task_id=team_task_events.task_id and f.user_id=auth.uid()));

create function public.list_followed_tasks(_viewer uuid,_history boolean default false)
returns table(source text,task_id uuid) language sql stable security invoker set search_path='' as $$
 select f.source,f.task_id from public.task_followers f
 join (select 'team' as source,id,status from public.team_tasks
 union all select 'order',id,status from public.ebay_order_tasks
 union all select 'return',id,status from public.ebay_return_tasks) t on t.source=f.source and t.id=f.task_id
 where f.user_id=_viewer and (_viewer=auth.uid() or public.is_admin()) and public.can_manage_inventory()
 and (t.status in ('resolved','cancelled','approved_by_admin','approved_for_shipping','shipped_completed','closed'))=_history
$$;
revoke all on function public.list_followed_tasks(uuid,boolean) from public,anon,authenticated;
grant execute on function public.list_followed_tasks(uuid,boolean) to authenticated;

alter table public.ebay_return_tasks drop constraint if exists ebay_return_tasks_status_check;
alter table public.ebay_return_tasks add constraint ebay_return_tasks_status_check
 check(status in ('open','assigned','in_progress','blocked','deferred','resolved','cancelled','completed_by_employee','sent_back_for_rework'));
alter table public.ebay_return_task_events add column if not exists photo_attachments jsonb not null default '[]';

-- Explicit transitions send one event-linked notification to the next actor.
-- Keep legacy clients' triggers, but do not let them also notify a former owner.
do $$ declare s text; tbl text; evt text; ready_fn text; progress_fn text;begin
 foreach s in array array['team','order','return'] loop
  tbl:=case s when 'team' then 'team_tasks' when 'order' then 'ebay_order_tasks' else 'ebay_return_tasks' end;
  evt:=case s when 'team' then 'team_task_events' when 'order' then 'ebay_order_task_events' else 'ebay_return_task_events' end;
  ready_fn:=case s when 'team' then 'notify_team_task_ready_for_review' when 'order' then 'notify_ebay_order_task_ready_for_review' else 'notify_ebay_return_task_ready_for_review' end;
  progress_fn:=case s when 'team' then 'notify_team_task_progress_to_owner' when 'order' then 'notify_ebay_order_task_progress_to_owner' else 'notify_ebay_return_task_progress_to_owner' end;
  execute format('drop trigger if exists %I on public.%I','trg_'||ready_fn,tbl);
  execute format('create trigger %I after update of status on public.%I for each row when (old.metadata->''task_workflow'' is not distinct from new.metadata->''task_workflow'') execute function public.%I()','trg_'||ready_fn,tbl,ready_fn);
  execute format('drop trigger if exists %I on public.%I','trg_'||progress_fn,evt);
  execute format('create trigger %I after insert on public.%I for each row when (new.payload->>''source'' is distinct from ''task_next_action'') execute function public.%I()','trg_'||progress_fn,evt,progress_fn);
 end loop;
end $$;

-- The new path notifies its named reviewer with the audited event. Older clients
-- still get a notification, directed to that reviewer instead of every admin.
create or replace function public.notify_admins_ebay_subtask_completed() returns trigger
language plpgsql security definer set search_path='' as $$
declare recipient public.employees;
begin
 if new.task_type<>'pending_subtask' or new.status<>'completed_by_employee' or old.status is not distinct from new.status
 or new.metadata#>>'{task_workflow,completed_at}' is distinct from old.metadata#>>'{task_workflow,completed_at}' then return new;end if;
 select * into recipient from public.employees where user_id=public.task_workflow_reviewer(to_jsonb(new)) and active is true limit 1;
 if found then perform public.create_task_notification(recipient.user_id,recipient.email,'order',new.id,new.parent_task_id,'subtask_completed',
 'Ready for your acceptance: '||new.title,coalesce(new.latest_note,''),new.priority,new.due_at,new.metadata,null,auth.uid(),null);end if;
 return new;
end $$;

-- One explicit completion / acceptance path. Reading an update is independent.
create function public.advance_task_workflow(
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
 if _action='complete' then
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
 execute format('update public.%I set status=$2,latest_note=$3,metadata=coalesce(metadata,''{}''::jsonb)||jsonb_build_object(''task_workflow'',$4),
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
   case _action when 'complete' then 'Ready for your acceptance: ' when 'return' then 'Your next step: ' else 'Task accepted: ' end||coalesce(t->>'title','Task'),
   left(note,500),t->>'priority',(t->>'due_at')::timestamptz,jsonb_build_object('source','task_next_action','action',_action),v_event_id,auth.uid(),actor.email);
 end if;
 return jsonb_build_object('task',result,'event_id',v_event_id);
end $$;
revoke all on function public.advance_task_workflow(text,uuid,text,text,text,uuid,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.advance_task_workflow(text,uuid,text,text,text,uuid,timestamptz,jsonb) to authenticated;

commit;
