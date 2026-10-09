import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {test} from 'node:test';
import {detailPath,discoveryPath,pageRows,pageTotal,runWorker,queueRefresh} from '../supabase/functions/ebay-return-sync/workspace.ts';
const raw=await readFile(new URL('../supabase/functions/ebay-return-sync/index.ts',import.meta.url),'utf8');
let handler,client;
const sandbox={console,URL,URLSearchParams,Response,Request,Headers,TextEncoder,crypto,AbortSignal,Map,Set,Date,fetch:()=>{throw Error('Unexpected provider call');},
 Deno:{env:{get:()=>undefined},serve:fn=>{handler=fn;}},createClient:()=>client,runWorker,queueRefresh:()=>{throw Error('Unexpected queue mutation');}};
vm.createContext(sandbox);vm.runInContext(stripTypeScriptTypes(raw.replace(/^import .*;\r?\n/gm,'')),sandbox);
const clean=x=>JSON.parse(JSON.stringify(x));
test('provider endpoints and pagination reject incomplete data instead of reporting zero',()=>{
 assert.equal(detailPath('case','123'),'/post-order/v2/casemanagement/123');
 assert.ok(discoveryPath('case',200,'2026-10-09T12:00:00Z').includes('case_creation_date_range_from='));
 assert.ok(discoveryPath('payment_dispute',100,'2026-10-09T12:00:00Z').includes('offset=100'));
 assert.throws(()=>pageRows({unexpected:[]},'return'),/unrecognized/);assert.deepEqual(pageRows({total:0},'payment_dispute'),[]);
 assert.equal(pageTotal({total:100,paginationOutput:{totalEntries:498}},'return'),498);
 assert.equal(pageTotal({total:100},'return'),null);
 assert.equal(pageTotal({total:498},'payment_dispute'),498);
});
test('item matching deduplicates repeated indexes but refuses genuinely ambiguous orders',()=>{
 const order={id:'o',order_number:'01-12345-12345',buyer_username:'buyer'},line={id:'l',order_id:'o',item_number:'123',transaction_id:'t',order};
 const indexes={orders:new Map([[order.order_number,order]]),ordersById:new Map([['o',order]]),linesByOrderId:new Map([['o',[line,line]]]),linesByItemNumber:new Map([['123',[line]]])};
 const prepared={orderNumber:order.order_number,itemNumber:'123',transactionId:'t',buyerUsername:'buyer'};
 assert.equal(sandbox.findMatches(prepared,indexes).lines.length,1);
 indexes.linesByOrderId.set('o',[line,{...line,id:'other'}]);assert.equal(sandbox.findMatches(prepared,indexes).lines.length,0);
 assert.equal(sandbox.findMatches({...prepared,orderNumber:'',buyerUsername:'wrongbuyer'},indexes).lines.length,0);
});
test('full provider details control current status and seller deadline, not the buyer deadline or old summary',()=>{
 const p=sandbox.preparePostOrderIssue({inquiryId:'r1',status:'OPEN',sellerResponseDue:{respondByDate:'2026-10-01T00:00:00Z'}},
 {inquiryId:'r1',status:'CLOSED',sellerResponseDue:{respondByDate:'2026-10-10T12:00:00Z'},buyerResponseDue:{respondByDate:'2026-10-20T12:00:00Z'},item:{itemId:'123'}},{},'inquiry');
 assert.equal(p.status,'CLOSED');assert.equal(p.dueAt,'2026-10-10T12:00:00.000Z');
});
test('anonymous callers and invalid dispatch tokens cannot run imports',async()=>{
 let claims=0;client={rpc:async(name)=>{assert.equal(name,'claim_customer_issue_worker');claims++;return {data:false};}};
 assert.equal((await handler(new Request('https://test',{method:'POST',body:'{"action":"refresh"}'}))).status,401);
 assert.equal(claims,0);
 assert.equal((await handler(new Request('https://test',{method:'POST',body:'{"workerToken":"00000000-0000-4000-8000-000000000001"}'}))).status,401);assert.equal(claims,1);
 client={auth:{getUser:async()=>({error:Error('Expired'),data:{user:null}})}};
 assert.equal((await handler(new Request('https://test',{method:'POST',headers:{Authorization:'Bearer expired'},body:'{"action":"refresh"}'}))).status,401);
});
function fakeDb({lane=null,jobs=[]}={}){
 const calls=[];return {calls,from(table){const call={table,op:'select',filters:[]};const q={
 select(){return q;},update(row){call.op='update';call.row=row;return q;},upsert(row,options){call.op='upsert';call.row=row;call.options=options;return q;},delete(){call.op='delete';return q;},
 eq(k,v){call.filters.push([k,v]);return q;},lte(){return q;},not(){return q;},or(){return q;},in(){return q;},order(){return q;},limit(){return q;},maybeSingle(){return q;},
 then(resolve){calls.push(call);return Promise.resolve({data:call.op==='select'?(table==='ebay_issue_sync_lanes'?lane:table==='ebay_issue_sync_jobs'?jobs:[]):null}).then(resolve);}};return q;}};
}
test('discovery continues after a full page instead of truncating at a page-sized total',async()=>{
 for(const pagination of [{total:100,paginationOutput:{totalEntries:498}},{total:100}]){
  const db=fakeDb({lane:{lane:'return',cursor_offset:0,error_count:0}});
  await runWorker(db,{token:async()=>'',read:async()=>({...pagination,members:Array.from({length:100},(_,i)=>({returnId:String(i+1)}))}),process:async()=>{}});
  const saved=db.calls.find(c=>c.table==='ebay_issue_sync_lanes'&&c.op==='update').row;
  assert.equal(saved.cursor_offset,100);assert.equal(saved.status,'syncing');assert.equal(saved.last_success_at,undefined);
 }
});
test('failed details retain case state and create a visible retry',async()=>{
 const db=fakeDb({jobs:[{lane:'return',external_id:'r1',summary:{},attempts:2,updated_at:'v1'}]});
 const result=await runWorker(db,{token:async()=>'',read:async()=>{throw Error('eBay timeout');},process:async()=>{throw Error('Must not process partial data');}});
 assert.equal(result.processed,0);const retry=db.calls.find(c=>c.table==='ebay_issue_sync_jobs'&&c.op==='update');assert.equal(retry.row.attempts,3);assert.equal(retry.row.state,'retry');
 assert.ok(db.calls.some(c=>c.table==='ebay_return_cases'&&c.row?.sync_error==='eBay timeout'));
 assert.ok(!db.calls.some(c=>c.row?.status==='closed'||c.op==='delete'));
});
test('successful jobs use a version guard so a newer refresh request cannot be deleted',async()=>{
 const db=fakeDb({jobs:[{lane:'inquiry',external_id:'r1',summary:{},attempts:0,updated_at:'v1'}]});let processed=0;
 await runWorker(db,{token:async()=>'',read:async()=>({status:'CLOSED'}),process:async()=>{processed++;}});
 assert.equal(processed,1);assert.ok(db.calls.find(c=>c.op==='delete').filters.some(([k,v])=>k==='updated_at'&&v==='v1'));
});
test('a requested case refresh jumps ahead of historical backfill',async()=>{
 let queued;
 const db={from:table=>table==='ebay_return_cases'?{select:()=>({eq:()=>({single:async()=>({data:{source_lane:'return',ebay_return_id:'r1'}})})})}:{upsert:async row=>{queued=row;return {};}}};
 await queueRefresh(db,'case-1');assert.equal(queued.priority,-10);assert.equal(queued.external_id,'r1');
});
test('a missing payment-dispute permission does not block ordinary case refreshes',async()=>{
 const db=fakeDb({lane:{lane:'payment_dispute',cursor_offset:0,error_count:0},jobs:[{lane:'inquiry',external_id:'r1',summary:{},attempts:0,updated_at:'v1'}]});let processed=0;
 await runWorker(db,{token:async(scope)=>{if(scope)throw Error('403 scope not authorized');return 'ordinary';},read:async()=>({status:'OPEN'}),process:async()=>{processed++;}});
 assert.equal(processed,1);assert.equal(db.calls.find(c=>c.table==='ebay_issue_sync_lanes'&&c.op==='update').row.status,'needs_access');
});
