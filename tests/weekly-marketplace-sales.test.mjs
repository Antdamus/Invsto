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
  await db.exec(await readFile(new URL('../supabase/migrations/20261101045000_weekly_sales_market_filter.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261101051000_weekly_ebay_seller_hub.sql',import.meta.url),'utf8'));
  await db.exec("create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as 'select 1::bigint'");
  await db.exec(await readFile(new URL('../supabase/migrations/20261101053000_ebay_order_earnings.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261101060000_weekly_sales_reversed_orders.sql',import.meta.url),'utf8'));
  await db.exec(`create table ebay_finance_worker(singleton boolean,dispatch_token uuid,claimed_at timestamptz,lease_until timestamptz);
   create table ebay_finance_jobs(state text,lease_until timestamptz);
   create function enqueue_ebay_finance_jobs(text[],boolean) returns integer language sql as 'select 1';
   create function dispatch_ebay_finance_worker() returns void language plpgsql as $$begin if not exists(select 1 from ebay_finance_jobs where (state='working' and lease_until<=now())) then return; end if; end$$;`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261101061000_weekly_ebay_sale_updates.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/migrations/20261101062000_weekly_ebay_refund_history.sql',import.meta.url),'utf8'));
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
  await db.exec("insert into weekly_ebay_seller_hub_periods values('2025-06-01','2025-06-30',100,5,10,2,93,now())");
  const ebay=(await one("select get_weekly_sales_for_market('2025-06-01','ebay') r")).r;
  assert.equal(ebay.seller_hub[0].reported_net,93);assert.equal((await report()).seller_hub,null);
  assert.ok(ebay.rows.every(item=>item.market==='ebay'));assert.equal(ebay.rows.reduce((n,item)=>n+item.net,0),100);
  await db.exec("update ebay_orders set raw_payload='{\"orderPaymentStatus\":\"FULLY_REFUNDED\"}' where id='a'");
  r=await report();assert.equal(row(r,'2025-05-26','ebay').refunded,100);assert.equal(row(r,'2025-05-26','ebay').net,0);
  await db.exec(`update ebay_orders set raw_payload='{"orderPaymentStatus":"PAID","ebayFinance":{"transactionIds":["x","y","z"],"transactions":[{"transactionId":"x","orderNumber":"e1","transactionType":"SALE","transactionStatus":"FUNDS_ON_HOLD","amount":90,"bookingEntry":"CREDIT"},{"transactionId":"y","orderNumber":"e1","transactionType":"SHIPPING_LABEL","transactionStatus":"FUNDS_AVAILABLE_FOR_PAYOUT","amount":6,"bookingEntry":"DEBIT"},{"transactionId":"z","orderNumber":"e1","transactionType":"REFUND","transactionStatus":"FUNDS_AVAILABLE_FOR_PAYOUT","amount":15,"bookingEntry":"DEBIT"}]}}' where id='a'`);
  r=await report();assert.equal(row(r,'2025-05-26','ebay').proceeds,0);assert.equal(row(r,'2025-05-26','ebay').settled_orders,0);
  // Post the reversal in July. The original June week changes immediately,
  // even if the payment ledger or an earnings snapshot still shows a profit.
  const paid=(await one("select raw_payload r from ebay_orders where id='a'")).r;
  const originalLedger=structuredClone(paid.ebayFinance);originalLedger.transactions=originalLedger.transactions.filter(t=>t.transactionType!=='REFUND');originalLedger.transactionIds=['x','y'];
  const setOrder=(value)=>db.query("update ebay_orders set raw_payload=$1 where id='a'",[JSON.stringify(value)]);
  const saleWeek=async()=>row((await one("select get_weekly_sales_for_market('2025-06-01','ebay') r")).r,'2025-05-26','ebay');
  const checkSale=async(net,posted,eligible)=>{const w=await saleWeek();assert.equal(w.net,net);assert.equal(w.proceeds,posted);assert.equal(w.settled_orders,eligible);return w;};
  await setOrder({orderPaymentStatus:'PAID',ebayFinance:originalLedger});await checkSale(100,84,1);
  await setOrder({orderPaymentStatus:'PAID',orderCancelStatus:'CANCELED',ebayFinance:originalLedger});
  let adjusted=await checkSale(0,0,0);assert.equal(adjusted.cancelled,100);assert.equal(adjusted.refunded,0);
  await db.exec("insert into weekly_ebay_order_earnings(order_number,purchased_at,earnings,refunds,checked_at) values('e1','2025-06-02 03:59Z',84,0,now())");
  await setOrder({orderPaymentStatus:'FULLY_REFUNDED',orderCancelStatus:'CANCELED',ebayFinance:originalLedger});
  adjusted=await checkSale(0,0,0);assert.equal(adjusted.cancelled+adjusted.refunded,100);
  const julyRefund={refundReferenceId:'r-july',refundStatus:'REFUNDED',refundDate:'2025-07-03T12:00:00Z',amount:{currency:'USD',value:'25.00'}};
  const partial={orderPaymentStatus:'PARTIALLY_REFUNDED',order:{pricingSummary:{total:{value:'100.00'}},paymentSummary:{refunds:[julyRefund,julyRefund]}},ebayFinance:originalLedger};
  await setOrder(partial);adjusted=await checkSale(75,0,0);assert.equal(adjusted.refunded,25);
  const refundDebit={transactionId:'new-r',orderNumber:'e1',transactionType:'REFUND',transactionStatus:'COMPLETED',bookingEntry:'DEBIT',amount:25};
  partial.ebayFinance={...originalLedger,transactionIds:['x','y','new-r'],transactions:[...originalLedger.transactions,refundDebit]};
  await setOrder(partial);await checkSale(75,59,1);
  assert.equal((await one("select count(*) n from weekly_sales_order_rows('2025-07-01','2025-08-01') where order_number='e1'")).n,0);
  // A refunded line snapshot cannot wipe out its siblings' sales.
  await db.exec("update ebay_order_lines set raw_payload=jsonb_set(raw_payload,'{orderPaymentStatus}','\"FULLY_REFUNDED\"') where id='1'");
  await db.exec("insert into ebay_order_lines values('extra','a','fulfilled',1,10,'{\"Sold For\":\"10.00\",\"orderPaymentStatus\":\"PAID\"}')");
  partial.order.pricingSummary.total.value='110.00';await setOrder(partial);adjusted=await checkSale(85,59,1);assert.equal(adjusted.refunded,25);
  await db.exec("delete from ebay_order_lines where id='extra'");
  partial.orderPaymentStatus='FULLY_REFUNDED';partial.ebayFinance.transactions.at(-1).amount=100;
  await setOrder(partial);await checkSale(0,-16,1);
  await setOrder({orderPaymentStatus:'PAID',ebayFinance:originalLedger});
  await db.exec("update ebay_order_lines set raw_payload=raw_payload-'orderPaymentStatus' where id='1'");
  await checkSale(100,84,1);
  await db.exec("update weekly_ebay_change_cursor set through_at='2025-07-01';insert into ebay_finance_worker values(true,auth.uid(),now(),now()+interval '1 minute')");
  const change={order_number:'e1',modified_at:'2025-07-03T12:00:00Z',changes:{orderPaymentStatus:'PARTIALLY_REFUNDED',refunds:[julyRefund],total:{value:'100.00',currency:'USD'}}};
  const apply=()=>db.query("select save_weekly_ebay_change_page(auth.uid(),'2025-07-01','2025-07-05',$1,true,false)",[JSON.stringify([change])]);
  await apply();await apply();await checkSale(75,0,0);
  assert.equal((await one("select status from ebay_orders where id='a'")).status,'fulfilled');
  assert.equal((await one("select count(*) n from weekly_ebay_sale_updates")).n,1);
  // A later page may repeat one refund, revise its amount, and introduce
  // another. A newer order snapshot can omit all of them.
  const nextChange={...change,modified_at:'2025-07-06T12:00:00Z',changes:{...change.changes,refunds:[
   {...julyRefund,amount:{currency:'USD',value:'20.00'}},{...julyRefund,refundReferenceId:'second',amount:{currency:'USD',value:'10.00'}}]}};
  await db.query("select save_weekly_ebay_change_page(auth.uid(),'2025-07-05','2025-07-07',$1,true,false)",[JSON.stringify([nextChange])]);
  await checkSale(70,0,0);
  nextChange.modified_at='2025-07-08T12:00:00Z';nextChange.changes.refunds=[{...julyRefund,refundReferenceId:'third',amount:{currency:'USD',value:'5.00'}}];
  await db.query("select save_weekly_ebay_change_page(auth.uid(),'2025-07-07','2025-07-09',$1,true,false)",[JSON.stringify([nextChange])]);
  await setOrder({orderPaymentStatus:'PARTIALLY_REFUNDED',order:{lastModifiedDate:'2025-07-10T00:00:00Z',pricingSummary:{total:{currency:'USD',value:'100.00'}}},ebayFinance:originalLedger});
  await checkSale(65,0,0);
  // One shared debit spans two purchase weeks; only one copy of its seven cents is deducted.
  for(const [order,id,day] of [['combined-A','aa','2025-06-08 12:00Z'],['combined-B','bb','2025-06-09 12:00Z']]){
   const raw={orderPaymentStatus:'PAID',ebayFinance:{source:'ebay_finances_api',orderNumber:order,transactionIds:[id,'shared-label'],transactions:[
    {transactionId:id,orderNumber:order,transactionType:'SALE',bookingEntry:'CREDIT',transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT',amount:10},
    {transactionId:'shared-label',transactionType:'SHIPPING_LABEL',bookingEntry:'DEBIT',transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT',amount:.07}]}};
   await db.query('insert into ebay_orders values($1,$2,$3,$4,now(),$5,10,null)',[id,order,'fulfilled',day,JSON.stringify(raw)]);
   await db.query('insert into ebay_order_lines values($1,$2,$3,1,10,$4)',[id+'-line',id,'fulfilled',JSON.stringify({'Sold For':'10.00'})]);
  }
  const postage=(await db.query("select order_number,posted,complete from weekly_sales_proceeds('2025-06-01','2025-06-09') where order_number='combined-A'")).rows[0];
  assert.equal(Number(postage.posted),9.96);assert.equal(postage.complete,true);
  assert.equal(Number((await one("select posted from weekly_sales_proceeds('2025-06-09','2025-06-10') where order_number='combined-B'")).posted),9.97);
  await db.exec("insert into weekly_ebay_order_earnings(order_number,purchased_at,earnings,checked_at) values ('combined-B',now(),8.44,now())");
  assert.equal(Number((await one("select posted from weekly_sales_proceeds('2025-06-09','2025-06-10') where order_number='combined-B'")).posted),8.44);
  await db.exec("update employees set active=false;set role authenticated");await assert.rejects(report(),/admin access/i);
 }finally{await db.close();}
});
