import assert from 'node:assert/strict';
import {before,after,beforeEach,test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import C from '../material-costs-core.js';
import M from '../live-sales-report-model.js';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=async n=>db.exec(`reset role;set test.actor='${id(n)}';set role authenticated`);
const rpc=async(sql,params=[]) => (await db.query(sql,params)).rows[0]?.v;
const config=()=>rpc('select get_material_cost_settings() v');
const preview=rates=>rpc('select material_cost_stock_preview($1) v',[rates]);
const save=(rates,version,apply=false,token=null)=>rpc('select save_material_cost_settings($1,$2,$3,$4) v',[rates,version,apply,token]);
const defaults={gold_10:78,gold_14:99,silver:5.8};
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create table auth.users(id uuid primary key);insert into auth.users values('${id(1)}'),('${id(2)}');
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(user_id uuid primary key,display_name text,email text,role text,active boolean);
 insert into employees values('${id(1)}','Otello Guillen','admin@example.test','admin',true),('${id(2)}','Staff','staff@example.test','employee',true);
 create function can_manage_inventory() returns boolean language sql stable security definer as $$select exists(select 1 from public.employees where user_id=auth.uid() and active)$$;
 create function is_admin() returns boolean language sql stable security definer as $$select exists(select 1 from public.employees where user_id=auth.uid() and active and role='admin')$$;
 create table item_types(id uuid primary key default gen_random_uuid(),title text,barcode text,cost numeric,sale_price numeric,minimum_sale_price numeric,price_per_weight numeric,
 weight numeric,metal text,purity_basis_points int,watch_details jsonb,coin_details jsonb,deleted_at timestamptz,ebay_sync_enabled boolean default false,added_by uuid,created_at timestamptz default now());
 create table locations(id uuid primary key,location_name text);create table item_stock_locations(item_id uuid,location_id uuid,quantity int);
 create table storefront_listings(item_type_id uuid,published boolean);
 create table metadata(id text,inventory_version text,changed_item_ids text[]);insert into metadata values('inventory','before',null);
 grant usage on schema auth to authenticated;grant select,update on item_types to authenticated;`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261010140000_inventory_pricing_queue.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../supabase/migrations/20261029210000_shared_material_costs.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{await db.exec(`reset role;truncate item_types,item_stock_locations,inventory_pricing_events,material_cost_events;
 update material_cost_settings set rates='{"gold_10":78,"gold_14":99,"silver":5.8}',updated_at=clock_timestamp();
 set test.actor='${id(1)}';
 insert into item_types(id,title,cost,sale_price,minimum_sale_price,price_per_weight,weight,metal,purity_basis_points) values
 ('${id(10)}','Silver bracelet',70,300,100,7,10,'silver',9250),
 ('${id(11)}','Gold chain',156,400,220,78,2,'gold',4167),
 ('${id(12)}','Manual ring',120,300,170,7,10,'silver',9250),
 ('${id(13)}','Sold out',70,300,100,7,10,'silver',9250),
 ('${id(14)}','Fine silver',70,300,100,7,10,'silver',9990),
 ('${id(15)}','Gold plated',70,300,100,7,10,'gold',4167);
 insert into item_types(id,title,pricing_status,weight,metal,purity_basis_points) values('${id(16)}','Unpriced silver','pending',10,'silver',9250);
 insert into item_stock_locations(item_id,quantity) select id,case when id='${id(13)}' then 0 when id='${id(10)}' then 2 else 1 end from item_types;
 set role authenticated;`);});
test('global defaults flow into live costs, show overrides and manual zero retain precedence',()=>{
 const payload={global_material_costs:{rates:defaults},attempts:[{id:'s',buyer:'buyer',listing_title:'Silver 10g',price:100,payment_state:'paid'},{id:'g',buyer:'buyer',listing_title:'Gold 2g',price:200,payment_state:'paid'}]};
 let m=M.makeModel(payload);assert.equal(m.rows[0].cost.base,5800);assert.equal(m.rows[1].cost.base,15600);assert.match(m.rows[0].cost.source,/Global rate/);assert.equal(m.rows[0].cost.parsed.assumption,'925 assumed');
 m=M.makeModel({...payload,settings:{rates:{silver:6}},costs:{g:{mode:'manual',base_cost:0}}});assert.equal(m.rows[0].cost.base,6000);assert.equal(m.rows[1].cost.base,0);assert.match(m.rows[0].cost.source,/Show override/);
 assert.equal(M.costFor({listing_title:'999 silver 10g'},{},{rates:defaults}).base,null);
 assert.equal(M.costFor({listing_title:'925 silver 10g'},{},{rates:defaults}).parsed.assumed,false);
 for(const item of [{metal:'silver',purity_basis_points:9990,weight:3},{metal:'gold',weight:3,title:'Gold filled ring'},{metal:'silver',weight:3,coin_details:{}}])assert.equal(C.estimate(item,defaults),null);
 assert.equal(C.estimate({metal:'gold',purity_basis_points:5833,weight:2},defaults).cost,198);
});
test('stock preview counts eligible records and quantity without changing data',async()=>{
 const p=await preview(defaults);assert.equal(p.count,2);assert.equal(p.old_total,296);assert.equal(p.new_total,272);assert.equal(p.items[0].new_cost,58);
 assert.equal(await rpc('select cost::float v from item_types where id=$1',[id(10)]),70);
});
test('global save alone changes defaults; stock apply is atomic, audited, cache-invalidated and preserves retail and floor',async()=>{
 let c=await config();const changed={...defaults,silver:6};c=await save(changed,c.updated_at);assert.equal(c.updated_items,0);assert.equal(await rpc('select cost::float v from item_types where id=$1',[id(10)]),70);
 const p=await preview(changed);const result=await save(changed,c.updated_at,true,p.token);assert.equal(result.updated_items,2);
 const row=(await db.query('select * from item_types where id=$1',[id(10)])).rows[0];assert.equal(Number(row.cost),60);assert.equal(Number(row.sale_price),300);assert.equal(Number(row.minimum_sale_price),100);assert.equal(row.material_cost_key,'silver');
 await db.exec('reset role');assert.equal(await rpc('select jsonb_array_length(stock_changes) v from material_cost_events order by created_at desc limit 1'),2);assert.deepEqual(await rpc("select changed_item_ids v from metadata where id='inventory'"),[id(10),id(11)]);
});
test('stale rate editors and stale stock previews cannot overwrite changes',async()=>{
 const c=await config(),p=await preview(defaults);await db.query('update item_types set cost=71 where id=$1',[id(10)]);
 await assert.rejects(save(defaults,c.updated_at,true,p.token),/Stock changed/);assert.deepEqual((await config()).rates,defaults);
 await save(defaults,c.updated_at);await assert.rejects(save(defaults,c.updated_at),/Material rates changed/);
});
test('manual overrides disconnect a previously linked stock item',async()=>{
 const c=await config(),p=await preview(defaults);await save(defaults,c.updated_at,true,p.token);
 await db.query('update item_types set cost=123 where id=$1',[id(10)]);
 const row=(await db.query('select material_cost_key,material_cost_manual from item_types where id=$1',[id(10)])).rows[0];assert.equal(row.material_cost_key,null);assert.equal(row.material_cost_manual,true);assert.equal((await preview(defaults)).count,1);
});
test('pricing queue uses current material cost only with authorized owner and matching rate version',async()=>{
 const c=await config();await actor(2);
 const price=version=>rpc('select price_inventory_with_material_rate($1,1,200,100,$2) v',[id(16),version]);
 await assert.rejects(price(c.updated_at),/pricing owner/);await actor(1);await assert.rejects(price('2020-01-01'),/Material rates changed/);
 await price(c.updated_at);const row=(await db.query('select * from item_types where id=$1',[id(16)])).rows[0];assert.equal(Number(row.cost),58);assert.equal(row.material_cost_key,'silver');assert.equal(row.material_cost_manual,false);assert.equal(row.pricing_status,'ready');
});
test('rates are validated, admin-only, and inaccessible to anonymous users',async()=>{
 const c=await config();for(const r of [{silver:5},{...defaults,gold_10:-1},{...defaults,gold_10:'78'},{...defaults,silver:0},{...defaults,silver:1.12345},{...defaults,other:5}])await assert.rejects(save(r,c.updated_at));
 await actor(2);assert.equal((await config()).can_edit,false);await assert.rejects(save(defaults,c.updated_at),/administrator/);await assert.rejects(db.query('select * from material_cost_settings'),/permission denied/);
 await db.exec('reset role;set role anon');await assert.rejects(config(),/permission denied/);
});


 test('new globally priced intake validates current rate and deferred intake stays unpriced',async()=>{
  await db.exec('reset role');
  await db.query("insert into item_types(id,title,weight,metal,purity_basis_points,cost,price_per_weight,material_cost_key) values($1,'10K ring',2,'gold',4167,156,78,'gold_10')",[id(21)]);
  await assert.rejects(db.query("insert into item_types(title,weight,metal,purity_basis_points,cost,price_per_weight,material_cost_key) values('Old cost',2,'gold',4167,150,75,'gold_10')"),/rates changed/);
  await db.query("insert into item_types(id,title,weight,metal,pricing_status,cost,price_per_weight,material_cost_key) values($1,'Pending',2,'silver','pending',11.6,5.8,'silver')",[id(22)]);
  const row=(await db.query('select * from item_types where id=$1',[id(22)])).rows[0];assert.equal(row.cost,null);assert.equal(row.price_per_weight,null);assert.equal(row.material_cost_key,null);
 });
