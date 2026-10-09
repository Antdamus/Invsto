import assert from 'node:assert/strict';
import {test,before,after} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create function auth.uid()returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory()returns boolean language sql as $$select coalesce(current_setting('test.staff',true),'')='yes'$$;
 create function can_access_post_order_issues()returns boolean language sql as $$select false$$;
 create function is_admin()returns boolean language sql as $$select coalesce(current_setting('test.admin',true),'')='yes'$$;
 create table auth.users(id uuid primary key,email text);create table ebay_order_lines(id uuid primary key,line_status text,quantity int);
 create table storage.objects(bucket_id text,name text,owner_id text);
 insert into auth.users values('${id(1)}','staff@example.test'),('${id(2)}','other@example.test');
 insert into ebay_order_lines values('${id(10)}','pending',1),('${id(11)}','pending',1);
 set test.actor='${id(1)}';set test.staff='yes';`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261009020000_order_line_certificates.sql',import.meta.url),'utf8'));
 await db.exec('grant usage on schema public,auth to authenticated;set role authenticated;');
});
after(async()=>db?.close());
const file=n=>({bucket:'order-evidence-photos',path:`certificates/${id(10)}/${id(n)}/hash.pdf`,mime_type:'application/pdf',size:1500,sha256:'hash'});
async function upload(n,owner=id(1)){await db.exec('reset role');await db.query('insert into storage.objects values($1,$2,$3)',[file(n).bucket,file(n).path,owner]);await db.exec('set role authenticated');}
async function save(n,overrides={}){const p={line:id(10),url:'https://www.cgl-labs.com/27-qr7732',files:[file(n)],...overrides};return(await db.query('select (public.save_order_line_certificate($1,$2,$3,$4,$5,$6,$7)).*',[id(n),p.line,p.url,p.url,'2778747053007732','4016195325EY',p.files])).rows[0];}
test('PDF and link persist after fulfillment, retries are idempotent, no inventory changes',async()=>{
 await upload(20);const first=await save(20),retry=await save(20);assert.equal(first.id,retry.id);assert.equal(first.created_by_email,'staff@example.test');
 await db.exec(`reset role;update ebay_order_lines set line_status='fulfilled' where id='${id(10)}';set role authenticated;`);
 const rows=(await db.query('select * from ebay_order_line_certificates')).rows;assert.equal(rows.length,1);assert.equal(rows[0].watch_serial,'4016195325EY');assert.equal(rows[0].attachments.length,1);
});
test('missing copies, wrong item paths, unsupported links and others uploads are rejected',async()=>{
 await assert.rejects(save(21,{files:[]}),/at least one/);await assert.rejects(save(21),/uploaded to this item/);
 await upload(22,id(2));await assert.rejects(save(22),/uploaded to this item/);
 await upload(23);await assert.rejects(save(23,{line:id(11)}),/uploaded to this item/);
 await assert.rejects(save(23,{url:'javascript:alert(1)'}),/Invalid certificate/);
 await assert.rejects(save(23,{files:[{...file(23),mime_type:null}]}),/uploaded to this item/);
 await assert.rejects(save(20,{line:id(11)}),/another item/);
});
test('corrections retain original evidence and are restricted to author or admin',async()=>{
 await db.exec(`set test.actor='${id(2)}'`);
 await assert.rejects(db.query('select void_order_line_certificate($1,$2)',[id(20),'Wrong watch']),/author or an admin/);
 await db.exec(`set test.actor='${id(1)}'`);
 const row=(await db.query('select (void_order_line_certificate($1,$2)).*',[id(20),'Wrong watch, corrected copy follows'])).rows[0];
 assert.ok(row.voided_at);assert.equal(row.attachments.length,1);assert.equal(row.voided_by,id(1));
 await assert.rejects(db.query('delete from ebay_order_line_certificates where id=$1',[id(20)]),/permission denied/);
});
test('inactive and unsigned users cannot read or write certificates',async()=>{
 await db.exec("set test.staff='no'");assert.equal((await db.query('select * from ebay_order_line_certificates')).rows.length,0);
 await assert.rejects(save(24),/Not allowed/);await db.exec("set test.staff='yes';set test.actor=''");await assert.rejects(save(24),/Not allowed/);
});
