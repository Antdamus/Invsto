begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- The administrator may retire issue follow-ups when accepting a finalized
-- decision. Automatic cleanup keeps its existing employee-work safeguards.
create or replace function public.customer_issue_manual_history_record(c public.ebay_return_cases) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare outcome text:=public.customer_issue_final_outcome(to_jsonb(c));blocked text;related public.ebay_return_cases;
begin
 blocked:=public.customer_issue_history_work_block(c);
 if blocked='Internal work is unfinished' then blocked:=null;end if;
 if outcome='open' then blocked:='Still open on eBay';
 elsif outcome='unfinished' then blocked:='Refund, appeal or eBay follow-up is unfinished';
 elsif outcome='unknown' then blocked:='Final outcome needs verification';end if;
 if outcome='escalated' then
  select * into related from public.ebay_return_cases r where r.id<>c.id and r.source_lane='case'
   and ((c.source_lane='inquiry' and r.ebay_return_id=c.ebay_return_id)
    or (c.source_lane='return' and r.raw_payload#>>'{ebayDetail,returnId}'=c.ebay_return_id))
   order by r.opened_at desc,r.id limit 1;
  if not found then blocked:='Link the escalated eBay case before archiving this request';end if;
 end if;
 if public.customer_issue_return_refund(c.source_lane,c.ebay_return_id,c.ebay_status,c.raw_payload) in ('pending','failed') then blocked:='The refund is unfinished';end if;
 return jsonb_build_object('allowed',blocked is null,'reason',blocked,'related_case_id',related.id,
  'related_case_number',related.ebay_return_id,'predecessor',related.id is not null,'accept_decision',outcome='against_us');
end $$;

-- Include task versions in the preview: if an employee changes the work after
-- it was displayed, refresh before accepting it. The IDs remain issue-specific.
create or replace function public.customer_issue_manual_history_check(c public.ebay_return_cases) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare r public.ebay_return_cases;checked jsonb;blocked text;against_us boolean:=false;versions jsonb:='[]';base jsonb;
 task_count int:=0;employee_tasks int:=0;record_tasks int;record_employee_tasks int;tasks_version text;
begin
 base:=public.customer_issue_manual_history_record(c);
 for r in select * from public.ebay_return_cases where id in (select public.customer_issue_history_family(c.id)) order by id loop
  checked:=public.customer_issue_manual_history_record(r);
  if checked->>'allowed' is distinct from 'true' then blocked:=coalesce(blocked,checked->>'reason');end if;
  against_us:=against_us or coalesce((checked->>'accept_decision')::boolean,false);
  select count(*) filter(where t.status not in ('resolved','cancelled','closed','approved_by_admin')),
   count(*) filter(where t.status not in ('resolved','cancelled','closed','approved_by_admin') and not public.customer_issue_obsolete_monitor(t)),
   md5(coalesce(jsonb_agg(to_jsonb(t) order by t.id),'[]')::text)
   into record_tasks,record_employee_tasks,tasks_version from public.ebay_return_tasks t where t.return_case_id=r.id;
  task_count:=task_count+record_tasks;employee_tasks:=employee_tasks+record_employee_tasks;
  versions:=versions||jsonb_build_array(jsonb_build_object('id',r.id,'updated_at',r.updated_at,'tasks_version',tasks_version));
 end loop;
 return base||jsonb_build_object('allowed',blocked is null,'reason',blocked,'accept_decision',against_us or employee_tasks>0,
  'against_us',against_us,'task_count',task_count,'employee_task_count',employee_tasks,'cases',versions,'case_count',jsonb_array_length(versions));
end $$;

create or replace function public.send_customer_issue_to_history(_case_id uuid,_expected_cases jsonb,_accept_decision boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;t public.ebay_return_tasks;check_result jsonb;case_ids uuid[];versions jsonb;expected jsonb;archived jsonb:='[]';
 closed_tasks jsonb:='[]';record_tasks jsonb;close_note text;stamp timestamptz:=now();
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
 select jsonb_agg(jsonb_build_object('id',id,'updated_at',updated_at,'tasks_version',tasks_version) order by id) into expected
  from jsonb_to_recordset(_expected_cases) x(id uuid,updated_at timestamptz,tasks_version text);
 if expected is distinct from versions then raise exception 'This issue or its tasks changed. Refresh it before sending it to History';end if;
 if check_result->>'allowed' is distinct from 'true' then raise exception '%',check_result->>'reason';end if;
 if check_result->>'accept_decision'='true' and _accept_decision is distinct from true then raise exception 'Review and accept the decision before closing its tasks and sending this issue to History';end if;
 close_note:=case when _accept_decision then 'Decision reviewed and accepted as fair. Related task closed because no further work is required on this issue.'
  else 'Finalized eBay issue sent to History. Related monitoring task is no longer required.' end;
 for c in select * from public.ebay_return_cases where id=any(case_ids) order by id loop
  if c.status in ('closed','cancelled') and not exists(select 1 from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin')) then continue;end if;
  record_tasks:='[]';
  for t in select * from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin') order by id loop
   update public.ebay_return_tasks set status='resolved',updated_at=stamp,resolved_at=stamp,
    resolved_by=auth.uid(),resolved_by_email=auth.jwt()->>'email',
    resolution_notes=concat_ws(E'\n\n',nullif(resolution_notes,''),close_note),
    metadata=coalesce(metadata,'{}')||jsonb_build_object('history_closeout',true,'decision_accepted_as_fair',_accept_decision,
     'history_closed_at',stamp,'history_closed_by',auth.uid()) where id=t.id;
   insert into public.ebay_return_task_events(task_id,return_case_id,action,old_status,new_status,notes,signed_by,signed_by_email,payload)
   values(t.id,c.id,'resolved',t.status,'resolved',close_note,auth.uid(),auth.jwt()->>'email',
    jsonb_build_object('source','customer_issue_manual_history','previous_task',to_jsonb(t),'decision_accepted_as_fair',_accept_decision,
     'issue_case_ids',case_ids,'closed_at',stamp));
   record_tasks:=record_tasks||jsonb_build_array(t.id);closed_tasks:=closed_tasks||jsonb_build_array(t.id);
  end loop;
  update public.ebay_return_cases set status='closed',closed_at=coalesce(closed_at,stamp),history_managed=true,
   history_archived_at=stamp,history_snapshot=public.customer_issue_history_snapshot(c),history_update_pending=false,updated_at=stamp where id=c.id;
  insert into public.ebay_return_events(return_case_id,order_id,action,notes,signed_by,signed_by_email,payload)
  values(c.id,c.order_id,'closed',case when _accept_decision then 'Decision reviewed and accepted as fair. ' else '' end||
   'Sent to History. '||jsonb_array_length(record_tasks)||' related task(s) closed. New eBay activity or case work brings this record back for review.',auth.uid(),auth.jwt()->>'email',
   jsonb_build_object('source','customer_issue_manual_history','previous_status',c.status,'ebay_status',c.ebay_status,
    'issue_case_ids',case_ids,'decision_accepted_as_fair',_accept_decision,'closed_task_ids',record_tasks,'inventory_changed',false));
  archived:=archived||jsonb_build_array(c.id);
 end loop;
 return jsonb_build_object('id',_case_id,'archived_ids',archived,'archived',jsonb_array_length(archived),
  'closed_task_ids',closed_tasks,'closed_tasks',jsonb_array_length(closed_tasks));
end $$;

revoke all on function public.customer_issue_manual_history_record(public.ebay_return_cases),
 public.customer_issue_manual_history_check(public.ebay_return_cases) from public,anon,authenticated;
revoke all on function public.send_customer_issue_to_history(uuid,jsonb,boolean) from public,anon;
grant execute on function public.send_customer_issue_to_history(uuid,jsonb,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
