import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const sandbox={};
vm.runInNewContext(await readFile(new URL('../customer-issue-evidence.js',import.meta.url),'utf8'),sandbox);
vm.runInNewContext(await readFile(new URL('../customer-issues.js',import.meta.url),'utf8'),sandbox);
const {nextText}=sandbox.OGCustomerIssues.testing;
const payment={source_lane:'payment_dispute',issue_kind:'dispute',order_id:'order',status:'open',next_user:'admin',open_tasks:1,ebay_action:'2026-10-14T06:59:59.000Z'};

test('escalated cases distinguish eBay review from an unknown or actionable open case',()=>{
 const {escalatedBadge,cardStatus,cardKind}=sandbox.OGCustomerIssues.testing;
 const c={...payment,source_lane:'case',ebay_return_id:'5388233234',ebay_status:'OPEN',ebay_action:null,provider_case:{caseId:'5388233234',caseType:'RETURN',nextSteps:[],sellerResponseDue:{},caseContentOnHold:false}};
 assert.equal(escalatedBadge(c).label,'eBay reviewing · no response needed');assert.equal(nextText(c),'Waiting for eBay’s decision');assert.equal(cardKind(c),'eBay case');
 const html=cardStatus(c);assert.ok(html.includes('eBay reviewing · no response needed'));assert.ok(!html.includes('Continue assigned work'));assert.ok(!html.includes('deadline not provided'));
 assert.equal(escalatedBadge({...c,provider_case:undefined}).label,'eBay case opened','OPEN alone cannot confirm no response needed');
 assert.equal(escalatedBadge({...c,provider_case:{...c.provider_case,caseId:'different'}}).label,'eBay case opened');
 assert.equal(escalatedBadge({...c,provider_case:{...c.provider_case,nextSteps:['SELLER_PROVIDE_INFO']}}).kind,'case_open');
 assert.equal(escalatedBadge({...c,ebay_due_at:'2026-10-11'}).kind,'case_open');
 assert.equal(escalatedBadge({...c,ebay_action:'SELLER_PROVIDE_INFO'}).kind,'case_open');
 assert.equal(escalatedBadge({...c,ebay_status:'ACTION_NEEDED'}).label,'eBay case · response required');
 assert.equal(escalatedBadge({...c,ebay_status:'REFUND_AGREED_BUT_FAILED'}).label,'Refund failed · review required');
 assert.equal(escalatedBadge({...c,ebay_status:'ON_HOLD'}).label,'eBay case · on hold');
 assert.equal(escalatedBadge({...c,provider_case:{...c.provider_case,caseContentOnHold:true}}).label,'eBay case · on hold');
 assert.equal(escalatedBadge({...c,ebay_status:'WAITING_DELIVERY'}).label,'eBay case · awaiting delivery');
 assert.equal(escalatedBadge({...c,ebay_status:'OTHER'}).label,'eBay case · check status');
 assert.equal(escalatedBadge({...c,ebay_status:'WAITING_CS'}).kind,'reviewing');
 assert.equal(escalatedBadge({...c,ebay_status:'CS_CLOSED'}),null);assert.ok(cardStatus({...c,ebay_status:'CS_CLOSED'}).includes('Closed on eBay'));
 assert.equal(escalatedBadge({...c,source_lane:'payment_dispute'}),null);assert.equal(c.status,'open');
 const detail={...c,provider_case:undefined,raw_payload:{ebayDetail:c.provider_case}};assert.equal(escalatedBadge(detail).kind,'reviewing');
});
test('return badges distinguish provider delivery from confirmed local receipt and preserve closed-case actions',()=>{
 const {returnBadge,cardStatus}=sandbox.OGCustomerIssues.testing,c={...payment,source_lane:'return',issue_kind:'return',ebay_status:'ITEM_DELIVERED',return_stage:'delivered'};
 assert.ok(returnBadge(c).includes('Delivered · eBay'));assert.ok(!returnBadge(c).includes('Received'));
 assert.equal(nextText(c),'Confirm receipt and inspect the returned items');
 assert.equal(nextText({...c,status:'closed',open_tasks:0}),'Closed · saved in History');
 assert.ok(returnBadge({...c,return_stage:'received'}).includes('Received in Invsto'));
 assert.ok(returnBadge({...c,return_stage:'in_transit'}).includes('In transit'));
 assert.ok(returnBadge({...c,return_stage:'awaiting_shipment'}).includes('Awaiting buyer shipment'));
 assert.ok(returnBadge({...c,return_stage:'<img>'}).includes('Shipment not reported'));
 assert.equal(returnBadge({...c,issue_kind:'dispute'}),'');
 assert.ok(cardStatus({...c,ebay_due_at:'2026-10-11T10:00:00Z',overdue:true}).includes('eBay deadline overdue'),'shipping badge does not suppress an actionable deadline');
});

test('return refund badges coexist with delivery and do not claim pending or partial refunds are complete',()=>{
 const {returnBadge}=sandbox.OGCustomerIssues.testing,c={...payment,source_lane:'return',issue_kind:'return',ebay_status:'ITEM_DELIVERED',return_stage:'delivered',return_refund:'refunded'};
 assert.match(returnBadge(c),/Delivered · eBay/);assert.match(returnBadge(c),/Refunded · eBay/);
 assert.equal(nextText(c),'Confirm receipt and inspect the returned items','refund does not bypass physical inspection');
 for(const [return_refund,label] of [['partial','Partially refunded'],['pending','Refund pending'],['failed','Refund failed']]){
  const html=returnBadge({...c,return_refund});assert.match(html,/Delivered · eBay/);assert.ok(html.includes(label));assert.ok(!html.includes('>Refunded ·'));
 }
 assert.ok(!returnBadge({...c,return_refund:null}).includes('Refund'));
 assert.equal(returnBadge({...c,issue_kind:'dispute'}),'');
 assert.equal(nextText({...c,return_stage:'unknown',ebay_action:'SELLER_ISSUE_REFUND'}),'Refund saved · review the remaining case work');
});
test('customer names stay distinct from usernames; return addresses retain recipient, unit and postal code safely',()=>{
 const {customerContact}=sandbox.OGCustomerIssues.testing,c={issue_kind:'return',order_id:'order',customer_name:'Alex <Taylor>',shipping_name:'Robin Taylor',shipping_address:{line1:'123 Example Lane',line2:'Apt 4 & 5',city:'Boston',state:'MA',postal_code:'02108',country:'US'}};
 const html=customerContact(c);assert.ok(html.includes('Alex &lt;Taylor&gt;'));assert.ok(html.includes('Recipient: Robin Taylor'));assert.ok(html.includes('Apt 4 &amp; 5'));assert.ok(html.includes('Boston, MA 02108'));assert.ok(html.includes('Original shipping address'));
 const same=customerContact({...c,shipping_name:c.customer_name});assert.ok(!same.includes('Recipient:'));
 for(const issue_kind of ['request','dispute']){const html=customerContact({...c,issue_kind});assert.ok(html.includes('Alex &lt;Taylor&gt;'));assert.ok(!html.includes('123 Example Lane'));}
 const missing=customerContact({issue_kind:'return',order_id:'order',buyer_username:'username-only'});assert.ok(missing.includes('Name not saved'));assert.ok(missing.includes('Address not saved'));assert.ok(!missing.includes('undefined'));
 assert.ok(customerContact({issue_kind:'return'}).includes('Link the original order'));
});
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
 assert.equal(nextText({...payment,source_lane:'case',ebay_status:'OPEN'}),'Review the eBay case');
});

test('quick review keeps unknown prices distinct from zero and escapes buyer-provided values',()=>{
 const {money,cardFacts,conversationRows}=sandbox.OGCustomerIssues.testing;
 assert.equal(money({item_value:null}),'Not available');assert.equal(money({item_value:0,item_currency:'USD'}),'$0.00');
 assert.ok(!cardFacts({item_value:25,item_currency:'<img>'}).includes('<img>'));
 const rows=conversationRows({case_messages:[{direction:'inbound',message_body:'Case question',sent_at:'2026-10-01'},{direction:'internal',message_body:'Staff note',sent_at:'2026-10-04'},{direction:'outbound',message_status:'failed',sent_at:'2026-10-05'}],buyer_messages:[{direction:'outbound',message_body:'New reply',created_at_ebay:'2026-10-03'}]});
 assert.equal(rows.length,2);assert.equal(rows[0].message_body,'New reply');assert.equal(rows[1].channel,'eBay case');
});

test('compact complaint review omits legacy purchase dates and duplicate navigation but keeps video evidence',async()=>{
 const source=await readFile(new URL('../ebay-order-history.js',import.meta.url),'utf8'),start=source.indexOf('function renderReturnComplaintDetails('),end=source.indexOf('\nfunction ',start+10);
 const context={getReturnComplaintDetails:()=>({buyerComment:'Clasp complaint',datePurchased:'2026-10-09',detailsUrl:'https://www.ebay.com/case',orderDetailsUrl:'https://www.ebay.com/order',videoReceiptUrl:'https://www.ebay.com/video',imageUrls:[],returnFileIds:[],blobUrls:[]}),getReturnTaskCase:()=>({}),getReturnTaskApiDetails:()=>({}),getReturnTaskPayload:()=>({}),escapeHtml:x=>String(x)};
 vm.runInNewContext(source.slice(start,end),context);
 const compact=context.renderReturnComplaintDetails({}, {compact:true});assert.ok(!compact.includes('Date purchased'));assert.ok(!compact.includes('Open eBay return'));assert.ok(compact.includes('https://www.ebay.com/video'));assert.ok(compact.includes('Clasp complaint'));
 assert.ok(context.renderReturnComplaintDetails({}).includes('Date purchased'),'other uses keep their existing display');
});
