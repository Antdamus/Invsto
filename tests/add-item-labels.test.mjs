import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const read = file => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
function labels() {
  // No database/storage client: printing a saved item must not need write access.
  const context={window:{latestDymoXml:'unsaved item',latestDymoUrl:'labels/draft.dymo'},encodeURIComponent};
  vm.createContext(context);vm.runInContext(read('additem-dymolabel.js'),context);
  return {api:context.window.dymoModule,window:context.window};
}
test('first prints and reprints use saved item facts without storage or inventory writes',async()=>{
 const {api,window}=labels();
 const item=Object.freeze({id:'saved-1',barcode:'COIN&123',weight:26.73,qr_type:'website',qr_code:'https://example.invalid/?a=1&b=2',dymo_label_url:''});
 const result=await api.prepareSavedItemLabel(item);
 assert.equal(result.labelPath,undefined);assert.equal(item.dymo_label_url,'');
 assert.match(result.templateXml,/COIN&amp;123/);assert.match(result.templateXml,/a=1&amp;b=2/);assert.match(result.templateXml,/26.73/);
 assert.equal((await api.prepareSavedItemLabel(item)).templateXml,result.templateXml);
 assert.equal(window.latestDymoXml,'unsaved item');assert.equal(window.latestDymoUrl,'labels/draft.dymo');
});
test('deferred certificate labels retain their certificate QR fallback',async()=>{
 const {api}=labels();const {templateXml}=await api.prepareSavedItemLabel({id:'cert-item',barcode:'ABC123',qr_type:'CGL ID'});
 assert.match(templateXml,/https:\/\/ogjewelry.store\/auth\?id=ABC123/);
});

test('one-off CGL labels reuse the jewelry layout without inventory or staged-label state',()=>{
 const window={latestDymoXml:'pending stock label',latestDymoUrl:'labels/pending.dymo',latestDymoBarcode:'OG123'};
 const context={window}; // No database client: a print-only label must work without it.
 vm.createContext(context);vm.runInContext(read('additem-dymolabel.js'),context);
 const api=window.dymoModule;
 const xml=api.buildCglLabelXml({qr:' https://certificate.example/report?id=00123&name="A<B>" '});
 assert.match(xml,/<LabelName>Jewelry30299<\/LabelName>/);
 assert.equal((xml.match(/<DataString>https:\/\/certificate\.example\/report\?id=00123&amp;name=&quot;A&lt;B&gt;&quot;<\/DataString>/g)||[]).length,4);
 assert.equal((xml.match(/<Text>CGL ID<\/Text>/g)||[]).length,4);
 assert.doesNotMatch(xml,/<Text>barcode<\/Text>|<Text>[^<]*g<\/Text>|OG123/);
 assert.equal(window.latestDymoXml,'pending stock label');assert.equal(window.latestDymoUrl,'labels/pending.dymo');assert.equal(window.latestDymoBarcode,'OG123');
 assert.match(api.buildCglLabelXml({qr:'0000123'}),/<DataString>0000123<\/DataString>/);
 for(const qr of ['', '   ', 'x'.repeat(2049), 'https://example.test/\u0000bad', 'line\nbreak'])assert.throws(()=>api.buildCglLabelXml({qr}),/CGL QR contents/);
});
test('preparing a print still requires a saved item and its barcode',async()=>{
 const {api}=labels();
 for(const item of [null,{}, {id:'saved'},{barcode:'OG123'}])await assert.rejects(api.prepareSavedItemLabel(item),/Save the item/);
});
test('Stock prepares missing labels on demand and reuses attached labels',async()=>{
 const source=read('stock.js');const start=source.indexOf('async function queueStockDymoLabelForHelper(');const end=source.indexOf('\ndocument.addEventListener',start);
 const calls=[];const item={id:'saved',barcode:'OG456',title:'Saved coin'};
 const context={window:{dymoModule:{prepareSavedItemLabel:async value=>{calls.push(['prepare',value.id]);return {templateXml:'<new/>'};},printDymoLabelXml:async(xml,options)=>{calls.push(['print',xml,options.barcode]);}}},getStockItemById:()=>item,loadDymoLabelXml:async path=>{calls.push(['load',path]);return '<attached/>';}};
 vm.createContext(context);vm.runInContext(source.slice(start,end),context);
 await context.queueStockDymoLabelForHelper({dataset:{id:item.id}});assert.deepEqual(calls,[['prepare','saved'],['print','<new/>','OG456']]);
 calls.length=0;item.dymo_label_url='labels/saved.dymo';await context.queueStockDymoLabelForHelper({dataset:{id:item.id}});assert.deepEqual(calls,[['load','labels/saved.dymo'],['print','<attached/>','OG456']]);
});
