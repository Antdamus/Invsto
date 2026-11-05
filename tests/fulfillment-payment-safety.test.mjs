import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import vm from 'node:vm';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create table auth.users(id uuid primary key,email text);insert into auth.users values('${id(9)}','manager@example.test');
 create function auth.jwt() returns jsonb language sql stable as $$select coalesce(nullif(current_setting('test.jwt',true),''),'{}')::jsonb$$;
 create function can_revert_order_fulfillment() returns boolean language sql stable as $$select auth.uid() is not null and current_setting('test.manager',true)='yes'$$;
 create function lock_shared_inventory() returns void language sql as $$select$$;
 create table ebay_orders(id uuid primary key,order_number text,status text,raw_payload jsonb default '{}',label_file_path text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_title text,line_status text,fulfilled_quantity int,raw_payload jsonb default '{}');
 create table ebay_order_label_events(order_ids uuid[],action text);
 create table packaging_shipments(id uuid primary key,order_ids uuid[],status text,revision int default 1,hold_reason text,updated_at timestamptz,created_by uuid);
 create table packaging_events(shipment_id uuid,request_id uuid,action text,notes text,payload jsonb,created_by uuid);
 create table packaging_items(shipment_id uuid,order_line_id uuid);
 create table inventory(quantity int);insert into inventory values(5);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261009060000_fulfillment_payment_safety.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261009061000_fulfillment_safety_observations.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261022020000_ebay_partial_refund_review.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261105191500_durable_partial_refund_approvals.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
beforeEach(async()=>{await db.exec(`reset role;set test.manager='yes';select set_config('test.jwt',jsonb_build_object('amr',jsonb_build_array(jsonb_build_object('method','password','timestamp',floor(extract(epoch from now())))))::text,false);select set_config('test.actor','${id(9)}',false);select set_config('test.access','yes',false);truncate ebay_partial_refund_approvals,ebay_fulfillment_safety_events,packaging_events,ebay_orders,ebay_order_lines,ebay_order_label_events,packaging_shipments,packaging_items;update inventory set quantity=5;
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

const partial=(amount=100)=>({orderPaymentStatus:'PAID',orderCancelStatus:'NONE_REQUESTED',ebayFinance:{transactions:[{transactionId:'refund-1',transactionType:'REFUND',transactionStatus:'FUNDS_AVAILABLE',amount}]}});
const review=async()=>(await db.query('select get_ebay_partial_refund_reviews($1) r',[[id(1)]])).rows[0].r[0];
const approve=async(snapshot,note='Verified $100 partial refund; ship the watch',confirmed=true)=>(await db.query('select approve_ebay_partial_refund($1,$2,$3,$4) r',[id(1),snapshot|| (await review()).snapshot,note,confirmed])).rows[0].r;

test('a signed partial-refund approval unlocks normal completion, labels and dispatch without rewriting refund facts',async()=>{
 const source=partial();await block(source);await assert.rejects(fulfill(),/Refund/);
 assert.equal((await review()).reviewable,true);const approved=await approve();
 assert.equal(approved.by,'manager@example.test');await fulfill();
 await db.exec("update ebay_orders set status='fulfilled',label_file_path='label.pdf'");
 await db.query('insert into ebay_order_label_events values($1,$2)',[[id(1)],'attached']);
 await db.exec(`insert into packaging_shipments(id,order_ids,status) values('${id(3)}',array['${id(1)}']::uuid[],'in_progress');insert into packaging_items values('${id(3)}','${id(2)}');update packaging_shipments set status='ready';update packaging_shipments set status='dispatched'`);
 assert.deepEqual((await db.query('select raw_payload from ebay_orders')).rows[0].raw_payload,source);
 assert.equal((await db.query('select count(*)::int n from ebay_partial_refund_approvals where revoked_at is null')).rows[0].n,1);
 assert.equal((await approve()).id,approved.id,'retry does not duplicate approval');
});

test('approval requires an active manager, recent password authentication, reason and explicit verification',async()=>{
 await block(partial());await db.exec("set test.manager='no'");await assert.rejects(approve(),/Only active/);
 await db.exec("set test.manager='yes';set test.jwt='{}'");await assert.rejects(approve(),/password/);
 for(const amr of [[{method:'token_refresh',timestamp:Math.floor(Date.now()/1000)}],[{method:'password',timestamp:Math.floor(Date.now()/1000)-600}],[{method:'password',timestamp:'invalid'}]]){
  await db.query("select set_config('test.jwt',$1,false)",[JSON.stringify({amr})]);await assert.rejects(approve(),/password/);
 }
 await db.query("select set_config('test.jwt',$1,false)",[JSON.stringify({amr:[{method:'password',timestamp:Math.floor(Date.now()/1000)}]})]);
 await assert.rejects(approve(null,'x'),/Record the refund amount/);await assert.rejects(approve(null,undefined,false),/Confirm/);
 await db.exec('set role authenticated');await assert.rejects(db.exec(`insert into ebay_partial_refund_approvals(order_id,snapshot,reason,approved_by,approved_by_email) values('${id(1)}','{}','forged','${id(9)}','forged')`),/permission denied/);
});

for(const status of ['FULLY_REFUNDED','REFUNDED','REFUND_PENDING','UNPAID','PARTIALLY_PAID'])test(`partial refund review cannot override ${status}`,async()=>{
 await block({...partial(),orderPaymentStatus:status});assert.equal((await review()).reviewable,false);await assert.rejects(approve(),/refund|Payment/i);await assert.rejects(fulfill(),/Do not ship/);
});

test('cancelled sibling and line-level full refund block order approval despite a paid order',async()=>{
 await block(partial());await db.exec(`insert into ebay_order_lines values('${id(4)}','${id(1)}','Other item','pending',0,'{"orderPaymentStatus":"FULLY_REFUNDED"}')`);
 await assert.rejects(approve(),/Full or pending/);
 await db.exec(`update ebay_order_lines set raw_payload='{"orderCancelStatus":"IN_PROGRESS"}' where id='${id(4)}'`);await assert.rejects(approve(),/Cancellation/);
 await db.exec(`update ebay_order_lines set raw_payload='{}',line_status='cancelled' where id='${id(4)}'`);await assert.rejects(approve(),/cancelled/);
});

test('changed refunds revoke approval and put an active package on hold; stale review cannot be signed',async()=>{
 await block(partial());const old=(await review()).snapshot;await approve(old);
 await db.exec(`insert into packaging_shipments(id,order_ids,status) values('${id(3)}',array['${id(1)}']::uuid[],'in_progress')`);
 await block(partial(200));assert.equal((await review()).approval,null);
 assert.ok((await db.query('select revoked_at from ebay_partial_refund_approvals')).rows[0].revoked_at);
 assert.equal((await db.query('select status from packaging_shipments')).rows[0].status,'on_hold');
 await assert.rejects(approve(old),/changed/);await assert.rejects(fulfill(),/Refund/);
 await approve();await fulfill();assert.equal((await db.query('select count(*)::int n from ebay_partial_refund_approvals')).rows[0].n,2);
});

test('new items and line refund changes revoke approval; unrelated poll timestamps retain it',async()=>{
 await block(partial());await approve();await block({...partial(),last_ebay_finance_sync_at:new Date().toISOString()});assert.ok((await review()).approval);
 await db.exec(`insert into ebay_order_lines values('${id(4)}','${id(1)}','Other item','pending',0,'{}')`);assert.equal((await review()).approval,null);
 await approve();await db.exec(`update ebay_order_lines set raw_payload='{"orderPaymentStatus":"FULLY_REFUNDED"}' where id='${id(4)}'`);
 assert.equal((await review()).approval,null);await assert.rejects(fulfill(),/Refund/);
});

test('explicit partial payment status can be reviewed; failed refund alone cannot',async()=>{
 await block({orderPaymentStatus:'PARTIALLY_REFUNDED'});await approve();await fulfill();
 await block({orderPaymentStatus:'PAID',ebayFinance:{transactions:[{transactionType:'REFUND',transactionStatus:'FAILED'}]}});
 assert.equal((await review()).reviewable,false);await assert.rejects(approve(),/No reviewable/);
});

const feedRefund = () => ({orderPaymentStatus:'PARTIALLY_REFUNDED',orderCancelStatus:'NONE_REQUESTED',
 order:{orderPaymentStatus:'PAID',paymentSummary:{refunds:[]}},ebayFinance:{transactions:[{
  transactionId:'finance-refund-1',transactionType:'REFUND',transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT',
  amount:8.46,currency:'USD',bookingEntry:'DEBIT',transactionDate:'2026-11-04T03:46:55.768Z',payoutId:'',
 }]}});
const receipt = () => ({refundId:'refund-1',refundReferenceId:'refund-1',amount:{value:'8.46',currency:'USD'},refundStatus:'REFUNDED',refundDate:'2026-11-04T03:46:54.705Z'});

test('daily sync can add/remove the delayed copy of an already approved shipping refund without hiding the order',async()=>{
 const initial=feedRefund();await block(initial);const approved=await approve();
 await db.exec(`insert into packaging_shipments(id,order_ids,status) values('${id(3)}',array['${id(1)}']::uuid[],'in_progress')`);
 for(let day=0;day<5;day++){
  const fresh=feedRefund();fresh.order.orderPaymentStatus='PARTIALLY_REFUNDED';
  fresh.order.paymentSummary.refunds=day%2===0?[receipt()]:[];
  fresh.ebayFinance.transactions[0].payoutId=`payout-${day}`;
  fresh.ebayFinance.transactions[0].memo=`Sync ${day}`;
  fresh.ebayFinance.transactions[0].transactionStatus='FUNDS_PAID_OUT';
  await block(fresh);
  assert.equal((await review()).approval.id,approved.id);
  assert.deepEqual((await db.query('select check_ebay_fulfillment_allowed($1) r',[[id(2)]])).rows[0].r,[]);
 }
 assert.equal((await db.query('select status from packaging_shipments')).rows[0].status,'in_progress');
 assert.equal((await db.query("select count(*)::int n from ebay_fulfillment_safety_events where source='partial_refund_approval_changed'")).rows[0].n,0);
 await fulfill();
});

test('a newly imported line copy of the same approved order refund is not a second refund',async()=>{
 const source=feedRefund();await block(source);const approved=await approve();
 await db.query('update ebay_order_lines set raw_payload=$1',[JSON.stringify({ebayFinance:source.ebayFinance})]);
 assert.equal((await review()).approval.id,approved.id);
});

for(const [name,change] of [
 ['different refund ID',p=>{p.ebayFinance.transactions[0].transactionId='new-refund';}],
 ['second equal refund',p=>{p.ebayFinance.transactions.push({...p.ebayFinance.transactions[0],transactionId:'second-refund'});}],
 ['different amount',p=>{p.order.paymentSummary.refunds=[{...receipt(),amount:{value:'9.46',currency:'USD'}}];}],
 ['same amount on another day',p=>{p.order.paymentSummary.refunds=[{...receipt(),refundDate:'2026-11-05T03:46:54.705Z'}];}],
 ['missing evidence date',p=>{p.order.paymentSummary.refunds=[{...receipt(),refundDate:null}];}],
 ['pending refund',p=>{p.order.paymentSummary.refunds=[{...receipt(),refundStatus:'PENDING'}];}],
 ['two summary refunds for one finance debit',p=>{p.order.paymentSummary.refunds=[receipt(),{...receipt(),refundId:'second-refund'}];}],
])test(`${name} still requires review even if another feed retains the old refund`,async()=>{
 await block(feedRefund());await approve();const changed=feedRefund();change(changed);await block(changed);
 assert.equal((await review()).approval,null);await assert.rejects(fulfill(),/Refund/);
});

test('browser and database agree on delayed evidence, reordered records and material changes',async()=>{
 const context=vm.createContext({window:{}});
 vm.runInContext(await readFile(new URL('../partial-refund-facts.js',import.meta.url),'utf8'),context);
 const source=feedRefund();await block(source);const original=(await review()).snapshot;
 for(const [name,modify,expected] of [
  ['delayed summary',p=>{p.order.paymentSummary.refunds=[receipt()];p.order.orderPaymentStatus='PARTIALLY_REFUNDED';},true],
  ['payout metadata',p=>{p.ebayFinance.transactions[0].payoutId='changed';p.ebayFinance.transactions[0].status='paid';},true],
  ['duplicate hydration',p=>{p.ebayFinance.transactions.push({...p.ebayFinance.transactions[0],payoutId:'new'});},true],
  ['new refund',p=>{p.ebayFinance.transactions[0].transactionId='new';},false],
  ['different amount',p=>{p.ebayFinance.transactions[0].amount=9;},false],
  ['full refund',p=>{p.orderPaymentStatus='FULLY_REFUNDED';},false],
 ]){
  const changed=feedRefund();modify(changed);await block(changed);const current=(await review()).snapshot;
  const sql=(await db.query('select ebay_partial_refund_snapshots_match($1,$2) same',[original,current])).rows[0].same;
  assert.equal(sql,expected,name);assert.equal(context.window.OGPartialRefundFacts.matches(original,current),expected,name);
 }
});

test('repair restores only the latest mistakenly expired approval and preserves the original signature',async()=>{
 await block(feedRefund());const original=await approve();
 await db.exec("update ebay_partial_refund_approvals set revoked_at=now(),revocation_reason='Order, refund, or cancellation facts changed'");
 const synced=feedRefund();synced.order.paymentSummary.refunds=[receipt()];synced.order.orderPaymentStatus='PARTIALLY_REFUNDED';await block(synced);
 const migration=await readFile(new URL('../supabase/migrations/20261105191500_durable_partial_refund_approvals.sql',import.meta.url),'utf8');
 const repair=migration.slice(migration.indexOf('with candidates as ('),migration.indexOf('\nrevoke all on function'));
 await db.exec(repair);const restored=(await review()).approval;
 assert.equal(restored.id,original.id);assert.equal(restored.at,original.at);assert.equal(restored.by,original.by);
 const audit=(await db.query('select snapshot,sync_restoration from ebay_partial_refund_approvals')).rows[0];
 assert.deepEqual(audit.snapshot.order.refunds,[]);assert.ok(audit.sync_restoration.previous_revoked_at);
 synced.ebayFinance.transactions[0].amount=50;await block(synced);await db.exec(repair);
 assert.equal((await review()).approval,null,'a real financial change cannot be restored automatically');
});
