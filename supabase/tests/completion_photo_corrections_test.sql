begin;
set local statement_timeout = '25s';
create function pg_temp.verify(ok boolean, label text) returns void language plpgsql as $$
begin
  if ok is distinct from true then raise exception 'Failed: %', label; end if;
  raise notice 'ok %', label;
end $$;
do $$
declare
  actor uuid := (select user_id from public.employees where active is distinct from false
                and role in ('employee','manager','admin') order by (role='employee') desc limit 1);
  order_a uuid := gen_random_uuid(); order_b uuid := gen_random_uuid();
  line_a uuid := gen_random_uuid(); line_b uuid := gen_random_uuid();
  event_a public.ebay_order_task_events; event_b public.ebay_order_task_events;
  other_event public.ebay_order_task_events;
  original jsonb; extra jsonb; replacement jsonb; request_id uuid := gen_random_uuid();
  remove_id uuid := gen_random_uuid(); result jsonb; before_lines jsonb; snapshots jsonb;
  prefix text := 'completion-photos/__correction_test_' || gen_random_uuid()::text;
begin
  perform pg_temp.verify(actor is not null, 'staff fixture actor exists');
  perform pg_temp.verify(not has_function_privilege('anon',
    'public.correct_pending_order_completion_photo(uuid[],text,text,uuid,jsonb)', 'execute'), 'anonymous correction denied');
  insert into public.ebay_orders(id,order_number,buyer_username) values
    (order_a,'__photo_correction_'||order_a,'photo-correction-fixture'),
    (order_b,'__photo_correction_'||order_b,'photo-correction-fixture');
  insert into public.ebay_order_lines(id,order_id,item_number,transaction_id,item_title,quantity) values
    (line_a,order_a,'123456789001','photo-correction-a','Correction fixture A',1),
    (line_b,order_b,'123456789002','photo-correction-b','Correction fixture B',1);
  select jsonb_agg(to_jsonb(l) order by id) into before_lines
    from public.ebay_order_lines l where id in (line_a,line_b);
  original := jsonb_build_object('bucket','order-evidence-photos','path',prefix||'/original.png','label','Original');
  extra := jsonb_build_object('bucket','order-evidence-photos','path',prefix||'/extra.png','label','Keep me');
  replacement := jsonb_build_object('bucket','order-evidence-photos','path',prefix||'/new.png',
    'label','Replacement','signed_by_email','spoofed@example.com');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.email','correction-fixture@example.com',true);
  select * into event_a from public.add_ebay_order_history_extra_photos(order_a,array[line_a],
    jsonb_build_array(original,extra),null,'completion_photo','original-uploader@example.com');
  select * into event_b from public.add_ebay_order_history_extra_photos(order_b,array[line_b],
    jsonb_build_array(original),null,'completion_photo','original-uploader@example.com');
  select * into other_event from public.add_ebay_order_history_extra_photos(order_a,array[line_a],
    jsonb_build_array(original),null,'receipt_screenshot','original-uploader@example.com');

  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.correct_pending_order_completion_photo(array[event_a.id],'order-evidence-photos',prefix||'/original.png',request_id);
    raise exception 'Unauthorized correction succeeded';
  exception when insufficient_privilege then null; end;
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform pg_temp.verify(true,'non-staff correction denied');
  begin
    perform public.correct_pending_order_completion_photo(array[other_event.id],'order-evidence-photos',prefix||'/original.png',request_id);
    raise exception 'Receipt screenshot was changed';
  exception when no_data_found then null; end;
  perform pg_temp.verify(true,'receipt and note events cannot be corrected through this API');
  begin
    perform public.correct_pending_order_completion_photo(array[event_a.id],'order-evidence-photos',prefix||'/original.png',request_id,replacement);
    raise exception 'Missing replacement accepted';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify((select photo_attachments=event_a.photo_attachments from public.ebay_order_task_events where id=event_a.id),
    'missing replacement leaves original untouched');

  -- Test-only storage metadata, rolled back with every other fixture below.
  insert into storage.objects(bucket_id,name) values('order-evidence-photos',prefix||'/new.png');
  execute 'set local role authenticated';
  result := public.correct_pending_order_completion_photo(array[event_a.id,event_b.id],
    'order-evidence-photos',prefix||'/original.png',request_id,replacement);
  perform pg_temp.verify((result->>'updated_events')::int=2,'replacement updates both selected orders atomically');
  perform pg_temp.verify((select photo_attachments->0->>'path'=prefix||'/new.png' and photo_attachments->1=extra
    from public.ebay_order_task_events where id=event_a.id),'replacement preserves sibling photo and position');
  perform pg_temp.verify((select photo_attachments->0->>'signed_by_email'='correction-fixture@example.com'
    from public.ebay_order_task_events where id=event_a.id),'replacement author comes from authenticated identity');
  perform pg_temp.verify((select payload->'completion_photo_changes'->0->'original'=jsonb_build_array(original)
    and payload->'completion_photo_changes'->0->>'signed_by'=actor::text
    from public.ebay_order_task_events where id=event_a.id),'original and correcting actor are audited');
  result := public.correct_pending_order_completion_photo(array[event_a.id,event_b.id],
    'order-evidence-photos',prefix||'/original.png',request_id,replacement);
  perform pg_temp.verify((result->>'updated_events')::int=0,'lost-response replacement retry is idempotent');
  perform pg_temp.verify((select jsonb_array_length(payload->'completion_photo_changes')=1
    from public.ebay_order_task_events where id=event_a.id),'retry adds no duplicate audit');
  perform pg_temp.verify((select photo_attachments=other_event.photo_attachments
    from public.ebay_order_task_events where id=other_event.id),'receipt photo sharing original path is untouched');

  perform public.correct_pending_order_completion_photo(array[event_a.id],'order-evidence-photos',prefix||'/new.png',remove_id);
  perform pg_temp.verify((select photo_attachments=jsonb_build_array(extra) from public.ebay_order_task_events where id=event_a.id),
    'remove detaches only the chosen photo');
  perform pg_temp.verify((select photo_attachments->0->>'path'=prefix||'/new.png' from public.ebay_order_task_events where id=event_b.id),
    'same photo on an order outside remove scope remains');
  perform pg_temp.verify((select latest_photo_count=2 from public.ebay_order_tasks where id=event_a.task_id),
    'task photo count includes retained completion and receipt attachments');
  result := public.correct_pending_order_completion_photo(array[event_a.id],'order-evidence-photos',prefix||'/new.png',remove_id);
  perform pg_temp.verify((result->>'updated_events')::int=0,'lost-response removal retry is idempotent');
  select jsonb_agg(to_jsonb(e) order by id) into snapshots from public.ebay_order_task_events e where id in (event_a.id,event_b.id);
  begin
    perform public.correct_pending_order_completion_photo(array[event_a.id,event_b.id],
      'order-evidence-photos',prefix||'/new.png',gen_random_uuid());
    raise exception 'Stale mixed correction succeeded';
  exception when serialization_failure then null; end;
  perform pg_temp.verify((select jsonb_agg(to_jsonb(e) order by id) from public.ebay_order_task_events e
    where id in (event_a.id,event_b.id))=snapshots,'stale correction rolls back every selected event');
  perform pg_temp.verify((select jsonb_agg(to_jsonb(l) order by id) from public.ebay_order_lines l
    where id in (line_a,line_b))=before_lines,'corrections preserve fulfillment and inventory fields');
end $$;
rollback;
