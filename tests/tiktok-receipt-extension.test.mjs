import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
const sharedSource=await readFile(new URL('../tools/ebay-og-order-link-extension/tiktok-receipt-background.js',import.meta.url),'utf8');
const imageSource=await readFile(new URL('../tools/ebay-og-order-link-extension/tiktok-receipt-image.js',import.meta.url),'utf8');
const builder=fileURLToPath(new URL('../tools/build-firefox-order-link-package.py',import.meta.url));
const firefoxSource=execFileSync('python',['-c',"import runpy,sys; module=runpy.run_path(sys.argv[1]); print(module['firefox_script'](sys.stdin.read()))",builder],{input:sharedSource,encoding:'utf8'});
const order='900000000000000001',sku='900000000000000003',id='00000000-0000-4000-8000-000000000002',url=`https://seller-us.tiktok.com/order/detail?order_no=${order}&ogReceipt=1`;
for(const [apiName,source] of [['chrome',sharedSource],['browser',firefoxSource]]){
function worker({hasReceiver=true,ready=true,busy=false,blank=false}={}){
 let listener,active=1,captures=0;const data={},tabs=[],crops=[],delivered=[],focused=[];
 const tab={id:1,windowId:4,url};
 const og={id:2,windowId:4,url:'https://og.example/Invsto/pending-tiktok-orders.html'};
 vm.runInNewContext(imageSource+'\n'+source,{URL,Date,console,Number,String,Uint8Array,btoa,fetch:async()=>({blob:async()=>new Blob(['image'])}),createImageBitmap:async()=>({width:2400,height:1600,close(){}}),OffscreenCanvas:class{constructor(w,h){this.width=w;this.height=h;}getContext(){return {drawImage(...args){crops.push(args.slice(1));},getImageData(){return {data:Uint8Array.from(blank?[0,0,0,255]:[0,0,255,255])};}};}async convertToBlob(){return new Blob(['cropped-jpeg']);}},[apiName]:{storage:{sync:{get:async()=>({ogPendingOrdersUrl:'https://og.example/Invsto/pending-orders.html'})},local:{get:async k=>k===null?data:{[k]:data[k]},set:async v=>Object.assign(data,v),remove:async keys=>{for(const k of Array.isArray(keys)?keys:[keys])delete data[k];}}},runtime:{onMessage:{addListener:f=>listener=f}},windows:{update:async()=>{}},tabs:{get:async()=>tab,query:async q=>q.active?[{...tab,id:active}]:[tab,...hasReceiver?[og]:[],{id:3,url:'https://og.example/Invsto/pending-orders.html'}],sendMessage:async(id,message)=>{assert.equal(id,og.id);if(message.type==='OG_TIKTOK_RECEIPT_PING')return {ready,busy};delivered.push(message);return {ok:true};},update:async(id,options)=>{assert.equal(options.url,undefined,'never reload the OG tab');focused.push(id);return og;},captureVisibleTab:async(windowId)=>{assert.equal(windowId,4);captures++;return 'data:image/png;base64,eA==';},create:async t=>tabs.push(t)}}});
 return {data,tabs,crops,delivered,focused,og,get captures(){return captures;},setActive(id){active=id;},send:(m,sender={url,frameId:0,tab})=>new Promise(r=>listener(m,sender,r))};
}
const message=()=>({type:'OG_TIKTOK_RECEIPT_CAPTURE',transferId:id,orderNumber:order,skuId:sku,videoTime:336.9,rect:{x:200,y:100,width:200,height:400},viewport:{width:1200,height:800}});
test(apiName+': capture reuses the open TikTok workspace without navigation and focuses it only after save ACK',async()=>{
 const w=worker(),result=await w.send(message());assert.equal(result.ok,true);assert.equal(w.captures,1);assert.deepEqual(w.crops[0],[400,200,400,800,0,0,400,800]);
 const target=w.og.url;assert.equal(w.tabs.length,0);assert.equal(w.delivered[0].transferId,id);assert.deepEqual(w.focused,[]);
 const sender={url:target,frameId:0,tab:{id:2}},get={type:'OG_TIKTOK_RECEIPT_GET',transferId:id};
 const p=(await w.send(get,sender)).payload;assert.equal(p.orderNumber,order);assert.equal(p.skuId,sku);assert.equal(p.image,'data:image/jpeg;base64,'+btoa('cropped-jpeg'));
 assert.equal((await w.send(get,{...sender,url:target.replace('pending-tiktok-orders','pending-orders')})).ok,false);
 assert.equal((await w.send(get,{...sender,tab:{id:3}})).ok,false);
 await w.send({type:'OG_TIKTOK_RECEIPT_ACK',transferId:id},sender);assert.equal((await w.send(get,sender)).payload.image,undefined);assert.equal((await w.send(get,sender)).payload.completed,true);
 assert.deepEqual(w.focused,[2]);await w.send({type:'OG_TIKTOK_RECEIPT_ACK',transferId:id},sender);assert.deepEqual(w.focused,[2]);
});
test(apiName+': wrong origins, iframes, order IDs, clipped videos and inactive tabs cannot capture',async()=>{
 const w=worker();for(const sender of [{url:'https://evil.test/order/detail?order_no='+order,frameId:0,tab:{id:1}},{url,frameId:1,tab:{id:1}}])assert.equal((await w.send(message(),sender)).ok,false);
 assert.equal((await w.send({...message(),orderNumber:'900000000000000002'})).ok,false);
 assert.equal((await w.send({...message(),rect:{x:-20,y:100,width:200,height:400}})).ok,false);
 assert.equal((await w.send({...message(),skuId:'1.7327e18'})).ok,false);
 w.setActive(2);assert.equal((await w.send(message())).ok,false);assert.equal(w.captures,0);
});
test(apiName+': expired captures and same-origin unrelated app paths cannot retrieve a photo',async()=>{
 const w=worker();await w.send(message());const sender={url:w.og.url,frameId:0,tab:{id:2}};
 assert.equal((await w.send({type:'OG_TIKTOK_RECEIPT_GET',transferId:id},{...sender,url:'https://evil.test/Invsto/pending-tiktok-orders.html?tiktokReceipt='+id})).ok,false);
 w.data['ogTikTokReceipt:'+id].createdAt=Date.now()-3600001;
 assert.equal((await w.send({type:'OG_TIKTOK_RECEIPT_GET',transferId:id},sender)).ok,false);assert.equal(w.data['ogTikTokReceipt:'+id],undefined);
});
test(apiName+': missing, outdated or busy OG tabs do not cause new tabs or captures',async()=>{
 for(const options of [{hasReceiver:false},{ready:false},{busy:true}]){const w=worker(options),result=await w.send(message());assert.equal(result.ok,false);assert.match(result.error,/OG TikTok orders tab/);assert.equal(w.captures,0);assert.equal(w.tabs.length,0);assert.equal(w.delivered.length,0);}
});
test(apiName+': blank video surfaces are never stored or sent to OG',async()=>{
 const w=worker({blank:true}),result=await w.send(message());assert.equal(result.ok,false);assert.equal(result.code,'BLANK_FRAME');assert.deepEqual(w.data,{});assert.equal(w.delivered.length,0);
});
test(apiName+': malformed or oversized window photos cannot bypass capture guards',async()=>{
 const w=worker();for(const image of ['https://evil.test/image.jpg','data:image/png;base64,eA==','data:image/jpeg;base64,'+'a'.repeat(7*1024*1024)])assert.equal((await w.send({...message(),captureMode:'window',image})).ok,false);
 assert.equal((await w.send({...message(),captureMode:'window',image:'data:image/jpeg;base64,eA=='})).ok,false,'reject decoded dimensions over 1600');assert.deepEqual(w.data,{});assert.equal(w.captures,0);
});

}
