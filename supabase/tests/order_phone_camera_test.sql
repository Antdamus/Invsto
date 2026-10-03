begin;
set local statement_timeout='25s';
create function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Failed: %',label; end if;
  raise notice 'ok %',label;
end $$;
do $$
declare
  owner uuid := (select user_id from public.employees where active is distinct from false and role in ('employee','manager','admin') limit 1);
  phone uuid := (select user_id from public.employees where active is distinct from false and role in ('employee','manager','admin') and user_id<>owner limit 1);
  sid uuid := gen_random_uuid(); sid2 uuid := gen_random_uuid(); req uuid := gen_random_uuid(); req2 uuid := gen_random_uuid();
  test_order uuid := gen_random_uuid(); line_a uuid := gen_random_uuid(); line_b uuid := gen_random_uuid(); result jsonb; before_lines jsonb;
begin
  perform pg_temp.verify(owner is not null and phone is not null,'two staff actors exist');
  perform pg_temp.verify(not has_table_privilege('authenticated','public.order_phone_camera_sessions','select')
    and not has_table_privilege('authenticated','public.order_phone_camera_requests','insert'),'pairings cannot be enumerated or changed directly');
  perform pg_temp.verify(not has_function_privilege('authenticated','public.order_phone_camera_payload(uuid)','execute')
    and not has_function_privilege('anon','public.read_order_phone_camera(uuid,boolean)','execute'),'private payload and anonymous access denied');
  insert into public.ebay_orders(id,order_number,buyer_username) values(test_order,'__phone_'||test_order,'phone-fixture');
  insert into public.ebay_order_lines(id,order_id,item_number,transaction_id,item_title,quantity) values
    (line_a,test_order,'123456789001','phone-a','Fixture A',1),(line_b,test_order,'123456789002','phone-b','Fixture B',2);
  select jsonb_agg(to_jsonb(l) order by id) into before_lines from public.ebay_order_lines l where l.order_id=test_order;
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.send_order_to_phone(sid,req,array[line_a]);raise exception 'Nonstaff send succeeded';
  exception when insufficient_privilege then null; end;
  perform pg_temp.verify(true,'nonstaff cannot send');
  perform set_config('request.jwt.claim.sub',owner::text,true);perform set_config('request.jwt.claim.email','computer@example.com',true);
  execute 'set local role authenticated';
  result := public.send_order_to_phone(sid,req,array[line_a,line_a]);
  perform pg_temp.verify(result->>'owner_email'='computer@example.com' and result->'request'->>'id'=req::text
    and jsonb_array_length(result->'request'->'lines')=1,'sender identity and exact deduplicated item scope are saved');
  result := public.send_order_to_phone(sid,req2,array[line_b]);
  result := public.send_order_to_phone(sid,req,array[line_a]);
  perform pg_temp.verify(result->'request'->>'id'=req2::text,'late retry does not replace newer order');
  begin
    perform public.send_order_to_phone(sid,req,array[line_b]);raise exception 'Changed request accepted';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify(true,'request retry cannot change scope');
  begin
    perform public.send_order_to_phone(sid,gen_random_uuid(),array[gen_random_uuid()]);raise exception 'Unknown line accepted';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify(true,'invalid order lines denied');
  perform set_config('request.jwt.claim.sub',phone::text,true);perform set_config('request.jwt.claim.email','phone@example.com',true);
  begin
    perform public.read_order_phone_camera(sid,false);raise exception 'Other user read workstation';
  exception when insufficient_privilege then null; end;
  begin
    perform public.send_order_to_phone(sid,gen_random_uuid(),array[line_b]);raise exception 'Other user sent order';
  exception when insufficient_privilege then null; end;
  perform pg_temp.verify(true,'another user cannot control the workstation');
  result := public.read_order_phone_camera(sid,true);
  perform pg_temp.verify(result->>'phone_email'='phone@example.com' and result->>'phone_seen_at' is not null,'QR link pairs authenticated phone staff');
  perform public.mark_order_phone_camera_request(sid,req,'saved');
  result := public.read_order_phone_camera(sid,true);
  perform pg_temp.verify(result->'request'->>'id'=req2::text and result->'request'->>'saved_at' is null,'finishing previous photos cannot mark next order saved');
  begin
    perform public.disconnect_order_phone_camera(sid);raise exception 'Phone disconnected other workstation';
  exception when insufficient_privilege then null; end;
  perform pg_temp.verify(true,'only workstation owner can disconnect');
  perform set_config('request.jwt.claim.sub',owner::text,true);
  begin
    perform public.read_order_phone_camera(sid,true);raise exception 'Different phone account claimed pairing';
  exception when insufficient_privilege then null; end;
  perform pg_temp.verify(true,'existing phone pairing cannot be claimed by another account');
  result := public.send_order_to_phone(sid2,gen_random_uuid(),array[line_b]);
  perform set_config('request.jwt.claim.sub',phone::text,true);
  begin
    perform public.mark_order_phone_camera_request(sid, (result->'request'->>'id')::uuid,'saved');raise exception 'Cross-session request acknowledged';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify(true,'photo acknowledgements cannot cross workstations');
  perform set_config('request.jwt.claim.sub',owner::text,true);
  perform public.disconnect_order_phone_camera(sid);
  perform public.disconnect_order_phone_camera(sid);
  begin
    perform public.read_order_phone_camera(sid,true);raise exception 'Disconnected link accepted';
  exception when no_data_found then null; end;
  perform pg_temp.verify(true,'disconnect is idempotent and revokes old QR link');
  execute 'set local role postgres';
  update public.order_phone_camera_sessions set expires_at=now()-interval '1 second' where id=sid2;
  begin
    perform public.read_order_phone_camera(sid2,true);raise exception 'Expired link accepted';
  exception when no_data_found then null; end;
  perform pg_temp.verify(true,'inactive expired pairing requires new QR');
  perform pg_temp.verify((select jsonb_agg(to_jsonb(l) order by id)=before_lines from public.ebay_order_lines l where l.order_id=test_order),
    'phone handoff never changes order completion or inventory');
end $$;
rollback;
