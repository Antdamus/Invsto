begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

-- eBay documents appealRefundAmount as money refunded to the SELLER after a
-- successful appeal. GRANTED alone can refer to either party's appeal.
-- https://developer.ebay.com/Devzone/post-order/types/AppealDetails.html
create or replace function public.customer_issue_appeal_facts(c jsonb) returns jsonb
language plpgsql immutable set search_path='' as $$
declare d jsonb:=c#>'{raw_payload,ebayDetail}';a jsonb;h jsonb;closed_at text;
 rid text:=c->>'ebay_return_id';lane text:=c->>'source_lane';grant_status text;stage text;
 amount numeric;terminal boolean;pending boolean;won boolean;
begin
 if lane not in ('case','inquiry') or rid is null or d is null then return null;end if;
 if (case when lane='case' then d->>'caseId' else d->>'inquiryId' end) is distinct from rid
  or coalesce(c#>>'{raw_payload,ebayReturnId}',rid)<>rid
  or coalesce(c#>>'{raw_payload,ebayIssueId}',rid)<>rid then return null;end if;
 a:=case when lane='case' then d->'appealDetails' else d#>'{inquiryDetails,appealDetails}' end;
 if a is null or a='null'::jsonb or a='{}'::jsonb then return null;end if;
 grant_status:=upper(coalesce(a->>'appealStatus',''));stage:=upper(coalesce(a->>'appealStatusEnum',''));
 if coalesce(a#>>'{appealRefundAmount,value}','') ~ '^\d+(\.\d+)?$' then amount:=(a#>>'{appealRefundAmount,value}')::numeric;end if;
 h:=case when lane='case' then d#>'{caseHistoryDetails,history}' else d#>'{inquiryHistoryDetails,history}' end;
 select max(coalesce(e#>>'{date,value}',e->>'date')) into closed_at
 from jsonb_array_elements(case when jsonb_typeof(h)='array' then h else '[]'::jsonb end) e
 where upper(e->>'actor') in ('SYSTEM','CSR','EBAY','CUSTOMER_SUPPORT')
  and replace(lower(e->>'action'),'_',' ') ~ '^(the )?appeal (has been |was |is )?(closed|resolved)([.;:]|$)'
  and coalesce(e#>>'{date,value}',e->>'date')>=coalesce(a#>>'{appealDate,value}',a->>'appealDate','');
 terminal:=grant_status in ('GRANTED','DENIED') or nullif(a->>'appealCloseReasonEnum','') is not null or closed_at is not null;
 -- The historical enum can still contain APPEALED after GRANTED. Do not treat
 -- that substring as an outstanding appeal when eBay supplies a final result.
 pending:=grant_status in ('PENDING','OPEN','UNDER_REVIEW','APPEALED') or (not terminal and (stage like '%APPEALED%' or a->'appealDate' is not null));
 won:=terminal and grant_status<>'DENIED' and (upper(coalesce(d->>'sellerOutcome',''))='WIN' or coalesce(amount,0)>0);
 return jsonb_build_object('seller_won',won,'pending',pending,'terminal',terminal,
  'status',grant_status,'stage',stage,'appealed_at',coalesce(a#>>'{appealDate,value}',a->>'appealDate'),
  'closed_at',closed_at,'reimbursed_amount',case when won and amount>0 then amount end,
  'currency',a#>>'{appealRefundAmount,currency}','source','eBay appeal record');
end $$;

create or replace function public.customer_issue_final_outcome(c jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare d jsonb:=c#>'{raw_payload,ebayDetail}'; r jsonb:=c->'raw_payload';
 lane text:=c->>'source_lane'; rid text:=c->>'ebay_return_id'; s text:=upper(coalesce(c->>'ebay_status',''));
 reason text; appeal text; facts jsonb;
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
 facts:=public.customer_issue_appeal_facts(c);
 appeal:=upper(concat_ws('|',d#>>'{appealDetails,appealStatus}',d#>>'{appealDetails,appealStatusEnum}'));
 if d->>'caseContentOnHold'='true' or d->>'returnContentOnHold'='true' or d->>'inquiryContentOnHold'='true'
  or facts->>'pending'='true' or (facts is null and appeal ~ 'APPEALED|PENDING|OPEN|UNDER_REVIEW') then return 'unfinished';end if;
 if public.customer_issue_return_refund(lane,rid,s,r) in ('pending','failed')
  or upper(coalesce(d->>'state','')) ~ 'PENDING|INITIATED|FAILED'
  or upper(coalesce(d#>>'{refundInfo,actualRefundDetail,refundStatus}','')) in ('PENDING','FAILED') then return 'unfinished';end if;
 -- eBay may keep buyerOutcome=WIN after reimbursing the seller. The current
 -- seller outcome and a completed seller appeal take precedence over it.
 if lane='case' and upper(coalesce(d->>'sellerOutcome',''))='WIN'
  or facts->>'seller_won'='true' then return 'final';end if;
 if reason in ('SELLER_LOST','SELLER_INVOICED','REFUND_TIMEOUT') or s='SELLER_LOST'
  or upper(coalesce(d->>'sellerOutcome','')) in ('LOSE','LOST','SELLER_LOST')
  or upper(coalesce(d->>'buyerOutcome',''))='WIN' then return 'against_us';end if;
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


-- Queue cards and the expanded detail share the same current result. A linked
-- escalated case supersedes its request, but unrelated cases on an order do not.
create or replace function public.customer_issue_outcome_summary(_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c public.ebay_return_cases;r public.ebay_return_cases;facts jsonb;outcome text;label text;
begin
 if auth.uid() is null or not coalesce(public.can_access_post_order_issues(),false)
 then raise exception 'Customer issues access required' using errcode='42501';end if;
 select * into c from public.ebay_return_cases where id=_case_id;
 if not found then return null;end if;
 if c.source_lane in ('inquiry','return') then
  select * into r from public.ebay_return_cases x where x.source_lane='case' and x.id<>c.id
   and (c.order_id is null or x.order_id is null or x.order_id=c.order_id)
   and ((c.source_lane='inquiry' and x.ebay_return_id=c.ebay_return_id)
    or (c.source_lane='return' and x.raw_payload#>>'{ebayDetail,returnId}'=c.ebay_return_id))
   order by x.synced_at desc nulls last,x.id limit 1;
  if found then c:=r;end if;
 end if;
 outcome:=public.customer_issue_final_outcome(to_jsonb(c));facts:=public.customer_issue_appeal_facts(to_jsonb(c));
 label:=case when outcome='final' and facts->>'seller_won'='true' then 'Appeal won'
  when outcome='final' and upper(c.raw_payload#>>'{ebayDetail,sellerOutcome}')='WIN' then 'Decided in our favor'
  when outcome='against_us' then 'Decided against us'
  when outcome='unfinished' and facts->>'pending'='true' then 'Appeal awaiting decision'
  when outcome='final' then 'Finalized on eBay'
  when outcome='open' then 'Open on eBay'
  when outcome='escalated' then 'Escalated to a case'
  when outcome='unfinished' then 'Follow-up is unfinished' else 'Outcome needs verification' end;
 return jsonb_build_object('outcome',outcome,'label',label,'appeal',facts,'case_id',c.id,'case_number',c.ebay_return_id,
  'synced_at',c.synced_at,'sync_error',c.sync_error);
end $$;

-- Extend queue overloads without changing their filters or access.
do $$ declare p record;src text;begin
 for p in select oid from pg_proc where pronamespace='public'::regnamespace and proname='list_customer_issues' loop
  src:=pg_get_functiondef(p.oid);
  if src ~ 'end\s+provider_case,' then
   src:=regexp_replace(src,'end\s+provider_case,','end provider_case, public.customer_issue_outcome_summary(c.id) provider_outcome,');
   execute src;
  end if;
 end loop;
 src:=pg_get_functiondef('public.customer_issue_ebay_review_packet(uuid)'::regprocedure);
 src:=replace(src,'''outcome'',public.customer_issue_final_outcome(to_jsonb(c)),',
  '''outcome'',public.customer_issue_final_outcome(to_jsonb(c)),''provider_outcome'',public.customer_issue_outcome_summary(c.id),');
 if strpos(src,'''provider_outcome'',public.customer_issue_outcome_summary(c.id)')=0 then raise exception 'Review packet outcome extension failed';end if;
 execute src;
end $$;

-- Task acceptance and an adverse decision are different facts. A winning appeal
-- must never create an audit note saying a loss was accepted as fair.
do $$ declare src text;begin
 src:=pg_get_functiondef('public.send_customer_issue_to_history(uuid,jsonb,boolean)'::regprocedure);
 src:=replace(src,'case when _accept_decision then ''Decision reviewed and accepted as fair.',
  'case when check_result->>''against_us''=''true'' then ''Decision reviewed and accepted as fair.');
 src:=replace(src,'''decision_accepted_as_fair'',_accept_decision',
  '''decision_accepted_as_fair'',coalesce((check_result->>''against_us'')::boolean,false)');
 src:=replace(src,'else ''Finalized eBay issue sent to History. Related monitoring task is no longer required.'' end;',
  'when _accept_decision then ''Finalized eBay decision reviewed. Related task closed because no further work is required on this issue.'' else ''Finalized eBay issue sent to History. Related monitoring task is no longer required.'' end;');
 if strpos(src,'Finalized eBay decision reviewed.')=0 then raise exception 'History audit extension failed';end if;
 execute src;
end $$;

revoke all on function public.customer_issue_appeal_facts(jsonb),public.customer_issue_outcome_summary(uuid) from public,anon,authenticated;
grant execute on function public.customer_issue_outcome_summary(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
