import {test} from 'node:test';
import assert from 'node:assert/strict';
import {returnFacts} from '../supabase/functions/tiktok-order-sync/weekly-sales.ts';
import {financialRows,syncWeeklyWhatnot} from '../supabase/functions/whatnot-order-sync/weekly-sales.ts';
test('TikTok uses the merchandise component only after a refund succeeds',()=>{
 const sale={return_id:'123456789012',order_id:'234567890123',update_time:1770000000,return_type:'REFUND',return_status:'RETURN_OR_REFUND_REQUEST_PENDING',refund_amount:{currency:'USD',refund_total:'62.20',refund_subtotal:'50.00'}};
 assert.equal(returnFacts(sale).state,'pending');assert.equal(returnFacts(sale).item_amount,null);
 const paid={...sale,return_status:'RETURN_OR_REFUND_REQUEST_COMPLETE'};assert.equal(returnFacts(paid).item_amount,50);
 assert.equal(returnFacts({...paid,refund_amount:{currency:'USD',refund_total:'62.20'}}).item_amount,null);
 assert.equal(returnFacts({...paid,return_type:'EXCHANGE'}).state,'inactive');
});
test('Whatnot sends UTC milliseconds for saved Postgres statement cursors',async()=>{
 const feed={market:'whatnot',state:'loading',through_at:'2026-09-24T00:00:00+00:00',progress:{coverage_start:'2026-09-24T00:00:00Z'}};
 const db={from:()=>({select:()=>({eq:()=>({single:async()=>({data:feed})})})}),rpc:async()=>({})};
 let request;
 await syncWeeklyWhatnot(db,{read:async(_path,_query,body)=>{request=body.report_parameters;return {id:'00000000-0000-0000-0000-000000000001',report_type:'seller_financial_report',status:'pending'};}});
 assert.equal(request.start_date,'2026-09-24T00:00:00.000Z');assert.equal(request.end_date,'2026-10-01T00:00:00.000Z');
});
test('Whatnot ledger preserves signed amounts and flags refunds without inventing an item allocation',()=>{
 const csv='ledger_transaction_id,order_id,transaction_amount,transaction_currency,transaction_type,transaction_message,transaction_completed_at_utc\n1,112,50,USD,ORDER_EARNINGS,"ring, order",2026-10-04\n2,112,-12.51,USD,REFUND,"partial",2026-10-10\n3,112,25,USD,PAYOUT,payout,2026-10-10';
 const r=financialRows(csv,'2026-10-11T00:00:00Z');assert.deepEqual(r.settlements.map(x=>x.amount),[50,-12.51]);
 assert.equal(r.refunds[0].item_amount,null);assert.equal(r.refunds[0].external_id,'2');assert.throws(()=>financialRows(csv+'\n2,112,-12,USD,REFUND,repeat,2026-10-10','2026-10-11T00:00:00Z'),/identity/);
});
