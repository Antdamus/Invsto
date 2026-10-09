begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

alter table public.ebay_return_cases add column provider_action_required boolean,
 add column provider_action_key text, add column provider_action_version integer not null default 0;
alter table public.ebay_issue_sync_jobs add column failure_kind text;

create function public.customer_issue_requires_action(c jsonb) returns boolean
language sql immutable set search_path='' as $$
 select coalesce(c->>'ebay_status','') !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)'
 and case when c->>'source_lane'='payment_dispute' then c->>'ebay_status'='ACTION_NEEDED'
 else c->>'ebay_due_at' is not null or coalesce(c->>'ebay_action','') ~* 'SELLER|RESPOND|PROVIDE|ISSUE_REFUND' end
$$;

-- These are in-app alerts only; existing SMS/email allowlists do not include them.
alter table public.task_notifications drop constraint task_notifications_notification_type_check;
alter table public.task_notifications add constraint task_notifications_notification_type_check check(notification_type in (
 'task_assigned','subtask_assigned','shipment_assigned','packaging_assigned','return_task_assigned','subtask_completed',
 'task_progress_update','task_completed','task_ready_for_review','task_due_tomorrow','task_due_today','task_overdue_assignee','task_overdue_assigner',
 'customer_issue_action','customer_issue_deadline'));
create table public.customer_issue_alerts (
 case_id uuid not null references public.ebay_return_cases(id),recipient uuid not null,alert_key text not null,
 created_at timestamptz not null default now(),primary key(case_id,recipient,alert_key)
);
alter table public.customer_issue_alerts enable row level security;
revoke all on public.customer_issue_alerts from public,anon,authenticated;
grant select,insert on public.customer_issue_alerts to service_role;

-- New provider action tasks use the case alert below, not a second generic
-- assignment notification (which would also enqueue an SMS/email).
drop trigger trg_notify_ebay_return_task_assignment on public.ebay_return_tasks;
create trigger trg_notify_ebay_return_task_assignment after insert or update on public.ebay_return_tasks
 for each row when(new.metadata->>'source' is distinct from 'customer_issue_action') execute function public.notify_ebay_return_task_assignment();

create function public.notify_customer_issue(_case uuid,_task uuid,_key text,_type text,_title text,_body text) returns void
language plpgsql security definer set search_path='' as $$
declare t public.ebay_return_tasks; c public.ebay_return_cases; recipient public.employees;
begin
 select * into t from public.ebay_return_tasks where id=_task and return_case_id=_case;
 if not found then return;end if;
 select * into c from public.ebay_return_cases where id=_case;
 select * into recipient from public.employees where active and user_id=public.task_workflow_reviewer(to_jsonb(t)) limit 1;
 if not found then return;end if;
 insert into public.customer_issue_alerts values(c.id,recipient.user_id,_key,now()) on conflict do nothing;
 if not found then return;end if;
 perform public.create_task_notification(recipient.user_id,recipient.email,'return',t.id,null,_type,
 _title||coalesce(c.buyer_username,c.order_number,c.ebay_return_id),_body,'high',c.ebay_due_at,
 jsonb_build_object('case_id',c.id,'source','customer_issue_alert','action_version',c.provider_action_version),null,null,null);
end $$;

create function public.reconcile_customer_issue_action(_case uuid) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;t public.ebay_return_tasks; previous public.ebay_return_tasks;
 required boolean; sig text; changed boolean; reviewer uuid; outcome_changed boolean;
begin
 select * into c from public.ebay_return_cases where id=_case for update;
 if not found or c.synced_at is null or c.sync_error is not null then return;end if;
 required:=coalesce(public.customer_issue_requires_action(to_jsonb(c)),false);
 sig:=concat_ws('|',c.ebay_status,c.ebay_action,c.ebay_due_at::text);
 changed:=required and (c.provider_action_required is distinct from true or c.provider_action_key is distinct from sig);
 outcome_changed:=c.provider_action_key is not null and split_part(c.provider_action_key,'|',1) !~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)'
  and c.ebay_status ~* '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)';
 update public.ebay_return_cases set provider_action_required=required,provider_action_key=sig,
 provider_action_version=provider_action_version+case when changed then 1 else 0 end where id=c.id returning * into c;

 -- Only untouched, automatically imported monitoring tasks may be parked.
 -- Employee assignments, comments, review submissions and deadlines survive.
 if c.source_lane='payment_dispute' and c.ebay_status='OPEN' then
  for t in select * from public.ebay_return_tasks where return_case_id=c.id and task_type='return_review'
    and status='open' and assigned_to_user_id is null and assigned_by is null and created_by is null and due_at is null
    and metadata->>'source' in ('ebay_return_api','ebay_post_order_api')
    and not exists(select 1 from public.ebay_return_task_events e where e.task_id=ebay_return_tasks.id and (e.signed_by is not null or e.signed_by_email is not null))
    for update
  loop
   reviewer:=public.task_workflow_reviewer(to_jsonb(t));
   update public.ebay_return_tasks set status='deferred',metadata=metadata||jsonb_build_object('customer_issue_watch',true),updated_at=now() where id=t.id;
   if reviewer is not null then insert into public.task_followers values('return',t.id,reviewer) on conflict do nothing;end if;
   insert into public.ebay_return_task_events(task_id,return_case_id,action,old_status,new_status,notes,payload)
   values(t.id,c.id,'status_changed','open','deferred','Following eBay updates; eBay is not requesting a seller response.',jsonb_build_object('source','task_next_action','reason','provider_monitoring'));
  end loop;
 end if;

 if changed then
  select * into t from public.ebay_return_tasks where return_case_id=c.id and task_type='return_review'
   and status not in ('resolved','cancelled','closed','approved_by_admin','completed_by_employee') order by created_at desc limit 1 for update;
  if found then
   -- A provider event never replaces employee instructions or ownership.
   if t.status='deferred' and t.metadata->>'customer_issue_watch'='true' then
    update public.ebay_return_tasks set status='open',metadata=metadata||jsonb_build_object('customer_issue_watch',false,'provider_action_version',c.provider_action_version),updated_at=now() where id=t.id returning * into t;
   end if;
  else
   select * into previous from public.ebay_return_tasks where return_case_id=c.id and task_type='return_review' order by created_at desc limit 1;
   reviewer:=public.task_workflow_reviewer(coalesce(to_jsonb(previous),'{}'));
   insert into public.ebay_return_tasks(return_case_id,order_id,order_line_ids,task_type,title,question,status,priority,assigned_to_user_id,metadata)
   values(c.id,c.order_id,coalesce(previous.order_line_ids,'{}'),'return_review','New eBay response needed',
    'eBay requests a response. Review the current case and its response deadline. Earlier completed work remains in the history.',
    'open','high',reviewer,jsonb_build_object('request_kind','decision','source','customer_issue_action','provider_action_version',c.provider_action_version)) returning * into t;
  end if;
  insert into public.ebay_return_task_events(task_id,return_case_id,action,notes,payload)
  values(t.id,c.id,'commented','eBay requests a seller response. Check the current deadline before responding.',jsonb_build_object('source','task_next_action','reason','provider_action','version',c.provider_action_version));
  perform public.notify_customer_issue(c.id,t.id,'action:'||c.provider_action_version,'customer_issue_action','eBay response needed: ',
   'A new response is required. Open the case to review the deadline and evidence.');
 end if;

 if outcome_changed then
  for t in select * from public.ebay_return_tasks where return_case_id=c.id and status='deferred' and metadata->>'customer_issue_watch'='true' for update loop
   update public.ebay_return_tasks set status='open',metadata=metadata||jsonb_build_object('customer_issue_watch',false),updated_at=now() where id=t.id;
   perform public.notify_customer_issue(c.id,t.id,'outcome:'||sig,'customer_issue_action','eBay outcome ready: ','eBay closed the case. Review the outcome and finish any remaining internal follow-up.');
  end loop;
 end if;
end $$;

create function public.customer_issue_after_sync() returns trigger language plpgsql security definer set search_path='' as $$
begin perform public.reconcile_customer_issue_action(new.id);return new;end $$;
create trigger customer_issue_after_sync after update of synced_at on public.ebay_return_cases for each row
 when(new.synced_at is not null and new.sync_error is null) execute function public.customer_issue_after_sync();

create function public.follow_customer_issue(_task_id uuid,_expected_updated_at timestamptz,_note text) returns void
language plpgsql security definer set search_path='' as $$
declare t public.ebay_return_tasks;c public.ebay_return_cases;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 select * into t from public.ebay_return_tasks where id=_task_id for update;
 if not found or t.updated_at is distinct from _expected_updated_at then raise exception 'This task changed. Refresh before continuing.';end if;
 if not public.is_admin() and auth.uid() is distinct from public.task_workflow_reviewer(to_jsonb(t)) then raise exception 'Only the reviewer may follow this case' using errcode='42501';end if;
 select * into c from public.ebay_return_cases where id=t.return_case_id;
 if t.task_type<>'return_review' or t.status in ('resolved','cancelled','completed_by_employee') or c.ebay_status is distinct from 'OPEN' or c.source_lane<>'payment_dispute'
  or c.sync_error is not null or c.synced_at is null or c.synced_at<now()-interval '30 minutes' then raise exception 'Refresh the case. Only a current payment dispute waiting on eBay may be followed.';end if;
 if nullif(btrim(_note),'') is null then raise exception 'Add your review note';end if;
 update public.ebay_return_tasks set status='deferred',due_at=null,metadata=metadata||jsonb_build_object('customer_issue_watch',true,'previous_follow_up',due_at),latest_note=_note,updated_at=now() where id=t.id;
 insert into public.task_followers values('return',t.id,auth.uid()) on conflict do nothing;
 insert into public.ebay_return_task_events(task_id,return_case_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload)
 values(t.id,c.id,'status_changed',t.status,'deferred',_note,auth.uid(),auth.jwt()->>'email',jsonb_build_object('source','task_next_action','reason','reviewed_and_following'));
end $$;

create function public.enqueue_customer_issue_deadlines(_now timestamptz default now()) returns int
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;t public.ebay_return_tasks;stage text;counted int:=0;
begin
 for c in select * from public.ebay_return_cases where provider_action_required is true
  and ebay_due_at<=_now+interval '48 hours' and public.customer_issue_requires_action(to_jsonb(ebay_return_cases))
 loop
  stage:=case when c.ebay_due_at<=_now then 'overdue' when c.ebay_due_at<=_now+interval '4 hours' then '4h' when c.ebay_due_at<=_now+interval '24 hours' then '24h' else '48h' end;
  select * into t from public.ebay_return_tasks where return_case_id=c.id and task_type='return_review' order by
   (status not in ('resolved','cancelled','closed','approved_by_admin')) desc,created_at desc limit 1;
  if not found then continue;end if;
  perform public.notify_customer_issue(c.id,t.id,concat_ws(':','deadline',c.provider_action_version,c.ebay_due_at::text,stage),
   'customer_issue_deadline',case when stage='overdue' then 'eBay response overdue: ' else 'eBay response due soon: ' end,
   'eBay response deadline: '||to_char(c.ebay_due_at at time zone 'America/New_York','Mon DD, YYYY HH12:MI AM')||' America/New_York. This is separate from the employee task due date.'||
   case when c.sync_error is not null or c.synced_at<_now-interval '30 minutes' then ' Case information needs a refresh; verify the current status on eBay.' else '' end);
  counted:=counted+1;
 end loop;
 return counted;
end $$;

create function public.finish_customer_issue_review(_task_id uuid,_expected_updated_at timestamptz,_note text,_photos jsonb default '[]') returns void
language plpgsql security definer set search_path='' as $$
declare t public.ebay_return_tasks;
begin
 if auth.uid() is null or not public.can_access_post_order_issues() then raise exception 'Customer issues access required' using errcode='42501';end if;
 select * into t from public.ebay_return_tasks where id=_task_id for update;
 if not found or t.updated_at is distinct from _expected_updated_at then raise exception 'This task changed. Refresh before continuing.';end if;
 if t.assigned_to_user_id is not null or t.task_type<>'return_review' or t.status not in ('open','in_progress','blocked','deferred')
  or public.task_workflow_reviewer(to_jsonb(t)) is distinct from auth.uid() then raise exception 'Only the current reviewer may finish this review' using errcode='42501';end if;
 if nullif(btrim(_note),'') is null or length(_note)>10000 then raise exception 'Describe the review outcome';end if;
 if jsonb_typeof(_photos) is distinct from 'array' or jsonb_array_length(_photos)>30 then raise exception 'Invalid review attachments';end if;
 update public.ebay_return_tasks set status='resolved',resolution_notes=_note,latest_note=_note,resolved_at=now(),resolved_by=auth.uid(),resolved_by_email=auth.jwt()->>'email',updated_at=now() where id=t.id;
 insert into public.task_followers values('return',t.id,auth.uid()) on conflict do nothing;
 insert into public.ebay_return_task_events(task_id,return_case_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload,photo_attachments)
 values(t.id,t.return_case_id,'status_changed',t.status,'resolved',_note,auth.uid(),auth.jwt()->>'email',jsonb_build_object('source','task_next_action','reason','review_completed'),_photos);
end $$;

revoke all on function public.notify_customer_issue(uuid,uuid,text,text,text,text),public.reconcile_customer_issue_action(uuid),public.customer_issue_after_sync(),public.enqueue_customer_issue_deadlines(timestamptz) from public,anon,authenticated;
grant execute on function public.reconcile_customer_issue_action(uuid),public.enqueue_customer_issue_deadlines(timestamptz) to service_role;
revoke all on function public.follow_customer_issue(uuid,timestamptz,text) from public,anon;
grant execute on function public.follow_customer_issue(uuid,timestamptz,text) to authenticated;
revoke all on function public.finish_customer_issue_review(uuid,timestamptz,text,jsonb) from public,anon;
grant execute on function public.finish_customer_issue_review(uuid,timestamptz,text,jsonb) to authenticated;

-- Backfill the new state using successful observations only; never resolve work.
-- Establish a baseline first, so installing the migration does not reopen an
-- already completed review of an unchanged eBay response request.
update public.ebay_return_cases set provider_action_required=coalesce(public.customer_issue_requires_action(to_jsonb(ebay_return_cases)),false),
 provider_action_key=concat_ws('|',ebay_status,ebay_action,ebay_due_at::text),provider_action_version=1 where synced_at is not null;
do $$ declare r record;begin
 for r in select id from public.ebay_return_cases where synced_at>now()-interval '30 minutes' and sync_error is null and status not in ('closed','cancelled') loop
  perform public.reconcile_customer_issue_action(r.id);
 end loop;
end $$;
commit;
