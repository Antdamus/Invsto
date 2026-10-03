import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {createRequire} from 'node:module';
import {test, before, after} from 'node:test';
import {chromium, expect} from '@playwright/test';

const require = createRequire(import.meta.url);
const {PDFDocument} = require('../vendor/pdf-lib/pdf-lib.min.js');
const root = new URL('../', import.meta.url);
let server, browser, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.slice(1);
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) return res.writeHead(404).end();
    try {
      let content = await readFile(new URL(name, root));
      if (name.endsWith('.html')) content = content.toString().replace(/<script\b[\s\S]*?<\/script>/gi, '');
      res.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css' : 'text/html');
      res.end(content);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch();
});
after(async () => {await browser?.close(); await new Promise(resolve => {server.close(resolve); server.closeAllConnections();});});

async function pdf(texts = ['Tracking: 9400111899223856928499'], size = [288,432]) {
  const doc = await PDFDocument.create();
  for (const text of texts) {
    const page = doc.addPage(size);
    page.drawText('SHIPPING LABEL - TEST', {x:20,y:size[1]-40,size:14});
    if (text) page.drawText(text, {x:20,y:size[1]-80,size:10});
  }
  return Buffer.from(await doc.save());
}
function database() {
  return {orders: ['a','b'].map(letter => ({id:`order-${letter}`,order_number:`11-22222-${letter === 'a' ? '33333':'44444'}`,
    buyer_username:'lore2526',label_metadata:{}})), events:[], uploads:[], calls:[], requests:new Set(), failUpload:0, loseResponse:false};
}
async function open(t, db, mobile = false) {
  const context = await browser.newContext({viewport:{width:mobile ? 390:1440,height:950},isMobile:mobile,hasTouch:mobile});
  t.after(() => context.close());
  await context.route('**/*', r => [origin, `blob:${origin}`, 'data:'].some(s => r.request().url().startsWith(s)) ? r.continue():r.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors=[]; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors,[]));
  await page.exposeFunction('labelDb', async ({op,...args}) => {
    if (op === 'read') {
      let rows = structuredClone(args.table === 'ebay_orders' ? db.orders : db.events);
      for (const [kind,key,values] of args.filters) rows = rows.filter(row => kind === 'in' ? values.includes(row[key]) : row[key].some(v => values.includes(v)));
      if (args.fields) rows = rows.map(row => Object.fromEntries(args.fields.split(',').map(key => key.trim()).map(key => [key,row[key] ?? null])));
      return {data:rows.slice(args.start,args.end+1)};
    }
    if (op === 'upload') {
      if (db.failUpload && db.uploads.length === db.failUpload-1) {db.failUpload=0; return {error:{message:'Upload interrupted'}};}
      if (db.uploads.some(upload=>upload.path===args.path) && !args.options?.upsert) return {error:{statusCode:'409',message:'The resource already exists'}};
      db.uploads.push(args); return {data:{path:args.path}};
    }
    if (op === 'rpc') {
      db.calls.push(args);
      if (args.name === 'append_ebay_shipping_label') {
        const a=args.args,orders=db.orders.filter(order=>a._order_ids.includes(order.id));
        for (const order of orders) {
          if (!db.events.some(event=>event.order_ids.includes(order.id)&&event.label_file_path===a._label_file_path)) {
            db.events.push({id:`event-${db.events.length}`,action:order.label_file_path?'extra_label':'attached',
              order_ids:[order.id],order_numbers:[order.order_number],label_storage_bucket:'ebay-labels',label_file_path:a._label_file_path,
              label_metadata:a._label_metadata,source:'extension-append',signed_by_email:'staff@example.com',created_at:'2026-10-03T18:00:00Z'});
          }
          if (!order.label_file_path) Object.assign(order,{label_storage_bucket:'ebay-labels',label_file_path:a._label_file_path,
            label_metadata:a._label_metadata,label_status:'label_uploaded',ebay_shipment_id:a._shipment_id});
        }
        if (db.loseAppendResponse) {db.loseAppendResponse=false;return {error:{message:'Save response lost'}};}
        return {data:{saved:true,order_labels:structuredClone(orders)}};
      }
      if (args.name !== 'attach_manual_shipping_labels') return {data:{}};
      const a=args.args;
      if (db.requests.has(a._request_id)) return {data:{saved:true,already_saved:true}};
      db.requests.add(a._request_id);
      for (const label of a._labels) for (const id of label.order_ids) {
        const order=db.orders.find(o=>o.id===id);
        db.events.push({id:`event-${db.events.length}`,action:order.label_file_path?'extra_label':'attached',
          order_ids:[id],order_numbers:[order.order_number],label_storage_bucket:'ebay-labels',label_file_path:label.path,
          label_metadata:label.metadata,source:'manual-label-upload',signed_by_email:'staff@example.com',created_at:'2026-10-03T17:00:00Z'});
        if (!order.label_file_path) Object.assign(order,{label_storage_bucket:'ebay-labels',label_file_path:label.path,
          label_metadata:label.metadata,label_status:'label_uploaded'});
      }
      if (db.loseResponse) {db.loseResponse=false;return {error:{message:'Save response lost'}};}
      return {data:{saved:true}};
    }
    throw Error(`Unknown operation ${op}`);
  });
  await page.goto(`${origin}/pending-orders.html`);
  for (const script of ['shipping-label-reader.js','shipping-label-print.js','order-shipping-labels.js','barcode-scanner.js','pending-orders.js']) await page.addScriptTag({url:`${origin}/${script}`});
  await page.evaluate(orders => {
    const create=OGOrderShippingLabels.create; OGOrderShippingLabels.create=config=>create({...config,pollMs:150});
    window.supabase={
      from(table) {
        const filters=[];let start=0,end=499,fields;
        const q={select(value){fields=value;return q;},in(k,v){filters.push(['in',k,v]);return q;},overlaps(k,v){filters.push(['overlaps',k,v]);return q;},
          order(){return q;},range(a,b){start=a;end=b;return q;},then(resolve,reject){return labelDb({op:'read',table,filters,start,end,fields}).then(resolve,reject);}};
        return q;
      },
      storage:{from(bucket){return {upload:(path,file,options)=>labelDb({op:'upload',bucket,path,size:file.size,options}),createSignedUrl:async path=>({data:{signedUrl:`${location.origin}/${path}`}})};}},
      rpc:(name,args)=>labelDb({op:'rpc',name,args}),
    };
    window.lines=orders.map((order,i)=>({id:`line-${i?'b':'a'}`,order_id:order.id,item_title:i?'Silver ring':'Gold chain',quantity:1,fulfilled_quantity:0,
      total_price:i?30:1485,line_status:'pending',order}));
    state.user={id:'staff',email:'staff@example.com'};state.employee={active:true,role:'employee'};
    state.orders=lines;state.filteredOrders=lines;state.selectedLine=lines[0];
    state.checkoutStoreId='store-a';state.stores=[{id:'store-a',name:'Main Store'}];
    hydrateBuyerGroupNotes=()=>{}; scheduleQueueVideoReceiptEvidenceHydration=()=>{};
    loadNoInventoryCaptureStations=async()=>{};captureAuditLocation=async()=>({status:'granted'});resolvePhotoUrl=async()=>'';
    setupListeners();renderOrders();
  },db.orders);
  return page;
}
async function pick(page, files) {
  await page.locator('#order-label-files').setInputFiles(files.map(([name,buffer])=>({name,mimeType:'application/pdf',buffer})));
  await expect(page.locator('#save-order-labels')).toBeEnabled();
}
async function save(page) {
  await page.locator('#save-order-labels').click();
  await expect(page.locator('#order-label-upload-status')).toContainText('Labels saved');
}

test('saved shipping label marks the whole group, including filtered lines; tracking alone does not',async t=>{
  const db=database();
  Object.assign(db.orders[0],{label_file_path:'extension/saved.pdf',label_metadata:{trackingNumber:'111111111111'}});
  Object.assign(db.orders[1],{label_status:'completed',label_metadata:{trackingNumber:'222222222222'}});
  const page=await open(t,db),badge=page.locator('.buyer-card-meta [data-shipping-label-orders]');
  await expect(badge).toHaveCount(1);await expect(badge).toBeVisible();
  await expect(badge).toHaveText('✓ Shipping label added');
  await expect(page.locator('.buyer-line-btn [data-shipping-label-orders]')).toHaveCount(0);
  await page.evaluate(()=>{state.filteredOrders=[lines[1]];renderOrders();});
  await expect(badge).toBeVisible();
  await page.evaluate(()=>{lines[1].order.buyer_username='another-buyer';state.filteredOrders=lines;renderOrders();});
  await expect(badge).toHaveCount(2);
  await expect(page.locator('[data-shipping-label-orders*="order-a"]')).toBeVisible();
  await expect(page.locator('[data-shipping-label-orders*="order-b"]')).toBeHidden();
  await expect.poll(()=>page.evaluate(()=>lines[0].order.label_metadata.trackingNumber)).toBe('111111111111');
});

test('phone label upload updates the collapsed queue without opening labels or replacing the card',async t=>{
  const db=database(),desktop=await open(t,db),phone=await open(t,db,true);
  await desktop.evaluate(()=>{
    state.selectedLine=null;state.collapsedBuyerKeys.add('lore2526');renderOrders();
    document.querySelector('.buyer-order-card').dataset.testIdentity='same-card';
  });
  const badge=desktop.locator('.buyer-card-meta [data-shipping-label-orders]');
  await expect(badge).toBeHidden();
  await phone.locator('[data-buyer-shipping-labels]').tap();
  await pick(phone,[['phone-label.pdf',await pdf()]]);
  await expect(badge).toBeHidden();
  await save(phone);
  await expect(badge).toBeVisible();await expect(badge).toHaveText('✓ Shipping label added');
  await expect(desktop.locator('.buyer-order-card')).toHaveAttribute('data-test-identity','same-card');
  await expect(desktop.locator('.buyer-card-expanded')).toHaveCount(0);
  await phone.locator('#done-order-labels').tap();
  await expect(phone.locator('.buyer-card-meta [data-shipping-label-orders]')).toBeVisible();
  assert.equal(await phone.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await desktop.screenshot({path:'test-results/shipping-label-queue-marker.png'});
  await phone.screenshot({path:'test-results/shipping-label-queue-marker-phone.png'});
  for (const order of db.orders) order.label_file_path=null;
  await expect(badge).toBeHidden();
});

test('extension imports append multiple PDFs in checkout, preserve old labels, and retry without duplicates',async t=>{
  const db=database();
  Object.assign(db.orders[0],{label_file_path:'old/current.pdf',label_status:'label_uploaded',label_metadata:{trackingNumber:'111111111111'}});
  db.events=['original','current'].map((name,i)=>({id:`legacy-${i}`,action:i?'replaced':'attached',order_ids:['order-a'],
    order_numbers:[db.orders[0].order_number],label_storage_bucket:'ebay-labels',label_file_path:`old/${name}.pdf`,
    label_metadata:i?{}:{trackingNumber:'000000000000'},source:'extension',created_at:`2026-10-02T1${i}:00:00Z`}));
  const original=structuredClone(db.orders[0]),page=await open(t,db);
  await page.evaluate(async()=>{
    ensureExtensionOrderLinesLoaded=async({orderNumbers})=>lines.filter(line=>orderNumbers.includes(line.order.order_number));
    openPendingNoInventorySessionForLabel=async()=>true;
    await openWorkerNoInventoryModal({lineIds:['line-a']});
    window.prints=[];shippingLabelPrint.run=(button,options)=>prints.push(options);
  });
  const saved=page.locator('#no-inventory-shipping-labels .order-saved-label');
  await expect(saved).toHaveCount(2);
  const firstPdf=(await pdf(['222222222222'])).toString('base64');
  const secondPdf=(await pdf(['333333333333'])).toString('base64');
  const send=(base64,tracking,transferId)=>page.evaluate(async args=>attachEbayLabelToOrder({
    transferId:args.transferId,metadata:{orderId:lines[0].order.order_number,shipmentId:'reused-shipment',trackingNumber:args.tracking},
    label:{base64:args.base64,mimeType:'application/pdf'},
  }),{base64,tracking,transferId});
  await send(firstPdf,'222222222222','send-1');await expect(saved).toHaveCount(3);
  db.loseAppendResponse=true;
  await assert.rejects(send(secondPdf,'333333333333','send-2'),/Save response lost/);
  await send(secondPdf,'333333333333','retry-2');await expect(saved).toHaveCount(4);
  await send(firstPdf,'222222222222','send-again');await expect(saved).toHaveCount(4);
  assert.deepEqual(db.orders[0],original);
  assert.equal(db.uploads.length,2);assert.notEqual(db.uploads[0].path,db.uploads[1].path);
  assert.ok(db.uploads.every(upload=>upload.options.upsert===false));
  assert.ok(db.calls.every(call=>call.name==='append_ebay_shipping_label'));
  assert.equal(await page.evaluate(()=>lines[0].order.label_file_path),'old/current.pdf');
  for (const tracking of ['000000000000','111111111111','222222222222','333333333333']) await expect(page.locator('#no-inventory-shipping-labels')).toContainText(tracking);
  for (const button of await saved.locator('[data-print-saved-label]').all()) await button.click();
  assert.equal(new Set(await page.evaluate(()=>prints.map(item=>item.path))).size,4);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await page.locator('#no-inventory-shipping-labels').screenshot({path:'test-results/extension-multiple-labels.png'});
  await page.goto(`${origin}/ebay-order-history.html`);await page.addScriptTag({url:`${origin}/ebay-order-history.js`});
  const history=await page.evaluate(events=>{state.labelEvents=events;state.relatedLabelEvents=[];return renderExtraLabelEvents(['11-22222-33333']);},db.events);
  assert.match(history,/222222222222/);assert.match(history,/333333333333/);assert.doesNotMatch(history,/forgotten-item/);
});

test('real PDF reader reads multiple pages and tracking formats, with bounded file validation',async t=>{
  const page=await open(t,database());
  const bytes=await pdf(['1Z 999 AA1 01 2345 6784','TRK# 1234 5678 9012','9400 1118 9922 3856 9284 99'],[612,792]);
  const result=await page.evaluate(bytes=>shippingLabelReader.read(new File([new Uint8Array(bytes)],'labels.pdf')),[...bytes]);
  assert.deepEqual(result.trackingNumbers,['1Z999AA10123456784','123456789012','9400111899223856928499']);
  assert.equal(result.pageCount,3);assert.equal(result.allThermal,false);assert.match(result.previewUrl,/^data:image\/jpeg/);
  assert.equal(await page.evaluate(()=>shippingLabelReader.trackingFromBarcode('420331019400111899223856928499')),'9400111899223856928499');
  const errors=await page.evaluate(async()=>{
    const failures=[];
    for(const file of [new File(['not a pdf'],'wrong.pdf'),new File(['%PDF-1.7 incomplete'],'partial.pdf'),new File([new Uint8Array(10485761)],'large.pdf')]){
      try {await shippingLabelReader.read(file);}catch(e){failures.push(e.message);}
    }
    return failures;
  });
  assert.equal(errors.length,3);assert.match(errors[0],/complete PDF/);assert.match(errors[2],/10 MB/);
  const passwordError=await page.evaluate(async bytes=>{
    window.pdfjsLib={...window.pdfjsLib,getDocument:()=>{
      const task={promise:new Promise(()=>{}),destroy:async()=>{}};
      queueMicrotask(()=>task.onPassword());return task;
    }};
    try {await shippingLabelReader.read(new File([new Uint8Array(bytes)],'protected.pdf'));}
    catch(error){return error.message;}
  },[...bytes]);
  assert.match(passwordError,/password protected/);
});

test('real image-only PDF barcode decoding preserves leading zeros',async t=>{
  const page=await open(t,database());
  await page.addScriptTag({url:`${origin}/vendor/pdf-lib/pdf-lib.min.js`});
  await page.addScriptTag({url:`${origin}/node_modules/jsbarcode/dist/JsBarcode.all.min.js`});
  const result=await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');JsBarcode(canvas,'001234567890',{format:'CODE128',width:3,height:160,margin:30,displayValue:false});
    const doc=await PDFLib.PDFDocument.create();const img=await doc.embedPng(canvas.toDataURL());
    doc.addPage([288,432]).drawImage(img,{x:10,y:140,width:268,height:110});
    return shippingLabelReader.read(new File([await doc.save()],'scanned-label.pdf'));
  });
  assert.deepEqual(result.trackingNumbers,['001234567890']);assert.deepEqual(result.barcodeValues,['001234567890']);assert.equal(result.allThermal,true);
});

test('compact mobile block accepts multiple PDFs, reviewed tracking and explicit per-order scope',async t=>{
  const db=database(),page=await open(t,db,true);
  await page.evaluate(()=>{state.selectedLine=null;renderOrders();});
  await page.locator('[data-buyer-shipping-labels]').tap();
  await expect(page.locator('.buyer-card-expanded')).toHaveCount(0);
  await pick(page,[['USPS label.pdf',await pdf()],['UPS label.pdf',await pdf(['1Z999AA10123456784'])]]);
  const cards=page.locator('.order-label-upload-card');
  await cards.nth(0).locator('[data-label-order][value="order-b"]').uncheck();
  await cards.nth(1).locator('[data-label-order][value="order-a"]').uncheck();
  await cards.nth(0).locator('[data-label-tracking]').fill('9400111899223856928400');
  await expect(cards.nth(0).locator('[data-scan-target]')).toBeVisible();
  await page.locator('#done-order-labels').tap();await expect(page.locator('#order-label-upload-status')).toContainText('Save or clear');
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await page.screenshot({path:'test-results/shipping-labels-mobile.png'});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await save(page);
  assert.equal(db.uploads.length,2);assert.equal(db.events.length,2);
  const labels=db.calls[0].args._labels;
  assert.deepEqual(labels.map(l=>l.order_ids),[['order-a'],['order-b']]);
  assert.deepEqual(labels[0].metadata.trackingNumbers,['9400111899223856928400']);
  assert.equal(labels[0].metadata.labelRows,undefined);assert.equal(labels[0].metadata.lookupKeys.includes('9400111899223856928499'),false);
  await expect(page.locator('#order-label-saved .order-saved-label')).toHaveCount(2);
  await page.locator('#done-order-labels').tap();await expect(page.locator('#order-shipping-labels-modal')).toBeHidden();
});

test('camera scanner accepts a photo barcode into the pending PDF and keeps its modal open',async t=>{
  const db=database(),page=await open(t,db,true);
  await page.locator('[data-buyer-shipping-labels]').tap();await pick(page,[['scan-this.pdf',await pdf([''])]]);
  await page.addScriptTag({url:`${origin}/node_modules/jsbarcode/dist/JsBarcode.all.min.js`});
  const image=await page.evaluate(()=>{
    navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};
    const canvas=document.createElement('canvas');JsBarcode(canvas,'001234567890',{format:'CODE128',width:3,height:160,margin:30,displayValue:false});
    return canvas.toDataURL();
  });
  await page.locator('.order-label-upload-card [data-scan-target]').tap();
  await page.locator('[data-camera="photo"]').setInputFiles({name:'barcode.png',mimeType:'image/png',buffer:Buffer.from(image.split(',')[1],'base64')});
  await expect(page.locator('[data-camera="use"]')).toBeEnabled();
  await page.locator('[data-camera="use"]').tap();
  await expect(page.locator('[data-label-tracking]')).toHaveValue('001234567890');
  await expect(page.locator('#order-shipping-labels-modal')).toBeVisible();
  await save(page);assert.equal(db.calls[0].args._labels[0].metadata.trackingNumber,'001234567890');
});

test('blank PDF uses scan/manual fallback and requires an order and tracking before saving',async t=>{
  const db=database(),page=await open(t,db);
  await page.locator('[data-buyer-shipping-labels]').click();await pick(page,[['blank.pdf',await pdf([''])]]);
  await expect(page.locator('.order-label-upload-card')).toContainText('No tracking number was read');
  await page.locator('#save-order-labels').click();assert.equal(db.calls.length,0);
  const input=page.locator('[data-label-tracking]');await input.fill('000123456789');await input.press('Enter');assert.equal(db.calls.length,0);
  for (const choice of await page.locator('[data-label-order]').all()) await choice.uncheck();
  await page.locator('#save-order-labels').click();assert.equal(db.calls.length,0);
  await page.locator('[data-label-order]').first().check();await save(page);
  assert.equal(db.calls[0].args._labels[0].metadata.trackingNumber,'000123456789');
});

test('partial storage failure and lost database response retry safely; existing primary label stays',async t=>{
  const db=database();db.orders[0].label_file_path='extension/original.pdf';db.orders[0].label_metadata={trackingNumber:'111111111111'};
  const page=await open(t,db);await page.locator('[data-buyer-shipping-labels]').click();
  await pick(page,[['one.pdf',await pdf()],['two.pdf',await pdf(['1Z999AA10123456784'])]]);
  db.failUpload=2;await page.locator('#save-order-labels').click();await expect(page.locator('#order-label-upload-status')).toContainText('Upload interrupted');
  assert.equal(db.uploads.length,1);assert.equal(db.events.length,0);
  db.loseResponse=true;await page.locator('#save-order-labels').click();await expect(page.locator('#order-label-upload-status')).toContainText('Save response lost');
  assert.equal(db.uploads.length,2);assert.equal(db.events.length,4);
  await save(page);assert.equal(db.calls[0].args._request_id,db.calls[1].args._request_id);
  assert.equal(db.events.length,4);assert.equal(db.uploads.length,2);assert.equal(db.orders[0].label_file_path,'extension/original.pdf');
  await expect(page.locator('#order-label-saved .order-saved-label')).toHaveCount(3);
  await page.goto(`${origin}/ebay-order-history.html`);
  await page.addScriptTag({url:`${origin}/ebay-order-history.js`});
  const history=await page.evaluate(events=>{
    state.labelEvents=events;state.relatedLabelEvents=[];
    return renderExtraLabelEvents(['11-22222-33333']);
  },db.events);
  assert.match(history,/one.pdf/);assert.match(history,/two.pdf/);
  assert.match(history,/1Z999AA10123456784/);assert.doesNotMatch(history,/forgotten-item/);
});

test('phone label uploads appear in both open checkout modes and pending PDFs prevent completion',async t=>{
  const db=database(),desktop=await open(t,db),mixed=await open(t,db),phone=await open(t,db,true);
  await desktop.evaluate(()=>openWorkerNoInventoryModal({lineIds:['line-a']}));
  await mixed.evaluate(()=>{
    state.stagedFulfillments.set('line-a',{line:lines[0],mode:'inventory',qty:1,item:{id:'item-a',title:'Chain',photos:[]},row:{id:'stock-a',locationLabel:'Main'}});
    state.stagedFulfillments.set('line-b',{line:lines[1],mode:'without_inventory',qty:1,item:{title:'Ring'},row:{locationLabel:'Without inventory'}});
    openBundleReviewModal();
  });
  await phone.locator('[data-buyer-shipping-labels]').tap();await pick(phone,[['phone-label.pdf',await pdf()]]);await save(phone);
  await expect(desktop.locator('#no-inventory-shipping-labels')).toContainText('phone-label.pdf');
  await expect(mixed.locator('#bundle-shipping-labels')).toContainText('phone-label.pdf');
  assert.equal(await desktop.evaluate(()=>state.selectedLine.label_file_path),db.orders[0].label_file_path);
  await mixed.locator('[data-order-label-source="bundle"]').click();await pick(mixed,[['not-saved.pdf',await pdf()]]);
  const count=db.calls.length;
  await mixed.evaluate(()=>fulfillSelectedOrder({skipReview:true}));
  await desktop.locator('[data-order-label-source="no-inventory"]').click();await pick(desktop,[['not-saved.pdf',await pdf()]]);
  await desktop.evaluate(()=>confirmWorkerNoInventoryCompletion());assert.equal(db.calls.length,count);
  await expect(desktop.locator('#order-shipping-labels-modal')).toBeVisible();
  await mixed.locator('#clear-order-label-selection').click();await mixed.locator('#done-order-labels').click();
  await expect(mixed.locator('#bundle-review-modal')).toBeVisible();
});
