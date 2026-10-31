import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;const actor='00000000-0000-4000-8000-000000000001';
const record=(id='1')=>({id,url:'https://www.whatnot.com/dashboard/orders/a',status:'pending_fulfillment',buyer_id:'9',username:'buyer',customer_name:'Name',currency:'USD',subtotal:12,shipping:3,tax:1,total:16,purchased_at:'2026-10-27T22:17:00Z',source_updated_at:'2026-10-27T22:17:00Z',lines:[{id:id+'01',order_id:id,title:'Silver earrings',quantity:2,unit_price:6,currency:'USD',shipment_id:'42',shipment_status:'label_generated',tracking_number:'9400111000000000001234',ship_by_date:'2026-10-29',holds:[]}]});
const run=async(sql,args=[]) => (await db.query(sql,args)).rows;
const save=async r=>run('select import_whatnot_order($1)',[JSON.stringify(r)]);
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;create table auth.users(id uuid primary key);insert into auth.users values('${actor}');create function auth.uid() returns uuid language sql stable as $$select '${actor}'::uuid$$;create function can_manage_inventory() returns boolean language sql stable as $$select coalesce(current_setting('test.allowed',true),'yes')<>'no'$$;create function is_admin() returns boolean language sql stable as $$select true$$;create table employees(user_id uuid,display_name text,email text);insert into employees values('${actor}','Tester','test@example.test');create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261031170000_whatnot_workspace.sql',import.meta.url),'utf8'));
 await db.exec(`alter table employees add column role text default 'admin';alter table employees add column active boolean default true;create schema net;create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$select 1::bigint$$;create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261031171000_whatnot_api_connection.sql',import.meta.url),'utf8'));
 await db.exec('create table tiktok_orders(id uuid primary key)');
 await db.exec(await readFile(new URL('../supabase/migrations/20261031230000_marketplace_pending_summaries.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261031234500_whatnot_queue_screenshots.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261101000500_whatnot_marketplace_status.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261101003000_whatnot_shipping_label_summary.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
test('all historical orders import; missing filters show only matching lines and counts',async()=>{
 await save(record());const r=record('2');r.lines[0].shipment_status='delivered';await save(r);
 let data=(await run("select whatnot_workspace('pending','','all',0) as data"))[0].data;assert.equal(data.visible_lines,1);assert.equal(data.counts.history,1);
 await run("select whatnot_work_action('missing',$1,'Location checked')",[JSON.stringify([{id:'101',revision:1}])]);
 data=(await run("select whatnot_workspace('pending','','missing',0) as data"))[0].data;assert.equal(data.groups[0].lines.length,1);assert.equal(data.filters.missing,1);
 const old=record();old.source_updated_at='2026-10-26T00:00:00Z';old.lines[0].title='Stale';await save(old);assert.equal((await run("select title,item_missing from whatnot_order_lines where id='101'"))[0].item_missing,true);
});
test('search supports partial tracking and literal buyer punctuation',async()=>{
 const data=(await run("select whatnot_workspace('all','00001234','all',0) as data"))[0].data;assert.equal(data.visible_lines,2);
 const none=(await run("select whatnot_workspace('all','%','all',0) as data"))[0].data;assert.equal(none.visible_lines,0);
});
test('completion guards exact selected items, photos, label tracking and stale revisions',async()=>{
 await save(record('3'));await save(record('4'));
 const lines=JSON.stringify([{id:'301',revision:1}]);
 await assert.rejects(run("select whatnot_work_action('complete',$1,null)",[lines]),/label/);
 for(const [kind,mime] of [['label','application/pdf'],['completion_photo','image/jpeg']]){
  const path=`${actor}/${kind}.test`;await run('insert into storage.objects values($1,$2,$3)',['whatnot-order-evidence',path,JSON.stringify({mimetype:mime})]);
  await run('select attach_whatnot_file($1,$2,$3,$4,$5)',[path,kind,kind,mime,lines]);
 }
 await run("select whatnot_work_action('complete',$1,'Physical contents checked')",[lines]);
 const states=await run("select id,work_state from whatnot_order_lines where id in('301','401') order by id");assert.deepEqual(states,[{id:'301',work_state:'completed'},{id:'401',work_state:'pending'}]);
 await assert.rejects(run("select whatnot_work_action('note',$1,'A stale edit')",[lines]),/changed/);
 const changed=record('3');changed.lines[0].tracking_number='new-tracking';await save(changed);assert.equal((await run("select work_state from whatnot_order_lines where id='301'"))[0].work_state,'pending');
 const rev=(await run("select revision from whatnot_order_lines where id='301'"))[0].revision;
 await assert.rejects(run("select whatnot_work_action('complete',$1,null)",[JSON.stringify([{id:'301',revision:rev}])]),/label/);
});
test('unpaid and cancellation holds stay out of ready queue and cannot complete',async()=>{
 const r=record('5');r.status='pending';await save(r);const held=record('6');held.lines[0].holds=['order_pending_cancellation'];await save(held);
 const data=(await run("select whatnot_workspace('review','','all',0) as data"))[0].data;assert.equal(data.visible_lines,2);
 await assert.rejects(run("select whatnot_work_action('complete',$1,null)",[JSON.stringify([{id:'501',revision:1}])]),/Resolve/);
});
test('staff cannot write source records or access credential-free RPCs without inventory permission',async()=>{
 await db.exec("set test.allowed='no'");await assert.rejects(run('select whatnot_workspace()'),/access/);await db.exec("set test.allowed='yes'");
 const grants=await run("select has_table_privilege('authenticated','whatnot_orders','UPDATE') as update,has_function_privilege('authenticated','import_whatnot_order(jsonb)','EXECUTE') as import");assert.equal(grants[0].update,false);assert.equal(grants[0].import,false);
});
test('connection pins the seller, hides encrypted credentials, and claims single-use leases',async()=>{
 await run('select install_whatnot_connection($1,$2,$3,$4,null)',['123','ogjewelers','v1.encrypted',actor]);
 await assert.rejects(run('select install_whatnot_connection($1,$2,$3,$4,null)',['456','ogjewelers','v1.other',actor]),/Different account/);
 const privileges=(await run("select has_table_privilege('authenticated','whatnot_api_connection','SELECT') as read,has_function_privilege('authenticated','claim_whatnot_worker(uuid)','EXECUTE') as claim"))[0];assert.equal(privileges.read,false);assert.equal(privileges.claim,false);
 await run('select dispatch_whatnot_worker()');const token=(await run('select dispatch_token from whatnot_api_connection'))[0].dispatch_token;
 assert.ok((await run('select claim_whatnot_worker($1) as c',[token]))[0].c);assert.equal((await run('select claim_whatnot_worker($1) as c',[token]))[0].c,null);
 await assert.rejects(run('select import_whatnot_worker_order($1,$2)',['00000000-0000-4000-8000-000000000099',JSON.stringify(record('7'))]),/expired/);
 await run('select import_whatnot_worker_order($1,$2)',[token,JSON.stringify(record('7'))]);assert.equal((await run("select count(*)::int as n from whatnot_orders where id='7'"))[0].n,1);
});

test('queue totals precede paging and charge each checkout once across its original lines',async()=>{
 const make=(n)=>{const r=record(String(n));r.buyer_id=r.id;r.username='facetBuyer'+n;return r;};
 const r=make(1000);r.lines.push({...r.lines[0],id:'100002',title:'Watch',quantity:1,unit_price:12});r.subtotal=24;r.total=28;await save(r);
 await run("select whatnot_work_action('watch_missing',$1,'Checked')",[JSON.stringify([{id:'100002',revision:1}])]);
 const summary=async(filter='all',search='facetBuyer',offset=0)=> (await run("select whatnot_queue_summary('pending',$1,$2,$3,'all',null,'due','all') as d",[search,filter,offset]))[0].d;
 let s=await summary('missing_watch');
 assert.equal(s.visible_lines,1);assert.equal(s.groups[0].lines[0].id,'100002');
 assert.deepEqual(s.facets.shown.amounts.USD,{lines:1,sales:12,shipping:1.5,fees:1.51,unknown_ship:0,unknown_fees:0});
 s=await summary();assert.equal(s.facets.shown.amounts.USD.fees,3.03);assert.equal(s.facets.shown.amounts.USD.shipping,3);
 await assert.rejects(run("select whatnot_work_action('complete',$1,null)",[JSON.stringify([{id:'100002',revision:2}])]),/Resolve/);
 await run("select whatnot_work_action('cancel_pending',$1,null)",[JSON.stringify([{id:'100001',revision:1}])]);assert.equal((await summary('cancel')).visible_lines,1);
 for(let n=1001;n<=1041;n++)await save(make(n));
 const first=await summary(),second=await summary('all','facetBuyer',40);
 assert.equal(first.groups.length,40);assert.equal(second.groups.length,2);assert.deepEqual(first.facets,second.facets);
 assert.equal(first.facets.shown.lines,43);assert.equal(first.facets.shown.amounts.USD.sales,516);
 const scanned=await summary('missing_watch',']C14200000009400111000000000001234');assert.equal(scanned.visible_lines,1);
 await db.exec("set test.allowed='no'");await assert.rejects(summary(),/access/);await db.exec("set test.allowed='yes'");
});

test('only item screenshots cover a line and original order totals survive filtering',async()=>{
 const order=record('4000');order.username='screenshotBuyer';
 order.lines.push({...order.lines[0],id:'400002',quantity:1});await save(order);
 for(const [i,kind,id] of [[1,'item_photo','400001'],[2,'item_photo','400001'],[3,'completion_photo','400002'],[4,'label','400002']]){
  await run("insert into whatnot_order_files(path,kind,name,mime,line_ids,snapshot,actor,actor_name) values($1,$2,'file',$3,array[$4::text],'[]',$5,'Staff')",
   ['photo-test-'+i,kind,kind==='label'?'application/pdf':'image/jpeg',id,actor]);
 }
 const fetch=async filter=>(await run("select whatnot_queue_summary('pending','screenshotBuyer',$1,0,'all',null,'due','all') as result",[filter]))[0].result;
 const all=await fetch('all'),remaining=await fetch('no_screenshot');
 assert.equal(all.facets['work:no_screenshot'].lines,1);
 assert.equal(all.groups[0].lines[0].screenshot_count,2);
 assert.equal(remaining.groups[0].lines.length,1);
 const line=remaining.groups[0].lines[0];
 assert.deepEqual([line.id,line.order_lines,line.line_number,line.order_units,line.order_missing_screenshots],['400002',2,2,3,1]);
 await run("update whatnot_order_files set line_ids=array['400001','400002'] where path='photo-test-1'");
 assert.equal((await fetch('no_screenshot')).visible_lines,0);
});

test('Whatnot status views preserve order identity and separate shipping, failures and completion review at Eastern midnight',async()=>{
 const boundary=(await run("select date_trunc('day',now() at time zone 'America/New_York') at time zone 'America/New_York' as t"))[0].t;
 const day=new Date(boundary).getTime(),before=new Date(day-1).toISOString(),after=new Date(day+1).toISOString();
 async function put(id,status,stamp,ship,holds=[]){
  const r=record(id);r.username='coverage88';r.source_updated_at=stamp;r.status=status;r.lines[0].shipment_status=ship;r.lines[0].holds=holds;await save(r);
 }
 const visible=async view=>(await run("select whatnot_queue_summary($1,'coverage88','all',0,'all',null,'due','all') as r",[view]))[0].r.groups.flatMap(g=>g.lines.map(l=>l.order_id)).sort();
 await put('8801','pending_fulfillment',before,'label_generated');await put('8802','pending_fulfillment',before,'in_transit');
 await put('8803','failed',before,'created');await put('8804','cancelled',before,'created');
 await put('8805','pending_fulfillment',before,'label_generated');await put('8805','completed',after,'delivered');
 await put('8806','completed',before,'delivered');await put('8807','completed',null,'delivered');
 await put('8808','pending_fulfillment',before,'created',['order_pending_cancellation']);
 assert.deepEqual(await visible('market_open'),['8801','8802','8808']);assert.deepEqual(await visible('unfulfilled'),['8801']);
 assert.deepEqual(await visible('market_failed'),['8803']);assert.deepEqual(await visible('market_cancelled'),['8804']);
 assert.deepEqual(await visible('pending'),['8801','8805','8807']);assert.deepEqual(await visible('closeout'),['8805','8807']);
 assert.deepEqual(await visible('history'),['8802','8804','8806']);
 await put('8805','completed',after,'delivered');assert.deepEqual(await visible('closeout'),['8805','8807']);
 await put('8801','completed',before,'delivered');assert.ok((await visible('history')).includes('8801'));
 await db.exec("update whatnot_order_lines set work_state='completed' where order_id='8805'");
 await put('8805','completed',after,'delivered');assert.deepEqual(await visible('closeout'),['8807']);
});

test('physical label completion checks the current exact number and requires a photo of that package',async()=>{
 const r=record('734501');const tracking='9300120762602631700001';
 r.lines[0].tracking_number=tracking;r.lines[0].last_mile_tracking='LM-12345670';await save(r);
 const unrelated=record('734502');unrelated.lines[0].title='Jewelry 63000001';await save(unrelated);
 const search=async scan=>(await run("select whatnot_queue_summary('all',$1,'all',0,'all',null,'due','all') as res",['!scan:'+scan]))[0].res.groups.flatMap(g=>g.lines.map(l=>l.order_id));
 assert.deepEqual(await search('42033131'+tracking),[r.id]);assert.deepEqual(await search('700001'),[r.id]);
 assert.deepEqual(await search('12345670'),[r.id]);assert.deepEqual(await search(unrelated.id),[]);
 const row={id:r.lines[0].id,revision:1,verified_tracking_number:tracking};
 const close=sel=>run("select whatnot_work_action('complete',$1,null)",[JSON.stringify([sel])]);
 await assert.rejects(close({...row,verified_tracking_number:'700001'}),/label/);
 await assert.rejects(close(row),/packing photo/);
 const attach=async(suffix,selection)=>{const path=actor+'/parcel-'+suffix+'.jpg';await run('insert into storage.objects values($1,$2,$3)',['whatnot-order-evidence',path,JSON.stringify({mimetype:'image/jpeg'})]);await run("select attach_whatnot_file($1,'completion_photo','parcel.jpg','image/jpeg',$2)",[path,JSON.stringify([selection])]);};
 await attach('first',row);r.lines[0].tracking_number=tracking+'2';await save(r);
 await assert.rejects(close(row),/changed/);
 const next={...row,revision:2,verified_tracking_number:r.lines[0].tracking_number};await assert.rejects(close(next),/packing photo/);
 await attach('second',next);await close(next);
 assert.equal((await run("select details->>'label_source' as src from whatnot_order_events where line_id=$1 and action='complete'",[row.id]))[0].src,'Whatnot tracking verified by staff');
 assert.equal((await run('select work_state from whatnot_order_lines where id=$1',[unrelated.lines[0].id]))[0].work_state,'pending');
});

test('Whatnot label summaries distinguish attached PDFs, platform issuance, and stale or missing coverage',async()=>{
 const o=record('63455');o.username='label-scope';o.lines=Array.from({length:5},(_,i)=>({...o.lines[0],id:'63455'+i}));o.lines[2].shipment_status='created';o.lines[4].replacement_shipment_id='other';await save(o);
 const [a,b,c,d,e]=o.lines;
 const file=async(path,ids,snap)=>run("insert into whatnot_order_files(path,kind,name,mime,line_ids,snapshot,actor,actor_name) values($1,'label','label.pdf','application/pdf',$2,$3,$4,'Staff')",[path,ids,JSON.stringify(snap),actor]);
 await file('group-label-1',[a.id,d.id],[{id:a.id,quantity:a.quantity,tracking_number:a.tracking_number},{id:d.id,quantity:d.quantity,tracking_number:'old-tracking'}]);
 await file('same-line-second-label',[a.id],[{id:a.id,quantity:a.quantity,tracking_number:a.tracking_number}]);
 await run("update whatnot_order_lines set item_missing=true where id=$1",[c.id]);
 const rows=await run('select id,label_state,order_label_pdfs,order_labels_issued_only,order_label_pdfs_to_check from whatnot_queue_lines where order_id=$1 order by id',[o.id]);
 assert.deepEqual(rows.map(l=>l.label_state),['attached','issued','missing','review','missing']);
 const filtered=(await run("select whatnot_queue_summary('pending','label-scope','missing',0,'all',null,'due','all') as s"))[0].s.groups[0].lines;
 assert.deepEqual(filtered.map(l=>[l.id,l.order_label_pdfs,l.order_labels_issued_only,l.order_label_pdfs_to_check]),[[c.id,2,1,1]]);
});
