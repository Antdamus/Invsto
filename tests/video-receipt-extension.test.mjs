import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../tools/ebay-og-order-link-extension/background.js', import.meta.url), 'utf8');
const receiptUrl = 'https://www.ebay.com/ebaylive/events/test/stream?selectedItemId=123456789012&playback=true';
const appTab = {id: 8, windowId: 1, url: 'https://antdamus.github.io/Invsto/pending-orders.html'};
const receiptTab = {id: 9, windowId: 1, url: receiptUrl};

function worker(t) {
  let listener, delivered;
  const delivery = new Promise(resolve => { delivered = resolve; });
  const stored = {}, focused = [], created = [], timers = new Set();
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const chrome = {
    runtime: {onMessage: {addListener(callback) { listener = callback; }}},
    storage: {
      sync: {async get() { return {ogPendingOrdersUrl: appTab.url}; }},
      local: {
        async set(values) { Object.assign(stored, values); },
        async remove(key) { delete stored[key]; },
      },
    },
    windows: {async update() {}},
    tabs: {
      async query() { return [appTab, receiptTab]; },
      async get(id) { return id === appTab.id ? appTab : receiptTab; },
      async create(options) { created.push(options); return receiptTab; },
      async update(id, options) { focused.push({id, ...options}); },
      async captureVisibleTab(windowId, options) {
        assert.equal(windowId, receiptTab.windowId);
        assert.equal(options.format, 'png');
        return 'data:image/png;base64,ZmFrZQ==';
      },
      async sendMessage(id, message) {
        assert.equal(id, appTab.id);
        assert.equal(message.type, 'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER');
        delivered(message.payload);
        return {ok: true};
      },
    },
  };
  vm.runInNewContext(source, {
    chrome, URL, console,
    setTimeout(callback, ms) { const timer = setTimeout(callback, ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch() { throw new Error('Saved receipt should open without fetching eBay pages'); },
  });
  return {stored, focused, created, delivery,
    send(type, payload, tab = appTab) {
      return new Promise(resolve => assert.equal(listener({type, payload}, {tab}, resolve), true));
    },
  };
}

test('installed extension opens a saved exact-item receipt in an active eBay tab', async t => {
  const w = worker(t);
  const result = await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', {videoReceiptUrl: receiptUrl, itemNumber: '123456789012'});
  assert.equal(result.ok, true);
  assert.equal(result.openedUrl, receiptUrl);
  assert.equal(w.created.length, 1);
  assert.equal(w.created[0].url, receiptUrl);
  assert.equal(w.created[0].active, true);
});

for (const success of [true, false]) {
  test(success ? 'capture returns to Pending Orders only after the screenshot is saved'
    : 'a failed screenshot save retains the capture for retry and does not return as success', {timeout: 5000}, async t => {
    const w = worker(t);
    const capture = w.send('OG_EBAY_CAPTURE_VIDEO_RECEIPT_FRAME', {
      metadata: {itemNumber: '123456789012', videoReceiptUrl: receiptUrl},
    }, receiptTab);
    const payload = await w.delivery;
    const storageKey = `ogPendingVideoReceiptPhoto:${payload.transferId}`;
    assert.equal(payload.metadata.itemNumber, '123456789012');
    assert.equal(payload.screenshot.base64, 'ZmFrZQ==');
    assert.ok(w.stored[storageKey]);
    assert.equal(w.focused.length, 0);
    await w.send('OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS', {transferId: payload.transferId, phase: 'started'});
    assert.equal(w.focused.length, 0);
    await w.send('OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS', {transferId: payload.transferId, ok: success});
    const result = await capture;
    assert.equal(result.ok, success);
    assert.equal(Boolean(w.stored[storageKey]), !success);
    if (success) {
      assert.ok(w.focused.length > 0);
      assert.ok(w.focused.every(tab => tab.id === appTab.id && tab.active === true));
    } else assert.equal(w.focused.length, 0);
  });
}
