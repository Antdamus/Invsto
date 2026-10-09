import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
let server, browser, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) return res.writeHead(404).end();
    try {
      let content = await readFile(new URL(name, root));
      if (name.endsWith('.html')) content = content.toString().replace(/<script\b[\s\S]*?<\/script>/gi, '');
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await (process.env.INVSTO_ITEM_BROWSER === 'webkit' ? webkit : chromium).launch();
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});

async function open(t, {mobile = false, render = true} = {}) {
  const context = await browser.newContext({viewport: {width: mobile ? 390 : 1440, height: 900},
    isMobile: mobile, hasTouch: mobile, timezoneId: 'America/New_York'});
  t.after(() => context.close());
  await context.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/pending-orders.html`);
  await page.addScriptTag({url: `${origin}/pending-orders.js`});
  await page.evaluate(() => {
    window.calls = [];
    window.failNotes = false;
    window.noteDelay = 0;
    window.customerTasks = [];
    window.customerCalls = [];
    window.failCustomerTasks = false;
    window.tasks = [{id: 'notes-a', order_id: 'order-a', order_line_ids: ['line-a'], status: 'resolved',
      created_by: 'user-other', metadata: {source: 'pending_order_line_note', hidden_from_task_board: true}}];
    window.events = [
      {id: 'event-a', task_id: 'notes-a', order_id: 'order-a', notes: 'Use the blue box.\nCustomer requested a gift.',
        signed_by: 'user-other', signed_by_email: 'alex@example.com', created_at: '2026-10-02T18:15:00Z', payload: {order_line_id: 'line-a'}},
      {id: 'event-b', task_id: 'notes-a', order_id: 'order-a', notes: 'Gift wrap is ready <keep this text>.',
        signed_by: 'user-third', signed_by_email: 'maria@example.com', created_at: '2026-10-03T13:30:00Z', payload: {order_line_id: 'line-a'}},
    ];
    window.line = {id: 'line-a', order_id: 'order-a', item_title: 'Gold chain', item_number: '123456789012',
      line_status: 'pending', quantity: 1, fulfilled_quantity: 0, total_price: 1485,
      line_note_count: 2, latest_line_note: events[1].notes,
      order: {order_number: '11-22222-33333', buyer_username: 'lore2526', buyer_name: 'Lorena Hernandez',
        created_at: '2026-10-02T20:58:00Z', ship_by_date: '2026-10-07T06:59:00Z'}};
    window.supabase = {
      from(table) {
        const filters = [], orders = [];
        let start = 0, end = Infinity;
        const query = {
          select() { return query; },
          eq(key, value) { filters.push([key, value]); return query; },
          order(key, options) { orders.push([key, options.ascending]); return query; },
          range(a, b) { start = a; end = b; return query; },
          async then(resolve, reject) {
            try {
              calls.push({table, filters, start, end});
              const rows = structuredClone(table === 'ebay_order_tasks' ? tasks : events)
                .filter(row => filters.every(([key, value]) => row[key] === value));
              rows.sort((a, b) => {
                for (const [key, asc] of orders) {
                  const compared = String(a[key] || '').localeCompare(String(b[key] || ''));
                  if (compared) return asc ? compared : -compared;
                }
                return 0;
              });
              if (noteDelay) await new Promise(r => setTimeout(r, noteDelay));
              resolve(failNotes ? {error: {message: 'Notes unavailable'}} : {data: rows.slice(start, end + 1)});
            } catch (error) { reject(error); }
          },
        };
        return query;
      },
      rpc(name, args) {
        if (name === 'list_pending_customer_task_notes') return {async range(start, end) {
          customerCalls.push({buyers: args._buyers, start, end});
          return failCustomerTasks ? {error: {message: 'Customer tasks unavailable'}} :
            {data: customerTasks.filter(task => args._buyers.includes(task.buyer_username)).slice(start, end + 1)};
        }};
        assertNoteRpc(name);
        events.push({id: 'event-new', task_id: 'notes-a', order_id: 'order-a', notes: args._note,
          signed_by: state.user.id, signed_by_email: args._signed_by_email, created_at: '2026-10-03T16:00:00Z',
          payload: {order_line_id: args._order_line_id}, photo_attachments: args._photo_attachments});
        return {data: events.at(-1)};
      },
    };
    window.assertNoteRpc = name => { if (name !== 'add_pending_order_line_note') throw Error(`Unexpected RPC ${name}`); };
    scheduleQueueVideoReceiptEvidenceHydration = () => {};
    state.user = {id: 'user-current', email: 'sam@example.com'};
    state.employee = {active: true, role: 'employee'};
    state.orders = [line];
    state.filteredOrders = [line];
    document.getElementById('close-line-note').onclick = closeLineNoteModal;
    document.getElementById('save-line-note').onclick = saveLineNote;
    document.getElementById('refresh-line-note-history').onclick = loadLineNoteHistory;
  });
  if (render) await page.evaluate(() => renderOrders());
  return page;
}

async function loaded(page, count = 2) {
  await page.locator('.buyer-order-card').first().scrollIntoViewIfNeeded();
  await page.waitForFunction(count => document.querySelectorAll('[data-buyer-shared-notes] .buyer-card-note-preview-item').length === count
    && document.querySelector('[data-buyer-shared-notes]')?.textContent.includes('alex@example.com'), count);
}

test('notes expand only on click and show all authors and timestamps without opening the order', async t => {
  const page = await open(t);
  await loaded(page);
  const card = page.locator('.buyer-order-card');
  const toggle = card.locator('.buyer-card-notes-toggle');
  const details = card.locator('.buyer-card-note-details');
  await page.mouse.move(0, 0);
  assert.equal(await details.isVisible(), false);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.match(await toggle.innerText(), /2 notes.*Gift wrap/s);
  await toggle.hover();
  await expect(details).toBeHidden();
  await toggle.click();
  await expect(details).toBeVisible();
  assert.match(await details.innerText(), /maria@example.com[\s\S]*Oct 3[\s\S]*9:30 AM/);
  assert.match(await details.innerText(), /alex@example.com[\s\S]*Oct 2[\s\S]*2:15 PM/);
  assert.match(await details.innerText(), /Gift wrap is ready <keep this text>/);
  assert.equal(await details.locator('keep').count(), 0);
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
  await page.screenshot({path: 'test-results/pending-notes-expanded.png'});
  await page.mouse.move(0, 0);
  assert.equal(await details.isVisible(), true);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await card.locator('.buyer-card-expanded').count(), 0);
  await toggle.click();
  await page.mouse.move(0, 0);
  assert.equal(await details.isVisible(), false);
  assert.ok((await page.evaluate(() => calls)).every(call => call.filters.every(([key]) => key === 'order_id')));
});

test('phone users can read every note in the queue without opening the order or a nested scroll area', async t => {
  const page = await open(t, {mobile: true});
  await loaded(page);
  const toggle = page.locator('.buyer-card-notes-toggle');
  assert.equal(await toggle.isVisible(), false);
  const details = page.locator('.buyer-card-note-details');
  await expect(details).toBeVisible();
  assert.match(await details.innerText(), /alex@example.com/);
  const box = await details.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  assert.equal(await page.locator('.buyer-card-expanded').count(), 0);
  await details.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({path: 'test-results/pending-notes-mobile.png'});
  assert.equal(await details.evaluate(el => getComputedStyle(el).maxHeight), 'none');
  assert.equal(await details.evaluate(el => getComputedStyle(el).overflowY), 'visible');
  assert.match(await details.innerText(), /Use the blue box/);
});

test('written notes remain shared, deduplicated, and scoped to their lines', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => {
    tasks.push({id: 'order-task', order_id: 'order-a', order_line_ids: [], status: 'resolved', metadata: {source: 'pending_order_line_note'}});
    tasks.push({id: 'removed', order_id: 'order-a', order_line_ids: [], metadata: {history_removed_at: '2026-10-03'}});
    events.push({id: 'order-note', task_id: 'order-task', order_id: 'order-a', notes: 'Combine this shipment', signed_by_email: 'lee@example.com'});
    events.push({id: 'sibling-note', task_id: 'order-task', order_id: 'order-a', notes: 'Sibling item only', payload: {order_line_id: 'line-b'}});
    events.push({id: 'removed-note', task_id: 'removed', order_id: 'order-a', notes: 'Removed note'});
    state.orders.push({...line, id: 'line-b', item_title: 'Silver chain', line_note_count: 0, latest_line_note: ''});
    state.filteredOrders = state.orders;
    renderOrders();
  });
  await loaded(page, 4);
  assert.equal(await page.locator('.buyer-card-note-body p', {hasText: 'Combine this shipment'}).count(), 1);
  assert.equal(await page.locator('.buyer-card-note-body p', {hasText: 'Removed note'}).count(), 0);
  await page.evaluate(() => openLineNoteModal('line-a', {focusInput: false}));
  await page.waitForFunction(() => document.getElementById('line-note-history').getAttribute('aria-busy') === 'false');
  const history = await page.locator('#line-note-history').innerText();
  assert.match(history, /Combine this shipment/);
  assert.doesNotMatch(history, /Sibling item only|Removed note/);
});

test('notes also appear when queue counters are missing, and history is not capped at one API page', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => {
    line.line_note_count = 0;
    line.latest_line_note = '';
    for (let i = 0; i < 505; i++) events.push({...events[0], id: `older-${i}`, notes: `Older note ${i}`});
    renderOrders();
  });
  await page.locator('.buyer-order-card').scrollIntoViewIfNeeded();
  await loaded(page, 507);
  assert.ok((await page.evaluate(() => calls)).some(call => call.table === 'ebay_order_task_events' && call.start === 500));
  await page.locator('.buyer-card-notes-toggle').hover();
  await expect(page.locator('.buyer-card-note-details')).toBeHidden();
  await page.mouse.move(0, 0);
  await page.locator('.buyer-card-notes-toggle').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.buyer-card-note-details')).toBeVisible();
});

test('saving another user note refreshes the block without losing earlier notes', async t => {
  const page = await open(t);
  await loaded(page);
  await page.evaluate(() => openLineNoteModal('line-a'));
  await page.locator('#line-note-text').fill('Sam checked the clasp.');
  await page.locator('#save-line-note').click();
  await page.locator('#line-note-modal').waitFor({state: 'hidden'});
  await loaded(page, 3);
  assert.match(await page.locator('.buyer-card-notes-toggle').innerText(), /Sam checked the clasp/);
  await page.locator('.buyer-card-notes-toggle').click();
  assert.match(await page.locator('.buyer-card-note-details').innerText(), /sam@example.com/);
  assert.match(await page.locator('.buyer-card-note-details').innerText(), /alex@example.com/);
});

test('failed history reads do not expose unfiltered queue summaries and retry loads written notes', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => { failNotes = true; renderOrders(); });
  await page.locator('.buyer-order-card').scrollIntoViewIfNeeded();
  await page.locator('[data-retry-group-notes]').waitFor();
  assert.equal(await page.locator('.buyer-card-notes-toggle').count(), 0);
  await page.evaluate(() => { failNotes = false; });
  await page.locator('[data-retry-group-notes]').click();
  await loaded(page);
  assert.equal(await page.locator('[data-retry-group-notes]').count(), 0);
});

test('written note counts exclude media uploads and unassigned task events', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => {
    const base = {task_id: 'notes-a', order_id: 'order-a', action: 'commented', signed_by_email: 'alex@example.com',
      created_at: '2026-10-03T18:00:00Z', payload: {source: 'pending_order_line_note', order_line_id: 'line-a'}};
    events.push({...base, id: 'note-photo', notes: 'Check this clasp photo.',
      photo_attachments: [{path: 'line-notes/photo.png', metadata: {source: 'pending_order_line_note'}}]});
    events.push({...base, id: 'note-about-receipt', notes: 'Screenshot looks correct; use the blue box.'});
    events.push({...base, id: 'receipt', notes: 'Video receipt screenshot uploaded for eBay item 123.\nReceived image',
      photo_attachments: [{path: 'video-receipts/manual/receipt.png', metadata: {source: 'manual_video_receipt_screenshot'}}]});
    events.push({...base, id: 'video', notes: 'Video evidence added manually for eBay item 123.\nPacking video',
      photo_attachments: [{path: 'standalone-order-evidence/manual/clip.mp4', metadata: {source: 'standalone_order_evidence'}}]});
    events.push({...base, id: 'deleted-receipt', notes: 'Video receipt screenshot uploaded for eBay item 123.\nRemoved mistaken capture', photo_attachments: []});
    tasks.push({id: 'coordination', order_id: 'order-a', order_line_ids: ['line-a'], status: 'resolved'});
    events.push({...base, id: 'task-update', task_id: 'coordination', notes: 'Task progress update', payload: {source: 'pending_orders'}});
    events.push({...base, id: 'attachment-only', notes: '', photo_attachments: [{path: 'line-notes/photo.png'}]});
    line.latest_line_note = 'Video receipt screenshot uploaded for eBay item 123.\nReceived image';
    line.line_note_count = 99;
    state.expandedBuyerKeys.add(getBuyerKey(line));
    renderOrders();
  });
  // Unfiltered latest-note text must never flash while history is loading.
  assert.doesNotMatch(await page.locator('.buyer-order-card').textContent(), /Video receipt screenshot uploaded|99 notes/);
  await loaded(page, 4);
  await page.locator('.buyer-card-notes-toggle').click();
  const notes = await page.locator('.buyer-card-note-details').innerText();
  assert.match(notes, /Check this clasp photo/);
  assert.match(notes, /Screenshot looks correct/);
  assert.doesNotMatch(notes, /uploaded for|evidence added manually|Task progress update|Removed mistaken/);
  assert.equal(await page.locator('[data-line-view-notes]').innerText(), 'View 4 notes');
  assert.doesNotMatch(await page.locator('.buyer-line-note-preview').innerText(), /uploaded for|evidence added manually/);
  await page.locator('[data-line-view-notes]').click();
  await page.waitForFunction(() => document.getElementById('line-note-history').getAttribute('aria-busy') === 'false');
  assert.equal(await page.locator('#line-note-history .order-task-event').count(), 4);
  assert.doesNotMatch(await page.locator('#line-note-history').innerText(), /uploaded for|evidence added manually|Task progress update/);
});

test('orders containing only media uploads have no notes preview or note count', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => {
    events = [{...events[0], notes: 'Video receipt screenshot uploaded for eBay item 123.\nReceipt proof',
      photo_attachments: [{metadata: {source: 'manual_video_receipt_screenshot'}}]}];
    line.latest_line_note = events[0].notes;
    state.expandedBuyerKeys.add(getBuyerKey(line));
    renderOrders();
  });
  await page.locator('.buyer-order-card').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => state.sharedOrderNoteHistory.get('order-a')?.data);
  assert.equal(await page.locator('.buyer-card-notes-toggle, [data-line-view-notes], .buyer-line-note-preview').count(), 0);
  await page.locator('[data-line-add-note]').click();
  await page.waitForFunction(() => document.getElementById('line-note-history').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#line-note-history').innerText(), /No notes yet/);
});

test('a late history response cannot overwrite a newly opened item', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => {
    state.orders.push({...line, id: 'other-line', order_id: 'other-order'});
    noteDelay = 150;
    openLineNoteModal('line-a', {focusInput: false});
    closeLineNoteModal();
    openLineNoteModal('other-line', {focusInput: false});
  });
  await page.waitForFunction(() => document.getElementById('line-note-history').getAttribute('aria-busy') === 'false');
  assert.match(await page.locator('#line-note-history').innerText(), /No notes yet/);
  assert.doesNotMatch(await page.locator('#line-note-history').innerText(), /alex@example.com/);
});

async function addAssignedTask(page) {
  await page.evaluate(() => {
    state.orderTaskAssignees = [{user_id: 'jose', display_name: 'Jose Munoz'}, {user_id: 'sandra', display_name: 'Sandra'}];
    tasks.push({id: 'assigned-task', order_id: 'order-a', order_line_ids: ['line-a'], status: 'waiting_on_admin',
      assigned_to_user_id: 'jose', assigned_to_email: 'jose@example.com', created_by_email: 'sandra@example.com',
      question: 'Pending CGL. Customer paid extra for fast shipping.\nPlease check the clasp <before packing>.',
      latest_note: 'Certificate requested. Waiting for the supplier.', created_at: '2026-10-07T15:02:00Z'});
    const photo = {bucket: 'proof', path: 'tasks/clasp.jpg', label: 'Clasp photo', media_type: 'image',
      preview_bucket: 'proof', preview_path: 'tasks/clasp-preview.jpg'};
    events.push({id: 'task-created', task_id: 'assigned-task', order_id: 'order-a', action: 'created',
      notes: tasks.at(-1).question, created_at: tasks.at(-1).created_at, signed_by_email: 'sandra@example.com', photo_attachments: [photo]});
    events.push({id: 'task-reply', task_id: 'assigned-task', order_id: 'order-a', action: 'commented',
      notes: tasks.at(-1).latest_note, created_at: '2026-10-07T16:00:00Z', signed_by_email: 'jose@example.com', photo_attachments: [photo]});
    window.openedTaskPhotos = [];
    openOrderTaskPhoto = async (bucket, path, options) => openedTaskPhotos.push({bucket, path, options});
    renderOrders();
  });
}

for (const width of [320, 390, 1440]) {
  test(`${width}px: assigned tasks and notes are readable together with ownership, dates, updates and photos`, async t => {
    const page = await open(t, {mobile: width < 760, render: false});
    await page.setViewportSize({width, height: 900});
    await addAssignedTask(page);
    await loaded(page, 3);
    if (width >= 760) await page.locator('.buyer-card-notes-toggle').click();
    const task = page.locator('[data-queue-task="assigned-task"]');
    await expect(task).toBeVisible();
    const text = await task.innerText();
    assert.match(text, /Assigned to Jose Munoz/);
    assert.match(text, /Created Oct 7, 11:02 AM/);
    assert.match(text, /Waiting on admin/);
    assert.match(text, /Pending CGL.*Customer paid extra/s);
    assert.match(text, /<before packing>/);
    assert.equal(await task.locator('before').count(), 0);
    assert.doesNotMatch(text, /Certificate requested|Clasp photo/);
    const compactHeight = (await task.boundingBox()).height;
    assert.ok(compactHeight < (width === 320 ? 260 : 230), `Task preview too tall: ${compactHeight}`);
    await task.locator('summary').click();
    const expandedText = await task.innerText();
    assert.match(expandedText, /Latest update.*Oct 7.*12:00 PM.*jose@example.com/s);
    assert.match(expandedText, /Certificate requested/);
    assert.match(text, /1 file/);
    await expect(task.getByRole('link', {name: 'Open task ↗'})).toHaveAttribute('href', 'team-tasks.html?taskId=assigned-task');
    await task.getByRole('button', {name: 'Clasp photo'}).click();
    const opened = await page.evaluate(() => openedTaskPhotos);
    assert.equal(opened.length, 1);
    assert.equal(opened[0].path, 'tasks/clasp.jpg');
    assert.equal(opened[0].bucket, 'proof');
    assert.equal(await page.locator('.buyer-card-expanded').count(), 0);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    // The same two existing history requests supply both notes and tasks.
    assert.equal((await page.evaluate(() => calls)).length, 2);
    await task.locator('summary').click();
    await task.scrollIntoViewIfNeeded();
    if (width !== 320) await page.screenshot({path: `test-results/pending-notes-tasks-${width}.png`});
  });
}

test('only open tasks appear, scoped and deduplicated across lines with no hidden audit tasks', async t => {
  const page = await open(t, {mobile: true, render: false});
  await page.evaluate(() => {
    const base = {order_id: 'order-a', assigned_to_user_id: 'jose', assigned_to_email: 'jose@example.com',
      created_at: '2026-10-07T15:00:00Z', question: 'Find the missing bracelet', status: 'assigned'};
    tasks.push({...base, id: 'whole-order', order_line_ids: []});
    tasks.push({...base, id: 'multi-line', order_line_ids: ['line-a', 'line-b'], status: 'resolved'});
    tasks.push({...base, id: 'closed-line', order_line_ids: ['line-closed']});
    tasks.push({...base, id: 'hidden', metadata: {hidden_from_task_board: true}});
    tasks.push({...base, id: 'removed', metadata: {history_removed_at: '2026-10-07'}});
    tasks.push({...base, id: 'cancelled', status: 'cancelled'});
    tasks.push({...base, id: 'receipt', title: 'Video receipt screenshot captured'});
    tasks.push({...base, id: 'note-record', metadata: {source: 'pending_order_line_note'}});
    tasks.push({...base, id: 'other-order', order_id: 'order-b'});
    state.orders.push({...line, id: 'line-b', item_title: 'Silver bracelet'});
    state.filteredOrders = state.orders;
    renderOrders();
  });
  await loaded(page, 3);
  assert.deepEqual(await page.locator('[data-queue-task]').evaluateAll(elements => elements.map(el => el.dataset.queueTask).sort()), ['whole-order']);
  assert.doesNotMatch(await page.locator('[data-queue-task="whole-order"]').innerText(), /No attachments/);
  assert.equal((await page.evaluate(() => calls)).length, 2);
});

test('task-only orders show current handoff ownership even without note counters', async t => {
  const page = await open(t, {mobile: true, render: false});
  await page.evaluate(() => { tasks = []; events = []; line.line_note_count = 0; line.latest_line_note = ''; });
  await addAssignedTask(page);
  await page.locator('.buyer-order-card').scrollIntoViewIfNeeded();
  await expect(page.locator('[data-queue-task="assigned-task"]')).toBeVisible();
  await expect(page.locator('.buyer-card-notes-title')).toHaveText('Notes & tasks · 1 task');
  await page.evaluate(async () => {
    tasks[0].assigned_to_user_id = 'sandra'; tasks[0].assigned_to_email = 'sandra@example.com';
    state.sharedOrderNoteHistory.delete('order-a');
    renderOrders();
  });
  await expect(page.locator('[data-queue-task="assigned-task"]')).toContainText('Assigned to Sandra');
  assert.equal(await page.locator('[data-line-view-notes]').count(), 0);
});

test('customer tasks join existing notes once, with compact phone details and exact customer scope', async t => {
  const page = await open(t, {mobile: true, render: false});
  await page.evaluate(() => {
    customerTasks = [
      {id: 'customer-team', source: 'team', buyer_username: 'lore2526', status: 'assigned', question: 'Call the customer before shipping.',
        assigned_to_email: 'sandra@example.com', assignee_name: 'Sandra', created_at: '2026-10-09T13:30:00Z', attachment_count: 3},
      {id: 'old-order-task', source: 'order', order_id: 'previous-order', buyer_username: 'lore2526', status: 'in_progress',
        question: 'Include the replacement clasp.', created_at: '2026-10-08T13:30:00Z'},
      {id: 'different-buyer', source: 'team', buyer_username: 'lore2526-other', status: 'assigned', question: 'Wrong customer'},
    ];
    state.orders.push({...line, id: 'line-b', item_title: 'Silver bracelet'});
    state.filteredOrders = state.orders;
    renderOrders();
  });
  await loaded(page, 4);
  const task = page.locator('[data-queue-task="customer-team"]');
  await expect(task).toContainText('Assigned to Sandra');
  await expect(task).toContainText('Created Oct 9, 9:30 AM');
  assert.equal(await task.locator('details').getAttribute('open'), null);
  assert.ok((await task.boundingBox()).height < 190);
  assert.equal(await page.locator('[data-queue-task="different-buyer"]').count(), 0);
  assert.equal(await page.locator('[data-queue-task="old-order-task"]').count(), 1);
  assert.equal((await page.evaluate(() => customerCalls)).length, 1);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await task.scrollIntoViewIfNeeded();
  await page.screenshot({path: 'test-results/pending-customer-task-notes-mobile.png'});
  await task.locator('summary').click();
  await expect(task.getByRole('link', {name: 'Open task · 3 files ↗'})).toHaveAttribute('href','team-tasks.html?taskId=customer-team');
});

test('customer summaries deduplicate the same order task and retry without losing notes', async t => {
  const page = await open(t, {mobile: true, render: false});
  await page.evaluate(() => { failCustomerTasks = true; });
  await addAssignedTask(page);
  await page.locator('.buyer-order-card').scrollIntoViewIfNeeded();
  await page.locator('[data-retry-group-notes]').waitFor();
  await page.evaluate(() => {
    failCustomerTasks = false;
    customerTasks = [{...tasks.at(-1),source:'order',buyer_username:'lore2526'}];
  });
  await page.locator('[data-retry-group-notes]').click();
  await loaded(page, 3);
  assert.equal(await page.locator('[data-queue-task="assigned-task"]').count(),1);
  await expect(page.locator('[data-retry-group-notes]')).toHaveCount(0);
});

test('an open task for an already packed line stays visible as customer context', async t => {
 const page = await open(t,{mobile:true,render:false});
 await page.evaluate(() => {
  customerTasks = [{id:'packed-item-task',source:'order',order_id:'order-a',order_line_ids:['packed-line'],
   buyer_username:'lore2526',status:'assigned',question:'Call before shipping the remaining items.'}];
  renderOrders();
 });
 await loaded(page,3);
 const task=page.locator('[data-queue-task="packed-item-task"]');
 await expect(task).toContainText('Call before shipping');
 await task.locator('summary').click();
 await expect(task).toContainText('Customer task');
});

test('visible customer lookups batch, paginate and reuse results without loading unrelated customers', async t => {
  const page = await open(t, {render: false});
  const result = await page.evaluate(async () => {
    customerTasks = Array.from({length:501}, (_,i)=>({id:`task-${i}`,source:'team',buyer_username:'lore2526',status:'assigned'}));
    const other = {...line,order:{...line.order,buyer_username:'buyer.two'}};
    await Promise.all([loadCustomerTaskNotes([line]),loadCustomerTaskNotes([other]),loadCustomerTaskNotes([line])]);
    await loadCustomerTaskNotes([line]);
    return {calls:customerCalls,count:state.customerTaskNotes.get('lore2526').data.length};
  });
  assert.equal(result.calls.length,2);
  assert.deepEqual(result.calls[0].buyers,['lore2526','buyer.two']);
  assert.equal(result.calls[1].start,500);
  assert.equal(result.count,501);
});

test('refreshing the cache before the batch starts still settles previous requests', async t => {
  const page = await open(t, {render: false});
  const result = await page.evaluate(async () => {
    const old = loadCustomerTaskNotes([line]);
    state.customerTaskNotes = new Map();
    const current = loadCustomerTaskNotes([line]);
    await Promise.all([old,current]);
    return state.customerTaskNotes.get('lore2526').data;
  });
  assert.deepEqual(result,[]);
});

test('new phone order tasks choose intent and do not inherit an expired shipping deadline',async t=>{
 const page=await open(t,{mobile:true,render:false});
 await page.evaluate(async()=>{
  state.selectedLine=line;state.selectedOrderTasks=[];window.taskWrites=[];
  loadOrderTaskAssignees=async()=>{state.orderTaskAssignees=[{user_id:'admin',role:'admin',display_name:'Jose'}];document.getElementById('order-task-assignee').replaceChildren(new Option('Jose','admin'));};
  loadNoInventoryCaptureStations=async()=>[];persistOrderTaskPhotos=async()=>[];
  loadSelectedOrderTasks=hydrateOrderTaskAssignments=async()=>{};renderOrders=renderSelectedOrderTaskAssignment=()=>{};
  supabase.rpc=async(name,args)=>{taskWrites.push({name,args});return {data:{},error:null};};
  document.getElementById('submit-order-task').onclick=submitOrderTask;
  await openOrderTaskModal();
 });
 await expect(page.locator('#order-task-request-kind input[value=work]')).toBeChecked();
 await expect(page.locator('#order-task-due-at')).toHaveValue('');
 await page.locator('#order-task-request-kind input[value=decision]').check();
 await page.locator('#order-task-note').fill('May we proceed without the video?');
 await page.locator('#order-task-assignee').selectOption('admin');
 await page.locator('#submit-order-task').click();
 await expect(page.locator('#order-task-modal')).toBeHidden();
 const writes=await page.evaluate(()=>taskWrites);assert.equal(writes.length,1);assert.equal(writes[0].name,'create_task_request');
 assert.equal(writes[0].args._request_kind,'decision');assert.equal(writes[0].args._source,'order');assert.equal(writes[0].args._details._due_at,null);
});
