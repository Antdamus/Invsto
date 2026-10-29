import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
let db;const id='00000000-0000-4000-8000-000000000001';
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${id}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create function can_manage_inventory() returns boolean language sql stable as $$select current_setting('test.access',true)='yes'$$;
 create function is_admin() returns boolean language sql stable as $$select current_setting('test.admin',true)='yes'$$;
 create table material_cost_settings(singleton boolean primary key default true,rates jsonb not null default '{"silver":5.8}',updated_at timestamptz not null default now(),updated_by uuid);
 insert into material_cost_settings(singleton) values(true);
 create function get_material_cost_settings() returns jsonb language sql security definer set search_path='' as $$select to_jsonb(s) from public.material_cost_settings s where singleton$$;
 grant usage on schema auth to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261029220000_title_cost_rules.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{await db.exec(`reset role;truncate title_cost_rule_events;update material_cost_settings set title_cost_rules='[]',title_rules_updated_at=null,title_rules_updated_by=null;
 set test.actor='${id}';set test.access='yes';set test.admin='yes';set role authenticated;`);});
const save=(rules,version=null)=>db.query('select save_title_cost_rules($1,$2) v',[JSON.stringify(rules),version]);
test('rules persist globally with audit and version checks independent of material rates',async()=>{
 const before=(await db.query('select get_material_cost_settings() v')).rows[0].v;
 const saved=(await save([{phrase:' Watch   box ',base_cost:0,enabled:true}])).rows[0].v;
 assert.deepEqual(saved.title_cost_rules,[{phrase:'Watch box',base_cost:0,enabled:true}]);assert.equal(saved.title_rules_updated_by,id);assert.equal(saved.updated_at,before.updated_at);assert.deepEqual(saved.rates,before.rates);
 await assert.rejects(save([]),/changed on another device/);
 const disabled=(await save([{phrase:'Watch box',base_cost:15.25,enabled:false}],saved.title_rules_updated_at)).rows[0].v;
 await save([],disabled.title_rules_updated_at);
 await db.exec('reset role');const events=(await db.query('select * from title_cost_rule_events order by created_at')).rows;
 assert.equal(events.length,3);assert.equal(events[0].actor,id);assert.deepEqual(events[0].old_rules,[]);assert.deepEqual(events[2].new_rules,[]);
});
test('rules reject duplicate phrases and malformed prices without saving changes',async()=>{
 const good={phrase:'Watch box',base_cost:10,enabled:true};
 for(const rules of [null,{},[{}],[{...good,phrase:' '}],[{...good,phrase:'a'}],[{...good,phrase:'x'.repeat(121)}],[{...good,base_cost:null}],[{...good,base_cost:'10'}],[{...good,base_cost:-1}],[{...good,base_cost:1.001}],[{...good,base_cost:10000000000}],[{...good,enabled:'true'}],[good,{...good,phrase:'WATCH   box'}],Array.from({length:101},(_,i)=>({...good,phrase:'Watch '+i}))])await assert.rejects(save(rules));
 assert.deepEqual((await db.query('select get_material_cost_settings() v')).rows[0].v.title_cost_rules,[]);
});
test('only authenticated inventory administrators can change rules or audit data',async()=>{
 await db.exec('set test.admin=\'no\'');await assert.rejects(save([]),/administrator/);
 await db.exec('set test.admin=\'yes\';set test.access=\'no\'');await assert.rejects(save([]),/administrator/);
 await db.exec('set test.access=\'yes\';set test.actor=\'\'');await assert.rejects(save([]),/administrator/);
 await assert.rejects(db.query('select * from title_cost_rule_events'),/permission denied/);
 await assert.rejects(db.query("update material_cost_settings set title_cost_rules='[]'"),/permission denied/);
 await db.exec('reset role;set role anon');await assert.rejects(save([]),/permission denied/);
});
