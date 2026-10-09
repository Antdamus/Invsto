begin;
set local lock_timeout='3s';
set local statement_timeout='60s';
alter table public.ebay_issue_sync_jobs add column enqueued_at timestamptz not null default now();
alter table public.ebay_issue_sync_lanes add column last_progress_at timestamptz;
update public.ebay_issue_sync_lanes set last_progress_at=case when status in ('ok','syncing') then coalesce(last_attempt_at,last_success_at) else last_success_at end;
alter table public.ebay_issue_worker add column monitoring_started_at timestamptz not null default now(),
 add column last_run_started_at timestamptz,add column last_run_finished_at timestamptz,add column last_manual_retry_at timestamptz;

-- Discovery can promote an existing job without resetting its retry/backoff or
-- overwriting a manual refresh. Revision changes retain the worker delete guard.
create function public.enqueue_customer_issue_jobs(_jobs jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare j jsonb;
begin
 if jsonb_typeof(_jobs) is distinct from 'array' or jsonb_array_length(_jobs)>100 then raise exception 'Invalid issue jobs';end if;
 for j in select * from jsonb_array_elements(_jobs) loop
  if j->>'lane' not in ('return','inquiry','case','payment_dispute') or nullif(j->>'external_id','') is null then raise exception 'Invalid issue identity';end if;
  insert into public.ebay_issue_sync_jobs as existing(lane,external_id,summary,priority)
  values(j->>'lane',j->>'external_id',coalesce(j->'summary','{}'),coalesce((j->>'priority')::int,0))
  on conflict(lane,external_id) do update set
   summary=case when excluded.summary<>'{}' then excluded.summary else existing.summary end,
   priority=least(existing.priority,excluded.priority),updated_at=clock_timestamp()
  where existing.state in ('queued','retry') and
   (excluded.priority<existing.priority or (excluded.summary<>'{}' and excluded.summary is distinct from existing.summary));
 end loop;
end $$;

create function public.schedule_customer_issue_refreshes(_now timestamptz default now()) returns void
language plpgsql security definer set search_path='' as $$
declare jobs jsonb;
begin
 with candidates as (
  select c.source_lane,c.ebay_return_id,c.last_sync_attempt_at,c.synced_at,c.ebay_due_at,
   case when public.customer_issue_requires_action(to_jsonb(c)) and c.ebay_due_at<=_now+interval '4 hours' then -8
    when public.customer_issue_requires_action(to_jsonb(c)) and c.ebay_due_at<=_now+interval '48 hours' then -4 else 0 end priority
  from public.ebay_return_cases c where c.ebay_return_id is not null and c.status not in ('closed','cancelled')
 ), urgent as (
  select * from candidates where priority<0 and (synced_at is null or synced_at<_now-interval '2 minutes')
  order by priority,ebay_due_at,last_sync_attempt_at nulls first limit 12
 ), routine as (
  select * from candidates where priority=0 and (synced_at is null or synced_at<_now-interval '10 minutes')
  order by last_sync_attempt_at nulls first limit 12
 ) select coalesce(jsonb_agg(jsonb_build_object('lane',source_lane,'external_id',ebay_return_id,'priority',priority)),'[]') into jobs
 from (select * from urgent union all select * from routine) q;
 perform public.enqueue_customer_issue_jobs(jobs);
end $$;

create function public.customer_issue_job_batch(_now timestamptz default now()) returns setof public.ebay_issue_sync_jobs
language sql stable security definer set search_path='' as $$
 with ready as materialized (
  select j.*,least(j.priority,case when public.customer_issue_requires_action(to_jsonb(c)) and c.ebay_due_at<=_now+interval '4 hours' then -8
   when public.customer_issue_requires_action(to_jsonb(c)) and c.ebay_due_at<=_now+interval '48 hours' then -4 else j.priority end) rank,
   case when public.customer_issue_requires_action(to_jsonb(c)) then c.ebay_due_at end deadline
  from public.ebay_issue_sync_jobs j left join lateral (select c.* from public.ebay_return_cases c where c.source_lane=j.lane and c.ebay_return_id=j.external_id order by c.synced_at desc nulls last,c.id limit 1) c on true
  where j.state in ('queued','retry') and j.next_attempt_at<=_now
 ), first_urgent as (
  select lane,external_id,1::bigint slot from ready where rank<0 order by rank,deadline nulls last,enqueued_at,lane,external_id limit 1
 ), retries as (
  select r.lane,r.external_id,1+row_number() over(order by r.next_attempt_at,r.enqueued_at,r.lane,r.external_id) slot
  from ready r where state='retry' and not exists(select 1 from first_urgent u where (u.lane,u.external_id)=(r.lane,r.external_id))
  order by slot limit 3
 ), aged as (
  select r.lane,r.external_id,5::bigint slot from ready r where r.enqueued_at<_now-interval '30 minutes'
   and not exists(select 1 from first_urgent u where (u.lane,u.external_id)=(r.lane,r.external_id))
   and not exists(select 1 from retries u where (u.lane,u.external_id)=(r.lane,r.external_id))
  order by r.enqueued_at,r.lane,r.external_id limit 1
 ), reserved as (select * from first_urgent union all select * from retries union all select * from aged),
 rest as (
  select r.lane,r.external_id,5+row_number() over(order by r.rank,r.deadline nulls last,r.enqueued_at,r.lane,r.external_id) slot from ready r
  where not exists(select 1 from reserved u where (u.lane,u.external_id)=(r.lane,r.external_id))
 ), chosen as (select * from reserved union all select * from rest)
 select j.* from chosen x join public.ebay_issue_sync_jobs j using(lane,external_id) order by x.slot limit 12
$$;

-- Used only after the endpoint verifies an administrator. Keep errors and
-- attempt counts until a successful provider read; rate-limit repeated clicks.
create function public.retry_customer_issue_sync() returns void
language plpgsql security definer set search_path='' as $$
begin
 update public.ebay_issue_worker set last_manual_retry_at=now() where singleton
  and (last_manual_retry_at is null or last_manual_retry_at<now()-interval '1 minute');
 if not found then raise exception 'A retry was just requested. Please allow a minute for it to run.';end if;
 update public.ebay_issue_sync_lanes set next_run_at=now();
 update public.ebay_issue_sync_jobs set next_attempt_at=now(),updated_at=clock_timestamp() where state='retry';
end $$;
revoke all on function public.enqueue_customer_issue_jobs(jsonb),public.schedule_customer_issue_refreshes(timestamptz),public.customer_issue_job_batch(timestamptz),public.retry_customer_issue_sync() from public,anon,authenticated;
grant execute on function public.enqueue_customer_issue_jobs(jsonb),public.schedule_customer_issue_refreshes(timestamptz),public.customer_issue_job_batch(timestamptz),public.retry_customer_issue_sync() to service_role;
commit;
