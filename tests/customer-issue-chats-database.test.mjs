import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after,beforeEach} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;let db;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_access_post_order_issues() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create function can_access_email_triage() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create table ebay_return_cases(id uuid primary key,order_id uuid,order_number text,buyer_username text,raw_payload jsonb default '{}');
 create table ebay_return_items(return_case_id uuid,order_line_id uuid);
 create table ebay_return_tasks(return_case_id uuid,order_line_ids uuid[]);
 create table ebay_seller_accounts(id uuid primary key,status text,environment text);
 create table ebay_orders(id uuid primary key,buyer_username text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text);
 create table ebay_conversations(id uuid primary key,seller_account_id uuid,other_party_username text,conversation_type text,reference_id text,latest_message_id text);
 create table ebay_conversation_messages(id uuid primary key,conversation_id uuid,ebay_message_id text,direction text,created_at_ebay timestamptz,created_at timestamptz default now(),message_body_preview text);
 create table ebay_conversation_links(conversation_id uuid,seller_account_id uuid,link_type text,status text,buyer_username text,matched_value text,match_method text,ebay_order_id uuid,ebay_order_line_id uuid);
 create table ebay_conversation_user_read_states(user_id uuid,conversation_id uuid,read_state text,latest_message_id text,latest_message_created_at timestamptz,read_at timestamptz,primary key(user_id,conversation_id));`);
 const links=await readFile(new URL('../supabase/migrations/20261009057000_customer_issue_order_links.sql',import.meta.url),'utf8');
 await db.exec(links.slice(links.indexOf('create function public.customer_issue_order_line_ids'),links.indexOf('revoke all on function public.customer_issue_order_line_ids')));
 await db.exec(await readFile(new URL('../supabase/migrations/20261010150000_customer_issue_chat_markers.sql',import.meta.url),'utf8'));
});
after(async()=>db?.close());
beforeEach(async()=>{
 await db.exec(`reset role;select set_config('test.actor','${id(1)}',false);select set_config('test.access','yes',false);
 truncate ebay_return_cases,ebay_return_items,ebay_return_tasks,ebay_seller_accounts,ebay_orders,ebay_order_lines,ebay_conversations,ebay_conversation_messages,ebay_conversation_links,ebay_conversation_user_read_states;
 insert into ebay_seller_accounts values('${id(10)}','active','production'),('${id(11)}','active','sandbox');
 insert into ebay_orders values('${id(20)}','Buyer_One'),('${id(21)}','buyer%two');
 insert into ebay_order_lines values('${id(30)}','${id(20)}','item-a'),('${id(31)}','${id(20)}','item-b'),('${id(32)}','${id(21)}','item-a');
 insert into ebay_return_cases(id,order_id,order_number,buyer_username) values('${id(60)}','${id(20)}','01-12345-12345','Buyer_One'),('${id(61)}',null,'02-12345-12345','buyer%two');
 insert into ebay_return_items values('${id(60)}','${id(30)}');
 insert into ebay_conversations values('${id(40)}','${id(10)}','buyer_one','FROM_MEMBERS','item-a','m1'),('${id(41)}','${id(10)}','unrelated','FROM_MEMBERS','item-a','wrong'),('${id(42)}','${id(11)}','buyer_one','FROM_MEMBERS','item-a','sandbox');
 insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay,message_body_preview) values('${id(50)}','${id(40)}','m1','inbound','2026-10-09T17:00:00Z','Please check the clasp');`);
});

const list=async(ids=[id(60),id(61)])=>(await db.query('select * from customer_issue_chat_markers($1)',[ids])).rows;
test('matches exact item chats with case-insensitive buyer and seller isolation',async()=>{
 const rows=await list();assert.equal(rows[0].case_id,id(60));assert.equal(rows[0].conversation_count,1);assert.equal(rows[0].conversation_id,id(40));assert.equal(rows[0].match_scope,'item');assert.equal(rows[0].unread_count,1);assert.equal(rows[1].conversation_count,0);
});
test('newer unrelated buyer chat cannot displace this order; fallback is explicitly buyer-only',async()=>{
 await db.exec(`insert into ebay_conversations values('${id(43)}','${id(10)}','buyer_one','FROM_MEMBERS','other-item','m2');
 insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay,message_body_preview) values('${id(53)}','${id(43)}','m2','inbound','2026-10-10T17:00:00Z','Unrelated purchase');`);
 let row=(await list())[0];assert.equal(row.conversation_count,1);assert.equal(row.conversation_id,id(40));
 await db.exec('delete from ebay_return_items');row=(await list())[0];assert.equal(row.match_scope,'buyer');assert.equal(row.conversation_count,2);
});
test('confirmed order links count, historical inferred links and conflicting buyers do not',async()=>{
 await db.exec(`update ebay_conversations set reference_id='unrelated';insert into ebay_conversation_links(conversation_id,seller_account_id,status,match_method,ebay_order_id) values('${id(40)}','${id(10)}','confirmed','buyer_recent_unique_order','${id(20)}');`);
 assert.equal((await list())[0].match_scope,'buyer');
 await db.exec("update ebay_conversation_links set match_method='manual'");assert.equal((await list())[0].match_scope,'order');
 await db.exec(`update ebay_conversations set other_party_username='somebody-else' where id='${id(40)}'`);assert.equal((await list())[0].conversation_count,0);
});
test('order number references work without locally matched items',async()=>{
 await db.exec("update ebay_conversations set reference_id='01-12345-12345'");assert.equal((await list())[0].match_scope,'order');
});
test('verified legacy identity matches an unlinked case; literal wildcard username stays isolated',async()=>{
 await db.exec(`update ebay_conversations set other_party_username=null where id='${id(40)}';insert into ebay_conversation_links(conversation_id,seller_account_id,link_type,status,buyer_username) values('${id(40)}','${id(10)}','buyer_username','confirmed','buyer%two');`);
 const rows=await list();assert.equal(rows[0].conversation_count,0);assert.equal(rows[1].conversation_count,1);assert.equal(rows[1].match_scope,'buyer');
});
test('personal unread state clears after reading; new inbound reactivates, outbound does not',async()=>{
 await db.exec(`insert into ebay_conversation_user_read_states values('${id(2)}','${id(40)}','read','m1','2026-10-09T17:00:00Z',now())`);assert.equal((await list())[0].unread_count,1);
 await db.exec(`insert into ebay_conversation_user_read_states values('${id(1)}','${id(40)}','read','m1','2026-10-09T17:00:00Z',now())`);assert.equal((await list())[0].unread_count,0);
 await db.exec(`insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay) values('${id(51)}','${id(40)}','out','outbound','2026-10-10T17:00:00Z');update ebay_conversations set latest_message_id='out' where id='${id(40)}'`);assert.equal((await list())[0].unread_count,0);
 await db.exec(`insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,direction,created_at_ebay) values('${id(52)}','${id(40)}','in','inbound','2026-10-10T18:00:00Z');update ebay_conversations set latest_message_id='in' where id='${id(40)}'`);assert.equal((await list())[0].unread_count,1);
 assert.equal((await db.query('select count(*) from ebay_conversation_user_read_states')).rows[0].count,2);
});
test('bounds and permissions fail closed',async()=>{
 await db.exec("set role authenticated;select set_config('test.access','no',false)");await assert.rejects(list(),/access are required/);
 await db.exec("reset role;select set_config('test.access','yes',false)");await assert.rejects(list(Array(61).fill(id(60))),/at most 60/);
 await db.exec(`insert into ebay_seller_accounts values('${id(12)}','active','production')`);await assert.rejects(list(),/needs configuration/);
});
