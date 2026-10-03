import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, expect} from '@playwright/test';

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
  browser = await chromium.launch();
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
      async rpc(name, args) {
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

test('collapsed blocks reveal all authors and timestamps on hover, and expand independently of the order', async t => {
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
  await expect(details).toBeVisible();
  assert.match(await details.innerText(), /maria@example.com[\s\S]*Oct 3[\s\S]*9:30 AM/);
  assert.match(await details.innerText(), /alex@example.com[\s\S]*Oct 2[\s\S]*2:15 PM/);
  assert.match(await details.innerText(), /Gift wrap is ready <keep this text>/);
  assert.equal(await details.locator('keep').count(), 0);
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
  await page.screenshot({path: 'test-results/pending-notes-hover.png'});
  await toggle.click();
  await page.mouse.move(0, 0);
  assert.equal(await details.isVisible(), true);
  assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
  assert.equal(await card.locator('.buyer-card-expanded').count(), 0);
  await toggle.click();
  await page.mouse.move(0, 0);
  assert.equal(await details.isVisible(), false);
  assert.ok((await page.evaluate(() => calls)).every(call => call.filters.every(([key]) => key === 'order_id')));
});

test('phone users can tap to expand and collapse notes without opening the order or overflowing', async t => {
  const page = await open(t, {mobile: true});
  await loaded(page);
  const toggle = page.locator('.buyer-card-notes-toggle');
  await toggle.tap();
  const details = page.locator('.buyer-card-note-details');
  await expect(details).toBeVisible();
  assert.match(await details.innerText(), /alex@example.com/);
  const box = await details.boundingBox();
  assert.ok(box.x >= 0 && box.x + box.width <= 390, JSON.stringify(box));
  assert.equal(await page.locator('.buyer-card-expanded').count(), 0);
  await details.scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await page.screenshot({path: 'test-results/pending-notes-mobile.png'});
  await toggle.tap();
  assert.equal(await details.isVisible(), false);
});

test('resolved and order-wide notes are shared, deduplicated, and scoped to their lines', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => {
    tasks.push({id: 'order-task', order_id: 'order-a', order_line_ids: [], status: 'resolved'});
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
  const popup = await page.locator('.buyer-card-note-details').boundingBox();
  assert.ok(popup.y >= 0 && popup.y + popup.height <= 900, JSON.stringify(popup));
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

test('failed history reads preserve the preview and retry loads all notes', async t => {
  const page = await open(t, {render: false});
  await page.evaluate(() => { failNotes = true; renderOrders(); });
  await page.locator('.buyer-order-card').scrollIntoViewIfNeeded();
  await page.locator('[data-retry-group-notes]').waitFor();
  assert.match(await page.locator('.buyer-card-notes-toggle').innerText(), /Gift wrap/);
  await page.evaluate(() => { failNotes = false; });
  await page.locator('[data-retry-group-notes]').click();
  await loaded(page);
  assert.equal(await page.locator('[data-retry-group-notes]').count(), 0);
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
