-- Apply only after the bounded worker endpoint is deployed.
begin;
create function public.dispatch_customer_issue_worker() returns void
language plpgsql security definer set search_path='' as $$
declare worker public.ebay_issue_worker;token uuid;
begin
 select * into worker from public.ebay_issue_worker where singleton for update skip locked;
 if not found or worker.lease_until>now() then return;end if;
 token:=gen_random_uuid();
 update public.ebay_issue_worker set dispatch_token=token,lease_until=now()+interval '3 minutes',claimed_at=null where singleton;
 perform net.http_post(url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-return-sync',
  headers:='{"Content-Type":"application/json"}'::jsonb,body:=jsonb_build_object('workerToken',token),timeout_milliseconds:=120000);
end $$;
revoke all on function public.dispatch_customer_issue_worker() from public,anon,authenticated;
grant execute on function public.dispatch_customer_issue_worker() to service_role;
select cron.schedule('invsto-customer-issues','* * * * *','select public.dispatch_customer_issue_worker();');
commit;
