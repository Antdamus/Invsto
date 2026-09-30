begin;
set local statement_timeout='25s';
create function pg_temp.verify(ok boolean,label text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'Failed: %',label; end if; raise notice 'ok %',label; end $$;
create function pg_temp.packing_line(l uuid,i uuid,s uuid,q integer,e integer default 0,m text default 'inventory') returns jsonb
language sql as $$select jsonb_build_object('order_line_id',l,'item_id',i,'stock_location_row_id',s,'quantity',q,'expected_fulfilled_quantity',e,'mode',m)$$;
create function pg_temp.fail_checkout_audit() returns trigger language plpgsql as $$
begin if NEW.notes='__checkout_fail_after_stock__' then raise exception 'Fixture final audit failure'; end if; return NEW; end $$;
create trigger checkout_fixture_final_failure before insert on public.ebay_order_admin_events for each row execute function pg_temp.fail_checkout_audit();
do $$
declare
 actor uuid:=(select user_id from public.employees where role='admin' and active is distinct from false limit 1);
 store_a uuid:=gen_random_uuid();store_b uuid:=gen_random_uuid();item_a uuid:=gen_random_uuid();item_b uuid:=gen_random_uuid();
 tray uuid:=gen_random_uuid();parent uuid:=gen_random_uuid();box uuid:=gen_random_uuid();away uuid:=gen_random_uuid();checked_out uuid:=gen_random_uuid();
 stock_a uuid:=gen_random_uuid();box_stock uuid:=gen_random_uuid();bag_stock uuid:=gen_random_uuid();bag uuid:=gen_random_uuid();
 order_a uuid:=gen_random_uuid();order_b uuid:=gen_random_uuid();line_a uuid:=gen_random_uuid();line_b uuid:=gen_random_uuid();line_other uuid:=gen_random_uuid();
 show_id uuid:=gen_random_uuid();lot uuid:=gen_random_uuid();req uuid:=gen_random_uuid();bad_req uuid:=gen_random_uuid();
 code text:='CHK-'||gen_random_uuid()::text||'%,9';payload jsonb;result jsonb;retry jsonb;version_before text;tx_before bigint;
begin
 perform pg_temp.verify(actor is not null,'fixture actor exists');
 perform pg_temp.verify(not has_function_privilege('anon','public.fulfill_pending_checkout_bundle(uuid,uuid,jsonb,text,uuid)','execute'),'anonymous checkout is denied');
 perform pg_temp.verify(not has_function_privilege('authenticated','public.fulfill_ebay_order_line(uuid,uuid,uuid,integer,numeric,numeric,text,text)','execute'),'unguarded legacy base RPC is private');
 perform pg_temp.verify(not has_table_privilege('authenticated','public.pending_checkout_receipts','select'),'receipts are private');
 perform set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 begin perform public.lookup_pending_checkout_items(code); raise exception 'Unauthorized lookup succeeded'; exception when insufficient_privilege then null; end;
 begin perform public.fulfill_pending_checkout_bundle(req,store_a,'[]'); raise exception 'Unauthorized checkout succeeded'; exception when insufficient_privilege then null; end;
 perform pg_temp.verify(true,'lookup requires staff identity');
 perform set_config('request.jwt.claim.sub',actor::text,true);
 insert into public.store_locations(id,name,lat,lng) values(store_a,'__checkout_test_a',0,0),(store_b,'__checkout_test_b',0,0);
 insert into public.item_types(id,title,barcode,cost,sale_price) values(item_a,'__checkout_watch',code,2,10),(item_b,'__checkout_other',lower(code),3,15);
 perform pg_temp.verify(jsonb_array_length(public.lookup_pending_checkout_items('  '||code||'  ')->'items')=2,'case variants remain explicit choices and barcode punctuation survives');
 perform pg_temp.verify((public.lookup_pending_checkout_items(item_a::text)#>>'{items,0,id}')=item_a::text,'item UUID label resolves exactly');
 perform pg_temp.verify((public.lookup_pending_checkout_items('__checkout_watch')->>'exact')::boolean=false,'name search is a reviewed suggestion');
 insert into public.locations(id,location_name,location_code,active,is_tray,location_role,store_id,tray_current_store_id,tray_status)
 values(tray,'__checkout_tray',gen_random_uuid()::text,true,true,'tray',store_a,store_a,'checked_in'),
 (parent,'__checkout_storage',gen_random_uuid()::text,true,false,'storage_location',store_a,null,'checked_in'),
 (away,'__checkout_other_store',gen_random_uuid()::text,true,true,'tray',store_b,store_b,'checked_in'),
 (checked_out,'__checkout_out',gen_random_uuid()::text,true,true,'tray',store_a,store_a,'checked_out');
 insert into public.locations(id,location_name,location_code,active,is_tray,location_role,parent_location_id)
 values(box,'__checkout_box',gen_random_uuid()::text,true,false,'container',parent);
 insert into public.item_stock_locations(id,item_id,location_id,quantity,condition_status)
 values(stock_a,item_a,tray,6,'good'),(box_stock,item_a,box,4,'good');
 insert into public.item_stock_locations(item_id,location_id,quantity,condition_status)
 values(item_a,parent,1,'good'),(item_a,away,2,'good'),(item_a,checked_out,2,'good'),(item_a,tray,2,'defective');
 insert into public.bulk_batches(id,item_type_id,bag_barcode,location_id,tare_weight_g,gross_weight_g,unit_weight_g,estimated_qty)
 values(bag,item_a,'BAG-'||code,tray,1,6,1,5);
 insert into public.item_stock_locations(id,item_id,location_id,batch_id,quantity,condition_status) values(bag_stock,item_a,tray,bag,5,'good');
 perform pg_temp.verify(public.lookup_pending_checkout_items('BAG-'||code)#>'{items,0,checkout_batch_ids}'=jsonb_build_array(bag),'bulk bag scan identifies its exact batch');
 insert into public.ebay_orders(id,order_number,buyer_username,total_price) values(order_a,'__checkout_'||order_a,'fixture',40),(order_b,'__checkout_'||order_b,'other',20);
 insert into public.ebay_order_lines(id,order_id,item_title,quantity,sold_for,total_price)
 values(line_a,order_a,'__checkout_watch',3,10,30),(line_b,order_a,'__checkout_manual',1,10,10),(line_other,order_b,'__checkout_other',2,10,20);
 insert into public.ebay_order_line_reservations(order_id,order_line_id,item_id,stock_location_row_id,location_id,quantity)
 values(order_a,line_a,item_a,stock_a,tray,2),(order_b,line_other,item_a,stock_a,tray,2);
 insert into public.live_sale_sessions(id,title,store_id) values(show_id,'__checkout_show',store_a);
 perform public.infer_seller_shift_for_sale_time('ebay',now(),store_a,show_id);
 perform pg_temp.verify(true,'seller inference supports both session and shift UUIDs');
 insert into public.live_sale_lots(id,session_id,auction_number) values(lot,show_id,'CHECKOUT');
 insert into public.live_sale_lot_items(lot_id,session_id,item_id,source_stock_location_row_id,source_location_id,quantity)
 values(lot,show_id,item_a,stock_a,tray,1);
 result:=public.get_pending_checkout_stock(item_a,line_a,store_a);
 perform pg_temp.verify(jsonb_array_length(result)=4,'tray, storage, inherited-store container and bulk stock are available');
 perform pg_temp.verify((select (r->>'quantity')::int=3 and (r->>'own_reserved_quantity')::int=2 from jsonb_array_elements(result) r where r->>'id'=stock_a::text),'own reservation is usable; other order and live-bag reservations remain protected');
 update public.locations set active=false where id=parent;
 perform pg_temp.verify(jsonb_array_length(public.get_pending_checkout_stock(item_a,line_a,store_a))=2,'inactive storage also hides its container');
 update public.locations set active=true where id=parent;
 payload:=jsonb_build_array(pg_temp.packing_line(line_a,item_a,stock_a,2),pg_temp.packing_line(line_b,null,null,1,0,'without_inventory'));
 select inventory_version into version_before from public.metadata where id='inventory';
 begin perform public.fulfill_pending_checkout_bundle(bad_req,store_a,payload,'__checkout_fail_after_stock__');
  raise exception 'Injected failure did not fire'; exception when raise_exception then if SQLERRM<>'Fixture final audit failure' then raise; end if; end;
 perform pg_temp.verify((select quantity=6 from public.item_stock_locations where id=stock_a),'failure after removal rolls stock back');
 perform pg_temp.verify((select bool_and(fulfilled_quantity=0) from public.ebay_order_lines where id in(line_a,line_b)),'failed mixed bundle leaves both lines pending');
 perform pg_temp.verify(not exists(select 1 from public.stock_transactions where metadata->>'pending_checkout_request_id'=bad_req::text),'failed bundle leaves no stock transactions');
 perform pg_temp.verify(public.get_pending_checkout_receipt(bad_req) is null,'failed bundle leaves no receipt');
 perform pg_temp.verify((select inventory_version=version_before from public.metadata where id='inventory'),'failed bundle leaves cache version unchanged');
 result:=public.fulfill_pending_checkout_bundle(req,store_a,payload,'mixed fixture');
 perform pg_temp.verify((select quantity=4 from public.item_stock_locations where id=stock_a),'only the scanned quantity leaves inventory');
 perform pg_temp.verify((select fulfilled_quantity=2 and line_status='partially_fulfilled' from public.ebay_order_lines where id=line_a),'inventory partial quantity is recorded');
 perform pg_temp.verify((select line_status='fulfilled' and stock_transaction_id is null from public.ebay_order_lines where id=line_b),'manual line completes without a stock transaction');
 perform pg_temp.verify((select status='partially_fulfilled' from public.ebay_orders where id=order_a),'order stays pending until all quantities are handled');
 perform pg_temp.verify((select count(*)=1 from public.stock_transactions where metadata->>'pending_checkout_request_id'=req::text and quantity=-2 and user_id=actor and source_stock_location_row_id=stock_a),'inventory audit records exact source, quantity, and authenticated actor');
 perform pg_temp.verify(exists(select 1 from public.ebay_order_admin_events a where a.payload->>'checkout_request_id'=req::text and signed_by=actor and action='fulfilled_no_inventory'),'manual completion has its own audit');
 retry:=public.fulfill_pending_checkout_bundle(req,store_a,payload,'mixed fixture');
 perform pg_temp.verify(retry=result and public.get_pending_checkout_receipt(req)=result,'lost-response retry recovers the same receipt');
 perform pg_temp.verify((select quantity=4 from public.item_stock_locations where id=stock_a),'retry cannot remove inventory twice');
 begin perform public.fulfill_pending_checkout_bundle(req,store_b,payload,'mixed fixture');raise exception 'Changed request accepted';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify(true,'request identity cannot change store or contents');
 begin perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,stock_a,1)));raise exception 'Stale expected quantity accepted';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify(true,'stale quantities reject even with a new request id');
 -- Finish the partially packed line without inventory. Preserve prior sale/stock references.
 perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,null,null,1,2,'without_inventory')));
 perform pg_temp.verify((select quantity=4 from public.item_stock_locations where id=stock_a),'manual remainder does not remove stock');
 perform pg_temp.verify((select fulfilled_quantity=3 and stock_transaction_id is not null from public.ebay_order_lines where id=line_a),'mixed completion preserves earlier inventory audit references');
 perform pg_temp.verify((select status='fulfilled' from public.ebay_orders where id=order_a),'mixed order closes after its last quantity');
 perform pg_temp.verify((select reserved_quantity=3 from public.active_stock_reservations where stock_location_row_id=stock_a),'other order and live bag keep their reservations');
 -- A fresh line cannot consume those protected three units.
 insert into public.ebay_orders(id,order_number) values(gen_random_uuid(),'__checkout_'||gen_random_uuid()) returning id into order_a;
 insert into public.ebay_order_lines(order_id,item_title,quantity) values(order_a,'__checkout_tests',10) returning id into line_a;
 insert into public.ebay_order_lines(order_id,item_title,quantity) values(order_a,'__checkout_shared_source',1) returning id into line_b;
 begin perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,stock_a,1),pg_temp.packing_line(line_b,item_a,stock_a,1)));raise exception 'Shared source oversold';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify((select quantity=4 from public.item_stock_locations where id=stock_a),'bundle totals cannot overdraw a shared source');
 begin perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,stock_a,2)));raise exception 'Reserved stock stolen';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify(true,'server refuses stock reserved to another order or bag');
 begin perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_b,jsonb_build_array(pg_temp.packing_line(line_a,item_a,stock_a,1)));raise exception 'Cross-store checkout accepted';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify(true,'server refuses cross-store checkout');
 begin perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,(select id from public.item_stock_locations where location_id=checked_out),1)));raise exception 'Checked-out tray accepted';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify(true,'server refuses checked-out trays');
 begin perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,(select id from public.item_stock_locations where location_id=tray and condition_status='defective'),1)));raise exception 'Defective stock accepted';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify(true,'server refuses defective stock');
 begin perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,stock_a,1)||'{"quantity":1.5}'));raise exception 'Fractional quantity accepted';exception when invalid_parameter_value then null;end;
 perform pg_temp.verify(true,'server refuses fractional quantity');
 perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,bag_stock,5)));
 perform pg_temp.verify((select quantity=0 from public.item_stock_locations where id=bag_stock) and (select retired_at is not null from public.bulk_batches where id=bag),'bulk removal updates its remaining stock and retirement');
 perform pg_temp.verify((select quantity=4 from public.item_stock_locations where id=stock_a),'bulk removal leaves loose stock alone');
 perform public.fulfill_pending_checkout_bundle(gen_random_uuid(),store_a,jsonb_build_array(pg_temp.packing_line(line_a,item_a,box_stock,1,5)));
 perform pg_temp.verify((select quantity=3 from public.item_stock_locations where id=box_stock),'container checkout removes the exact source');
 perform public.fulfill_ebay_order_line_for_store(line_a,item_a,box_stock,1,null,null,null,'untrusted@example.test',store_a);
 perform pg_temp.verify((select quantity=2 from public.item_stock_locations where id=box_stock),'legacy store RPC uses the protected checkout path');
 perform pg_temp.verify((select fulfilled_by_email<>( 'untrusted@example.test') from public.ebay_order_lines where id=line_a),'server records authenticated email rather than trusting the caller');
end $$;
rollback;
