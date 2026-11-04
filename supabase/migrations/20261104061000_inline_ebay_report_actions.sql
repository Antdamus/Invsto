begin;
set local lock_timeout='5s';
alter table public.ebay_health_jobs add column manual_requested timestamptz;

-- The dashboard and the scheduled Edge worker use the same jobs and leases.
-- A request never advances a verification timestamp or replaces a live ticket.
create function public.ebay_manual_performance_sources() returns jsonb language sql stable set search_path='' as $$
 select jsonb_object_agg(k.kind,jsonb_build_object('verified',v.at,'requested',j.manual_requested,'attempted',j.attempted,
  'checking',coalesce(j.lease_until>now(),false),'error',j.note))
 from (values ('cases','register'),('orders',date_trunc('week',now() at time zone 'America/Los_Angeles')::date::text)) k(kind,id)
 left join public.ebay_health_jobs j on (j.kind,j.id)=(k.kind,k.id)
 left join lateral (select max(verified) at from public.ebay_health_jobs where kind=k.kind) v on true
$$;
revoke all on function public.ebay_manual_performance_sources() from public,anon,authenticated;

create or replace function public.ebay_report_manual_actions(_month date) returns jsonb language plpgsql stable security definer set search_path='' as $$
declare actions jsonb; sources jsonb;
begin
 actions:=public.ebay_report_manual_actions_before_performance(_month);
 if exists(select from public.ebay_health_config where coverage_start is not null) then
  sources:=public.ebay_manual_performance_sources();
  if exists(select from jsonb_each(sources) s where coalesce((s.value->>'verified')::timestamptz,'-infinity')<=now()-interval '12 hours') then
   actions:=actions||jsonb_build_object('kind','performance','sources',sources);
  end if;
 end if;return actions;
end$$;

create function public.request_ebay_performance_refresh() returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.require_ebay_health_admin();
 if not exists(select from public.ebay_health_config where coverage_start is not null) then raise exception 'Performance report is not set up.';end if;
 insert into public.ebay_health_jobs as j(kind,id,manual_requested)
 select k.kind,k.id,now() from (values ('cases','register'),('orders',date_trunc('week',now() at time zone 'America/Los_Angeles')::date::text)) k(kind,id)
 where not exists(select from public.ebay_health_jobs where kind=k.kind and verified>now()-interval '12 hours')
 on conflict(kind,id) do update set due=least(j.due,now()),manual_requested=now()
 where coalesce(j.lease_until,'-infinity')<now() and coalesce(j.manual_requested,'-infinity')<now()-interval '3 minutes';
end$$;

create function public.claim_requested_ebay_performance_checks() returns jsonb language plpgsql security definer set search_path='' as $$
declare jobs jsonb;
begin
 perform public.require_ebay_health_admin();
 with available as (select kind,id from public.ebay_health_jobs
  where (kind,id) in (('cases','register'),('orders',date_trunc('week',now() at time zone 'America/Los_Angeles')::date::text))
  and due<=now() and manual_requested>now()-interval '15 minutes' and coalesce(verified,'-infinity')<manual_requested
  and coalesce(lease_until,'-infinity')<now() order by kind for update skip locked),
 claimed as (update public.ebay_health_jobs j set ticket=gen_random_uuid(),owner_id=auth.uid(),attempted=now(),lease_until=now()+interval '10 minutes'
  from available k where (j.kind,j.id)=(k.kind,k.id) returning j.kind,j.id,j.ticket)
 select coalesce(jsonb_agg(to_jsonb(claimed) order by kind),'[]') into jobs from claimed;return jobs;
end$$;
revoke all on function public.request_ebay_performance_refresh(),public.claim_requested_ebay_performance_checks() from public,anon;
grant execute on function public.request_ebay_performance_refresh(),public.claim_requested_ebay_performance_checks() to authenticated;
notify pgrst,'reload schema';
commit;
