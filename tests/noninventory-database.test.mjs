import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test, before, after} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

let db;
const migration = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
before(async () => {
  db = new PGlite();
  // A real PostgreSQL runtime with only the tables this RPC/trigger touches.
  // Record reconciliation calls instead of invoking an unrelated entire show.
  await db.exec(`
    create role anon; create role authenticated; create schema auth;
    create function auth.uid() returns uuid language sql as $$
      select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid;
    $$;
    create function public.can_manage_inventory() returns boolean language sql as $$select auth.uid() is not null$$;
    create table public.store_locations(id uuid primary key, name text);
    create table public.ebay_orders(id uuid primary key default gen_random_uuid(), order_number text,
      buyer_username text, status text default 'pending', raw_payload jsonb default '{}', updated_at timestamptz);
    create table public.ebay_order_lines(id uuid primary key default gen_random_uuid(), order_id uuid references public.ebay_orders,
      item_number text, item_title text, custom_label text, quantity integer default 1,
      fulfilled_quantity integer default 0, line_status text default 'pending', fulfilled_by uuid,
      fulfilled_by_email text, fulfilled_at timestamptz, internal_item_id uuid, stock_location_row_id uuid,
      location_id uuid, sale_id uuid, sale_item_id uuid, stock_transaction_id uuid, notes text,
      updated_at timestamptz, raw_payload jsonb default '{}', sold_for numeric default 20);
    create table public.ebay_live_attempts(event_id text, listing_id text, buyer text);
    create table public.ebay_order_admin_events(action text,order_ids uuid[],order_line_ids uuid[],notes text,
      signed_by uuid,signed_by_email text,checkout_store_id uuid,gps_latitude numeric,gps_longitude numeric,
      gps_accuracy_meters numeric,gps_captured_at timestamptz,gps_status text,payload jsonb);
    create table public.reconciliation_calls(event_id text);
    create function public.reconcile_ebay_live_orders_internal(_event_id text) returns void language sql as $$
      insert into public.reconciliation_calls values (_event_id);
    $$;
    select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
  `);
  const original = await migration('20260928120000_ebay_live_payment_queue.sql');
  await db.exec(original.slice(original.indexOf('create function public.ebay_live_order_changed()'),
    original.indexOf('revoke all on function public.reconcile_ebay_live_orders_internal')));
  const complete = await migration('20260517134000_no_inventory_order_evidence_repository.sql');
  await db.exec(complete.slice(complete.indexOf('create or replace function public.complete_ebay_order_lines_without_inventory_evidence(')));
  await db.exec(`
    insert into public.ebay_orders(order_number,buyer_username)
      select n::text,'buyer' from generate_series(1,81) n;
    insert into public.ebay_order_lines(order_id,item_number,item_title)
      select o.id,'item-'||o.order_number||'-'||n,'Fixture item'
      from public.ebay_orders o cross join lateral generate_series(1,case when o.order_number='1' then 25 else 1 end) n;
    insert into public.ebay_live_attempts select 'event',item_number,'buyer' from public.ebay_order_lines;
  `);
});
after(async () => { await db?.close(); });

const scalar = async sql => (await db.query(sql)).rows[0].value;
const countCalls = () => scalar('select count(*)::int as value from public.reconciliation_calls');
const closeBuyer = () => db.query(`select * from public.complete_ebay_order_lines_without_inventory_evidence(
  (select array_agg(id order by id) from public.ebay_order_lines),
  _signed_by_email => 'worker@example.test', _evidence_photos => '[{"path":"saved-photo.png"}]'::jsonb)`);

test('105-line noninventory checkout avoids 186 full-event reconciliations and preserves its atomic audit', async () => {
  await db.exec('begin');
  assert.deepEqual((await closeBuyer()).rows, [{updated_lines:105,updated_orders:81}]);
  assert.equal(await countCalls(),186,'reproduce the old per-line and per-order work');
  await db.exec('rollback');
  await db.exec(await migration('20261005121000_skip_live_reconciliation_for_fulfillment.sql'));
  await db.exec('begin');
  assert.deepEqual((await closeBuyer()).rows, [{updated_lines:105,updated_orders:81}]);
  assert.equal(await countCalls(),0,'fulfillment no longer starts payment reconciliation');
  assert.equal(await scalar("select count(*)::int as value from public.ebay_order_lines where line_status='fulfilled' and fulfilled_quantity=quantity"),105);
  assert.equal(await scalar("select count(*)::int as value from public.ebay_orders where status='fulfilled'"),81);
  assert.equal(await scalar('select count(*)::int as value from public.ebay_order_admin_events'),1);
  assert.equal(await scalar("select jsonb_array_length(payload->'line_snapshots') as value from public.ebay_order_admin_events"),105);
  assert.equal(await scalar("select payload#>>'{evidence_photos,0,path}' as value from public.ebay_order_admin_events"),'saved-photo.png');
  await db.exec('rollback');
});

test('failed bulk closeout rolls back earlier items instead of partially closing the buyer', async () => {
  await db.exec('begin');
  const ids = (await db.query('select id from public.ebay_order_lines order by id')).rows.map(r => r.id);
  await db.query("update public.ebay_order_lines set line_status='fulfilled',fulfilled_quantity=quantity where id=$1",[ids.at(-1)]);
  await db.exec('savepoint completion');
  await assert.rejects(closeBuyer, /Only untouched pending/);
  await db.exec('rollback to completion');
  assert.equal(await scalar("select count(*)::int as value from public.ebay_order_lines where line_status='pending'"),104);
  assert.equal(await scalar('select count(*)::int as value from public.ebay_order_admin_events'),0);
  await db.exec('rollback');
});

test('payment evidence, refund, amount, cancellation and reopening changes still reconcile', async () => {
  await db.exec('begin');
  const ord = "(select id from public.ebay_orders where order_number='2')";
  const line = `(select id from public.ebay_order_lines where order_id=${ord})`;
  for (const sql of [
    `update public.ebay_orders set raw_payload='{"orderPaymentStatus":"PAID"}' where id=${ord}`,
    `update public.ebay_orders set raw_payload='{"orderPaymentStatus":"PARTIALLY_REFUNDED"}' where id=${ord}`,
    `update public.ebay_orders set status='cancelled' where id=${ord}`,
    `update public.ebay_orders set status='pending' where id=${ord}`,
    `update public.ebay_order_lines set line_status='cancelled' where id=${line}`,
    `update public.ebay_order_lines set line_status='pending' where id=${line}`,
    `update public.ebay_order_lines set sold_for=21 where id=${line}`,
    `update public.ebay_order_lines set raw_payload='{"orderPaymentStatus":"FULLY_REFUNDED"}' where id=${line}`,
    `insert into public.ebay_order_lines(order_id,item_number) select order_id,item_number from public.ebay_order_lines where id=${line}`,
  ]) {
    const before = await countCalls();
    await db.exec(sql);
    assert.equal(await countCalls(),before+1,sql);
  }
  const before = await countCalls();
  await db.exec(`update public.ebay_orders set status='partially_fulfilled',raw_payload=raw_payload where id=${ord}`);
  await db.exec(`update public.ebay_order_lines set line_status='partially_fulfilled',raw_payload=raw_payload,sold_for=sold_for where order_id=${ord}`);
  assert.equal(await countCalls(),before,'unchanged payment data does not recheck the show');
  await db.exec('rollback');
});
