begin;
-- An older week's successful refresh must not clear this week's reminder.
create or replace function public.ebay_manual_performance_sources() returns jsonb language sql stable set search_path='' as $$
 select jsonb_object_agg(k.kind,jsonb_build_object('verified',j.verified,'requested',j.manual_requested,'attempted',j.attempted,
  'checking',coalesce(j.lease_until>now(),false),'error',j.note))
 from (values ('cases','register'),('orders',date_trunc('week',now() at time zone 'America/Los_Angeles')::date::text)) k(kind,id)
 left join public.ebay_health_jobs j on (j.kind,j.id)=(k.kind,k.id)
$$;
create or replace function public.request_ebay_performance_refresh() returns void language plpgsql security definer set search_path='' as $$
begin
 perform public.require_ebay_health_admin();
 if not exists(select from public.ebay_health_config where coverage_start is not null) then raise exception 'Performance report is not set up.';end if;
 insert into public.ebay_health_jobs as j(kind,id,manual_requested)
 select k.kind,k.id,now() from (values ('cases','register'),('orders',date_trunc('week',now() at time zone 'America/Los_Angeles')::date::text)) k(kind,id)
 where not exists(select from public.ebay_health_jobs s where (s.kind,s.id)=(k.kind,k.id) and s.verified>now()-interval '12 hours')
 on conflict(kind,id) do update set due=least(j.due,now()),manual_requested=now()
 where coalesce(j.lease_until,'-infinity')<now() and coalesce(j.manual_requested,'-infinity')<now()-interval '3 minutes';
end$$;
commit;
