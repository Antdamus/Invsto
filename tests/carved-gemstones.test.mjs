import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {stripTypeScriptTypes} from 'node:module';
import {webcrypto} from 'node:crypto';
import vm from 'node:vm';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import '../collectible-core.js';
const core=globalThis.CollectibleFacts;
const read=path=>readFileSync(new URL(`../${path}`,import.meta.url),'utf8');
const metadata={category:{id:'12345',label:'Test collectible category'},aspects:[
  {localizedAspectName:'Material',aspectConstraint:{aspectRequired:true,aspectMode:'FREE_TEXT'}},
  {localizedAspectName:'Country of Origin',aspectConstraint:{aspectRequired:true,aspectMode:'SELECTION_ONLY'},aspectValues:[{localizedValue:'Unknown'},{localizedValue:'China'}]},
],policy:{itemConditionRequired:true,itemConditions:[{conditionId:'3000',conditionDescription:'Used'}]}};
const details={objectType:'Vase',material:'Jade',height:'24',dimensionUnit:'cm',conditionNotes:'Chipped rim',ebay:{categoryId:'12345',conditionId:'3000',aspects:{'Country of Origin':'Unknown'}}};
const item={id:'test',barcode:'JADE-1',title:'Jade Vase',description:'Floral carving.',weight:1200,sale_price:300,minimum_sale_price:180,photos:['https://example.invalid/public-ebay-photos/jade.jpg'],collectible_details:details,categories:['Carved Gemstones'],ebay_aspects:{Metal:['Fine Silver'],'Metal Purity':['925']},ebay_category_id:'261993',ebay_condition:'NEW'};
const settings={marketplace_id:'EBAY_US',currency:'USD',merchant_location_key:'main',default_category_id:'261993',default_condition:'NEW',listing_format:'FIXED_PRICE',category_rules:[]};
function backend() {
  const context={Deno:{env:{get:()=>''},serve(){}},console,TextEncoder,crypto:webcrypto,URL,URLSearchParams,Response,AbortSignal};
  vm.createContext(context);vm.runInContext(read('collectible-core.js'),context);
  vm.runInContext(stripTypeScriptTypes(read('supabase/functions/ebay-inventory-sync/index.ts').replace(/^import .*;\r?\n/gm,'')),context);
  return context;
}
test('collectible descriptions preserve units and damage without inferring age or jade variety',()=>{
  const description=core.description('Floral carving.',details,1200);
  assert.match(description,/Height: 24 cm/);assert.match(description,/Chipped rim/);assert.match(description,/1200 g/);
  assert.doesNotMatch(description,/jadeite|nephrite|antique|authentic|untreated/i);
  assert.equal(core.description(description,details,1200),description);
  assert.ok(core.validate({...details,depth:'-3'}).length);assert.ok(core.validate({...details,material:''}).length);
});
test('collectible listing validates live specifics and conditions, without jewelry fallback',async()=>{
  const api=backend(),prepared=await api.prepareItem({},item,1,settings,{copyMissingPhotos:false,collectibleMetadata:metadata});
  assert.deepEqual([...prepared.blockingReasons],[]);assert.equal(prepared.categoryId,'12345');assert.equal(prepared.inventoryPayload.condition,'USED_EXCELLENT');
  assert.equal(prepared.offerPayload.pricingSummary.price.value,'300.00');
  assert.doesNotMatch(JSON.stringify(prepared.inventoryPayload),/Fine Silver|Metal Purity|Unbranded/);
  const missing=await api.prepareItem({},item,1,settings,{copyMissingPhotos:false});assert.match(missing.blockingReasons.join(','),/requirements/);assert.equal(missing.inventoryPayload.condition,undefined);
  const cleared={...item,collectible_details:{...details,ebay:{}}};assert.equal(api.chooseCategory(cleared,settings).categoryId,'');
  assert.match(core.listing({...item,collectible_details:{...details,ebay:{...details.ebay,conditionId:'1000',aspects:{'Country of Origin':'Invented'}}}},metadata).reasons.join(','),/supported Country of Origin/);
  assert.match(core.listing({...item,collectible_details:{...details,ebay:{...details.ebay,conditionId:''}}},metadata).reasons.join(','),/condition/);
});
test('eBay category discovery uses keyword suggestions and rejects parent categories',async()=>{
  const api=backend();api.testMetadata=metadata;api.calls=[];
  vm.runInContext(`coinMetadataClient=async()=>({token:'test',treeId:'0'});ebayRequest=async(token,method,path)=>{
    calls.push(path);
    if(path.includes('get_category_suggestions'))return {categorySuggestions:[{category:{categoryId:'12345',categoryName:'Carvings'},categoryTreeNodeAncestors:[{categoryName:'Collectibles',categoryTreeNodeLevel:1}]}]};
    if(path.includes('get_category_subtree'))return {categorySubtreeNode:{category:{categoryId:'12345',categoryName:'Carvings'},leafCategoryTreeNode:!globalThis.testParent}};
    if(path.includes('get_item_aspects'))return {aspects:testMetadata.aspects};
    return {itemConditionPolicies:[{categoryId:'12345',...testMetadata.policy}]};
  };`,api);
  const categories=await api.searchCollectibleCategories('EBAY_US','jade vase & carving');
  assert.equal(categories[0].label,'Collectibles > Carvings');assert.match(api.calls[0],/jade%20vase%20%26%20carving/);
  api.testParent=true;await assert.rejects(api.loadCollectibleMetadata('EBAY_US','12345'),/parent/);
  api.testParent=false;assert.equal((await api.loadCollectibleMetadata('EBAY_US','12345')).category.id,'12345');
});
test('database saves collectible facts and updates eBay metadata without contaminating other item types',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create table item_types(id uuid primary key default gen_random_uuid(),title text,description text,categories text[],
      watch_details jsonb,coin_details jsonb,ebay_category_id text,ebay_condition text,ebay_sync_enabled boolean default false,
      ebay_aspects jsonb default '{}',stone_type text,item_length text,metal text,purity_basis_points numeric,weight numeric,
      sale_price numeric,barcode text,photos text[],photo_url text,deleted_at timestamptz);
      create table test_dirty_events(item_id uuid);
      create function mark_ebay_item_dirty_from_item() returns trigger language plpgsql as $$begin insert into test_dirty_events values(new.id); return new; end $$;`);
    await db.exec(read('supabase/migrations/20261106010000_carved_gemstone_collectibles.sql'));
    const {rows:[saved]}=await db.query(`insert into item_types(title,collectible_details) values('Jade Vase',$1) returning *`,[JSON.stringify(details)]);
    assert.equal(saved.collectible_details.height,'24');assert.equal(saved.ebay_category_id,'12345');assert.equal(saved.ebay_condition,'USED_EXCELLENT');assert.deepEqual(saved.ebay_aspects,{});
    assert.equal((await db.query('select inventory_material_key(i) k from item_types i where id=$1',[saved.id])).rows[0].k,null);
    await db.query(`update item_types set collectible_details=jsonb_set(collectible_details,'{ebay}','{}') where id=$1`,[saved.id]);
    const updated=(await db.query('select * from item_types where id=$1',[saved.id])).rows[0];assert.equal(updated.ebay_category_id,null);assert.equal(updated.ebay_condition,null);
    assert.equal((await db.query('select count(*)::int n from test_dirty_events')).rows[0].n,2);
    await assert.rejects(db.query(`insert into item_types(collectible_details,watch_details) values($1,'{}')`,[JSON.stringify(details)]),/item_types_collectible_details_check/);
    const {rows:[jewelry]}=await db.query(`insert into item_types(title,metal,purity_basis_points) values('Silver ring','silver',9250) returning *`);
    assert.equal(jewelry.ebay_category_id,'261994');assert.deepEqual(jewelry.ebay_aspects['Metal Purity'],['925']);
    const {rows:[watch]}=await db.query(`insert into item_types(watch_details) values('{"brand":"Rolex","condition":"USED_EXCELLENT"}') returning *`);
    assert.equal(watch.ebay_category_id,'31387');assert.equal(watch.ebay_condition,'USED_EXCELLENT');
  } finally {await db.close();}
});
