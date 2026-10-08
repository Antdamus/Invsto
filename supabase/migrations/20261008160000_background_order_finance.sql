-- Durable, bounded finance work. Only the internal worker can claim/write jobs;
-- inventory staff get aggregate progress without credentials or payment data.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create table public.ebay_finance_jobs (
 job_key text primary key,
 order_id uuid references public.ebay_orders(id) on delete cascade,
 state text not null default 'queued' check(state in ('queued','working','retry','done','no_data','failed')),
 attempts int not null default 0,
 requested_at timestamptz not null default now(),
 next_attempt_at timestamptz not null default now(),
 lease_token uuid,
 lease_until timestamptz,
 last_checked_at timestamptz,
 last_error text,
 updated_at timestamptz not null default now(),
 check(order_id is not null or job_key='__funds_on_hold__')
);
create index ebay_finance_jobs_pending_idx on public.ebay_finance_jobs(next_attempt_at,requested_at)
 where state in ('queued','retry','working');
create table public.ebay_finance_worker (
 singleton boolean primary key default true check(singleton),
 dispatch_token uuid,
 lease_until timestamptz,
 claimed_at timestamptz,
 last_finished_at timestamptz
);
insert into public.ebay_finance_worker(singleton) values(true);
alter table public.ebay_finance_jobs enable row level security;
alter table public.ebay_finance_worker enable row level security;
revoke all on public.ebay_finance_jobs,public.ebay_finance_worker from public,anon,authenticated;
grant select,insert,update,delete on public.ebay_finance_jobs,public.ebay_finance_worker to service_role;

create function public.enqueue_ebay_finance_jobs(_order_numbers text[],_include_holds boolean default true)
returns integer language plpgsql security definer set search_path='' as $$
declare added integer;
begin
 with wanted as (
  select o.order_number job_key,o.id order_id from public.ebay_orders o where o.order_number=any(_order_numbers)
  union all select '__funds_on_hold__',null::uuid where _include_holds
 ), changed as (
  insert into public.ebay_finance_jobs(job_key,order_id) select job_key,order_id from wanted
  on conflict(job_key) do update set state='queued',attempts=0,requested_at=now(),next_attempt_at=now(),
   lease_token=null,lease_until=null,last_error=null,updated_at=now()
  where ebay_finance_jobs.state in ('done','no_data','failed')
   and (ebay_finance_jobs.last_checked_at is null or ebay_finance_jobs.last_checked_at<now()-interval '15 minutes')
  returning 1
 ) select count(*) into added from changed;
 return added;
end $$;

-- A single-use, short-lived dispatch token authorizes only this batch. No
-- service key is placed in a cron command, client response, or browser.
create function public.claim_ebay_finance_jobs(_dispatch_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare jobs jsonb;
begin
 update public.ebay_finance_worker set claimed_at=now()
 where singleton and dispatch_token=_dispatch_token and lease_until>now() and claimed_at is null;
 if not found then return null;end if;
 update public.ebay_finance_jobs set state='failed',lease_token=null,lease_until=null,
  last_error='Finance worker was interrupted repeatedly. Retry finance updates.',updated_at=now()
 where state='working' and lease_until<=now() and attempts>=6;
 with wanted as (
  select job_key from public.ebay_finance_jobs
  where (state in ('queued','retry') and next_attempt_at<=now()) or (state='working' and lease_until<=now())
  order by requested_at,job_key limit 12 for update skip locked
 ), claimed as (
  update public.ebay_finance_jobs j set state='working',attempts=attempts+1,lease_token=_dispatch_token,
   lease_until=now()+interval '2 minutes',updated_at=now()
  from wanted w where j.job_key=w.job_key returning j.job_key,j.order_id
 ) select coalesce(jsonb_agg(to_jsonb(c)),'[]') into jobs from claimed c;
 return jobs;
end $$;

create function public.finish_ebay_finance_job(_job_key text,_lease_token uuid,
 _finance jsonb default null,_line_finances jsonb default '[]',_error text default null,
 _discovered_orders text[] default '{}')
returns boolean language plpgsql security definer set search_path='' as $$
declare job public.ebay_finance_jobs;
begin
 select * into job from public.ebay_finance_jobs where job_key=_job_key for update;
 if not found or job.state<>'working' or job.lease_token is distinct from _lease_token or job.lease_until<=now() then return false;end if;
 if _error is null then
  if job.order_id is null then
   perform public.enqueue_ebay_finance_jobs(_discovered_orders,false);
  elsif _finance is not null then
   -- Merge in the database under row locks: never replace another writer's
   -- notes, cancellation evidence, dates, or fulfillment data with a stale copy.
   update public.ebay_orders set raw_payload=coalesce(raw_payload,'{}')||jsonb_build_object(
    'ebayFinance',_finance,'last_ebay_finance_sync_at',now()) where id=job.order_id;
   update public.ebay_order_lines l set raw_payload=coalesce(l.raw_payload,'{}')||jsonb_build_object('ebayFinance',f.value->'finance')
   from jsonb_array_elements(_line_finances) f
   where l.order_id=job.order_id and l.id::text=f.value->>'id' and jsonb_typeof(f.value->'finance')='object';
  end if;
 end if;
 update public.ebay_finance_jobs set
  state=case when _error is not null then case when attempts>=6 then 'failed' else 'retry' end
   when job.order_id is not null and _finance is null then 'no_data' else 'done' end,
  next_attempt_at=now()+make_interval(mins=>least(60,power(2,least(attempts,6))::int)),
  last_error=left(_error,300),last_checked_at=case when _error is null then now() else last_checked_at end,
  lease_token=null,lease_until=null,updated_at=now() where job_key=_job_key;
 return true;
end $$;

create function public.finish_ebay_finance_worker(_dispatch_token uuid)
returns void language sql security definer set search_path='' as $$
 update public.ebay_finance_worker set dispatch_token=null,lease_until=null,claimed_at=null,last_finished_at=now()
 where singleton and dispatch_token=_dispatch_token;
$$;

create function public.get_ebay_finance_sync_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
 if not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 return (select jsonb_build_object('queued',count(*) filter(where state='queued'),
  'working',count(*) filter(where state='working'),'retrying',count(*) filter(where state='retry'),
  'failed',count(*) filter(where state='failed'),'checked',count(*) filter(where state in ('done','no_data')),
  'without_transactions',count(*) filter(where state='no_data'),'last_checked_at',max(last_checked_at),
  'next_retry_at',min(next_attempt_at) filter(where state='retry')) from public.ebay_finance_jobs);
end $$;

create function public.retry_ebay_finance_sync()
returns void language plpgsql security definer set search_path='' as $$
begin
 if not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 update public.ebay_finance_jobs set state='queued',attempts=0,next_attempt_at=now(),last_error=null,updated_at=now()
 where state='failed';
end $$;

revoke all on function public.enqueue_ebay_finance_jobs(text[],boolean),public.claim_ebay_finance_jobs(uuid),
 public.finish_ebay_finance_job(text,uuid,jsonb,jsonb,text,text[]),public.finish_ebay_finance_worker(uuid),
 public.get_ebay_finance_sync_status(),public.retry_ebay_finance_sync() from public,anon,authenticated;
grant execute on function public.enqueue_ebay_finance_jobs(text[],boolean),public.claim_ebay_finance_jobs(uuid),
 public.finish_ebay_finance_job(text,uuid,jsonb,jsonb,text,text[]),public.finish_ebay_finance_worker(uuid) to service_role;
grant execute on function public.get_ebay_finance_sync_status(),public.retry_ebay_finance_sync() to authenticated;

create function public.preserve_newer_ebay_finance()
returns trigger language plpgsql set search_path='' as $$
begin
 if OLD.raw_payload->'ebayFinance' is not null and (
  NEW.raw_payload->'ebayFinance' is null or NEW.raw_payload->'ebayFinance'='null'::jsonb
  or coalesce(NEW.raw_payload#>>'{ebayFinance,syncedAt}','')<coalesce(OLD.raw_payload#>>'{ebayFinance,syncedAt}','')) then
  NEW.raw_payload:=coalesce(NEW.raw_payload,'{}')||jsonb_build_object('ebayFinance',OLD.raw_payload->'ebayFinance');
  if OLD.raw_payload ? 'last_ebay_finance_sync_at' then
   NEW.raw_payload:=NEW.raw_payload||jsonb_build_object('last_ebay_finance_sync_at',OLD.raw_payload->'last_ebay_finance_sync_at');
  end if;
 end if;
 return NEW;
end $$;
revoke all on function public.preserve_newer_ebay_finance() from public,anon,authenticated;
create trigger preserve_newer_ebay_order_finance before update of raw_payload on public.ebay_orders
 for each row execute function public.preserve_newer_ebay_finance();
create trigger preserve_newer_ebay_line_finance before update of raw_payload on public.ebay_order_lines
 for each row execute function public.preserve_newer_ebay_finance();

-- Finance metadata alone does not change the evidence used to release a bag.
-- Preserve the existing payment/refund/cancellation tests while preventing
-- the background worker from rechecking the entire show for each payout.
do $$declare definition text;begin
 select pg_get_functiondef('public.ebay_live_order_changed()'::regprocedure) into definition;
 if strpos(definition,'NEW.raw_payload is not distinct from OLD.raw_payload')=0 then
  raise exception 'Unexpected order reconciliation definition; finance migration cancelled';end if;
 definition:=replace(definition,'NEW.raw_payload is not distinct from OLD.raw_payload',
  '(NEW.raw_payload - ''ebayFinance'' - ''last_ebay_finance_sync_at'') is not distinct from (OLD.raw_payload - ''ebayFinance'' - ''last_ebay_finance_sync_at'')');
 execute definition;
 select pg_get_functiondef('public.ebay_live_order_lines_changed_statement()'::regprocedure) into definition;
 if strpos(definition,'n.raw_payload is distinct from o.raw_payload')=0 then
  raise exception 'Unexpected line reconciliation definition; finance migration cancelled';end if;
 definition:=replace(definition,'n.raw_payload is distinct from o.raw_payload',
  '(n.raw_payload - ''ebayFinance'' - ''last_ebay_finance_sync_at'') is distinct from (o.raw_payload - ''ebayFinance'' - ''last_ebay_finance_sync_at'')');
 execute definition;
end $$;
commit;
