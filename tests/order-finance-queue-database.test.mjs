import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const read=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const scalar=async sql=>(await db.query(sql)).rows[0].value;
const token='00000000-0000-4000-8000-000000000001';
const order='00000000-0000-4000-8000-000000000002';
const line='00000000-0000-4000-8000-000000000003';
const enqueue=()=>db.query("select enqueue_ebay_finance_jobs(array['order-one'])");
const claim=async()=> (await db.query('select claim_ebay_finance_jobs($1) as jobs',[token])).rows[0].jobs;
const finish=async(finance=null,error=null,key='order-one',lease=token)=> (await db.query(
 'select finish_ebay_finance_job($1,$2,$3,$4,$5) value',[key,lease,finance,JSON.stringify([{id:line,finance}]),error])).rows[0].value;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create function can_manage_inventory() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;
 create table ebay_orders(id uuid primary key,order_number text unique,buyer_username text,status text,raw_payload jsonb);
 create table ebay_order_lines(id uuid primary key,order_id uuid references ebay_orders,item_number text,sold_for numeric,line_status text,raw_payload jsonb);
 create table ebay_live_attempts(event_id text,listing_id text,buyer text);
 create table reconciliation_calls(event_id text);
 create function reconcile_ebay_live_orders_internal(text) returns void language sql set search_path=public as $$insert into reconciliation_calls values($1)$$;
 create schema net;create schema cron;create table public.dispatches(body jsonb,timeout integer);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql set search_path=public as $$
 insert into dispatches values(body,timeout_milliseconds);select 1::bigint$$;
 create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;`);
 await db.exec(await read('20261005121000_skip_live_reconciliation_for_fulfillment.sql'));
 await db.exec(await read('20261008150000_batch_live_order_sync_reconciliation.sql'));
 await db.exec(`create trigger ebay_live_order_payment_changed after insert or update of status,raw_payload on ebay_orders for each row execute function ebay_live_order_changed()`);
 await db.exec(await read('20261008160000_background_order_finance.sql'));
 await db.exec(await read('20261008161000_finance_worker_schedule.sql'));
});
beforeEach(async()=>{
 await db.exec(`reset role;set test.allowed='yes';truncate ebay_finance_jobs,ebay_order_lines,ebay_orders,ebay_live_attempts,reconciliation_calls,dispatches cascade;
 update ebay_finance_worker set dispatch_token='${token}',lease_until=now()+interval '2 minutes',claimed_at=null;
 insert into ebay_orders values('${order}','order-one','buyer','fulfilled','{"note":"keep","orderPaymentStatus":"PAID"}');
 insert into ebay_order_lines values('${line}','${order}','listing',50,'fulfilled','{"source":"ebay_fulfillment_api","orderPaymentStatus":"PAID"}');
 insert into ebay_live_attempts values('event','listing','buyer');`);
});
after(async()=>db?.close());

test('enqueue is durable and idempotent, ignores unknown orders, and does not reset in-flight work',async()=>{
 await enqueue();await enqueue();assert.equal(await scalar('select count(*)::int value from ebay_finance_jobs'),2);
 const jobs=await claim();assert.equal(jobs.length,2);assert.equal(await claim(),null,'a dispatch token cannot be replayed');
 await enqueue();assert.equal(await scalar("select count(*)::int value from ebay_finance_jobs where state='working' and attempts=1"),2);
 await db.query("select enqueue_ebay_finance_jobs(array['missing'],false)");assert.equal(await scalar('select count(*)::int value from ebay_finance_jobs'),2);
});

test('completion atomically merges finance without changing order status, notes, payment state or line identity',async()=>{
 await enqueue();await claim();
 const finance={status:'available',syncedAt:'2026-10-08T15:00:00Z'};
 assert.equal(await finish(finance),true);assert.equal(await finish(finance),false);
 assert.deepEqual((await db.query('select status,raw_payload from ebay_orders')).rows[0],{
  status:'fulfilled',raw_payload:{note:'keep',orderPaymentStatus:'PAID',ebayFinance:finance,last_ebay_finance_sync_at:await scalar("select raw_payload->>'last_ebay_finance_sync_at' value from ebay_orders")},
 });
 assert.equal(await scalar("select raw_payload->>'orderPaymentStatus' value from ebay_order_lines"),'PAID');
 assert.equal(await scalar('select count(*)::int value from reconciliation_calls'),0,'finance does not restart payment reconciliation');
 await db.exec(`update ebay_orders set raw_payload=raw_payload||'{"orderPaymentStatus":"FULLY_REFUNDED"}'`);
 assert.equal(await scalar('select count(*)::int value from reconciliation_calls'),1,'actual payment evidence still reconciles');
});

test('a normal order sync cannot overwrite newer payout data with a stale or missing copy',async()=>{
 await enqueue();await claim();await finish({status:'available',syncedAt:'2026-10-08T15:00:00Z'});
 await db.exec(`update ebay_orders set raw_payload='{"note":"new note","ebayFinance":{"status":"on_hold","syncedAt":"2026-10-08T14:00:00Z"}}';
 update ebay_order_lines set raw_payload='{"source":"ebay_fulfillment_api","orderPaymentStatus":"PAID"}';`);
 assert.equal(await scalar("select raw_payload#>>'{ebayFinance,status}' value from ebay_orders"),'available');
 assert.equal(await scalar("select raw_payload->>'note' value from ebay_orders"),'new note');
 assert.equal(await scalar("select raw_payload#>>'{ebayFinance,status}' value from ebay_order_lines"),'available');
});

test('errors preserve prior finance, back off, and stop after the retry limit; staff can retry failed jobs',async()=>{
 await enqueue();await claim();await finish({status:'on_hold',syncedAt:'2026-10-08T15:00:00Z'});
 await db.exec(`update ebay_finance_jobs set state='working',attempts=6,lease_token='${token}',lease_until=now()+interval '2 minutes' where job_key='order-one'`);
 await finish(null,'eBay finance authorization needs attention.');
 assert.equal(await scalar("select state value from ebay_finance_jobs where job_key='order-one'"),'failed');
 assert.equal(await scalar("select raw_payload#>>'{ebayFinance,status}' value from ebay_orders"),'on_hold');
 await db.exec('select retry_ebay_finance_sync()');
 assert.equal(await scalar("select state value from ebay_finance_jobs where job_key='order-one'"),'queued');
 assert.equal(await scalar("select attempts value from ebay_finance_jobs where job_key='order-one'"),0);
});

test('no transactions is explicit and does not fabricate a paid or failed payment status',async()=>{
 await enqueue();await claim();await finish();
 assert.equal(await scalar("select state value from ebay_finance_jobs where job_key='order-one'"),'no_data');
 assert.equal(await scalar("select raw_payload->>'orderPaymentStatus' value from ebay_orders"),'PAID');
 assert.equal(await scalar("select (get_ebay_finance_sync_status()->>'without_transactions')::int value"),1);
});

test('expired workers are recovered, stale completions are rejected, and claims stay bounded',async()=>{
 await enqueue();await claim();
 await db.exec(`update ebay_finance_jobs set lease_until=now()-interval '1 second';
 update ebay_finance_worker set claimed_at=null,lease_until=now()+interval '2 minutes';`);
 assert.equal(await finish({status:'paid_out'}),false);
 assert.equal((await claim()).length,2);assert.equal(await scalar('select max(attempts) value from ebay_finance_jobs'),2);
 await db.exec(`update ebay_finance_jobs set lease_until=now()-interval '1 second',attempts=6;
 update ebay_finance_worker set claimed_at=null;`);
 assert.equal((await claim()).length,0);assert.equal(await scalar("select count(*)::int value from ebay_finance_jobs where state='failed'"),2);
 await db.exec(`insert into ebay_orders select gen_random_uuid(),'order-'||n,'buyer','pending','{}' from generate_series(1,30)n;
 select enqueue_ebay_finance_jobs((select array_agg(order_number) from ebay_orders),false);
 update ebay_finance_worker set claimed_at=null;`);
 assert.equal((await claim()).length,12);
});

test('server scheduler dispatches only due work once with a short-lived batch token',async()=>{
 await db.exec('update ebay_finance_worker set lease_until=null,dispatch_token=null');
 await db.exec('select dispatch_ebay_finance_worker()');assert.equal(await scalar('select count(*)::int value from dispatches'),0);
 await enqueue();await db.exec('select dispatch_ebay_finance_worker();select dispatch_ebay_finance_worker()');
 assert.equal(await scalar('select count(*)::int value from dispatches'),1);
 assert.equal(await scalar('select timeout value from dispatches'),60000);
 assert.equal(await scalar("select body ? 'financeWorkerToken' value from dispatches"),true);
 assert.equal(await scalar('select claimed_at is null and lease_until>now() value from ebay_finance_worker'),true);
});

test('worker and queue are private; progress and retries enforce inventory permission',async()=>{
 for(const role of ['anon','authenticated']){
  for(const signature of ['claim_ebay_finance_jobs(uuid)','finish_ebay_finance_worker(uuid)','enqueue_ebay_finance_jobs(text[],boolean)','dispatch_ebay_finance_worker()'])
   assert.equal(await scalar(`select has_function_privilege('${role}','${signature}','execute') value`),false);
  assert.equal(await scalar(`select has_table_privilege('${role}','ebay_finance_worker','select') value`),false);
 }
 await db.exec("set test.allowed='no'");
 await assert.rejects(db.query('select get_ebay_finance_sync_status()'),/Inventory access required/);
 await assert.rejects(db.query('select retry_ebay_finance_sync()'),/Inventory access required/);
});
