import assert from 'node:assert/strict';
import {test, before, after} from 'node:test';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {chromium, expect} from '@playwright/test';
const root = new URL('../', import.meta.url);
const folder = 'tools/ebay-og-order-link-extension/';
const require = createRequire(import.meta.url), {PDFDocument} = require('../vendor/pdf-lib/pdf-lib.min.js');
const background = await readFile(new URL(folder + 'online-print-background.js', root), 'utf8');
const id = '11111111-1111-4111-8111-111111111111';
const app = 'https://og.example/Invsto/print-stations.html';
const pdf = Buffer.from('%PDF-1.4\ncomplete fixture\n%%EOF').toString('base64');
function worker(fetchPdf = async () => new Response(Buffer.from(pdf, 'base64'), {headers: {'content-type': 'application/pdf'}})) {
  const data = {}, session = {}, tabs = [], listeners = [], tabEvents = {}, notifications = [], fetches = [];
  vm.runInNewContext(background, {URL, Date, atob, btoa, AbortSignal, fetch: async (...args) => { fetches.push(args); return fetchPdf(...args); }, chrome: {
    storage: {session: {get: async key => ({[key]: session[key]}), set: async value => Object.assign(session, value), remove: async key => { delete session[key]; }}, sync: {get: async () => ({ogPendingOrdersUrl: 'https://og.example/Invsto/pending-orders.html'})}, local: {
      get: async key => key === null ? {...data} : {[key]: data[key]},
      set: async value => Object.assign(data, value), remove: async keys => { for (const key of Array.isArray(keys) ? keys : [keys]) delete data[key]; },
    }},
    tabs: {create: async value => { tabs.push(value); return {id: 1}; }, sendMessage: async (id, value) => notifications.push({id, ...value}), onCreated: {addListener: fn => tabEvents.created = fn}, onUpdated: {addListener: fn => tabEvents.updated = fn}},
    runtime: {onMessage: {addListener: listener => listeners.push(listener)}},
  }});
  const call = (message, url, frameId = 0) => new Promise(resolve => listeners[0](message, {url, tab: {url, id: 1}, frameId}, resolve));
  return {data, session, tabs, call, tabEvents, notifications, fetches};
}
test('private handoff enforces sender, configured receiver, size and complete PDF; duplicates do not open twice', async () => {
  const w = worker(), send = {type: 'OG_ONLINE_PRINT_SEND', payload: {transferId: id, base64: pdf}};
  assert.equal((await w.call(send, 'https://evil.example')).ok, false);
  assert.equal((await w.call(send, 'https://seller-us.tiktok.com/shipment/labels', 2)).ok, false);
  assert.equal((await w.call({...send, payload: {...send.payload, base64: btoa('%PDF- partial')}}, 'https://seller-us.tiktok.com/shipment/labels')).ok, false);
  assert.equal((await w.call(send, 'https://seller-us.tiktok.com/shipment/labels')).ok, true);
  assert.equal((await w.call(send, 'https://seller-us.tiktok.com/shipment/labels')).ok, true);
  assert.equal(w.tabs.length, 1); assert.equal(w.tabs[0].url, app + '?onlinePrintTransfer=' + id);
  const get = {type: 'OG_ONLINE_PRINT_GET', transferId: id};
  assert.equal((await w.call(get, 'https://evil.example/print-stations.html?onlinePrintTransfer=' + id)).ok, false);
  assert.equal((await w.call(get, app)).ok, false);
  assert.equal((await w.call(get, app + '?onlinePrintTransfer=' + id)).payload.base64, pdf);
  await w.call({type: 'OG_ONLINE_PRINT_DONE', transferId: id, result: 'Queued once'}, app + '?onlinePrintTransfer=' + id);
  const completed = (await w.call(get, app + '?onlinePrintTransfer=' + id)).payload;
  assert.equal(completed.completed, true); assert.equal(completed.base64, undefined);
  w.data['ogOnlinePrint:' + id].createdAt = Date.now() - 3600001;
  assert.equal((await w.call(get, app + '?onlinePrintTransfer=' + id)).ok, false);
  assert.equal(w.data['ogOnlinePrint:' + id], undefined);
});

test('signed PDF popup fallback follows only an armed TikTok opener and deduplicates tab events', async () => {
  const w = worker(), source = 'https://seller-us.tiktok.com/shipment/labels';
  const signed = 'https://seller-us.tiktok.com/easesafe/oec_fulfillment_doc_na/object/testsafe?sign=fixture';
  w.tabEvents.created({id: 2, openerTabId: 1, url: signed});
  await new Promise(resolve => setImmediate(resolve)); assert.equal(w.fetches.length, 0);
  assert.equal((await w.call({type: 'OG_TIKTOK_PRINT_BEGIN', transferId: id}, source)).ok, true);
  w.tabEvents.created({id: 3, openerTabId: 99, url: signed});
  w.tabEvents.created({id: 2, openerTabId: 1, url: 'https://evil.example/label.pdf'});
  w.tabEvents.created({id: 2, openerTabId: 1, url: 'about:blank'});
  w.tabEvents.updated(2, {url: signed}, {id: 2, openerTabId: 1, url: signed});
  w.tabEvents.updated(2, {status: 'complete'}, {id: 2, openerTabId: 1, url: signed});
  for (let i = 0; i < 50 && !w.notifications.length; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.fetches.length, 1); assert.equal(w.tabs.length, 1);
  assert.equal(w.notifications[0].ok, true);
  assert.equal(w.data['ogOnlinePrint:' + id].base64, pdf);
});

test('cancelling a signed PDF fetch prevents a late handoff', async () => {
  let release;
  const w = worker(() => new Promise(resolve => release = resolve)), source = 'https://seller-us.tiktok.com/shipment/labels';
  await w.call({type: 'OG_TIKTOK_PRINT_BEGIN', transferId: id}, source);
  w.tabEvents.created({id: 2, openerTabId: 1, url: 'https://seller-us.tiktok.com/easesafe/oec_fulfillment_doc_na/object/testsafe?sign=fixture'});
  for (let i = 0; i < 20 && !release; i++) await new Promise(resolve => setImmediate(resolve));
  await w.call({type: 'OG_TIKTOK_PRINT_CANCEL', transferId: id}, source);
  release(new Response(Buffer.from(pdf, 'base64')));
  for (let i = 0; i < 10; i++) await new Promise(resolve => setImmediate(resolve));
  assert.equal(w.tabs.length, 0);
});

let server, browser, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!path || path === 'print-stations.html') return res.setHeader('Content-Type', 'text/html; charset=utf-8').end('<!doctype html><html><head><meta charset="utf-8"><title>OG print test</title></head><body><main></main></body></html>');
    if (path === 'api/v1/fulfillment/na/doc/print') return res.setHeader('Content-Type', 'application/json').end(JSON.stringify({data: {pdf_url: origin + '/label.pdf'}}));
    if (path === 'label.pdf') return res.setHeader('Content-Type', 'application/pdf').end(Buffer.from(pdf, 'base64'));
    if (!/^[\w./-]+$/.test(path) || path.includes('..')) return res.writeHead(404).end();
    try { res.setHeader('Content-Type', (path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html') + '; charset=utf-8'); res.end(await readFile(new URL(path, root))); }
    catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => { await browser?.close(); if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); });
async function pageFor(t) {
  const context = await browser.newContext(); t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue() : route.abort());
  const page = await context.newPage(); const errors = [];
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []));
  await page.goto(origin); return page;
}
async function load(page, name) { await page.addScriptTag({url: origin + '/' + folder + name}); }
test('TikTok Print offers OG, cancel is inert, native print remains available, capture sends once', async t => {
  const page = await pageFor(t);
  await page.setContent('<div class="arco-modal"><h2>Print document</h2><label>Shipping label</label><p>PDF · 4x6 inches</p><button id="native">Print</button></div><button id="create">Create labels</button>');
  await page.evaluate(pdf => {
    window.transfers = []; window.nativeClicks = 0;
    window.chrome = {runtime: {sendMessage: async message => { if (message.type === 'OG_ONLINE_PRINT_SEND') transfers.push(message); return {ok: true}; }}};
    document.getElementById('native').onclick = () => {
      nativeClicks++;
      URL.createObjectURL(new Blob(['%PDF- incomplete'], {type: 'application/pdf'}));
      URL.createObjectURL(new Blob([atob(pdf)], {type: 'application/pdf'}));
      URL.createObjectURL(new Blob([atob(pdf)], {type: 'application/pdf'}));
    };
  }, pdf);
  await load(page, 'tiktok-print-probe.js'); await load(page, 'tiktok-print.js');
  await page.locator('#create').click(); assert.equal(await page.locator('dialog').count(), 0);
  await page.locator('#native').click(); await expect(page.locator('dialog')).toBeVisible();
  assert.equal(await page.evaluate(() => nativeClicks), 0);
  await page.getByRole('button', {name: 'Cancel', exact: true}).click(); assert.equal(await page.evaluate(() => nativeClicks), 0);
  await page.locator('#native').click(); await page.getByRole('button', {name: 'Use TikTok print', exact: true}).click();
  assert.equal(await page.evaluate(() => nativeClicks), 1); assert.equal(await page.evaluate(() => transfers.length), 0);
  await page.locator('#native').click();
  await mkdir(new URL('test-results', root), {recursive: true});
  await page.screenshot({path: new URL('test-results/tiktok-print-choice.png', root).pathname.replace(/^\/([A-Z]:)/, '$1')});
  await page.getByRole('button', {name: 'Print through OG', exact: true}).click();
  await expect.poll(() => page.evaluate(() => transfers.length)).toBe(1);
  assert.equal(await page.evaluate(() => nativeClicks), 2);
  assert.equal(await page.evaluate(() => transfers[0].payload.base64), pdf);
});
test('probe preserves fetch responses, ignores idle PDFs, and captures a full armed response', async t => {
  const page = await pageFor(t); await load(page, 'tiktok-print-probe.js');
  await page.evaluate(async () => {
    window.captures = []; addEventListener('message', e => { if (e.data?.type === 'OG_TIKTOK_PDF') captures.push(e.data.payload); });
    await fetch('/label.pdf');
  });
  assert.equal(await page.evaluate(() => captures.length), 0);
  await page.evaluate(id => new Promise(resolve => {
    addEventListener('message', async function ready(e) {
      if (e.data?.type !== 'OG_TIKTOK_PRINT_ARMED') return;
      removeEventListener('message', ready); window.originalResponse = await (await fetch('/label.pdf')).text(); resolve();
    });
    postMessage({type: 'OG_TIKTOK_PRINT_ARM', id}, location.origin);
  }), id);
  await expect.poll(() => page.evaluate(() => captures.length)).toBe(1);
  assert.equal(await page.evaluate(() => originalResponse), atob(pdf));
});

async function receiver(t, size = [288, 432]) {
  const page = await pageFor(t), document = await PDFDocument.create(); document.addPage(size);
  const base64 = Buffer.from(await document.save()).toString('base64');
  await page.evaluate(base64 => {
    window.jobs = []; window.uploads = []; window.completed = []; window.files = {}; window.signedIn = true;
    window.supabase = {
      auth: {getSession: async () => ({data: {session: signedIn ? {user: {id: 'staff'}} : null}})},
      storage: {from: bucket => ({upload: async (path, blob) => { uploads.push({bucket, path}); files[path] = blob; return {}; }, createSignedUrl: async path => ({data: {signedUrl: URL.createObjectURL(files[path])}})})},
      rpc: async (name, args) => name === 'list_print_stations' ? {data: [{id: 'shipping', name: 'Online shipping printer', paired: true, online: true, printer_connected: true, printer_name: 'DYMO 5XL', pdf_print_ready: true}]} : (jobs.push({name, args}), {data: {id: 'job-one'}}),
    };
    window.payload = {transferId: 'fixture', base64};
    addEventListener('message', event => {
      if (event.data?.type === 'OG_ONLINE_PRINT_READY') postMessage({type: 'OG_ONLINE_PRINT_DATA', payload}, location.origin);
      if (event.data?.type === 'OG_ONLINE_PRINT_COMPLETE') completed.push(event.data);
    });
  }, base64);
  await page.addScriptTag({url: origin + '/print-stations.js'});
  return page;
}
test('receiver cancellation queues nothing; retry sends chosen printer once and does not attach an order', async t => {
  const page = await receiver(t); await load(page, 'online-print-page.js');
  await expect(page.locator('[data-destination]')).toBeEnabled();
  assert.equal(await page.evaluate(() => jobs.length), 0);
  await page.locator('[data-cancel]').click();
  await expect(page.locator('#og-online-print [data-status]')).toContainText('cancelled');
  await page.locator('#og-online-print [data-print]').click();
  await page.locator('[data-destination]').selectOption('shipping');
  await page.locator('[data-send]').click();
  await expect(page.locator('#og-online-print [data-status]')).toContainText('Queued 1');
  assert.equal(await page.evaluate(() => uploads.length), 1);
  const jobs = await page.evaluate(() => jobs); assert.equal(jobs.length, 1);
  assert.equal(jobs[0].name, 'enqueue_shipping_label_print'); assert.equal(jobs[0].args._station_id, 'shipping');
  assert.match(jobs[0].args._source_path, /^online-print\/staff\/[a-f0-9]{64}\.pdf$/);
  await expect(page.locator('#og-online-print [data-print]')).toBeDisabled();
  await page.evaluate(() => postMessage({type: 'OG_ONLINE_PRINT_DATA', payload}, location.origin));
  assert.equal(await page.evaluate(() => jobs.length), 1);
});
test('A6 cannot enter remote 4x6 queue, and signing in can recover a waiting transfer', async t => {
  const page = await receiver(t, [297.64, 419.53]);
  await page.evaluate(() => signedIn = false); await load(page, 'online-print-page.js');
  await expect(page.locator('#og-online-print [data-status]')).toContainText('Sign in');
  assert.equal(await page.evaluate(() => uploads.length), 0);
  await page.evaluate(() => signedIn = true); await page.locator('#og-online-print [data-print]').click();
  await page.locator('[data-destination]').selectOption('shipping'); await page.locator('[data-send]').click();
  await expect(page.locator('#og-online-print [data-status]')).toContainText('not a 4 × 6');
  assert.equal(await page.evaluate(() => jobs.length), 0);
});

for (const mode of ['blob', 'signed-popup']) test(`real extension carries a TikTok ${mode} PDF into the existing OG picker`, async t => {
  const extensionPath = fileURLToPath(new URL(folder, root));
  const context = await chromium.launchPersistentContext('', {channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`]});
  t.after(() => context.close());
  const doc = await PDFDocument.create(); doc.addPage([288, 432]);
  const label = Buffer.from(await doc.save()).toString('base64');
  const signedUrl = 'https://seller-us.tiktok.com/easesafe/oec_fulfillment_doc_na/object/fixturesafe?sign=fixture';
  const createPdf = mode === 'signed-popup' ? `const popup=window.open('about:blank'); popup.location.href='${signedUrl}';` : `URL.createObjectURL(new Blob([Uint8Array.from(atob('${label}'),c=>c.charCodeAt(0))],{type:'application/pdf'}));`;
  const ogOrigin = 'https://og.example';
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.protocol === 'chrome-extension:') return route.continue();
    if (url.href === signedUrl) return route.fulfill({contentType: 'application/pdf', body: Buffer.from(label, 'base64')});
    if (url.origin === 'https://seller-us.tiktok.com') return route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><div role="dialog"><h2>Print document</h2><label data-id="fulfillment.print_document.selection.shipping_label"><input type="checkbox" checked>Shipping label</label><p>PDF · 4x6 inches</p><button id="print">Print</button></div><script>document.getElementById('print').onclick=()=>{${createPdf}};</script>`});
    if (url.origin !== ogOrigin) return route.abort();
    if (url.pathname === '/Invsto/print-stations.html') return route.fulfill({contentType: 'text/html; charset=utf-8', body: `<!doctype html><meta charset="utf-8"><main><h1>Print stations</h1></main><script>
      window.jobs=[];window.savedFiles={};window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:'staff'}}}})},storage:{from:()=>({upload:async(path,blob)=>{savedFiles[path]=blob;return {};},createSignedUrl:async path=>({data:{signedUrl:URL.createObjectURL(savedFiles[path])}})})},rpc:async(name,args)=>name==='list_print_stations'?{data:[{id:'shipping',name:'Online shipping printer',paired:true,online:true,printer_connected:true,printer_name:'DYMO 5XL',pdf_print_ready:true}]}:(jobs.push({name,args}),{data:{id:'job'}})};
      </script><script src="print-stations.js"></script>`});
    const path = url.pathname.slice('/Invsto/'.length);
    if (!/^[\w./-]+$/.test(path) || path.includes('..')) return route.abort();
    try { await route.fulfill({contentType: (path.endsWith('.js') ? 'text/javascript' : 'text/css') + '; charset=utf-8', body: await readFile(new URL(path, root))}); }
    catch { await route.abort(); }
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  await worker.evaluate(() => chrome.storage.sync.set({ogPendingOrdersUrl: 'https://og.example/Invsto/pending-orders.html'}));
  // Chromium tab events and sender metadata remain real; only the signed transport is mocked.
  await worker.evaluate(({signedUrl, label}) => {
    const original = globalThis.fetch;
    globalThis.fetch = (url, options) => String(url) === signedUrl
      ? Promise.resolve(new Response(Uint8Array.from(atob(label), c => c.charCodeAt(0)), {headers: {'content-type': 'application/pdf'}}))
      : original(url, options);
  }, {signedUrl, label});
  const source = await context.newPage(); await source.goto('https://seller-us.tiktok.com/shipment/labels');
  await source.locator('#print').click();
  const opened = context.waitForEvent('page', {predicate: page => page.waitForURL(ogOrigin + '/Invsto/print-stations.html?onlinePrintTransfer=*', {timeout: 15000}).then(() => true, () => false)});
  await source.getByRole('button', {name: 'Print through OG', exact: true}).click();
  const receiver = await opened;
  await expect(receiver.locator('[data-destination]')).toBeEnabled({timeout: 15000});
  await receiver.locator('[data-destination]').selectOption('shipping');
  assert.equal(await receiver.evaluate(() => jobs.length), 0);
  await receiver.screenshot({path: fileURLToPath(new URL('test-results/tiktok-online-printer.png', root))});
  await receiver.locator('[data-send]').click();
  await expect(receiver.locator('#og-online-print [data-status]')).toContainText('Queued 1');
  assert.equal(await receiver.evaluate(() => jobs.length), 1);
  await expect.poll(() => worker.evaluate(async () => Object.values(await chrome.storage.local.get(null)).filter(record => record.completed).length)).toBe(1);
  await receiver.reload();
  await expect(receiver.locator('#og-online-print [data-status]')).toContainText('Queued 1');
  assert.equal(await receiver.locator('[data-destination]').count(), 0);
});
