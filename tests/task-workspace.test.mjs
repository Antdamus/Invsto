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
  if (width < 900) {
    const header = await page.locator('.mobile-header').boundingBox();
    const hero = await page.locator('.team-task-hero').boundingBox();
    assert.ok(hero.y >= header.y + header.height, 'Tasks heading and New task must be below the phone header');
  }
  if ([320, 390, 1366].includes(width)) await page.screenshot({path: `test-results/tasks-${width}-local.png`});
  assert.ok((await card.boundingBox()).y < 630, 'work visible in the first screen below the inbox and status controls');
  await expect(page.locator('.team-task-card')).toHaveCount(20);
  await expect(page.locator('.team-task-card-details > *')).toHaveCount(0);
  await expect(card.locator('.team-task-summary-preview')).toContainText('Certificate is still missing');
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
  await page.locator('[data-task-owner-filter=created]').click();
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
  await expect(page.locator('[data-task-owner-filter=approvals]')).toBeVisible();
  await page.evaluate(() => {
    state.employee.role = 'admin'; state.viewedWorkerUserId = 'teammate'; updateTaskScopeChrome(); renderTasks();
  });
  await expect(page.locator('#new-team-task')).toBeDisabled();
  await page.locator('[data-team-task-toggle="team:task-1"]').click();
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

test('responsibility inboxes include acceptance work and keep overdue counts scoped', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    const base = state.tasks[0];
    const task = (id, values) => ({...base, id, title: id, metadata: {}, ...values});
    state.tasks = [
      task('my work', {assigned_by: 'boss', created_by: 'boss', created_by_email: '', status: 'waiting_on_admin'}),
      task('my completed work', {assigned_by: 'boss', created_by: 'boss', created_by_email: '', status: 'completed_by_employee', due_at: ''}),
      task('delegated review', {assigned_to_user_id: 'teammate', assigned_to_email: '', assigned_by: 'me', status: 'completed_by_employee'}),
      task('other admin work', {assigned_to_user_id: 'boss', assigned_to_email: '', assigned_by: 'boss', created_by: 'boss', created_by_email: '', status: 'waiting_on_admin'}),
      task('reassigned by someone else', {assigned_to_user_id: 'teammate', assigned_to_email: '', assigned_by: 'boss', status: 'in_progress'}),
      task('unassigned review', {assigned_to_user_id: null, assigned_to_email: '', assigned_by: 'boss', created_by: 'boss', created_by_email: '', status: 'ready_for_admin_approval'}),
      task('automatic photo capture record', {assigned_to_user_id: null, assigned_to_email: null, assigned_by: 'me', status: 'open'}),
    ];
    state.eventsByTask.clear(); renderTasks();
  });
  await expect(page.locator('.team-task-card')).toHaveCount(2);
  await expect(page.locator('[data-task-stat=overdue]')).toHaveText('1');
  await page.locator('[data-task-focus=overdue]').click();
  await expect(page.locator('.team-task-card')).toHaveCount(1);
  await page.locator('[data-task-owner-filter=created]').click();
  await expect(page.locator('.team-task-card')).toHaveCount(1);
  await expect(page.locator('.team-task-card')).toContainText('delegated review');
  await expect(page.locator('[data-task-focus=overdue]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-task-stat=all]')).toHaveText('1');
  await page.locator('[data-task-owner-filter=approvals]').click();
  await expect(page.locator('.team-task-card')).toHaveCount(3);
  await expect(page.locator('#team-task-list')).not.toContainText('other admin work');
  await page.locator('.task-quick-views [data-task-focus=all]').click();
  await expect(page.locator('.team-task-card')).toHaveCount(4);
  await page.evaluate(() => {
    state.tasks.push({...state.tasks[2], id: 'delegated-order-approval', source: 'order', task_type: 'pending_admin_review', status: 'ready_for_admin_approval', metadata: {workflow_type: 'pending_order_approval'}});
    renderTasks();
  });
  await expect(page.locator('.team-task-card')).toHaveCount(5);
  await expect(page.locator('[data-team-task-card="delegated-order-approval"]')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => writes), []);
});

test('switching to history retains the assigned-by inbox and shows delegated closed work', async t => {
  const page = await open(t);
  await page.locator('[data-task-owner-filter=created]').click();
  await page.evaluate(() => {
    loadTasks = async () => {
      state.tasks = state.tasks.slice(0, 2).map(task => ({...task, status: 'resolved', resolved_by: 'me', assigned_by: 'me'}));
      renderTasks();
    };
  });
  await page.getByRole('button', {name: 'History', exact: true}).click();
  await expect(page.locator('[data-task-owner-filter=created]')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.team-task-card')).toHaveCount(2);
  await expect(page.locator('#team-task-list-title')).toHaveText('Assigned by me · History');
  await page.locator('[data-task-owner-filter=approvals]').click();
  await expect(page.locator('.team-task-card')).toHaveCount(2);
});

test('task loading includes delegated and reviewed records and reads beyond one page', async t => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const activeFilter = getTaskLoadVisibilityFilter();
    state.taskView = 'history';
    const historyFilter = getTaskLoadVisibilityFilter();
    const pages = [];
    const rows = await readTaskPages({range: async (start, end) => {
      pages.push([start, end]);
      return {data: Array.from({length: Math.min(200, 205 - start)}, (_, i) => ({id: start+i})), error: null};
    }});
    return {activeFilter, historyFilter, pages, length: rows.length};
  });
  assert.match(result.activeFilter, /assigned_by.eq.me/);
  assert.match(result.activeFilter, /or\(assigned_to_user_id.not.is.null,assigned_to_email.not.is.null\)/);
  assert.match(result.activeFilter, /assigned_to_user_id.is.null,assigned_to_email.is.null/);
  assert.match(result.historyFilter, /resolved_by.eq.me/);
  assert.deepEqual(result.pages, [[0,199],[200,399]]);
  assert.equal(result.length, 205);
});

test('order groups have a short summary while retaining all order numbers in detail', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    state.tasks = [{...state.tasks[0], source: 'order', task_type: 'admin_review',
      title: 'Closed order group 01-11111-11111, 02-22222-22222 - buyer_42', buyer_username: 'buyer_42',
      metadata: {source: 'order_history', order_numbers: ['01-11111-11111','02-22222-22222']}}];
    renderTasks();
  });
  await expect(page.locator('.team-task-summary-title-row')).toHaveText('buyer_42 · 2 orders');
  await expect(page.locator('[data-team-task-toggle]')).toHaveAttribute('aria-label', /01-11111-11111, 02-22222-22222/);
});

test('cards show the latest assignment date in both inboxes, with an honest legacy fallback', async t => {
  const page = await open(t);
  await page.evaluate(() => {
    state.tasks = [{...state.tasks[0], assigned_by: 'me', updated_at: '2026-10-07T18:00:00Z'}];
    state.eventsByTask.set('team:task-0', [
      {action: 'assigned', new_assigned_to_user_id: 'me', created_at: '2026-10-05T10:00:00Z'},
      {action: 'progress', notes: 'Followed up', created_at: '2026-10-07T18:00:00Z'},
      {action: 'assigned', new_assigned_to_user_id: 'me', created_at: '2026-10-06T14:30:00Z'},
    ]);
    renderTasks();
  });
  await expect(page.locator('.task-card-assigned time')).toHaveAttribute('datetime', '2026-10-06T14:30:00.000Z');
  await expect(page.locator('.task-card-assigned')).toContainText('Assigned');
  await page.locator('[data-task-owner-filter=created]').click();
  await expect(page.locator('.task-card-assigned time')).toHaveAttribute('datetime', '2026-10-06T14:30:00.000Z');
  await page.evaluate(() => {state.eventsByTask.clear(); renderTasks();});
  await expect(page.locator('.task-card-assigned')).toContainText('Created');
  await expect(page.locator('.task-card-assigned')).toHaveAttribute('title', /Assignment date not recorded/);
});

test('filters have three primary controls and keep team oversight collapsed', async t => {
  const page = await open(t);
  await page.getByRole('button', {name: 'Filters', exact: true}).click();
  const filters = page.locator('#task-filters-panel');
  await expect(filters.getByRole('combobox')).toHaveCount(3);
  await expect(page.locator('#team-task-scope')).toBeHidden();
  await expect(page.getByRole('button', {name: 'Refresh tasks', exact: true})).toHaveCount(1);
  await filters.getByLabel('Source', {exact: true}).selectOption('order');
  await expect(page.locator('.team-task-card')).toHaveCount(0);
  await filters.getByLabel('Read status', {exact: true}).selectOption('unread');
  await expect(page.locator('#task-filter-count')).toHaveText('2');
  await filters.getByRole('button', {name: 'Reset filters', exact: true}).click();
  await expect(filters.getByLabel('Source', {exact: true})).toHaveValue('all');
  await expect(filters.getByLabel('Read status', {exact: true})).toHaveValue('all');
  await expect(page.locator('[data-task-owner-filter=assigned]')).toHaveAttribute('aria-pressed', 'true');
  await filters.getByText('Team oversight', {exact: true}).click();
  await expect(page.locator('#team-task-scope')).toBeVisible();
  await expect(page.locator('#team-task-worker-view')).toBeVisible();
});

test('pending order links target the order queue, while closed orders keep their history link', async t => {
  const page = await open(t);
  const links = await page.evaluate(() => {
    const task = {id: 'task-123', order_id: 'order-1', ebay_orders: {order_number: '20-15235-74943'}};
    return [normalizeOrderTask(task).actionHref, normalizeOrderTask({...task, metadata: {source: 'order_history'}}).actionHref];
  });
  assert.equal(links[0], 'pending-orders.html?orderTaskId=task-123#orders-list');
  assert.match(links[1], /^ebay-order-history.html\?historySearch=20-15235-74943/);
});

async function replyFixture(page, source='team') {
  await page.evaluate(source => {
    state.assignees.forEach(employee => {employee.display_name = employee.name; employee.active = true;});
    const task = {...state.tasks[0], source, status:'waiting_on_admin', task_type:source==='order'?'coordination':'general',
      assigned_by:'teammate', assigned_by_email:'sandra@example.test', created_by:'teammate', created_by_email:'sandra@example.test'};
    state.tasks=[task];state.taskEvidenceLoads.set(getUnifiedTaskKey(task),{status:'ready'});
    state.eventsByTask.clear(); loadTasks=async()=>renderTasks(); renderTasks();
  },source);
  await page.locator('[data-team-task-toggle]').click();
}

for(const width of [320,390,1366]) test(`reply and handoff form is clear and fits at ${width}px`,async t=>{
  const page=await open(t,width,{admin:false});await replyFixture(page);
  await page.getByRole('button',{name:'Reply / Add update',exact:true}).click();
  await expect(page.getByRole('radio',{name:/Just an update/})).toBeChecked();
  await expect(page.locator('#task-response-summary')).toContainText('Alex stays responsible');
  await expect(page.locator('#team-task-assignee')).toBeHidden();await expect(page.locator('.task-attachments')).toBeHidden();
  await page.getByRole('radio',{name:/Hand back to assigner/}).check();
  await expect(page.locator('#task-response-summary')).toContainText('Sandra will be responsible next');
  await expect(page.getByRole('button',{name:'Send & hand back'})).toBeVisible();
  await page.locator('#team-task-note').fill('Please locate the CGL certificate and attach a photo so I can continue.');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  if(width===390)await page.screenshot({path:'test-results/task-reply-handoff-phone.png'});
  if(width===1366)await page.screenshot({path:'test-results/task-reply-handoff-desktop.png'});
  await page.keyboard.press('Escape');await expect(page.locator('#team-task-modal')).toBeHidden();
  assert.deepEqual(await page.evaluate(()=>writes),[]);
  await page.locator('[data-team-task-progress]').click();
  await expect(page.locator('#task-response-options')).toBeHidden();
  await expect(page.locator('.task-attachments')).toBeVisible();
});

for(const source of ['team','order','return'])test(`${source} replies send a note only; handoff explicitly changes responsibility`,async t=>{
  const page=await open(t,390,{admin:false});await replyFixture(page,source);
  await page.getByRole('button',{name:'Reply / Add update',exact:true}).click();
  await page.getByRole('button',{name:'Send update',exact:true}).click();
  await expect(page.locator('#team-task-modal-error')).toContainText('Write an update');
  await page.locator('#team-task-note').fill('I checked the order and still need the certificate.');
  await page.getByRole('button',{name:'Send update',exact:true}).click();
  await expect(page.locator('#team-task-modal')).toBeHidden();
  let writes=await page.evaluate(()=>window.writes);
  assert.equal(writes.length,1);assert.equal(writes[0][0],'reply_to_task');
  assert.deepEqual(writes[0][1],{_task_source:source,_task_id:'task-0',_note:'I checked the order and still need the certificate.',_request_action:false,_expected_assignee:'me',_expected_assigner:'teammate'});
  await page.getByRole('button',{name:'Hand back to assigner',exact:true}).click();
  await page.locator('#team-task-note').fill('Please locate the certificate so I can continue.');
  await page.evaluate(()=>{supabase.rpc=async(...args)=>{writes.push(args);const task=state.tasks[0];task.assigned_to_user_id='teammate';task.assigned_to_email='sandra@example.test';task.assigned_by='me';task.assigned_by_email='alex@example.test';task.status='assigned';return {data:{},error:null};};});
  await page.getByRole('button',{name:'Send & hand back',exact:true}).click();
  await expect(page.locator('#team-task-modal')).toBeHidden();
  await expect(page.locator('[data-task-owner-filter=created]')).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.team-task-card')).toHaveCount(1);
  await expect(page.locator('.task-card-owner')).toContainText('Sandra');
  writes=await page.evaluate(()=>window.writes);assert.equal(writes.length,2);assert.equal(writes[1][1]._request_action,true);
});

test('failed reply keeps the draft and owner; completion review cannot be handed off',async t=>{
  const page=await open(t,390,{admin:false});await replyFixture(page);
  await page.getByRole('button',{name:'Hand back to assigner',exact:true}).click();
  await page.locator('#team-task-note').fill('Need the certificate.');
  await page.evaluate(()=>{supabase.rpc=async()=>({error:{message:'The assignment changed. Refresh the task before replying.'}});});
  await page.getByRole('button',{name:'Send & hand back',exact:true}).click();
  await expect(page.locator('#team-task-modal-error')).toContainText('assignment changed');
  await expect(page.locator('#team-task-note')).toHaveValue('Need the certificate.');
  assert.equal(await page.evaluate(()=>state.tasks[0].assigned_to_user_id),'me');
  await page.keyboard.press('Escape');
  await page.evaluate(()=>{state.tasks[0].status='completed_by_employee';renderTasks();});
  await expect(page.getByRole('button',{name:'Hand back to assigner',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:'Reply / Add update',exact:true}).click();
  await expect(page.locator('#task-response-handoff-option')).toBeHidden();
});
