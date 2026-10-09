begin;
set local lock_timeout='3s';
set local statement_timeout='60s';

-- Recover the API identity only when both saved provider responses agree.
-- The local case UUID, order link, tasks, notes and physical stock stay intact.
do $$
declare r record;
begin
 for r in
  select c.id,c.order_id,c.ebay_return_id as old_id,
   c.raw_payload#>>'{ebaySummary,caseId}' as case_id
  from public.ebay_return_cases c
  where c.source_lane='case'
   and c.raw_payload#>>'{ebaySummary,caseId}' ~ '^[1-9][0-9]*$'
   and c.raw_payload#>>'{ebaySummary,caseId}'=c.raw_payload#>>'{ebayDetail,caseId}'
   and c.ebay_return_id<>c.raw_payload#>>'{ebaySummary,caseId}'
   and not exists(select 1 from public.ebay_return_cases other where other.id<>c.id and other.source_lane='case'
    and (other.ebay_return_id=c.raw_payload#>>'{ebaySummary,caseId}'
     or other.raw_payload#>>'{ebaySummary,caseId}'=c.raw_payload#>>'{ebaySummary,caseId}'))
  for update of c
 loop
  insert into public.ebay_return_events(return_case_id,order_id,action,notes,payload)
  values(r.id,r.order_id,'admin_override','Corrected the provider case ID from matching saved eBay responses. Local work and the order link are unchanged.',
   jsonb_build_object('source','customer_issue_identity_correction','before_ebay_id',r.old_id,'after_ebay_id',r.case_id));
  update public.ebay_return_cases set ebay_return_id=r.case_id,synced_at=null,provider_fingerprint=null,
   raw_payload=raw_payload||jsonb_build_object('ebayReturnId',r.case_id,'ebayIssueId',r.case_id,'ebayRequestId',r.case_id),updated_at=now()
   where id=r.id;
  -- Keep obsolete job records for diagnosis; only the canonical case may run.
  update public.ebay_issue_sync_jobs set state='superseded',updated_at=now()
   where lane='case' and external_id=r.old_id
    and not exists(select 1 from public.ebay_return_cases c where c.source_lane='case' and c.ebay_return_id=r.old_id);
  insert into public.ebay_issue_sync_jobs(lane,external_id,summary)
   values('case',r.case_id,'{}') on conflict(lane,external_id) do update
   set state='queued',attempts=0,next_attempt_at=now(),updated_at=now();
 end loop;
end $$;
commit;
