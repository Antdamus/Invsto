import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
let db;
const uid='11111111-1111-4111-8111-111111111111';
const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${uid}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function public.can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.staff',true)='yes'$$;
 create table item_types(id uuid primary key default gen_random_uuid(),title text,description text,sale_price numeric,pricing_status text,barcode text,photos text[],photo_url text,categories text[],metal text,purity_basis_points integer,weight numeric,created_at timestamptz,deleted_at timestamptz,cost numeric,minimum_sale_price numeric,distributor_notes text);
 set test.uid='${uid}';set test.staff='yes';`);
 // Use the actual category function, without the unrelated client RPCs.
 const filters=await read('supabase/migrations/20261011001000_catalogue_inventory_filters.sql');
 await db.exec(filters.slice(filters.indexOf('create or replace function public.catalogue_piece_type'),filters.indexOf('create or replace function public.browse_catalogue_inventory')));
 await db.exec(await read('supabase/migrations/20261105080000_daily_inventory_catalogues.sql'));
});
after(()=>db?.close());
const prep=async(date,recipient='Manny')=>(await db.query('select * from prepare_inventory_daily_catalogue($1,$2)',[date,recipient])).rows[0];
const publish=async(r,value=true)=>(await db.query('select * from publish_inventory_daily_catalogue($1,$2,$3)',[r.id,r.revision,value])).rows[0];
const shared=async(r)=>(await db.query('select shared_inventory_daily_catalogue($1) result',[r.share_token])).rows[0].result;
const insert=async(title,at,{price=250,photos=['item/a.jpg','item/a.jpg','item/b.jpg'],deleted=false}={})=>(await db.query(`insert into item_types(title,created_at,sale_price,photos,photo_url,deleted_at,cost,minimum_sale_price,distributor_notes,metal,purity_basis_points,weight)
 values($1,$2,$3,$4,'item/a.jpg',case when $5 then now() end,12,50,'SECRET','silver',9250,2.5) returning id`,[title,at,price,photos,deleted])).rows[0].id;

test('Eastern day includes both midnight boundaries correctly and all items beyond 100',async()=>{
 await insert('Before','2026-11-05T04:59:59Z');await insert('Start pendant','2026-11-05T05:00:00Z');await insert('End pendant','2026-11-06T04:59:59Z');await insert('After','2026-11-06T05:00:00Z');await insert('Deleted','2026-11-05T12:00:00Z',{deleted:true});
 await db.exec(`insert into item_types(title,created_at,sale_price,photos) select 'Ring '||n,'2026-11-05T14:00:00Z',150,array['item/a.jpg'] from generate_series(1,125) n`);
 const r=await prep('2026-11-05');assert.equal(r.draft.items.length,127);assert.equal(new Set(r.draft.items.map(i=>i.id)).size,127);
 assert.deepEqual(r.draft.items.find(i=>i.name==='Start pendant').photos,['item/a.jpg','item/b.jpg']);
 assert.equal(r.draft.items.some(i=>['Before','After','Deleted'].includes(i.name)),false);
 assert.equal(JSON.stringify(r.draft).includes('SECRET'),false);assert.equal(JSON.stringify(r.draft).includes('cost'),false);
 assert.equal(await shared(r),null);
});
test('25-hour fall DST day includes both 1:30 AM occurrences and correct end boundary',async()=>{
 await insert('DST before','2026-11-01T03:59:59Z');await insert('DST first','2026-11-01T05:30:00Z');await insert('DST second','2026-11-01T06:30:00Z');await insert('DST end','2026-11-02T04:59:59Z');await insert('DST after','2026-11-02T05:00:00Z');
 const r=await prep('2026-11-01');assert.deepEqual(r.draft.items.map(i=>i.name).sort(),['DST end','DST first','DST second']);
});
test('late additions refresh the same draft without changing published review; optimistic revision required',async()=>{
 let r=await prep('2026-11-05');r=await publish(r);const old=r;
 assert.equal((await shared(r)).items.length,127);
 await insert('Late bracelet','2026-11-06T04:20:00Z');r=await prep('2026-11-05');
 assert.equal(r.id,old.id);assert.equal(r.share_token,old.share_token);assert.equal(r.draft.items.length,128);assert.equal((await shared(r)).items.length,127);
 await assert.rejects(publish(old),/draft changed/);r=await publish(r);assert.equal((await shared(r)).items.length,128);
 const late=r.draft.items.find(i=>i.name==='Late bracelet');
 await db.query('update item_types set photos=$2,photo_url=null where id=$1',[late.id,['item/b.jpg']]);
 assert.deepEqual((await shared(r)).items.find(i=>i.id===late.id).photos,['item/b.jpg']);
 await db.query('update item_types set deleted_at=now() where id=$1',[late.id]);assert.equal((await shared(r)).items.length,127);
 r=await publish(r,false);assert.equal(await shared(r),null);
});
test('incomplete items are visible in draft, block publication, and can be fixed and regathered',async()=>{
 const id=await insert('Price pending','2026-11-03T15:00:00Z',{price:null});
 let r=await prep('2026-11-03');assert.equal(r.draft.items.length,1);assert.equal(r.draft.items[0].retail_price,null);
 await assert.rejects(publish(r),/Finish missing retail prices or photos/);
 await db.query('update item_types set sale_price=100,photos=$2,photo_url=null where id=$1',[id,[]]);r=await prep('2026-11-03');await assert.rejects(publish(r),/Finish missing retail prices or photos/);
 await db.query('update item_types set photos=$2 where id=$1',[id,['item/fixed.jpg']]);r=await prep('2026-11-03');await publish(r);
 await assert.rejects(publish(await prep('2001-01-01')),/no items/);
});
test('anonymous/non-staff cannot read drafts or create a shared selection; direct writes forbidden',async()=>{
 await db.exec('set role anon');await assert.rejects(db.query('select * from inventory_daily_catalogues'),/permission denied/);await assert.rejects(prep('2026-11-05'),/permission denied/);
 await db.exec("reset role;set test.staff='no';set role authenticated");assert.equal((await db.query('select * from inventory_daily_catalogues')).rows.length,0);await assert.rejects(prep('2026-11-05'),/staff access/);
 await assert.rejects(db.query('select shared_inventory_daily_catalogue(gen_random_uuid())'),/permission denied/);
 await db.exec("reset role;set test.staff='yes';set role authenticated");await assert.rejects(db.exec("update inventory_daily_catalogues set published=draft"),/permission denied/);await db.exec('reset role');
});
test('public review endpoint allowlists retail fields and rejects purchasing/invalid tokens',async()=>{
 let handler;const calls=[];
 const client={rpc:async(name)=>{calls.push(name);return{data:{title:'New',recipient:'Manny',source_date:'2026-11-05',prepared_at:'2026-11-05T16:00:00Z',company:'eBay',cost:200,items:[{id:uid,name:'Ring',description:'Silver',category:'Rings',retail_price:250,reference:'OG123',material:'silver',purity_basis_points:9250,weight:2.5,photos:['photo.jpg','https://project.example/storage/v1/object/sign/private/secret.jpg'],minimum_sale_price:20,private:'SECRET'}]}}},storage:{from:bucket=>({createSignedUrls:async paths=>{assert.equal(bucket,'photos');assert.deepEqual([...paths],['photo.jpg']);return{data:paths.map(path=>({path,signedUrl:'https://photos.example/'+path}))};}})}};
 const source=await read('supabase/functions/storefront-catalog/index.ts');
 vm.runInNewContext(stripTypeScriptTypes(source.replace(/^import .*;\r?\n/gm,'')),{URL,Response,Map,Set,createClient:()=>client,Deno:{env:{get:()=> 'https://project.example'},serve:fn=>handler=fn}});
 const response=await handler(new Request('https://edge.example/?daily_catalogue='+uid));const data=await response.json();
 assert.equal(response.status,200);assert.equal(calls[0],'shared_inventory_daily_catalogue');assert.deepEqual(data.items[0].images,['https://photos.example/photo.jpg']);assert.equal(data.recipient,'Manny');assert.equal(data.items[0].retail_price,250);assert.ok(!JSON.stringify(data).includes('SECRET'));assert.ok(!JSON.stringify(data).includes('cost'));assert.ok(!JSON.stringify(data).includes('minimum_sale_price'));
 assert.equal((await handler(new Request('https://edge.example/?daily_catalogue='+uid,{method:'POST'}))).status,405);
 assert.equal((await handler(new Request('https://edge.example/?daily_catalogue=bad'))).status,404);
});
