begin;
set local statement_timeout='30s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);event text;mode text;item text;counter int:=0;
 ord uuid;line uuid;win uuid;stub uuid;obs jsonb;health jsonb;recovery jsonb;result jsonb;
 stream jsonb:='{"source":"ebay_event_information","title":"Overnight buyer fixture","start_local":"2026-09-30T23:59","timezone_label":"EDT","activity_timezone":"America/New_York"}';
begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 foreach mode in array array['normal','preexisting_alias','missing_alias','different_order','different_minute','second_win','claimed','manual','partial','refund','cancel'] loop
  counter:=counter+1;event:='ALIAS-'||replace(gen_random_uuid()::text,'-','');item:=(800000003000+counter)::text;
  perform public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
  insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
   values('__alias_'||gen_random_uuid(),'former-name','2026-10-01 04:17:20Z','2026-10-01 04:17:23Z','{"orderPaymentStatus":"PAID"}') returning id into ord;
  insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
   values(ord,item,'fixture','Renamed buyer sale',65,1,'{"source":"ebay_fulfillment_api","orderPaymentStatus":"PAID","line":{"lineItemCost":{"value":"55","currency":"USD"}}}') returning id into line;
  if mode='preexisting_alias' then
   update public.ebay_orders set buyer_username='current-name',raw_payload=raw_payload||jsonb_build_object('ebay_buyer_identity',jsonb_build_object('source','ebay_fulfillment_api','order_number',order_number,'aliases',jsonb_build_array('former-name','current-name'))) where id=ord;
  end if;
  obs:=jsonb_build_object('key','win','kind','won','listing_id',item,'title','Renamed buyer sale','buyer','former-name','amount',55,'currency','USD','source','activity','time_label','Oct 1, 12:17 AM');
  health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now(),'pending',0);
  perform public.ingest_ebay_live_events(event,jsonb_build_array(obs,obs||'{"key":"tile","kind":"paid","source":"listing","buyer":"current-name","time_label":null}'),health);
  select id into win from public.ebay_live_attempts where event_id=event and win_key='win';
  select id into stub from public.ebay_live_attempts where event_id=event and win_key is null;
  perform pg_temp.verify(win is not null and stub is not null,mode||': historical and current buyer names initially remain distinct');
  update public.ebay_orders set buyer_username='current-name',raw_payload=raw_payload||jsonb_build_object('ebay_buyer_identity',
   jsonb_build_object('source','ebay_fulfillment_api','order_number',order_number,'current_username','current-name','aliases',jsonb_build_array('former-name','current-name'))) where id=ord;
  recovery:=jsonb_build_object('protocol',1,'run_id',gen_random_uuid(),'phase','read','sold_seen',1,'sold_expected',1,'observed_wins',1,'activity_passes',2,'listing_passes',2,'live_sales',55);
  if mode='missing_alias' then update public.ebay_orders set raw_payload=raw_payload-'ebay_buyer_identity' where id=ord;end if;
  if mode='different_order' then update public.ebay_orders set raw_payload=jsonb_set(raw_payload,'{ebay_buyer_identity,order_number}','"unrelated-order"') where id=ord;end if;
  if mode='different_minute' then update public.ebay_orders set sale_date='2026-10-01 04:18Z' where id=ord;end if;
  if mode='second_win' then
   perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"rerun","buyer":"current-name","time_label":"Oct 1, 12:21 AM"}'),health);
   recovery:=recovery||'{"observed_wins":2,"live_sales":110}';
  end if;
  if mode='claimed' then update public.ebay_live_attempts set claimed_at=now() where id=stub;end if;
  if mode='manual' then update public.ebay_live_attempts set review_note='Staff checking this customer' where id=win;end if;
  if mode='partial' then recovery:=recovery||'{"phase":"reading"}';end if;
  if mode='refund' then update public.ebay_order_lines set raw_payload=raw_payload||'{"orderPaymentStatus":"FULLY_REFUNDED"}' where id=line;end if;
  if mode='cancel' then update public.ebay_order_lines set raw_payload=raw_payload||'{"orderCancelStatus":"IN_PROGRESS"}' where id=line;end if;
  perform public.ingest_ebay_live_events(event,'[]',health||jsonb_build_object('recovery',recovery));
  if mode in ('normal','preexisting_alias','refund','cancel') then
   perform pg_temp.verify((select merged_into=win and resolved_at is not null from public.ebay_live_attempts where id=stub),mode||': same-order buyer change combines the duplicate without deleting it');
   perform pg_temp.verify((select buyer='current-name' and order_line_id=line from public.ebay_live_attempts where id=win),mode||': canonical buyer and exact order remain linked');
   perform pg_temp.verify((select buyer='former-name' and attempt_id=win from public.ebay_live_observations where event_id=event and source_key='win'),mode||': original Activity buyer remains in evidence');
   perform pg_temp.verify((select payment_state=(case when mode in ('normal','preexisting_alias') then 'paid' when mode='cancel' then 'cancelled' else 'review' end) from public.ebay_live_attempts where id=win),mode||': latest negative line evidence overrides stale paid header');
   perform public.reconcile_ebay_live_orders_internal(event);
   perform pg_temp.verify((select count(*)=1 from public.ebay_live_audit where event_id=event and action='buyer_alias_capture_combined'),mode||': replay is idempotent and audited');
  else
   perform pg_temp.verify((select merged_into is null from public.ebay_live_attempts where id=stub),mode||': incomplete or conflicting identity proof is never combined');
  end if;
 end loop;
 event:='FAIL-TOTAL-'||replace(gen_random_uuid()::text,'-','');
 perform public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
 obs:='{"key":"success","kind":"won","listing_id":"800000004001","title":"Winning auction","buyer":"buyer","amount":55,"currency":"USD","source":"activity","time_label":"Oct 1, 12:17 AM"}';
 health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now(),'pending',0);
 recovery:=jsonb_build_object('protocol',1,'run_id',gen_random_uuid(),'phase','read','sold_seen',2,'sold_expected',2,'observed_wins',1,'activity_passes',2,'listing_passes',2,'live_sales',55);
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs,obs||'{"key":"failed","kind":"failed","listing_id":"800000004002","title":"Failed attempt","amount":200}'),health||jsonb_build_object('recovery',recovery));
 result:=public.ebay_live_recovery_status(event);
 perform pg_temp.verify(result->>'phase'='read' and (result->>'captured_total')::numeric=55 and (result->>'failed_without_win')::int=1 and (result->>'failed_without_win_total')::numeric=200,'failed attempt without a win is reported separately from eBay Live sales');
 perform pg_temp.verify((select count(*)=2 from public.ebay_live_attempts where event_id=event and resolved_at is null),'the failed attempt is preserved for payment review');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"failure-after-win","kind":"failed","time_label":"Oct 1, 12:18 AM"}'),health);
 perform pg_temp.verify((public.ebay_live_recovery_status(event)->>'captured_total')::numeric=55,'a win that later fails remains in the historical auction total');
 -- An exact paid API line plus the original win can confirm payment even if
 -- the current Sold card shows a changed username and the header is from CSV.
 event:='WIN-LINE-'||replace(gen_random_uuid()::text,'-','');
 obs:=obs||'{"listing_id":"800000004003"}';
 perform public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
 insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
  values('__win_line_'||gen_random_uuid(),'buyer','2026-10-01 04:17:20Z','2026-10-01 04:17:23Z','{}') returning id into ord;
 insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
  values(ord,'800000004003','fixture','Winning auction',65,1,'{"source":"ebay_fulfillment_api","orderPaymentStatus":"PAID","line":{"lineItemCost":{"value":"55","currency":"USD"}}}');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health);
 perform pg_temp.verify((select payment_state='paid' from public.ebay_live_attempts where event_id=event),'exact original win and official paid line confirm payment without an unrelated buyer tile');
end $$;
rollback;
