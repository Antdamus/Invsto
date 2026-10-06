import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
let server, browser, browserServer, origin;
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
  const engine = process.env.INVSTO_ITEM_BROWSER === 'webkit' ? webkit : chromium;
  browserServer = await engine.launchServer();
  browser = await engine.connect(browserServer.wsEndpoint());
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => {
  await browser?.close();
  // Windows WebKit can keep its transport open after every context has closed.
  // Stop only this suite's isolated browser process if normal shutdown stalls.
  let timer;
  try { await Promise.race([browserServer?.close(), new Promise(resolve => {timer = setTimeout(() => browserServer?.kill().then(resolve), 5000);})]); }
  finally { clearTimeout(timer); }
  await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
});

async function open(t, kind, width = 390, admin = true) {
  const context = await browser.newContext({viewport: {width, height: 844}, hasTouch: true});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage(); page.setDefaultTimeout(6000);
  const errors = []; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors, []));
  const file = kind === 'history' ? 'ebay-order-history' : 'stock';
  await page.goto(`${origin}/${file}.html`);
  await page.addScriptTag({url: `${origin}/${file}.js`});
  await page.addScriptTag({url: origin + '/barcode-scanner.js'});
  await page.addScriptTag({url: origin + '/phone-workspace.js'});
  await page.evaluate(({kind, admin}) => {
    window.databaseWrites = [];
    window.supabase = {from: table => {databaseWrites.push(table); throw Error('Unexpected database request');}, rpc: async name => {databaseWrites.push(name); throw Error('Unexpected database request');}};
    if (kind === 'history') {
      state.user = {id: 'tester', email: 'test@example.test'};
      state.employee = {role: admin ? 'admin' : 'employee', active: true};
      state.lines = Array.from({length: 8}, (_, i) => normalizeLine({
        id: `line-${i}`, order_id: `order-${i}`, item_title: i === 0 ? 'Sterling silver bracelet with heart charm' : 'Gold necklace with a delicate clasp',
        item_number: `12345678901${i}`, line_status: i === 7 ? 'cancelled' : 'fulfilled', quantity: 1, fulfilled_quantity: 1,
        fulfilled_at: '2026-10-06T12:00:00Z', fulfilled_by_email: 'sandra@example.test', sold_for: 89, total_price: 89,
        notes: 'Packed together.\nThe bracelet clasp was checked before shipping.',
        order: {id: `order-${i}`, order_number: `11-22222-3333${i}`, buyer_username: i < 2 ? 'jewelrylover_28' : `buyer_${i}`, buyer_name: 'Olivia Bennett', sale_date: '2026-10-05T12:00:00Z'}
      }));
      loadOrderHistory = async () => applyFilters();
      setupDefaultDates(); setupListeners(); applyFilters();
      document.querySelectorAll('[data-admin-only=true]').forEach(el => el.classList.toggle('hidden', !admin));
    } else {
      currentUser = {id: 'tester'}; stockAccess = {role: admin ? 'admin' : 'worker', isAdmin: admin, canViewSensitive: admin};
      allItems = Array.from({length: 14}, (_, i) => ({id: `item-${i}`, title: i === 0 ? '100 Fam Pendant 925 Fine Silver' : `Gold chain ${String(i).padStart(2, '0')}`,
        description: 'Fine silver with a delicate clasp and polished finish. '.repeat(5), barcode: `ABC00${i}`, weight: 27.31, sale_price: 1700 + i, minimum_sale_price: 1200,
        cost: 750, stock: 2, stock_locations: ['Seybold 364'], stock_location_details: [], photos: [], categories: ['Necklaces'], qr_type: 'jewelry', created_at: '2026-10-05T12:00:00Z'}));
      userFavorites = new Set(['item-0']);
      refreshInventoryUI = async () => applySortAndRender(getFilteredItems(allItems));
      setupDynamicFilters('filter-form', ['sort-select', 'cards-per-page']);
      setupClearFilters(); setupFilterPanelUI(); setupStockMediaListeners(); setupCardEventListeners();
      applyStockAccessUi(); applySortAndRender(getFilteredItems(allItems)); updateFilterChips(getActiveFilters());
    }
  }, {kind, admin});
  await page.addScriptTag({url: origin + '/admin-nav.js'});
  await page.evaluate(admin => OGRoleNavigation.render(admin ? 'admin' : 'worker'), admin);
  await expect(page.locator(kind === 'history' ? '.history-order-card' : '.stock-card').first()).toBeVisible();
  return page;
}

const overflow = page => page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
for (const width of [320, 390, 430, 760]) {
  for (const kind of ['history', 'stock']) test(`${kind} ${width}px: compact, readable, usable filters and desktop restoration`, async t => {
    const page = await open(t, kind, width);
    const card = page.locator(kind === 'history' ? '.history-order-card' : '.stock-card').first();
    if (width === 390) await page.screenshot({path: `test-results/${kind}-phone-local.png`});
    const box = await card.boundingBox(); assert.ok(box.y < 510, `first card at ${box.y}`);
    assert.equal(await overflow(page), false);
    if (kind === 'stock') assert.ok(box.height < 510, `stock card height ${box.height}`);
    if (width === 390) await page.screenshot({path: `test-results/${kind}-phone-local.png`});
    await page.locator('#menu-toggle').click(); await expect(page.locator('#mobile-menu')).toBeVisible();
    await page.locator('#menu-toggle').click(); await expect(page.locator('#mobile-menu')).toBeHidden();
    await page.locator('#phone-filter-button').click();
    await expect(page.locator('#phone-filters-sheet')).toBeVisible(); assert.equal(await overflow(page), false);
    if (kind === 'history') await expect(page.locator('#history-from')).toBeVisible();
    else { await expect(page.locator('#sort-select')).toBeVisible(); await expect(page.locator('#filter-form input[name=title]')).toBeVisible(); }
    await page.locator('#phone-filters-sheet [data-close-sheet]').first().click();
    if (kind === 'stock') {
      await card.locator('.phone-stock-details-toggle').click();
      await expect(card.locator('.stock-card-action-cluster')).toBeVisible();
      await expect(card.locator('.stock-description-wrap')).toBeVisible();
      await expect(card.locator('.card-float-controls')).toBeVisible();
      await card.locator('.stock-description-read-btn').click();
      await expect(page.locator('#stock-description-modal')).toBeVisible();
      assert.equal(await overflow(page), false);
      await page.locator('#close-stock-description-modal').click();
    } else {
      await card.locator('[data-history-group-toggle]').click();
      await expect(page.locator('.history-order-detail')).toBeVisible();
      await expect(page.locator('[data-history-order-task]').first()).toBeVisible();
      assert.match(await page.locator('.history-order-detail').innerText(), /bracelet clasp/);
    }
    assert.equal(await overflow(page), false);
    await page.locator('#phone-workspace-tools').click();
    await expect(page.locator('#phone-tools-sheet')).toBeVisible();
    await page.setViewportSize({width: 1280, height: 900});
    await expect(page.locator('#phone-tools-sheet')).toBeHidden();
    await expect(page.locator('#phone-workspace-overview')).toBeHidden();
    await expect(page.locator(kind === 'history' ? '.history-filters #history-search' : '.top-controls #open-storage-transfer')).toBeAttached();
    if (kind === 'stock') await expect(page.locator('.stock-image-container .card-float-controls').first()).toBeAttached();
    await page.setViewportSize({width, height: 844});
    await expect(page.locator('#phone-primary-search input')).toBeVisible();
    assert.equal(await overflow(page), false);
    assert.deepEqual(await page.evaluate(() => databaseWrites), []);
  });
}

test('stock quick search matches names, descriptions and barcodes, composes with filters, and clears correctly', async t => {
  const page = await open(t, 'stock');
  await page.locator('#stock-quick-search').fill('abc0012');
  await expect(page.locator('.stock-card')).toHaveCount(1); await expect(page.locator('.stock-card h2')).toHaveText('Gold chain 12');
  assert.match(page.url(), /query=abc0012/);
  await page.locator('#stock-quick-search').fill('delicate clasp');
  await expect(page.locator('.stock-card')).toHaveCount(6);
  await page.locator('#phone-filter-button').click();
  await page.locator('#filter-form input[name=title]').fill('pendant');
  await expect(page.locator('.stock-card')).toHaveCount(1);
  await page.locator('#phone-filters-sheet [data-close-sheet]').first().click();
  await page.locator('#header-filter-chips .filter-chip').filter({hasText: 'Title:'}).locator('button').click();
  await expect(page.locator('.stock-card')).toHaveCount(6);
  await expect(page.locator('#edit-title')).toHaveValue('');
  await page.locator('#phone-filter-button').click();
  await page.locator('#clear-filters').click();
  await expect(page.locator('#stock-quick-search')).toHaveValue('');
  await expect(page.locator('.stock-card')).toHaveCount(6);
  await page.locator('#sort-select').selectOption('price-desc');
  await expect(page.locator('.stock-card h2').first()).toHaveText('Gold chain 13');
  await page.locator('#phone-filters-sheet [data-close-sheet]').first().click();
  await page.locator('#pagination-buttons').getByRole('button', {name: 'Next', exact: true}).click();
  await expect(page.locator('.pagination-summary-pill')).toHaveText('Page 2 of 3');
  await expect(page.locator('.stock-card h2').first()).toHaveText('Gold chain 07');
  await page.locator('#show-favorites-only').check(); await expect(page.locator('.stock-card')).toHaveCount(1);
  await expect(page.locator('.stock-card h2')).toHaveText('100 Fam Pendant 925 Fine Silver');
});

test('history search and status filters update visible groups and mirrored counts', async t => {
  const page = await open(t, 'history');
  await page.locator('#history-search').fill('jewelrylover_28');
  await expect(page.locator('.history-order-card')).toHaveCount(1);
  await expect(page.locator('[data-phone-stat=shipped-orders]')).toHaveText('2');
  await page.locator('#history-search').fill('');
  await page.locator('#phone-filter-button').click();
  await page.locator('#history-status').selectOption('cancelled');
  await expect(page.locator('.history-order-card')).toHaveCount(1);
  await expect(page.locator('[data-phone-stat=cancelled]')).toHaveText('1');
});

test('worker stock and history views keep sensitive controls hidden inside sheets', async t => {
  for (const kind of ['stock', 'history']) {
    const page = await open(t, kind, 390, false);
    await page.locator('#phone-filter-button').click();
    if (kind === 'stock') {
      await expect(page.locator('input[name=distributor]')).toBeHidden();
      await expect(page.locator('#sort-select option[value=cost-asc]')).toHaveCount(0);
      await expect(page.locator('#deleted-items-toggle-wrap')).toBeHidden();
    }
    await page.locator('#phone-filters-sheet [data-close-sheet]').first().click();
    await page.locator('#phone-workspace-tools').click();
    if (kind === 'history') { await expect(page.locator('#backfill-label-tracking')).toBeHidden(); await expect(page.locator('#summary-gross')).toBeHidden(); }
  }
});
