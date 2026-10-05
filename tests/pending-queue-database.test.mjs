import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const migration = name => readFile(new URL(`../supabase/migrations/${name}`, import.meta.url), 'utf8');
let db;
const baseline = new Map();
const cases = [
  ['pending', true, 1000, 0], ['pending', false, 1000, 0],
  ['fulfilled', true, 37, 23], ['all', true, 1000, 100],
  [' PENDING ', true, 7, 3], [null, true, null, null],
  ['pending', true, 0, -1], ['pending', true, 1000, 10000],
  ['all', true, 10000, 0],
];
const queue = async args => (await db.query(
  'select * from public.list_pending_ebay_order_queue_v2($1,$2,$3,$4)', args,
)).rows.map(row => row.list_pending_ebay_order_queue_v2);

before(async () => {
  db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated;
    create function public.can_manage_inventory() returns boolean language sql stable as $$
      select current_setting('test.staff',true) = 'yes' $$;
    create function public.is_admin() returns boolean language sql stable as $$
      select current_setting('test.admin',true) = 'yes' $$;
    set test.staff='yes'; set test.admin='yes';
    create table public.ebay_orders (
      id uuid primary key, order_number text, sales_record_number text, buyer_username text,
      buyer_name text, sale_date timestamptz, paid_on_date timestamptz, imported_at timestamptz,
      ship_by_date timestamptz, payment_method text, shipping_and_handling numeric,
      ebay_collected_tax numeric, total_price numeric, net_payout numeric, status text,
      raw_payload jsonb, label_status text, label_storage_bucket text, label_file_path text,
      label_uploaded_at timestamptz);
    create table public.ebay_order_lines (
      id uuid primary key, order_id uuid not null references public.ebay_orders,
      item_number text, transaction_id text, item_title text, custom_label text,
      quantity integer, sold_for numeric, shipping_and_handling numeric, total_price numeric,
      net_payout numeric, line_status text, created_at timestamptz, internal_item_id uuid,
      fulfilled_quantity integer, fulfilled_at timestamptz, assigned_seller_employee_id uuid,
      assigned_seller_snapshot jsonb, notes text, raw_payload jsonb);
    create table public.ebay_return_cases (
      id uuid primary key, status text, return_reason text, raw_payload jsonb,
      opened_at timestamptz, ebay_return_id text, case_type text);
    create table public.ebay_return_items (return_case_id uuid references public.ebay_return_cases,
      order_line_id uuid references public.ebay_order_lines);
    create table public.pending_order_item_search (
      order_line_id uuid primary key references public.ebay_order_lines,
      is_missing boolean, updated_at timestamptz, updated_by uuid, updated_by_email text);
    insert into public.ebay_orders
      select md5(n::text)::uuid,'order-'||n,'sale-'||n,'buyer-'||(n%20),'Buyer',
        now(),now(),now(),now()+interval '2 days','CARD',5,2,25,18,'pending',
        jsonb_build_object('orderPaymentStatus','PAID','orderFulfillmentStatus','NOT_STARTED',
          'ebayFinance',jsonb_build_object('memo','preserve this'),'first_row',jsonb_build_object('Sale Date','Oct-01-26')),
        'ready','labels','saved.pdf',now()
      from generate_series(1,2200) n;
    insert into public.ebay_order_lines
      select md5(('line-'||n))::uuid,md5(n::text)::uuid,'item-'||n,'txn-'||n,'Jewelry','SKU-'||n,
        2,20,5,25,18,
        case when n<=138 then case when n%3=0 then 'partially_fulfilled' else 'pending' end
          when n<=2150 then 'fulfilled' else 'cancelled' end,
        '2026-10-01'::timestamptz + ((n/3)||' seconds')::interval,null,
        case when n%3=0 then 1 else 0 end,null,null,null,'saved note',
        jsonb_build_object('orderPaymentStatus','PAID','ebayFinance',jsonb_build_object('memo','line memo'))
      from generate_series(1,2200) n;
    insert into public.pending_order_item_search
      select id,true,now(),null,'worker@example.test' from public.ebay_order_lines
      where item_number='item-1';
    insert into public.ebay_return_cases values
      (md5('return-old')::uuid,'open','Wrong item','{"returnStatus":"OPEN"}',
        '2026-09-01','old','return'),
      (md5('return-new')::uuid,'needs_review','Dispute','{"returnStatus":"ESCALATED","detailsUrl":"https://example.test/case"}',
        '2026-10-01','new','return'),
      (md5('return-closed')::uuid,'closed','Closed','{}','2026-10-02','closed','return');
    insert into public.ebay_return_items
      select c.id,l.id from public.ebay_return_cases c cross join public.ebay_order_lines l
      where l.item_number='item-1';
  `);
  await db.exec(await migration('20260703133000_pending_order_line_only_post_order_issue_badges.sql'));
  const previousV2 = await migration('20261004031000_pending_item_search.sql');
  await db.exec(previousV2.slice(previousV2.indexOf('create or replace function public.list_pending_ebay_order_queue_v2(')));
  // The replacement must preserve the existing API grants as well as row contents.
  await db.exec('revoke all on function public.list_pending_ebay_order_queue_v2(text,boolean,integer,integer) from public,anon; grant execute on function public.list_pending_ebay_order_queue_v2(text,boolean,integer,integer) to authenticated');
  for (const args of cases) baseline.set(JSON.stringify(args), await queue(args));
  await db.exec(await migration('20261005153000_single_pass_pending_order_queue.sql'));
});
after(async () => { await db?.close(); });

test('single-pass queue preserves every legacy field, status filter, and page boundary', async () => {
  const byId = rows => [...rows].sort((a,b) => a.id.localeCompare(b.id));
  for (const args of cases) {
    const actual = await queue(args);
    assert.deepEqual(byId(actual), byId(baseline.get(JSON.stringify(args))), JSON.stringify(args));
    assert.deepEqual(actual, [...actual].sort((a,b) =>
      b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id)), 'stable newest-first pages');
  }
  assert.equal((await queue(['all',true,10000,0])).length,2000,'preserve the server page cap');
});

test('queue keeps line-scoped issue badges, raw metadata, and missing-item status', async () => {
  const rows = await queue(['pending',true,1000,0]);
  const row = rows.find(r => r.item_number==='item-1');
  assert.equal(row.post_order_issue_count,2);
  assert.equal(row.post_order_issue_type,'dispute');
  assert.equal(row.post_order_issue_payload.ebayReturnId,'new');
  assert.equal(row.post_order_issue_scope,'line');
  assert.equal(row.item_search.is_missing,true);
  assert.equal(row.line_raw_payload.ebayFinance.memo,'line memo');
  assert.equal(row.order_raw_payload.ebayFinance.memo,'preserve this');
  assert.equal(rows.find(r => r.item_number==='item-2').post_order_issue_count,0);
});

test('staff authorization and admin-only columns remain enforced', async () => {
  await db.exec("set test.admin='no'");
  const rows = await queue(['pending',true,1000,0]);
  for (const row of rows) {
    for (const key of ['net_payout','payment_method','order_shipping_and_handling','ebay_collected_tax','order_net_payout']) {
      assert.equal(row[key],null,key);
    }
    assert.equal(row.sold_for,20,'staff still see sold prices');
  }
  await db.exec("set test.staff='no'");
  await assert.rejects(queue(['pending',true,1000,0]), /Not allowed/);
  const grants = (await db.query(`select
    has_function_privilege('anon','public.list_pending_ebay_order_queue_v2(text,boolean,integer,integer)','execute') as anon,
    has_function_privilege('authenticated','public.list_pending_ebay_order_queue_v2(text,boolean,integer,integer)','execute') as staff`)).rows[0];
  assert.deepEqual(grants,{anon:false,staff:true});
});
