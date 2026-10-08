-- Isolated integration fixtures. Always roll back; never use a customer's order.
begin;
set local statement_timeout='60s';
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 store uuid:=gen_random_uuid();loc uuid:=gen_random_uuid();item_a uuid:=gen_random_uuid();item_b uuid:=gen_random_uuid();stock_a uuid:=gen_random_uuid();stock_b uuid:=gen_random_uuid();
 ord uuid:=gen_random_uuid();line_a uuid:=gen_random_uuid();line_b uuid:=gen_random_uuid();line_c uuid:=gen_random_uuid();
 show_id uuid:=gen_random_uuid();bag_a uuid:=gen_random_uuid();bag_b uuid:=gen_random_uuid();a jsonb;barcode_a text:=gen_random_uuid()::text;req uuid:=gen_random_uuid();
begin
 if actor is null then raise exception 'Fixture needs an inventory-capable employee';end if;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 perform set_config('request.jwt.claims',(select jsonb_build_object('sub',id,'user_metadata',raw_user_meta_data,'app_metadata',raw_app_meta_data)::text from auth.users where id=actor),true);
 insert into public.store_locations(id,name,lat,lng) values(store,'__shared_inventory_test',0,0);
 insert into public.locations(id,location_name,location_code,active,is_tray,location_role,store_id)
  values(loc,'__shared_inventory_test',gen_random_uuid()::text,true,false,'storage_location',store);
 insert into public.item_types(id,title,barcode,cost,sale_price) values(item_a,'__shared_inventory_test_a',barcode_a,2,10),(item_b,'__shared_inventory_test_b',gen_random_uuid()::text,3,10);
 insert into public.item_stock_locations(id,item_id,location_id,quantity,condition_status) values(stock_a,item_a,loc,8,'good'),(stock_b,item_b,loc,5,'good');
 insert into public.ebay_orders(id,order_number,buyer_username,total_price) values(ord,'__shared_inventory_test_'||ord,'fixture',50);
 insert into public.ebay_order_lines(id,order_id,item_title,quantity,sold_for,total_price)
  values(line_a,ord,'__shared_inventory_test_a',1,30,30),(line_b,ord,'__shared_inventory_test_b',1,10,10),(line_c,ord,'__shared_inventory_test_c',1,10,10);
 insert into public.live_sale_sessions(id,title,store_id) values(show_id,'__shared_inventory_test',store);
 insert into public.live_sale_lots(id,session_id,auction_number) values(bag_a,show_id,'TEST-A'),(bag_b,show_id,'TEST-B');

 -- Pending first: move the same hold into its bag, then add a second piece.
 perform public.save_pending_inventory_attachment_checked(line_a,item_a,stock_a,store,1,0,false);
 perform public.set_live_bag_order_link(bag_a,line_a,null);
 if (select reserved_quantity<>1 from public.active_stock_reservations where stock_location_row_id=stock_a) then raise exception 'Attachment was double reserved';end if;
 perform public.reserve_live_sale_item(bag_a,barcode_a,stock_a,1);
 if (select reserved_quantity<>1 from public.active_stock_reservations where stock_location_row_id=stock_a) then raise exception 'Rescan added another unit';end if;
 a:=public.get_pending_scanned_inventory((select lot_code from public.live_sale_lots where id=bag_a),line_a);
 if a#>>'{bag,lot_id}' is distinct from bag_a::text then raise exception 'Bag scanner did not return existing shared inventory';end if;
 a:=public.get_shared_bag_inventory(bag_a);
 perform public.save_shared_bag_inventory(bag_a,item_b,stock_b,store,2,a->>'revision');
 if (select quantity<>8 from public.item_stock_locations where id=stock_a) then raise exception 'Reservation removed stock';end if;
 begin perform public.save_shared_bag_inventory(bag_a,item_b,stock_b,store,3,a->>'revision');
  raise exception 'Stale quantity change accepted';exception when serialization_failure then null;end;
 perform public.complete_ebay_order_lines_without_inventory_evidence(array[line_a],_checkout_store_id=>store);
 if (select quantity<>7 from public.item_stock_locations where id=stock_a) or (select quantity<>3 from public.item_stock_locations where id=stock_b) then raise exception 'Bag contents were not deducted exactly once';end if;
 perform public.fulfill_ebay_order_line_with_live_lot(line_a,bag_a);
 if (select quantity<>7 from public.item_stock_locations where id=stock_a) then raise exception 'Retry deducted twice';end if;
 if not exists(select 1 from public.packaging_handoffs where order_id=ord) then raise exception 'No Packaging handoff';end if;
 if not exists(select 1 from public.ebay_order_admin_events where line_a=any(order_line_ids) and payload ? 'shared_bag_inventory_removals') then raise exception 'Missing shared inventory evidence audit';end if;

 -- Bag first: one reservation, compatible legacy bundle, repeat request.
 perform public.reserve_live_sale_item(bag_b,barcode_a,stock_a,1);
 perform public.set_live_bag_order_link(bag_b,line_b,null);
 begin perform public.save_pending_inventory_attachment(line_b,item_a,stock_a,store,1,0);
  raise exception 'Old attachment client created a second hold';exception when invalid_parameter_value then null;end;
 a:=jsonb_build_array(jsonb_build_object('order_line_id',line_b,'item_id',item_a,'stock_location_row_id',stock_a,'quantity',1,'expected_fulfilled_quantity',0,'mode','inventory'));
 perform public.fulfill_pending_checkout_bundle(req,store,a);
 perform public.fulfill_pending_checkout_bundle(req,store,a);
 if (select quantity<>6 from public.item_stock_locations where id=stock_a) then raise exception 'Legacy bundle double deducted';end if;

 -- Standalone attachments still work normally; no bag is required.
 perform public.save_pending_inventory_attachment_checked(line_c,item_a,stock_a,store,1,0,false);
 perform public.complete_ebay_order_lines_without_inventory_evidence(array[line_c],_checkout_store_id=>store);
 if (select quantity<>5 from public.item_stock_locations where id=stock_a) then raise exception 'Standalone checkout regressed';end if;
 if not public.packaging_order_ready(ord) then raise exception 'Completed order is not ready for Packaging';end if;
 if exists(select 1 from public.active_stock_reservations where stock_location_row_id in (stock_a,stock_b) and reserved_quantity>0) then raise exception 'A stale reservation remained after completion';end if;
 if (select count(*)<>4 from public.stock_transactions where item_id in (item_a,item_b)) then raise exception 'Wrong number of stock transactions';end if;
 perform public.admin_revert_ebay_order_lines(array[line_a],'__shared_inventory_test revert',null);
 if (select quantity<>6 from public.item_stock_locations where id=stock_a) or (select quantity<>5 from public.item_stock_locations where id=stock_b) then raise exception 'Verified revert did not restore the actual bag contents';end if;
 perform public.complete_ebay_order_lines_without_inventory_evidence(array[line_a],_checkout_store_id=>store);
 perform public.fulfill_ebay_order_line_with_live_lot(line_a,bag_a);
 if (select quantity<>5 from public.item_stock_locations where id=stock_a) or (select quantity<>3 from public.item_stock_locations where id=stock_b) then raise exception 'Recompletion after revert double removed stock';end if;
 if has_function_privilege('authenticated','public.consume_shared_inventory_bag(uuid,uuid,text,text,uuid)','execute') then raise exception 'Private accounting helper exposed';end if;
end $$;
rollback;
select 'Shared inventory: both scan sequences, multi-item bag, repeated scans, stale edits, completion retries, legacy checkout, audit and Packaging passed; all fixtures rolled back.' as result;
