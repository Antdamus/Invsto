import assert from 'node:assert/strict';
import {test} from 'node:test';
import M from '../live-sales-report-model.js';
import F from '../live-sales-report-finances.js';
const usd=value=>({value:String(value),currency:'USD'});
function fixture(price=53,shipping=1,tax=4.32,fee=3.51){
 const line={lineItemId:'line-1',legacyItemId:'123456789012',lineItemCost:usd(price),total:usd(price+shipping),deliveryCost:{shippingCost:usd(shipping),discountAmount:usd(9)},ebayCollectAndRemitTaxes:[{amount:usd(tax),collectionMethod:'NET'}]};
 return {attempts:[{id:'a',amount:price,buyer:'buyer',payment_state:'paid'}],costs:{a:{mode:'manual',base_cost:11}},evidence:{a:{line:{raw_payload:{line}},order:{id:'order',order_number:'07-15366-59131',updated_at:'2026-10-29T23:00:00Z',financials:{totalMarketplaceFee:fee==null?null:usd(fee),totalFeeBasisAmount:usd(price+shipping+tax),pricingSummary:{deliveryCost:usd(10),deliveryDiscount:usd(-9)},lineItems:[line]}}}}};
}
test('four verified eBay order fees and checkout bases; shipping discounts are not deducted twice',()=>{
 for(const [price,shipping,tax,fee,profit] of [[53,1,4.32,3.51,3949],[32,1,2.64,2.26,1974],[10,10,1.4,1.48,752],[199,10,14.84,12.61,18539]]){
  const r=M.makeModel(fixture(price,shipping,tax,fee)).rows[0];
  assert.equal(r.finance.source,'actual');assert.equal(r.finance.fee,Math.round(fee*100));assert.equal(r.finance.shipping,shipping*100);
  assert.equal(r.finance.basis,Math.round((price+shipping+tax)*100));assert.equal(r.profit,profit);assert.equal(r.finance.postage,null);
  assert.equal(M.itemProfit(r).label,'Profit');assert.match(M.itemProfit(r).basis,/before postage/);
 }
});
test('an early estimate automatically becomes actual, including known zero and custom estimates',()=>{
 const p=fixture(53,1,4.32,null);p.settings={fee_percent:10,fee_fixed:1};
 let m=M.makeModel(p);assert.equal(m.rows[0].finance.fee,683);assert.equal(m.rows[0].profit,3617);assert.equal(m.stats.estimatedFeeItems,1);
 p.evidence.a.order.financials.totalMarketplaceFee=usd(3.51);
 m=M.makeModel(p);assert.equal(m.rows[0].finance.fee,351);assert.equal(m.rows[0].profit,3949);assert.equal(m.stats.actualFeeItems,1);assert.equal(m.stats.estimatedFeeItems,0);
 p.evidence.a.order.financials.totalMarketplaceFee=usd(0);m=M.makeModel(p);assert.equal(m.rows[0].finance.source,'actual');assert.equal(m.rows[0].profit,4300);
 p.settings.shipping_per_sale=5;assert.equal(M.makeModel(p).rows[0].profit,3800);
});
test('default estimate includes checkout shipping and tax; raw NET tax is included once if fee basis absent',()=>{
 const p=fixture(53,1,4.32,null);assert.equal(M.makeModel(p).rows[0].finance.fee,351);
 delete p.evidence.a.order.financials.totalFeeBasisAmount;assert.equal(M.makeModel(p).rows[0].finance.fee,351);
 const line=p.evidence.a.order.financials.lineItems[0];line.total=usd(58.32);line.ebayCollectAndRemitTaxes[0].collectionMethod='GROSS';
 assert.equal(M.makeModel(p).rows[0].finance.fee,351);assert.equal(M.makeModel(p).rows[0].finance.revenue,5400);
});
test('multi-line fees allocate exact cents once, including lines outside the show and item order changes',()=>{
 const p=fixture(10,1,0,1.01),fin=p.evidence.a.order.financials;
 const second={...structuredClone(fin.lineItems[0]),lineItemId:'line-2',lineItemCost:usd(20),total:usd(21)};
 fin.lineItems.push(second);fin.totalFeeBasisAmount=usd(32);
 p.attempts.push({id:'b',amount:20,buyer:'buyer',payment_state:'paid'});p.costs.b={mode:'manual',base_cost:0};p.evidence.b={order:p.evidence.a.order,line:{raw_payload:{line:second}}};
 const m=M.makeModel(p);assert.deepEqual(m.rows.map(r=>r.finance.fee),[35,66]);assert.equal(m.stats.actualFees,101);assert.equal(m.stats.profit,1999);
 assert.equal(M.makeModel({...p,attempts:p.attempts.slice(0,1)}).stats.actualFees,35);
 fin.lineItems.reverse();assert.deepEqual(M.makeModel(p).rows.map(r=>r.finance.fee),[35,66]);
 delete fin.totalMarketplaceFee;const estimated=M.makeModel(p);assert.equal(estimated.stats.estimatedFees,206);assert.equal(estimated.rows.reduce((s,r)=>s+r.finance.shipping,0),200);
});
test('shipping fallback uses signed order discount, and unknown checkout stays visibly provisional',()=>{
 const p=fixture(53,1,4.32,null);delete p.evidence.a.order.financials.lineItems[0].deliveryCost;
 assert.equal(M.makeModel(p).rows[0].finance.shipping,100);
 delete p.evidence.a.order.financials.totalFeeBasisAmount;
 delete p.evidence.a.order.financials.lineItems[0].total;
 const partial=M.makeModel(p).rows[0];assert.equal(partial.finance.fee,351);assert.equal(partial.finance.basis,5832);
 const early=M.makeModel({attempts:p.attempts,costs:p.costs});assert.equal(early.rows[0].finance.fee,322);assert.equal(early.rows[0].finance.shipping,null);assert.equal(early.rows[0].finance.basisKnown,false);assert.match(early.rows[0].finance.caveat,/Shipping \/ tax/);
 assert.equal(early.stats.profit,3878);assert.equal(M.buyerProfit(early.stats).label,'Estimated profit');
});
test('foreign currency, malformed fees and unmapped multi-line orders do not become actual USD charges',()=>{
 const p=fixture();p.evidence.a.order.financials.totalMarketplaceFee={value:'3.51',currency:'CAD'};
 assert.equal(M.makeModel(p).rows[0].finance.source,'estimated');
 p.evidence.a.order.financials.totalMarketplaceFee=usd('invalid');assert.equal(M.makeModel(p).rows[0].finance.source,'estimated');
 p.evidence.a.order.financials.lineItems.push({...p.evidence.a.order.financials.lineItems[0],lineItemId:'line-2'});p.evidence.a.line={};
 const m=M.makeModel(p);assert.equal(m.rows[0].profit,null);assert.equal(m.stats.missingFees,1);assert.equal(M.buyerProfit(m.stats).amount,null);
 assert.equal(F.usd({value:'',currency:'USD'}),null);
});
test('unpaid and unknown base costs remain excluded; fee-only loss appears in buyer and category totals',()=>{
 const p=fixture(10,0,0,.85);p.costs.a.base_cost=10;
 let m=M.makeModel(p);assert.equal(m.rows[0].loss,85);assert.equal(M.buyerProfit(m.stats).amount,-85);
 for(const groups of Object.values(m.breakdowns))assert.equal(groups.reduce((s,g)=>s+g.stats.profit,0),-85);
 delete p.costs.a;m=M.makeModel(p);assert.equal(m.rows[0].profit,null);assert.equal(m.stats.actualFees,85);
 for(const payment_state of ['waiting','failed','review','cancelled']){p.attempts[0].payment_state=payment_state;m=M.makeModel(p);assert.equal(m.stats.actualFees,0);assert.equal(m.stats.profit,0);}
});
