begin;
set local statement_timeout='30s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);
 event text; mode text; buyer text; item text; counter int:=0;s public.live_sale_sessions;
 ord uuid;line uuid;stub uuid;obs jsonb;health jsonb;events jsonb;
 stream jsonb:='{"source":"ebay_event_information","title":"Order-bound win fixture","start_local":"2026-10-02T14:15","timezone_label":"EDT","activity_timezone":"America/New_York"}';
begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 foreach mode in array array['normal','different_minute','later_failure','manual_review'] loop
  counter:=counter+1;event:='WIN-'||replace(gen_random_uuid()::text,'-','');buyer:='fixture-'||mode;item:=(800000000100+counter)::text;
  s:=public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
  insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
   values('__win_fixture_'||gen_random_uuid(),buyer,'2026-10-02 19:55:25Z','2026-10-02 19:55:26Z',
    '{"orderPaymentStatus":"PAID","order":{"paymentSummary":{"payments":[{"paymentDate":"2026-10-02T19:55:26Z"}]}}}') returning id into ord;
  insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
   values(ord,item,'fixture','Historical sale',65,1,'{"source":"ebay_fulfillment_api","line":{"lineItemCost":{"value":"55.00","currency":"USD"}}}') returning id into line;
  obs:=jsonb_build_object('key','tile','kind','paid','listing_id',item,'title','Historical sale','buyer',buyer,'amount',55,'currency','USD','source','listing');
  health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now());
  perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health);
  select id into stub from public.ebay_live_attempts where event_id=event;
  perform pg_temp.verify((select order_line_id=line and payment_state='paid' from public.ebay_live_attempts where id=stub),mode||': tile is tied to its exact official order');
  if mode='manual_review' then
   update public.ebay_live_attempts set payment_state='review',review_note='Manual hold must remain' where id=stub;
   events:='[]';
  else
   events:=jsonb_build_array(obs||jsonb_build_object('key','failure','kind','failed','source','activity','time_label',case when mode='later_failure' then 'Oct 2, 3:56 PM' else 'Oct 2, 3:53 PM' end));
  end if;
  events:=events||jsonb_build_array(obs||jsonb_build_object('key','win','kind','won','source','activity','time_label',case when mode='different_minute' then 'Oct 2, 3:54 PM' else 'Oct 2, 3:55 PM' end));
  perform public.ingest_ebay_live_events(event,events,health);
  if mode='different_minute' then
   perform pg_temp.verify((select count(*)=2 from public.ebay_live_attempts where event_id=event),'a different win minute is not attached to the old order-bound record');
  else
   perform pg_temp.verify((select count(*)=1 from public.ebay_live_attempts where event_id=event),mode||': same-minute win attaches without a duplicate');
   perform pg_temp.verify((select win_key='win' and order_line_id=line and amount=55 and seller_id=seller from public.ebay_live_attempts where id=stub),mode||': order, amount and seller remain intact');
   perform pg_temp.verify((select payment_state=case when mode='normal' then 'paid' else 'review' end from public.ebay_live_attempts where id=stub),mode||': payment holds obey official chronology');
  end if;
  if mode='normal' then
   perform public.ingest_ebay_live_events(event,events,health);
   perform pg_temp.verify((select count(*)=1 from public.ebay_live_attempts where event_id=event),'replayed failure/win batch stays idempotent');
   perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"actual-rerun","kind":"won","source":"activity","time_label":"Oct 2, 4:10 PM"}'),health);
   perform pg_temp.verify((select count(*)=2 from public.ebay_live_attempts where event_id=event),'a second actual win remains a separate auction attempt');
  end if;
 end loop;
end $$;
rollback;
