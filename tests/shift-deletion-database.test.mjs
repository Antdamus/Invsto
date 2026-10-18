import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const start='2026-01-10T09:00:00Z', end='2026-01-10T17:00:00Z';
let db;
const remove=(reason='Opened by mistake; no work performed.',expectedIn=start,expectedOut=null)=>
  db.query('select admin_delete_shift_entry($1,$2,$3,$4) result',[id(10),reason,expectedIn,expectedOut]);
const count=async table=>(await db.query(`select count(*)::int n from ${table}`)).rows[0].n;
before(async()=>{
  db=new PGlite();
  await db.exec(`
    create role authenticated; create role anon; create role service_role; create schema auth;
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
    create table auth.users(id uuid primary key,email text);
    -- Simulate the legacy metadata-based admin check passing for a spoofed token.
    create function is_admin() returns boolean language sql as $$select true$$;
    create table employees(id uuid primary key,user_id uuid,display_name text,role text,active boolean);
    create table store_locations(id uuid primary key,active boolean);
    create table time_entries(id uuid primary key,employee_id uuid references employees(id),clock_in timestamptz,clock_out timestamptz,photo_in_path text,clock_in_lat numeric,note text);
    create table time_breaks(id uuid primary key,time_entry_id uuid references time_entries(id) on delete cascade,started_at timestamptz,ended_at timestamptz,photo_start_path text);
    create table shift_approvals(time_entry_id uuid primary key references time_entries(id) on delete cascade,status text);
    create table shift_adjustments(id uuid primary key default gen_random_uuid(),time_entry_id uuid references time_entries(id) on delete cascade,editor_user_id uuid,edited_at timestamptz default now(),reason text,fields_changed text[],old_value jsonb,new_value jsonb);
    create table work_outings(id uuid primary key,time_entry_id uuid references time_entries(id) on delete restrict);
    create table test_locked(starts timestamptz,ends timestamptz);
    create table test_refresh(kind text);
    create function assert_unlocked_for_range(a timestamptz,b timestamptz,c text) returns void language plpgsql as $$begin if exists(select 1 from test_locked where a<ends and b>starts) then raise exception 'Payroll period is locked';end if;end$$;
    create function refresh_monthly_hours_all() returns void language sql as $$insert into test_refresh values('monthly')$$;
    create function refresh_payroll_period_hours() returns void language plpgsql as $$begin if current_setting('test.fail_refresh',true)='yes' then raise exception 'Refresh failed';end if;insert into test_refresh values('payroll');end$$;
    grant delete,truncate on time_entries to authenticated,anon;
  `);
  await db.exec(await readFile(new URL('../supabase/migrations/20260528130000_admin_manual_time_entry_controls.sql',import.meta.url),'utf8'));
  await db.exec('grant insert,update,delete,truncate on time_entry_admin_audits to authenticated,anon');
  await db.exec(await readFile(new URL('../supabase/migrations/20261018120000_live_shift_deletion_guards.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{
  await db.exec(`truncate employees,time_entries,time_breaks,shift_approvals,shift_adjustments,work_outings,time_entry_admin_audits,test_locked,test_refresh cascade;
    set test.actor='${id(1)}';set test.fail_refresh='no';
    insert into employees values('${id(1)}','${id(1)}','Admin','admin',true),('${id(2)}','${id(2)}','Worker','employee',true);
    insert into time_entries values('${id(10)}','${id(2)}','${start}',null,'original-photo.jpg',25.71,'Original punch');
  `);
});

test('deleting an open shift preserves the actor, reason, original evidence and related records in a durable audit',async()=>{
  await db.exec(`insert into time_breaks values('${id(20)}','${id(10)}','2026-01-10T10:00Z',null,'break-photo.jpg');
    insert into shift_approvals values('${id(10)}','approved');
    insert into shift_adjustments(time_entry_id,reason,old_value,new_value) values('${id(10)}','Earlier correction','{"clock_in":"2026-01-10T08:00Z"}','{}');
    insert into time_entry_admin_audits(time_entry_id,employee_id,action,reason) values('${id(10)}','${id(2)}','manual_create','Earlier creation');`);
  const result=(await remove('  Opened by mistake  ')).rows[0].result;
  assert.deepEqual(result,{deleted:true,time_entry_id:id(10),employee_id:id(2)});
  for(const table of ['time_entries','time_breaks','shift_approvals','shift_adjustments']) assert.equal(await count(table),0);
  const audit=(await db.query("select * from time_entry_admin_audits where action='manual_delete'")).rows[0];
  assert.equal(audit.editor_user_id,id(1));assert.ok(audit.edited_at);assert.equal(audit.reason,'Opened by mistake');
  assert.equal(audit.employee_id,id(2));assert.deepEqual(audit.fields_changed,['deleted']);assert.deepEqual(audit.new_value,{});
  assert.equal(audit.old_value.time_entry.photo_in_path,'original-photo.jpg');assert.equal(audit.old_value.time_entry.clock_in_lat,25.71);
  assert.equal(audit.old_value.time_entry.clock_out,null);assert.equal(audit.old_value.breaks[0].photo_start_path,'break-photo.jpg');
  assert.equal(audit.old_value.approval.status,'approved');assert.equal(audit.old_value.adjustments[0].reason,'Earlier correction');
  assert.equal(audit.old_value.admin_audits[0].action,'manual_create');
  const trail=(await db.query("select * from v_shift_adjustments where 'manual_delete'=any(fields_changed)")).rows[0];
  assert.equal(trail.editor_name,'Admin');assert.equal(trail.reason,'Opened by mistake');assert.equal(trail.time_entry_id,id(10));
  assert.deepEqual((await db.query('select kind from test_refresh order by kind')).rows.map(r=>r.kind),['monthly','payroll']);
  await assert.rejects(remove(),/already have been deleted/);assert.equal(await count('time_entry_admin_audits'),2);
});

test('workers, anonymous callers and inactive admins cannot delete even with legacy admin metadata',async()=>{
  for(const actor of [id(2),'']){
    await db.query("select set_config('test.actor',$1,false)",[actor]);await assert.rejects(remove(),/active administrator/);
  }
  await db.exec(`set test.actor='${id(1)}';update employees set active=false where role='admin'`);
  await assert.rejects(remove(),/active administrator/);assert.equal(await count('time_entries'),1);assert.equal(await count('time_entry_admin_audits'),0);
});

test('blank/oversized reasons and stale confirmation snapshots cannot delete a shift',async()=>{
  for(const reason of ['', '  ', 'ab', 'x'.repeat(2001)]) await assert.rejects(remove(reason),/3 to 2000/);
  await assert.rejects(remove('Opened by mistake','2026-01-10T08:00Z'),/changed after/);
  await db.query('update time_entries set clock_out=$1',[end]);
  await assert.rejects(remove(),/changed after/);
  assert.equal(await count('time_entries'),1);assert.equal(await count('time_entry_admin_audits'),0);
  await remove('Wrong shift',start,end);assert.equal(await count('time_entries'),0);
});

test('payroll locks and off-site records prevent deletion without leaving a false audit',async()=>{
  await db.exec("insert into test_locked values('2026-01-10T00:00Z','2026-01-11T00:00Z')");
  await assert.rejects(remove(),/locked/);
  await db.exec(`truncate test_locked;insert into work_outings values('${id(30)}','${id(10)}')`);
  await assert.rejects(remove(),/off-site work records/);assert.equal(await count('work_outings'),1);
  assert.equal(await count('time_entries'),1);assert.equal(await count('time_entry_admin_audits'),0);
});

test('deletion and audit roll back together if recalculating totals fails',async()=>{
  await db.exec("set test.fail_refresh='yes'");await assert.rejects(remove(),/Refresh failed/);
  assert.equal(await count('time_entries'),1);assert.equal(await count('time_entry_admin_audits'),0);assert.equal(await count('test_refresh'),0);
});

test('legacy clients retain the audited RPC and direct deletion/audit tampering are denied',async()=>{
  await db.query('select admin_delete_shift_entry($1,$2)',[id(10),'Opened by mistake']);
  assert.equal(await count('time_entry_admin_audits'),1);
  for(const role of ['authenticated','anon']){
    for(const privilege of ['DELETE','TRUNCATE']) assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,'time_entries',privilege])).rows[0].allowed,false);
    for(const privilege of ['INSERT','UPDATE','DELETE','TRUNCATE']) assert.equal((await db.query('select has_table_privilege($1,$2,$3) allowed',[role,'time_entry_admin_audits',privilege])).rows[0].allowed,false);
  }
});
