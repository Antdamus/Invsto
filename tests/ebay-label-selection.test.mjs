import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import {test} from 'node:test';
const source=await readFile(new URL('../tools/ebay-og-order-link-extension/content.js',import.meta.url),'utf8');
function functionSource(name,next){return source.slice(source.indexOf(`  function ${name}(`),source.indexOf(`  function ${next}(`));}
function snapshot(details){
 const a='11-22222-33333',b='11-22222-44444',other='11-22222-55555';
 const context=vm.createContext({URL,Date,Set,Number,ORDER_NUMBER_PATTERN:/\d{2}-\d{5}-\d{5}/,
  window:{location:{origin:'https://www.ebay.com',href:'https://www.ebay.com/ship/confirmation'}},
  document:{title:'Labels ready',body:{innerText:`Your other order ${other}`},
   querySelectorAll:selector=>selector==='ul[data-testid="item-details-no-sku"] li'?details.map(textContent=>({textContent})):[],querySelector:()=>null},
  getBulkLabelDownloadLink:()=>({getAttribute:()=>'/label/fixture/download'}),
  getOptionalCachedBulkContext:()=>({orderIds:[a,b,other]}),getBulkConfirmationLabelRows:()=>[],getBulkConfirmationTrackingNumbers:()=>[],
  unique:values=>[...new Set(values)],cleanText:value=>String(value).trim()});
 vm.runInContext(functionSource('getBulkConfirmationOrderIds','normalizeBulkContextOrderIds')+functionSource('getBulkLabelConfirmationSnapshot','getReportErrorMessage'),context);
 return JSON.parse(JSON.stringify(context.getBulkLabelConfirmationSnapshot()));
}
test('Send to OG uses purchased-label item details and ignores unrelated page text or cached orders',()=>{
 const result=snapshot(['Order 11-22222-33333','Order 11-22222-44444','Order 11-22222-33333']);
 assert.deepEqual(result.orderIds,['11-22222-33333','11-22222-44444']);assert.equal(result.source,'ebay-bulk-label-confirmation');
});
test('missing confirmation details cannot fall back to an older selection',()=>{
 const result=snapshot([]);assert.deepEqual(result.orderIds,[]);assert.equal(result.orderId,'');
});
