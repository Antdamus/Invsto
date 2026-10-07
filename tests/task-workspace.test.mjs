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
  browserServer = await (process.env.INVSTO_ITEM_BROWSER === 'webkit' ? webkit : chromium).launchServer();
  browser = await (process.env.INVSTO_ITEM_BROWSER === 'webkit' ? webkit : chromium).connect(browserServer.wsEndpoint());
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => {
  // Windows WebKit occasionally leaves its close transport pending after every
  // context has closed. Stop only the isolated process launched by this suite.
  const timer = setTimeout(() => browserServer?.kill().catch(() => {}), 5000);
  try {await browser?.close(); await browserServer?.close();}
  finally {clearTimeout(timer);}
  await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
});

async function open(t, width = 390, {admin = true, direct = false, ready = true} = {}) {
  const context = await browser.newContext({viewport: {width, height: 900}, hasTouch: width < 800});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/team-tasks.html${direct ? '?taskId=00000000-0000-4000-8000-000000000001' : ''}`);
  await page.addScriptTag({url: `${origin}/team-tasks.js`});
  await page.evaluate(({admin, ready, direct}) => {
    window.writes = [];
    window.supabase = {rpc: async (...args) => {writes.push(args); return {data: [], error: null};}, from: table => {throw Error('Unexpected DB request: ' + table);}};
    state.user = {id: 'me', email: 'alex@example.test'};
    state.employee = {id: 'me', user_id: 'me', name: 'Alex', role: admin ? 'admin' : 'employee', active: true};
    state.assignees = [{user_id: 'me', name: 'Alex', email: 'alex@example.test', role: 'admin'}, {user_id: 'teammate', name: 'Sandra', email: 'sandra@example.test', role: 'employee'}];
    const today = new Date(); today.setHours(23, 59, 0, 0);
    const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
    state.tasks = Array.from({length: 48}, (_, i) => ({
      id: i === 0 && direct ? '00000000-0000-4000-8000-000000000001' : `task-${i}`, source: 'team', title: i === 0 ? 'Confirm the watch certificate before shipping' : i === 1 ? 'Review the bracelet photos' : `Follow up on ${String(i).padStart(2, '0')}`,
      description: 'Check the certificate matches the serial number. Add a clear photo before packing.',
      latest_note: i === 0 ? 'The certificate is still missing. Sandra has the watch ready.\nWaiting for the matching card before this can ship.' : 'The item is ready for review. Please check the photos and confirm the next step.',
      assigned_to_user_id: i % 2 ? 'teammate' : 'me', assigned_to_email: i % 2 ? 'sandra@example.test' : 'alex@example.test',
      created_by: 'me', created_by_email: 'alex@example.test', task_type: 'shipping', metadata: {},
      status: i === 1 ? 'completed_by_employee' : i === 2 ? 'blocked' : 'in_progress', priority: i === 0 ? 'urgent' : 'normal',
      due_at: i === 0 ? yesterday.toISOString() : i === 3 ? today.toISOString() : '',
      created_at: '2026-10-05T10:00:00Z', updated_at: '2026-10-06T13:00:00Z',
    }));
    state.eventsByTask.set('team:task-0', [{id: 'update-0', task_id: 'task-0', action: 'progress', new_status: 'in_progress', notes: 'Certificate is still missing. Sandra has the watch ready. Waiting for the matching card before this can ship.', signed_by_email: 'sandra@example.test', created_at: '2026-10-06T14:00:00Z'}]);
    if (ready) state.tasks.forEach(task => state.taskEvidenceLoads.set(getUnifiedTaskKey(task), {status: 'ready', promise: Promise.resolve()}));
    loadCaptureStations = async () => [];
    setupListeners(); renderAssigneeSelect(); updateTaskScopeChrome(); renderTasks();
  }, {admin, ready, direct});
  await page.addScriptTag({url: `${origin}/admin-nav.js`});
  await page.evaluate(admin => OGRoleNavigation.render(admin ? 'admin' : 'worker'), admin);
  return page;
}

for (const width of [320, 390, 430, 768, 1366]) test(`Tasks at ${width}px: readable queue, filters, details, modal and no overflow`, async t => {
  const page = await open(t, width);
  const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(await overflow(), false);
  const card = page.locator('.team-task-card').first();
  assert.ok((await card.boundingBox()).y < (width < 800 ? 530 : 620), 'work visible without scrolling past controls');
  await expect(page.locator('.team-task-card')).toHaveCount(20);
  await expect(page.locator('.team-task-card-details > *')).toHaveCount(0);
  await expect(card.locator('.team-task-summary-preview')).toContainText('Certificate is still missing');
  if (width === 390 || width === 1366) await page.screenshot({path: `test-results/tasks-${width}-local.png`});
  await page.getByRole('button', {name: 'Filters', exact: true}).click();
  await expect(page.locator('#task-filters-panel')).toBeVisible();
  assert.equal(await overflow(), false);
  await page.getByRole('button', {name: 'Filters', exact: true}).click();
  await card.locator('[data-team-task-toggle]').click();
  await expect(card.locator('.team-task-card-details')).toBeVisible();
  await expect(card.locator('[data-team-task-progress]')).toBeVisible();
  assert.equal(await overflow(), false);
  await card.locator('[data-team-task-progress]').click();
  await expect(page.locator('#team-task-modal')).toBeVisible();
  await expect(page.locator('#team-task-note')).toBeVisible();
  assert.equal(await overflow(), false);
  await page.locator('#submit-team-task').focus(); await page.keyboard.press('Tab');
  await expect(page.locator('#close-team-task-modal')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#team-task-modal')).toBeHidden();
  assert.deepEqual(await page.evaluate(() => writes), []);
});

test('search finds notes and update text across all buckets, filters compose and reset, and list pages', async t => {
  const page = await open(t);
  await page.locator('#task-search').fill('matching card');
  await expect(page.locator('.team-task-card')).toHaveCount(1);
  await page.locator('#task-search').fill('Review the bracelet');
  await expect(page.locator('.team-task-card')).toHaveCount(1);
  await expect(page.locator('.team-task-card')).toContainText('Needs acceptance');
  await page.locator('#task-search').fill('nothing matches 987');
  await page.getByRole('button', {name: 'Reset filters', exact: true}).click();
  await expect(page.locator('.team-task-card')).toHaveCount(20);
  await page.locator('#task-load-more').click(); await expect(page.locator('.team-task-card')).toHaveCount(40);
  await page.locator('[data-task-focus=overdue]').click(); await expect(page.locator('.team-task-card')).toHaveCount(1);
  await page.locator('[data-task-focus=review]').click(); await expect(page.locator('.team-task-card')).toHaveCount(1);
  await page.locator('[data-task-focus=blocked]').click(); await expect(page.locator('.team-task-card')).toHaveCount(1);
  await page.locator('[data-task-focus=today]').click(); await expect(page.locator('.team-task-card')).toHaveCount(1);
  await page.locator('.task-quick-views [data-task-focus=all]').click();
  await expect(page.locator('.team-task-card')).toHaveCount(20);
  assert.deepEqual(await page.evaluate(() => writes), []);
});

test('evidence is loaded only on demand, reused, and detail buttons are keyboard accessible', async t => {
  const page = await open(t, 390, {ready: false});
  await page.evaluate(() => {
    window.mediaReads = [];
    for (const name of ['photos', 'returns', 'receipts', 'events']) mediaReads[name] = 0;
    hydrateReturnComplaintImages = async () => {mediaReads.photos++;};
    hydrateReturnMessages = async () => {mediaReads.returns++;};
    hydrateOrderVideoReceiptEvidence = async () => {mediaReads.receipts++;};
    hydrateEventPhotoUrls = async () => {mediaReads.events++;};
  });
  const toggle = page.locator('[data-team-task-toggle="team:task-0"]');
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(page.locator('[data-team-task-progress="task-0"]')).toBeVisible();
  await expect(page.locator('#task-details-team-task-0')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => ({...mediaReads})), {photos: 1, returns: 1, receipts: 1, events: 1});
  await toggle.click(); await toggle.click();
  assert.deepEqual(await page.evaluate(() => ({...mediaReads})), {photos: 1, returns: 1, receipts: 1, events: 1});
  assert.deepEqual(await page.evaluate(() => writes), []);
});

test('deep links retain the requested task regardless of filters and give a way back', async t => {
  const page = await open(t, 390, {direct: true});
  await expect(page.locator('.team-task-card')).toHaveCount(1);
  await expect(page.locator('#task-back-to-list')).toBeVisible();
  await expect(page.locator('#task-overview')).toBeHidden();
  await page.evaluate(() => {state.taskSearch = 'unrelated'; state.taskFocus = 'review'; renderTasks();});
  await expect(page.locator('.team-task-card')).toHaveCount(1);
});

test('history keeps completed records searchable and excludes active-only overview', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    state.taskView = 'history'; state.tasks = state.tasks.map(task => ({...task, status: 'resolved'}));
    updateTaskScopeChrome(); renderTasks();
  });
  await expect(page.locator('#task-overview')).toBeHidden();
  await page.locator('#task-search').fill('certificate');
  await expect(page.locator('.team-task-card')).toHaveCount(20);
  await page.locator('#task-search').fill('matching card');
  await expect(page.locator('.team-task-card')).toHaveCount(1);
});

test('worker view and admin worker preview preserve permissions', async t => {
  const page = await open(t, 390, {admin: false});
  await page.getByRole('button', {name: 'Filters', exact: true}).click();
  await expect(page.locator('#team-task-scope-control')).toBeHidden();
  await expect(page.locator('[data-task-owner-filter=order_approval]')).toBeHidden();
  await page.evaluate(() => {
    state.employee.role = 'admin'; state.viewedWorkerUserId = 'teammate'; updateTaskScopeChrome(); renderTasks();
  });
  await expect(page.locator('#new-team-task')).toBeDisabled();
  await page.locator('[data-team-task-toggle="team:task-0"]').click();
  await expect(page.locator('[data-task-assignment-action]')).toHaveCount(0);
  assert.deepEqual(await page.evaluate(() => writes), []);
});

test('task content is escaped rather than interpreted as markup', async t => {
  const page = await open(t);
  await page.evaluate(() => {state.tasks[0].title = '<img src=x onerror=alert(1)>'; state.eventsByTask.clear(); state.tasks[0].latest_note = '<script>alert(2)</script>'; renderTasks();});
  await expect(page.locator('.team-task-card').first()).toContainText('<img src=x onerror=alert(1)>');
  await expect(page.locator('.team-task-card img')).toHaveCount(0);
});

test('initial loading renders work without signing or requesting evidence for closed cards', async t => {
  const page = await open(t);
  await page.evaluate(async () => {
    const fixtures = state.tasks;
    window.mediaCalls = 0;
    loadTeamTaskRecords = async () => fixtures;
    loadOrderTaskRecords = async () => [];
    loadReturnTaskRecords = async () => [];
    hydrateTaskLines = async () => {};
    hydrateOrderWorkflowChildren = async () => {};
    loadEventsForTasks = async () => {};
    loadTaskReadStates = async () => {};
    hydrateEventPhotoUrls = async () => {mediaCalls++;};
    hydrateOrderVideoReceiptEvidence = async () => {mediaCalls++;};
    await loadTasks();
  });
  await expect(page.locator('.team-task-card')).toHaveCount(20);
  assert.equal(await page.evaluate(() => mediaCalls), 0);
  await page.locator('[data-team-task-toggle="team:task-0"]').click();
  await expect(page.locator('[data-team-task-progress="task-0"]')).toBeVisible();
  assert.equal(await page.evaluate(() => mediaCalls), 2);
});

test('order approval keeps item decisions, evidence and workflow actions on a phone', async t => {
  const page = await open(t, 390);
  await page.evaluate(() => {
    const task = normalizeOrderTask({id: 'review-order', order_id: 'order-1', order_line_ids: ['line-1'], task_type: 'pending_admin_review',
      title: 'Review the gold bracelet for buyer_42', question: 'Confirm the bracelet matches the sale photo.', status: 'ready_for_admin_approval', priority: 'high',
      metadata: {workflow_type: 'pending_order_approval'}, assigned_to_user_id: 'me', assigned_to_email: 'alex@example.test',
      ebay_orders: {order_number: '11-22222-33333', buyer_username: 'buyer_42', buyer_name: 'Test Buyer', status: 'pending', total_price: 125, raw_payload: {orderPaymentStatus: 'PAID'}},
    });
    task.lineDetails = [{id: 'line-1', order_id: 'order-1', item_number: '123456789012', item_title: 'Gold bracelet', quantity: 1, line_status: 'pending', total_price: 125}];
    state.tasks = [task]; state.taskEvidenceLoads.set('order:review-order', {status: 'ready'}); renderTasks();
    state.eventsByTask.set('order:review-order', [{id: 'evidence-1', action: 'progress', notes: 'Bracelet photographed', photo_attachments: [{bucket: 'team-task-evidence', path: 'bracelet.png', label: 'Bracelet close-up', url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4boAAAAASUVORK5CYII='}]}]);
  });
  await page.locator('[data-team-task-toggle]').click();
  await expect(page.locator('.team-task-card-details')).toContainText('Confirm the bracelet matches');
  await expect(page.locator('.team-task-approval-line').first()).toBeVisible();
  await expect(page.locator('[data-order-workflow-action="assign-shipping"]')).toBeVisible();
  await expect(page.locator('[data-order-workflow-action="send-back-order"]')).toBeVisible();
  await page.getByRole('button', {name: 'Open Bracelet close-up', exact: true}).first().click();
  await expect(page.locator('#team-task-photo-viewer-modal')).toBeVisible();
  await expect(page.locator('#team-task-photo-viewer-image')).toHaveAttribute('alt', 'Bracelet close-up');
  await page.getByRole('button', {name: 'Done', exact: true}).click();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: 'test-results/tasks-order-review-phone.png'});
  assert.deepEqual(await page.evaluate(() => writes), []);
});

test('saving a progress note retains the existing status-update contract', async t => {
  const page = await open(t, 390);
  await page.locator('[data-team-task-toggle="team:task-0"]').click();
  await page.locator('[data-team-task-progress="task-0"]').click();
  await page.locator('#team-task-note').fill('Waiting for the matching certificate; recheck tomorrow.');
  await page.locator('#team-task-status-input').selectOption('blocked');
  await page.evaluate(() => { loadTasks = async () => {}; });
  await page.locator('#submit-team-task').click();
  await expect(page.locator('#team-task-modal')).toBeHidden();
  const writes = await page.evaluate(() => window.writes);
  assert.equal(writes.length, 1);
  assert.equal(writes[0][0], 'respond_team_task');
  assert.equal(writes[0][1]._status, 'blocked');
  assert.equal(writes[0][1]._task_id, 'task-0');
  assert.equal(writes[0][1]._assigned_to_user_id, null);
  assert.match(writes[0][1]._note, /matching certificate/);
});
