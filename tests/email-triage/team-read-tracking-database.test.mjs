import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after,beforeEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db,backfilled;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const scalar=async(sql,args=[])=>(await db.query(sql,args)).rows[0].v;
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_access_email_triage() returns boolean language sql as $$select current_setting('test.access',true)='yes'$$;
 create table employees(user_id uuid,display_name text,email text);
 insert into employees values('${id(1)}','Jose','jose@example.test'),('${id(2)}','Sandra','sandra@example.test');
 create table ebay_conversations(id uuid primary key,other_party_username text,conversation_title text,latest_message_preview text,latest_message_id text,latest_message_created_at timestamptz,last_message_created_at timestamptz,first_message_created_at timestamptz);
 create table ebay_conversation_messages(id uuid primary key,conversation_id uuid references ebay_conversations(id),ebay_message_id text,direction text,created_at_ebay timestamptz,created_at timestamptz default now(),subject text,message_body_preview text);
 create table ebay_conversation_user_read_states(user_id uuid,conversation_id uuid,read_state text,read_at timestamptz,latest_message_created_at timestamptz);
 create table ebay_message_send_attempts(id uuid primary key,conversation_id uuid references ebay_conversations(id),target_message_id uuid references ebay_conversation_messages(id),attempt_status text,created_by uuid,created_at timestamptz default now(),sent_at timestamptz,metadata jsonb default '{}');
 revoke all on ebay_message_send_attempts from public,anon,authenticated;
 grant select on ebay_message_send_attempts to authenticated;
 select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);`);
 await db.exec(`insert into ebay_conversations(id) values('${id(20)}');
 insert into ebay_conversation_messages(id,conversation_id,direction,created_at_ebay,created_at) values
 ('${id(200)}','${id(20)}','inbound','2026-10-10T10:00:00Z','2026-10-10T10:01:00Z'),
 ('${id(201)}','${id(20)}','inbound','2026-10-10T10:00:00Z','2026-10-12T10:01:00Z');
 insert into ebay_conversation_user_read_states values
 ('${id(1)}','${id(20)}','read','2026-10-10T12:00:00Z','2026-10-10T10:00:00Z'),
 ('${id(2)}','${id(20)}','read','2026-10-11T12:00:00Z','2026-10-10T10:00:00Z');`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261013110000_ebay_team_read_tracking.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261013120000_ebay_reply_marks_read.sql',import.meta.url),'utf8'));
 backfilled={receipts:(await db.query('select * from ebay_message_team_reads')).rows,events:(await db.query('select actor_name from ebay_message_read_events order by created_at')).rows};
});
after(()=>db?.close());
beforeEach(async()=>{
 await db.exec(`reset role;select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);
 truncate ebay_message_read_events,ebay_message_team_reads,ebay_conversation_messages,ebay_conversations cascade;
 insert into ebay_conversations(id,other_party_username,latest_message_id,latest_message_created_at) values('${id(10)}','buyer','msg-1','2026-10-12T23:00:00Z');
 insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay) values('${id(100)}','${id(10)}','msg-1','inbound','2026-10-12T23:00:00Z');`);
});
const daily=(day='2026-10-12',state='all',offset=0)=>scalar('select get_ebay_daily_read_activity($1,$2,$3,30) v',[day,state,offset]);
const mark=(state='read',message=null,latest='msg-1')=>scalar('select set_ebay_team_read_state($1,$2,$3,$4) v',[id(10),state,message,latest]);
const beginSend=async()=>db.exec(`insert into ebay_message_send_attempts(id,conversation_id,target_message_id,attempt_status,created_by,created_at) values('${id(500)}','${id(10)}','${id(100)}','sending','${id(2)}',now());`);
const finishSend=async()=>db.exec(`update ebay_message_send_attempts set attempt_status='succeeded',sent_at=clock_timestamp() where id='${id(500)}';`);

test('migration preserves known prior readers without marking subsequently imported messages read',()=>{
 assert.equal(backfilled.receipts.length,1);assert.equal(backfilled.receipts[0].message_id,id(200));
 assert.equal(backfilled.receipts[0].first_read_name,'Jose');assert.equal(backfilled.receipts[0].last_read_name,'Sandra');
 assert.deepEqual(backfilled.events.map(e=>e.actor_name),['Jose','Sandra']);
});

test('opening daily tracking does not read anything; explicit actions identify the reader for every teammate',async()=>{
 assert.deepEqual((await daily()).counts,{all:1,read:0,unread:1});
 assert.equal(await scalar('select count(*)::int v from ebay_message_read_events'),0);
 assert.equal((await mark()).is_read,true);
 await db.exec(`select set_config('test.actor','${id(2)}',false)`);
 const result=await daily();assert.deepEqual(result.counts,{all:1,read:1,unread:0});assert.equal(result.rows[0].read_by,'Jose');
 assert.equal((await daily('2026-10-12','unread')).total,0);
 await mark('unread');assert.equal((await daily()).counts.unread,1);
 await mark();
 const receipt=await scalar(`select to_jsonb(r) v from ebay_message_team_reads r where message_id='${id(100)}'`);
 assert.equal(receipt.first_read_name,'Jose');assert.equal(receipt.last_read_name,'Sandra');
 assert.equal(await scalar('select count(*)::int v from ebay_message_read_events'),3,'mark unread never erases history');
 const history=(await db.query('select * from get_ebay_read_history($1)',[id(10)])).rows;assert.equal(history.length,3);
});
test('new incoming replies move the thread date and require another explicit read, retaining previous receipts',async()=>{
 await mark();
 await db.exec(`insert into ebay_conversation_messages values('${id(101)}','${id(10)}','msg-2','inbound','2026-10-13T12:00:00Z',now(),null,'New question');
 update ebay_conversations set latest_message_id='msg-2',latest_message_created_at='2026-10-13T12:00:00Z';`);
 assert.equal((await daily()).counts.all,0);assert.deepEqual((await daily('2026-10-13')).counts,{all:1,read:0,unread:1});
 await assert.rejects(mark(),/new message arrived/);
 assert.equal((await mark('read',id(101),'msg-2')).is_read,true);
 assert.equal(await scalar(`select first_read_name v from ebay_message_team_reads where message_id='${id(100)}'`),'Jose');
 await db.exec(`insert into ebay_conversation_messages values('${id(102)}','${id(10)}','msg-3','outbound','2026-10-14T13:00:00Z',now(),null,'Our reply');
 update ebay_conversations set latest_message_id='msg-3',latest_message_created_at='2026-10-14T13:00:00Z';`);
 assert.equal((await daily('2026-10-13')).total,0);assert.deepEqual((await daily('2026-10-14')).counts,{all:1,read:1,unread:0});
});
test('individual message actions cannot mark another message or conversation read',async()=>{
 await db.exec(`insert into ebay_conversation_messages values('${id(101)}','${id(10)}','msg-2','inbound','2026-10-12T23:00:00Z',now(),null,null);`);
 assert.equal((await mark('read',id(100))).is_read,false,'same-timestamp incoming message remains unread');
 await assert.rejects(mark('read',id(999)),/not found/);
 await assert.rejects(mark('invalid'),/Invalid read state/);
 await mark('read',id(101));assert.equal((await daily()).counts.read,1);
});

test('only a successful reply marks its target and earlier messages read for the team, recording the sender',async()=>{
 await db.exec(`insert into ebay_conversation_messages values('${id(99)}','${id(10)}','older','inbound','2026-10-12T22:00:00Z',now(),null,'Older question');`);
 await beginSend();
 assert.equal((await daily()).counts.read,0,'starting a send is not a read');
 for(const state of ['failed','cancelled','blocked','duplicate']){
  await db.query('update ebay_message_send_attempts set attempt_status=$1',[state]);
  assert.equal(await scalar('select count(*)::int v from ebay_message_read_events'),0);
 }
 await finishSend();
 const result=await daily();assert.deepEqual(result.counts,{all:1,read:1,unread:0});
 assert.equal(result.rows[0].read_by,'Sandra','shared read belongs to the sender, not the viewer');
 const receipts=(await db.query('select * from ebay_message_team_reads')).rows;
 assert.equal(receipts.length,2);assert.ok(receipts.every(r=>r.first_read_by===id(2)&&r.last_read_by===id(2)));
 const events=(await db.query('select * from ebay_message_read_events')).rows;
 assert.equal(events.length,2);assert.ok(events.every(e=>e.actor_name==='Sandra'&&e.send_attempt_id===id(500)));
 await db.exec(`insert into ebay_conversation_messages values('${id(102)}','${id(10)}','our-reply','outbound','2026-10-13T13:00:00Z',now(),null,'Our reply');
 update ebay_conversations set latest_message_id='our-reply',latest_message_created_at='2026-10-13T13:00:00Z';`);
 assert.equal((await daily()).total,0);assert.deepEqual((await daily('2026-10-13')).counts,{all:1,read:1,unread:0});
});

test('replying to an older message leaves newer incoming messages and later imports unread',async()=>{
 await db.exec(`insert into ebay_conversation_messages values('${id(101)}','${id(10)}','newer','inbound','2026-10-13T12:00:00Z',now(),null,'Newer question');`);
 await beginSend();
 await db.exec(`insert into ebay_conversation_messages values
 ('${id(102)}','${id(10)}','during-send','inbound','2026-10-13T12:01:00Z',clock_timestamp()+interval '1 second',null,'Arrived while sending'),
 ('${id(103)}','${id(10)}','late-import','inbound','2026-10-12T22:00:00Z',clock_timestamp()+interval '1 second',null,'Imported while sending');
 update ebay_conversations set latest_message_id='during-send',latest_message_created_at='2026-10-13T12:01:00Z';`);
 await finishSend();
 const receipts=(await db.query('select message_id from ebay_message_team_reads')).rows;
 assert.deepEqual(receipts.map(r=>r.message_id),[id(100)]);
 assert.deepEqual((await daily('2026-10-13')).counts,{all:1,read:0,unread:1});
});

test('successful reply preserves the first reader and repeated send updates never erase a later mark-unread',async()=>{
 await mark();await beginSend();await finishSend();
 const receipt=await scalar('select to_jsonb(r) v from ebay_message_team_reads r');
 assert.equal(receipt.first_read_name,'Jose');assert.equal(receipt.last_read_name,'Sandra');
 await mark('unread');
 await db.exec("update ebay_message_send_attempts set metadata='{\"local_outbound_message_persist_failed\":true}'; update ebay_message_send_attempts set attempt_status='succeeded';");
 await db.exec("update ebay_message_send_attempts set attempt_status='failed';");await finishSend();
 assert.equal((await daily()).counts.unread,1);
 assert.equal(await scalar('select count(*)::int v from ebay_message_read_events where send_attempt_id is not null'),1);
 assert.equal(await scalar('select count(*)::int v from ebay_message_read_events'),3);
});

test('delayed send confirmation cannot undo a newer explicit unread action',async()=>{
 await beginSend();
 await db.exec("update ebay_message_send_attempts set sent_at=clock_timestamp()-interval '1 second'");
 await mark('unread');
 await db.exec("update ebay_message_send_attempts set attempt_status='succeeded'");
 assert.equal((await daily()).counts.unread,1);
 assert.equal(await scalar('select count(*)::int v from ebay_message_read_events where send_attempt_id is not null'),1,'the send remains in history');
});

test('send receipts require a known sender, confirmed time and a target in the same conversation',async()=>{
 await beginSend();
 await db.exec("update ebay_message_send_attempts set attempt_status='succeeded'");
 assert.equal(await scalar('select count(*)::int v from ebay_message_team_reads'),0);
 await db.exec("update ebay_message_send_attempts set attempt_status='sending',created_by=null");await finishSend();
 assert.equal(await scalar('select count(*)::int v from ebay_message_team_reads'),0);
 await db.exec(`insert into ebay_conversations(id) values('${id(11)}');
 update ebay_message_send_attempts set attempt_status='sending',created_by='${id(2)}',conversation_id='${id(11)}';`);
 await finishSend();assert.equal(await scalar('select count(*)::int v from ebay_message_team_reads'),0);
});
test('calendar grouping uses New York midnight and daylight saving boundaries, independent of database time zone',async()=>{
 for(const [stamp,day] of [['2026-10-13T03:59:59Z','2026-10-12'],['2026-10-13T04:00:00Z','2026-10-13'],['2026-11-01T05:30:00Z','2026-11-01'],['2026-11-01T06:30:00Z','2026-11-01']]){
  await db.query('update ebay_conversations set latest_message_created_at=$1',[stamp]);await db.query('update ebay_conversation_messages set created_at_ebay=$1',[stamp]);
  await db.exec("set time zone 'Asia/Tokyo'");assert.equal((await daily(day)).counts.all,1);
 }
});
test('daily counts cover all pages and status filters do not change totals',async()=>{
 await db.exec(`insert into ebay_conversations(id,other_party_username,latest_message_created_at) select gen_random_uuid(),'buyer '||i,'2026-10-12T23:00:00Z' from generate_series(1,40) i;`);
 await mark();const page=await daily('2026-10-12','unread',30);
 assert.equal(page.rows.length,10);assert.equal(page.total,40);assert.deepEqual(page.counts,{all:41,read:1,unread:40});
});
test('unauthorized users cannot inspect or forge read receipts or history',async()=>{
 await mark();
 await db.exec("select set_config('test.access','no',false)");
 assert.equal((await daily()).total,0);await assert.rejects(mark(),/access required/);
 assert.deepEqual((await db.query('select * from get_ebay_read_history($1)',[id(10)])).rows,[]);
 await db.exec("select set_config('test.access','yes',false);set role authenticated");
 await assert.rejects(db.exec('delete from ebay_message_read_events'),/permission denied/);
 await assert.rejects(db.exec('update ebay_message_team_reads set last_read_name=\'Forged\''),/permission denied/);
 await assert.rejects(db.exec("update ebay_message_send_attempts set attempt_status='succeeded'"),/permission denied/);
});
