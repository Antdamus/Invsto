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
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => { await browser?.close(); await new Promise(resolve => {server.close(resolve); server.closeAllConnections();}); });

async function open(t, {width = 390, admin = false} = {}) {
  const context = await browser.newContext({viewport: {width, height: 844}, hasTouch: true});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(7000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin + '/pending-orders.html');
  await page.addScriptTag({url: origin + '/pending-orders.js'});
  await page.evaluate(admin => {
    state.user = {id: 'worker', email: 'worker@example.test'};
    state.employee = {role: admin ? 'admin' : 'employee', active: true};
    isAdminUser = () => admin;
    state.stores = [{id: 'main', name: 'Main Store'}]; state.checkoutStoreId = 'main';
    window.databaseWrites = [];
    window.supabase = {rpc: async (name, args) => {databaseWrites.push({name, args}); throw Error('Unexpected write');}};
    const note = 'Missing the silver bracelet.\nThe gold chain is ready in tray 4. Check the clasp before packing.';
    state.orders = Array.from({length: 8}, (_, i) => ({
      id: `line-${i}`, order_id: `order-${i}`, item_title: i === 0 ? 'Sterling silver bracelet with a heart charm' : 'Gold chain, 18 inch',
      item_number: `12345678901${i}`, line_status: 'pending', quantity: 1, fulfilled_quantity: 0,
      video_receipt_photo_count: i === 1 ? 0 : 1, total_price: 89, sold_for: 89,
      order: {id: `order-${i}`, order_number: `11-22222-3333${i}`, buyer_username: i < 2 ? 'jewelrylover_28' : `buyer_${i}`,
        buyer_name: i < 2 ? 'Olivia Bennett' : `Customer ${i}`, sale_date: i < 2 ? '2026-09-30T12:00:00Z' : '2026-10-01T12:00:00Z', ship_by_date: '2026-10-02T12:00:00Z'}
    }));
    state.orders = state.orders.map(normalizeLine);
    state.orders.forEach((line, i) => {
      const tasks = [{id: `task-${i}`, order_id: line.order_id, order_line_ids: [line.id], status: 'resolved', metadata: {source: 'pending_order_line_note'}}];
      const events = i === 0 ? [{id: `event-${i}`, task_id: `task-${i}`, order_id: line.order_id,
        notes: note, signed_by_email: 'sandra@example.test', created_at: '2026-10-05T14:00:00Z', payload: {order_line_id: line.id}}] : i === 1 ? [{id: 'event-second', task_id: 'task-1', order_id: line.order_id,
        notes: 'Still waiting for the receipt screenshot for the chain.', signed_by_email: 'alex@example.test', created_at: '2026-10-04T14:00:00Z', payload: {order_line_id: line.id}}] : [];
      const data = {tasks, events}; state.sharedOrderNoteHistory.set(line.order_id, {data, promise: Promise.resolve(data)});
      state.queueVideoReceiptLoadedOrderIds.add(line.order_id);
    });
    watchQueueCompletionPhotos = watchQueueShippingLabels = scheduleQueueVideoReceiptEvidenceHydration = () => {};
    loadSelectedOrderTasks = hydrateSelectedOrderDetails = async () => {};
    hydrateNoInventoryVideoReceiptEvidenceThumbnails = loadNoInventoryCaptureStations = async () => {};
    captureAuditLocation = async () => ({status: 'not_available'});
    loadOrders = async () => applyOrderFilters();
    setupListeners(); renderCheckoutStoreSelect(); applyOrderFilters();
    if (admin) document.getElementById('admin-order-actions-panel').classList.remove('hidden');
  }, admin);
  await page.addScriptTag({url: origin + '/pending-orders-mobile.js'});
  await page.addScriptTag({url: origin + '/admin-nav.js'});
  await page.evaluate(admin => OGRoleNavigation.render(admin ? 'admin' : 'worker'), admin);
  await expect(page.locator('.buyer-order-card')).toHaveCount(7);
  return page;
}

for (const width of [320, 390, 430, 760]) {
  test(`${width}px: queue comes first, all notes are readable, tools and expanded cards fit`, async t => {
    const page = await open(t, {width});
    await expect(page.locator('.mobile-header')).toBeHidden();
    await expect(page.locator('.phone-orders-header')).toBeVisible();
    const card = page.locator('.buyer-order-card').first();
    const box = await card.boundingBox(); assert.ok(box.y < 520, `first buyer remains on the first screen below the action bar: ${box.y}px`);
    await expect(card.locator('.buyer-card-note-body p')).toHaveCount(2);
    await expect(card.locator('.buyer-card-note-body p').first()).toBeVisible();
    assert.match(await card.innerText(), /Missing the silver bracelet/);
    assert.match(await card.innerText(), /Still waiting for the receipt screenshot/);
    assert.equal(await card.locator('.buyer-card-note-details').evaluate(el => getComputedStyle(el).maxHeight), 'none');
    await expect(page.locator('[data-phone-count=all]')).toHaveText('7');
    const overflow = () => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(await overflow(), false);
    if (width === 390) await page.screenshot({path: 'test-results/pending-mobile-queue.png'});
    await card.locator('[data-buyer-expand-key]').click();
    await expect(page.locator('.phone-line-actions')).toHaveCount(2);
    await expect(page.locator('[data-line-cancel]').first()).toBeHidden();
    await page.locator('.phone-line-actions button').nth(1).click();
    await expect(page.locator('[data-line-cancel]').first()).toBeVisible();
    assert.equal(await overflow(), false);
    await page.locator('#phone-orders-tools').click();
    await expect(page.locator('#checkout-store-select')).toBeVisible();
    await expect(page.locator('#admin-order-actions-panel')).toBeHidden();
    assert.equal(await overflow(), false);
    await page.locator('#phone-close-packing-tools').click();
  });
}

test('filters work, navigation opens, and desktop restores the original tools', async t => {
  const page = await open(t, {admin: true});
  await page.locator('#phone-orders-menu').click();
  await expect(page.locator('#mobile-menu')).toBeVisible();
  await page.locator('#phone-orders-menu').click();
  await expect(page.locator('#mobile-menu')).toBeHidden();
  await expect(page.locator('#order-sort')).toBeHidden();
  await page.locator('#phone-order-filters').click();
  await expect(page.locator('#order-sort')).toBeVisible();
  await page.locator('#order-search').fill('jewelrylover_28');
  await expect(page.locator('.buyer-order-card')).toHaveCount(1);
  await page.locator('#phone-orders-tools').click();
  await expect(page.locator('#admin-order-actions-panel')).toBeVisible();
  await page.setViewportSize({width: 1280, height: 900});
  await expect(page.locator('#phone-packing-tools-modal')).toBeHidden();
  await expect(page.locator('.pending-content > .fulfillment-utility-strip')).toBeVisible();
  await expect(page.locator('.phone-orders-header')).toBeHidden();
  await expect(page.locator('.buyer-card-note-details')).toBeHidden();
  await expect(page.locator('#phone-checkout-dock')).toBeHidden();
});

test('packing opens without the keyboard, back preserves the staged bundle, resume and review do not submit', async t => {
  const page = await open(t);
  await page.locator('[data-buyer-expand-key]').first().click();
  await page.locator('[data-buyer-complete-key]').first().click();
  await expect(page.locator('#fulfillment-workflow')).toBeVisible();
  assert.notEqual(await page.evaluate(() => document.activeElement.id), 'item-scan');
  await page.evaluate(() => {
    state.stagedFulfillments.set('line-0', {line: state.orders[0], item: {title: state.orders[0].item_title}, mode: 'without_inventory', qty: 1, row: {locationLabel: 'Without inventory'}});
    renderBuyerBundlePanel();
  });
  await expect(page.locator('#phone-checkout-count')).toHaveText('1 item staged');
  await page.locator('#close-mobile-order-detail').click();
  await expect(page.locator('#fulfillment-workflow')).toBeHidden();
  assert.equal(await page.evaluate(() => state.stagedFulfillments.size), 1);
  await expect(page.locator('#phone-review-checkout')).toHaveText('Resume packing →');
  await page.locator('#phone-review-checkout').click();
  await expect(page.locator('#fulfillment-workflow')).toBeVisible();
  await page.screenshot({path: 'test-results/pending-mobile-checkout.png'});
  await page.locator('#phone-review-checkout').click();
  await expect(page.locator('#bundle-review-modal')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => databaseWrites), []);
  await page.locator('#cancel-bundle-review').click();
  assert.equal(await page.evaluate(() => state.stagedFulfillments.size), 1);
});

test('no-inventory review keeps screenshot eligibility and fits the phone', async t => {
  const page = await open(t);
  await page.locator('[data-buyer-expand-key]').first().click();
  await page.locator('[data-buyer-no-inventory-key]').first().click();
  await expect(page.locator('#worker-no-inventory-modal')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => [...state.workerNoInventoryLineIds]), ['line-0']);
  await expect(page.locator('[data-no-inventory-line="line-1"]')).not.toBeChecked();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({path: 'test-results/pending-mobile-no-inventory.png'});
  assert.deepEqual(await page.evaluate(() => databaseWrites), []);
});

test('missing checkout store opens tools and choosing the store enables packing', async t => {
  const page = await open(t);
  await page.evaluate(() => {state.checkoutStoreId = ''; renderCheckoutStoreSelect();});
  await page.locator('[data-buyer-expand-key]').first().click();
  await page.locator('[data-buyer-complete-key]').first().click();
  await expect(page.locator('#phone-packing-tools-modal')).toBeVisible();
  await page.locator('#checkout-store-select').selectOption('main');
  await page.locator('#phone-close-packing-tools').click();
  await expect(page.locator('#fulfillment-workflow')).toBeVisible();
  await expect(page.locator('#phone-review-checkout')).toHaveText('Find an item →');
  await page.locator('#phone-review-checkout').click();
  await expect(page.locator('#item-scan')).toBeFocused();
  assert.deepEqual(await page.evaluate(() => databaseWrites), []);
});
