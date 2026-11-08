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
 alter table ebay_orders add column buyer_username text;
 alter table ebay_order_lines add column quantity integer default 1,add column sold_for numeric,add column raw_payload jsonb default '{}',add column internal_item_id uuid;
 create table item_types(id uuid primary key,categories text[],watch_details jsonb,ebay_category_id text,ebay_aspects jsonb);
 create table order_line_watch_flags(order_line_id text primary key,is_watch boolean,brand text);
 create function weekly_sales_money(v text) returns numeric language sql immutable strict as $$select case when v ~ '^[0-9]+([.][0-9]+)?$' then round(v::numeric,2) end$$;
 create table sale_rows(market text,order_number text,purchased timestamp,booked numeric,cancelled numeric,refunded numeric,needs_review boolean);
 create function weekly_sales_order_rows(date,date) returns setof sale_rows language sql as $$select * from public.sale_rows where purchased>=$1 and purchased<$2$$;
 create function get_weekly_sales_for_market(date,text) returns jsonb language plpgsql as $$declare m date;end_date date;cutoff timestamp;begin
 with orders as(select market,order_number,purchased,booked,cancelled,refunded,0 held,booked net from sale_rows)
 select jsonb_build_object('ebay_item_orders','[]'::jsonb) from orders;return '{}';end$$;
 set test.actor='${admin}';`);
 for(const file of ['20261108030000_weekly_ebay_production.sql','20261108040000_weekly_production_reports.sql','20261108050000_weekly_weekend_streamer.sql','20261108060000_streamer_performance_history.sql','20261108070000_streamer_all_history.sql','20261108080000_streamer_commercial_analysis.sql','20261108100000_show_push_labels.sql','20261108120000_streamer_start_date.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
});
after(()=>db?.close());
test('September 23 and 6 AM boundaries use the owner confirmed streamer schedule',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,airtime_seconds,insights) values
 ('cut-before','Before Sydney','2026-09-22T12:00-04:00',60,'{"paid_items":0}'),
 ('cut-day','Sydney first day','2026-09-23T06:00-04:00',60,'{"paid_items":0}'),
 ('cut-night','Otello morning','2026-09-23T05:59-04:00',60,'{"paid_items":0}'),
 ('cut-evening','Otello evening','2026-09-23T18:00-04:00',60,'{"paid_items":0}'),
 ('cut-weekend','Weekend daytime','2026-09-26T12:00-04:00',60,'{"paid_items":0}');`);
 const h=(await db.query("select get_streamer_performance_history('2026-09-22','2026-09-27') r")).rows[0].r;
 assert.equal(h.sydney_estimated_start,'2026-09-23');
 for(const [id,name]of [['cut-before','Otello'],['cut-day','Sydney'],['cut-night','Otello'],['cut-evening','Otello'],['cut-weekend','Manuella']])assert.equal(h.shows.find(s=>s.event_id===id).seller,name);
});
test('push labels honor the Eastern cutoff, explicit exceptions, audit and concurrent edits',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,airtime_seconds,insights) values
 ('push-before','Before cutoff','2026-08-25T03:59Z',3600,'{"paid_items":0}'),
 ('push-after','At cutoff','2026-08-25T04:00Z',3600,'{"paid_items":0}'),
 ('push-future','Future default','2028-01-01T20:00Z',3600,'{"paid_items":0}');`);
 const initial=(await db.query("select get_streamer_performance_history('2026-08-24','2026-08-26') r")).rows[0].r;
 const before=initial.shows.find(s=>s.event_id==='push-before'),after=initial.shows.find(s=>s.event_id==='push-after');
 assert.equal(before.push.manual,null);assert.equal(after.push.manual,false);assert.equal(after.push.manual_source,'date_rule');assert.equal(after.push.automatic,null);
 const future=(await db.query("select ebay_show_push_labels(push_labels,starts_at,push_updated_at) p from weekly_ebay_show_catalog where event_id='push-future'")).rows[0].p;
 assert.equal(future.manual,false);
 const saved=(await db.query(`select set_weekly_ebay_show_push_labels('push-after','{"manual":true,"automatic":true,"note":"Both pushes confirmed"}',null) p`)).rows[0].p;
 assert.equal(saved.manual,true);assert.equal(saved.automatic,true);assert.equal(saved.manual_source,'recorded');assert.ok(saved.updated_at);
 await assert.rejects(db.query(`select set_weekly_ebay_show_push_labels('push-after','{}',null)`),/changed/);
 for(const bad of ['{"manual":"yes"}','{"automatic":1}','{"other":true}','{"note":null}','[]'])await assert.rejects(db.query('select set_weekly_ebay_show_push_labels($1,$2,$3)',['push-after',bad,saved.updated_at]),/valid push/);
 const unknown=(await db.query('select set_weekly_ebay_show_push_labels($1,$2,$3) p',['push-after','{"manual":null,"automatic":false}',saved.updated_at])).rows[0].p;
 assert.equal(unknown.manual,null);assert.equal(unknown.automatic,false);
 const reset=(await db.query('select set_weekly_ebay_show_push_labels($1,$2,$3) p',['push-after','{}',unknown.updated_at])).rows[0].p;
 assert.equal(reset.manual,false);assert.equal(reset.manual_source,'date_rule');assert.equal(reset.automatic,null);
 const updated=(await db.query("select get_streamer_performance_history('2026-08-24','2026-08-26') r")).rows[0].r;
 assert.deepEqual(updated.shows.map(({push,...s})=>s),initial.shows.map(({push,...s})=>s));
 assert.equal((await db.query("select weekly_ebay_show_timing('2026-08-25','2026-08-26') r")).rows[0].r.find(s=>s.event_id==='push-after').push.manual,false);
 assert.equal((await db.query("select count(*)::int n from weekly_ebay_show_push_audit where event_id='push-after'")).rows[0].n,3);
 await db.exec("set test.actor='';set role authenticated");
 await assert.rejects(db.query("select set_weekly_ebay_show_push_labels('push-after','{}',null)"),/Active admin/);
 await assert.rejects(db.query("select * from weekly_ebay_show_push_audit"),/permission denied/);
 await assert.rejects(db.query("update weekly_ebay_show_catalog set push_labels='{}'"),/permission denied/);
 await db.exec(`reset role;set test.actor='${admin}'`);
});
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
 insert into ebay_orders(id,order_number,sale_date,raw_payload) values('1','1','2026-07-01T08:30-04:00','{"source":"ebay_fulfillment_api"}'),('2','2','2026-07-01T01:30-04:00','{"source":"ebay_fulfillment_api"}'),('3','3','2026-06-05T15:00-04:00','{"source":"ebay_fulfillment_api"}');
 insert into ebay_order_lines(id,order_id,assigned_seller_employee_id) values('1','1',null),('2','2',null),('3','3',null);
 insert into sale_rows values('ebay','1','2026-07-01T08:30',100,10,20,false),('ebay','2','2026-07-01T01:30',50,0,0,true),('ebay','3','2026-06-05T15:00',30,0,0,false);`);
 const r=(await db.query("select get_streamer_performance_history('2026-06-01','2026-07-01') r")).rows[0].r;
 assert.equal(r.shows.length,3);
 assert.equal(r.shows.find(s=>s.event_id==='earlyday').seller,'Otello');
 assert.equal(r.shows.find(s=>s.event_id==='earlysaved').seller,'Sydney');
 const night=r.shows.find(s=>s.event_id==='overnight');assert.equal(night.seller,'Otello');assert.equal(night.net,70);assert.equal(night.held,50);assert.equal(night.orders,2);assert.equal(night.linked_lines,2);assert.equal(r.coverage.unlinked_orders,1);assert.equal(r.coverage.unlinked_net,30);
 const next=(await db.query("select get_streamer_performance_history('2026-07-01','2026-07-02') r")).rows[0].r;
 const whole=(await db.query("select get_streamer_performance_history('2026-06-01','2026-07-02') r")).rows[0].r;
 assert.equal(r.coverage.orders+next.coverage.orders,whole.coverage.orders);
 assert.equal(next.shows.length,0);assert.equal(whole.shows.find(s=>s.event_id==='overnight').net,night.net);
});

test('commercial evidence reconciles money without exposing buyers or inventing line refunds',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,airtime_seconds,insights) values
 ('commercial','Rolex watch','2026-08-02T23:30-04:00',3600,'{"paid_items":4}');
 insert into ebay_orders(id,order_number,sale_date,raw_payload,buyer_username) values
 ('c1','c1','2026-08-02T23:40-04:00','{"source":"ebay_fulfillment_api"}','Alice'),
 ('c2','c2','2026-08-03T00:10-04:00','{"source":"ebay_fulfillment_api"}','ALICE'),
 ('c3','c3','2026-08-03T00:45-04:00','{"source":"ebay_fulfillment_api"}',null),
 ('c4','c4','2026-08-03T00:00-04:00','{"date_precision":{"sale_date":"day"}}','Bob');
 insert into ebay_order_lines(id,order_id,sold_for,quantity) values('c1','c1',100,2),('c2','c2',50,1),('c3','c3',40,1),('c4','c4',20,1);
 insert into order_line_watch_flags values('c1',true,'rolex');
 insert into ebay_live_attempts(order_line_id,event_id) values('c4','commercial');
 insert into sale_rows values('ebay','c1','2026-08-02T23:40',200,0,50,false),('ebay','c2','2026-08-03T00:10',50,0,0,false),('ebay','c3','2026-08-03T00:45',40,0,0,false),('ebay','c4','2026-08-03T00:00',20,0,0,false);`);
 const h=(await db.query("select get_streamer_performance_history('2026-08-01','2026-08-04') r")).rows[0].r,s=h.shows[0],c=s.commercial;
 assert.equal(s.net,260);assert.equal(c.orders,4);assert.equal(c.timed_orders,2);assert.equal(c.timed_net,200);assert.equal(c.precise_orders,3);assert.equal(c.after_duration_orders,1);
 assert.deepEqual(c.halves.map(r=>[r.bin,r.net]),[[0,150],[1,50]]);assert.deepEqual(c.clocks.map(r=>r.hour),[0,23]);
 assert.equal(c.known_buyers,2);assert.equal(c.largest_buyer_net,200);assert.equal(c.missing_buyer_orders,1);assert.equal(c.largest_order_net,150);assert.equal(c.top_three_orders_net,240);
 const rolex=c.merchandise.find(r=>r.brand==='Rolex');assert.equal(rolex.original_sales,200);assert.equal(rolex.units,2);assert.equal(rolex.price_band,'$100-$499');assert.equal(rolex.evidence,'Staff classification');
 assert.equal(c.merchandise.reduce((n,r)=>n+r.original_sales,0),310);
 assert.ok(!JSON.stringify(c).toLowerCase().includes('alice'));assert.ok(!JSON.stringify(c).includes('c1'));
 await db.exec('set role authenticated');await assert.rejects(db.query("select streamer_commercial_details('{}','2026-08-01','2026-08-04')"),/permission denied/);await db.exec('reset role');
});


test('saved audience viewing time backfill retains zero, rejects missing values and preserves financial fields',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,airtime_seconds,insights) values
 ('audience-time','Audience','2026-10-01T22:00-04:00',3600,'{"metrics":[{"name":"AVG VIEWING TIME","value":"06m 08s"}],"total_viewers":1000}'),
 ('audience-zero','Audience zero','2026-10-02T22:00-04:00',3600,'{"metrics":[{"name":"AVG VIEWING TIME","value":"00m 00s"}]}'),
 ('audience-missing','Audience missing','2026-10-03T22:00-04:00',3600,'{"metrics":[{"name":"AVG VIEWING TIME","value":"Data unavailable"}]}');`);
 const before=(await db.query("select get_streamer_performance_history('2026-10-01','2026-10-04') r")).rows[0].r;
 await db.exec(await readFile(new URL('../supabase/migrations/20261108090000_show_audience_watch_time.sql',import.meta.url),'utf8'));
 const after=(await db.query("select get_streamer_performance_history('2026-10-01','2026-10-04') r")).rows[0].r;
 assert.equal(after.shows.find(s=>s.event_id==='audience-time').insights.average_viewing_seconds,368);
 assert.equal(after.shows.find(s=>s.event_id==='audience-zero').insights.average_viewing_seconds,0);
 assert.equal(after.shows.find(s=>s.event_id==='audience-missing').insights.average_viewing_seconds,undefined);
 assert.deepEqual(after.shows.map(({insights,...s})=>s),before.shows.map(({insights,...s})=>s));
 assert.ok(after.shows.every(s=>s.insights.metrics===undefined));
});
