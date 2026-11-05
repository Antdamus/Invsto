import assert from 'node:assert/strict';
import {test} from 'node:test';
import selection from '../ebay-customer-selection.js';
import report from '../ebay-customer-report.js';
function records(){return {orders:[{id:'o',order_number:'01-12345-12345',buyer_username:'test',status:'fulfilled',sale_date:'2026-10-01T12:00:00Z',total_price:1026,raw_payload:{order:{orderPaymentStatus:'PAID',orderFulfillmentStatus:'FULFILLED',pricingSummary:{total:{value:'1026',currency:'USD'}},paymentSummary:{refunds:[]},lineItems:[{legacyItemId:'watch',lineItemCost:{value:'825'},total:{value:'826'},ebayCollectAndRemitTaxes:[{amount:{value:'49.50'}}]},{legacyItemId:'bracelet',lineItemCost:{value:'199'},total:{value:'200'},ebayCollectAndRemitTaxes:[{amount:{value:'11.94'}}]}]}}}],lines:[{id:'w',order_id:'o',item_number:'watch',item_title:'Watch',sold_for:825,line_status:'fulfilled'},{id:'b',order_id:'o',item_number:'bracelet',item_title:'Silver bracelet',sold_for:199,line_status:'fulfilled'}],returnCases:[],events:[],adminEvents:[]};}
function model(r,params='orders=01-12345-12345&excludeItems=bracelet'){const chosen=selection.select(r,new URLSearchParams(params));return selection.attach(report.makeModel('test',chosen.records,'all','https://example.test/'),chosen);}
test('selected mixed order excludes sibling price, shipping, tax and details',()=>{const m=model(records());assert.equal(m.count,1);assert.equal(m.selection.item,82500);assert.equal(m.selection.shipping,100);assert.equal(m.selection.tax,4950);assert.equal(m.selection.net,82500);assert.equal(m.selection.paid,87550);const html=report.render(m);assert.doesNotMatch(html,/Silver bracelet|1,026|Lifetime purchase summary/);assert.match(html,/Selected purchase summary/);assert.equal(m.rows[0].refund.gross.cents,82600);});
test('unknown selected IDs fail rather than silently broadening report',()=>{assert.throws(()=>model(records(),'orders=missing'),/not saved/);assert.throws(()=>model(records(),'lines=missing'),/no longer available/);assert.throws(()=>model(records(),'excludeItems=watch,bracelet'),/Choose at least/);});
test('partial order refund never guesses the amount assigned to selected sibling',()=>{const r=records();r.orders[0].raw_payload.order.paymentSummary.refunds=[{refundReferenceId:'r1',refundStatus:'REFUNDED',amount:{value:'100',currency:'USD'}}];const m=model(r);assert.equal(m.selection.net,null);assert.equal(m.selection.deducted,null);assert.equal(m.rows[0].refund.netCents,null);assert.equal(m.rows[0].refund.unknown,true);});
test('full refunds reduce the selected items only and duplicate selection IDs do not inflate totals',()=>{const r=records();r.orders[0].raw_payload.order.orderPaymentStatus='FULLY_REFUNDED';const m=model(r,'lines=w,w');assert.equal(m.selection.net,0);assert.equal(m.selection.deducted,82500);assert.equal(m.count,1);});
test('case amounts from other orders cannot contaminate the selection',()=>{const r=records();r.returnCases=[{id:'unrelated',order_id:'elsewhere',order_number:'other'}];const chosen=selection.select(r,new URLSearchParams('lines=w'));assert.equal(chosen.records.returnCases.length,0);});
test('foreign currency selections cannot be silently totaled as dollars',()=>{const r=records();r.orders[0].raw_payload.order.lineItems[0].lineItemCost.currency='EUR';assert.throws(()=>model(r),/require USD/);});
test('only the matching item shipment is added, in chronological order',()=>{const m=model(records());selection.shipping(m,{results:[{orderNumber:'01-12345-12345',lineItems:[{legacyItemId:'watch',lineItemId:'w-api'},{legacyItemId:'bracelet',lineItemId:'b-api'}],fulfillments:[{lineItems:[{lineItemId:'w-api'}],shipmentTrackingNumber:'watch-tracking',shippedDate:'2026-10-02T12:00:00Z'},{lineItems:[{lineItemId:'b-api'}],shipmentTrackingNumber:'bracelet-tracking',shippedDate:'2026-10-03T12:00:00Z'}]}]});assert.match(JSON.stringify(m.rows[0].timeline),/watch-tracking/);assert.doesNotMatch(JSON.stringify(m.rows[0].timeline),/bracelet-tracking/);assert.deepEqual(m.rows[0].timeline.map(e=>e.at),m.rows[0].timeline.map(e=>e.at).sort((a,b)=>a-b));});

function refunded(){
 const r=records();r.orders[0].raw_payload.order.orderPaymentStatus='PARTIALLY_REFUNDED';
 r.orders[0].raw_payload.order.paymentSummary.refunds=[{refundReferenceId:'return-1',refundStatus:'REFUNDED',amount:{value:'800',currency:'USD'}}];
 r.returnCases=[{id:'case-1',order_id:'o',buyer_username:'test',source_lane:'return',ebay_return_id:'return-1',ebay_status:'CLOSED',raw_payload:{ebayDetail:{returnId:'return-1',itemDetail:{itemId:'watch'},refundInfo:{actualRefundDetail:{actualRefund:{totalAmount:{value:825,currency:'USD'},itemizedRefundDetail:[{refundFeeType:'PURCHASE_PRICE',refundAmount:{value:824,currency:'USD'}},{refundFeeType:'ORIGINAL_SHIPPING',refundAmount:{value:1,currency:'USD'}}]},netChargeAmount:{value:800,currency:'USD'}}}}}}];
 r.returnCases[0].raw_payload.ebayDetail.moneyMovementInfo=[{status:'SUCCESS',moneyMovementType:'PAYPAL_PARTIAL_REFUND',actualAmount:{value:874.44,currency:'USD'},creationDate:{value:'2026-11-05T03:00:00Z'}}];
 return r;
}
test('exact return evidence reconciles the seller debit without exposing it to the customer',()=>{
 const m=model(refunded(),'lines=w&amounts=auction&audience=customer');
 assert.equal(m.selection.deducted,82400);assert.equal(m.selection.net,100);
 assert.equal(m.selection.buyerRefund,87444);assert.equal(m.selection.buyerPaidAfterRefund,106);
 assert.equal(m.rows[0].refund.itemRefundConfirmed,true);assert.equal(m.rows[0].notes.length,0);
 const html=report.render(m);
 assert.match(html,/Auction winning amount/);assert.match(html,/\$874\.44/);
 assert.doesNotMatch(html,/\$800\.00|fee|proceeds|profit|System record|ebay-returns\.html|System case|netChargeAmount/i);
 assert.match(html,/Return return-1/);assert.match(html,/Refund completed Nov 4, 2026/);
});
test('duplicate return records are counted once',()=>{const r=refunded();r.returnCases.push({...r.returnCases[0],id:'duplicate'});assert.equal(model(r).selection.deducted,82400);});
test('unmatched seller debit, buyer identity conflict and inconsistent parts stay unverified',()=>{
 for(const corrupt of [r=>r.orders[0].raw_payload.order.paymentSummary.refunds[0].refundReferenceId='other',r=>r.orders[0].raw_payload.order.paymentSummary.refunds[0].amount.value='799',r=>r.returnCases[0].buyer_username='another-buyer',r=>r.returnCases[0].raw_payload.ebayDetail.refundInfo.actualRefundDetail.actualRefund.itemizedRefundDetail[0].refundAmount.value=823]){
  const r=refunded();corrupt(r);assert.equal(model(r).selection.net,null);
 }
});
test('refunds assigned to an excluded sibling do not reduce the selected item',()=>{const r=refunded();const m=model(r,'lines=b&audience=customer');assert.equal(m.selection.net,19900);assert.equal(m.selection.buyerRefund,0);assert.doesNotMatch(report.render(m),/874\.44|return-1/);});
test('unverified buyer tax refund never becomes zero or a fabricated amount',()=>{const r=refunded();r.returnCases[0].raw_payload.ebayDetail.moneyMovementInfo[0].status='FAILED';const m=model(r,'lines=w&audience=customer');assert.equal(m.selection.net,100);assert.equal(m.selection.buyerRefund,null);});
test('auction wording and customer privacy apply only to the requested edition',()=>{const ordinary=model(records());assert.equal(ordinary.clientFacing,false);assert.equal(ordinary.amountLabel,undefined);const client=model(records(),'lines=w&amounts=auction&audience=customer');assert.equal(client.clientFacing,true);assert.doesNotMatch(report.render(client),/fee|proceeds|profit/i);});
