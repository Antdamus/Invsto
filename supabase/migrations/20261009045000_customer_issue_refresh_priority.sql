begin;
alter table public.ebay_issue_sync_jobs add column priority integer not null default 10;
-- Refreshing an open case should not wait behind historical backfill.
update public.ebay_issue_sync_jobs j set priority=0
where exists(select 1 from public.ebay_return_cases c where c.source_lane=j.lane and c.ebay_return_id=j.external_id and c.status not in ('closed','cancelled'));
create index customer_issue_jobs_priority_due on public.ebay_issue_sync_jobs(priority,next_attempt_at) where state in ('queued','retry');
commit;
