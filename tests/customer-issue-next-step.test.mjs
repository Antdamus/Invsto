import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const sandbox={};
vm.runInNewContext(await readFile(new URL('../customer-issues.js',import.meta.url),'utf8'),sandbox);
const {nextText}=sandbox.OGCustomerIssues.testing;
const payment={source_lane:'payment_dispute',issue_kind:'dispute',order_id:'order',status:'open',next_user:'admin',open_tasks:1,ebay_action:'2026-10-14T06:59:59.000Z'};
test('payment response deadlines do not become next-step instructions',()=>{
 assert.equal(nextText({...payment,ebay_status:'ACTION_NEEDED'}),'Respond to the payment dispute');
 assert.equal(nextText({...payment,ebay_status:'OPEN'}),'Monitor payment-dispute updates');
});
test('closed disputes preserve internal follow-up and outcome review',()=>{
 assert.equal(nextText({...payment,ebay_status:'CLOSED'}),'Finish internal follow-up');
 assert.equal(nextText({...payment,ebay_status:'CLOSED',open_tasks:0}),'Review the case outcome');
});
test('unlinked orders and ordinary return actions keep their existing priority',()=>{
 assert.equal(nextText({...payment,ebay_status:'ACTION_NEEDED',order_id:null}),'Match the order');
 assert.equal(nextText({...payment,source_lane:'return',issue_kind:'return',ebay_status:'OPEN',ebay_action:'SELLER_ISSUE_REFUND'}),'Seller issue refund');
 assert.equal(nextText({...payment,source_lane:'case',ebay_status:'OPEN'}),'Continue assigned work');
});

test('quick review keeps unknown prices distinct from zero and escapes buyer-provided values',()=>{
 const {money,cardFacts,conversationRows}=sandbox.OGCustomerIssues.testing;
 assert.equal(money({item_value:null}),'Not available');assert.equal(money({item_value:0,item_currency:'USD'}),'$0.00');
 assert.ok(!cardFacts({item_value:25,item_currency:'<img>'}).includes('<img>'));
 const rows=conversationRows({case_messages:[{direction:'inbound',message_body:'Case question',sent_at:'2026-10-01'},{direction:'internal',message_body:'Staff note',sent_at:'2026-10-04'},{direction:'outbound',message_status:'failed',sent_at:'2026-10-05'}],buyer_messages:[{direction:'outbound',message_body:'New reply',created_at_ebay:'2026-10-03'}]});
 assert.equal(rows.length,2);assert.equal(rows[0].message_body,'New reply');assert.equal(rows[1].channel,'eBay case');
});
