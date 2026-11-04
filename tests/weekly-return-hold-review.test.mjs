import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {chromium} from '@playwright/test';
const root=s=>fileURLToPath(new URL('../'+s,import.meta.url));
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
test('reviews isolate returns on a shared order and survive ledger replacement; task retries create one assignment',async()=>{
 const db=new PGlite(),v=async(q,args=[])=>(await db.query(q,args)).rows[0].v;
 try{
  await db.exec(`create role anon;create role authenticated;create schema auth;
   create function auth.uid() returns uuid language sql as $$select '${id(1)}'::uuid$$;
   create function auth.jwt() returns jsonb language sql as $$select '{}'::jsonb$$;
   create table employees(user_id uuid,role text,active boolean,display_name text,email text);
   insert into employees values(auth.uid(),'admin',true,'Alex','alex@test');
   create table ebay_account_holds(singleton bool,entries jsonb);
   insert into ebay_account_holds values(true,'[{"kind":"return","ref":"R1","oid":"order1"},{"kind":"return","ref":"R2","oid":"order1"},{"kind":"sale","ref":"R3","oid":"order1"}]');
   create table ebay_orders(id uuid,order_number text,buyer_name text,buyer_username text,raw_payload jsonb);
   create table ebay_order_lines(id uuid,order_id uuid,item_title text,item_number text);
   create table ebay_return_cases(id uuid,order_id uuid,order_number text,buyer_username text,item_title text,raw_payload jsonb,source_lane text,issue_kind text,ebay_return_id text,status text);
   create table ebay_return_items(id uuid,return_case_id uuid,order_line_id uuid,item_title text);
   create table ebay_return_tasks(id uuid primary key default gen_random_uuid(),status text,assigned_to_user_id uuid,assigned_to_email text);
   create table team_tasks(like ebay_return_tasks including all);
   insert into ebay_orders values('${id(10)}','order1','Buyer Name','buyer', '{}');
   insert into ebay_order_lines values('${id(11)}','${id(10)}','Sapphire ring','111'),('${id(12)}','${id(10)}','Watch','222');
   insert into ebay_return_cases values('${id(13)}','${id(10)}','order1','buyer','Ring from provider','{"manualOrderMatch":{"line_ids":["${id(11)}"]}}','return','return','R1','open');
   insert into ebay_return_items values('${id(14)}','${id(13)}','${id(12)}','Stale match');
   create function weekly_ebay_hold_snapshot() returns jsonb language sql as $$ select jsonb_build_object('entries',jsonb_agg(r||case when true then '{}'::jsonb end))
    from ebay_account_holds h cross join lateral jsonb_array_elements(h.entries) r left join ebay_orders e on e.order_number=r->>'oid' $$;
   create function get_weekly_sales_for_market(_month date,_market text) returns jsonb language sql as $$select jsonb_build_object('ebay_account_holds',public.weekly_ebay_hold_snapshot())$$;
   create function request_customer_return_followup(uuid,uuid,uuid,text,text,timestamptz) returns uuid language sql as $$insert into public.ebay_return_tasks(status,assigned_to_user_id) values('assigned',$3) returning id$$;
   create function create_task_request(text,text,jsonb) returns jsonb language sql as $$insert into public.team_tasks(status,assigned_to_user_id) values('assigned',($3->>'_assigned_to_user_id')::uuid) returning jsonb_build_object('id',id)$$;`);
  await db.exec(await readFile(root('supabase/migrations/20261104043000_return_hold_reviews.sql'),'utf8'));
  const report=()=>v("select get_weekly_sales_for_market(current_date,'ebay') v"),mark=(ref,flag,rev)=>v('select set_return_hold_inspected($1,$2,$3) v',[ref,flag,rev]);
  const entries=(await report()).ebay_account_holds.entries,find=r=>entries.find(x=>x.ref===r).item_context;
  assert.deepEqual(find('R1').items,[{id:id(11),title:'Sapphire ring',number:'111'}]);assert.equal(find('R1').name,'Buyer Name');
  assert.equal(find('R2').items,undefined);assert.equal(find('R3').items.length,2);
  assert.equal((await mark('R1',true,0)).mark.signer,'Alex');assert.equal((await mark('R1',true,0)).mark.revision,1);
  await assert.rejects(mark('R1',false,0),/changed/);await assert.rejects(mark('R3',true,0),/no longer/);
  const task=(ref,n)=>v('select create_return_hold_task($1,$2,$3,$4) v',[id(n),ref,id(1),'Check refund evidence']);
  const created=await task('R1',21);assert.equal(created.tasks[0].owner,'Alex');assert.deepEqual(await task('R1',21),created);
  await task('R2',22);assert.equal(await v('select count(*)::int v from team_tasks'),1);
  assert.equal(await v('select count(*)::int v from ebay_return_tasks'),1);
  const data=await report();assert.equal(data.ebay_return_hold_reviews.R2.mark,null);assert.equal(data.ebay_return_hold_reviews.R1.mark.inspected,true);
  await db.exec('update ebay_account_holds set entries=entries||\'[]\'::jsonb');
  assert.equal((await mark('R1',false,1)).mark.revision,2);
  await db.exec("update employees set active=false");await assert.rejects(mark('R1',true,2),/admin/);await assert.rejects(task('R2',23),/admin/);
 }finally{await db.close();}
});
test('phone review: filter, assign without losing the draft on auto-refresh, inspect and undo',async()=>{
 const b=await chromium.launch();try{
  const p=await b.newPage({viewport:{width:390,height:840}});
  await p.route('http://localhost/holds',r=>r.fulfill({contentType:'text/html',body:'<section class="wh-panel"></section>'}));await p.goto('http://localhost/holds');
  for(const f of ['weekly-return-hold-review.js','weekly-ebay-holds.js'])await p.addScriptTag({path:root(f)});
  await p.addStyleTag({path:root('weekly-marketplace-sales.css')});
  await p.evaluate(()=>{
   const data={month:'2026-11-01',ebay_return_hold_reviews:{},ebay_account_holds:{verified_at:new Date().toISOString(),ledger_cents:2500,entries:['111','222'].map((ref,i)=>({kind:'return',ref,oid:'22-10000-00222',cents:i?1000:1500,placed:'2026-11-01',item_context:{name:'Taylor',user:'tg',source:'line',items:[{title:i?'Pendant':'Watch',number:ref}]}}))}};
   const client={rpc:async(n,args)=>{
    if(n==='list_team_task_assignees')return {data:[{user_id:'employee',display_name:'Jo'}]};
    const v=data.ebay_return_hold_reviews[args._ref]??={};
    if(n==='set_return_hold_inspected')v.mark={revision:args._revision+1,inspected:args._inspected,signer:'Alex',at:'2026-11-03T18:15:00Z'};
    if(n==='create_return_hold_task')v.tasks=[{id:'task-id',owner:'Jo',status:'assigned'}];return {data:v};
   }};
   window.draw=()=>WeeklyEbayHolds.update(document.querySelector('section'),data,client,()=>{});draw();
  });
  await p.locator('[data-wh-kind=return]').click();await p.locator('[data-inspection-mode=unchecked]').click();
  await p.locator('.wh-find').fill('Watch');let card=p.locator('.wh-list article');assert.equal(await card.count(),1);
  assert.match(await card.innerText(),/Taylor/);await card.getByRole('button',{name:'Create task'}).click();
  await p.locator('.whr-dialog select').selectOption('employee');await p.locator('.whr-dialog textarea').fill('Review the receipt');
  await p.evaluate(()=>draw());assert.equal(await p.locator('.whr-dialog textarea').inputValue(),'Review the receipt');
  await p.getByRole('button',{name:'Assign task'}).click();await card.getByRole('link',{name:'View task'}).waitFor();
  await card.getByRole('button',{name:'Mark inspected'}).click();await p.locator('.whr-mark').waitFor({state:'detached'});
  await p.locator('[data-inspection-mode=checked]').click();assert.match(await card.innerText(),/Alex.*EST/);
  await card.getByRole('button',{name:'Undo inspection'}).click();await p.locator('.whr-mark').waitFor({state:'detached'});
  await p.locator('[data-inspection-mode=unchecked]').click();assert.equal(await card.count(),1);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await b.close();}
});
