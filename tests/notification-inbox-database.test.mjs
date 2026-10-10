import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db; const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
before(async()=>{
 db=new PGlite(); await db.exec(`create role authenticated; create role anon; create role service_role; create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user',true),'')::uuid$$;
 create table task_notifications(id uuid primary key,recipient_user_id uuid,source text,task_id uuid,notification_type text,title text,body text,actor_email text,priority text,read_at timestamptz,created_at timestamptz,metadata jsonb);
 create table ebay_return_tasks(id uuid primary key,return_case_id uuid,metadata jsonb default '{}',assigned_by uuid);
 create table ebay_return_cases(id uuid primary key,issue_kind text,source_lane text);
 alter table task_notifications enable row level security;
 insert into ebay_return_cases values('${id(101)}','return','return'),('${id(102)}','request','inquiry'),('${id(103)}','dispute','payment_dispute');
 insert into ebay_return_tasks(id,return_case_id) values('${id(201)}','${id(101)}');`);
 const cleanup=await readFile(new URL('../supabase/migrations/20261010110000_customer_issue_employee_tasks.sql',import.meta.url),'utf8');
 await db.exec(cleanup.slice(cleanup.indexOf('create or replace function public.customer_issue_is_employee_task'),cleanup.indexOf('-- Filter before paging')));
 await db.exec(await readFile(new URL('../supabase/migrations/20261010112000_customer_issue_notification_cleanup.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{await db.exec(`reset role; truncate task_notifications; update ebay_return_tasks set metadata='{}',assigned_by=null; select set_config('test.user','${id(1)}',false);`);});
const add=async(n,type='task_assigned',metadata={},options={})=>db.query(`insert into task_notifications values($1,$2,$3,$4,$5,$6,'Instructions','staff@example.test','high',$7,$8,$9)`,[
 id(n),id(options.user||1),options.source||'return',id(options.task||201),type,options.title||`Update ${n}`,options.read?'2026-10-09T16:00:00Z':null,options.created||`2026-10-09T15:00:00Z`,JSON.stringify(metadata)]);
const inbox=async(category='all',view='unread',limit=30)=>(await db.query('select notification_inbox($1,$2,$3) data',[category,view,limit])).rows[0].data;
test('automatic case alerts separate from explicit work, including return-task replies',async()=>{
 await add(10,'task_progress_update',{case_id:id(101)});
 await add(11,'return_task_assigned',{case_id:id(101)});
 await add(12,'customer_issue_action',{case_id:id(101)});
 await add(13,'customer_issue_deadline',{case_id:id(102)});
 await add(14,'customer_issue_action',{case_id:id(103)});
 await add(15,'customer_issue_sync',{case_id:id(101)});
 const result=await inbox();assert.deepEqual(result.counts,{all:6,tasks:2,returns:1,buyers:2,system:1});
 assert.deepEqual((await inbox('tasks')).entries.map(n=>n.id),[id(11),id(10)]);
 assert.deepEqual((await inbox('returns')).entries.map(n=>n.id),[id(12)]);
 assert.deepEqual((await inbox('buyers')).entries.map(n=>n.id),[id(14),id(13)]);
 assert.deepEqual((await inbox('system')).entries.map(n=>n.id),[id(15)]);
});
test('old generic task notices stay stored but stop crowding the inbox; case alerts remain',async()=>{
 await db.exec(`update ebay_return_tasks set metadata='{"source":"ebay_return_extension"}'`);
 await add(10,'return_task_assigned');await add(11,'task_overdue_assignee');await add(12,'customer_issue_action',{case_id:id(101)});
 await add(13,'customer_issue_deadline',{case_id:id(101)});await add(14,'task_assigned',{}, {source:'team',task:999});
 let result=await inbox();assert.deepEqual(result.counts,{all:3,tasks:1,returns:2,buyers:0,system:0});
 assert.equal((await inbox('tasks')).entries[0].id,id(14));assert.equal((await inbox('all','recent')).total,3);
 assert.equal((await db.query('select count(*)::int n from task_notifications')).rows[0].n,5);
 await db.exec(`update ebay_return_tasks set assigned_by='${id(1)}'`);
 result=await inbox();assert.equal(result.counts.tasks,3,'explicit staff assignments retain their notifications');
});
test('filters find older matches beyond the newest global page and paginate both views',async()=>{
 for(let i=10;i<55;i++)await add(i,'customer_issue_action',{case_id:id(101)});
 await add(60,'task_assigned',{}, {created:'2026-10-01T12:00:00Z'});
 await add(61,'task_completed',{}, {read:true,created:'2026-09-01T12:00:00Z'});
 const all=await inbox();assert.equal(all.entries.length,30);assert.equal(all.total,46);
 const tasks=await inbox('tasks');assert.equal(tasks.entries[0].id,id(60));assert.equal(tasks.total,1);assert.equal(tasks.unread_count,46);
 assert.equal((await inbox('returns','unread',60)).entries.length,45);
 const recent=await inbox('tasks','recent');assert.equal(recent.total,2);assert.equal(recent.entries.length,2);assert.equal(recent.counts.tasks,1);
 assert.equal((await inbox('returns','recent',30)).entries.length,30);assert.equal((await inbox('returns','recent',60)).entries.length,45);
});
test('invalid metadata is safe, legacy case references resolve, unknown cases remain visible',async()=>{
 await add(10,'customer_issue_action',{case_id:'not-a-uuid'});
 await add(11,'customer_issue_action',{case_id:'bad'}, {task:999});
 assert.equal((await inbox('returns')).entries[0].id,id(10));
 assert.equal((await inbox('buyers')).entries[0].id,id(11));
});
test('recipient isolation holds even for privileged callers; anonymous cannot execute',async()=>{
 await add(10);await add(11,'task_assigned',{}, {user:2,title:'Private other employee'});
 assert.equal((await inbox()).total,1);
 await db.exec('set role authenticated');assert.equal((await inbox()).entries[0].id,id(10));
 await db.exec(`reset role;select set_config('test.user','${id(2)}',false);set role authenticated`);
 assert.equal((await inbox()).entries[0].id,id(11));
 await db.exec('reset role;set role anon');await assert.rejects(inbox(),/permission denied/);
 await db.exec(`reset role;select set_config('test.user','',false)`);await assert.rejects(inbox(),/Sign in/);
});
test('reads update category counts without changing notifications in other categories',async()=>{
 await add(10);await add(11,'customer_issue_action',{case_id:id(101)});
 await db.query('update task_notifications set read_at=now() where id=$1',[id(10)]);
 const result=await inbox('tasks');assert.equal(result.total,0);assert.equal(result.unread_count,1);assert.equal(result.counts.returns,1);
 assert.equal((await inbox('tasks','recent')).entries[0].id,id(10));
 await assert.rejects(inbox('unknown'),/Unknown notification filter/);
 await assert.rejects(inbox('all','unknown'),/Unknown notification filter/);
});
