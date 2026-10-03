import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1sAAAAASUVORK5CYII=', 'base64');
const imageUrl = `data:image/png;base64,${png.toString('base64')}`;
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
  browser = await (process.env.INVSTO_PHOTO_BROWSER === 'webkit' ? webkit : chromium).launch();
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});

function database() {
  return {events: [], uploads: [], calls: [], reads: [], failUpload: false, failRead: false,
    loseResponse: false, failOrder: '', delayRead: 0, failCorrection: false,
    loseCorrectionResponse: false, corrections: new Map()};
}

async function open(t, db, {mobile = false, actor = 'desktop@example.com'} = {}) {
  const context = await browser.newContext({viewport: {width: mobile ? 390 : 1440, height: 950},
    isMobile: mobile, hasTouch: mobile});
  t.after(() => context.close());
  await context.route('**/*', r => r.request().url().startsWith(origin) ? r.continue() : r.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, []));
  await page.exposeFunction('photoDb', async ({op, ...args}) => {
    if (op === 'read') {
      db.reads.push(args);
      const rows = structuredClone(db.events).filter(row => args.filters.every(([key, value]) =>
        Array.isArray(value) ? value.includes(row[key]) : (key === 'payload->>proof_type' ? row.payload?.proof_type : row[key]) === value));
      if (db.delayRead) await new Promise(r => setTimeout(r, db.delayRead));
      return db.failRead ? {error: {message: 'Read unavailable'}} : {data: rows.slice(args.start, args.end + 1)};
    }
    if (op === 'upload') {
      if (db.failUpload) return {error: {message: 'Upload unavailable'}};
      db.uploads.push(args);
      return {data: {path: args.path}};
    }
    if (op === 'rpc') {
      db.calls.push(args);
      if (args.name === 'correct_pending_order_completion_photo') {
        const a = args.args;
        if (db.failCorrection) return {error: {message: 'Photo correction unavailable'}};
        if (db.corrections.has(a._request_id)) return {data: db.corrections.get(a._request_id)};
        const rows = db.events.filter(e => a._event_ids.includes(e.id));
        if (rows.length !== a._event_ids.length || rows.some(e => e.payload.proof_type !== 'completion_photo' ||
          !e.photo_attachments.some(p => p.bucket === a._bucket && p.path === a._path))) {
          return {error: {message: 'This photo has already changed. Refresh the photos and try again.'}};
        }
        rows.forEach(e => {
          e.payload.completion_photo_changes ||= [];
          e.payload.completion_photo_changes.push({request_id: a._request_id,
            original: e.photo_attachments.filter(p => p.bucket === a._bucket && p.path === a._path),
            replacement: a._replacement, signed_by_email: actor});
          e.photo_attachments = e.photo_attachments.flatMap(p => p.bucket === a._bucket && p.path === a._path
            ? (a._replacement ? [{...a._replacement, signed_by_email: actor}] : []) : [p]);
        });
        const result = {updated_events: rows.length};
        db.corrections.set(a._request_id, result);
        if (db.loseCorrectionResponse) {db.loseCorrectionResponse = false; return {error: {message: 'Correction response lost'}};}
        return {data: result};
      }
      if (args.name !== 'add_ebay_order_history_extra_photos') return {data: {}};
      const a = args.args;
      if (db.failOrder === a._order_id) return {error: {message: 'Order save unavailable'}};
      db.events.unshift({id: `event-${db.events.length}`, order_id: a._order_id,
        created_at: '2026-10-03T16:30:00Z', signed_by_email: a._signed_by_email,
        action: 'history_extra_photo', photo_attachments: a._photo_attachments,
        payload: {source: 'order_history_extra_photo', proof_type: a._proof_type, order_line_ids: a._order_line_ids}});
      if (db.loseResponse) { db.loseResponse = false; return {error: {message: 'Response lost after saving'}}; }
      return {data: db.events[0]};
    }
    throw Error(`Unknown operation ${op}`);
  });
  await page.goto(`${origin}/pending-orders.html`);
  await page.addScriptTag({url: `${origin}/completion-photos.js`});
  await page.addScriptTag({url: `${origin}/pending-orders.js`});
  await page.evaluate(({actor, imageUrl}) => {
    const create = OGCompletionPhotos.create;
    OGCompletionPhotos.create = config => create({...config, pollMs: 150});
    window.supabase = {
      from(table) {
        const filters = [];
        let start = 0, end = 499;
        const q = {
          select() {return q;}, eq(k, v) {filters.push([k, v]); return q;}, in(k,v) {filters.push([k,v]);return q;}, order() {return q;},
          range(a, b) {start = a; end = b; return q;},
          then(resolve, reject) {return photoDb({op: 'read', table, filters, start, end}).then(resolve, reject);},
        };
        return q;
      },
      storage: {from(bucket) {return {
        upload: (path, file) => photoDb({op: 'upload', bucket, path, size: file.size}),
        createSignedUrl: async () => ({data: {signedUrl: imageUrl}}),
      };}},
      rpc: (name, args) => photoDb({op: 'rpc', name, args}),
    };
    window.lines = [
      {id: 'line-a', order_id: 'order-a', item_title: 'Gold chain', quantity: 1, fulfilled_quantity: 0,
        total_price: 1485, line_status: 'pending', order: {order_number: '11-22222-33333', buyer_username: 'lore2526'}},
      {id: 'line-b', order_id: 'order-b', item_title: 'Silver ring', quantity: 1, fulfilled_quantity: 0,
        total_price: 30, line_status: 'pending', order: {order_number: '11-22222-44444', buyer_username: 'lore2526'}},
    ];
    state.user = {id: actor, email: actor}; state.employee = {active: true, role: 'employee'};
    state.orders = lines; state.filteredOrders = lines; state.selectedLine = lines[0];
    state.checkoutStoreId = 'store-a'; state.stores = [{id: 'store-a', name: 'Main Store'}];
    hydrateBuyerGroupNotes = () => {};
    scheduleQueueVideoReceiptEvidenceHydration = () => {};
    loadNoInventoryCaptureStations = async () => {};
    captureAuditLocation = async () => ({status: 'granted', latitude: 25, longitude: -80});
    renderEbayLabelPanel = () => {};
    resolvePhotoUrl = async () => '';
    setupListeners();
    renderOrders();
  }, {actor, imageUrl});
  return page;
}

async function pick(page, input = 'completion-photo-files', name = 'packed-order.png') {
  await page.locator(`#${input}`).setInputFiles({name, mimeType: 'image/png', buffer: png});
}

test('photo context uses the queue customer-name fallback and keeps unnamed customers identifiable',async t=>{
  const page=await open(t,database());
  await page.evaluate(()=>{
    lines[0].order.raw_payload={fulfillmentStartInstructions:[{shippingStep:{shipTo:{fullName:'Customer from shipping'}}}]};
    lines[0].item_title='#023 - JEWELRY ITEM - AS SEEN ON SCREEN';
    lines[1].order.buyer_username='another-buyer';
    openCompletionPhotos(lines);
  });
  const context=page.locator('#completion-photo-context');
  await expect(context.locator('.photo-order-customer-name')).toHaveText(['Customer from shipping','another-buyer']);
  await expect(context.locator('.photo-order-items').first()).toContainText('#023 - JEWELRY ITEM - AS SEEN ON SCREEN');
  await expect(context).not.toContainText('11-22222-33333');
});
async function save(page) {
  await page.locator('#save-completion-photos').click();
  await expect(page.locator('#completion-photo-status')).toContainText('Saved to the order.');
  await expect(page.locator('#completion-photo-pending .completion-photo-card')).toHaveCount(0);
}
function evidence({order = 'order-a', line = 'line-a', path = 'remote.png', proof = 'completion_photo'} = {}) {
  return {id: path, order_id: order, created_at: '2026-10-03T16:30:00Z', signed_by_email: 'phone@example.com',
    payload: {source: 'order_history_extra_photo', proof_type: proof, order_line_ids: [line]},
    photo_attachments: [{bucket: 'order-evidence-photos', path, label: path}]};
}

test('phone card offers camera and library, saves audited photos for the displayed orders without expanding the card', async t => {
  const db = database(), page = await open(t, db, {mobile: true, actor: 'phone@example.com'});
  await page.evaluate(() => {state.selectedLine = null; renderOrders();});
  await page.locator('[data-buyer-completion-photos]').tap();
  await expect(page.locator('#completion-photos-modal')).toBeVisible();
  await expect(page.locator('.buyer-card-expanded')).toHaveCount(0);
  assert.equal(await page.locator('#completion-photo-camera').getAttribute('capture'), 'environment');
  assert.equal(await page.locator('#completion-photo-files').getAttribute('capture'), null);
  assert.notEqual(await page.locator('#completion-photo-files').getAttribute('multiple'), null);
  await pick(page, 'completion-photo-camera');
  await save(page);
  assert.equal(db.events.length, 2);
  assert.deepEqual(db.calls.map(c => c.args._order_line_ids).sort(), [['line-a'], ['line-b']]);
  assert.equal(new Set(db.events.flatMap(e => e.photo_attachments.map(p => p.path))).size, 1);
  assert.ok(db.events.every(e => e.signed_by_email === 'phone@example.com' && e.payload.proof_type === 'completion_photo'));
  assert.equal(db.events[0].photo_attachments[0].metadata.source, 'pending_order_completion_photo');
  await expect(page.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(1);
  await expect(page.locator('#completion-photo-saved')).toContainText('phone@example.com');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await mkdir(new URL('../test-results', import.meta.url), {recursive: true});
  await page.screenshot({path: 'test-results/completion-photos-mobile.png'});
  await page.locator('#done-completion-photos').tap();
  await expect(page.locator('#completion-photos-modal')).toBeHidden();
});

test('one completion photo marks the whole buyer group, including when filtering its lines',async t=>{
  const db=database();
  db.events=[evidence({proof:'receipt_screenshot'}),evidence({proof:'line_note',path:'note.png'}),
    {...evidence({path:'removed.png'}),payload:{proof_type:'completion_photo',order_line_ids:['line-a'],history_removed:true}},
    evidence({order:'order-b',line:'line-a',path:'wrong-order.png'})];
  const desktop=await open(t,db),phone=await open(t,db,{mobile:true,actor:'phone@example.com'});
  await desktop.evaluate(()=>{
    lines.push({...lines[0],id:'line-c',item_title:'Another item in the same order'});
    state.selectedLine=null;state.collapsedBuyerKeys.add('lore2526');renderOrders();
    document.querySelector('.buyer-order-card').dataset.testIdentity='same-card';
  });
  const group=desktop.locator('.buyer-card-meta [data-completion-photo-lines]');
  await expect(group).toHaveText('No completion photos');
  await phone.evaluate(()=>openCompletionPhotos([lines[0]]));await pick(phone);await save(phone);
  await expect(group).toHaveText('✓ Completion photo added');
  await expect(desktop.locator('.buyer-order-card')).toHaveAttribute('data-test-identity','same-card');
  await desktop.locator('[data-buyer-expand-key]').click();
  await expect(desktop.locator('.buyer-line-btn [data-completion-photo-lines]')).toHaveCount(0);
  await desktop.evaluate(()=>{state.filteredOrders=[lines[1]];renderOrders();});
  await expect(group).toHaveText('✓ Completion photo added');
  await desktop.evaluate(()=>{state.filteredOrders=lines;renderOrders();});
  await pick(phone,'completion-photo-files','second-photo.png');await save(phone);
  await phone.locator('#completion-photo-saved [data-remove-saved-photo]').first().click();
  await expect(phone.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(1);
  await expect(group).toHaveText('✓ Completion photo added');
  await desktop.locator('[data-buyer-expand-key]').click();
  await expect(group).toHaveText('✓ Completion photo added');
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await desktop.screenshot({path:'test-results/completion-photo-queue-markers.png'});
  await phone.locator('#done-completion-photos').click();
  await expect(phone.locator('.buyer-card-meta [data-completion-photo-lines]')).toHaveText('✓ Completion photo added');
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await phone.screenshot({path:'test-results/completion-photo-queue-markers-phone.png'});
  await phone.evaluate(()=>openCompletionPhotos([lines[0]]));
  await phone.locator('#completion-photo-saved [data-remove-saved-photo]').click();
  await expect(group).toHaveText('No completion photos');
});

test('queue photo coverage paginates, distinguishes read failures, and ignores results for an old filter',async t=>{
  const db=database();
  db.events=Array.from({length:500},(_,i)=>evidence({order:'order-b',line:'line-b',path:`${i}.png`}));
  db.events.push(evidence({path:'last-page.png'}));
  const page=await open(t,db),badge=page.locator('.buyer-card-meta [data-completion-photo-lines]');
  await page.evaluate(()=>{lines[1].order={...lines[1].order,buyer_username:'another-buyer'};renderOrders();});
  await expect(badge).toHaveText(['✓ Completion photo added','✓ Completion photo added']);
  assert.ok(db.reads.some(r=>r.start===500&&r.filters.some(([,v])=>Array.isArray(v))));
  db.failRead=true;
  await expect(badge).toHaveText(['Completion photos unavailable','Completion photos unavailable']);
  db.failRead=false;
  await expect(badge).toHaveText(['✓ Completion photo added','✓ Completion photo added']);
  db.delayRead=400;
  await page.evaluate(()=>{state.filteredOrders=[lines[0]];renderOrders();});
  await expect.poll(()=>db.reads.some(r=>r.filters.some(([k,v])=>k==='order_id'&&Array.isArray(v)&&v.length===1&&v[0]==='order-a'))).toBe(true);
  db.delayRead=0;db.events=[];
  await page.evaluate(()=>{state.filteredOrders=[lines[1]];renderOrders();});
  await expect(badge).toHaveText('No completion photos');
  await page.waitForTimeout(500);
  await expect(badge).toHaveText('No completion photos');
});

test('phone uploads appear automatically in open desktop without-inventory and mixed inventory review screens', async t => {
  const db = database();
  const desktop = await open(t, db), mixed = await open(t, db), phone = await open(t, db, {mobile: true, actor: 'phone@example.com'});
  await desktop.evaluate(() => openWorkerNoInventoryModal({lineIds: ['line-a']}));
  await mixed.evaluate(() => {
    state.activeBuyerKey = '';
    state.stagedFulfillments.set('line-a', {line: lines[0], mode: 'inventory', qty: 1,
      item: {id: 'item-a', title: 'Chain', photos: []}, row: {id: 'stock-a', locationLabel: 'Main'}});
    state.stagedFulfillments.set('line-b', {line: lines[1], mode: 'without_inventory', qty: 1,
      item: {title: 'Silver ring'}, row: {locationLabel: 'Without inventory'}});
    openBundleReviewModal();
  });
  await phone.evaluate(() => openCompletionPhotos([lines[0]]));
  await pick(phone); await save(phone);
  await expect(desktop.locator('#no-inventory-completion-photo-grid .completion-photo-card')).toHaveCount(1);
  await expect(mixed.locator('#bundle-completion-photo-grid .completion-photo-card')).toHaveCount(1);
  assert.equal(await desktop.evaluate(() => getSelectedNoInventoryEvidencePhotos().length), 0);
  assert.deepEqual(await desktop.evaluate(() => persistNoInventoryEvidencePhotos(['line-a'])), []);
  await desktop.locator('#no-inventory-completion-photo-grid [data-completion-photo]').click();
  await expect(desktop.locator('#no-inventory-photo-viewer-modal')).toBeVisible();
  await desktop.locator('#dismiss-no-inventory-photo-viewer').click();
  await expect(desktop.locator('#worker-no-inventory-modal')).toBeVisible();
  await desktop.screenshot({path: 'test-results/completion-photos-desktop.png'});
});

test('line selection filters shared photos, ignores notes and receipts, and drops obsolete responses', async t => {
  const db = database();
  db.events.push(evidence(), evidence({order: 'order-b', line: 'line-b', path: 'ring.png'}),
    evidence({path: 'receipt.png', proof: 'receipt_screenshot'}), evidence({path: 'note.png', proof: 'line_note'}));
  const page = await open(t, db);
  await page.evaluate(() => openWorkerNoInventoryModal({lineIds: ['line-a']}));
  await expect(page.locator('#no-inventory-completion-photo-grid .completion-photo-card')).toHaveCount(1);
  await expect(page.locator('#no-inventory-completion-photo-grid img')).toHaveAttribute('alt', 'remote.png');
  db.delayRead = 200;
  await page.evaluate(() => {setWorkerNoInventoryLineSelection('line-a', false); setWorkerNoInventoryLineSelection('line-b', true);});
  await expect(page.locator('#no-inventory-completion-photo-grid img')).toHaveAttribute('alt', 'ring.png');
  await page.waitForTimeout(300);
  await expect(page.locator('#no-inventory-completion-photo-grid img')).toHaveAttribute('alt', 'ring.png');
  const modalReadCount=()=>db.reads.filter(r=>r.filters.some(([k,v])=>k==='order_id'&&!Array.isArray(v))).length;
  const queryCount = modalReadCount();
  await page.evaluate(() => closeWorkerNoInventoryModal({suppressEbayReturn: true, keepMobileDetail: true}));
  await page.waitForTimeout(450);
  assert.ok(modalReadCount() <= queryCount + 1, 'closing stops modal polling while queue coverage can keep refreshing');
  assert.equal(await page.evaluate(event => isWrittenLineNote(event, {metadata: {source: 'order_history_extra_photo'}}), db.events[0]), false);
});

test('lost save response retries by reading the saved evidence and avoids duplicate uploads or events', async t => {
  const db = database(), page = await open(t, db);
  await page.evaluate(() => openCompletionPhotos([lines[0]]));
  await pick(page); db.loseResponse = true;
  await page.locator('#save-completion-photos').click();
  await expect(page.locator('#completion-photo-status')).toContainText('Response lost');
  assert.equal(db.events.length, 1);
  const uploadCount = db.uploads.length;
  await save(page);
  assert.equal(db.events.length, 1);
  assert.equal(db.calls.length, 1);
  assert.equal(db.uploads.length, uploadCount);
});

test('partial multi-order save retries only the failed order with the original uploaded photo', async t => {
  const db = database(), page = await open(t, db);
  await page.locator('[data-buyer-completion-photos]').click();
  await pick(page); db.failOrder = 'order-b';
  await page.locator('#save-completion-photos').click();
  await expect(page.locator('#completion-photo-status')).toContainText('Order save unavailable');
  assert.deepEqual(db.events.map(e => e.order_id), ['order-a']);
  const count = db.uploads.length;
  db.failOrder = ''; await save(page);
  assert.equal(db.events.length, 2);
  assert.equal(db.calls.filter(c => c.args._order_id === 'order-a').length, 1);
  assert.equal(db.uploads.length, count);
});

test('upload failures preserve selection, protect against accidental close, and allow remove or retry', async t => {
  const db = database(), page = await open(t, db);
  await page.evaluate(() => openCompletionPhotos([lines[0]]));
  await pick(page); db.failUpload = true;
  await page.locator('#save-completion-photos').click();
  await expect(page.locator('#completion-photo-status')).toContainText('Upload unavailable');
  await page.locator('#done-completion-photos').click();
  await expect(page.locator('#completion-photos-modal')).toBeVisible();
  await expect(page.locator('#completion-photo-status')).toContainText('Save or remove');
  await page.evaluate(() => confirmWorkerNoInventoryCompletion());
  assert.equal(db.calls.length, 0);
  await page.locator('[data-remove-photo]').click();
  await page.locator('#done-completion-photos').click();
  await expect(page.locator('#completion-photos-modal')).toBeHidden();
});

test('completion-screen file and camera buttons invoke the picker and retain the selected line scope', async t => {
  const db = database(), page = await open(t, db);
  await page.evaluate(() => openWorkerNoInventoryModal({lineIds: ['line-a']}));
  const chooser = page.waitForEvent('filechooser');
  await page.locator('[data-completion-source="no-inventory"][data-completion-picker="files"]').click();
  await (await chooser).setFiles({name: 'from-folder.png', mimeType: 'image/png', buffer: png});
  await save(page);
  assert.deepEqual(db.calls[0].args._order_line_ids, ['line-a']);
  await page.locator('#done-completion-photos').click();
  const camera = page.waitForEvent('filechooser');
  await page.locator('[data-completion-source="no-inventory"][data-completion-picker="camera"]').click();
  await (await camera).setFiles({name: 'camera.png', mimeType: 'image/png', buffer: png});
  await save(page);
  assert.equal(db.events.length, 2);
});

test('read errors are visible and recover on refresh, with paginated order-scoped evidence', async t => {
  const db = database(), page = await open(t, db);
  db.failRead = true;
  await page.evaluate(() => openCompletionPhotos([lines[0]]));
  await expect(page.locator('#completion-photo-status')).toContainText('Read unavailable');
  db.failRead = false;
  db.events = Array.from({length: 501}, (_, index) => evidence({path: `${index}.png`}));
  await page.locator('#refresh-completion-photos').click();
  await expect(page.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(501);
  assert.ok(db.reads.some(r => r.start === 500));
  assert.ok(db.reads.filter(r=>!r.filters.some(([,v])=>Array.isArray(v)))
    .every(r => r.filters.some(([k, v]) => k === 'order_id' && v === 'order-a')));
});

test('saved completion photos survive both final completion paths and appear as proof in Order History', async t => {
  for (const mode of ['without_inventory', 'inventory']) {
    const db = database(), page = await open(t, db);
    await page.evaluate(() => openCompletionPhotos([lines[0]]));
    await pick(page); await save(page);
    await page.locator('#done-completion-photos').click();
    const uploadCount = db.uploads.length;
    await page.evaluate(async mode => {
      loadOrders = async () => {state.orders = [];};
      clearSelection = () => {state.selectedLine = null; state.stagedFulfillments.clear();};
      completeFulfilledShippingTasksForLines = async () => 0;
      postEbayPendingQueueChanged = () => {};
      if (mode === 'without_inventory') {
        await openWorkerNoInventoryModal({lineIds: ['line-a']});
        await confirmWorkerNoInventoryCompletion();
      } else {
        state.stagedFulfillments.set('line-a', {line: lines[0], mode, qty: 1,
          item: {id: 'item-a', title: 'Chain', photos: []}, row: {id: 'stock-a', locationLabel: 'Main'}});
        openBundleReviewModal();
        await fulfillSelectedOrder({skipReview: true});
      }
    }, mode);
    const complete = db.calls.find(c => c.name === (mode === 'inventory'
      ? 'fulfill_pending_checkout_bundle' : 'complete_ebay_order_lines_without_inventory_evidence'));
    assert.ok(complete, `${mode} was confirmed`);
    if (mode === 'without_inventory') assert.deepEqual(complete.args._evidence_photos, []);
    assert.equal(db.uploads.length, uploadCount, 'saved shared photos are not re-uploaded');
    assert.equal(db.events.length, 1);
    await page.goto(`${origin}/ebay-order-history.html`);
    await page.addScriptTag({url: `${origin}/ebay-order-history.js`});
    const result = await page.evaluate(events => {
      const photos = getHistoryExtraOrderProofPhotos({events, lines: []});
      return photos.map(p => ({path: p.path, author: p.signed_by_email}));
    }, db.events);
    assert.deepEqual(result, [{path: db.events[0].photo_attachments[0].path, author: 'desktop@example.com'}]);
  }
});

test('multiple library selections, additional camera shots, and later additions all remain saved', async t => {
  const db = database(), page = await open(t, db, {mobile: true});
  await page.evaluate(() => openCompletionPhotos([lines[0]]));
  await page.locator('#completion-photo-files').setInputFiles(['front.png', 'back.png'].map(name => ({name, mimeType: 'image/png', buffer: png})));
  await pick(page, 'completion-photo-camera', 'detail.png');
  await expect(page.locator('#completion-photo-pending .completion-photo-card')).toHaveCount(3);
  await save(page);
  await expect(page.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(3);
  await pick(page, 'completion-photo-files', 'extra.png'); await save(page);
  await expect(page.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(4);
  assert.equal(db.events.length, 4);
});

test('removing a shared photo updates the desktop and only changes the orders in this view', async t => {
  const db = database();
  db.events = [evidence({path: 'completion-photos/shared.png'}),
    {...evidence({order: 'order-b', line: 'line-b', path: 'completion-photos/shared.png'}), id: 'other-event'},
    {...evidence({order: 'order-c', line: 'line-c', path: 'completion-photos/shared.png'}), id: 'outside-event'}];
  const desktop = await open(t, db), phone = await open(t, db, {mobile: true, actor: 'other-staff@example.com'});
  await desktop.evaluate(() => openWorkerNoInventoryModal({lineIds: ['line-a']}));
  await phone.locator('[data-buyer-completion-photos]').tap();
  await expect(phone.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(1);
  await phone.locator('[data-remove-saved-photo]').tap();
  await expect(phone.locator('#completion-photo-status')).toContainText('Photo removed');
  await expect(phone.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(0);
  await expect(desktop.locator('#no-inventory-completion-photo-grid .completion-photo-card')).toHaveCount(0);
  assert.equal(db.events[0].photo_attachments.length, 0);
  assert.equal(db.events[1].photo_attachments.length, 0);
  assert.equal(db.events[2].photo_attachments.length, 1);
  assert.equal(db.events[0].payload.completion_photo_changes[0].signed_by_email, 'other-staff@example.com');
});

async function replace(page, {camera = false, name = 'replacement.png'} = {}) {
  await page.locator('[data-replace-saved-photo]').click();
  const chooser = page.waitForEvent('filechooser');
  await page.locator(camera ? '[data-replacement-camera]' : '[data-replacement-file]').click();
  await (await chooser).setFiles({name, mimeType: 'image/png', buffer: png});
}

for (const [source,mobile] of [['no-inventory',true],['bundle',false]]) {
  test(`${source} checkout removes saved photos inline, reports failures, and synchronizes only the displayed orders`,async t=>{
    const db=database();
    db.events=[evidence({path:'completion-photos/shared.png'}),
      {...evidence({order:'order-b',line:'line-b',path:'completion-photos/shared.png'}),id:'outside-event'},
      evidence({path:'completion-photos/keep.png'})];
    const page=await open(t,db,{mobile}),otherDevice=await open(t,db,{mobile:!mobile,actor:'other@example.com'});
    await otherDevice.evaluate(()=>openCompletionPhotos([lines[0]]));
    await expect(otherDevice.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(2);
    await page.evaluate(source=>{
      if(source==='no-inventory')openWorkerNoInventoryModal({lineIds:['line-a']});
      else {
        state.activeBuyerKey='';
        state.stagedFulfillments.set('line-a',{line:lines[0],mode:'inventory',qty:1,
          item:{id:'item-a',title:'Chain',photos:[]},row:{id:'stock-a',locationLabel:'Main'}});
        openBundleReviewModal();
      }
    },source);
    const grid=page.locator(`#${source}-completion-photo-grid`);
    const card=grid.locator('.completion-photo-card').filter({has:page.locator('img[alt="completion-photos/shared.png"]')});
    await expect(grid.locator('[data-remove-saved-photo]')).toHaveCount(2);
    await expect(page.locator('#completion-photos-modal')).toBeHidden();
    db.failCorrection=true;
    await card.getByRole('button',{name:'Remove',exact:true}).click();
    await expect(card.getByRole('status')).toContainText('Photo correction unavailable');
    await expect(card.getByRole('button',{name:'Remove',exact:true})).toBeEnabled();
    assert.equal(db.events[0].photo_attachments.length,1);
    db.failCorrection=false;
    await card.getByRole('button',{name:'Remove',exact:true}).click();
    await expect(card).toHaveCount(0);
    await expect(grid.locator('.completion-photo-card')).toHaveCount(1);
    await expect(otherDevice.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(1);
    await expect(page.locator('#completion-photos-modal')).toBeHidden();
    assert.equal(db.events[0].photo_attachments.length,0);
    assert.equal(db.events[1].photo_attachments.length,1,'same photo on an order outside this checkout remains');
    assert.equal(db.events[2].photo_attachments.length,1,'the other photo on this order remains');
    assert.deepEqual(db.calls.filter(c=>c.name==='correct_pending_order_completion_photo').at(-1).args._event_ids,['completion-photos/shared.png']);
  });
}

test('replacement keeps the original through upload failure, then swaps and synchronizes after saving', async t => {
  const db = database(); db.events = [evidence({path: 'completion-photos/original.png'})];
  const desktop = await open(t, db), phone = await open(t, db, {mobile: true, actor: 'phone@example.com'});
  await desktop.evaluate(() => openWorkerNoInventoryModal({lineIds: ['line-a']}));
  await phone.evaluate(() => openCompletionPhotos([lines[0]]));
  await replace(phone, {camera: true});
  assert.equal(await phone.locator('#completion-photo-replacement').getAttribute('capture'), 'environment');
  await expect(phone.locator('#completion-photo-pending')).toContainText('The original stays until you save.');
  db.failUpload = true;
  await phone.locator('#save-completion-photos').click();
  await expect(phone.locator('#completion-photo-status')).toContainText('Upload unavailable');
  assert.equal(db.events[0].photo_attachments[0].path, 'completion-photos/original.png');
  db.failUpload = false; await save(phone);
  await expect(desktop.locator('#no-inventory-completion-photo-grid img')).toHaveAttribute('alt', 'replacement.png');
  assert.equal(db.events.length, 1);
  assert.equal(db.events[0].photo_attachments.length, 1);
  assert.equal(db.events[0].payload.completion_photo_changes[0].original[0].path, 'completion-photos/original.png');
  await expect(phone.locator('#completion-photo-saved')).toContainText('phone@example.com');
  await phone.screenshot({path: 'test-results/completion-photo-replace-mobile.png'});
});

test('replacement retries use one request and uploaded file after the server committed but the response was lost', async t => {
  const db = database(); db.events = [evidence({path: 'completion-photos/original.png'})];
  const page = await open(t, db);
  await page.evaluate(() => openCompletionPhotos([lines[0]]));
  await replace(page);
  assert.equal(await page.locator('#completion-photo-replacement').getAttribute('capture'), null);
  db.loseCorrectionResponse = true;
  await page.locator('#save-completion-photos').click();
  await expect(page.locator('#completion-photo-status')).toContainText('Correction response lost');
  const uploadCount = db.uploads.length;
  await save(page);
  const calls = db.calls.filter(c => c.name === 'correct_pending_order_completion_photo');
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args._request_id, calls[1].args._request_id);
  assert.equal(db.uploads.length, uploadCount);
  assert.equal(db.events[0].payload.completion_photo_changes.length, 1);
});

test('cancelling a replacement or a failed removal leaves the original photo available', async t => {
  const db = database(); db.events = [evidence({path: 'completion-photos/original.png'})];
  const page = await open(t, db);
  await page.evaluate(() => openCompletionPhotos([lines[0]]));
  await replace(page);
  await page.locator('[data-remove-photo]').click();
  await expect(page.locator('#completion-photo-saved img')).toHaveAttribute('alt', 'completion-photos/original.png');
  db.failCorrection = true;
  await page.locator('[data-remove-saved-photo]').click();
  await expect(page.locator('#completion-photo-status')).toContainText('Photo correction unavailable');
  assert.equal(db.events[0].photo_attachments.length, 1);
  await expect(page.locator('[data-remove-saved-photo]')).toBeEnabled();
  db.failCorrection = false;
  await page.locator('[data-remove-saved-photo]').click();
  await expect(page.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(0);
});

test('desktop can inspect an unsaved photo, wheel zoom and left-drag at any scale without scrolling or saving', async t => {
  const db=database(), page=await open(t,db);
  await page.evaluate(()=>openCompletionPhotos([lines[0]]));
  await pick(page);
  const preview=page.locator('[data-inspect-pending-photo]');
  await preview.focus();await preview.press('Enter');
  await expect(page.locator('#no-inventory-photo-viewer-modal')).toBeVisible();
  await expect(page.locator('#dismiss-no-inventory-photo-viewer')).toBeFocused();
  const image=page.locator('#no-inventory-photo-viewer-image');
  const frame=page.locator('#no-inventory-photo-viewer-frame');
  await frame.scrollIntoViewIfNeeded();
  await expect(image).toHaveJSProperty('complete',true);
  const box=await image.boundingBox();
  // A photo can be grabbed immediately, without first pressing Zoom In.
  await page.mouse.move(box.x+box.width/2,box.y+box.height/2);
  await page.mouse.down();await page.mouse.move(box.x+box.width/2+40,box.y+box.height/2+20,{steps:4});await page.mouse.up();
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerPanX),40);
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerPanY),20);
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerZoom),1);
  const bounds=await frame.boundingBox();
  const pointer={x:Math.round(bounds.x+bounds.width/2+60),y:Math.round(bounds.y+bounds.height/2+30)};
  const before=await image.boundingBox();
  const scroll=()=>page.evaluate(()=>({page:scrollY,card:document.querySelector('.evidence-photo-viewer-card').scrollTop}));
  const oldScroll=await scroll();
  await page.mouse.move(pointer.x,pointer.y);
  await page.mouse.wheel(0,-120);
  await expect.poll(()=>page.evaluate(()=>state.evidencePhotoViewerZoom)).toBeGreaterThan(1);
  const after=await image.boundingBox();
  assert.ok(Math.abs((pointer.x-before.x)/before.width-(pointer.x-after.x)/after.width)<0.001,'horizontal detail stays under the cursor');
  assert.ok(Math.abs((pointer.y-before.y)/before.height-(pointer.y-after.y)/after.height)<0.001,'vertical detail stays under the cursor');
  assert.deepEqual(await scroll(),oldScroll,'wheel zoom does not scroll the modal or page');
  await page.mouse.wheel(0,120);
  await expect.poll(()=>page.evaluate(()=>state.evidencePhotoViewerZoom)).toBeCloseTo(1,6);
  await page.mouse.wheel(0,-10000);
  await expect.poll(()=>page.evaluate(()=>state.evidencePhotoViewerZoom)).toBe(4);
  await page.mouse.wheel(0,10000);
  await expect.poll(()=>page.evaluate(()=>state.evidencePhotoViewerZoom)).toBeLessThan(1);
  await page.mouse.wheel(0,10000);
  await expect.poll(()=>page.evaluate(()=>state.evidencePhotoViewerZoom)).toBe(0.5);
  // The blank margin also works as a drag surface when the image is zoomed out.
  const startPan=await page.evaluate(()=>({x:state.evidencePhotoViewerPanX,y:state.evidencePhotoViewerPanY}));
  await page.mouse.move(bounds.x+20,bounds.y+bounds.height/2);
  await page.mouse.down();await page.mouse.move(bounds.x+50,bounds.y+bounds.height/2+15,{steps:3});await page.mouse.up();
  expect(await page.evaluate(()=>state.evidencePhotoViewerPanX)).toBeCloseTo(startPan.x+30,6);
  expect(await page.evaluate(()=>state.evidencePhotoViewerPanY)).toBeCloseTo(startPan.y+15,6);
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerPanning),false);
  await page.locator('#reset-zoom-no-inventory-photo').click();
  await expect(image).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
  await page.locator('#dismiss-no-inventory-photo-viewer').click();
  await expect(preview).toBeFocused();
  await expect(page.locator('#completion-photo-pending .completion-photo-card')).toHaveCount(1);
  assert.equal(db.uploads.length,0);assert.equal(db.events.length,0);
});

test('photo drag keeps pointer capture outside the frame and leaves video controls alone', async t => {
  const db=database(),page=await open(t,db);
  await page.evaluate(()=>openCompletionPhotos([lines[0]]));await pick(page);
  await page.locator('[data-inspect-pending-photo]').click();
  await expect(page.locator('#dismiss-no-inventory-photo-viewer')).toBeFocused();
  const frame=page.locator('#no-inventory-photo-viewer-frame');
  await frame.scrollIntoViewIfNeeded();
  const box=await frame.boundingBox();
  const x=Math.round(box.x+box.width-30),y=Math.round(box.y+box.height/2);
  await page.mouse.move(x,y);await page.mouse.down();
  await page.mouse.move(x+70,y+20,{steps:4});await page.mouse.up();
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerPanX),70);
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerPanning),false);
  await page.mouse.move(x,y);
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerPanX),70,'release outside the frame ends the drag');
  await page.evaluate(()=>openEvidencePhotoObjectViewer({previewUrl:'data:video/mp4;base64,',mime_type:'video/mp4',label:'clip.mp4'}));
  await expect(page.locator('#no-inventory-photo-viewer-video')).toBeVisible();
  const prevented=await frame.evaluate(el=>{
    const event=new WheelEvent('wheel',{deltaY:-100,bubbles:true,cancelable:true});
    el.dispatchEvent(event);return event.defaultPrevented;
  });
  assert.equal(prevented,false,'video wheel events are not intercepted by photo gestures');
  assert.equal(await page.evaluate(()=>state.evidencePhotoViewerZoom),1);
});
