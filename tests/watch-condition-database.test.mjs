import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { before, after, test } from 'node:test';
import { PGlite } from '@electric-sql/pglite';

const read = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');
const worker = '00000000-0000-4000-8000-000000000002';
const owner = '00000000-0000-4000-8000-000000000001';
let db;
let migration;
before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql as $$select '${worker}'::uuid$$;
    create table employees(user_id uuid primary key, display_name text, email text, role text, active boolean);
    create function can_manage_inventory() returns boolean language sql as $$
      select exists(select 1 from employees where user_id=auth.uid() and active and role in ('admin','manager','employee'))$$;
    create function is_admin() returns boolean language sql as $$
      select exists(select 1 from employees where user_id=auth.uid() and active and role='admin')$$;
    insert into employees values ('${owner}','Otello Guillen','owner@example.test','admin',true),
      ('${worker}','Inventory worker','worker@example.test','employee',true);
    create table item_types(id uuid primary key default gen_random_uuid(), title text, description text,
      cost numeric, sale_price numeric, minimum_sale_price numeric, price_per_weight numeric,
      ebay_sync_enabled boolean default true, ebay_condition text, ebay_category_id text,
      ebay_aspects jsonb default '{}', watch_details jsonb, coin_details jsonb, categories text[],
      stone_type text, item_length text, metal text, purity_basis_points numeric, weight numeric,
      deleted_at timestamptz, barcode text unique, added_by uuid, created_at timestamptz default now(), photos text[]);
    create table locations(id uuid primary key,location_name text);
    create table item_stock_locations(item_id uuid,location_id uuid,quantity int);
    create table storefront_listings(item_type_id uuid,published boolean);
    create table metadata(id text,inventory_version text,changed_item_ids text[]);
  `);
  const old = await read('supabase/migrations/20260523123000_ebay_item_metadata_backfill.sql');
  await db.exec(old.match(/do \$\$[\s\S]*?\$\$;/i)[0]);
  const metadata = await read('supabase/migrations/20260926163000_coin_ebay_listing.sql');
  await db.exec(metadata.slice(metadata.indexOf('create or replace function public.fill_item_type_ebay_metadata()')));
  await db.exec(`create trigger item_types_fill_ebay_metadata before insert or update on item_types
    for each row execute function fill_item_type_ebay_metadata();`);
  await db.exec(await read('supabase/migrations/20261010140000_inventory_pricing_queue.sql'));
  migration = await read('supabase/migrations/20261011220000_watch_condition_validation.sql');
});
after(() => db?.close());

const saveWatch = condition => db.query(`insert into item_types(title,watch_details,pricing_status,ebay_sync_enabled,added_by,photos)
  values ('Watch',jsonb_build_object('brand','Cartier','condition',$1::text),'pending',false,$2,array['original.jpg']) returning *`, [condition, worker]);

test('reproduces the reported failure, then accepts excellent and fair without changing their meaning', async () => {
  for (const condition of ['PRE_OWNED_EXCELLENT', 'PRE_OWNED_FAIR']) {
    await assert.rejects(saveWatch(condition), error => error.code === '23514' && error.constraint === 'item_types_ebay_condition_check');
  }
  assert.equal((await db.query('select count(*)::int n from item_types')).rows[0].n, 0);
  assert.equal((await db.query('select count(*)::int n from inventory_pricing_events')).rows[0].n, 0);
  await db.exec(migration);
  for (const condition of ['PRE_OWNED_EXCELLENT', 'PRE_OWNED_FAIR']) {
    const { rows: [item] } = await saveWatch(condition);
    assert.equal(item.ebay_condition, condition);
    assert.equal(item.watch_details.condition, condition);
    assert.equal(item.ebay_category_id, '31387');
    assert.equal(item.pricing_owner, owner);
    assert.equal(item.pricing_status, 'pending');
    assert.equal(item.cost, null);
    assert.equal(item.sale_price, null);
    assert.equal(item.ebay_sync_enabled, false);
    assert.equal(item.pricing_resume_ebay, false);
    assert.deepEqual(item.photos, ['original.jpg']);
    const { rows: [event] } = await db.query('select * from inventory_pricing_events where item_id=$1', [item.id]);
    assert.equal(event.actor, worker);
    assert.equal(event.action, 'queued');
  }
});

test('every watch choice in Add Item saves; absent condition stays absent', async () => {
  const html = await read('add-item.html');
  const select = html.match(/<select id="watch-condition"[\s\S]*?<\/select>/)[0];
  const choices = [...select.matchAll(/value="([^"]*)"/g)].map(match => match[1]);
  assert.ok(choices.length > 1);
  for (const condition of choices) {
    const { rows: [item] } = await saveWatch(condition);
    assert.equal(item.ebay_condition, condition || null);
  }
});

test('existing jewelry and coin conditions still save, and unsupported conditions remain rejected', async () => {
  for (const condition of ['NEW','LIKE_NEW','NEW_OTHER','NEW_WITH_DEFECTS','MANUFACTURER_REFURBISHED',
    'CERTIFIED_REFURBISHED','EXCELLENT_REFURBISHED','VERY_GOOD_REFURBISHED','GOOD_REFURBISHED',
    'SELLER_REFURBISHED','USED_EXCELLENT','USED_VERY_GOOD','USED_GOOD','USED_ACCEPTABLE','FOR_PARTS_OR_NOT_WORKING']) {
    await db.query('insert into item_types(title,ebay_condition) values ($1,$2)', ['Jewelry', condition]);
  }
  for (const condition of ['EXCELLENT','DAMAGED','pre_owned_fair']) {
    await assert.rejects(saveWatch(condition), error => error.code === '23514');
  }
});

test('updating a watch to fair preserves the new condition; migration can be reapplied', async () => {
  await db.exec(migration);
  const { rows: [item] } = await saveWatch('USED_EXCELLENT');
  await db.query(`update item_types set watch_details=jsonb_set(watch_details,'{condition}','"PRE_OWNED_FAIR"') where id=$1`, [item.id]);
  assert.equal((await db.query('select ebay_condition from item_types where id=$1', [item.id])).rows[0].ebay_condition, 'PRE_OWNED_FAIR');
});
