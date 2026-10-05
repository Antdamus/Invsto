import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {after, before, test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261005180000_order_history_read_performance.sql', import.meta.url), 'utf8');
const tables = ['ebay_orders','ebay_order_lines','ebay_order_admin_events',
  'ebay_order_revert_events','ebay_order_label_events','ebay_order_tasks',
  'ebay_order_task_events','ebay_return_cases','ebay_return_items','ebay_return_events'];
let db, policiesBefore;
const baseline = new Map();
const actors = [
  ['admin','yes','yes','yes'], ['staff','yes','no','no'],
  ['returns','no','no','yes'], ['denied','no','no','no'],
];
async function asActor([name, staff, admin, returns]) {
  await db.exec(`reset role; set test.staff='${staff}'; set test.admin='${admin}'; set test.returns='${returns}'; set test.actor='${name}'; set role authenticated;`);
}
async function visibleRows() {
  const result = {};
  for (const table of tables) result[table] = (await db.query(`select count(*)::int as count, md5(string_agg(id::text,',' order by id)) as ids from public.${table}`)).rows;
  return result;
}
const policies = async () => (await db.query(`select tablename,policyname,cmd,roles,permissive,qual,with_check from pg_policies where schemaname='public' order by tablename,policyname`)).rows;
before(async () => {
  db = new PGlite();
  await db.exec(`create role authenticated;
    create function can_manage_inventory() returns boolean language sql stable security definer as $$select current_setting('test.staff',true)='yes'$$;
    create function is_admin() returns boolean language sql stable as $$select current_setting('test.admin',true)='yes'$$;
    create function can_access_post_order_issues() returns boolean language sql stable security definer as $$select current_setting('test.returns',true)='yes'$$;`);
  for (const table of tables) {
    const access = table === 'ebay_order_revert_events' ? 'is_admin()'
      : table.startsWith('ebay_return_') ? 'can_access_post_order_issues()' : 'can_manage_inventory()';
    await db.exec(`create table public.${table} (id int primary key, owner text, created_at timestamptz, order_line_ids int[], fulfilled_at timestamptz, line_status text, payload text);
      insert into public.${table} select n,'staff',now(),array[n],
        case when n<=166 then '2026-10-05'::timestamptz else '2026-09-01'::timestamptz end,
        case when n%4=0 then 'cancelled' when n%4=1 then 'skipped' else 'fulfilled' end,repeat('x',1000)
        from generate_series(1,${table==='ebay_order_lines'?16000:20}) n;
      alter table public.${table} enable row level security;
      grant select,insert,update,delete on public.${table} to authenticated;
      create policy staff_select on public.${table} for select to authenticated using (${access});
      create policy staff_insert on public.${table} for insert to authenticated with check (${access});`);
  }
  await db.exec(`
    create policy admin_write on public.ebay_orders for all to authenticated using (is_admin()) with check (is_admin());
    create policy admin_write on public.ebay_order_lines for all to authenticated using (is_admin()) with check (is_admin());
    create policy post_order_select on public.ebay_order_label_events for select to authenticated using (can_manage_inventory() or can_access_post_order_issues());
    create policy own_return on public.ebay_return_cases for select to authenticated using (owner=current_setting('test.actor',true));
    create policy own_task_update on public.ebay_order_tasks for update to authenticated using (is_admin() or owner=current_setting('test.actor',true)) with check (is_admin() or owner=current_setting('test.actor',true));
    create index ebay_order_lines_closed_history_idx on public.ebay_order_lines(fulfilled_at desc,line_status) where fulfilled_at is not null and line_status in ('fulfilled','cancelled','skipped');
    analyze public.ebay_order_lines;
  `);
  policiesBefore = await policies();
  for (const actor of actors) {
    await asActor(actor);
    baseline.set(actor[0], await visibleRows());
  }
  await db.exec('reset role');
  await db.exec(migration);
});
after(async () => { await db?.close(); });

test('history read optimization preserves admin, staff, returns and denied access', async () => {
  for (const actor of actors) {
    await asActor(actor);
    assert.deepEqual(await visibleRows(), baseline.get(actor[0]), actor[0]);
  }
});

test('policy roles, commands, write checks and row-dependent conditions stay unchanged', async () => {
  await db.exec('reset role');
  const afterPolicies = await policies();
  assert.equal(afterPolicies.length,policiesBefore.length);
  for (let i=0;i<afterPolicies.length;i++) {
    const {qual:beforeQual,...beforePolicy}=policiesBefore[i];
    const {qual:afterQual,...afterPolicy}=afterPolicies[i];
    assert.deepEqual(afterPolicy,beforePolicy);
    if (!['SELECT','ALL'].includes(beforePolicy.cmd) || beforeQual.includes('owner')) {
      assert.equal(afterQual,beforeQual);
    }
  }
  await asActor(actors[3]);
  await assert.rejects(db.exec("insert into ebay_order_admin_events(id) values(999)"),/row-level security/);
  await asActor(actors[1]);
  assert.equal((await db.query("update ebay_order_lines set owner='changed' where id=1 returning id")).rows.length,0);
  assert.equal((await db.query("update ebay_order_tasks set payload='updated' where id=1 returning id")).rows.length,1);
});

test('parameterized date requests use the history index even with a generic plan', async () => {
  await asActor(actors[1]);
  await db.exec(`set plan_cache_mode=force_generic_plan;
    prepare history_page(text[],timestamptz,timestamptz,int) as
      select * from ebay_order_lines where line_status=any($1) and fulfilled_at >= $2 and fulfilled_at <= $3
      order by fulfilled_at desc limit $4;`);
  const [row] = (await db.query(`explain(analyze,format json) execute history_page(array['fulfilled','cancelled','skipped'],'2026-10-05','2026-10-06',500)`)).rows;
  const plan = row['QUERY PLAN'][0].Plan;
  const nodes = [];
  function visit(node) {nodes.push(node); (node.Plans||[]).forEach(visit);}
  visit(plan);
  assert.equal(plan['Actual Rows'],166);
  assert.ok(nodes.some(n=>n['Index Name']==='ebay_order_lines_history_date_idx'));
  assert.ok(!nodes.some(n=>n['Node Type']==='Seq Scan'&&n['Relation Name']==='ebay_order_lines'));
  assert.ok(nodes.some(n=>n['Parent Relationship']==='InitPlan'&&n['Actual Loops']===1));
  await db.exec('deallocate history_page; reset role');
});

test('migration can be replayed without rewriting policies or duplicating indexes', async () => {
  await db.exec('reset role');
  const beforeReplay = await policies();
  await db.exec(migration);
  assert.deepEqual(await policies(),beforeReplay);
});
