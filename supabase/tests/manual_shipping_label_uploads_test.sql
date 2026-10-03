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
  order_a uuid := gen_random_uuid(); order_b uuid := gen_random_uuid(); order_c uuid := gen_random_uuid();
  line_a uuid := gen_random_uuid(); line_a2 uuid := gen_random_uuid(); line_b uuid := gen_random_uuid();
  request_id uuid := gen_random_uuid(); bad_request uuid := gen_random_uuid();
  prefix text := 'manual-labels/__label_test_'||gen_random_uuid()::text;
  labels jsonb; invalid_labels jsonb; result jsonb; before_lines jsonb; event_count int;
begin
  perform pg_temp.verify(actor is not null,'staff fixture actor exists');
  perform pg_temp.verify(not has_function_privilege('anon','public.attach_manual_shipping_labels(uuid,jsonb)','execute'),'anonymous upload denied');
  perform pg_temp.verify(has_function_privilege('authenticated','public.attach_manual_shipping_labels(uuid,jsonb)','execute'),'authenticated staff can call upload');
  insert into public.ebay_orders(id,order_number,buyer_username) values
    (order_a,'__manual_label_'||order_a,'label-fixture'),(order_b,'__manual_label_'||order_b,'label-fixture'),
    (order_c,'__manual_label_'||order_c,'label-fixture');
  update public.ebay_orders set label_storage_bucket='ebay-labels',label_file_path='existing/label.pdf',label_status='completed',
    label_metadata='{"trackingNumber":"111111111111"}' where id=order_b;
  insert into public.ebay_order_lines(id,order_id,item_number,transaction_id,item_title,quantity) values
    (line_a,order_a,'123456789001','label-a','Label fixture A',1),
    (line_a2,order_a,'123456789002','label-a2','Label fixture A2',2),
    (line_b,order_b,'123456789003','label-b','Label fixture B',1);
  select jsonb_agg(to_jsonb(l) order by id) into before_lines from public.ebay_order_lines l where order_id in(order_a,order_b);
  insert into storage.objects(bucket_id,name) values('ebay-labels',prefix||'/one.pdf'),('ebay-labels',prefix||'/two.pdf');
  labels := jsonb_build_array(
    jsonb_build_object('path',prefix||'/one.pdf','order_ids',jsonb_build_array(order_a,order_b),'metadata',
      jsonb_build_object('fileName','One.pdf','trackingNumber','000123456789','trackingNumbers',jsonb_build_array('000123456789'),'signed_by','spoofed')),
    jsonb_build_object('path',prefix||'/two.pdf','order_ids',jsonb_build_array(order_a),'metadata',
      jsonb_build_object('fileName','Two.pdf','trackingNumber','1Z999AA10123456784','trackingNumbers',jsonb_build_array('1Z999AA10123456784'))));
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.attach_manual_shipping_labels(request_id,labels);
    raise exception 'Non-staff upload succeeded';
  exception when insufficient_privilege then null; end;
  perform pg_temp.verify(true,'non-staff upload denied');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.email','label-fixture@example.com',true);
  execute 'set local role authenticated';
  result := public.attach_manual_shipping_labels(request_id,labels);
  perform pg_temp.verify((result->>'saved')::boolean and jsonb_array_length(result->'event_ids')=3,'multiple PDFs attach to selected orders');
  perform pg_temp.verify((select label_file_path=prefix||'/one.pdf' and label_status='label_uploaded' and label_uploaded_by=actor
    and label_metadata->>'trackingNumber'='000123456789' from public.ebay_orders where id=order_a),'first PDF becomes order label with exact barcode');
  perform pg_temp.verify((select label_file_path='existing/label.pdf' and label_status='completed'
    and label_metadata->>'trackingNumber'='111111111111' from public.ebay_orders where id=order_b),'existing label and completed state remain intact');
  perform pg_temp.verify((select count(*)=2 from public.ebay_order_label_events where source='manual-label-upload'
    and label_metadata->>'manualUploadRequestId'=request_id::text and action='extra_label'),'additional PDFs use history-compatible extra label events');
  perform pg_temp.verify((select count(*)=2 and bool_and(order_line_ids @> array[line_a,line_a2] and cardinality(order_line_ids)=2)
    from public.ebay_order_label_events where order_ids=array[order_a]),'audit includes all lines of each covered order');
  perform pg_temp.verify((select bool_and(signed_by=actor and signed_by_email='label-fixture@example.com')
    from public.ebay_order_label_events where label_metadata->>'manualUploadRequestId'=request_id::text),'audit actor is authenticated identity');
  perform pg_temp.verify((select jsonb_agg(to_jsonb(l) order by id)=before_lines from public.ebay_order_lines l where order_id in(order_a,order_b)),
    'label uploads do not fulfill orders or remove inventory');
  perform pg_temp.verify((select label_file_path is null from public.ebay_orders where id=order_c),'unselected order unchanged');
  result := public.attach_manual_shipping_labels(request_id,labels);
  perform pg_temp.verify((result->>'already_saved')::boolean and (select count(*)=3 from public.ebay_order_label_events
    where label_metadata->>'manualUploadRequestId'=request_id::text),'retry is idempotent with no duplicate labels');
  begin
    perform public.attach_manual_shipping_labels(request_id,labels->0 || '{"path":"another.pdf"}'::jsonb);
    raise exception 'Invalid scalar labels accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.attach_manual_shipping_labels(request_id,jsonb_build_array(labels->0));
    raise exception 'Request reused with different payload';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify(true,'request ID cannot be reused with different labels');
  invalid_labels := jsonb_build_array(labels->0 || jsonb_build_object('order_ids',jsonb_build_array(order_c)),
    labels->1 || jsonb_build_object('path',prefix||'/missing.pdf'));
  begin
    perform public.attach_manual_shipping_labels(bad_request,invalid_labels);
    raise exception 'Missing PDF accepted';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify((select label_file_path is null from public.ebay_orders where id=order_c) and
    (select count(*)=0 from public.ebay_order_label_events where label_metadata->>'manualUploadRequestId'=bad_request::text),
    'one invalid PDF rolls back entire batch');
  begin
    perform public.attach_manual_shipping_labels(gen_random_uuid(),jsonb_build_array(labels->0 || jsonb_build_object('order_ids',jsonb_build_array(gen_random_uuid()))));
    raise exception 'Unknown order accepted';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify(true,'unknown order denied');
  foreach invalid_labels in array array['[]'::jsonb,'[null]'::jsonb,'["bad barcode!"]'::jsonb,'[123456789012]'::jsonb]
  loop
    begin
      perform public.attach_manual_shipping_labels(gen_random_uuid(),jsonb_build_array(jsonb_set(labels->0,'{metadata,trackingNumbers}',invalid_labels)));
      raise exception 'Invalid barcode list accepted';
    exception when invalid_parameter_value then null; end;
  end loop;
  perform pg_temp.verify(true,'missing, null, numeric and malformed tracking values denied');
  execute 'reset role';
end $$;
rollback;
