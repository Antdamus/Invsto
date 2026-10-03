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
  prefix text := '__extension_append_test_'||gen_random_uuid()::text;
  before_order_b jsonb; before_lines jsonb; result jsonb; event_count int;
begin
  perform pg_temp.verify(actor is not null,'staff fixture actor exists');
  perform pg_temp.verify(not has_function_privilege('anon','public.append_ebay_shipping_label(uuid[],text,jsonb,text)','execute'),
    'anonymous append denied');
  insert into public.ebay_orders(id,order_number,buyer_username) values
    (order_a,'__append_'||order_a,'label-fixture'),(order_b,'__append_'||order_b,'label-fixture'),
    (order_c,'__append_'||order_c,'label-fixture');
  update public.ebay_orders set label_storage_bucket='ebay-labels',label_file_path='existing/label.pdf',label_status='completed',
    label_metadata='{"trackingNumber":"111111111111"}',ebay_shipment_id='original-shipment' where id=order_b;
  select to_jsonb(o) into before_order_b from public.ebay_orders o where id=order_b;
  insert into public.ebay_order_lines(id,order_id,item_number,transaction_id,item_title,quantity) values
    (line_a,order_a,'123456789001',prefix||'a','Label fixture A',1),
    (line_a2,order_a,'123456789002',prefix||'a2','Label fixture A2',2),
    (line_b,order_b,'123456789003',prefix||'b','Label fixture B',1);
  select jsonb_agg(to_jsonb(l) order by id) into before_lines from public.ebay_order_lines l where order_id in(order_a,order_b);
  insert into storage.objects(bucket_id,name) values('ebay-labels',prefix||'/one.pdf'),('ebay-labels',prefix||'/two.pdf');
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.append_ebay_shipping_label(array[order_a],prefix||'/one.pdf');
    raise exception 'Non-staff append succeeded';
  exception when insufficient_privilege then null; end;
  perform pg_temp.verify(true,'non-staff append denied');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  perform set_config('request.jwt.claim.email','label-fixture@example.com',true);
  execute 'set local role authenticated';
  result := public.append_ebay_shipping_label(array[order_a,order_b],prefix||'/one.pdf',
    '{"trackingNumber":"000123456789","signed_by":"spoofed"}','same-shipment');
  perform pg_temp.verify((result->>'saved')::boolean and jsonb_array_length(result->'order_labels')=2,
    'one import covers all selected orders and returns authoritative primary labels');
  perform pg_temp.verify((select label_file_path=prefix||'/one.pdf' and label_status='label_uploaded'
    and label_uploaded_by=actor and label_metadata->>'trackingNumber'='000123456789'
    from public.ebay_orders where id=order_a),'first PDF becomes primary with tracking');
  perform pg_temp.verify((select to_jsonb(o)=before_order_b from public.ebay_orders o where id=order_b),
    'existing primary label, tracking, shipment and completion state remain unchanged');
  result := public.append_ebay_shipping_label(array[order_a,order_b],prefix||'/two.pdf',
    '{"trackingNumber":"1Z999AA10123456784"}','same-shipment');
  perform pg_temp.verify((select label_file_path=prefix||'/one.pdf' and label_metadata->>'trackingNumber'='000123456789'
    from public.ebay_orders where id=order_a),'another PDF with the same shipment ID preserves original label');
  perform pg_temp.verify((select count(*)=4 and count(distinct label_file_path)=2
    from public.ebay_order_label_events where label_file_path like prefix||'/%'),'each order retains both imported PDFs');
  perform pg_temp.verify((select count(*)=3 from public.ebay_order_label_events
    where label_file_path like prefix||'/%' and action='extra_label'),'additional labels are append events, never replacements');
  perform pg_temp.verify((select bool_and(order_line_ids @> array[line_a,line_a2] and cardinality(order_line_ids)=2)
    from public.ebay_order_label_events where order_ids=array[order_a]),'labels cover every line of an order');
  perform pg_temp.verify((select bool_and(signed_by=actor and signed_by_email='label-fixture@example.com')
    from public.ebay_order_label_events where label_file_path like prefix||'/%'),'audit uses authenticated identity');
  result := public.append_ebay_shipping_label(array[order_b,order_a,order_a],prefix||'/two.pdf','{}','same-shipment');
  perform pg_temp.verify((select count(*)=4 from public.ebay_order_label_events where label_file_path like prefix||'/%'),
    'resending a PDF and duplicate order IDs do not duplicate labels');
  result := public.append_ebay_shipping_label(array[order_a,order_c],prefix||'/two.pdf','{}','same-shipment');
  perform pg_temp.verify((select count(*)=5 from public.ebay_order_label_events where label_file_path like prefix||'/%')
    and (select label_file_path=prefix||'/two.pdf' from public.ebay_orders where id=order_c),
    'resend can cover a new order without duplicating existing coverage');
  perform pg_temp.verify((select jsonb_agg(to_jsonb(l) order by id)=before_lines from public.ebay_order_lines l where order_id in(order_a,order_b)),
    'label imports do not fulfill lines or remove inventory');
  begin
    perform public.append_ebay_shipping_label(array[order_a],prefix||'/missing.pdf');
    raise exception 'Missing PDF accepted';
  exception when invalid_parameter_value then null; end;
  begin
    perform public.append_ebay_shipping_label(array[order_a,gen_random_uuid()],prefix||'/one.pdf');
    raise exception 'Unknown order accepted';
  exception when invalid_parameter_value then null; end;
  perform pg_temp.verify(true,'missing PDFs and unknown orders rejected');
  execute 'reset role';
end $$;
rollback;
