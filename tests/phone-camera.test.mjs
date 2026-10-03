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
  browser = await (process.env.INVSTO_PHONE_BROWSER === 'webkit' ? webkit : chromium).launch();
});
after(async () => {
  await browser?.close();
  await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
});

function database() {
  return {sessions: new Map(), requests: new Map(), failSend: false, loseSendResponse: false, marks: [], events: [], uploads: [], calls: [], reads: [], failUpload: false, failRead: false,
    loseResponse: false, failOrder: '', delayRead: 0, failCorrection: false,
    loseCorrectionResponse: false, corrections: new Map()};
}

async function open(t, db, {mobile = false, actor = 'desktop@example.com', phoneLink = '', loggedIn = true} = {}) {
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
        (key === 'payload->>proof_type' ? row.payload?.proof_type : row[key]) === value));
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
      if (args.name === 'send_order_to_phone') {
        if (db.failSend) return {error:{code:'NETWORK',message:'Send unavailable'}};
        const a=args.args;
        let session=db.sessions.get(a._session_id);
        if (!session) {session={id:a._session_id,owner_email:actor,phone_email:null,expires_at:'2099-01-01',request:null};db.sessions.set(session.id,session);}
        if (session.closed) return {error:{code:'P0002',message:'Pair this phone again'}};
        if (!db.requests.has(a._request_id)) {
          session.request={id:a._request_id,lines:a._line_ids.map(id=>({id,order_id:id==='line-a'?'order-a':'order-b',item_title:id==='line-a'?'Gold chain':'Silver ring',
            order:{order_number:id==='line-a'?'11-22222-33333':'11-22222-44444',buyer_username:'lore2526'}}))};
          db.requests.set(a._request_id,session.request);
        }
        if(db.loseSendResponse){db.loseSendResponse=false;return {error:{message:'Send response lost'}};}
        return {data:structuredClone(session)};
      }
      if (args.name === 'read_order_phone_camera') {
        const session=db.sessions.get(args.args._session_id);
        if(!session||session.closed)return {error:{code:'P0002',message:'This pairing has ended. Scan a new QR code.'}};
        if(args.args._phone){session.phone_email=actor;session.phone_seen_at=new Date().toISOString();}
        return {data:structuredClone(session)};
      }
      if(args.name==='mark_order_phone_camera_request'){
        const a=args.args,request=db.requests.get(a._request_id);
        if(request)request[a._status==='saved'?'saved_at':'opened_at']=new Date().toISOString();
        db.marks.push({actor,...a});return {data:null};
      }
      if(args.name==='disconnect_order_phone_camera'){db.sessions.get(args.args._session_id).closed=true;return {data:null};}
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
  await page.goto(phoneLink || `${origin}/pending-orders.html`);
  await page.addScriptTag({url: `${origin}/completion-photos.js`});
  await page.addScriptTag({url: `${origin}/phone-camera.js`});
  await page.addScriptTag({url: `${origin}/pending-orders.js`});
  await page.evaluate(({actor, imageUrl, phoneLink, loggedIn}) => {
    const create = OGCompletionPhotos.create;
    OGCompletionPhotos.create = config => create({...config, pollMs: 150});
    const desktopCreate=OGPhoneCamera.createDesktop, receiverCreate=OGPhoneCamera.createReceiver;
    OGPhoneCamera.createDesktop=config=>desktopCreate({...config,pollMs:100});
    OGPhoneCamera.createReceiver=config=>receiverCreate({...config,pollMs:100});
    let signedIn=loggedIn;
    window.supabase = {
      auth:{getSession:async()=>({data:{session:signedIn?{user:{id:actor,email:actor}}:null}}),
        signInWithPassword:async()=>{signedIn=true;return {data:{}};}},
      from(table) {
        const filters = [];
        let start = 0, end = 499;
        const q = {
          select() {return q;}, eq(k, v) {filters.push([k, v]); return q;}, order() {return q;},
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
    if (phoneLink) document.dispatchEvent(new Event('DOMContentLoaded'));
    else {setupListeners();renderOrders();}
  }, {actor, imageUrl, phoneLink, loggedIn});
  return page;
}

async function pick(page, input = 'completion-photo-files', name = 'packed-order.png') {
  await page.locator(`#${input}`).setInputFiles({name, mimeType: 'image/png', buffer: png});
}
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

test('computer QR opens a focused phone view, preserves sign-in and shares photos automatically', async t => {
  const db=database(), desktop=await open(t,db);
  await desktop.evaluate(()=>{state.selectedLine=null;renderOrders();});
  await desktop.locator('[data-phone-camera="buyer"]').click();
  await expect(desktop.locator('#phone-pair-qr svg')).toBeVisible();
  const link=await desktop.locator('#phone-pair-link').inputValue();
  assert.match(link,/#phone-camera=[0-9a-f-]{36}$/);
  assert.equal(db.sessions.size,1);assert.equal(db.requests.size,1);
  // Decode the actual displayed QR rather than only checking that an SVG exists.
  const qrImage=await desktop.locator('#phone-pair-qr').screenshot();
  const decoded=await desktop.evaluate(async url=>(await new ZXingBrowser.BrowserQRCodeReader().decodeFromImageUrl(url)).getText(),`data:image/png;base64,${qrImage.toString('base64')}`);
  assert.equal(decoded,link);
  const phone=await open(t,db,{mobile:true,actor:'phone@example.com',phoneLink:link,loggedIn:false});
  await expect(phone.locator('#phone-camera-login')).toBeVisible();
  await phone.locator('#phone-camera-email').fill('phone@example.com');
  await phone.locator('#phone-camera-password').fill('test-only-password');
  await phone.locator('#phone-camera-login-submit').tap();
  await expect(phone.locator('#completion-photos-modal')).toBeVisible();
  await expect(phone.locator('#completion-photo-context')).toContainText('11-22222-33333');
  await expect(phone.locator('#orders-list')).toBeHidden();
  assert.equal(await phone.locator('#completion-photo-camera').getAttribute('capture'),'environment');
  await pick(phone);await save(phone);
  await expect(desktop.locator('#phone-pair-photos .completion-photo-card')).toHaveCount(1);
  await expect(desktop.locator('#phone-pair-progress')).toContainText('Photos saved');
  assert.ok(db.events.every(e=>e.signed_by_email==='phone@example.com'));
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await phone.screenshot({path:'test-results/phone-camera-mobile.png'});
  await desktop.screenshot({path:'test-results/phone-camera-desktop.png'});
  await expect(desktop.locator('[data-phone-camera="buyer"]')).toHaveText('Send to phone');
  await desktop.locator('#phone-pair-qr-section summary').click();
  await expect(desktop.locator('#phone-pair-qr svg')).toBeVisible();
  await desktop.waitForTimeout(250);
  await expect(desktop.locator('#phone-pair-qr svg')).toBeVisible();
  // A new workstation page restores its saved browser pairing without another QR scan.
  const resumed=await open(t,db);
  const sessionId=[...db.sessions.keys()][0];
  await resumed.evaluate(id=>localStorage.setItem(`og-order-phone:${state.user.id}`,id),sessionId);
  await resumed.evaluate(()=>sendOrderToPhone([lines[1]]));
  await expect(resumed.locator('#phone-pair-order')).toContainText('11-22222-44444');
  assert.equal(db.sessions.size,1);
});

test('next order cannot steal unsaved photos; one phone tap opens its camera with the new scope',async t=>{
  const db=database(),desktop=await open(t,db);
  await desktop.evaluate(()=>sendOrderToPhone([lines[0]]));
  await expect(desktop.locator('#phone-pair-qr svg')).toBeVisible();
  const link=await desktop.locator('#phone-pair-link').inputValue();
  const phone=await open(t,db,{mobile:true,actor:'phone@example.com',phoneLink:link});
  await expect(phone.locator('#completion-photo-context')).toContainText('11-22222-33333');
  await pick(phone,'completion-photo-camera','order-a.png');
  await desktop.evaluate(()=>sendOrderToPhone([lines[1]]));
  await expect(phone.locator('#phone-camera-next')).toBeVisible();
  await phone.locator('#phone-camera-open-next').tap();
  // Connection notices refresh in the background; verify the protected photo scope itself.
  await expect(phone.locator('#completion-photo-pending .completion-photo-card')).toHaveCount(1);
  await expect(phone.locator('#completion-photo-context')).toContainText('11-22222-33333');
  db.failUpload=true;await phone.locator('#save-completion-photos').tap();
  await expect(phone.locator('#completion-photo-status')).toContainText('Upload unavailable');
  assert.equal(db.marks.some(m=>m._status==='saved'),false);
  db.failUpload=false;await save(phone);
  assert.equal(db.events.length,1);assert.equal(db.events[0].order_id,'order-a');
  const firstRequest=[...db.requests.values()][0];
  assert.ok(db.marks.some(m=>m._request_id===firstRequest.id&&m._status==='saved'));
  const chooser=phone.waitForEvent('filechooser');await phone.locator('#phone-camera-open-next').tap();
  await (await chooser).setFiles({name:'order-b.png',mimeType:'image/png',buffer:png});
  await expect(phone.locator('#completion-photo-context')).toContainText('11-22222-44444');
  await save(phone);assert.equal(db.events[0].order_id,'order-b');
  assert.equal(db.sessions.size,1);assert.equal(db.requests.size,2);
});

test('lost handoff response retries once, reuses pairing and disconnect revokes the phone link',async t=>{
  const db=database(),desktop=await open(t,db);db.loseSendResponse=true;
  await desktop.evaluate(()=>sendOrderToPhone([lines[0]]));
  await expect(desktop.locator('#phone-pair-status')).toContainText('response lost');
  await desktop.locator('#retry-phone-send').click();
  await expect(desktop.locator('#phone-pair-qr svg')).toBeVisible();
  assert.equal(db.requests.size,1);assert.equal(db.sessions.size,1);
  const sends=db.calls.filter(c=>c.name==='send_order_to_phone');
  assert.equal(sends[0].args._request_id,sends[1].args._request_id);
  const link=await desktop.locator('#phone-pair-link').inputValue();
  const phone=await open(t,db,{mobile:true,actor:'phone@example.com',phoneLink:link});
  await expect(phone.locator('#completion-photos-modal')).toBeVisible();
  await desktop.locator('#disconnect-phone-camera').click();
  await expect(phone.locator('#phone-camera-status')).toContainText('pairing has ended');
  await desktop.evaluate(()=>sendOrderToPhone([lines[1]]));
  await expect(desktop.locator('#phone-pair-link')).not.toHaveValue(link);
  assert.equal(db.sessions.size,2);
});

test('both checkout paths and the photo panel send exactly their selected items',async t=>{
  const db=database(),page=await open(t,db);
  await page.evaluate(()=>openWorkerNoInventoryModal({lineIds:['line-b']}));
  await page.locator('[data-phone-camera="no-inventory"]').click();
  await expect(page.locator('#phone-pair-order')).toContainText('11-22222-44444');
  assert.deepEqual(db.calls.find(c=>c.name==='send_order_to_phone').args._line_ids,['line-b']);
  await page.locator('#done-phone-camera-pair').click();
  await page.evaluate(()=>{
    closeWorkerNoInventoryModal();
    state.stagedFulfillments.set('line-a',{line:lines[0],mode:'inventory',qty:1,item:{title:'Chain',photos:[]},row:{locationLabel:'Main'}});
    openBundleReviewModal();
  });
  await page.locator('[data-phone-camera="bundle"]').click();
  await expect(page.locator('#phone-pair-order')).toContainText('11-22222-33333');
  assert.deepEqual(db.calls.filter(c=>c.name==='send_order_to_phone').at(-1).args._line_ids,['line-a']);
  await page.locator('#done-phone-camera-pair').click();
  await page.evaluate(()=>{closeBundleReviewModal();openCompletionPhotos([lines[1]]);});
  await page.locator('[data-phone-camera="photos"]').click();
  await expect(page.locator('#phone-pair-order')).toContainText('11-22222-44444');
});

test('phone previews unsaved photos with zoom and pinch, then returns without losing or uploading them',async t=>{
  const db=database(),desktop=await open(t,db);
  await desktop.evaluate(()=>sendOrderToPhone([lines[0]]));
  await expect(desktop.locator('#phone-pair-qr svg')).toBeVisible();
  const phone=await open(t,db,{mobile:true,actor:'phone@example.com',phoneLink:await desktop.locator('#phone-pair-link').inputValue()});
  await expect(phone.locator('#completion-photos-modal')).toBeVisible();
  await phone.locator('#completion-photo-files').setInputFiles(['front.png','back.png'].map(name=>({name,mimeType:'image/png',buffer:png})));
  const previews=phone.locator('[data-inspect-pending-photo]');
  await expect(previews).toHaveCount(2);
  const selectedUrl=await previews.nth(1).locator('img').getAttribute('src');
  await previews.nth(1).tap();
  const viewer=phone.locator('#no-inventory-photo-viewer-modal'), image=phone.locator('#no-inventory-photo-viewer-image');
  await expect(viewer).toBeVisible();
  await expect(image).toHaveAttribute('src',selectedUrl);
  await expect(image).toHaveAttribute('alt','back.png');
  await phone.locator('#zoom-in-no-inventory-photo').tap();
  assert.equal(await phone.evaluate(()=>state.evidencePhotoViewerZoom),1.25);
  await phone.locator('#reset-zoom-no-inventory-photo').tap();
  // Exercise the browser's pointer listeners for a two-finger pinch and a following one-finger pan.
  await image.dispatchEvent('pointerdown',{pointerId:11,pointerType:'touch',clientX:140,clientY:350,button:0});
  await image.dispatchEvent('pointerdown',{pointerId:12,pointerType:'touch',clientX:240,clientY:350,button:0});
  await image.dispatchEvent('pointermove',{pointerId:12,pointerType:'touch',clientX:340,clientY:350});
  assert.equal(await phone.evaluate(()=>state.evidencePhotoViewerZoom),2);
  await image.dispatchEvent('pointerup',{pointerId:12,pointerType:'touch',clientX:340,clientY:350});
  const oldPan=await phone.evaluate(()=>state.evidencePhotoViewerPanX);
  await image.dispatchEvent('pointermove',{pointerId:11,pointerType:'touch',clientX:170,clientY:350});
  assert.equal(await phone.evaluate(()=>state.evidencePhotoViewerPanX),oldPan+30);
  await image.dispatchEvent('pointercancel',{pointerId:11,pointerType:'touch'});
  assert.equal(await phone.evaluate(()=>state.evidencePhotoViewerPanning),false);
  await phone.locator('#reset-zoom-no-inventory-photo').tap();
  await expect(image).toHaveCSS('transform','matrix(1, 0, 0, 1, 0, 0)');
  await phone.locator('#dismiss-no-inventory-photo-viewer').tap();
  await expect(viewer).toBeHidden();await expect(previews).toHaveCount(2);
  assert.equal(db.uploads.length,0);assert.equal(db.events.length,0);
  await previews.first().tap();await expect(image).toHaveAttribute('alt','front.png');
  assert.equal(await phone.evaluate(()=>state.evidencePhotoViewerZoom),1);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await phone.screenshot({path:'test-results/phone-pending-photo-inspection.png'});
  await phone.locator('#close-no-inventory-photo-viewer').tap();
  await save(phone);assert.equal(db.events.length,2);
  await expect(phone.locator('[data-completion-photo]')).toHaveCount(2);
  await phone.locator('[data-completion-photo]').first().tap();await expect(viewer).toBeVisible();
  await phone.locator('#zoom-in-no-inventory-photo').tap();assert.equal(await phone.evaluate(()=>state.evidencePhotoViewerZoom),1.25);
  await phone.locator('#dismiss-no-inventory-photo-viewer').tap();
  // The computer can remove a phone upload directly from the pairing panel.
  await expect(desktop.locator('#phone-pair-photos [data-remove-saved-photo]')).toHaveCount(2);
  await desktop.locator('#phone-pair-photos [data-remove-saved-photo]').first().click();
  await expect(desktop.locator('#phone-pair-photos .completion-photo-card')).toHaveCount(1);
  await expect(phone.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(1);
  await phone.locator('#completion-photo-saved [data-remove-saved-photo]').tap();
  await expect(phone.locator('#completion-photo-saved .completion-photo-card')).toHaveCount(0);
  await expect(desktop.locator('#phone-pair-photos .completion-photo-card')).toHaveCount(0);
});

