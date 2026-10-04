begin;
set local statement_timeout='30s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);
 event text;mode text;buyer text;item text;counter int:=0;s public.live_sale_sessions;
 ord uuid;line uuid;stub uuid;win uuid;obs jsonb;health jsonb;recovery jsonb;result jsonb;other_event text;other_attempt uuid;
 stream jsonb:='{"source":"ebay_event_information","title":"Complete history fixture","start_local":"2026-10-01T14:16","timezone_label":"EDT","activity_timezone":"America/New_York"}';
begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 foreach mode in array array['normal','line_only','win_first','partial','wrong_total','second_win','manual_note','manual_audit','claimed','cancelled','refunded','later_failure','unknown_time','multiple_orders','different_minute','other_owner'] loop
  counter:=counter+1;event:='FULL-'||replace(gen_random_uuid()::text,'-','');buyer:='full-'||mode;item:=(800000001000+counter)::text;
  s:=public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
  insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
   values('__full_'||gen_random_uuid(),buyer,'2026-10-01 19:21:34Z','2026-10-01 19:21:36Z',
    case when mode='line_only' then '{}'::jsonb else '{"orderPaymentStatus":"PAID","order":{"paymentSummary":{"payments":[{"paymentDate":"2026-10-01T19:21:36Z"}]}}}' end) returning id into ord;
  insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
   values(ord,item,'fixture','Historical sale',65,1,'{"source":"ebay_fulfillment_api","orderPaymentStatus":"PAID","line":{"lineItemCost":{"value":"55.00","currency":"USD"}}}') returning id into line;
  obs:=jsonb_build_object('key','tile','kind','paid','listing_id',item,'title','Historical sale','buyer',buyer,'amount',55,'currency','USD','source','listing');
  health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now(),'pending',0);
  recovery:=jsonb_build_object('protocol',1,'run_id',gen_random_uuid(),'phase','read','sold_seen',1,'sold_expected',1,'observed_wins',1,'activity_passes',2,'listing_passes',2,'live_sales',55);
  if mode='win_first' then
   perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"win","kind":"won","source":"activity","time_label":"Oct 1, 3:21 PM"}',obs||'{"key":"failure","kind":"failed","source":"activity","time_label":"Oct 1, 3:20 PM"}',obs),health);
   perform pg_temp.verify((select count(*)=1 and bool_and(payment_state='paid') from public.ebay_live_attempts where event_id=event),'win-first cold batch resolves only its automatic historical payment conflict');
   continue;
  end if;
  perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"failure","kind":"failed","source":"activity","time_label":"Oct 1, 3:20 PM"}',obs||'{"key":"win","kind":"won","source":"activity","time_label":"Oct 1, 3:21 PM"}',obs),health);
  select id into win from public.ebay_live_attempts where event_id=event and win_key='win';
  select id into stub from public.ebay_live_attempts where event_id=event and win_key is null;
  perform pg_temp.verify(win is not null and stub is not null,mode||': cold capture fixture contains the duplicate');
  if mode='partial' then recovery:=recovery||'{"phase":"reading"}';end if;
  if mode='wrong_total' then recovery:=recovery||'{"live_sales":56}';end if;
  if mode='second_win' then
   perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"rerun","kind":"won","source":"activity","time_label":"Oct 1, 3:25 PM"}'),health);
   recovery:=recovery||'{"observed_wins":2,"live_sales":110}';
  end if;
  if mode='manual_note' then update public.ebay_live_attempts set review_note='Staff hold' where id=win;end if;
  if mode='manual_audit' then insert into public.ebay_live_audit(event_id,attempt_id,action) values(event,win,'payment_manually_reviewed');end if;
  if mode='claimed' then update public.ebay_live_attempts set claimed_at=now() where id=stub;end if;
  if mode='cancelled' then update public.ebay_orders set raw_payload=raw_payload||'{"orderCancelStatus":"CANCEL_PENDING"}' where id=ord;end if;
  if mode='refunded' then update public.ebay_orders set raw_payload=raw_payload||'{"orderPaymentStatus":"FULLY_REFUNDED"}' where id=ord;end if;
  if mode='later_failure' then update public.ebay_live_observations set occurred_at='2026-10-01 19:22Z' where event_id=event and source_key='failure';end if;
  if mode='unknown_time' then update public.ebay_live_observations set occurred_at=null,time_label='unknown' where event_id=event and source_key='failure';end if;
  if mode='multiple_orders' then
   insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
    values(ord,item,'another','Historical sale',55,1,'{"source":"ebay_fulfillment_api","line":{"lineItemCost":{"value":"55","currency":"USD"}}}');
  end if;
  if mode='different_minute' then update public.ebay_orders set sale_date='2026-10-01 19:22Z' where id=ord;end if;
  if mode='other_owner' then
   other_event:='OWNER-'||replace(gen_random_uuid()::text,'-','');
   perform public.start_ebay_live_capture_from_stream(other_event,seller,'{}',stream);
   insert into public.ebay_live_attempts(event_id,listing_id,listing_title,buyer,amount,seller_id,order_line_id)
    values(other_event,item,'Other show',buyer,55,seller,line) returning id into other_attempt;
  end if;
  -- Completion may be a health-only heartbeat. It must run reconciliation.
  perform public.ingest_ebay_live_events(event,'[]',health||jsonb_build_object('recovery',recovery));
  if mode in ('normal','line_only') then
   perform pg_temp.verify((select merged_into=win and resolved_at is not null from public.ebay_live_attempts where id=stub),mode||': duplicate is preserved and combined');
   perform pg_temp.verify((select payment_state='paid' and order_line_id=line from public.ebay_live_attempts where id=win),mode||': exact official payment confirms the canonical win');
   perform pg_temp.verify((select count(*)=3 and bool_and(attempt_id=win and disposition='matched') from public.ebay_live_observations where event_id=event),mode||': failures, win and Paid tile stay linked as evidence');
   perform pg_temp.verify((select count(*)=1 from public.ebay_live_audit where event_id=event and action='duplicate_capture_combined'),mode||': correction is audited');
   perform public.reconcile_ebay_live_orders_internal(event);
   perform pg_temp.verify((select count(*)=1 from public.ebay_live_attempts where event_id=event and merged_into is null),mode||': repeated reconciliation is idempotent');
  else
   perform pg_temp.verify((select merged_into is null and resolved_at is null from public.ebay_live_attempts where id=stub),mode||': ambiguous evidence or operator work is not combined');
  end if;
 end loop;
 -- A reused card's order is already owned by its correct later show.
 event:='REUSE-'||replace(gen_random_uuid()::text,'-','');
 perform public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
 obs:='{"key":"own","kind":"won","listing_id":"800000002001","title":"This show","buyer":"reuse-own","amount":42,"currency":"USD","source":"activity","time_label":"Oct 1, 3:00 PM"}';
 health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now(),'pending',0);
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health);
 other_event:='LATER-'||replace(gen_random_uuid()::text,'-','');
 perform public.start_ebay_live_capture_from_stream(other_event,seller,'{}',stream||'{"start_local":"2026-10-02T14:16"}');
 insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
  values('__reuse_'||gen_random_uuid(),'reuse-later','2026-10-02 19:00Z','2026-10-02 19:00:03Z','{"orderPaymentStatus":"PAID"}') returning id into ord;
 insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
  values(ord,'800000002002','fixture','Later show',55,1,'{}') returning id into line;
 insert into public.ebay_live_attempts(event_id,listing_id,listing_title,buyer,amount,seller_id,order_line_id,payment_state)
  values(other_event,'800000002002','Later show','reuse-later',55,seller,line,'paid') returning id into other_attempt;
 obs:='{"key":"later","kind":"paid","listing_id":"800000002002","title":"Later show","buyer":"reuse-later","amount":55,"currency":"USD","source":"listing"}';
 recovery:=jsonb_build_object('protocol',1,'run_id',gen_random_uuid(),'phase','read','sold_seen',2,'sold_expected',2,'observed_wins',1,'activity_passes',2,'listing_passes',2,'live_sales',42);
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health||jsonb_build_object('recovery',recovery));
 perform pg_temp.verify((select event_exclusion->>'order_line_id'=line::text and resolved_at is not null and order_line_id is null from public.ebay_live_attempts where event_id=event and listing_id='800000002002'),'reused unbound card can be excluded using exact later-show order proof');
 perform pg_temp.verify((select order_line_id=line and resolved_at is null and payment_state='paid' from public.ebay_live_attempts where id=other_attempt),'the actual later show keeps its order ownership and paid sale');
end $$;
rollback;
