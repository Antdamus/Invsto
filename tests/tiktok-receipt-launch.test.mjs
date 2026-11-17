import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
const source=await readFile(new URL('../tools/ebay-og-order-link-extension/tiktok-receipt-launch-background.js',import.meta.url),'utf8');
const order='577681512483951404',sku='1732855573992804598',requestId='00000000-0000-4000-8000-000000000002';
const workspace='https://antdamus.github.io/Invsto/pending-tiktok-orders.html',launcher=`https://antdamus.github.io/Invsto/tiktok-receipt-launch.html?order=${order}&sku=${sku}`;
function fixture({receiver=true,ready=true}={}){
 let handler;const created=[],focused=[],receiving={id:7,windowId:2,url:workspace};
 vm.runInNewContext(source,{URL,Map,Error,Promise,setTimeout:resolve=>resolve(),chrome:{storage:{sync:{get:async()=>({ogPendingOrdersUrl:workspace})}},runtime:{onMessage:{addListener:fn=>handler=fn}},tabs:{query:async()=>receiver?[receiving]:[],sendMessage:async()=>({ready,busy:false}),create:async value=>{created.push(value);return {...receiving,...value};},update:async id=>focused.push(id)}}});
 return {created,focused,send:(message={},sender={url:launcher,frameId:0,tab:{id:9}})=>new Promise(resolve=>handler({type:'OG_TIKTOK_OPEN_RECEIPT',requestId,orderNumber:order,skuId:sku,...message},sender,resolve))};
}
test('launcher reuses a ready workspace and preserves exact string order and SKU',async()=>{
 const f=fixture();assert.equal((await f.send()).ok,true);assert.equal(f.created.length,1);const opened=f.created[0];assert.equal(opened.openerTabId,7);const url=new URL(opened.url);assert.equal(url.searchParams.get('order_no'),order);assert.equal(url.searchParams.get('ogSku'),sku);assert.equal(url.searchParams.get('ogReceipt'),'1');
});
test('missing workspace opens before receipt; unready sign-in never opens a receipt',async()=>{
 const f=fixture({receiver:false});assert.equal((await f.send()).ok,true);assert.equal(f.created[0].url,workspace);assert.equal(f.created.length,2);
 const blocked=fixture({receiver:false,ready:false});assert.equal((await blocked.send()).ok,false);assert.equal(blocked.created.length,1);assert.deepEqual(blocked.focused,[7]);
});
test('external pages, subframes, mismatched order/SKU and malformed IDs cannot launch',async()=>{
 for(const sender of [{url:launcher.replace('antdamus.github.io','evil.test'),frameId:0,tab:{id:9}},{url:launcher,frameId:1,tab:{id:9}},{url:workspace,frameId:0,tab:{id:9}}]){const f=fixture();assert.equal((await f.send({},sender)).ok,false);assert.equal(f.created.length,0);}
 for(const message of [{orderNumber:order+'1'},{skuId:sku+'1'},{orderNumber:'--new-window'},{requestId:'bad'}]){const f=fixture();assert.equal((await f.send(message)).ok,false);assert.equal(f.created.length,0);}
});
