-- Run after the performance migration, inside a transaction that is rolled back.
do $$
declare staff uuid; started timestamptz; old_count integer; new_count integer;
  sid uuid:=gen_random_uuid(); rid uuid:=gen_random_uuid(); before_count integer; after_count integer;
  event_id uuid; task uuid; test_order uuid;
begin
  select user_id into staff from public.employees where active and user_id is not null limit 1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',staff,'role','authenticated')::text,true);
  if not public.can_manage_inventory() then raise exception 'No staff test account'; end if;
  started:=clock_timestamp();
  select count(*) into old_count from public.list_pending_ebay_order_queue('pending',false,1000,0);
  raise notice 'ok legacy queue database time: % ms',round(extract(epoch from clock_timestamp()-started)*1000);
  started:=clock_timestamp();
  select count(*) into new_count from public.list_pending_ebay_order_queue_v2('pending',false,1000,0) q
    where q ? 'line_raw_payload' and q ? 'order_raw_payload';
  assert old_count=new_count,'Queue rows or metadata missing';
  raise notice 'ok v2 queue with metadata: % rows, % ms',new_count,round(extract(epoch from clock_timestamp()-started)*1000);
  insert into public.order_phone_camera_sessions(id,owner_id) values(sid,staff);
  insert into public.order_phone_camera_requests(id,session_id,line_ids) values(rid,sid,'{}');
  update public.order_phone_camera_sessions set current_request_id=rid where id=sid;
  select count(*) into before_count from realtime.messages where topic='pending-orders:updates' and payload->>'session_id'=sid::text;
  assert before_count=3,'Phone broadcasts were not written';
  update public.order_phone_camera_sessions set phone_seen_at=now() where id=sid;
  select count(*) into after_count from realtime.messages where topic='pending-orders:updates' and payload->>'session_id'=sid::text;
  assert after_count=before_count,'Heartbeat must not create a broadcast loop';
  update public.order_phone_camera_requests set saved_at=now() where id=rid;
  select count(*) into after_count from realtime.messages where topic='pending-orders:updates' and payload->>'session_id'=sid::text and private;
  assert after_count=before_count+1,'Saved acknowledgement was not broadcast privately';
  raise notice 'ok phone change broadcasts, heartbeat suppression, and private delivery';
  select id,order_id into task,test_order from public.ebay_order_tasks limit 1;
  assert task is not null,'A fixture task is required for the rolled-back photo check';
  select count(*) into before_count from realtime.messages where topic='pending-orders:updates' and payload->>'order_id'=test_order::text;
  insert into public.ebay_order_task_events(task_id,order_id,action,payload)
    values(task,test_order,'history_extra_photo','{"proof_type":"completion_photo"}') returning id into event_id;
  update public.ebay_order_task_events set photo_attachments='[]' where id=event_id;
  delete from public.ebay_order_task_events where id=event_id;
  select count(*) into after_count from realtime.messages where topic='pending-orders:updates' and payload->>'order_id'=test_order::text and private;
  assert after_count=before_count+3,'Photo add/change/delete notifications missing';
  insert into public.ebay_order_task_events(task_id,order_id,action,payload)
    values(task,test_order,'commented','{"proof_type":"line_note"}');
  assert (select count(*) from realtime.messages where topic='pending-orders:updates' and payload->>'order_id'=test_order::text)=after_count,'Notes should not trigger photo reads';
  raise notice 'ok completion photo add/change/delete broadcasts and unrelated notes ignored';
  perform set_config('realtime.topic','pending-orders:updates',true);
  set local role authenticated;
  assert (select count(*) from realtime.messages where topic='pending-orders:updates' and payload->>'session_id'=sid::text)=4,'Staff cannot receive private updates';
  reset role;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
  begin
    perform public.list_pending_ebay_order_queue_v2('pending',false,1,0);
    raise exception 'Nonstaff accessed the queue';
  exception when insufficient_privilege then null;
  end;
  raise notice 'ok queue denies nonstaff access';
  set local role authenticated;
  assert (select count(*) from realtime.messages where topic='pending-orders:updates' and payload->>'session_id'=sid::text)=0,'Nonstaff can read private updates';
  reset role;
  raise notice 'ok realtime RLS permits staff and denies nonstaff';
end $$;
