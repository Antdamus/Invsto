-- Install after the worker-capable ebay-order-sync function is deployed.
begin;
set local lock_timeout='2s';
set local statement_timeout='30s';
create function public.dispatch_ebay_finance_worker()
returns void language plpgsql security definer set search_path='' as $$
declare worker public.ebay_finance_worker; token uuid;
begin
 select * into worker from public.ebay_finance_worker where singleton for update skip locked;
 if not found or worker.lease_until>now() then return;end if;
 if not exists(select 1 from public.ebay_finance_jobs
  where (state in ('queued','retry') and next_attempt_at<=now()) or (state='working' and lease_until<=now())) then return;end if;
 token:=gen_random_uuid();
 update public.ebay_finance_worker set dispatch_token=token,lease_until=now()+interval '2 minutes',claimed_at=null where singleton;
 perform net.http_post(
  url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-order-sync',
  headers:='{"Content-Type":"application/json"}'::jsonb,
  body:=jsonb_build_object('financeWorkerToken',token),timeout_milliseconds:=60000);
end $$;
revoke all on function public.dispatch_ebay_finance_worker() from public,anon,authenticated;
select cron.schedule('invsto-order-finance','30 seconds','select public.dispatch_ebay_finance_worker();');
commit;
