import assert from 'node:assert/strict';
import {test} from 'node:test';
import refunds from '../buyer-report-refunds.js';
import report from '../ebay-buyer-report.js';
const order=(id='a',total=110)=>({id,order_number:`order-${id}`,total_price:total,raw_payload:{}});
const line=(id='la',orderId='a')=>({id,order_id:orderId,item_number:id,sold_for:100});
function request(overrides={}){
  return {id:'case-a',order_id:'a',order_number:'order-a',source_lane:'return',issue_kind:'return',ebay_return_id:'123',
    status:'closed',ebay_status:'CLOSED',opened_at:'2026-10-01T12:00:00Z',closed_at:'2026-10-05T12:00:00Z',
    ebay_return_items:[{order_line_id:'la'}],raw_payload:{ebayReturnId:'123',ebayDetail:{refundInfo:{actualRefundDetail:{
      refundStatus:'SUCCESS',actualRefund:{totalAmount:{value:110,currency:'USD'}},outstandingAmount:{value:0,currency:'USD'},
      refundIssuedDate:{value:'2026-10-04T12:00:00Z'}}}}},...overrides};
}
const records=(orders=[order()],returnCases=[],lines=[line()])=>({orders,returnCases,lines,adminEvents:[],events:[]});
test('completed refunds reduce net spending and preserve the original purchase price',()=>{
  const data=records(undefined,[request()]), model=refunds.model(data), rows=report.buildRows(data,'https://example.test/Invsto/ebay-buyer-report.html');
  assert.equal(model.totals[0].gross,11000);assert.equal(model.totals[0].refunds,11000);assert.equal(model.totals[0].net,0);
  assert.equal(rows[0].price.total,100);assert.match(model.orders[0].label,/Full refund completed/);
  assert.match(refunds.detailLines(rows[0].refund).join(' '),/Requested: Oct 1, 2026.*Issued: Oct 4, 2026/);
  assert.match(report.renderReport('buyer',data,rows),/NET SPENT AFTER REFUNDS/);
});
test('requests, failed attempts, returned items and internal closure alone never count as paid refunds',()=>{
  for(const change of [{raw_payload:{},status:'open',ebay_status:'RETURN_REQUESTED'},
    {raw_payload:{},received_at:'2026-10-04T12:00:00Z'},
    {raw_payload:{ebayReturnId:'123',ebayDetail:{refundInfo:{actualRefundDetail:{refundStatus:'PENDING',actualRefund:{totalAmount:{value:110,currency:'USD'}}}}}}},
    {raw_payload:{ebayReturnId:'123',ebayDetail:{refundInfo:{actualRefundDetail:{refundStatus:'FAILED',actualRefund:{totalAmount:{value:110,currency:'USD'}}}}}}}]){
    const f=refunds.model(records(undefined,[request(change)]));assert.equal(f.totals[0].refunds,0);assert.equal(f.totals[0].net,11000);
  }
});
test('partial refunds deduct only actual amounts and count once across grouped items and duplicate data sources',()=>{
  const o=order(), c=request();c.raw_payload.ebayDetail.refundInfo.actualRefundDetail.actualRefund.totalAmount.value=25;
  c.raw_payload.ebayDetail.refundInfo.actualRefundDetail.outstandingAmount.value=85;
  o.raw_payload.order={paymentSummary:{refunds:[{refundReferenceId:'r1',refundStatus:'REFUNDED',amount:{value:'25',currency:'USD'}}]}};
  const data=records([o],[c,c],[line(),line('lb')]), f=refunds.model(data);
  assert.equal(f.totals[0].refunds,2500);assert.equal(f.totals[0].net,8500);assert.equal(f.refundedOrders,1);
  assert.equal(refunds.forLine(f,line('lb'),'https://example.test').requests.length,0);
  assert.equal(refunds.forLine(f,line(),'https://example.test').requests.length,1);
});
test('seller net debits, partial-refund approvals and mismatched case payloads cannot invent buyer refund amounts',()=>{
  const o=order();o.raw_payload.ebayFinance={transactions:[{transactionId:'r',transactionType:'REFUND',amount:23.54}]};
  const f=refunds.model(records([o]));assert.equal(f.totals[0].refunds,0);assert.equal(f.totals[0].net,null);assert.equal(f.unverifiedOrders,1);
  const c=request();c.raw_payload.ebayDetail.returnId='different';
  assert.equal(refunds.caseRefund(c).state,'closed');assert.equal(refunds.caseRefund(c).cents,null);
});
test('unknown amounts, conflicting currencies and unmatched cases leave net spent unconfirmed',()=>{
  const c=request();delete c.raw_payload.ebayDetail.refundInfo.actualRefundDetail.actualRefund;
  assert.equal(refunds.model(records(undefined,[c])).totals[0].net,null);
  const foreign=request();foreign.raw_payload.ebayDetail.refundInfo.actualRefundDetail.actualRefund.totalAmount.currency='EUR';
  assert.equal(refunds.model(records(undefined,[foreign])).totals[0].net,null);
  assert.equal(refunds.model(records(undefined,[request({order_id:'other',order_number:'other'})])).totals[0].net,null);
});
test('only completed fulfillment refunds count and duplicate reference IDs are counted once',()=>{
  const o=order();const paid={refundReferenceId:'paid',refundStatus:'REFUNDED',amount:{value:20,currency:'USD'}};
  o.raw_payload.order={paymentSummary:{refunds:[paid,paid,{refundReferenceId:'pending',refundStatus:'PENDING',amount:{value:90,currency:'USD'}}]}};
  const f=refunds.model(records([o]));assert.equal(f.totals[0].refunds,2000);assert.equal(f.totals[0].net,9000);assert.equal(f.requestedOrders,1);
});
test('explicit full refund status zeroes the saved order total without treating fulfillment as a refund',()=>{
  const o=order();o.raw_payload.orderPaymentStatus='FULLY_REFUNDED';
  assert.equal(refunds.model(records([o])).totals[0].net,0);
  o.raw_payload={};o.status='fulfilled';assert.equal(refunds.model(records([o])).totals[0].net,11000);
});
test('manual item matching cannot leak a refund case onto another item',()=>{
  const c=request();c.raw_payload.manualOrderMatch={line_ids:['lb']};
  const f=refunds.model(records(undefined,[c],[line(),line('lb')]));
  assert.equal(refunds.forLine(f,line(),'https://example.test').requests.length,0);
  assert.equal(refunds.forLine(f,line('lb'),'https://example.test').requests.length,1);
});
test('case buyer mismatches are flagged and are not silently deducted for another buyer',()=>{
  const o=order();o.buyer_username='buyer-a';const c=request({buyer_username:'buyer-b'});
  const f=refunds.model(records([o],[c]));assert.equal(f.totals[0].refunds,0);assert.equal(f.totals[0].net,null);
  assert.match(f.orders[0].note,/different buyer usernames/);
});
test('failed seller ledger attempts do not reduce spent totals',()=>{
  const o=order();o.raw_payload.ebayFinance={transactions:[{transactionType:'REFUND',transactionStatus:'FAILED',amount:23.54}]};
  const f=refunds.model(records([o]));assert.equal(f.totals[0].net,11000);assert.equal(f.orders[0].label,'Refund failed');
});
test('a refund-record read failure cannot produce a clean zero-refund report',async()=>{
  const client={from(table){const q={select(){return q;},ilike(){return q;},in(){return q;},order(){return q;},
    async range(){return table==='ebay_return_cases'?{error:{message:'Refund records unavailable'}}:{data:[]};}};return q;}};
  await assert.rejects(()=>report.loadRecords(client,'buyer'),/Refund records unavailable/);
});
