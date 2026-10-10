import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
let db;const uid='11111111-1111-4111-8111-111111111111',item='22222222-2222-4222-8222-222222222222',pending='33333333-3333-4333-8333-333333333333';
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${uid}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.uid',true),'')::uuid$$;
 create function public.can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.staff',true)='yes'$$;
 create table item_types(id uuid primary key,title text,description text,sale_price numeric,pricing_status text,barcode text,photos text[],photo_url text,categories text[],created_at timestamptz default now(),deleted_at timestamptz,cost numeric,minimum_sale_price numeric,distributor_notes text);
 insert into item_types(id,title,description,sale_price,pricing_status,photos,cost,minimum_sale_price,distributor_notes) values
 ('${item}','Diamond watch','A beautiful watch',5210,'ready',array['watch/1.jpg','watch/2.jpg'],1800,2300,'PRIVATE'),
 ('${pending}','Unpriced ring','Ring',null,'pending',array['ring.jpg'],null,null,'PRIVATE');
 set test.uid='${uid}';set test.staff='yes';`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261010210000_inventory_catalogues.sql',import.meta.url),'utf8'));
 await db.exec(`create table task_notifications(id uuid primary key default gen_random_uuid(),recipient_user_id uuid,source text not null check(source in ('team','order','return')),task_id uuid,notification_type text not null check(notification_type in ('task_assigned','customer_issue_action')),title text,body text,metadata jsonb,recipient_email text,actor_email text,priority text,read_at timestamptz,created_at timestamptz default now());
 create table ebay_return_tasks(id uuid,return_case_id uuid);create table ebay_return_cases(id uuid,issue_kind text,source_lane text);
 create function customer_issue_is_employee_task(jsonb) returns boolean language sql as $$select true$$;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261010220000_catalogue_requests.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
const selection=[{id:item,category:'Watches',photos:['watch/1.jpg']}];
const save=async (credit=5000)=>(await db.query('select * from save_inventory_catalogue(null,0,$1,$2,$3,$4,true)',['Private collection','Selected for you',credit,JSON.stringify(selection)])).rows[0];
const request=async(c,key,options={})=>(await db.query('select submit_catalogue_request($1,$2,$3,$4,$5,$6,$7,$8,$9) result',[c.share_token,key,options.revision??null,options.name??'Test client',options.contact??'test@example.invalid','discuss','Please call before shipping.',JSON.stringify(options.items??[{id:item,retail_price:5210}]),options.credit===undefined?5000:options.credit])).rows[0].result;
const review=async(id,revision,action,message='',reference='')=>(await db.query('select * from review_catalogue_request($1,$2,$3,$4,$5)',[id,revision,action,message,reference])).rows[0];
const row=async key=>(await db.query('select * from catalogue_requests where receipt_token=$1',[key])).rows[0];
const receipt=async(c,key)=>(await db.query('select catalogue_request_receipt($1,$2) result',[c.share_token,key])).rows[0].result;
const key=n=>`aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12,'0')}`;
let c,r;
test('submission uses authoritative retail snapshot, creates one purposeful notification and never an inventory transaction',async()=>{
 c=await save();const result=await request(c,key(1));r=await row(key(1));
 assert.equal(result.total,5210);assert.equal(result.credit_applied,5000);assert.equal(result.balance,210);assert.equal(result.status,'pending_review');
 assert.equal(r.items[0].name,'Diamond watch');assert.equal(JSON.stringify(result).includes('PRIVATE'),false);assert.equal(JSON.stringify(result).includes('contact'),false);
 assert.equal((await db.query('select count(*) from task_notifications')).rows[0].count,1);
 const notice=(await db.query('select * from task_notifications')).rows[0];assert.equal(notice.source,'catalogue');assert.equal(notice.metadata.request_id,r.id);
 const inbox=(await db.query("select notification_inbox('catalogues') result")).rows[0].result;assert.equal(inbox.counts.catalogues,1);assert.equal(inbox.counts.tasks,0);
 assert.equal((await db.query('select sale_price from item_types where id=$1',[item])).rows[0].sale_price,'5210');
});
test('retries are idempotent, even after staff approval; no duplicate notices or changed selection',async()=>{
 await request(c,key(1),{name:'Different client',items:[]});assert.equal((await row(key(1))).customer_name,'Test client');
 assert.equal((await db.query('select count(*) from task_notifications')).rows[0].count,1);
 r=await review(r.id,r.revision,'approve');assert.equal(r.status,'approved');assert.equal((await request(c,key(1))).status,'approved');
 const publicData=(await db.query('select shared_inventory_catalogue($1) result',[c.share_token])).rows[0].result;assert.equal(publicData.credit,0);
 await assert.rejects(review(r.id,1,'approve'),/changed/);await assert.rejects(review(r.id,r.revision,'approve'),/not available/);
});
test('prices, stale credit, unknown/duplicate IDs and invalid contact cannot be forged',async()=>{
 await assert.rejects(request(c,key(2)),/selection_changed/);
 await assert.rejects(request(c,key(2),{credit:0,items:[{id:item,retail_price:1}]}),/selection_changed/);
 await assert.rejects(request(c,key(2),{credit:0,items:[{id:pending,retail_price:5210}]}),/selection_changed/);
 await assert.rejects(request(c,key(2),{credit:0,items:[{id:item,retail_price:5210},{id:item,retail_price:5210}]}),/invalid_selection/);
 await assert.rejects(request(c,key(2),{credit:0,name:''}),/invalid_contact/);
});
test('declining or cancelling releases credit once; fulfilment requires stock checkout reference and is final',async()=>{
 r=await review(r.id,r.revision,'cancel','Client changed their mind.');
 assert.equal((await db.query('select catalogue_available_credit($1) amount',[c.id])).rows[0].amount,'5000.00');
 await assert.rejects(review(r.id,r.revision,'cancel','Again'),/not available/);
 await request(c,key(3));let q=await row(key(3));q=await review(q.id,q.revision,'approve');
 await assert.rejects(review(q.id,q.revision,'fulfill'),/checkout/);
 q=await review(q.id,q.revision,'fulfill','Collected in store','TEST-CHECKOUT-100');assert.equal(q.status,'fulfilled');
 assert.equal((await receipt(c,key(3))).status,'fulfilled');assert.equal((await receipt(c,key(3))).fulfillment_reference,undefined);
 await assert.rejects(review(q.id,q.revision,'fulfill','','OTHER'),/not available/);
});
test('multiple pending requests cannot commit the same credit; budget changes require revision',async()=>{
 const budget=await save(5000);await request(budget,key(4));await request(budget,key(5));const a=await row(key(4)),b=await row(key(5));
 await review(a.id,a.revision,'approve');await assert.rejects(review(b.id,b.revision,'approve'),/credit changed/);
 let q=await review(b.id,b.revision,'changes','Please review without the already allocated credit.');
 const updated=await request(budget,key(5),{revision:q.revision,credit:0});assert.equal(updated.credit_applied,0);assert.equal(updated.revision,3);
 assert.equal((await db.query('select count(*) from catalogue_request_events where request_id=$1',[q.id])).rows[0].count,3);
 // A delayed retry of the old revision must not undo the new submission.
 assert.equal((await request(budget,key(5),{revision:2,credit:0})).revision,3);
});
test('revoked links block new requests, keep a private existing receipt accessible, and expose no contact to other link holders',async()=>{
 assert.equal(await receipt(c,key(999)),null);const other=await save();assert.equal(await receipt(other,key(3)),null);
 await db.query('select unpublish_inventory_catalogue($1,$2)',[c.id,c.revision]);await assert.rejects(request(c,key(6),{credit:0}),/catalogue_unavailable/);
 assert.equal((await receipt(c,key(3))).status,'fulfilled');
});
test('anonymous/nonstaff callers cannot list requests, obtain receipts through RPC, or approve decisions',async()=>{
 await db.exec('set role anon');await assert.rejects(db.query('select * from catalogue_requests'),/permission denied/);await assert.rejects(receipt(c,key(3)),/permission denied/);await assert.rejects(request(c,key(9)),/permission denied/);
 await db.exec("reset role;set test.staff='no';set role authenticated");assert.equal((await db.query('select * from catalogue_requests')).rows.length,0);await assert.rejects(review(r.id,r.revision,'approve'),/staff access/);
 await db.exec("reset role;set test.staff='yes';set role authenticated");await assert.rejects(db.exec("update catalogue_requests set status='approved'"),/permission denied/);await assert.rejects(receipt(c,key(3)),/permission denied/);await db.exec('reset role');
});
test('edge validates request size/types and returns only safe receipt fields',async()=>{
 let handler,calls=[];const client={rpc:async(name,args)=>{calls.push({name,args});return {data:{reference:'12345678',status:'pending_review',total:10,items:[{id:item,name:'Watch',retail_price:10,cost:2}],contact:'PRIVATE',receipt_token:'SECRET'}};}};
 const src=await readFile(new URL('../supabase/functions/storefront-catalog/index.ts',import.meta.url),'utf8');
 vm.runInNewContext(stripTypeScriptTypes(src.replace(/^import .*;\r?\n/gm,'')),{URL,Response,Map,Set,TextDecoder,createClient:()=>client,Deno:{env:{get:()=> 'https://project.example'},serve:fn=>handler=fn}});
 const send=body=>handler(new Request(`https://edge.example/?catalogue=${uid}`,{method:'POST',body:JSON.stringify(body)}));
 const payload={receipt:key(50),items:[{id:item,retail_price:10,cost:1}],name:'Test',contact:'test@example.invalid',delivery:'discuss',credit:null};
 let response=await send(payload);assert.equal(response.status,200);const result=await response.json();assert.ok(!JSON.stringify(result).includes('PRIVATE'));assert.ok(!JSON.stringify(result).includes('SECRET'));assert.ok(!JSON.stringify(result).includes('cost'));assert.deepEqual(JSON.parse(JSON.stringify(calls[0].args._items)),[{id:item,retail_price:10}]);
 response=await send({...payload,credit:'500'});assert.equal(response.status,400);response=await send({...payload,note:'x'.repeat(25000)});assert.equal(response.status,413);
 response=await handler(new Request(`https://edge.example/?catalogue=${uid}&receipt=bad`));assert.equal(response.status,404);
});
