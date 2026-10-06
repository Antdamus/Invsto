import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after,beforeEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const actor='00000000-0000-4000-8000-000000000010',attempt='00000000-0000-4000-8000-000000000001',photo='00000000-0000-4000-8000-000000000020';
const path=`live-bags/${attempt}/${actor}/${photo}.jpg`,captured='2026-10-06T20:00:00Z';
const attach=async(overrides={})=>{
 const p={attempt,photo,path,width:720,height:1280,captured,...overrides};
 return (await db.query('select to_jsonb(attach_ebay_live_bag_photo($1,$2,$3,$4,$5,$6)) as photo',[p.attempt,p.photo,p.path,p.width,p.height,p.captured])).rows[0].photo;
};
before(async()=>{
 db=new PGlite();await db.exec(`
 create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key);insert into auth.users values('${actor}');
 create function auth.uid() returns uuid language sql as $$select current_setting('test.actor')::uuid$$;
 create function can_manage_inventory() returns boolean language sql as $$select current_setting('test.allowed')='yes'$$;
 create table live_sale_lots(id uuid primary key,status text);insert into live_sale_lots values('${attempt}','open');
 create table ebay_live_attempts(id uuid primary key,event_id text,lot_id uuid,payment_state text,buyer text,resolved_at timestamptz,merged_into uuid,hold boolean default false);
 insert into ebay_live_attempts(id,event_id,lot_id,payment_state,buyer) values('${attempt}','EVENT123','${attempt}','paid','winner');
 create function ebay_live_has_payment_hold(a ebay_live_attempts) returns boolean language sql as $$select a.hold$$;
 create table ebay_live_audit(event_id text,attempt_id uuid,action text,details jsonb);
 create table storage.objects(bucket_id text,name text,metadata jsonb);
 `);
 await db.exec(await readFile(new URL('../supabase/migrations/20261006210000_live_bag_stream_photos.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{await db.exec(`set test.actor='${actor}';set test.allowed='yes';truncate live_sale_bag_photos,ebay_live_audit,storage.objects;update ebay_live_attempts set payment_state='paid',buyer='winner',resolved_at=null,merged_into=null,hold=false;update live_sale_lots set status='open';`);});
after(async()=>db?.close());
const uploaded=()=>db.query('insert into storage.objects values($1,$2,$3)',['photos',path,{mimetype:'image/jpeg',size:150000}]);
test('only completed uploads attach to the exact bag and retries create one photo and audit event',async()=>{
 await assert.rejects(attach(),/upload is not complete/);await uploaded();const first=await attach(),second=await attach();
 assert.equal(first.id,second.id);assert.equal(first.lot_id,attempt);assert.equal(first.created_by,actor);
 assert.equal((await db.query('select count(*)::int n from live_sale_bag_photos')).rows[0].n,1);
 assert.equal((await db.query('select count(*)::int n from ebay_live_audit')).rows[0].n,1);
 assert.equal((await db.query('select status from live_sale_lots')).rows[0].status,'open','attaching does not reserve or close the bag');
 await assert.rejects(attach({width:640}),/different capture/);
});
test('wrong bag paths, untrusted formats, oversized photos, and unauthorized access are rejected',async()=>{
 await uploaded();await assert.rejects(attach({path:path.replace(attempt,actor)}),/does not belong/);
 await assert.rejects(attach({path:path.replace(actor,attempt)}),/does not belong/);
 await assert.rejects(attach({width:1601}),/dimensions/);
 await db.exec(`update storage.objects set metadata='{"mimetype":"text/html","size":200}'`);await assert.rejects(attach(),/upload is not complete/);
 await db.exec(`update storage.objects set metadata='{"mimetype":"image/jpeg","size":3000001}'`);await assert.rejects(attach(),/upload is not complete/);
 await db.exec("set test.allowed='no'");await assert.rejects(attach(),/Inventory access required/);
 assert.equal((await db.query("select has_function_privilege('anon','attach_ebay_live_bag_photo(uuid,uuid,text,integer,integer,timestamptz)','execute') allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_table_privilege('authenticated','live_sale_bag_photos','insert') allowed")).rows[0].allowed,false);
});
test('changed payment, holds, merged attempts and cancelled bags cannot receive photos',async()=>{
 await uploaded();
 for(const change of ["payment_state='waiting'","payment_state='failed'","buyer=''","resolved_at=now()","merged_into=gen_random_uuid()","hold=true"]){
  await db.exec('update ebay_live_attempts set '+change);await assert.rejects(attach(),/Payment is not confirmed/);
  await db.exec("update ebay_live_attempts set payment_state='paid',buyer='winner',resolved_at=null,merged_into=null,hold=false");
 }
 await db.exec("update live_sale_lots set status='cancelled'");await assert.rejects(attach(),/no longer available/);
 assert.equal((await db.query('select count(*)::int n from live_sale_bag_photos')).rows[0].n,0);
});
