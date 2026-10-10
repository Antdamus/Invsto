import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';

const source = await readFile(new URL('../pending-orders.js', import.meta.url), 'utf8');
const line = (id, number, buyer = 'buyer-one', extra = {}) => ({id, order_id:`order-${number}`, quantity:1,
  fulfilled_quantity:0, line_status:'pending', order:{order_number:number,buyer_username:buyer}, ...extra});
function fixture(lines) {
  const launches=[], checks=[], messages=[];
  const ctx = vm.createContext({console,URL,URLSearchParams,document:{addEventListener(){}},
    window:{location:{href:'https://antdamus.github.io/Invsto/pending-orders.html'},addEventListener(){},open(url){const launch={initial:url,closed:false};launches.push(launch);
      return {opener:null,location:{replace(value){launch.url=value;}},close(){launch.closed=true;}};}},
    supabase:{async rpc(name,args){checks.push({name,args});return {data:[]};}}});
  vm.runInContext(source,ctx);
  ctx.stateRef=vm.runInContext('state',ctx);ctx.stateRef.orders=lines;ctx.stateRef.filteredOrders=lines.slice(0,1);
  ctx.setStatus=(message,tone)=>messages.push({message,tone});
  return {ctx,launches,checks,messages};
}
const numbers = f => new URL(f.launches.at(-1).url).searchParams.get('t')?.split(',');

test('one selected/filtered line launches all eligible orders for that buyer, with no single-label route',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','11-22222-44444'),line('c','22-33333-55555','other')]);
  await f.ctx.openEbayLabelPagesForLines([f.ctx.stateRef.orders[0]]);
  assert.deepEqual(numbers(f),['11-22222-33333','11-22222-44444']);
  assert.deepEqual([...f.checks[0].args._line_ids],['a','b']);
  assert.match(f.messages.at(-1).message,/Combine orders per buyer/);
  assert.equal(f.ctx.stateRef.adminSelectedLineIds.size,0,'shipping scope does not change checkout selection');
});

test('customer action needs no checkboxes; direct detail and order-number routes cannot bypass combining',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','11-22222-44444')]);
  f.ctx.stateRef.selectedLine=f.ctx.stateRef.orders[0];
  await f.ctx.openSelectedEbayLabelPage();
  await f.ctx.openBuyerGroupSelectedEbayLabelPages({lines:[f.ctx.stateRef.orders[0]]});
  await f.ctx.openEbayLabelPagesForOrderNumbers(['11-22222-33333']);
  assert.equal(f.launches.length,3);
  for(const launch of f.launches) assert.equal(launch.url,'https://www.ebay.com/ship/bulk?t=11-22222-33333,11-22222-44444');
});

test('two item lines in the same order stay in combined flow, without duplicate order numbers',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','11-22222-33333')]);
  await f.ctx.openEbayLabelPagesForOrderNumbers(['11-22222-33333']);
  assert.deepEqual(numbers(f),['11-22222-33333']);
  assert.equal(f.ctx.getShippingLabelAction(f.ctx.getBuyerShippingLabelLines(f.ctx.stateRef.orders[0])).combined,true);
});

test('single eligible item still opens a normal label and skips closed, refunded and cancelled sibling orders',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','11-22222-44444','buyer-one',{line_status:'fulfilled',fulfilled_quantity:1}),
    line('c','11-22222-55555','buyer-one',{line_status:'cancelled'}),line('d','11-22222-66666')]);
  f.ctx.stateRef.orders[3].order.raw_payload={orderPaymentStatus:'FULLY_REFUNDED'};
  await f.ctx.openEbayLabelPagesForLines([f.ctx.stateRef.orders[0]]);
  assert.equal(f.launches[0].url,'https://www.ebay.com/ship/single/11-22222-33333');
  assert.deepEqual([...f.checks[0].args._line_ids],['a']);
});

test('batch of different buyers expands each buyer separately and never pulls an unrelated customer',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','11-22222-44444'),line('c','22-33333-55555','other'),
    line('d','22-33333-66666','other'),line('e','33-44444-77777','unrelated')]);
  await f.ctx.openEbayLabelPagesForLines([f.ctx.stateRef.orders[0],f.ctx.stateRef.orders[2]]);
  assert.deepEqual(numbers(f),['11-22222-33333','11-22222-44444','22-33333-55555','22-33333-66666']);
});

test('missing buyer usernames do not combine unrelated orders',async()=>{
  const f=fixture([line('a','11-22222-33333',''),line('b','11-22222-44444','')]);
  await f.ctx.openEbayLabelPagesForLines([f.ctx.stateRef.orders[0]]);
  assert.equal(f.launches[0].url,'https://www.ebay.com/ship/single/11-22222-33333');
});

test('a missing sibling order number blocks a partial combined label',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','')]);
  await f.ctx.openEbayLabelPagesForLines([f.ctx.stateRef.orders[0]]);
  assert.equal(f.launches.length,0);assert.match(f.messages.at(-1).message,/missing its eBay order number/);
});

test('database eligibility failure closes the blank tab without opening eBay, including expanded orders',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','11-22222-44444')]);
  f.ctx.supabase.rpc=async(name,args)=>{f.checks.push({name,args});return {data:[{order_number:'11-22222-44444',reason:'Refund reported'}]};};
  await f.ctx.openEbayLabelPagesForLines([f.ctx.stateRef.orders[0]]);
  assert.deepEqual([...f.checks[0].args._line_ids],['a','b']);
  assert.equal(f.launches[0].closed,true);assert.equal(f.launches[0].url,undefined);
  assert.match(f.messages.at(-1).message,/Refund/);
});

test('blocked lines in a whole eBay order cannot slip through the expanded buyer scope',async()=>{
  const f=fixture([line('a','11-22222-33333'),line('b','11-22222-44444'),line('c','11-22222-44444','buyer-one',{line_status:'cancelled'})]);
  await f.ctx.openEbayLabelPagesForLines([f.ctx.stateRef.orders[0]]);
  assert.equal(f.launches[0].closed,true);assert.equal(f.launches[0].url,undefined);
});

test('extension safety payload exposes loaded state and refunds without combining unknown buyers',()=>{
  const f=fixture([line('a','11-22222-33333',''),line('b','11-22222-44444',''),line('c','22-33333-55555')]);
  f.ctx.stateRef.orders[2].order.raw_payload={orderPaymentStatus:'FULLY_REFUNDED'};
  assert.equal(f.ctx.buildEbayPendingPriorityPayload().shippingCheckReady,false);
  f.ctx.stateRef.ebayTransferReceiverReady=true;
  const payload=f.ctx.buildEbayPendingPriorityPayload();
  assert.equal(payload.shippingCheckReady,true);assert.equal(payload.priorities.length,3);
  const refund=payload.priorities.flatMap(group=>group.lines).find(line=>line.orderNumber==='22-33333-55555');
  assert.equal(refund.shippingEligible,false);assert.match(refund.shippingBlockReason,/refund/i);
});
