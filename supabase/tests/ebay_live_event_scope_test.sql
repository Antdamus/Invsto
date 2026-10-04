begin;
set local statement_timeout='30s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);
 event text:='SCOPE-'||replace(gen_random_uuid()::text,'-','');s public.live_sale_sessions;ord uuid;line uuid;extra uuid;win uuid;obs jsonb;health jsonb;recovery jsonb;result jsonb;
 stream jsonb:='{"source":"ebay_event_information","title":"Event scope fixture","start_local":"2026-10-01T10:04","timezone_label":"EDT","activity_timezone":"America/New_York"}';
begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 s:=public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
 insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
 values('__scope_'||gen_random_uuid(),'scope-buyer','2026-10-01 15:34:35Z','2026-10-01 15:34:40Z','{}') returning id into ord;
 insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
 values(ord,'800000000601','fixture','This event auction',52,1,'{"source":"ebay_fulfillment_api","orderPaymentStatus":"PAID","line":{"lineItemCost":{"value":"42.00","currency":"USD"}}}') returning id into line;
 obs:='{"key":"tile","kind":"paid","listing_id":"800000000601","title":"This event auction","buyer":"scope-buyer","amount":42,"currency":"USD","source":"listing"}';
 health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now(),'pending',0);
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health);
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs,obs||'{"key":"failure","kind":"failed","source":"activity","time_label":"Oct 1, 11:33 AM"}',obs||'{"key":"win","kind":"won","source":"activity","time_label":"Oct 1, 11:34 AM"}'),health);
 select id into win from public.ebay_live_attempts where event_id=event and win_key='win';
 perform pg_temp.verify((select payment_state='paid' from public.ebay_live_attempts where id=win),'paid API line plus Paid tile and later order payment resolve an earlier failure');
 update public.ebay_orders set raw_payload='{"orderPaymentStatus":"FULLY_REFUNDED"}' where id=ord;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select payment_state='review' from public.ebay_live_attempts where id=win),'header refund overrides the older paid line');
 update public.ebay_orders set raw_payload='{}' where id=ord;
 update public.ebay_live_attempts set payment_state='failed',review_note=null where id=win;
 update public.ebay_live_observations set occurred_at='2026-10-01 15:35Z' where event_id=event and source_key='failure';
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select payment_state='review' from public.ebay_live_attempts where id=win),'line payment cannot clear a later failure');
 update public.ebay_live_attempts set payment_state='failed',review_note=null where id=win;
 update public.ebay_live_observations set occurred_at='2026-10-01 15:33Z',kind='unknown' where event_id=event and source_key='tile';
 update public.ebay_live_observations set occurred_at='2026-10-01 15:33Z' where event_id=event and source_key='failure';
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select payment_state='failed' from public.ebay_live_attempts where id=win),'an uncorroborated paid line cannot clear a failure');
 update public.ebay_live_observations set kind='paid',occurred_at=null where event_id=event and source_key='tile';
 perform public.reconcile_ebay_live_orders_internal(event);
 insert into public.ebay_orders(order_number,buyer_username,sale_date,paid_on_date,raw_payload)
 values('__scope_later_'||gen_random_uuid(),'later-buyer','2026-10-02 15:00Z','2026-10-02 15:00:05Z','{"orderPaymentStatus":"PAID"}') returning id into ord;
 insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,sold_for,quantity,raw_payload)
 values(ord,'800000000602','fixture','Reused listing',65,1,'{"source":"ebay_fulfillment_api","line":{"lineItemCost":{"value":"55.00","currency":"USD"}}}') returning id into line;
 obs:='{"key":"later-tile","kind":"paid","listing_id":"800000000602","title":"Reused listing","buyer":"later-buyer","amount":55,"currency":"USD","source":"listing"}';
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health);
 select id into extra from public.ebay_live_attempts where event_id=event and listing_id='800000000602';
 recovery:=jsonb_build_object('protocol',1,'run_id',gen_random_uuid(),'phase','read','sold_seen',2,'sold_expected',2,'observed_wins',1,'activity_passes',2,'listing_passes',2,'live_sales',42);
 update public.ebay_live_connections set history_recovery=public.normalize_ebay_live_recovery(recovery-'live_sales',now()) where event_id=event;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select event_exclusion is null from public.ebay_live_attempts where id=extra),'missing Live sales does not exclude a listing');
 update public.ebay_live_connections set history_recovery=public.normalize_ebay_live_recovery(recovery||'{"live_sales":97}',now()) where event_id=event;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select event_exclusion is null from public.ebay_live_attempts where id=extra),'incomplete Activity totals do not exclude a listing');
 update public.ebay_live_connections set history_recovery=public.normalize_ebay_live_recovery(recovery||'{"phase":"reading"}',now()) where event_id=event;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select event_exclusion is null from public.ebay_live_attempts where id=extra),'partial scan does not exclude a listing');
 update public.ebay_live_connections set history_recovery=public.normalize_ebay_live_recovery(recovery,now()) where event_id=event;
 update public.ebay_orders set sale_date='2026-10-01 16:00Z' where id=ord;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select event_exclusion is null from public.ebay_live_attempts where id=extra),'same-day orders remain available for review');
 perform pg_temp.verify(public.ebay_live_recovery_status(event)->>'phase'='needs_review','a completed scan with an unexplained Live sales mismatch requires review');
 update public.ebay_orders set sale_date='2026-10-02 15:00Z' where id=ord;
 update public.ebay_live_attempts set claimed_at=now() where id=extra;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select event_exclusion is null from public.ebay_live_attempts where id=extra),'a claimed sale is never automatically excluded');
 update public.ebay_live_attempts set claimed_at=null where id=extra;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select event_exclusion is not null and resolved_at is not null and order_line_id is null and payment_state='paid' from public.ebay_live_attempts where id=extra),'proven later-day listing is preserved outside the event and releases its order link');
 perform pg_temp.verify((select (event_exclusion->>'order_line_id')::uuid=line from public.ebay_live_attempts where id=extra),'excluded order link remains in audit evidence');
 perform pg_temp.verify((select count(*)=1 from public.ebay_live_audit where event_id=event and action='other_event_listing_excluded'),'scope correction is audited');
 result:=public.ebay_live_recovery_status(event);
 perform pg_temp.verify((result->>'saved_auctions')::int=1 and (result->>'paid_auctions')::int=1 and (result->>'excluded_listings')::int=1 and result->>'phase'='read','coverage counts include inspected listings but omit the other event sale');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health||jsonb_build_object('recovery',recovery));
 perform pg_temp.verify((select count(*)=2 from public.ebay_live_attempts where event_id=event),'recapturing excluded tiles does not recreate sales');
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs||'{"key":"later-win","kind":"won","source":"activity","time_label":"Oct 1, 12:00 PM"}'),health);
 perform pg_temp.verify((select event_exclusion is null and resolved_at is null and payment_state='review' and win_key='later-win' from public.ebay_live_attempts where id=extra),'new event Activity reopens an exclusion for review without silently claiming an order');
 perform pg_temp.verify((select count(*)=2 from public.ebay_live_attempts where event_id=event),'new Activity restores its existing record instead of duplicating it');
end $$;
rollback;
