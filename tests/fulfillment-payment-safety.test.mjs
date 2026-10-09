import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create table ebay_orders(id uuid primary key,order_number text,status text,raw_payload jsonb default '{}',label_file_path text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_title text,line_status text,fulfilled_quantity int,raw_payload jsonb default '{}');
 create table ebay_order_label_events(order_ids uuid[],action text);
 create table packaging_shipments(id uuid primary key,order_ids uuid[],status text,revision int default 1,hold_reason text,updated_at timestamptz,created_by uuid);
 create table packaging_events(shipment_id uuid,request_id uuid,action text,notes text,payload jsonb,created_by uuid);
 create table packaging_items(shipment_id uuid,order_line_id uuid);
 create table inventory(quantity int);insert into inventory values(5);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261009060000_fulfillment_payment_safety.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261009061000_fulfillment_safety_observations.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
beforeEach(async()=>{await db.exec(`reset role;select set_config('test.actor','${id(9)}',false);select set_config('test.access','yes',false);truncate ebay_fulfillment_safety_events,packaging_events,ebay_orders,ebay_order_lines,ebay_order_label_events,packaging_shipments,packaging_items;update inventory set quantity=5;
 insert into ebay_orders values('${id(1)}','01-12345-12345','pending','{"orderPaymentStatus":"PAID","orderCancelStatus":"NONE_REQUESTED"}',null);
 insert into ebay_order_lines values('${id(2)}','${id(1)}','Watch','pending',0,'{}');`);});
const block=async value=>db.query('update ebay_orders set raw_payload=$1 where id=$2',[JSON.stringify(value),id(1)]);
const fulfill=()=>db.exec(`update ebay_order_lines set line_status='fulfilled',fulfilled_quantity=1 where id='${id(2)}'`);
for(const payment of ['FULLY_REFUNDED','PARTIALLY_REFUNDED','REFUND_PENDING','UNPAID'])test(`${payment}: checkout and all new label writes are blocked`,async()=>{
 await block({orderPaymentStatus:payment,orderCancelStatus:'NONE_REQUESTED'});
 await assert.rejects(fulfill(),/Do not ship/);
 for(const action of ['attached','replaced','extra_label'])await assert.rejects(db.query('insert into ebay_order_label_events values($1,$2)',[[id(1)],action]),/Do not ship/);
 await assert.rejects(db.exec("update ebay_orders set label_file_path='new.pdf'"),/blocked/);
});
test('cancellation cannot be overridden by keep pending; stale checkout rolls inventory back',async()=>{
 await block({orderPaymentStatus:'PAID',orderCancelStatus:'IN_PROGRESS',cancellation_review:{decision:'keep_pending'}});
 await db.exec('begin;update inventory set quantity=quantity-1');await assert.rejects(fulfill(),/Cancellation/);await db.exec('rollback');
 assert.equal((await db.query('select quantity from inventory')).rows[0].quantity,5);
});
test('paid order and rejected cancellation remain shippable; later refunds do not rewrite history',async()=>{
 await block({orderPaymentStatus:'PAID',orderCancelStatus:'CANCEL_REJECTED'});await fulfill();
 await block({orderPaymentStatus:'FULLY_REFUNDED'});
 assert.equal((await db.query('select fulfilled_quantity from ebay_order_lines')).rows[0].fulfilled_quantity,1);
 await db.exec("update ebay_order_lines set item_title='Evidence correction'");
});
test('closed lines cannot be reopened as fulfilled',async()=>{
 await db.exec("update ebay_order_lines set line_status='cancelled'");await assert.rejects(fulfill(),/Item is cancelled/);
});
test('line refund blocks completion even while the order still says paid',async()=>{
 await db.exec(`update ebay_order_lines set raw_payload='{"orderPaymentStatus":"FULLY_REFUNDED"}'`);await assert.rejects(fulfill(),/Refund/);
});
test('package readiness and dispatch are rechecked against new refund status',async()=>{
 await fulfill();await db.exec(`insert into packaging_shipments(id,order_ids,status) values('${id(3)}',array['${id(1)}']::uuid[],'in_progress');insert into packaging_items values('${id(3)}','${id(2)}')`);
 await block({orderPaymentStatus:'FULLY_REFUNDED'});
 await assert.rejects(db.exec("update packaging_shipments set status='ready'"),/Do not ship/);
 await assert.rejects(db.exec("update packaging_shipments set status='dispatched'"),/Do not ship/);
 assert.equal((await db.query('select status from packaging_shipments')).rows[0].status,'on_hold');
 assert.equal((await db.query('select count(*)::int n from packaging_events')).rows[0].n,1);
 await block({orderPaymentStatus:'FULLY_REFUNDED',unrelated_note:'Update'});
 assert.equal((await db.query('select count(*)::int n from ebay_fulfillment_safety_events')).rows[0].n,1);
});

test('label preflight also catches a cancelled sibling outside the selected browser page',async()=>{
 await db.exec(`insert into ebay_order_lines values('${id(4)}','${id(1)}','Other item','cancelled',0,'{}')`);
 const rows=(await db.query('select check_ebay_fulfillment_allowed($1) result',[[id(2)]])).rows[0].result;
 assert.equal(rows.length,1);assert.equal(rows[0].line_id,id(4));
});

test('finance refund blocks a still-paid order; payout holds and failed refunds alone do not',async()=>{
 await block({orderPaymentStatus:'PAID',ebayFinance:{transactions:[{transactionType:'REFUND',transactionStatus:'FUNDS_AVAILABLE'}]}});await assert.rejects(fulfill(),/Finances/);
 await block({orderPaymentStatus:'PAID',ebayFinance:{transactions:[{transactionType:'SALE',transactionStatus:'FUNDS_ON_HOLD'},{transactionType:'REFUND',transactionStatus:'FAILED'}]}});await fulfill();
});
test('label preflight is staff-only and refuses missing IDs',async()=>{
 await db.exec("select set_config('test.access','no',false)");await assert.rejects(db.query('select check_ebay_fulfillment_allowed($1)',[[id(2)]]),/access required/);
 await db.exec("select set_config('test.access','yes',false)");await assert.rejects(db.query('select check_ebay_fulfillment_allowed($1)',[[id(4)]]),/no longer exists/);
});
test('historical service import records external facts without performing a local checkout',async()=>{
 await block({orderPaymentStatus:'FULLY_REFUNDED'});await db.exec("select set_config('test.actor','',false)");await fulfill();
 assert.equal((await db.query('select quantity from inventory')).rows[0].quantity,5);
});
