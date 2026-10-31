begin;
set local lock_timeout='5s';
set local statement_timeout='60s';
alter table public.ebay_return_cases add column history_archived_at timestamptz,
 add column history_snapshot text, add column history_update_pending boolean not null default false;

-- Reuse the receiving, review and employee-work safeguards independently of
-- the provider outcome. A closed predecessor request may have a separate case.
create function public.customer_issue_history_work_block(c public.ebay_return_cases) returns text
language plpgsql stable security definer set search_path='' as $$
declare reason text:=c.raw_payload#>>'{ebayDetail,closeInfo,returnCloseReason}';
begin
 if c.synced_at is null or c.sync_error is not null or c.synced_at<now()-interval '24 hours' then return 'Refresh eBay status before archiving';end if;
 if exists(select 1 from public.customer_return_reviews where return_case_id=c.id and status in ('pending','changes_requested')) then return 'Final review is unfinished';end if;
 if c.status in ('needs_review','partially_received') then return 'Return inspection is unfinished';end if;
 if exists(select 1 from public.ebay_return_items where return_case_id=c.id and received_quantity>restocked_quantity
  and disposition not in ('received_no_restock','damaged','refund_only')) then return 'Returned items still need inspection';end if;
 if c.source_lane='return' and (public.customer_issue_return_stage(c.issue_kind,c.status,c.ebay_status,c.raw_payload) in ('delivered','in_transit')
  or (reason not in ('BUYER_NO_ACTION','REQUEST_DECLINED','RETURN_REJECTED','SHIPMENT_TIMEOUT') and c.raw_payload->>'physicalReturnExpected'='true'))
  and (not exists(select 1 from public.ebay_return_items where return_case_id=c.id)
   or exists(select 1 from public.ebay_return_items where return_case_id=c.id and expected_quantity>received_quantity and disposition<>'refund_only')) then return 'Return receipt is unfinished';end if;
 if exists(select 1 from public.ebay_return_tasks t where t.return_case_id=c.id and t.status not in ('resolved','cancelled','closed','approved_by_admin')
  and not public.customer_issue_obsolete_monitor(t)) then return 'Internal work is unfinished';end if;
 return null;
end $$;

create function public.customer_issue_manual_history_record(c public.ebay_return_cases) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare outcome text:=public.customer_issue_final_outcome(to_jsonb(c));blocked text;related public.ebay_return_cases;
begin
 blocked:=public.customer_issue_history_work_block(c);
 if outcome='open' then blocked:='Still open on eBay';
 elsif outcome='unfinished' then blocked:='Refund, appeal or eBay follow-up is unfinished';
 elsif outcome='unknown' then blocked:='Final outcome needs verification';end if;
 if outcome='escalated' then
  select * into related from public.ebay_return_cases r where r.id<>c.id and r.source_lane='case'
   and ((c.source_lane='inquiry' and r.ebay_return_id=c.ebay_return_id)
    or (c.source_lane='return' and r.raw_payload#>>'{ebayDetail,returnId}'=c.ebay_return_id))
   order by r.opened_at desc,r.id limit 1;
  if not found then blocked:='Link the escalated eBay case before archiving this request';
  end if;
 end if;
 if public.customer_issue_return_refund(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload) in ('pending','failed') then blocked:='The refund is unfinished';end if;
 return jsonb_build_object('allowed',blocked is null,'reason',blocked,'related_case_id',related.id,
  'related_case_number',related.ebay_return_id,'predecessor',related.id is not null,'accept_decision',outcome='against_us');
end $$;

-- An issue consists only of records linked by eBay's case/request IDs, never
-- every case belonging to the same buyer or order.
create function public.customer_issue_history_family(_case_id uuid) returns setof uuid
language sql stable security definer set search_path='' as $$
 with root as (select * from public.ebay_return_cases where id=_case_id), cases as (
  select r.* from public.ebay_return_cases r,root c where r.source_lane='case' and (r.id=c.id
   or (c.source_lane='inquiry' and r.ebay_return_id=c.ebay_return_id)
   or (c.source_lane='return' and r.raw_payload#>>'{ebayDetail,returnId}'=c.ebay_return_id)))
 select id from root union select id from cases union select r.id from public.ebay_return_cases r,cases c
 where (r.source_lane='inquiry' and r.ebay_return_id=c.ebay_return_id)
  or (r.source_lane='return' and r.ebay_return_id=c.raw_payload#>>'{ebayDetail,returnId}')
$$;

create function public.customer_issue_manual_history_check(c public.ebay_return_cases) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.ebay_return_cases;checked jsonb;blocked text;accept_decision boolean:=false;versions jsonb:='[]';base jsonb;
begin
 base:=public.customer_issue_manual_history_record(c);
 for r in select * from public.ebay_return_cases where id in (select public.customer_issue_history_family(c.id)) order by id loop
  checked:=public.customer_issue_manual_history_record(r);
  if checked->>'allowed' is distinct from 'true' then blocked:=coalesce(blocked,checked->>'reason');end if;
  accept_decision:=accept_decision or coalesce((checked->>'accept_decision')::boolean,false);
  versions:=versions||jsonb_build_array(jsonb_build_object('id',r.id,'updated_at',r.updated_at));
 end loop;
 return base||jsonb_build_object('allowed',blocked is null,'reason',blocked,'accept_decision',accept_decision,'cases',versions,'case_count',jsonb_array_length(versions));
end $$;

-- Stable provider facts and actual case work, never the time of a routine poll.
-- A changed closed outcome/message still merits review even if it stays CLOSED.
create function public.customer_issue_history_snapshot(c public.ebay_return_cases) returns text
language sql stable security definer set search_path='' as $$
 select md5(jsonb_build_object('status',c.ebay_status,'action',c.ebay_action,'due',c.ebay_due_at,
  'detail',coalesce(c.raw_payload->'ebayDetail','{}')-array['__fingerprint','__ogIssueLane'],
  'summary',coalesce(c.raw_payload->'ebaySummary','{}')-array['__fingerprint','__ogIssueLane'],
  'messages',(select jsonb_agg(jsonb_build_array(direction,message_body,sent_at) order by sent_at,direction,message_body) from public.ebay_return_messages where return_case_id=c.id),
  'tasks',(select jsonb_agg(jsonb_build_array(id,status,assigned_to_user_id,assigned_by,created_by,due_at,latest_note,resolution_notes) order by id) from public.ebay_return_tasks where return_case_id=c.id),
  'items',(select jsonb_agg(jsonb_build_array(id,expected_quantity,received_quantity,restocked_quantity,disposition) order by id) from public.ebay_return_items where return_case_id=c.id),
  'review',(select jsonb_build_array(status,version) from public.customer_return_reviews where return_case_id=c.id))::text)
$$;

create function public.reopen_customer_issue_for_update(_case_id uuid,_reason text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;
begin
 select * into c from public.ebay_return_cases where id=_case_id for update;
 if not found or c.history_archived_at is null or c.history_update_pending then return;end if;
 update public.ebay_return_cases set status='open',closed_at=null,history_update_pending=true,updated_at=now() where id=c.id;
 insert into public.ebay_return_events(return_case_id,order_id,action,notes,payload)
 values(c.id,c.order_id,'admin_override','Returned from History: '||_reason,
  jsonb_build_object('source','customer_issue_history_update','previous_status',c.status,'archived_at',c.history_archived_at));
end $$;

create function public.send_customer_issue_to_history(_case_id uuid,_expected_cases jsonb,_accept_decision boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;t public.ebay_return_tasks;check_result jsonb;case_ids uuid[];versions jsonb;expected jsonb;archived jsonb:='[]';
begin
 if auth.uid() is null or not coalesce(public.is_admin(),false) or not coalesce(public.can_access_post_order_issues(),false)
 then raise exception 'Administrator access required' using errcode='42501';end if;
 select array_agg(id order by id) into case_ids from public.ebay_return_cases where id in (select public.customer_issue_history_family(_case_id));
 perform 1 from public.ebay_return_cases where id=any(case_ids) order by id for update;
 select * into c from public.ebay_return_cases where id=_case_id;
 if not found then raise exception 'Case not found';end if;
 perform 1 from public.ebay_return_tasks where return_case_id=any(case_ids) order by id for update;
 perform 1 from public.ebay_return_items where return_case_id=any(case_ids) order by id for update;
 perform 1 from public.customer_return_reviews where return_case_id=any(case_ids) order by return_case_id for update;
 check_result:=public.customer_issue_manual_history_check(c);
 versions:=check_result->'cases';
 if jsonb_typeof(_expected_cases) is distinct from 'array' then raise exception 'Refresh this issue before archiving';end if;
 select jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at) order by id) into expected from jsonb_to_recordset(_expected_cases) x(id uuid,updated_at timestamptz);
 if expected is distinct from versions then raise exception 'This issue changed. Refresh it before sending it to History';end if;
 if check_result->>'allowed' is distinct from 'true' then raise exception '%',check_result->>'reason';end if;
 if check_result->>'accept_decision'='true' and _accept_decision is distinct from true then raise exception 'Review and accept the decision before sending this issue to History';end if;
 for c in select * from public.ebay_return_cases where id=any(case_ids) order by id loop
 if c.status in ('closed','cancelled') and not exists(select 1 from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin')) then continue;end if;
 for t in select * from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin') order by id loop
  update public.ebay_return_tasks set status='cancelled',updated_at=now(),resolved_at=now(),
   resolution_notes='Closed eBay record sent to History; updates remain monitored.',
   metadata=coalesce(metadata,'{}')||jsonb_build_object('history_closeout',true) where id=t.id;
  insert into public.ebay_return_task_events(task_id,return_case_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload)
  values(t.id,c.id,'cancelled',t.status,'cancelled','Monitoring record sent to History; employee work was not changed.',auth.uid(),auth.jwt()->>'email',
   jsonb_build_object('source','customer_issue_manual_history','previous_task',to_jsonb(t)));
 end loop;
 update public.ebay_return_cases set status='closed',closed_at=coalesce(closed_at,now()),history_managed=true,
  history_archived_at=now(),history_snapshot=public.customer_issue_history_snapshot(c),history_update_pending=false,updated_at=now() where id=c.id;
 insert into public.ebay_return_events(return_case_id,order_id,action,notes,signed_by,signed_by_email,payload)
 values(c.id,c.order_id,'closed',case when _accept_decision then 'Decision reviewed and accepted as fair. ' else '' end||'Sent to History. New eBay activity or case work brings this record back for review.',auth.uid(),auth.jwt()->>'email',
  jsonb_build_object('source','customer_issue_manual_history','previous_status',c.status,'ebay_status',c.ebay_status,
   'issue_case_ids',case_ids,'decision_accepted_as_fair',_accept_decision,'inventory_changed',false));
 archived:=archived||jsonb_build_array(c.id);
 end loop;
 return jsonb_build_object('id',_case_id,'archived_ids',archived,'archived',jsonb_array_length(archived));
end $$;

-- Add per-case affordances to the existing queue preview, including blocked
-- reasons. Automatic cleanup keeps its stricter finalized-only criteria.
do $$ declare src text;begin
 src:=pg_get_functiondef('public.customer_issue_history_preview()'::regprocedure);
 src:=replace(src,'public.customer_issue_history_block(case_record) reason from active',
  'public.customer_issue_history_block(case_record) reason,public.customer_issue_manual_history_check(case_record) manual,(case_record).history_update_pending update_pending from active');
 src:=replace(src,'''ready'',reason is null,''reason'',reason)', '''ready'',reason is null,''reason'',reason,''manual'',manual,''update_pending'',update_pending)');
 if strpos(src,'''manual'',manual')=0 then raise exception 'History preview extension failed';end if;
 execute src;

 src:=pg_get_functiondef('public.archive_finalized_customer_issue_internal(uuid,boolean)'::regprocedure);
 src:=replace(src,'blocked:=public.customer_issue_history_block(c);',
  'if _automatic and c.history_archived_at is not null and c.history_snapshot is distinct from public.customer_issue_history_snapshot(c) then
    perform public.reopen_customer_issue_for_update(c.id,''New eBay information or case work'');
    return jsonb_build_object(''id'',c.id,''archived'',false,''reason'',''New update needs review'');
   end if;
   if _automatic and (c.history_update_pending or (c.history_archived_at is not null and not active)) then
    return jsonb_build_object(''id'',c.id,''archived'',false,''reason'',''Monitoring the saved case'');
   end if;
   blocked:=public.customer_issue_history_block(c);');
 src:=replace(src,'history_managed=true,updated_at=stamp','history_managed=true,history_update_pending=false,history_archived_at=now(),history_snapshot=public.customer_issue_history_snapshot(c),updated_at=stamp');
 src:=replace(src,'history_managed=true,updated_at=now()', 'history_managed=true,history_update_pending=false,history_archived_at=now(),history_snapshot=public.customer_issue_history_snapshot(c),updated_at=now()');
 if strpos(src,'New update needs review')=0 or strpos(src,'history_snapshot=public.customer_issue_history_snapshot(c)')=0 then raise exception 'History monitoring extension failed';end if;
 execute src;
end $$;

create function public.customer_issue_history_message_update() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if new.direction in ('inbound','internal') and exists(select 1 from public.ebay_return_cases c where c.id=new.return_case_id
  and c.history_archived_at is not null and new.sent_at>c.history_archived_at) then
  perform public.reopen_customer_issue_for_update(new.return_case_id,'New case message');
 end if;
 return new;
end $$;
create trigger customer_issue_history_message_update after insert on public.ebay_return_messages for each row execute function public.customer_issue_history_message_update();

-- Establish a baseline for the cases safely archived by the previous release.
update public.ebay_return_cases c set history_archived_at=coalesce(c.closed_at,now()),history_snapshot=public.customer_issue_history_snapshot(c)
 where c.history_managed and c.status in ('closed','cancelled');

revoke all on function public.customer_issue_history_work_block(public.ebay_return_cases),public.customer_issue_manual_history_record(public.ebay_return_cases),public.customer_issue_history_family(uuid),public.customer_issue_manual_history_check(public.ebay_return_cases),
 public.customer_issue_history_snapshot(public.ebay_return_cases),public.reopen_customer_issue_for_update(uuid,text),
 public.send_customer_issue_to_history(uuid,jsonb,boolean),public.customer_issue_history_message_update() from public,anon,authenticated;
grant execute on function public.send_customer_issue_to_history(uuid,jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
