import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;const admin='00000000-0000-4000-8000-000000000001',staff='00000000-0000-4000-8000-000000000002',token='00000000-0000-4000-8000-000000000003';
const run=async(s,a=[]) => (await db.query(s,a)).rows;
const record=(patch={})=>({conversation_id:'7494924360615101685',buyer_id:'7494924360615101687',buyer_name:'Pat',latest_message:{index:'1'},latest_message_id:'7494924360615101686',latest_message_at:'2026-10-31T12:00:00Z',latest_preview:'Order question',latest_sender_role:'BUYER',unread_count:2,can_send_message:true,...patch});
async function save(rows,next=null){await db.exec(`update tiktok_chat_sync_state set dispatch_token='${token}',lease_until=now()+interval '2 minutes',claimed=false;`);await run('select claim_tiktok_chat_worker($1)',[token]);await run('select save_tiktok_chat_page($1,$2,$3,$4)',[token,'shop',JSON.stringify(rows),next]);}
before(async()=>{db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create schema net;create schema cron;
 create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb);insert into auth.users values('${admin}','admin@example.test','{}'),('${staff}','staff@example.test','{"full_name":"Pat staff"}');
 create function auth.uid() returns uuid language sql stable as $$select current_setting('test.actor',true)::uuid$$;set test.actor='${admin}';
 create table employees(user_id uuid,role text,active boolean,email_triage_access boolean);insert into employees values('${admin}','admin',true,false),('${staff}','employee',true,false);
 create table tiktok_orders(id uuid,api_buyer_id text,buyer_username text,order_number text,recipient_name text);insert into tiktok_orders values(gen_random_uuid(),'7494924360615101687','pat_buyer','577637745070936130','Pat Jones');
 create table tiktok_api_connection(singleton boolean primary key,shop_id text,credentials text);insert into tiktok_api_connection values(true,'shop','encrypted');
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds int) returns bigint language sql as $$select 1::bigint$$;
 create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;`);await db.exec(await readFile(new URL('../supabase/migrations/20261031180000_tiktok_messages.sql',import.meta.url),'utf8'));await db.exec(await readFile(new URL('../supabase/migrations/20261031193000_tiktok_chat_replies.sql',import.meta.url),'utf8'));});
after(async()=>db?.close());
test('only active authorized staff can read or update chat data',async()=>{
 await save([record()]);await db.exec(`set test.actor='${staff}';set role authenticated;`);assert.equal((await run('select can_access_tiktok_messages() ok'))[0].ok,false);assert.equal((await run('select * from tiktok_chat_conversations')).length,0);await assert.rejects(run('select list_tiktok_chats()'),/access required/);await assert.rejects(run('select dispatch_tiktok_chat_worker()'),/permission denied/);
 await db.exec(`reset role;update employees set email_triage_access=true where user_id='${staff}';set role authenticated;`);assert.equal((await run('select * from tiktok_chat_conversations')).length,1);await assert.rejects(run("update tiktok_chat_conversations set triage_status='done'"),/permission denied/);
 await db.exec(`reset role;update employees set active=false where user_id='${staff}';set role authenticated;`);assert.equal((await run('select can_access_tiktok_messages() ok'))[0].ok,false);await db.exec(`reset role;update employees set active=true where user_id='${staff}';set test.actor='${admin}';`);
});
test('exact buyer order search, literal wildcards and status totals',async()=>{
 assert.equal((await run('select * from list_tiktok_chats($1)',['577637745070936130'])).length,1);assert.equal((await run('select * from list_tiktok_chats($1)',['%'])).length,0);assert.equal((await run('select * from list_tiktok_chats($1)',['pat_buyer'])).length,1);assert.equal((await run('select count_tiktok_chats() n'))[0].n.unread,1);
});
test('triage is optimistic; incoming buyer messages reopen done; stale pages cannot roll back history',async()=>{
 let c=(await run('select * from tiktok_chat_conversations'))[0];await run('select set_tiktok_chat_triage($1,$2,$3)',[c.id,'done',c.revision]);await assert.rejects(run('select set_tiktok_chat_triage($1,$2,$3)',[c.id,'open',c.revision]),/changed/);
 await save([record()]);assert.equal((await run('select triage_status from tiktok_chat_conversations'))[0].triage_status,'done');
 await save([record({latest_message_id:'7494924360615101688',latest_message_at:'2026-10-31T13:00:00Z'})],'next-page');assert.equal((await run('select triage_status from tiktok_chat_conversations'))[0].triage_status,'open');assert.equal((await run('select page_token from tiktok_chat_sync_state'))[0].page_token,'next-page');
 await save([record()]);assert.equal((await run('select latest_message_id from tiktok_chat_conversations'))[0].latest_message_id,'7494924360615101688');
 await assert.rejects(save([record({buyer_id:'1111111111111111111'})]),/buyer changed/);
});
test('notes keep author/time and worker tokens are single-use and cannot be used after expiry',async()=>{
 const c=(await run('select * from tiktok_chat_conversations'))[0];await db.exec(`set test.actor='${staff}';set role authenticated;`);const note=(await run('select * from add_tiktok_chat_note($1,$2)',[c.id,'  Check shipping  ']))[0];assert.equal(note.body,'Check shipping');assert.equal(note.author,staff);assert.equal(note.author_name,'Pat staff');assert.ok(note.created_at);await db.exec('reset role');
 await db.exec(`update tiktok_chat_sync_state set dispatch_token='${token}',lease_until=now()+interval '2 minutes',claimed=false`);assert.equal((await run('select * from claim_tiktok_chat_worker($1)',[token]))[0].claimed,true);assert.equal((await run('select * from claim_tiktok_chat_worker($1)',[token]))[0].singleton,null);
 await db.exec("update tiktok_chat_sync_state set lease_until=now()-interval '1 minute'");await assert.rejects(run('select save_tiktok_chat_page($1,$2,$3,$4)',[token,'shop','[]',null]),/expired/);
});

test('send claims are permission-checked, immutable, and cannot leak another buyer’s order',async()=>{
 await db.exec(`reset role;set test.actor='${admin}';`);const c=(await run('select * from tiktok_chat_conversations'))[0],id='00000000-0000-4000-8000-000000000020',hash='a'.repeat(64);
 const claim=(requestId=id,actor=staff,type='TEXT',content={content:'Shipping update'},fingerprint=hash)=>run('select claim_tiktok_chat_send($1,$2,$3,$4,$5,$6) result',[requestId,c.id,actor,type,JSON.stringify(content),fingerprint]);
 await db.exec('set role authenticated');await assert.rejects(claim(),/permission denied/);await db.exec('reset role');
 await assert.rejects(claim(id,'00000000-0000-4000-8000-000000000999'),/access required/);await assert.rejects(claim(id,staff,'ORDER_CARD',{order_id:'577637745070936131'}),/does not belong/);
 assert.equal((await claim())[0].result.dispatch,true);assert.equal((await claim())[0].result.dispatch,false);
 await assert.rejects(claim(id,staff,'TEXT',{content:'Changed'},'b'.repeat(64)),/does not match/);
 assert.equal((await claim('00000000-0000-4000-8000-000000000021'))[0].result.dispatch,false);
 await assert.rejects(claim('00000000-0000-4000-8000-000000000022',staff,'TEXT',{content:'Another message'},'c'.repeat(64)),/still being sent/);
 await run('select finish_tiktok_chat_send($1,$2,$3,$4)',[id,'sent','7494924360615101699',null]);assert.equal((await claim())[0].result.attempt.status,'sent');
 assert.equal((await run('select triage_status from tiktok_chat_conversations where id=$1',[c.id]))[0].triage_status,'waiting');
});

test('unconfirmed sends are never resent until staff explicitly reviews them; audit remains',async()=>{
 const c=(await run('select * from tiktok_chat_conversations'))[0],id='00000000-0000-4000-8000-000000000023',hash='d'.repeat(64);
 const claim=requestId=>run('select claim_tiktok_chat_send($1,$2,$3,$4,$5,$6) result',[requestId,c.id,staff,'TEXT',JSON.stringify({content:'Another update'}),hash]);
 await claim(id);await run("update tiktok_chat_sends set created_at=now()-interval '3 minutes' where id=$1",[id]);const retry=(await claim('00000000-0000-4000-8000-000000000024'))[0].result;assert.equal(retry.dispatch,false);assert.equal(retry.attempt.status,'unknown');
 await db.exec(`set test.actor='${staff}';set role authenticated`);await assert.rejects(run("update tiktok_chat_sends set status='not_sent' where id=$1",[id]),/permission denied/);
 const reviewed=(await run('select * from review_tiktok_chat_send($1)',[id]))[0];assert.equal(reviewed.reviewed_by,staff);assert.ok(reviewed.reviewed_at);await db.exec('reset role');assert.equal((await claim('00000000-0000-4000-8000-000000000024'))[0].result.dispatch,true);
});
