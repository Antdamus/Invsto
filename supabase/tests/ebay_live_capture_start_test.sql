begin;
set local statement_timeout='25s';
create function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label; end if; raise notice 'ok %',label; end $$;
do $$
declare
 actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor and active is distinct from false limit 1);
 other uuid:=(select id from public.employees where id<>seller and active is distinct from false limit 1);
 event text:='TEST-'||replace(gen_random_uuid()::text,'-','');
 s public.live_sale_sessions; retry public.live_sale_sessions; before_count bigint; auction uuid; bag public.live_sale_lots;
 obs jsonb:=jsonb_build_object('key','win-1','kind','won','listing_id','123456789012','title','#001 - Capture test','buyer','capture-fixture','amount',100,'currency','USD','ordinal','1','time_label','10:03 AM','source','activity');
begin
 perform pg_temp.verify(actor is not null and other is not null,'fixture sellers exist');
 perform pg_temp.verify(not has_function_privilege('anon','public.start_ebay_live_capture(text,uuid,uuid[])','EXECUTE'),'anonymous cannot start capture sessions');
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 begin perform public.start_ebay_live_capture(event,seller);raise exception 'Unauthorized start succeeded';exception when insufficient_privilege then null;end;
 perform pg_temp.verify(true,'nonstaff capture start is rejected');
 perform set_config('request.jwt.claim.sub',actor::text,true);
 select count(*) into before_count from public.live_sale_sessions;
 begin perform public.start_ebay_live_capture('bad',seller);raise exception 'Invalid event accepted';exception when invalid_parameter_value then null;end;
 begin perform public.start_ebay_live_capture(event,null);raise exception 'Missing seller accepted';exception when invalid_parameter_value then null;end;
 begin perform public.start_ebay_live_capture(event,seller,array[gen_random_uuid()]);raise exception 'Invalid co-seller accepted';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify((select count(*) from public.live_sale_sessions)=before_count,'invalid setup creates no orphan sessions');
 s:=public.start_ebay_live_capture(event,seller,array[other]);
 perform pg_temp.verify(s.store_id is null and s.workflow_mode='ebay_live' and s.status='active','capture creates an active eBay show without a store');
 perform pg_temp.verify(s.primary_seller_employee_id=seller and s.co_seller_employee_ids=array[other],'selected seller roster is saved');
 perform pg_temp.verify((select session_id=s.id and active_seller_id=seller from public.ebay_live_connections where event_id=event),'exact event and first seller are linked');
 retry:=public.start_ebay_live_capture(event,other,'{}');
 perform pg_temp.verify(retry.id=s.id and retry.primary_seller_employee_id=seller and retry.co_seller_employee_ids=array[other],'retry reuses the show without overwriting sellers');
 perform pg_temp.verify((select count(*) from public.live_sale_sessions)=before_count+1,'retry creates no duplicate show');
 perform pg_temp.verify(not exists(select 1 from public.live_sale_lots where session_id=s.id),'starting capture creates no empty auction bags');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),jsonb_build_object('observed_at',clock_timestamp(),'ready',true));
 select id into auction from public.ebay_live_attempts where event_id=event;
 perform pg_temp.verify((select seller_id=seller and payment_state='waiting' from public.ebay_live_attempts where id=auction),'captured win belongs to selected seller and still requires payment');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"paid-1","kind":"paid","source":"listing"}'),jsonb_build_object('observed_at',clock_timestamp(),'ready',true));
 bag:=public.claim_ebay_live_bag(auction);
 perform pg_temp.verify(bag.session_id=s.id and bag.owner_employee_id=seller,'paid bag is created under the store-free show and correct seller');
 perform public.resolve_ebay_live_attempt(auction,'cancel_release','Fixture only: empty physical bag checked and released.');
 perform public.mark_ebay_live_broadcast_ended(event);
 perform public.complete_ebay_live_session(s.id,true,true);
 begin perform public.start_ebay_live_capture(event,seller);raise exception 'Closed show reopened';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify((select status='ended' from public.live_sale_sessions where id=s.id),'capture never reopens a completed show');
 perform pg_temp.verify((select count(*) from public.live_sale_sessions)=before_count+1,'closed event creates no replacement session');
end $$;
rollback;
