import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test,before,after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const rpc=async(name,args)=> (await db.query(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) result`,args)).rows[0].result;
const create=(n,details={})=>rpc('create_customer_followup',[id(n),{kind:'manual_return',title:'Return clasp',channel:'ebay',buyer_username:'buyer.one',line_id:id(101),note:'Customer will mail the damaged clasp.',...details}]);
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;create schema storage;
 create table auth.users(id uuid primary key);create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(id uuid,user_id uuid,email text,active boolean);
 create function can_manage_inventory() returns boolean language sql as $$select coalesce(current_setting('test.staff',true),'yes')='yes'$$;
 create function can_access_email_triage() returns boolean language sql as $$select coalesce(current_setting('test.chat',true),'yes')='yes'$$;
 create function can_access_tiktok_messages() returns boolean language sql as $$select public.can_access_email_triage()$$;
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(id uuid default gen_random_uuid(),bucket_id text,name text);alter table storage.objects enable row level security;
 create table ebay_orders(id uuid primary key,order_number text,buyer_username text,buyer_name text,buyer_email text,sale_date timestamptz,raw_payload jsonb,status text);
 create table ebay_order_lines(id uuid primary key,order_id uuid,item_number text,item_title text,quantity integer,total_price numeric);
 create table tiktok_orders(id uuid primary key,order_number text,buyer_username text,recipient_name text,api_buyer_id text,source_snapshot_at timestamptz);
 create table tiktok_order_lines(id uuid primary key,order_id uuid,sku_id text,title text,quantity integer,line_amount numeric);
 create table tiktok_chat_conversations(id uuid,buyer_id text,buyer_name text,latest_preview text);
 create table team_tasks(id uuid primary key default gen_random_uuid(),title text,description text,status text,due_at timestamptz,assigned_to_user_id uuid,assigned_to_email text,latest_note text,created_at timestamptz default now(),metadata jsonb default '{}');
 create function create_task_request(text,text,jsonb) returns jsonb language plpgsql as $$declare t public.team_tasks;begin
 if not exists(select 1 from public.employees where user_id=($3->>'_assigned_to_user_id')::uuid and active) then raise exception 'Choose active owner';end if;
 insert into public.team_tasks(title,description,status,due_at,assigned_to_user_id,assigned_to_email) values($3->>'_title',$3->>'_description','assigned',($3->>'_due_at')::timestamptz,($3->>'_assigned_to_user_id')::uuid,'worker@example.test') returning * into t;return to_jsonb(t);end$$;
 create function buyer_followup_message_context(text,uuid,uuid) returns jsonb language plpgsql as $$begin
 if $1<>'buyer.one' or $2<>'${id(301)}'::uuid then raise exception 'Conversation does not belong to this exact customer';end if;
 return jsonb_build_object('conversation_id',$2,'conversation_link','email-triage.html?ebayConversationDbId='||$2,'message_preview','Please call about my clasp');end$$;
 insert into auth.users values('${id(1)}'),('${id(2)}'),('${id(3)}');
 insert into employees values('${id(1)}','${id(1)}','admin@example.test',true),('${id(2)}','${id(2)}','worker@example.test',true),('${id(3)}','${id(3)}','inactive@example.test',false);
 insert into ebay_orders values('${id(100)}','03-12345-67890','buyer.one','Buyer One','buyer@example.test','2026-11-02T20:54:24Z',
 '{"order":{"fulfillmentStartInstructions":[{"shippingStep":{"shipTo":{"fullName":"Buyer One","primaryPhone":{"phoneNumber":"555-0100"},"contactAddress":{"addressLine1":"12 Test Street","city":"Miami","stateOrProvince":"FL","postalCode":"33101","countryCode":"US"}}}}]}}','fulfilled'),
 ('${id(200)}','04-12345-67890','buyer.two','Buyer Two',null,now(),'{}','fulfilled');
 insert into ebay_order_lines values('${id(101)}','${id(100)}','12345','Gold clasp',1,75),('${id(201)}','${id(200)}','56789','Silver chain',2,120);
 insert into tiktok_orders values('${id(400)}','111111111111','buyer.tt','TikTok Buyer','888888888888',now());
 insert into tiktok_order_lines values('${id(401)}','${id(400)}','222222222222','Jade pendant',1,90);
 insert into tiktok_chat_conversations values('${id(402)}','888888888888','TikTok Buyer','Return this pendant');
 set test.actor='${id(1)}';grant usage on schema auth,public,storage to authenticated;grant select,insert on storage.objects to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261108010000_customer_followups.sql',import.meta.url),'utf8'));
 await db.exec('set role authenticated');
});
after(async()=>db?.close());
test('manual return requires a real item owned by the exact buyer; saves contact and chat snapshot',async()=>{
 await assert.rejects(create(1000,{line_id:null}),/exact purchased item/);
 await assert.rejects(create(1004,{return_quantity:2}),/purchased quantity/);
 await assert.rejects(create(1001,{line_id:id(201)}),/different customer/);
 await assert.rejects(create(1002,{line_id:id(999)}),/not found/);
 const r=await create(1003,{conversation_id:id(301)});
 assert.equal(r.contact.phone,'555-0100');assert.equal(r.contact.email,'buyer@example.test');assert.match(r.contact.address,/12 Test Street, Miami/);
 assert.equal(r.ebay_order_line_id,id(101));assert.equal(r.order_snapshot.order_number,'03-12345-67890');assert.equal(r.source_context.message_preview,'Please call about my clasp');
 assert.match(r.order_snapshot.history_link,/focusOrder=03-12345-67890&focusLineId=/);
 assert.equal((await create(1003,{conversation_id:id(301)})).id,r.id,'lost-response retry cannot duplicate');
 await assert.rejects(create(1003,{title:'Changed after uncertain response'}),/already created/);
 assert.equal((await rpc('customer_followup_packet',[r.id])).events.length,1);
});
test('standalone call needs a contact, supports details without a chat or order',async()=>{
 await assert.rejects(create(1010,{kind:'call',channel:'other',buyer_username:'',line_id:null}),/contact name/);
 const r=await create(1011,{kind:'call_followup',channel:'other',buyer_username:'',line_id:null,contact:{name:'Outside supplier',phone:'555-0199',email:'vendor@example.test',address:'Office'},due_at:'2026-11-10T20:00:00Z'});
 assert.equal(r.contact.name,'Outside supplier');assert.equal(r.ebay_order_line_id,null);assert.equal(r.status,'open');
});
test('order search is bounded, exact buyer scoped and supports standalone order-number search',async()=>{
 const query=async args=>(await db.query('select search_customer_followup_orders($1,$2,$3,$4) r',args)).rows.map(x=>x.r);
 assert.equal((await query(['03-12345','ebay','',null]))[0].line_id,id(101));
 assert.equal((await query(['','ebay','BUYER.ONE',null])).length,1);
 assert.equal((await query(['','ebay','buyer',null])).length,0);
 assert.deepEqual(await query(['','ebay','',null]),[]);
 assert.equal((await query(['Jade','tiktok','888888888888',null]))[0].line_id,id(401));
});
test('photos must be real private uploads under the actor and save ID',async()=>{
 const photo={bucket:'customer-followup-photos',path:`${id(1)}/${id(1020)}/clasp.jpg`,mime_type:'image/jpeg',size_bytes:4000,label:'Clasp'};
 await assert.rejects(create(1020,{photos:[photo]}),/missing photo/);
 await db.query('insert into storage.objects(bucket_id,name) values($1,$2)',[photo.bucket,photo.path]);
 const r=await create(1020,{photos:[photo]});assert.equal((await rpc('customer_followup_packet',[r.id])).events[0].photos[0].label,'Clasp');
 await assert.rejects(create(1021,{photos:[photo]}),/Invalid or missing/);
 await assert.rejects(db.query('insert into storage.objects(bucket_id,name) values($1,$2)',[photo.bucket,`${id(2)}/fake.jpg`]),/row-level security/);
});
test('shared staff can read and add audited updates; revisions prevent lost edits and retries are safe',async()=>{
 const r=await create(1030);await db.exec(`set test.actor='${id(2)}'`);
 assert.equal((await db.query('select id from customer_followups where id=$1',[r.id])).rows.length,1);
 const update={note:'Called customer; label provided.',tracking_number:'94000000001',carrier:'USPS',return_stage:'in_transit',status:'waiting'};
 const saved=await rpc('update_customer_followup',[r.id,1,id(1031),update]);assert.equal(saved.revision,2);
 assert.equal((await rpc('update_customer_followup',[r.id,1,id(1031),update])).revision,2);
 await assert.rejects(rpc('update_customer_followup',[r.id,1,id(1032),{note:'Stale edit'}]),/Someone updated/);
 const p=await rpc('customer_followup_packet',[r.id]);assert.equal(p.events.length,2);assert.equal(p.events[1].before_values.tracking_number,'');assert.equal(p.events[1].created_by,id(2));
 await assert.rejects(db.query("update customer_followups set title='Unaudited' where id=$1",[r.id]),/permission denied/);
 await db.exec(`set test.actor='${id(1)}'`);
});
test('optional tasks use team assignment, remain linked, prevent premature closure and can be multiple',async()=>{
 const r=await create(1040),details={title:'Check return arrival',instructions:'Call buyer if no scan tomorrow.',owner:id(2),due_at:'2026-11-10T20:00:00Z'};
 const task=await rpc('create_customer_followup_task',[r.id,id(1041),details]);
 assert.equal(task.metadata.source,'customer_followup');assert.equal(task.metadata.followup_id,r.id);assert.equal(task.assigned_to_user_id,id(2));
 assert.equal((await rpc('create_customer_followup_task',[r.id,id(1041),details])).id,task.id);
 await rpc('create_customer_followup_task',[r.id,id(1042),{...details,title:'Inspect return'}]);
 const p=await rpc('customer_followup_packet',[r.id]);assert.equal(p.tasks.length,2);
 await assert.rejects(rpc('update_customer_followup',[r.id,p.record.revision,id(1043),{status:'closed',note:'Done'}]),/Finish or cancel/);
 await db.exec('reset role');await db.query("update team_tasks set status='resolved' where metadata->>'followup_id'=$1",[r.id]);await db.exec('set role authenticated');
 const closed=await rpc('update_customer_followup',[r.id,p.record.revision,id(1043),{status:'closed',note:'Return received and tasks complete'}]);assert.equal(closed.status,'closed');
 await assert.rejects(rpc('create_customer_followup_task',[r.id,id(1044),details]),/Reopen/);
});
test('TikTok return links verify the exact chat buyer; missing contact information stays missing',async()=>{
 const r=await create(1050,{channel:'tiktok',buyer_username:'888888888888',line_id:id(401),conversation_id:id(402)});
 assert.equal(r.tiktok_order_line_id,id(401));assert.equal(r.buyer_username,'buyer.tt');assert.equal(r.contact.phone,'');
 await assert.rejects(create(1051,{channel:'tiktok',buyer_username:'other',line_id:id(401),conversation_id:id(402)}),/different customer/);
});
test('non-staff and inactive accounts cannot read shared records or invoke mutation RPCs',async()=>{
 await db.exec(`set test.actor='${id(3)}'`);assert.equal((await db.query('select id from customer_followups')).rows.length,0);await assert.rejects(create(1060),/Active staff/);
 await db.exec(`set test.actor='${id(1)}';set test.staff='no'`);await assert.rejects(rpc('customer_followup_packet',[id(999)]),/Active staff/);
 await db.exec("set test.staff='yes';set test.chat='no'");await assert.rejects(create(1061,{conversation_id:id(301)}),/Messages access/);
 await db.exec("set test.chat='yes';set test.actor=''");await assert.rejects(create(1062),/Active staff/);
});
