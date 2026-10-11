import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
const {localValue,toISO,geoError}=createRequire(import.meta.url)('../time-correction-core.js');
const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
let db;
const day='2025-10-10';
const at=t=>`${day}T${t}:00Z`;
const correction=(args={})=>db.query('select * from admin_correct_shift_time($1,$2,$3,$4,$5,$6)',[
  id(args.entry||10),args.expectedIn||at('16:19'),args.expectedOut??null,args.start||at('13:45'),args.end??null,args.reason??'Arrived at 9:45; supervisor confirmed.'
]);
before(async()=>{
 db=new PGlite();
 await db.exec(`
 create role authenticated;create role anon;create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.user',true),'')::uuid$$;
 create table employees(id uuid primary key,user_id uuid,display_name text,role text,active boolean);
 create table store_locations(id uuid primary key,schedule_grace_in_m integer,schedule_grace_out_m integer);
 create table time_entries(id uuid primary key,employee_id uuid,store_id uuid,clock_in timestamptz,clock_out timestamptz,expected_start_ts timestamptz,expected_end_ts timestamptz,schedule_codes text[],photo_in_path text,photo_out_path text,geo_in jsonb,note text);
 create table time_breaks(id uuid primary key,time_entry_id uuid,started_at timestamptz,ended_at timestamptz);
 create table shift_approvals(time_entry_id uuid primary key,status text);
 create table shift_adjustments(id uuid primary key default gen_random_uuid(),time_entry_id uuid,editor_user_id uuid,edited_at timestamptz default now(),reason text,fields_changed text[],old_value jsonb,new_value jsonb);
 create table test_locked(starts timestamptz,ends timestamptz);
 create table test_refresh(kind text);
 create function assert_unlocked_for_range(a timestamptz,b timestamptz,c text) returns void language plpgsql as $$begin if exists(select 1 from test_locked where a < ends and b > starts) then raise exception 'Payroll period is locked'; end if;end$$;
 create function resolve_expected_window(uuid,timestamptz,uuid) returns table(expected_start_ts timestamptz,expected_end_ts timestamptz) language sql as $$select '${at('13:45')}'::timestamptz,'${at('22:00')}'::timestamptz$$;
 create function refresh_monthly_hours_all() returns void language sql as $$insert into test_refresh values('monthly')$$;
 create function refresh_payroll_period_hours() returns void language sql as $$insert into test_refresh values('payroll')$$;
 grant update on time_entries to authenticated;grant insert,update,delete on shift_adjustments to authenticated;
 `);
 await db.exec(await readFile(new URL('../supabase/migrations/20261011170000_audited_open_shift_corrections.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{
 await db.exec(`truncate employees,store_locations,time_entries,time_breaks,shift_approvals,shift_adjustments,test_locked,test_refresh;
 insert into employees values('${id(1)}','${id(1)}','Admin','admin',true),('${id(2)}','${id(2)}','Worker','employee',true),('${id(3)}','${id(3)}','Other','employee',true);
 insert into store_locations values('${id(4)}',5,5);
 insert into time_entries values('${id(10)}','${id(2)}','${id(4)}','${at('16:19')}',null,null,null,array['LATE_CLOCK_IN','ADMIN_TEST_LOCATION'],'original-in.jpg',null,'{"lat":25.7}', 'Original punch');
 select set_config('test.user','${id(1)}',false);`);
});
test('open correction preserves running shift and punch evidence, records actor/reason/full before-after, refreshes totals',async()=>{
 await correction();
 const row=(await db.query('select * from time_entries')).rows[0];
 assert.equal(new Date(row.clock_in).toISOString(),at('13:45').replace('Z','.000Z'));
 assert.equal(row.clock_out,null);assert.equal(row.photo_in_path,'original-in.jpg');assert.deepEqual(row.geo_in,{lat:25.7});assert.equal(row.note,'Original punch');
 assert.deepEqual(row.schedule_codes,['ADMIN_TEST_LOCATION']);
 const a=(await db.query('select * from shift_adjustments')).rows[0];
 assert.equal(a.editor_user_id,id(1));assert.match(a.reason,/supervisor/);assert.ok(a.edited_at);
 assert.equal(a.old_value.photo_in_path,'original-in.jpg');assert.deepEqual(a.fields_changed,['clock_in']);
 assert.equal((await db.query('select * from test_refresh')).rows.length,2);
});
test('non-admin, inactive admin and anonymous callers cannot correct',async()=>{
 for(const actor of [id(2),'']){
  await db.query("select set_config('test.user',$1,false)",[actor]);await assert.rejects(correction(),/active administrator/);
 }
 await db.query("select set_config('test.user',$1,false)",[id(1)]);await db.exec("update employees set active=false where role='admin'");
 await assert.rejects(correction(),/active administrator/);
});
test('audit cannot be forged or changed using direct authenticated writes',async()=>{
 const r=await db.query("select has_table_privilege('authenticated','time_entries','UPDATE') as edit,has_table_privilege('authenticated','shift_adjustments','INSERT') as forge,has_table_privilege('authenticated','shift_adjustments','DELETE') as erase");
 assert.deepEqual(r.rows[0],{edit:false,forge:false,erase:false});
});
test('rejects absent reason, future times, stale snapshots, and silently closing an open shift',async()=>{
 await assert.rejects(correction({reason:' '}),/Explain/);
 await assert.rejects(correction({start:'2099-01-01T09:45:00Z'}),/past/);
 await assert.rejects(correction({expectedIn:at('16:18')}),/changed after/);
 await assert.rejects(correction({end:at('22:00')}),/still clocked in/);
 assert.equal((await db.query('select * from shift_adjustments')).rows.length,0);
});
test('a second save cannot overwrite the correction using a stale form',async()=>{
 await correction();await assert.rejects(correction(),/changed after/);
 assert.equal((await db.query('select * from shift_adjustments')).rows.length,1);
});
test('no-op preserves approval and adds no audit record',async()=>{
 await db.exec(`insert into shift_approvals values('${id(10)}','approved')`);
 await correction({start:at('16:19')});
 assert.equal((await db.query('select * from shift_adjustments')).rows.length,0);
 assert.equal((await db.query('select * from shift_approvals')).rows.length,1);
});
test('closed shift correction captures previous approval and requires review again',async()=>{
 await db.exec(`update time_entries set clock_out='${at('22:00')}';insert into shift_approvals values('${id(10)}','approved')`);
 await correction({expectedOut:at('22:00'),end:at('21:45')});
 assert.equal((await db.query('select * from shift_approvals')).rows.length,0);
 assert.equal((await db.query('select old_value from shift_adjustments')).rows[0].old_value.previous_approval.status,'approved');
 await assert.rejects(correction({expectedIn:at('13:45'),expectedOut:at('21:45')}),/Clock-out must/);
});
test('overlap is rejected but adjacent shifts are allowed',async()=>{
 await db.exec(`insert into time_entries(id,employee_id,clock_in,clock_out) values('${id(11)}','${id(2)}','${at('12:00')}','${at('14:00')}')`);
 await assert.rejects(correction(),/overlap/);
 await correction({start:at('14:00')});
});
test('recorded and open breaks cannot be moved outside shift',async()=>{
 await db.exec(`insert into time_breaks values('${id(20)}','${id(10)}','${at('17:00')}',null)`);
 await assert.rejects(correction({start:at('17:30')}),/all recorded breaks/);
 await correction();
 assert.equal((await db.query('select * from time_breaks')).rows[0].ended_at,null);
});
test('payroll locks apply to both original and corrected ranges',async()=>{
 await db.exec(`insert into test_locked values('${at('13:00')}','${at('14:00')}')`);
 await assert.rejects(correction(),/locked/);
 await db.exec(`truncate test_locked;insert into test_locked values('${at('16:00')}','${at('17:00')}')`);
 await assert.rejects(correction(),/locked/);
 assert.equal((await db.query('select * from shift_adjustments')).rows.length,0);
});
test('legacy correction uses the same audited implementation',async()=>{
 await db.query('select admin_update_shift_time($1,$2,null,$3)',[id(10),at('13:45'),'Confirmed actual arrival']);
 assert.equal((await db.query('select * from shift_adjustments')).rows.length,1);
});
test('employee correction history returns only their own summary, without location evidence',async()=>{
 await correction();await db.query("select set_config('test.user',$1,false)",[id(2)]);
 const own=(await db.query('select * from get_my_time_corrections($1)',[[id(10)]])).rows;
 assert.equal(own.length,1);assert.equal(own[0].editor_name,'Admin');assert.equal(own[0].old_value.geo_in,undefined);
 await db.query("select set_config('test.user',$1,false)",[id(3)]);
 assert.equal((await db.query('select * from get_my_time_corrections($1)',[[id(10)]])).rows.length,0);
});
test('store timezone conversion handles winter/summer and preserves unchanged seconds',()=>{
 assert.equal(toISO('2026-10-11T09:45','America/New_York'),'2026-10-11T13:45:00.000Z');
 assert.equal(toISO('2026-01-11T09:45','America/New_York'),'2026-01-11T14:45:00.000Z');
 assert.equal(toISO('2026-10-11T09:45','America/New_York','2026-10-11T13:45:27Z'),'2026-10-11T13:45:27.000Z');
 assert.equal(localValue('2026-10-11T13:45:00Z','America/Los_Angeles'),'2026-10-11T06:45');
});
test('DST missing and repeated times require explicit resolution instead of silent wrong hours',()=>{
 assert.throws(()=>toISO('2026-03-08T02:30','America/New_York'),/does not exist/);
 assert.throws(()=>toISO('2026-11-01T01:30','America/New_York'),/occurs twice/);
 assert.equal(toISO('2026-11-01T01:30','America/New_York','2026-11-01T06:30:00Z'),'2026-11-01T06:30:00.000Z');
 assert.throws(()=>toISO('2026-02-30T09:45','America/New_York'),/does not exist/);
});
test('location timeout is not mislabeled as denied permission',()=>{
 assert.match(geoError(1),/blocked/);assert.match(geoError(3),/too long/);assert.doesNotMatch(geoError(3),/blocked/);
});

