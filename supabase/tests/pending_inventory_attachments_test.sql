-- Rollback-only integration check: all objects below are isolated fixture rows.
begin;
set local statement_timeout='45s';
do $$
declare actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 store uuid:=gen_random_uuid();loc uuid:=gen_random_uuid();item uuid:=gen_random_uuid();stock uuid:=gen_random_uuid();
 ord uuid:=gen_random_uuid();line uuid:=gen_random_uuid();other_line uuid:=gen_random_uuid();a jsonb;result jsonb;req uuid:=gen_random_uuid();
begin
 if actor is null then raise exception 'Fixture needs an inventory-capable employee';end if;
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.store_locations(id,name,lat,lng) values(store,'__attachment_test',0,0);
 insert into public.locations(id,location_name,location_code,active,is_tray,location_role,store_id)
  values(loc,'__attachment_test',gen_random_uuid()::text,true,false,'storage_location',store);
 insert into public.item_types(id,title,barcode,cost,sale_price) values(item,'__attachment_test',gen_random_uuid()::text,2,10);
 insert into public.item_stock_locations(id,item_id,location_id,quantity,condition_status) values(stock,item,loc,5,'good');
 insert into public.ebay_orders(id,order_number,buyer_username,total_price) values(ord,'__attachment_test_'||ord,'fixture',40);
 insert into public.ebay_order_lines(id,order_id,item_title,quantity,sold_for,total_price)
  values(line,ord,'__attachment_test',3,10,30),(other_line,ord,'__attachment_other',1,10,10);
 a:=public.save_pending_inventory_attachment(line,item,stock,store,2,0);
 if (select quantity<>5 from public.item_stock_locations where id=stock) then raise exception 'Attachment removed stock';end if;
 if a#>>'{0,remaining_quantity}'<>'2' then raise exception 'Attachment quantity not saved';end if;
 perform public.reserve_ebay_order_line_stock(line);
 if (select quantity<>2 from public.ebay_order_line_reservations where order_line_id=line) then raise exception 'Sync changed attachment';end if;
 begin perform public.save_pending_inventory_attachment(line,item,stock,store,1,0);
  raise exception 'Stale change accepted';exception when serialization_failure then null;end;
 perform public.complete_ebay_order_lines_without_inventory_evidence(array[line],_checkout_store_id=>store);
 if (select quantity<>3 from public.item_stock_locations where id=stock) then raise exception 'Wrong stock deduction';end if;
 if (select consumed_quantity<>2 or status<>'consumed' from public.pending_inventory_attachments where order_line_id=line) then raise exception 'Attachment not consumed';end if;
 if not exists(select 1 from public.packaging_handoffs where order_id=ord) then raise exception 'Completion did not reach Packaging';end if;
 if not exists(select 1 from public.ebay_order_admin_events where line=any(order_line_ids) and jsonb_array_length(payload->'inventory_attachment_removals')=1) then raise exception 'Audit missing attached stock';end if;
 begin perform public.complete_ebay_order_lines_without_inventory_evidence(array[line],_checkout_store_id=>store);
  raise exception 'Completion retry accepted';exception when invalid_parameter_value then null;end;
 a:=public.save_pending_inventory_attachment(other_line,item,stock,store,1,0);
 result:=public.fulfill_pending_checkout_bundle(req,store,jsonb_build_array(jsonb_build_object('order_line_id',other_line,
  'item_id',item,'stock_location_row_id',stock,'quantity',1,'expected_fulfilled_quantity',0,'mode','inventory')));
 perform public.fulfill_pending_checkout_bundle(req,store,jsonb_build_array(jsonb_build_object('order_line_id',other_line,
  'item_id',item,'stock_location_row_id',stock,'quantity',1,'expected_fulfilled_quantity',0,'mode','inventory')));
 if (select quantity<>2 from public.item_stock_locations where id=stock) then raise exception 'Normal checkout deducted attachment twice';end if;
 if not public.packaging_order_ready(ord) then raise exception 'Completed order is not ready for Packaging';end if;
 if (select count(*)<>2 from public.stock_transactions where item_id=item) then raise exception 'Incorrect inventory audit count';end if;
end $$;
rollback;
select 'Attachment, reservation, quick completion, inventory checkout, retry, audit and Packaging checks passed; fixture rows rolled back.' as result;
