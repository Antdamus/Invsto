begin;
set local lock_timeout='2s';
set local statement_timeout='30s';

create or replace function public.apply_ebay_live_stream_metadata(_event_id text,_stream jsonb) returns public.live_sale_sessions
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
 -- A different browser may read the same show from another zone. Keep the
 -- established clock for sale identity and interpret each observation at ingress.
 if c.stream_metadata->>'activity_timezone' is not null then
  activity_zone:=c.stream_metadata->>'activity_timezone';
  _stream:=jsonb_set(_stream,'{activity_timezone}',to_jsonb(activity_zone));
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

-- Translate a browser's Activity clock and the clock field in its deduplication
-- key together. Existing observations keep their exact key and display label.
create function public.ebay_live_show_clock_event(_event_id text,_start timestamptz,_show_zone text,_source_zone text,_event jsonb)
returns jsonb language plpgsql stable set search_path='' as $$
declare raw_key text:=_event->>'key'; parts text[]:=string_to_array(raw_key,'|');
 raw_clock text:=_event->>'time_label'; instant timestamptz; wall timestamp; label text;
 labels text[]; keys text[]; saved public.ebay_live_observations;
begin
 if _event->>'source' is distinct from 'activity' then return _event;end if;
 if raw_key is null or length(raw_key)>2000 or octet_length(_event::text)>6000 or
    coalesce(_event->>'kind','') not in ('won','paid','failed','cancelled','unknown') then
  raise exception 'Invalid stream observation' using errcode='22023';
 end if;
 if _source_zone=_show_zone and (parts[1]<>'activity' or cardinality(parts)<>6 or _start is null) then return _event;end if;
 if _source_zone=_show_zone and exists(select 1 from public.ebay_live_observations where event_id=_event_id and source_key=raw_key) then return _event;end if;
 instant:=public.ebay_live_activity_time(_start,_source_zone,raw_clock);
 if instant is not null then
  wall:=instant at time zone _show_zone;
  label:=to_char(wall,'FMHH12:MI AM');
 end if;
 if instant is null or public.ebay_live_activity_time(_start,_show_zone,label) is distinct from instant then
  if _source_zone=_show_zone then return _event;end if;
  -- A repeated DST minute or an unreadable clock cannot identify a sale.
  -- Retain the evidence in the existing unmatched queue for staff review.
  return _event||jsonb_build_object('key','clock-review|'||md5(jsonb_build_array(_source_zone,raw_key)::text),
   'kind','unknown','time_label',null,'evidence',left(concat('Verify ',_event->>'kind',' Activity time ',raw_clock,' (',_source_zone,'). ',_event->>'evidence'),1000));
 end if;
 if parts[1]<>'activity' or cardinality(parts)<>6 then
  return _event||jsonb_build_object('time_label',label);
 end if;
 -- eBay shows a month/day on historical rows and a bare clock during a show.
 labels:=array[label,to_char(wall,'HH12:MI AM'),to_char(wall,'Mon FMDD, ')||label,to_char(wall,'Mon FMDD, HH12:MI AM')];
 select array_agg(concat_ws('|',parts[1],parts[2],parts[3],parts[4],
    replace(replace(replace(v,':','%3A'),',','%2C'),' ','%20'),parts[6]) order by ord)
 into keys from unnest(labels) with ordinality as options(v,ord);
 select * into saved from public.ebay_live_observations where event_id=_event_id and source_key=any(keys)
 order by array_position(keys,source_key) limit 1;
 if found then return _event||jsonb_build_object('key',saved.source_key,'time_label',saved.time_label);end if;
 return _event||jsonb_build_object('key',keys[1],'time_label',label);
end $$;
revoke all on function public.ebay_live_show_clock_event(text,timestamptz,text,text,jsonb) from public,anon,authenticated;

create or replace function public.ingest_ebay_live_events(_event_id text,_events jsonb,_health jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; e jsonb; seen timestamptz; c public.ebay_live_connections; batch_zone text;
begin
 if not public.can_manage_inventory() then raise exception 'Inventory access required' using errcode='42501';end if;
 if jsonb_typeof(_events) is distinct from 'array' or jsonb_array_length(_events)>100 then raise exception 'Send up to 100 observations' using errcode='22023';end if;
 select * into c from public.ebay_live_connections where event_id=_event_id for update;
 if not found then raise exception 'Link this eBay event to a show first' using errcode='22023';end if;
 if c.review_completed_at is not null then raise exception 'This show is already closed' using errcode='22023';end if;
 batch_zone:=_health#>>'{stream,activity_timezone}';
 if jsonb_typeof(_health->'stream')='object' then
  -- Identical heartbeats do not need to revalidate or rewrite the show.
  if c.stream_metadata is distinct from _health->'stream' and
     (c.stream_metadata is null or c.stream_metadata-'activity_timezone' is distinct from (_health->'stream')-'activity_timezone') then
   perform public.apply_ebay_live_stream_metadata(_event_id,_health->'stream');
   select * into c from public.ebay_live_connections where event_id=_event_id;
  end if;
  _health:=_health-'stream';
 end if;
 if jsonb_array_length(_events)>0 and c.stream_metadata->>'activity_timezone' is not null then
  select jsonb_agg(public.ebay_live_show_clock_event(_event_id,c.stream_start_at,c.stream_metadata->>'activity_timezone',
                   coalesce(nullif(item->>'activity_timezone',''),batch_zone,c.stream_metadata->>'activity_timezone'),item) order by ord)
  into _events from jsonb_array_elements(_events) with ordinality as obs(item,ord);
 end if;
 result:=public.ingest_ebay_live_events_before_current_payment(_event_id,_events,_health);
 for e in select value from jsonb_array_elements(_events) loop
  if e->>'source'<>'listing' or coalesce(e->>'listing_id','')!~'^[0-9]{8,20}$'
   or (e->>'kind' not in ('paid','failed','cancelled') and not (e->>'kind'='unknown' and e->>'payment_snapshot'='true')) then continue;end if;
  if e->>'kind'='paid' and coalesce(e->>'currency','')<>'USD' then continue;end if;
  seen:=nullif(e->>'observed_at','')::timestamptz;
  if seen is null or seen>now()+interval '30 seconds' then continue;end if;
  insert into public.ebay_live_listing_payments(event_id,listing_id,buyer,amount,kind,observed_at,source_key,evidence)
   values(_event_id,e->>'listing_id',left(e->>'buyer',100),case when coalesce(e->>'amount','')~'^[0-9]{1,9}([.][0-9]{1,2})?$' then (e->>'amount')::numeric end,e->>'kind',seen,e->>'key',left(e->>'evidence',1000))
   on conflict(event_id,listing_id) do update set buyer=excluded.buyer,amount=excluded.amount,kind=excluded.kind,
    observed_at=excluded.observed_at,source_key=excluded.source_key,evidence=excluded.evidence
   where (excluded.kind<>'unknown' and (ebay_live_listing_payments.kind='unknown' or excluded.observed_at>ebay_live_listing_payments.observed_at))
    or (excluded.kind='unknown' and ebay_live_listing_payments.kind='unknown' and excluded.observed_at>ebay_live_listing_payments.observed_at);
  if e->>'kind'='unknown' and e->>'payment_snapshot'='true' then
   update public.ebay_live_observations set disposition='matched'
    where event_id=_event_id and source_key=e->>'key' and source='listing' and kind='unknown' and disposition<>'reviewed';
  end if;
 end loop;
 if jsonb_array_length(_events)>0 then perform public.apply_ebay_live_listing_payments_internal(_event_id);end if;
 return result;
end $$;

notify pgrst,'reload schema';
commit;
