begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Live capture can deliver a current Paid card before older Activity rows.
-- Recover only one unambiguous later win, with Paid read after its entire
-- minute and every failure strictly before it. Preserve all original evidence.
-- Ended shows retain their stricter official-order/history reconciliation.
create function public.reconcile_ebay_live_paid_retry_internal(_event_id text) returns void
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
     or (kind='failed' and (source<>'activity' or occurred_at is null or occurred_at+interval '1 minute'>win_at)))) then continue;end if;
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
   and observed_at>=win_at+interval '1 minute' and observed_at<=now()+interval '30 seconds'
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
    'paid_observed_at',p.observed_at,'previous_state',w.payment_state,'proof','One live win after all failed minutes; current Paid card observed after win minute; no operator work'));
 end loop;
end $$;
revoke all on function public.reconcile_ebay_live_paid_retry_internal(text) from public,anon,authenticated;

create or replace function public.ingest_ebay_live_events(_event_id text,_events jsonb,_health jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
<<ingest>>
declare c public.ebay_live_connections; e jsonb; o public.ebay_live_observations; a public.ebay_live_attempts;
 candidates uuid[]; key text; kind text; listing text; title text; buyer text; amount numeric(12,2); seen timestamptz;
 count_accepted integer:=0; next_state text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 if jsonb_typeof(_events) is distinct from 'array' or jsonb_array_length(_events)>100 then raise exception 'Send up to 100 observations' using errcode='22023'; end if;
 if jsonb_typeof(_health->'stream')='object' then perform public.apply_ebay_live_stream_metadata(_event_id,_health->'stream');end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Link this eBay event to a show first' using errcode='22023'; end if;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023'; end if;
 seen:=nullif(_health->>'observed_at','')::timestamptz;
 if seen>now()+interval '30 seconds' then seen:=null; end if;
 update public.ebay_live_connections set last_received_at=now(),source_seen_at=greatest(source_seen_at,seen),
 capture_ready=coalesce((_health->>'ready')::boolean,false),
 health=jsonb_strip_nulls(jsonb_build_object('message',left(_health->>'message',250),'version',left(_health->>'version',30),'pending',_health->>'pending',
  'diagnostics',public.normalize_ebay_live_diagnostics(_health->'diagnostics'))) where event_id=_event_id;
 if _health ? 'recovery' and seen is not null and (c.history_recovery is null or seen>=coalesce((c.history_recovery->>'observed_at')::timestamptz,'-infinity'::timestamptz)) then
  update public.ebay_live_connections set history_recovery=public.normalize_ebay_live_recovery(_health->'recovery',seen) where event_id=_event_id;
 end if;
 if _health->>'broadcast_ended'='true' and c.broadcast_ended_at is null then
  update public.ebay_live_connections set broadcast_ended_at=clock_timestamp(),broadcast_end_source='ebay_event_ended',capture_ready=false where event_id=_event_id;
  insert into public.ebay_live_audit(event_id,action,details) values(_event_id,'broadcast_ended','{"source":"ebay_event_ended"}');
 end if;
 for e in select value from jsonb_array_elements(_events) loop
  key:=e->>'key';kind:=e->>'kind';listing:=nullif(e->>'listing_id','');title:=left(coalesce(e->>'title',''),300);buyer:=left(coalesce(e->>'buyer',''),100);
  if key is null or length(key)>2000 or coalesce(kind,'') not in ('won','paid','failed','cancelled','unknown') or coalesce(e->>'source','') not in ('activity','listing') or octet_length(e::text)>6000 then raise exception 'Invalid stream observation' using errcode='22023'; end if;
  if listing is not null and listing !~ '^[0-9]{8,20}$' then raise exception 'Invalid listing identifier' using errcode='22023'; end if;
  if coalesce(e->>'amount','') ~ '^[0-9]{1,9}([.][0-9]{1,2})?$' then amount:=(e->>'amount')::numeric;else amount:=null;end if;
  insert into public.ebay_live_observations(event_id,source_key,kind,listing_id,listing_title,buyer,amount,time_label,observed_at,source,evidence,occurred_at)
  values(_event_id,key,kind,listing,title,buyer,amount,left(e->>'time_label',40),coalesce(nullif(e->>'observed_at','')::timestamptz,now()),e->>'source',left(e->>'evidence',1000),case when e->>'source'='activity' then public.ebay_live_activity_time(c.stream_start_at,c.stream_metadata->>'activity_timezone',e->>'time_label') end)
  on conflict(event_id,source_key) do nothing;
  select * into o from public.ebay_live_observations where event_id=_event_id and source_key=key for update;
  if o.disposition in ('matched','reviewed') then continue;end if;
  -- A later visible listing tile can supply the ID missing from an activity row.
  if listing is not null and o.listing_id is null then update public.ebay_live_observations set listing_id=listing where event_id=_event_id and source_key=key;end if;
  if listing is null or title='' or buyer='' or amount is null or coalesce(e->>'currency','')<>'USD' or kind='unknown' then continue;end if;
  a:=null;
  if kind='won' then
   -- New direct Activity invalidates an earlier scope exclusion. Restore it
   -- for review without taking an order line owned by another show.
   update public.ebay_live_attempts x set event_exclusion=null,resolved_at=null,payment_state='review',
    review_note='New auction Activity conflicts with the earlier event exclusion; verify order ownership.',updated_at=now()
    where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=ingest.amount
     and x.event_exclusion is not null and x.lot_id is null returning * into a;
   if found then
    update public.ebay_live_attempts set win_key=key,win_time_label=e->>'time_label' where id=a.id;
    insert into public.ebay_live_audit(event_id,attempt_id,action) values(_event_id,a.id,'event_exclusion_reopened');
   end if;
   select * into a from public.ebay_live_attempts where event_id=_event_id and win_key=key;
   if not found then
    select array_agg(id) into candidates from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=(e->>'amount')::numeric and x.win_key is null and x.resolved_at is null and x.merged_into is null and (x.payment_state in ('waiting','paid') or exists(select 1 from public.ebay_live_observations prior where prior.attempt_id=x.id and prior.kind in ('failed','cancelled') and prior.time_label=e->>'time_label')
     -- Historical failures can arrive before the win in the same batch. A
     -- payment-only record already tied to this exact official order belongs
     -- to its same-minute win even while payment review is still pending.
     -- Attaching evidence never clears the payment hold by itself.
     or (c.broadcast_ended_at is not null and o.occurred_at is not null and exists(
      select 1 from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
      where el.id=x.order_line_id and el.item_number=x.listing_id and public.ebay_live_order_buyer_matches(eo,x.buyer)
       and public.ebay_live_order_item_amount(el)=x.amount
       and eo.sale_date>=o.occurred_at and eo.sale_date<o.occurred_at+interval '1 minute')));
    if cardinality(candidates)=1 then
     update public.ebay_live_attempts set win_key=key,win_time_label=e->>'time_label',stream_offset_seconds=case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int else stream_offset_seconds end,updated_at=now() where id=candidates[1] returning * into a;
    else
     insert into public.ebay_live_attempts(event_id,listing_id,listing_title,ordinal,buyer,amount,win_key,win_time_label,stream_offset_seconds,seller_id)
     values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,key,e->>'time_label',case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int end,public.ebay_live_seller_at(_event_id,coalesce(o.occurred_at,case when c.broadcast_ended_at is not null or _health->>'broadcast_ended'='true' then c.stream_start_at end,o.observed_at))) returning * into a;
    end if;
   end if;
  else
   select array_agg(id) into candidates from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=ingest.amount and x.resolved_at is null and x.merged_into is null;
   if cardinality(candidates)>1 then
    update public.ebay_live_observations set disposition='review' where event_id=_event_id and source_key=key;
    update public.ebay_live_attempts set payment_state='review',review_note='Multiple auction attempts match this notification',updated_at=now() where id=any(candidates);
    continue;
   elsif cardinality(candidates)=1 then
    select * into a from public.ebay_live_attempts where id=candidates[1] for update;
   else
    insert into public.ebay_live_attempts(event_id,listing_id,listing_title,ordinal,buyer,amount,seller_id)
    values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,public.ebay_live_seller_at(_event_id,coalesce(o.occurred_at,case when c.broadcast_ended_at is not null or _health->>'broadcast_ended'='true' then c.stream_start_at end,o.observed_at))) returning * into a;
   end if;
   next_state:=case when kind='paid' then 'paid' when kind='failed' then 'failed' else 'cancelled' end;
   -- A delayed Paid tile must never resurrect a failed/cancelled attempt.
   if next_state='paid' and a.payment_state in ('failed','cancelled','review') then
    next_state:='review';
   end if;
   update public.ebay_live_attempts set payment_state=next_state,payment_source=e->>'source',
    paid_at=case when next_state='paid' then coalesce(paid_at,now()) else paid_at end,
    review_note=case when next_state='review' then 'Payment evidence conflicts; verify this attempt on eBay' else review_note end,updated_at=now()
   where id=a.id returning * into a;
  end if;
  update public.ebay_live_observations set attempt_id=a.id,disposition='matched' where event_id=_event_id and source_key=key;
  insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'observation_'||kind,jsonb_build_object('key',key,'payment_state',a.payment_state));
  count_accepted:=count_accepted+1;
 end loop;
 update public.ebay_live_attempts target set sold_at=evidence.occurred_at,sale_time_source='ebay_activity',sale_time_precision='minute'
 from public.ebay_live_observations evidence where target.event_id=_event_id and target.sold_at is null and evidence.event_id=target.event_id and evidence.source_key=target.win_key and evidence.occurred_at is not null;
 -- Reconcile the complete batch, independent of listing/Activity delivery order.
 if jsonb_array_length(_events)>0 then perform public.reconcile_ebay_live_paid_retry_internal(_event_id);end if;
 -- Capture health is independent of payment holds on individual sales.
 if jsonb_array_length(_events)>0 or (_health#>>'{recovery,phase}'='read' and
  (c.history_recovery->>'phase' is distinct from 'read' or c.history_recovery->>'run_id' is distinct from _health#>>'{recovery,run_id}')) then perform public.reconcile_ebay_live_orders_internal(_event_id);end if;
 return jsonb_build_object('accepted',count_accepted);
end $$;



commit;
