begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create function public.reconcile_ebay_live_history_duplicates_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;w public.ebay_live_attempts;s public.ebay_live_attempts;
 h jsonb;ids uuid[];l public.ebay_order_lines;o public.ebay_orders;win_at timestamptz;paid timestamptz;payment text;proof jsonb;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 h:=c.history_recovery;
 -- Only complete, independently totalled history can collapse a payment-only
 -- capture artifact. Two actual wins, operator work and ambiguous orders stay held.
 if c.broadcast_ended_at is null or h->>'phase' is distinct from 'read'
  or coalesce((h->>'activity_passes')::int,0)<2 or coalesce((h->>'listing_passes')::int,0)<2
  or h->>'sold_expected' is null or (h->>'sold_seen')::int is distinct from (h->>'sold_expected')::int
  or coalesce(h->>'live_sales','')!~'^[0-9]{1,9}([.][0-9]{1,2})?$'
  or coalesce(c.health->>'pending','0')<>'0' then return;end if;
 if (select count(*) from public.ebay_live_observations where event_id=_event_id and source='activity' and kind='won')
    is distinct from (h->>'observed_wins')::int
  or (select sum(amount) from public.ebay_live_observations where event_id=_event_id and source='activity' and kind='won')
    is distinct from (h->>'live_sales')::numeric then return;end if;
 for w in select * from public.ebay_live_attempts where event_id=_event_id and win_key is not null
  and merged_into is null and resolved_at is null for update loop
  select occurred_at into win_at from public.ebay_live_observations where event_id=_event_id and source_key=w.win_key
   and kind='won' and source='activity' and attempt_id=w.id;
  if win_at is null then continue;end if;
  select array_agg(id) into ids from public.ebay_live_attempts where event_id=_event_id and listing_id=w.listing_id
   and lower(buyer)=lower(w.buyer) and amount=w.amount and merged_into is null;
  if cardinality(ids)<>2 then continue;end if;
  select * into s from public.ebay_live_attempts where id=any(ids) and id<>w.id and win_key is null for update;
  if not found or s.resolved_at is not null or s.seller_id is distinct from w.seller_id then continue;end if;
  if exists(select 1 from public.ebay_live_attempts x where x.id=any(ids) and
   (x.lot_id is not null or x.claimed_by is not null or x.claimed_at is not null or x.verified_at is not null
    or x.closed_at is not null or x.event_exclusion is not null or x.payment_state='cancelled'
    or coalesce(x.review_note,'') not in ('','Multiple auction attempts match this notification',
     'Payment evidence conflicts; verify this attempt on eBay','Order import requires payment/bag review')))
   or exists(select 1 from public.ebay_live_audit where attempt_id=any(ids) and action not in
    ('observation_won','observation_paid','observation_failed','order_reconciled')) then continue;end if;
  if not exists(select 1 from public.ebay_live_observations where attempt_id=s.id and kind='failed' and source='activity')
   or not exists(select 1 from public.ebay_live_observations where event_id=_event_id and listing_id=w.listing_id
     and lower(buyer)=lower(w.buyer) and amount=w.amount and kind='paid' and source='listing')
   or exists(select 1 from public.ebay_live_observations where event_id=_event_id and listing_id=w.listing_id
    and (kind in ('unknown','cancelled') or (kind='won' and source_key<>w.win_key)
     or (kind='failed' and (occurred_at is null or occurred_at+interval '1 minute'>win_at)))) then continue;end if;
  select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=w.listing_id and lower(eo.buyer_username)=lower(w.buyer) and el.quantity=1
    and public.ebay_live_order_item_amount(el)=w.amount and eo.sale_date>=win_at and eo.sale_date<win_at+interval '1 minute';
  if cardinality(ids)<>1 or ids is null then continue;end if;
  if (w.order_line_id is not null and w.order_line_id<>ids[1]) or (s.order_line_id is not null and s.order_line_id<>ids[1])
   or exists(select 1 from public.ebay_live_attempts where order_line_id=ids[1] and id not in (w.id,s.id)) then continue;end if;
  select * into l from public.ebay_order_lines where id=ids[1];
  select * into o from public.ebay_orders where id=l.order_id;
  payment:=upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}',''));
  if payment='' and l.raw_payload->>'source'='ebay_fulfillment_api' then payment:=l.raw_payload->>'orderPaymentStatus';end if;
  paid:=null;
  begin paid:=(o.raw_payload#>>'{order,paymentSummary,payments,0,paymentDate}')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then paid:=null;end;
  paid:=coalesce(paid,o.paid_on_date);
  if payment is distinct from 'PAID' or paid is null or paid<win_at or o.status='cancelled' or l.line_status='cancelled'
   or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) not in ('','NONE_REQUESTED')
   or exists(select 1 from public.ebay_live_observations where event_id=_event_id and listing_id=w.listing_id
     and kind='failed' and (occurred_at is null or occurred_at+interval '1 minute'>paid)) then continue;end if;
  proof:=jsonb_build_object('original_attempt',s.id,'order_line_id',l.id,'official_payment_date',paid,
   'proof','Complete Activity total, one win, exact order in win minute, earlier failures and no operator edits',
   'previous_win_state',w.payment_state,'previous_stub_state',s.payment_state,'run_id',h->>'run_id');
  update public.ebay_live_observations set attempt_id=w.id where attempt_id=s.id;
  update public.ebay_live_observations set attempt_id=w.id,disposition='matched' where event_id=_event_id and listing_id=w.listing_id
   and lower(buyer)=lower(w.buyer) and amount=w.amount and source='listing' and kind='paid' and disposition in ('unmatched','review');
  update public.ebay_live_attempts set merged_into=w.id,resolved_at=now(),order_line_id=null,
   review_note='Payment-only capture combined with its exact order-matched auction win',updated_at=now() where id=s.id;
  -- Payment is proven above, not inferred from the Paid card or from matching totals.
  update public.ebay_live_attempts set order_line_id=l.id,payment_state='paid',payment_source='order_import',paid_at=paid,
   review_note='Exact eBay order paid after the historical payment failures',updated_at=now() where id=w.id;
  insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,w.id,'duplicate_capture_combined',proof);
 end loop;
end $$;
revoke all on function public.reconcile_ebay_live_history_duplicates_internal(text) from public,anon,authenticated;

create or replace function public.reconcile_ebay_live_event_scope_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;a public.ebay_live_attempts;h jsonb;win_count int;win_total numeric;day_count int;win_day date;proof jsonb;line_ids uuid[];order_day date;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id;
 h:=c.history_recovery;
 -- A Sold card alone does not prove this event sold the item. Only exclude a
 -- later-day listing after complete Activity accounts for the exact Live sales
 -- metric. Missing metrics, partial scans and overnight evidence stay untouched.
 if c.broadcast_ended_at is null or c.stream_start_at is null or h->>'phase' is distinct from 'read'
  or coalesce((h->>'activity_passes')::int,0)<2 or coalesce((h->>'listing_passes')::int,0)<2
  or h->>'sold_expected' is null or (h->>'sold_seen')::int is distinct from (h->>'sold_expected')::int
  or coalesce(h->>'live_sales','')!~'^[0-9]{1,9}([.][0-9]{1,2})?$'
  or coalesce(c.health->>'pending','0')<>'0'
  or not exists(select 1 from pg_timezone_names where name=c.stream_metadata->>'activity_timezone')
  or exists(select 1 from public.ebay_live_observations where event_id=_event_id and disposition in ('unmatched','review')) then return;end if;
 select count(*),sum(w.amount),count(distinct (e.occurred_at at time zone (c.stream_metadata->>'activity_timezone'))::date),min((e.occurred_at at time zone (c.stream_metadata->>'activity_timezone'))::date)
  into win_count,win_total,day_count,win_day
  from public.ebay_live_attempts w join public.ebay_live_observations e on e.event_id=w.event_id and e.source_key=w.win_key and e.attempt_id=w.id
  where w.event_id=_event_id and w.merged_into is null and w.resolved_at is null and e.source='activity' and e.kind='won' and e.occurred_at is not null;
 if win_count=0 or win_count is distinct from (h->>'observed_wins')::int or win_total is distinct from (h->>'live_sales')::numeric
  or day_count<>1 or win_day is distinct from (c.stream_start_at at time zone (c.stream_metadata->>'activity_timezone'))::date then return;end if;
 for a in select x.* from public.ebay_live_attempts x
  where x.event_id=_event_id and x.merged_into is null and x.resolved_at is null and x.event_exclusion is null and x.win_key is null
   and x.lot_id is null and x.claimed_at is null and x.verified_at is null and x.closed_at is null and x.review_note is null
   and x.payment_state='paid'
   and not exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and (e.attempt_id=x.id or e.listing_id=x.listing_id) and e.source='activity')
  for update of x loop
  -- An order can already belong to its actual later show. Read its proof
  -- without claiming or changing that show's unique order link.
  select array_agg(l.id),min((o.sale_date at time zone (c.stream_metadata->>'activity_timezone'))::date)
   into line_ids,order_day from public.ebay_order_lines l join public.ebay_orders o on o.id=l.order_id
   where l.item_number=a.listing_id and lower(o.buyer_username)=lower(a.buyer) and l.quantity=1
    and public.ebay_live_order_item_amount(l)=a.amount;
  if cardinality(line_ids)<>1 or line_ids is null or order_day is null or order_day<=win_day
   or (a.order_line_id is not null and a.order_line_id<>line_ids[1]) then continue;end if;
  proof:=jsonb_build_object('reason','later_day_listing_without_event_activity','order_line_id',line_ids[1],'checked_at',now(),'live_sales',win_total,'observed_wins',win_count,'run_id',h->>'run_id');
  update public.ebay_live_attempts set event_exclusion=proof,resolved_at=now(),order_line_id=null,
   review_note='Excluded from this show: this listing sold on a later date; this event''s Activity matches its Live sales total.',updated_at=now() where id=a.id;
  insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'other_event_listing_excluded',proof);
 end loop;
end $$;
revoke all on function public.reconcile_ebay_live_event_scope_internal(text) from public,anon,authenticated;

create or replace function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;c public.ebay_live_connections;
 ids uuid[];v_state text;started timestamptz;later_payment boolean;payment_date timestamptz;line_paid boolean;payment_status text;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id;
 select s.started_at into started from public.live_sale_sessions s where s.id=c.session_id;
 -- Repair previously unread date-prefixed clocks using saved original metadata.
 update public.ebay_live_observations set occurred_at=public.ebay_live_activity_time(c.stream_start_at,c.stream_metadata->>'activity_timezone',time_label)
  where event_id=_event_id and source='activity' and occurred_at is null;
 update public.ebay_live_attempts target set sold_at=e.occurred_at,sale_time_source='ebay_activity',sale_time_precision='minute'
  from public.ebay_live_observations e where target.event_id=_event_id and target.merged_into is null
   and e.event_id=target.event_id and e.source_key=target.win_key and e.kind='won' and e.source='activity' and e.occurred_at is not null
   and (target.sold_at is null or (target.sale_time_source='ebay_order'
    and (target.sold_at<e.occurred_at or target.sold_at>=e.occurred_at+interval '1 minute')));
 perform public.reconcile_ebay_live_history_duplicates_internal(_event_id);
 for a in select * from public.ebay_live_attempts where event_id=_event_id and resolved_at is null and merged_into is null for update loop
  if a.order_line_id is null then
   select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=a.listing_id and lower(eo.buyer_username)=lower(a.buyer) and el.quantity=1
    and public.ebay_live_order_item_amount(el)=a.amount
    and eo.sale_date>=coalesce(a.sold_at,started)-interval '1 day' and eo.sale_date<=coalesce(a.sold_at,started)+interval '2 days'
    and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.merged_into is null and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
    and not exists(select 1 from public.ebay_live_attempts used where used.order_line_id=el.id);
   if cardinality(ids)<>1 or ids is null then continue;end if;
   update public.ebay_live_attempts set order_line_id=ids[1] where id=a.id;
   a.order_line_id:=ids[1];
  end if;
  select * into l from public.ebay_order_lines where id=a.order_line_id;
  select * into o from public.ebay_orders where id=l.order_id;
  if a.sold_at is null and o.sale_date is not null then
   update public.ebay_live_attempts set sold_at=o.sale_date,sale_time_source='ebay_order',sale_time_precision='second' where id=a.id;
  end if;
  payment_status:=upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}',''));
  line_paid:=payment_status='' and l.raw_payload->>'source'='ebay_fulfillment_api' and l.raw_payload->>'orderPaymentStatus'='PAID'
   and exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and e.attempt_id=a.id and e.source='listing' and e.kind='paid'
    and e.listing_id=a.listing_id and lower(e.buyer)=lower(a.buyer) and e.amount=a.amount);
  if line_paid then payment_status:='PAID';end if;
  payment_date:=null;
  begin
   payment_date:=(o.raw_payload#>>'{order,paymentSummary,payments,0,paymentDate}')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then payment_date:=null;
  end;
  if payment_date is null and line_paid then payment_date:=o.paid_on_date;end if;
  -- A current exact order can resolve an earlier failed retry after the show.
  -- A Paid tile alone cannot. Keep cancellations, manual reviews, unknown
  -- failure times, ambiguous reruns and failures in/after the payment minute held.
  later_payment:=c.broadcast_ended_at is not null and (a.payment_state='failed' or
   (a.payment_state='review' and a.review_note in ('Payment evidence conflicts; verify this attempt on eBay','Order import requires payment/bag review')))
   and not exists(select 1 from public.ebay_live_audit where attempt_id=a.id and action not in
    ('observation_won','observation_paid','observation_failed','order_reconciled','duplicate_capture_combined'))
   and payment_date is not null
   and l.item_number=a.listing_id and lower(o.buyer_username)=lower(a.buyer) and public.ebay_live_order_item_amount(l)=a.amount
   and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.merged_into is null and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
   and exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and e.attempt_id=a.id and e.kind='failed')
   and not exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and (e.attempt_id=a.id or e.listing_id=a.listing_id)
    and (e.kind in ('cancelled','unknown') or (e.kind='failed' and (e.occurred_at is null or e.occurred_at+interval '1 minute'>payment_date))));
  v_state:=null;
  if o.status='cancelled' or l.line_status='cancelled' or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS') then v_state:='cancelled';
  elsif payment_status in ('FULLY_REFUNDED','PARTIALLY_REFUNDED') then v_state:='review';
  elsif payment_status='PAID' then
   v_state:=case when a.payment_state in ('failed','cancelled','review') and not later_payment then 'review' else 'paid' end;
  end if;
  if v_state is not null and v_state<>a.payment_state then
   update public.ebay_live_attempts set payment_state=v_state,payment_source='order_import',
    paid_at=case when v_state='paid' then coalesce(payment_date,paid_at,now()) else paid_at end,
    review_note=case when later_payment and v_state='paid' then 'Exact eBay order paid after the historical payment failures' when v_state<>'paid' then 'Order import requires payment/bag review' else review_note end,updated_at=now() where id=a.id;
   insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'order_reconciled',jsonb_build_object('order_line_id',l.id,'state',v_state,'historical_failure_resolved',later_payment and v_state='paid','payment_date',payment_date));
  end if;
 end loop;
 perform public.reconcile_ebay_live_event_scope_internal(_event_id);
end $$;


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
      where el.id=x.order_line_id and el.item_number=x.listing_id and lower(eo.buyer_username)=lower(x.buyer)
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
 -- Capture health is independent of payment holds on individual sales.
 if jsonb_array_length(_events)>0 or (_health#>>'{recovery,phase}'='read' and
  (c.history_recovery->>'phase' is distinct from 'read' or c.history_recovery->>'run_id' is distinct from _health#>>'{recovery,run_id}')) then perform public.reconcile_ebay_live_orders_internal(_event_id);end if;
 return jsonb_build_object('accepted',count_accepted);
end $$;

commit;
