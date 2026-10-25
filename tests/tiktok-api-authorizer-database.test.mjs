import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('OAuth and scheduled sync require a current active staff administrator without a browser JWT',async()=>{
 const db=new PGlite(), admin='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002';
 try{
  await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
   create table auth.users(id uuid primary key);create table employees(user_id uuid primary key,role text,active boolean);
   insert into auth.users values('${admin}'),('${other}');insert into employees values('${admin}','admin',true),('${other}','manager',true);
   create function public.is_admin() returns boolean language sql as $$select false$$;
   set request.jwt.claims='{"role":"service_role"}';`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261025220000_tiktok_api_authorizer.sql',import.meta.url),'utf8'));
  const allowed=async id=>(await db.query('select tiktok_api_authorizer_allowed($1) allowed',[id])).rows[0].allowed;
  await db.exec('set role service_role');assert.equal(await allowed(admin),true);assert.equal(await allowed(other),false);assert.equal(await allowed(null),false);
  assert.equal((await db.query("select current_setting('request.jwt.claims') claims")).rows[0].claims,'{"role":"service_role"}');
  await db.exec('reset role');await db.query("update employees set role='employee' where user_id=$1",[admin]);assert.equal(await allowed(admin),false);
  await db.query("update employees set role='admin',active=false where user_id=$1",[admin]);assert.equal(await allowed(admin),false);
  await db.query('update employees set active=null where user_id=$1',[admin]);assert.equal(await allowed(admin),true);
  await db.query('delete from auth.users where id=$1',[admin]);assert.equal(await allowed(admin),false);
  await db.exec('set role authenticated');await assert.rejects(allowed(other),/permission denied/);
  await db.exec('set role anon');await assert.rejects(allowed(other),/permission denied/);
 }finally{await db.close();}
});
