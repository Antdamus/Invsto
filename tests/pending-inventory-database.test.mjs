import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const migration=n=>readFile(new URL('../supabase/migrations/'+n,import.meta.url),'utf8');
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0]?.v;
const attach=(qty=2,revision=0,line=11,stock=31,item=21,store=41)=>scalar('select save_pending_inventory_attachment($1,$2,$3,$4,$5,$6) v',[id(line),id(item),id(stock),id(store),qty,revision]);
const read=()=>scalar('select get_pending_inventory_attachments($1) v',[[id(11)]]);
const close=()=>db.query('select * from complete_ebay_order_lines_without_inventory_evidence($1,_checkout_store_id=>$2,_signed_by_email=>$3)',[[id(11)],id(41),'staff@example.test']);
before(async()=>{
 db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key,email text);
 insert into auth.users values('${id(1)}','staff@example.test');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select auth.uid() is not null and current_setting('test.allowed',true)='yes'$$;
 create table store_locations(id uuid primary key,name text,active boolean default true);
 create table locations(id uuid primary key,location_name text,location_code text,parent_location_id uuid,active boolean default true,
  is_tray boolean default false,location_role text default 'storage_location',tray_status text default 'checked_in',tray_current_store_id uuid,store_id uuid);
 create table item_types(id uuid primary key,title text,description text,barcode text,sale_price numeric,photos text[],photo_url text,categories text[],weight numeric,deleted_at timestamptz,deletion_status text default 'active');
 create table bulk_batches(id uuid primary key,item_type_id uuid,bag_barcode text);
 create table item_stock_locations(id uuid primary key,item_id uuid,location_id uuid,batch_id uuid,quantity integer,condition_status text default 'good',last_updated timestamptz,locked_by uuid,locked_at timestamptz);
 create table live_sale_lot_items(source_stock_location_row_id uuid,source_location_id uuid,item_id uuid,quantity integer,status text,scanned_at timestamptz);
 create table ebay_orders(id uuid primary key,order_number text,buyer_username text,status text default 'pending',total_price numeric default 300,net_payout numeric,
  ebay_collected_tax numeric,ebay_collected_charges numeric,seller_collected_tax numeric,raw_payload jsonb default '{}',updated_at timestamptz);
 create table ebay_order_lines(id uuid primary key,order_id uuid references ebay_orders,item_number text,item_title text,transaction_id text,custom_label text,quantity integer default 3,fulfilled_quantity integer default 0,
  line_status text default 'pending',fulfilled_by uuid,fulfilled_by_email text,fulfilled_at timestamptz,internal_item_id uuid,stock_location_row_id uuid,location_id uuid,
  sale_id uuid,sale_item_id uuid,stock_transaction_id uuid,notes text,updated_at timestamptz,raw_payload jsonb default '{}',sold_for numeric default 100,total_price numeric default 300,net_payout numeric);
 create table stock_transactions(id uuid primary key default gen_random_uuid(),item_id uuid,location_id uuid,quantity integer,action_type text,confirmed_at timestamptz,user_id uuid,email text,
  notes text,method text,timestamp timestamptz,source_stock_location_row_id uuid,stock_condition text,metadata jsonb);
 create table sales(id uuid primary key default gen_random_uuid(),external_sales_id text,user_id uuid,email text,platform text,subtotal numeric,credits_applied numeric,total_discount numeric,final_amount numeric,
  platform_fee_amount numeric,platform_fee_percent numeric,profit_amount numeric,flagged boolean,verified_method text,verified_at timestamptz,created_at timestamptz);
 create table sale_items(id uuid primary key default gen_random_uuid(),sale_id uuid,item_id uuid,title text,quantity integer,sale_price numeric,discount_percent numeric,discount_amount numeric,final_price numeric,remaining_stock_qty integer,location_id uuid,photo_path text);
 create table sale_item_categories(sale_item_id uuid,category text);
 create table sales_audit(external_sales_id text,subtotal numeric,credits_applied numeric,owes_after_credit numeric,per_item_discount numeric,general_discount numeric,effective_discount_pct numeric,owes_store numeric,
  platform_fee_amount numeric,platform_fee_percent numeric,profit_amount numeric,platform text,cart_snapshot jsonb,flagged boolean,notes text,verified_method text,verified_at timestamptz,created_at timestamptz,email text,user_id uuid,credits_breakdown jsonb);
 create table ebay_order_admin_events(action text,order_ids uuid[],order_line_ids uuid[],notes text,signed_by uuid,signed_by_email text,checkout_store_id uuid,
  gps_latitude numeric,gps_longitude numeric,gps_accuracy_meters numeric,gps_captured_at timestamptz,gps_status text,payload jsonb);
 create table metadata(id text primary key,inventory_version text,changed_item_ids text[],updated_at timestamptz);
 insert into metadata(id) values('inventory');
 create function assign_seller_to_ebay_order_line(uuid,uuid,uuid,jsonb) returns void language sql as $$select$$;
 `);
 const reserve=await migration('20260523233000_ebay_order_sync_reservations.sql');
 await db.exec(reserve.slice(0,reserve.indexOf('create table if not exists public.ebay_order_sync_runs')));
 await db.exec(await migration('20260524010000_fix_ebay_order_reservation_trigger_auth.sql'));
 await db.exec(reserve.slice(reserve.indexOf('create or replace function public.reserve_ebay_order_line_stock_from_line()')));
 const core=await migration('20260515090000_ebay_pending_orders_worker_checkout.sql');await db.exec(core.slice(core.indexOf('create or replace function public.fulfill_ebay_order_line(')));
 const checkout=await migration('20260930160000_pending_inventory_checkout.sql');await db.exec(checkout.slice(checkout.indexOf('create function public.lookup_pending_checkout_items')));
 const evidence=await migration('20260517134000_no_inventory_order_evidence_repository.sql');await db.exec(evidence.slice(evidence.indexOf('create or replace function public.complete_ebay_order_lines_without_inventory_evidence(')));
 await db.exec(await migration('20261008180000_pending_inventory_attachments.sql'));
});
beforeEach(async()=>{
 await db.exec(`set test.allowed='yes';select set_config('request.jwt.claim.sub','${id(1)}',false);
 truncate pending_inventory_attachment_events,pending_inventory_attachments,ebay_order_line_reservations,ebay_order_lines,ebay_orders,item_types,item_stock_locations,locations,store_locations,
 stock_transactions,sales,sale_items,sale_item_categories,sales_audit,ebay_order_admin_events,pending_checkout_receipts,live_sale_lot_items cascade;
 insert into store_locations values('${id(41)}','Main',true),('${id(42)}','Other',true);
 insert into locations(id,location_name,store_id) values('${id(51)}','Shelf A','${id(41)}'),('${id(52)}','Shelf B','${id(42)}');
 insert into item_types(id,title,barcode,sale_price) values('${id(21)}','Gold chain','GOLD-21',100),('${id(22)}','Other item','OTHER-22',50);
 insert into item_stock_locations(id,item_id,location_id,quantity) values('${id(31)}','${id(21)}','${id(51)}',5),('${id(32)}','${id(21)}','${id(52)}',5),('${id(33)}','${id(22)}','${id(51)}',5);
 insert into ebay_orders(id,order_number,buyer_username) values('${id(2)}','ORDER-A','buyer');
 insert into ebay_order_lines(id,order_id,item_title) values('${id(11)}','${id(2)}','Order item'),('${id(12)}','${id(2)}','Another line');`);
});
after(async()=>db?.close());

test('attach persists the chosen item and quantity without removing stock or closing anything; sync preserves it',async()=>{
 const rows=await attach();assert.equal(rows[0].remaining_quantity,2);assert.equal(rows[0].item.barcode,'GOLD-21');
 assert.equal(await scalar(`select quantity v from item_stock_locations where id='${id(31)}'`),5);
 assert.equal(await scalar(`select fulfilled_quantity v from ebay_order_lines where id='${id(11)}'`),0);
 await db.query('select reserve_ebay_order_line_stock($1)',[id(11)]);
 assert.equal(await scalar(`select quantity v from ebay_order_line_reservations where order_line_id='${id(11)}'`),2);
 assert.equal((await read())[0].status,'reserved');
 await assert.rejects(attach(1,0),/changed on another screen/);
 assert.equal((await read())[0].quantity,2);
});
test('store, quantity, reservations, condition and permissions are enforced on the server',async()=>{
 await assert.rejects(attach(4),/remaining order quantity/);
 await assert.rejects(attach(1,0,11,32),/unavailable/);
 await db.exec(`insert into live_sale_lot_items values('${id(31)}','${id(51)}','${id(21)}',4,'reserved',now())`);
 await assert.rejects(attach(2),/unavailable/);await attach(1);
 await db.exec("set test.allowed='no'");await assert.rejects(read(),/access required/);await assert.rejects(attach(1,1),/access required/);
 assert.equal(await scalar("select has_function_privilege('anon','save_pending_inventory_attachment(uuid,uuid,uuid,uuid,integer,integer)','execute') v"),false);
 assert.equal(await scalar("select has_function_privilege('authenticated','remove_pending_attachment_inventory(uuid,uuid,uuid,integer,numeric,numeric,text,text)','execute') v"),false);
 assert.equal(await scalar("select has_table_privilege('authenticated','pending_inventory_attachments','update') v"),false);
});
test('quick completion consumes only the attached quantity, records accounting, and retries cannot double-remove',async()=>{
 await attach(2);await close();
 assert.equal(await scalar(`select quantity v from item_stock_locations where id='${id(31)}'`),3);
 assert.equal(await scalar('select count(*)::int v from stock_transactions'),1);
 assert.equal(await scalar('select quantity v from sale_items'),2);
 assert.equal(Number(await scalar('select profit_amount v from sales_audit')),200,'partial attachment accounts for its share of the sale');
 assert.equal(await scalar("select jsonb_array_length(payload->'inventory_attachment_removals') v from ebay_order_admin_events"),1);
 assert.equal((await read())[0].status,'consumed');
 assert.equal(await scalar(`select fulfilled_quantity v from ebay_order_lines where id='${id(11)}'`),3);
 assert.deepEqual(await scalar(`select raw_payload v from ebay_order_lines where id='${id(11)}'`),{},'inventory completion cannot restart payment reconciliation by changing imported evidence');
 await assert.rejects(close(),/Only untouched pending/);
 assert.equal(await scalar(`select quantity v from item_stock_locations where id='${id(31)}'`),3);
 await db.exec(`update ebay_orders set status='fulfilled' where id='${id(2)}'`);
 assert.equal(await scalar('select count(*)::int v from stock_transactions'),1,'later shipping status cannot remove twice');
});
test('normal checkout uses its existing stock transaction, preserves remainder, and consumes the hold exactly once',async()=>{
 await attach(2);
 const payload=qty=>JSON.stringify([{order_line_id:id(11),item_id:id(21),stock_location_row_id:id(31),quantity:qty,expected_fulfilled_quantity:0,mode:'inventory'}]);
 await db.query('select fulfill_pending_checkout_bundle($1,$2,$3::jsonb)',[id(90),id(41),payload(1)]);
 assert.equal(await scalar(`select quantity v from item_stock_locations where id='${id(31)}'`),4);
 assert.equal((await read())[0].remaining_quantity,1);
 assert.equal(await scalar(`select quantity v from ebay_order_line_reservations where order_line_id='${id(11)}' and status='reserved'`),1);
 await db.query('select fulfill_pending_checkout_bundle($1,$2,$3::jsonb)',[id(90),id(41),payload(1)]);
 assert.equal(await scalar('select count(*)::int v from stock_transactions'),1);
});
test('cancelling or removing releases the hold without reducing stock; changing a line cannot discard a hold',async()=>{
 await attach();await assert.rejects(db.query('update ebay_order_lines set quantity=1 where id=$1',[id(11)]),/attached inventory/i);
 await attach(0,1);assert.equal((await read())[0].status,'released');
 assert.equal(await scalar('select count(*)::int v from active_stock_reservations'),0);
 await attach(2,2);await db.query("update ebay_order_lines set line_status='cancelled' where id=$1",[id(11)]);
 assert.equal((await read())[0].status,'cancelled');assert.equal(await scalar('select count(*)::int v from stock_transactions'),0);
});
test('mismatched checkout, unavailable saved stock and failed audit all roll back stock and order together',async()=>{
 await attach();
 await assert.rejects(db.query('select fulfill_pending_checkout_bundle($1,$2,$3::jsonb)',[id(91),id(41),JSON.stringify([{order_line_id:id(11),item_id:id(22),stock_location_row_id:id(33),quantity:1,expected_fulfilled_quantity:0,mode:'inventory'}])]),/differs from the saved/);
 assert.equal(await scalar(`select quantity v from item_stock_locations where id='${id(33)}'`),5);
 await db.exec(`update item_stock_locations set condition_status='defective' where id='${id(31)}'`);await assert.rejects(close(),/no longer available/);
 await db.exec(`update item_stock_locations set condition_status='good' where id='${id(31)}';
 create function fail_attachment_audit() returns trigger language plpgsql as $$begin raise exception 'Test audit failure';end$$;
 create trigger fail_attachment_audit before insert on pending_inventory_attachment_events for each row execute function fail_attachment_audit();`);
 try {await assert.rejects(close(),/Test audit failure/);}finally{await db.exec('drop trigger fail_attachment_audit on pending_inventory_attachment_events;drop function fail_attachment_audit()');}
 assert.equal(await scalar(`select quantity v from item_stock_locations where id='${id(31)}'`),5);
 assert.equal(await scalar(`select fulfilled_quantity v from ebay_order_lines where id='${id(11)}'`),0);
 assert.equal((await read())[0].status,'reserved');assert.equal(await scalar('select count(*)::int v from stock_transactions'),0);
});
