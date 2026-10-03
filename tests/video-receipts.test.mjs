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

async function open(t, {pageName = 'pending-orders', saved = '', button = false, desktop = false, width} = {}) {
  const context = await browser.newContext({viewport: {width: width || (desktop ? 1280 : 390), height: 844}, isMobile: !desktop, hasTouch: !desktop});
  t.after(() => context.close());
  await context.route('**/*', route => [origin, `blob:${origin}`, 'data:'].some(prefix => route.request().url().startsWith(prefix)) ? route.continue()
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
      window.originalScheduleReceiptHydration = scheduleQueueVideoReceiptEvidenceHydration;
      scheduleQueueVideoReceiptEvidenceHydration = () => {};
      // Shared-note reads are covered separately; keep receipt lookup assertions scoped to receipts.
      hydrateBuyerGroupNotes = () => {};
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

async function screenshotPage(t, options = {}) {
  const p = await open(t, options);
  await p.evaluate(() => {
    window.uploads = []; window.notes = []; window.uploadFailure = false; window.noteFailure = false;
    window.uploadDelay = 0; window.refreshFailure = false;
    const canvas = document.createElement('canvas'); canvas.width = 280; canvas.height = 600;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#202526'; ctx.fillRect(0, 0, 280, 600);
    ctx.fillStyle = '#ffe1a2'; ctx.font = '18px sans-serif'; ctx.fillText('Receipt screenshot fixture', 16, 70);
    window.testScreenshot = canvas.toDataURL('image/png');
    const originalFrom = supabase.from;
    supabase.from = table => {
      if (table === 'ebay_orders') return originalFrom(table);
      const q = {select() {return q;}, in() {return q;}, order() {return q;}, then(resolve) {
        const data = table === 'ebay_order_tasks'
          ? notes.map((note, i) => ({id: `task-${i}`, order_id: 'order-one', order_line_ids: [note._order_line_id], status: 'resolved', metadata: {source: 'pending_order_line_note'}}))
          : notes.map((note, i) => ({id: `event-${i}`, task_id: `task-${i}`, photo_attachments: note._photo_attachments, notes: note._note}));
        return Promise.resolve({data}).then(resolve);
      }}; return q;
    };
    supabase.storage = {from(bucket) {return {
      async upload(path, blob, options) {
        uploads.push({bucket, path, type: blob.type, size: blob.size, options});
        if (uploadDelay) await new Promise(resolve => setTimeout(resolve, uploadDelay));
        return uploadFailure ? {error: {message: 'Upload unavailable'}} : {data: {path}};
      },
      async createSignedUrl() {return {data: {signedUrl: testScreenshot}};},
    };}};
    supabase.rpc = async (name, args) => {
      assertRpc(name); // Reject accidental fulfillment or broad-order actions.
      if (noteFailure) return {error: {message: 'Could not save receipt note'}};
      notes.push(structuredClone(args));
      return {data: {id: 'saved-note', photo_attachments: args._photo_attachments}};
    };
    window.assertRpc = name => {if (name !== 'add_pending_order_line_note') throw new Error(`Unexpected write ${name}`);};
    state.user = {id: 'staff-fixture', email: 'staff@example.test'};
    // Another line has the same eBay listing; the screenshot must keep its line identity.
    state.orders.push({...structuredClone(fixtureLine), id: 'line-two', transaction_id: 'txn-two'});
    loadSelectedOrderTasks = async () => {if (refreshFailure) throw new Error('Refresh unavailable');};
    hydrateSelectedOrderDetails = async () => {};
    setupListeners();
  });
  return p;
}

async function chooseScreenshot(p, locator = p.locator('[data-upload-receipt-screenshot="line-one"]').first()) {
  const [picker] = await Promise.all([p.waitForEvent('filechooser'), locator.click()]);
  const buffer = Buffer.from(await p.evaluate(() => testScreenshot.split(',')[1]), 'base64');
  await picker.setFiles({name: 'IMG_Receipt.PNG', mimeType: 'image/png', buffer});
  try {
    await p.locator('#manual-video-receipt-preview').waitFor({state: 'visible', timeout: 5000});
  } catch (error) {
    const details = await p.evaluate(() => {
      const img = document.querySelector('#manual-video-receipt-preview');
      const ancestors = []; let node = img;
      while (node) {
        const s = getComputedStyle(node), box = node.getBoundingClientRect();
        ancestors.push({tag: node.tagName, id: node.id, className: node.className, display: s.display,
          visibility: s.visibility, width: box.width, height: box.height});
        node = node.parentElement;
      }
      return {complete: img.complete, naturalWidth: img.naturalWidth, naturalHeight: img.naturalHeight, ancestors};
    });
    throw new Error(`Screenshot preview unavailable: ${JSON.stringify(details)}`, {cause: error});
  }
}

test('phone screenshot upload opens Photos, previews, and saves receipt evidence only for the chosen item', async t => {
  const p = await screenshotPage(t);
  await chooseScreenshot(p);
  assert.equal(await p.locator('#manual-video-receipt-file').getAttribute('accept'), 'image/*');
  assert.equal(await p.locator('#manual-video-receipt-file').getAttribute('capture'), null);
  assert.match(await p.locator('#manual-video-receipt-context').textContent(), /123456789012/);
  assert.equal(await p.locator('#manual-video-receipt-note').inputValue(), 'Video receipt screenshot uploaded manually.');
  await p.locator('#manual-video-receipt-note-section summary').click();
  await p.locator('#manual-video-receipt-note').fill('');
  await p.locator('#save-manual-video-receipt').click();
  await p.locator('#manual-video-receipt-modal').waitFor({state: 'hidden'});
  const result = await p.evaluate(() => ({notes, uploads, count: getLineVideoReceiptPhotoCount(fixtureLine),
    secondCount: getLineVideoReceiptPhotoCount(state.orders[1]), lineStatus: fixtureLine.line_status}));
  assert.equal(result.notes.length, 1);
  assert.equal(result.notes[0]._order_line_id, 'line-one');
  const photo = result.notes[0]._photo_attachments[0];
  assert.match(photo.path, /^video-receipts\/manual\//);
  assert.equal(photo.label, 'Video receipt - 123456789012');
  assert.equal(photo.media_type, 'image');
  assert.equal(photo.metadata.source, 'manual_video_receipt_screenshot');
  assert.deepEqual(photo.order_line_ids, ['line-one']);
  assert.equal(photo.signed_by_email, 'staff@example.test');
  assert.ok(photo.preview_path && photo.thumbnail_path, 'derivatives generated for queue thumbnails');
  assert.equal(result.uploads[0].type, 'image/png');
  assert.equal(result.count, 1);
  assert.equal(result.secondCount, 0);
  assert.equal(result.lineStatus, 'pending');
  await p.locator('[data-queue-video-evidence="line-one"] img').waitFor({state: 'visible'});
  // Rehydrate from saved events after losing all in-memory receipt caches.
  await p.evaluate(async () => {
    state.videoReceiptEvidenceByLineId.clear(); state.selectedOrderTasks = []; state.queueVideoReceiptTasks = [];
    state.queueVideoReceiptTaskEvents.clear(); state.queueVideoReceiptLoadedOrderIds.clear();
    await ensureQueueVideoReceiptTasksLoaded(state.orders);
  });
  assert.deepEqual(await p.evaluate(() => state.orders.map(getLineVideoReceiptPhotoCount)), [1, 0]);
});

test('receipt panel screenshot action closes the panel and preserves the original item', async t => {
  const p = await screenshotPage(t);
  await trigger(p).click();
  await chooseScreenshot(p, p.locator('.video-receipt-upload'));
  assert.equal(await dialog(p).count(), 0);
  assert.equal(await p.evaluate(() => state.manualVideoReceiptLineId), 'line-one');
  const bounds = await p.locator('.manual-video-receipt-card').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390);
  await p.screenshot({path: `test-results/receipt-screenshot-upload-${process.env.INVSTO_RECEIPT_BROWSER || 'chromium'}.png`});
  await p.locator('#cancel-manual-video-receipt').click();
  assert.deepEqual(await p.evaluate(() => [uploads.length, notes.length]), [0, 0]);
});

test('screenshot mode rejects video and cancelled selection never attaches the previous image', async t => {
  const p = await screenshotPage(t);
  await chooseScreenshot(p);
  await p.locator('#cancel-manual-video-receipt').click();
  const [picker] = await Promise.all([p.waitForEvent('filechooser'), p.locator('[data-upload-receipt-screenshot="line-one"]').first().click()]);
  assert.equal(await p.locator('#save-manual-video-receipt').isEnabled(), false);
  await picker.setFiles({name: 'screen-recording.mp4', mimeType: 'video/mp4', buffer: Buffer.from('test video')});
  assert.match(await p.locator('#manual-video-receipt-error').textContent(), /Choose a screenshot/);
  assert.equal(await p.locator('#save-manual-video-receipt').isEnabled(), false);
  assert.deepEqual(await p.evaluate(() => [uploads.length, notes.length]), [0, 0]);
});

test('upload failures keep the selected screenshot available for retry', async t => {
  const p = await screenshotPage(t);
  await chooseScreenshot(p);
  await p.evaluate(() => {uploadFailure = true;});
  await p.locator('#save-manual-video-receipt').click();
  await p.waitForFunction(() => document.querySelector('#manual-video-receipt-error').textContent === 'Upload unavailable');
  assert.equal(await p.locator('#save-manual-video-receipt').isEnabled(), true);
  assert.equal(await p.evaluate(() => notes.length), 0);
  await p.evaluate(() => {uploadFailure = false;});
  await p.locator('#save-manual-video-receipt').click();
  await p.locator('#manual-video-receipt-modal').waitFor({state: 'hidden'});
  assert.equal(await p.evaluate(() => notes.length), 1);
});

test('saving blocks double submission, close and switching the target line', async t => {
  const p = await screenshotPage(t);
  await chooseScreenshot(p);
  await p.evaluate(() => {uploadDelay = 200;});
  await p.locator('#save-manual-video-receipt').click();
  await p.evaluate(() => {
    saveManualVideoReceipt(); closeManualVideoReceiptModal();
    openManualVideoReceiptModal('line-two', {mode: 'screenshot'});
  });
  assert.equal(await p.evaluate(() => state.manualVideoReceiptLineId), 'line-one');
  assert.equal(await p.locator('#cancel-manual-video-receipt').isEnabled(), false);
  await p.locator('#manual-video-receipt-modal').waitFor({state: 'hidden'});
  assert.deepEqual(await p.evaluate(() => notes.map(note => note._order_line_id)), ['line-one']);
});

test('a refresh failure after successful save does not leave the screenshot ready to submit twice', async t => {
  const p = await screenshotPage(t);
  await chooseScreenshot(p);
  await p.evaluate(() => {refreshFailure = true;});
  await p.locator('#save-manual-video-receipt').click();
  await p.locator('#manual-video-receipt-modal').waitFor({state: 'hidden'});
  assert.deepEqual(await p.evaluate(() => [notes.length, state.manualVideoReceiptPhoto]), [1, null]);
  assert.equal(await p.locator('#save-manual-video-receipt').isEnabled(), false);
});

test('ordinary item videos keep their existing media picker and are not classified as receipt screenshots', async t => {
  const p = await screenshotPage(t);
  await chooseScreenshot(p);
  await p.locator('#cancel-manual-video-receipt').click();
  const [picker] = await Promise.all([p.waitForEvent('filechooser'), p.getByRole('button', {name: 'Add item video', exact: true}).click()]);
  assert.equal(await p.locator('#manual-video-receipt-file').getAttribute('accept'), 'image/*,video/*');
  await picker.setFiles({name: 'evidence.png', mimeType: 'image/png', buffer: Buffer.from(await p.evaluate(() => testScreenshot.split(',')[1]), 'base64')});
  await p.locator('#manual-video-receipt-note').fill('Original item condition.');
  await p.locator('#save-manual-video-receipt').click();
  await p.locator('#manual-video-receipt-modal').waitFor({state: 'hidden'});
  assert.equal(await p.evaluate(() => notes[0]._photo_attachments[0].metadata.source), 'standalone_order_evidence');
  assert.equal(await p.evaluate(() => isVideoReceiptEvidencePhoto(notes[0]._photo_attachments[0])), false);
});

test('selected item detail offers the same screenshot picker', async t => {
  const p = await screenshotPage(t);
  await p.evaluate(() => {renderSelectedVideoReceipt(fixtureLine); document.querySelector('#fulfillment-workflow').classList.remove('hidden');});
  await chooseScreenshot(p, p.locator('#selected-video-receipt [data-upload-receipt-screenshot]'));
  assert.equal(await p.evaluate(() => state.manualVideoReceiptLineId), 'line-one');
});

test('uploading from without-inventory review does not toggle or fulfill its selected lines', async t => {
  const p = await screenshotPage(t);
  await p.evaluate(() => {
    state.workerNoInventoryCandidates = state.orders;
    state.workerNoInventoryLineIds.add('line-one');
    renderWorkerNoInventoryList(); openModal('worker-no-inventory-modal');
  });
  await chooseScreenshot(p, p.locator('#worker-no-inventory-list [data-upload-receipt-screenshot="line-two"]'));
  assert.equal(await p.evaluate(() => state.manualVideoReceiptLineId), 'line-two');
  assert.deepEqual(await p.evaluate(() => [...state.workerNoInventoryLineIds]), ['line-one']);
  await p.locator('#save-manual-video-receipt').click();
  await p.locator('#manual-video-receipt-modal').waitFor({state: 'hidden'});
  assert.equal(await p.locator('#worker-no-inventory-modal').isVisible(), true);
  assert.deepEqual(await p.evaluate(() => [notes[0]._order_line_id, [...state.workerNoInventoryLineIds], state.orders.map(line => line.line_status)]),
    ['line-two', ['line-one'], ['pending', 'pending']]);
});

test('order history recognizes phone screenshots and respects item-line identity before shared listing numbers', async t => {
  const p = await open(t, {pageName: 'ebay-order-history'});
  const result = await p.evaluate(() => {
    const photo = {bucket: 'order-evidence-photos', path: 'video-receipts/manual/fixture.png', label: 'Video receipt - 123456789012',
      order_line_ids: ['line-one'], metadata: {source: 'manual_video_receipt_screenshot', itemNumber: '123456789012'}};
    const event = {photo_attachments: [photo], payload: {source: 'pending_order_line_note', order_line_ids: ['line-one']}};
    return [getHistoryLineVideoReceiptPhotos(fixtureLine, [event]).length,
      getHistoryLineVideoReceiptPhotos({...fixtureLine, id: 'line-two'}, [event]).length];
  });
  assert.deepEqual(result, [1, 0]);
});

test('desktop receipt opens through the extension on the first click and closes options before return', async t => {
  const p = await open(t, {desktop: true});await trigger(p).click();
  await p.waitForFunction(() => extensionRequests.length === 1);
  assert.equal(await p.locator('.video-receipt-desktop').evaluate(el=>el.open), true);
  assert.equal(await p.locator('.video-receipt-find').isDisabled(), true);
  const payload = await p.evaluate(() => extensionRequests[0].payload);
  assert.equal(payload.orderNumber, '11-22222-33333');assert.equal(payload.itemNumber, '123456789012');assert.equal(payload.transactionId, 'txn-one');
  // Repeated action while the worker is still opening cannot create another request.
  await p.evaluate(()=>OGVideoReceipts.open(null,getOrderVideoReceiptLink(fixtureLine)));
  assert.equal(await p.evaluate(()=>extensionRequests.length),1);
  await p.evaluate(url=>window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE',requestId:extensionRequests[0].requestId,payload:{ok:true,openedUrl:url}},location.origin),receiptUrl);
  await dialog(p).waitFor({state:'detached'});assert.equal(await trigger(p).textContent(),'Open video receipt');
});

test('desktop saved links keep using extension capture without an extra native tab', async t => {
  const p = await open(t,{desktop:true,saved:receiptUrl});await trigger(p).click();
  await p.waitForFunction(()=>extensionRequests.length===1);
  assert.equal(await p.evaluate(()=>extensionRequests[0].payload.videoReceiptUrl),receiptUrl);
  assert.equal(p.context().pages().length,1);assert.equal(await p.evaluate(()=>dbCalls.length),0);
  await p.evaluate(url=>window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE',requestId:extensionRequests[0].requestId,payload:{ok:true,openedUrl:url}},location.origin),receiptUrl);
  await dialog(p).waitFor({state:'detached'});await trigger(p).click();await p.waitForFunction(()=>extensionRequests.length===2);
  assert.equal(await p.evaluate(()=>extensionRequests[1].payload.videoReceiptUrl),receiptUrl);
});

test('narrow desktop windows still open automatically and missing extensions leave usable fallback and retry', async t => {
  const p=await open(t,{desktop:true,width:390});await p.clock.install();await trigger(p).click();
  await p.waitForFunction(()=>extensionRequests.length===1);assert.equal(await p.locator('.video-receipt-order').isVisible(),true);
  await p.clock.fastForward(20100);assert.match(await p.locator('.video-receipt-extension-status').textContent(),/did not respond/);
  assert.equal(await p.locator('.video-receipt-find').isEnabled(),true);await p.locator('.video-receipt-find').click();
  await p.waitForFunction(()=>extensionRequests.length===2);
  await p.evaluate(()=>window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE',requestId:extensionRequests[1].requestId,payload:{ok:false,error:'Sign in to eBay first.'}},location.origin));
  await p.waitForFunction(()=>document.querySelector('.video-receipt-extension-status').textContent==='Sign in to eBay first.');
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});

test('desktop capture transfer attaches once to its item and returns to the pending queue', async t => {
  const p=await screenshotPage(t,{desktop:true});await p.evaluate(()=>{
    scheduleQueueVideoReceiptEvidenceHydration=originalScheduleReceiptHydration;
    state.ebayTransferReceiverReady=true;window.captureAcks=[];window.savedCaptures=[];
    supabase.rpc=async(name,args)=>{
      if(name!=='create_ebay_order_coordination_task')throw Error('Unexpected receipt write '+name);
      savedCaptures.push(structuredClone(args));return {data:{id:'captured-task'}};
    };
    setupEbayLabelReceiver();
    window.addEventListener('message',event=>{if(event.data?.type==='OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS')captureAcks.push(event.data.payload);});
    window.transfer={transferId:'desktop-fixture',metadata:{itemNumber:fixtureLine.item_number,transactionId:fixtureLine.transaction_id,orderNumber:fixtureLine.order.order_number,videoReceiptUrl:'https://www.ebay.com/ebaylive/events/fixture-event/stream?selectedItemId=123456789012&playback=true'},screenshot:{mimeType:'image/png',base64:testScreenshot.split(',')[1]}};
    window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER',payload:transfer},location.origin);
    window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER',payload:transfer},location.origin);
  });
  await p.waitForFunction(()=>captureAcks.some(ack=>ack.ok===true));
  assert.deepEqual(await p.evaluate(()=>savedCaptures.map(c=>c._order_line_ids)),[['line-one']]);
  assert.equal(await p.evaluate(()=>savedCaptures[0]._photo_attachments[0].label),'Video receipt - 123456789012');
  assert.deepEqual(await p.evaluate(()=>[getLineVideoReceiptPhotoCount(fixtureLine),getLineVideoReceiptPhotoCount(state.orders[1])]),[1,0]);
  assert.equal(await p.evaluate(()=>state.selectedLine),null);assert.equal(await p.locator('#manual-video-receipt-modal').isVisible(),false);
  assert.equal(await p.evaluate(()=>fixtureLine.line_status),'pending');
  await p.locator('[data-queue-video-evidence="line-one"] img').waitFor({state:'visible'});
});
