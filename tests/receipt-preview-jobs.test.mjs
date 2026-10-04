import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../receipt-preview-jobs.js',import.meta.url),'utf8');
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const photo={bucket:'order-evidence-photos',path:'video-receipts/test.png',metadata:{receipt_previews_pending:true}};
const derivatives={preview_path:'video-receipts/derivatives/test-preview.jpg',thumbnail_path:'video-receipts/derivatives/test-thumb.jpg'};
function fixture(t,{fail=false,removed=false}={}){
  const pending=[{task_id:'task',photo}],calls=[],updated=[],warnings=[],removedPaths=[];
  let complete=false;
  const window={setTimeout:fn=>setImmediate(fn),setInterval:()=>1,clearInterval(){},addEventListener(){},removeEventListener(){}};
  const document={visibilityState:'visible',addEventListener(){},removeEventListener(){}};
  vm.runInNewContext(source,{window,document,Map,console:{warn:(...args)=>warnings.push(args)}});
  const client={storage:{from:()=>({async download(path){calls.push(['download',path]);return {data:'downloaded-original'};},
    async remove(paths){removedPaths.push(...paths);return {};}})},async rpc(name,args){calls.push([name,args]);
    if(name==='list_pending_receipt_previews')return {data:complete?[]:pending};
    if(name==='finish_receipt_previews'){complete=true;return {data:!removed};}
    throw Error(name);}};
  const config={client,async createDerivatives(blob,bucket,path,options){calls.push(['derive',blob,options]);
    if(fail)throw Error('Offline');return derivatives;},onUpdated:(...args)=>updated.push(args)};
  const controller=window.OGReceiptPreviewJobs.create(config);t.after(()=>controller.stop());
  return {controller,calls,updated,warnings,removedPaths,document,config,window,setFailure(value){fail=value;},
    async settle(){for(let n=0;n<6;n++)await tick();}};
}
test('previews use already captured bytes, deduplicate in-flight work and publish only after upload',async t=>{
  const f=fixture(t);f.controller.add({task_id:'task',photo,blob:'local-original'});f.controller.add({task_id:'task',photo});
  assert.equal(f.calls.length,0,'acknowledgement can run before optional work starts');await f.settle();
  assert.equal(f.calls.filter(c=>c[0]==='derive').length,1);assert.equal(f.calls[0][1],'local-original');
  assert.equal(f.calls.some(c=>c[0]==='download'),false);assert.equal(f.updated.length,1);
});
test('failed or interrupted previews remain discoverable after reload and do not require captured bytes',async t=>{
  const f=fixture(t,{fail:true});f.controller.add({task_id:'task',photo,blob:'local-original'});await f.settle();
  assert.equal(f.updated.length,0);assert.equal(f.calls.some(c=>c[0]==='finish_receipt_previews'),false);
  f.controller.stop();f.setFailure(false);
  const resumed=f.window.OGReceiptPreviewJobs.create(f.config);t.after(()=>resumed.stop());
  await resumed.resume();await f.settle();
  assert.equal(f.calls.filter(c=>c[0]==='download').length,1);assert.equal(f.updated.length,1);
});
test('a photo removed during preview generation is not restored or deleted from shared storage',async t=>{
  const f=fixture(t,{removed:true});f.controller.add({task_id:'task',photo,blob:'original'});await f.settle();
  assert.equal(f.updated.length,0);assert.deepEqual(f.removedPaths,[]);
});
test('hidden pages skip recovery queries and resume when visible',async t=>{
  const f=fixture(t);f.document.visibilityState='hidden';await f.controller.resume();assert.equal(f.calls.length,0);
  f.document.visibilityState='visible';await f.controller.resume();await f.settle();assert.equal(f.updated.length,1);
});
