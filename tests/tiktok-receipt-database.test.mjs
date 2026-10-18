import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;
const actor='00000000-0000-4000-8000-000000000001',transfer='00000000-0000-4000-8000-000000000002',order='577620684385522369',sku='1732759903849189622',path=`${actor}/${transfer}.jpg`;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;create table auth.users(id uuid primary key);insert into auth.users values('${actor}');create function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;create function can_manage_inventory() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;create table storage.objects(bucket_id text,name text);alter table storage.objects enable row level security;grant usage on schema auth,storage to authenticated;grant select,insert on storage.objects to authenticated;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);create table ebay_orders(order_number text,notes text);insert into ebay_orders values('${order}','Never change eBay');`);
 for(const file of ['20261018030000_tiktok_order_workspace.sql','20261018050000_tiktok_receipt_photos.sql','20261018060000_tiktok_receipt_thumbnails.sql'])await db.exec(await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8'));
});
after(()=>db.close());
beforeEach(async()=>{
 await db.exec("reset role;set test.allowed='yes';truncate tiktok_order_receipt_photos,tiktok_order_documents,tiktok_order_events,tiktok_order_lines,tiktok_orders,tiktok_order_imports,storage.objects cascade;");
 await db.exec(`create or replace function auth.uid() returns uuid language sql as $$select '${actor}'::uuid$$;`);
 await db.query(`insert into tiktok_orders(order_number,buyer_username,marketplace_status,marketplace_substatus,source_snapshot_at) values($1,'fixture','To ship','Awaiting shipment',now()),($2,'other','Completed','Completed',now())`,[order,'577620684385522370']);
 await db.query(`insert into tiktok_order_lines(order_id,sku_id,title,quantity) select id,$1,'Ring',1 from tiktok_orders`,[sku]);
 await db.query(`insert into tiktok_order_lines(order_id,sku_id,title,quantity) select id,$1,'Earrings',1 from tiktok_orders where order_number=$2`,['1732759903849189623',order]);
});
const save=(o=order,s=sku,p=path,t=336.9)=>db.query('select attach_tiktok_receipt_photo($1,$2,$3,$4,$5) r',[o,s,transfer,p,t]);
test('capture matches exact order plus SKU, is retry-safe and survives refreshed line data',async()=>{
 await db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos',path]);
 const photo=(await save()).rows[0].r;assert.equal((await save()).rows[0].r.id,photo.id);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_receipt_photos')).rows[0].n,1);
 const linked=(await db.query('select o.order_number,l.sku_id from tiktok_order_receipt_photos p join tiktok_order_lines l on l.id=p.line_id join tiktok_orders o on o.id=l.order_id')).rows;
 assert.deepEqual(linked,[{order_number:order,sku_id:sku}]);
 await assert.rejects(save('577620684385522370'),/another item/);
 await assert.rejects(save(order,'1732759903849189623'),/another item/);
 await db.query("update tiktok_order_lines set tracking_number='REFRESHED' where id=$1",[photo.line_id]);
 await db.query("update tiktok_orders set stage='dispatched' where order_number=$1",[order]);
 assert.equal((await save()).rows[0].r.line_id,photo.line_id);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_events')).rows[0].n,1);
 assert.deepEqual((await db.query('select * from ebay_orders')).rows,[{order_number:order,notes:'Never change eBay'}]);
});
test('reject missing/mismatched IDs, missing storage, other-user paths and unauthorized saves',async()=>{
 await assert.rejects(save(),/Upload/);await assert.rejects(save('999999999999999999'),/not found/);await assert.rejects(save(order,'999999999999999999'),/not found/);
 await assert.rejects(save(order,sku,'other/photo.jpg'),/Invalid/);await assert.rejects(save(order,sku,path,-1),/Invalid/);
 await db.exec("set test.allowed='no'");await assert.rejects(save(),/access required/);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_receipt_photos')).rows[0].n,0);
});
test('receipt storage stays private, staff uploads are own-folder only and writes require the RPC',async()=>{
 assert.equal((await db.query("select public from storage.buckets where id='tiktok-receipt-photos'")).rows[0].public,false);
 await db.exec('set role authenticated');
 await db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos',path]);
 await db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos',`${actor}/${transfer}-thumb.jpg`]);
 await assert.rejects(db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos','someone-else/'+transfer+'.jpg']),/row-level security/);
 await assert.rejects(db.exec('delete from tiktok_order_receipt_photos'),/permission denied/);
 await db.exec("set test.allowed='no'");assert.equal((await db.query('select * from storage.objects')).rows.length,0);
});

const thumb=`${actor}/${transfer}-thumb.jpg`;
const saveV2=(preview=thumb,imageBytes=150000,thumbBytes=9000)=>db.query('select attach_tiktok_receipt_photo_v2($1,$2,$3,$4,$5,$6,$7,$8) r',[order,sku,transfer,path,337,preview,imageBytes,thumbBytes]);
test('two-size save is atomic, retry-safe and requires both uploaded files',async()=>{
 await db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos',path]);
 await assert.rejects(saveV2(),/Upload the receipt thumbnail/);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_receipt_photos')).rows[0].n,0);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_events')).rows[0].n,0);
 await db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos',thumb]);
 await assert.rejects(saveV2('someone-else/'+transfer+'-thumb.jpg'),/Invalid/);
 await assert.rejects(saveV2(thumb,150000,262145),/Invalid/);
 const photo=(await saveV2()).rows[0].r;
 assert.equal(photo.thumbnail_path,thumb);assert.equal(photo.image_bytes,150000);assert.equal(photo.thumbnail_bytes,9000);
 assert.deepEqual((await saveV2()).rows[0].r,photo);
 assert.equal((await db.query('select count(*)::int n from tiktok_order_events')).rows[0].n,1);
 await db.exec("set test.allowed='no'");await assert.rejects(saveV2(),/access required/);
});
test('legacy photo backfill permits other staff, preserves its line/history and never replaces a finished thumbnail',async()=>{
 await db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos',path]);
 const old=(await save()).rows[0].r,other='00000000-0000-4000-8000-000000000003',otherThumb=`${other}/${transfer}-thumb.jpg`;
 await db.exec(`create or replace function auth.uid() returns uuid language sql as $$select '${other}'::uuid$$;`);
 const finish=(preview=otherThumb)=>db.query('select finish_tiktok_receipt_thumbnail($1,$2,150000,9000) r',[old.id,preview]);
 await assert.rejects(finish(thumb),/Invalid/);await assert.rejects(finish(),/Upload/);
 await db.exec('set role authenticated');await db.query('insert into storage.objects values($1,$2)',['tiktok-receipt-photos',otherThumb]);
 const photo=(await finish()).rows[0].r;assert.equal(photo.thumbnail_path,otherThumb);
 for(const key of ['id','line_id','path','created_by','created_at','video_time'])assert.equal(photo[key],old[key]);
 assert.deepEqual((await finish()).rows[0].r,photo);
 await db.exec("reset role;set test.allowed='no'");await assert.rejects(finish(),/access required/);
 await db.exec("set test.allowed='yes'");assert.equal((await db.query('select count(*)::int n from tiktok_order_events')).rows[0].n,1);
 assert.deepEqual((await db.query('select * from ebay_orders')).rows,[{order_number:order,notes:'Never change eBay'}]);
});
