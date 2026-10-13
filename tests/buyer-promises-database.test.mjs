import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,beforeEach,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const sql=async name=>readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
const actor=async n=>db.exec(`set test.actor='${id(n)}'`);
const create=async(buyer='Buyer.One',request=50,details={})=> (await db.query('select create_buyer_followup_task($1,$2,$3) t',[buyer,{_title:'Replacement clasp',_description:'Include one silver clasp',_assigned_to_user_id:id(1),_signed_by_email:'forged@example.test',...details},id(request)])).rows[0].t;
const list=async(order=100)=>(await db.query('select list_buyer_promise_requirements($1) r',[[id(order)]])).rows.map(row=>row.r);
const sign=async(task,{order=100,decision='certify',version,signature='Sam Person',reason='Clasp included'}={})=>db.query('select sign_buyer_promise($1,$2,$3,$4,$5,$6)',[task.id,id(order),decision,signature,reason,version || (await list(order)).find(row=>row.task_id===task.id).version]);
const fulfill=async(line=110)=>db.query("update ebay_order_lines set fulfilled_quantity=quantity,line_status='fulfilled' where id=$1",[id(line)]);
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(id uuid primary key,user_id uuid,email text,display_name text,role text,active boolean);
 create function can_manage_inventory() returns boolean language sql as $$select exists(select 1 from public.employees where user_id=auth.uid() and active)$$;
 create function can_access_email_triage() returns boolean language sql as $$select public.can_manage_inventory()$$;
 create function task_workflow_reviewer(jsonb) returns uuid language sql as $$select null::uuid$$;
 create function is_admin() returns boolean language sql as $$select exists(select 1 from public.employees where user_id=auth.uid() and active and role='admin')$$;
 create table ebay_orders(id uuid primary key,buyer_username text,order_number text,status text default 'pending');
 create table ebay_order_lines(id uuid primary key,order_id uuid,quantity int default 1,fulfilled_quantity int default 0,line_status text default 'pending');
 create table ebay_return_cases(id uuid,buyer_username text);
 create table ebay_conversations(id uuid,other_party_username text,ebay_conversation_id text,conversation_title text);
 create table ebay_conversation_messages(id uuid,conversation_id uuid,ebay_message_id text,message_body text,message_body_preview text,sender_username text,recipient_username text,direction text,created_at_ebay timestamptz,created_at timestamptz,subject text);
 create table ebay_conversation_links(conversation_id uuid,link_type text,status text,buyer_username text,matched_value text);`);
 const base=await sql('20260522113000_team_independent_tasks.sql');
 await db.exec(base.slice(base.indexOf('create table if not exists public.team_tasks'),base.indexOf('create or replace function public.respond_team_task')));
 await db.exec(`alter table team_tasks drop constraint team_tasks_status_check;
 create table ebay_order_tasks(like team_tasks including defaults);alter table ebay_order_tasks add column order_id uuid,add column order_line_ids uuid[],add column question text;
 create table ebay_return_tasks(like ebay_order_tasks including defaults);alter table ebay_return_tasks add column return_case_id uuid;
 create view employee_return_tasks as select * from ebay_return_tasks;
 create table ebay_order_task_events(task_id uuid,photo_attachments jsonb);create table ebay_return_task_events(like ebay_order_task_events);
 grant usage on schema public,auth to authenticated;grant select on all tables in schema public to authenticated;
 grant update on ebay_orders,ebay_order_lines to authenticated;`);
 const intent=await sql('20261007233000_task_request_intent.sql');
 await db.exec(intent.slice(intent.indexOf('create function public.apply_task_request_intent'),intent.indexOf('-- The recipient')));
 await db.exec(await sql('20261010113000_pending_employee_case_tasks.sql'));
 await db.exec(await sql('20261013130000_buyer_followup_tasks.sql'));
 await db.exec(await sql('20261013140000_buyer_promise_fulfillment.sql'));
 await db.exec(await sql('20261013150000_buyer_task_message_photos.sql'));
});
beforeEach(async()=>{
 await db.exec('reset role;truncate buyer_promise_order_signoffs,team_task_events,team_tasks,ebay_orders,ebay_order_lines,employees,auth.users,ebay_conversations,ebay_conversation_messages cascade');
 for(const n of [1,2,3,4]) {
  await db.query('insert into auth.users values($1,$2)',[id(n),`person${n}@example.test`]);
  await db.query('insert into employees values($1,$1,$2,$3,$4,$5)',[id(n),`person${n}@example.test`,'Person '+n,n===3?'admin':'employee',n!==4]);
 }
 await db.query("insert into ebay_orders(id,buyer_username,order_number) values($1,'BUYER.ONE','ORDER-100'),($2,'buyer.one','ORDER-101'),($3,'buyer.two','ORDER-102')",[id(100),id(101),id(102)]);
 await db.query('insert into ebay_order_lines(id,order_id) values($1,$2),($3,$4),($5,$6)',[id(110),id(100),id(111),id(101),id(112),id(102)]);
 await db.query("insert into ebay_conversations values($1,'Buyer.One','ebay-thread-1','Watch conversation'),($2,null,'ebay-thread-2','Legacy conversation')",[id(200),id(201)]);
 await db.query("insert into ebay_conversation_messages(id,conversation_id,ebay_message_id,message_body,sender_username,recipient_username,direction,created_at) values($1,$2,'external-message','We will include a certificate next time','shop','buyer.one','outbound',now()),($3,$4,'external-legacy','Thank you','buyer.two','shop','inbound',now())",[id(210),id(200),id(211),id(201)]);
 await actor(1);await db.exec('set role authenticated');
});
after(async()=>db?.close());
test('a task created before any order appears by exact username; shared read access does not expose ordinary tasks',async()=>{
 const task=await create('  Future.Buyer  ');
 assert.equal(task.metadata.buyer_username,'future.buyer');assert.equal(task.status,'assigned');assert.equal(task.created_by_email,'person1@example.test');
 assert.equal(task.metadata.request_kind,'work');
 await db.query("insert into team_tasks(title,assigned_to_user_id,created_by) values('Private task',$1,$1)",[id(1)]);
 await actor(2);
 assert.equal((await db.query('select count(*)::int n from team_tasks')).rows[0].n,1);
 const notes=(await db.query('select list_pending_customer_task_notes($1) t',[['FUTURE.BUYER']])).rows[0].t;
 assert.equal(notes.id,task.id);assert.equal(notes.buyer_followup,true);
 assert.equal((await db.query('select list_pending_customer_task_notes($1)',[['future']])).rows.length,0);
 assert.equal((await db.query('select count(*)::int n from team_task_events')).rows[0].n,1);
 await db.exec('reset role');await db.query("insert into ebay_orders values($1,'Future.Buyer','NEW','pending')",[id(105)]);await db.exec('set role authenticated');
 assert.equal((await list(105))[0].task_id,task.id);
 const changed=await db.query("update team_tasks set title='Unrelated staff edit' where id=$1 returning id",[task.id]);assert.equal(changed.rows.length,0);
});
test('creation retries are idempotent; conflicting request, invalid username and inactive staff are rejected',async()=>{
 const first=await create();const retry=await create('buyer.one');assert.equal(first.id,retry.id);
 await assert.rejects(create('other.buyer'),/different task/);
 for(const value of ['', 'First Last','https://ebay.com/u/buyer','@buyer'])await assert.rejects(create(value),/exact eBay/);
 await actor(4);await assert.rejects(create(),/staff access/);
});
test('all direct fulfillment paths block without signed certification, including admin; unrelated buyers remain unaffected',async()=>{
 await create();await assert.rejects(fulfill(),/signed certification/);
 await assert.rejects(db.query("update ebay_orders set status='fulfilled' where id=$1",[id(100)]),/signed certification/);
 await assert.rejects(db.query('update ebay_order_lines set fulfilled_quantity=1 where id=$1',[id(110)]),/signed certification/);
 await actor(3);await assert.rejects(fulfill(),/signed certification/);await fulfill(112);
});
test('signed certification records authenticated actor; partial and failed checkout keep the promise; completed order consumes it',async()=>{
 const task=await create();await actor(2);
 await db.exec('reset role');await db.query('insert into ebay_order_lines(id,order_id) values($1,$2)',[id(113),id(100)]);await db.exec('set role authenticated');
 await assert.rejects(sign(task,{signature:''}),/Type your name/);
 await sign(task);await sign(task);
 const receipt=(await list())[0];assert.equal(receipt.signed_by_email,'person2@example.test');assert.equal(receipt.signature,'Sam Person');
 await assert.rejects(db.exec(`begin;update ebay_order_lines set line_status='fulfilled',fulfilled_quantity=1 where order_id='${id(100)}';select 1/0;commit`),/division by zero/);await db.exec('rollback');
 assert.equal((await list())[0].consumed_at,null);
 await fulfill();assert.equal((await db.query('select status from team_tasks')).rows[0].status,'assigned');
 await fulfill(113);assert.equal((await db.query('select status from team_tasks')).rows[0].status,'resolved');
 assert.ok((await list())[0].consumed_at);assert.equal((await list(101)).length,0);
 assert.equal((await db.query('select count(*)::int n from team_task_events')).rows[0].n,3,'created, signed, fulfilled');
});
test('only admins can defer; permission is limited to one order and keeps the promise for the next order',async()=>{
 const task=await create();await assert.rejects(sign(task,{decision:'defer'}),/Only an admin/);
 await actor(3);await sign(task,{decision:'defer',reason:'Replacement arrives tomorrow'});
 await actor(2);await fulfill();assert.equal((await list(101))[0].decision,null);
 assert.equal((await db.query('select status from team_tasks')).rows[0].status,'assigned');
 await assert.rejects(fulfill(111),/signed certification/);
 await sign(task,{order:101});await fulfill(111);assert.equal((await db.query('select status from team_tasks')).rows[0].status,'resolved');
});
test('changed instructions invalidate decisions; employees cannot overwrite signatures or silently close/hide the promise',async()=>{
 const task=await create();const version=(await list())[0].version;
 await sign(task);await db.query("update team_tasks set description='Include TWO silver clasps' where id=$1",[task.id]);
 await assert.rejects(fulfill(),/signed certification/);await assert.rejects(sign(task,{version}),/promise changed/);
 await assert.rejects(sign(task),/admin must change/);
 await assert.rejects(db.query("update team_tasks set status='resolved' where id=$1",[task.id]),/Certify and sign/);
 await assert.rejects(db.query("update team_tasks set status='cancelled' where id=$1",[task.id]),/Only an admin/);
 await assert.rejects(db.query("update team_tasks set metadata=metadata||'{\"hidden_from_task_board\":true}' where id=$1",[task.id]),/stay visible/);
 await assert.rejects(db.query("update team_tasks set metadata=metadata||'{\"buyer_username\":\"other\"}' where id=$1",[task.id]),/identity cannot/);
 await assert.rejects(db.exec("update buyer_promise_order_signoffs set decision='defer'"),/permission denied/);
 await actor(3);await sign(task,{reason:'Two clasps included'});await fulfill();
});
test('multiple promises all require signoff, mismatched buyers are rejected, and one promise cannot be certified into two orders',async()=>{
 const a=await create();const b=await create('buyer.one',51);await sign(a);
 await assert.rejects(fulfill(),/signed certification/);
 await assert.rejects(sign(a,{order:102,version:'anything'}),/does not belong/);
 await assert.rejects(sign(a,{order:101}),/signed for another order/);
 await sign(b);await fulfill();assert.equal((await list(101)).length,0);
});
test('reversing fulfillment reopens the promise and requires a fresh signature while retaining signed history',async()=>{
 const task=await create();await sign(task);await fulfill();
 await actor(3);await db.query("update ebay_order_lines set line_status='pending',fulfilled_quantity=0 where id=$1",[id(110)]);
 assert.equal((await db.query('select status from team_tasks')).rows[0].status,'assigned');
 assert.equal((await list())[0].decision,null);await assert.rejects(fulfill(),/signed certification/);
 assert.equal((await db.query("select count(*)::int n from team_task_events where payload->>'source'='buyer_promise_signoff'")).rows[0].n,1);
 await sign(task);await fulfill();assert.ok((await list())[0].consumed_at);
});

const photo={bucket:'team-task-evidence',path:'team-tasks/customer-promises/photo.jpg',mime_type:'image/jpeg',size_bytes:2048,label:'Watch photo',media_type:'image'};
test('message customer tasks preserve server source context and photos, including retries and workspace visibility',async()=>{
 const details={_conversation_id:id(200),_message_id:id(210),_photo_attachments:[photo],message_preview:'forged'};
 const task=await create('Buyer.One',50,details);
 assert.equal(task.metadata.source,'buyer_followup');assert.equal(task.metadata.message_id,id(210));
 assert.equal(task.metadata.message_preview,'We will include a certificate next time');
 assert.match(task.metadata.conversation_link,new RegExp('ebayMessageDbId='+id(210)));
 assert.equal(task.latest_photo_count,1);
 const event=(await db.query('select * from team_task_events where task_id=$1',[task.id])).rows[0];
 assert.deepEqual(event.photo_attachments,[photo]);assert.equal(event.payload.conversation_id,id(200));
 assert.equal((await create('buyer.one',50,details)).id,task.id);
 await assert.rejects(create('buyer.one',50,{...details,_photo_attachments:[]}),/different task/);
 const workspace=(await db.query('select list_ebay_conversation_task_workspace($1,false) t',[[id(200)]])).rows;
 assert.equal(workspace.length,1);assert.equal(workspace[0].t.task_id,task.id);
 await assert.rejects(fulfill(),/signed certification/);
});
test('rejects another buyer, mismatched message and invalid photos; supports legacy username from messages',async()=>{
 await assert.rejects(create('other.buyer',50,{_conversation_id:id(200),_message_id:id(210)}),/exact customer/);
 await assert.rejects(create('buyer.one',50,{_conversation_id:id(200),_message_id:id(211)}),/does not belong/);
 await assert.rejects(create('buyer.one',50,{_photo_attachments:[{...photo,bucket:'other'}]}),/Invalid task photo/);
 await assert.rejects(create('buyer.one',50,{_photo_attachments:Array(11).fill(photo)}),/10 photos/);
 const legacy=await create('buyer.two',50,{_conversation_id:id(201),_message_id:id(211)});
 assert.equal(legacy.metadata.buyer_username,'buyer.two');assert.equal(legacy.metadata.message_id,id(211));
});
test('linking an existing promise preserves ownership and signoff, audits once, and restricts updates',async()=>{
 const task=await create();await sign(task);
 const attach=()=>db.query('select attach_buyer_followup_message($1,$2,$3) t',[task.id,id(200),id(210)]);
 await actor(2);await assert.rejects(attach(),/creator or an admin/);
 await actor(1);const linked=(await attach()).rows[0].t;
 assert.equal(linked.assigned_to_user_id,task.assigned_to_user_id);assert.equal(linked.status,task.status);
 await attach();assert.equal((await list())[0].decision,'certify');
 assert.equal((await db.query("select count(*)::int n from team_task_events where payload->>'source'='buyer_followup_message_link'")).rows[0].n,1);
 await assert.rejects(db.query('select attach_buyer_followup_message($1,$2,null)',[task.id,id(200)]),/already has/);
 await fulfill();assert.equal((await db.query('select status from team_tasks where id=$1',[task.id])).rows[0].status,'resolved');
});
