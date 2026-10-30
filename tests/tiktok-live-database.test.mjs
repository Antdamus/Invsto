import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db,session;
const event='tiktok-7702243594937125663';
const stream={url:'https://shop.tiktok.com/streamer/live/product/dashboard?event=1&session_id=13104336646&tool_tab=auction',title:'Synthetic test show',started_at:null};
const start=()=>db.query('select to_jsonb(start_tiktok_live_capture($1,$2,$3)) s',[event,id(2),stream]);
const sale=(extra={})=>({key:'16|test_buyer|201.00',sku:'16',buyer:'test_buyer',buyer_name:'Test buyer',title:'#16 - Jewelry',amount:201,currency:'USD',payment_state:'paid',payment_label:'Payment complete',observed_at:new Date(Date.now()-10000).toISOString(),sold_at:new Date(Date.now()-60000).toISOString(),...extra});
const ingest=events=>db.query('select ingest_tiktok_live_events($1,$2,$3) v',[event,events,{ready:true,history_read:true}]);
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key,email text);insert into auth.users values('${id(1)}','test@example.invalid');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.allowed',true)='yes'$$;
 create table employees(id uuid primary key,active boolean);insert into employees values('${id(2)}',true);
 create table live_sale_sessions(id uuid primary key default gen_random_uuid(),title text,started_at timestamptz default now(),status text default 'active',workflow_mode text default 'manual' constraint live_sale_sessions_workflow_mode_check check(workflow_mode in ('manual','ebay_live')));
 create table live_sale_lots(id uuid primary key default gen_random_uuid(),session_id uuid,auction_number text,lot_code text default ('LIVE-'||replace(gen_random_uuid()::text,'-','')),status text default 'open',owner_employee_id uuid);
 create function start_live_sale_session(text,uuid,text,text,uuid,uuid[]) returns live_sale_sessions language sql as $$insert into public.live_sale_sessions(title) values($1) returning *$$;
 create function create_live_sale_lot(uuid,text,text,text,uuid) returns live_sale_lots language sql as $$insert into public.live_sale_lots(session_id,auction_number,owner_employee_id) values($1,$2,$5) returning *$$;
 create table ebay_live_attempts(id uuid primary key);
 create table live_sale_bag_photos(id uuid primary key,lot_id uuid,attempt_id uuid not null references ebay_live_attempts(id),photo_path text unique,width int,height int,captured_at timestamptz,created_at timestamptz default now(),created_by uuid);
 create table storage.objects(bucket_id text,name text,metadata jsonb);
 create table print_stations(id uuid primary key,name text);insert into print_stations values('${id(3)}','Test printer');
 create table label_print_jobs(id uuid primary key default gen_random_uuid(),request_id uuid,station_id uuid,barcode text,status text default 'queued',created_at timestamptz default now(),updated_at timestamptz default now(),printer_roll text,copies int,submitted_copies int default 0,lease_until timestamptz,detail text);
 create function enqueue_label_print(uuid,uuid,text,int,text,text,uuid,text) returns jsonb language sql as $$insert into public.label_print_jobs(station_id,request_id,barcode,copies,printer_roll) values($1,$2,$6,$4,$8) returning to_jsonb(label_print_jobs.*)$$;
 grant usage on schema auth to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261030020000_tiktok_live_capture.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
beforeEach(async()=>{await db.exec(`reset role;truncate tiktok_live_audit,tiktok_live_attempts,tiktok_live_connections,live_sale_bag_photos,label_print_jobs,storage.objects,live_sale_lots,live_sale_sessions cascade;select set_config('test.actor','${id(1)}',false);select set_config('test.allowed','yes',false);set role authenticated;`);session=(await start()).rows[0].s;});
test('show start and replayed sales are idempotent; TikTok never creates eBay attempts',async()=>{
 assert.equal((await start()).rows[0].s.id,session.id);await ingest([sale()]);await ingest([sale()]);
 const d=(await db.query('select get_tiktok_live_dashboard($1) d',[session.id])).rows[0].d;
 assert.equal(d.session.workflow_mode,'tiktok_live');assert.equal(d.attempts.length,1);assert.ok(d.attempts[0].lot_id);assert.match(d.attempts[0].lot_code,/^LIVE-/);assert.equal(d.connection.health.history_read,true);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from ebay_live_attempts')).rows[0].n,0);assert.equal((await db.query('select count(*)::int n from live_sale_lots')).rows[0].n,1);
});
test('payment updates preserve the same bag and reject stale evidence',async()=>{
 const a=sale({payment_state:'failed',payment_label:'Payment failed'});await ingest([a]);
 const read=async()=>(await db.query('select get_tiktok_live_dashboard($1) d',[session.id])).rows[0].d.attempts[0];const first=await read();
 await ingest([{...a,payment_state:'paid',payment_label:'Payment complete',observed_at:new Date().toISOString()}]);assert.equal((await read()).payment_state,'paid');assert.equal((await read()).lot_id,first.lot_id);
 await ingest([a]);assert.equal((await read()).payment_state,'paid');
 await assert.rejects(ingest([{...a,buyer:'someone_else'}]),/identity changed/);
});
test('failed-payment bags can be photographed, exact retry is safe, cross-bag photo requests fail',async()=>{
 await ingest([sale({payment_state:'failed',payment_label:'Payment failed'})]);const a=(await db.query('select get_tiktok_live_dashboard($1) d',[session.id])).rows[0].d.attempts[0],path=`live-bags/${a.lot_id}/${id(1)}/${id(4)}.jpg`;
 const args=[a.id,id(4),path,720,1280,new Date().toISOString()];
 const attach=()=>db.query('select to_jsonb(attach_tiktok_live_bag_photo($1,$2,$3,$4,$5,$6)) p',args);
 await assert.rejects(attach(),/upload not complete/);await db.exec('reset role');await db.query('insert into storage.objects values($1,$2,$3)',['photos',path,{mimetype:'image/jpeg',size:1000}]);await db.exec('set role authenticated');await attach();await attach();
 const d=(await db.query('select get_tiktok_live_dashboard($1) d',[session.id])).rows[0].d;assert.equal(d.photos.length,1);assert.equal(d.attempts[0].payment_state,'failed');args[3]=800;await assert.rejects(attach(),/different capture/);
});
test('automatic sends across users retain one queue job and receipts reflect printer acknowledgement',async()=>{
 await ingest([sale()]);const a=(await db.query('select get_tiktok_live_dashboard($1) d',[session.id])).rows[0].d.attempts[0];
 const send=()=>db.query('select enqueue_tiktok_live_auto_label($1,$2,$3,$4) j',[a.id,id(3),`<Label>${a.lot_code}</Label>`,'Left']);
 const first=(await send()).rows[0].j;await db.exec(`select set_config('test.actor','${id(5)}',false)`);assert.equal((await send()).rows[0].j.id,first.id);
 await db.exec('reset role');assert.equal((await db.query('select count(*)::int n from label_print_jobs')).rows[0].n,1);await db.exec("update label_print_jobs set status='submitted',submitted_copies=1;set role authenticated");
 const receipts=(await db.query('select get_tiktok_live_bag_print_status($1) r',[event])).rows[0].r;assert.equal(receipts[0].status,'submitted');assert.equal(receipts[0].attempt_id,a.id);
 await assert.rejects(db.query('select enqueue_tiktok_live_auto_label($1,$2,$3,$4)',[a.id,id(3),'<Label>wrong</Label>','Left']),/does not identify/);
});
test('invalid evidence, closed shows, direct writes, anonymous and nonstaff access are denied',async()=>{
 for(const extra of [{currency:'EUR'},{payment_state:'shipped'},{amount:-1},{buyer:''},{sku:'bad sku'}])await assert.rejects(ingest([sale(extra)]),/Invalid/);
 await assert.rejects(db.query("insert into tiktok_live_attempts default values"),/permission denied/);
 await db.exec("select set_config('test.allowed','no',false)");await assert.rejects(ingest([sale()]),/Inventory access/);await assert.rejects(start(),/Inventory access/);
 await db.exec("reset role;select set_config('test.allowed','yes',false);update live_sale_sessions set status='ended';set role authenticated");await assert.rejects(ingest([sale()]),/already closed/);await assert.rejects(start(),/already closed/);
 await db.exec('reset role;set role anon');await assert.rejects(start(),/permission denied/);
});
