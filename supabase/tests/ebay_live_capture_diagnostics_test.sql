begin;
set local statement_timeout='30s';
create or replace function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label;end if;raise notice 'ok %',label;end $$;
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 seller uuid:=(select id from public.employees where user_id=actor limit 1);
 event text:='DIAG-'||replace(gen_random_uuid()::text,'-','');s public.live_sale_sessions;
 raw jsonb:='{"protocol":1,"observed_at":"2026-10-04T20:00:00Z","activity_rows":12,"visibility":"visible","search_active":false,
 "tile_ids":["287622455043","PRIVATE_ITEM"],"password":"PRIVATE_PASSWORD","listings":[{"tag":"div","classes":"_list_","top":120,"height":800,"viewport":180,"selected":true,"overflow":"auto","html":"PRIVATE_HTML"}],"activity":[],"controls":[{"label":"Next page","disabled":false},{"label":"PRIVATE_BUTTON"}]}';
 value jsonb;
begin
 value:=public.normalize_ebay_live_diagnostics(raw);
 perform pg_temp.verify(value#>>'{listings,0,top}'='120' and value#>>'{listings,0,selected}'='true','preserve selected scroll viewport and position');
 perform pg_temp.verify(value->'tile_ids'='["287622455043"]'::jsonb,'retain only numeric listing identifiers');
 perform pg_temp.verify(value::text not like '%PRIVATE_%','omit arbitrary page content and unknown fields');
 perform pg_temp.verify(jsonb_array_length(value->'controls')=1,'retain recognized pagination controls only');
 perform pg_temp.verify(public.normalize_ebay_live_diagnostics(raw||'{"listings":"bad","controls":true}') is not null,'wrong-shaped optional lists cannot interrupt capture');
 perform pg_temp.verify(public.normalize_ebay_live_diagnostics(raw||'{"observed_at":"not-a-date"}') is null,'invalid timestamp is rejected without raising');
 perform pg_temp.verify(public.normalize_ebay_live_diagnostics(raw||'{"protocol":2}') is null,'unsupported diagnostic protocol is ignored');
 perform pg_temp.verify(public.normalize_ebay_live_diagnostics(raw||jsonb_build_object('unexpected',repeat('x',12000))) is null,'oversized diagnostic payload is discarded');
 value:=public.normalize_ebay_live_diagnostics(raw||jsonb_build_object('listings',(select jsonb_agg(raw#>'{listings,0}') from generate_series(1,12))));
 perform pg_temp.verify(jsonb_array_length(value->'listings')=8,'ancestor collection is bounded');
 perform pg_temp.verify(not has_function_privilege('authenticated','public.normalize_ebay_live_diagnostics(jsonb)','execute'),'normalization helper stays internal');
 perform set_config('request.jwt.claim.sub',actor::text,true);
 s:=public.start_ebay_live_capture_from_stream(event,seller,'{}','{"source":"ebay_event_information","title":"Diagnostics fixture","start_local":"2026-10-02T14:15","timezone_label":"EDT","activity_timezone":"America/New_York"}');
 perform public.ingest_ebay_live_events(event,'[]',jsonb_build_object('version','1.4.2','observed_at',now(),'message','History needs review','diagnostics',raw));
 perform pg_temp.verify((select health#>>'{diagnostics,listings,0,top}'='120' and health->>'version'='1.4.2' from public.ebay_live_connections where event_id=event),'normal authenticated heartbeat stores normalized diagnostics');
 perform pg_temp.verify(not exists(select 1 from public.ebay_live_attempts where event_id=event),'diagnostic heartbeat creates no sale records');
 perform public.ingest_ebay_live_events(event,'[]',jsonb_build_object('observed_at',now(),'diagnostics',raw||'{"observed_at":"bad"}'));
 perform pg_temp.verify((select not health?'diagnostics' from public.ebay_live_connections where event_id=event),'bad diagnostics do not reject the capture heartbeat');
end $$;
rollback;
