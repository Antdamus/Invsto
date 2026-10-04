begin;
set local statement_timeout='30s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);
 event text:='TEST-'||replace(gen_random_uuid()::text,'-','');s public.live_sale_sessions;
 ord uuid;line uuid;auction uuid;other uuid;fixture public.ebay_order_lines;
 stream jsonb:='{"source":"ebay_event_information","title":"Historical recovery fixture","start_local":"2026-10-02T14:15","timezone_label":"EDT","activity_timezone":"America/New_York"}';
 obs jsonb:='{"key":"paid","kind":"paid","listing_id":"800000000001","title":"Historical bracelet","buyer":"capture-fixture","amount":53,"currency":"USD","ordinal":"1","source":"listing"}';
 health jsonb;
begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform pg_temp.verify(public.ebay_live_activity_time('2026-10-02 18:15Z','America/New_York','Oct 2, 3:09 PM')='2026-10-02 19:09Z','old-event calendar prefix resolves to original date');
 perform pg_temp.verify(public.ebay_live_activity_time('2026-10-02 18:15Z','America/New_York','Oct 1, 3:09 PM') is null,'different calendar day is not stripped');
 perform pg_temp.verify(public.ebay_live_activity_time('2026-12-31 23:30Z','UTC','Jan 1, 12:15 AM')='2027-01-01 00:15Z','dated clock handles year boundary');
 perform pg_temp.verify(public.ebay_live_activity_time('2026-11-01 04:30Z','America/New_York','Nov 1, 1:30 AM') is null,'dated ambiguous DST clock remains unverified');
 perform pg_temp.verify(public.ebay_live_activity_time('2026-10-02 18:15Z','America/New_York','Foo 2, 3:09 PM') is null,'unknown month stays unverified');
 perform pg_temp.verify(not has_function_privilege('authenticated','public.ebay_live_order_item_amount(public.ebay_order_lines)','execute'),'price helper remains internal');
 fixture.quantity:=1;fixture.sold_for:=63;
 fixture.raw_payload:='{"source":"ebay_fulfillment_api","line":{"lineItemCost":{"value":"53.00","currency":"USD"}}}';
 perform pg_temp.verify(public.ebay_live_order_item_amount(fixture)=53,'match item-only cost without shipping');
 fixture.raw_payload:=jsonb_set(fixture.raw_payload,'{line,lineItemCost,currency}','"CAD"');
 perform pg_temp.verify(public.ebay_live_order_item_amount(fixture) is null,'foreign currency does not fall back to total');
 fixture.raw_payload:='{"source":"ebay_fulfillment_api"}';
 perform pg_temp.verify(public.ebay_live_order_item_amount(fixture) is null,'missing official item price remains unknown');
 fixture.raw_payload:='{}';perform pg_temp.verify(public.ebay_live_order_item_amount(fixture)=63,'legacy import price remains supported');
 fixture.quantity:=2;perform pg_temp.verify(public.ebay_live_order_item_amount(fixture) is null,'multi-unit order is not assumed to be one auction');
 s:=public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
 health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now());
 -- Order was imported before this historical capture, includes shipping, and
 -- proves a successful payment after the earlier failure notifications.
 insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
 values('__capture_fixture_'||gen_random_uuid(),'capture-fixture','2026-10-02 21:54:03Z','2026-10-02 21:54:03Z',
 '{"orderPaymentStatus":"PAID","order":{"paymentSummary":{"payments":[{"paymentDate":"2026-10-02T21:54:03Z"}]}}}') returning id into ord;
 insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
 values(ord,'800000000001','capture-fixture','Historical bracelet',53.67,1,
 '{"source":"ebay_fulfillment_api","line":{"lineItemCost":{"value":"53.00","currency":"USD"},"total":{"value":"53.67","currency":"USD"}}}') returning id into line;
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs,obs||'{"key":"failure-1","kind":"failed","source":"activity","time_label":"Oct 2, 4:23 PM"}'),health);
 select id into auction from public.ebay_live_attempts where event_id=event;
 perform pg_temp.verify((select payment_state='paid' and order_line_id=line and amount=53 from public.ebay_live_attempts where id=auction),'exact later paid order resolves old failure without changing auction amount');
 perform pg_temp.verify((select occurred_at='2026-10-02 20:23Z' from public.ebay_live_observations where event_id=event and source_key='failure-1'),'failure retains its original time');
 perform pg_temp.verify(exists(select 1 from public.ebay_live_audit where attempt_id=auction and action='order_reconciled' and details->>'historical_failure_resolved'='true'),'historical payment recovery is audited');
 perform pg_temp.verify((select sold_for=53.67 from public.ebay_order_lines where id=line),'reconciliation leaves imported accounting unchanged');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs,obs||'{"key":"failure-1","kind":"failed","source":"activity","time_label":"Oct 2, 4:23 PM"}'),health);
 perform pg_temp.verify((select count(*)=1 from public.ebay_live_attempts where event_id=event),'recapture is idempotent');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"failure-2","kind":"failed","source":"activity","time_label":"Oct 2, 4:29 PM"}'),health);
 perform pg_temp.verify((select payment_state='paid' from public.ebay_live_attempts where id=auction),'another older failure cannot undo later official payment');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"later-failure","kind":"failed","source":"activity","time_label":"Oct 2, 5:55 PM"}'),health);
 perform pg_temp.verify((select payment_state='review' from public.ebay_live_attempts where id=auction),'failure after official payment stays held');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"replayed-paid"}'),health);
 perform pg_temp.verify((select payment_state='review' from public.ebay_live_attempts where id=auction),'replayed Paid tile cannot clear a later failure');
 update public.ebay_orders set raw_payload=jsonb_set(raw_payload,'{orderPaymentStatus}','"FULLY_REFUNDED"') where id=ord;
 perform pg_temp.verify((select payment_state='review' from public.ebay_live_attempts where id=auction),'refund stays held');
 update public.ebay_orders set status='cancelled' where id=ord;
 perform pg_temp.verify((select payment_state='cancelled' from public.ebay_live_attempts where id=auction),'official cancellation wins');
 -- A different buyer and a shipping-sized price difference are never enough.
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"other-buyer","buyer":"different-buyer","kind":"won","source":"activity","time_label":"Oct 2, 3:00 PM"}'),health);
 perform pg_temp.verify(exists(select 1 from public.ebay_live_attempts where event_id=event and buyer='different-buyer' and order_line_id is null and payment_state='waiting'),'different buyer never shares the order');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"other-price","amount":53.67,"kind":"won","source":"activity","time_label":"Oct 2, 3:01 PM"}'),health);
 perform pg_temp.verify(exists(select 1 from public.ebay_live_attempts where event_id=event and amount=53.67 and order_line_id is null and payment_state='waiting'),'shipping-inclusive total is not accepted as the item price');
end $$;
rollback;
