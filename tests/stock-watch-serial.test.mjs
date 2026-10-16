import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
let server, browser, browserServer, origin;
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
  browserServer = await chromium.launchServer();
  browser = await chromium.connect(browserServer.wsEndpoint());
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => {
  await browser?.close(); await browserServer?.close();
  await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
});

for (const [role, width] of [['employee', 320], ['employee', 390], ['manager', 1366], ['admin', 1366]]) {
  test(`${role} can read and search watch serials at ${width}px without opening the editor`, async t => {
    const context = await browser.newContext({viewport: {width, height: 900}});
    t.after(() => context.close());
    await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/stock.html`);
    await page.addScriptTag({url: `${origin}/phone-workspace.js`});
    await page.addScriptTag({url: `${origin}/inventory-item-facts.js`});
    await page.addScriptTag({url: `${origin}/stock.js`});
    await page.evaluate(role => {
      stockAccess = {role, isAdmin: role === 'admin', canViewSensitive: role === 'admin'};
      applyStockAccessUi();
      allItems = [
        {id: 'watch', title: 'Cartier Santos', barcode: 'OG-WATCH', description: 'Steel watch', cost: 1500,
          sale_price: 2500, stock: 1, categories: ['Watches'], watch_details: {brand: 'Cartier', model: 'WSSA0018', serial: '  001234AB  '}},
        {id: 'missing', title: 'Cartier Panthere', categories: ['Watches'], watch_details: {brand: 'Cartier', model: 'WSPN0006'}},
        {id: 'jewelry', title: 'Gold chain', categories: ['Chains']},
      ];
      window.drawSerialCards = items => {document.getElementById('stock-container').innerHTML = items.map(item => `<article class="stock-card" data-item="${item.id}">${buildCardContent(item)}</article>`).join('');};
      drawSerialCards(allItems);
    }, role);
    const serial = page.locator('[data-item="watch"] .stock-watch-serial strong');
    await expect(serial).toHaveText('001234AB');
    await expect(serial).toBeVisible();
    await expect(page.locator('[data-item="missing"] .stock-watch-serial strong')).toHaveText('Not recorded');
    await expect(page.locator('[data-item="jewelry"] .stock-watch-serial')).toHaveCount(0);
    if (role !== 'admin') {
      assert.ok((await page.evaluate(() => getStockItemSelectColumns())).split(', ').includes('watch_details'));
      await expect(page.locator('[data-item="watch"] .stock-metric-grid')).not.toContainText('Cost');
    }
    // Search uses the actual filter engine and preserves leading zeros.
    await page.getByRole('searchbox', {name: 'Search your collection'}).fill('001234ab');
    assert.deepEqual(await page.evaluate(() => getFilteredItems(allItems).map(item => item.id)), ['watch']);
    await page.evaluate(() => drawSerialCards(getFilteredItems(allItems)));
    await expect(serial).toBeVisible();
    const bounds = await serial.boundingBox();
    assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'serial stays inside the viewport');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    if (role === 'employee' && width === 390) await page.locator('[data-item="watch"]').screenshot({path: 'test-results/stock-serial-employee.png'});
    await page.evaluate(() => {
      allItems[0].watch_details.serial = '<img src=x onerror=alert(1)>';
      drawSerialCards([allItems[0]]);
    });
    await expect(serial).toHaveText('<img src=x onerror=alert(1)>');
    await expect(page.locator('.stock-watch-serial img')).toHaveCount(0);
    assert.deepEqual(errors, []);
  });
}
