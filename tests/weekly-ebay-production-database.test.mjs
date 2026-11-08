import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;const uid=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const query=async(s,p=[])=>(await db.query(s,p)).rows;
const production=async rows=>(await query('select weekly_ebay_production($1) r',[JSON.stringify(rows)]))[0].r;
const amounts={booked:123.45,cancelled:3.45,refunded:20,held:1,net:99};
async function order(id,time,raw={source:'ebay_fulfillment_api'}){
 await db.query('insert into ebay_orders values($1,$1,$2,$3)',[id,time,JSON.stringify(raw)]);
 await db.query('insert into ebay_order_lines values($1,$1,null)',[id]);
 return {order_number:id,purchased:time,...amounts};
}
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${uid(1)}');
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(id uuid primary key,user_id uuid,active boolean,role text,display_name text);
 insert into employees values('${uid(1)}','${uid(1)}',true,'admin','Admin'),('${uid(2)}',null,true,'seller','Otello Guillen'),('${uid(3)}',null,true,'seller','Sydney Miller');
 create table live_sale_sessions(id uuid primary key,title text,primary_seller_employee_id uuid,co_seller_employee_ids uuid[]);
 create table ebay_live_connections(event_id text primary key,session_id uuid,stream_start_at timestamptz,stream_metadata jsonb,history_recovery jsonb);
 create table ebay_live_attempts(order_line_id text unique,event_id text,seller_id uuid,merged_into uuid,event_exclusion jsonb);
 create table ebay_orders(id text primary key,order_number text unique,sale_date timestamp,raw_payload jsonb);
 create table ebay_order_lines(id text primary key,order_id text,assigned_seller_employee_id uuid);
 create function get_weekly_sales_for_market(date,text) returns jsonb language plpgsql as $$declare m date;end_date date;begin
 with orders as(select 'ebay' market,order_number,sale_date purchased,1 booked,0 cancelled,0 refunded,0 held,1 net from ebay_orders)
 select jsonb_build_object('ebay_item_orders','[]'::jsonb) from orders;return '{}';end$$;
 set test.actor='${uid(1)}';`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261108030000_weekly_ebay_production.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261108050000_weekly_weekend_streamer.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
test('Eastern hour rule handles both boundaries, DST and unknown purchase time without losing money',async()=>{
 const rows=[];
 for(const [id,time] of [['before-eight','2026-10-01T07:59:00'],['at-eight','2026-10-01T08:00:00'],['before-six','2026-10-01T17:59:00'],['at-six','2026-10-01T18:00:00'],['dst','2026-11-01T01:30:00']])rows.push(await order(id,time));
 rows.push(await order('date-only','2026-10-01T00:00:00',{date_precision:{sale_date:'day'}}));
 const r=await production(rows);assert.deepEqual(r.orders.map(x=>[x.order,x.seller]).sort(),[
  ['at-eight','Sydney'],['at-six','Otello'],['before-eight','Otello'],['before-six','Sydney'],['date-only','Seller unassigned'],['dst','Otello']]);
 for(const key of Object.keys(amounts))assert.equal(Math.round(r.orders.reduce((n,r)=>n+r[key],0)*100),Math.round(amounts[key]*rows.length*100));
 assert.ok(r.orders.every(r=>r.show===null));assert.equal(r.orders.find(r=>r.order==='date-only').seller_source,'unknown');
});
test('captured overnight show survives midnight; missing history is explicitly estimated; multiple shows never duplicate an order',async()=>{
 await db.exec(`insert into live_sale_sessions values('${uid(10)}','Overnight','${uid(2)}','{}');
 insert into ebay_live_connections values('night001','${uid(10)}','2026-11-02T04:00Z','{}','{"phase":"read"}');
 insert into weekly_ebay_show_catalog(event_id,title,starts_at) values('day00001','Morning','2026-11-02T15:00Z'),('day00002','Afternoon','2026-11-02T19:00Z');`);
 const overnight=await order('overnight','2026-11-02T08:01:00');
 await db.query('insert into ebay_live_attempts values($1,$2,$3,null,null)',['overnight','night001',uid(2)]);
 const estimate=await order('estimate','2026-11-02T14:01:00');
 const mixed=await order('mixed','2026-11-02T15:01:00');
 await db.exec(`insert into ebay_order_lines values('mixed-two','mixed',null);
 insert into ebay_live_attempts values('mixed','night001','${uid(2)}',null,null),('mixed-two','day00001','${uid(3)}',null,null);`);
 const r=(await production([overnight,estimate,mixed])).orders;
 assert.deepEqual(r.find(r=>r.order==='overnight').show,'night001');assert.equal(r.find(r=>r.order==='overnight').day,'2026-11-02');
 assert.equal(r.find(r=>r.order==='overnight').seller,'Otello');assert.equal(r.find(r=>r.order==='overnight').show_source,'captured');
 assert.equal(r.find(r=>r.order==='estimate').show,'day00002');assert.equal(r.find(r=>r.order==='estimate').show_source,'time_window');
 assert.equal(r.find(r=>r.order==='mixed').show,null);assert.equal(r.find(r=>r.order==='mixed').show_source,'multiple');assert.equal(r.find(r=>r.order==='mixed').seller_source,'multiple');
 assert.equal(r.length,3);assert.equal(r.find(r=>r.order==='mixed').net,99);
});
test('simultaneous shows and verified end boundaries stay unmatched',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,ends_at) values
 ('same0001','A','2026-11-03T15:00Z','2026-11-03T16:00Z'),('same0002','B','2026-11-03T15:00Z','2026-11-03T16:00Z');`);
 const r=await production([await order('overlap','2026-11-03T10:15:00'),await order('after-end','2026-11-03T11:00:00')]);
 assert.ok(r.orders.every(r=>r.show===null&&r.show_source==='unmatched'));
});
test('weekend daytime defaults to Manuella at both boundaries, with show start and explicit sellers taking priority',async()=>{
 const rows=[];
 for(const [id,time] of [['sat-before','2026-11-07T07:59:00'],['sat-start','2026-11-07T08:00:00'],['sat-end','2026-11-07T17:59:00'],['sat-night','2026-11-07T18:00:00'],['sun-day','2026-11-08T12:00:00'],['mon-day','2026-11-09T12:00:00']])rows.push(await order(id,time));
 const names=Object.fromEntries((await production(rows)).orders.map(r=>[r.order,r.seller]));
 assert.deepEqual(names,{'sat-before':'Otello','sat-start':'Manuella','sat-end':'Manuella','sat-night':'Otello','sun-day':'Manuella','mon-day':'Sydney'});
 await db.exec("insert into weekly_ebay_show_catalog(event_id,title,starts_at) values('weekend1','Saturday afternoon','2026-11-07T22:30Z')");
 const later=await order('sat-after-six','2026-11-07T18:45:00');
 let r=(await production([later])).orders[0];assert.equal(r.show,'weekend1');assert.equal(r.seller,'Manuella');
 await db.query('update ebay_order_lines set assigned_seller_employee_id=$1 where id=$2',[uid(3),'sat-after-six']);
 r=(await production([later])).orders[0];assert.equal(r.seller,'Sydney');assert.equal(r.seller_source,'recorded');
 await query('select set_weekly_ebay_show_seller($1,$2,null)',['weekend1',uid(2)]);
 r=(await production([later])).orders[0];assert.equal(r.seller,'Otello');assert.equal(r.seller_source,'override');
 for(const key of Object.keys(amounts))assert.equal(r[key],amounts[key]);
});
test('admin report override is audited, revision protected, and leaves orders and capture sellers intact',async()=>{
 const save=(seller,stamp=null)=>query('select set_weekly_ebay_show_seller($1,$2,$3) r',['day00002',seller,stamp]);
 const before=(await query('select * from ebay_orders where id=$1',['estimate']))[0];
 const saved=(await save(uid(2)))[0].r;
 const r=await production([{order_number:'estimate',purchased:'2026-11-02T14:01:00',...amounts}]);
 assert.equal(r.orders[0].seller,'Otello');assert.equal(r.orders[0].seller_source,'override');
 assert.deepEqual((await query('select * from ebay_orders where id=$1',['estimate']))[0],before);
 await assert.rejects(save(uid(3)),/changed/);await save(null,saved.updated_at);
 assert.equal((await query("select count(*) n from weekly_ebay_show_assignment_audit where event_id='day00002'"))[0].n,2);
 await db.exec("set test.actor=''");await assert.rejects(save(uid(3)),/admin access/);
 await db.exec(`set test.actor='${uid(1)}';set role authenticated`);
 await assert.rejects(production([]),/permission denied/);await assert.rejects(query('select * from weekly_ebay_show_catalog'),/permission denied/);
 await db.exec('reset role');
});
