begin;
set local statement_timeout='45s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);event text:='CHECK-'||replace(gen_random_uuid()::text,'-','');
 ord uuid;claim jsonb;nextclaim jsonb;run text:=gen_random_uuid()::text;i int;item text;
 stream jsonb:='{"source":"ebay_event_information","title":"Order check fixture","start_local":"2026-09-28T23:58","timezone_label":"EDT","activity_timezone":"America/New_York"}';
begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
 perform pg_temp.verify(public.claim_ebay_live_order_check(event)->>'state'='waiting','unfinished history cannot start an official check');
 for i in 1..10 loop
  item:=(890000004000+i)::text;
  insert into public.ebay_orders(order_number,buyer_username,sale_date,raw_payload) values('__check_'||gen_random_uuid(),'buyer','2026-09-29 04:30Z','{}') returning id into ord;
  insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity) values(ord,item,'fixture','Sale',55,1);
  insert into public.ebay_live_attempts(event_id,listing_id,listing_title,buyer,amount,seller_id) values(event,item,'Sale','buyer',55,seller);
 end loop;
 update public.ebay_live_connections set broadcast_ended_at=now(),health='{"pending":0}',history_recovery=jsonb_build_object('phase','read','run_id',run,'sold_seen',10,'sold_expected',10,'activity_passes',2,'listing_passes',2,'observed_at',now()) where event_id=event;
 claim:=public.claim_ebay_live_order_check(event);
 perform pg_temp.verify(jsonb_array_length(claim->'orders')=8 and (claim->>'total')::int=10,'official checks are event-scoped batches of eight');
 perform pg_temp.verify(jsonb_array_length(public.claim_ebay_live_order_check(event)->'orders')=0,'another receiver cannot duplicate a running check');
 perform pg_temp.verify(public.ebay_live_recovery_status(event)->>'phase'='checking_orders' and public.ebay_live_recovery_status(event)->>'can_close'='false','pending official checks cannot report completion');
 perform public.finish_ebay_live_order_check(event,(claim->>'token')::uuid,false);
 perform pg_temp.verify(jsonb_array_length(public.claim_ebay_live_order_check(event)->'orders')=0,'failed batches back off without losing their checkpoint');
 update public.ebay_live_connections set order_check=order_check-'retry_at' where event_id=event;
 nextclaim:=public.claim_ebay_live_order_check(event);
 perform pg_temp.verify(nextclaim->'orders'=claim->'orders','retry reads the same batch');
 perform pg_temp.verify(public.finish_ebay_live_order_check(event,(claim->>'token')::uuid,true)->>'state'='superseded','late responses cannot advance a replaced lease');
 perform public.finish_ebay_live_order_check(event,(nextclaim->>'token')::uuid,true);
 claim:=public.claim_ebay_live_order_check(event);
 perform pg_temp.verify(jsonb_array_length(claim->'orders')=2 and (claim->>'checked')::int=8,'reload resumes at the persisted checkpoint');
 perform public.finish_ebay_live_order_check(event,(claim->>'token')::uuid,true);
 claim:=public.claim_ebay_live_order_check(event);
 perform pg_temp.verify(claim->>'state'='complete' and jsonb_array_length(claim->'orders')=0,'completed checks do not refetch every heartbeat');
 update public.ebay_live_connections set history_recovery=jsonb_set(history_recovery,'{run_id}',to_jsonb(gen_random_uuid()::text)) where event_id=event;
 perform pg_temp.verify((public.claim_ebay_live_order_check(event)->>'checked')::int=0,'a new scan checks official evidence again');
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 begin perform public.claim_ebay_live_order_check(event);raise exception 'Unauthorized access unexpectedly succeeded';exception when insufficient_privilege then null;end;
 perform pg_temp.verify(not has_function_privilege('authenticated','public.finish_ebay_live_order_check(text,uuid,boolean)','EXECUTE'),'the browser cannot mark official checks successful');
end $$;
rollback;
