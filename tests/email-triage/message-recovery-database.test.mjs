import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const token='00000000-0000-4000-8000-000000000001';
const read=name=>readFile(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;
 create function can_access_email_triage() returns boolean language sql as $$select current_setting('test.allowed',true)='yes'$$;
 create table ebay_message_notifications(id uuid default gen_random_uuid() primary key,signature_verified boolean,processing_status text,received_at timestamptz default now()-interval '1 hour',processed_at timestamptz,ebay_conversation_id text,conversation_type text,ebay_message_id text);
 create table ebay_conversation_messages(ebay_message_id text,ebay_conversation_id text);
 create table ebay_conversations(id uuid default gen_random_uuid(),ebay_conversation_id text,conversation_type text,latest_message_created_at timestamptz,last_detail_synced_at timestamptz);
 create schema net;create schema cron;create table dispatches(body jsonb);
 create function net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) returns bigint language sql set search_path=public as $$insert into dispatches values(body);select 1::bigint$$;
 create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;`);
 await db.exec(await read('20261009001000_ebay_message_recovery.sql'));
 await db.exec(await read('20261009002000_ebay_message_recovery_schedule.sql'));
 await db.exec(await read('20261009003000_ebay_message_recovery_priority.sql'));
});
beforeEach(async()=>{
 await db.exec(`reset role;truncate ebay_message_notifications,ebay_conversations,ebay_conversation_messages,dispatches;
 update ebay_message_recovery_worker set dispatch_token='${token}',lease_until=now()+interval '3 minutes',claimed_at=null,discovery_offset=40,discovery_turn=1,discovery_after=now();`);
});
after(async()=>db?.close());
const claim=async(t=token)=>(await db.query('select claim_ebay_message_recovery($1) result',[t])).rows[0].result;
test('worker tokens are single-use, expiring, and protected from browser roles',async()=>{
 assert.equal(await claim('00000000-0000-4000-8000-000000000099'),null);
 assert.ok(await claim());assert.equal(await claim(),null);
 await db.exec('set role authenticated');await assert.rejects(claim(),/permission denied/);
 await db.exec(`reset role;update ebay_message_recovery_worker set claimed_at=null,lease_until=now()-interval '1 second'`);
 assert.equal(await claim(),null);
});
test('recovery verifies persisted message, preserves unsigned events, retries only eligible failures',async()=>{
 await db.exec(`insert into ebay_message_notifications(signature_verified,processing_status,ebay_conversation_id,conversation_type,ebay_message_id) values
 (true,'sync_failed','one','FROM_MEMBERS','saved'),(true,'sync_failed','two','FROM_MEMBERS','missing'),
 (false,'signature_failed','three','FROM_MEMBERS','unsigned'),(true,'sync_requested','four','FROM_MEMBERS','stuck');
 insert into ebay_conversation_messages values('saved','one');`);
 const work=await claim();assert.equal(work.retries.length,2);
 assert.deepEqual(work.retries.map(x=>x.ebay_message_id).sort(),['missing','stuck']);
 const rows=(await db.query('select processing_status from ebay_message_notifications order by ebay_conversation_id')).rows;
 assert.equal(rows.find(x=>x.processing_status==='sync_succeeded')?.processing_status,'sync_succeeded');
 assert.ok(rows.some(x=>x.processing_status==='signature_failed'));
 assert.equal((await db.query('select min(recovery_attempts) n from ebay_message_notifications where recovery_attempts>0')).rows[0].n,1);
});
test('recent activity and old conversations get separate bounded recovery slots',async()=>{
 await db.exec(`insert into ebay_conversations(ebay_conversation_id,conversation_type,latest_message_created_at,last_detail_synced_at)
 select 'recent-'||g,'FROM_MEMBERS',now(),now()-interval '1 hour' from generate_series(1,8)g;
 insert into ebay_conversations(id,ebay_conversation_id,conversation_type,latest_message_created_at,last_detail_synced_at) values(gen_random_uuid(),'old','FROM_MEMBERS',now()-interval '90 days',null);`);
 const work=await claim();assert.equal(work.conversations.length,3);assert.ok(work.conversations.some(x=>x.ebay_conversation_id==='old'));
 assert.deepEqual(work.discovery,{offset:40,archive:true});
});
test('dispatch does not overlap and old worker cannot finish a newer lease',async()=>{
 await db.exec('select dispatch_ebay_message_recovery()');assert.equal((await db.query('select count(*) n from dispatches')).rows[0].n,0);
 await db.exec("update ebay_message_recovery_worker set lease_until=now()-interval '1 second';select dispatch_ebay_message_recovery();select dispatch_ebay_message_recovery();");
 assert.equal((await db.query('select count(*) n from dispatches')).rows[0].n,1);
 assert.equal((await db.query('select finish_ebay_message_recovery($1) result',[token])).rows[0].result,false);
});
test('completed archive page advances cursor, failed page preserves it',async()=>{
 await claim();await db.query('select finish_ebay_message_recovery($1,null,$2)',[token,JSON.stringify({archive:true,nextOffset:50})]);
 let row=(await db.query('select discovery_offset,discovery_turn,last_error from ebay_message_recovery_worker')).rows[0];
 assert.deepEqual(row,{discovery_offset:50,discovery_turn:2,last_error:null});
 await db.exec(`update ebay_message_recovery_worker set dispatch_token='${token}',lease_until=now()+interval '3 minutes',claimed_at=null`);await claim();
 await db.query('select finish_ebay_message_recovery($1,$2)',[token,'provider temporarily unavailable']);
 row=(await db.query('select discovery_offset,last_error from ebay_message_recovery_worker')).rows[0];
 assert.equal(row.discovery_offset,50);assert.equal(row.last_error,'provider temporarily unavailable');
});
test('new failures take priority over the backlog and each claim stays bounded',async()=>{
 await db.exec(`insert into ebay_message_notifications(signature_verified,processing_status,received_at,ebay_conversation_id,conversation_type,ebay_message_id,recovery_after)
 select true,'sync_failed',now()-interval '30 days','old-'||g,'FROM_MEMBERS','old-'||g,now()-interval '1 hour' from generate_series(1,15)g;
 insert into ebay_message_notifications(signature_verified,processing_status,received_at,ebay_conversation_id,conversation_type,ebay_message_id)
 values(true,'sync_failed',now()-interval '3 minutes','current','FROM_MEMBERS','current');`);
 const work=await claim();assert.equal(work.retries.length,10);assert.equal(work.retries[0].ebay_message_id,'current');
});
