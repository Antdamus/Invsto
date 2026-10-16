import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
const receiptUrl = 'https://www.ebay.com/ebaylive/events/fixture-event/stream?selectedItemId=123456789012&playback=true';
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
  const engine = process.env.INVSTO_RECEIPT_BROWSER === 'webkit' ? webkit : chromium;
  browserServer = await engine.launchServer();
  browser = await engine.connect(browserServer.wsEndpoint());
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => {
  await browser?.close(); await browserServer?.close();
  await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
});

async function openHistory(t, {width = 390, saved = receiptUrl, screenshot = true, role = 'employee'} = {}) {
  const context = await browser.newContext({viewport: {width, height: 844}, isMobile: width < 800, hasTouch: width < 800});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue()
    : route.request().isNavigationRequest() ? route.fulfill({body: '<h1>eBay receipt fixture</h1>'}) : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/ebay-order-history.html`);
  for (const script of ['video-receipts.js', 'ebay-order-history.js', 'phone-workspace.js']) await page.addScriptTag({url: `${origin}/${script}`});
  await page.evaluate(({saved, screenshot, role}) => {
    window.supabase = {from() {
      const query = {select() {return query;}, eq() {return query;}, abortSignal() {return query;},
        async maybeSingle() {return {data: {label_metadata: {videoReceiptUrl: saved}}};}};
      return query;
    }};
    state.user = {id: 'staff'}; state.employee = {role, active: true};
    const line = {id: 'receipt-line', order_id: 'order-one', item_number: '123456789012', transaction_id: 'txn-one',
      item_title: 'Silver chain bundle', line_status: 'fulfilled', quantity: 1, fulfilled_quantity: 1, total_price: 145,
      fulfilled_at: '2026-10-05T20:44:00Z', fulfilled_by_email: 'staff@example.test',
      order: {id: 'order-one', order_number: '11-22222-33333', buyer_username: 'receipt-buyer', label_metadata: {videoReceiptUrl: saved}}};
    state.lines = [normalizeLine(line)];
    state.relatedOrderTaskEvents = screenshot ? [{id: 'capture', order_line_ids: [line.id], category: 'task',
      created_at: '2026-10-03T21:03:00Z', signed_by_email: 'staff@example.test',
      photo_attachments: [{bucket: 'proof', path: 'video-receipts/123456789012.png', label: 'Video receipt - 123456789012'}]}] : [];
    signEventEvidencePhoto = async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    document.getElementById('history-from').value = '2026-10-01';
    document.getElementById('history-to').value = '2026-10-16';
    setupListeners(); rebuildHistoryLineSearchIndex(); applyFilters();
  }, {saved, screenshot, role});
  await page.locator('[data-history-group-toggle]').click();
  await expect(page.locator('.history-video-receipt-link')).toBeVisible();
  return page;
}

for (const width of [320, 390]) test(`employee can open the actual video and saved screenshot at ${width}px`, async t => {
  const page = await openHistory(t, {width});
  const link = page.getByRole('link', {name: 'Open video receipt', exact: true});
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await popup.waitForLoadState(); assert.equal(popup.url(), receiptUrl); await popup.close();
  await expect(page.locator('.history-receipt-preview-label')).toHaveText('View screenshot');
  const thumb = page.locator('[data-history-video-receipt-photo]');
  await expect(thumb).toHaveAttribute('data-loaded', 'true');
  await thumb.click();
  await expect(page.locator('#evidence-photo-viewer-modal')).toBeVisible();
  await expect(page.locator('#evidence-photo-viewer-title')).toHaveText('Video receipt - 123456789012');
  await page.locator('#close-evidence-photo-viewer').click();
  await expect(page.locator('#evidence-photo-viewer-modal')).toBeHidden();
  await link.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (width === 390) await page.screenshot({path: 'test-results/order-history-receipt-phone.png'});
  // Re-expanding rebuilds the card, including its receipt action.
  await page.locator('[data-history-group-toggle]').click();
  await page.locator('[data-history-group-toggle]').click();
  const [reopened] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await reopened.waitForLoadState(); assert.equal(reopened.url(), receiptUrl); await reopened.close();
});

test('history without screenshots offers the eBay order fallback and rejects another item receipt', async t => {
  const page = await openHistory(t, {screenshot: false, saved: receiptUrl.replace('123456789012', '999999999999')});
  await expect(page.locator('[data-history-video-receipt-photo]')).toHaveCount(0);
  await page.getByRole('link', {name: 'Open video receipt', exact: true}).click();
  await expect(page.locator('.video-receipt-dialog')).toBeVisible();
  await expect(page.locator('.video-receipt-lookup')).toContainText('No saved');
  await expect(page.locator('.video-receipt-direct')).toBeHidden();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.getByRole('link', {name: 'Open eBay order', exact: true}).click()]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), 'https://www.ebay.com/mesh/ord/details?orderid=11-22222-33333');
  await popup.close();
});

test('desktop history retains the receipt options and correct saved video link', async t => {
  const page = await openHistory(t, {width: 1366, role: 'admin'});
  await page.getByRole('link', {name: 'Open video receipt', exact: true}).click();
  await expect(page.locator('.video-receipt-dialog')).toBeVisible();
  await expect(page.locator('.video-receipt-direct')).toHaveAttribute('href', receiptUrl);
  await page.getByRole('button', {name: 'Close video receipt', exact: true}).click();
  await expect(page.locator('.video-receipt-dialog')).toHaveCount(0);
});
