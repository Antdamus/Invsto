import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const actor='00000000-0000-4000-8000-000000000001',phone='00000000-0000-4000-8000-000000000002',other='00000000-0000-4000-8000-000000000003',session='00000000-0000-4000-8000-000000000004',request='00000000-0000-4000-8000-000000000005';
const label=`tiktok-orders/${actor}/${'a'.repeat(64)}.pdf`,path=`${actor}/${request}.jpg`,photo={bucket:'tiktok-completion-photos',path,thumbnail_path:path.replace('.jpg','-thumb.jpg')};
let db,orders,lines;
before(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;create table auth.users(id uuid primary key);insert into auth.users values('${actor}'),('${phone}'),('${other}');create function auth.uid() returns uuid language sql as $$select current_setting('test.actor',true)::uuid$$;create function auth.email() returns text language sql as $$select auth.uid()::text||'@fixture.test'$$;create function can_manage_inventory() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;create table storage.objects(bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema auth,storage to authenticated;grant select,insert,delete on storage.objects to authenticated;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table ebay_orders(order_number text,notes text);insert into ebay_orders values('keep','Unchanged');`);
for(const file of ['20261018030000_tiktok_order_workspace.sql','20261018080000_tiktok_completion_workflow.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
await db.exec(`create table store_locations(id uuid primary key,name text,active boolean default true);
create table locations(id uuid primary key,location_name text,location_code text,parent_location_id uuid,active boolean default true,is_tray boolean default false,location_role text default 'storage_location',tray_status text default 'checked_in',tray_current_store_id uuid,store_id uuid);
create table item_types(id uuid primary key,title text,barcode text,deleted_at timestamptz,deletion_status text default 'active');
create table bulk_batches(id uuid primary key,bag_barcode text);
create table item_stock_locations(id uuid primary key,item_id uuid,location_id uuid,batch_id uuid,quantity integer check(quantity>=0),condition_status text default 'good',last_updated timestamptz);
create table active_stock_reservations(stock_location_row_id uuid,reserved_quantity integer);
create table stock_transactions(id uuid primary key default gen_random_uuid(),item_id uuid,location_id uuid,quantity integer,action_type text,confirmed_at timestamptz,user_id uuid,email text,notes text,method text,timestamp timestamptz,source_stock_location_row_id uuid,stock_condition text,metadata jsonb);
create table metadata(id text primary key,inventory_version text,changed_item_ids text[],updated_at timestamptz);insert into metadata(id) values('inventory');
create function lock_shared_inventory() returns void language sql as $$select pg_advisory_xact_lock(817042,20261008)$$;`);
await db.exec(await readFile(new URL('../supabase/migrations/20261018090000_tiktok_inventory_completion.sql',import.meta.url),'utf8'));
await db.exec(`create function is_admin() returns boolean language sql as $$select false$$;`);
await db.exec(await readFile(new URL('../supabase/migrations/20261018100000_tiktok_work_controls.sql',import.meta.url),'utf8'));
await db.exec(await readFile(new URL('../supabase/migrations/20261018180000_tiktok_completion_review.sql',import.meta.url),'utf8'));
await reversalSetup();for(const file of ['20261018200000_tiktok_line_completion.sql','20261018220000_tiktok_cancellation_sync.sql','20261018230000_tiktok_line_cancellations.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));});
after(()=>db.close());
beforeEach(async()=>{await db.exec(`reset role;set test.allowed='yes';set test.actor='${actor}';truncate tiktok_inventory_attachments,stock_transactions,item_stock_locations,item_types,locations,store_locations,active_stock_reservations,tiktok_order_completion_photos,tiktok_order_phone_camera_requests,tiktok_order_phone_camera_sessions,tiktok_order_documents,tiktok_order_events,tiktok_order_lines,tiktok_orders,tiktok_order_imports,storage.objects cascade;`);orders=(await db.query("insert into tiktok_orders(order_number,buyer_username,marketplace_status,marketplace_substatus,source_snapshot_at) values('577620684385522369','buyer','To ship','Awaiting shipment',now()-interval '1 day'),('577620723998233281','buyer','To ship','Awaiting shipment',now()-interval '1 day') returning *")).rows;lines=(await db.query("insert into tiktok_order_lines(order_id,sku_id,title,quantity) select id,'1732759903849189622','Ring',1 from tiktok_orders returning *")).rows;});
const scope=o=>lines.filter(l=>l.order_id===o.id).map(l=>({id:l.id,sku_id:l.sku_id,quantity:l.quantity})).sort((a,b)=>a.id.localeCompare(b.id));
const save=(o=orders[0],p=photo,s=scope(o))=>db.query('select add_tiktok_order_completion_photos($1,$2,$3,null,$4,$5,$6) r',[o.id,s.map(l=>l.id),JSON.stringify([p]),'completion_photo','spoofed@example.com',JSON.stringify(s)]);
const attach=(docs=orders.map(o=>({order_id:o.id,path:label,pages:[1]})))=>db.query('select attach_tiktok_label_batch($1) r',[JSON.stringify(docs)]);
const complete=(os=orders,confirmed=true)=>db.query('select complete_tiktok_orders($1,$2,$3) r',[os.map(o=>o.id),JSON.stringify(Object.fromEntries(os.map(o=>[o.id,o.revision]))),confirmed]);
async function objects(){await db.query('insert into storage.objects values($1,$2),($1,$3),($4,$5)',[photo.bucket,photo.path,photo.thumbnail_path,'ebay-labels',label]);}
const review=(note=null,os=orders,revisions=Object.fromEntries(os.map(o=>[o.id,o.revision])))=>db.query('select complete_tiktok_orders_review($1,$2,true,$3) r',[os.map(o=>o.id),JSON.stringify(revisions),note]);
test('completion review notes, selected orders and label evidence commit once with the authenticated actor',async()=>{
 await objects();await attach();for(const o of orders)await save(o);
 await db.query('update tiktok_orders set notes=$1',['Existing preparation note']);
 assert.equal((await review('  Gift note enclosed.  ')).rows[0].r.completed,2);
 const events=(await db.query("select * from tiktok_order_events where action='completion_review' order by order_id")).rows;assert.equal(events.length,2);
 for(const event of events){assert.equal(event.actor,actor);assert.equal(event.details.actor_email,actor+'@fixture.test');assert.equal(event.details.notes,'Gift note enclosed.');assert.deepEqual(event.details.selected_order_ids,[...orders.map(o=>o.id)].sort());assert.equal(event.details.label_document_ids.length,1);assert.equal(event.details.items.length,1);assert.ok(event.created_at);}
 await review('A retry cannot replace the original note');assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='completion_review'")).rows[0].n,2);
 assert.ok((await db.query('select notes from tiktok_orders')).rows.every(o=>o.notes==='Existing preparation note'));
 assert.deepEqual((await db.query('select * from ebay_orders')).rows,[{order_number:'keep',notes:'Unchanged'}]);
});
test('failed or unauthorized completion never saves a review note or bypasses existing completion guards',async()=>{
 await objects();await attach();await save(orders[0]);
 await assert.rejects(review('Must not save'),/completion photo/);assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='completion_review'")).rows[0].n,0);assert.ok((await db.query('select stage from tiktok_orders')).rows.every(o=>o.stage==='pending'));
 await save(orders[1]);await assert.rejects(review('Stale',orders,{}),/changed/);await assert.rejects(review('x'.repeat(4001)),/4,000/);
 await db.exec("set test.allowed='no';set role authenticated");await assert.rejects(review('Not allowed'),/access required/);await db.exec("reset role;set test.allowed='yes'");
 await review(null,[orders[0]]);const events=(await db.query("select * from tiktok_order_events where action='completion_review'")).rows;assert.equal(events.length,1);assert.equal(events[0].details.notes,null);assert.deepEqual(events[0].details.selected_order_ids,[orders[0].id]);assert.equal((await db.query('select stage from tiktok_orders where id=$1',[orders[1].id])).rows[0].stage,'pending');
});

test('labels and both photo sizes are required; retries are idempotent and actor cannot be forged',async()=>{
 await assert.rejects(attach(),/Upload/);await assert.rejects(save(),/both/);await objects();
 await db.query('delete from storage.objects where name=$1',[photo.thumbnail_path]);await assert.rejects(save(),/both/);await db.query('insert into storage.objects values($1,$2)',[photo.bucket,photo.thumbnail_path]);
 const a=(await save()).rows[0].r,b=(await save()).rows[0].r;assert.equal(a.id,b.id);assert.equal(a.signed_by_email,actor+'@fixture.test');
 assert.equal((await attach()).rows[0].r.attached,2);assert.equal((await attach()).rows[0].r.attached,0);
 assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='completion_photo_saved'")).rows[0].n,1);
 assert.deepEqual((await db.query('select * from ebay_orders')).rows,[{order_number:'keep',notes:'Unchanged'}]);
});
test('bulk completion is atomic, requires current proof and labels, and cannot bypass review through stage edits',async()=>{
 await assert.rejects(complete(),/label/);await objects();await attach();await assert.rejects(complete(),/photo/);await save();await assert.rejects(complete(),/photo/);
 assert.ok((await db.query('select stage from tiktok_orders')).rows.every(o=>o.stage==='pending'));
 await save(orders[1]);await assert.rejects(complete(orders,false),/Confirm/);
 await assert.rejects(db.query('select update_tiktok_order($1,$2,$3,$4)',[orders[0].id,orders[0].revision,'completed','']),/Use Complete/);
 assert.equal((await complete()).rows[0].r.completed,2);assert.equal((await complete()).rows[0].r.completed,0);
 assert.ok((await db.query('select stage from tiktok_orders')).rows.every(o=>o.stage==='completed'));
 const o=(await db.query('select * from tiktok_orders where id=$1',[orders[0].id])).rows[0];await assert.rejects(db.query('select update_tiktok_order($1,$2,$3,$4)',[o.id,o.revision,'pending','']),/Use Revert order/);
});
test('item changes reject stale phone photos and previous proof, and new imports reopen completed orders',async()=>{
 await objects();await attach();for(const o of orders)await save(o);await complete();
 const row={order_number:orders[0].order_number,sku_id:lines.find(l=>l.order_id===orders[0].id).sku_id,quantity:2,title:'Ring',buyer_username:'buyer',marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment'};
 await db.query('select import_tiktok_orders($1,$2,$3,now())',[JSON.stringify([row]),'b'.repeat(64),'fresh.csv']);
 const changed=(await db.query('select * from tiktok_orders where id=$1',[orders[0].id])).rows[0];assert.equal(changed.stage,'waiting');await assert.rejects(save(),/items changed/);await assert.rejects(complete([changed]),/current items/);
 await assert.rejects(complete([orders[0]]),/order changed/);
});
test('batch labels roll back invalid mappings and private storage/RPCs enforce staff identity',async()=>{
 await objects();await assert.rejects(attach([{order_id:orders[0].id,path:label},{order_id:orders[1].id,path:label.replace(actor,other)}]),/Upload/);assert.equal((await db.query('select count(*)::int n from tiktok_order_documents')).rows[0].n,0);
 await db.exec('set role authenticated');await assert.rejects(db.query('insert into storage.objects values($1,$2)',[photo.bucket,photo.path.replace(actor,other)]),/row-level/);await assert.rejects(db.exec('delete from tiktok_order_completion_photos'),/permission denied/);
 await db.exec("set test.allowed='no'");await assert.rejects(save(),/staff/i);await assert.rejects(attach(),/staff/i);await assert.rejects(complete(),/staff/i);assert.equal((await db.query('select * from storage.objects')).rows.length,0);
});
test('remove/replace proof is retry-safe and removed proof cannot complete an order',async()=>{
 await objects();await attach();const item=(await save()).rows[0].r;
 const remove=()=>db.query('select correct_tiktok_order_completion_photo($1,$2,$3,$4) r',[[item.id],photo.bucket,photo.path,request]);
 assert.equal((await remove()).rows[0].r.updated_events,1);assert.equal((await remove()).rows[0].r.updated_events,0);await assert.rejects(complete([orders[0]]),/completion photo/);
 assert.equal((await db.query('select jsonb_array_length(photo_attachments) n from tiktok_order_completion_photos')).rows[0].n,0);
});
test('phone pairing scopes requests to TikTok, one staff phone, owner-only control, and never rewinds on retry',async()=>{
 const send=(r=request,ids=lines.map(l=>l.id))=>db.query('select send_tiktok_order_to_phone($1,$2,$3) r',[session,r,ids]);
 let result=(await send()).rows[0].r;assert.equal(result.request.lines.length,2);assert.equal(result.request.lines[0].quantity,1);assert.equal(result.request.lines[0].item_number,'1732759903849189622');
 await send(other,[lines[1].id]);result=(await send()).rows[0].r;assert.equal(result.request.id,other);
 await db.exec(`set test.actor='${phone}'`);await assert.rejects(send(),/another workstation/);await assert.rejects(db.query('select read_tiktok_order_phone_camera($1,false)',[session]),/Only the workstation/);
 await db.query('select read_tiktok_order_phone_camera($1,true)',[session]);await db.query('select mark_tiktok_order_phone_camera_request($1,$2,$3)',[session,other,'saved']);
 await db.exec(`set test.actor='${other}'`);await assert.rejects(db.query('select read_tiktok_order_phone_camera($1,true)',[session]),/different staff/);await assert.rejects(db.query('select disconnect_tiktok_order_phone_camera($1)',[session]),/Only the workstation/);
 await db.exec(`set test.actor='${actor}'`);await db.query('select disconnect_tiktok_order_phone_camera($1)',[session]);await assert.rejects(db.query('select read_tiktok_order_phone_camera($1,false)',[session]),/ended/);
});

const stockId='10000000-0000-4000-8000-000000000001',itemId='10000000-0000-4000-8000-000000000002',locationId='10000000-0000-4000-8000-000000000003',storeId='10000000-0000-4000-8000-000000000004';
async function inventory(){await db.query('insert into store_locations(id,name) values($1,$2)',[storeId,'Main']);await db.query('insert into locations(id,location_name,store_id) values($1,$2,$3)',[locationId,'Shelf',storeId]);await db.query('insert into item_types(id,title,barcode) values($1,$2,$3)',[itemId,'Gold ring','0000123']);await db.query('insert into item_stock_locations(id,item_id,location_id,quantity) values($1,$2,$3,5)',[stockId,itemId,locationId]);}
const link=(o=orders[0],qty=1,rev=0)=>db.query('select save_tiktok_inventory_attachment($1,$2,$3,$4,$5,$6) r',[lines.find(l=>l.order_id===o.id).id,itemId,stockId,storeId,qty,rev]);
const stock=async()=>(await db.query('select quantity from item_stock_locations where id=$1',[stockId])).rows[0].quantity;
const fresh=async()=>{orders=(await db.query('select * from tiktok_orders order by order_number')).rows;};
test('scanning links exact inventory without deducting; completion deducts once with a TikTok stock audit',async()=>{
 await inventory();const a=(await link()).rows[0].r;assert.equal(a.quantity,1);assert.equal(a.consumed_quantity,0);assert.equal(await stock(),5);assert.equal((await link()).rows[0].r.revision,1);await fresh();
 await objects();await attach();for(const o of orders)await save(o);assert.equal((await complete()).rows[0].r.inventory_units_deducted,1);assert.equal(await stock(),4);assert.equal((await complete()).rows[0].r.inventory_units_deducted,0);assert.equal(await stock(),4);
 const tx=(await db.query('select * from stock_transactions')).rows;assert.equal(tx.length,1);assert.equal(tx[0].quantity,-1);assert.equal(tx[0].metadata.marketplace,'tiktok');assert.equal(tx[0].metadata.order_id,orders[0].id);assert.equal(tx[0].source_stock_location_row_id,stockId);
 assert.equal((await db.query('select consumed_quantity from tiktok_inventory_attachments')).rows[0].consumed_quantity,1);assert.deepEqual((await db.query('select * from ebay_orders')).rows,[{order_number:'keep',notes:'Unchanged'}]);
});
test('stock, reservation, source and evidence failures roll back the entire buyer completion',async()=>{
 await inventory();await link();await link(orders[1]);await fresh();await objects();await attach();await save();await assert.rejects(complete(),/completion photo/);assert.equal(await stock(),5);assert.equal((await db.query('select count(*)::int n from stock_transactions')).rows[0].n,0);await save(orders[1]);
 await db.query('insert into active_stock_reservations values($1,4)',[stockId]);await assert.rejects(complete(),/no longer available/);assert.equal(await stock(),5);assert.ok((await db.query('select stage from tiktok_orders')).rows.every(o=>o.stage==='pending'));
 await db.exec('truncate active_stock_reservations');await db.query("update locations set tray_status='checked_out',is_tray=true where id=$1",[locationId]);await assert.rejects(complete(),/no longer available/);assert.equal(await stock(),5);
 await db.query("update locations set is_tray=false where id=$1",[locationId]);await db.query("update item_stock_locations set condition_status='defective' where id=$1",[stockId]);await assert.rejects(complete(),/no longer available/);
});
test('link changes invalidate stale completion, can be removed without stock changes, and cannot bypass via dispatch',async()=>{
 await inventory();await assert.rejects(link(orders[0],2),/Quantity/);await link();await assert.rejects(link(orders[0],0,0),/another screen/);
 await db.query("update tiktok_orders set stage='packed' where id=$1",[orders[0].id]);await assert.rejects(db.query("update tiktok_orders set stage='dispatched' where id=$1",[orders[0].id]),/Use Complete order/);
 await objects();await attach();for(const o of orders)await save(o);await assert.rejects(complete(),/order changed/);assert.equal(await stock(),5);
 await link(orders[0],0,1);await fresh();assert.equal((await complete()).rows[0].r.inventory_units_deducted,0);assert.equal(await stock(),5);
 await db.exec('set role authenticated');await assert.rejects(db.query('select complete_tiktok_orders_evidence($1,$2,true)',[orders.map(o=>o.id),'{}']),/permission denied/);await assert.rejects(db.exec('delete from tiktok_inventory_attachments'),/permission denied/);
});
test('reopened orders retain consumed quantities and never deduct old units a second time',async()=>{
 await inventory();await link();await fresh();await objects();await attach();for(const o of orders)await save(o);await complete();assert.equal(await stock(),4);
 await db.query("update tiktok_orders set stage='waiting',revision=revision+1 where id=$1",[orders[0].id]);await fresh();await complete();assert.equal(await stock(),4);assert.equal((await db.query('select count(*)::int n from stock_transactions')).rows[0].n,1);
});

const lineOf=o=>lines.find(l=>l.order_id===o.id);
async function work(action,{o=orders[0],note='',confirmed=false,certificate=null,revision}={}){const l=lineOf(o);const w=(await db.query('select * from tiktok_line_work where line_id=$1',[l.id])).rows[0];return db.query('select save_tiktok_line_work($1,$2,$3,$4,$5,$6) r',[l.id,revision??w?.revision??0,action,note,confirmed,certificate]);}
async function certificate(o=orders[0],id=request){const l=lineOf(o),path=`certificates/${actor}/${l.id}/${id}/${'a'.repeat(64)}.pdf`;await db.query('insert into storage.objects values($1,$2)',['tiktok-order-certificates',path]);return (await db.query('select to_jsonb(save_tiktok_line_certificate($1,$2,null,null,null,null,$3)) r',[id,l.id,JSON.stringify([{bucket:'tiktok-order-certificates',path,mime_type:'application/pdf'}])])).rows[0].r;}
test('item and watch controls persist, reject stale updates, and block a whole buyer before stock deduction',async()=>{
 await inventory();await link();await objects();await attach();for(const o of orders)await save(o);
 await work('not_found');await fresh();await assert.rejects(complete([orders[1]]),/item not found/);assert.equal(await stock(),5);await assert.rejects(work('found',{revision:0}),/another screen/);
 await work('found');await work('watch');await work('missing');await fresh();await assert.rejects(complete(),/watch missing/);await assert.rejects(work('unwatch'),/Clear/);await assert.rejects(work('watch_found'),/physically/);
 await work('watch_found',{confirmed:true});await fresh();assert.equal((await complete()).rows[0].r.inventory_units_deducted,1);await assert.rejects(work('not_found'),/read-only/);
});
test('CGL requires a real copy on the exact line plus explicit confirmation; invalidation reopens its hold',async()=>{
 await work('watch');await work('require_cgl');const c=await certificate();await objects();await attach();for(const o of orders)await save(o);await fresh();await assert.rejects(complete(),/pending CGL/);
 await assert.rejects(work('confirm_cgl',{certificate:c.id}),/Confirm/);await assert.rejects(work('confirm_cgl',{o:orders[1],confirmed:true,certificate:c.id}),/Confirm/);await work('watch',{o:orders[1]});await work('require_cgl',{o:orders[1]});await assert.rejects(work('confirm_cgl',{o:orders[1],confirmed:true,certificate:c.id}),/exact item/);
 await work('confirm_cgl',{confirmed:true,certificate:c.id});await assert.rejects(work('unwatch'),/Clear/);await assert.rejects(work('remove_cgl'),/correction/);await work('remove_cgl',{o:orders[1],note:'Not a watch requiring CGL'});
 await db.query('select void_tiktok_line_certificate($1,$2)',[c.id,'Wrong report']);await fresh();await assert.rejects(complete(),/pending CGL/);assert.equal((await db.query('select certificate_id from tiktok_line_work where line_id=$1',[lineOf(orders[0]).id])).rows[0].certificate_id,null);
 const corrected=await certificate(orders[0],other);await work('confirm_cgl',{confirmed:true,certificate:corrected.id});await fresh();await complete();assert.equal((await db.query('select count(*)::int n from tiktok_order_line_certificates')).rows[0].n,2);
});
test('cancellation holds are audited and retry-safe without cancelling the marketplace sale or changing stock',async()=>{
 const cancel=(rev=0,pending=true,reason='Customer requested cancellation')=>db.query('select set_tiktok_cancellation($1,$2,$3,$4) r',[orders[0].id,rev,pending,reason]);await inventory();await link();await objects();await attach();for(const o of orders)await save(o);
 await cancel();await cancel();await fresh();await assert.rejects(complete([orders[1]]),/pending cancellation/);assert.equal(await stock(),5);assert.ok(orders.every(o=>o.marketplace_status==='To ship'));await assert.rejects(cancel(0,false,'Continue'),/another screen/);await assert.rejects(cancel(1,false,''),/reason/);
 await assert.rejects(db.query("update tiktok_orders set stage='packed' where id=$1",[orders[1].id]),/pending cancellation/);
 await cancel(1,false,'Customer chose to keep the order');await fresh();await complete();assert.equal(await stock(),4);assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='pending_cancellation'")).rows[0].n,1);
});
test('certificate uploads and work RPCs enforce ownership, permissions and retained copies',async()=>{
 await assert.rejects(db.query('select save_tiktok_line_certificate($1,$2,null,null,null,null,$3)',[request,lineOf(orders[0]).id,'[]']),/at least one/);
 const c=await certificate();await db.exec(`set test.actor='${phone}'`);await assert.rejects(db.query('select void_tiktok_line_certificate($1,$2)',[c.id,'Wrong']),/author/);await db.exec('set role authenticated');await assert.rejects(db.exec('delete from tiktok_order_line_certificates'),/permission denied/);await assert.rejects(db.exec('delete from tiktok_line_work'),/permission denied/);await assert.rejects(db.query('select complete_tiktok_orders_inventory($1,$2,true)',[orders.map(o=>o.id),'{}']),/permission denied/);
 await db.exec("set test.allowed='no'");await assert.rejects(work('watch'),/staff/);await assert.rejects(db.query('select set_tiktok_cancellation($1,0,true,$2)',[orders[0].id,'Cancel']),/staff/);
});

test('completion can be followed by carrier dispatch without reopening or deducting stock twice',async()=>{
 await inventory();await link();await fresh();await objects();await attach();for(const o of orders)await save(o);await complete();await fresh();await db.exec("update tiktok_order_lines set tracking_number='TRACKING123'");
 await db.query('select update_tiktok_order($1,$2,$3,$4,null,true)',[orders[0].id,orders[0].revision,'dispatched','']);assert.equal(await stock(),4);assert.equal((await db.query('select stage from tiktok_orders where id=$1',[orders[0].id])).rows[0].stage,'dispatched');
});

let reversalInstalled=false;
async function reversalSetup(){
 if(!reversalInstalled){
  await db.exec(`alter table auth.users add column email text;update auth.users set email=id::text||'@fixture.test';
    create table employees(user_id uuid primary key,display_name text,role text,active boolean);`);
  for(const file of ['20261018130000_order_reversal_permissions.sql','20261018132000_audited_tiktok_order_reversals.sql'])
   await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
  reversalInstalled=true;
 }
 await db.exec(`truncate employees;insert into employees values('${actor}','Manager','manager',true);`);
}
const revert=(os=orders,reason='Wrong order completed',confirmed=true)=>db.query('select revert_tiktok_orders($1,$2,$3,$4) r',[os.map(o=>o.id),JSON.stringify(Object.fromEntries(os.map(o=>[o.id,o.revision]))),reason,confirmed]);
const completeLines=(ids,note='Packed selected items',revisions=Object.fromEntries(orders.map(o=>[o.id,o.revision])),confirmed=true)=>db.query('select complete_tiktok_order_lines_review($1,$2,$3,$4) r',[ids,JSON.stringify(revisions),confirmed,note]);
async function extraLine(){const l=(await db.query("insert into tiktok_order_lines(order_id,sku_id,title,quantity) values($1,'1732759903849189623','Necklace',2) returning *",[orders[0].id])).rows[0];lines.push(l);return l;}
test('partial completion excludes lost lines and other orders from evidence, notes and inventory; retry is idempotent',async()=>{
 const extra=await extraLine(),selected=lineOf(orders[0]);await inventory();await link();await link(orders[1]);
 await db.query('select save_tiktok_inventory_attachment($1,$2,$3,$4,2,0)',[extra.id,itemId,stockId,storeId]);
 await db.query("select save_tiktok_line_work($1,0,'not_found')",[extra.id]);await work('not_found',{o:orders[1]});
 await objects();await attach([{order_id:orders[0].id,path:label,pages:[1]}]);await save(orders[0],photo,[scope(orders[0]).find(l=>l.id===selected.id)]);await fresh();
 const revisions=Object.fromEntries(orders.map(o=>[o.id,o.revision]));await db.exec('set role authenticated');
 const result=(await completeLines([selected.id], '  Box 1 packed  ',revisions)).rows[0].r;await db.exec('reset role');
 assert.deepEqual(result,{completed:0,completed_lines:1,inventory_units_deducted:1});assert.equal(await stock(),4);
 await fresh();assert.equal(orders[0].stage,'preparing');assert.ok(orders[0].reopened_at);assert.equal(orders[1].stage,'pending');
 const states=(await db.query('select id,fulfilled_at,fulfilled_by from tiktok_order_lines')).rows;assert.equal(states.filter(l=>l.fulfilled_at).length,1);assert.equal(states.find(l=>l.id===selected.id).fulfilled_by,actor);
 assert.equal((await db.query('select consumed_quantity from tiktok_inventory_attachments where line_id=$1',[extra.id])).rows[0].consumed_quantity,0);
 const audit=(await db.query("select * from tiktok_order_events where action='completion_review'")).rows;assert.equal(audit.length,1);assert.equal(audit[0].order_id,orders[0].id);assert.equal(audit[0].details.notes,'Box 1 packed');assert.deepEqual(audit[0].details.selected_line_ids,[selected.id]);assert.deepEqual(audit[0].details.remaining_line_ids,[extra.id]);assert.equal(audit[0].details.completion_photo_ids.length,1);
 assert.equal((await completeLines([selected.id], 'Retry',revisions)).rows[0].r.completed_lines,0);assert.equal(await stock(),4);
 await assert.rejects(work('not_found'),/read-only/);await assert.rejects(link(orders[0],0,2),/Only open/);
 await db.exec("update tiktok_order_lines set tracking_number='TRACKING123'");await assert.rejects(db.query("select update_tiktok_order($1,$2,'dispatched','',null,true)",[orders[0].id,orders[0].revision]),/remaining|deduct|Use Complete order/);
 await db.query("select save_tiktok_line_work($1,1,'found')",[extra.id]);
 const second={...photo,path:`${actor}/${other}.jpg`,thumbnail_path:`${actor}/${other}-thumb.jpg`};await db.query('insert into storage.objects values($1,$2),($1,$3)',[second.bucket,second.path,second.thumbnail_path]);await save(orders[0],second,[scope(orders[0]).find(l=>l.id===extra.id)]);await fresh();
 assert.equal((await completeLines([extra.id])).rows[0].r.completed,1);assert.equal(await stock(),2);await fresh();assert.equal(orders[0].stage,'completed');assert.equal(orders[1].stage,'pending');
});
test('line completion rejects lost, CGL, cancelled, stale, empty, foreign and unauthorized requests atomically',async()=>{
 await inventory();await link();await objects();await attach();for(const o of orders)await save(o);await fresh();const ids=lines.map(l=>l.id);
 await assert.rejects(completeLines([]),/Select/);await assert.rejects(completeLines([request]),/not found/);await assert.rejects(completeLines(ids,null,{},false),/Confirm/);await assert.rejects(completeLines(ids,null,{}),/changed/);await assert.rejects(completeLines(ids,'x'.repeat(4001)),/4,000/);
 const stale=Object.fromEntries(orders.map(o=>[o.id,o.revision]));await work('not_found',{o:orders[1]});await assert.rejects(completeLines(ids,null,stale),/changed/);await fresh();await assert.rejects(completeLines(ids),/lost/);assert.equal(await stock(),5);
 await work('found',{o:orders[1]});await work('watch',{o:orders[1]});await work('require_cgl',{o:orders[1]});await fresh();await assert.rejects(completeLines(ids),/CGL/);
 await work('remove_cgl',{o:orders[1],note:'Not needed'});await db.query("select set_tiktok_cancellation($1,0,true,'Buyer requested cancellation')",[orders[1].id]);await fresh();await assert.rejects(completeLines(ids),/cancellation/);
 await db.exec("set test.allowed='no';set role authenticated");await assert.rejects(completeLines(ids),/access required/);await db.exec('reset role');await db.exec('set role anon');await assert.rejects(completeLines(ids),/permission denied/);await db.exec('reset role');
 assert.equal(await stock(),5);assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='completion_review'")).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from tiktok_order_lines where fulfilled_at is not null')).rows[0].n,0);
});
test('selected photo proof supports subsets, rejects foreign or stale scopes, and cannot cover an unpictured item',async()=>{
 const extra=await extraLine(),selected=lineOf(orders[0]);await objects();await attach();const subset=scope(orders[0]).filter(l=>l.id===selected.id);await save(orders[0],photo,subset);
 await assert.rejects(save(orders[0],photo,scope(orders[1])),/items changed/);await assert.rejects(save(orders[0],photo,[{...subset[0],quantity:99}]),/items changed/);
 await assert.rejects(completeLines([extra.id]),/completion photo/);await assert.rejects(completeLines([selected.id,extra.id]),/completion photo/);
 await db.query("update tiktok_order_completion_photos set payload=payload||'{\"history_removed\":true}',photo_attachments='[]'");await assert.rejects(completeLines([selected.id]),/completion photo/);
});
test('selected-line stock failure rolls back every deduction, completion marker and audit note',async()=>{
 await inventory();await link();await link(orders[1]);await objects();await attach();for(const o of orders)await save(o);await fresh();
 await db.query('update item_stock_locations set quantity=1 where id=$1',[stockId]);await assert.rejects(completeLines(lines.map(l=>l.id)),/no longer available/);assert.equal(await stock(),1);
 assert.equal((await db.query('select count(*)::int n from stock_transactions')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from tiktok_order_lines where fulfilled_at is not null')).rows[0].n,0);
 assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='completion_review'")).rows[0].n,0);
});
test('a manager can reverse partial completion and the audit retains the completed line snapshot',async()=>{
 await reversalSetup();await extraLine();await inventory();await link();await objects();await attach();await save(orders[0]);await fresh();const selected=lineOf(orders[0]);await completeLines([selected.id]);await fresh();
 assert.equal(orders[0].stage,'preparing');assert.equal(await stock(),4);const result=(await revert([orders[0]])).rows[0].r;assert.equal(result.restored_units,1);assert.equal(await stock(),5);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_lines where fulfilled_at is not null')).rows[0].n,0);
 const audit=(await db.query("select details from tiktok_order_events where action='order_reverted'")).rows[0].details;assert.equal(audit.lines.filter(l=>l.fulfilled_at).length,1);assert.equal(audit.before.stage,'preparing');assert.equal(audit.after.stage,'pending');
});
test('unchanged imports preserve completed lines while changed quantities and new lines reopen their work',async()=>{
 await objects();await attach();await save(orders[0]);await fresh();const selected=lineOf(orders[0]);await completeLines([selected.id]);
 const row={order_number:orders[0].order_number,sku_id:selected.sku_id,quantity:1,title:'Ring',buyer_username:'buyer',marketplace_status:'Shipped',marketplace_substatus:'Awaiting delivery'};
 await db.query('select import_tiktok_orders($1,$2,$3,now())',[JSON.stringify([row]),'c'.repeat(64),'same.csv']);await fresh();assert.equal(orders[0].stage,'completed');assert.ok((await db.query('select fulfilled_at from tiktok_order_lines where id=$1',[selected.id])).rows[0].fulfilled_at);
 const newRow={...row,sku_id:'1732759903849189623',title:'New necklace'};await db.query("select import_tiktok_orders($1,$2,$3,now()+interval '0.5 seconds')",[JSON.stringify([row,newRow]),'e'.repeat(64),'new-item.csv']);await fresh();assert.equal(orders[0].stage,'waiting');assert.ok(orders[0].reopened_at);assert.equal((await db.query('select count(*)::int n from tiktok_order_lines where order_id=$1 and fulfilled_at is null',[orders[0].id])).rows[0].n,1);
 row.quantity=2;await db.query("select import_tiktok_orders($1,$2,$3,now()+interval '1 second')",[JSON.stringify([row]),'d'.repeat(64),'changed.csv']);await fresh();assert.equal(orders[0].stage,'waiting');assert.ok(orders[0].reopened_at);assert.equal((await db.query('select fulfilled_at from tiktok_order_lines where id=$1',[selected.id])).rows[0].fulfilled_at,null);await assert.rejects(completeLines([selected.id]),/current quantity/);
});
async function finished(){await inventory();await link();await fresh();await objects();await attach();for(const o of orders)await save(o);await complete();await fresh();}
test('TikTok manager reversal restores only consumed stock, preserves evidence and marketplace status, and records full before/after',async()=>{
 await reversalSetup();await finished();assert.equal(await stock(),4);await db.exec("update tiktok_orders set marketplace_status='Shipped'");await fresh();
 await db.exec('set role authenticated');const result=(await revert()).rows[0].r;await db.exec('reset role');assert.deepEqual(result,{reverted_orders:2,restored_units:1});assert.equal(await stock(),5);
 const audits=(await db.query("select * from tiktok_order_events where action='order_reverted'")).rows;
 assert.equal(audits.length,2);assert.ok(audits.every(a=>a.actor===actor&&a.created_at));
 const details=audits.find(a=>a.details.restored_units===1).details;
 assert.equal(details.actor_email,actor+'@fixture.test');assert.equal(details.actor_role,'manager');assert.equal(details.notes,'Wrong order completed');
 assert.equal(details.before.stage,'completed');assert.equal(details.after.stage,'pending');assert.equal(details.after.marketplace_status,'Shipped');
 assert.equal(details.inventory_before[0].consumed_quantity,1);assert.equal(details.stock_movements[0].before_quantity,4);assert.equal(details.stock_movements[0].after_quantity,5);
 assert.equal((await db.query('select consumed_quantity from tiktok_inventory_attachments')).rows[0].consumed_quantity,0);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_completion_photos')).rows[0].n,2);assert.equal((await db.query('select count(*)::int n from tiktok_order_documents')).rows[0].n,2);
 await assert.rejects(revert(),/changed/);assert.equal(await stock(),5);
 await fresh();assert.ok(orders.every(o=>o.reopened_at));await assert.rejects(revert(),/already have been reverted/);
 await complete();await fresh();assert.equal(await stock(),4);assert.ok(orders.every(o=>!o.reopened_at));
});
test('TikTok employee/inactive/unregistered callers cannot reverse or bypass through preparation edits',async()=>{
 await reversalSetup();await finished();
 await assert.rejects(db.query('select update_tiktok_order($1,$2,$3,$4)',[orders[0].id,orders[0].revision,'pending','I want to reopen']),/Use Revert order/);
 await db.exec("update employees set role='employee'");await assert.rejects(revert(),/active admins and managers/);
 await db.exec("update employees set role='manager',active=false");await assert.rejects(revert(),/active admins and managers/);
 await db.exec(`set test.actor='${phone}'`);await assert.rejects(revert(),/active admins and managers/);
 await db.exec('set role anon');await assert.rejects(revert(),/permission denied/);await db.exec('reset role');
 await db.exec('set role authenticated');await assert.rejects(db.exec('delete from tiktok_order_events'),/permission denied/);
 await assert.rejects(db.query("insert into tiktok_order_events(order_id,actor,action,details) values($1,$2,'order_reverted','{}')",[orders[0].id,phone]),/permission denied/);
 await db.exec('reset role');assert.equal(await stock(),4);
});
test('TikTok stale/missing orders, cancellation, invalid reasons and unconfirmed reversal fail atomically',async()=>{
 await reversalSetup();await finished();
 await assert.rejects(revert(orders,' '),/note is required/);await assert.rejects(revert(orders,'x'.repeat(2001)),/note is required/);await assert.rejects(revert(orders,'Reason',false),/Confirm/);
 await assert.rejects(revert([...orders,{id:request,revision:1}]),/not found/);
 const stale=structuredClone(orders);stale[1].revision++;await assert.rejects(revert(stale),/changed/);assert.equal(await stock(),4);
 await db.query("update tiktok_orders set marketplace_status='Canceled' where id=$1",[orders[1].id]);await assert.rejects(revert(),/cancellation/);
 assert.equal(await stock(),4);assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='order_reverted'")).rows[0].n,0);
});

const markCancelled=(o=orders[0],cancelled=true,reason='Verified cancellation in TikTok',confirmed=true)=>db.query('select record_tiktok_cancellation($1,$2,$3,$4,$5) r',[o.id,o.revision,cancelled,reason,confirmed]);
test('manual cancellation is exact, signed, retry-safe and preserves evidence and inventory',async()=>{
 await inventory();await link();await objects();await attach();for(const o of orders)await save(o);
 await db.query("select set_tiktok_cancellation($1,0,true,'Buyer requested cancellation')",[orders[0].id]);await fresh();const original=orders[0];
 await assert.rejects(markCancelled(original,true,'No',true),/reason/);await assert.rejects(markCancelled(original,true,undefined,false),/Confirm/);await assert.rejects(markCancelled({...original,revision:0}),/changed/);
 await db.exec('set role authenticated');await markCancelled(original);await markCancelled(original);await db.exec('reset role');await fresh();
 assert.equal(orders[0].marketplace_status,'Canceled');assert.equal(orders[1].marketplace_status,'To ship');assert.equal(orders[0].stage,original.stage);assert.equal(await stock(),5);
 assert.equal((await db.query('select pending from tiktok_order_cancellations where order_id=$1',[original.id])).rows[0].pending,false);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_documents')).rows[0].n,2);assert.equal((await db.query('select count(*)::int n from tiktok_order_completion_photos')).rows[0].n,2);
 const events=(await db.query("select * from tiktok_order_events where action='cancellation_confirmed'")).rows;assert.equal(events.length,1);assert.equal(events[0].actor,actor);assert.equal(events[0].details.actor_email,actor+'@fixture.test');assert.equal(events[0].details.before.marketplace_status,'To ship');assert.equal(events[0].details.after.marketplace_status,'Canceled');assert.equal(events[0].details.inventory_changed,false);
 await assert.rejects(complete([orders[0]]),/cancell/i);assert.deepEqual((await db.query('select * from ebay_orders')).rows,[{order_number:'keep',notes:'Unchanged'}]);
});
test('only managers correct manual marks, restoring the original cancellation hold with a separate audit',async()=>{
 await reversalSetup();await db.query("select set_tiktok_cancellation($1,0,true,'Hold for buyer')",[orders[0].id]);await fresh();await markCancelled();await fresh();
 await db.exec("update employees set role='employee'");await assert.rejects(markCancelled(orders[0],false,'Mistaken order number'),/Only admins and managers/);
 await db.exec("update employees set role='manager'");await markCancelled(orders[0],false,'Mistaken order number');await fresh();assert.equal(orders[0].marketplace_status,'To ship');assert.equal(orders[0].cancellation_record,null);
 const hold=(await db.query('select * from tiktok_order_cancellations where order_id=$1',[orders[0].id])).rows[0];assert.equal(hold.pending,true);assert.equal(hold.reason,'Hold for buyer');assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='cancellation_corrected'")).rows[0].n,1);
});
test('status refresh audits known and newly discovered cancellations, ignores stale reports and cannot silently reopen cancellations',async()=>{
 await reversalSetup();await inventory();await link();await db.query("select set_tiktok_cancellation($1,0,true,'Waiting for TikTok')",[orders[0].id]);await fresh();
 const row={order_number:orders[0].order_number,sku_id:lineOf(orders[0]).sku_id,title:'Ring',quantity:1,buyer_username:'buyer',marketplace_status:'Canceled',marketplace_substatus:'Canceled',cancel_return:'Cancelled by buyer'};
 const imported=(rows,hash,offset)=>db.query("select import_tiktok_orders($1,$2,'All orders.csv',now()+$3::interval) r",[JSON.stringify(rows),hash.repeat(64),offset]);
 const result=(await imported([row,{...row,order_number:'577623648796643333'}],'a','-1 hour')).rows[0].r;assert.equal(result.refreshed,1);assert.equal(result.history_skipped,0);assert.equal(result.added,1);await fresh();assert.equal(orders[0].cancellation_record.source,'export');assert.equal(orders[1].marketplace_status,'To ship');assert.equal(await stock(),5);
 assert.equal((await db.query('select pending from tiktok_order_cancellations where order_id=$1',[orders[0].id])).rows[0].pending,false);
 const audit=(await db.query("select * from tiktok_order_events where action='cancellation_imported'")).rows;assert.equal(audit.length,2);assert.equal(audit.find(e=>e.order_id===orders[0].id).details.before.marketplace_status,'To ship');assert.equal(audit[0].details.source,'export');assert.equal(audit[0].actor,actor);
 assert.equal((await imported([row],'a','-1 hour')).rows[0].r.already_imported,true);
 const active={...row,marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment'};assert.equal((await imported([active],'b','-2 hours')).rows[0].r.stale,1);
 await imported([active],'c','-30 minutes');await fresh();assert.equal(orders[0].marketplace_status,'Canceled');assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='cancellation_refresh_conflict'")).rows[0].n,1);
 await assert.rejects(markCancelled(orders[0],false,'Attempt to reopen'),/Only a manual cancellation/);
});
test('cancellation cannot bypass staff permissions or directly edit audit rows, and never refunds completed stock',async()=>{
 await finished();assert.equal(await stock(),4);await markCancelled();assert.equal(await stock(),4);await fresh();assert.equal(orders[0].stage,'completed');
 await db.exec("set test.allowed='no';set role authenticated");await assert.rejects(markCancelled(orders[1]),/access required/);await assert.rejects(db.query("update tiktok_orders set marketplace_status='Canceled'"),/permission denied/);await assert.rejects(db.query('delete from tiktok_order_events'),/permission denied/);
 await db.exec("reset role;set test.allowed='yes';set test.actor=''");await assert.rejects(markCancelled(orders[1]));
});

const cancelLine=(line,o=orders[0],cancelled=true,reason='Item cancellation verified in TikTok',confirmed=true)=>db.query('select record_tiktok_line_cancellation($1,$2,$3,$4,$5) r',[line.id,o.revision,cancelled,reason,confirmed]);
test('item cancellation is audited, retry-safe, survives imports and cannot deduct the cancelled stock',async()=>{
 const extra=await extraLine(),live=lineOf(orders[0]);await inventory();await link();await db.query('select save_tiktok_inventory_attachment($1,$2,$3,$4,2,0)',[extra.id,itemId,stockId,storeId]);
 await objects();await attach([{order_id:orders[0].id,path:label,pages:[1]}]);await save(orders[0],photo,[scope(orders[0]).find(l=>l.id===live.id)]);await fresh();const previous=orders[0];
 await db.exec('set role authenticated');await cancelLine(extra,previous);await cancelLine(extra,previous);await db.exec('reset role');await fresh();assert.equal(await stock(),5);
 const events=(await db.query("select * from tiktok_order_events where action='line_cancellation_confirmed'")).rows;assert.equal(events.length,1);assert.equal(events[0].actor,actor);assert.equal(events[0].details.sku_id,extra.sku_id);assert.equal(events[0].details.quantity,2);assert.equal(events[0].details.inventory_changed,false);
 await assert.rejects(completeLines([extra.id]),/cancelled/);await assert.rejects(complete([orders[0]]),/cancelled/);await assert.rejects(db.query("select save_tiktok_line_work($1,0,'found')",[extra.id]),/read-only/);
 const row={order_number:orders[0].order_number,buyer_username:'buyer',marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',sku_id:extra.sku_id,title:extra.title,quantity:extra.quantity};
 await db.query("select import_tiktok_orders($1,$2,'All orders.csv',now())",[JSON.stringify([row]),'d'.repeat(64)]);assert.ok((await db.query('select cancelled_at from tiktok_order_lines where id=$1',[extra.id])).rows[0].cancelled_at);await fresh();
 assert.equal((await completeLines([live.id])).rows[0].r.completed,1);assert.equal(await stock(),4);await fresh();assert.equal(orders[0].stage,'completed');
 const stopped=(await db.query('select * from tiktok_order_lines where id=$1',[extra.id])).rows[0];assert.ok(stopped.cancelled_at);assert.equal(stopped.fulfilled_at,null);
 assert.equal((await db.query('select consumed_quantity from tiktok_inventory_attachments where line_id=$1',[extra.id])).rows[0].consumed_quantity,0);
 await reversalSetup();await cancelLine(extra,orders[0],false,'Wrong item was selected');await fresh();assert.equal(orders[0].stage,'preparing');assert.ok(orders[0].reopened_at);assert.equal(await stock(),4);
 assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='line_cancellation_corrected'")).rows[0].n,1);
});
test('item cancellation rejects stale, unconfirmed, unauthorized and non-manager corrections',async()=>{
 const line=lineOf(orders[0]);await assert.rejects(cancelLine(line,orders[0],true,'Valid reason',false),/Confirm/);await assert.rejects(cancelLine(line,orders[0],true,'x'),/reason/);await assert.rejects(cancelLine(line,{...orders[0],revision:999}),/changed/);
 await cancelLine(line);await fresh();await assert.rejects(db.query("select update_tiktok_order($1,$2,'packed','',null,true)",[orders[0].id,orders[0].revision]),/cancelled/);await db.exec("update employees set role='employee'");await assert.rejects(cancelLine(line,orders[0],false,'Wrong item'),/managers/);
 await db.exec("set test.allowed='no'");await assert.rejects(cancelLine(line),/access required/);await db.exec("set test.allowed='yes';set role authenticated");await assert.rejects(db.query('update tiktok_order_lines set cancelled_at=null'),/permission denied/);await db.exec('reset role');
});
test('buyer cancellation is atomic, scoped to selected orders, and preserves their evidence',async()=>{
 const args=()=>[orders.map(o=>o.id),JSON.stringify(Object.fromEntries(orders.map(o=>[o.id,o.revision]))),'Buyer cancellation confirmed in TikTok',true];
 const stale=args();stale[1]=JSON.stringify({[orders[0].id]:orders[0].revision,[orders[1].id]:999});await assert.rejects(db.query('select record_tiktok_buyer_cancellations($1,$2,$3,$4)',stale),/changed/);assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='cancellation_confirmed'")).rows[0].n,0);
 await db.query('select record_tiktok_buyer_cancellations($1,$2,$3,$4)',[[orders[0].id],args()[1],args()[2],true]);await fresh();assert.equal(orders[0].marketplace_status,'Canceled');assert.equal(orders[1].marketplace_status,'To ship');
 assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='cancellation_confirmed'")).rows[0].n,1);
});

test('reimporting an old file recovers only its skipped cancellations, once, without refreshing existing orders',async()=>{
 const hash='e'.repeat(64);await db.query("insert into tiktok_order_imports(file_hash,filename,snapshot_at,imported_by,result) values($1,'All orders.csv',now()-interval '1 hour',$2,$3)",[hash,actor,JSON.stringify({added:0,refreshed:1,history_skipped:1})]);
 const rows=[{order_number:orders[0].order_number,buyer_username:'buyer',marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',sku_id:lineOf(orders[0]).sku_id,title:'Changed title must be ignored',quantity:5},{order_number:'577623648796643339',buyer_username:'buyer',marketplace_status:'Canceled',marketplace_substatus:'Canceled',sku_id:'1732765489814737199',title:'Cancelled ring',quantity:1}];
 const call=()=>db.query("select import_tiktok_orders($1,$2,'All orders.csv',now()) r",[JSON.stringify(rows),hash]);assert.equal((await call()).rows[0].r.cancelled_recovered,1);assert.equal((await call()).rows[0].r.already_imported,true);
 assert.equal((await db.query('select quantity from tiktok_order_lines where id=$1',[lineOf(orders[0]).id])).rows[0].quantity,1);assert.equal((await db.query('select count(*)::int n from tiktok_order_imports')).rows[0].n,1);assert.equal((await db.query("select count(*)::int n from tiktok_order_events where action='cancellation_imported'")).rows[0].n,1);
});
