import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
import { webcrypto } from 'node:crypto';
import * as core from '../coin-ebay-core.mjs';
const metadata=JSON.parse(readFileSync(new URL('./fixtures/coin-ebay-metadata.json',import.meta.url),'utf8'));
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const base={id:'coin',barcode:'coin-001',title:'1881 Morgan dollar',description:'Silver collector coin.',sale_price:90,minimum_sale_price:55,cost:40,photos:['https://example.invalid/public-ebay-photos/front.jpg','https://example.invalid/public-ebay-photos/back.jpg'],ebay_category_id:'39464',coin_details:{name:'Morgan dollar',year:'1881',metal:'Silver',fineness:'900',country:'United States',denomination:'$1',gradingStatus:'ungraded',condition:'Circulated',ebay:{categoryId:'39464',categoryLabel:metadata['39464'].category.label,photosConfirmed:true,descriptors:{'2':{values:['9']}}}}};
function graded(){const item=structuredClone(base);Object.assign(item.coin_details,{gradingStatus:'certified',grade:'MS 65',gradingService:'PCGS',certNumber:'00012345'});item.coin_details.ebay.descriptors=core.seedCoinDescriptors(item.coin_details,metadata['39464']);return item;}
function backend(){const ctx={buildCoinListing:core.buildCoinListing,Deno:{env:{get:()=>''},serve(){}},console,TextEncoder,crypto:webcrypto,URL,URLSearchParams,Response,AbortSignal};vm.createContext(ctx);vm.runInContext(stripTypeScriptTypes(read('supabase/functions/ebay-inventory-sync/index.ts').replace(/^import .*;\r?\n/gm,'')),ctx);return ctx;}
const settings={marketplace_id:'EBAY_US',currency:'USD',merchant_location_key:'main',default_category_id:'261993',default_condition:'NEW',listing_format:'FIXED_PRICE',category_rules:[]};
test('raw collector coin uses live descriptors, year, actual metal and fractional fineness',()=>{
 const result=core.buildCoinListing(base,metadata['39464']);
 assert.deepEqual(result.reasons,[]);assert.equal(result.condition,'USED_VERY_GOOD');
 assert.deepEqual(result.conditionDescriptors,[{name:'2',values:['9']}]);
 assert.deepEqual(result.aspects.Fineness,['0.9']);assert.deepEqual(result.aspects.Year,['1881']);
 assert.equal(result.aspects['Metal Purity'],undefined);assert.equal(result.aspects.Brand,undefined);
});
test('certified coins preserve the grader, dependent letter/numeric grade and leading-zero certification',()=>{
 const item=graded();const result=core.buildCoinListing(item,metadata['39464']);
 assert.deepEqual(result.reasons,[]);assert.equal(result.condition,'LIKE_NEW');
 assert.deepEqual(result.conditionDescriptors,[{name:'1',values:['14']},{name:'3',values:['18']},{name:'4',values:['55']},{name:'5',additionalInfo:'00012345'}]);
 item.coin_details.ebay.descriptors['3']={values:['19']};
 assert.match(core.buildCoinListing(item,metadata['39464']).reasons.join(','),/valid Numerical grade/);
 item.coin_details.ebay.descriptors['5']={additionalInfo:'1'.repeat(21)};
 assert.match(core.buildCoinListing(item,metadata['39464']).reasons.join(','),/maximum 20/);
});
test('graded fields do not leak into raw condition payloads; raw claims and incomplete photos are blocked',()=>{
 const item=graded();item.coin_details.gradingStatus='self-assessed';item.coin_details.ebay.descriptors['2']={values:['8']};
 const result=core.buildCoinListing(item,metadata['39464']);
 assert.deepEqual(result.conditionDescriptors,[{name:'2',values:['8']}]);assert.doesNotMatch(result.description,/00012345|MS 65|Professional grader/);
 item.title='Morgan dollar MS 65';item.photos=[item.photos[0],item.photos[0]];item.coin_details.ebay.photosConfirmed=false;item.sale_price=2500;
 const reasons=core.buildCoinListing(item,metadata['39464']).reasons.join(',');
 assert.match(reasons,/numeric grading claims/);assert.match(reasons,/front and back/);assert.match(reasons,/below \$2,500/);
});
test('gold and silver bullion use Certification specifics and omit unsupported condition fields',async()=>{
 for(const [id,metal] of [['177652','Gold'],['177653','Silver']]){
  const item=structuredClone(base);item.coin_details.ebay={categoryId:id,photosConfirmed:true};item.coin_details.metal=metal;item.coin_details.fineness='999.9';item.coin_details.fineMetalContent='1 troy oz';item.ebay_category_id=id;
  const prepared=await backend().prepareItem({},item,2,settings,{copyMissingPhotos:false,coinMetadata:metadata[id]});
  assert.deepEqual(plain(prepared.blockingReasons),[]);
  assert.equal(prepared.inventoryPayload.condition,undefined);assert.equal(prepared.inventoryPayload.conditionDescriptors,undefined);
  assert.deepEqual(plain(prepared.inventoryPayload.product.aspects.Certification),['Uncertified']);
  assert.deepEqual(plain(prepared.inventoryPayload.product.aspects.Fineness),['0.9999']);
  assert.equal(prepared.offerPayload.pricingSummary.price.value,'90.00');
 }
});
test('coin API payload uses retail only and cannot fall back to the jewelry category',async()=>{
 const api=backend();const prepared=await api.prepareItem({},base,1,settings,{copyMissingPhotos:false,coinMetadata:metadata['39464']});
 assert.equal(prepared.categoryId,'39464');assert.equal(prepared.inventoryPayload.condition,'USED_VERY_GOOD');
 assert.equal(prepared.offerPayload.pricingSummary.price.value,'90.00');
 assert.deepEqual(plain(prepared.blockingReasons),[]);
 const serialized=JSON.stringify([prepared.inventoryPayload,prepared.offerPayload]);assert.doesNotMatch(serialized,/minimum_sale_price|"55.00"|Unbranded|Metal Purity|"NEW"/);
 const unavailable=await api.prepareItem({},base,1,settings,{copyMissingPhotos:false});assert.match(unavailable.blockingReasons.join(','),/coin requirements could not be verified/);
 const noCategory={...base,ebay_category_id:null,coin_details:{...base.coin_details,ebay:{}}};assert.equal(api.chooseCategory(noCategory,settings).categoryId,'');
});
test('coin CSV exports category, descriptor IDs and retail only; missing metadata blocks export',async()=>{
 const ctx={window:{CoinEbay:core},console,setTimeout,clearTimeout};vm.createContext(ctx);vm.runInContext(read('ebayExport.js'),ctx);
 vm.runInContext('getQuantitiesByItemId=async()=>({coin:1});getPublicImageUrls=async()=>"front.jpg|back.jpg";',ctx);
 const headers=['Category ID','Start price','Condition ID','C:Year','C:Fineness','CD:Coin Condition - (ID: 2)','C:Brand','C:Metal Purity'];
 const options={coinMetadataMap:new Map([['39464',metadata['39464']]])};
 const rows=await ctx.buildListingRows([base],headers,ctx.window.EBAY_EXPORT_PROFILES.coin,options);
 assert.deepEqual(plain(rows[0]),['39464',90,'4000','1881','0.9','9','','']);
 await assert.rejects(()=>ctx.buildListingRows([base],headers,ctx.window.EBAY_EXPORT_PROFILES.coin,{}),/load the coin eBay category/);
 const gradedHeaders=['Condition ID','CD:Professional grader - (ID: 1)','CD:Letter grade - (ID: 3)','CD:Numerical grade - (ID: 4)','CDA:Certification number - (ID: 5)'];
 assert.deepEqual(plain((await ctx.buildListingRows([graded()],gradedHeaders,ctx.window.EBAY_EXPORT_PROFILES.coin,options))[0]),['2750','14','18','55','00012345']);
});

function syncHandler(item,{inventoryStatus=204}={}){
 let handler;const calls=[];
 const query={insert(){return this;},update(){return this;},upsert(){return this;},select(){return this;},eq(){return this;},single:async()=>({data:{id:'test-run'}}),then(resolve,reject){return Promise.resolve({data:null}).then(resolve,reject);}};
 const context={buildCoinListing:core.buildCoinListing,createClient:()=>({from:()=>Object.create(query)}),Deno:{env:{get:name=>({SUPABASE_URL:'https://example.invalid',SUPABASE_SERVICE_ROLE_KEY:'test',EBAY_SYNC_ALLOW_PUBLISH:'true'})[name]},serve:fn=>handler=fn},console,Request,Response,TextEncoder,crypto:webcrypto,URL,URLSearchParams,AbortSignal,testItem:item,testMetadata:metadata['39464'],testSettings:{...settings,enabled:true,publish_enabled:true,payment_policy_id:'p',return_policy_id:'r',fulfillment_policy_id:'f'},calls,inventoryStatus};
 vm.createContext(context);vm.runInContext(stripTypeScriptTypes(read('supabase/functions/ebay-inventory-sync/index.ts').replace(/^import .*;\r?\n/gm,'')),context);
 vm.runInContext(`loadItems=async()=>[{...testItem,quantity:1}];loadSettings=async()=>testSettings;loadEbayLinks=async()=>[];loadCoinMetadata=async()=>testMetadata;recordEbayLinkState=async()=>{};getEbayAccessToken=async()=>"test";findExistingEbayOffer=async()=>null;ebayRequest=async(token,method,path,body)=>{calls.push({method,path,body});if(path.includes("bulk_create"))return {responses:[{sku:testItem.barcode,statusCode:inventoryStatus,errors:inventoryStatus>=400?[{message:"Test inventory rejected"}]:[]}]};if(path.endsWith("/publish"))return {listingId:"test-listing"};return {offerId:"test-offer"};};`,context);
 return {calls,invoke:async()=> (await handler(new Request('https://example.invalid',{method:'POST',body:JSON.stringify({dryRun:false,publish:true,itemIds:[item.id]})}))).json()};
}
test('complete coin publish flow sends descriptors and retail through inventory, offer and publish APIs',async()=>{
 const api=syncHandler(base);const result=await api.invoke();
 assert.equal(result.ok,true);assert.equal(result.results[0].published,true);
 assert.equal(api.calls.length,3);assert.deepEqual(plain(api.calls[0].body.requests[0].conditionDescriptors),[{name:'2',values:['9']}]);
 assert.equal(api.calls[1].body.pricingSummary.price.value,'90.00');assert.match(api.calls[2].path,/publish$/);
});
test('invalid coin details or per-item eBay errors prevent offer creation and publishing',async()=>{
 const missing=structuredClone(base);missing.coin_details.ebay.descriptors={};
 const blocked=syncHandler(missing);const result=await blocked.invoke();
 assert.equal(result.ok,false);assert.match(result.results[0].error,/Coin Condition/);assert.equal(blocked.calls.length,0);
 const rejected=syncHandler(base,{inventoryStatus:400});const failed=await rejected.invoke();
 assert.equal(failed.ok,false);assert.match(failed.results[0].error,/Test inventory rejected/);assert.equal(rejected.calls.length,1);
});


test('clearing a coin category cannot reuse an old category, and failed photo copies block API and CSV listings',async()=>{
 const api=backend();
 const cleared={...base,coin_details:{...base.coin_details,ebay:{...base.coin_details.ebay,categoryId:''}}};
 assert.equal(api.chooseCategory(cleared,settings).categoryId,'');
 assert.match(core.buildCoinListing(cleared,metadata['39464']).reasons.join(','),/load the coin eBay category/);
 vm.runInContext('ensurePublicImageUrls=async()=>["https://example.invalid/front.jpg"];',api);
 const prepared=await api.prepareItem({},base,1,settings,{copyMissingPhotos:true,coinMetadata:metadata['39464']});
 assert.match(prepared.blockingReasons.join(','),/both front and back photos/);
 const csv={window:{CoinEbay:core},console,setTimeout,clearTimeout};vm.createContext(csv);vm.runInContext(read('ebayExport.js'),csv);
 vm.runInContext('getQuantitiesByItemId=async()=>({coin:1});getPublicImageUrls=async()=>"front.jpg";',csv);
 await assert.rejects(()=>csv.buildListingRows([base],['Item photo URL'],csv.window.EBAY_EXPORT_PROFILES.coin,{coinMetadataMap:new Map([['39464',metadata['39464']]])}),/both front and back photos/);
});
