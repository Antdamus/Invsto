begin;
set local statement_timeout='20s';
do $$
declare actor uuid; ids uuid[]; names text[]; other_id uuid:=gen_random_uuid();
  prefix text:='__bulk_handoff_'||gen_random_uuid(); rows jsonb; result jsonb; before_lines jsonb;
  all_lines uuid[]; page_one uuid[]; page_two uuid[]; started timestamptz;
begin
  select user_id into actor from public.employees where active is distinct from false
    and role='employee' and user_id is not null limit 1;
  assert actor is not null,'Staff fixture required';
  assert not has_function_privilege('anon','public.list_pending_ebay_order_matches(text[],text[],text,text,boolean,integer,integer)','execute');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated','email','bulk-test@example.com')::text,true);
  with added as (insert into public.ebay_orders(order_number,buyer_username,net_payout)
    select prefix||i,prefix,100 from generate_series(1,8) i returning id,order_number)
    select array_agg(id order by order_number),array_agg(order_number order by order_number) into ids,names from added;
  insert into public.ebay_orders(id,order_number,buyer_username) values(other_id,prefix||'-other',prefix||'-other');
  insert into public.ebay_order_lines(order_id,item_number,item_title,quantity,net_payout)
    select id,'fixture-item',prefix,1,80 from unnest(ids||other_id) id;
  insert into public.ebay_order_lines(order_id,item_number,transaction_id,item_title,quantity)
    select ids[8],'sibling-'||i,'txn-'||i,prefix||i,1 from generate_series(1,3) i;
  insert into public.ebay_order_lines(order_id,item_title,quantity,line_status,fulfilled_quantity)
    values(ids[8],prefix||'-closed',1,'fulfilled',1),(ids[8],prefix||'-cancelled',1,'cancelled',0);
  insert into public.pending_order_item_search(order_line_id,is_missing,updated_by,updated_by_email)
    select id,false,actor,'bulk-test@example.com' from public.ebay_order_lines where order_id=ids[8] and item_number='sibling-1';
  select jsonb_agg(to_jsonb(l) order by id) into before_lines from public.ebay_order_lines l where order_id=any(ids);
  insert into storage.objects(bucket_id,name) values('ebay-labels',prefix||'.pdf'),('ebay-labels',prefix||'-second.pdf');
  set local role authenticated;
  started:=clock_timestamp();
  select jsonb_agg(q) into rows from public.list_pending_ebay_order_matches(_order_numbers=>names,_include_admin_fields=>true) q;
  assert jsonb_array_length(rows)=11,'Eight orders must include all eleven pending lines';
  assert (select count(*) from jsonb_array_elements(rows) q where q->>'order_id'=ids[8]::text)=4;
  assert (select bool_and(q->'net_payout'='null'::jsonb and q#>'{ebay_orders,net_payout}'='null'::jsonb) from jsonb_array_elements(rows) q),'Workers cannot request admin money fields';
  assert (select (q#>>'{item_search,is_missing}')::boolean=false from jsonb_array_elements(rows) q where q->>'item_number'='sibling-1'),'Found markers retained';
  raise notice 'ok eight-order lookup includes eleven lines, metadata and staff field restrictions: % ms',round(extract(epoch from clock_timestamp()-started)*1000);
  select array_agg((q->>'id')::uuid order by q->>'id') into all_lines from public.list_pending_ebay_order_matches(_buyer_usernames=>array[prefix]) q;
  assert cardinality(all_lines)=11;
  select array_agg((q->>'id')::uuid) into page_one from public.list_pending_ebay_order_matches(_buyer_usernames=>array[prefix],_limit=>6) q;
  select array_agg((q->>'id')::uuid) into page_two from public.list_pending_ebay_order_matches(_buyer_usernames=>array[prefix],_limit=>6,_offset=>6) q;
  assert cardinality(page_one)=6 and cardinality(page_two)=5 and not page_one&&page_two;
  assert (page_one||page_two)@>all_lines and all_lines@>(page_one||page_two),'Pagination lost buyer lines';
  assert (select count(*) from public.list_pending_ebay_order_matches(_order_numbers=>array[prefix||'-unknown']))=0,'Unknown order must not return other buyers';
  assert (select count(*) from public.list_pending_ebay_order_matches(_item_number=>'sibling-1',_transaction_id=>'txn-1',_buyer_usernames=>array[prefix]))=1;
  begin perform public.list_pending_ebay_order_matches(); raise exception 'Unscoped read allowed'; exception when invalid_parameter_value then null; end;
  raise notice 'ok whole-buyer scope, all pages, item/transaction matching and empty scope guard';
  started:=clock_timestamp();
  result:=public.append_ebay_shipping_label(ids,prefix||'.pdf','{"trackingNumber":"000123456789"}');
  assert jsonb_array_length(result->'order_labels')=8 and jsonb_array_length(result->'event_ids')=8;
  assert (select count(*) from public.ebay_order_label_events where label_file_path=prefix||'.pdf')=8;
  assert (select count(distinct line) from public.ebay_order_label_events e cross join lateral unnest(e.order_line_ids) line where e.label_file_path=prefix||'.pdf')=13;
  raise notice 'ok combined label saves every order and audits every associated line: % ms',round(extract(epoch from clock_timestamp()-started)*1000);
  perform public.append_ebay_shipping_label(ids||ids[1],prefix||'.pdf','{}');
  assert (select count(*) from public.ebay_order_label_events where label_file_path=prefix||'.pdf')=8,'Retry duplicated label';
  perform public.append_ebay_shipping_label(ids,prefix||'-second.pdf','{"trackingNumber":"999999999999"}');
  assert (select bool_and(label_file_path=prefix||'.pdf' and label_metadata->>'trackingNumber'='000123456789') from public.ebay_orders where id=any(ids));
  assert (select count(*) from public.ebay_order_label_events where label_file_path=prefix||'-second.pdf' and action='extra_label')=8;
  assert (select jsonb_agg(to_jsonb(l) order by id)=before_lines from public.ebay_order_lines l where order_id=any(ids)),'Attaching labels changed fulfillment';
  raise notice 'ok retry deduplication, old labels retained, and fulfillment unchanged';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
  begin perform public.list_pending_ebay_order_matches(_buyer_usernames=>array[prefix]); raise exception 'Nonstaff read allowed'; exception when insufficient_privilege then null; end;
  begin perform public.append_ebay_shipping_label(ids,prefix||'.pdf'); raise exception 'Nonstaff append allowed'; exception when insufficient_privilege then null; end;
  raise notice 'ok nonstaff reads and writes denied';
end $$;
rollback;
