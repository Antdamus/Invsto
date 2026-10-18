import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const q=createRequire(import.meta.url)('../tiktok-order-queue.js');
const now=new Date('2026-10-18T02:30:00Z'); // Still Oct 17 in the shop's timezone.
const order=(id,buyer,date,extra={})=>({id,order_number:'57762364879664333'+id,buyer_username:buyer,ship_by_date:date,stage:'pending',marketplace_status:'To ship',order_amount:'25.68',created_time:'10/17/2026 11:48:52 AM',lines:[{quantity:1,title:'Gold ring',seller_sku:id,tracking_number:''}],documents:[],...extra});

test('audited reversals of shipped orders stay pending, while marketplace cancellations and new completions remain closed',()=>{
 const reopened=order('1','Alice',null,{marketplace_status:'Shipped',reopened_at:'2026-10-18T12:00:00Z'});
 assert.equal(q.closed(reopened),false);assert.equal(q.select([reopened]).length,1);
 assert.equal(q.closed({...reopened,marketplace_status:'Canceled'}),true);
 assert.equal(q.closed({...reopened,stage:'completed'}),true);
 assert.equal(q.closed({...reopened,reopened_at:null}),true);
});
test('shipping urgency uses New York calendar days, including UTC midnight and DST',()=>{
 assert.equal(q.calendarDate(now),'2026-10-17');assert.equal(q.urgency('2026-10-16',now).level,'overdue');assert.equal(q.urgency('2026-10-17',now).level,'today');assert.equal(q.urgency('2026-10-18',now).level,'tomorrow');assert.equal(q.urgency('2026-10-20',now).days,3);
 assert.equal(q.urgency('2026-11-01',new Date('2026-11-02T04:30:00Z')).level,'today');assert.equal(q.urgency('2026-03-08',new Date('2026-03-09T03:30:00Z')).level,'today');
});
test('unknown and invalid deadlines never imply an overdue order',()=>{for(const value of [null,'','bad','2026-02-30'])assert.equal(q.urgency(value,now).level,'unknown');assert.equal(q.day('2028-02-29')!==null,true);});
test('buyer grouping preserves companions across due, search and stage filters',()=>{
 const orders=[order('1','Alice','2026-10-16',{stage:'waiting'}),order('2','alice','2026-10-20'),order('3','Bob',null)];
 const due=q.select(orders,{due:'overdue',now});assert.equal(due.length,1);assert.equal(due[0].orders.length,2);assert.equal(due[0].waiting,1);assert.equal(q.select(orders,{term:orders[0].order_number,now})[0].orders.length,2);assert.equal(q.select(orders,{stage:'waiting',now})[0].orders.length,2);
});
test('partly verified groups report missing dates separately and count only label documents',()=>{const g=q.group([order('1','Alice','2026-10-17',{documents:[{kind:'packet'}]}),order('2','Alice',null,{documents:[{kind:'label'},{kind:'label'}]})],now)[0];assert.equal(g.unknown,1);assert.equal(g.shipBy,'2026-10-17');assert.equal(g.labelCount,1);assert.equal(q.select(g.orders,{due:'unknown',now}).length,1);});
test('shipped, canceled and dispatched records remain in TikTok history and out of the queue',()=>{const orders=[order('1','Alice','2026-10-16'),order('2','Alice','2026-10-16',{marketplace_status:'Shipped'}),order('3','Bob',null,{stage:'dispatched'}),order('4','Carol',null,{marketplace_status:'Canceled'})];assert.equal(q.select(orders,{now}).flatMap(g=>g.orders).length,1);assert.equal(q.select(orders,{history:true,due:'overdue',now}).flatMap(g=>g.orders).length,3);});
test('sorting uses source calendar values, puts unknown deadlines last and does not change order IDs',()=>{const a=order('1','Zoe',null,{created_time:'9/30/2026 11:59:00 PM'}),b=order('2','Amy','2026-10-18',{created_time:'10/01/2026 12:01:00 AM'});assert.equal(q.select([b,a],{now})[0].buyer,'Zoe');assert.equal(q.select([a,b],{sort:'due',now})[0].buyer,'Amy');assert.equal(q.select([a,b],{sort:'newest',now})[0].orders[0].order_number,b.order_number);});

test('a shipped export cannot hide inventory links still awaiting OG completion',()=>{
 const o=order('1','buyer','2026-10-17',{marketplace_status:'Shipped',lines:[{quantity:1,inventory:{quantity:1,consumed_quantity:0}}]});assert.equal(q.closed(o),false);
 o.lines[0].inventory.consumed_quantity=1;assert.equal(q.closed(o),true);o.lines[0].inventory.consumed_quantity=0;o.marketplace_status='Canceled';assert.equal(q.closed(o),true);
});
