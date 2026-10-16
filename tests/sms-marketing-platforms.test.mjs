import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../sms-marketing.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../sms-marketing.js', import.meta.url), 'utf8');

async function openComposer({ confirm = true, send } = {}) {
  const elements = new Map();
  const requests = [], confirmations = [], errors = [];
  function element(value = '') {
    const events = new Map();
    const attributes = {};
    return {
      value, textContent: '', innerHTML: '', className: '', style: {}, dataset: {}, disabled: false,
      classList: { toggle() {} }, setAttribute: (key, value) => { attributes[key] = value; },
      getAttribute: key => attributes[key], focus() {},
      addEventListener: (type, fn) => events.set(type, fn),
      emit: (type) => events.get(type)?.({ preventDefault() {} }),
    };
  }
  for (const [, id] of html.matchAll(/\bid="([^"]+)"/g)) elements.set(`#${id}`, element());
  const platforms = ['ebay', 'tiktok'].map(key => Object.assign(element(), { dataset: { showPlatform: key } }));
  elements.get('#templateSelect').value = 'starting-soon';
  let loaded;
  const summary = { subscribedCount: 69, totalCount: 84, recentCampaigns: [] };
  const window = {
    setTimeout, clearTimeout, location: {}, SUPABASE_URL: 'https://example.invalid', SUPABASE_ANON_KEY: 'test',
    confirm: text => { confirmations.push(text); return confirm; },
    supabaseClient: {
      auth: { getSession: async () => ({ data: { session: { access_token: 'test', user: { id: 'admin' } } } }) },
      from: () => { const q = { select: () => q, eq: () => q, maybeSingle: async () => ({ data: { role: 'admin', active: true } }) }; return q; },
    },
  };
  vm.runInNewContext(source, {
    window, URL, Date, console: { error: (...args) => errors.push(args) },
    document: {
      querySelector: selector => elements.get(selector),
      querySelectorAll: selector => selector === '[data-show-platform]' ? platforms : [],
      addEventListener: (type, callback) => { if (type === 'DOMContentLoaded') loaded = callback; },
    },
    fetch: async (url, options) => {
      assert.equal(url, 'https://example.invalid/functions/v1/sms-marketing-admin');
      const request = JSON.parse(options.body);
      requests.push(request);
      if (request.action === 'send' && send) await send(request);
      return { ok: true, json: async () => ({ ok: true, summary, subscribers: [], autoMessages: [], result: { audienceCount: 69, sentCount: 69 } }) };
    },
  });
  loaded();
  await new Promise(setImmediate);
  assert.deepEqual(errors, []);
  assert.equal(elements.get('#audiencePill').textContent, '69 recipients');
  return {
    get: id => elements.get(`#${id}`), requests, confirmations, platforms,
    switchTo: key => platforms.find(button => button.dataset.showPlatform === key).emit('click'),
    set: (id, value, event = 'input') => { const target = elements.get(`#${id}`); target.value = value; return target.emit(event); },
    submit: () => elements.get('#smsForm').emit('submit'),
  };
}

test('TikTok templates invite customers to TikTok and preserve branding and opt-out preview', async () => {
  const page = await openComposer();
  page.switchTo('tiktok');
  assert.equal(page.get('showPlatformHeading').textContent, 'Send TikTok Show Alert');
  assert.equal(page.get('showLinkLabel').textContent, 'TikTok show link');
  assert.equal(page.get('linkUrl').value, '');
  assert.equal(page.platforms[1].getAttribute('aria-pressed'), 'true');
  for (const key of ['starting-soon', 'next-show', 'reminder', 'live-now', 'last-call']) {
    page.set('templateSelect', key, 'change');
    assert.match(page.get('messageBody').value, /TikTok/);
    assert.match(page.get('campaignTitle').value, /TikTok/);
    assert.match(page.get('smsPreview').textContent, /^OG Jewelers:/);
    assert.match(page.get('smsPreview').textContent, /Reply STOP to unsubscribe\.$/);
    assert.doesNotMatch(page.get('smsPreview').textContent, /eBay/);
  }
  assert.equal(page.requests.filter(request => request.action === 'send').length, 0);
});

test('switching sections preserves independent messages, links, dates and custom titles', async () => {
  const page = await openComposer();
  page.set('campaignTitle', 'Custom eBay title');
  page.set('messageBody', 'My eBay invitation');
  page.set('linkUrl', 'https://www.ebay.com/ebaylive/events/example');
  page.switchTo('tiktok');
  page.set('showDate', '2026-10-20', 'change');
  page.set('showTime', '19:30', 'change');
  page.set('campaignTitle', 'Custom TikTok title');
  page.set('messageBody', 'My TikTok invitation');
  page.set('linkUrl', 'https://www.tiktok.com/@example/live');
  page.switchTo('ebay');
  assert.equal(page.get('messageBody').value, 'My eBay invitation');
  assert.equal(page.get('campaignTitle').value, 'Custom eBay title');
  assert.match(page.get('linkUrl').value, /ebay\.com/);
  page.switchTo('tiktok');
  assert.equal(page.get('messageBody').value, 'My TikTok invitation');
  assert.equal(page.get('campaignTitle').value, 'Custom TikTok title');
  assert.equal(page.get('showDate').value, '2026-10-20');
  assert.equal(page.get('showTime').value, '19:30');
  assert.match(page.get('smsPreview').textContent, /tiktok\.com/);
  assert.doesNotMatch(page.get('smsPreview').textContent, /ebay\.com/);
});

test('TikTok needs its own link and confirmation; the send uses the existing paced endpoint', async () => {
  const page = await openComposer();
  page.set('linkUrl', 'https://www.ebay.com/ebaylive/events/example');
  page.switchTo('tiktok');
  await page.submit();
  assert.match(page.get('sendStatus').textContent, /valid TikTok show link/);
  assert.equal(page.confirmations.length, 0);
  page.set('templateSelect', 'live-now', 'change');
  page.set('linkUrl', 'https://www.tiktok.com/@example/live');
  await page.submit();
  const sends = page.requests.filter(request => request.action === 'send');
  assert.equal(sends.length, 1);
  assert.equal(sends[0].templateId, 'tiktok:live-now');
  assert.equal(sends[0].linkUrl, 'https://www.tiktok.com/@example/live');
  assert.match(sends[0].message, /LIVE on TikTok/);
  assert.match(page.confirmations[0], /TikTok show SMS to 69/);
  assert.match(page.confirmations[0], /Reply STOP to unsubscribe/);
});

test('an in-flight campaign cannot be submitted twice or switched to another platform', async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const page = await openComposer({ send: () => pending });
  page.switchTo('tiktok');
  page.set('linkUrl', 'https://www.tiktok.com/@example/live');
  const sending = page.submit();
  await new Promise(setImmediate);
  page.switchTo('ebay');
  page.set('messageBody', 'Still a TikTok invitation');
  assert.equal(page.get('sendBtn').disabled, true);
  assert.ok(page.platforms.every(button => button.disabled));
  assert.equal(page.get('showPlatformHeading').textContent, 'Send TikTok Show Alert');
  await page.submit();
  assert.equal(page.requests.filter(request => request.action === 'send').length, 1);
  release();
  await sending;
  assert.equal(page.get('sendBtn').disabled, false);
});
