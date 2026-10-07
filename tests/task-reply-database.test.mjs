import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tables={team:'team_tasks',order:'ebay_order_tasks',return:'ebay_return_tasks'};
const events={team:'team_task_events',order:'ebay_order_task_events',return:'ebay_return_task_events'};
const reply=async(source,{handoff=false,actor=1,owner=1,assigner=2,note='Please find the matching certificate.'}={})=>{
 await db.exec(`set test.actor='${id(actor)}'`);
 return (await db.query('select reply_to_task($1,$2,$3,$4,$5,$6) result',[source,id(100),note,handoff,id(owner),id(assigner)])).rows[0].result;
};
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select current_setting('test.actor',true)::uuid$$;
 create table employees(id uuid,user_id uuid,email text,role text,active boolean);
 create function can_manage_inventory() returns boolean language sql as $$select exists(select 1 from public.employees where user_id=auth.uid() and active)$$;
 create function is_admin() returns boolean language sql as $$select exists(select 1 from public.employees where user_id=auth.uid() and active and role='admin')$$;
 create table task_notifications(id uuid default gen_random_uuid(),recipient_user_id uuid,source text,task_id uuid,event_id uuid);
 create function create_task_notification(uuid,text,text,uuid,uuid,text,text,text,text,timestamptz,jsonb,uuid,uuid,text) returns uuid language plpgsql as $$declare n uuid;begin
 insert into public.task_notifications(recipient_user_id,source,task_id,event_id) values($1,$3,$4,$12) returning id into n;return n;end$$;`);
 for(const source of Object.keys(tables)) await db.exec(`create table ${tables[source]}(id uuid primary key,assigned_to_user_id uuid,assigned_to_employee_id uuid,
 assigned_to_email text,${source==='return'?'':'assigned_to_role text,'}assigned_by uuid,assigned_by_email text,created_by uuid,
 status text,latest_note text,latest_photo_count int default 2,updated_at timestamptz default now(),resolved_at timestamptz,
 due_at timestamptz,priority text,title text,metadata jsonb,order_id uuid,parent_task_id uuid,return_case_id uuid);
 create table ${events[source]}(id uuid default gen_random_uuid(),task_id uuid,action text check(action in('assigned','commented')),
 old_status text,new_status text,old_assigned_to_user_id uuid,new_assigned_to_user_id uuid,notes text,signed_by uuid,signed_by_email text,
 payload jsonb,order_id uuid,return_case_id uuid);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261007180000_task_reply_handoff.sql',import.meta.url),'utf8'));
 for(const source of ['team','order'])await db.exec(`create trigger assignment_guard before update on ${tables[source]} for each row execute function prevent_non_admin_task_reassignment()`);
});
beforeEach(async()=>{
 await db.exec('truncate employees,task_notifications,'+Object.values(tables).join(',')+','+Object.values(events).join(','));
 for(const n of [1,2,3,4])await db.query('insert into employees values($1,$1,$2,$3,true)',[id(n),`person${n}@example.test`,n===4?'admin':'employee']);
 for(const table of Object.values(tables))await db.query(`insert into ${table}(id,assigned_to_user_id,assigned_to_employee_id,assigned_to_email,assigned_by,assigned_by_email,created_by,status,due_at,priority,title,metadata,latest_note)
 values($1,$2,$2,'person1@example.test',$3,'person2@example.test',$3,'waiting_on_admin','2026-10-10T10:00:00Z','high','Certificate needed','{"evidence":"kept"}','Original instructions')`,[id(100),id(1),id(2)]);
});
after(async()=>db?.close());

for(const source of Object.keys(tables)) {
 test(`${source}: a reply preserves ownership, status, dates and evidence and notifies the other participant`,async()=>{
  const result=await reply(source);
  assert.equal(result.task.assigned_to_user_id,id(1));assert.equal(result.task.assigned_by,id(2));assert.equal(result.task.status,'waiting_on_admin');
  assert.equal(result.task.latest_note,'Please find the matching certificate.');assert.equal(result.task.latest_photo_count,2);
  assert.deepEqual(result.task.metadata,{evidence:'kept'});assert.equal(result.task.priority,'high');
  assert.equal(new Date(result.task.due_at).toISOString(),'2026-10-10T10:00:00.000Z');
  const trail=(await db.query(`select * from ${events[source]}`)).rows;assert.equal(trail.length,1);assert.equal(trail[0].action,'commented');
  assert.equal(trail[0].signed_by_email,'person1@example.test');
  assert.equal((await db.query('select recipient_user_id from task_notifications')).rows[0].recipient_user_id,id(2));
  await reply(source,{actor:2,note:'The certificate is on the shelf.'});
  assert.equal((await db.query('select count(*)::int n from task_notifications where recipient_user_id=$1',[id(1)])).rows[0].n,1);
 });
 test(`${source}: handoff swaps responsibility and supports returning the same task`,async()=>{
  const result=await reply(source,{handoff:true});
  assert.equal(result.task.id,id(100));assert.equal(result.task.assigned_to_user_id,id(2));assert.equal(result.task.assigned_by,id(1));
  assert.equal(result.task.assigned_to_email,'person2@example.test');assert.equal(result.task.status,'assigned');assert.equal(result.task.created_by,id(2));
  assert.deepEqual(result.task.metadata,{evidence:'kept'});
  assert.equal(result.task.latest_photo_count,2);assert.equal(result.task.resolved_at,null);
  const trail=(await db.query(`select * from ${events[source]}`)).rows[0];
  assert.equal(trail.action,'assigned');assert.equal(trail.payload.response_kind,'handoff');
  assert.equal(trail.old_assigned_to_user_id,id(1));assert.equal(trail.new_assigned_to_user_id,id(2));
  await assert.rejects(reply(source,{handoff:true}),/assignment changed/);
  const back=await reply(source,{handoff:true,actor:2,owner:2,assigner:1,note:'Certificate found; please continue.'});
  assert.equal(back.task.assigned_to_user_id,id(1));assert.equal(back.task.assigned_by,id(2));
  assert.equal((await db.query(`select count(*)::int n from ${tables[source]}`)).rows[0].n,1);
 });
 test(`${source}: closed tasks, outsiders, inactive staff, stale owners and completion review are protected`,async()=>{
  await assert.rejects(reply(source,{actor:3}),/participants/);
  await assert.rejects(reply(source,{handoff:true,actor:2}),/current assignee/);
  await assert.rejects(reply(source,{owner:3}),/assignment changed/);
  await assert.rejects(reply(source,{assigner:3,handoff:true}),/assignment changed/);
  await assert.rejects(reply(source,{note:'   '}),/Write an update/);
  await db.query('update employees set active=false where user_id=$1',[id(2)]);
  await assert.rejects(reply(source,{handoff:true}),/assigner is inactive/);
  await db.query('update employees set active=true where user_id=$1',[id(2)]);
  await db.exec(`update ${tables[source]} set status='completed_by_employee'`);
  await assert.rejects(reply(source,{handoff:true}),/approval controls/);await reply(source);
  await db.exec(`update ${tables[source]} set status='closed'`);
  await assert.rejects(reply(source),/task is closed/);
  await db.query('update employees set active=false where user_id=$1',[id(1)]);
  await assert.rejects(reply(source),/Active staff/);
 });
}

test('workers cannot use arbitrary reassignment or forge a different handoff recipient',async()=>{
 await db.exec(`set test.actor='${id(1)}'`);
 await assert.rejects(db.query('update team_tasks set assigned_to_user_id=$1',[id(3)]),/Only admins/);
 await assert.rejects(db.query('update ebay_order_tasks set assigned_to_user_id=$1,assigned_by=$2,status=$3,latest_note=$4',[id(2),id(1),'assigned','Do this']),/Only admins/);
 assert.equal((await db.query("select has_function_privilege('anon','reply_to_task(text,uuid,text,boolean,uuid,uuid)','execute') allowed")).rows[0].allowed,false);
 await assert.rejects(reply('unexpected'),/Invalid task source/);
});

test('an audit insertion failure rolls back the ownership change',async()=>{
 await db.exec("alter table team_task_events add constraint block_test_note check(notes<>'force audit failure')");
 await assert.rejects(reply('team',{handoff:true,note:'force audit failure'}),/block_test_note/);
 assert.equal((await db.query('select assigned_to_user_id from team_tasks')).rows[0].assigned_to_user_id,id(1));
 await db.exec('alter table team_task_events drop constraint block_test_note');
});
