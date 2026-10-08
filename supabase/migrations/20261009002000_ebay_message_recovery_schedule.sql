-- Apply after the worker-capable notification endpoint and sync are deployed.
begin;
create function public.dispatch_ebay_message_recovery() returns void
language plpgsql security definer set search_path='' as $$
declare worker public.ebay_message_recovery_worker;token uuid;
begin
 select * into worker from public.ebay_message_recovery_worker where singleton for update skip locked;
 if not found or worker.lease_until>now() then return;end if;
 token:=gen_random_uuid();
 update public.ebay_message_recovery_worker set dispatch_token=token,lease_until=now()+interval '3 minutes',claimed_at=null where singleton;
 perform net.http_post(url:='https://byhytmarmigalvawkedi.supabase.co/functions/v1/ebay-message-notification',
  headers:='{"Content-Type":"application/json"}'::jsonb,
  body:=jsonb_build_object('recoveryToken',token),timeout_milliseconds:=120000);
end $$;
revoke all on function public.dispatch_ebay_message_recovery() from public,anon,authenticated;
select cron.schedule('invsto-message-recovery','* * * * *','select public.dispatch_ebay_message_recovery();');
commit;
