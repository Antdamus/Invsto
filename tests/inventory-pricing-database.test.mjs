import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {before,after,beforeEach,test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import vm from 'node:vm';
let db;const id=n=>`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`;
const actor=async n=>db.exec(`set test.actor='${id(n)}'`);
const item=async()=> (await db.query('select * from item_types where id=$1',[id(100)])).rows[0];
const act=async(action,revision=1,prices=[null,null,null],owner=null)=>(await db.query('select act_inventory_pricing($1,$2,$3,$4,$5,$6,$7) result',[id(100),revision,action,...prices,owner])).rows[0].result;
const queue=async(scope='all',status='waiting',search='',offset=0)=>(await db.query('select list_inventory_pricing($1,$2,$3,$4) result',[scope,status,search,offset])).rows[0].result;
before(async()=>{
 db=new PGlite();await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('test.actor',true),'')::uuid$$;
 create table employees(user_id uuid primary key,display_name text,email text,role text,active boolean);
 create function can_manage_inventory() returns boolean language sql as $$select exists(select 1 from employees where user_id=auth.uid() and active and role in('admin','manager','employee'))$$;
 create function is_admin() returns boolean language sql as $$select exists(select 1 from employees where user_id=auth.uid() and active and role='admin')$$;
 create table item_types(id uuid primary key default gen_random_uuid(),title text,description text,cost numeric,sale_price numeric,minimum_sale_price numeric,price_per_weight numeric,
  ebay_sync_enabled boolean default true,deleted_at timestamptz,barcode text unique,added_by uuid,created_at timestamptz default now(),photos text[]);
 create table locations(id uuid primary key,location_name text);
 create table item_stock_locations(item_id uuid,location_id uuid,quantity int);
 create table storefront_listings(item_type_id uuid,published boolean);
 create table metadata(id text,inventory_version text,changed_item_ids text[]);insert into metadata values('inventory','before',null);
 insert into employees values('${id(1)}','Otello Guillen','otello@example.test','admin',true),('${id(2)}','Employee','employee@example.test','employee',true),('${id(3)}','Reviewer','reviewer@example.test','employee',true),('${id(4)}','Inactive','inactive@example.test','employee',false);`);
 await db.exec(await readFile(new URL('../supabase/migrations/20261010140000_inventory_pricing_queue.sql',import.meta.url),'utf8'));
});
after(()=>db?.close());
beforeEach(async()=>{await db.exec(`truncate inventory_pricing_events,item_types,storefront_listings;update inventory_pricing_settings set default_owner='${id(1)}';`);await actor(2);await db.query("insert into item_types(id,title,barcode,pricing_status,cost,sale_price,added_by,photos) values($1,'Cartier watch','WATCH-100','pending',99,250,$2,array['watch.jpg'])",[id(100),id(2)]);});
test('intake atomically defaults to Otello, strips all prices, holds eBay and records actor',async()=>{
 const i=await item();assert.equal(i.pricing_owner,id(1));assert.equal(i.pricing_status,'pending');assert.equal(i.cost,null);assert.equal(i.sale_price,null);assert.equal(i.minimum_sale_price,null);assert.equal(i.ebay_sync_enabled,false);assert.equal(i.pricing_resume_ebay,true);assert.deepEqual(i.photos,['watch.jpg']);
 const events=(await db.query('select * from inventory_pricing_events')).rows;assert.equal(events.length,1);assert.equal(events[0].actor,id(2));
});
test('manual intake remains ready and old inventory is not swept into the queue',async()=>{
 await db.query("insert into item_types(title,cost,sale_price) values('Manual',10,25)");assert.equal((await queue()).total,1);
});
test('worker cannot price an item assigned to someone else; owner completes atomically',async()=>{
 await assert.rejects(act('price',1,[100,250,175]),/Only the pricing owner/);await actor(1);await act('price',1,[100,250,175]);
 const i=await item();assert.equal(i.pricing_status,'ready');assert.equal(i.cost,'100');assert.equal(i.sale_price,'250');assert.equal(i.minimum_sale_price,'175');assert.equal(i.pricing_completed_by,id(1));assert.equal(i.ebay_sync_enabled,true);
 assert.equal((await queue()).total,0);assert.equal((await queue('mine','priced')).total,1);
 assert.deepEqual((await db.query("select changed_item_ids from metadata where id='inventory'")).rows[0].changed_item_ids,[id(100)]);
});
test('skip is durable, leaves prices blank, and remains available for later pricing',async()=>{
 await actor(1);await act('skip');assert.equal((await queue()).total,0);assert.equal((await queue('mine','skipped')).total,1);assert.equal((await item()).cost,null);
 await act('price',2,[0,10,null]);assert.equal((await item()).sale_price,'10');assert.equal((await queue('mine','skipped')).total,0);
});
test('stale and duplicate submissions cannot overwrite a price or duplicate its audit',async()=>{
 await actor(1);await act('price',1,[10,20,null]);await assert.rejects(act('price',1,[999,1000,null]),/changed or was already priced/);
 assert.equal((await item()).sale_price,'20');assert.equal((await db.query("select count(*)::int n from inventory_pricing_events where action='priced'")).rows[0].n,1);
});
test('rejects missing, nonfinite, negative, fractional cents and minimum above retail',async()=>{
 await actor(1);for(const prices of [[null,10,null],[1,null,null],[-1,10,null],[1,0,null],['NaN',10,null],[1,'Infinity',null],[1,10,11],[1.001,10,null],[1,10.005,null]])await assert.rejects(act('price',1,prices),/Enter a cost/);
 assert.equal((await item()).pricing_status,'pending');
});
test('reassign requires admin; assigned active employee can price without admin privileges',async()=>{
 await actor(1);await act('reassign',1,undefined,id(3));await actor(3);await assert.rejects(act('reassign',2,undefined,id(2)),/Only an administrator/);await act('price',2,[10,20,null]);assert.equal((await item()).pricing_completed_by,id(3));
});
test('inactive owner rejected; missing default fails whole insert with no orphan item',async()=>{
 await actor(1);await assert.rejects(act('reassign',1,undefined,id(4)),/active inventory employee/);
 await db.exec('update inventory_pricing_settings set default_owner=null');await assert.rejects(db.query("insert into item_types(title,pricing_status) values('Blocked','pending')"),/active pricing owner/);
 assert.equal((await db.query('select count(*)::int n from item_types')).rows[0].n,1);
});
test('default changes affect future items only and require administrator',async()=>{
 await assert.rejects(db.query('select set_inventory_pricing_owner($1)',[id(3)]),/Only an administrator/);
 await actor(1);await db.query('select set_inventory_pricing_owner($1)',[id(3)]);await db.query("insert into item_types(title,pricing_status) values('Next','pending')");assert.equal((await item()).pricing_owner,id(1));assert.equal((await queue('all')).items.find(i=>i.title==='Next').pricing_owner,id(3));
});
test('pending prices and publish flags cannot be edited outside workflow; storefront publishing blocked',async()=>{
 await actor(1);await assert.rejects(db.query('update item_types set sale_price=20 where id=$1',[id(100)]),/Use the Pricing queue/);
 await assert.rejects(db.query('update item_types set ebay_sync_enabled=true where id=$1',[id(100)]),/Use the Pricing queue/);
 await assert.rejects(db.query('insert into storefront_listings values($1,true)',[id(100)]),/Finish this item/);
 await db.query('insert into storefront_listings values($1,false)',[id(100)]);await act('price',1,[10,20,null]);await db.exec('update storefront_listings set published=true');
});
test('queue scopes, search and pagination are applied on server before limit',async()=>{
 await actor(1);await db.exec("insert into item_types(title,barcode,pricing_status) select 'Ring '||g,'R-'||g,'pending' from generate_series(1,25) g");
 const data=await queue();assert.equal(data.total,26);assert.equal(data.items.length,20);assert.equal((await queue('all','waiting','',20)).items.length,6);assert.equal((await queue('all','waiting','WATCH-100')).total,1);await actor(2);assert.equal((await queue('mine')).total,0);
});
test('unauthenticated/inactive users cannot read or act; no task or notification writes',async()=>{
 await actor(4);await assert.rejects(queue(),/Inventory access/);await assert.rejects(act('skip'),/Inventory access/);
 const sql=await readFile(new URL('../supabase/migrations/20261010140000_inventory_pricing_queue.sql',import.meta.url),'utf8');assert.doesNotMatch(sql,/insert into (public\.)?(team_tasks|task_notifications|ebay_return_tasks)/i);
});
test('phone money parser rejects ambiguous/invalid amounts and permits intentional zero cost',async()=>{
 const context={window:{}};vm.createContext(context);vm.runInContext(await readFile(new URL('../inventory-pricing-core.js',import.meta.url),'utf8'),context);
 const p=context.window.InventoryPricing;assert.equal(p.prices('0','1,250.00','').cost,0);assert.equal(p.prices('0','1,250.00','').minimum,null);
 for(const value of ['','1e3','1.999','NaN','-3','Infinity','1,5'])assert.throws(()=>p.prices(value,'100',''));
 assert.equal(p.prices('.50','10','').cost,.5);
 assert.throws(()=>p.prices('10','20','21'));
});
