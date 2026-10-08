import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(id uuid,user_id uuid,email text,display_name text,role text,active boolean);
 create function can_manage_inventory() returns boolean language sql as $$select exists(select 1 from public.employees where user_id=auth.uid() and active)$$;
 create function can_access_email_triage() returns boolean language sql as $$select public.can_manage_inventory()$$;`);
 for(const table of ['team_tasks','ebay_order_tasks'])await db.exec(`create table ${table}(id uuid primary key,title text,description text,question text,status text,priority text,
 assigned_to_user_id uuid,assigned_to_email text,assigned_to_role text,assigned_by uuid,assigned_by_email text,created_by uuid,created_by_email text,
 created_at timestamptz default now(),updated_at timestamptz default now(),due_at timestamptz,resolved_at timestamptz,latest_note text,metadata jsonb);`);
 for(const table of ['team_task_events','ebay_order_task_events'])await db.exec(`create table ${table}(id uuid primary key,task_id uuid,action text,notes text,signed_by uuid,signed_by_email text,created_at timestamptz default now(),payload jsonb);`);
 const intent=await readFile(new URL('../../supabase/migrations/20261007233000_task_request_intent.sql',import.meta.url),'utf8');
 const start=intent.indexOf('create or replace function public.task_workflow_reviewer');await db.exec(intent.slice(start,intent.indexOf('$$;',start)+3));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261008010000_email_triage_task_workspace.sql',import.meta.url),'utf8'));
 await db.exec(`create function public.get_ebay_canonical_mailbox_v2(integer,integer,text,text[],jsonb,jsonb) returns jsonb language sql as $$
 with base as materialized (select task_stats.task_count,task_stats.pending_task_count from (select '00000000-0000-4000-8000-000000000050'::uuid id) c left join lateral (
 select count(*)::integer as task_count,
 count(*) filter (where t.status not in ('resolved', 'cancelled'))::integer as pending_task_count
 from public.team_tasks t where t.metadata ->> 'source' = 'ebay_conversation_message'
 and t.metadata ->> 'conversation_id' = c.id::text and t.metadata ->> 'history_removed_at' is null
 ) task_stats on true) select to_jsonb(base) from base $$;`);
 await db.exec(await readFile(new URL('../../supabase/migrations/20261008011000_email_triage_linked_task_counts.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../../supabase/migrations/20261008012000_email_triage_bulk_task_counts.sql',import.meta.url),'utf8'));
 for(const [n,name,role]of [[1,'Sandra','worker'],[2,'Jose','admin']])await db.query('insert into employees values($1,$1,$2,$3,$4,true)',[id(n),name+'@example.test',name,role]);
 await db.exec(`set test.actor='${id(2)}'`);
 for(const [n,table,status,kind]of [[10,'team_tasks','assigned','work'],[11,'ebay_order_tasks','assigned','decision'],[12,'team_tasks','completed_by_employee','work'],[13,'ebay_order_tasks','approved_for_shipping','work'],[14,'team_tasks','cancelled','work']]){
  await db.query(`insert into ${table}(id,title,status,assigned_to_user_id,assigned_by,created_by,metadata)values($1,'Certificate task',$2,$3,$4,$4,$5)`,[id(n),status,id(1),id(2),{conversation_id:id(50),source:'ebay_conversation_message',request_kind:kind}]);
 }
 await db.query('insert into team_task_events(id,task_id,action,notes,signed_by) values($1,$2,$3,$4,$5)',[id(100),id(10),'commented','Certificate found',id(1)]);
});
after(async()=>db?.close());
const list=async(ids=[id(50)],events=false)=>(await db.query('select list_ebay_conversation_task_workspace($1,$2) task',[ids,events])).rows.map(r=>r.task);
test('message task summaries use work, decision, independent reviewer and final states',async()=>{
 const rows=await list();assert.equal(rows.length,5);const byId=new Map(rows.map(r=>[r.task_id,r]));
 assert.equal(byId.get(id(10)).next_actor_label,'Next: Sandra');
 assert.equal(byId.get(id(11)).next_actor_label,'Decision: Sandra');
 assert.equal(byId.get(id(12)).next_actor_label,'Review: Jose');
 assert.equal(byId.get(id(13)).next_actor_label,'Finished');
 assert.equal(byId.get(id(14)).next_actor_label,'Canceled');
 assert.equal(byId.get(id(11)).source,'order');assert.equal(byId.get(id(11)).metadata.request_kind,'decision');
 assert.ok(rows.every(r=>r.events.length===0),'inbox excludes event history');
});
test('history is scoped, requested on demand and includes the author',async()=>{
 const rows=await list([id(50)],true);const event=rows.find(r=>r.task_id===id(10)).events[0];assert.equal(event.notes,'Certificate found');assert.equal(event.signed_by_display_name,'Sandra');
 assert.deepEqual(await list([id(51)]),[]);assert.deepEqual(await list([]),[]);
});
test('mailbox open-task filter includes linked orders and excludes finished work',async()=>{
 const counts=(await db.query('select * from public.email_triage_conversation_task_counts($1)',[id(50)])).rows[0];
 assert.deepEqual(counts,{task_count:5,pending_task_count:3});
 const mailbox=(await db.query("select public.get_ebay_canonical_mailbox_v2(100,0,'all','{}','{}','{}') result")).rows[0].result;
 assert.deepEqual(mailbox,counts);
});
test('anonymous and inactive staff cannot read message tasks',async()=>{
 await db.exec("set test.actor=''");assert.deepEqual(await list(),[]);
 assert.deepEqual((await db.query('select * from public.list_email_triage_task_counts()')).rows,[]);
 await db.exec(`set test.actor='${id(99)}'`);assert.deepEqual(await list(),[]);
 assert.deepEqual((await db.query('select * from public.list_email_triage_task_counts()')).rows,[]);
});
