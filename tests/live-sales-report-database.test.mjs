import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${id(1)}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create table live_sale_sessions(id uuid primary key,title text,session_code text,started_at timestamptz,ended_at timestamptz,status text);
 create table ebay_live_connections(event_id text primary key,session_id uuid);
 create table ebay_live_attempts(id uuid primary key,event_id text,merged_into uuid,order_line_id uuid);
 create table ebay_orders(id uuid primary key,order_number text,buyer_name text,status text,label_metadata jsonb,raw_payload jsonb,updated_at timestamptz default now());
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,transaction_id text,quantity int,raw_payload jsonb);
 create table live_sale_bag_photos(id uuid primary key,attempt_id uuid,photo_path text,captured_at timestamptz,width int,height int);
 create function get_ebay_live_dashboard(uuid) returns jsonb language sql as $$select jsonb_build_object('connection',(select to_jsonb(c) from public.ebay_live_connections c where session_id=$1),'attempts','[]'::jsonb)$$;
 insert into live_sale_sessions(id,title) values('${id(2)}','Test show');insert into ebay_live_connections values('event','${id(2)}');
 insert into ebay_live_attempts values('${id(3)}','event',null,'${id(4)}'),('${id(6)}','other',null,null),('${id(7)}','event','${id(3)}',null);
 insert into ebay_orders(id,order_number,buyer_name,status,label_metadata,raw_payload) values('${id(5)}','01-12345-12345','Buyer Name','pending','{}','{"videoReceiptUrl":"receipt"}');
 insert into ebay_order_lines values('${id(4)}','${id(5)}','123','tx',2,'{}');
 insert into live_sale_bag_photos values('${id(8)}','${id(3)}','photo.png',now(),100,100);
 create function get_material_cost_settings() returns jsonb language sql as $$select '{}'::jsonb$$;
 grant usage on schema auth to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261029200000_live_sales_report.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261030000000_live_report_actual_fees.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
beforeEach(async()=>{await db.exec(`reset role;truncate live_sale_report_settings,live_sale_report_costs;select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);set role authenticated;`);});
const settings=(rates={},fee=null,expected=null)=>db.query('select to_jsonb(s) v from save_live_sale_report_settings($1,$2,$3,null,null,$4) s',[id(2),JSON.stringify(rates),fee,expected]);
const cost=(mode='manual',base=10,expected=null,attempt=id(3))=>db.query('select to_jsonb(s) v from save_live_sale_report_cost($1,$2,$3,$4,null,null,null,$5,$6) s',[id(2),attempt,mode,base,'Cost note',expected]);
test('read joins screenshots, buyer identity and quantity without creating costs',async()=>{
 const {rows}=await db.query('select get_live_sale_report($1) v',[id(2)]),v=rows[0].v;
 assert.equal(v.evidence[id(3)].order.buyer_name,'Buyer Name');assert.equal(v.evidence[id(3)].line.quantity,2);assert.equal(v.evidence[id(3)].photos.length,1);assert.equal(v.evidence[id(7)],undefined);assert.deepEqual(v.costs,{});assert.equal(v.settings,null);
 await assert.rejects(db.query('select get_live_sale_report($1)',[id(20)]),/Linked show/);
});
test('authorized saves persist explicit zero and reject stale editors',async()=>{
 const saved=(await settings({gold_10:30,silver:0},0)).rows[0].v;assert.equal(saved.rates.gold_10,30);assert.equal(Number(saved.fee_percent),0);
 await assert.rejects(settings({},0),/changed on another device/);await settings({gold_10:31},null,saved.updated_at);
 const item=(await cost('manual',0)).rows[0].v;assert.equal(Number(item.base_cost),0);await assert.rejects(cost(),/changed on another device/);await cost('auto',null,item.updated_at);
});
test('validations reject invalid numbers, unavailable items and unsafe rates',async()=>{
 for(const rates of [{gold_10:-1},{gold_10:'30'},{unknown:1},{silver:1000001}])await assert.rejects(settings(rates),/Invalid/);
 await assert.rejects(settings({},101),/Invalid/);await assert.rejects(settings({},'NaN'),/Invalid/);
 await assert.rejects(cost('manual',null),/Enter the total/);await assert.rejects(cost('manual',-1),/Invalid/);
 await assert.rejects(cost('metal',null),/Enter material/);await assert.rejects(cost('manual',1,null,id(6)),/does not belong/);await assert.rejects(cost('manual',1,null,id(7)),/does not belong/);
});
test('permissions enforce inventory staff, authenticated actor and RPC-only writes',async()=>{
 await assert.rejects(db.query(`insert into live_sale_report_costs(attempt_id,mode,base_cost,updated_by) values('${id(3)}','manual',0,'${id(1)}')`),/permission denied/);
 await db.exec("select set_config('test.access','no',false)");await assert.rejects(settings(),/Inventory access/);await assert.rejects(cost(),/Inventory access/);await assert.rejects(db.query('select get_live_sale_report($1)',[id(2)]),/Inventory access/);
 assert.equal((await db.query('select * from live_sale_report_costs')).rows.length,0);
 await db.exec("select set_config('test.access','yes',false);select set_config('test.actor','',false)");await assert.rejects(cost(),/Inventory access/);
 await db.exec('reset role;set role anon');await assert.rejects(db.query('select get_live_sale_report($1)',[id(2)]),/permission denied/);
});

test('report exposes actual fee and all line allocation amounts, without order addresses or full payload',async()=>{
 await db.exec('reset role');
 const order={totalMarketplaceFee:{value:'0',currency:'USD'},totalFeeBasisAmount:{value:'33',currency:'USD'},pricingSummary:{deliveryCost:{value:'1',currency:'USD'}},fulfillmentStartInstructions:[{shippingStep:{shipTo:{fullName:'PRIVATE ADDRESS'}}}],lineItems:[{lineItemId:'one',lineItemCost:{value:'10',currency:'USD'},lineItemFulfillmentInstructions:{private:'HIDDEN'}},{lineItemId:'two',lineItemCost:{value:'20',currency:'USD'}}]};
 await db.query('update ebay_orders set raw_payload=$1 where id=$2',[JSON.stringify({order,videoReceiptUrl:'receipt',private:'DO NOT EXPOSE'}),id(5)]);
 await db.exec('set role authenticated');
 const v=(await db.query('select get_live_sale_report($1) v',[id(2)])).rows[0].v.evidence[id(3)];
 assert.equal(v.order.financials.totalMarketplaceFee.value,'0');assert.equal(v.order.financials.lineItems.length,2);assert.ok(v.order.updated_at);
 assert.equal(v.order.financials.lineItems[1].lineItemCost.value,'20');
 assert.equal(v.order.raw_payload.videoReceiptUrl,'receipt');assert.ok(!JSON.stringify(v).includes('PRIVATE'));assert.ok(!JSON.stringify(v).includes('HIDDEN'));assert.ok(!JSON.stringify(v).includes('DO NOT EXPOSE'));
});
