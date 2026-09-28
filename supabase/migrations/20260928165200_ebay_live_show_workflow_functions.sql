begin;
set local lock_timeout='1s';
set local statement_timeout='15s';
update public.live_sale_sessions set workflow_mode='ebay_live' where id in (select session_id from public.ebay_live_connections);
create or replace function public.link_ebay_live_event(_session_id uuid,_event_id text,_seller_id uuid default null) returns public.ebay_live_connections
language plpgsql security definer set search_path='' as $$
declare v_session public.live_sale_sessions; v_result public.ebay_live_connections;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501'; end if;
 select * into v_session from public.live_sale_sessions where id=_session_id and status='active' for update;
 if not found then raise exception 'Select an active show session' using errcode='22023'; end if;
 if _event_id !~ '^[A-Za-z0-9_-]{6,100}$' or _event_id is null then raise exception 'Enter a valid eBay event URL' using errcode='22023'; end if;
 _seller_id:=coalesce(_seller_id,v_session.primary_seller_employee_id);
 if not exists(select 1 from public.employees where id=_seller_id and active is distinct from false) then raise exception 'Select the active seller' using errcode='22023'; end if;
 insert into public.ebay_live_connections(event_id,session_id,active_seller_id) values(_event_id,_session_id,_seller_id)
 on conflict(event_id) do nothing;
 select * into v_result from public.ebay_live_connections where event_id=_event_id;
 if v_result.session_id<>_session_id then raise exception 'This event is already linked to another show' using errcode='22023'; end if;
 insert into public.ebay_live_audit(event_id,action,details) values(_event_id,'event_linked',jsonb_build_object('session_id',_session_id));
 update public.live_sale_sessions set workflow_mode='ebay_live' where id=_session_id;
 return v_result;
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
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Link this eBay event to a show first' using errcode='22023'; end if;
 if not exists(select 1 from public.live_sale_sessions where id=c.session_id and status='active') then raise exception 'This show has ended' using errcode='22023'; end if;
 seen:=nullif(_health->>'observed_at','')::timestamptz;
 if seen>now()+interval '30 seconds' then seen:=null; end if;
 update public.ebay_live_connections set last_received_at=now(),source_seen_at=greatest(source_seen_at,seen),
 capture_ready=coalesce((_health->>'ready')::boolean,false),
 health=jsonb_build_object('message',left(_health->>'message',250),'version',left(_health->>'version',30),'pending',_health->>'pending') where event_id=_event_id;
 for e in select value from jsonb_array_elements(_events) loop
  key:=e->>'key';kind:=e->>'kind';listing:=nullif(e->>'listing_id','');title:=left(coalesce(e->>'title',''),300);buyer:=left(coalesce(e->>'buyer',''),100);
  if key is null or length(key)>2000 or coalesce(kind,'') not in ('won','paid','failed','cancelled','unknown') or coalesce(e->>'source','') not in ('activity','listing') or octet_length(e::text)>6000 then raise exception 'Invalid stream observation' using errcode='22023'; end if;
  if listing is not null and listing !~ '^[0-9]{8,20}$' then raise exception 'Invalid listing identifier' using errcode='22023'; end if;
  if coalesce(e->>'amount','') ~ '^[0-9]{1,9}([.][0-9]{1,2})?$' then amount:=(e->>'amount')::numeric;else amount:=null;end if;
  insert into public.ebay_live_observations(event_id,source_key,kind,listing_id,listing_title,buyer,amount,time_label,observed_at,source,evidence)
  values(_event_id,key,kind,listing,title,buyer,amount,left(e->>'time_label',40),coalesce(nullif(e->>'observed_at','')::timestamptz,now()),e->>'source',left(e->>'evidence',1000))
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
     values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,key,e->>'time_label',case when coalesce(e->>'stream_offset_seconds','') ~ '^[0-9]{1,6}$' then (e->>'stream_offset_seconds')::int end,c.active_seller_id) returning * into a;
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
    values(_event_id,listing,title,left(e->>'ordinal',30),buyer,amount,c.active_seller_id) returning * into a;
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
 if exists(select 1 from public.ebay_live_observations unresolved where unresolved.event_id=_event_id and unresolved.disposition in ('unmatched','review') and unresolved.kind in ('failed','cancelled','unknown')) then
  update public.ebay_live_connections set capture_ready=false,health=health||jsonb_build_object('message','Unmatched notifications need review') where event_id=_event_id;
 end if;
 return jsonb_build_object('accepted',count_accepted);
end $$;

create or replace function public.get_ebay_live_dashboard(_session_id uuid) returns jsonb language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections; rows jsonb; unmatched jsonb;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 select * into c from public.ebay_live_connections where session_id=_session_id;
 if not found then return jsonb_build_object('connection',null,'attempts','[]'::jsonb,'unmatched','[]'::jsonb);end if;
 select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc),'[]') into rows from (
  select a.*,em.display_name seller_name,
   totals.units, totals.minimum_total, totals.cost_total,
   case when a.payment_state='paid' and a.closed_at is not null and a.resolved_at is null then a.amount-totals.minimum_total end above_minimum,
   case when a.payment_state='paid' and a.closed_at is not null and a.resolved_at is null then a.amount-totals.cost_total-(a.amount*c.fee_percent/100)-c.fee_fixed-c.shipping_per_sale end estimated_profit
  from public.ebay_live_attempts a left join public.employees em on em.id=a.seller_id
  left join lateral (
   select coalesce(sum(quantity),0) units,
   case when count(*)>0 and bool_and(live_unit_minimum is not null) and not exists(select 1 from public.live_sale_manual_lot_items m where m.lot_id=a.lot_id and m.status in ('reserved','packed')) then sum(quantity*live_unit_minimum) end minimum_total,
   case when count(*)>0 and bool_and(live_unit_cost is not null) and not exists(select 1 from public.live_sale_manual_lot_items m where m.lot_id=a.lot_id and m.status in ('reserved','packed')) then sum(quantity*live_unit_cost) end cost_total
   from public.live_sale_lot_items li where li.lot_id=a.lot_id and li.status in ('reserved','packed')
  ) totals on true where a.event_id=c.event_id and a.merged_into is null
 ) x;
 select coalesce(jsonb_agg(to_jsonb(x)),'[]') into unmatched from (select source_key,kind,listing_title,buyer,amount,time_label,evidence,disposition,(kind in ('failed','cancelled','unknown')) blocking from public.ebay_live_observations where event_id=c.event_id and disposition in ('unmatched','review') order by received_at desc limit 100) x;
 return jsonb_build_object('connection',to_jsonb(c),'attempts',rows,'unmatched',unmatched,'server_time',now());
end $$;


create or replace function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;ids uuid[];v_state text;started timestamptz;
begin
 select s.started_at into started from public.ebay_live_connections c join public.live_sale_sessions s on s.id=c.session_id where c.event_id=_event_id;
 for a in select * from public.ebay_live_attempts where event_id=_event_id and resolved_at is null for update loop
  if a.order_line_id is null then
   select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=a.listing_id and lower(eo.buyer_username)=lower(a.buyer) and el.quantity=1 and el.sold_for=a.amount
    and eo.sale_date>=started-interval '10 minutes' and eo.sale_date<=coalesce((select ended_at from public.live_sale_sessions s join public.ebay_live_connections c on c.session_id=s.id where c.event_id=_event_id),now())+interval '10 minutes'
    and not exists(select 1 from public.ebay_live_attempts other where other.id<>a.id and other.merged_into is null and other.event_id=_event_id and other.listing_id=a.listing_id and lower(other.buyer)=lower(a.buyer) and other.amount=a.amount)
    and not exists(select 1 from public.ebay_live_attempts used where used.order_line_id=el.id);
   if cardinality(ids)<>1 or ids is null then continue;end if;
   update public.ebay_live_attempts set order_line_id=ids[1] where id=a.id;
   a.order_line_id:=ids[1];
  end if;
  select * into l from public.ebay_order_lines where id=a.order_line_id;
  select * into o from public.ebay_orders where id=l.order_id;
  v_state:=null;
  if o.status='cancelled' or l.line_status='cancelled' or upper(coalesce(o.raw_payload->>'orderCancelStatus',o.raw_payload#>>'{order,cancelStatus,cancelState}','')) in ('CANCELED','CANCELLED','CANCEL_COMPLETE','CANCEL_PENDING','IN_PROGRESS') then v_state:='cancelled';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}','')) in ('FULLY_REFUNDED','PARTIALLY_REFUNDED') then v_state:='review';
  elsif upper(coalesce(o.raw_payload->>'orderPaymentStatus',o.raw_payload#>>'{order,orderPaymentStatus}',''))='PAID' then
   v_state:=case when a.payment_state in ('failed','cancelled','review') then 'review' else 'paid' end;
  end if;
  if v_state is not null and v_state<>a.payment_state then
   update public.ebay_live_attempts set payment_state=v_state,payment_source='order_import',paid_at=case when v_state='paid' then coalesce(paid_at,now()) else paid_at end,review_note=case when v_state<>'paid' then 'Order import requires payment/bag review' else review_note end,updated_at=now() where id=a.id;
   insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(_event_id,a.id,'order_reconciled',jsonb_build_object('order_line_id',l.id,'state',v_state));
  end if;
 end loop;
end $$;

-- Starting a connected show is atomic: a bad event URL cannot leave a half-created show.
create function public.start_ebay_live_session(_title text,_store_id uuid,_event_id text,_primary_seller_employee_id uuid,_co_seller_employee_ids uuid[] default '{}',_notes text default null) returns public.live_sale_sessions
language plpgsql security definer set search_path='' as $$
declare s public.live_sale_sessions;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 s:=public.start_live_sale_session(_title,_store_id,_notes,(select email from auth.users where id=auth.uid()),_primary_seller_employee_id,_co_seller_employee_ids);
 perform public.link_ebay_live_event(s.id,_event_id,_primary_seller_employee_id);
 select * into s from public.live_sale_sessions where id=s.id;
 return s;
end $$;
revoke all on function public.start_ebay_live_session(text,uuid,text,uuid,uuid[],text) from public,anon,authenticated;
grant execute on function public.start_ebay_live_session(text,uuid,text,uuid,uuid[],text) to authenticated;

-- Repair only the specific first-release artifact: an unclaimed payment-only stub
-- and its single win with the SAME failure minute. Never merge two actual wins.
do $repair$
declare pair record;
begin
 for pair in
  select stub.id stub_id,win.id win_id,stub.event_id
  from public.ebay_live_attempts stub join public.ebay_live_attempts win
   on win.event_id=stub.event_id and win.listing_id=stub.listing_id and lower(win.buyer)=lower(stub.buyer) and win.amount=stub.amount
  where stub.win_key is null and win.win_key is not null and stub.resolved_at is null and win.resolved_at is null
   and stub.lot_id is null and win.lot_id is null and stub.claimed_by is null and win.claimed_by is null
   and stub.verified_at is null and win.verified_at is null and stub.order_line_id is null and win.order_line_id is null
   and stub.payment_state='review' and win.payment_state='review'
   and stub.review_note='Multiple auction attempts match this notification' and win.review_note=stub.review_note
   and exists(select 1 from public.ebay_live_observations o where o.attempt_id=stub.id and o.kind='failed' and o.time_label=win.win_time_label)
   and 2=(select count(*) from public.ebay_live_attempts x where x.event_id=stub.event_id and x.listing_id=stub.listing_id and lower(x.buyer)=lower(stub.buyer) and x.amount=stub.amount and x.resolved_at is null)
 loop
  update public.ebay_live_observations set attempt_id=pair.win_id where attempt_id=pair.stub_id;
  update public.ebay_live_attempts set merged_into=pair.win_id,resolved_at=now(),review_note='Duplicate capture combined with its auction win',updated_at=now() where id=pair.stub_id;
  update public.ebay_live_attempts set review_note='eBay reported both a payment failure and Paid. Verify the latest payment before scanning.',updated_at=now() where id=pair.win_id;
  update public.ebay_live_observations o set attempt_id=pair.win_id,disposition='matched' from public.ebay_live_attempts a where a.id=pair.win_id and o.event_id=a.event_id and o.listing_id=a.listing_id and lower(o.buyer)=lower(a.buyer) and o.amount=a.amount and o.kind='paid' and o.disposition='review';
  insert into public.ebay_live_audit(event_id,attempt_id,action,details) values(pair.event_id,pair.win_id,'duplicate_capture_combined',jsonb_build_object('original_attempt',pair.stub_id,'payment_remains','review'));
 end loop;
end $repair$;
notify pgrst,'reload schema';
commit;
