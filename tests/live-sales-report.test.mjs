import assert from 'node:assert/strict';
import {test} from 'node:test';
import M from '../live-sales-report-model.js';
const settings={rates:{gold_10:30,gold_14:42,silver:1.25},fee_percent:10,fee_fixed:1,shipping_per_sale:5};
test('title parser uses explicit purity or the requested 10K assumption',()=>{
  assert.deepEqual(M.parseTitle('Gold necklace 12.5 g'),{material:'gold',grams:12.5,purity:10,assumed:true,ambiguous:false,note:'10K gold assumed because purity is not specified.'});
  assert.equal(M.costFor({listing_title:'14kt gold 2 grams'}, {},settings).base,8400);
  assert.equal(M.costFor({listing_title:'925 sterling silver 10g'}, {},settings).base,1250);
  assert.equal(M.costFor({listing_title:'Gold 5gr'}, {},settings).base,15000);
});
test('ambiguous, plated, missing and invalid title information never becomes a zero cost',()=>{
  for(const title of ['Watch','Gold ring','10g bracelet','Gold 5-10g','Gold 5 to 10g','Gold 5,5g','Gold 1/2 grams','Gold 5g silver 3g','Gold plated 5g','Gold colored 5g','Gold filled 5g','14k 18k 5g','30k gold 5g','Gold 5g + 2g','Gold 5g + 5g','Gold -5g','Gold .5g']){
    assert.equal(M.costFor({listing_title:title},{},settings).base,null,title);
  }
  assert.equal(M.costFor({listing_title:'18k gold 2g'},{},settings).base,null);
});
test('manual total costs, including explicit zero, take priority and metal corrections are explicit',()=>{
  assert.equal(M.costFor({listing_title:'Gold 5g'},{mode:'manual',base_cost:0},settings).base,0);
  assert.equal(M.costFor({listing_title:'Gold 5g'},{mode:'manual',base_cost:37.19},settings).base,3719);
  assert.equal(M.costFor({listing_title:'Unknown'},{mode:'metal',material:'silver',grams:2.5},settings).base,313);
});
test('paid totals exclude held, merged, resolved and unpaid attempts; margin shows cost coverage',()=>{
  const attempts=[{id:'1',buyer:'Alice',amount:100,payment_state:'paid',listing_title:'Gold 2g'},
    {id:'2',buyer:'alice',amount:50,payment_state:'waiting'},{id:'3',buyer:'bob',amount:200,payment_state:'failed'},
    {id:'4',buyer:'bob',amount:70,payment_state:'paid',payment_hold:true},{id:'5',buyer:'bob',amount:300,payment_state:'paid',resolved_at:'2026-10-01'},
    {id:'6',buyer:'alice',amount:100,payment_state:'paid',merged_into:'1'},{id:'7',buyer:'alice',amount:20,payment_state:'paid'}];
  const model=M.makeModel({attempts,settings,evidence:{'1':{order:{buyer_name:'Alice Example'},line:{quantity:2}}}});
  assert.equal(model.rows.length,6);assert.equal(model.customers.length,2);assert.equal(model.customers[0].name,'Alice Example');
  assert.deepEqual(model.stats.paid,{count:2,amount:12000});assert.equal(model.stats.expectedItems,3);
  assert.equal(model.stats.missingCosts,1);assert.equal(model.stats.pricedPaid,1);assert.equal(model.stats.base,6000);assert.equal(model.stats.margin,4000);assert.equal(model.stats.profit,2400);
});
test('blank expenses stay unknown, zero is known, unknown amount is not inferred',()=>{
  const a={id:'1',buyer:'A',amount:10,payment_state:'paid'},costs={'1':{mode:'manual',base_cost:2}};
  assert.equal(M.makeModel({attempts:[a],costs}).rows[0].profit,null);
  const m=M.makeModel({attempts:[a,{...a,id:'2',amount:null}],costs,settings:{fee_percent:0,fee_fixed:0,shipping_per_sale:0}});
  assert.equal(m.rows[0].profit,800);assert.equal(m.stats.missingAmounts,1);assert.equal(m.stats.paid.amount,1000);
});
test('payment holds do not disguise recorded failures or pending payments',()=>{
  const m=M.makeModel({attempts:[{id:'1',amount:10,payment_state:'failed',payment_hold:true},{id:'2',amount:20,payment_state:'waiting',payment_hold:true},{id:'3',amount:30,payment_state:'paid',payment_hold:true}]});
  assert.deepEqual(m.stats.failed,{count:1,amount:1000});assert.deepEqual(m.stats.waiting,{count:1,amount:2000});assert.deepEqual(m.stats.paid,{count:0,amount:0});assert.deepEqual(m.stats.review,{count:1,amount:3000});
});
test('buyer anchors are safe and system links use real order numbers and correct page',()=>{
  const m=M.makeModel({attempts:[{id:'1',buyer:'A % é',amount:10,payment_state:'paid'}],evidence:{'1':{order:{id:'uuid',order_number:'01-12345-12345',status:'fulfilled'},line:{id:'line'}}}});
  assert.match(m.customers[0].key,/^buyer-[a-f0-9-]+$/);
  const url=new URL(m.rows[0].links.find(([label])=>label==='System order')[1]);assert.equal(url.pathname,'/Invsto/ebay-order-history.html');assert.equal(url.searchParams.get('focusOrder'),'01-12345-12345');
});
