import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const context={URL,Blob,TextEncoder,Uint8Array,DataView};vm.createContext(context);
vm.runInContext(await readFile(new URL('../customer-issue-evidence.js',import.meta.url),'utf8'),context);
const api=context.OGIssueEvidence.testing;
test('archive keeps original bytes and emits a valid directory and CRC',async()=>{
 const content=new TextEncoder().encode('original photo bytes');
 const blob=api.zip([{name:'files/photo.jpg',bytes:content},{name:'report.html',bytes:new TextEncoder().encode('<h1>Report</h1>')}]);
 const bytes=new Uint8Array(await blob.arrayBuffer()),view=new DataView(bytes.buffer);
 assert.equal(view.getUint32(0,true),0x04034b50);
 const nameLength=view.getUint16(26,true);assert.deepEqual(bytes.slice(30+nameLength,30+nameLength+content.length),content);
 assert.equal(view.getUint32(14,true),api.crc(content));
 assert.equal(view.getUint32(bytes.length-22,true),0x06054b50);assert.equal(view.getUint16(bytes.length-12,true),2);
 const directory=view.getUint32(bytes.length-6,true);assert.equal(view.getUint32(directory,true),0x02014b50);
});
test('evidence collection deduplicates shared photos without including arbitrary staff attachments',()=>{
 const files=api.collect({bag_photos:[{bucket:'photos',path:'a.jpg'}],reference_events:[{photo_attachments:[{bucket:'photos',path:'private.jpg'}]}],certificates:[{attachments:[{bucket:'documents',path:'cert.pdf'}]}]},[{bucket:'photos',path:'a.jpg'}],[]);
 assert.equal(files.length,2);assert.ok(!files.some(f=>f.path==='private.jpg'));
});
test('download report escapes message markup and flags missing evidence',()=>{
 const result=api.report({case:{buyer_username:'<script>alert(1)</script>'},certificates:[{certificate_url:'javascript:alert(1)'}]},[],[{message_body:'<img src=x onerror=alert(1)>'}],['Photo could not download']);
 assert.ok(result.includes('&lt;script&gt;'));assert.ok(!result.includes('<script>'));assert.ok(!result.includes('href="javascript:'));assert.ok(result.includes('Incomplete download'));
});


test('saved inquiry history includes buyer, seller and tracking activity with exact dates and no staff notes',()=>{
 const history=[
  {actor:'BUYER',action:'A CPS case was created.',description:'Item shows delivered but I never receive it.',date:'2026-10-01T03:16:26Z'},
  {actor:'BUYER',action:'A message was sent from one party to another.',description:'Please follow up on the necklace.',date:'2026-10-04T17:00:49Z'},
  {actor:'SELLER',action:'Seller offered another solution.',description:'Please check your mailbox.',date:'2026-10-04T17:57:18Z'},
  {actor:'SELLER',action:'Seller provided tracking information for shipment.',date:'2026-10-04T18:52:52Z'},
  {actor:'SYSTEM',action:'Reminder',date:'2026-10-03T07:00:54Z'},
  {actor:'CSR',description:'Support checked delivery.',date:'2026-10-05T10:00:00Z'},
  {actor:'UNRECOGNIZED',description:'Unknown author',date:'invalid'}
 ];
 const rows=api.conversation({case:{buyer_username:'buyer.test'},case_history:history,case_messages:[{direction:'internal',message_body:'Private staff note'},
  {direction:'outbound',message_body:'Unsent draft',message_status:'failed'}]});
 assert.equal(rows.length,7);assert.equal(rows[0].sender_username,'eBay support');
 const seller=rows.find(m=>m.message_body==='Please check your mailbox.');assert.equal(seller.direction,'outbound');assert.equal(seller.sender_username,'Our reply');assert.equal(seller.sent_at,'2026-10-04T17:57:18Z');
 assert.equal(rows.find(m=>m.message_body.includes('tracking')).entry_type,'event');assert.equal(rows.find(m=>m.provider_actor==='UNRECOGNIZED').sender_username,'eBay · unknown author');
 const report=api.report({case:{}},[],rows,[]);assert.ok(report.includes('Please check your mailbox.'));assert.ok(!report.includes('Private staff note'));assert.ok(report.includes('tracking information'));
});

test('conversation merges cross-source copies but keeps repeated messages at different times',()=>{
 const date='2026-10-04T17:57:18Z',rows=api.conversation({case_history:[{actor:'SELLER',description:'Same reply',date}],
 case_messages:[{direction:'outbound',message_body:'Same reply',sent_at:date,message_status:'imported'},
 {direction:'outbound',message_body:'Same reply',sent_at:'2026-10-04T18:00:00Z',message_status:'sent'}],
 buyer_messages:[{direction:'inbound',message_body:'Same reply',created_at_ebay:date}]});
 assert.equal(rows.length,3);assert.equal(rows.filter(r=>r.sent_at===date).length,2);
});

test('provider complaint context uses exact case claim amount instead of an unrelated zero refund field',()=>{
 const c={source_lane:'inquiry',ebay_return_id:'123',raw_payload:{ebayDetail:{inquiryId:123,claimAmount:{value:97,currency:'USD'},inquiryDetails:{refundAmounts:{buyerInitExpectRefundAmt:{value:0,currency:'USD'}}},inquiryHistoryDetails:{additionalInfo:'Original buyer complaint'}}}};
 const p=api.providerContext(c);assert.equal(p.requestAmount,'$97.00');assert.equal(p.buyerComment,'Original buyer complaint');
 assert.deepEqual(JSON.parse(JSON.stringify(api.providerContext({...c,ebay_return_id:'other'}))),{});
 c.raw_payload.ebayDetail.claimAmount.value=null;assert.equal(api.providerContext(c).requestAmount,'');
 c.raw_payload.ebayDetail.claimAmount.value=0;assert.equal(api.providerContext(c).requestAmount,'$0.00');
 c.raw_payload.ebayDetail.claimAmount.value='invalid';assert.equal(api.providerContext(c).requestAmount,'');
});
