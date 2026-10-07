import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

let server, browser, browserServer, origin;
const root = new URL('../', import.meta.url);
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) return res.writeHead(404).end();
    try {
      let body = await readFile(new URL(name, root));
      if (name.endsWith('.html')) body = body.toString().replace(/<script\b[\s\S]*?<\/script>/gi, '');
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.INVSTO_ITEM_BROWSER === 'webkit' ? webkit : chromium;
  browserServer = await engine.launchServer(); browser = await engine.connect(browserServer.wsEndpoint());
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => {
  const timer = setTimeout(() => browserServer?.kill().catch(() => {}), 5000);
  try {await browser?.close(); await browserServer?.close();} finally {clearTimeout(timer);}
  await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
});

async function open(t, width = 390, {ready = true} = {}) {
  const context = await browser.newContext({viewport: {width, height: 900}, hasTouch: width < 800, timezoneId: 'America/New_York'});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/dashboard.html`);
  await page.addScriptTag({url: `${origin}/task-workflow.js`});
  await page.addScriptTag({url: `${origin}/dashboard.js`});
  await page.evaluate(() => {
    const date = delta => {const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() + delta); return d.toISOString();};
    const task = (id, status, priority = 'normal') => ({id, title: id === 't-0' ? 'Confirm the watch certificate before shipping' : `Review task ${id}`, description: 'Check the certificate matches the serial number.', latest_note: 'The certificate is still missing. Sandra has the watch ready. Waiting for the matching card before this can ship.', assigned_to_user_id: 'me', assigned_to_email: 'alex@example.test', assigned_by: 'me', status, priority, due_at: date(-1), created_at: date(-3), metadata: {}, task_type: 'shipping'});
    const line = (id, orderId, delta, quantity = 1, fulfilled = 0) => ({id, order_id: orderId, item_title: '#006 — Gold bracelet with natural diamonds', quantity, fulfilled_quantity: fulfilled, line_status: 'pending', notes: 'Waiting for the matching certificate before packing.', ebay_orders: {id: orderId, order_number: `12-12345-${orderId.padStart(5, '0')}`, buyer_username: orderId === '2' ? 'alex_collects' : `buyer_${orderId}`, ship_by_date: delta == null ? null : date(delta), status: orderId === '2' ? 'fulfilled' : 'pending'}});
    window.fixtures = {
      employees: [{user_id: 'me', role: 'admin', active: true, display_name: 'Alex Rivers'}],
      ebay_order_lines: [line('l1','1',-4,3,1),line('l2','1',-4,2),line('l3','2',0),line('l4','3',1),line('l5','4',null),line('l6','5',3),line('l7','6',-2),line('l8','7',-1),line('l9','8',-1),{...line('lx','9',-2),line_status:'cancelled'},line('ly','10',-2,1,1)],
      team_tasks: [task('t-0','in_progress','urgent'),task('t-1','completed_by_employee'),task('t-2','blocked'),task('t-3','waiting_on_admin'),task('t-4','pending_admin_review'),task('t-5','in_progress'),task('t-6','in_progress'),{...task('hidden','assigned'),metadata:{hidden_from_task_board:true}},{...task('removed','assigned'),metadata:{history_removed_at:date(0)}},task('closed','closed')],
      ebay_order_tasks: [{...task('o-1','ready_for_admin_approval'),ebay_orders:{buyer_username:'alex_collects',ship_by_date:date(-3)}},{...task('o-parent','assigned_for_shipping'),task_type:'coordination'}],
      ebay_return_tasks: [],
      store_transfers: [{id:'s1',status:'exception',receiver_user_id:'me'}],
      locations: [{id:'tr1',is_tray:true,tray_status:'weight_mismatch'}],
      ebay_return_cases: [{id:'r1',status:'open'},{id:'r2',status:'closed'}],
      item_types: [{id:'i1',categories:['Chains','Gold'],cost:50,sale_price:150,deleted_at:null},{id:'i2',categories:['testcard'],cost:100,sale_price:1000,deleted_at:null},{id:'i3',categories:['Rings'],cost:30,sale_price:90,deleted_at:'2026-01-01'}],
      item_stock_locations: [{id:'s1',item_id:'i1',quantity:2},{id:'s2',item_id:'i1',quantity:3},{id:'s3',item_id:'i2',quantity:10},{id:'s4',item_id:'i3',quantity:4}],
      get_dashboard_buyer_snapshot: [{buyer_username:'collector',gross_sales:23000,net_payout:20000,order_count:10,open_return_count:1}],
      list_team_task_assignees: [{user_id:'me',role:'admin',display_name:'Alex Rivers',email:'alex@example.test'},{user_id:'colleague',role:'employee',display_name:'Sandra',email:'sandra@example.test'}],
    };
    window.reads = []; window.failures = []; window.waiters = {};
    window.supabase = {
      auth: {getSession: async () => ({data:{session:{user:{id:'me',email:'alex@example.test'}}}})},
      from: table => query(table), rpc: (name,args) => query(name,args),
    };
    function query(table, args) {
      const spec = {table,args,filters:[],offset:0,end:Infinity,columns:'',scope:''};
      const q = {
        select: (columns,options) => {spec.columns=columns;spec.options=options;return q;},
        eq: (key,value) => {spec.filters.push(row=>row[key]===value);return q;},
        is: (key,value) => {spec.filters.push(row=>row[key]===value);return q;},
        gt: (key,value) => {spec.filters.push(row=>row[key]>value);return q;},
        in: (key,value) => {spec.filters.push(row=>value.includes(row[key]));return q;},
        not: (key,op,value) => {spec.filters.push(row=>!value.slice(1,-1).split(',').includes(row[key]));return q;},
        or: scope => {spec.scope=scope;return q;},
        order: () => q,
        range: (offset,end) => {spec.offset=offset;spec.end=end;return q;},
        maybeSingle: () => {spec.single=true;return q;}, abortSignal: () => q,
        then: (resolve,reject) => Promise.resolve().then(async () => {
          reads.push({...spec,filters:undefined});
          if (waiters[table]) await waiters[table];
          if (failures.includes(table)) return {data:null,error:{message:'Simulated connection failure'}};
          const rows = (fixtures[table] || []).filter(row=>spec.filters.every(filter=>filter(row)));
          return {data:spec.options?.head ? null : spec.single ? rows[0] : rows.slice(spec.offset,spec.end+1), count:spec.options?.count ? rows.length : null,error:null};
        }).then(resolve,reject),
      }; return q;
    }
  });
  if (ready) await page.evaluate(() => initializeDashboard());
  await page.addScriptTag({url:`${origin}/admin-nav.js`});
  await page.evaluate(() => OGRoleNavigation.render('admin'));
  return page;
}

for (const width of [320,390,430,768,1366]) test(`Dashboard at ${width}px: usable summaries, navigation, filters and reports`, async t => {
  const page = await open(t,width);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(await overflow(),false);
  await expect(page.locator('#stat-orders')).toHaveText('8');
  await expect(page.locator('#stat-overdue')).toHaveText('4');
  await expect(page.locator('#stat-tasks')).toHaveText('4');
  await expect(page.locator('#stat-review')).toHaveText('3');
  await expect(page.locator('.dash-order-row')).toHaveCount(4);
  await expect(page.locator('.dash-task-row')).toHaveCount(4);
  const first = await page.locator('.dash-order-row').first().boundingBox();
  if ([320,390,1366].includes(width)) await page.screenshot({path:`test-results/dashboard-${width}-local.png`});
  assert.ok(first.y < (width < 600 ? 760 : 720),`pending work visible in the first screen (y=${first.y})`);
  await page.locator('[data-order-filter=today]').click();
  await expect(page.locator('.dash-order-row')).toHaveCount(1);
  await expect(page.locator('.dash-order-row')).toContainText('alex_collects');
  await expect(page.locator('.dash-order-row')).toHaveAttribute('href','pending-orders.html?orderId=12-12345-00002');
  await page.locator('[data-task-filter=blocked]').click();
  await expect(page.locator('.dash-task-row')).toHaveCount(1);
  await page.locator('#inventory-report summary').click();
  await expect(page.locator('#inventory-report-body')).toContainText('$750');
  assert.equal(await overflow(),false);
  if (width < 900) {
    await page.getByRole('button',{name:'Open menu'}).click();
    await expect(page.locator('#mobile-menu')).toBeVisible();
    await page.getByRole('button',{name:'Open menu'}).click();
    await expect(page.locator('#mobile-menu')).toBeHidden();
  }
});

test('units, orders and buyers are distinct; label printing never removes unfinished work', async t => {
  const page = await open(t);
  await expect(page.locator('#stat-orders-detail')).toHaveText('8 buyers · 11 units');
  await expect(page.locator('#orders-summary')).toContainText('9 item lines still to finish');
  await expect(page.locator('#orders-summary')).toContainText('1 without a ship date');
  const data = await page.evaluate(() => ({order:dashboardState.orders[0],reads}));
  assert.equal(data.order.lines,2); assert.equal(data.order.units,4);
  assert.ok(!data.reads.find(r=>r.table==='ebay_order_lines').columns.includes('raw_payload'));
  assert.ok(data.reads.find(r=>r.table==='ebay_order_tasks').scope.includes('status.eq.ready_for_admin_approval'));
  assert.ok(data.reads.find(r=>r.table==='team_tasks').scope.includes('assigned_by.eq.me'));
});

test('queries run independently, refreshes coalesce, and reports/media stay off the initial path', async t => {
  const page = await open(t,390,{ready:false});
  await page.evaluate(() => {
    dashboardState.user = {id:'me'}; setupDashboardListeners();
    waiters.ebay_order_lines = new Promise(resolve=>window.releaseOrders=resolve);
    window.refreshOne = refreshDashboard(); window.sameRefresh = refreshOne === refreshDashboard();
  });
  await expect(page.locator('#stat-tasks')).toHaveText('4');
  await expect(page.locator('#stat-orders')).toHaveText('—');
  assert.equal(await page.evaluate(() => sameRefresh),true);
  let names = await page.evaluate(() => reads.map(row=>row.table));
  assert.equal(names.filter(name=>name==='ebay_order_lines').length,1);
  assert.equal(names.some(name=>/item_types|item_stock|buyer_snapshot|photo|event/.test(name)),false);
  await page.evaluate(async () => {releaseOrders();await refreshOne;});
  await page.locator('#buyers-report summary').click();
  await expect(page.locator('.dash-buyer')).toHaveCount(1);
  await page.locator('#buyers-report summary').click(); await page.locator('#buyers-report summary').click();
  assert.equal(await page.evaluate(() => reads.filter(row=>row.table==='get_dashboard_buyer_snapshot').length),1);
});

test('failure never masquerades as zero or a partial task total; retry recovers', async t => {
  const page = await open(t);
  await page.evaluate(() => {failures=['ebay_order_lines','ebay_order_tasks','get_dashboard_buyer_snapshot'];});
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await expect(page.locator('#dashboard-orders')).toContainText("Couldn't load orders");
  await expect(page.locator('#dashboard-tasks')).toContainText("Couldn't load tasks");
  await expect(page.locator('#stat-orders')).toHaveText('—');
  await expect(page.locator('#stat-tasks')).toHaveText('—');
  await expect(page.locator('#dashboard-status')).toBeVisible();
  await page.locator('#buyers-report summary').click();
  await expect(page.locator('#buyers-report-body')).toContainText('This report is unavailable');
  await expect(page.locator('#buyers-report-body')).not.toContainText('No buyer activity');
  await page.evaluate(() => {failures=[];});
  await page.locator('#dashboard-orders [data-retry]').click();
  await expect(page.locator('#stat-orders')).toHaveText('8');
  await expect(page.locator('#stat-tasks')).toHaveText('4');
  await expect(page.locator('#dashboard-status')).toBeHidden();
});

test('summary paging includes rows past 1,000; category totals do not double-count multi-category items', async t => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    fixtures.item_stock_locations = Array.from({length:1003},(_,i)=>({id:`s${i}`,item_id:'i1',quantity:1}));
    const rows = await dashboardPages(()=>supabase.from('item_stock_locations').select('id,item_id,quantity'));
    const summary = summarizeDashboardInventory(fixtures.item_types,rows);
    return {count:rows.length,units:summary.units,cost:summary.cost,value:summary.value,offsets:reads.filter(r=>r.table==='item_stock_locations').map(r=>r.offset)};
  });
  assert.deepEqual(result,{count:1003,units:1003,cost:50150,value:150450,offsets:[0,500,1000]});
});

test('notes and names are escaped; local-day deadlines survive daylight-saving changes', async t => {
  const page = await open(t);
  const result = await page.evaluate(() => {
    dashboardState.tasks[0].title = '<img src=x onerror=alert(1)>';
    dashboardState.tasks[0].note = '<script>alert(1)</script>';
    renderDashboardTasks();
    return [deadlineBucket('2026-11-01T01:30:00-04:00',new Date('2026-11-01T17:00:00-05:00')),deadlineBucket('2026-11-02T00:15:00-05:00',new Date('2026-11-01T17:00:00-05:00')),deadlineBucket('nonsense')];
  });
  assert.deepEqual(result,['today','tomorrow','undated']);
  await expect(page.locator('#dashboard-tasks img,#dashboard-tasks script')).toHaveCount(0);
  await expect(page.locator('#dashboard-tasks')).toContainText('<img src=x onerror=alert(1)>');
});

test('task deadlines match the Tasks page, display names resolve, and return links open their work queue', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    dashboardState.tasks = [{id:'return-1',source:'return',sourceLabel:'Return',title:'Inspect the returned bracelet',note:'Photograph the clasp.',assigned_to_user_id:'colleague',assigned_to_email:'sandra@example.test',due:new Date(Date.now()-60000).toISOString(),status:'open',priority:'urgent'}];
    renderDashboardTasks();
  });
  await expect(page.locator('#stat-tasks-detail')).toHaveText('1 overdue · 0 need help');
  await expect(page.locator('.dash-task-row')).toContainText('Sandra');
  await expect(page.locator('.dash-task-row')).toHaveAttribute('href','team-tasks.html?taskId=return-1');
});

