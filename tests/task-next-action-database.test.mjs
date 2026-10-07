import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const tables={team:'team_tasks',order:'ebay_order_tasks',return:'ebay_return_tasks'};
const events={team:'team_task_events',order:'ebay_order_task_events',return:'ebay_return_task_events'};
const advance=async(source,action,{actor=1,note='Certificate checked; please review.',override={},photos=[]}={})=>{
 await db.exec(`set test.actor='${id(actor)}'`);
 const task=(await db.query(`select * from ${tables[source]} where id=$1`,[id(100)])).rows[0];
 const expected={status:task.status,owner:task.assigned_to_user_id,updated:task.updated_at,...override};
 return (await db.query('select advance_task_workflow($1,$2,$3,$4,$5,$6,$7,$8) result',[source,id(100),action,note,expected.status,expected.owner,expected.updated,JSON.stringify(photos)])).rows[0].result;
};
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(id uuid,user_id uuid,email text,role text,active boolean);
 create function can_manage_inventory() returns boolean language sql as $$select exists(select 1 from public.employees where user_id=auth.uid() and active)$$;
 create function is_admin() returns boolean language sql as $$select exists(select 1 from public.employees where user_id=auth.uid() and active and role='admin')$$;
 create table task_notifications(id uuid default gen_random_uuid(),recipient_user_id uuid,source text,task_id uuid,event_id uuid);
 create function create_task_notification(uuid,text,text,uuid,uuid,text,text,text,text,timestamptz,jsonb,uuid,uuid,text) returns uuid language plpgsql as $$declare n uuid;begin
 insert into public.task_notifications(recipient_user_id,source,task_id,event_id) values($1,$3,$4,$12) returning id into n;return n;end$$;
 create table ebay_orders(id uuid primary key,status text);
 create table ebay_order_lines(id uuid primary key,fulfilled_quantity int);
 create function ebay_order_required_subtasks_complete(uuid) returns boolean language sql as $$select true$$;`);
 for(const source of Object.keys(tables))await db.exec(`create table ${tables[source]}(id uuid primary key,assigned_to_user_id uuid,assigned_to_employee_id uuid,
 assigned_to_email text,${source==='return'?'':'assigned_to_role text,'}assigned_by uuid,assigned_by_email text,created_by uuid,
 status text,task_type text,latest_note text,latest_photo_count int default 2,updated_at timestamptz default now(),resolved_at timestamptz,
 resolved_by uuid,resolved_by_email text,resolution_notes text,due_at timestamptz,priority text,title text,metadata jsonb,order_id uuid,parent_task_id uuid,return_case_id uuid);
 create table ${events[source]}(id uuid default gen_random_uuid(),task_id uuid,action text check(action in('assigned','commented','status_changed')),
 old_status text,new_status text,old_assigned_to_user_id uuid,new_assigned_to_user_id uuid,notes text,signed_by uuid,signed_by_email text,
 payload jsonb,photo_attachments jsonb default '[]',order_id uuid,return_case_id uuid);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261007180000_task_reply_handoff.sql',import.meta.url),'utf8'));
 await db.exec('create table legacy_notifications(function_name text)');
 for (const kind of ['team','ebay_order','ebay_return']) for (const action of ['ready_for_review','progress_to_owner']) {
  const name=`notify_${kind}_task_${action}`;
  await db.exec(`create function ${name}() returns trigger language plpgsql as $$begin insert into public.legacy_notifications values('${name}');return new;end$$`);
 }
 await db.exec(await readFile(new URL('../supabase/migrations/20261007220000_task_next_action_workflow.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261007233000_task_request_intent.sql',import.meta.url),'utf8'));
 for(const table of ['team_tasks','ebay_order_tasks']) await db.exec(`alter table ${table} alter column id set default gen_random_uuid();
 alter table ${table} add column description text,add column question text,add column created_by_email text,add column order_line_ids uuid[];`);
 for(const table of ['team_task_events','ebay_order_task_events']) await db.exec(`alter table ${table} drop constraint ${table}_action_check;`);
 await db.exec('alter table ebay_orders add column order_number text,add column buyer_username text,add column buyer_name text,add column total_price numeric,add column net_payout numeric;alter table ebay_order_lines add column order_id uuid;');
 const historySql=await readFile(new URL('../supabase/migrations/20260714193000_order_history_group_tasks.sql',import.meta.url),'utf8');
 await db.exec(historySql.slice(historySql.indexOf('create or replace function public.create_ebay_order_history_task('),historySql.indexOf('$;',historySql.indexOf('create or replace function public.create_ebay_order_history_task('))+3));
 for(const [file,name,next] of [['20260522113000_team_independent_tasks.sql','create_team_task','respond_team_task'],['20260522103000_ebay_order_coordination_tasks.sql','create_ebay_order_coordination_task','respond_ebay_order_coordination_task']]) {
  const sql=await readFile(new URL('../supabase/migrations/'+file,import.meta.url),'utf8');
  await db.exec(sql.slice(sql.indexOf('create or replace function public.'+name+'('),sql.indexOf('create or replace function public.'+next+'(')));
 }
 for(const source of ['team','order'])await db.exec(`create trigger assignment_guard before update on ${tables[source]} for each row execute function prevent_non_admin_task_reassignment()`);
 await db.exec(`create trigger completion_notify after update of status on ebay_order_tasks for each row execute function notify_admins_ebay_subtask_completed()`);
});
beforeEach(async()=>{
 await db.exec('truncate legacy_notifications,employees,task_notifications,task_followers,ebay_orders,ebay_order_lines,'+Object.values(tables).join(',')+','+Object.values(events).join(','));
 for(const n of [1,2,3,4])await db.query('insert into employees values($1,$1,$2,$3,true)',[id(n),`person${n}@example.test`,n===4?'admin':'employee']);
 for(const table of Object.values(tables))await db.query(`insert into ${table}(id,assigned_to_user_id,assigned_to_employee_id,assigned_to_email,assigned_by,assigned_by_email,created_by,status,task_type,due_at,priority,title,metadata,latest_note,order_id)
 values($1,$2,$2,'person1@example.test',$3,'person2@example.test',$3,'assigned','general','2026-10-10T10:00:00Z','high','Certificate needed','{"evidence":"kept"}','Original instructions',$4)`,[id(100),id(1),id(2),id(500)]);
 await db.query("insert into ebay_orders(id,status) values($1,'pending')",[id(500)]);
 await db.query('insert into ebay_order_lines(id,fulfilled_quantity,order_id) values($1,0,$1)',[id(500)]);
});
after(async()=>db?.close());
for(const source of Object.keys(tables)) {
 test(`${source}: complete, request changes, complete again, accept; order and assignee stay intact`,async()=>{
  const photos=[{bucket:'evidence',path:'certificate.jpg'}];
  let result=await advance(source,'complete',{photos});
  assert.equal(result.task.status,'completed_by_employee');assert.equal(result.task.assigned_to_user_id,id(1));assert.equal(result.task.resolved_at,null);
  assert.equal(result.task.metadata.task_workflow.reviewer_user_id,id(2));assert.equal(result.task.metadata.evidence,'kept');assert.equal(result.task.latest_photo_count,2);
  assert.equal((await db.query('select recipient_user_id from task_notifications')).rows[0].recipient_user_id,id(2));
  assert.deepEqual((await db.query(`select photo_attachments from ${events[source]}`)).rows[0].photo_attachments,photos);
  await assert.rejects(advance(source,'accept'),/next reviewer/);
  result=await advance(source,'return',{actor:2,note:'Attach a clearer photo.'});assert.equal(result.task.status,'sent_back_for_rework');
  assert.equal(result.task.assigned_to_user_id,id(1));assert.equal(result.task.resolved_at,null);
  await advance(source,'complete');result=await advance(source,'accept',{actor:2});
  assert.equal(result.task.status,'resolved');assert.equal(result.task.resolved_by,id(2));assert.ok(result.task.resolved_at);
  assert.equal((await db.query('select status from ebay_orders')).rows[0].status,'pending');
  assert.equal((await db.query('select fulfilled_quantity from ebay_order_lines')).rows[0].fulfilled_quantity,0);
  assert.equal((await db.query(`select count(*)::int n from ${events[source]}`)).rows[0].n,4);
  assert.equal((await db.query('select count(*)::int n from legacy_notifications')).rows[0].n,0,'new transitions do not invoke duplicate legacy notifications');
  assert.equal((await db.query('select count(*)::int n from task_notifications')).rows[0].n,4);
 });
 test(`${source}: permission, stale status/owner/update, missing note, repeated completion and closed work are protected`,async()=>{
  await assert.rejects(advance(source,'complete',{actor:3}),/responsible person/);
  await assert.rejects(advance(source,'complete',{actor:4}),/responsible person/);
  for(const override of [{status:'in_progress'},{owner:id(3)},{updated:'2000-01-01T00:00:00Z'}])await assert.rejects(advance(source,'complete',{override}),/task changed/);
  await assert.rejects(advance(source,'complete',{note:''}),/Describe/);
  await advance(source,'complete');await assert.rejects(advance(source,'complete'),/review or shipping/);
  await assert.rejects(advance(source,'accept',{actor:3}),/next reviewer/);await assert.rejects(advance(source,'accept',{actor:4}),/next reviewer/);
  await advance(source,'accept',{actor:2});await assert.rejects(advance(source,'complete'),/review or shipping/);
 });
 test(`${source}: update and handoff preserve records; followers survive a later reassignment`,async()=>{
  await db.exec(`set test.actor='${id(1)}'`);
  await db.query('select reply_to_task($1,$2,$3,false,$4,$5)',[source,id(100),'FYI, still working',id(1),id(2)]);
  assert.equal((await db.query(`select status from ${tables[source]}`)).rows[0].status,'assigned');
  await db.query('select reply_to_task($1,$2,$3,true,$4,$5)',[source,id(100),'Please find certificate',id(1),id(2)]);
  await db.exec(`set test.actor='${id(4)}'`);await db.query(`update ${tables[source]} set assigned_to_user_id=$1,assigned_by=$2`,[id(3),id(4)]);
  assert.equal((await db.query('select count(*)::int n from task_followers where source=$1 and task_id=$2',[source,id(100)])).rows[0].n,4);
 });
}
test('legacy completed work routes to its active assigner; inactive or self-assigner routes to another active admin',async()=>{
 await db.exec("update team_tasks set status='completed_by_employee'");
 await assert.rejects(advance('team','accept'),/next reviewer/);await advance('team','accept',{actor:2});
 await db.query("update team_tasks set status='assigned',assigned_by=$1,created_by=$1,metadata='{}'",[id(1)]);
 const result=await advance('team','complete');assert.equal(result.task.metadata.task_workflow.reviewer_user_id,id(4));
 await db.query('update employees set active=false where user_id=$1',[id(4)]);
 await assert.rejects(advance('team','accept',{actor:2}),/next reviewer/);
});
test('audit failure rolls back completion, notification, and follower changes',async()=>{
 await db.exec("alter table team_task_events add constraint force_failure check(notes<>'force failure')");
 await assert.rejects(advance('team','complete',{note:'force failure'}),/force_failure/);
 assert.equal((await db.query('select status from team_tasks')).rows[0].status,'assigned');
 assert.equal((await db.query('select count(*)::int n from task_notifications')).rows[0].n,0);
 await db.exec('alter table team_task_events drop constraint force_failure');
});
test('anonymous callers cannot execute transitions or read followers',async()=>{
 assert.equal((await db.query("select has_function_privilege('anon','advance_task_workflow(text,uuid,text,text,text,uuid,timestamptz,jsonb)','execute') allowed")).rows[0].allowed,false);
 assert.equal((await db.query("select has_table_privilege('anon','task_followers','select') allowed")).rows[0].allowed,false);
});

test('following lookup separates active and accepted work and cannot query another worker',async()=>{
 await db.exec(`set test.actor='${id(1)}'`);
 assert.equal((await db.query('select * from list_followed_tasks($1,false)',[id(1)])).rows.length,3);
 assert.equal((await db.query('select * from list_followed_tasks($1,false)',[id(2)])).rows.length,0);
 await advance('team','complete');
 assert.equal((await db.query('select * from list_followed_tasks($1,true)',[id(1)])).rows.length,0);
 await advance('team','accept',{actor:2});
 await db.exec(`set test.actor='${id(1)}'`);
 assert.deepEqual((await db.query('select source from list_followed_tasks($1,true)',[id(1)])).rows,[{source:'team'}]);
 assert.equal((await db.query('select * from list_followed_tasks($1,false)',[id(1)])).rows.length,2);
});

test('a completion cannot choose itself as reviewer through task metadata',async()=>{
 await db.query(`update team_tasks set status='completed_by_employee',metadata=$1`,[JSON.stringify({task_workflow:{completed_by:id(3),reviewer_user_id:id(1)}})]);
 await assert.rejects(advance('team','accept'),/next reviewer/);
 await advance('team','accept',{actor:2});
});

test('an admin decision hands responsibility back to the worker and follows it through acceptance',async()=>{
 await db.exec("update team_tasks set status='waiting_on_admin'");
 const result=await advance('team','return',{actor:4,note:'Please locate and attach the missing certificate.'});
 assert.equal(result.task.status,'sent_back_for_rework');assert.equal(result.task.assigned_to_user_id,id(1));assert.equal(result.task.assigned_by,id(4));
 assert.equal((await db.query('select count(*)::int n from task_followers where source=$1 and user_id=$2',['team',id(4)])).rows[0].n,1);
 const completed=await advance('team','complete');assert.equal(completed.task.metadata.task_workflow.reviewer_user_id,id(4));
 await advance('team','accept',{actor:4});
});

test('an admin completing their own assigned work sends it to the assigner, not themselves',async()=>{
 await db.exec(`set test.actor='${id(4)}'`);await db.query('update team_tasks set assigned_to_user_id=$1',[id(4)]);
 const result=await advance('team','complete',{actor:4});assert.equal(result.task.metadata.task_workflow.reviewer_user_id,id(2));
});

for(const source of ['team','order','history']) for(const kind of ['work','decision']) test(source+': explicit '+kind+' uses intent rather than recipient role, including the creation audit',async()=>{
 await db.exec(`set test.actor='${id(1)}'`);
 const owner=kind==='work'?4:2;
 const details={_title:'Check the certificate',_question:'What should happen next?',_description:'What should happen next?',_order_id:id(500),_assigned_to_user_id:id(owner),_photo_attachments:[{path:'proof.jpg'}]};
 const task=(await db.query('select create_task_request($1,$2,$3) task',[source,kind,JSON.stringify(details)])).rows[0].task;
 assert.equal(task.status,'assigned');assert.equal(task.metadata.request_kind,kind);assert.equal(task.assigned_to_user_id,id(owner));
 const event=(await db.query(`select * from ${events[source==='history'?'order':source]} where task_id=$1`,[task.id])).rows[0];
 assert.equal(event.new_status,'assigned');assert.equal(event.new_assigned_to_user_id,id(owner));assert.deepEqual(event.photo_attachments,details._photo_attachments);
 assert.equal((await db.query("select current_setting('invsto.task_request_kind',true) kind")).rows[0].kind,'');
 assert.equal((await db.query('select status from ebay_orders')).rows[0].status,'pending');
});
test('creation rejects missing recipients, invalid intent, inactive staff, and preserves source validation',async()=>{
 await db.exec(`set test.actor='${id(1)}'`);
 const args={_title:'Work',_assigned_to_user_id:id(4)};
 for(const [source,kind,details,pattern] of [['team','work',{_title:'No owner'},/person responsible/],['team','bad',args,/Work or Decision/],['bad','work',args,/Invalid task source/],['order','work',{...args,_order_id:id(999),_question:'Need help'},/order not found/]]){
  await assert.rejects(db.query('select create_task_request($1,$2,$3)',[source,kind,JSON.stringify(details)]),pattern);
 }
 await db.query('update employees set active=false where user_id=$1',[id(1)]);
 await assert.rejects(db.query('select create_task_request($1,$2,$3)',['team','work',JSON.stringify(args)]),/Active staff/);
 assert.equal((await db.query("select has_function_privilege('anon','create_task_request(text,text,jsonb)','execute') allowed")).rows[0].allowed,false);
});
const respond=async(source,mode,actor,note='Please decide the next step.',override={})=>{
 await db.exec(`set test.actor='${id(actor)}'`);
 const t=(await db.query(`select * from ${tables[source]} where id=$1`,[id(100)])).rows[0];
 return (await db.query('select respond_task_request($1,$2,$3,$4,$5,$6,$7) result',[source,id(100),note,mode,t.assigned_to_user_id,t.assigned_by,override.updated||t.updated_at])).rows[0].result;
};
for(const source of ['team','order','return'])test(source+': work to decision to instructions to completion to acceptance stays one task',async()=>{
 const result=await respond(source,'decision',1);
 assert.equal(result.task.assigned_to_user_id,id(2));assert.equal(result.task.metadata.request_kind,'decision');
 await assert.rejects(advance(source,'complete',{actor:2}),/Record the decision/);
 const updated=await respond(source,'update',2,'Checking with the supplier.');
 assert.equal(updated.task.assigned_to_user_id,id(2));assert.equal(updated.task.metadata.request_kind,'decision');
 await assert.rejects(respond(source,'work',3),/participants|assignee/);
 await assert.rejects(respond(source,'work',2,'Proceed.',{updated:'2000-01-01T00:00:00Z'}),/task changed/);
 const back=await respond(source,'work',2,'Attach the confirmed certificate.');
 assert.equal(back.task.assigned_to_user_id,id(1));assert.equal(back.task.metadata.request_kind,'work');
 await advance(source,'complete');await advance(source,'accept',{actor:2});
 assert.equal((await db.query(`select count(*)::int n from ${tables[source]}`)).rows[0].n,1);
 assert.equal((await db.query('select status from ebay_orders')).rows[0].status,'pending');
});
for(const source of ['team','order','return'])test(source+': decision recipient may explicitly finish; updates never do',async()=>{
 await respond(source,'decision',1);
 await assert.rejects(advance(source,'decide',{actor:1}),/responsible person/);
 const result=await advance(source,'decide',{actor:2,note:'Confirmed: no action is necessary.'});
 assert.equal(result.task.status,'resolved');assert.equal(result.task.resolved_by,id(2));
 assert.equal((await db.query('select status from ebay_orders')).rows[0].status,'pending');
});
