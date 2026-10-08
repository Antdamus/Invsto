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
 create table item_types(id uuid primary key,title text,description text,barcode text,sale_price numeric,photos text[],photo_url text,categories text[],weight numeric,cost numeric,minimum_sale_price numeric,deleted_at timestamptz,deletion_status text default 'active');
 create table bulk_batches(id uuid primary key,item_type_id uuid,bag_barcode text);
 create table item_stock_locations(id uuid primary key,item_id uuid,location_id uuid,batch_id uuid,quantity integer,condition_status text default 'good',last_updated timestamptz,locked_by uuid,locked_at timestamptz);

 create function auth.jwt() returns jsonb language sql stable as $$select jsonb_build_object('email','staff@example.test')$$;
 create table live_sale_sessions(id uuid primary key default gen_random_uuid(),store_id uuid,status text default 'active',started_at timestamptz default now());
 create table live_sale_lots(id uuid primary key default gen_random_uuid(),session_id uuid,auction_number text,lot_code text default gen_random_uuid()::text,status text default 'open',closed_at timestamptz,matched_order_line_id uuid,matched_order_id uuid);
 create table live_sale_lot_items(id uuid primary key default gen_random_uuid(),lot_id uuid,session_id uuid,item_id uuid,source_stock_location_row_id uuid,source_location_id uuid,quantity integer default 1,status text default 'reserved',scanned_at timestamptz default now(),scanned_by uuid,scanned_by_email text,show_elapsed_seconds integer,notes text,
  packed_order_line_id uuid,packed_sale_item_id uuid,packed_stock_transaction_id uuid,packed_at timestamptz,live_unit_cost numeric,live_unit_minimum numeric);
 create table live_sale_events(id uuid primary key default gen_random_uuid(),session_id uuid,lot_id uuid,lot_item_id uuid,item_id uuid,event_type text,actor uuid default auth.uid(),actor_email text,notes text,payload jsonb);
 create table live_bag_order_links(lot_id uuid primary key,order_line_id uuid,linked_by uuid,linked_at timestamptz default now());
 create table ebay_live_attempts(id uuid primary key default gen_random_uuid(),lot_id uuid,order_line_id uuid,listing_title text,event_id text,payment_state text default 'paid',claimed_by uuid,closed_at timestamptz,resolved_at timestamptz);
 create table ebay_live_connections(event_id text primary key,session_id uuid);
 create table live_sale_manual_lot_items(id uuid,lot_id uuid,session_id uuid,status text,quantity integer,edit_revision integer,notes text);
 create function ebay_live_scan_evidence_ok(ebay_live_connections,ebay_live_attempts) returns boolean language sql as $$select true$$;

 create table ebay_orders(id uuid primary key,order_number text,buyer_username text,status text default 'pending',total_price numeric default 300,net_payout numeric,
  ebay_collected_tax numeric,ebay_collected_charges numeric,seller_collected_tax numeric,raw_payload jsonb default '{}',updated_at timestamptz);
 create table ebay_order_lines(id uuid primary key,order_id uuid references ebay_orders,item_number text,item_title text,transaction_id text,custom_label text,quantity integer default 3,fulfilled_quantity integer default 0,
  line_status text default 'pending',fulfilled_by uuid,fulfilled_by_email text,fulfilled_at timestamptz,internal_item_id uuid,stock_location_row_id uuid,location_id uuid,
  sale_id uuid,sale_item_id uuid,stock_transaction_id uuid,notes text,updated_at timestamptz,raw_payload jsonb default '{}',sold_for numeric default 100,total_price numeric default 300,net_payout numeric);
 create table stock_transactions(id uuid primary key default gen_random_uuid(),item_id uuid,location_id uuid,quantity integer,action_type text,confirmed_at timestamptz,user_id uuid,email text,
  notes text,method text,timestamp timestamptz,source_stock_location_row_id uuid,source_transaction_id uuid,stock_condition text,metadata jsonb);
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
 const oldLive=(await migration('20260516103000_live_sale_storage_source_fallback.sql')).replaceAll('\r\n','\n');
 await db.exec(oldLive.slice(oldLive.indexOf('create or replace function public.reserve_live_sale_item('),oldLive.indexOf('create or replace function public.fulfill_ebay_order_line_with_live_lot_for_store')));
 const oldLinks=await migration('20260930120000_live_bag_pending_order_links.sql');
 await db.exec(oldLinks.slice(oldLinks.indexOf('create function public.set_live_bag_order_link('),oldLinks.indexOf('create function public.get_live_bag_order_matches(')));
 await db.exec(await migration('20261008200000_shared_bag_inventory.sql'));
 await db.exec('create trigger ebay_live_inventory_gate before insert or update on live_sale_lot_items for each row execute function guard_ebay_live_reservation(); create trigger ebay_live_manual_gate before insert or update on live_sale_manual_lot_items for each row execute function guard_ebay_live_reservation()');

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


beforeEach(async()=>{
 await db.exec(`truncate shared_inventory_reviews,shared_inventory_consumptions,shared_inventory_transfers,shared_inventory_bag_links,live_bag_order_links,live_sale_events,ebay_live_attempts,ebay_live_connections,live_sale_lots,live_sale_sessions cascade;
 insert into live_sale_sessions(id,store_id) values('${id(61)}','${id(41)}');
 insert into live_sale_lots(id,session_id,auction_number,lot_code) values('${id(71)}','${id(61)}','017','LIVE-UNIQUE-17'),('${id(72)}','${id(61)}','018','LIVE-UNIQUE-18');
 update ebay_order_lines set quantity=1,total_price=100 where id='${id(11)}';`);
});
const bagscan=(bag=71,barcode='GOLD-21',source=31,qty=1)=>db.query('select * from reserve_live_sale_item($1,$2,$3,$4)',[id(bag),barcode,id(source),qty]);
const link=(bag=71,line=11)=>db.query('select set_live_bag_order_link($1,$2,null)',[id(bag),id(line)]);
const manifest=(bag=71)=>scalar('select get_shared_bag_inventory($1) v',[id(bag)]);
const totalheld=()=>scalar('select coalesce(sum(reserved_quantity),0)::int v from active_stock_reservations');
const physical=(source=31)=>scalar('select quantity v from item_stock_locations where id=$1',[id(source)]);
const legacyBag=async(bag=71)=>{await db.exec('alter table live_sale_lot_items disable trigger a_shared_bag_inventory_guard');try{await bagscan(bag);}finally{await db.exec('alter table live_sale_lot_items enable trigger a_shared_bag_inventory_guard');}};

test('bag first shares one hold; old attachment clients cannot duplicate; every completion route deducts once',async()=>{
 await bagscan();await link();assert.equal(await totalheld(),1);
 await assert.rejects(attach(1),/bag inventory/);
 await db.query('select reserve_ebay_order_line_stock($1)',[id(11)]);await bagscan();assert.equal(await totalheld(),1);
 await close();assert.equal(await physical(),4);assert.equal(await totalheld(),0);
 await db.query('select * from fulfill_ebay_order_line_with_live_lot($1,$2)',[id(11),id(71)]);
 assert.equal(await physical(),4);assert.equal(await scalar('select count(*)::int v from stock_transactions'),1);
});
test('pending first transfers the existing hold; rescans are idempotent and explicit quantity edits share the manifest',async()=>{
 await attach(1);await link();assert.equal(await totalheld(),1);assert.equal((await read())[0].status,'linked');
 await bagscan();assert.equal(await totalheld(),1);
 const before=await manifest();await db.query('select save_shared_bag_inventory($1,$2,$3,$4,2,$5)',[id(71),id(21),id(31),id(41),before.revision]);
 assert.equal((await manifest()).items[0].quantity,2);assert.equal(await totalheld(),2);assert.equal(await physical(),5);
 await assert.rejects(db.query('select save_shared_bag_inventory($1,$2,$3,$4,3,$5)',[id(71),id(21),id(31),id(41),before.revision]),/contents changed/);
 await close();assert.equal(await physical(),3);assert.equal(await totalheld(),0);
});
test('one eBay line can own a multi-item bag; completion consumes every item and preserves accounting',async()=>{
 await bagscan();await bagscan(71,'OTHER-22',33,2);await link();
 assert.equal((await manifest()).items.length,2);await close();
 assert.equal(await physical(),4);assert.equal(await physical(33),3);assert.equal(await totalheld(),0);
 assert.equal(await scalar('select sum(quantity)::int v from sale_items'),3);
 assert.equal(Number(await scalar('select sum(subtotal) v from sales_audit')),100);
 assert.equal(await scalar(`select count(*)::int v from live_sale_lot_items where status='packed'`),2);
});
test('confirmed identical legacy holds consolidate, differing quantities require review without moving stock',async()=>{
 await attach(1);await legacyBag();assert.equal(await totalheld(),2);await link();assert.equal(await totalheld(),1);
 await db.exec(`update ebay_order_lines set quantity=2 where id='${id(12)}'`);
 await attach(2,0,12);await legacyBag(72);await link(72,12);
 assert.match((await manifest(72)).conflict,/differ/);
 assert.equal(await physical(),5);
 await assert.rejects(db.query("update ebay_order_lines set fulfilled_quantity=quantity,line_status='fulfilled',fulfilled_by=$2 where id=$1",[id(12),id(1)]),/review needed/);
 await db.query('select resolve_shared_inventory_overlap($1,$2,$3,$4)',[id(72),'attachment','Verified two physical pieces',(await manifest(72)).revision]);
 assert.equal((await manifest(72)).conflict,null);assert.equal((await manifest(72)).remaining_quantity,2);assert.equal(await physical(),5);
});
test('unrelated orders and reused bag numbers never merge and cannot over-reserve the same source',async()=>{
 await attach(1);await db.exec(`update item_stock_locations set quantity=1 where id='${id(31)}'`);
 await assert.rejects(bagscan(),/Connect the bag/);
 assert.equal(await physical(),1);assert.equal(await totalheld(),1);
});
test('failed payment and stock errors roll back the full multi-item completion',async()=>{
 await bagscan();await bagscan(71,'OTHER-22',33);await link();
 await db.exec(`insert into ebay_live_connections values('event','${id(61)}');insert into ebay_live_attempts(lot_id,order_line_id,event_id,payment_state) values('${id(71)}','${id(11)}','event','failed');`);
 await assert.rejects(close(),/Payment needs review/);assert.equal(await physical(),5);assert.equal(await physical(33),5);
 assert.equal(await scalar('select count(*)::int v from stock_transactions'),0);
 assert.equal(await totalheld(),2);
});

test('old bundle checkout reuses its bag on the last stock unit and retries return the original receipt',async()=>{
 await db.exec(`update item_stock_locations set quantity=1 where id='${id(31)}'`);await bagscan();await link();
 const entries=JSON.stringify([{order_line_id:id(11),item_id:id(21),stock_location_row_id:id(31),quantity:1,expected_fulfilled_quantity:0,mode:'inventory'}]);
 const first=await scalar('select fulfill_pending_checkout_bundle($1,$2,$3::jsonb) v',[id(90),id(41),entries]);
 const repeat=await scalar('select fulfill_pending_checkout_bundle($1,$2,$3::jsonb) v',[id(90),id(41),entries]);
 assert.deepEqual(repeat,first);assert.equal(await physical(),0);assert.equal(await totalheld(),0);
 assert.equal(await scalar('select count(*)::int v from stock_transactions'),1);
});
test('unlinked bags require a deliberate connection or confirmation of separate physical units',async()=>{
 await bagscan();await assert.rejects(attach(1),/unlinked bag/);
 assert.equal((await scalar('select get_inventory_bag_candidates($1,$2) v',[id(21),id(31)])).length,1);
 await db.query('select save_pending_inventory_attachment_checked($1,$2,$3,$4,1,0,true)',[id(11),id(21),id(31),id(41)]);
 assert.equal(await totalheld(),2);assert.equal(await physical(),5);
 assert.equal(await scalar("select count(*)::int v from pending_inventory_attachment_events where action='separate_physical_units_confirmed'"),1);
});
test('two near-simultaneous scans are idempotent; stale competing edits cannot replace a saved quantity',async()=>{
 await Promise.all([bagscan(),bagscan()]);assert.equal(await totalheld(),1);await link();
 const revision=(await manifest()).revision;
 const edits=await Promise.allSettled([2,3].map(n=>db.query('select save_shared_bag_inventory($1,$2,$3,$4,$5,$6)',[id(71),id(21),id(31),id(41),n,revision])));
 assert.equal(edits.filter(x=>x.status==='fulfilled').length,1);assert.equal(edits.filter(x=>x.status==='rejected').length,1);
 assert.equal(await physical(),5);assert.equal(await totalheld(),2);
});
test('transfers after a show preserve payment holds and do not allocate fresh stock',async()=>{
 await attach(1);
 await db.exec(`insert into ebay_live_connections values('event','${id(61)}');
  insert into ebay_live_attempts(lot_id,event_id,payment_state,closed_at) values('${id(71)}','event','failed',now());
  update live_sale_sessions set status='ended' where id='${id(61)}'`);
 await link();assert.equal(await totalheld(),1);assert.equal(await physical(),5);
 await assert.rejects(close(),/Payment needs review/);
 await db.exec(`update ebay_live_attempts set payment_state='paid' where lot_id='${id(71)}'`);
 await close();assert.equal(await physical(),4);
});
test('standalone attachments retain normal checkout; private accounting functions are inaccessible',async()=>{
 await attach(1);await close();assert.equal(await physical(),4);
 assert.equal(await scalar("select has_function_privilege('authenticated','consume_shared_inventory_bag(uuid,uuid,text,text,uuid)','execute') v"),false);
 assert.equal(await scalar("select has_function_privilege('anon','get_shared_bag_inventory(uuid)','execute') v"),false);
 await db.exec("set test.allowed='no'");await assert.rejects(manifest(),/access required/);
});

test('manual bag items retain payment and claim gates without requiring inventory-only fields',async()=>{
 await db.query('insert into ebay_live_connections(event_id,session_id) values($1,$2)',['show',id(61)]);
 await db.query('insert into ebay_live_attempts(lot_id,event_id,claimed_by) values($1,$2,$3)',[id(71),'show',id(1)]);
 await db.query("insert into live_sale_manual_lot_items(id,lot_id,session_id,status,quantity) values($1,$2,$3,'reserved',1)",[id(91),id(71),id(61)]);
 await db.query('update live_sale_manual_lot_items set quantity=2 where id=$1',[id(91)]);
 await db.query("update ebay_live_attempts set payment_state='failed' where lot_id=$1",[id(71)]);
 await assert.rejects(db.query('update live_sale_manual_lot_items set quantity=3 where id=$1',[id(91)]),/paid, open/);
});
test('packed inventory cannot be reserved again without a verified stock restoration',async()=>{
 await bagscan();await link();await close();
 await assert.rejects(db.query("update live_sale_lot_items set status='reserved' where lot_id=$1",[id(71)]),/restor|packed|deduct/i);
 assert.equal(await physical(),4);assert.equal(await totalheld(),0);
});
