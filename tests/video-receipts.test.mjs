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

async function savedCaptureFixture(t, options = {}) {
  const p = await open(t, {saved: receiptUrl, ...options});
  await p.evaluate(() => {
    const image = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    window.capturePhoto = {bucket: 'order-evidence-photos', path: 'video-receipts/wrong.png', label: 'Video receipt - 123456789012'};
    window.keepPhoto = {...capturePhoto, path: 'video-receipts/correct.png'};
    const task = {id: 'receipt-task', order_id: 'order-one', order_line_ids: ['line-one'], status: 'resolved'};
    const outsideTask = {...task, id: 'outside-task', order_id: 'outside-order', order_line_ids: ['outside-line']};
    window.savedReceiptEvents = [{id: 'receipt-event', task_id: task.id, order_id: task.order_id,
      photo_attachments: [capturePhoto, keepPhoto], signed_by_email: 'camera@example.com', created_at: '2026-10-03T16:30:00Z'}];
    state.user = {id: 'staff', email: 'staff@example.com'};
    state.orders.push({...fixtureLine, id: 'outside-line', order_id: 'outside-order'});
    state.selectedOrderTasks = [task]; state.selectedOrderTaskEvents.set(task.id, structuredClone(savedReceiptEvents));
    state.queueVideoReceiptTasks = [task, outsideTask];
    state.queueVideoReceiptTaskEvents.set(task.id, structuredClone(savedReceiptEvents));
    state.queueVideoReceiptTaskEvents.set(outsideTask.id, [{...savedReceiptEvents[0], id: 'outside-event', task_id: outsideTask.id, order_id: outsideTask.order_id}]);
    state.queueVideoReceiptLoadedOrderIds = new Set(['order-one', 'outside-order']);
    state.videoReceiptEvidenceByLineId.set('line-one', {...capturePhoto, previewUrl: image, thumbnailUrl: image});
    state.videoReceiptEvidenceByLineId.set('outside-line', {...capturePhoto, previewUrl: image, thumbnailUrl: image});
    ensureEvidencePhotoPreviewUrls = async photo => ({...photo, previewUrl: image, thumbnailUrl: image});
    window.removeCalls = []; window.removeFails = false;
    supabase.rpc = async (name, args) => {
      if (name !== 'delete_ebay_video_receipt_capture') throw Error(`Unexpected RPC ${name}`);
      removeCalls.push({name, args});
      if (removeFails) return {error: {message: 'Removal unavailable'}};
      savedReceiptEvents = savedReceiptEvents.map(e => ({...e, photo_attachments: e.photo_attachments.filter(p => p.path !== args._path)}));
      return {data: {removed_count: 1}};
    };
    loadSelectedOrderTasks = async () => state.selectedOrderTaskEvents.set(task.id, structuredClone(savedReceiptEvents));
    renderOrders();
  });
  await p.evaluate(() => hydrateQueueVideoReceiptEvidenceThumbnails([fixtureLine]));
  return p;
}

test('saved receipt screenshots can be removed directly in the pending block without stale cached captures returning', async t => {
  const p = await savedCaptureFixture(t);
  p.on('dialog', d => d.accept());
  const remove = p.locator('[data-queue-video-evidence="line-one"] [data-remove-receipt]').first();
  assert.equal(await remove.isEnabled(), true, 'live preview is enriched with its saved event id');
  await remove.click();
  await p.waitForFunction(() => removeCalls.length === 1 && !state.videoReceiptEvidenceByLineId.has('line-one'));
  const result = await p.evaluate(() => ({
    calls: removeCalls,
    selected: getVideoReceiptEvidencePhotosForLine(fixtureLine).map(p => p.path),
    outside: state.queueVideoReceiptTaskEvents.get('outside-task')[0].photo_attachments.map(p => p.path),
    outsideLive: state.videoReceiptEvidenceByLineId.has('outside-line'),
  }));
  assert.equal(result.calls[0].args._event_id, 'receipt-event');
  assert.equal(result.calls[0].args._path, 'video-receipts/wrong.png');
  assert.deepEqual(result.selected, ['video-receipts/correct.png']);
  assert.ok(result.outside.includes('video-receipts/wrong.png'));
  assert.equal(result.outsideLive, true);
});

test('receipt Capture again reopens the exact item through the desktop capture extension', async t => {
  const p = await savedCaptureFixture(t, {desktop: true});
  await p.locator('[data-queue-video-evidence="line-one"] [data-recapture-receipt]').first().click();
  await p.waitForFunction(() => extensionRequests.length === 1);
  assert.equal(await p.evaluate(() => removeCalls.length), 0, 'recapture retains the original until explicitly removed');
});

test('cancelled or failed receipt removal keeps the saved screenshot and permits retry', async t => {
  const p = await savedCaptureFixture(t);
  p.once('dialog', d => d.dismiss());
  const remove = p.locator('[data-queue-video-evidence="line-one"] [data-remove-receipt]').first();
  await remove.click();
  assert.equal(await p.evaluate(() => removeCalls.length), 0);
  await p.evaluate(() => removeFails = true);
  p.on('dialog', d => d.accept());
  await remove.click();
  await p.waitForFunction(() => removeCalls.length === 1);
  await p.waitForFunction(() => !document.querySelector('[data-queue-video-evidence="line-one"] [data-remove-receipt]').disabled);
  assert.equal(await p.evaluate(() => getVideoReceiptEvidencePhotosForLine(fixtureLine).length), 2);
});

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

async function controlledCapturePage(t) {
  const p=await screenshotPage(t,{desktop:true});
  await p.evaluate(()=>{
    scheduleQueueVideoReceiptEvidenceHydration=originalScheduleReceiptHydration;
    state.ebayTransferReceiverReady=true;
    window.captureAcks=[];window.receiptUploads=[];window.receiptWrites=[];window.receiptReads=[];
    window.failReceiptOriginal=false;window.failReceiptWrite=false;window.failReceiptDisplay=false;
    window.receiptTaskArray=false;
    window.receiptEvents=[];window.receiptTasks=[];
    const uploadsReady=new Promise(resolve=>window.releaseReceiptUploads=resolve);
    const commitReady=new Promise(resolve=>window.releaseReceiptCommit=resolve);
    const displayReady=new Promise(resolve=>window.releaseReceiptDisplay=resolve);
    supabase.storage={from:bucket=>({
      async upload(path,blob){
        const original=!path.includes('/derivatives/');
        receiptUploads.push({path,size:blob.size,original,bytes:original?[...new Uint8Array(await blob.arrayBuffer())]:[]});
        await uploadsReady;
        if(original&&failReceiptOriginal)throw Error('Original screenshot upload failed');
        return {data:{path}};
      },
      async createSignedUrl(){await displayReady;return failReceiptDisplay?{error:{message:'Preview refresh unavailable'}}:{data:{signedUrl:testScreenshot}};},
    })};
    supabase.rpc=async(name,args)=>{
      if(name!=='create_ebay_order_coordination_task')throw Error('Unexpected receipt write '+name);
      receiptWrites.push(structuredClone(args));await commitReady;
      if(failReceiptWrite)return {error:{message:'Receipt audit save failed'}};
      const suffix=receiptWrites.length===1?'':`-${receiptWrites.length}`;
      const task={id:`new-receipt-task${suffix}`,order_id:fixtureLine.order_id,order_line_ids:args._order_line_ids,question:args._question,status:'open'};
      receiptTasks.push(task);receiptEvents.push({id:`new-receipt-event${suffix}`,task_id:task.id,order_id:task.order_id,photo_attachments:args._photo_attachments});
      return {data:receiptTaskArray?[task]:task};
    };
    supabase.from=table=>{
      const filters=[];
      const q={select(){return q;},eq(key,value){filters.push([key,value]);return q;},in(key,value){filters.push([key,value]);return q;},order(){return q;},
        then(resolve,reject){receiptReads.push({table,filters});return displayReady.then(()=>
          failReceiptDisplay?{error:{message:'History refresh unavailable'}}:{data:structuredClone((table==='ebay_order_tasks'?receiptTasks:receiptEvents)
            .filter(row=>filters.every(([key,value])=>Array.isArray(value)?value.includes(row[key]):row[key]===value)))}).then(resolve,reject);}};
      return q;
    };
    loadSelectedOrderTasks=async()=>{throw Error('Capture must not wait for the closing detail panel');};
    setupEbayLabelReceiver();
    window.addEventListener('message',event=>{if(event.data?.type==='OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS')captureAcks.push(event.data.payload);});
    window.receiptTransfer={transferId:'controlled-receipt',metadata:{itemNumber:fixtureLine.item_number,transactionId:fixtureLine.transaction_id,
      orderNumber:fixtureLine.order.order_number,videoReceiptUrl:'https://www.ebay.com/ebaylive/events/fixture-event/stream?selectedItemId=123456789012&playback=true'},
      screenshot:{mimeType:'image/png',base64:testScreenshot.split(',')[1]}};
  });
  return p;
}

test('receipt capture uploads together and returns after durable save while its preview and history refresh are slow',async t=>{
  const p=await controlledCapturePage(t);
  await p.evaluate(()=>{
    receiptTaskArray=true; // PostgREST can encode a composite task row as a one-element array.
    window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER',payload:receiptTransfer},location.origin);
  });
  await p.waitForFunction(()=>receiptUploads.length===3);
  assert.equal(await p.evaluate(()=>receiptWrites.length),0);
  assert.equal(await p.evaluate(()=>captureAcks.some(ack=>ack.ok)),false);
  assert.equal(await p.evaluate(()=>{
    const original=receiptUploads.find(upload=>upload.original);
    return btoa(String.fromCharCode(...original.bytes))===receiptTransfer.screenshot.base64;
  }),true,'original PNG bytes remain unchanged');
  await p.evaluate(()=>releaseReceiptUploads());
  await p.waitForFunction(()=>receiptWrites.length===1);
  assert.equal(await p.evaluate(()=>captureAcks.some(ack=>ack.ok)),false,'saving the audit record still gates the return');
  await p.evaluate(()=>releaseReceiptCommit());
  await p.waitForFunction(()=>captureAcks.some(ack=>ack.ok));
  assert.equal(await p.evaluate(()=>state.selectedLine),null);
  assert.equal(await p.evaluate(()=>receiptWrites[0]._photo_attachments[0].previewUrl),undefined,'transient previews are never saved in the database');
  assert.deepEqual(await p.evaluate(()=>receiptWrites[0]._order_line_ids),['line-one']);
  await p.locator('[data-queue-video-evidence="line-one"] img').waitFor({state:'visible'});
  assert.equal(await p.locator('[data-queue-video-evidence="line-one"] img').getAttribute('src'),await p.evaluate(()=>testScreenshot));
  assert.equal(await p.locator('[data-queue-video-evidence="line-one"] [data-remove-receipt]').isEnabled(),false);
  await p.evaluate(()=>releaseReceiptDisplay());
  await p.waitForFunction(()=>document.querySelector('[data-queue-video-evidence="line-one"] [data-remove-receipt]')?.disabled===false);
  assert.equal(await p.evaluate(()=>getVideoReceiptEvidencePhotosForLine(fixtureLine)[0].receiptEventId),'new-receipt-event');
  assert.equal(await p.evaluate(()=>receiptReads.some(read=>read.table==='ebay_order_task_events'&&read.filters.some(([key,value])=>key==='task_id'&&value==='new-receipt-task'))),true);
});

for(const failure of ['original','audit','display']){
  test(`receipt ${failure} failure preserves the correct save status and order selection`,async t=>{
    const p=await controlledCapturePage(t);
    await p.evaluate(failure=>{
      failReceiptOriginal=failure==='original';failReceiptWrite=failure==='audit';failReceiptDisplay=failure==='display';
      releaseReceiptUploads();releaseReceiptCommit();releaseReceiptDisplay();
      window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER',payload:receiptTransfer},location.origin);
    },failure);
    await p.waitForFunction(()=>captureAcks.some(ack=>typeof ack.ok==='boolean'));
    const result=await p.evaluate(()=>({ack:captureAcks.find(ack=>typeof ack.ok==='boolean'),selected:state.selectedLine?.id,
      writes:receiptWrites.length,hasPhoto:state.videoReceiptEvidenceByLineId.has('line-one')}));
    assert.equal(result.ack.ok,failure==='display');assert.equal(result.hasPhoto,failure==='display');
    assert.equal(result.selected,failure==='display'?undefined:'line-one');
    assert.equal(result.writes,failure==='original'?0:1);
    if(failure==='display')await p.locator('[data-queue-video-evidence="line-one"] img').waitFor({state:'visible'});
  });
}

test('late receipt details cannot restore a removed capture or replace a newer one',async t=>{
  const p=await controlledCapturePage(t);
  await p.evaluate(()=>{
    state.queueVideoReceiptLoadedOrderIds.add('order-one');
    releaseReceiptUploads();releaseReceiptCommit();
    window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER',payload:receiptTransfer},location.origin);
  });
  await p.waitForFunction(()=>captureAcks.some(ack=>ack.ok));
  await p.evaluate(()=>{
    const old=state.videoReceiptEvidenceByLineId.get('line-one');
    window.newCapture={...old,path:'newer-capture.png',receiptEventId:'newer-event'};
    state.videoReceiptEvidenceByLineId.set('line-one',newCapture);
    window.detailRead=refreshCapturedReceiptDetails(fixtureLine,old,{id:'new-receipt-task'});
    releaseReceiptDisplay();
  });
  await p.evaluate(()=>detailRead);
  assert.equal(await p.evaluate(()=>state.videoReceiptEvidenceByLineId.get('line-one').path),'newer-capture.png');
  await p.evaluate(async()=>{
    const photo=state.videoReceiptEvidenceByLineId.get('line-one');
    forgetReceiptCapture(fixtureLine.order_id,photo.bucket,photo.path);
    await refreshCapturedReceiptDetails(fixtureLine,photo,{id:'new-receipt-task'});
  });
  assert.equal(await p.evaluate(()=>state.videoReceiptEvidenceByLineId.has('line-one')),false);
});

test('successive receipt captures remain visible and removable when earlier history reads finish later',async t=>{
  const p=await controlledCapturePage(t);
  await p.evaluate(()=>{
    state.queueVideoReceiptLoadedOrderIds.add('order-one');
    releaseReceiptUploads();releaseReceiptCommit();
    window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER',payload:receiptTransfer},location.origin);
  });
  await p.waitForFunction(()=>captureAcks.some(ack=>ack.ok));
  await p.evaluate(()=>window.postMessage({type:'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER',payload:{...receiptTransfer,transferId:'second-capture'}},location.origin));
  await p.waitForFunction(()=>captureAcks.filter(ack=>ack.ok).length===2);
  assert.equal(await p.evaluate(()=>getVideoReceiptEvidencePhotosForLine(fixtureLine).length),2);
  await p.evaluate(()=>releaseReceiptDisplay());
  await p.waitForFunction(()=>getVideoReceiptEvidencePhotosForLine(fixtureLine).every(photo=>photo.receiptEventId));
  assert.equal(await p.locator('[data-queue-video-evidence="line-one"] [data-remove-receipt]').count(),2);
  assert.equal(await p.locator('[data-queue-video-evidence="line-one"] [data-remove-receipt]:disabled').count(),0);
});
