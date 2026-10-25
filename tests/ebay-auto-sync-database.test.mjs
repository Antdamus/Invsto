import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const admin='00000000-0000-4000-8000-000000000001',manual='00000000-0000-4000-8000-000000000002',run='00000000-0000-4000-8000-000000000003';
async function setup(){
 const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create schema auth;create schema net;create schema cron;
 create function auth.uid() returns uuid language sql as $$select '${admin}'::uuid$$;
 create function can_manage_inventory() returns boolean language sql as $$select current_setting('test.staff',true)='yes'$$;
 set test.staff='yes';create table employees(user_id uuid,role text,active boolean);insert into employees values('${admin}','admin',true);
 create table cron.job(jobname text,schedule text,command text);
 create function cron.schedule(name text,schedule text,command text) returns bigint language sql as $$insert into cron.job values(name,schedule,command) returning 1::bigint$$;
 create table requests(body jsonb);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql as $$insert into public.requests values(body) returning 1::bigint$$;
 create table ebay_order_sync_runs(id uuid primary key,status text,dry_run boolean default false);
 create table ebay_orders(id uuid primary key,status text default 'pending');
 create table ebay_order_lines(id uuid primary key default gen_random_uuid(),order_id uuid references ebay_orders,item_number text,transaction_id text,item_title text,custom_label text,quantity int,sold_for numeric,shipping_and_handling numeric,total_price numeric,net_payout numeric,line_status text default 'pending',internal_item_id uuid,raw_payload jsonb default '{}',fulfilled_quantity int default 0,notes text,unique(order_id,item_number,transaction_id));`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261025230000_ebay_automatic_order_sync.sql',import.meta.url),'utf8'));return db;
}
const one=async(db,sql,args=[])=>(await db.query(sql,args)).rows[0];
test('scheduled/manual imports share a single-use lease; successful runs wait five minutes',async()=>{
 const db=await setup();try{
  await db.exec('select dispatch_ebay_order_sync()');assert.equal((await one(db,'select count(*)::int n from requests')).n,0);
  await db.exec("select control_ebay_order_auto_sync('resume')");
  const token=(await one(db,'select dispatch_token from ebay_order_auto_sync')).dispatch_token;
  assert.equal((await one(db,'select claim_ebay_order_sync($1,true) ok',[token])).ok,true);
  assert.equal((await one(db,'select claim_ebay_order_sync($1,true) ok',[token])).ok,false);
  assert.equal((await one(db,'select claim_ebay_order_sync($1,false) ok',[manual])).ok,false);
  await db.query("insert into ebay_order_sync_runs(id,status,automatic) values($1,'completed',true)",[run]);
  assert.equal((await one(db,'select finish_ebay_order_sync($1,$2,null) ok',[token,run])).ok,true);
  let state=await one(db,'select *,extract(epoch from next_sync_at-last_synced_at)::int seconds from ebay_order_auto_sync');
  assert.equal(state.seconds,300);assert.ok(state.last_synced_at);assert.equal(state.last_error,null);
  await db.exec('select dispatch_ebay_order_sync()');assert.equal((await one(db,'select count(*)::int n from requests')).n,1);
  assert.equal((await one(db,'select claim_ebay_order_sync($1,false) ok',[manual])).ok,true);
  await db.exec("update ebay_order_auto_sync set next_sync_at=now();select dispatch_ebay_order_sync()");assert.equal((await one(db,'select count(*)::int n from requests')).n,1);
  assert.equal((await one(db,'select finish_ebay_order_sync($1,$2,null) ok',[token,run])).ok,false,'old worker cannot release a newer lease');
  await db.query('select finish_ebay_order_sync($1,null,null)',[manual]);
 }finally{await db.close();}
});
test('failures retry, expired leases recover, pause stops dispatch, and staff cannot access lease secrets',async()=>{
 const db=await setup();try{
  await db.exec("select control_ebay_order_auto_sync('resume')");let token=(await one(db,'select dispatch_token from ebay_order_auto_sync')).dispatch_token;
  await db.query('select claim_ebay_order_sync($1,true)',[token]);await db.query("select finish_ebay_order_sync($1,null,'API unavailable')",[token]);
  assert.equal((await one(db,'select last_synced_at,last_error from ebay_order_auto_sync')).last_error,'API unavailable');
  await db.exec("update ebay_order_auto_sync set next_sync_at=now();select dispatch_ebay_order_sync()");token=(await one(db,'select dispatch_token from ebay_order_auto_sync')).dispatch_token;
  await db.query('select claim_ebay_order_sync($1,true)',[token]);await db.exec("update ebay_order_auto_sync set lease_until=now()-interval '1 second';select dispatch_ebay_order_sync()");
  assert.notEqual((await one(db,'select dispatch_token from ebay_order_auto_sync')).dispatch_token,token);
  await db.exec("select control_ebay_order_auto_sync('pause')");const pending=(await one(db,'select dispatch_token from ebay_order_auto_sync')).dispatch_token;
  assert.equal((await one(db,'select claim_ebay_order_sync($1,true) ok',[pending])).ok,false);
  await db.exec('set role authenticated');const status=(await one(db,'select get_ebay_order_auto_sync_status() s')).s;
  assert.equal(status.enabled,false);assert.equal(status.dispatch_token,undefined);
  await assert.rejects(db.query('select * from ebay_order_auto_sync'),/permission denied/);
  await assert.rejects(db.query('select claim_ebay_order_sync($1,false)',[manual]),/permission denied/);
  await db.exec("reset role;update employees set role='employee';set role authenticated");
  await assert.rejects(db.query("select control_ebay_order_auto_sync('resume')"),/Administrator/);
  await db.exec("set test.staff='no'");await assert.rejects(db.query('select get_ebay_order_auto_sync_status()'),/staff access/);
 }finally{await db.close();}
});
test('repeated API imports preserve packing work, stock links, partial completion and closed lines',async()=>{
 const db=await setup();try{
  await db.query('insert into ebay_orders(id) values($1)',[admin]);
  const row={order_id:admin,item_number:'item',transaction_id:'transaction',item_title:'Ring',quantity:2,raw_payload:{source:'ebay_fulfillment_api',line:{title:'Ring'}}};
  const save=()=>db.query('select id from upsert_ebay_order_sync_lines($1)',[JSON.stringify([row])]);
  await save();await db.query("update ebay_order_lines set line_status='partially_fulfilled',fulfilled_quantity=1,notes='Packed first item',internal_item_id=$1,net_payout=12,raw_payload=raw_payload||'{\"staff_note\":\"keep\"}'",[manual]);
  await save();await save();let line=await one(db,'select * from ebay_order_lines');
  assert.equal(line.line_status,'partially_fulfilled');assert.equal(line.fulfilled_quantity,1);assert.equal(line.internal_item_id,manual);assert.equal(line.notes,'Packed first item');assert.equal(line.raw_payload.staff_note,'keep');assert.equal(Number(line.net_payout),12);
  await db.exec("update ebay_order_lines set line_status='fulfilled'");assert.equal((await save()).rows.length,0);
  assert.equal((await one(db,'select count(*)::int n from ebay_order_lines')).n,1);
  await db.exec("update ebay_orders set status='archived'");row.transaction_id='new';assert.equal((await save()).rows.length,0);
  await db.exec('set role authenticated');await assert.rejects(save(),/permission denied/);
 }finally{await db.close();}
});
