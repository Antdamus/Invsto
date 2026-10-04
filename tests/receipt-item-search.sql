-- Execute with the two migrations in a transaction, and always roll back.
do $$
<<checks>>
declare staff uuid; other_staff uuid; line_id uuid; sibling uuid; order_id uuid;
  before_line jsonb; after_line jsonb; saved public.pending_order_item_search; count_before integer;
  task_id uuid; event_id uuid; original text:='video-receipts/preflight/test.png';
  preview text:='video-receipts/preflight/derivatives/test-preview.jpg';
  thumbnail text:='video-receipts/preflight/derivatives/test-thumb.jpg';
  derivatives jsonb; photo jsonb;
begin
  select user_id into staff from public.employees where active and user_id is not null limit 1;
  select user_id into other_staff from public.employees where active and user_id is not null and user_id<>staff limit 1;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',staff,'role','authenticated')::text,true);
  insert into public.ebay_orders(order_number,buyer_username,status)
    values('receipt-item-search-preflight-'||gen_random_uuid(),'rollback-fixture','pending') returning id into order_id;
  insert into public.ebay_order_lines(order_id,item_title,item_number)
    values(order_id,'Rollback-only missing item','fixture-one') returning id,to_jsonb(ebay_order_lines.*) into line_id,before_line;
  insert into public.ebay_order_lines(order_id,item_title,item_number)
    values(order_id,'Rollback-only sibling','fixture-two') returning id into sibling;
  select count(*) into count_before from public.pending_order_item_search_events;
  select * into saved from public.set_pending_order_item_missing(line_id,true);
  assert saved.is_missing and saved.updated_by=staff,'Missing flag or actor not saved';
  perform public.set_pending_order_item_missing(line_id,true);
  assert (select count(*) from public.pending_order_item_search_events)=count_before+1,'Repeated mark created duplicate history';
  assert not exists(select 1 from public.pending_order_item_search where order_line_id=sibling),'Another line was marked';
  assert exists(select 1 from public.list_pending_ebay_order_queue_v2('pending',false,100000,0) q
    where q->>'id'=line_id::text and q #>> '{item_search,is_missing}'='true'),'Shared queue omits marker';
  select to_jsonb(l) into after_line from public.ebay_order_lines l where l.id=line_id;
  assert before_line=after_line,'Flag changed fulfillment or imported order data';
  set local role authenticated;
  assert exists(select 1 from public.pending_order_item_search where order_line_id=line_id),'Staff cannot read marker';
  begin
    update public.pending_order_item_search set is_missing=false where order_line_id=line_id;
    raise exception 'Direct unaudited update permitted';
  exception when insufficient_privilege then null; end;
  set local role postgres;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',coalesce(other_staff,staff),'role','authenticated')::text,true);
  select * into saved from public.set_pending_order_item_missing(line_id,false);
  assert not saved.is_missing,'Another staff member cannot mark it found';
  assert (select count(*) from public.pending_order_item_search_events)=count_before+2,'Found history missing';
  raise notice 'ok exact-line shared missing/found flags, actor history, idempotence, permissions, unchanged fulfillment';

  -- Finding an untouched item does not require marking it missing first.
  select to_jsonb(l) into before_line from public.ebay_order_lines l where l.id=sibling;
  select * into saved from public.set_pending_order_item_missing(sibling,false);
  assert saved.is_missing=false and saved.updated_by=coalesce(other_staff,staff),'Direct found mark or actor missing';
  assert (select count(*) from public.pending_order_item_search_events)=count_before+3,'Direct found audit missing';
  perform public.set_pending_order_item_missing(sibling,false);
  assert (select updated_at from public.pending_order_item_search where order_line_id=sibling)=saved.updated_at,'Repeated found changed the latest-found time';
  assert (select count(*) from public.pending_order_item_search_events)=count_before+3,'Repeated found duplicated history';
  assert exists(select 1 from public.list_pending_ebay_order_queue_v2('pending',false,100000,0) q
    where q->>'id'=sibling::text and q #>> '{item_search,is_missing}'='false'),'Shared queue omits direct found mark';
  select to_jsonb(l) into after_line from public.ebay_order_lines l where l.id=sibling;
  assert before_line=after_line,'Found mark changed fulfillment or imported order data';
  raise notice 'ok direct item-found saves, shared queue, stable latest-found time and unchanged order line';

  perform set_config('request.jwt.claims',jsonb_build_object('sub',staff,'role','authenticated')::text,true);
  select t.id into task_id from public.ebay_order_tasks t where t.order_id=checks.order_id limit 1;
  if task_id is null then
    insert into public.ebay_order_tasks(order_id,order_line_ids,task_type,title,question,status,metadata)
      values(order_id,array[line_id],'coordination','Rollback fixture','Rollback fixture','resolved','{"hidden_from_task_board":true}') returning id into task_id;
  end if;
  photo:=jsonb_build_object('bucket','order-evidence-photos','path',original,'metadata',jsonb_build_object('receipt_previews_pending',true));
  insert into public.ebay_order_task_events(task_id,order_id,action,photo_attachments,signed_by)
    values(task_id,order_id,'created',jsonb_build_array(photo),staff) returning id into event_id;
  assert exists(select 1 from public.list_pending_receipt_previews() j where j->>'task_id'=task_id::text),'Interrupted preview work not recoverable';
  derivatives:=jsonb_build_object('preview_bucket','order-evidence-photos','preview_path',preview,
    'thumbnail_bucket','order-evidence-photos','thumbnail_path',thumbnail);
  begin
    perform public.finish_receipt_previews(task_id,original,derivatives);
    raise exception 'Published missing storage files';
  exception when invalid_parameter_value then null; end;
  insert into storage.objects(bucket_id,name) values('order-evidence-photos',preview),('order-evidence-photos',thumbnail);
  assert public.finish_receipt_previews(task_id,original,derivatives),'Preview references not attached';
  assert public.finish_receipt_previews(task_id,original,derivatives),'Concurrent completed job not idempotent';
  assert (select photo_attachments #>> '{0,path}' from public.ebay_order_task_events where id=event_id)=original,'Original overwritten';
  assert (select photo_attachments #>> '{0,metadata,receipt_previews_pending}' from public.ebay_order_task_events where id=event_id)='false','Retry marker not cleared';
  begin
    perform public.finish_receipt_previews(task_id,original,derivatives || '{"preview_path":"unrelated-file.jpg"}');
    raise exception 'Accepted unrelated preview path';
  exception when invalid_parameter_value then null; end;
  update public.ebay_order_task_events set photo_attachments='[]' where id=event_id;
  assert not public.finish_receipt_previews(task_id,original,derivatives),'Removed photo resurrected';
  raise notice 'ok durable preview recovery, verified storage references, idempotence, original preservation, deletion race';

  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
  begin
    perform public.set_pending_order_item_missing(line_id,true);
    raise exception 'Nonstaff changed item status';
  exception when insufficient_privilege then null; end;
  begin
    perform public.list_pending_receipt_previews();
    raise exception 'Nonstaff read preview jobs';
  exception when insufficient_privilege then null; end;
  begin
    perform public.finish_receipt_previews(task_id,original,derivatives);
    raise exception 'Nonstaff changed preview references';
  exception when insufficient_privilege then null; end;
  set local role authenticated;
  assert (select count(*) from public.pending_order_item_search)=0,'Nonstaff can read item search';
  set local role postgres;
  raise notice 'ok nonstaff denied';
end $$;
