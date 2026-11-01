import {test} from 'node:test';
import assert from 'node:assert/strict';
import {earningsWindow,earningRow,day} from '../supabase/functions/ebay-weekly-earnings/model.ts';
test('imports the official earnings without deducting an included fee or label twice',()=>{
 const at='2026-11-01T04:00:00Z',order={orderId:'01-12345-67890',orderCreationDate:at,orderEarningsSummary:{orderEarnings:{currency:'USD',value:'-8.21'},expenses:{currency:'USD',value:'8.21',shippingLabels:{currency:'USD',value:'6.00'}},refunds:{currency:'USD',value:'60.00'}}};
 assert.equal(earningRow(order,at).earnings,-8.21);assert.equal(earningRow(order,at).labels,6);assert.equal(earningRow({...order,orderEarningsSummary:{}},at),null);
 const w=earningsWindow({},Date.parse(at));assert.equal(w.end-w.start,7*day);assert.equal(w.end-w.stop,93*day);
});
