begin;
set local lock_timeout='2s';
alter table public.ebay_live_connections add column order_check jsonb;

-- Claim a small batch so browser reloads and multiple receivers cannot start
-- concurrent full-account imports. This refreshes existing evidence only.
create function public.claim_ebay_live_order_check(_event_id text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;j jsonb;orders jsonb;batch jsonb;token uuid;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found or c.review_completed_at is not null or c.broadcast_ended_at is null
  or c.history_recovery->>'phase' is distinct from 'read'
  or coalesce((c.history_recovery->>'activity_passes')::int,0)<2
  or coalesce((c.history_recovery->>'listing_passes')::int,0)<2
  or c.history_recovery->>'sold_expected' is null
  or (c.history_recovery->>'sold_seen')::int is distinct from (c.history_recovery->>'sold_expected')::int
  or coalesce(c.health->>'pending','0')<>'0' then return jsonb_build_object('state','waiting','orders','[]'::jsonb);end if;
 j:=c.order_check;
 if j is null or j->>'run_id' is distinct from c.history_recovery->>'run_id' then
  select coalesce(jsonb_agg(order_number order by order_number),'[]') into orders from (
   select distinct o.order_number from public.ebay_live_attempts a
   join public.ebay_order_lines l on l.id=a.order_line_id or (l.item_number=a.listing_id and l.quantity=1 and public.ebay_live_order_item_amount(l)=a.amount)
   join public.ebay_orders o on o.id=l.order_id
   where a.event_id=_event_id and a.event_exclusion is null
    and (l.id=a.order_line_id or o.sale_date between c.stream_start_at-interval '1 day' and c.stream_start_at+interval '2 days')
  ) q;
  if jsonb_array_length(orders)>500 then raise exception 'Too many matching orders; review event scope';end if;
  j:=jsonb_build_object('run_id',c.history_recovery->>'run_id','state','checking','started_at',now(),'order_numbers',orders,'checked',0,'total',jsonb_array_length(orders));
 end if;
 if j->>'state'='complete' or (j->>'lease_until')::timestamptz>now() or (j->>'retry_at')::timestamptz>now() then
  return (j-'order_numbers'-'token')||jsonb_build_object('orders','[]'::jsonb);
 end if;
 select coalesce(jsonb_agg(value order by ordinality),'[]') into batch
  from jsonb_array_elements(j->'order_numbers') with ordinality where ordinality>(j->>'checked')::int and ordinality<=(j->>'checked')::int+8;
 if jsonb_array_length(batch)=0 then
  j:=(j-'lease_until'-'token'-'retry_at'-'error')||jsonb_build_object('state','complete','finished_at',now());
 else
  token:=gen_random_uuid();j:=(j-'error'-'retry_at')||jsonb_build_object('state','checking','token',token,'lease_until',now()+interval '2 minutes');
 end if;
 update public.ebay_live_connections set order_check=j where event_id=_event_id;
 return (j-'order_numbers')||jsonb_build_object('orders',batch);
end $$;
revoke all on function public.claim_ebay_live_order_check(text) from public,anon;
grant execute on function public.claim_ebay_live_order_check(text) to authenticated;

create function public.finish_ebay_live_order_check(_event_id text,_token uuid,_ok boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;j jsonb;n int;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id for update;j:=c.order_check;
 if j->>'token' is distinct from _token::text or _token is null or j->>'run_id' is distinct from c.history_recovery->>'run_id' then
  return jsonb_build_object('state','superseded');end if;
 j:=j-'lease_until'-'token';
 if _ok then
  n:=least((j->>'checked')::int+8,(j->>'total')::int);
  j:=(j-'error'-'retry_at')||jsonb_build_object('checked',n,'state',case when n=(j->>'total')::int then 'complete' else 'checking' end,'updated_at',now());
 else
  j:=j||jsonb_build_object('state','retry','retry_at',now()+interval '1 minute','error','Current eBay orders could not be checked. Automatic retry pending.');
 end if;
 update public.ebay_live_connections set order_check=j where event_id=_event_id;
 perform public.reconcile_ebay_live_orders_internal(_event_id);
 return j-'order_numbers';
end $$;
revoke all on function public.finish_ebay_live_order_check(text,uuid,boolean) from public,anon,authenticated;
grant execute on function public.finish_ebay_live_order_check(text,uuid,boolean) to service_role;


create or replace function public.reconcile_ebay_live_buyer_aliases_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;w public.ebay_live_attempts;s public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;
 h jsonb;ids uuid[];win_at timestamptz;proof jsonb;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id for update;h:=c.history_recovery;
 if c.broadcast_ended_at is null or h->>'phase' is distinct from 'read'
  or coalesce((h->>'activity_passes')::int,0)<2 or coalesce((h->>'listing_passes')::int,0)<2
  or h->>'sold_expected' is null or (h->>'sold_seen')::int is distinct from (h->>'sold_expected')::int
  or coalesce(h->>'live_sales','')!~'^[0-9]{1,9}([.][0-9]{1,2})?$'
  or coalesce(c.health->>'pending','0')<>'0' then return;end if;
 if (select count(*) from public.ebay_live_observations where event_id=_event_id and source='activity' and kind='won') is distinct from (h->>'observed_wins')::int
  or (select sum(amount) from public.ebay_live_observations where event_id=_event_id and source='activity' and kind='won') is distinct from (h->>'live_sales')::numeric then return;end if;
 for w in select * from public.ebay_live_attempts where event_id=_event_id and win_key is not null and merged_into is null and resolved_at is null for update loop
  select occurred_at into win_at from public.ebay_live_observations where event_id=_event_id and source_key=w.win_key and attempt_id=w.id and kind='won' and source='activity';
  if win_at is null then continue;end if;
  select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=w.listing_id and el.quantity=1 and public.ebay_live_order_item_amount(el)=w.amount
    and public.ebay_live_order_buyer_matches(eo,w.buyer) and eo.sale_date>=win_at and eo.sale_date<win_at+interval '1 minute';
  if cardinality(ids)<>1 or ids is null then continue;end if;
  select * into l from public.ebay_order_lines where id=ids[1];select * into o from public.ebay_orders where id=l.order_id;
  select array_agg(x.id) into ids from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=w.listing_id and x.amount=w.amount
   and x.id<>w.id and lower(x.buyer)<>lower(w.buyer) and public.ebay_live_order_buyer_matches(o,x.buyer)
   and x.win_key is null and x.payment_state='paid' and x.merged_into is null and x.resolved_at is null;
  if cardinality(ids)<>1 or ids is null then continue;end if;
  select * into s from public.ebay_live_attempts where id=ids[1] for update;
  if s.seller_id is distinct from w.seller_id or exists(select 1 from public.ebay_live_attempts x where x.id in(w.id,s.id) and
    (x.lot_id is not null or x.claimed_by is not null or x.claimed_at is not null or x.verified_at is not null or x.closed_at is not null
     or x.event_exclusion is not null or coalesce(x.review_note,'') not in ('','Order import requires payment/bag review','Exact eBay order paid after the historical payment failures')))
   or exists(select 1 from public.ebay_live_audit where attempt_id in(w.id,s.id) and action not in ('observation_won','observation_paid','observation_failed','order_reconciled','duplicate_capture_combined'))
   or exists(select 1 from public.ebay_live_observations where attempt_id=s.id and source='activity')
   or exists(select 1 from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=w.listing_id and x.amount=w.amount
    and x.id not in(w.id,s.id) and x.merged_into is null and public.ebay_live_order_buyer_matches(o,x.buyer))
   or (w.order_line_id is not null and w.order_line_id<>l.id) or (s.order_line_id is not null and s.order_line_id<>l.id)
   or exists(select 1 from public.ebay_live_attempts where order_line_id=l.id and id not in(w.id,s.id)) then continue;end if;
  proof:=jsonb_build_object('original_attempt',s.id,'order_line_id',l.id,'order_number',o.order_number,
   'activity_buyer',w.buyer,'listing_buyer',s.buyer,'current_buyer',o.buyer_username,'identity',o.raw_payload->'ebay_buyer_identity','run_id',h->>'run_id');
  update public.ebay_live_observations set attempt_id=w.id where attempt_id=s.id;
  update public.ebay_live_attempts set merged_into=w.id,resolved_at=now(),order_line_id=null,
   review_note='Buyer username changed; capture combined with the same official order and auction win',updated_at=now() where id=s.id;
  update public.ebay_live_attempts set buyer=o.buyer_username,order_line_id=l.id,updated_at=now() where id=w.id;
  insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,w.id,'buyer_alias_capture_combined',proof);
 end loop;
end $$;
revoke all on function public.reconcile_ebay_live_buyer_aliases_internal(text) from public,anon,authenticated;

create or replace function public.reconcile_ebay_live_history_duplicates_internal(_event_id text) returns void
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
     and amount=w.amount and kind='paid' and source='listing'
     and (lower(buyer)=lower(w.buyer) or exists(select 1 from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
      where el.item_number=w.listing_id and el.quantity=1 and public.ebay_live_order_item_amount(el)=w.amount
       and eo.sale_date>=win_at and eo.sale_date<win_at+interval '1 minute'
       and public.ebay_live_order_buyer_matches(eo,w.buyer) and public.ebay_live_order_buyer_matches(eo,ebay_live_observations.buyer))))
   or exists(select 1 from public.ebay_live_observations where event_id=_event_id and listing_id=w.listing_id
    and (kind in ('unknown','cancelled') or (kind='won' and source_key<>w.win_key)
     or (kind='failed' and (occurred_at is null or occurred_at+interval '1 minute'>win_at)))) then continue;end if;
  select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=w.listing_id and public.ebay_live_order_buyer_matches(eo,w.buyer) and el.quantity=1
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
  if o.raw_payload#>>'{ebay_order_evidence,source}'='ebay_fulfillment_api' and o.raw_payload#>>'{ebay_order_evidence,order_number}'=o.order_number then paid:=o.paid_on_date;end if;
  paid:=coalesce(paid,o.paid_on_date);
  if (l.raw_payload->>'source'='ebay_fulfillment_api' and (l.raw_payload->>'orderPaymentStatus' in ('FULLY_REFUNDED','PARTIALLY_REFUNDED') or l.raw_payload->>'orderCancelStatus' in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS')))
   or payment is distinct from 'PAID' or paid is null or paid<win_at or o.status='cancelled' or l.line_status='cancelled'
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


create or replace function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;c public.ebay_live_connections;
 ids uuid[];v_state text;started timestamptz;later_payment boolean;payment_date timestamptz;line_paid boolean;payment_status text;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 select s.started_at into started from public.live_sale_sessions s where s.id=c.session_id;
 -- Repair previously unread date-prefixed clocks using saved original metadata.
 update public.ebay_live_observations set occurred_at=public.ebay_live_activity_time(c.stream_start_at,c.stream_metadata->>'activity_timezone',time_label)
  where event_id=_event_id and source='activity' and occurred_at is null;
 update public.ebay_live_attempts target set sold_at=e.occurred_at,sale_time_source='ebay_activity',sale_time_precision='minute'
  from public.ebay_live_observations e where target.event_id=_event_id and target.merged_into is null
   and e.event_id=target.event_id and e.source_key=target.win_key and e.kind='won' and e.source='activity' and e.occurred_at is not null
   and (target.sold_at is null or (target.sale_time_source='ebay_order'
    and (target.sold_at<e.occurred_at or target.sold_at>=e.occurred_at+interval '1 minute')));
 perform public.reconcile_ebay_live_buyer_aliases_internal(_event_id);
 perform public.reconcile_ebay_live_history_duplicates_internal(_event_id);
 perform public.reconcile_ebay_live_buyer_aliases_internal(_event_id);
 for a in select * from public.ebay_live_attempts where event_id=_event_id and resolved_at is null and merged_into is null for update loop
  if a.order_line_id is null then
   select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=a.listing_id and public.ebay_live_order_buyer_matches(eo,a.buyer) and el.quantity=1
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
    and e.listing_id=a.listing_id and public.ebay_live_order_buyer_matches(o,e.buyer) and e.amount=a.amount)
   or (payment_status='' and l.raw_payload->>'source'='ebay_fulfillment_api' and l.raw_payload->>'orderPaymentStatus'='PAID'
    and a.payment_state in ('waiting','paid') and l.quantity=1 and l.item_number=a.listing_id and public.ebay_live_order_item_amount(l)=a.amount
    and public.ebay_live_order_buyer_matches(o,a.buyer)
    and exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and e.source_key=a.win_key and e.attempt_id=a.id
     and e.kind='won' and e.source='activity' and o.sale_date>=e.occurred_at and o.sale_date<e.occurred_at+interval '1 minute')
    and not exists(select 1 from public.ebay_live_observations e where e.attempt_id=a.id and e.kind in ('failed','cancelled','unknown')));
  if line_paid then payment_status:='PAID';end if;
  if l.raw_payload->>'source'='ebay_fulfillment_api' and l.raw_payload->>'orderPaymentStatus' in ('FULLY_REFUNDED','PARTIALLY_REFUNDED') then
   payment_status:=l.raw_payload->>'orderPaymentStatus';
  end if;
  payment_date:=null;
  begin
   payment_date:=(o.raw_payload#>>'{order,paymentSummary,payments,0,paymentDate}')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then payment_date:=null;
  end;
  if o.raw_payload#>>'{ebay_order_evidence,source}'='ebay_fulfillment_api' and o.raw_payload#>>'{ebay_order_evidence,order_number}'=o.order_number then payment_date:=o.paid_on_date;end if;
  if payment_date is null and line_paid then payment_date:=o.paid_on_date;end if;
  -- A current exact order can resolve an earlier failed retry after the show.
  -- A Paid tile alone cannot. Keep cancellations, manual reviews, unknown
  -- failure times, ambiguous reruns and failures in/after the payment minute held.
  later_payment:=c.broadcast_ended_at is not null and (a.payment_state='failed' or
   (a.payment_state='review' and a.review_note in ('Payment evidence conflicts; verify this attempt on eBay','Order import requires payment/bag review')))
   and not exists(select 1 from public.ebay_live_audit where attempt_id=a.id and action not in
    ('observation_won','observation_paid','observation_failed','order_reconciled','duplicate_capture_combined','buyer_alias_capture_combined'))
   and payment_date is not null
   and l.item_number=a.listing_id and public.ebay_live_order_buyer_matches(o,a.buyer) and public.ebay_live_order_item_amount(l)=a.amount
   and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.merged_into is null and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
   and exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and e.attempt_id=a.id and e.kind='failed')
   and not exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and (e.attempt_id=a.id or e.listing_id=a.listing_id)
    and (e.kind in ('cancelled','unknown') or (e.kind='failed' and (e.occurred_at is null or (e.occurred_at+interval '1 minute'>payment_date and not (
      e.occurred_at=date_trunc('minute',payment_date) and o.sale_date>=e.occurred_at and o.sale_date<=payment_date
      and o.raw_payload#>>'{ebay_order_evidence,source}'='ebay_fulfillment_api'
      and o.raw_payload#>>'{ebay_order_evidence,order_number}'=o.order_number
      and (o.raw_payload#>>'{ebay_order_evidence,checked_at}')::timestamptz>=e.occurred_at+interval '1 minute'
      and exists(select 1 from public.ebay_live_observations win where win.attempt_id=a.id and win.source_key=a.win_key and win.kind='won' and win.occurred_at=e.occurred_at)
     ))))));
  v_state:=null;
  if o.status='cancelled' or l.line_status='cancelled' or (l.raw_payload->>'source'='ebay_fulfillment_api' and l.raw_payload->>'orderCancelStatus' in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS')) or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS') then v_state:='cancelled';
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




create or replace function public.ebay_live_recovery_status(_event_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c public.ebay_live_connections;history jsonb;phase text;saved integer;paid integer;issues integer;listings integer;unmatched integer;pending integer;captured_total numeric;failed_without_win integer;failed_without_win_total numeric;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id;
 if not found then return null;end if;
 history:=coalesce(c.history_recovery,'{}');phase:=coalesce(history->>'phase','unknown');
 select count(*) filter(where event_exclusion is null),count(*) filter(where payment_state='paid' and resolved_at is null),
  count(*) filter(where payment_state<>'paid' and resolved_at is null),count(distinct listing_id)
  into saved,paid,issues,listings from public.ebay_live_attempts where event_id=_event_id and merged_into is null;
 select count(*) into unmatched from public.ebay_live_observations where event_id=_event_id and disposition in ('unmatched','review');
 pending:=case when coalesce(c.health->>'pending','')~'^[0-9]{1,9}$' then (c.health->>'pending')::int else 0 end;
 if phase='read' and (coalesce((history->>'activity_passes')::int,0)<2 or coalesce((history->>'listing_passes')::int,0)<2
  or history->>'sold_expected' is null or (history->>'sold_expected')::int is distinct from (history->>'sold_seen')::int
  or listings<(history->>'sold_expected')::int) then phase:='needs_review';end if;
 select coalesce(sum(a.amount),0),count(*) filter(where a.win_key is null and a.payment_state in ('failed','cancelled','review')
   and exists(select 1 from public.ebay_live_observations e where e.attempt_id=a.id and e.source='activity' and e.kind='failed')),
  coalesce(sum(a.amount) filter(where a.win_key is null and a.payment_state in ('failed','cancelled','review')
   and exists(select 1 from public.ebay_live_observations e where e.attempt_id=a.id and e.source='activity' and e.kind='failed')),0)
  into captured_total,failed_without_win,failed_without_win_total from public.ebay_live_attempts a
  where a.event_id=_event_id and a.merged_into is null and a.resolved_at is null;
 captured_total:=captured_total-failed_without_win_total;
 if phase='read' and history->>'live_sales' is not null and captured_total is distinct from (history->>'live_sales')::numeric then
  phase:='needs_review';history:=history||jsonb_build_object('reason','live_sales');
 end if;
 if phase='live' and c.broadcast_ended_at is not null then phase:='needs_review';end if;
 if phase='reading' and (history->>'observed_at')::timestamptz<now()-interval '30 seconds' then phase:='paused';end if;
 if pending>0 and phase<>'reading' then phase:='syncing';end if;
 if c.order_check is not null and c.order_check->>'run_id'=history->>'run_id' and c.order_check->>'state'<>'complete' then phase:='checking_orders';end if;
 return history||jsonb_build_object('phase',phase,'order_check',c.order_check-'order_numbers'-'token','saved_auctions',saved,'paid_auctions',paid,'payment_issues',issues,
  'excluded_listings',(select count(*) from public.ebay_live_attempts where event_id=_event_id and event_exclusion is not null),'captured_total',captured_total,'failed_without_win',failed_without_win,'failed_without_win_total',failed_without_win_total,'saved_listings',listings,'unmatched_notifications',unmatched,'pending',pending,
  'can_close',phase not in ('reading','syncing','live','checking_orders'),'requires_manual_note',phase in ('paused','needs_review'));
end $$;


commit;
