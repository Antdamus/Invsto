begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Live capture can deliver a current Paid card before older Activity rows.
-- Recover only one unambiguous later win. A Failed card read before the win
-- minute and a Paid card read during/after it prove the status transition even
-- when payment is quick. Every failed Activity minute must still precede the
-- win; a Failed card read in/after that minute remains a hold.
-- Ended shows retain their stricter official-order/history reconciliation.
create or replace function public.reconcile_ebay_live_paid_retry_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections; w public.ebay_live_attempts;
 ids uuid[]; stub uuid; win_at timestamptz; p public.ebay_live_observations;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found or c.broadcast_ended_at is not null or c.review_completed_at is not null
  or c.stream_start_at is null
  or not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then return;end if;
 for w in select * from public.ebay_live_attempts where event_id=_event_id
  and win_key is not null and merged_into is null and resolved_at is null
  and lot_id is null and verified_at is null and payment_state<>'cancelled' for update loop
  select occurred_at into win_at from public.ebay_live_observations
   where event_id=_event_id and source_key=w.win_key and attempt_id=w.id and source='activity' and kind='won';
  if win_at is null or win_at<c.stream_start_at-interval '2 hours' or win_at>now() then continue;end if;
  -- Multiple real wins (including another buyer), unknown clocks, cancellations,
  -- and same-minute/later failures cannot be resolved from a listing badge.
  if (select count(*) from public.ebay_live_observations where event_id=_event_id and listing_id=w.listing_id and kind='won')<>1
   or exists(select 1 from public.ebay_live_observations where event_id=_event_id and listing_id=w.listing_id
    and (disposition='reviewed' or kind in ('unknown','cancelled')
     or (kind='failed' and ((source='activity' and (occurred_at is null or occurred_at+interval '1 minute'>win_at))
      or (source='listing' and observed_at>=win_at) or source not in ('activity','listing'))))) then continue;end if;
  select array_agg(id) into ids from public.ebay_live_attempts where event_id=_event_id and listing_id=w.listing_id and merged_into is null;
  if cardinality(ids) not between 1 and 2 or exists(select 1 from public.ebay_live_attempts x where id=any(ids)
    and (lower(x.buyer)<>lower(w.buyer) or x.amount<>w.amount or x.seller_id is distinct from w.seller_id
     or x.resolved_at is not null or x.lot_id is not null or x.order_line_id is not null
     or x.claimed_by is not null or x.claimed_at is not null or x.verified_at is not null or x.closed_at is not null
     or x.event_exclusion is not null or x.payment_state='cancelled'
     or coalesce(x.review_note,'') not in ('','Multiple auction attempts match this notification',
      'Payment evidence conflicts; verify this attempt on eBay')))
   or exists(select 1 from public.ebay_live_audit where attempt_id=any(ids)
    and action not in ('observation_won','observation_paid','observation_failed')) then continue;end if;
  if not exists(select 1 from public.ebay_live_observations where event_id=_event_id
   and attempt_id=any(ids) and kind='failed' and source='activity') then continue;end if;
  select * into p from public.ebay_live_observations where event_id=_event_id and listing_id=w.listing_id
   and lower(buyer)=lower(w.buyer) and amount=w.amount and source='listing' and kind='paid'
   and (attempt_id is null or attempt_id=any(ids)) and disposition<>'reviewed'
   and observed_at<=now()+interval '30 seconds'
   and (observed_at>=win_at+interval '1 minute' or (observed_at>=win_at and exists(
    select 1 from public.ebay_live_observations prior where prior.event_id=_event_id and prior.listing_id=w.listing_id
     and lower(prior.buyer)=lower(w.buyer) and prior.amount=w.amount and prior.kind='failed' and prior.source='listing'
     and prior.attempt_id=any(ids) and prior.observed_at<win_at)))
   order by observed_at desc limit 1;
  if not found then continue;end if;
  -- Imported cancellation/refund evidence always takes precedence over a badge.
  if exists(select 1 from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
   where l.item_number=w.listing_id and public.ebay_live_order_buyer_matches(o,w.buyer)
    and (o.status='cancelled' or l.line_status='cancelled'
     or upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}','')) in ('FULLY_REFUNDED','PARTIALLY_REFUNDED')
     or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) not in ('','NONE_REQUESTED')
     or (l.raw_payload->>'source'='ebay_fulfillment_api' and
      (l.raw_payload->>'orderPaymentStatus' in ('FULLY_REFUNDED','PARTIALLY_REFUNDED')
       or coalesce(l.raw_payload->>'orderCancelStatus','') not in ('','NONE_REQUESTED'))))) then continue;end if;
  select id into stub from public.ebay_live_attempts where id=any(ids) and id<>w.id and win_key is null;
  update public.ebay_live_observations set attempt_id=w.id where event_id=_event_id and attempt_id=stub;
  update public.ebay_live_observations set attempt_id=w.id,disposition='matched'
   where event_id=_event_id and source_key=p.source_key;
  update public.ebay_live_attempts set merged_into=w.id,resolved_at=now(),updated_at=now(),
   review_note='Earlier failed-payment capture combined with the later paid auction win' where id=stub;
  update public.ebay_live_attempts set payment_state='paid',payment_source='listing',paid_at=p.observed_at,
   review_note='Paid on eBay after the earlier failed payment and later auction win',updated_at=now() where id=w.id;
  insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,w.id,'live_paid_retry_reconciled',
   jsonb_build_object('original_attempt',stub,'win_key',w.win_key,'win_at',win_at,'paid_key',p.source_key,
    'paid_observed_at',p.observed_at,'previous_state',w.payment_state,'proof','One live win after all failed minutes; Paid after win minute or explicit earlier Failed-to-Paid listing transition; no operator work'));
 end loop;
end $$;
revoke all on function public.reconcile_ebay_live_paid_retry_internal(text) from public,anon,authenticated;


commit;
