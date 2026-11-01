import {test} from 'node:test';
import assert from 'node:assert/strict';
import {syncWeeklySaleUpdates} from '../supabase/functions/ebay-order-sync/weekly-sale-updates.ts';
const from='2026-10-01T00:00:00.000Z',until='2026-10-08T00:00:00.000Z';
function state(writes){
 return {from:()=>({select:()=>({eq:()=>({single:async()=>({data:{through_at:from,window_end:until,next_at:from}})})})}),
  rpc:async(_name,body)=>{writes.push(body);return {};}};
}
test('a change to an already shipped order is captured once without buyer data or a fulfillment filter',async()=>{
 const writes=[],paths=[];
 const order={orderId:'11-12345-67890',lastModifiedDate:'2026-10-02T01:00:00Z',orderFulfillmentStatus:'FULFILLED',orderPaymentStatus:'FULLY_REFUNDED',buyer:{username:'private'},paymentSummary:{refunds:[{refundId:'r1',refundStatus:'REFUNDED',amount:{currency:'USD',value:'100.00'}}]}};
 await syncWeeklySaleUpdates(state(writes),'lease',async path=>{paths.push(path);return paths.length===1?{total:300,orders:[],next:'next'}:{total:1,orders:[order]};});
 assert.equal(paths.length,2);assert.doesNotMatch(paths[0],/fulfillmentstatus/i);assert.match(decodeURIComponent(paths[1]),/lastmodifieddate/);
 assert.equal(writes.length,1);assert.equal(writes[0]._advance,true);assert.equal(writes[0]._orders[0].changes.refunds[0].amount.value,'100.00');
 assert.doesNotMatch(JSON.stringify(writes[0]),/private|FULFILLED/);
});
test('an incomplete page does not advance past a potentially missing refund',async()=>{
 const writes=[];await syncWeeklySaleUpdates(state(writes),'lease',async()=>({total:2,orders:[]}));
 assert.equal(writes[0]._advance,false);assert.equal(writes[0]._error,true);
});
