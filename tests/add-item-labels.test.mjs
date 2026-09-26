import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
function labels({uploadError=false,updateError=false}={}) {
  const writes=[],uploads=[];
  const context={window:{},console,Blob,Date,encodeURIComponent,supabase:{
    storage:{from:bucket=>({upload:async(path,blob)=>{uploads.push({bucket,path,xml:await blob.text()});return {error:uploadError?new Error('Storage unavailable'):null};}})},
    from:table=>({select(){return this;},update(value){writes.push({table,value});return this;},eq(key,value){if(writes.length)writes.at(-1).filter={key,value};return this;},limit(){return this;},maybeSingle:async()=>({data:null}),then(resolve){return Promise.resolve({error:updateError?new Error('Update unavailable'):null}).then(resolve);}})
  }};
  vm.createContext(context);vm.runInContext(read('additem-dymolabel.js'),context);
  return {api:context.window.dymoModule,writes,uploads};
}
test('deferred labels use the saved item, escape XML and attach to its own ID',async()=>{
 const {api,writes,uploads}=labels();
 const item={id:'saved-1',barcode:'COIN&123',weight:26.73,qr_type:'website',qr_code:'https://example.invalid/?a=1&b=2'};
 const result=await api.prepareSavedItemLabel(item);
 assert.equal(result.labelPath,'labels/saved-1.dymo');assert.equal(item.dymo_label_url,result.labelPath);
 assert.equal(uploads[0].bucket,'dymo-labels');assert.match(result.templateXml,/COIN&amp;123/);assert.match(result.templateXml,/a=1&amp;b=2/);assert.match(result.templateXml,/26.73/);
 assert.equal(writes.length,1);assert.equal(writes[0].filter.value,'saved-1');assert.equal(writes[0].value.dymo_label_url,result.labelPath);
});
test('deferred certificate labels retain their certificate QR fallback',async()=>{
 const {api}=labels();const {templateXml}=await api.prepareSavedItemLabel({id:'cert-item',barcode:'ABC123',qr_type:'CGL ID'});
 assert.match(templateXml,/https:\/\/ogjewelry.store\/auth\?id=ABC123/);
});
test('label storage or attachment failures propagate for retry without marking a label prepared',async()=>{
 for(const failure of [{uploadError:true},{updateError:true}]){
  const {api,writes}=labels(failure),item={id:'saved',barcode:'OG123'};
  await assert.rejects(api.prepareSavedItemLabel(item),/unavailable/);assert.equal(item.dymo_label_url,undefined);
  if(failure.uploadError)assert.equal(writes.length,0);
 }
});
test('Stock prepares missing labels on demand and reuses attached labels',async()=>{
 const source=read('stock.js');const start=source.indexOf('async function queueStockDymoLabelForHelper(');const end=source.indexOf('\ndocument.addEventListener',start);
 const calls=[];const item={id:'saved',barcode:'OG456',title:'Saved coin'};
 const context={window:{dymoModule:{prepareSavedItemLabel:async value=>{calls.push(['prepare',value.id]);return {templateXml:'<new/>'};},printDymoLabelXml:async(xml,options)=>{calls.push(['print',xml,options.barcode]);}}},getStockItemById:()=>item,loadDymoLabelXml:async path=>{calls.push(['load',path]);return '<attached/>';}};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 await context.queueStockDymoLabelForHelper({dataset:{id:item.id}});assert.deepEqual(calls,[['prepare','saved'],['print','<new/>','OG456']]);
 calls.length=0;item.dymo_label_url='labels/saved.dymo';await context.queueStockDymoLabelForHelper({dataset:{id:item.id}});assert.deepEqual(calls,[['load','labels/saved.dymo'],['print','<attached/>','OG456']]);
});
