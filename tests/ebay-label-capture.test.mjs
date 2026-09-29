import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../tools/ebay-og-order-link-extension/label-capture-probe.js',import.meta.url),'utf8');
function probe(fetch){
 const messages=[];
 class FileReader{readAsDataURL(blob){blob.arrayBuffer().then(buffer=>{this.result='data:application/pdf;base64,'+Buffer.from(buffer).toString('base64');this.onload();});}}
 class XHR{open(){}send(){}addEventListener(){}}
 const URLmock={createObjectURL:()=> 'blob:test'};
 const window={fetch,postMessage:message=>messages.push(message)};
 vm.runInNewContext(source,{window,document:{addEventListener(){}},XMLHttpRequest:XHR,FileReader,URL:URLmock,Blob,ArrayBuffer,Date,Set});
 return {window,messages,URLmock};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('eBay PDF range responses are replaced with a full GET before capture',async()=>{
 const calls=[];const full='%PDF-1.4\ncomplete label fixture\n%%EOF';
 const context=probe(async(url,options)=>{calls.push({url,options});return new Response(calls.length===1?'%PDF-1.4 partial':full,{status:calls.length===1?206:200,headers:{'content-type':'application/pdf'}});});
 const response=await context.window.fetch('https://www.ebay.com/label.pdf',{headers:{Range:'bytes=0-15'}});
 for(let i=0;i<30&&!context.messages.some(m=>m.payload?.base64);i++)await tick();
 assert.equal(response.status,206);assert.equal(await response.text(),'%PDF-1.4 partial');
 assert.equal(calls.length,2);assert.equal(calls[1].options.headers,undefined);
 const captures=context.messages.filter(m=>m.payload?.base64);assert.equal(captures.length,1);assert.equal(Buffer.from(captures[0].payload.base64,'base64').toString(),full);
});
test('incomplete object URLs do not win over a later complete shipping PDF',async()=>{
 const context=probe(async()=>new Response(''));
 context.URLmock.createObjectURL(new Blob(['%PDF-1.4 missing final bytes'],{type:'application/pdf'}));
 for(let i=0;i<5;i++)await tick();assert.equal(context.messages.filter(m=>m.payload?.base64).length,0);
 context.URLmock.createObjectURL(new Blob(['%PDF-1.4 full bytes\n%%EOF'],{type:'application/pdf'}));
 for(let i=0;i<30&&!context.messages.some(m=>m.payload?.base64);i++)await tick();assert.equal(context.messages.filter(m=>m.payload?.base64).length,1);
});
