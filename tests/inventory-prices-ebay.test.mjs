import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import vm from 'node:vm';
import { test } from 'node:test';
const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const source = read('supabase/functions/ebay-inventory-sync/index.ts').replace(/^import .*;\r?\n/gm, '');
function backend() {
  const context = { Deno: { env: { get: () => '' }, serve() {} }, console, TextEncoder, crypto: webcrypto, URL, URLSearchParams, Response, AbortSignal };
  vm.createContext(context);
  vm.runInContext(stripTypeScriptTypes(source), context);
  return context;
}
const metadata = { aspects: ['Brand', 'Department', 'Type'].map(localizedAspectName => ({ localizedAspectName, aspectConstraint: { aspectRequired: true } })), conditions: [{ conditionId: '3000' }, { conditionId: '1000' }] };
const item = { id:'watch', title:'Rolex Datejust', description:'Pre-owned watch.\n\nWatch details:\nModel / reference: old-reference', barcode:'watch-1', sale_price:6500, minimum_sale_price:4700, cost:4100, photos:['https://example.invalid/storage/v1/object/public/public-ebay-photos/watch.jpg'], watch_details: { name:'Datejust', brand:'Rolex', model:'126233', department:'Unisex Adults', condition:'USED_EXCELLENT', materials:'Steel case; gold bezel', modifications:'Aftermarket diamond bezel' }, ebay_category_id:'261993', ebay_condition:'NEW', ebay_aspects:{Brand:['Unbranded'], Type:['Pendant'], Metal:['Fine Silver'], 'Metal Purity':['925']} };
const settings = { marketplace_id:'EBAY_US', currency:'USD', merchant_location_key:'main', default_category_id:'261993', default_condition:'NEW', listing_format:'FIXED_PRICE', category_rules:[] };
const plain = value => JSON.parse(JSON.stringify(value));
test('watch eBay payload uses actual watch facts, mixed materials and retail only', async () => {
  const api = backend();
  const result = await api.prepareItem({}, item, 1, settings, {copyMissingPhotos:false, watchMetadata:metadata});
  assert.equal(result.categoryId,'31387');
  assert.equal(result.inventoryPayload.condition,'USED_EXCELLENT');
  assert.deepEqual(plain(result.inventoryPayload.product.aspects),{Type:['Wristwatch'],Brand:['Rolex'],Department:['Unisex Adults'],'Reference Number':['126233']});
  assert.equal(result.offerPayload.pricingSummary.price.value,'6500.00');
  assert.deepEqual(plain(result.blockingReasons),[]);
  assert.match(result.offerPayload.listingDescription,/Steel case; gold bezel/);
  assert.match(result.offerPayload.listingDescription,/Aftermarket diamond bezel/);
  assert.doesNotMatch(result.offerPayload.listingDescription,/old-reference/);
  assert.doesNotMatch(JSON.stringify([result.inventoryPayload,result.offerPayload]),/minimum_sale_price|4700|4100|Fine Silver|Unbranded/);
});
test('missing watch condition is blocked rather than defaulted to NEW; live requirements fail closed',async()=>{
  const api=backend();
  const unknown={...item,watch_details:{name:'Watch'}};
  const result=await api.prepareItem({},unknown,1,settings,{copyMissingPhotos:false,watchMetadata:metadata});
  assert.notEqual(result.inventoryPayload.condition,'NEW');
  assert.match(result.blockingReasons.join(','),/watch condition/);
  assert.match(result.blockingReasons.join(','),/Brand/);
  assert.match(result.blockingReasons.join(','),/Department/);
  const unavailable=await api.prepareItem({},item,1,settings,{copyMissingPhotos:false});
  assert.match(unavailable.blockingReasons.join(','),/requirements could not be verified/);
});
test('no minimum-price fallback for zero retail, and coins cannot become jewelry listings',async()=>{
  const api=backend();
  const result=await api.prepareItem({}, {...item,sale_price:0},1,settings,{copyMissingPhotos:false,watchMetadata:metadata});
  assert.equal(result.offerPayload,null);
  assert.match(result.blockingReasons.join(','),/retail price/);
  assert.match(api.collectPublishBlockingReasons({...item,coin_details:{name:'Coin'}},90,1,true,'261993','override',{}).join(','),/coin-specific/);
});
test('required eBay aspects and allowed condition values are checked',()=>{
  const api=backend();
  const changed={aspects:[...metadata.aspects,{localizedAspectName:'Movement',aspectConstraint:{aspectRequired:true}}],conditions:[{conditionId:'1000'}]};
  const reasons=api.validateWatchMetadata(item,api.watchAspects(item),changed).join(',');
  assert.match(reasons,/Movement/); assert.match(reasons,/supported watch condition/);
});
function exporter(){
  const context={window:{},console,setTimeout,clearTimeout};
  vm.createContext(context);vm.runInContext(read('ebayExport.js'),context);
  vm.runInContext('getQuantitiesByItemId = async () => ({watch:1,jewelry:2}); getPublicImageUrls = async () => "https://example.invalid/photo.jpg";',context);
  return context;
}
test('watch CSV uses retail, watch category and condition without jewelry specifics',async()=>{
  const api=exporter();
  const headers=['Start price','Category ID','Condition ID','C:Brand','C:Department','C:Reference Number','C:Metal','C:Metal Purity'];
  const rows=await api.buildListingRows([item],headers,api.window.EBAY_EXPORT_PROFILES.watch);
  assert.deepEqual(plain(rows[0]),[6500,'31387','3000','Rolex','Unisex Adults','126233','','']);
  assert.throws(()=>api.validateEbayExportItems([item],api.window.EBAY_EXPORT_PROFILES.pendant),/Watch export/);
  assert.throws(()=>api.validateEbayExportItems([{...item,coin_details:{name:'Coin'}}],api.window.EBAY_EXPORT_PROFILES.watch),/coin-specific/);
  assert.throws(()=>api.validateEbayExportItems([{...item,sale_price:0}],api.window.EBAY_EXPORT_PROFILES.watch),/retail price/);
});
test('jewelry CSV also uses retail, never the internal selling floor',async()=>{
  const api=exporter();
  const rows=await api.buildListingRows([{id:'jewelry',sale_price:300,minimum_sale_price:150}],['Start price'],api.window.EBAY_EXPORT_PROFILES.bracelet);
  assert.equal(rows[0][0],300);
});
test('Stock renders both prices for staff and treats old missing minimum as unset',()=>{
  const stock=read('stock.js');
  const start=stock.indexOf('    function buildCardContent(item)');
  const end=stock.indexOf('  //#endregion',start);
  const context={ getItemGoodStock:()=>1,getItemDefectStock:()=>0,canViewSensitiveStockData:()=>false,isStockItemDeleted:()=>false,getEffectiveEbayCategoryOption:()=>null,buildEbayStatusBadge:()=>'',buildLocationChips:()=>'',escapeStockHtml:String,formatStockMoney:value=>`$${Number(value).toFixed(2)}` };
  vm.createContext(context);vm.runInContext(stock.slice(start,end),context);
  const html=context.buildCardContent(item);
  const metrics=html.split('<div class="stock-metric-grid">')[1].split('</div>')[0];
  assert.match(metrics,/>Retail<.*6500\.00/s);assert.match(metrics,/>Minimum sale<.*4700\.00/s);assert.doesNotMatch(metrics,/>Cost</);
  assert.match(context.buildCardContent({...item,minimum_sale_price:null}),/>Not set</);
  assert.match(context.buildCardContent({...item,minimum_sale_price:0}),/>\$0\.00</);
});


test('watch condition IDs map to the correct Inventory API enum, including Good versus Excellent', () => {
  const api = backend();
  const liveConditions = { ...metadata, conditions: ['1000','1500','1750','2500','2990','3000','3010','7000'].map(conditionId => ({conditionId})) };
  for (const condition of ['NEW','NEW_OTHER','NEW_WITH_DEFECTS','SELLER_REFURBISHED','PRE_OWNED_EXCELLENT','USED_EXCELLENT','PRE_OWNED_FAIR','FOR_PARTS_OR_NOT_WORKING']) {
    assert.deepEqual(plain(api.validateWatchMetadata({...item,watch_details:{...item.watch_details,condition}},api.watchAspects(item),liveConditions)), []);
  }
  assert.match(api.validateWatchMetadata({...item,watch_details:{...item.watch_details,condition:'USED_GOOD'}},api.watchAspects(item),liveConditions).join(','),/supported watch condition/);
});
