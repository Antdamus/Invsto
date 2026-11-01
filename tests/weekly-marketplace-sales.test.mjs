import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('weekly report revises the original ET week, separates cancellation and refund, and withholds uncertain sales',async()=>{
 const db=new PGlite(),one=async(sql,args=[])=>(await db.query(sql,args)).rows[0];
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create function auth.uid() returns uuid language sql as $$select '00000000-0000-4000-8000-000000000001'::uuid$$;
   create table employees(user_id uuid,active boolean,role text);insert into employees values(auth.uid(),true,'admin');
   create table ebay_orders(id text,order_number text,status text,sale_date timestamptz,paid_on_date timestamptz,raw_payload jsonb,total_price numeric,buyer_username text);
   create table ebay_order_lines(id text,order_id text,line_status text,quantity int,sold_for numeric,raw_payload jsonb);
   create table ebay_return_cases(order_id text,order_number text,buyer_username text,source_lane text,ebay_return_id text,ebay_status text,raw_payload jsonb);
   create function customer_issue_return_refund(text,text,text,jsonb) returns text language sql as $$select null::text$$;
   create table tiktok_orders(id text,order_number text,marketplace_status text,paid_time text,created_time text,cancel_return text,last_import_id uuid);
   create table tiktok_order_lines(id text,order_id text,sku_id text,line_amount numeric,cancelled_at timestamptz);
   create table whatnot_orders(id text,status text,currency text,subtotal numeric,total numeric,shipping numeric,tax numeric,purchased_at timestamptz);
   create table whatnot_api_connection(singleton boolean,full_in_progress boolean);
   create table tiktok_order_imports(id uuid,source text);create function import_tiktok_api_order(_token uuid,_rows jsonb,_hash text) returns jsonb language plpgsql as $$declare imp uuid;begin update public.tiktok_order_imports set source='api' where id=imp;return null;end$$;`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261101040000_weekly_marketplace_sales.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261101041000_weekly_sales_settlement_sync.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261101042000_weekly_sales_shared_postage.sql',import.meta.url),'utf8'));
  await db.exec(`insert into ebay_orders values ('a','e1','fulfilled','2025-06-02 03:59Z',now(),'{"orderPaymentStatus":"PAID"}',112,'b'),
   ('b','e2','cancelled','2025-06-02 04:00Z',now(),'{"orderPaymentStatus":"FULLY_REFUNDED","orderCancelStatus":"CANCELED"}',54,'b'),
   ('c','e3','pending','2025-06-04 17:00Z',now(),'{"orderPaymentStatus":"PAID","ebayFinance":{"transactions":[{"transactionType":"REFUND","transactionStatus":"COMPLETED"}]}}',75,'b');
   insert into ebay_order_lines values('1','a','fulfilled',2,99,'{"line":{"lineItemCost":{"value":"100","currency":"USD"}}}'),
   ('2','b','cancelled',1,54,'{"Sold For":"$50.00"}'),('3','c','pending',1,75,'{}');
   insert into tiktok_orders values('t','t','Shipped','06/03/2025 9:00 AM','06/02/2025 11:00 PM','',null);
   insert into tiktok_order_lines values('l','t','sku',120,null,20);
   insert into whatnot_orders values('w','completed','USD',80,76,4,2,'2025-06-03 04:30Z'),('failed','failed','USD',9999,9999,0,0,'2025-06-03 04:30Z');`);
  const report=async()=>(await one("select get_weekly_marketplace_sales('2025-06-01') r")).r;
  const row=(r,w,m)=>r.rows.find(x=>x.week===w&&x.market===m);
  let r=await report();assert.equal(row(r,'2025-05-26','ebay').net,100);
  assert.equal(row(r,'2025-06-02','ebay').cancelled,50);assert.equal(row(r,'2025-06-02','ebay').refunded,0);
  assert.equal(row(r,'2025-06-02','ebay').held,75);assert.equal(row(r,'2025-06-02','ebay').net,0);
  assert.equal(row(r,'2025-06-02','whatnot').held,70);assert.equal(row(r,'2025-06-02','tiktok').cancelled,20);
  await db.exec(`update weekly_sales_feed set state='ready',through_at=now(),progress='{"coverage_start":"2025-01-01T00:00:00Z"}';
   insert into weekly_sales_refunds values('tiktok','case1','t','pending',40,'USD',now());`);
  assert.equal(row(await report(),'2025-06-02','tiktok').net,100);
  await db.exec("update weekly_sales_refunds set state='completed';update tiktok_order_lines set api_cancelled_item_amount=0");
  r=await report();assert.equal(row(r,'2025-06-02','tiktok').net,80);assert.equal(row(r,'2025-06-02','whatnot').net,70);
  await db.exec("update ebay_orders set raw_payload='{\"orderPaymentStatus\":\"FULLY_REFUNDED\"}' where id='a'");
  r=await report();assert.equal(row(r,'2025-05-26','ebay').refunded,100);assert.equal(row(r,'2025-05-26','ebay').net,0);
  await db.exec(`update ebay_orders set raw_payload='{"orderPaymentStatus":"PAID","ebayFinance":{"transactionIds":["x","y","z"],"transactions":[{"transactionId":"x","orderNumber":"e1","transactionType":"SALE","transactionStatus":"FUNDS_ON_HOLD","amount":90,"bookingEntry":"CREDIT"},{"transactionId":"y","orderNumber":"e1","transactionType":"SHIPPING_LABEL","transactionStatus":"FUNDS_AVAILABLE_FOR_PAYOUT","amount":6,"bookingEntry":"DEBIT"},{"transactionId":"z","orderNumber":"e1","transactionType":"REFUND","transactionStatus":"FUNDS_AVAILABLE_FOR_PAYOUT","amount":15,"bookingEntry":"DEBIT"}]}}' where id='a'`);
  r=await report();assert.equal(row(r,'2025-05-26','ebay').proceeds,69);assert.equal(row(r,'2025-05-26','ebay').settled_orders,1);
  // One shared debit spans two purchase weeks; only one copy of its seven cents is deducted.
  for(const [order,id,day] of [['combined-A','aa','2025-06-08 12:00Z'],['combined-B','bb','2025-06-09 12:00Z']]){
   const raw={orderPaymentStatus:'PAID',ebayFinance:{source:'ebay_finances_api',orderNumber:order,transactionIds:[id,'shared-label'],transactions:[
    {transactionId:id,orderNumber:order,transactionType:'SALE',bookingEntry:'CREDIT',transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT',amount:10},
    {transactionId:'shared-label',transactionType:'SHIPPING_LABEL',bookingEntry:'DEBIT',transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT',amount:.07}]}};
   await db.query('insert into ebay_orders values($1,$2,$3,$4,now(),$5,10,null)',[id,order,'fulfilled',day,JSON.stringify(raw)]);
  }
  const postage=(await db.query("select order_number,posted,complete from weekly_sales_proceeds('2025-06-01','2025-06-09') where order_number='combined-A'")).rows[0];
  assert.equal(Number(postage.posted),9.96);assert.equal(postage.complete,true);
  assert.equal(Number((await one("select posted from weekly_sales_proceeds('2025-06-09','2025-06-10') where order_number='combined-B'")).posted),9.97);
  await db.exec("update employees set active=false;set role authenticated");await assert.rejects(report(),/admin access/i);
 }finally{await db.close();}
});
