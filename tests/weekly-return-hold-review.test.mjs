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
  await checkHoldUpgrade(db,v,report);
 }finally{await db.close();}
});
async function checkHoldUpgrade(db,v,report){
 await db.exec(`update employees set active=true;create role service_role;create schema cron;
  create table auth.users(id uuid primary key);insert into auth.users values(auth.uid());alter table ebay_return_cases add primary key(id);
  create table customer_return_money_marks(case_id uuid,marked boolean,revision int);
  create table task_notifications(id uuid primary key default gen_random_uuid(),recipient uuid,notification_type text constraint task_notifications_notification_type_check check(notification_type='other'),metadata jsonb);
  create function create_task_notification(uuid,text,text,uuid,uuid,text,text,text,text,timestamptz,jsonb,uuid,uuid,text) returns uuid language sql as $$insert into public.task_notifications(recipient,notification_type,metadata) values($1,$6,$11) returning id$$;
  create function notification_inbox(text,text,integer) returns jsonb language sql as $$select jsonb_agg(case when n.notification_type='catalogue_request' then 'catalogues' else 'tasks' end) from public.task_notifications n where n.recipient=auth.uid()$$;
  create function cron.schedule(text,text,text) returns int language sql as $$select 1$$;
  create function assign_customer_issue(uuid,uuid,uuid,text,text,timestamptz) returns uuid language sql as $$insert into public.ebay_return_tasks(status,assigned_to_user_id) values('assigned',$3) returning id$$;`);
 await db.exec(await readFile(root('supabase/migrations/20261104044000_return_hold_refund_reminders.sql'),'utf8'));
 await v("select set_hold_refund_reminder('R1',current_date+3) v");
 await db.exec(await readFile(root('supabase/migrations/20261104051000_ebay_hold_work.sql'),'utf8'));
 await db.query('update ebay_account_holds set entries=entries||$1::jsonb',[JSON.stringify(['dispute','retro','sale','other'].map(kind=>({kind,ref:'R1',oid:'order1'})))]);
 await db.query("insert into ebay_return_cases(id,order_id,order_number,source_lane,issue_kind,ebay_return_id,status) values($1,$2,'order1','payment_dispute','payment_dispute','R1','open')",[id(30),id(10)]);
 const before=(await report());assert.equal(before.ebay_hold_work['return:R1'].mark.revision,2);assert.equal(before.ebay_hold_work['return:R1'].tasks.length,1);
 assert.equal(before.ebay_hold_reminders['return:R1'].ref,'R1');
 const note=(kind,n,body)=>v('select add_ebay_hold_note($1,$2,$3,$4) v',[id(n),kind,'R1',body]);
 for(const [i,k] of ['dispute','retro','sale','other','return'].entries()){
  const a=await note(k,40+i,k+' note');assert.equal(a.notes.length,1);assert.equal(a.notes[0].signer,'Alex');assert.ok(a.notes[0].at);
  assert.deepEqual((await note(k,40+i,k+' note')).notes,a.notes);
 }
 await assert.rejects(note('sale',40,'dispute note'),/already used/);await assert.rejects(note('return',89,'  '),/Enter a note/);
 const typedTask=k=>v("select create_ebay_hold_task($1,$2,'R1',$3,'Check the evidence') v",[id(k==='dispute'?61:62),k,id(1)]);
 for(const k of ['dispute','retro']){
  assert.equal((await v("select set_ebay_hold_inspected($1,'R1',true,0) v",[k])).mark.revision,1);
  assert.equal((await typedTask(k)).tasks[0].owner,'Alex');assert.equal((await typedTask(k)).tasks.length,1);
  await v("select set_ebay_hold_reminder($1,'R1',current_date+2) v",[k]);
 }
 assert.equal(await v('select count(*)::int v from ebay_return_tasks'),2);assert.equal(await v('select count(*)::int v from team_tasks'),2);
 const after=await report();assert.deepEqual(after.ebay_account_holds,before.ebay_account_holds);
 assert.equal(after.ebay_hold_work['sale:R1'].mark,null);assert.equal(after.ebay_hold_work['return:R1'].mark.inspected,false);
 assert.equal(after.ebay_return_hold_reviews.R1.notes[0].body,'return note');assert.equal(Object.keys(after.ebay_hold_reminders).length,3);
 assert.deepEqual(Object.keys(after.ebay_refund_reminders),['R1']);
 await db.exec("update ebay_account_holds set entries='[]';insert into customer_return_money_marks values('"+id(13)+"',true,1);update ebay_hold_refund_reminders set due_at=now()-interval '1 minute'");
 await assert.rejects(note('retro',99,'too late'),/no longer/);
 assert.equal(await v('select deliver_hold_refund_reminders() v'),2);assert.equal(await v('select deliver_hold_refund_reminders() v'),0);
 assert.deepEqual(await v("select jsonb_agg(metadata->>'hold_kind' order by metadata->>'hold_kind') v from task_notifications where notification_type='hold_review_reminder'"),['dispute','retro']);
 await db.exec('update employees set active=false');await assert.rejects(note('return',44,'return note'),/admin/);
}
test('phone review: filter, assign without losing the draft on auto-refresh, inspect and undo',async()=>{
 const b=await chromium.launch();try{
  const p=await b.newPage({viewport:{width:390,height:840}});
  await p.route('http://localhost/holds',r=>r.fulfill({contentType:'text/html',body:'<section class="wh-panel"></section>'}));await p.goto('http://localhost/holds');
  for(const f of ['weekly-refund-reminders.js','weekly-return-hold-review.js','weekly-ebay-holds.js'])await p.addScriptTag({path:root(f)});
  await p.addStyleTag({path:root('weekly-marketplace-sales.css')});
  await p.evaluate(()=>{
   const data={month:'2026-11-01',ebay_hold_work:{},ebay_hold_reminders:{},ebay_account_holds:{verified_at:new Date().toISOString(),ledger_cents:8500,entries:['return','return','retro','dispute','sale','other'].map((kind,i)=>({kind,ref:i===1?'222':'111',oid:'22-10000-00222',cents:i===1?1000:1500,placed:'2026-11-01',item_context:{name:'Taylor',user:'tg',source:'line',items:[{title:i===1?'Pendant':'Watch'}]}}))}};
   const client={rpc:async(n,args)=>{
    if(n==='list_team_task_assignees')return {data:[{user_id:'employee',display_name:'Jo'}]};
    const k=args._kind+':'+args._ref;
    if(n==='set_ebay_hold_reminder'){if(args._day)data.ebay_hold_reminders[k]={day:args._day,ref:args._ref,kind:args._kind};else delete data.ebay_hold_reminders[k];return {data:data.ebay_hold_reminders};}
    const v=data.ebay_hold_work[k]??={};
    if(n==='set_ebay_hold_inspected')v.mark={revision:args._revision+1,inspected:args._inspected,signer:'Alex',at:'2026-11-03T18:15:00Z'};
    if(n==='create_ebay_hold_task')v.tasks=[{id:'task-id',owner:'Jo',status:'assigned'}];
    if(n==='add_ebay_hold_note')(v.notes??=[]).unshift({body:args._note,signer:'Jo',at:'2026-11-03T18:15:00Z'});
    return {data:v};
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
  await card.getByRole('button',{name:'Remind me to refund'}).click();const d=p.locator('.whr-reminder-dialog');
  await d.locator('input').fill('2030-02-04');await p.evaluate(()=>draw());assert.equal(await d.locator('input').inputValue(),'2030-02-04');
  await d.getByRole('button',{name:'Save reminder'}).click();await card.getByRole('button',{name:'Edit reminder'}).waitFor();
  assert.match(await card.innerText(),/Feb 4, 2030/);await card.getByRole('button',{name:'Edit reminder'}).click();
  await d.getByRole('button',{name:'Remove reminder'}).click();await card.getByRole('button',{name:'Remind me to refund'}).waitFor();
  for(const kind of ['dispute','retro','sale','other','return']){
   await p.locator('.wh-kind').selectOption(kind);const first=card.first();
   assert.equal(await first.locator('.whr-mark').count(),['dispute','retro','return'].includes(kind)?1:0);
   if(['retro','dispute'].includes(kind)){
    await first.getByRole('button',{name:'Remind me to follow up'}).click();await d.getByLabel('Follow up by').fill('2030-03-01');await d.getByRole('button',{name:'Save reminder'}).click();
    await first.getByRole('button',{name:'Edit reminder'}).waitFor();assert.equal(await first.getByRole('button',{name:'Create task'}).count(),1);
   }
   assert.equal(await first.locator('.whr-notes').count(),0);
   await first.getByRole('button',{name:'Add note'}).click();const nd=p.getByRole('dialog',{name:'Add a team note'}),field=nd.getByLabel('Note for the team');
   await field.fill(kind+' <check>');await p.evaluate(()=>draw());assert.equal(await field.inputValue(),kind+' <check>');
   await nd.getByRole('button',{name:'Save note'}).click();await first.locator('.whr-notes').waitFor();
   assert.match(await first.locator('.whr-notes').innerText(),/Jo.*EST/);assert.equal(await first.locator('.whr-note-body').innerText(),kind+' <check>');
  }
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await b.close();}
});
