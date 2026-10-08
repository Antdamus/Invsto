import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const code='9400100000000000000001';
const call=async(action,args={})=>(await db.query('select packaging_workspace($1,$2) r',[action,JSON.stringify(args)])).rows[0].r;
const write=(action,s,args={})=>call(action,{shipment_id:s?.id,revision:s?.revision,request_id:randomUUID(),...args});
const close=async(n=1)=>db.query("update ebay_order_lines set fulfilled_quantity=quantity,line_status='fulfilled',fulfilled_at=clock_timestamp(),fulfilled_by=auth.uid() where order_id=$1",[id(n)]);
const start=async(orders=[id(1)],tracking=code)=>write('start',null,{order_ids:orders,tracking});
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.allowed',true)='yes'$$;
 create table employees(id uuid default gen_random_uuid(),user_id uuid,email text,display_name text,role text,active boolean);
 create table ebay_orders(id uuid primary key,order_number text,buyer_username text,buyer_name text,status text,sale_date timestamptz,tracking_number text,label_metadata jsonb default '{}',label_file_path text,label_storage_bucket text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_title text,item_number text,custom_label text,quantity integer,fulfilled_quantity integer,line_status text,fulfilled_by uuid,fulfilled_at timestamptz,notes text);
 create table ebay_order_label_events(id uuid primary key default gen_random_uuid(),order_ids uuid[],action text,label_metadata jsonb,label_storage_bucket text,label_file_path text);
 create table live_sale_lots(id uuid primary key,lot_code text,auction_number text,matched_order_line_id uuid);
 create table live_bag_order_links(lot_id uuid,order_line_id uuid);
 create table live_sale_bag_photos(lot_id uuid,photo_path text,captured_at timestamptz);
 create table ebay_live_attempts(lot_id uuid,order_line_id uuid);
 create table shared_inventory_bag_links(lot_id uuid,order_line_id uuid);
 create table ebay_order_admin_events(id uuid default gen_random_uuid(),order_ids uuid[],order_line_ids uuid[],created_at timestamptz default now(),signed_by_email text,payload jsonb);
 create table ebay_order_tasks(order_line_ids uuid[] default '{}',id uuid primary key default gen_random_uuid(),order_id uuid,title text,question text,latest_note text,status text,task_type text,assigned_to_email text,metadata jsonb default '{}',created_at timestamptz default now(),resolved_at timestamptz,resolved_by uuid,resolved_by_email text,resolution_notes text,updated_at timestamptz);
 create table ebay_order_task_events(id uuid,order_id uuid,task_id uuid,notes text,photo_attachments jsonb,signed_by_email text,created_at timestamptz,payload jsonb,action text,old_status text,new_status text,signed_by uuid);
 create table storage.objects(bucket_id text,name text,metadata jsonb,primary key(bucket_id,name));
 create function create_task_request(_source text,_kind text,_details jsonb) returns jsonb language plpgsql set search_path=public as $$declare t ebay_order_tasks;begin
 if _source<>'history' then raise exception 'Must reuse the closed-order task workflow';end if;
 if not exists(select 1 from employees where user_id=(_details->>'_assigned_to_user_id')::uuid and active) then raise exception 'Choose an active owner';end if;
 insert into ebay_order_tasks(order_id,title,question,status,task_type,assigned_to_email,metadata) values((_details->>'_order_id')::uuid,'Packaging issue',_details->>'_question','assigned','coordination','worker@example.test',jsonb_build_object('request_kind',_kind)) returning * into t;return to_jsonb(t);end$$;
 insert into employees(user_id,email,display_name,role,active) values('${id(100)}','admin@example.test','Jose','admin',true),('${id(101)}','worker@example.test','Sandra','employee',true);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261008020000_packaging_workspace.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261008220000_packaging_reference_photos.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261008230000_packaging_buyer_queue.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{
 await db.exec(`set test.allowed='yes';set test.actor='${id(100)}';truncate ebay_order_admin_events,ebay_live_attempts,shared_inventory_bag_links,live_sale_bag_photos,live_sale_lots,live_bag_order_links,packaging_events,packaging_issues,packaging_evidence,packaging_items,packaging_shipments,packaging_handoffs,ebay_order_task_events,ebay_order_tasks,ebay_order_label_events,ebay_order_lines,ebay_orders,storage.objects cascade;update packaging_settings set enabled=true,activated_at=now();`);
 for(const n of [1,2]){await db.query("insert into ebay_orders(id,order_number,buyer_username,status,sale_date,tracking_number) values($1,$2,$3,'pending',now(),$4)",[id(n),`order-${n}`,`buyer${n}`,n===1?code:'9400100000000000000002']);await db.query("insert into ebay_order_lines(id,order_id,item_title,quantity,fulfilled_quantity,line_status) values($1,$2,'Gold chain',2,0,'pending')",[id(n+10),id(n)]);}
});
after(()=>db?.close());
test('activation cutoff, real local closure and provider updates never backfill historical orders',async()=>{
 await db.exec('update packaging_settings set enabled=false');await close();assert.equal((await call('queue')).total,0);
 await db.exec('update packaging_settings set enabled=true');await db.exec("update ebay_orders set tracking_number='9400100000000000000009',status='fulfilled' where order_number='order-1'");assert.equal((await call('queue')).total,0);
 await db.exec("set test.actor=''");await db.exec("update ebay_order_lines set line_status='fulfilled',fulfilled_quantity=quantity where order_id='"+id(2)+"'");await db.exec(`set test.actor='${id(100)}'`);assert.equal((await call('queue')).total,0);
});
test('local partial completion waits for every order line; retries enqueue exactly once',async()=>{
 await db.query("insert into ebay_order_lines(id,order_id,item_title,quantity,fulfilled_quantity,line_status) values($1,$2,'Ring',1,0,'pending')",[id(15),id(1)]);
 await db.query("update ebay_order_lines set line_status='fulfilled',fulfilled_quantity=quantity,fulfilled_at=clock_timestamp(),fulfilled_by=auth.uid() where id=$1",[id(11)]);assert.equal((await call('queue')).total,0);
 await close();await close();assert.equal((await call('queue')).total,1);assert.equal((await db.query('select count(*)::int n from packaging_handoffs')).rows[0].n,1);
});
test('tracking normalizes scanner prefixes and routed USPS codes; current multi-page and extra labels match',async()=>{
 await close();let r=await call('scan',{tracking:']C142033101'+code});assert.equal(r.tracking,code);assert.equal(r.matches[0].orders[0].order_number,'order-1');
 await db.query("update ebay_orders set tracking_number=null,label_metadata=$1,label_file_path='current.pdf',label_storage_bucket='ebay-labels' where id=$2",[JSON.stringify({pages:[{trackingNumbers:[code]}]}),id(1)]);
 assert.equal((await call('scan',{tracking:code})).matches.length,1);
 await db.query("insert into ebay_order_label_events(order_ids,action,label_metadata,label_file_path,label_storage_bucket) values($1,'attached',$2,'obsolete.pdf','ebay-labels')",[[id(2)],JSON.stringify({trackingNumber:code})]);assert.equal((await call('scan',{tracking:code})).matches.length,1);
});
test('scan ambiguity requires a specific candidate, combined label is all-or-nothing, rescan is idempotent',async()=>{
 await close();await db.query('update ebay_orders set tracking_number=$1 where id=$2',[code,id(2)]);assert.equal((await call('scan',{tracking:code})).matches.length,2);
 await assert.rejects(start([id(1),id(2)]),/Review and confirm/);let d=await start();const again=await start();assert.equal(again.shipment.id,d.shipment.id);
 assert.equal((await call('scan',{tracking:code})).shipment_id,d.shipment.id);assert.equal((await db.query('select count(*)::int n from packaging_shipments')).rows[0].n,1);
});
test('external label needs explicit order confirmation and all selected orders ready',async()=>{
 await close();await assert.rejects(start([id(1)],'9400100000000000000099'),/Review and confirm/);
 await assert.rejects(write('start',null,{tracking:'9400100000000000000099',order_ids:[id(1),id(2)],confirm_link:true,note:'External label'}),/still open/);
 const d=await write('start',null,{tracking:'9400100000000000000099',order_ids:[id(1)],confirm_link:true,note:'Label purchased outside eBay'});assert.equal(d.shipment.order_ids[0],id(1));
});
test('item quantities are confirmed once across split boxes; invalid saves roll back',async()=>{
 await close();let a=await start();a=await write('contents',a.shipment,{items:[{line_id:id(11),quantity:1}]});
 let b=await write('start',null,{tracking:'9400100000000000000099',order_ids:[id(1)],confirm_link:true,note:'Second box'});
 await assert.rejects(write('contents',b.shipment,{items:[{line_id:id(11),quantity:2}]}),/already in another/);
 await assert.rejects(write('contents',b.shipment,{items:[{line_id:id(12),quantity:1}]}),/not available/);
 b=await write('contents',b.shipment,{items:[{line_id:id(11),quantity:1}]});assert.equal(b.lines[0].other_quantity,1);assert.equal((await call('queue')).total,0);
 await assert.rejects(write('contents',b.shipment,{items:[{line_id:id(11),quantity:1},{line_id:id(11),quantity:1}]}));assert.equal((await call('detail',{shipment_id:b.shipment.id})).lines[0].packed_quantity,1);
});
test('exclusive claim, expired claim, stale revision and retry identity protect concurrent workers',async()=>{
 await close();let d=await start();const req={shipment_id:d.shipment.id,revision:d.shipment.revision,request_id:randomUUID(),note:'Keep certificate with chain'};
 let first=await call('note',req);let second=await call('note',req);assert.equal(first.shipment.revision,second.shipment.revision);
 await assert.rejects(call('note',{...req,note:'Changed request'}),/already used/);
 await assert.rejects(write('note',d.shipment,{note:'Stale'}),/package changed/);
 await db.exec(`set test.actor='${id(101)}'`);await assert.rejects(write('claim',first.shipment),/Another employee/);await assert.rejects(write('note',first.shipment,{note:'No claim'}),/Claim this package/);
 await db.exec("update packaging_shipments set claimed_until=now()-interval '1 minute'");d=await write('claim',first.shipment);assert.equal(d.shipment.claimed_by,id(101));
 await assert.rejects(write('reopen',d.shipment,{note:'Not admin'}),/administrator/);
});
async function proof(d,type='image/jpeg'){
 const path=`packaging/${d.shipment.id}/${id(100)}/${randomUUID()}.jpg`;
 await db.query('insert into storage.objects values($1,$2,$3)',['team-task-evidence',path,JSON.stringify({mimetype:type,size:1024})]);return write('evidence',d.shipment,{path,label:'Packing proof'});
}
test('packing requires real scoped photo, confirmed contents; video alone is insufficient',async()=>{
 await close();let d=await start();await assert.rejects(write('pack',d.shipment),/contents first/);
 d=await write('contents',d.shipment,{items:[{line_id:id(11),quantity:2}]});await assert.rejects(write('pack',d.shipment),/packaging photo/);
 await assert.rejects(write('evidence',d.shipment,{path:'arbitrary-file.jpg'}),/for this package/);
 d=await proof(d,'video/mp4');await assert.rejects(write('pack',d.shipment),/packaging photo/);d=await proof(d);d=await write('pack',d.shipment);
 assert.equal(d.shipment.status,'ready');assert.equal((await call('queue',{view:'sending'})).total,1);
 assert.equal((await db.query('select fulfilled_quantity n from ebay_order_lines where id=$1',[id(11)])).rows[0].n,2);
 await assert.rejects(write('note',d.shipment,{note:'Frozen'}),/no longer editable/);
});
test('issue creates an assigned task, blocks until accepted, and requires explicit resume',async()=>{
 await close();let d=await start();d=await write('issue',d.shipment,{order_id:id(1),owner:id(101),kind:'work',note:'Replace defective clasp',blocking:true});assert.equal(d.shipment.status,'on_hold');assert.equal(d.issues.length,1);
 await assert.rejects(write('resume',d.shipment,{note:'Checked'}),/Resolve and accept/);
 await db.exec("update ebay_order_tasks set status='completed_by_employee'");await assert.rejects(write('resume',d.shipment,{note:'Checked'}),/Resolve and accept/);
 await db.exec("update ebay_order_tasks set status='cancelled'");await assert.rejects(write('resume',d.shipment,{note:'Checked'}),/Resolve and accept/);
 await db.exec("update ebay_order_tasks set status='resolved'");d=await write('resume',d.shipment,{note:'Replacement checked'});assert.equal(d.shipment.status,'in_progress');
});
test('sending today is separate from dispatch, overnight carryover requires review, reopen changes no inventory',async()=>{
 await close();let d=await start();d=await write('contents',d.shipment,{items:[{line_id:id(11),quantity:2}]});d=await proof(d);d=await write('pack',d.shipment);
 await db.exec("update packaging_shipments set dispatch_date=current_date-2");await assert.rejects(write('dispatch',d.shipment),/carried over/);
 d=await write('sending_today',d.shipment);d=await write('dispatch',d.shipment);assert.equal(d.shipment.status,'dispatched');assert.equal((await call('queue',{view:'history'})).total,1);
 const before=(await db.query('select * from ebay_order_lines')).rows;d=await write('reopen',d.shipment,{note:'Carrier returned unopened package'});assert.equal(d.shipment.status,'in_progress');assert.deepEqual((await db.query('select * from ebay_order_lines')).rows,before);
});
test('reopened pending order holds a packed package and older task completion cannot bypass packaging',async()=>{
 await close();let d=await start();d=await write('contents',d.shipment,{items:[{line_id:id(11),quantity:2}]});d=await proof(d);d=await write('pack',d.shipment);
 await db.query("insert into ebay_order_tasks(order_id,title,task_type,status) values($1,'Ship order','pending_packaging','in_progress')",[id(1)]);
 await assert.rejects(db.exec("update ebay_order_tasks set status='shipped_completed'"),/Complete packing and dispatch/);
 await db.exec("update ebay_order_lines set line_status='pending' where item_title='Gold chain'");d=await call('detail',{shipment_id:d.shipment.id});assert.equal(d.shipment.status,'on_hold');await assert.rejects(write('dispatch',d.shipment),/before dispatch/);
});
test('anonymous/inactive access and direct table writes are denied',async()=>{
 await db.exec("set test.allowed='no'");await assert.rejects(call('queue'),/staff access/);await db.exec("set test.allowed='yes';set test.actor=''");await assert.rejects(call('queue'),/staff access/);
 assert.equal((await db.query("select has_function_privilege('anon','packaging_workspace(text,jsonb)','execute') a,has_table_privilege('authenticated','packaging_shipments','insert') b")).rows[0].a,false);
 assert.equal((await db.query("select has_table_privilege('authenticated','packaging_shipments','insert') b")).rows[0].b,false);
});
test('legacy shipping assignments close only when all split packages dispatch, with an audit',async()=>{
 await db.query("insert into ebay_order_tasks(order_id,title,task_type,status) values($1,'Ship all items','pending_shipping','in_progress')",[id(1)]);
 await close();assert.equal((await db.query('select metadata from ebay_order_tasks')).rows[0].metadata.packaging_order_handoff,true);
 let a=await start();a=await write('contents',a.shipment,{items:[{line_id:id(11),quantity:1}]});a=await proof(a);a=await write('pack',a.shipment);a=await write('dispatch',a.shipment);
 assert.equal((await db.query('select status from ebay_order_tasks')).rows[0].status,'in_progress');
 let b=await write('start',null,{tracking:'9400100000000000000099',order_ids:[id(1)],confirm_link:true,note:'Second box'});b=await write('contents',b.shipment,{items:[{line_id:id(11),quantity:1}]});b=await proof(b);b=await write('pack',b.shipment);b=await write('dispatch',b.shipment);
 assert.equal((await db.query('select status from ebay_order_tasks')).rows[0].status,'shipped_completed');assert.equal((await db.query("select count(*)::int n from ebay_order_task_events where payload->>'source'='packaging_dispatch'")).rows[0].n,1);
});
test('combined label brings all linked orders and only their bag photos, without copying reference proof',async()=>{
 await close(1);await close(2);await db.query("update ebay_orders set tracking_number=null,label_storage_bucket='ebay-labels',label_file_path='combined.pdf',label_metadata=$1",[JSON.stringify({trackingNumbers:[code]})]);
 await db.query("insert into live_sale_lots values($1,'LIVE-049','049',$2),($3,'LIVE-099','099',$4)",[id(500),id(11),id(501),id(99)]);
 await db.query('insert into live_sale_bag_photos values($1,$2,now()),($3,$4,now())',[id(500),'our-bag.jpg',id(501),'other-buyer.jpg']);
 const scan=await call('scan',{tracking:code});assert.equal(scan.matches.length,1);assert.equal(scan.matches[0].order_ids.length,2);
 let d=await start([id(1),id(2)]);assert.equal(d.orders.length,2);assert.equal(d.lines.length,2);assert.equal(d.bag_photos.length,1);assert.equal(d.bag_photos[0].path,'our-bag.jpg');assert.equal(d.evidence.length,0);
 await db.exec('truncate live_sale_bag_photos,live_sale_lots');
});

test('all saved photo evidence survives a long notes history and hidden receipt tasks keep their exact line scope',async()=>{
 await close();
 await db.query("insert into ebay_order_tasks(id,order_id,order_line_ids,title,metadata) values($1,$2,$3,'Receipt',$4)",[id(301),id(1),[id(11)],JSON.stringify({hidden_from_task_board:true})]);
 await db.query("insert into ebay_order_task_events(id,task_id,order_id,created_at,payload,photo_attachments) values($1,$2,$3,now()-interval '1 year','{}',$4)",[id(401),id(301),id(1),JSON.stringify([{bucket:'order-evidence-photos',path:'receipt.jpg',label:'Video receipt'}])]);
 await db.query("insert into ebay_order_task_events(id,order_id,created_at,notes) select gen_random_uuid(),$1,now(),'Recent note' from generate_series(1,205)",[id(1)]);
 const d=await call('detail',{order_ids:[id(1)]});assert.equal(d.order_events.length,200);assert.equal(d.reference_events.length,1);assert.deepEqual(d.reference_events[0].task_line_ids,[id(11)]);assert.equal(d.tasks.length,0);
});
test('removed completion photos never resurface from legacy closeout snapshots; unrelated orders remain excluded',async()=>{
 const old={bucket:'order-evidence-photos',path:'completion-photos/old.jpg'},current={...old,path:'completion-photos/new.jpg'};
 await db.query('insert into ebay_order_admin_events(order_ids,order_line_ids,payload) values($1,$2,$3)',[[id(1)],[id(11)],JSON.stringify({evidence_photos:[old]})]);
 await db.query('insert into ebay_order_task_events(id,order_id,created_at,payload,photo_attachments) values($1,$2,now(),$3,$4)',[id(401),id(1),JSON.stringify({proof_type:'completion_photo',order_line_ids:[id(11)],completion_photo_changes:[{bucket:old.bucket,path:old.path}]}),JSON.stringify([current])]);
 await db.query('insert into ebay_order_task_events(id,order_id,created_at,payload,photo_attachments) values($1,$2,now(),$3,$4)',[id(402),id(1),JSON.stringify({history_removed:true}),JSON.stringify([{...old,path:'removed.jpg'}])]);
 await db.query('insert into ebay_order_admin_events(order_ids,order_line_ids,payload) values($1,$2,$3)',[[id(2)],[id(12)],JSON.stringify({evidence_photos:[{...old,path:'other-customer.jpg'}]})]);
 const d=await call('detail',{order_ids:[id(1)]});assert.equal(d.completion_events.length,0);assert.equal(d.reference_events.length,1);assert.equal(d.reference_events[0].photo_attachments[0].path,current.path);
});
test('bag photos follow confirmed captured and shared inventory links, without matching bags by number',async()=>{
 await db.query("insert into live_sale_lots values($1,'LIVE-049','049',null),($2,'LIVE-049-OTHER','049',null)",[id(500),id(501)]);
 await db.query('insert into ebay_live_attempts values($1,$2)',[id(500),id(11)]);
 await db.query('insert into shared_inventory_bag_links values($1,$2)',[id(500),id(11)]);
 await db.query('insert into live_sale_bag_photos values($1,$2,now()),($3,$4,now())',[id(500),'correct.jpg',id(501),'wrong.jpg']);
 const d=await call('detail',{order_ids:[id(1)]});assert.equal(d.bag_photos.length,1);assert.deepEqual(d.bag_photos[0].order_line_ids,[id(11)]);assert.deepEqual(d.bag_photos[0].order_ids,[id(1)]);
});

test('buyer queue groups normalized usernames before search and opens all ready order lines',async()=>{
 await db.exec("update ebay_orders set buyer_username=case when order_number='order-1' then ' BuyerOne ' else 'buyerone' end");
 await close(1);await close(2);
 const q=await call('queue');assert.equal(q.total,1);assert.equal(q.order_total,2);assert.equal(q.counts.to_package,1);assert.equal(q.rows[0].item_count,4);assert.deepEqual(q.rows[0].order_ids,[id(1),id(2)]);
 const search=await call('queue',{search:'order-2'});assert.equal(search.total,1);assert.equal(search.rows[0].order_ids.length,2);
 const tracking=await call('queue',{search:code});assert.equal(tracking.rows[0].order_ids.length,2);
 const d=await call('buyer',{buyer_order_id:id(2)});assert.equal(d.orders.length,2);assert.equal(d.lines.length,2);
 await db.query("update ebay_order_lines set line_status='pending',fulfilled_quantity=0 where order_id=$1",[id(2)]);
 assert.deepEqual((await call('queue')).rows[0].order_ids,[id(1)]);
 assert.equal((await call('buyer',{buyer_order_id:id(2)})).orders.length,1);
 await db.query("update ebay_orders set tracking_number=null,label_metadata=$1 where id=$2",[JSON.stringify({pages:[{trackingNumbers:[code]}]}),id(1)]);
 assert.equal((await call('queue',{search:']C142033101'+code})).total,1);
});

test('missing usernames and similar display names never merge unrelated customers',async()=>{
 await db.exec("update ebay_orders set buyer_username=null,buyer_name='Same name'");await close(1);await close(2);
 assert.equal((await call('queue')).total,2);assert.equal((await call('buyer',{buyer_order_id:id(1)})).orders.length,1);
 await db.exec("update ebay_orders set buyer_username=case when order_number='order-1' then 'rahulp601' else 'rahulp602' end");
 assert.equal((await call('queue')).total,2);
 for(const fn of ['packaging_buyer_key(text,uuid)','packaging_ready_orders()','packaging_buyer_orders(uuid)'])assert.equal((await db.query("select has_function_privilege('authenticated',$1,'execute') ok",[fn])).rows[0].ok,false);
 await db.exec("set test.allowed='no'");await assert.rejects(call('buyer',{buyer_order_id:id(1)}),/staff access/);
});

test('buyer groups span pagination and more than fifty orders without dropping any order',async()=>{
 await db.exec(`insert into ebay_orders(id,order_number,buyer_username,status,sale_date) select gen_random_uuid(),'extra-'||n,case when n<=60 then 'wholesale' else 'separate-'||n end,'pending',now() from generate_series(1,101) n;
 insert into ebay_order_lines(id,order_id,item_title,quantity,fulfilled_quantity,line_status) select gen_random_uuid(),id,'Ring',1,0,'pending' from ebay_orders where order_number like 'extra-%';
 update ebay_order_lines set line_status='fulfilled',fulfilled_quantity=quantity,fulfilled_at=now(),fulfilled_by=auth.uid() where item_title='Ring';`);
 const q=await call('queue');assert.equal(q.total,42);assert.equal(q.rows.length,40);
 const q2=await call('queue',{offset:40});assert.equal(q2.rows.length,2);
 const all=[...q.rows,...q2.rows];assert.equal(new Set(all.map(r=>r.buyer_key)).size,42);
 const group=all.find(r=>r.title==='wholesale');assert.equal(group.order_ids.length,60);
 assert.equal((await call('queue',{search:'extra-60'})).rows[0].order_ids.length,60);
 assert.equal((await call('buyer',{buyer_order_id:group.order_id})).orders.length,60);
});

test('same buyer and tracking resolve one shipment even with separate PDF copies',async()=>{
 await db.query("update ebay_orders set buyer_username='onebuyer',tracking_number=$1,label_storage_bucket='ebay-labels',label_file_path=order_number||'.pdf'",[code]);await close(1);await close(2);
 const scan=await call('scan',{tracking:code});assert.equal(scan.matches.length,1);assert.deepEqual(scan.matches[0].order_ids,[id(1),id(2)]);
 const d=await start(scan.matches[0].order_ids);assert.equal(d.orders.length,2);assert.equal((await call('queue')).total,0);
 assert.equal((await start(scan.matches[0].order_ids)).shipment.id,d.shipment.id);
});

test('combine buyer requires recipient confirmation and creates one audited package without changing stock',async()=>{
 await db.exec("update ebay_orders set buyer_username='onebuyer'");await close(1);await close(2);
 const scan=await call('scan',{tracking:code});assert.deepEqual(scan.matches[0].order_ids,[id(1)]);assert.deepEqual(scan.matches[0].buyer_order_ids,[id(1),id(2)]);
 const args={tracking:code,order_ids:[id(1),id(2)],combine_buyer:true,note:'Same recipient, one label'};
 await assert.rejects(write('start',null,args),/Confirm that all buyer/);
 const d=await write('start',null,{...args,confirm_buyer:true});assert.equal(d.orders.length,2);assert.equal(d.lines.length,2);assert.equal((await call('queue')).total,0);
 assert.equal((await db.query('select sum(fulfilled_quantity)::int n from ebay_order_lines')).rows[0].n,4);
 assert.equal((await db.query("select (payload->'request'->>'combine_buyer')::boolean ok from packaging_events where action='start'")).rows[0].ok,true);
});

test('combine buyer rejects mixed buyers, stale group and orders already being packed',async()=>{
 await close(1);await close(2);const args={tracking:code,order_ids:[id(1),id(2)],combine_buyer:true,confirm_buyer:true};
 await assert.rejects(write('start',null,args),/same eBay username/);
 await db.exec("update ebay_orders set buyer_username='onebuyer'");
 await assert.rejects(write('start',null,{...args,order_ids:[id(1)]}),/buyer group changed/);
 await start([id(2)],'9400100000000000000002');
 await assert.rejects(write('start',null,args),/already being packed/);
 assert.equal((await db.query('select count(*)::int n from packaging_shipments')).rows[0].n,1);
});
