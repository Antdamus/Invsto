begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

alter table public.ebay_live_connections add column history_recovery jsonb;

create function public.normalize_ebay_live_recovery(_value jsonb,_seen timestamptz) returns jsonb
language plpgsql immutable set search_path='' as $$
declare k text;
begin
 if jsonb_typeof(_value) is distinct from 'object' or octet_length(_value::text)>4000
  or _value->>'protocol' is distinct from '1' or coalesce(_value->>'phase','') not in ('live','reading','read','paused','needs_review')
  or coalesce(_value->>'run_id','')!~ '^[a-fA-F0-9-]{36}$' then
  return jsonb_build_object('phase','needs_review','reason','invalid','observed_at',_seen);
 end if;
 foreach k in array array['sold_seen','observed_wins','activity_passes','listing_passes'] loop
  if coalesce(_value->>k,'')!~ '^[0-9]{1,6}$' then return jsonb_build_object('phase','needs_review','reason','invalid','observed_at',_seen);end if;
 end loop;
 if _value->>'sold_expected' is not null and (_value->>'sold_expected')!~ '^[0-9]{1,6}$' then
  return jsonb_build_object('phase','needs_review','reason','invalid','observed_at',_seen);
 end if;
 return jsonb_build_object('protocol',1,'run_id',_value->>'run_id','phase',_value->>'phase','sold_seen',(_value->>'sold_seen')::int,
  'sold_expected',(_value->>'sold_expected')::int,'observed_wins',(_value->>'observed_wins')::int,
  'activity_passes',least(2,(_value->>'activity_passes')::int),'listing_passes',least(2,(_value->>'listing_passes')::int),
  'reason',left(_value->>'reason',30),'observed_at',_seen);
end $$;
revoke all on function public.normalize_ebay_live_recovery(jsonb,timestamptz) from public,anon,authenticated;

create function public.ebay_live_recovery_status(_event_id text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare c public.ebay_live_connections;history jsonb;phase text;saved integer;paid integer;issues integer;listings integer;unmatched integer;pending integer;
begin
 select * into c from public.ebay_live_connections where event_id=_event_id;
 if not found then return null;end if;
 history:=coalesce(c.history_recovery,'{}');phase:=coalesce(history->>'phase','unknown');
 select count(*),count(*) filter(where payment_state='paid' and resolved_at is null),
  count(*) filter(where payment_state<>'paid' and resolved_at is null),count(distinct listing_id)
  into saved,paid,issues,listings from public.ebay_live_attempts where event_id=_event_id and merged_into is null;
 select count(*) into unmatched from public.ebay_live_observations where event_id=_event_id and disposition in ('unmatched','review');
 pending:=case when coalesce(c.health->>'pending','')~'^[0-9]{1,9}$' then (c.health->>'pending')::int else 0 end;
 if phase='read' and (coalesce((history->>'activity_passes')::int,0)<2 or coalesce((history->>'listing_passes')::int,0)<2
  or history->>'sold_expected' is null or (history->>'sold_expected')::int is distinct from (history->>'sold_seen')::int
  or listings<(history->>'sold_expected')::int) then phase:='needs_review';end if;
 if phase='live' and c.broadcast_ended_at is not null then phase:='needs_review';end if;
 if phase='reading' and (history->>'observed_at')::timestamptz<now()-interval '30 seconds' then phase:='paused';end if;
 if pending>0 and phase<>'reading' then phase:='syncing';end if;
 return history||jsonb_build_object('phase',phase,'saved_auctions',saved,'paid_auctions',paid,'payment_issues',issues,
  'saved_listings',listings,'unmatched_notifications',unmatched,'pending',pending,
  'can_close',phase not in ('reading','syncing','live'),'requires_manual_note',phase in ('paused','needs_review'));
end $$;
revoke all on function public.ebay_live_recovery_status(text) from public,anon,authenticated;

-- The existing ingestion, dashboard and completion definitions follow with
-- their payment checks intact. Recovery never establishes payment or inventory.

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
 return jsonb_build_object('accepted',count_accepted);
end $$;



create or replace function public.get_ebay_live_dashboard(_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections; rows jsonb; unmatched jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into c from public.ebay_live_connections where session_id=_session_id;
 if not found then return jsonb_build_object('connection',null,'attempts','[]'::jsonb,'unmatched','[]'::jsonb);end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into rows from (
  select a.*,em.display_name seller_name,public.ebay_live_has_payment_hold(a) payment_hold,
   totals.units, totals.minimum_total, totals.cost_total,
   case when a.payment_state='paid' and a.closed_at is not null and a.resolved_at is null then a.amount-totals.minimum_total end above_minimum,
   case when a.payment_state='paid' and a.closed_at is not null and a.resolved_at is null then a.amount-totals.cost_total-(a.amount*c.fee_percent/100)-c.fee_fixed-c.shipping_per_sale end estimated_profit
  from public.ebay_live_attempts a left join public.employees em on em.id=a.seller_id
  left join lateral (
   select coalesce(sum(quantity),0) units,
    case when count(*)>0 and bool_and(unit_minimum is not null) then sum(quantity*unit_minimum) end minimum_total,
    case when count(*)>0 and bool_and(unit_cost is not null) then sum(quantity*unit_cost) end cost_total
   from (
    select quantity,live_unit_minimum unit_minimum,live_unit_cost unit_cost from public.live_sale_lot_items where lot_id=a.lot_id and status in ('reserved','packed')
    union all
    select quantity,live_unit_minimum,null::numeric from public.live_sale_manual_lot_items where lot_id=a.lot_id and status in ('reserved','packed')
   ) entries
  ) totals on true where a.event_id=c.event_id and a.merged_into is null
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into unmatched from (select source_key,kind,listing_title,buyer,amount,time_label,evidence,disposition,(kind in ('failed','cancelled','unknown')) blocking from public.ebay_live_observations where event_id=c.event_id and disposition in ('unmatched','review') order by received_at desc limit 100) x;
 return jsonb_build_object('connection',to_jsonb(c)||jsonb_build_object('active_seller_name',(select display_name from public.employees where id=c.active_seller_id)),'attempts',rows,'unmatched',unmatched,'post_show',public.ebay_live_post_show_check(c.event_id),'recovery',public.ebay_live_recovery_status(c.event_id),'server_time',now());
end $$;


drop function public.complete_ebay_live_session(uuid,boolean,boolean);
create function public.complete_ebay_live_session(_session_id uuid,_bags_checked boolean,_payments_checked boolean,_history_note text default null) returns void
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;checks jsonb;recovery jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if _bags_checked is distinct from true or _payments_checked is distinct from true then raise exception 'Confirm the physical bags and the final eBay payment review' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where session_id=_session_id for update;
 if not found or c.broadcast_ended_at is null then raise exception 'Mark the broadcast ended before closing the session' using errcode='22023';end if;
 if c.review_completed_at is not null then return;end if;
 if not exists(select 1 from public.live_sale_sessions where id=_session_id and status='active') then raise exception 'This session is already closed' using errcode='22023';end if;
 -- Serialize with capture ingestion and item edits, then recheck the latest payment state.
 perform 1 from public.ebay_live_attempts where event_id=c.event_id order by id for update;
 perform public.reconcile_ebay_live_orders_internal(c.event_id);
 perform 1 from public.live_sale_lots where session_id=_session_id order by id for update;
 checks:=public.ebay_live_post_show_check(c.event_id);
 if (checks->>'open_paid_bags')::int>0 or (checks->>'payment_issues')::int>0 or (checks->>'unmatched_notifications')::int>0 or (checks->>'unlinked_bags')::int>0 then
  raise exception 'Finish all paid bags and resolve outstanding payments, notifications and unlinked bags before closing' using errcode='22023';
 end if;
 if coalesce((c.health->>'pending')::int,0)>0 then raise exception 'The capture helper still has pending notifications. Let them sync before closing' using errcode='22023';end if;
 recovery:=public.ebay_live_recovery_status(c.event_id);
 if recovery->>'can_close'='false' then raise exception 'History is still being read or synced. Wait for recovery to finish before closing.' using errcode='22023';end if;
 if recovery->>'requires_manual_note'='true' and length(btrim(coalesce(_history_note,'')))<10 then raise exception 'Compare the complete eBay history and explain your manual history check before closing.' using errcode='22023';end if;
 update public.ebay_live_connections set review_completed_at=now(),review_completed_by=auth.uid() where event_id=c.event_id;
 perform public.end_live_sale_session(_session_id,null,(select email from auth.users where id=auth.uid()));
 insert into public.ebay_live_audit(event_id,action,details) values(c.event_id,'post_show_completed',checks||jsonb_build_object('bags_checked',true,'payments_checked',true,'history_recovery',recovery,'manual_history_note',left(nullif(btrim(_history_note),''),2000)));
end $$;
revoke all on function public.complete_ebay_live_session(uuid,boolean,boolean,text) from public,anon,authenticated;
grant execute on function public.complete_ebay_live_session(uuid,boolean,boolean,text) to authenticated;

notify pgrst,'reload schema';
commit;
