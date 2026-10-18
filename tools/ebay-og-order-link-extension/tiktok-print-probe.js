/* Runs in TikTok's MAIN world. Capture only during an explicit OG print action. */
(function () {
  'use strict';
  if (window.__ogTikTokPrintProbe) return;
  window.__ogTikTokPrintProbe = true;
  const MAX = 10 * 1024 * 1024;
  let active = null;
  const originalFetch = window.fetch.bind(window), originalOpen = window.open;
  const alive = token => token && active === token && Date.now() < token.until;
  function documentUrl(value) {
    try {
      const url = new URL(value, location.href);
      return /^(blob:|data:application\/pdf)/i.test(url.href) || /\.pdf(?:[?#]|$)/i.test(url.href)
        || (url.origin === location.origin && /^\/easesafe\/oec_fulfillment_doc_na\/object\//.test(url.pathname));
    } catch (_) { return false; }
  }
  const post = payload => window.postMessage({type: 'OG_TIKTOK_PDF', payload}, window.location.origin);
  async function capture(blob, token) {
    if (!alive(token) || !(blob instanceof Blob) || blob.size > MAX) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    if (!alive(token) || !new TextDecoder().decode(bytes.slice(0, 1024)).includes('%PDF-') || !new TextDecoder().decode(bytes.slice(-4096)).includes('%%EOF')) return;
    let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    active = null;
    post({transferId: token.id, base64: btoa(binary)});
  }
  async function readUrl(value, token) {
    if (!alive(token) || typeof value !== 'string') return;
    const url = new URL(value, location.href);
    if (!['https:', 'blob:', 'data:'].includes(url.protocol) || token.urls.has(url.href)) return;
    token.urls.add(url.href);
    try {
      const response = await originalFetch(url.href, {credentials: url.origin === location.origin ? 'include' : 'omit', signal: AbortSignal.timeout(30000)});
      if (response.ok && response.status !== 206 && Number(response.headers.get('content-length')) <= MAX) await capture(await response.blob(), token);
    } catch (_) { /* Keep the native download/manual PDF fallback available. */ }
  }
  function documentUrls(value, token, depth = 0) {
    if (!alive(token) || !value || depth > 8) return;
    if (Array.isArray(value)) { value.slice(0, 100).forEach(v => documentUrls(v, token, depth + 1)); return; }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (typeof child === 'string' && documentUrl(child)) void readUrl(child, token);
      else if (typeof child === 'object') documentUrls(child, token, depth + 1);
    }
  }
  async function responseBody(response, url, token) {
    if (!alive(token) || !response.ok) return;
    const type = response.headers.get('content-type') || '';
    if (/pdf|octet-stream/i.test(type)) {
      if (response.status === 206) void readUrl(url, token);
      else if (Number(response.headers.get('content-length')) <= MAX) await capture(await response.blob(), token);
    } else if (/json/i.test(type) && /\/fulfillment\/.*\/doc\//i.test(url)) {
      documentUrls(await response.json(), token);
    }
  }
  window.addEventListener('message', event => {
    if (event.source !== window || event.origin !== location.origin) return;
    if (event.data?.type === 'OG_TIKTOK_PRINT_ARM' && /^[a-f0-9-]{36}$/i.test(event.data.id)) {
      active = {id: event.data.id, until: Date.now() + 120000, urls: new Set()};
      window.postMessage({type: 'OG_TIKTOK_PRINT_ARMED', id: active.id}, location.origin);
    }
    if (event.data?.type === 'OG_TIKTOK_PRINT_CANCEL') active = null;
  });
  window.fetch = async (...args) => {
    const token = active, response = await originalFetch(...args);
    if (alive(token)) void responseBody(response.clone(), response.url || String(args[0]?.url || args[0]), token).catch(() => {});
    return response;
  };
  const xhrOpen = XMLHttpRequest.prototype.open, xhrSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) { this.__ogPrintUrl = String(url); return xhrOpen.call(this, method, url, ...rest); };
  XMLHttpRequest.prototype.send = function(...args) {
    const token = active;
    this.addEventListener('load', () => {
      if (!alive(token) || this.status < 200 || this.status >= 300) return;
      const type = this.getResponseHeader('content-type') || '', url = this.responseURL || this.__ogPrintUrl;
      try {
        if (this.status === 206) { void readUrl(url, token); return; }
        if (this.response instanceof Blob) void capture(this.response, token);
        else if (this.response instanceof ArrayBuffer) void capture(new Blob([this.response]), token);
        else if (/\/fulfillment\/.*\/doc\//i.test(url) && /json/i.test(type)) documentUrls(this.responseType === 'json' ? this.response : JSON.parse(this.responseText), token);
      } catch (_) {}
    }, {once: true});
    return xhrSend.apply(this, args);
  };
  const createObjectURL = URL.createObjectURL;
  URL.createObjectURL = function(value) { if (alive(active)) void capture(value, active); return createObjectURL.call(this, value); };
  const anchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function(...args) {
    if (alive(active) && documentUrl(this.href)) void readUrl(this.href, active);
    return anchorClick.apply(this, args);
  };
  window.open = function(url, ...args) {
    if (alive(active) && typeof url === 'string' && documentUrl(url)) void readUrl(url, active);
    return originalOpen.call(this, url, ...args);
  };
})();
