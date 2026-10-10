import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
let db;const uid='11111111-1111-4111-8111-111111111111',item='22222222-2222-4222-8222-222222222222',pending='33333333-3333-4333-8333-333333333333';
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${uid}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function public.can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.staff',true)='yes'$$;
 create table item_types(id uuid primary key,title text,description text,sale_price numeric,pricing_status text,barcode text,photos text[],photo_url text,categories text[],metal text,purity_basis_points integer,created_at timestamptz default now(),deleted_at timestamptz,cost numeric,minimum_sale_price numeric,distributor_notes text);
 insert into item_types(id,title,description,sale_price,pricing_status,photos,cost,minimum_sale_price,distributor_notes) values
 ('${item}','Diamond watch','A beautiful watch',5210,'ready',array['watch/1.jpg','watch/2.jpg'],1800,2300,'PRIVATE'),
 ('${pending}','Unpriced ring','Ring',null,'pending',array['ring.jpg'],null,null,'PRIVATE');
 set test.uid='${uid}';set test.staff='yes';`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261010210000_inventory_catalogues.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261011001000_catalogue_inventory_filters.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
const selection=[{id:item,category:'Watches',photos:['watch/1.jpg']}];
const save=async({id=null,revision=0,items=selection,publish=false,credit=5000}={})=>(await db.query('select * from save_inventory_catalogue($1,$2,$3,$4,$5,$6,$7)',[id,revision,'Your collection','Selected for you',credit,JSON.stringify(items),publish])).rows[0];
const shared=async token=>(await db.query('select shared_inventory_catalogue($1) result',[token])).rows[0].result;
let c;
test('drafts remain private; public lookup includes only retail fields and selected photos',async()=>{
 c=await save();assert.equal(await shared(c.share_token),null);
 c=await save({id:c.id,revision:c.revision,publish:true});
 const result=await shared(c.share_token);
 assert.deepEqual(Object.keys(result).sort(),['credit','currency','introduction','items','title']);
 assert.deepEqual(Object.keys(result.items[0]).sort(),['category','description','id','name','photos','retail_price']);
 assert.equal(result.items[0].retail_price,5210);assert.deepEqual(result.items[0].photos,['watch/1.jpg']);
 assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});
test('unpriced items, arbitrary photos, duplicate items, empty publication and invalid credit are rejected',async()=>{
 await assert.rejects(save({items:[{id:pending,category:'Rings',photos:['ring.jpg']}],publish:true}),/retail price/);
 await assert.rejects(save({items:[{...selection[0],photos:['another-customer/private.jpg']}],publish:true}),/photo is no longer/);
 await assert.rejects(save({items:[...selection,...selection]}),/only appear once/);
 await assert.rejects(save({items:[],publish:true}),/at least one/);
 await assert.rejects(save({credit:-1}),/valid credit/);
 await assert.rejects(save({credit:1.111}),/valid credit/);
});
test('concurrent edits fail safely; inventory price updates propagate and removed photos/items do not remain public',async()=>{
 await assert.rejects(save({id:c.id,revision:1,publish:true}),/Someone changed/);
 await db.exec(`update item_types set sale_price=5500,photos=array['watch/2.jpg'] where id='${item}'`);
 let result=await shared(c.share_token);assert.equal(result.items[0].retail_price,5500);assert.deepEqual(result.items[0].photos,[]);
 await db.exec(`update item_types set pricing_status='pending' where id='${item}'`);assert.equal((await shared(c.share_token)).items.length,0);
 await db.exec(`update item_types set pricing_status='ready',deleted_at=now() where id='${item}'`);assert.equal((await shared(c.share_token)).items.length,0);
 await db.exec(`update item_types set deleted_at=null,photos=array['watch/1.jpg','watch/2.jpg'] where id='${item}'`);
});
test('turning off link is immediate and does not depend on items still being available',async()=>{
 await db.exec(`update item_types set deleted_at=now() where id='${item}'`);
 c=(await db.query('select * from unpublish_inventory_catalogue($1,$2)',[c.id,c.revision])).rows[0];
 assert.equal(await shared(c.share_token),null);
 await db.exec(`update item_types set deleted_at=null where id='${item}'`);
});
test('custom client prices are optional, catalogue-specific, and never reveal underlying inventory prices',async()=>{
 const custom=await save({items:[{...selection[0],retail_override:4999.95}],publish:true});
 let result=await shared(custom.share_token);assert.equal(result.items[0].retail_price,4999.95);
 assert.equal(JSON.stringify(result).includes('5500'),false);assert.equal(JSON.stringify(result).includes('retail_override'),false);
 assert.equal((await db.query('select sale_price from item_types where id=$1',[item])).rows[0].sale_price,'5500');
 await assert.rejects(save({items:[{...selection[0],retail_override:0}]}),/custom client price/);
 await assert.rejects(save({items:[{...selection[0],retail_override:1.111}]}),/custom client price/);
 const reset=await save({id:custom.id,revision:custom.revision,publish:true});result=await shared(reset.share_token);assert.equal(result.items[0].retail_price,5500);
});
test('anonymous and nonstaff access cannot list catalogues, read inventory, publish, or resolve tokens',async()=>{
 await db.exec('set role anon');
 await assert.rejects(db.query('select * from inventory_catalogues'),/permission denied/);
 await assert.rejects(shared(c.share_token),/permission denied/);
 await assert.rejects(save(),/permission denied/);
 await db.exec("reset role;set test.staff='no';set role authenticated");
 assert.equal((await db.query('select * from inventory_catalogues')).rows.length,0);
 await assert.rejects(save(),/staff access/);
 await assert.rejects(db.query('select catalogue_inventory()'),/staff access/);
 await assert.rejects(shared(c.share_token),/permission denied/);
 await db.exec("reset role;set test.staff='yes';set role authenticated");
 await assert.rejects(db.exec("update inventory_catalogues set status='published'"),/permission denied/);
 const items=(await db.query('select catalogue_inventory() result')).rows[0].result;
 assert.ok(!JSON.stringify(items).includes('PRIVATE'));assert.ok(!JSON.stringify(items).includes('minimum_sale_price'));
 await db.exec('reset role');
});
test('selection credit uses cents, cannot go negative, and filters/sorts operate on retail only',async()=>{
 const context={Intl,URL};vm.runInNewContext(await readFile(new URL('../catalogue-core.js',import.meta.url),'utf8'),context);const C=context.Catalogue;
 const items=[{id:'a',name:'Watch',description:'Gold',category:'Watches',retail_price:10.10},{id:'b',name:'Ring',description:'Diamond',category:'Rings',retail_price:20.20}];
 assert.equal(C.totals(items,new Set(['a','b']),25).total,30.3);assert.equal(C.totals(items,new Set(['a','b']),25).due,5.3);assert.equal(C.totals(items,new Set(['a','b']),25).remaining,0);
 assert.equal(C.totals(items,new Set(['a']),25).remaining,14.9);assert.equal(C.totals(items,new Set(),25).remaining,25);
 assert.equal(C.filter(items,{category:'Rings',min:'15',max:'25'})[0].id,'b');assert.equal(C.filter(items,{sort:'price-high'})[0].id,'b');
 assert.ok(!C.card({...items[0],name:'<script>alert(1)</script>',images:['javascript:alert(1)']}).includes('<script>'));
});
test('Edge endpoint never exposes internal fields even if upstream returns them; signs only curated photos',async()=>{
 let handler;const requested=[];const client={rpc:async()=>({data:{title:'Private selection',credit:20,cost:9999,items:[{id:item,name:'Watch',description:'Gold',category:'Watches',retail_price:50,photos:['watch/1.jpg'],cost:20,minimum_sale_price:30,private:'SECRET'}]}}),storage:{from:bucket=>({createSignedUrls:async paths=>{requested.push({bucket,paths});return{data:paths.map(path=>({path,signedUrl:`https://images.example/${path}`}))};}})}};
 const src=await readFile(new URL('../supabase/functions/storefront-catalog/index.ts',import.meta.url),'utf8');
 const code=stripTypeScriptTypes(src.replace(/^import .*;\r?\n/gm,''));
 vm.runInNewContext(code,{URL,Response,Map,Set,createClient:()=>client,Deno:{env:{get:()=> 'https://project.example'},serve:fn=>handler=fn}});
 const response=await handler(new Request(`https://edge.example/?catalogue=${uid}`));const data=await response.json();
 assert.equal(response.status,200);assert.equal(data.items[0].retail_price,50);assert.deepEqual(data.items[0].images,['https://images.example/watch/1.jpg']);
 assert.deepEqual(Object.keys(data.items[0]).sort(),['category','description','id','images','name','retail_price']);
 assert.deepEqual(JSON.parse(JSON.stringify(requested)),[{bucket:'photos',paths:['watch/1.jpg']}]);
 assert.ok(!JSON.stringify(data).includes('SECRET'));assert.ok(!JSON.stringify(data).includes('cost'));
 const invalid=await handler(new Request('https://edge.example/?catalogue=bad'));assert.equal(invalid.status,404);
});


test('builder filters all inventory before pagination and combines metal, purity, type and search',async()=>{
 await db.exec(`insert into item_types(id,title,metal,purity_basis_points,barcode,sale_price,photos,categories)
 select gen_random_uuid(),'14K Gold Chain Bracelet '||n,'gold',5833,'FILTER-'||n,1200,array['test.jpg'],array['Chains'] from generate_series(1,30) n;
 insert into item_types(id,title,metal,purity_basis_points,barcode,sale_price,photos,categories) values
 (gen_random_uuid(),'925 Sterling Silver Pendant','silver',9250,'FILTER-P',250,array['test.jpg'],array['Necklaces']),
 (gen_random_uuid(),'18K Gold Chain','gold',7500,'FILTER-C',2000,array['test.jpg'],array['Necklaces']),
 (gen_random_uuid(),'Unspecified material bracelet',null,null,'FILTER-U',100,array['test.jpg'],'{}');`);
 const browse=async(args=[])=>(await db.query('select browse_catalogue_inventory($1,$2,$3,$4,$5) result',args.length?args:['',0,'','',''])).rows[0].result;
 const first=await browse(['FILTER',0,'gold','5833','Bracelets']);
 assert.equal(first.total,30);assert.equal(first.items.length,24);
 assert.ok(first.items.every(i=>i.material==='gold' && i.purity_basis_points===5833 && i.piece_type==='Bracelets'));
 const second=await browse(['FILTER',24,'gold','5833','Bracelets']);assert.equal(second.items.length,6);
 assert.equal(new Set([...first.items,...second.items].map(i=>i.id)).size,30);
 assert.ok(first.facets.purities.every(p=>p.material==='gold'));
 assert.equal((await browse(['FILTER',0,'silver','9250','Pendants'])).total,1);
 assert.equal((await browse(['FILTER',0,'gold','7500','Chains'])).total,1);
 assert.equal((await browse(['FILTER',0,'silver','9250','Chains'])).total,0);
 assert.equal((await browse(['FILTER',0,'unspecified','unspecified','Bracelets'])).total,1);
 assert.ok(!JSON.stringify(first).includes('cost'));
 await db.exec("set role anon");await assert.rejects(browse(),/permission denied/);
 await db.exec("reset role;set test.staff='no';set role authenticated");await assert.rejects(browse(),/staff access/);
 await db.exec("reset role;set test.staff='yes'");
});

test('piece types distinguish chains and pendants, respect explicit titles, and do not use brand as watch proof',async()=>{
 const context={Intl,URL};vm.runInNewContext(await readFile(new URL('../catalogue-core.js',import.meta.url),'utf8'),context);const C=context.Catalogue;
 for(const [title,tags,want] of [
 ['Cartier Love ring',[],'Rings'],['Gold chain bracelet',['Chains'],'Bracelets'],['Diamond pendant with chain',['Necklaces'],'Pendants'],['10K Gold Curb Chain Necklace',[],'Chains'],['Pearl necklace',[],'Necklaces'],['Silver earrings',[],'Earrings'],['Datejust watch',[],'Watches'],['Unspecified piece',['Pendants'],'Pendants'],['Cartier',[],'Other']]){
  assert.equal(C.categoryFor({title,categories:tags}),want,title);
  assert.equal((await db.query('select catalogue_piece_type($1,$2) value',[title,tags])).rows[0].value,want,title);
 }
 assert.equal(C.clientCategory({name:'14K pendant',category:'Necklaces'}),'Pendants');
 assert.equal(C.clientCategory({name:'Chain bracelet',category:'Bracelets'}),'Bracelets');
 for(const category of ['Chains','Pendants','Anklets','Coins']){
  const saved=await save({items:[{...selection[0],category}],publish:true});
  assert.equal((await shared(saved.share_token)).items[0].category,category);
 }
});
