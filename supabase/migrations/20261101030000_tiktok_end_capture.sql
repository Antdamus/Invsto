begin;
set local lock_timeout='5s';
create function public.end_tiktok_live_capture(_event_id text,_source text) returns timestamptz
language plpgsql security definer set search_path='' as $$
declare stopped timestamptz;
begin
 if auth.uid() is null or not coalesce(public.can_manage_inventory(),false) then raise exception 'Inventory access required' using errcode='42501';end if;
 if _source is null or _source not in ('staff','tiktok_console') then raise exception 'Invalid end confirmation';end if;
 update public.tiktok_live_connections set broadcast_ended_at=clock_timestamp() where event_id=_event_id and broadcast_ended_at is null
 returning broadcast_ended_at into stopped;
 if found then
  insert into public.tiktok_live_audit(event_id,action,details) values(_event_id,'broadcast_end_confirmed',jsonb_build_object('source',_source));
 else
  select broadcast_ended_at into strict stopped from public.tiktok_live_connections where event_id=_event_id;
 end if;
 return stopped;
end$$;
revoke all on function public.end_tiktok_live_capture(text,text) from public,anon;
grant execute on function public.end_tiktok_live_capture(text,text) to authenticated;

-- Older receivers also poll with empty batches. An ended show must keep its last real heartbeat.
do $$declare def text; guard text:='for e in select value from jsonb_array_elements(_events) loop';begin
 def:=pg_get_functiondef('public.ingest_tiktok_live_events(text,jsonb,jsonb)'::regprocedure);
 if strpos(def,guard)=0 then raise exception 'Unexpected TikTok capture function';end if;
 def:=replace(def,guard,$code$if c.broadcast_ended_at is not null then
   if jsonb_array_length(_events)=0 then return jsonb_build_object('accepted',0,'ended',true);end if;
   if exists(select 1 from jsonb_array_elements(_events) ev where (ev->>'observed_at')::timestamptz>c.broadcast_ended_at) then
    raise exception 'This TikTok show has ended; later observations need review';
   end if;
  end if;
  $code$||guard);
 def:=replace(def,'update public.tiktok_live_connections set last_received_at=now(),health=', 'if c.broadcast_ended_at is null then update public.tiktok_live_connections set last_received_at=now(),health=');
 def:=replace(def,'return jsonb_build_object(''accepted'',accepted);',$code$end if;
  if _health->>'broadcast_ended'='true' then
   c.broadcast_ended_at:=public.end_tiktok_live_capture(_event_id,'tiktok_console');
  end if;
  return jsonb_build_object('accepted',accepted,'ended',c.broadcast_ended_at is not null);$code$);
 execute def;
 def:=pg_get_functiondef('public.start_tiktok_live_capture(text,uuid,jsonb)'::regprocedure);
 if strpos(def,'if s.status<>''active'' or c.review_completed_at is not null')=0 then raise exception 'Unexpected TikTok start function';end if;
 execute replace(def,'if s.status<>''active'' or c.review_completed_at is not null','if s.status<>''active'' or c.broadcast_ended_at is not null or c.review_completed_at is not null');
end$$;
notify pgrst,'reload schema';
commit;
