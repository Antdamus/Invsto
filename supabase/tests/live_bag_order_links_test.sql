begin;
set local statement_timeout = '20s';
do $$
declare
  actor uuid := (select user_id from public.employees where active is distinct from false and role = 'admin' limit 1);
  show_id uuid; bag_id uuid; manual_id uuid; order_a uuid; order_b uuid; line_a uuid; line_b uuid;
  event_id text := 'BAG-LINK-TEST-' || replace(gen_random_uuid()::text, '-', '');
  buyer text := 'bag-link-test-' || gen_random_uuid()::text;
  payload jsonb; before_bag jsonb; before_line jsonb; before_tx bigint;
begin
  assert actor is not null, 'An active fixture actor is required';
  perform set_config('request.jwt.claim.sub', actor::text, true);
  assert not has_function_privilege('anon', 'public.get_live_bag_order_matches(uuid,text)', 'execute');
  assert not has_table_privilege('authenticated', 'public.live_bag_order_links', 'insert');
  insert into public.live_sale_sessions(title) values ('__bag_link_test') returning id into show_id;
  insert into public.live_sale_lots(session_id, auction_number) values (show_id, 'EB-INTERNAL') returning id into bag_id;
  insert into public.live_sale_lots(session_id, auction_number) values (show_id, '019') returning id into manual_id;
  insert into public.ebay_live_connections(event_id, session_id) values (event_id, show_id);
  insert into public.ebay_live_attempts(event_id, listing_id, listing_title, buyer, amount, lot_id, payment_state)
    values (event_id, '888888888887', '#019 - Test chain', buyer, 83.25, bag_id, 'paid');
  insert into public.ebay_orders(order_number, buyer_username, sale_date)
    values ('__bag_link_' || gen_random_uuid(), upper(buyer), now()) returning id into order_a;
  insert into public.ebay_order_lines(order_id, item_number, item_title, sold_for)
    values (order_a, '888888888887', '#019 - Test chain', 83.25) returning id into line_a;
  insert into public.ebay_orders(order_number, buyer_username, sale_date)
    values ('__bag_link_' || gen_random_uuid(), 'another-' || buyer, now() - interval '90 days') returning id into order_b;
  insert into public.ebay_order_lines(order_id, item_number, item_title, sold_for)
    values (order_b, '888888888886', '#019 - Test chain', 83.25) returning id into line_b;
  payload := public.get_live_bag_order_matches(bag_id);
  assert payload#>>'{matches,0,line,id}' = line_a::text, 'Empty open bag finds buyer/listing/amount match';
  assert (payload#>'{matches,0,reasons}') @> '["Buyer username","eBay listing","Sale amount"]'::jsonb;
  assert not exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}' = line_b::text), 'Old repeated auction is excluded';
  assert not exists(select 1 from public.live_bag_order_links where lot_id = bag_id), 'Suggestions do not save links';
  payload := public.get_live_bag_order_matches(manual_id);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}' = line_a::text), 'Manual bag matches auction/date without contents';
  payload := public.get_live_bag_order_matches(bag_id, 'another-' || buyer);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}' = line_b::text), 'Manual search includes older pending orders';
  update public.ebay_order_lines set item_title='unrelated item' where id=line_b;
  update public.ebay_orders set sale_date=now() where id=order_b;
  payload := public.get_live_bag_order_matches(bag_id);
  assert not exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}' = line_b::text), 'Amount/date alone never suggest a match';

  update public.ebay_orders set sale_date=now()+interval '60 days' where id=order_a;
  update public.ebay_live_attempts set order_line_id=null where lot_id=bag_id;
  payload:=public.get_live_bag_order_matches(bag_id);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}'=line_a::text), 'Buyer identity survives a date outside the range';
  update public.ebay_orders set buyer_username='different-'||buyer where id=order_a;
  payload:=public.get_live_bag_order_matches(bag_id);
  assert exists(select 1 from jsonb_array_elements(payload->'matches') m where m#>>'{line,id}'=line_a::text), 'Exact listing and amount survive a date outside the range';
  update public.ebay_orders set sale_date=now(),buyer_username=upper(buyer) where id=order_a;

  select to_jsonb(l) into before_bag from public.live_sale_lots l where id=bag_id;
  select to_jsonb(l) into before_line from public.ebay_order_lines l where id=line_a;
  select count(*) into before_tx from public.stock_transactions;
  perform public.set_live_bag_order_link(bag_id, line_a, null);
  assert (select to_jsonb(l)=before_bag from public.live_sale_lots l where id=bag_id), 'Link does not alter or close bag';
  assert (select to_jsonb(l)=before_line from public.ebay_order_lines l where id=line_a), 'Link does not fulfill order';
  assert (select count(*)=before_tx from public.stock_transactions), 'Link never moves inventory';
  assert (select count(*)=1 from public.live_sale_events where lot_id=bag_id and event_type='order_linked');
  perform public.set_live_bag_order_link(bag_id, line_a, line_a);
  assert (select count(*)=1 from public.live_sale_events where lot_id=bag_id and event_type='order_linked'), 'Retry is idempotent';
  payload := public.get_live_bag_order_matches(bag_id, 'no-search-result');
  assert payload#>>'{matches,0,line,id}'=line_a::text and (payload#>>'{matches,0,linked}')::boolean, 'Saved link survives later searches';
  begin
    perform public.set_live_bag_order_link(bag_id, line_b, null);
    raise exception 'Stale client was allowed';
  exception when serialization_failure then null; end;
  begin
    update public.live_sale_lots set matched_order_line_id=line_b, status='packed' where id=bag_id;
    raise exception 'Wrong order packing was allowed';
  exception when invalid_parameter_value then null; end;
  update public.ebay_order_lines set line_status='fulfilled', fulfilled_quantity=quantity where id=line_a;
  payload := public.get_live_bag_order_matches(bag_id);
  assert payload#>>'{matches,0,line,line_status}'='fulfilled', 'Historical link remains visible with correct status';
  begin
    perform public.set_live_bag_order_link(manual_id, line_a, null);
    raise exception 'Closed order linking was allowed';
  exception when invalid_parameter_value then null; end;
  perform public.set_live_bag_order_link(bag_id, null, line_a);
  assert not exists(select 1 from public.live_bag_order_links where lot_id=bag_id), 'Unlink works without bag closure';
  update public.ebay_live_attempts set order_line_id=line_a where lot_id=bag_id;
  payload := public.get_live_bag_order_matches(bag_id);
  assert payload->>'link_source'='Identified by eBay', 'Existing reconciliation is recognized';
  begin
    perform public.set_live_bag_order_link(bag_id, line_b, null);
    raise exception 'Contradictory reconciled link was allowed';
  exception when invalid_parameter_value then null; end;
  update public.live_sale_lots set status='released' where id=manual_id;
  begin
    perform public.set_live_bag_order_link(manual_id, line_b, null);
    raise exception 'Released bag linking was allowed';
  exception when invalid_parameter_value then null; end;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.get_live_bag_order_matches(bag_id);
    raise exception 'Anonymous read was allowed';
  exception when insufficient_privilege then null; end;
  begin
    perform public.set_live_bag_order_link(bag_id, line_b, null);
    raise exception 'Anonymous write was allowed';
  exception when insufficient_privilege then null; end;
  raise notice 'ok bag links: matching, manual search, empty bags, persistence, audit, stale writes, packing guard, history, auth';
end $$;
rollback;
