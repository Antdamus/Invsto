import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
test('private Eastern refund deadlines deliver once to the owner and respect reschedules, cancellation and money returned',async()=>{
 const db=new PGlite(),id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0'),val=async(q,args=[])=>(await db.query(q,args)).rows[0].v;
 try{
  await db.exec(`create schema auth;create schema cron;create role authenticated;create role anon;create role service_role;
   create table auth.users(id uuid primary key);insert into auth.users values('${id(1)}'),('${id(2)}');
   create function auth.uid() returns uuid language sql stable as $$select current_setting('app.uid')::uuid$$;
   create table employees(user_id uuid,active bool,role text);insert into employees select id,true,'admin' from auth.users;
   create function require_return_hold_admin() returns void language plpgsql as $$begin if not exists(select from public.employees where user_id=auth.uid() and active and role='admin') then raise exception 'Access denied';end if;end$$;
   create table ebay_account_holds(singleton bool,entries jsonb);insert into ebay_account_holds values(true,'[{"kind":"return","ref":"123","oid":"orderA"},{"kind":"return","ref":"456"}]');
   create table ebay_return_cases(id uuid primary key,source_lane text,issue_kind text,ebay_return_id text,order_number text);
   insert into ebay_return_cases values('${id(3)}','return','return','123','orderA');
   create table customer_return_money_marks(case_id uuid,marked bool,revision int);
   create table task_notifications(id uuid primary key default gen_random_uuid(),recipient uuid,notification_type text constraint task_notifications_notification_type_check check(notification_type='other'),metadata jsonb);
   create function create_task_notification(uuid,text,text,uuid,uuid,text,text,text,text,timestamptz,jsonb,uuid,uuid,text) returns uuid language sql as $$insert into public.task_notifications(recipient,notification_type,metadata) values($1,$6,$11) returning id$$;
   create function get_weekly_sales_for_market(_month date,_market text) returns jsonb language sql as $$select jsonb_build_object('ebay_return_hold_reviews','{}'::jsonb)$$;
   create function notification_inbox(text,text,integer) returns jsonb language sql as $$select jsonb_agg(case when n.notification_type='catalogue_request' then 'catalogues' else 'tasks' end) from public.task_notifications n where n.recipient=auth.uid()$$;
   create function cron.schedule(text,text,text) returns int language sql as $$select 1$$;
   select set_config('app.uid','${id(1)}',false);`);
  await db.exec(await readFile(new URL('../supabase/migrations/20261104044000_return_hold_refund_reminders.sql',import.meta.url),'utf8'));
  const set=(ref,date)=>val('select set_hold_refund_reminder($1,$2) v',[ref,date]);
  const deliver=()=>val('select deliver_hold_refund_reminders() v');
  assert.equal(new Date((await set('123','2099-07-01'))['123'].at).toISOString(),'2099-07-01T13:00:00.000Z');
  assert.equal(new Date((await set('123','2099-12-01'))['123'].at).toISOString(),'2099-12-01T14:00:00.000Z');
  await assert.rejects(set('123','2000-01-01'),/today/);await assert.rejects(set('no-return','2099-07-01'),/no longer/);
  await set('456','2099-09-01');await set('456',null);
  await db.exec(`select set_config('app.uid','${id(2)}',false)`);assert.deepEqual(await val('select my_hold_refund_reminders() v'),{});
  await set('123','2099-06-01');await db.exec("update ebay_hold_refund_reminders set due_at=now()-interval '1 minute' where owner_id='"+id(1)+"'");
  assert.equal(await deliver(),1);assert.equal(await deliver(),0);
  assert.deepEqual(await val("select metadata v from task_notifications where recipient=$1",[id(1)]),{case_id:id(3),return_ref:'123'});
  await db.exec(`insert into customer_return_money_marks values('${id(3)}',true,1);update ebay_hold_refund_reminders set due_at=now()-interval '1 minute' where owner_id='${id(2)}';`);
  assert.equal(await deliver(),0);await assert.rejects(set('123','2099-09-01'),/already marked/);
  await db.exec(`select set_config('app.uid','${id(1)}',false)`);
  assert.deepEqual(await val("select notification_inbox('all','unread',30) v"),['returns']);
 }finally{await db.close();}
});
