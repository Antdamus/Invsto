begin;
set local statement_timeout='25s';
create function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label; end if; raise notice 'ok %',label; end $$;
do $$
declare
  actor uuid := (select user_id from public.employees where role='admin' and active is distinct from false limit 1);
  order_a uuid := gen_random_uuid();
  line_a uuid := gen_random_uuid();
  line_b uuid := gen_random_uuid();
  event_a public.ebay_order_task_events;
  attachment jsonb;
  before_lines jsonb;
  count_a integer;
  count_b integer;
begin
  perform pg_temp.verify(actor is not null,'authorized fixture actor exists');
  insert into public.ebay_orders(id,order_number,buyer_username) values(order_a,'__receipt_fixture_'||order_a,'receipt-fixture');
  insert into public.ebay_order_lines(id,order_id,item_number,transaction_id,item_title,quantity)
    values(line_a,order_a,'123456789012','receipt-txn-a','__receipt_fixture_a',1),
          (line_b,order_a,'123456789012','receipt-txn-b','__receipt_fixture_b',1);
  select jsonb_agg(to_jsonb(l) order by l.id) into before_lines from public.ebay_order_lines l where l.order_id=order_a;
  attachment := jsonb_build_object('bucket','order-evidence-photos','path','video-receipts/manual/fixture.png',
    'label','Video receipt - 123456789012','mime_type','image/png','media_type','image',
    'order_line_ids',jsonb_build_array(line_a),'attachment_scope','line',
    'metadata',jsonb_build_object('source','manual_video_receipt_screenshot','itemNumber','123456789012','selectedItemId','123456789012'));
  perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  begin
    perform public.add_pending_order_line_note(line_a,'Video receipt screenshot uploaded manually.',jsonb_build_array(attachment));
    raise exception 'Unauthorized receipt upload succeeded';
  exception when insufficient_privilege then null;
  end;
  perform pg_temp.verify(true,'receipt attachment requires inventory staff');
  perform set_config('request.jwt.claim.sub',actor::text,true);
  select * into event_a from public.add_pending_order_line_note(line_a,'Video receipt screenshot uploaded manually.',jsonb_build_array(attachment));
  perform pg_temp.verify(event_a.signed_by=actor,'receipt audit records the authenticated actor');
  perform pg_temp.verify(event_a.photo_attachments=jsonb_build_array(attachment),'original receipt attachment and item scope are retained');
  perform pg_temp.verify(event_a.payload->>'order_line_id'=line_a::text,'receipt audit targets the exact item line');
  perform pg_temp.verify((select status='resolved' and metadata->>'hidden_from_task_board'='true' from public.ebay_order_tasks where id=event_a.task_id),'screenshot upload does not create a pending staff task');
  -- The fast queue intentionally returns zero counts initially. The browser
  -- hydrates saved receipts from these staff-readable task/event records.
  execute 'set local role authenticated';
  select count(*) into count_a from public.ebay_order_task_events e join public.ebay_order_tasks t on t.id=e.task_id
    where t.order_id=order_a and line_a=any(t.order_line_ids)
      and e.photo_attachments @> jsonb_build_array(attachment);
  select count(*) into count_b from public.ebay_order_task_events e join public.ebay_order_tasks t on t.id=e.task_id
    where t.order_id=order_a and line_b=any(t.order_line_ids)
      and e.photo_attachments @> jsonb_build_array(attachment);
  perform pg_temp.verify(count_a=1,'saved screenshot is counted as video receipt evidence after reload');
  perform pg_temp.verify(count_b=0,'another line with the same item number receives no screenshot');
  perform pg_temp.verify((select jsonb_agg(to_jsonb(l) order by l.id) from public.ebay_order_lines l where l.order_id=order_a)=before_lines,'receipt upload preserves every fulfillment and inventory field');
  perform pg_temp.verify((select status='pending' from public.ebay_orders where id=order_a),'order stays pending after receipt upload');
end $$;
rollback;
