import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { test, before, after } from 'node:test';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
let browser, server, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[a-z\d.-]+$/i.test(name)) return res.writeHead(404).end();
    try {
      let content = await readFile(new URL(name, root), 'utf8');
      if (name.endsWith('.html')) content = content.replace(/<script\b[\s\S]*?<\/script>/gi,
        tag => /src="(?:stock-cgl-label|additem-dymolabel|print-stations)\.js/.test(tag) ? tag : '');
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});

async function openPage(t, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 844 }, acceptDownloads: true });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(async () => { await page.close(); assert.deepEqual(errors, []); });
  await page.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  await page.addInitScript(() => {
    window.testCalls = []; window.testJobs = []; window.testFail = false;
    window.latestDymoXml = 'staged item'; window.latestDymoUrl = 'labels/staged.dymo'; window.latestDymoBarcode = 'OG123';
    const forbidden = () => { throw new Error('CGL printing must not access stock or storage.'); };
    window.supabase = {
      from: forbidden, storage: { from: forbidden },
      auth: { getSession: async () => ({ data: { session: { user: { id: 'staff' } } } }) },
      rpc: async (name, args) => {
        window.testCalls.push(name);
        if (name === 'list_print_stations') return { data: [{ id: 'counter', name: 'Shipping counter', paired: true, online: true, printer_connected: true, printer_name: 'DYMO LabelWriter' }] };
        if (name === 'enqueue_label_print') {
          window.testJobs.push(args);
          return window.testFail ? { error: { message: 'Connection lost' } } : { data: { id: 'job-1', status: 'queued' } };
        }
        throw new Error(`Unexpected RPC: ${name}`);
      },
    };
  });
  await page.goto(`${origin}/stock.html`);
  await page.locator('#open-cgl-label').click();
  await page.locator('#cgl-label-dialog').waitFor({ state: 'visible' });
  return page;
}

async function choosePrinter(page, destination = 'counter', copies = '1') {
  await page.locator('[data-destination]:enabled').selectOption(destination);
  await page.locator('[data-copies]').fill(copies);
  await page.locator('[data-send]').click();
}

test('standalone CGL prints through the existing selector and leaves stock state untouched', async t => {
  const page = await openPage(t);
  await page.locator('#print-cgl-label').click();
  assert.deepEqual(await page.evaluate(() => window.testCalls), []);
  const qr = 'https://certificate.example/report?id=000123&key="<original>"';
  await page.locator('#cgl-label-qr').fill(qr);
  await page.locator('#print-cgl-label').click();
  assert.equal(await page.locator('#print-cgl-label').isDisabled(), true);
  assert.deepEqual(await page.evaluate(() => window.testJobs), []);
  await choosePrinter(page, 'counter', '2');
  await page.waitForFunction(() => document.getElementById('cgl-label-status').textContent.includes('Queued 2 labels'));
  const jobs = await page.evaluate(() => window.testJobs);
  assert.equal(jobs.length, 1); assert.equal(jobs[0]._copies, 2); assert.equal(jobs[0]._station_id, 'counter');
  const values = await page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    return { errors: doc.querySelectorAll('parsererror').length, codes: [...doc.querySelectorAll('DataString')].map(node => node.textContent),
      label: doc.querySelector('LabelName').textContent };
  }, jobs[0]._label_xml);
  assert.deepEqual(values, { errors: 0, codes: [qr, qr, qr, qr], label: 'Jewelry30299' });
  assert.deepEqual(await page.evaluate(() => [window.latestDymoXml, window.latestDymoUrl, window.latestDymoBarcode]), ['staged item', 'labels/staged.dymo', 'OG123']);
  assert.equal(await page.locator('#print-cgl-label').isEnabled(), true);
  await mkdir(new URL('test-results/', root), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('test-results/cgl-label-desktop.png', root)) });
});

test('phone dialog fits, cancellation sends nothing, and local download contains only CGL codes', async t => {
  const page = await openPage(t, 390);
  const qr = '0000123456';
  await page.locator('#cgl-label-qr').fill(qr);
  const bounds = await page.locator('#cgl-label-dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 390 && bounds.height <= 844);
  await mkdir(new URL('test-results/', root), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('test-results/cgl-label-phone.png', root)) });
  await page.locator('#print-cgl-label').click();
  await page.locator('[data-cancel]').click();
  await page.waitForFunction(() => document.getElementById('cgl-label-status').textContent.includes('cancelled'));
  assert.deepEqual(await page.evaluate(() => window.testJobs), []);
  assert.equal(await page.locator('#cgl-label-qr').inputValue(), qr);
  await page.locator('#print-cgl-label').click();
  const downloadReady = page.waitForEvent('download');
  await choosePrinter(page, 'local', '3');
  const download = await downloadReady;
  assert.match(download.suggestedFilename(), /CGLLabel_CGL_.*Copies_3.*\.dymo$/);
  const xml = await readFile(await download.path(), 'utf8');
  assert.equal((xml.match(/<DataString>0000123456<\/DataString>/g) || []).length, 4);
  assert.deepEqual(await page.evaluate(() => window.testJobs), []);
  await page.locator('#close-cgl-label').click();
  await page.locator('#open-cgl-label').click();
  assert.equal(await page.locator('#cgl-label-qr').inputValue(), '');
});

test('failed send keeps the certificate and retries with the same print request identity', async t => {
  const page = await openPage(t);
  await page.locator('#cgl-label-qr').fill('https://certificate.example/000123');
  await page.evaluate(() => { window.testFail = true; });
  await page.locator('#print-cgl-label').click();
  await choosePrinter(page);
  await page.waitForFunction(() => document.getElementById('cgl-label-status').textContent === 'Connection lost');
  assert.equal(await page.locator('#cgl-label-qr').inputValue(), 'https://certificate.example/000123');
  await page.evaluate(() => { window.testFail = false; });
  await page.locator('#print-cgl-label').click();
  await choosePrinter(page);
  await page.waitForFunction(() => document.getElementById('cgl-label-status').textContent.includes('Queued 1 label'));
  const jobs = await page.evaluate(() => window.testJobs);
  assert.equal(jobs.length, 2); assert.equal(jobs[0]._request_id, jobs[1]._request_id);
});
