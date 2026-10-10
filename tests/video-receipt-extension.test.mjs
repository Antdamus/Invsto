import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../tools/ebay-og-order-link-extension/background.js', import.meta.url), 'utf8');
const receiptUrl = 'https://www.ebay.com/ebaylive/events/test/stream?selectedItemId=123456789012&playback=true';
const appTab = {id: 8, windowId: 1, url: 'https://antdamus.github.io/Invsto/pending-orders.html'};
const receiptTab = {id: 9, windowId: 1, url: receiptUrl};

function worker(t, {deferStorage = false, fetchImpl, receiptLookup, tabUrl, fastTimers = false} = {}) {
  let listener, delivered;
  const delivery = new Promise(resolve => { delivered = resolve; });
  let releaseStorage, lookupStarted, deliveryCount = 0;
  const storageWait = new Promise(resolve => { releaseStorage = resolve; });
  const lookup = new Promise(resolve => { lookupStarted = resolve; });
  const stored = {}, focused = [], created = [], timers = new Set();
  let createdTab = receiptTab;
  t.after(() => { for (const timer of timers) clearTimeout(timer); });
  const chrome = {
    runtime: {onMessage: {addListener(callback) { listener = callback; }}},
    storage: {
      sync: {async get() { return {ogPendingOrdersUrl: appTab.url}; }},
      local: {
        async set(values) { if (deferStorage) await storageWait; Object.assign(stored, values); },
        async remove(key) { delete stored[key]; },
      },
    },
    windows: {async update() {}},
    tabs: {
      async query() { lookupStarted(); return [appTab, receiptTab]; },
      async get(id) { return id === appTab.id ? appTab : {...createdTab, url: tabUrl || createdTab.url}; },
      async create(options) { created.push(options); createdTab = {...receiptTab, ...options}; return createdTab; },
      async update(id, options) { focused.push({id, ...options}); },
      async captureVisibleTab(windowId, options) {
        assert.equal(windowId, receiptTab.windowId);
        assert.equal(options.format, 'png');
        return 'data:image/png;base64,ZmFrZQ==';
      },
      async sendMessage(id, message) {
        if (message.type === 'OG_EBAY_FIND_ORDER_VIDEO_RECEIPT') {
          assert.equal(id, receiptTab.id);
          return receiptLookup?.(message.payload, createdTab) || {ok: false};
        }
        assert.equal(id, appTab.id);
        assert.equal(message.type, 'OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER');
        deliveryCount++; delivered(message.payload);
        return {ok: true};
      },
    },
  };
  vm.runInNewContext(source, {
    chrome, URL, console, AbortController,
    setTimeout(callback, ms) { const timer = setTimeout(callback, fastTimers ? ms / 100 : ms); timers.add(timer); return timer; },
    clearTimeout(timer) { timers.delete(timer); clearTimeout(timer); },
    fetch: fetchImpl || (() => { throw new Error('Saved receipt should open without fetching eBay pages'); }),
  });
  return {stored, focused, created, delivery, lookup, releaseStorage, get deliveryCount() {return deliveryCount;},
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

const lookupPayload = {orderNumber: '01-15278-16486', itemNumber: '123456789012'};
const detailsUrl = 'https://www.ebay.com/mesh/ord/details?orderid=01-15278-16486';
const lookupReply = (_payload, tab) => ({ok: true, receiptUrl, pageUrl: tab.url});

test('failed background fetch recovers in a fresh order tab and opens the exact receipt there', async t => {
  const requests = [];
  const w = worker(t, {fastTimers: true, async fetchImpl(url) {requests.push(url); throw new TypeError('Failed to fetch');},
    receiptLookup(payload, tab) {
      assert.equal(payload.orderNumber, lookupPayload.orderNumber);
      assert.equal(payload.itemNumber, lookupPayload.itemNumber);
      return lookupReply(payload, tab);
    }});
  const result = await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', lookupPayload);
  assert.equal(result.ok, true); assert.equal(result.source, 'order-tab');
  assert.equal(requests.length, 2);
  assert.equal(w.created.length, 1); assert.equal(w.created[0].url, detailsUrl); assert.equal(w.created[0].active, true);
  assert.equal(w.focused.length, 1); assert.equal(w.focused[0].id, receiptTab.id);
  assert.equal(w.focused[0].url, receiptUrl);
});

test('background lookup still opens the exact receipt directly when eBay supplies it', async t => {
  const w = worker(t, {async fetchImpl() {return {ok: true, async text() {return '<a href="' + receiptUrl + '">Receipt</a>';}};}});
  const result = await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', lookupPayload);
  assert.equal(result.ok, true); assert.equal(result.source, 'item');
  assert.equal(w.created[0].url, receiptUrl); assert.equal(w.focused.length, 0);
});

test('a stalled background response body is aborted, then receipt lookup continues in the order tab', async t => {
  let aborted = 0;
  const w = worker(t, {fastTimers: true, async fetchImpl(_url, {signal}) {
    return {ok: true, text: () => new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
      aborted++; reject(new Error('Aborted'));
    }))};
  }, receiptLookup: lookupReply});
  assert.equal((await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', lookupPayload)).ok, true);
  assert.equal(aborted, 2);
});

test('fallback waits for the new tab content script and dynamically rendered receipt', async t => {
  let attempts = 0;
  const w = worker(t, {fastTimers: true, receiptLookup(payload, tab) {
    attempts++;
    if (attempts === 1) throw new Error('Receiving end does not exist');
    if (attempts === 2) return {ok: false, pageUrl: tab.url};
    return lookupReply(payload, tab);
  }});
  assert.equal((await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', lookupPayload)).ok, true);
  assert.equal(attempts, 3); assert.equal(w.created.length, 1);
});

for (const unsafeUrl of [
  receiptUrl.replace('123456789012', '999999999999'),
  receiptUrl.replace('https:', 'http:'),
  receiptUrl.replace('www.ebay.com', 'example.com'),
]) {
  test('fallback never navigates to a mismatched or non-eBay HTTPS receipt: ' + unsafeUrl, async t => {
    const w = worker(t, {fastTimers: true, receiptLookup(_payload, tab) {return {receiptUrl: unsafeUrl, pageUrl: tab.url};}});
    const result = await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', lookupPayload);
    assert.equal(result.ok, false); assert.match(result.error, /matching video receipt/);
    assert.equal(w.focused.length, 0); assert.equal(w.created[0].url, detailsUrl);
  });
}

test('fallback does not overwrite a tab the operator navigated elsewhere', async t => {
  const w = worker(t, {fastTimers: true, receiptLookup: lookupReply, tabUrl: 'https://www.ebay.com/ship/bulk'});
  const result = await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', lookupPayload);
  assert.equal(result.ok, false); assert.match(result.error, /tab changed/);
  assert.equal(w.focused.length, 0);
});

test('a sign-in redirect gives actionable instructions and leaves eBay open', async t => {
  const w = worker(t, {fastTimers: true, async fetchImpl() {return {ok: false, status: 401};},
    tabUrl: 'https://signin.ebay.com/ws/eBayISAPI.dll?SignIn'});
  const result = await w.send('OG_EBAY_OPEN_VIDEO_RECEIPT', lookupPayload);
  assert.equal(result.ok, false); assert.match(result.error, /Sign in to eBay/);
  assert.equal(w.created.length, 1); assert.equal(w.focused.length, 0);
});

const contentSource = await readFile(new URL('../tools/ebay-og-order-link-extension/content.js', import.meta.url), 'utf8');
function orderPage({links = [], html = '', order = lookupPayload.orderNumber, menu = false} = {}) {
  const location = new URL('https://www.ebay.com/mesh/ord/details?orderid=' + order);
  let menuClicks = 0;
  const moreActions = {textContent: 'More actions', getAttribute: () => null, click() {menuClicks++;}};
  const document = {
    documentElement: {innerHTML: html},
    querySelectorAll(selector) {
      if (selector === 'button, [role="button"]') return menu ? [moreActions] : [];
      return links.map(href => ({getAttribute: () => href}));
    },
  };
  const context = {URL, document, window: {location}, cleanText: value => String(value || '').trim(),
    decodeHtmlEntities: value => String(value || '').replace(/&amp;/g, '&')};
  // Execute the production lookup and its helpers without unrelated shipping-page injection.
  vm.runInNewContext(contentSource.slice(contentSource.indexOf('  function normalizeEbayNavigationUrl('),
    contentSource.indexOf('  function setVideoReceiptStatus(')) + '\nthis.lookup = findOrderVideoReceiptForOg;', context);
  return {document, get menuClicks() {return menuClicks;}, lookup: context.lookup};
}

test('rendered order lookup ignores another line and selects the exact item from relative links', () => {
  const page = orderPage({links: [
    receiptUrl.replace('123456789012', '999999999999'),
    '/ebaylive/events/test/stream?itemIds=999999999999,123456789012&playback=true',
  ]});
  const result = page.lookup(lookupPayload);
  assert.equal(result.ok, true);
  assert.equal(new URL(result.receiptUrl).searchParams.get('selectedItemId'), lookupPayload.itemNumber);
});

test('rendered lookup opens More actions only once and picks up a receipt that appears afterward', () => {
  const page = orderPage({menu: true});
  assert.equal(page.lookup(lookupPayload).ok, false);
  assert.equal(page.lookup(lookupPayload).ok, false); assert.equal(page.menuClicks, 1);
  page.document.documentElement.innerHTML = '<a href="' + receiptUrl + '">View video receipt</a>';
  assert.equal(page.lookup(lookupPayload).receiptUrl, receiptUrl); assert.equal(page.menuClicks, 1);
});

test('rendered lookup refuses another order, an unidentified line, or an external receipt', () => {
  assert.match(orderPage({order: 'other', links: [receiptUrl]}).lookup(lookupPayload).error, /requested order/);
  assert.match(orderPage({links: [receiptUrl]}).lookup({orderNumber: lookupPayload.orderNumber}).error, /no eBay item number/);
  assert.equal(orderPage({links: [receiptUrl.replace('www.ebay.com', 'example.com')]}).lookup(lookupPayload).ok, false);
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
    assert.equal(payload.screenshot.dataUrl, undefined, 'send the original PNG once, without a duplicate data URL');
    assert.ok(w.stored[storageKey]);
    assert.equal(w.focused.length, 0);
    await w.send('OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS', {transferId: payload.transferId, phase: 'started'});
    assert.equal(w.focused.length, 0);
    await w.send('OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS', {transferId: payload.transferId, ok: success});
    const result = await capture;
    assert.equal(result.ok, success);
    assert.equal(Boolean(w.stored[storageKey]), !success);
    if (success) {
      assert.equal(w.focused.length, 1, 'a saved capture focuses OG only once');
      assert.ok(w.focused.every(tab => tab.id === appTab.id && tab.active === true));
    } else assert.equal(w.focused.length, 0);
  });
}

test('receipt tab lookup overlaps retry storage, but delivery waits for the durable retry copy', {timeout:5000}, async t=>{
  const w=worker(t,{deferStorage:true});
  const capture=w.send('OG_EBAY_CAPTURE_VIDEO_RECEIPT_FRAME', {metadata:{itemNumber:'123456789012'}},receiptTab);
  await w.lookup;
  assert.equal(w.deliveryCount,0);assert.equal(Object.keys(w.stored).length,0);
  w.releaseStorage();
  const payload=await w.delivery;
  assert.ok(w.stored[`ogPendingVideoReceiptPhoto:${payload.transferId}`]);
  await w.send('OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS',{transferId:payload.transferId,ok:true});
  assert.equal((await capture).ok,true);
});

test('receipt bridge stops repeating captured bytes on acceptance while unrelated or foreign statuses cannot stop delivery', async()=>{
  const code=await readFile(new URL('../tools/ebay-og-order-link-extension/app-bridge.js',import.meta.url),'utf8');
  const intervals=new Map(), sent=[], relayed=[];let onTransfer,onStatus,nextTimer=0;
  const window={location:{origin:'https://og.test',pathname:'/pending-orders.html'},
    postMessage(message){sent.push(message);},
    setInterval(callback){const id=++nextTimer;intervals.set(id,callback);return id;},
    clearInterval(id){intervals.delete(id);},addEventListener(type,fn){if(type==='message')onStatus=fn;}};
  const chrome={runtime:{onMessage:{addListener(fn){onTransfer=fn;}},
    async sendMessage(message){relayed.push(message);return {};}}};
  vm.runInNewContext(code,{window,chrome,console,URL,Map});
  const type='OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER';
  onTransfer({type,payload:{transferId:'capture-one',screenshot:{base64:'original'}}},null,()=>{});
  assert.equal(intervals.size,1);[...intervals.values()][0]();assert.equal(sent.length,2);
  const status=(id,source=window,origin=window.location.origin,extra={phase:'started'})=>onStatus({source,origin,
    data:{type:type+'_STATUS',payload:{transferId:id,...extra}}});
  status('other');status('capture-one',{},window.location.origin);status('capture-one',window,'https://foreign.test');
  assert.equal(intervals.size,1);
  status('capture-one');assert.equal(intervals.size,0);
  assert.equal(relayed.at(-1).payload.phase,'started','the background worker still receives the acceptance');
  onTransfer({type,payload:{transferId:'capture-two'}},null,()=>{});
  status('capture-two',window,window.location.origin,{ok:false});assert.equal(intervals.size,0);
  onTransfer({type,payload:{transferId:'no-receiver'}},null,()=>{});
  const before=sent.length;while(intervals.size)[...intervals.values()][0]();
  assert.equal(sent.length-before,60,'bounded retries remain when no page accepts the capture');
});
