import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {test, before, after} from 'node:test';
import {chromium, expect} from '@playwright/test';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const bridge = await readFile(new URL('tools/ebay-og-order-link-extension/app-bridge.js', root), 'utf8');
const manifest = JSON.parse(await readFile(new URL('tools/ebay-og-order-link-extension/manifest.json', root)));
const published = JSON.parse(await readFile(new URL('downloads/og-ebay-order-link-release.json', root)));
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
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});

async function installBridge(page, version) {
  await page.evaluate(version => {
    window.chrome = {runtime: {
      getManifest: () => ({version}),
      sendMessage: async () => ({appUrl: location.origin + '/pending-orders.html'}),
      onMessage: {addListener() {}},
    }};
  }, version);
  await page.addScriptTag({content: bridge});
}

async function open(t, {version = manifest.version, release = published, width = 1360, hash = '#extension-updates'} = {}) {
  const context = await browser.newContext({viewport: {width, height: 1100}});
  t.after(() => context.close());
  await context.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  const fixture = {release, requests: []};
  await page.route('**/og-ebay-order-link-release.json?*', route => {
    fixture.requests.push(route.request().url());
    return route.fulfill({status: fixture.release ? 200 : 503, contentType: 'application/json', body: JSON.stringify(fixture.release)});
  });
  await page.goto(origin + '/pending-orders.html' + hash);
  if (version) await installBridge(page, version);
  await page.addScriptTag({url: origin + '/extension-updates.js'});
  return {page, fixture};
}

test('current bridge and published version agree; popup/download metadata use the same release', async t => {
  assert.equal(published.version, manifest.version);
  assert.equal(published.sha256, createHash('sha256').update(await readFile(new URL('downloads/OG-eBay-Order-Link.zip', root))).digest('hex'));
  const {page} = await open(t);
  await expect(page.locator('#extension-update-badge')).toHaveText('Up to date');
  await expect(page.locator('#extension-updates')).toHaveAttribute('open', '');
  await expect(page.locator('#extension-installed-version')).toHaveText(`v${manifest.version}`);
  const download = new URL(await page.locator('#extension-download').getAttribute('href'));
  assert.equal(download.origin, origin);
  assert.equal(download.pathname, '/downloads/OG-eBay-Order-Link.zip');
  assert.equal(download.searchParams.get('v'), manifest.version);
  assert.equal(download.searchParams.get('build'), published.sha256.slice(0, 12));
  await mkdir(new URL('test-results', root), {recursive: true});
  await page.locator('#extension-updates').screenshot({path: fileURLToPath(new URL('test-results/extension-updates-desktop.png', root))});
});

test('numeric version comparison handles multi-digit releases and refreshes published versions', async t => {
  const {page, fixture} = await open(t, {version: '1.0.9', release: {...published, version: '1.0.10'}, hash: ''});
  await expect(page.locator('#extension-update-badge')).toHaveText('Update available');
  assert.equal(await page.locator('#extension-updates').getAttribute('open'), null, 'updates do not force open the section');
  await page.locator('#extension-updates > summary').click();
  await expect(page.locator('#extension-download')).toHaveText('Download v1.0.10 ZIP');
  fixture.release = {...published, version: '1.0.9.0'};
  await page.locator('#extension-check').click();
  await expect(page.locator('#extension-update-badge')).toHaveText('Up to date');
  assert.equal(fixture.requests.length, 2);
  assert.notEqual(fixture.requests[0], fixture.requests[1]);
});

test('a newer installed build does not prompt a downgrade', async t => {
  const {page} = await open(t, {version: '1.1.0'});
  await expect(page.locator('#extension-update-badge')).toHaveText('Newer version installed');
  await expect(page.locator('#extension-update-message')).toContainText('No downgrade is needed');
});

test('old/missing/disabled extension remains unverified and gives manual update steps', async t => {
  const {page} = await open(t, {version: null});
  await expect(page.locator('#extension-update-badge')).toHaveText('Version not detected', {timeout: 8000});
  await expect(page.locator('#extension-installed-version')).toHaveText('Not detected');
  await expect(page.locator('#extension-update-message')).toContainText('Older versions need one manual update');
  await installBridge(page, manifest.version);
  await page.locator('#extension-check').click();
  await expect(page.locator('#extension-update-badge')).toHaveText('Up to date');
});

test('bridge loaded after the initial request is still detected', async t => {
  const {page} = await open(t, {version: null});
  await installBridge(page, manifest.version);
  await expect(page.locator('#extension-update-badge')).toHaveText('Up to date');
});

test('failed or malformed release check never keeps an old up-to-date result', async t => {
  const {page, fixture} = await open(t);
  await expect(page.locator('#extension-update-badge')).toHaveText('Up to date');
  for (const release of [null, {...published, version: '<img src=x onerror=alert(1)>'}]) {
    fixture.release = release;
    await page.locator('#extension-check').click();
    await expect(page.locator('#extension-update-badge')).toHaveText('Check unavailable');
    await expect(page.locator('#extension-latest-version')).toHaveText('Unavailable');
    assert.equal(await page.locator('#extension-download').getAttribute('href'), origin + '/downloads/OG-eBay-Order-Link.zip');
    await expect(page.locator('#extension-installed-version')).toHaveText(`v${manifest.version}`);
  }
});

test('responses with unrelated requests or origins cannot mark a missing extension current', async t => {
  const {page} = await open(t, {version: null});
  await page.evaluate(version => {
    addEventListener('message', event => {
      if (event.data?.type !== 'OG_EBAY_EXTENSION_VERSION_REQUEST') return;
      const data = {type: 'OG_EBAY_EXTENSION_VERSION_RESPONSE', requestId: event.data.requestId, version};
      postMessage({...data, requestId: 'wrong-request'}, location.origin);
      dispatchEvent(new MessageEvent('message', {source: window, origin: 'https://other.example', data}));
      dispatchEvent(new MessageEvent('message', {source: null, origin: location.origin, data}));
    });
  }, manifest.version);
  await expect(page.locator('#extension-update-badge')).toHaveText('Version not detected', {timeout: 8000});
});

test('update instructions and controls fit a narrow screen', async t => {
  const {page} = await open(t, {width: 390, release: {...published, version: '1.0.10'}});
  await expect(page.locator('#extension-update-badge')).toHaveText('Update available');
  await page.locator('.extension-install-help > summary').click();
  const section = await page.locator('#extension-updates').boundingBox();
  assert.ok(section.x >= 0 && section.x + section.width <= 390);
  assert.equal(await page.locator('#extension-updates').evaluate(el => el.scrollWidth <= el.clientWidth), true);
  for (const selector of ['#extension-download', '#extension-check']) {
    const rect = await page.locator(selector).boundingBox();
    assert.ok(rect.x >= section.x && rect.x + rect.width <= section.x + section.width);
  }
  await page.screenshot({path: fileURLToPath(new URL('test-results/extension-updates-mobile.png', root))});
});

test('bridge version replies are scoped to configured OG pages or the public OG page', async () => {
  for (const [href, configured, allowed] of [
    ['https://antdamus.github.io/Invsto/pending-orders.html', '', true],
    ['https://private.example/pending-orders.html', 'https://private.example/pending-orders.html', true],
    ['https://other.example/pending-orders.html', 'https://private.example/pending-orders.html', false],
    ['https://antdamus.github.io/other/pending-orders.html', '', false],
    ['https://private.example/unrelated.html', 'https://private.example/pending-orders.html', false],
  ]) {
    const replies = []; let listener;
    const window = {location: new URL(href), addEventListener(type, fn) { if (type === 'message') listener = fn; }, postMessage(data) { replies.push(data); }};
    vm.runInNewContext(bridge, {window, URL, URLSearchParams, chrome: {runtime: {
      sendMessage: async () => ({appUrl: configured}),
      getManifest: () => manifest,
      onMessage: {addListener() {}},
    }}});
    listener({source: window, origin: window.location.origin, data: {type: 'OG_EBAY_EXTENSION_VERSION_REQUEST', requestId: 'valid'}});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(replies.length, allowed ? 1 : 0, href);
    if (allowed) assert.equal(replies[0].version, manifest.version);
  }
});

test('real unpacked extension reports its manifest version across the isolated content-script boundary', async t => {
  const extensionPath = fileURLToPath(new URL('tools/ebay-og-order-link-extension', root));
  const context = await chromium.launchPersistentContext('', {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  t.after(() => context.close());
  // Use the real public OG origin with local fixture responses; no live order data is accessed.
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'https://antdamus.github.io' || !url.pathname.startsWith('/Invsto/')) return route.abort();
    const name = url.pathname.slice('/Invsto/'.length);
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) return route.abort();
    try {
      let body = await readFile(new URL(name, root));
      if (name.endsWith('.html')) body = body.toString().replace(/<script\b[\s\S]*?<\/script>/gi, '');
      await route.fulfill({contentType: name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html', body});
    } catch { await route.abort(); }
  });
  const page = await context.newPage();
  await page.goto('https://antdamus.github.io/Invsto/pending-orders.html#extension-updates');
  await page.addScriptTag({url: 'https://antdamus.github.io/Invsto/extension-updates.js'});
  await expect(page.locator('#extension-update-badge')).toHaveText('Up to date', {timeout: 10000});
  await expect(page.locator('#extension-installed-version')).toHaveText(`v${manifest.version}`);
});
