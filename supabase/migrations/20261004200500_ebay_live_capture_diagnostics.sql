begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

-- Bounded layout diagnostics for incomplete history capture. Deliberately omit
-- page HTML, field values, chat text, URLs, cookies and authentication data.
create function public.normalize_ebay_live_diagnostics(_value jsonb) returns jsonb
language plpgsql stable set search_path='' as $$
declare result jsonb; nodes jsonb; controls jsonb:='[]'; ids jsonb; item jsonb; name text; stamp timestamptz;
begin
 if jsonb_typeof(_value) is distinct from 'object' or _value->>'protocol' is distinct from '1' or octet_length(_value::text)>12000 then return null;end if;
 stamp:=(_value->>'observed_at')::timestamptz;
 if stamp is null or coalesce(_value->>'activity_rows','')!~'^[0-9]{1,6}$' then return null;end if;
 result:=jsonb_build_object('protocol',1,'observed_at',stamp,'visibility',case when _value->>'visibility' in ('visible','hidden') then _value->>'visibility' else 'unknown' end,
  'activity_rows',(_value->>'activity_rows')::int,'search_active',_value->'search_active'='true'::jsonb);
 select coalesce(jsonb_agg(value),'[]') into ids from (select value from jsonb_array_elements(case when jsonb_typeof(_value->'tile_ids')='array' then _value->'tile_ids' else '[]' end)
  where jsonb_typeof(value)='string' and value#>>'{}'~'^[0-9]{8,20}$' limit 80) valid;
 result:=result||jsonb_build_object('tile_ids',ids);
 foreach name in array array['listings','activity'] loop
  nodes:='[]';
  for item in select value from jsonb_array_elements(case when jsonb_typeof(_value->name)='array' then _value->name else '[]' end) limit 8 loop
   if jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'top','')!~'^[0-9]{1,8}$' or coalesce(item->>'height','')!~'^[0-9]{1,8}$' or coalesce(item->>'viewport','')!~'^[0-9]{1,8}$' then continue;end if;
   nodes:=nodes||jsonb_build_array(jsonb_build_object('tag',case when item->>'tag'~'^[a-z][a-z0-9-]{0,29}$' then item->>'tag' else 'unknown' end,
    'classes',left(item->>'classes',160),'selected',item->'selected'='true'::jsonb,
    'top',(item->>'top')::int,'height',(item->>'height')::int,'viewport',(item->>'viewport')::int,
    'overflow',case when item->>'overflow' in ('auto','scroll','overlay','visible','hidden','clip') then item->>'overflow' else 'unknown' end));
  end loop;
  result:=result||jsonb_build_object(name,nodes);
 end loop;
 for item in select value from jsonb_array_elements(case when jsonb_typeof(_value->'controls')='array' then _value->'controls' else '[]' end) limit 12 loop
  if item->>'label'~*'^(?:[0-9]{1,3}|Next(?: page)?|Previous(?: page)?|Load more|Show more)$' then
   controls:=controls||jsonb_build_array(jsonb_build_object('label',item->>'label','disabled',item->'disabled'='true'::jsonb));
  end if;
 end loop;
 return result||jsonb_build_object('controls',controls);
exception when invalid_datetime_format or datetime_field_overflow or numeric_value_out_of_range then return null;
end $$;
revoke all on function public.normalize_ebay_live_diagnostics(jsonb) from public,anon,authenticated;

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
