import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { test, before, after } from 'node:test';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
let server, browser, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[a-z\d_/.-]+$/i.test(name) || name.includes('..')) return res.writeHead(404).end();
    try {
      let content = await readFile(new URL(name, root));
      if (name.endsWith('.html')) content = content.toString().replace(/<script\b[\s\S]*?<\/script>/gi, tag => tag.includes('src="barcode-scanner.js') ? tag : '');
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => { await browser?.close(); await new Promise(resolve => server?.close(resolve)); });

async function pageFor(t, name = 'add-inventory.html') {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.goto(`${origin}/${name}`);
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  return page;
}
const open = page => page.locator('[data-scan-target="input-to-search-inventory-item"]').click();
const status = page => page.locator('[data-camera="status"]');
async function deniedCamera(page) {
  await page.evaluate(() => { navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Denied', 'NotAllowedError'); }; });
}

async function fixture(page, format, code) {
  await page.addScriptTag({ url: `${origin}/vendor/zxing-browser-0.1.5.min.js` });
  await page.addScriptTag({ url: `${origin}/node_modules/jsbarcode/dist/JsBarcode.all.min.js` });
  const url = await page.evaluate(async ({ format, code }) => {
    const canvas = document.createElement('canvas');
    if (format === 'QR') {
      const svg = new ZXingBrowser.BrowserQRCodeSvgWriter().write(code, 400, 400);
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' }));
      const img = new Image(); img.src = url; await img.decode();
      canvas.width = canvas.height = 400;
      canvas.getContext('2d').drawImage(img, 0, 0);
      URL.revokeObjectURL(url);
    } else JsBarcode(canvas, code, { format, width: 3, height: 140, margin: 30, displayValue: false });
    return canvas.toDataURL('image/png');
  }, { format, code });
  return { name: 'barcode.png', mimeType: 'image/png', buffer: Buffer.from(url.split(',')[1], 'base64') };
}

test('real photo decoder reads Code 128, EAN-13, UPC and QR; preserves leading zeros until accepted', async t => {
  const page = await pageFor(t);
  await deniedCamera(page);
  for (const [format, code] of [['CODE128', '00OG-12345'], ['EAN13', '5901234123457'], ['UPC', '036000291452'], ['QR', 'TRAY-00027']]) {
    const photo = await fixture(page, format, code);
    await page.locator('#input-to-search-inventory-item').fill('unchanged');
    await open(page);
    await page.locator('[data-camera="photo"]').setInputFiles(photo);
    await page.waitForFunction(() => !document.querySelector('[data-camera="use"]').disabled);
    assert.equal(await page.locator('[data-camera="value"]').textContent(), code);
    assert.equal(await page.locator('#input-to-search-inventory-item').inputValue(), 'unchanged');
    await page.locator('[data-camera="use"]').click();
    assert.equal(await page.locator('#input-to-search-inventory-item').inputValue(), code);
    assert.equal(await page.locator('dialog').isVisible(), false);
  }
});

test('website QR is rejected without navigation; unreadable photos and denied cameras explain recovery', async t => {
  const page = await pageFor(t);
  await deniedCamera(page);
  const photo = await fixture(page, 'QR', 'https://www.og-jewelers.com/');
  await open(page);
  await page.waitForFunction(() => document.querySelector('[data-camera="status"]').textContent.includes('blocked'));
  await page.locator('[data-camera="photo"]').setInputFiles(photo);
  await page.waitForFunction(() => document.querySelector('[data-camera="status"]').textContent.includes('website or app'));
  assert.equal(await page.locator('[data-camera="use"]').isDisabled(), true);
  assert.equal(page.url(), `${origin}/add-inventory.html`);
  await page.locator('[data-camera="photo"]').setInputFiles({ name: 'bad.png', mimeType: 'image/png', buffer: Buffer.from('bad image') });
  await page.waitForFunction(() => document.querySelector('[data-camera="status"]').textContent.includes('No readable barcode'));
  await mkdir(new URL('test-results/', root), { recursive: true });
  await page.screenshot({ path: new URL('test-results/phone-scanner.png', root).pathname.replace(/^\/([A-Z]:)/, '$1') });
  const size = await page.locator('dialog').boundingBox();
  assert.ok(size.x >= 0 && size.width <= 390 && size.height <= 844);
});

test('real video decoder waits through blank frames, reads a barcode, and stops the video track', async t => {
  const page = await pageFor(t);
  const photo = await fixture(page, 'CODE128', 'OG-CAMERA-00012');
  await page.evaluate(async url => {
    const canvas = document.createElement('canvas');
    canvas.width = 900; canvas.height = 300;
    const context = canvas.getContext('2d');
    context.fillStyle = '#fff'; context.fillRect(0, 0, 900, 300);
    window.testStream = canvas.captureStream(15);
    setInterval(() => window.testStream.getVideoTracks()[0]?.requestFrame(), 80);
    navigator.mediaDevices.getUserMedia = async () => window.testStream;
    navigator.mediaDevices.enumerateDevices = async () => [];
    const img = new Image(); img.src = url; await img.decode();
    window.drawTestBarcode = () => context.drawImage(img, 20, 30);
  }, `data:image/png;base64,${photo.buffer.toString('base64')}`);
  await open(page);
  await page.waitForFunction(() => document.querySelector('[data-camera="video"]').readyState >= 2);
  await page.waitForTimeout(450); // Let the real reader encounter empty camera frames.
  assert.match(await status(page).textContent(), /Center the whole barcode/);
  await page.evaluate(() => window.drawTestBarcode());
  await page.waitForFunction(() => !document.querySelector('[data-camera="use"]').disabled);
  assert.equal(await page.locator('[data-camera="value"]').textContent(), 'OG-CAMERA-00012');
  assert.equal(await page.evaluate(() => window.testStream.getVideoTracks()[0].readyState), 'ended');
  await page.locator('[data-camera="use"]').click();
  assert.equal(await page.locator('#input-to-search-inventory-item').inputValue(), 'OG-CAMERA-00012');
});

async function fakeCamera(page, deferred = false) {
  await page.evaluate(deferred => {
    window.cameraStops = 0; window.controlStops = 0; window.cameraCalls = [];
    navigator.mediaDevices.getUserMedia = async constraints => {
      window.cameraCalls.push(constraints);
      if (deferred) await new Promise(resolve => { window.releasePermission = resolve; });
      const track = { stop: () => window.cameraStops++, getSettings: () => ({ deviceId: constraints.video.deviceId?.exact || 'rear' }) };
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    };
    navigator.mediaDevices.enumerateDevices = async () => ['rear', 'front'].map(deviceId => ({ kind: 'videoinput', deviceId }));
    window.ZXingBrowser = { BrowserMultiFormatReader: class {
      async decodeFromStream(stream, video, callback) {
        const controls = { stop: () => window.controlStops++ };
        window.deliverBarcode = code => callback({ getText: () => code }, null, controls);
        return controls;
      }
    } };
  }, deferred);
}

test('cancel releases late camera permission, stale results cannot change another field, and Escape stays inside scanner', async t => {
  const page = await pageFor(t);
  await fakeCamera(page, true);
  await page.evaluate(() => { window.underlyingKeys = 0; document.addEventListener('keydown', () => window.underlyingKeys++); });
  await open(page);
  await page.waitForFunction(() => window.releasePermission);
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.releasePermission());
  await page.waitForFunction(() => window.cameraStops === 1);
  assert.equal(await page.evaluate(() => window.underlyingKeys), 0);
  assert.equal(await page.locator('dialog').isVisible(), false);
  await fakeCamera(page);
  await open(page);
  await page.waitForFunction(() => window.deliverBarcode);
  await page.evaluate(() => { window.oldDelivery = window.deliverBarcode; });
  await page.locator('[data-camera="cancel"]').click();
  await open(page);
  await page.evaluate(() => window.oldDelivery('STALE-CODE'));
  assert.equal(await page.locator('[data-camera="use"]').isDisabled(), true);
  await page.locator('[data-camera="cancel"]').click();
  assert.ok(await page.evaluate(() => window.cameraStops >= 1));
});

test('switch camera stops previous stream; duplicate frames result in only one accepted input', async t => {
  const page = await pageFor(t);
  await fakeCamera(page);
  await page.evaluate(() => {
    window.inputs = 0;
    document.querySelector('#input-to-search-inventory-item').addEventListener('input', () => window.inputs++);
  });
  await open(page);
  await page.locator('[data-camera="switchCamera"]').click();
  await page.waitForFunction(() => window.cameraCalls.length === 2);
  assert.equal(await page.evaluate(() => window.cameraCalls[1].video.deviceId.exact), 'front');
  assert.ok(await page.evaluate(() => window.cameraStops >= 1));
  await page.evaluate(() => { window.deliverBarcode('000987'); window.deliverBarcode('000987'); });
  await page.locator('[data-camera="use"]').click();
  assert.equal(await page.evaluate(() => window.inputs), 1);
  assert.equal(await page.locator('#input-to-search-inventory-item').inputValue(), '000987');
});

test('camera acceptance runs the existing inventory lookup once and increments an existing batch once', async t => {
  const page = await pageFor(t);
  await page.addScriptTag({ url: `${origin}/add-inventory.js` });
  await page.evaluate(() => {
    window.lookups = []; window.confirmed = []; window.counts = [];
    ExtractItemWithBarcodeFromSupabase = async code => { window.lookups.push(code); return { barcode: code }; };
    showModalToConfirmItem = item => window.confirmed.push(item.barcode);
    incrementCardCount = code => window.counts.push(code);
    searchForBarcodeListener();
  });
  await fakeCamera(page);
  await open(page);
  await page.waitForFunction(() => window.deliverBarcode);
  await page.evaluate(() => { window.deliverBarcode('000123'); window.deliverBarcode('000123'); });
  await page.locator('[data-camera="use"]').click();
  await page.waitForFunction(() => window.confirmed.length === 1);
  assert.deepEqual(await page.evaluate(() => window.lookups), ['000123']);
  await page.evaluate(() => { currentBatch['000123'] = { count: 1 }; lastInventoryBarcodeScan.at = 0; });
  await open(page);
  await page.evaluate(() => window.deliverBarcode('000123'));
  await page.locator('[data-camera="use"]').click();
  await page.waitForFunction(() => window.counts.length === 1);
  assert.deepEqual(await page.evaluate(() => window.counts), ['000123']);
});

test('stock scan clears search filters and returns the matching item through real filtering', async t => {
  const page = await pageFor(t, 'stock.html');
  await page.addScriptTag({ url: `${origin}/stock.js` });
  await page.evaluate(() => {
    allItems = [{ id: 'one', barcode: '000123', title: 'Coin' }, { id: 'two', barcode: '456', title: 'Watch' }];
    applySortAndRender = items => { window.filteredCodes = items.map(item => item.barcode); };
    updateFilterChips = () => {}; updateURLFromForm = () => {}; showToast = () => {};
    setupDynamicFilters('filter-form'); setupClearFilters();
    document.querySelector('[name="title"]').value = 'Watch';
    showOnlyFavorites = true;
    document.querySelector('#show-favorites-only').checked = true;
    const location = document.createElement('span');
    location.className = 'dropdown-option selected'; location.dataset.location = 'elsewhere';
    document.body.append(location);
  });
  await fakeCamera(page);
  await page.locator('[data-scan-target="stock-barcode-search"]').first().click();
  await page.waitForFunction(() => window.deliverBarcode);
  await page.evaluate(() => window.deliverBarcode('000123'));
  await page.locator('[data-camera="use"]').click();
  assert.deepEqual(await page.evaluate(() => window.filteredCodes), ['000123']);
  assert.equal(await page.locator('#filter-form [name="title"]').inputValue(), '');
});

test('each placement scan button points to an editable input; disabled fields cannot open scanner', async t => {
  for (const name of ['add-item.html', 'add-inventory.html', 'stock.html']) {
    const page = await pageFor(t, name);
    const valid = await page.locator('[data-scan-target]').evaluateAll(buttons => buttons.every(button => {
      const target = document.getElementById(button.dataset.scanTarget);
      return target?.tagName === 'INPUT' && !target.readOnly;
    }));
    assert.equal(valid, true);
  }
  const page = await pageFor(t);
  await page.locator('#input-to-search-inventory-item').evaluate(el => { el.disabled = true; });
  await page.waitForFunction(() => document.querySelector('[data-scan-target="input-to-search-inventory-item"]').disabled);
  assert.equal(await page.locator('dialog').count(), 0);
});

test('barcode entry fields across the app have one adjacent camera control, including later-created fields', async t => {
  const pages = ['add-item.html', 'add-inventory.html', 'stock.html', 'pending-orders.html', 'live-sales.html', 'locations.html', 'store-transfers.html', 'ebay-order-history.html', 'ebay-returns.html', 'inventory-activity.html', 'past-live-sales.html', 'admin.html'];
  let covered = 0;
  for (const name of pages) {
    const page = await pageFor(t, name);
    const fields = await page.locator('input').evaluateAll(inputs => inputs
      .filter(input => ['text', 'search'].includes(input.type) && !input.readOnly && input.id !== 'manual-live-item-description' && /barcode|scan|tracking/i.test(`${input.id} ${input.placeholder}`))
      .map(input => ({ id: input.id, marked: input.hasAttribute('data-camera-scan'), adjacent: input.parentElement.classList.contains('camera-scan-field'), buttons: [...input.parentElement.querySelectorAll('[data-scan-target]')].filter(button => button.dataset.scanTarget === input.id).length, disabled: input.disabled, buttonDisabled: input.nextElementSibling?.disabled })));
    for (const field of fields) {
      assert.equal(field.marked, true, `${name}: ${field.id} is marked`);
      assert.equal(field.adjacent, true, `${name}: ${field.id} has adjacent control`);
      assert.equal(field.buttons, 1, `${name}: ${field.id} has no duplicate camera button`);
      assert.equal(field.buttonDisabled, field.disabled, `${name}: ${field.id} follows its input state`);
    }
    covered += fields.length;
    const badActions = await page.locator('[data-camera-action]').evaluateAll(inputs => inputs.filter(input => !document.getElementById(input.dataset.cameraAction)).map(input => input.id));
    assert.deepEqual(badActions, [], `${name}: every lookup action exists`);
    await page.close();
  }
  assert.equal(covered, 43);
  const page = await pageFor(t);
  await page.evaluate(() => {
    const holder = document.createElement('div'); holder.id = 'dynamic-test-field';
    holder.innerHTML = '<input id="dynamic-location" data-camera-scan placeholder="Scan location" disabled>';
    document.body.append(holder);
  });
  await page.waitForFunction(() => document.querySelector('[data-scan-target="dynamic-location"]'));
  assert.equal(await page.locator('[data-scan-target="dynamic-location"]').isDisabled(), true);
  await page.locator('#dynamic-location').evaluate(input => { input.disabled = false; });
  await page.waitForFunction(() => !document.querySelector('[data-scan-target="dynamic-location"]').disabled);
  await page.locator('#dynamic-test-field').evaluate(holder => { document.body.append(holder); });
  assert.equal(await page.locator('[data-scan-target="dynamic-location"]').count(), 1);
});

test('the Stock barcode filter has a visible mobile camera button and keeps the other search filters', async t => {
  const page = await pageFor(t, 'stock.html');
  await page.addScriptTag({ url: `${origin}/stock.js` });
  await page.evaluate(() => {
    setupToggleBehavior('toggle-filters', 'filter-section', 'Hide Filters', 'Show Filters');
    document.getElementById('toggle-filters').click();
    allItems = [{ id: 'one', barcode: '000123', title: 'Coin' }, { id: 'two', barcode: '456', title: 'Watch' }];
    applySortAndRender = items => { window.filteredCodes = items.map(item => item.barcode); };
    updateFilterChips = () => {}; updateURLFromForm = () => {}; showToast = () => {};
    setupDynamicFilters('filter-form'); setupClearFilters();
    document.querySelector('#filter-form [name="title"]').value = 'Coin';
  });
  const button = page.locator('#filter-form [data-scan-target="stock-barcode-search"]');
  await page.locator('#stock-barcode-search').focus();
  await button.scrollIntoViewIfNeeded();
  assert.equal(await button.isVisible(), true);
  const fieldBox = await page.locator('#stock-barcode-search').boundingBox();
  const buttonBox = await button.boundingBox();
  assert.ok(buttonBox.height >= 44 && buttonBox.x >= 0 && buttonBox.x + buttonBox.width <= 390);
  assert.ok(buttonBox.y >= fieldBox.y + fieldBox.height && buttonBox.y - fieldBox.y - fieldBox.height <= 12);
  await mkdir(new URL('test-results/', root), { recursive: true });
  await page.screenshot({ path: new URL('test-results/stock-barcode-field-mobile.png', root).pathname.replace(/^\/([A-Z]:)/, '$1') });
  await fakeCamera(page);
  await button.click();
  await page.waitForFunction(() => window.deliverBarcode);
  await page.evaluate(() => window.deliverBarcode('000123'));
  await page.locator('[data-camera="use"]').click();
  assert.deepEqual(await page.evaluate(() => window.filteredCodes), ['000123']);
  assert.equal(await page.locator('#filter-form [name="title"]').inputValue(), 'Coin');
});

test('camera acceptance in a stock sale modal runs its lookup once without submitting the sale', async t => {
  const page = await pageFor(t, 'stock.html');
  await page.addScriptTag({ url: `${origin}/stock.js` });
  await page.evaluate(() => {
    window.saleLookups = []; window.saleSubmits = 0;
    searchManualSaleItem = () => window.saleLookups.push(document.getElementById('manual-sale-item-scan').value);
    finalizeManualEbaySale = () => window.saleSubmits++;
    setupManualEbaySale();
    document.getElementById('manual-sale-item-scan').closest('.modal').classList.remove('hidden');
  });
  await fakeCamera(page);
  await page.locator('[data-scan-target="manual-sale-item-scan"]').click();
  await page.waitForFunction(() => window.deliverBarcode);
  await page.evaluate(() => { window.deliverBarcode('000-SALE'); window.deliverBarcode('000-SALE'); });
  await page.locator('[data-camera="use"]').click();
  assert.deepEqual(await page.evaluate(() => window.saleLookups), ['000-SALE']);
  assert.equal(await page.evaluate(() => window.saleSubmits), 0);
  assert.equal(await page.locator('#manual-sale-item-scan').isVisible(), true);
});

test('camera controls keep a barcode dropdown open until the accepted code reaches its field', async t => {
  const page = await pageFor(t);
  await page.evaluate(() => {
    const popup = document.createElement('div'); popup.id = 'barcode-dropdown';
    popup.innerHTML = '<input id="dropdown-barcode" data-camera-scan placeholder="Search location barcode">';
    document.body.append(popup);
    document.addEventListener('click', event => { if (!popup.contains(event.target)) popup.hidden = true; });
  });
  await fakeCamera(page);
  await page.locator('[data-scan-target="dropdown-barcode"]').click();
  await page.waitForFunction(() => window.deliverBarcode);
  await page.locator('[data-camera="switchCamera"]').click();
  await page.waitForFunction(() => window.cameraCalls.length === 2);
  assert.equal(await page.locator('#barcode-dropdown').isVisible(), true);
  await page.evaluate(() => window.deliverBarcode('TRAY-0042'));
  await page.locator('[data-camera="use"]').click();
  assert.equal(await page.locator('#barcode-dropdown').isVisible(), true);
  assert.equal(await page.locator('#dropdown-barcode').inputValue(), 'TRAY-0042');
});
