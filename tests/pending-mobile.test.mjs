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
  await page.addScriptTag({url: origin + '/live-sales-report-finances.js'});
  await page.addScriptTag({url: origin + '/pending-orders.js'});
  await page.evaluate(admin => {
    state.user = {id: 'worker', email: 'worker@example.test'};
    state.employee = {role: admin ? 'admin' : 'employee', active: true};
    isAdminUser = () => admin;
    state.stores = [{id: 'main', name: 'Main Store'}]; state.checkoutStoreId = 'main';
    window.databaseWrites = [];
    window.supabase = {rpc: (name, args) => {if (name === 'list_pending_customer_task_notes') return {range: async () => ({data: []})}; databaseWrites.push({name, args}); throw Error('Unexpected write');}};
    const note = 'Missing the silver bracelet.\nThe gold chain is ready in tray 4. Check the clasp before packing.';
    state.orders = Array.from({length: 8}, (_, i) => ({
      id: `line-${i}`, order_id: `order-${i}`, item_title: i === 0 ? 'Sterling silver bracelet with a heart charm' : 'Gold chain, 18 inch',
      item_number: `12345678901${i}`, line_status: 'pending', quantity: 1, fulfilled_quantity: 0,
      video_receipt_photo_count: i === 1 ? 0 : 1, total_price: 89, sold_for: 89, shipping_and_handling: 0,
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

test('phone tracking search keeps its camera visible and finds every matching buyer with partial or prefixed scans', async t => {
  const page = await open(t);
  await page.addScriptTag({url: origin + '/order-tracking-search.js'});
  await page.addScriptTag({url: origin + '/pending-shipment-evidence.js'});
  await page.addScriptTag({url: origin + '/barcode-scanner.js'});
  await page.evaluate(() => {
    state.orders[0].order.tracking_number = '9400108106245736262406';
    state.orders[2].order.label_metadata = {trackingNumbers: ['9400108106245700262406']};
    applyOrderFilters();
  });
  const input = page.locator('#order-search');
  const camera = page.locator('[data-scan-target="order-search"]');
  await expect(camera).toBeVisible();
  await expect(camera).toHaveAttribute('data-scan-mode', 'tracking');
  for (const [scan, count] of [['262406', 2], [']C1420331319400108106245736262406', 1], ['9400 1081 0624 5736 2624 06', 1]]) {
    await input.fill(scan);
    await expect(page.locator('.buyer-order-card')).toHaveCount(count);
  }
  await expect(page.locator('.buyer-order-card')).toContainText('jewelrylover_28');
  await input.fill('262406');
  for (const width of [320, 390, 1440]) {
    await page.setViewportSize({width, height: 844});
    await expect(camera).toBeVisible();
    const buttonBox = await camera.boundingBox(), fieldBox = await input.boundingBox();
    assert.ok(buttonBox.width >= 44 && buttonBox.height >= 44 && buttonBox.x + buttonBox.width <= width);
    assert.ok(fieldBox.height < 100 && Math.abs(buttonBox.y - fieldBox.y) < 12);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (width === 390) await page.screenshot({path: 'test-results/pending-mobile-tracking-search.png'});
  }
  await input.fill('');
  await expect(page.locator('.buyer-order-card')).toHaveCount(7);
  assert.deepEqual(await page.evaluate(() => databaseWrites), []);
});

test('queue summary shows shipping separately and the dollar amount of estimated fees, updating to actual fees', async t => {
  const page = await open(t, {width: 1440, admin: true});
  await expect(page.locator('#summary-pending-value')).toHaveText('$712.00 item sales · before fees');
  await expect(page.locator('#summary-pending-fees')).toHaveText('$670.40 items + shipping after eBay fees · $41.60 of fees estimated');
  await page.evaluate(() => {
    const usd = value => ({value: String(value), currency: 'USD'});
    state.orders.forEach(line => {
      const item = {lineItemId: line.id, lineItemCost: usd(89), total: usd(94), deliveryCost: {shippingCost: usd(5)}, ebayCollectAndRemitTaxes: []};
      line.raw_payload = {line: item};
      line.order.raw_payload = {order: {totalMarketplaceFee: usd(3), lineItems: [item]}};
    });
    renderSummaryStrip();
  });
  await expect(page.locator('#summary-pending-value')).toHaveText('$712.00 item sales · before fees');
  await expect(page.locator('#summary-pending-shipping')).toHaveText('Shipping collected: $40.00');
  await expect(page.locator('#summary-pending-fees')).toHaveText('$728.00 items + shipping after eBay fees');
  await expect(page.locator('.summary-money-disclaimer')).toBeVisible();
  await expect(page.locator('.summary-money-disclaimer')).toContainText('5.5% + $0.30 per order');
  await expect(page.locator('.summary-money-disclaimer')).toContainText('shipping labels, refunds and item costs are not deducted');
  await page.evaluate(() => {
    state.orders.slice(4).forEach(line => delete line.order.raw_payload.order.totalMarketplaceFee);
    renderSummaryStrip();
  });
  await expect(page.locator('#summary-pending-shipping')).toHaveText('Shipping collected: $40.00');
  await expect(page.locator('#summary-pending-fees')).toHaveText('$718.12 items + shipping after eBay fees · $21.88 of fees estimated');
  await expect(page.locator('#summary-overdue-fees')).toHaveText('$718.12 items + shipping after eBay fees · $21.88 of fees estimated');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#summary-strip').screenshot({path: 'test-results/pending-summary-estimated-fees.png'});
  assert.deepEqual(await page.evaluate(() => databaseWrites), []);
});

for (const width of [320, 390, 430, 760]) {
  test(`${width}px: queue comes first, all notes are readable, tools and expanded cards fit`, async t => {
    const page = await open(t, {width});
    await expect(page.locator('.mobile-header')).toBeHidden();
    await expect(page.locator('.phone-orders-header')).toBeVisible();
    const card = page.locator('.buyer-order-card').first();
    await expect(card.locator('[data-buyer-task-key]')).toBeVisible();
    const box = await card.boundingBox();
    const filters = await page.locator('[data-pending-chat-status]').boundingBox();
    assert.ok(box.y < filters.y + filters.height + 60, 'queue follows work/chat filters without packing tools taking over the page');
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
    await expect(page.locator('.buyer-item-tools')).toHaveCount(2);
    const line = card.locator('.buyer-line-btn').first();
    await expect(line.locator('[data-line-assign-task]')).toBeVisible();
    await expect(line.locator('[data-line-complete-order]')).toBeVisible();
    await expect(line.locator('[data-certificate-line]')).toBeVisible();
    await expect(line.locator('.order-chat-link')).toBeVisible();
    const chatUrl = new URL(await line.locator('.order-chat-link').getAttribute('href'), page.url());
    assert.equal(chatUrl.searchParams.get('orderLineId'), await line.getAttribute('data-line-id'));
    assert.equal(chatUrl.searchParams.get('from'), 'pending');
    await expect(line.locator('.order-chat-link')).toHaveAttribute('target', '_blank');
    await expect(page.locator('[data-line-cancel]').first()).toBeHidden();
    await line.locator('.buyer-item-tools > summary').click();
    await expect(page.locator('[data-line-cancel]').first()).toBeVisible();
    await expect(line.locator('[data-item-found]')).toBeVisible();
    await expect(line.locator('[data-item-search]')).toBeVisible();
    await expect(line.locator('[data-upload-receipt-screenshot]')).toBeVisible();
    await card.locator('.buyer-order-tools > summary').click();
    await expect(card.locator('[data-phone-camera=buyer]')).toBeVisible();
    await expect(card.locator('[data-buyer-completion-photos]')).toBeVisible();
    await expect(card.locator('[data-buyer-approval-key]')).toBeVisible();
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
  await expect(page.locator('[data-buyer-select-all]')).toHaveCount(0);
  await page.locator('[data-buyer-expand-key]').click();
  const selectAll = page.locator('[data-buyer-select-all]');
  await expect(selectAll).toBeVisible();
  await selectAll.click();
  await expect(selectAll).toHaveText('Deselect all lines');
  assert.deepEqual(await page.evaluate(() => [...state.adminSelectedLineIds].sort()), ['line-0', 'line-1']);
  await expect(page.locator('#phone-selection-count')).toHaveText('2');
  await selectAll.click();
  assert.deepEqual(await page.evaluate(() => [...state.adminSelectedLineIds]), []);
  await page.locator('#phone-orders-tools').click();
  await expect(page.locator('#admin-order-actions-panel')).toBeVisible();
  await page.setViewportSize({width: 1280, height: 900});
  await expect(page.locator('#phone-packing-tools-modal')).toBeHidden();
  await expect(page.locator('.pending-content > .fulfillment-utility-strip')).toBeVisible();
  await expect(page.locator('.phone-orders-header')).toBeHidden();
  await expect(page.locator('.buyer-card-note-details')).toBeHidden();
  await expect(page.locator('#phone-checkout-dock')).toBeHidden();
});

for (const width of [768, 1024, 1440]) {
  test(`${width}px: grouped card tools are reachable, keyboard accessible, and preserve the expanded buyer`, async t => {
    const page = await open(t, {width, admin: true});
    await page.locator('#order-search').fill('jewelrylover_28');
    const card = page.locator('.buyer-order-card');
    await expect(card.locator('[data-buyer-no-inventory-key]')).toBeVisible();
    await expect(card.locator('[data-buyer-task-key]')).toBeVisible();
    await expect(card.locator('[data-buyer-complete-key]')).toBeVisible();
    await expect(card.locator('[data-buyer-label-key]')).toBeVisible();
    await expect(card.locator('[data-buyer-shipping-labels]')).toBeVisible();
    await expect(card.locator('[data-buyer-select-all]')).toHaveCount(0);
    await expect(card.locator('[data-buyer-completion-photos]')).toBeHidden();
    await card.locator('.buyer-order-tools > summary').press('Enter');
    await expect(card.locator('[data-buyer-completion-photos]')).toBeVisible();
    await expect(card.locator('[data-buyer-expand-key]')).toHaveAttribute('aria-expanded', 'false');
    await card.locator('[data-buyer-completion-photos]').press('Escape');
    await expect(card.locator('.buyer-order-tools > summary')).toBeFocused();
    await expect(card.locator('[data-buyer-completion-photos]')).toBeHidden();
    await card.locator('[data-buyer-expand-key]').click();
    const selectAll = card.locator('.buyer-card-items-heading [data-buyer-select-all]');
    await expect(selectAll).toBeVisible();
    await selectAll.press('Enter');
    await expect(selectAll).toHaveText('Deselect all lines');
    await expect(selectAll).toHaveAttribute('aria-pressed', 'true');
    await expect(selectAll).toBeFocused();
    await expect(card.locator('[data-buyer-expand-key]')).toHaveAttribute('aria-expanded', 'true');
    assert.deepEqual(await page.evaluate(() => [...state.adminSelectedLineIds].sort()), ['line-0', 'line-1']);
    await selectAll.press('Enter');
    assert.deepEqual(await page.evaluate(() => [...state.adminSelectedLineIds]), []);
    const line = card.locator('[data-line-id="line-0"]');
    await expect(line.locator('[data-line-assign-task]')).toBeVisible();
    await expect(line.locator('[data-line-complete-order]')).toBeVisible();
    await expect(line.locator('[data-certificate-line]')).toBeVisible();
    await expect(line.locator('[data-item-found]')).toBeVisible();
    await expect(line.locator('[data-item-search]')).toBeVisible();
    await expect(line.locator('[data-line-cancel]')).toBeHidden();
    await line.locator('.buyer-item-tools > summary').click();
    await expect(line.locator('[data-line-cancel]')).toBeVisible();
    await expect(line.locator('[data-line-pack]')).toBeVisible();
    await card.locator('.buyer-order-tools > summary').click();
    await expect(card.locator('[data-admin-group-select]')).toBeVisible();
    await page.evaluate(() => renderOrders());
    await expect(line.locator('[data-line-cancel]')).toBeVisible();
    await expect(card.locator('[data-buyer-completion-photos]')).toBeVisible();
    await expect(card.locator('[data-buyer-expand-key]')).toHaveAttribute('aria-expanded', 'true');
    await card.locator('[data-admin-group-select]').check();
    assert.deepEqual(await page.evaluate(() => [...state.adminSelectedLineIds].sort()), ['line-0', 'line-1']);
    await card.locator('[data-admin-group-select]').uncheck();
    assert.deepEqual(await page.evaluate(() => [...state.adminSelectedLineIds]), []);
    await line.locator('[data-admin-line-select]').check();
    await expect(selectAll).toHaveAttribute('aria-pressed', 'mixed');
    await selectAll.click();
    await expect(card.locator('[data-admin-group-select]')).toBeChecked();
    assert.deepEqual(await page.evaluate(() => [...state.adminSelectedLineIds].sort()), ['line-0', 'line-1']);
    await selectAll.click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.deepEqual(await page.evaluate(() => databaseWrites), []);
    await card.screenshot({path: `test-results/pending-card-tools-${width}.png`});
    await line.locator('.buyer-item-tools > summary').click();
    await card.locator('.buyer-order-tools > summary').click();
    await card.screenshot({path: `test-results/pending-card-organized-${width}.png`});
  });
}

test('front task, watch and completion actions keep their scope with an existing task and closed tools', async t => {
  const page = await open(t, {width: 390});
  await page.locator('#order-search').fill('jewelrylover_28');
  await page.evaluate(() => {
    window.frontCalls = [];
    openOrderTaskModal = options => frontCalls.push({scope: options.scope, line: state.selectedLine.id});
    const previous = window.supabase.rpc;
    window.supabase.rpc = (name, args) => {
      if (name === 'list_pending_order_work') return {range: async () => ({data: []})};
      if (name === 'set_order_line_watch') return Promise.resolve({data: {order_line_id: args._order_line_id, is_watch: args._is_watch, revision: 1}});
      return previous(name, args);
    };
    window.supabase.from = name => {
      if (name !== 'order_line_watch_flags') throw Error('Unexpected table: ' + name);
      return {select: () => ({in: async () => ({data: []})})};
    };
    rememberOrderTaskAssignment({id:'assigned-task', order_id:'order-0', order_line_ids:['line-0'], status:'assigned', assigned_to_email:'worker@example.test'});
  });
  for (const src of ['pending-watch-flags.js','pending-work-queue.js']) await page.addScriptTag({url: origin + '/' + src});
  await page.evaluate(async () => {await OGPendingWork.load(state.orders, {paint:false}); await OGOrderWatches.load(); OGOrderWatches.start(); renderOrders();});
  const card = page.locator('.buyer-order-card');
  await expect(card.locator('.buyer-card-alerts [data-view-order-task]')).toBeVisible();
  await card.locator('[data-buyer-task-key]').click();
  await expect.poll(() => page.evaluate(() => frontCalls.length)).toBe(1);
  if (await card.locator('[data-buyer-expand-key]').getAttribute('aria-expanded') !== 'true') await card.locator('[data-buyer-expand-key]').click();
  const line = card.locator('[data-line-id="line-0"]');
  await expect(line.locator('[data-line-view-task]')).toBeVisible();
  await line.locator('[data-line-assign-task]').click();
  await expect.poll(() => page.evaluate(() => frontCalls.length)).toBe(2);
  const calls = await page.evaluate(() => frontCalls);
  assert.equal(calls[0].scope, 'order'); assert.ok(['line-0','line-1'].includes(calls[0].line));
  assert.deepEqual(calls[1], {scope:'line',line:'line-0'});
  await expect(line.locator('[data-work-missing-add]')).toHaveCount(0);
  await line.locator('[data-watch-toggle]').click();
  await expect(line.locator('[data-watch-toggle]')).toHaveAttribute('aria-pressed','true');
  await expect(line.locator('[data-work-missing-add]')).toBeVisible();
  await expect(line.locator('[data-work-cgl-add]')).toBeVisible();
  await expect(line.locator('[data-certificate-line]')).toBeVisible();
  await expect(line.locator('[data-work-cancel-add]')).toBeHidden();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await card.screenshot({path:'test-results/pending-front-actions-mobile.png'});
  await line.locator('[data-line-complete-order]').click();
  await expect(page.locator('#worker-no-inventory-modal')).toBeVisible();
  assert.deepEqual(await page.evaluate(() => state.workerNoInventoryCandidates.map(l => l.id).sort()), ['line-0','line-1']);
  assert.deepEqual(await page.evaluate(() => databaseWrites), []);
});

test('relocated order and item actions keep their buyer/line scope without submitting', async t => {
  const page = await open(t, {width: 1440, admin: true});
  await page.locator('#order-search').fill('jewelrylover_28');
  await page.evaluate(() => {
    window.actionCalls = [];
    openCompletionPhotos = lines => actionCalls.push(['photos', lines.map(line => line.id).sort()]);
    sendOrderToPhone = lines => actionCalls.push(['phone', lines.map(line => line.id).sort()]);
    openOrderShippingLabels = lines => actionCalls.push(['labels', lines.map(line => line.id).sort()]);
    openBuyerGroupSelectedEbayLabelPages = group => actionCalls.push(['create-label', group.lines.map(line => line.id).sort()]);
    openWorkerCancelOrderModal = options => actionCalls.push(['cancel-review', options]);
    openSavedEvidenceVideosModal = (id, options) => actionCalls.push(['videos', id, options]);
    setItemMissing = (id, missing) => actionCalls.push(['missing', id, missing]);
  });
  const card = page.locator('.buyer-order-card');
  await card.locator('[data-buyer-expand-key]').click();
  await card.locator('[data-buyer-select-all]').click();
  await card.locator('[data-buyer-label-key]').click();
  await card.locator('[data-buyer-shipping-labels]').click();
  await card.locator('.buyer-order-tools > summary').click();
  await card.locator('[data-buyer-completion-photos]').click();
  await card.locator('[data-phone-camera=buyer]').click();
  const line = card.locator('[data-line-id="line-0"]');
  await line.locator('[data-item-found]').click();
  await line.locator('[data-item-search]').click();
  await line.locator('.buyer-item-tools > summary').click();
  await line.locator('[data-line-view-videos]').click();
  await expect.poll(() => page.evaluate(() => actionCalls.length)).toBe(7);
  await line.locator('[data-line-refund]').click();
  await line.locator('[data-line-cancel]').click();
  assert.deepEqual(await page.evaluate(() => actionCalls), [
    ['create-label', ['line-0', 'line-1']], ['labels', ['line-0', 'line-1']],
    ['photos', ['line-0', 'line-1']], ['phone', ['line-0', 'line-1']],
    ['missing', 'line-0', false], ['missing', 'line-0', true],
    ['videos', 'line-0', {scope: 'line'}],
    ['cancel-review', {lineIds: ['line-0'], mode: 'refunded'}],
    ['cancel-review', {lineIds: ['line-0'], openEbayCancel: true}],
  ]);
  assert.deepEqual(await page.evaluate(() => databaseWrites), []);
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
