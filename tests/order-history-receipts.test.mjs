import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
const receiptUrl = 'https://www.ebay.com/ebaylive/events/fixture-event/stream?selectedItemId=123456789012&playback=true';
let server, browser, browserServer, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) return res.writeHead(404).end();
    try {
      let body = await readFile(new URL(name, root));
      if (name.endsWith('.html')) body = body.toString().replace(/<script\b[\s\S]*?<\/script>/gi, '');
      res.setHeader('Content-Type', name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(body);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  const engine = process.env.INVSTO_RECEIPT_BROWSER === 'webkit' ? webkit : chromium;
  browserServer = await engine.launchServer();
  browser = await engine.connect(browserServer.wsEndpoint());
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
});
after(async () => {
  let teardownTimer;
  await Promise.race([
    Promise.allSettled([browser?.close(), browserServer?.close()]),
    new Promise(resolve => {teardownTimer = setTimeout(() => {browserServer?.process()?.kill(); resolve();}, 2500);}),
  ]);
  clearTimeout(teardownTimer);
  await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});
});

async function openHistory(t, {width = 390, saved = receiptUrl, screenshot = true, role = 'employee'} = {}) {
  const context = await browser.newContext({viewport: {width, height: 844}, isMobile: width < 800, hasTouch: width < 800});
  t.after(() => context.close());
  await context.route('**/*', route => route.request().url().startsWith(origin) ? route.continue()
    : route.request().isNavigationRequest() ? route.fulfill({body: '<h1>eBay receipt fixture</h1>'}) : route.abort());
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.goto(`${origin}/ebay-order-history.html`);
  for (const script of ['video-receipts.js', 'ebay-order-history.js', 'phone-workspace.js']) await page.addScriptTag({url: `${origin}/${script}`});
  await page.evaluate(({saved, screenshot, role}) => {
    window.supabase = {from() {
      const query = {select() {return query;}, eq() {return query;}, abortSignal() {return query;},
        async maybeSingle() {return {data: {label_metadata: {videoReceiptUrl: saved}}};}};
      return query;
    }};
    state.user = {id: 'staff'}; state.employee = {role, active: true};
    const line = {id: 'receipt-line', order_id: 'order-one', item_number: '123456789012', transaction_id: 'txn-one',
      item_title: 'Silver chain bundle', line_status: 'fulfilled', quantity: 1, fulfilled_quantity: 1, total_price: 145,
      fulfilled_at: '2026-10-05T20:44:00Z', fulfilled_by_email: 'staff@example.test',
      order: {id: 'order-one', order_number: '11-22222-33333', buyer_username: 'receipt-buyer', label_metadata: {videoReceiptUrl: saved}}};
    state.lines = [normalizeLine(line)];
    state.relatedOrderTaskEvents = screenshot ? [{id: 'capture', order_line_ids: [line.id], category: 'task',
      created_at: '2026-10-03T21:03:00Z', signed_by_email: 'staff@example.test',
      photo_attachments: [{bucket: 'proof', path: 'video-receipts/123456789012.png', label: 'Video receipt - 123456789012'}]}] : [];
    signEventEvidencePhoto = async () => 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=';
    document.getElementById('history-from').value = '2026-10-01';
    document.getElementById('history-to').value = '2026-10-16';
    setupListeners(); rebuildHistoryLineSearchIndex(); applyFilters();
  }, {saved, screenshot, role});
  await page.locator('[data-history-group-toggle]').click();
  await expect(page.locator('.history-video-receipt-link')).toBeVisible();
  return page;
}

for (const width of [320, 390]) test(`employee can open the actual video and saved screenshot at ${width}px`, async t => {
  const page = await openHistory(t, {width});
  const link = page.getByRole('link', {name: 'Open video receipt', exact: true});
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await popup.waitForLoadState(); assert.equal(popup.url(), receiptUrl); await popup.close();
  await expect(page.locator('.history-receipt-preview-label')).toHaveText('View screenshot');
  const thumb = page.locator('[data-history-video-receipt-photo]');
  await expect(thumb).toHaveAttribute('data-loaded', 'true');
  await thumb.click();
  await expect(page.locator('#evidence-photo-viewer-modal')).toBeVisible();
  await expect(page.locator('#evidence-photo-viewer-title')).toHaveText('Video receipt - 123456789012');
  await page.locator('#close-evidence-photo-viewer').click();
  await expect(page.locator('#evidence-photo-viewer-modal')).toBeHidden();
  await link.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (width === 390) await page.screenshot({path: 'test-results/order-history-receipt-phone.png'});
  // Re-expanding rebuilds the card, including its receipt action.
  await page.locator('[data-history-group-toggle]').click();
  await page.locator('[data-history-group-toggle]').click();
  const [reopened] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await reopened.waitForLoadState(); assert.equal(reopened.url(), receiptUrl); await reopened.close();
});

test('history without screenshots offers the eBay order fallback and rejects another item receipt', async t => {
  const page = await openHistory(t, {screenshot: false, saved: receiptUrl.replace('123456789012', '999999999999')});
  await expect(page.locator('[data-history-video-receipt-photo]')).toHaveCount(0);
  await page.getByRole('link', {name: 'Open video receipt', exact: true}).click();
  await expect(page.locator('.video-receipt-dialog')).toBeVisible();
  await expect(page.locator('.video-receipt-lookup')).toContainText('No saved');
  await expect(page.locator('.video-receipt-direct')).toBeHidden();
  const [popup] = await Promise.all([page.waitForEvent('popup'), page.locator('.video-receipt-dialog').getByRole('link', {name: 'Open eBay order', exact: true}).click()]);
  await popup.waitForLoadState();
  assert.equal(popup.url(), 'https://www.ebay.com/mesh/ord/details?orderid=11-22222-33333');
  await popup.close();
});

test('desktop history retains the receipt options and correct saved video link', async t => {
  const page = await openHistory(t, {width: 1366, role: 'admin'});
  await page.getByRole('link', {name: 'Open video receipt', exact: true}).click();
  await expect(page.locator('.video-receipt-dialog')).toBeVisible();
  await expect(page.locator('.video-receipt-direct')).toHaveAttribute('href', receiptUrl);
  await page.getByRole('button', {name: 'Close video receipt', exact: true}).click();
  await expect(page.locator('.video-receipt-dialog')).toHaveCount(0);
});

test('phone history shows reconciled earnings and opens the order directly from its line', async t => {
  const page = await openHistory(t, {width: 320, role: 'admin'});
  await page.evaluate(() => {
    state.historyFinancialsStatus = 'ready';
    state.historyFinancials.set('11-22222-33333', {line_ids: ['receipt-line'], original: 145, cancelled: 0,
      refunded: 25, net_sales: 120, earnings: 102, sales_complete: true, earnings_complete: true});
    applyFilters();
  });
  await expect(page.locator('#summary-gross')).toHaveText('$120.00');
  await expect(page.locator('#summary-payout')).toHaveText('$102.00');
  await expect(page.locator('#summary-gross-detail')).toContainText('refunded $25.00');
  await expect(page.locator('.history-money-row')).toContainText('Order earnings $102.00');
  const orderLink = page.locator('.history-direct-order-link');
  await expect(orderLink).toBeVisible();
  assert.ok((await orderLink.boundingBox()).height >= 44);
  const [popup] = await Promise.all([page.waitForEvent('popup'), orderLink.click()]);
  await popup.waitForLoadState(); assert.equal(popup.url(), 'https://www.ebay.com/mesh/ord/details?orderid=11-22222-33333');
  await popup.close();
  await expect(page.locator('.video-receipt-dialog')).toHaveCount(0);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.locator('#phone-workspace-tools').click();
  await page.locator('#summary-payout').scrollIntoViewIfNeeded();
  await page.screenshot({path: 'test-results/order-history-financials-phone.png'});
  await page.evaluate(() => {state.historyFinancials.clear(); state.historyFinancialsStatus = 'error'; applyFilters();});
  await expect(page.locator('#summary-payout')).toHaveText('Needs verification');
  await expect(page.locator('#summary-payout-detail')).toContainText('unavailable');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});


for (const width of [320, 390, 1366]) test(`shipment ledger keeps packages, reports and actions separate at ${width}px`, async t => {
  const page = await openHistory(t, {width, role: 'admin', screenshot: false});
  await page.evaluate(() => {
    state.expandedHistoryGroupIds.clear();
    state.lines = [1,2,3,4,5].map(number => normalizeLine({
      id: `shipment-line-${number}`, order_id: `shipment-order-${number}`,
      item_title: `Example jewelry ${number}`, item_number: String(123456780000 + number),
      line_status: 'fulfilled', quantity: 1, fulfilled_quantity: 1,
      fulfilled_at: `2026-10-0${9-number}T20:44:00Z`, fulfilled_by_email: 'packer@example.test', total_price: 20,
      order: {id: `shipment-order-${number}`, order_number: `11-22222-3333${number}`, buyer_username: 'sample.buyer',
        tracking_number: number < 3 ? '9400111899560000000001' : number === 3 ? '9400111899560000000002' : ''},
    }));
    state.adminEvents = [{id: 'bulk-closeout', action: 'fulfilled_no_inventory', order_line_ids: state.lines.map(l=>l.id)}];
    state.relatedOrderTaskEvents = [];
    openHistoryExtraPhotoModal = group => {window.evidenceScope = group.lines.map(l=>l.id);};
    rebuildHistoryLineSearchIndex(); applyFilters();
  });
  await expect(page.locator('.history-order-card')).toHaveCount(4);
  await expect(page.locator('#history-count')).toHaveText('2 shipments · 2 separate orders');
  await expect(page.locator('.history-shipment-summary.is-linked')).toHaveCount(2);
  await expect(page.locator('.history-shipment-summary.is-unconfirmed')).toHaveCount(2);
  const card = page.locator('.history-order-card').filter({hasText: '9400111899560000000001'});
  await expect(card.locator('.history-shipment-summary')).toBeVisible();
  await expect(card.locator('.history-order-count-pill')).toHaveText('2 orders - 2 lines - Qty 2');
  await expect(card.getByRole('link', {name: 'Full history report', exact: true})).toHaveAttribute('href', /buyer=sample.buyer&scope=all$/);
  await expect(card.getByRole('link', {name: 'Pending items report', exact: true})).toHaveAttribute('href', /scope=pending$/);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({path: `test-results/order-history-shipments-${width}.png`, fullPage: true});
  await card.locator('[data-history-group-toggle]').click();
  await expect(card.locator('.history-line-row')).toHaveCount(2);
  await expect(card.locator('[data-history-label-group]')).toHaveAttribute('data-history-label-group', '11-22222-33331,11-22222-33332');
  await card.getByRole('button', {name: 'Add Evidence', exact: true}).click();
  assert.deepEqual(await page.evaluate(() => evidenceScope), ['shipment-line-1','shipment-line-2']);
  await expect(card.locator('[data-revert-lines]')).toHaveAttribute('data-revert-lines', 'shipment-line-1,shipment-line-2');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
});


for (const width of [390,1366]) test(`normal completion cards keep their own packing photos at ${width}px`,async t=>{
  const page=await openHistory(t,{width,role:'admin',screenshot:false});
  await page.evaluate(()=>{
    state.expandedHistoryGroupIds.clear();
    state.lines=[1,2,3,4,5].map(n=>normalizeLine({id:`batch-line-${n}`,order_id:`batch-order-${n}`,
      item_title:`Packed item ${n}`,item_number:String(123456781000+n),line_status:'fulfilled',quantity:1,fulfilled_quantity:1,
      fulfilled_at:'2026-10-12T18:00:00Z',fulfilled_by:'staff',fulfilled_by_email:'packer@example.test',
      order:{id:`batch-order-${n}`,order_number:`11-22222-4444${n}`,buyer_username:'sample.buyer'}}));
    const event=(id,ids,normal)=>({id,action:'fulfilled_no_inventory',order_line_ids:ids.map(n=>`batch-line-${n}`),
      signed_by:'staff',signed_by_email:'packer@example.test',created_at:'2026-10-12T18:00:00Z',
      payload:normal?{source:'worker_physical_item_not_in_inventory_batch',completed_at:'2026-10-12T18:00:00Z',
        evidence_photos:[{bucket:'proof',path:`packing/${id}.jpg`,label:`${id} packing photo`}]}:{closed_at:'2026-10-12T18:00:00Z'}});
    state.adminEvents=[event('Batch one',[1,2],true),event('Batch two',[3],true),event('Forced close',[4,5],false)];
    state.relatedOrderTaskEvents=[];
    rebuildHistoryLineSearchIndex();applyFilters();
  });
  await expect(page.locator('.history-order-card')).toHaveCount(4);
  await expect(page.locator('#history-count')).toHaveText('2 completed groups · 2 separate orders');
  await expect(page.locator('.history-shipment-summary').getByText('Completed together',{exact:true})).toHaveCount(2);
  const card=page.locator('.history-order-card').filter({hasText:'11-22222-44441'});
  await expect(card.locator('.history-order-count-pill')).toHaveText('2 orders - 2 lines - Qty 2');
  await expect(card).toContainText('Completed Oct 12');
  await expect(card).toContainText('packer@example.test');
  await card.locator('[data-history-group-toggle]').click();
  await expect(card.locator('.history-line-row')).toHaveCount(2);
  const photo=card.locator('[data-evidence-photo-url]');
  await expect(photo).toHaveCount(1);
  await expect(photo).toHaveAttribute('data-evidence-photo-label','Batch one packing photo');
  await photo.click();
  await expect(page.locator('#evidence-photo-viewer-title')).toHaveText('Batch one packing photo');
  await page.locator('#close-evidence-photo-viewer').click();
  await card.locator('[data-history-group-toggle]').click();
  await card.scrollIntoViewIfNeeded();
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:`test-results/order-history-completion-batches-${width}.png`,fullPage:true});
});
