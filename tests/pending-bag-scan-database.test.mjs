import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

test('bag locator is read-only, exact, permission checked, and respects physical line status', async () => {
  const db = new PGlite();
  const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
  const lookup = async code => (await db.query('select find_pending_order_bag($1) as result', [code])).rows[0].result;
  try {
    await db.exec(`create role authenticated; create role anon; create schema auth;
      create function auth.uid() returns uuid language sql stable as $$ select '11111111-1111-1111-1111-111111111111'::uuid $$;
      create function can_manage_inventory() returns boolean language sql stable as $$ select current_setting('test.staff', true) = 'yes' $$;
      create table live_sale_lots(id uuid, lot_code text, auction_number text, matched_order_line_id uuid);
      create table live_bag_order_links(lot_id uuid, order_line_id uuid);
      create table ebay_live_attempts(lot_id uuid, order_line_id uuid, listing_id text, buyer text, listing_title text, amount numeric);
      create table ebay_orders(id uuid, order_number text, buyer_username text, buyer_name text, sale_date timestamptz, paid_on_date timestamptz, ship_by_date timestamptz, status text);
      create table ebay_order_lines(id uuid, order_id uuid, item_number text, item_title text, custom_label text, quantity int, fulfilled_quantity int, line_status text, sold_for numeric, total_price numeric, created_at timestamptz);
      create table pending_order_item_search(order_line_id uuid, is_missing boolean);
    `);
    for (let i = 1; i <= 6; i++) {
      await db.query('insert into ebay_orders values ($1,$2,$3,$3,now(),now(),now(),$4)', [id(i),`order-${i}`,i === 6 ? 'buyer1' : `buyer${i}`,i === 1 ? 'fulfilled' : 'pending']);
      await db.query('insert into ebay_order_lines values ($1,$2,$3,$4,$5,1,$6,$7,100,100,now())',
        [id(i+10),id(i),`listing-${i}`,i === 6 ? '#006 - Another item for buyer1' : `#00${i < 3 ? 5 : i} - Gold chain`, '', i === 4 ? 1 : 0,i === 3 ? 'cancelled' : i === 4 ? 'fulfilled' : 'pending']);
    }
    await db.query('insert into live_sale_lots values ($1,$2,$3,null),($4,$5,$6,$7)',[id(100),'LIVE-EXACT','EB-005',id(101),'LIVE-CLOSED','004',id(14)]);
    await db.query('insert into ebay_live_attempts values ($1,null,$2,$3,$4,100)',[id(100),'listing-1','buyer1','#005 - Gold chain']);
    await db.query('insert into pending_order_item_search values ($1,false)',[id(11)]);
    await db.exec(await readFile(new URL('../supabase/migrations/20261007002000_pending_bag_scan.sql',import.meta.url),'utf8'));
    await db.exec("set test.staff='no'");
    await assert.rejects(lookup('005'),error=>error.code==='42501');
    await db.exec("set test.staff='yes'");
    const exact = await lookup('live-exact');
    assert.deepEqual(exact.matches.map(m=>m.line.id),[id(11)]);
    assert.equal(exact.matches[0].line.order.status,'fulfilled'); // unfinished physical work still locatable
    assert.equal(exact.matches[0].line.item_search.is_missing,false);
    for (const scan of ['005','#005','5']) {
      const result = await lookup(scan);
      assert.equal(result.matches.length,3); // repeat reference across three pending orders
      assert.ok(result.matches.every(m=>m.line.line_status==='pending'));
    }
    assert.equal((await lookup('003')).matches.length,0);
    const closed = await lookup('LIVE-CLOSED');
    assert.equal(closed.matches.length,0); assert.equal(closed.linked_closed,true);
    assert.equal((await lookup('LIVE-UNKNOWN')).matches.length,0);
    await db.query('insert into live_sale_lots values ($1,$2,$3,$4)',[id(102),'LIVE-LEGACY','0007',id(11)]);
    for (const code of ['7','#007','0007']) assert.deepEqual((await lookup(code)).matches.map(m=>m.line.id),[id(11)]);
    await db.query('insert into live_bag_order_links values ($1,$2)',[id(100),id(12)]);
    assert.deepEqual((await lookup('LIVE-EXACT')).matches.map(m=>m.line.id),[id(12)]); // explicit link wins
    await assert.rejects(lookup(''),error=>error.code==='22023');
    await assert.rejects(lookup('x'.repeat(121)),error=>error.code==='22023');
    const permissions = (await db.query("select provolatile,has_function_privilege('anon','find_pending_order_bag(text)','execute') as anon from pg_proc where proname='find_pending_order_bag'")).rows[0];
    assert.equal(permissions.provolatile,'s'); assert.equal(permissions.anon,false);
    assert.equal((await db.query('select count(*)::int as n from ebay_order_lines')).rows[0].n,6);
    assert.equal((await db.query('select count(*)::int as n from pending_order_item_search')).rows[0].n,1);
  } finally { await db.close(); }
});
