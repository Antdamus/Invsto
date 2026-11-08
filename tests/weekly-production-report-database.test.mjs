import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
let db;const admin='00000000-0000-4000-8000-000000000001';
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(id uuid,user_id uuid,active boolean,role text,display_name text);
 insert into employees values('${admin}','${admin}',true,'admin','Admin');
 create table store_locations(id uuid,name text,timezone text);
 create table time_entries(id uuid,employee_id uuid,store_id uuid,clock_in timestamptz,clock_out timestamptz);
 create table time_breaks(time_entry_id uuid,started_at timestamptz,ended_at timestamptz);
 create table weekly_ebay_show_catalog(event_id text,title text,starts_at timestamptz,ends_at timestamptz,source text);
 create function weekly_ebay_production_shows() returns table(event_id text,title text,starts_at timestamptz,ends_at timestamptz,seller_override uuid,recorded_seller uuid)
 language sql as $$select event_id,title,starts_at,ends_at,null::uuid,null::uuid from public.weekly_ebay_show_catalog$$;
 create function get_weekly_sales_for_market(_month date,_market text) returns jsonb language plpgsql as $$
 declare m date:=_month;end_date date:=m+30;cutoff timestamp:=m+7;begin return jsonb_build_object('ebay_item_orders','[]'::jsonb);end$$;
 set test.actor='${admin}';`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261108040000_weekly_production_reports.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
test('timing preserves provenance, missing durations and unknown actual end',async()=>{
 await db.exec(`insert into weekly_ebay_show_catalog(event_id,title,starts_at,source,airtime_seconds,airtime_source,airtime_checked_at,airtime_provisional)
 values('show0001','A','2026-11-02T15:00Z','studio',7200,'ebay_live_studio_insights','2026-11-08T05:00Z',true),
 ('show0002','B','2026-11-03T15:00Z','studio',null,null,null,false);`);
 const r=(await db.query("select get_weekly_sales_for_market('2026-11-01','ebay') r")).rows[0].r.ebay_show_timing;
 assert.equal(r.length,2);assert.equal(r[0].airtime_seconds,7200);assert.equal(r[0].ends_at,null);assert.equal(r[0].airtime_provisional,true);assert.equal(r[1].airtime_seconds,null);
 await assert.rejects(db.exec("update weekly_ebay_show_catalog set airtime_seconds=-1"),/check constraint/);
});
test('timing helper remains private',async()=>{
 await db.exec('set role authenticated');
 await assert.rejects(db.query("select weekly_ebay_show_timing('2020-11-01','2020-11-02')"),/permission denied/);
 await db.exec('reset role');
});
