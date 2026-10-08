import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test, before, after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

let db;
const migration=name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const scalar=async sql=>(await db.query(sql)).rows[0].value;
const calls=()=>scalar('select count(*)::int as value from reconciliation_calls');
const importLines=(start=1,end=500)=>db.exec(`
 insert into ebay_order_lines(order_id,item_number,raw_payload)
 select id,order_number,'{"orderPaymentStatus":"PAID"}' from ebay_orders
 where order_number::int between ${start} and ${end}
 on conflict(order_id,item_number) do update set raw_payload=excluded.raw_payload||'{"refreshed":true}';`);

before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;
 create table ebay_orders(id uuid primary key default gen_random_uuid(),order_number text,buyer_username text,status text default 'pending',raw_payload jsonb default '{}');
 create table ebay_order_lines(id uuid primary key default gen_random_uuid(),order_id uuid references ebay_orders,
  item_number text,sold_for numeric default 50,line_status text default 'pending',raw_payload jsonb default '{}',
  fulfilled_quantity int default 0,internal_item_id uuid,unique(order_id,item_number));
 create table ebay_live_attempts(event_id text,listing_id text,buyer text);
 create table reconciliation_calls(event_id text,visible_lines int);
 create table reservation_checks(line_id uuid primary key);
 create function reconcile_ebay_live_orders_internal(_event_id text) returns void language plpgsql set search_path=public as $$begin
  if current_setting('test.fail',true)='yes' then raise exception 'fixture reconciliation failed';end if;
  insert into reconciliation_calls select _event_id,count(*) from ebay_order_lines l
   join ebay_live_attempts a on a.listing_id=l.item_number where a.event_id=_event_id;
 end$$;
 -- Model the existing row-level reservation's nested line update. It must
 -- still run on every row without restarting payment reconciliation.
 create function reserve_fixture() returns trigger language plpgsql as $$begin
  if pg_trigger_depth()>1 then return new;end if;
  insert into reservation_checks values(new.id) on conflict do nothing;
  update ebay_order_lines set internal_item_id=new.id where id=new.id;
  return new;
 end$$;
 create trigger ebay_order_lines_auto_reserve_stock after insert or update of internal_item_id,line_status
  on ebay_order_lines for each row execute function reserve_fixture();
 insert into ebay_orders(order_number,buyer_username) select n::text,'buyer' from generate_series(1,750)n;
 insert into ebay_live_attempts select 'event-'||(order_number::int%3),order_number,'buyer' from ebay_orders;`);
 await db.exec(await migration('20261005121000_skip_live_reconciliation_for_fulfillment.sql'));
 await db.exec(`create trigger ebay_live_order_line_changed after insert or update of line_status,raw_payload,sold_for
  on ebay_order_lines for each row execute function ebay_live_order_changed();
  create trigger ebay_live_order_payment_changed after insert or update of status,raw_payload
  on ebay_orders for each row execute function ebay_live_order_changed();`);
 const clock=await migration('20261004160000_ebay_live_history_reconciliation.sql');
 await db.exec(clock.slice(clock.indexOf('create or replace function public.ebay_live_activity_time'),clock.indexOf('-- Fulfillment'))
  .replace('public.ebay_live_activity_time','public.original_activity_time'));
});
after(async()=>db?.close());

test('500-line sync replaces 500 full-event reconciliations with three and retains all reservations',async()=>{
 await db.exec('begin');await importLines();assert.equal(await calls(),500);await db.exec('rollback');
 await db.exec(await migration('20261008150000_batch_live_order_sync_reconciliation.sql'));
 await importLines();assert.equal(await calls(),3);
 assert.equal(await scalar('select count(*)::int as value from reservation_checks'),500);
 assert.equal(await scalar('select count(*)::int as value from ebay_order_lines where internal_item_id=id'),500);
 assert.equal(await scalar('select sum(visible_lines)::int as value from reconciliation_calls'),500,'each reconciliation sees the complete batch');
});

test('mixed insert/update upsert processes both transition sets and sees all final rows',async()=>{
 await db.exec('begin;truncate reconciliation_calls;');
 await importLines(251,750);assert.equal(await calls(),6,'once per event per INSERT/UPDATE transition set');
 assert.equal(await scalar('select count(*)::int as value from ebay_order_lines'),750);
 assert.equal(await scalar('select min(visible_lines)::int as value from reconciliation_calls'),250);
 assert.equal(await scalar('select count(*)::int as value from reservation_checks'),750);
 await db.exec('rollback');
});

test('fulfillment, reservation updates, identical payloads and empty statements do not recheck payment',async()=>{
 await db.exec('begin;truncate reconciliation_calls;');
 await db.exec(`update ebay_order_lines set line_status='fulfilled',fulfilled_quantity=1;
  update ebay_order_lines set raw_payload=raw_payload,sold_for=sold_for;
  update ebay_order_lines set raw_payload='{"orderPaymentStatus":"PAID"}' where false;
  insert into ebay_order_lines(order_id,item_number) select id,'empty' from ebay_orders where false;`);
 assert.equal(await calls(),0);await db.exec('rollback');
});

test('changed payment, refund, cancellation, reopening and price still reconcile every affected show',async()=>{
 await db.exec('begin;truncate reconciliation_calls;');
 for(const change of [
  `raw_payload='{"orderPaymentStatus":"FULLY_REFUNDED"}'`,
  `raw_payload='{"orderPaymentStatus":"PAID"}'`,
  `line_status='cancelled'`,`line_status='pending'`,`sold_for=51`,
 ]){
  const previous=await calls();await db.exec('update ebay_order_lines set '+change);
  assert.equal(await calls(),previous+3,change);
 }
 const previous=await calls();
 await db.exec(`update ebay_orders set raw_payload='{"orderPaymentStatus":"PAID"}' where order_number='1'`);
 assert.equal(await calls(),previous+1,'individual official order evidence retains its immediate hook');
 await db.exec('rollback');
});

test('failed reconciliation rolls back all imported rows and reservations together',async()=>{
 await db.exec("set test.fail='yes';");
 await assert.rejects(importLines(501,750),/fixture reconciliation failed/);
 await db.exec("set test.fail='no';");
 assert.equal(await scalar('select count(*)::int as value from ebay_order_lines'),500);
 assert.equal(await scalar('select count(*)::int as value from reservation_checks'),500);
});

test('clock fast paths preserve dated, midnight and ambiguous DST behavior, and reject invalid evidence',async()=>{
 for(const [start,zone,clock] of [
  ['2026-10-07T14:00:00Z','America/New_York','10:25 AM'],
  ['2026-10-07T23:00:00Z','America/New_York','Oct 08, 12:15 AM'],
  ['2026-10-07T14:00:00Z','UTC','Oct 07, 2:25 PM'],
  ['2026-11-01T04:00:00Z','America/New_York','1:30 AM'],
  ['2026-03-08T05:00:00Z','America/New_York','2:30 AM'],
  ['2026-10-07T14:00:00Z','Europe/London','3:25 PM'],
  ['2026-10-07T14:00:00Z','Invalid/Zone','10:25 AM'],
  ['2026-10-07T14:00:00Z',null,'10:25 AM'],
  ['2026-10-07T14:00:00Z','America/New_York','unknown'],
  ['2026-10-07T14:00:00Z','America/New_York',null],
  ['2026-10-07T14:00:00Z','America/New_York',''],
  [null,'America/New_York','10:25 AM'],
 ]){
  const {rows:[row]}=await db.query('select original_activity_time($1,$2,$3) expected,ebay_live_activity_time($1,$2,$3) actual',[start,zone,clock]);
  assert.deepEqual(row.actual,row.expected,JSON.stringify([start,zone,clock]));
 }
 assert.equal(await scalar("select ebay_live_activity_time('2026-11-01T04:00:00Z','America/New_York','1:30 AM') as value"),null);
});

test('reconciliation hooks remain inaccessible as direct public RPCs',async()=>{
 for(const role of ['anon','authenticated'])assert.equal(await scalar(`select has_function_privilege('${role}','ebay_live_order_lines_changed_statement()','execute') as value`),false);
});
