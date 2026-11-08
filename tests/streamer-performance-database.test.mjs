import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;const admin='00000000-0000-4000-8000-000000000001';
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${admin}');
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(id uuid primary key,user_id uuid,active boolean,role text,display_name text);
 insert into employees values('${admin}','${admin}',true,'admin','Sydney Miller');
 create table live_sale_sessions(id uuid primary key,title text,primary_seller_employee_id uuid,co_seller_employee_ids uuid[]);
 create table ebay_live_connections(event_id text primary key,session_id uuid,stream_start_at timestamptz,stream_metadata jsonb,history_recovery jsonb);
 create table ebay_live_attempts(order_line_id text unique,event_id text,seller_id uuid,merged_into uuid,event_exclusion jsonb);
 create table ebay_orders(id text primary key,order_number text unique,sale_date timestamptz,raw_payload jsonb);
 create table ebay_order_lines(id text primary key,order_id text,assigned_seller_employee_id uuid);
 create table sale_rows(market text,order_number text,purchased timestamp,booked numeric,cancelled numeric,refunded numeric,needs_review boolean);
 create function weekly_sales_order_rows(date,date) returns setof sale_rows language sql as $$select * from public.sale_rows where purchased>=$1 and purchased<$2$$;
 create function get_weekly_sales_for_market(date,text) returns jsonb language plpgsql as $$declare m date;end_date date;cutoff timestamp;begin
 with orders as(select market,order_number,purchased,booked,cancelled,refunded,0 held,booked net from sale_rows)
 select jsonb_build_object('ebay_item_orders','[]'::jsonb) from orders;return '{}';end$$;
 set test.actor='${admin}';`);
 for(const file of ['20261108030000_weekly_ebay_production.sql','20261108040000_weekly_production_reports.sql','20261108050000_weekly_weekend_streamer.sql','20261108060000_streamer_performance_history.sql','20261108070000_streamer_all_history.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
});
after(()=>db?.close());
test('history endpoint enforces admin access and bounded input',async()=>{
 await assert.rejects(db.query("select get_streamer_performance_history('2026-01-01','2027-02-01')"),/370 days/);
 await assert.rejects(db.query("select get_streamer_performance_history(null,null)"),/valid history end date/);
 await db.exec("set test.actor='';set role authenticated");
 await assert.rejects(db.query("select get_streamer_performance_history('2026-06-01','2026-07-01')"),/Active admin/);
 await assert.rejects(db.query("select get_streamer_performance_history(null,'2026-07-01')"),/Active admin/);
 await db.exec(`reset role;set test.actor='${admin}'`);
});
test('all available history includes older shows beyond twelve months and respects the report end',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,airtime_seconds,insights) values
 ('firstshow','First show','2025-08-07T23:00-04:00',3600,'{"paid_items":0}'),
 ('future','Later show','2028-01-01T23:00-05:00',3600,'{"paid_items":0}');`);
 const r=(await db.query("select get_streamer_performance_history(null,'2026-11-09') r")).rows[0].r;
 assert.equal(r.from,'2025-08-07');assert.equal(r.until,'2026-11-09');
 assert.ok(r.shows.some(s=>s.event_id==='firstshow'));assert.ok(!r.shows.some(s=>s.event_id==='future'));
 const empty=(await db.query("select get_streamer_performance_history(null,'2024-01-01') r")).rows[0].r;
 assert.equal(empty.shows.length,0);assert.equal(empty.from,'2023-12-31');
});
test('historical hosts, overnight money, reversals and unlinked coverage remain explicit',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,seller_override,airtime_seconds,insights) values
 ('earlyday','Early day','2026-06-02T14:00Z',null,3600,'{"paid_items":0}'),
 ('earlysaved','Saved day','2026-06-03T14:00Z','${admin}',3600,'{"paid_items":0}'),
 ('overnight','Overnight','2026-06-30T23:00-04:00',null,36000,'{"paid_items":2}');
 insert into ebay_orders values('1','1','2026-07-01T08:30-04:00','{"source":"ebay_fulfillment_api"}'),('2','2','2026-07-01T01:30-04:00','{"source":"ebay_fulfillment_api"}'),('3','3','2026-06-05T15:00-04:00','{"source":"ebay_fulfillment_api"}');
 insert into ebay_order_lines values('1','1',null),('2','2',null),('3','3',null);
 insert into sale_rows values('ebay','1','2026-07-01T08:30',100,10,20,false),('ebay','2','2026-07-01T01:30',50,0,0,true),('ebay','3','2026-06-05T15:00',30,0,0,false);`);
 const r=(await db.query("select get_streamer_performance_history('2026-06-01','2026-07-01') r")).rows[0].r;
 assert.equal(r.shows.length,3);
 assert.equal(r.shows.find(s=>s.event_id==='earlyday').seller,'Historical seller unassigned');
 assert.equal(r.shows.find(s=>s.event_id==='earlysaved').seller,'Sydney');
 const night=r.shows.find(s=>s.event_id==='overnight');assert.equal(night.seller,'Otello');assert.equal(night.net,70);assert.equal(night.held,50);assert.equal(night.orders,2);assert.equal(night.linked_lines,2);assert.equal(r.coverage.unlinked_orders,1);assert.equal(r.coverage.unlinked_net,30);
 const next=(await db.query("select get_streamer_performance_history('2026-07-01','2026-07-02') r")).rows[0].r;
 const whole=(await db.query("select get_streamer_performance_history('2026-06-01','2026-07-02') r")).rows[0].r;
 assert.equal(r.coverage.orders+next.coverage.orders,whole.coverage.orders);
 assert.equal(next.shows.length,0);assert.equal(whole.shows.find(s=>s.event_id==='overnight').net,night.net);
});
