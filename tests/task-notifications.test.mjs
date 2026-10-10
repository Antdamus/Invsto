import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
let browser, server, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (name === 'notification-test.html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end('<!doctype html><html><meta name="viewport" content="width=device-width, initial-scale=1"><body style="margin:0;background:#111816;color:#efece5;font-family:Arial"><main style="padding:24px"><h1>Pending orders</h1><p>Continue packing while task updates arrive.</p><label>Scan bag <input id="scan" aria-label="Scan bag"></label><button id="work">Continue work</button></main><script src="task-notifications.js"></script></body></html>');
    }
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) return res.writeHead(404).end();
    try {
      let body = await readFile(new URL(name, root));
      if (name.endsWith('.html')) body = body.toString().replace(/<script\b[\s\S]*?<\/script>/gi, '');
      res.setHeader('Content-Type', (name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html') + '; charset=utf-8');
      res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (process.env.INVSTO_ITEM_BROWSER === 'webkit' ? webkit : chromium).launch();
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => { await browser?.close(); await new Promise(resolve => {server.close(resolve); server.closeAllConnections();}); });

async function open(t, {width = 1366, count = 2, signedIn = true, delay = 0} = {}) {
  const context = await browser.newContext({viewport: {width, height: 844}, isMobile: width < 760, hasTouch: width < 760, timezoneId: 'America/New_York'});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await context.addInitScript(({count, signedIn, delay}) => {
    window.user = signedIn ? {id: 'worker-a'} : null;
    window.calls = []; window.writes = []; window.channels = []; window.removed = [];
    window.failReads = false; window.failWrites = false; window.readDelay = delay;
    window.rows = Array.from({length: count}, (_, i) => ({id: `notice-${i}`, recipient_user_id: 'worker-a', source: 'order',
      task_id: '8794ebbb-3052-491a-ab49-1578e76701f0', notification_type: i === 0 ? 'task_progress_update' : 'task_assigned',
      title: i === 0 ? 'Reply: Certificate needed for this order' : `New task assigned: Prepare bag ${i}`,
      body: i === 0 ? 'Please wait for the CGL certificate before sending the order.\nThe customer paid for express shipping.' : 'Check the bag and upload a photo before packing.',
      actor_email: 'sandra@example.com', priority: 'high', created_at: new Date(Date.UTC(2026, 9, 7, 18, 20 - i)).toISOString(), read_at: null}));
    rows.push({...rows[0], id: 'private-other', title: 'Another employee private task', recipient_user_id: 'worker-b', read_at: null});
    window.supabase = window.supabaseClient = {
      auth: {getSession: async () => ({data: {session: user ? {user} : null}}), onAuthStateChange: handler => {window.authHandler = handler; return {data: {subscription: {unsubscribe() {}}}};}},
      channel(name) {
        const channel = {name, on(event, filter, callback) {this.filter = filter; this.callback = callback; return this;}, subscribe(callback) {this.status = callback; return this;}};
        channels.push(channel); return channel;
      },
      removeChannel: async channel => removed.push(channel.name),
      async rpc(name, args) {
        if (name !== 'notification_inbox') throw Error('Unexpected RPC '+name);
        calls.push({rpc:name,args,filters:[['recipient_user_id',user.id]]});
        const all = structuredClone(rows.filter(row=>row.recipient_user_id===user.id)).map(row=>({...row,category:row.notification_type==='customer_issue_sync'?'system':['customer_issue_action','customer_issue_deadline'].includes(row.notification_type)?row.metadata?.issue_kind==='return'?'returns':'buyers':'tasks'}));
        all.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.id.localeCompare(a.id));
        const unread=all.filter(row=>!row.read_at), counts={all:unread.length,tasks:0,buyers:0,returns:0,system:0};
        unread.forEach(row=>counts[row.category]++);
        const visible=all.filter(row=>(args._view==='recent'||!row.read_at)&&(args._category==='all'||row.category===args._category));
        const data={unread:unread.slice(0,30),unread_count:unread.length,counts,total:visible.length,entries:visible.slice(0,args._limit)};
        if(readDelay)await new Promise(resolve=>setTimeout(resolve,readDelay));
        return failReads?{error:{message:'Offline'}}:{data};
      },
      from(table) {
        if (table !== 'task_notifications') throw Error(`Unexpected table ${table}`);
        const filters = [], orders = []; let update, start = 0, end = Infinity;
        const query = {
          select() {return query;}, eq(key, value) {filters.push([key, value]); return query;},
          is(key, value) {filters.push([key, value]); return query;},
          in(key, values) {filters.push([key, values]); return query;},
          order(key, options) {orders.push([key, options.ascending]); return query;},
          range(a, b) {start = a; end = b; return query;}, limit(n) {end = n - 1; return query;},
          update(value) {update = value; return query;},
          async then(resolve, reject) {
            try {
              calls.push({table, filters, update});
              let result = rows.filter(row => filters.every(([key, value]) => Array.isArray(value) ? value.includes(row[key]) : row[key] === value));
              if (update) {
                if (failWrites) return resolve({error: {message: 'Offline'}});
                writes.push({table, filters, update}); result.forEach(row => Object.assign(row, update));
                return resolve({data: result.map(row => ({id: row.id}))});
              }
              result = structuredClone(result);
              result.sort((a, b) => {
                for (const [key, asc] of orders) {const compared = String(a[key] || '').localeCompare(String(b[key] || '')); if (compared) return asc ? compared : -compared;}
                return 0;
              });
              if (readDelay) await new Promise(resolve => setTimeout(resolve, readDelay));
              resolve(failReads ? {error: {message: 'Offline'}} : {data: result.slice(start, end + 1), count: result.length});
            } catch (error) {reject(error);}
          },
        };
        return query;
      },
    };
  }, {count, signedIn, delay});
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/notification-test.html`);
  await page.evaluate(() => OGTaskNotifications.ready);
  return page;
}

for (const width of [320, 390, 1366]) {
  test(`${width}px: persistent alerts and full inbox fit without interrupting work`, async t => {
    const page = await open(t, {width});
    const alert = page.getByRole('region', {name: 'New updates'});
    await expect(alert).toBeVisible();
    assert.deepEqual(await page.evaluate(() => writes), []);
    await page.getByLabel('Scan bag').fill('LIVE-019');
    const before = await page.evaluate(() => document.activeElement.id);
    await page.evaluate(() => {
      rows.unshift({...rows[0], id: 'new-reply', title: 'Reply: Use the blue box', body: '<img src=x onerror=alert(1)> Keep this as text.', created_at: '2026-10-07T19:00:00Z'});
      channels[0].callback({eventType: 'INSERT', new: rows[0]});
    });
    await expect(alert).toContainText('Use the blue box');
    assert.equal(await page.evaluate(() => document.activeElement.id), before);
    assert.equal(await alert.locator('img').count(), 0);
    await page.getByRole('button', {name: 'Review updates', exact: true}).click();
    const panel = page.getByRole('region', {name: 'Updates inbox'});
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('Please wait for the CGL certificate');
    await page.getByRole('heading', {name: 'Pending orders', exact: true}).click();
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= width + 1 && box.y >= 0 && box.y + box.height <= 845, JSON.stringify(box));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width !== 320) await page.screenshot({path: `test-results/task-notifications-${width}.png`});
    assert.deepEqual(await page.evaluate(() => writes), []);
    await page.getByRole('button', {name: 'Close updates', exact: true}).click();
    await expect(panel).toBeHidden();
    await expect(page.getByRole('button', {name: 'Updates, 3 unread', exact: true})).toBeVisible();
  });
}

test('minimizing persists across pages and a new reply brings the alert back', async t => {
  const page = await open(t);
  await page.getByRole('button', {name: 'Minimize update alert'}).click();
  await page.reload(); await page.evaluate(() => OGTaskNotifications.ready);
  await expect(page.getByRole('region', {name: 'New updates'})).toBeHidden();
  assert.equal(await page.evaluate(() => OGTaskNotifications.snapshot().unreadCount), 2);
  await page.evaluate(() => {
    rows.unshift({...rows[0], id: 'next', title: 'New reply after minimizing', created_at: '2026-10-07T20:00:00Z'});
    channels[0].callback({eventType: 'INSERT', new: rows[0]});
  });
  await expect(page.getByRole('region', {name: 'New updates'})).toContainText('New reply after minimizing');
});

test('all unread alerts are counted and paginated beyond the recent-history limit', async t => {
  const page = await open(t, {count: 45});
  await page.getByRole('button', {name: 'Review updates'}).click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(30);
  await page.getByRole('button', {name: 'Load more', exact: true}).click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(45);
  await expect(page.getByRole('button', {name: 'Load more', exact: true})).toBeHidden();
  assert.doesNotMatch(await page.locator('#og-task-updates').innerText(), /Another employee private task/);
  assert.ok((await page.evaluate(() => calls)).every(call => call.filters.some(([key, value]) => key === 'recipient_user_id' && value === 'worker-a')));
});

test('mark read only changes the selected recipient notification and syncs remote reads', async t => {
  const page = await open(t);
  await page.getByRole('button', {name: 'Review updates'}).click();
  await page.locator('[data-tu-read="notice-0"]').click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(1);
  const writes = await page.evaluate(() => window.writes);
  assert.equal(writes.length, 1); assert.deepEqual(Object.keys(writes[0].update), ['read_at']);
  assert.equal(writes[0].table, 'task_notifications');
  assert.ok(writes[0].filters.some(([key, value]) => key === 'recipient_user_id' && value === 'worker-a'));
  await page.evaluate(() => {rows.find(row => row.id === 'notice-1').read_at = new Date().toISOString(); channels[0].callback({eventType: 'UPDATE'});});
  await expect(page.locator('.og-tu-summary')).toHaveText('You’re all caught up');
  await page.getByRole('button', {name: 'Recent', exact: true}).click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(2);
});

test('opening a notification goes directly to its task, ignoring arbitrary supplied URLs', async t => {
  const page = await open(t);
  await page.evaluate(() => {rows[0].metadata = {open_url: 'https://unexpected.example'};});
  await page.getByRole('button', {name: 'Review updates'}).click();
  const link = page.locator('[data-tu-open="notice-0"]');
  await expect(link).toHaveAttribute('href', 'team-tasks.html?taskId=8794ebbb-3052-491a-ab49-1578e76701f0');
  await link.click();
  await page.waitForURL('**/team-tasks.html?taskId=8794ebbb-3052-491a-ab49-1578e76701f0');
});

test('sync incidents open the fixed recovery page rather than a nonexistent task or supplied URL',async t=>{
 const page=await open(t);
 await page.evaluate(()=>{Object.assign(rows[0],{notification_type:'customer_issue_sync',title:'eBay sync needs attention',metadata:{open_url:'https://unexpected.example',incident_id:'bad-id'}});channels[0].callback({eventType:'UPDATE'});});
 await page.getByRole('button',{name:'Review updates'}).click();
 const link=page.getByRole('link',{name:'Open sync status',exact:true});
 await expect(link).toHaveAttribute('href','ebay-returns.html?syncHealth=1');
 await expect(page.locator('.og-tu-entry').first()).toContainText('eBay sync');
});

test('failed reads and writes keep alerts visible, and retry recovers', async t => {
  const page = await open(t);
  await page.getByRole('button', {name: 'Review updates'}).click();
  await page.evaluate(() => {failWrites = true;});
  await page.locator('[data-tu-read="notice-0"]').click();
  await expect(page.locator('.og-tu-error')).toContainText('Could not mark');
  await expect(page.locator('.og-tu-entry')).toHaveCount(2);
  await page.evaluate(async () => {failReads = true; await OGTaskNotifications.refresh();});
  await expect(page.locator('.og-tu-entry')).toHaveCount(2);
  await expect(page.locator('.og-tu-error')).toContainText('could not refresh');
  await page.evaluate(() => {failReads = false; failWrites = false;});
  await page.getByRole('button', {name: 'Retry', exact: true}).click();
  await expect(page.locator('.og-tu-error')).toBeHidden();
  await page.locator('[data-tu-read="notice-0"]').click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(1);
});

test('sign-out clears private alerts and a late response cannot expose them to the next user', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    readDelay = 180;
    void OGTaskNotifications.refresh();
    user = null; authHandler('SIGNED_OUT', null);
  });
  await expect(page.locator('#og-task-updates')).toHaveCount(0);
  await page.evaluate(() => {user = {id: 'worker-b'}; authHandler('SIGNED_IN', {user});});
  await expect(page.getByRole('region', {name: 'New updates'})).toContainText('Another employee private task');
  assert.doesNotMatch(await page.locator('#og-task-updates').innerText(), /Certificate needed|Prepare bag/);
  assert.ok((await page.evaluate(() => removed)).length >= 1);
});

test('read acknowledgments cannot be undone by an older in-flight refresh', async t => {
  const page = await open(t);
  await page.evaluate(() => {readDelay = 180; void OGTaskNotifications.refresh();});
  assert.equal(await page.evaluate(() => OGTaskNotifications.markRead(['notice-0'])), true);
  await page.evaluate(() => OGTaskNotifications.refresh());
  await expect(page.getByRole('button', {name: 'Updates, 1 unread', exact: true})).toBeVisible();
  assert.equal(await page.evaluate(() => OGTaskNotifications.snapshot().notifications.some(row => row.id === 'notice-0' && !row.read_at)), false);
});

test('signed-out pages do not fetch or show employee notifications', async t => {
  const page = await open(t, {signedIn: false});
  assert.equal(await page.locator('#og-task-updates').count(), 0);
  assert.deepEqual(await page.evaluate(() => calls), []);
});

test('the Tasks-page bell uses the shared inbox and the same read state without a second subscription', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    document.querySelector('main').insertAdjacentHTML('beforeend', '<button id="team-task-notification-toggle">Task page updates</button><span id="team-task-notification-count"></span><div id="team-task-notification-panel" hidden><div id="team-task-notification-list"></div></div>');
  });
  await page.addScriptTag({url: `${origin}/team-tasks.js`});
  await page.evaluate(async () => {
    state.user = user;
    await loadTaskNotifications();
    setupTaskNotificationRealtime();
    document.getElementById('team-task-notification-toggle').onclick = () => setTaskNotificationPanelOpen(true);
  });
  await expect(page.locator('#team-task-notification-count')).toHaveText('2');
  assert.equal(await page.evaluate(() => channels.length), 1);
  await page.getByRole('button', {name: 'Minimize update alert'}).click();
  await page.getByRole('button', {name: 'Task page updates', exact: true}).click();
  await expect(page.getByRole('region', {name: 'Updates inbox'})).toBeVisible();
  await page.evaluate(() => markTaskNotificationsRead(['notice-0']));
  await expect(page.locator('#team-task-notification-count')).toHaveText('1');
  assert.equal(await page.evaluate(() => state.notifications.some(row => row.id === 'notice-0' && !row.read_at)), false);
});

test('staff pages include the shared inbox; public sign-in stays clear', async () => {
  const names = ['admin','dashboard','worker-dashboard','seller-dashboard','pending-orders','stock','team-tasks','live-sales','past-live-sales',
    'ebay-order-history','ebay-returns','email-triage','add-item','add-inventory','bag-lookup','inventory-activity','locations','print-stations','sms-marketing','store-transfers','timeclock'];
  for (const name of names) assert.match(await readFile(new URL(`${name}.html`, root), 'utf8'), /task-notifications\.js\?v=\d{8}/);
  for (const name of ['index','set-password']) assert.doesNotMatch(await readFile(new URL(`${name}.html`, root), 'utf8'), /task-notifications\.js/);
});

test('categories find old unread work, retain reads, and do not change when other alerts arrive', async t => {
  const page = await open(t, {count:45});
  await page.evaluate(() => {
    rows.filter(r=>r.recipient_user_id===user.id).forEach(r=>{r.notification_type='customer_issue_action';r.metadata={issue_kind:'return',case_id:'00000000-0000-4000-8000-000000000101'};});
    rows.push({...rows[0],id:'old-task',notification_type:'task_progress_update',title:'Older employee reply',created_at:'2026-09-01T12:00:00Z'});
    channels[0].callback({eventType:'INSERT'});
  });
  await page.getByRole('button',{name:'Review updates',exact:true}).click();
  await page.getByRole('button',{name:'Tasks, 1 unread',exact:true}).click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(1);
  await expect(page.locator('.og-tu-entry')).toContainText('Older employee reply');
  await page.evaluate(()=>{rows.unshift({...rows[0],id:'buyer-reply',metadata:{issue_kind:'request'},title:'New buyer issue',created_at:'2026-10-09T12:00:00Z'});channels[0].callback({eventType:'INSERT'});});
  await expect(page.getByRole('button',{name:'Buyer issues, 1 unread',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Tasks, 1 unread',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.og-tu-entry')).toHaveCount(1);
  await page.locator('[data-tu-read="old-task"]').click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Returns, 45 unread',exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Recent',exact:true}).click();
  await expect(page.locator('.og-tu-entry')).toContainText('Older employee reply');
  await page.getByRole('button',{name:'Returns, 45 unread',exact:true}).click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(30);
  await page.getByRole('button',{name:'Load more',exact:true}).click();
  await expect(page.locator('.og-tu-entry')).toHaveCount(45);
});

test('a slow previous filter cannot overwrite a newer filter and the preference survives navigation', async t => {
  const page = await open(t);
  await page.getByRole('button',{name:'Review updates',exact:true}).click();
  await page.evaluate(()=>{readDelay=180;});
  await page.getByRole('button',{name:'Tasks, 2 unread',exact:true}).click();
  await page.getByRole('button',{name:'Returns, 0 unread',exact:true}).click();
  await expect(page.locator('.og-tu-empty')).toContainText('No unread returns updates.');
  await expect(page.locator('.og-tu-entry')).toHaveCount(0);
  await page.reload();await page.evaluate(()=>OGTaskNotifications.ready);
  await page.getByRole('button',{name:'Updates, 2 unread',exact:true}).click();
  await expect(page.getByRole('button',{name:'Returns, 0 unread',exact:true})).toHaveAttribute('aria-pressed','true');
});
