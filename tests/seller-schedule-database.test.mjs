import {test,before,beforeEach,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;
const old=await readFile(new URL('../supabase/migrations/20260527100000_seller_sale_scheduling.sql',import.meta.url),'utf8');
function fn(name){const start=old.indexOf('create or replace function public.'+name+'(');return old.slice(start,old.indexOf('\n$$;',start)+4);}
function table(name){const start=old.indexOf('create table if not exists public.'+name+' (');return old.slice(start,old.indexOf('\n);',start)+3);}
const ids={admin:'10000000-0000-0000-0000-000000000001',s1:'10000000-0000-0000-0000-000000000002',s2:'10000000-0000-0000-0000-000000000003',s3:'10000000-0000-0000-0000-000000000004',store:'20000000-0000-0000-0000-000000000001'};
const book=async(seller,channel,start,end)=> (await db.query('select * from public.admin_schedule_seller_show($1,$2,$3,$4,$5,$6)',[seller,channel,ids.store,start,end,'Test show'])).rows[0];
before(async()=>{
 db=new PGlite();
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create table auth.users(id uuid primary key);
 create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
 create table public.employees(id uuid primary key,user_id uuid,display_name text,email text,role text,active boolean);
 create table public.store_locations(id uuid primary key,name text,timezone text,active boolean,created_at timestamptz default now());
 insert into auth.users values ('${ids.admin}'),('${ids.s1}'),('${ids.s2}'),('${ids.s3}');
 insert into public.employees values ('${ids.admin}','${ids.admin}','Admin','admin@test','admin',true),
 ('${ids.s1}','${ids.s1}','Seller One','one@test','seller',true),('${ids.s2}','${ids.s2}','Seller Two','two@test','seller',true),('${ids.s3}','${ids.s3}','Seller Three','three@test','seller',true);
 insert into public.store_locations(id,name,timezone,active) values('${ids.store}','Main studio','America/New_York',true);
 set test.uid='${ids.admin}';`);
 for(const name of ['current_employee_id','current_employee_role','current_user_can_manage_sellers','current_user_can_use_seller_schedule','seller_sale_active_statuses'])await db.exec(fn(name));
 for(const name of ['seller_sale_shifts','seller_sale_blocked_times','seller_shift_change_requests','seller_notifications'])await db.exec(table(name));
 await db.exec(`create table public.user_phones(user_id uuid primary key,phone_e164 text unique,can_sms boolean default true);
 create table public.sms_outbox(id uuid primary key default gen_random_uuid(),to_phone text not null,body text not null check(length(body)<=480),send_after timestamptz default now(),status text default 'pending',provider text,meta jsonb default '{}',attempts integer default 0,last_error text,created_at timestamptz default now());
 create table public.shift_sms_reminders(employee_id uuid,work_date date,start_local time,end_local time,store_id uuid,reminder_type text default 'shift_30_min');
 create table public.effective_work_shifts(employee_id uuid,work_date date,start_local time,end_local time,store_id uuid,source text);
 `);
 await db.exec(fn('create_seller_notification'));
 // SMS delivery is outside this database suite; retain the original workflow's contract.
 await db.exec(`create function public.notify_seller_management(uuid,text,text,text,text,uuid,uuid,jsonb,boolean) returns void language sql as $$select$$;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261113010000_show_schedule_studio.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261113020000_show_schedule_host_reminders.sql',import.meta.url),'utf8'));
 await db.exec(`create schema cron;create function cron.schedule(text,text,text) returns bigint language sql as $$select 1::bigint$$;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261113030000_recurring_seller_shows.sql',import.meta.url),'utf8'));
});

async function resetSms(){
 await db.exec('delete from seller_show_recurrence_conflicts');
 await db.exec(`set test.uid='${ids.admin}';delete from sms_outbox;delete from seller_shift_change_requests;delete from seller_notifications;delete from seller_sale_shifts;delete from effective_work_shifts;delete from shift_sms_reminders;delete from user_phones;update employees set active=true;
 insert into user_phones values('${ids.s1}','+12025550101',true),('${ids.s2}','+12025550102',true);`);
 await db.exec('delete from seller_show_recurrences');
}
async function seedShow(seller=ids.s1,minutes=20,status='booked'){
 return (await db.query(`insert into seller_sale_shifts(seller_employee_id,seller_user_id,channel,store_id,start_at,end_at,status)
 values($1,$1,'tiktok',$2,date_trunc('minute',now())+make_interval(mins=>$3),date_trunc('minute',now())+make_interval(mins=>$3+180),$4) returning *`,[seller,ids.store,minutes,status])).rows[0];
}
test('host SMS follows the correct phone, includes show details, and deduplicates scheduler runs',async()=>{
 await resetSms();const show=await seedShow();
 assert.equal((await db.query('select enqueue_seller_show_reminders() as n')).rows[0].n,1);
 assert.equal((await db.query('select enqueue_seller_show_reminders() as n')).rows[0].n,0);
 const row=(await db.query('select * from sms_outbox')).rows[0];
 assert.equal(row.to_phone,'+12025550101');assert.equal(row.meta.shift_id,show.id);assert.equal(row.meta.reminder_minutes,30);
 assert.match(row.body,/Seller One/);assert.match(row.body,/TikTok/);assert.match(row.body,/Main studio/);assert.match(row.body,/America\/New_York/);assert.match(row.body,/seller-dashboard.html/);
 const claim=(await db.query('select * from sms_outbox_claim(25)')).rows;
 assert.equal(claim.length,1);assert.equal(claim[0].status,'sending');assert.equal(claim[0].attempts,1);
 await db.exec("update sms_outbox set status='sent'");
 assert.equal((await db.query('select enqueue_seller_show_reminders() as n')).rows[0].n,0,'sent reminder is not sent again');
});
test('cancelled, expired, distant, inactive, opted-out, and missing-phone shows never get host SMS',async()=>{
 await resetSms();await seedShow(ids.s1,-5);await seedShow(ids.s1,60);await seedShow(ids.s1,20,'cancelled');await seedShow(ids.s3,20);
 await seedShow(ids.s2,20);await db.exec(`update user_phones set can_sms=false where user_id='${ids.s2}'`);
 await seedShow(ids.admin,20);await db.exec(`insert into user_phones values('${ids.admin}','+12025550103',true);update employees set active=false where id='${ids.admin}'`);
 assert.equal((await db.query('select enqueue_seller_show_reminders() as n')).rows[0].n,0);
 assert.equal((await db.query('select count(*) as n from sms_outbox')).rows[0].n,0);
});
test('rescheduling cancels old pending SMS and creates one current reminder; cancelling removes it',async()=>{
 await resetSms();const show=await seedShow();await db.query('select enqueue_seller_show_reminders()');
 await db.query("update seller_sale_shifts set start_at=start_at+interval '5 minutes',end_at=end_at+interval '5 minutes' where id=$1",[show.id]);
 assert.equal((await db.query('select status from sms_outbox')).rows[0].status,'cancelled');
 assert.equal((await db.query('select enqueue_seller_show_reminders() as n')).rows[0].n,1);
 const pending=(await db.query("select * from sms_outbox where status='pending'")).rows;
 assert.equal(pending.length,1);assert.equal(pending[0].meta.shift_id,show.id);
 await db.query("update seller_sale_shifts set status='cancelled' where id=$1",[show.id]);
 assert.equal((await db.query('select * from sms_outbox_claim(25)')).rows.length,0);
});
test('last-moment phone changes and expired shows are rejected by the SMS dispatcher claim',async()=>{
 await resetSms();await seedShow();await db.query('select enqueue_seller_show_reminders()');
 await db.exec(`update user_phones set can_sms=false where user_id='${ids.s1}'`);
 await db.exec("insert into sms_outbox(to_phone,body,meta) values('+12025550102','Existing task notice','{\"type\":\"task_notification\"}')");
 const claim=(await db.query('select * from sms_outbox_claim(25)')).rows;
 assert.equal(claim.length,1);assert.equal(claim[0].body,'Existing task notice','ordinary messages keep working');
 assert.equal((await db.query("select status from sms_outbox where meta->>'type'='seller_show_reminder'")).rows[0].status,'cancelled');
});
test('existing worker scheduler routes seller shows once and keeps normal shift reminders',async()=>{
 await resetSms();await seedShow();
 await db.exec(`insert into effective_work_shifts values
 ('${ids.s1}',current_date,'00:00','03:00','${ids.store}','seller_sale'),
 ('${ids.s2}',current_date,'00:00','03:00','${ids.store}','regular');`);
 await db.query('select enqueue_upcoming_shift_reminders()');await db.query('select enqueue_upcoming_shift_reminders()');
 const rows=(await db.query('select to_phone,meta from sms_outbox order by to_phone')).rows;
 assert.equal(rows.length,2);assert.equal(rows[0].meta.type,'seller_show_reminder');assert.equal(rows[1].meta.type,'shift_30_min_reminder');
});
test('reminder readiness flags missing phones, limits seller visibility, and protects internal enqueue RPC',async()=>{
 await resetSms();
 let rows=(await db.query('select * from get_seller_show_sms_readiness()')).rows;
 assert.equal(rows.find(r=>r.seller_employee_id===ids.s1).phone_last_four,'0101');
 assert.equal(rows.find(r=>r.seller_employee_id===ids.s3).reason,'missing_phone');
 await db.exec(`set test.uid='${ids.s1}'`);rows=(await db.query('select * from get_seller_show_sms_readiness()')).rows;
 assert.equal(rows.length,1);assert.equal(rows[0].seller_employee_id,ids.s1);
 const grants=(await db.query("select has_function_privilege('authenticated','enqueue_seller_show_reminders()','execute') as staff,has_function_privilege('service_role','enqueue_seller_show_reminders()','execute') as service")).rows[0];
 assert.deepEqual(grants,{staff:false,service:true});
});
after(async()=>db?.close());
beforeEach(async()=>{await db.exec(`set test.uid='${ids.admin}'`);});

async function seedRecurringWeek(){
 await resetSms();
 return (await db.query(`insert into seller_show_recurrences(seller_employee_id,channel,store_id,weekdays,start_local,end_local,ends_next_day,effective_from)
 select employee,'ebay',$3,days,start_time,end_time,overnight,date_trunc('week',now() at time zone 'America/New_York')::date+7
 from (values ($1::uuid,array[1,2,3,4,5],'10:00'::time,'13:00'::time,false),
 ($1::uuid,array[1,2,3,4,5],'14:00'::time,'17:00'::time,false),
 ($2::uuid,array[0,5,6],'22:30'::time,'01:30'::time,true)) v(employee,days,start_time,end_time,overnight)
 returning id,to_char(effective_from,'YYYY-MM-DD') as first_day`,[ids.s1,ids.s2,ids.store])).rows;
}
async function fillRecurringWeek(firstDay){return (await db.query('select materialize_seller_show_recurrences($1::date+6) as result',[firstDay])).rows[0].result;}

test('weekly patterns create thirteen correct local-time shows, cross midnight, extend and deduplicate',async()=>{
 const patterns=await seedRecurringWeek();
 assert.deepEqual(await fillRecurringWeek(patterns[0].first_day),{created:13,conflicts:0,window_days:90});
 assert.equal((await fillRecurringWeek(patterns[0].first_day)).created,0);
 const check=(await db.query(`select count(*)::int as n,bool_and(s.channel='ebay' and s.store_id=$1 and
   (s.start_at at time zone 'America/New_York')::time=r.start_local and
   (s.end_at at time zone 'America/New_York')::time=r.end_local and
   extract(dow from s.recurrence_date)::int=any(r.weekdays) and
   (s.end_at at time zone 'America/New_York')::date=s.recurrence_date+case when r.ends_next_day then 1 else 0 end
   and s.metadata->>'recurrence_id'=r.id::text) as valid
 from seller_sale_shifts s join seller_show_recurrences r on r.id=s.recurrence_id`,[ids.store])).rows[0];
 assert.deepEqual(check,{n:13,valid:true});
 const result=(await db.query('select materialize_seller_show_recurrences($1::date+13) as result',[patterns[0].first_day])).rows[0].result;
 assert.equal(result.created,13);
 // Long horizons cross DST in season; every generated occurrence must retain its local wall time.
 await db.query('select materialize_seller_show_recurrences(current_date+180)');
 assert.equal((await db.query(`select count(*)::int as n from seller_sale_shifts s join seller_show_recurrences r on r.id=s.recurrence_id
 where (s.start_at at time zone 'America/New_York')::time<>r.start_local or (s.end_at at time zone 'America/New_York')::time<>r.end_local`)).rows[0].n,0);
});

test('employees assigned to shows can open the schedule without receiving manager access',async()=>{
 await resetSms();
 await db.exec(`update employees set role='employee' where id='${ids.s1}';set test.uid='${ids.s1}'`);
 assert.equal((await db.query('select current_user_can_use_seller_schedule() as allowed')).rows[0].allowed,false);
 const patterns=await seedRecurringWeek();await fillRecurringWeek(patterns[0].first_day);
 await db.exec(`set test.uid='${ids.s1}'`);
 const access=(await db.query('select current_user_can_use_seller_schedule() as allowed,current_user_can_manage_sellers() as manager')).rows[0];
 assert.deepEqual(access,{allowed:true,manager:false});
 assert.ok((await db.query('select * from get_seller_schedule_month($1)',[patterns[0].first_day])).rows.some(r=>r.is_mine));
 await db.exec(`update employees set active=false where id='${ids.s1}'`);
 assert.equal((await db.query('select current_user_can_use_seller_schedule() as allowed')).rows[0].allowed,false);
 await db.exec(`update employees set role='seller',active=true where id='${ids.s1}'`);
});

test('individual exceptions survive refill; stopping a series cancels only its future shows, pending requests and SMS',async()=>{
 const patterns=await seedRecurringWeek();await fillRecurringWeek(patterns[0].first_day);
 const series=patterns[0].id;
 const rows=(await db.query('select * from seller_sale_shifts where recurrence_id=$1 order by start_at',[series])).rows;
 await db.query("update seller_sale_shifts set status='cancelled' where id=$1",[rows[0].id]);
 await db.query("update seller_sale_shifts set start_at=date_trunc('minute',now())+interval '20 minutes',end_at=date_trunc('minute',now())+interval '200 minutes',status='edit_pending' where id=$1",[rows[1].id]);
 await db.query("insert into seller_shift_change_requests(shift_id,seller_employee_id,request_type) values($1,$2,'edit')",[rows[1].id,ids.s1]);
 assert.equal((await fillRecurringWeek(patterns[0].first_day)).created,0);
 assert.equal((await db.query('select enqueue_seller_show_reminders() as n')).rows[0].n,1);
 await db.exec(`set test.uid='${ids.s1}'`);
 await assert.rejects(db.query('select admin_stop_seller_show_recurrence($1)',[series]),/Only managers/);
 await db.exec(`set test.uid='${ids.admin}'`);
 const stopped=(await db.query('select admin_stop_seller_show_recurrence($1) as result',[series])).rows[0].result;
 assert.equal(stopped.cancelled_shows,4);
 assert.equal((await db.query('select status from sms_outbox')).rows[0].status,'cancelled');
 assert.equal((await db.query('select status from seller_shift_change_requests')).rows[0].status,'cancelled');
 assert.equal((await db.query("select count(*)::int as n from seller_sale_shifts where status='booked'")).rows[0].n,8);
 assert.equal((await fillRecurringWeek(patterns[0].first_day)).created,0);
 const grants=(await db.query("select has_function_privilege('authenticated','materialize_seller_show_recurrences(date)','execute') as staff,has_function_privilege('anon','admin_stop_seller_show_recurrence(uuid,text)','execute') as anon")).rows[0];
 assert.deepEqual(grants,{staff:false,anon:false});
});

test('recurring shows record conflicts and retry the missing occurrence after the conflict is removed',async()=>{
 const patterns=await seedRecurringWeek();
 const conflict=(await db.query(`insert into seller_sale_shifts(seller_employee_id,seller_user_id,channel,store_id,start_at,end_at)
 values($1,$1,'whatnot',$2,($3::date+time '10:00') at time zone 'America/New_York',($3::date+time '13:00') at time zone 'America/New_York') returning id`,[ids.s1,ids.store,patterns[0].first_day])).rows[0];
 assert.deepEqual(await fillRecurringWeek(patterns[0].first_day),{created:12,conflicts:1,window_days:90});
 assert.equal((await db.query('select count(*)::int as n from seller_show_recurrence_conflicts')).rows[0].n,1);
 await db.query("update seller_sale_shifts set status='cancelled' where id=$1",[conflict.id]);
 assert.deepEqual(await fillRecurringWeek(patterns[0].first_day),{created:1,conflicts:0,window_days:90});
 assert.equal((await db.query('select count(*)::int as n from seller_show_recurrence_conflicts')).rows[0].n,0);
 await resetSms();
});

test('managers assign TikTok and overnight shows to the selected seller in future months',async()=>{
 const row=await book(ids.s1,'tiktok','2031-01-31T22:00:00-05:00','2031-02-01T01:00:00-05:00');
 assert.equal(row.seller_employee_id,ids.s1);assert.equal(row.seller_user_id,ids.s1);assert.equal(row.created_by,ids.admin);assert.equal(row.metadata.scheduled_by_management,true);
 const jan=(await db.query("select * from get_seller_schedule_month('2031-01-01')")).rows;
 const feb=(await db.query("select * from get_seller_schedule_month('2031-02-01')")).rows;
 const march=(await db.query("select * from get_seller_schedule_month('2031-03-01')")).rows;
 assert.equal(jan.length,1);assert.equal(feb.length,1);assert.equal(march.length,0);assert.equal(jan[0].shift_id,feb[0].shift_id);
 const notices=(await db.query('select * from seller_notifications')).rows;assert.equal(notices.length,1);assert.equal(notices[0].recipient_employee_id,ids.s1);
 await db.query('select request_seller_sale_shift_edit($1,$2,$3,$4,$5,$6)',[row.id,'tiktok',ids.store,row.start_at,row.end_at,'']);
 assert.equal((await db.query('select notes from seller_sale_shifts where id=$1',[row.id])).rows[0].notes,null,'managers can clear existing show notes');
});
test('server rejects cross-platform seller conflicts and enforces exact simultaneous capacity',async()=>{
 await book(ids.s1,'ebay','2031-03-01T12:00:00-05:00','2031-03-01T14:00:00-05:00');
 await assert.rejects(book(ids.s1,'whatnot','2031-03-01T13:00:00-05:00','2031-03-01T15:00:00-05:00'),/already has a shift/);
 await book(ids.s2,'ebay','2031-03-01T14:00:00-05:00','2031-03-01T16:00:00-05:00');
 await book(ids.s3,'ebay','2031-03-01T12:00:00-05:00','2031-03-01T16:00:00-05:00');
 await assert.rejects(book(ids.admin,'ebay','2031-03-01T12:00:00-05:00','2031-03-01T14:00:00-05:00'),/already has 2 sellers/);
});
test('blocked times, invalid durations, and inactive seller assignments are rejected',async()=>{
 await db.query("select admin_save_seller_sale_block(null,'tiktok','2031-04-01T12:00Z','2031-04-01T15:00Z','Reserved',true)");
 await assert.rejects(book(ids.s1,'tiktok','2031-04-01T13:00Z','2031-04-01T15:00Z'),/blocked/);
 await assert.rejects(book(ids.s1,'ebay','2031-04-02T13:00Z','2031-04-02T14:00Z'),/at least 2 hours/);
 await assert.rejects(book(ids.s1,'ebay','2031-04-02T13:00Z','2031-04-03T15:00Z'),/at most 24 hours/);
 await assert.rejects(book(ids.s1,'ebay','2031-04-02T13:15Z','2031-04-02T15:15Z'),/30-minute/);
 await db.exec(`update employees set active=false where id='${ids.s2}'`);
 await assert.rejects(book(ids.s2,'ebay','2031-04-02T13:00Z','2031-04-02T15:00Z'),/active seller/);
 await db.exec(`update employees set active=true where id='${ids.s2}'`);
});
test('seller access stays self-only, near-start edits require approval, and admin RPC is private',async()=>{
 await db.exec(`set test.uid='${ids.s1}'`);
 await assert.rejects(book(ids.s2,'ebay','2031-05-01T12:00Z','2031-05-01T14:00Z'),/Only managers/);
 await assert.rejects(db.query('select book_seller_sale_shift($1,$2,$3,$4,$5)',['tiktok',ids.store,'2031-05-01T12:00Z','2031-05-01T14:00Z','No']),/current month/);
 const dates=(await db.query("select (date_trunc('hour', now()) + interval '30 minutes') as start, (date_trunc('hour',now()) + interval '150 minutes') as finish")).rows[0];
 // Self-booking and the existing approval path must both accept the new platform.
 const row=(await db.query('select * from book_seller_sale_shift($1,$2,$3,$4,$5)',['tiktok',ids.store,dates.start,dates.finish,'Self booked'])).rows[0];
 const result=(await db.query('select request_seller_sale_shift_edit($1,$2,$3,$4,$5,$6) as result',[row.id,'tiktok',ids.store,dates.start,dates.finish,'New theme'])).rows[0].result;
 assert.equal(result.status,'approval_requested');
 const grants=(await db.query("select has_function_privilege('anon','admin_schedule_seller_show(uuid,text,uuid,timestamptz,timestamptz,text)','execute') as anon,has_function_privilege('authenticated','admin_schedule_seller_show(uuid,text,uuid,timestamptz,timestamptz,text)','execute') as staff")).rows[0];
 assert.deepEqual(grants,{anon:false,staff:true});
 await db.exec("set test.uid=''");
 await assert.rejects(db.query("select * from get_seller_schedule_month('2031-01-01')"),/Not allowed/);
});
