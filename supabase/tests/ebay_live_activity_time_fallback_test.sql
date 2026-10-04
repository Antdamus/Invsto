begin;
set local statement_timeout='30s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);
 event text:='TIME-'||replace(gen_random_uuid()::text,'-','');s public.live_sale_sessions;a public.ebay_live_attempts;obs jsonb;health jsonb;
 stream jsonb:='{"source":"ebay_event_information","title":"Time fallback fixture","start_local":"2026-10-02T14:15","timezone_label":"EDT","activity_timezone":"America/New_York"}';
begin
 perform set_config('request.jwt.claim.sub',actor::text,true);
 s:=public.start_ebay_live_capture_from_stream(event,seller,'{}',stream);
 obs:='{"key":"win","kind":"won","listing_id":"800000000501","title":"Historical sale","buyer":"time-fixture","amount":379,"currency":"USD","source":"activity","time_label":"Oct 2, 3:02 PM"}';
 health:=jsonb_build_object('stream',stream,'broadcast_ended',true,'observed_at',now());
 perform public.ingest_ebay_live_events(event,jsonb_build_array(obs),health);
 select * into a from public.ebay_live_attempts where event_id=event;
 update public.ebay_live_attempts set sold_at='2026-10-02 12:00Z',sale_time_source='ebay_order',sale_time_precision='second' where id=a.id;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select sold_at='2026-10-02 19:02Z' and sale_time_source='ebay_activity' and sale_time_precision='minute' from public.ebay_live_attempts where id=a.id),'dated win replaces an inconsistent order-import fallback');
 perform pg_temp.verify((select buyer=a.buyer and amount=a.amount and seller_id=a.seller_id and payment_state=a.payment_state from public.ebay_live_attempts where id=a.id),'time correction preserves buyer, price, seller and payment');
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select sold_at='2026-10-02 19:02Z' from public.ebay_live_attempts where id=a.id),'time correction is idempotent');
 update public.ebay_live_attempts set sold_at='2026-10-02 19:02:25Z',sale_time_source='ebay_order',sale_time_precision='second' where id=a.id;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select sold_at='2026-10-02 19:02:25Z' and sale_time_source='ebay_order' and sale_time_precision='second' from public.ebay_live_attempts where id=a.id),'matching order seconds remain precise');
 update public.ebay_live_attempts set sold_at='2026-10-02 19:03Z' where id=a.id;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select sold_at='2026-10-02 19:02Z' and sale_time_source='ebay_activity' from public.ebay_live_attempts where id=a.id),'next minute is outside the win minute');
 update public.ebay_live_attempts set win_key=null,sold_at='2026-10-02 12:00Z',sale_time_source='ebay_order',sale_time_precision='second' where id=a.id;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select sold_at='2026-10-02 12:00Z' and sale_time_source='ebay_order' from public.ebay_live_attempts where id=a.id),'unattached evidence cannot rewrite an order time');
 update public.ebay_live_attempts set win_key='win',sale_time_source='ebay_activity' where id=a.id;
 perform public.reconcile_ebay_live_orders_internal(event);
 perform pg_temp.verify((select sold_at='2026-10-02 12:00Z' from public.ebay_live_attempts where id=a.id),'existing non-order time sources remain untouched');
end $$;
rollback;
