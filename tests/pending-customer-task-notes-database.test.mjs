import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test, before, after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
before(async () => {
 db = new PGlite();
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function public.can_manage_inventory() returns boolean language sql as $$select coalesce(current_setting('test.staff',true),'')='yes'$$;
 create table employees(id uuid,user_id uuid,email text,display_name text);
 create table ebay_orders(id uuid,buyer_username text);
 create table ebay_return_cases(id uuid,buyer_username text);
 create table ebay_conversations(id uuid,other_party_username text);
 create table ebay_conversation_links(conversation_id uuid,link_type text,status text,buyer_username text,matched_value text);`);
 for (const table of ['team_tasks','ebay_order_tasks','ebay_return_tasks']) {
  await db.exec(`create table ${table}(id uuid primary key,order_id uuid,order_line_ids uuid[],return_case_id uuid,
   title text,question text,description text,status text,assigned_to_user_id uuid,assigned_to_employee_id uuid,assigned_to_email text,
   latest_note text,created_at timestamptz default now(),created_by_email text,metadata jsonb default '{}');
   alter table ${table} enable row level security;
   create policy participant on ${table} for select to authenticated using(assigned_to_user_id=auth.uid());`);
 }
 for (const table of ['team_task_events','ebay_order_task_events','ebay_return_task_events']) {
  await db.exec(`create table ${table}(task_id uuid,photo_attachments jsonb);`);
 }
 await db.exec(`grant usage on schema public,auth to authenticated;grant select on all tables in schema public to authenticated;`);
 const cleanup=await readFile(new URL('../supabase/migrations/20261010110000_customer_issue_employee_tasks.sql',import.meta.url),'utf8');
 await db.exec(cleanup.slice(cleanup.indexOf('create or replace function public.customer_issue_is_employee_task'),cleanup.indexOf('-- Filter before paging')));
 await db.exec(`create view employee_return_tasks with(security_invoker=true) as select t.* from ebay_return_tasks t where customer_issue_is_employee_task(to_jsonb(t));grant select on employee_return_tasks to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261010113000_pending_employee_case_tasks.sql',import.meta.url),'utf8'));
 await db.exec(`set test.actor='${id(1)}';set test.staff='yes';
 insert into employees values('${id(1)}','${id(1)}','sam@example.test','Sam');
 insert into ebay_orders values('${id(100)}','Buyer.ONE'),('${id(101)}','buyer.two');
 insert into ebay_return_cases values('${id(200)}','buyer.one');
 insert into ebay_conversations values('${id(300)}','BUYER.ONE'),('${id(301)}',null),('${id(302)}',null),('${id(303)}','other-buyer');
 insert into ebay_conversation_links values
 ('${id(301)}','buyer_username','confirmed','buyer.one',null),
 ('${id(302)}','buyer_username','confirmed','buyer.one',null),
 ('${id(302)}','buyer_username','confirmed','other-buyer',null),
 ('${id(303)}','buyer_username','confirmed','buyer.one',null);`);
 const fixtures = [
  ['team_tasks',1,'assigned',{buyer_username:'  Buyer.One '},null,null],
  ['team_tasks',2,'waiting_on_admin',{buyerUsername:'buyer.one'},null,null],
  ['team_tasks',3,'completed_by_employee',{buyer_username:'buyer.one'},null,null],
  ['ebay_order_tasks',4,'assigned',{},100,null],
  ['ebay_return_tasks',5,'blocked',{},null,200],
  ['team_tasks',6,'resolved',{buyer_username:'buyer.one'},null,null],
  ['team_tasks',7,'cancelled',{buyer_username:'buyer.one'},null,null],
  ['team_tasks',8,'assigned',{buyer_username:'buyer.one',hidden_from_task_board:true},null,null],
  ['team_tasks',9,'assigned',{buyer_username:'buyer.one',history_removed_at:'2026-10-09'},null,null],
  ['team_tasks',10,'assigned',{buyer_username:'buyer.one-more'},null,null],
  ['team_tasks',11,'assigned',{},null,null],
  ['team_tasks',12,'approved_for_shipping',{buyer_username:'buyer.one'},null,null],
  ['team_tasks',13,'assigned',{buyer_username:'buyer.one',assignment_cancelled_at:'2026-10-09'},null,null],
  ['ebay_order_tasks',14,'assigned',{source:'pending_order_line_note'},100,null],
  ['team_tasks',15,'assigned',{buyer_username:'buyer.one'},null,null],
  ['team_tasks',16,'assigned',{conversation_id:id(300)},null,null],
  ['team_tasks',17,'assigned',{conversation_id:id(301)},null,null],
  ['team_tasks',18,'assigned',{conversation_id:id(302)},null,null],
  ['team_tasks',19,'assigned',{conversation_id:id(303)},null,null],
  ['team_tasks',20,'assigned',{conversation_id:'malformed'},null,null],
  ['ebay_return_tasks',21,'open',{source:'ebay_return_api'},null,200],
  ['ebay_return_tasks',22,'open',{source:'customer_issue_action'},null,200],
 ];
 for (const [table,n,status,metadata,order,ret] of fixtures) await db.query(`insert into ${table}
  (id,title,description,question,status,metadata,order_id,return_case_id,assigned_to_user_id) values($1,$2,'Customer message','Check this item',$3,$4,$5,$6,$7)`,
  [id(n),n===11?'buyer.one mentioned in title':'Customer follow-up',status,metadata,order?id(order):null,ret?id(ret):null,id(n===15?2:1)]);
 await db.query('insert into team_task_events values($1,$2),($1,$2)',[id(1),[{bucket:'proof',path:'one.jpg'},{bucket:'proof',path:'two.jpg'}]]);
 await db.exec('set role authenticated');
});
after(async () => db?.close());
const list=async buyers=>(await db.query('select public.list_pending_customer_task_notes($1) task',[buyers])).rows.map(r=>r.task);
test('exact customer matching spans independent, order and return tasks, excludes closed and respects RLS',async()=>{
 const rows=await list(['BUYER.ONE','buyer.one','']);
 assert.deepEqual(rows.map(r=>r.id).sort(),[1,2,3,4,5,16,17].map(id));
 assert.deepEqual(new Set(rows.map(r=>r.source)),new Set(['team','order','return']));
 const task=rows.find(r=>r.id===id(1));assert.equal(task.assignee_name,'Sam');assert.equal(task.attachment_count,2);
 assert.equal(task.question,'Customer message');assert.ok(rows.every(r=>r.buyer_username==='buyer.one'));
 assert.equal(task.metadata,undefined,'No unrelated task metadata leaked');
 assert.deepEqual(await list(['buyer']),[]);assert.deepEqual(await list([]),[]);
});
test('requests are bounded and non-staff/unsigned readers are rejected',async()=>{
 await assert.rejects(list(Array(76).fill('buyer.one')),/at most 75/);
 await db.exec("set test.staff='no'");await assert.rejects(list(['buyer.one']),/Inventory staff/);
 await db.exec("set test.staff='yes';set test.actor=''");await assert.rejects(list(['buyer.one']),/Inventory staff/);
});
