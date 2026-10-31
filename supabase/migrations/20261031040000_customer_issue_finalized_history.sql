begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- Existing, deliberately archived history is preserved. New imports and cases
-- archived by this workflow are checked again after every successful eBay sync.
alter table public.ebay_return_cases add column history_managed boolean not null default false;
alter table public.ebay_return_cases alter column history_managed set default true;

-- Only structured, matching provider facts count as a final outcome. Protection
-- is not a win, and a return closed through escalation is not a completed case.
-- eBay Post-Order CloseReturnReasonEnum and Fulfillment DisputeResolutionEnum.
create function public.customer_issue_final_outcome(c jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare d jsonb:=c#>'{raw_payload,ebayDetail}'; r jsonb:=c->'raw_payload';
 lane text:=c->>'source_lane'; rid text:=c->>'ebay_return_id'; s text:=upper(coalesce(c->>'ebay_status',''));
 reason text; appeal text;
begin
 if s !~ '(^|_)(CLOSED|CANCELLED|CANCELED|RESOLVED|SELLER_WON|SELLER_LOST|DISPUTE_REVERSED)($|_)' then return 'open';end if;
 if d is null or rid is null then return 'unknown';end if;
 if coalesce(r->>'ebayReturnId',rid)<>rid or coalesce(r->>'ebayIssueId',rid)<>rid then return 'unknown';end if;
 if lane='payment_dispute' and d->>'paymentDisputeId' is distinct from rid
  or lane='case' and d->>'caseId' is distinct from rid
  or lane='inquiry' and d->>'inquiryId' is distinct from rid then return 'unknown';end if;
 if lane='return' and (coalesce(d->>'returnId',r#>>'{ebaySummary,returnId}',r->>'ebayReturnId') is distinct from rid
  or coalesce(d->>'returnId',rid)<>rid or coalesce(r#>>'{ebaySummary,returnId}',rid)<>rid) then return 'unknown';end if;
 reason:=upper(coalesce(d#>>'{resolution,reasonForClosure}',d#>>'{closeInfo,returnCloseReason}',''));
 if reason in ('SELLER_LOST','SELLER_INVOICED','REFUND_TIMEOUT') or s='SELLER_LOST'
  or upper(coalesce(d->>'sellerOutcome','')) in ('LOSE','LOST','SELLER_LOST')
  or upper(coalesce(d->>'buyerOutcome',''))='WIN' then return 'against_us';end if;
 appeal:=upper(concat_ws('|',d#>>'{appealDetails,appealStatus}',d#>>'{appealDetails,appealStatusEnum}',d#>>'{inquiryDetails,appealDetails,appealStatus}'));
 if appeal ~ 'APPEALED|PENDING|OPEN|UNDER_REVIEW' or d->>'caseContentOnHold'='true'
  or d->>'returnContentOnHold'='true' or d->>'inquiryContentOnHold'='true' then return 'unfinished';end if;
 if s ~ 'ESCALAT' or reason in ('ESCALATED','CHARGEBACK_DISPUTE_FILED')
  or d#>'{inquiryDetails,escalationDate}' is not null then return 'escalated';end if;
 if public.customer_issue_return_refund(lane,rid,s,r) in ('pending','failed')
  or upper(coalesce(d->>'state','')) ~ 'PENDING|INITIATED|FAILED'
  or upper(coalesce(d#>>'{refundInfo,actualRefundDetail,refundStatus}','')) in ('PENDING','FAILED') then return 'unfinished';end if;
 if lane='payment_dispute' then
  return case when reason='SELLER_WON' or s in ('SELLER_WON','DISPUTE_REVERSED') then 'final' else 'unknown' end;
 elsif lane='case' then
  return case when upper(coalesce(d->>'sellerOutcome',''))='WIN' then 'final' else 'unknown' end;
 elsif lane='inquiry' then
  return case when upper(coalesce(d->>'state',''))='CLOSED' then 'final' else 'unknown' end;
 elsif lane='return' and reason in ('BUYER_CLOSED','BUYER_NO_ACTION','REQUEST_DECLINED','RETURN_REJECTED','SHIPMENT_TIMEOUT',
  'FULL_REFUNDED','PARTIALLY_REFUNDED','BUYER_ACCEPT_LESS_THAN_FULL_REFUND','MARK_PARTIAL_REFUND_RECEIVED','MARK_REFUND_RECEIVED') then return 'final';
 end if;
 return 'unknown';
end $$;

-- An untouched imported monitor is obsolete after a confirmed final outcome;
-- assigned work, receiving tasks, notes, deadlines and review submissions are not.
create function public.customer_issue_obsolete_monitor(t public.ebay_return_tasks) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(t.task_type='return_review' and t.status in ('open','deferred')
  and t.assigned_to_user_id is null and t.assigned_by is null and t.created_by is null and t.due_at is null
  and nullif(btrim(t.latest_note),'') is null and nullif(btrim(t.resolution_notes),'') is null
  and t.metadata->>'source' in ('ebay_return_api','ebay_post_order_api')
  and not exists(select 1 from public.ebay_return_task_events e where e.task_id=t.id and (e.signed_by is not null or e.signed_by_email is not null)),false)
$$;

create function public.customer_issue_history_block(c public.ebay_return_cases) returns text
language plpgsql stable security definer set search_path='' as $$
declare outcome text:=public.customer_issue_final_outcome(to_jsonb(c)); reason text:=c.raw_payload#>>'{ebayDetail,closeInfo,returnCloseReason}';
begin
 if outcome='against_us' then return 'Decided against us · keep for review';end if;
 if outcome='open' then return 'Still open on eBay';end if;
 if outcome='escalated' then return 'Escalated case still needs review';end if;
 if outcome='unfinished' then return 'Refund, appeal or eBay follow-up is unfinished';end if;
 if outcome<>'final' then return 'Final outcome needs verification';end if;
 if c.synced_at is null or c.sync_error is not null or c.synced_at<now()-interval '24 hours' then return 'Refresh eBay status before archiving';end if;
 if exists(select 1 from public.customer_return_reviews where return_case_id=c.id and status in ('pending','changes_requested')) then return 'Final review is unfinished';end if;
 if c.status in ('needs_review','partially_received') then return 'Return inspection is unfinished';end if;
 if exists(select 1 from public.ebay_return_items where return_case_id=c.id and received_quantity>restocked_quantity
  and disposition not in ('received_no_restock','damaged','refund_only')) then return 'Returned items still need inspection';end if;
 if c.source_lane='return' and reason not in ('BUYER_NO_ACTION','REQUEST_DECLINED','RETURN_REJECTED','SHIPMENT_TIMEOUT')
  and (c.raw_payload->>'physicalReturnExpected'='true' or public.customer_issue_return_stage(c.issue_kind,c.status,c.ebay_status,c.raw_payload) in ('delivered','in_transit'))
  and (not exists(select 1 from public.ebay_return_items where return_case_id=c.id)
   or exists(select 1 from public.ebay_return_items where return_case_id=c.id and expected_quantity>received_quantity and disposition<>'refund_only'))
 then return 'Return receipt is unfinished';end if;
 if exists(select 1 from public.ebay_return_cases related where related.id<>c.id and related.source_lane='case'
  and ((c.source_lane='inquiry' and related.ebay_return_id=c.ebay_return_id)
   or (c.source_lane='return' and related.raw_payload#>>'{ebayDetail,returnId}'=c.ebay_return_id))
  and public.customer_issue_final_outcome(to_jsonb(related))<>'final') then return 'Related eBay case still needs review';end if;
 if exists(select 1 from public.ebay_return_tasks t where t.return_case_id=c.id and t.status not in ('resolved','cancelled','closed','approved_by_admin')
  and not public.customer_issue_obsolete_monitor(t)) then return 'Internal work is unfinished';end if;
 return null;
end $$;

create function public.archive_finalized_customer_issue_internal(_case_id uuid,_automatic boolean default false) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ebay_return_cases;t public.ebay_return_tasks;blocked text;active boolean;retired int:=0;
begin
 select * into c from public.ebay_return_cases where id=_case_id for update;
 if not found then return jsonb_build_object('id',_case_id,'archived',false,'reason','Case not found');end if;
 perform 1 from public.ebay_return_tasks where return_case_id=c.id order by id for update;
 perform 1 from public.ebay_return_items where return_case_id=c.id order by id for update;
 perform 1 from public.customer_return_reviews where return_case_id=c.id for update;
 active:=c.status not in ('closed','cancelled') or exists(select 1 from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin'))
  or exists(select 1 from public.customer_return_reviews where return_case_id=c.id and status in ('pending','changes_requested'));
 blocked:=public.customer_issue_history_block(c);
 if blocked is not null then
  if _automatic and c.history_managed and c.status in ('closed','cancelled') then
   update public.ebay_return_cases set status='open',closed_at=null,updated_at=now() where id=c.id;
   insert into public.ebay_return_events(return_case_id,order_id,action,notes,payload)
    values(c.id,c.order_id,'admin_override','Kept active: '||blocked,jsonb_build_object('source','customer_issue_finalized_history','reason',blocked,'previous_status',c.status));
  end if;
  return jsonb_build_object('id',c.id,'archived',false,'reason',blocked);
 end if;
 if not active then return jsonb_build_object('id',c.id,'archived',false,'reason','Already in History');end if;
 for t in select * from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin') order by id loop
  update public.ebay_return_tasks set status='cancelled',updated_at=now(),resolved_at=now(),
   resolution_notes='Final eBay outcome verified; automatic monitoring no longer needed.',
   metadata=coalesce(metadata,'{}')||jsonb_build_object('history_closeout',true) where id=t.id;
  insert into public.ebay_return_task_events(task_id,return_case_id,action,old_status,new_status,notes,payload)
   values(t.id,c.id,'cancelled',t.status,'cancelled','Obsolete eBay monitor archived with the finalized case.',jsonb_build_object('source','customer_issue_finalized_history','previous_task',to_jsonb(t)));
  retired:=retired+1;
 end loop;
 update public.ebay_return_cases set status='closed',closed_at=coalesce(closed_at,now()),history_managed=true,updated_at=now() where id=c.id;
 insert into public.ebay_return_events(return_case_id,order_id,action,notes,signed_by,signed_by_email,payload)
 values(c.id,c.order_id,'closed','Fully finalized on eBay with no remaining internal work. Saved in History.',auth.uid(),auth.jwt()->>'email',
  jsonb_build_object('source','customer_issue_finalized_history','automatic',_automatic,'previous_status',c.status,'ebay_status',c.ebay_status,
   'last_ebay_sync',c.synced_at,'obsolete_monitors',retired,'inventory_changed',false,'outcome',public.customer_issue_final_outcome(to_jsonb(c))));
 return jsonb_build_object('id',c.id,'archived',true,'obsolete_monitors',retired);
end $$;

create function public.customer_issue_history_preview() returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare result jsonb;
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' and (auth.uid() is null or not coalesce(public.is_admin(),false) or not coalesce(public.can_access_post_order_issues(),false))
 then raise exception 'Administrator access required' using errcode='42501';end if;
 with active as (select c as case_record from public.ebay_return_cases c where c.status not in ('closed','cancelled')
  or exists(select 1 from public.ebay_return_tasks where return_case_id=c.id and status not in ('resolved','cancelled','closed','approved_by_admin'))
  or exists(select 1 from public.customer_return_reviews where return_case_id=c.id and status in ('pending','changes_requested'))),
 checked as (select (case_record).id,public.customer_issue_history_block(case_record) reason from active)
 select jsonb_build_object('ready_ids',coalesce(jsonb_agg(id) filter(where reason is null),'[]'),
  'ready',count(*) filter(where reason is null),'kept',count(*) filter(where reason is not null),
  'against_us',count(*) filter(where reason='Decided against us · keep for review'),
  'checks',coalesce(jsonb_object_agg(id,jsonb_build_object('ready',reason is null,'reason',reason)),'{}')) into result from checked;
 return result;
end $$;

create function public.archive_finalized_customer_issues(_case_ids uuid[]) returns jsonb
language plpgsql security definer set search_path='' as $$
declare cid uuid;results jsonb:='[]';
begin
 if coalesce(auth.jwt()->>'role','')<>'service_role' and (auth.uid() is null or not coalesce(public.is_admin(),false) or not coalesce(public.can_access_post_order_issues(),false))
 then raise exception 'Administrator access required' using errcode='42501';end if;
 if _case_ids is null or cardinality(_case_ids)>500 then raise exception 'Choose up to 500 finalized cases';end if;
 for cid in select distinct x from unnest(_case_ids) x order by x loop
  results:=results||jsonb_build_array(public.archive_finalized_customer_issue_internal(cid,false));
 end loop;
 return jsonb_build_object('results',results,'archived',(select count(*) from jsonb_array_elements(results) x where x->>'archived'='true'));
end $$;

create or replace function public.customer_issue_after_sync() returns trigger language plpgsql security definer set search_path='' as $$
begin
 perform public.reconcile_customer_issue_action(new.id);
 perform public.archive_finalized_customer_issue_internal(new.id,true);
 return new;
end $$;

-- Older tabs and the previous manual/bulk close buttons must obey the same
-- finalized-only rule, rather than bypassing it with a confirmation checkbox.
do $$
declare signature text;src text;
begin
 foreach signature in array array['public.close_resolved_customer_issue(uuid,timestamptz,jsonb,boolean,text)','public.finish_customer_issue(uuid,text)'] loop
  src:=pg_get_functiondef(signature::regprocedure);
  src:=regexp_replace(src,'if not found then raise exception ''Case not found'';\s*end if;',
   'if not found then raise exception ''Case not found'';end if; if c.ebay_return_id is not null and public.customer_issue_history_block(c) is not null then raise exception ''Cannot move to History: %'',public.customer_issue_history_block(c);end if;');
  if strpos(src,'Cannot move to History: %')=0 then raise exception 'Finalized History guard could not be installed: %',signature;end if;
  execute src;
 end loop;
end $$;

revoke all on function public.customer_issue_final_outcome(jsonb),public.customer_issue_obsolete_monitor(public.ebay_return_tasks),public.customer_issue_history_block(public.ebay_return_cases),
 public.archive_finalized_customer_issue_internal(uuid,boolean),public.customer_issue_history_preview(),public.archive_finalized_customer_issues(uuid[]) from public,anon,authenticated;
grant execute on function public.customer_issue_history_preview(),public.archive_finalized_customer_issues(uuid[]) to authenticated,service_role;
notify pgrst,'reload schema';
commit;
