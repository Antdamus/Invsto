import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('notes retain server signatures, scope and history across retries and staff permission changes',async()=>{
 const db=new PGlite(),staff=randomUUID(),tk=randomUUID(),tkOther=randomUUID(),tkLine=randomUUID();
 const run=async(sql,args)=>(await db.query(sql,args)).rows;
 const add=(market,order,line,note,id=randomUUID())=>run('select add_marketplace_order_note($1,$2,$3,$4,$5) as id',[market,order,line,note,id]);
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema storage;
   create table auth.users(id uuid primary key);insert into auth.users values('${staff}');
   create function auth.uid() returns uuid language sql stable as $$select '${staff}'::uuid$$;
   create function auth.email() returns text language sql stable as $$select 'employee@example.test'::text$$;
   create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.allowed')='yes'$$;
   create function is_admin() returns boolean language sql stable as $$select true$$;
   create table employees(user_id uuid,display_name text,email text);insert into employees values('${staff}','Verified Staff','staff@example.test');
   create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   create table storage.objects(bucket_id text,name text,metadata jsonb);alter table storage.objects enable row level security;set test.allowed='yes';`);
  for(const migration of ['20261018030000_tiktok_order_workspace','20261031170000_whatnot_workspace','20261101010000_marketplace_order_notes','20261101013000_marketplace_note_photos']){
   await db.exec(await readFile(new URL('../supabase/migrations/'+migration+'.sql',import.meta.url),'utf8'));
  }
  await run("insert into tiktok_orders(id,order_number,buyer_username,marketplace_status,marketplace_substatus,source_snapshot_at) values($1,'577623648796643330','samebuyer','To ship','Awaiting shipment',now()),($2,'577623648796643331','samebuyer','To ship','Awaiting shipment',now())",[tk,tkOther]);
  await run("insert into tiktok_order_lines(id,order_id,sku_id,title,quantity) values($1,$2,'1234567890123','TikTok ring',1)",[tkLine,tk]);
  await db.exec("insert into whatnot_orders(id,status,currency,subtotal,shipping,tax,total) values('110','completed','USD',5,0,0,5),('111','completed','USD',7,0,0,7);insert into whatnot_order_lines(id,order_id,title,quantity,unit_price,currency,work_state) values('210','110','Whatnot ring',1,5,'USD','external_history');");
  const photoIds={tiktok:randomUUID(),whatnot:randomUUID()},batchId=randomUUID();
  for(const [market,id] of [...Object.entries(photoIds),['whatnot',batchId]]){
   await run("insert into storage.objects values('marketplace-note-photos',$1,'{\"mimetype\":\"image/jpeg\",\"size\":12345}')",[staff+'/'+market+'/'+id+'.jpg']);
  }
  const savePhoto=(market,targets,text,id)=>run('select add_marketplace_order_photo_note($1,$2,$3,$4)',[market,JSON.stringify(targets),text,id]);
  await db.exec("set role authenticated");
  for(const [market,order,other,line,title] of [['tiktok',tk,tkOther,tkLine,'TikTok ring'],['whatnot','110','111','210','Whatnot ring']]){
   const id=randomUUID();await add(market,order,null,'Whole order');await add(market,order,line,'  Inspect clasp  ',id);
   await add(market,order,line,'Inspect clasp',id);
   await assert.rejects(add(market,order,line,'Different note',id),/already used/);
   await assert.rejects(add(market,other,line,'Wrong scope'),/could not be found/);
   await assert.rejects(add(market,order,null,'   '),/Enter a note/);
   const rows=await run('select * from marketplace_order_notes where market=$1 and order_id=$2',[market,order]);assert.equal(rows.length,2);
   assert.ok(rows.every(row=>row.signer==='Verified Staff'&&row.created_at));
   assert.equal(rows.find(r=>r.body==='Inspect clasp').item_title,title);
   await add(market,order,line,'Box checked');
   const summary=await run('select * from marketplace_order_note_summaries where market=$1 and line_id=$2',[market,line]);
   assert.equal(summary[0].note_count,2);assert.equal(summary[0].preview,'Box checked');
   const targets=[{order_id:order,line_id:line}],photoId=photoIds[market];
   await assert.rejects(savePhoto(market,targets,'Photo',randomUUID()),/Upload the note photo first/);
   await assert.rejects(savePhoto(market,[{order_id:other,line_id:line}],'',photoId),/could not be found/);
   await savePhoto(market,targets,'',photoId);await savePhoto(market,targets,'',photoId);
   await assert.rejects(savePhoto(market,[{order_id:order,line_id:null}],'',photoId),/already saved/);
   const photos=await run('select * from marketplace_order_notes where market=$1 and photo_path is not null',[market]);
   assert.equal(photos.length,1);assert.equal(photos[0].photo_path,staff+'/'+market+'/'+photoId+'.jpg');
   assert.equal(photos[0].line_id,line);assert.equal(photos[0].signer,'Verified Staff');assert.equal(photos[0].body,'Photo note');
  }
  await db.exec("reset role;insert into whatnot_order_lines(id,order_id,title,quantity,unit_price,currency) values('211','111','Bracelet',1,7,'USD');set role authenticated");
  const selected=[{order_id:'110',line_id:'210',revision:1},{order_id:'111',line_id:'211',revision:1}];
  await assert.rejects(savePhoto('whatnot',[selected[0],{...selected[1],revision:0}],'Parcel',batchId),/Items changed/);
  await savePhoto('whatnot',selected,'Parcel',batchId);await savePhoto('whatnot',selected,'Parcel',batchId);
  const batch=await run("select line_id from marketplace_order_notes where body='Parcel' order by line_id");assert.deepEqual(batch,[{line_id:'210'},{line_id:'211'}]);
  assert.deepEqual((await run("select revision from whatnot_order_lines order by id")).map(l=>l.revision),[2,2]);
  await db.exec("set test.allowed='no'");
  assert.equal((await run('select * from marketplace_order_notes')).length,0);
  assert.equal((await run('select * from marketplace_order_note_summaries')).length,0);
  await assert.rejects(add('whatnot','110',null,'Denied'),/access required/);
  await assert.rejects(savePhoto('whatnot',selected,'Parcel',batchId),/access required/);
 }finally{await db.close();}
});
