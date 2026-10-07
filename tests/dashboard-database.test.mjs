import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

test('buyer snapshot respects admin access, purchase windows, cancellations and unknown payouts', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role authenticated;
      create function public.is_admin() returns boolean language sql stable as $$ select current_setting('test.admin', true) = 'yes' $$;
      create table ebay_orders (id int,buyer_username text,status text,sale_date timestamptz,paid_on_date timestamptz,imported_at timestamptz,total_price numeric,net_payout numeric);
      create table ebay_return_cases (buyer_username text,status text);
      insert into ebay_orders values
        (1,' Buyer A ','fulfilled',now(),null,null,100,80),
        (2,'buyer a','pending',now(),null,null,150,null),
        (3,'buyer a','cancelled',now(),null,null,99999,99999),
        (4,'old buyer','fulfilled',now()-interval '91 days',null,null,50000,40000),
        (5,'buyer b','fulfilled',null,now(),null,200,150),
        (6,'unknown payout','pending',null,null,now(),100,null),
        (7,'   ','pending',now(),null,null,90000,80000),
        (8,'archived','archived',now(),null,null,90000,80000);
      insert into ebay_return_cases values ('buyer a','open'),('BUYER A','closed'),(' Buyer A ','cancelled');
    `);
    await db.exec(await readFile(new URL('../supabase/migrations/20261007001000_dashboard_buyer_snapshot.sql',import.meta.url),'utf8'));
    await db.exec("set test.admin = 'no'");
    await assert.rejects(db.query('select * from get_dashboard_buyer_snapshot()'),error=>error.code==='42501');
    await db.exec("set test.admin = 'yes'");
    const {rows} = await db.query('select * from get_dashboard_buyer_snapshot()');
    assert.equal(rows.length,3);
    assert.equal(rows[0].buyer_username,'buyer a');
    assert.equal(Number(rows[0].gross_sales),250);
    assert.equal(Number(rows[0].order_count),2);
    assert.equal(Number(rows[0].net_payout),80);
    assert.equal(Number(rows[0].payout_missing_count),1);
    assert.equal(Number(rows[0].open_return_count),1);
    assert.equal(rows[2].net_payout,null);
    assert.equal((await db.query('select * from get_dashboard_buyer_snapshot(90,1)')).rows.length,1);
    const {rows:[permissions]} = await db.query("select prosecdef,provolatile,has_function_privilege('authenticated','get_dashboard_buyer_snapshot(integer,integer)','execute') as allowed from pg_proc where proname='get_dashboard_buyer_snapshot'");
    assert.equal(permissions.prosecdef,false); assert.equal(permissions.provolatile,'s'); assert.equal(permissions.allowed,true);
    assert.equal(Number((await db.query('select count(*) from ebay_orders')).rows[0].count),8);
  } finally {await db.close();}
});
