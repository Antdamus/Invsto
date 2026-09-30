begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

alter table public.ebay_live_connections add column stream_start_at timestamptz,
 add column stream_metadata jsonb;
alter table public.ebay_live_observations add column occurred_at timestamptz;
alter table public.ebay_live_attempts add column sold_at timestamptz,
 add column sale_time_source text, add column sale_time_precision text;

-- Activity only exposes a clock, to the minute. Anchor it to the event date,
-- never the import date. Support overnight shows and reject ambiguous DST clocks.
create function public.ebay_live_activity_time(_start timestamptz,_zone text,_clock text) returns timestamptz
language plpgsql stable set search_path='' as $$
declare parts text[]; local_clock time; result timestamptz; matches integer;
begin
 if _start is null or not exists(select 1 from pg_timezone_names where name=_zone) then return null; end if;
 parts:=regexp_match(btrim(_clock),'^([0-9]{1,2}):([0-9]{2})[[:space:]]*(AM|PM)$','i');
 if parts is null or parts[1]::int not between 1 and 12 or parts[2]::int>59 then return null;end if;
 local_clock:=make_time(parts[1]::int%12+case when upper(parts[3])='PM' then 12 else 0 end,parts[2]::int,0);
 -- A single-day broadcast may start slightly before its scheduled time.
 -- Round-trip every candidate: nonexistent and repeated local clocks are not guessed.
 with local_dates as (
  select ((_start at time zone _zone)::date+d)+local_clock wall from generate_series(-1,2) d
 ), candidates as (
  select distinct wall, (wall at time zone _zone)+h*interval '30 minutes' instant
  from local_dates cross join generate_series(-4,4) h
 ), valid as (
  select instant from candidates where instant at time zone _zone=wall
   and instant>=_start-interval '2 hours' and instant<_start+interval '22 hours'
 ) select count(*),min(instant) into matches,result from valid;
 return case when matches=1 then result end;
end $$;
revoke all on function public.ebay_live_activity_time(timestamptz,text,text) from public,anon,authenticated;

create function public.apply_ebay_live_stream_metadata(_event_id text,_stream jsonb) returns public.live_sale_sessions
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;s public.live_sale_sessions; local_start timestamp; started timestamptz; zone text; activity_zone text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if jsonb_typeof(_stream) is distinct from 'object' or _stream->>'source' is distinct from 'ebay_event_information'
  or coalesce(_stream->>'start_local','')!~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$'
  or octet_length(_stream::text)>3000 then raise exception 'Read the saved show date from eBay Event information before starting capture' using errcode='22023';end if;
 zone:=upper(btrim(_stream->>'timezone_label'));
 if zone not in ('EST','EDT','CST','CDT','MST','MDT','PST','PDT','AKST','AKDT','HST','UTC','GMT')
  and not exists(select 1 from pg_timezone_names where name=_stream->>'timezone_label') then
  raise exception 'The eBay event timezone is not supported. Check Event information before capture.' using errcode='22023';
 end if;
 if exists(select 1 from pg_timezone_names where name=_stream->>'timezone_label') then zone:=_stream->>'timezone_label';end if;
 activity_zone:=_stream->>'activity_timezone';
 if not exists(select 1 from pg_timezone_names where name=activity_zone) then raise exception 'The capture browser timezone is missing' using errcode='22023';end if;
 local_start:=(_stream->>'start_local')::timestamp;
 started:=local_start at time zone zone;
 if started<'2020-01-01'::timestamptz or started>now()+interval '1 year' then raise exception 'Check the eBay show date' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Link this eBay event to a show first' using errcode='22023';end if;
 if c.stream_metadata is not null and c.stream_metadata->>'activity_timezone' is distinct from activity_zone
  and exists(select 1 from public.ebay_live_observations where event_id=_event_id and source='activity') then
  raise exception 'Use the original capture timezone (%) for this show so its Activity clocks stay consistent',c.stream_metadata->>'activity_timezone' using errcode='22023';
 end if;
 select * into s from public.live_sale_sessions where id=c.session_id;
 if s.status<>'active' or c.review_completed_at is not null then raise exception 'This show is already closed' using errcode='22023';end if;
 if c.stream_metadata is distinct from _stream then
  update public.ebay_live_connections set stream_start_at=started,stream_metadata=_stream where event_id=_event_id;
  update public.live_sale_sessions set started_at=started where id=c.session_id returning * into s;
  update public.ebay_live_observations set occurred_at=public.ebay_live_activity_time(started,activity_zone,time_label)
   where event_id=_event_id and source='activity';
  update public.ebay_live_attempts a set sold_at=public.ebay_live_activity_time(started,activity_zone,win_time_label),
   sale_time_source=case when public.ebay_live_activity_time(started,activity_zone,win_time_label) is not null then 'ebay_activity' end,
   sale_time_precision=case when public.ebay_live_activity_time(started,activity_zone,win_time_label) is not null then 'minute' end
   where event_id=_event_id and (sale_time_source is null or sale_time_source='ebay_activity');
  insert into public.ebay_live_audit(event_id,action,details) values(_event_id,'stream_date_captured',jsonb_build_object('old_start',c.stream_start_at,'stream',_stream));
 end if;
 return s;
end $$;
revoke all on function public.apply_ebay_live_stream_metadata(text,jsonb) from public,anon,authenticated;
grant execute on function public.apply_ebay_live_stream_metadata(text,jsonb) to authenticated;

create function public.start_ebay_live_capture_from_stream(_event_id text,_primary_seller_employee_id uuid,_co_seller_employee_ids uuid[],_stream jsonb)
returns public.live_sale_sessions language plpgsql security definer set search_path='' as $$
declare s public.live_sale_sessions;is_new boolean;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended('ebay-live-capture:'||_event_id,0));
 is_new:=not exists(select 1 from public.ebay_live_connections where event_id=_event_id);
 s:=public.start_ebay_live_capture(_event_id,_primary_seller_employee_id,_co_seller_employee_ids);
 s:=public.apply_ebay_live_stream_metadata(_event_id,_stream);
 if is_new then
  update public.live_sale_sessions set title=coalesce(nullif(left(btrim(_stream->>'title'),200),''),'eBay Live - '||to_char(s.started_at,'Mon DD, YYYY')) where id=s.id returning * into s;
 end if;
 return s;
end $$;
revoke all on function public.start_ebay_live_capture_from_stream(text,uuid,uuid[],jsonb) from public,anon,authenticated;
grant execute on function public.start_ebay_live_capture_from_stream(text,uuid,uuid[],jsonb) to authenticated;

create function public.correct_ebay_live_sale_sellers(_event_id text,_attempt_ids uuid[],_seller_id uuid,_reason text) returns integer
language plpgsql security definer set search_path='' as $$
declare c public.ebay_live_connections;profile jsonb;selected integer;affected integer;mail text;
begin
 if not public.ebay_live_is_admin() then raise exception 'Only admins can correct earlier sales' using errcode='42501';end if;
 if length(btrim(coalesce(_reason,'')))<10 then raise exception 'Explain the seller correction (at least 10 characters)' using errcode='22023';end if;
 select count(distinct id) into selected from unnest(_attempt_ids) id;
 if selected not between 1 and 500 then raise exception 'Select between 1 and 500 sales' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Event is not linked' using errcode='22023';end if;
 perform 1 from public.ebay_live_attempts where event_id=_event_id and id=any(_attempt_ids) and merged_into is null order by id for update;
 get diagnostics affected=row_count;
 if affected<>selected then raise exception 'Some selected sales no longer belong to this show. Refresh and select them again.' using errcode='22023';end if;
 select jsonb_build_object('id',id,'display_name',display_name,'email',email,'role',role) into profile from public.employees where id=_seller_id and active is distinct from false;
 if profile is null then raise exception 'Select an active seller' using errcode='22023';end if;
 select email into mail from auth.users where id=auth.uid();
 insert into public.ebay_live_audit(event_id,attempt_id,action,details)
  select event_id,id,'seller_corrected',jsonb_build_object('old_seller_id',seller_id,'new_seller_id',_seller_id,'reason',_reason,'scope','selected') from public.ebay_live_attempts where event_id=_event_id and id=any(_attempt_ids) and seller_id is distinct from _seller_id;
 update public.ebay_live_attempts set seller_id=_seller_id,updated_at=now() where event_id=_event_id and id=any(_attempt_ids);
 insert into public.live_sale_events(session_id,lot_id,event_type,actor_email,notes,payload)
  select l.session_id,l.id,'stream_seller_corrected',mail,_reason,jsonb_build_object('old_owner_employee_id',l.owner_employee_id,'new_owner_employee_id',_seller_id)
  from public.live_sale_lots l join public.ebay_live_attempts a on a.lot_id=l.id where a.event_id=_event_id and a.id=any(_attempt_ids) and l.owner_employee_id is distinct from _seller_id;
 update public.live_sale_lots l set owner_employee_id=_seller_id,owner_snapshot=profile from public.ebay_live_attempts a
  where a.lot_id=l.id and a.event_id=_event_id and a.id=any(_attempt_ids);
 return selected;
end $$;
revoke all on function public.correct_ebay_live_sale_sellers(text,uuid[],uuid,text) from public,anon,authenticated;
grant execute on function public.correct_ebay_live_sale_sellers(text,uuid[],uuid,text) to authenticated;

-- Remaining function definitions are kept in this migration with their prior
-- payment/claim safeguards intact.

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


create or replace function public.reconcile_ebay_live_orders_internal(_event_id text) returns void
language plpgsql security definer set search_path='' as $$
declare a public.ebay_live_attempts;l public.ebay_order_lines;o public.ebay_orders;ids uuid[];v_state text;started timestamptz;
begin
 select s.started_at into started from public.ebay_live_connections c join public.live_sale_sessions s on s.id=c.session_id where c.event_id=_event_id;
 for a in select * from public.ebay_live_attempts where event_id=_event_id and resolved_at is null for update loop
  if a.order_line_id is null then
   select array_agg(el.id) into ids from public.ebay_order_lines el join public.ebay_orders eo on eo.id=el.order_id
   where el.item_number=a.listing_id and lower(eo.buyer_username)=lower(a.buyer) and el.quantity=1 and el.sold_for=a.amount
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


create or replace function public.update_live_sale_lot_owner(
  _lot_id uuid,
  _owner_employee_id uuid,
  _signed_by_email text default null,
  _verified_owner_email text default null
)
returns public.live_sale_lots
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_old public.live_sale_lots;
  v_lot public.live_sale_lots;
  v_owner_snapshot jsonb := '{}'::jsonb;
  v_actor_email text := nullif(btrim(coalesce(_signed_by_email, '')), '');
  v_verified_owner_email text := nullif(btrim(coalesce(_verified_owner_email, '')), '');
begin
  if not public.can_manage_inventory() then
    raise exception 'Not allowed to update live sale bag owners' using errcode = '42501';
  end if;

  -- Keep the sale and its bag in agreement, using connection/attempt/bag lock order.
  perform 1 from public.ebay_live_connections c where c.session_id=(select session_id from public.live_sale_lots where id=_lot_id) for update;
  perform 1 from public.ebay_live_attempts where lot_id=_lot_id for update;
  select *
    into v_old
  from public.live_sale_lots
  where id = _lot_id
    and status is distinct from 'cancelled';

  if not found then
    raise exception 'Editable live sale bag not found' using errcode = 'P0002';
  end if;

  if _owner_employee_id is null or not exists (
    select 1 from public.employees e
    where e.id = _owner_employee_id
      and e.active is distinct from false
  ) then
    raise exception 'Select an active owner for this auction bag' using errcode = '22023';
  end if;

  select jsonb_build_object(
    'id', e.id,
    'display_name', e.display_name,
    'email', e.email,
    'role', e.role
  )
    into v_owner_snapshot
  from public.employees e
  where e.id = _owner_employee_id;

  update public.live_sale_lots
  set owner_employee_id = _owner_employee_id,
      owner_snapshot = coalesce(v_owner_snapshot, '{}'::jsonb)
  where id = _lot_id
  returning * into v_lot;

  insert into public.live_sale_events (
    session_id,
    lot_id,
    event_type,
    actor_email,
    payload
  )
  values (
    v_lot.session_id,
    v_lot.id,
    case
      when v_old.status = 'packed' then 'packed_lot_owner_updated'
      else 'lot_owner_updated'
    end,
    v_actor_email,
    jsonb_build_object(
      'old_owner_employee_id', v_old.owner_employee_id,
      'new_owner_employee_id', v_lot.owner_employee_id,
      'old_owner_snapshot', v_old.owner_snapshot,
      'new_owner_snapshot', v_lot.owner_snapshot,
      'lot_status', v_old.status,
      'verified_owner_email', v_verified_owner_email,
      'verification_method', case when v_verified_owner_email is null then 'signed_in_user_password' else 'owner_password' end
    )
  );

  insert into public.ebay_live_audit(event_id,attempt_id,action,details)
   select event_id,id,'seller_corrected',jsonb_build_object('old_seller_id',seller_id,'new_seller_id',_owner_employee_id,'scope','signed_bag_owner') from public.ebay_live_attempts where lot_id=_lot_id and seller_id is distinct from _owner_employee_id;
  update public.ebay_live_attempts set seller_id=_owner_employee_id,updated_at=now() where lot_id=_lot_id and seller_id is distinct from _owner_employee_id;
  return v_lot;
end;
$$;

revoke all on function public.update_live_sale_lot_owner(uuid, uuid, text, text) from public;
grant execute on function public.update_live_sale_lot_owner(uuid, uuid, text, text) to authenticated;

notify pgrst,'reload schema';
commit;
