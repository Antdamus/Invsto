import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after,beforeEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;let db;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create function can_access_email_triage() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create table ebay_seller_accounts(id uuid primary key,status text,environment text);
 create table ebay_orders(id uuid primary key,buyer_username text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text);
 create table ebay_conversations(id uuid primary key,seller_account_id uuid,other_party_username text,conversation_type text,reference_id text,latest_message_id text);
 create table ebay_conversation_messages(id uuid primary key,conversation_id uuid,ebay_message_id text,direction text,created_at_ebay timestamptz,created_at timestamptz default now(),message_body_preview text);
 create table ebay_conversation_links(conversation_id uuid,seller_account_id uuid,link_type text,status text,buyer_username text,matched_value text,match_method text,ebay_order_id uuid,ebay_order_line_id uuid);
 create table ebay_conversation_user_read_states(user_id uuid,conversation_id uuid,read_state text,latest_message_id text,latest_message_created_at timestamptz,read_at timestamptz,primary key(user_id,conversation_id));`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261009050000_pending_order_chat_markers.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
beforeEach(async()=>{
 await db.exec(`reset role;select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);
 truncate ebay_seller_accounts,ebay_orders,ebay_order_lines,ebay_conversations,ebay_conversation_messages,ebay_conversation_links,ebay_conversation_user_read_states;
 insert into ebay_seller_accounts values('${id(10)}','active','production'),('${id(11)}','active','sandbox');
 insert into ebay_orders values('${id(20)}','Buyer_One'),('${id(21)}','buyer%two');
 insert into ebay_order_lines values('${id(30)}','${id(20)}','item-a'),('${id(31)}','${id(20)}','item-b'),('${id(32)}','${id(21)}','item-a');
 insert into ebay_conversations values('${id(40)}','${id(10)}','buyer_one','FROM_MEMBERS','item-a','m1'),('${id(41)}','${id(10)}','unrelated','FROM_MEMBERS','item-a','wrong'),('${id(42)}','${id(11)}','buyer_one','FROM_MEMBERS','item-a','sandbox');
 insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay,message_body_preview) values('${id(50)}','${id(40)}','m1','inbound','2026-10-09T17:00:00Z','Please check the clasp');`);
});
const list=async(ids=[id(30),id(31),id(32)])=>(await db.query('select * from list_pending_order_chat_markers($1)',[ids])).rows;
test('buyer and account isolation, item specificity and compact buyer fallback',async()=>{
 const rows=await list();const a=rows.find(r=>r.line_id===id(30)),b=rows.find(r=>r.line_id===id(31)),other=rows.find(r=>r.line_id===id(32));
 assert.equal(a.conversation_count,1);assert.equal(a.unread_count,1);assert.equal(a.match_scope,'item');assert.equal(b.match_scope,'buyer');assert.equal(other.conversation_count,0);
 assert.deepEqual(a.conversation_ids,[id(40)]);assert.equal(a.latest_buyer_preview,'Please check the clasp');
});
test('read state belongs to the viewer; reading clears the marker and a newer inbound restores it',async()=>{
 await db.exec(`insert into ebay_conversation_user_read_states values('${id(2)}','${id(40)}','read','m1','2026-10-09T17:00:00Z',now());`);
 assert.equal((await list())[0].unread_count,1);
 await db.exec(`insert into ebay_conversation_user_read_states values('${id(1)}','${id(40)}','read','m1','2026-10-09T17:00:00Z',now());`);
 assert.equal((await list())[0].unread_count,0);
 await db.exec(`insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay) values('${id(51)}','${id(40)}','m2','inbound','2026-10-09T17:01:00Z');update ebay_conversations set latest_message_id='m2' where id='${id(40)}';`);
 assert.equal((await list())[0].unread_count,1);
});
test('outbound replies do not create buyer alerts and manually marked unread survives',async()=>{
 await db.exec(`insert into ebay_conversation_user_read_states values('${id(1)}','${id(40)}','read','m1','2026-10-09T17:00:00Z',now());
 insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay) values('${id(51)}','${id(40)}','out','outbound','2026-10-09T18:01:00Z');update ebay_conversations set latest_message_id='out' where id='${id(40)}';`);
 assert.equal((await list())[0].unread_count,0);
 await db.exec("update ebay_conversation_user_read_states set read_state='unread'");assert.equal((await list())[0].unread_count,1);
});
test('same-timestamp messages use the saved message identity too',async()=>{
 await db.exec(`insert into ebay_conversation_user_read_states values('${id(1)}','${id(40)}','read','previous','2026-10-09T17:00:00Z',now());`);
 assert.equal((await list())[0].unread_count,1);
});
test('blank buyer identities require a verified exact buyer link; wildcard characters are literal',async()=>{
 await db.exec(`update ebay_conversations set other_party_username=null where id='${id(40)}';
 insert into ebay_conversation_links values('${id(40)}','${id(10)}','buyer_username','confirmed','buyer%two',null,'direct_api_field',null,null);`);
 const rows=await list();assert.equal(rows.find(r=>r.line_id===id(30)).conversation_count,0);assert.equal(rows.find(r=>r.line_id===id(32)).conversation_count,1);
});
test('unauthorized callers, ambiguous accounts and oversized batches fail explicitly',async()=>{
 await db.exec("set role authenticated;select set_config('test.access','no',false)");await assert.rejects(list(),/access are required/);
 await db.exec("reset role;select set_config('test.access','yes',false)");await assert.rejects(list(Array(501).fill(id(30))),/at most 500/);
 await db.exec(`insert into ebay_seller_accounts values('${id(12)}','active','production')`);await assert.rejects(list(),/needs configuration/);
});
