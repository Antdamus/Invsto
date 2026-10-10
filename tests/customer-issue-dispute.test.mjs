import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {disputeFile,evidenceMime,boundedEvidence,resolveDisputeEvidence} from '../supabase/functions/ebay-return-sync/payment-evidence.ts';
const c={id:'case-1',source_lane:'payment_dispute',ebay_return_id:'5010603112',ebay_status:'OPEN',status:'open',order_id:'order-1',raw_payload:{ebayDetail:{paymentDisputeId:'5010603112',paymentDisputeStatus:'OPEN',sellerResponse:'SELLER_CONTEST',note:'Full response\nWith <untrusted> text.',evidence:[{evidenceId:'ev-1',evidenceType:'PROOF_OF_AUTHENTICITY',files:[{fileId:'file-1',name:'Evidence.jpg',fileType:'image/jpeg',uploadedDate:'2026-10-10T04:41:01Z'}]}]}}};
const context={URL,location:{href:'https://example.test/'}};
vm.runInNewContext(await readFile(new URL('../customer-issue-dispute.js',import.meta.url),'utf8'),context);
vm.runInNewContext(await readFile(new URL('../customer-issues.js',import.meta.url),'utf8'),context);
const api=context.OGDisputeResponse;
test('submitted response shows full explanation and document metadata, separately from the open outcome',()=>{
 const r=api.response(c);assert.equal(r.waiting,true);assert.equal(r.files.length,1);
 const html=api.section(c);assert.ok(html.includes('Submitted response'));assert.ok(html.includes('awaiting outcome'));assert.ok(html.includes('&lt;untrusted&gt;'));assert.ok(html.includes('Evidence.jpg'));
 assert.equal(context.OGCustomerIssues.testing.nextText(c),'Response submitted · awaiting outcome');
 assert.equal(c.status,'open');
});
test('no response, wrong case, and closed cases do not falsely claim a submitted response awaiting outcome',()=>{
 const draft=structuredClone(c);delete draft.raw_payload.ebayDetail.sellerResponse;
 assert.equal(api.response(draft).waiting,false);assert.ok(api.section(draft).includes('Saved evidence alone does not confirm submission'));
 assert.equal(api.response({...c,ebay_return_id:'other'}),null);assert.equal(api.section({...c,source_lane:'return'}),'');
 const closed=structuredClone(c);closed.ebay_status='CLOSED';closed.raw_payload.ebayDetail.paymentDisputeStatus='CLOSED';assert.equal(api.response(closed).waiting,false);
});
test('list badges follow current eBay status, overriding a previous response when action is needed again',()=>{
 const row={...c,raw_payload:undefined,seller_response:'SELLER_CONTEST',ebay_due_at:'2026-10-14T06:59:59Z'};
 assert.equal(api.badge(row).kind,'waiting');
 const waiting=context.OGCustomerIssues.testing.cardStatus(row);assert.ok(waiting.includes('awaiting outcome'));assert.ok(!waiting.includes('eBay deadline'));assert.equal(waiting.match(/awaiting outcome/g).length,1);
 const action={...row,ebay_status:'ACTION_NEEDED'};
 assert.equal(api.badge(action).label,'Response required');
 assert.equal(api.response({...c,ebay_status:'ACTION_NEEDED'}).waiting,false,'fresh status overrides old response detail');
 const needed=context.OGCustomerIssues.testing.cardStatus(action);assert.ok(needed.includes('Response required'));assert.ok(needed.includes('eBay deadline'));assert.ok(!needed.includes('awaiting outcome'));
 assert.equal(api.badge({...row,ebay_status:'CLOSED'}),null);assert.equal(api.badge({...row,status:'closed'}),null);
 assert.equal(api.badge({...row,seller_response:null}),null);assert.equal(api.badge({...row,source_lane:'return'}),null);
 assert.equal(api.badge({...row,seller_response:'SELLER_ACCEPT'}),null,'acceptance is not a challenge awaiting outcome');
});
test('evidence is scoped to the exact dispute and evidence set, with duplicate files removed',()=>{
 assert.equal(disputeFile(c,'ev-1','file-1').name,'Evidence.jpg');
 for(const args of [[c,'ev-2','file-1'],[c,'ev-1','other'],[{...c,ebay_return_id:'other'},'ev-1','file-1'],[{...c,source_lane:'return'},'ev-1','file-1']])assert.throws(()=>disputeFile(...args));
 const duplicate=structuredClone(c);duplicate.raw_payload.ebayDetail.evidence.push(duplicate.raw_payload.ebayDetail.evidence[0]);assert.equal(api.response(duplicate).files.length,1);
});
test('archive validates bytes, refuses provider errors, and bounds both declared and streaming sizes',async()=>{
 assert.equal(evidenceMime(Uint8Array.from([255,216,255])),'image/jpeg');
 assert.equal(evidenceMime(new TextEncoder().encode('%PDF-1.4')),'application/pdf');
 assert.throws(()=>evidenceMime(new TextEncoder().encode('<html>sign in</html>')),/supported image/);
 await assert.rejects(boundedEvidence(new Response('denied',{status:403})),/403/);
 await assert.rejects(boundedEvidence(new Response(JSON.stringify({errors:[{errorId:2003,parameters:[{name:'code',value:'406'}]}]}),{status:500})),/eBay 2003 \/ upstream 406/);
 await assert.rejects(boundedEvidence(new Response('large',{headers:{'content-length':String(11*1024*1024)}})),/10 MB/);
 await assert.rejects(boundedEvidence(new Response(new Uint8Array(10*1024*1024+1))),/10 MB/);
});
test('first view archives exact eBay bytes privately; repeat views reuse the file without OAuth or eBay traffic',async()=>{
 let file,fetches=0,tokens=0,uploads=0;const bytes=Uint8Array.from([255,216,255,1,2,3]);
 const storage={list:async(_dir,args)=>({data:file?[{name:args.search,metadata:{mimetype:'image/jpeg'}}]:[]}),upload:async(path,value,options)=>{file={path};uploads++;assert.deepEqual(value,bytes);assert.equal(options.upsert,false);return {};},createSignedUrl:async(path,ttl)=>{assert.equal(ttl,3600);return {data:{signedUrl:'https://storage.example.test/'+path}};}};
 const db={storage:{from:bucket=>{assert.equal(bucket,'ebay-return-evidence');return storage;}}};
 const token=async()=>{tokens++;return 'server-only';},request=async(url,options)=>{fetches++;assert.equal(options.headers.Authorization,'Bearer server-only');assert.equal(options.redirect,'error');assert.equal(options.headers.Accept,'*/*');const u=new URL(url);assert.equal(u.hostname,'apiz.ebay.com');assert.equal(u.pathname,'/sell/fulfillment/v1/payment_dispute/5010603112/fetch_evidence_content');assert.equal(u.searchParams.get('evidence_id'),'ev-1');assert.equal(u.searchParams.get('file_id'),'file-1');return new Response(bytes);};
 const first=await resolveDisputeEvidence(db,c,'ev-1','file-1',token,'https://apiz.ebay.com',request);
 assert.equal(first.archived,true);assert.equal(first.mime_type,'image/jpeg');assert.ok(first.path.startsWith('payment-disputes/case-1/'));
 const second=await resolveDisputeEvidence(db,c,'ev-1','file-1',token,'https://apiz.ebay.com',request);assert.equal(first.path,second.path);assert.equal(fetches,1);assert.equal(tokens,1);assert.equal(uploads,1);
 await assert.rejects(resolveDisputeEvidence(db,c,'wrong','file-1',token,'https://apiz.ebay.com',request));assert.equal(fetches,1);
});
test('failed document retrieval renders a retry instead of removing the supporting document',async()=>{
 const panel={dataset:{},innerHTML:''},target={isConnected:true,querySelector:()=>panel,addEventListener(){}};
 await api.hydrate({c,db:{functions:{invoke:async()=>({error:Error('Network')})}},target});
 assert.ok(panel.innerHTML.includes('Retry document'));assert.ok(panel.innerHTML.includes('could not load'));assert.equal(panel.dataset.busy,'false');
});

test('binary dispute evidence uses the apiz host required by eBay for this operation',async()=>{
 const source=await readFile(new URL('../supabase/functions/ebay-return-sync/index.ts',import.meta.url),'utf8');
 assert.match(source,/resolveDisputeEvidence\(db,visible.data,body.evidenceId,body.fileId,[^;]+EBAY_FINANCES_API_BASE\)/);
});
