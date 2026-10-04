begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Old-event Activity includes a calendar date. Keep it when resolving the
-- clock so a different day (or an ambiguous DST instant) is never guessed.
create or replace function public.ebay_live_activity_time(_start timestamptz,_zone text,_clock text) returns timestamptz
language plpgsql stable set search_path='' as $$
declare parts text[]; dated text[]; local_clock time; result timestamptz; matches integer; month_number integer;
begin
 if _start is null or not exists(select 1 from pg_timezone_names where name=_zone) then return null;end if;
 dated:=regexp_match(btrim(_clock),'^([A-Za-z]{3})[[:space:]]+([0-9]{1,2}),[[:space:]]+([0-9]{1,2}:[0-9]{2}[[:space:]]*(AM|PM))$','i');
 if dated is not null then
  month_number:=array_position(array['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'],lower(dated[1]));
  if month_number is null or dated[2]::int not between 1 and 31 then return null;end if;
 end if;
 parts:=regexp_match(coalesce(dated[3],btrim(_clock)),'^([0-9]{1,2}):([0-9]{2})[[:space:]]*(AM|PM)$','i');
 if parts is null or parts[1]::int not between 1 and 12 or parts[2]::int>59 then return null;end if;
 local_clock:=make_time(parts[1]::int%12+case when upper(parts[3])='PM' then 12 else 0 end,parts[2]::int,0);
 with local_dates as (
  select ((_start at time zone _zone)::date+d)+local_clock wall from generate_series(-1,2) d
 ), candidates as (
  select distinct wall,(wall at time zone _zone)+h*interval '30 minutes' instant
  from local_dates cross join generate_series(-4,4) h
 ), valid as (
  select instant from candidates where instant at time zone _zone=wall
   and instant>=_start-interval '2 hours' and instant<_start+interval '22 hours'
   and (dated is null or (extract(month from wall)=month_number and extract(day from wall)=dated[2]::int))
 ) select count(*),min(instant) into matches,result from valid;
 return case when matches=1 then result end;
end $$;

-- Fulfillment's total includes delivery/tax. Match the exact item price;
-- never widen the amount tolerance or rewrite imported accounting fields.
create function public.ebay_live_order_item_amount(_line public.ebay_order_lines) returns numeric
language plpgsql immutable set search_path='' as $$
declare cost jsonb:=_line.raw_payload#>'{line,lineItemCost}';
begin
 if _line.quantity<>1 then return null;end if;
 if _line.raw_payload->>'source'='ebay_fulfillment_api' or cost is not null then
  if cost->>'currency'='USD' and coalesce(cost->>'value','')~'^[0-9]{1,9}([.][0-9]{1,2})?$' then return (cost->>'value')::numeric;end if;
  return null;
 end if;
 return _line.sold_for;
end $$;
revoke all on function public.ebay_live_order_item_amount(public.ebay_order_lines) from public,anon,authenticated;

create or replace function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;c public.ebay_live_connections;
 ids uuid[];v_state text;started timestamptz;later_payment boolean;payment_date timestamptz;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id;
 select s.started_at into started from public.live_sale_sessions s where s.id=c.session_id;
 -- Repair previously unread date-prefixed clocks using saved original metadata.
 update public.ebay_live_observations set occurred_at=public.ebay_live_activity_time(c.stream_start_at,c.stream_metadata->>'activity_timezone',time_label)
  where event_id=_event_id and source='activity' and occurred_at is null;
 update public.ebay_live_attempts target set sold_at=e.occurred_at,sale_time_source='ebay_activity',sale_time_precision='minute'
  from public.ebay_live_observations e where target.event_id=_event_id and target.merged_into is null and target.sold_at is null
   and e.event_id=target.event_id and e.source_key=target.win_key and e.occurred_at is not null;
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
  payment_date:=null;
  begin
   payment_date:=(o.raw_payload#>>'{order,paymentSummary,payments,0,paymentDate}')::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then payment_date:=null;
  end;
  -- A current exact order can resolve an earlier failed retry after the show.
  -- A Paid tile alone cannot. Keep cancellations, manual reviews, unknown
  -- failure times, ambiguous reruns and failures in/after the payment minute held.
  later_payment:=c.broadcast_ended_at is not null and a.payment_state='failed' and payment_date is not null
   and l.item_number=a.listing_id and lower(o.buyer_username)=lower(a.buyer) and public.ebay_live_order_item_amount(l)=a.amount
   and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.merged_into is null and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
   and exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and e.attempt_id=a.id and e.kind='failed')
   and not exists(select 1 from public.ebay_live_observations e where e.event_id=_event_id and (e.attempt_id=a.id or e.listing_id=a.listing_id)
    and (e.kind in ('cancelled','unknown') or (e.kind='failed' and (e.occurred_at is null or e.occurred_at+interval '1 minute'>payment_date))));
  v_state:=null;
  if o.status='cancelled' or l.line_status='cancelled' or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS') then v_state:='cancelled';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}','')) in ('FULLY_REFUNDED','PARTIALLY_REFUNDED') then v_state:='review';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}',''))='PAID' then
   v_state:=case when a.payment_state in ('failed','cancelled','review') and not later_payment then 'review' else 'paid' end;
  end if;
  if v_state is not null and v_state<>a.payment_state then
   update public.ebay_live_attempts set payment_state=v_state,payment_source='order_import',
    paid_at=case when v_state='paid' then coalesce(payment_date,paid_at,now()) else paid_at end,
    review_note=case when later_payment and v_state='paid' then 'Exact eBay order paid after the historical payment failures' when v_state<>'paid' then 'Order import requires payment/bag review' else review_note end,updated_at=now() where id=a.id;
   insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'order_reconciled',jsonb_build_object('order_line_id',l.id,'state',v_state,'historical_failure_resolved',later_payment and v_state='paid','payment_date',payment_date));
  end if;
 end loop;
end $$;

-- The ingestion definition below retains the existing payment/deduplication
-- checks and also compares newly recovered evidence with already imported orders.
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
 health=jsonb_build_object('message',left(_health->>'message',250),'version',left(_health->>'version',30),'pending',_health->>'pending') where event_id=_event_id;
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
   select * into a from public.ebay_live_attempts where event_id=_event_id and win_key=key;
   if not found then
    select array_agg(id) into candidates from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=(e->>'amount')::numeric and x.win_key is null and x.resolved_at is null and x.merged_into is null and (x.payment_state in ('waiting','paid') or exists(select 1 from public.ebay_live_observations prior where prior.attempt_id=x.id and prior.kind in ('failed','cancelled') and prior.time_label=e->>'time_label'));
    if cardinality(candidates)=1 then
     update public.ebay_live_attempts set win_key=key,win_time_label=e->>'time_label',stream_offset_seconds=case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int else stream_offset_seconds end,updated_at=now() where id=candidates[1] returning * into a;
    else
     insert into public.ebay_live_attempts(event_id,listing_id,listing_title,ordinal,buyer,amount,win_key,win_time_label,stream_offset_seconds,seller_id)
     values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,key,e->>'time_label',case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int end,public.ebay_live_seller_at(_event_id,coalesce(o.occurred_at,case when c.broadcast_ended_at is not null or _health->>'broadcast_ended'='true' then c.stream_start_at end,o.observed_at))) returning * into a;
    end if;
   end if;
  else
   select array_agg(id) into candidates from public.ebay_live_attempts x where x.event_id=_event_id and x.listing_id=listing and lower(x.buyer)=lower(e->>'buyer') and x.amount=ingest.amount and x.resolved_at is null;
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
 if jsonb_array_length(_events)>0 then perform public.reconcile_ebay_live_orders_internal(_event_id);end if;
 return jsonb_build_object('accepted',count_accepted);
end $$;

commit;
