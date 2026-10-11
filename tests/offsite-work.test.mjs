import {test,before,after,beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {randomUUID} from 'node:crypto';
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db;
const gps={lat:25.8,lng:-80.2,accuracy_m:15};
const startData={...gps,purpose:'Deliver an order',destination:'Customer address'};
const action=(type,outing=null,data={},request=randomUUID())=>db.query('select * from work_outing_action($1,$2,$3,$4)',[request,type,outing,data]);
const start=async()=> (await action('start',null,startData)).rows[0];
const actor=async n=>db.query("select set_config('test.user',$1,false)",[id(n)]);
const photo=async(name='proof.jpg',employee=2)=>{const p=`${id(employee)}/shifts/${randomUUID()}-${name}`;await db.query("insert into storage.objects(bucket_id,name) values('timeclock-photos',$1)",[p]);return p;};
before(async()=>{
 db=new PGlite();
 await db.exec(`create role authenticated;create role anon;create schema auth;create schema storage;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user',true),'')::uuid$$;
 create table employees(id uuid primary key,user_id uuid,display_name text,role text,active boolean);
 create table store_locations(id uuid primary key,lat numeric,lng numeric,radius_m numeric,active boolean);
 create table time_entries(id uuid primary key default gen_random_uuid(),employee_id uuid,store_id uuid,clock_in timestamptz,clock_out timestamptz,photo_out_path text,clock_out_lat numeric,clock_out_lng numeric,clock_out_accuracy_m numeric,clock_out_distance_m numeric,geo_ok_out boolean,schedule_codes text[] default '{}',schedule_note text);
 create table time_breaks(id uuid primary key default gen_random_uuid(),time_entry_id uuid,started_at timestamptz default now(),ended_at timestamptz,start_lat numeric,start_lng numeric,start_accuracy_m numeric,end_lat numeric,end_lng numeric,end_accuracy_m numeric,geo_ok_start boolean,geo_ok_end boolean,photo_start_path text,photo_end_path text,break_codes text[]);
 create table shift_approvals(time_entry_id uuid);
 create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
 create table storage.objects(bucket_id text,name text,metadata jsonb,created_at timestamptz default now());alter table storage.objects enable row level security;
 create function haversine_meters(numeric,numeric,numeric,numeric) returns numeric language sql immutable as $$select sqrt(power(($1-$3)*111000,2)+power(($2-$4)*100000,2))$$;
 create table test_locks(active boolean);
 create function assert_unlocked_for_range(timestamptz,timestamptz,text) returns void language plpgsql as $$begin if exists(select 1 from test_locks where active) then raise exception 'Payroll locked';end if;end$$;
 create function sync_shift_anomalies(uuid) returns void language sql as $$select$$;
 create function refresh_monthly_hours_all() returns void language sql as $$select$$;
 create function refresh_payroll_period_hours() returns void language sql as $$select$$;
 grant usage on schema public,auth,storage to authenticated;grant select on storage.objects to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261011200000_offsite_work.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261011201000_outing_clockout_filter.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{
 await db.exec(`reset role;truncate work_outing_events,work_outings,time_breaks,time_entries,employees,store_locations,shift_approvals,storage.objects,test_locks cascade;
 insert into employees values('${id(1)}','${id(1)}','Admin','admin',true),('${id(2)}','${id(2)}','Worker','employee',true),('${id(3)}','${id(3)}','Other worker','employee',true);
 insert into store_locations values('${id(4)}',25.8,-80.2,100,true);
 insert into time_entries(id,employee_id,store_id,clock_in) values('${id(10)}','${id(2)}','${id(4)}',now()-interval '4 hours');`);
 await actor(2);
});
test('outing keeps the paid shift open; return needs store GPS and retains all evidence',async()=>{
 const w=await start();assert.equal(w.ended_at,null);
 assert.equal((await db.query('select clock_out from time_entries')).rows[0].clock_out,null);
 assert.equal((await db.query('select * from time_breaks')).rows.length,0);
 await action('update',w.id,{note:'Order handed to the customer'});
 const p=await photo();await assert.rejects(action('return',w.id,{...gps,lat:26,photo_path:p}),/shift store/);
 await action('return',w.id,{...gps,photo_path:p});
 const rows=(await db.query('select * from work_outing_events order by created_at')).rows;
 assert.deepEqual(rows.map(r=>r.action),['start','update','return']);assert.equal(rows[2].store_verified,true);
 assert.equal((await db.query('select clock_out from time_entries')).rows[0].clock_out,null);
 assert.equal((await db.query('select end_kind from work_outings')).rows[0].end_kind,'returned');
});
test('offsite finish atomically closes shift, stores exact GPS/photo, and keeps a permanent review flag',async()=>{
 const w=await start(),p=await photo();
 await action('finish',w.id,{...gps,lat:26.123456,lng:-80.333333,photo_path:p,note:'Delivered. Heading home.'});
 const t=(await db.query('select * from time_entries')).rows[0],o=(await db.query('select * from work_outings')).rows[0];
 assert.equal(t.clock_out_lat,'26.123456');assert.equal(t.clock_out_lng,'-80.333333');assert.equal(t.clock_out_accuracy_m,'15');
 assert.equal(t.geo_ok_out,false);assert.equal(t.photo_out_path,p);assert.ok(t.schedule_codes.includes('OFFSITE_CLOCK_OUT'));
 assert.equal(+t.clock_out,+o.ended_at);assert.equal(o.reviewed_at,null);assert.equal(o.shift_ended_offsite,true);
 await actor(1);await action('review',w.id,{note:'Delivery proof and time checked'});
 assert.ok((await db.query('select reviewed_at from work_outings')).rows[0].reviewed_at);
 assert.ok((await db.query('select schedule_codes from time_entries')).rows[0].schedule_codes.includes('OFFSITE_CLOCK_OUT'));
});
test('missing, inaccurate, and invalid GPS cannot finish; no partially closed shift',async()=>{
 const w=await start(),p=await photo();
 for(const coords of [{},{...gps,accuracy_m:200},{...gps,lat:91},{...gps,lng:'NaN'}])await assert.rejects(action('finish',w.id,{...coords,photo_path:p,note:'Delivered'}),/GPS/);
 assert.equal((await db.query('select ended_at from work_outings')).rows[0].ended_at,null);
 assert.equal((await db.query('select clock_out from time_entries')).rows[0].clock_out,null);
});
test('proof must exist, be fresh, belong to the worker and not have been reused',async()=>{
 const w=await start();
 await assert.rejects(action('finish',w.id,{...gps,note:'Done',photo_path:'fake'}),/new camera photo/);
 const other=await photo('other.jpg',3);await assert.rejects(action('finish',w.id,{...gps,note:'Done',photo_path:other}),/new camera photo/);
 const p=await photo();await db.exec("update storage.objects set created_at=now()-interval '20 minutes'");
 await assert.rejects(action('finish',w.id,{...gps,note:'Done',photo_path:p}),/new camera photo/);
});
test('retrying the same start or finish cannot duplicate outings/events',async()=>{
 const req=randomUUID();const first=(await action('start',null,startData,req)).rows[0];
 const retry=(await action('start',null,startData,req)).rows[0];assert.equal(first.id,retry.id);
 await assert.rejects(action('start',null,{...startData,purpose:'Different'},req),/already used/);
 const endReq=randomUUID(),data={...gps,photo_path:await photo(),note:'Delivery complete'};
 await action('finish',first.id,data,endReq);await action('finish',first.id,data,endReq);
 assert.equal((await db.query('select * from work_outing_events')).rows.length,2);
});
test('second active outing, departure on break and generic clock-out are blocked',async()=>{
 const w=await start();await assert.rejects(start(),/already active/);
 await assert.rejects(db.exec('update time_entries set clock_out=now()'),/Finish or resolve/);
 await action('break_start',w.id,{...gps,photo_path:await photo()});
 await assert.rejects(action('finish',w.id,{...gps,photo_path:await photo(),note:'Done'}),/End the active break/);
});
test('offsite breaks remain real breaks with their own GPS and photos',async()=>{
 const w=await start();const p=await photo();
 await action('break_start',w.id,{...gps,lat:26,photo_path:p});
 await assert.rejects(action('break_end',w.id,{...gps,photo_path:p}),/new camera photo/);
 await action('break_end',w.id,{...gps,lat:26,photo_path:await photo()});
 const b=(await db.query('select * from time_breaks')).rows[0];assert.ok(b.ended_at);assert.deepEqual(b.break_codes,['OFFSITE_BREAK']);
 await action('finish',w.id,{...gps,lat:26,photo_path:await photo(),note:'Done'});
});
test('other workers, anonymous users and inactive accounts cannot act or read evidence',async()=>{
 const w=await start();await actor(3);await assert.rejects(action('update',w.id,{note:'Forged'}),/not allowed/);
 await db.exec('set role authenticated');assert.equal((await db.query('select * from work_outings')).rows.length,0);assert.equal((await db.query('select * from work_outing_events')).rows.length,0);await db.exec('reset role');
 await db.exec("select set_config('test.user','',false)");await assert.rejects(start(),/Sign in/);
 await actor(2);await db.exec(`update employees set active=false where id='${id(2)}'`);await assert.rejects(start(),/Active employee/);
});
test('workers cannot review or resolve; admin exceptions have an explicit unverified location flag and full snapshot',async()=>{
 const w=await start();await assert.rejects(action('resolve',w.id,{note:'Done',ended_at:new Date().toISOString()}),/Administrator/);
 await actor(1);await action('resolve',w.id,{note:'Worker forgot to end outing. Confirmed by supervisor.',ended_at:new Date().toISOString(),finish_shift:true});
 const t=(await db.query('select * from time_entries')).rows[0];assert.equal(t.clock_out_lat,null);assert.equal(t.geo_ok_out,false);assert.ok(t.schedule_codes.includes('OFFSITE_LOCATION_UNVERIFIED'));
 const event=(await db.query("select * from work_outing_events where action='resolve'")).rows[0];assert.equal(event.details.original_outing.id,w.id);assert.equal(event.actor_user_id,id(1));
});
test('shift corrections cannot move outings outside shift; delete cannot discard outing evidence',async()=>{
 const w=await start();await assert.rejects(db.exec("update time_entries set clock_in=now()+interval '1 minute'"),/every recorded outing/);
 await assert.rejects(db.exec('delete from time_entries'),/foreign key/);
 await action('finish',w.id,{...gps,photo_path:await photo(),note:'Done'});
 await assert.rejects(db.exec("update time_entries set clock_out=clock_in+interval '1 hour'"),/every recorded outing/);
});
test('payroll lock rejects transitions without writing evidence or closing anything',async()=>{
 const w=await start();await db.exec('insert into test_locks values(true)');
 await assert.rejects(action('finish',w.id,{...gps,photo_path:await photo(),note:'Done'}),/Payroll locked/);
 assert.equal((await db.query('select * from work_outing_events')).rows.length,1);
});
test('overnight shift remains the same shift; all timestamps persist as timestamptz',async()=>{
 await db.exec("update time_entries set clock_in=date_trunc('day',now())-interval '2 hours'");
 const w=await start();await action('finish',w.id,{...gps,photo_path:await photo(),note:'Night delivery complete'});
 const shifts=(await db.query('select * from time_entries')).rows;assert.equal(shifts.length,1);assert.equal(w.time_entry_id,shifts[0].id);assert.ok(shifts[0].clock_out>shifts[0].clock_in);
});
test('evidence can be added after return; cannot attach another employee file or forge direct rows',async()=>{
 const w=await start();await action('return',w.id,{...gps,photo_path:await photo()});
 const path=`${id(2)}/receipt.pdf`;await db.query("insert into storage.objects(bucket_id,name) values('offsite-work-evidence',$1)",[path]);
 await action('update',w.id,{note:'Receipt',attachments:[{path,name:'Receipt.pdf',type:'application/pdf'}]});
 await assert.rejects(action('update',w.id,{attachments:[{path:`${id(3)}/receipt.pdf`}]}),/Evidence file/);
 const p=(await db.query("select has_table_privilege('authenticated','work_outings','UPDATE') as edit,has_table_privilege('authenticated','work_outing_events','INSERT') as forge,has_table_privilege('authenticated','work_outing_events','DELETE') as erase")).rows[0];assert.deepEqual(p,{edit:false,forge:false,erase:false});
});
test('resolving an outing while keeping the shift open does not enter the offsite clock-out filter',async()=>{
 const w=await start();await actor(1);
 await action('resolve',w.id,{note:'Forgot return confirmation; worker is back.',ended_at:new Date().toISOString(),finish_shift:false});
 assert.equal((await db.query('select shift_ended_offsite from work_outings')).rows[0].shift_ended_offsite,false);
 assert.equal((await db.query('select clock_out from time_entries')).rows[0].clock_out,null);
});
