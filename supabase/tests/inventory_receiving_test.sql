begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions;
create temp table receiving_tap_results(result text);
do $receiving_checks$
declare
 admin_id uuid := (select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 item_a uuid:=gen_random_uuid();item_b uuid:=gen_random_uuid();tray uuid:=gen_random_uuid();tray_b uuid:=gen_random_uuid();parent uuid:=gen_random_uuid();box uuid:=gen_random_uuid();bag uuid:=gen_random_uuid();
 request_id uuid:=gen_random_uuid();bad_request uuid:=gen_random_uuid();payload jsonb;receipt jsonb;quantity_before bigint;tx_before bigint;
begin
 insert into receiving_tap_results select plan(27);
 insert into receiving_tap_results select ok(not has_table_privilege('authenticated','public.inventory_receiving_receipts','SELECT'),'staff cannot read other workers receipt table');
 insert into receiving_tap_results select ok(not has_function_privilege('anon','public.receive_inventory_batch(uuid,uuid,jsonb,text)','EXECUTE'),'anonymous clients cannot add inventory');
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 insert into receiving_tap_results select throws_ok('select public.get_inventory_receiving_receipt(gen_random_uuid())','42501','Inventory access required','non-staff cannot read receipt RPC');
 insert into receiving_tap_results select throws_ok('select public.receive_inventory_batch(gen_random_uuid(),gen_random_uuid(),''[]'')','42501','Inventory access required','non-staff cannot write inventory');
 perform set_config('request.jwt.claim.sub',admin_id::text,true);
 insert into public.item_types(id,title,barcode,cost,sale_price) values(item_a,'__receiving_watch',gen_random_uuid()::text,10,20),(item_b,'__receiving_coin',gen_random_uuid()::text,30,40);
 insert into public.locations(id,location_name,location_code,active,is_tray,location_role,max_capacity)
 values(tray,'__receiving_tray',gen_random_uuid()::text,true,true,'tray',100),
 (tray_b,'__receiving_other_tray',gen_random_uuid()::text,true,true,'tray',100),
 (parent,'__receiving_parent',gen_random_uuid()::text,true,false,'storage_location',null);
 insert into public.locations(id,location_name,location_code,active,is_tray,location_role,parent_location_id) values(box,'__receiving_box',gen_random_uuid()::text,true,false,'container',parent);
 insert into public.item_stock_locations(item_id,location_id,quantity,condition_status) values(item_a,tray,4,'good'),(item_a,tray,2,'defective');
 insert into public.bulk_batches(id,item_type_id,bag_barcode,location_id,tare_weight_g,gross_weight_g,unit_weight_g,estimated_qty) values(bag,item_a,gen_random_uuid()::text,tray,1,8,1,7);
 -- Model an existing bag placement without invoking the legacy bag-quantity trigger,
 -- which references absent bulk_batches.low_threshold/initial_qty columns. Receiving
 -- must never update this row or invoke that trigger for a bag.
 insert into public.item_stock_locations(item_id,location_id,quantity,condition_status) values(item_a,tray,7,'good');
 update public.item_stock_locations set batch_id=bag where item_id=item_a and location_id=tray and quantity=7;
 payload:=jsonb_build_array(jsonb_build_object('item_id',item_a,'quantity',3),jsonb_build_object('item_id',item_b,'quantity',2));
 receipt:=public.receive_inventory_batch(request_id,tray,payload,'Test shipment');
 insert into receiving_tap_results select is((receipt->>'quantity_added')::integer,5,'multiple items save as a single receiving batch');
 insert into receiving_tap_results select is((select quantity from public.item_stock_locations where item_id=item_a and location_id=tray and batch_id is null and condition_status='good'),7,'existing loose stock increments');
 insert into receiving_tap_results select is((select quantity from public.item_stock_locations where item_id=item_b and location_id=tray and batch_id is null),2,'new placement is inserted for existing item');
 insert into receiving_tap_results select is((select quantity from public.item_stock_locations where batch_id=bag),7,'bag stock is never accidentally modified');
 insert into receiving_tap_results select is((select quantity from public.item_stock_locations where item_id=item_a and location_id=tray and condition_status='defective'),2,'defective stock is unchanged');
 insert into receiving_tap_results select is((select count(*)::integer from public.stock_transactions where metadata->>'receiving_request_id'=request_id::text),2,'each line has an audit transaction');
 insert into receiving_tap_results select ok((select bool_and(user_id=admin_id and action_type='checkin' and stock_condition='good') from public.stock_transactions where metadata->>'receiving_request_id'=request_id::text),'audit uses authenticated identity and good-stock checkin');
 insert into receiving_tap_results select ok((select cost=10 and sale_price=20 and title='__receiving_watch' from public.item_types where id=item_a),'catalog details and prices are unchanged');
 insert into receiving_tap_results select is(public.receive_inventory_batch(request_id,tray,payload,'Test shipment'),receipt,'a lost-response retry returns the same receipt');
 insert into receiving_tap_results select is((select quantity from public.item_stock_locations where item_id=item_a and location_id=tray and batch_id is null and condition_status='good'),7,'retry never adds stock again');
 insert into receiving_tap_results select is(public.get_inventory_receiving_receipt(request_id),receipt,'receipt can be recovered without resubmitting stock');
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(%L,%L,%L::jsonb,%L)',request_id,tray_b,payload,'Test shipment'),'22023','This request already saved a different inventory batch','same request cannot silently change destination');
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(gen_random_uuid(),%L,%L::jsonb)',tray,jsonb_build_array(jsonb_build_object('item_id',item_a,'quantity',1.5))),'22023','Every item needs a whole quantity between 1 and 999999','fractional quantities rejected');
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(gen_random_uuid(),%L,%L::jsonb)',tray,jsonb_build_array(jsonb_build_object('item_id',item_a,'quantity',0))),'22023','Every item needs a whole quantity between 1 and 999999','zero quantities rejected');
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(gen_random_uuid(),%L,%L::jsonb)',tray,payload||payload),'22023','Combine repeated items into one quantity','duplicate item lines rejected');
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(gen_random_uuid(),%L,%L::jsonb)',parent,payload),'22023','Choose a tray or a container inside storage','parent storage cannot be mistaken for its container');
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(gen_random_uuid(),%L,%L::jsonb)',tray,jsonb_build_array(jsonb_build_object('item_id',item_b,'quantity',100))),'22023','This batch exceeds the destination capacity','capacity is checked before writes');
 select coalesce(sum(quantity),0) into quantity_before from public.item_stock_locations where location_id=tray;
 select count(*) into tx_before from public.stock_transactions where location_id=tray;
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(%L,%L,%L::jsonb)',bad_request,tray,jsonb_build_array(jsonb_build_object('item_id',item_a,'quantity',1),jsonb_build_object('item_id','ffffffff-ffff-ffff-ffff-ffffffffffff','quantity',1))),'22023','An item is missing or deleted. Review this batch','bad final item rolls the whole batch back');
 insert into receiving_tap_results select is((select sum(quantity) from public.item_stock_locations where location_id=tray),quantity_before,'no stock from a failed batch is retained');
 insert into receiving_tap_results select is((select count(*) from public.stock_transactions where location_id=tray),tx_before,'no partial audit or receipt is retained');
 insert into receiving_tap_results select is(public.get_inventory_receiving_receipt(bad_request),null::jsonb,'failed batch has no successful receipt');
 update public.locations set active=false where id=parent;
 insert into receiving_tap_results select throws_ok(format('select public.receive_inventory_batch(gen_random_uuid(),%L,%L::jsonb)',box,payload),'22023','The parent storage location is inactive','inactive parent blocks container intake');
 update public.locations set active=true where id=parent;
 insert into receiving_tap_results select is((public.receive_inventory_batch(gen_random_uuid(),box,payload)->>'quantity_added')::integer,5,'active container can receive a batch');
 insert into receiving_tap_results select * from finish();
end $receiving_checks$;
select result from receiving_tap_results;
rollback;
