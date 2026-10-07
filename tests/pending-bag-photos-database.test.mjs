import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after,beforeEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=async name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const review=async(scan='LIVE-A',line=id(11))=>(await db.query('select get_pending_bag_photo_review($1,$2) r',[scan,line])).rows[0].r;
const confirm=async({scan='LIVE-A',lot=id(100),line=id(11),photos=[id(200),id(201)]}={})=>(await db.query('select confirm_pending_bag_photos($1,$2,$3,$4) r',[scan,lot,line,photos])).rows[0].r;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create schema realtime;
 create table auth.users(id uuid primary key,email text);insert into auth.users values('${id(1)}','staff@example.test');
 create function auth.uid() returns uuid language sql stable as $$select '${id(1)}'::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.allowed',true)='yes'$$;
 create function realtime.send(jsonb,text,text,boolean) returns void language sql as $$select$$;
 create table ebay_orders(id uuid primary key,order_number text,buyer_username text,buyer_name text,status text,sale_date timestamptz,paid_on_date timestamptz,ship_by_date timestamptz,total_price numeric);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,item_title text,custom_label text,quantity int,fulfilled_quantity int,line_status text,sold_for numeric,total_price numeric,created_at timestamptz);
 create table live_sale_lots(id uuid primary key,lot_code text,auction_number text,matched_order_line_id uuid,status text);
 create table live_bag_order_links(lot_id uuid,order_line_id uuid);
 create table ebay_live_attempts(lot_id uuid,order_line_id uuid,listing_id text,buyer text,listing_title text,amount numeric);
 create table live_sale_bag_photos(id uuid primary key,lot_id uuid,photo_path text,captured_at timestamptz,created_at timestamptz default now(),created_by uuid);
 create table ebay_order_tasks(id uuid primary key default gen_random_uuid(),order_id uuid,order_line_ids uuid[],task_type text,title text,question text,status text,priority text,latest_note text,latest_photo_count int,resolved_at timestamptz,resolved_by uuid,resolved_by_email text,resolution_notes text,created_by uuid,created_by_email text,metadata jsonb,created_at timestamptz default now(),updated_at timestamptz);
 create table ebay_order_task_events(id uuid primary key default gen_random_uuid(),task_id uuid,order_id uuid,action text,old_status text,new_status text,notes text,photo_attachments jsonb,signed_by uuid,signed_by_email text,payload jsonb,created_at timestamptz default now());`);
 const search=await sql('20261004031000_pending_item_search.sql');await db.exec(search.slice(0,search.indexOf('create or replace function public.list_pending_ebay_order_queue_v2')));
 const notes=await sql('20260626123000_pending_order_line_notes_and_receipt_counts.sql');await db.exec(notes.slice(0,notes.indexOf('drop function if exists public.list_pending_ebay_order_queue')));
 await db.exec(await sql('20261007002000_pending_bag_scan.sql'));
 await db.exec(await sql('20261008003000_pending_bag_photo_confirmation.sql'));
});
beforeEach(async()=>{
 await db.exec("set test.allowed='yes';truncate ebay_orders,ebay_order_lines,live_sale_lots,live_bag_order_links,ebay_live_attempts,live_sale_bag_photos,ebay_order_tasks,ebay_order_task_events,pending_order_item_search,pending_order_item_search_events;");
 for(const n of [1,2]){
  await db.query("insert into ebay_orders values($1,$2,$3,$3,'fulfilled',now(),now(),now(),100)",[id(n),`order-${n}`,`buyer${n}`]);
  await db.query("insert into ebay_order_lines values($1,$2,$3,'#005 - Gold chain','',1,0,'pending',100,100,now())",[id(n+10),id(n),`listing-${n}`]);
  await db.query("insert into live_sale_lots values($1,$2,'EB-005',null,'open')",[id(99+n),n===1?'LIVE-A':'LIVE-B']);
  await db.query("insert into ebay_live_attempts values($1,null,$2,$3,'#005 - Gold chain',100)",[id(99+n),`listing-${n}`,`buyer${n}`]);
 }
 for(const n of [200,201,202])await db.query('insert into live_sale_bag_photos(id,lot_id,photo_path,captured_at,created_by) values($1,$2,$3,now(),$4)',[id(n),id(n===202?101:100),`live-bags/${n}.jpg`,id(1)]);
});
after(async()=>db?.close());
test('exact scans and reused bag numbers resolve only the selected buyer’s photos, without writes',async()=>{
 const a=await review();assert.equal(a.bag.id,id(100));assert.equal(a.photos.length,2);assert.ok(a.photos.every(p=>!p.attached));
 const b=await review('005',id(12));assert.equal(b.bag.id,id(101));assert.deepEqual(b.photos.map(p=>p.id),[id(202)]);
 await assert.rejects(review('LIVE-A',id(12)),/no longer matches/);
 assert.equal((await db.query('select count(*)::int n from ebay_order_task_events')).rows[0].n,0);
});
test('confirmation appends real evidence, marks found atomically, retries once, and never closes an order or bag',async()=>{
 await db.query('select add_pending_order_line_note($1,$2,$3,$4)',[id(11),'Existing instructions',JSON.stringify([{bucket:'evidence',path:'existing.jpg'}]),'staff@example.test']);
 const result=await confirm();assert.equal(result.attached_count,2);assert.equal(result.item_search.is_missing,false);
 assert.equal(result.task.metadata.hidden_from_task_board,true);assert.equal(result.event.photo_attachments[0].metadata.source,'live_bag_video_receipt');
 assert.equal(result.event.payload.bag_lot_id,id(100));assert.equal(result.event.photo_attachments[0].bucket,'photos');
 const retry=await confirm();assert.equal(retry.attached_count,0);assert.equal(retry.event,null);
 assert.equal((await db.query('select count(*)::int n from ebay_order_task_events')).rows[0].n,2);
 assert.equal((await db.query('select count(*)::int n from pending_order_item_search_events')).rows[0].n,1);
 assert.equal((await db.query('select latest_photo_count n from ebay_order_tasks')).rows[0].n,3);
 assert.ok((await review()).photos.every(p=>p.attached));
 assert.ok((await db.query('select line_status,fulfilled_quantity from ebay_order_lines')).rows.every(l=>l.line_status==='pending'&&l.fulfilled_quantity===0));
 assert.ok((await db.query('select status from ebay_orders')).rows.every(o=>o.status==='fulfilled'));
 assert.ok((await db.query('select status from live_sale_lots')).rows.every(b=>b.status==='open'));
});
test('new captures are not silently attached and selected photo identities are checked',async()=>{
 await confirm({photos:[id(200)]});let r=await review();assert.equal(r.photos.filter(p=>p.attached).length,1);
 await assert.rejects(confirm({photos:[id(202)]}),/does not belong/);
 await assert.rejects(confirm({photos:[]}),/Review between/);
 await assert.rejects(confirm({photos:[null]}),/does not belong/);
 const r2=await confirm({photos:[id(201),id(201)]});assert.equal(r2.attached_count,1);
});
test('closed lines, stale bag links, inactive bags and unauthorized users cannot attach',async()=>{
 await db.exec("set test.allowed='no'");await assert.rejects(review(),/access required/);await assert.rejects(confirm(),/access required/);
 await db.exec("set test.allowed='yes'");
 await db.query('insert into live_bag_order_links values($1,$2)',[id(100),id(12)]);await assert.rejects(confirm(),/no longer matches/);
 await db.exec('truncate live_bag_order_links');await db.query("update live_sale_lots set status='cancelled' where id=$1",[id(100)]);await assert.rejects(confirm(),/match changed/);
 await db.exec("update live_sale_lots set status='open'");await db.query("update ebay_order_lines set line_status='fulfilled',fulfilled_quantity=1 where id=$1",[id(11)]);await assert.rejects(confirm(),/no longer pending/);
 assert.equal((await db.query('select count(*)::int n from ebay_order_task_events')).rows[0].n,0);
 assert.equal((await db.query("select has_function_privilege('anon','confirm_pending_bag_photos(text,uuid,uuid,uuid[])','execute') allowed")).rows[0].allowed,false);
});
test('multiple possible bags demand a unique code; linked photos cannot be copied onto another order',async()=>{
 await db.query("update ebay_live_attempts set buyer='buyer1',listing_id='listing-1' where lot_id=$1",[id(101)]);
 const ambiguous=await review('005');assert.equal(ambiguous.ambiguous,true);assert.equal(ambiguous.bag,null);
 await assert.rejects(confirm({scan:'005'}),/match changed/);
 await confirm();
 await db.query('insert into live_bag_order_links values($1,$2)',[id(100),id(12)]);
 assert.ok((await review('LIVE-A',id(12))).photos.every(p=>p.attached_elsewhere));
 await assert.rejects(confirm({line:id(12)}),/another order/);
 // Detaching incorrect evidence permits an explicit, audited correction without deleting the source photo.
 await db.exec("update ebay_order_task_events set photo_attachments='[]'");
 assert.equal((await confirm({line:id(12)})).attached_count,2);
});
test('failure while marking found rolls back the attached evidence too',async()=>{
 await db.exec(`create function test_fail_search() returns trigger language plpgsql as $$begin raise exception 'Simulated failure';end$$;
 create trigger fail_search before insert on pending_order_item_search for each row execute function test_fail_search();`);
 try {await assert.rejects(confirm(),/Simulated failure/);
  assert.equal((await db.query('select count(*)::int n from ebay_order_task_events')).rows[0].n,0);
  assert.equal((await db.query('select count(*)::int n from ebay_order_tasks')).rows[0].n,0);
 }finally{await db.exec('drop trigger fail_search on pending_order_item_search;drop function test_fail_search();');}
});
