/* Private, expiring PDF handoff to the configured Invsto print-stations page. */
(function () {
  'use strict';
  const PREFIX = 'ogOnlinePrint:', MAX = 10 * 1024 * 1024, TTL = 60 * 60 * 1000;
  const CAPTURE = 'ogTikTokPrintCapture:', transfers = new Map(), fetching = new Set();
  function isTikTok(source, sender) { return source.origin === 'https://seller-us.tiktok.com' && !(sender.frameId > 0); }
  function isLabelUrl(value) {
    try { const url = new URL(value); return url.origin === 'https://seller-us.tiktok.com' && /^\/easesafe\/oec_fulfillment_doc_na\/object\/[a-zA-Z0-9_-]+$/.test(url.pathname); }
    catch (_) { return false; }
  }
  async function destination() {
    const settings = await chrome.storage.sync.get('ogPendingOrdersUrl');
    if (!settings.ogPendingOrdersUrl) throw new Error('Set your OG Pending Orders URL in the extension options first.');
    const app = new URL(settings.ogPendingOrdersUrl);
    if (app.protocol !== 'https:' && !(app.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(app.hostname))) throw new Error('Use an HTTPS OG address.');
    return new URL('print-stations.html', app);
  }
  function senderUrl(sender) {
    // sender.url identifies the frame; tab.url alone would trust unrelated frames.
    return new URL(sender.url || sender.tab?.url || 'about:blank');
  }
  function validId(id) { return typeof id === 'string' && /^[a-f0-9-]{36}$/i.test(id); }
  function validatePdf(base64) {
    if (typeof base64 !== 'string' || !base64 || base64.length > Math.ceil(MAX / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) throw new Error('Choose a PDF smaller than 10 MB.');
    const binary = atob(base64);
    if (binary.length > MAX || !binary.slice(0, 1024).includes('%PDF-') || !binary.slice(-4096).includes('%%EOF')) throw new Error('TikTok returned an incomplete PDF. Download the full PDF and try again.');
  }
  async function handle(message, sender) {
    const target = await destination(), source = senderUrl(sender);
    if (['OG_TIKTOK_PRINT_BEGIN', 'OG_TIKTOK_PRINT_CANCEL'].includes(message.type)) {
      if (!isTikTok(source, sender) || !Number.isInteger(sender.tab?.id) || !validId(message.transferId)) throw new Error('Open TikTok Seller Center to print.');
      const key = CAPTURE + sender.tab.id;
      if (message.type === 'OG_TIKTOK_PRINT_BEGIN') await chrome.storage.session.set({[key]: {id: message.transferId, until: Date.now() + 120000, sourceUrl: source.href}});
      else if ((await chrome.storage.session.get(key))[key]?.id === message.transferId) await chrome.storage.session.remove(key);
      return {ok: true};
    }
    if (message.type === 'OG_ONLINE_PRINT_SEND') {
      if (!isTikTok(source, sender)) throw new Error('Open TikTok Seller Center to send a label.');
      validatePdf(message.payload?.base64);
      if (!validId(message.payload?.transferId)) throw new Error('Invalid print transfer.');
      const transferId = message.payload.transferId, key = PREFIX + transferId;
      const stored = await chrome.storage.local.get(null);
      const expired = Object.keys(stored).filter(k => k.startsWith(PREFIX) && Date.now() - stored[k].createdAt > TTL);
      if (expired.length) await chrome.storage.local.remove(expired);
      const existing = stored[key];
      if (existing && Date.now() - existing.createdAt <= TTL) return {ok: true, transferId};
      await chrome.storage.local.set({[key]: {transferId, base64: message.payload.base64, title: 'TikTok shipping label', target: target.href, createdAt: Date.now()}});
      target.searchParams.set('onlinePrintTransfer', transferId);
      try { await chrome.tabs.create({url: target.href, active: true}); }
      catch (error) { await chrome.storage.local.remove(key); throw error; }
      return {ok: true, transferId};
    }
    if (source.origin !== target.origin || source.pathname !== target.pathname || sender.frameId > 0) throw new Error('Open the configured OG Print stations page.');
    const id = message.transferId;
    if (!validId(id) || source.searchParams.get('onlinePrintTransfer') !== id) throw new Error('Invalid print transfer.');
    const key = PREFIX + id, record = (await chrome.storage.local.get(key))[key];
    if (!record || record.target !== target.href || Date.now() - record.createdAt > TTL) {
      if (record) await chrome.storage.local.remove(key);
      throw new Error('This label handoff expired. Send the PDF from TikTok again.');
    }
    if (message.type === 'OG_ONLINE_PRINT_GET') return {ok: true, payload: record};
    if (message.type === 'OG_ONLINE_PRINT_DONE') {
      await chrome.storage.local.set({[key]: {transferId: id, target: record.target, createdAt: record.createdAt, completed: true, result: String(message.result || 'Print request completed.').slice(0, 400)}});
      return {ok: true};
    }
    return {ok: false};
  }
  function dispatch(message, sender) {
    if (message.type !== 'OG_ONLINE_PRINT_SEND') return handle(message, sender);
    // The MAIN-world probe and tab fallback may both finish for the same PDF.
    const key = `${sender.tab?.id}:${message.payload?.transferId}`;
    if (!transfers.has(key)) transfers.set(key, handle(message, sender).finally(() => transfers.delete(key)));
    return transfers.get(key);
  }
  async function capturePdfTab(tab) {
    if (!isLabelUrl(tab.url)) return;
    const sourceId = tab.openerTabId ?? tab.id, key = CAPTURE + sourceId;
    const capture = (await chrome.storage.session.get(key))[key];
    if (!capture) return;
    if (capture.until < Date.now()) { await chrome.storage.session.remove(key); return; }
    if (fetching.has(capture.id)) return;
    fetching.add(capture.id);
    try {
      const response = await fetch(tab.url, {credentials: 'include', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(30000)});
      if (!response.ok || response.status === 206) throw new Error('TikTok did not return the complete PDF. Use Choose PDF in the extension options.');
      if (Number(response.headers.get('content-length')) > MAX) throw new Error('Choose a PDF smaller than 10 MB.');
      // Bound reads even when the signed response does not advertise its length.
      const reader = response.body.getReader(), chunks = []; let length = 0;
      while (true) {
        const {value, done} = await reader.read(); if (done) break;
        length += value.length;
        if (length > MAX) { await reader.cancel(); throw new Error('Choose a PDF smaller than 10 MB.'); }
        chunks.push(value);
      }
      let binary = '';
      for (const chunk of chunks) for (let i = 0; i < chunk.length; i += 32768) binary += String.fromCharCode(...chunk.subarray(i, i + 32768));
      const current = (await chrome.storage.session.get(key))[key];
      if (current?.id !== capture.id || current.until < Date.now()) return;
      await dispatch({type: 'OG_ONLINE_PRINT_SEND', payload: {transferId: capture.id, base64: btoa(binary)}}, {url: capture.sourceUrl, tab: {id: sourceId}, frameId: 0});
      await chrome.storage.session.remove(key);
      await chrome.tabs.sendMessage(sourceId, {type: 'OG_TIKTOK_PRINT_CAPTURE_STATUS', transferId: capture.id, ok: true}).catch(() => {});
    } catch (error) {
      await chrome.tabs.sendMessage(sourceId, {type: 'OG_TIKTOK_PRINT_CAPTURE_STATUS', transferId: capture.id, ok: false, error: error.message}).catch(() => {});
    } finally { fetching.delete(capture.id); }
  }
  // TikTok sometimes opens a blank tab, then navigates it to a signed URL without
  // a .pdf suffix. Match only this document endpoint and this armed opener tab.
  chrome.tabs.onCreated?.addListener(tab => { void capturePdfTab(tab).catch(() => {}); });
  chrome.tabs.onUpdated?.addListener((_id, change, tab) => { if (change.url || change.status === 'complete') void capturePdfTab(tab).catch(() => {}); });
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!['OG_ONLINE_PRINT_SEND', 'OG_ONLINE_PRINT_GET', 'OG_ONLINE_PRINT_DONE', 'OG_TIKTOK_PRINT_BEGIN', 'OG_TIKTOK_PRINT_CANCEL'].includes(message?.type)) return false;
    dispatch(message, sender).then(sendResponse).catch(error => sendResponse({ok: false, error: error.message}));
    return true;
  });
})();
