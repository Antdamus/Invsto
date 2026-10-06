import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const attempt='00000000-0000-4000-8000-000000000001',station='00000000-0000-4000-8000-000000000002';
const xml='<DesktopLabel><DataString>LIVE-TEST</DataString></DesktopLabel>';
const send=async()=> (await db.query('select public.enqueue_ebay_live_auto_label($1,$2,$3,$4) as job',[attempt,station,xml,'Left'])).rows[0].job;
before(async()=>{
 db=new PGlite();await db.exec(`
 create role anon; create role authenticated; create schema auth;
 create function auth.uid() returns uuid language sql as $$select current_setting('test.actor')::uuid$$;
 create function public.can_manage_inventory() returns boolean language sql as $$select current_setting('test.allowed')='yes'$$;
 set test.allowed='yes';set test.actor='00000000-0000-4000-8000-000000000010';
 create table public.ebay_live_attempts(id uuid primary key,payment_state text,resolved_at timestamptz,merged_into uuid,lot_id uuid,listing_title text,hold boolean,buyer text);
 create function public.ebay_live_has_payment_hold(a public.ebay_live_attempts) returns boolean language sql as $$select coalesce(a.hold,false)$$;
 create table public.live_sale_lots(id uuid primary key,status text,lot_code text);
 create table public.print_stations(id uuid primary key,name text,active boolean,paired_at timestamptz,printer_model text,printer_name text,default_roll text);
 create table public.label_print_jobs(id uuid primary key default gen_random_uuid(),station_id uuid,requested_by uuid,request_id uuid,label_xml text,copies integer,title text,barcode text,printer_name text,retry_of uuid,printer_roll text,status text default 'queued',created_at timestamptz default now(),unique(requested_by,request_id));
 insert into live_sale_lots values('${attempt}','open','LIVE-TEST');
 insert into ebay_live_attempts values('${attempt}','paid',null,null,'${attempt}','#001 Jewelry',false,'winner');
 insert into print_stations values('${station}','Show printer',true,now(),'Twin Turbo','DYMO Twin Turbo','Left');
 alter table ebay_live_attempts add column event_id text default 'EVENT123';
 alter table label_print_jobs add column submitted_copies integer default 0,add column updated_at timestamptz default now(),add column lease_until timestamptz,add column detail text;
 `);
 const source=await readFile(new URL('../supabase/migrations/20260927200000_print_station_roll_selection.sql',import.meta.url),'utf8');
 await db.exec(source.slice(source.indexOf('create or replace function public.enqueue_label_print'),source.indexOf('create or replace function public.poll_print_station')));
 await db.exec(await readFile(new URL('../supabase/migrations/20261006120000_ebay_live_auto_labels.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261006160000_ebay_live_bag_print_status.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>db.exec("truncate label_print_jobs;set test.allowed='yes';set test.actor='00000000-0000-4000-8000-000000000010'"));
test('a manually printed bag is not printed again by an automatic send',async()=>{
 await send();
 await db.exec("update label_print_jobs set request_id=gen_random_uuid(),status='submitted'");
 const first=(await db.query('select id from label_print_jobs')).rows[0].id;assert.equal((await send()).id,first);
 assert.equal((await db.query('select count(*)::int as count from label_print_jobs')).rows[0].count,1);
});
test('automatic printing rejects unpaid, held, resolved and mismatched bags and unauthorized callers',async()=>{
 for(const change of ["payment_state='waiting'","hold=true","resolved_at=now()","merged_into=gen_random_uuid()","buyer=''"]){
  await db.exec('update ebay_live_attempts set '+change);await assert.rejects(send,/Payment is not confirmed/);await db.exec("update ebay_live_attempts set payment_state='paid',hold=false,resolved_at=null,merged_into=null,buyer='winner'");
 }
 await assert.rejects(db.query('select enqueue_ebay_live_auto_label($1,$2,$3,$4)',[attempt,station,'<DesktopLabel>WRONG</DesktopLabel>','Left']),/does not identify/);
 await db.exec("set test.allowed='no'");await assert.rejects(send,/Inventory access required/);await db.exec("set test.allowed='yes'");
 assert.equal((await db.query("select has_function_privilege('anon','public.enqueue_ebay_live_auto_label(uuid,uuid,text,text)','execute') allowed")).rows[0].allowed,false);
});
test('bag receipts include old manual jobs, track the latest reprint, and stay scoped to the show without queue mutations',async()=>{
 await send();
 const receipts=async event=>(await db.query('select get_ebay_live_bag_print_status($1) as receipts',[event])).rows[0].receipts;
 await db.exec("update label_print_jobs set created_at=now()-interval '2 days',status='submitted',submitted_copies=1");
 await db.exec(`insert into label_print_jobs(station_id,requested_by,request_id,barcode,status) select '${station}',auth.uid(),gen_random_uuid(),'OTHER-'||n,'submitted' from generate_series(1,120) n`);
 let rows=await receipts('EVENT123');assert.equal(rows.length,1);assert.equal(rows[0].attempt_id,attempt);assert.equal(rows[0].status,'submitted');assert.equal(rows[0].station_name,'Show printer');assert.equal(rows[0].submitted_copies,1);
 assert.equal('label_xml' in rows[0],false);assert.equal('requested_by' in rows[0],false);
 assert.deepEqual(await receipts('OTHER123'),[]);
 const job=(await db.query(`insert into label_print_jobs(station_id,requested_by,request_id,barcode,status) values('${station}',auth.uid(),gen_random_uuid(),'LIVE-TEST','queued') returning id`)).rows[0];
 rows=await receipts('EVENT123');assert.equal(rows.length,1);assert.equal(rows[0].job_id,job.id);assert.equal(rows[0].status,'queued');
 await db.query("update label_print_jobs set status='claimed',lease_until=now()-interval '1 second' where id=$1",[job.id]);
 rows=await receipts('EVENT123');assert.equal(rows[0].status,'uncertain');assert.match(rows[0].detail,/Check the printer/);
 assert.equal((await db.query('select status from label_print_jobs where id=$1',[job.id])).rows[0].status,'claimed','receipt reads do not mutate the queue');
 assert.equal((await db.query('select count(*)::int n from label_print_jobs')).rows[0].n,122);
 await db.exec("set test.allowed='no'");await assert.rejects(receipts('EVENT123'),/Inventory access required/);await db.exec("set test.allowed='yes'");
 assert.equal((await db.query("select has_function_privilege('anon','public.get_ebay_live_bag_print_status(text)','execute') allowed")).rows[0].allowed,false);
 await assert.rejects(receipts('bad!'),/Invalid eBay show/);
});
after(async()=>db?.close());
test('automatic sends across staff reuse one existing queue job and preserve its original destination',async()=>{
 const first=await send();await db.exec("set test.actor='00000000-0000-4000-8000-000000000011'");const again=await send();
 assert.equal(first.id,again.id);assert.equal(again.station_name,'Show printer');
 assert.equal((await db.query('select count(*)::int as count from label_print_jobs')).rows[0].count,1);
 const job=(await db.query('select * from label_print_jobs')).rows[0];assert.equal(job.request_id,attempt);assert.equal(job.copies,1);assert.equal(job.printer_roll,'Left');assert.equal(job.label_xml,xml);
});
