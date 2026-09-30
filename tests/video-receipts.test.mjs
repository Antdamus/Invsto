import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit} from '@playwright/test';

const root = new URL('../', import.meta.url);
const receiptUrl = 'https://www.ebay.com/ebaylive/events/fixture-event/stream?selectedItemId=123456789012&playback=true';
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
  browser = await (process.env.INVSTO_RECEIPT_BROWSER === 'webkit' ? webkit : chromium).launch();
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});

async function open(t, {pageName = 'pending-orders', saved = '', button = false} = {}) {
  const context = await browser.newContext({viewport: {width: 390, height: 844}, isMobile: true, hasTouch: true});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue()
    : route.request().isNavigationRequest() ? route.fulfill({body: '<h1>eBay navigation fixture</h1>', contentType: 'text/html'}) : route.abort());
  const p = await context.newPage();
  const errors = [];
  p.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await p.goto(`${origin}/${pageName}.html`);
  await p.addScriptTag({url: origin + '/video-receipts.js'});
  await p.addScriptTag({url: origin + (pageName === 'pending-orders' ? '/pending-orders.js' : '/ebay-order-history.js')});
  await p.evaluate(({saved, button, pageName}) => {
    window.dbCalls = [];
    window.metadata = {};
    window.dbError = false;
    window.dbDelay = 0;
    window.extensionRequests = [];
    window.supabase = {from(table) {
      const query = {select(columns) { dbCalls.push({table, columns}); return query; },
        eq(column, value) { dbCalls.at(-1).filter = [column, value]; return query; },
        abortSignal(signal) { query.signal = signal; return query; },
        async maybeSingle() {
          const result = structuredClone(metadata);
          await new Promise(resolve => {
            const timer = setTimeout(resolve, dbDelay);
            query.signal.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, {once: true});
          });
          return dbError || query.signal.aborted ? {error: {message: 'Unavailable'}} : {data: {label_metadata: result}};
        }};
      return query;
    }};
    window.fixtureLine = {id: 'line-one', order_id: 'order-one', item_number: '123456789012', transaction_id: 'txn-one',
      item_title: 'Fixture eBay Live item', quantity: 1, fulfilled_quantity: 0, line_status: 'pending',
      order: {id: 'order-one', order_number: '11-22222-33333', buyer_username: 'fixture-buyer', label_metadata: saved ? {videoReceiptUrl: saved} : {}}};
    window.addEventListener('message', event => {
      if (event.data?.type === 'OG_EBAY_VIDEO_RECEIPT_OPEN_REQUEST') extensionRequests.push(event.data);
    });
    // Exercise the actual pending queue link and its Opening... wrapper.
    if (pageName === 'pending-orders' && !button) {
      scheduleQueueVideoReceiptEvidenceHydration = () => {};
      state.employee = {active: true, role: 'admin'};
      state.orders = [fixtureLine]; state.filteredOrders = [fixtureLine]; state.selectedLine = fixtureLine;
      renderOrders();
      return;
    }
    const host = document.createElement('div');
    host.id = 'receipt-test-host';
    host.style.cssText = 'position:fixed;top:100px;left:20px;z-index:5000;background:#222;padding:20px';
    document.body.append(host);
    if (button) {
      host.innerHTML = '<button id="receipt-test-button">Open video receipt</button>';
      host.firstChild.onclick = event => openVideoReceiptLink(event, getOrderVideoReceiptLink(fixtureLine));
    } else {
      host.innerHTML = renderReturnLineVideoReceiptPanel(fixtureLine);
      bindReturnVideoReceiptLinks(host);
    }
  }, {saved, button, pageName});
  return p;
}

const trigger = p => p.locator('.buyer-line-receipt, [data-return-video-receipt-link], #receipt-test-button').first();
const dialog = p => p.locator('.video-receipt-dialog');

test('phone queue immediately offers a native eBay order link without requesting an extension', async t => {
  const p = await open(t);
  await trigger(p).click();
  await dialog(p).waitFor({state: 'visible', timeout: 1000});
  assert.equal(await trigger(p).textContent(), 'Open video receipt');
  assert.equal(await p.locator('.video-receipt-order').getAttribute('href'), 'https://www.ebay.com/mesh/ord/details?orderid=11-22222-33333');
  await p.waitForFunction(() => document.querySelector('.video-receipt-lookup').textContent.includes('No saved'));
  assert.deepEqual(await p.evaluate(() => extensionRequests), []);
  const [popup] = await Promise.all([p.waitForEvent('popup'), p.locator('.video-receipt-order').click()]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), 'https://www.ebay.com/mesh/ord/details?orderid=11-22222-33333');
  assert.equal(await popup.evaluate(() => window.opener), null);
  const bounds = await dialog(p).boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= 844);
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
  await p.screenshot({path: `test-results/video-receipt-${process.env.INVSTO_RECEIPT_BROWSER || 'chromium'}.png`});
});

test('a saved receipt opens directly through native navigation from the actual queue anchor', async t => {
  const p = await open(t, {saved: receiptUrl});
  const [popup] = await Promise.all([p.waitForEvent('popup'), trigger(p).click()]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), receiptUrl);
  assert.equal(await dialog(p).count(), 0);
  assert.deepEqual(await p.evaluate(() => [dbCalls, extensionRequests]), [[], []]);
});

test('a worker button also opens a saved receipt without the extension', async t => {
  const p = await open(t, {saved: receiptUrl, button: true});
  const [popup] = await Promise.all([p.waitForEvent('popup'), trigger(p).click()]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), receiptUrl);
});

test('queue metadata omitted during loading is fetched for the exact order and item', async t => {
  const p = await open(t);
  await p.evaluate(url => { metadata = {returnDetails: {videoReceiptUrls: [url.replace('123456789012', '999999999999'), url]}}; }, receiptUrl);
  await trigger(p).click();
  await p.locator('.video-receipt-direct').waitFor({state: 'visible'});
  assert.equal(await p.locator('.video-receipt-direct').getAttribute('href'), receiptUrl);
  assert.deepEqual(await p.evaluate(() => dbCalls), [{table: 'ebay_orders', columns: 'label_metadata', filter: ['id', 'order-one']}]);
  assert.equal(p.context().pages().length, 1, 'async lookup must not attempt a popup');
  const [popup] = await Promise.all([p.waitForEvent('popup'), p.locator('.video-receipt-direct').click()]);
  await popup.waitForLoadState(); assert.equal(popup.url(), receiptUrl);
});

test('lookup failures stay visible and leave the eBay fallback usable', async t => {
  const p = await open(t);
  await p.evaluate(() => { dbError = true; });
  await trigger(p).click();
  await p.waitForFunction(() => document.querySelector('.video-receipt-lookup').textContent.includes("Couldn't check"));
  assert.equal(await p.locator('.video-receipt-order').isVisible(), true);
});

test('slow metadata times out without blocking navigation', async t => {
  const p = await open(t);
  await p.clock.install();
  await p.evaluate(() => { dbDelay = 30000; });
  await trigger(p).click();
  assert.equal(await p.locator('.video-receipt-order').isVisible(), true);
  await p.clock.fastForward(8100);
  await p.waitForFunction(() => document.querySelector('.video-receipt-lookup').textContent.includes("Couldn't check"));
});

test('URLs must be HTTPS eBay replay links for the selected item', async t => {
  const p = await open(t);
  const results = await p.evaluate(url => [
    url, url.replace('https:', 'http:'), url.replace('www.ebay.com', 'www.ebay.com.evil.test'),
    url.replace('www.ebay.com', 'attacker@www.ebay.com'), url.replace('123456789012', '999999999999'),
    'javascript:alert(1)', url.replace('/ebaylive/events/', '/other/ebaylive/events/'),
    'https://www.ebay.com/ebaylive/events/fixture?itemIds=999999999999%2C123456789012',
  ].map(value => OGVideoReceipts.normalizeUrl(value, {itemNumber: '123456789012'})), receiptUrl);
  assert.equal(results[0], receiptUrl);
  assert.deepEqual(results.slice(1, 7), ['', '', '', '', '', '']);
  assert.equal(new URL(results[7]).searchParams.get('selectedItemId'), '123456789012');
  assert.equal(new URL(results[7]).searchParams.get('playback'), 'true');
});

test('extension errors and timeout appear inside the panel; retry is available', async t => {
  const p = await open(t);
  await p.clock.install();
  await trigger(p).click();
  await p.locator('.video-receipt-desktop summary').click();
  await p.locator('.video-receipt-find').click();
  await p.waitForFunction(() => extensionRequests.length === 1);
  await p.evaluate(() => {
    window.postMessage({type: 'OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE', requestId: extensionRequests[0].requestId,
      payload: {ok: false, error: 'Sign in to eBay first.'}}, location.origin);
  });
  await p.waitForFunction(() => document.querySelector('.video-receipt-extension-status').textContent === 'Sign in to eBay first.');
  assert.equal(await p.locator('.video-receipt-find').isEnabled(), true);
  await p.locator('.video-receipt-find').click();
  await p.clock.fastForward(20100);
  assert.match(await p.locator('.video-receipt-extension-status').textContent(), /did not respond/);
  assert.equal(await p.locator('.video-receipt-find').isEnabled(), true);
});

test('a matching extension result can be reopened; an unrelated response is ignored', async t => {
  const p = await open(t);
  await trigger(p).click();
  await p.locator('.video-receipt-desktop summary').click();
  await p.locator('.video-receipt-find').click();
  await p.waitForFunction(() => extensionRequests.length === 1);
  await p.evaluate(url => {
    window.postMessage({type: 'OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE', requestId: 'wrong-request', payload: {ok: true, openedUrl: url}}, location.origin);
  }, receiptUrl);
  assert.equal(await p.locator('.video-receipt-direct').isVisible(), false);
  await p.evaluate(url => {
    window.postMessage({type: 'OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE', requestId: extensionRequests[0].requestId,
      payload: {ok: true, openedUrl: url}}, location.origin);
  }, receiptUrl);
  await p.locator('.video-receipt-direct').waitFor({state: 'visible'});
  await p.locator('.video-receipt-close').click();
  const [popup] = await Promise.all([p.waitForEvent('popup'), trigger(p).click()]);
  await popup.waitForLoadState(); assert.equal(popup.url(), receiptUrl);
  assert.equal(await p.evaluate(() => extensionRequests.length), 1);
});

test('closing a lookup restores focus and ignores late results', async t => {
  const p = await open(t);
  await p.evaluate(url => { dbDelay = 1000; metadata = {videoReceiptUrl: url}; }, receiptUrl);
  await trigger(p).click();
  await p.keyboard.press('Escape');
  assert.equal(await dialog(p).count(), 0);
  assert.equal(await trigger(p).evaluate(el => el === document.activeElement), true);
  await p.evaluate(() => { metadata = {}; dbDelay = 0; });
  await trigger(p).click();
  await p.waitForFunction(() => document.querySelector('.video-receipt-lookup').textContent.includes('No saved'));
  assert.equal(await p.locator('.video-receipt-direct').isVisible(), false);
});

for (const pageName of ['ebay-order-history', 'ebay-returns']) {
  test(`${pageName} binds the shared fallback and exact-order metadata lookup`, async t => {
    const p = await open(t, {pageName});
    await trigger(p).click();
    await dialog(p).waitFor({state: 'visible'});
    await p.waitForFunction(() => dbCalls.length === 1);
    assert.deepEqual(await p.evaluate(() => dbCalls[0].filter), ['id', 'order-one']);
    assert.equal(await p.locator('.video-receipt-order').isVisible(), true);
  });
}
