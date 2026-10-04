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

test('PDF validation tools load only when needed, retry a failed download, and share concurrent loads',async t=>{
  const context=await browser.newContext();t.after(()=>context.close());
  const page=await context.newPage();
  await page.goto(`${origin}/pending-orders.html`);
  let requests=0,fail=true;
  await page.route('**/vendor/pdf-lib/pdf-lib.min.js',route=>{
    requests++;return fail ? route.abort() : route.continue();
  });
  await page.addScriptTag({url:`${origin}/shipping-pdf.js`});
  assert.equal(requests,0);assert.equal(await page.evaluate(()=>typeof PDFLib),'undefined');
  const bytes=[...await pdf()];
  const message=await page.evaluate(async bytes=>{
    try{await shippingPdf.inspect(new Uint8Array(bytes));}catch(error){return error.message;}
  },bytes);
  assert.match(message,/could not load/);assert.equal(requests,1);fail=false;
  const pages=await page.evaluate(async bytes=>{
    const inspections=await Promise.all([shippingPdf.inspect(new Uint8Array(bytes)),shippingPdf.inspect(new Uint8Array(bytes))]);
    return inspections.map(result=>result.count);
  },bytes);
  assert.deepEqual(pages,[1,1]);assert.equal(requests,2,'one successful download for two simultaneous users');
});
function database() {
  return {orders: ['a','b'].map(letter => ({id:`order-${letter}`,order_number:`11-22222-${letter === 'a' ? '33333':'44444'}`,
    buyer_username:'lore2526',label_metadata:{}})), events:[], uploads:[], calls:[], requests:new Set(), failUpload:0, loseResponse:false};
}
async function open(t, db, mobile = false, timezoneId = 'America/New_York') {
  db.lines ||= db.orders.map((order, i) => ({id:`line-${i?'b':'a'}`,order_id:order.id,item_title:i?'Silver ring':'Gold chain',quantity:1,fulfilled_quantity:0,
    total_price:i?30:1485,line_status:'pending',order}));
  db.reads ||= [];
  const context = await browser.newContext({viewport:{width:mobile ? 390:1440,height:950},isMobile:mobile,hasTouch:mobile,timezoneId});
  t.after(() => context.close());
  await context.route('**/*', r => [origin, `blob:${origin}`, 'data:'].some(s => r.request().url().startsWith(s)) ? r.continue():r.abort());
  const page = await context.newPage(); page.setDefaultTimeout(15000);
  const errors=[]; page.on('pageerror', e => errors.push(e.message)); t.after(() => assert.deepEqual(errors,[]));
  await page.exposeFunction('labelDb', async ({op,...args}) => {
    if (op === 'read') {
      db.reads.push(args);
      if (db.failBuyerBatch && args.filters.some(([,key])=>key==='ebay_orders.buyer_username')) return {error:{message:'Could not load full buyer batch'}};
      let rows = structuredClone(args.table === 'ebay_order_lines' ? db.lines.map(line=>({...line,ebay_orders:db.orders.find(order=>order.id===line.order_id)}))
        : args.table === 'ebay_orders' ? db.orders : args.table === 'ebay_order_label_events' ? db.events : []);
      for (const [kind,key,values] of args.filters) rows = rows.filter(row => {
        const value=key.split('.').reduce((value,part)=>value?.[part],row);
        return kind==='eq' ? value===values : kind === 'in' ? values.includes(value) : value?.some(v => values.includes(v));
      });
      if (args.fields && args.table !== 'ebay_order_lines') rows = rows.map(row => Object.fromEntries(args.fields.split(',').map(key => key.trim()).map(key => [key,row[key] ?? null])));
      return {data:rows.slice(args.start,args.end+1)};
    }
    if (op === 'upload') {
      if (db.failUpload && db.uploads.length === db.failUpload-1) {db.failUpload=0; return {error:{message:'Upload interrupted'}};}
      if (db.uploads.some(upload=>upload.path===args.path) && !args.options?.upsert) return {error:{statusCode:'409',message:'The resource already exists'}};
      db.uploads.push(args); return {data:{path:args.path}};
    }
    if (op === 'rpc') {
      db.calls.push(args);
      if (args.name === 'complete_ebay_order_lines_without_inventory_evidence') {
        const ids=args.args._order_line_ids;
        db.lines.filter(line=>ids.includes(line.id)).forEach(line=>Object.assign(line,{line_status:'fulfilled',fulfilled_quantity:line.quantity}));
        return {data:[{updated_lines:ids.length}]};
      }
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
          eq(k,v){filters.push(['eq',k,v]);return q;},limit(n){end=n-1;return q;},
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

async function prepareLabelBatch(page) {
  await page.evaluate(() => {
    hydratePendingOrderExtrasInBackground=()=>{};
    hydrateNoInventoryVideoReceiptEvidenceThumbnails=async()=>{};
    loadSelectedOrderTasks=hydrateSelectedOrderDetails=async()=>{};
    requestNoInventoryEvidencePhoto=async()=>{};
    state.activeBuyerKey=getBuyerKey(state.selectedLine);
    loadOrders=async()=>{
      const {data}=await supabase.from('ebay_order_lines').select('*').in('line_status',['pending','partially_fulfilled']);
      state.orders=data.map(normalizeLine);applyOrderFilters();
    };
  });
}

async function injectLabel(page, metadata, transferId='batch-label') {
  const base64=(await pdf()).toString('base64');
  return page.evaluate(({metadata,base64,transferId})=>attachEbayLabelToOrder({
    transferId,metadata,label:{base64,mimeType:'application/pdf'},
  }),{metadata,base64,transferId});
}

test('Get Label keeps two checked lines in the bulk flow even when they share one order number',async t=>{
  const page=await open(t,database());
  await page.evaluate(()=>{
    const first=state.orders[0];
    state.orders[1].order=first.order;
    state.orders[1].order_id=first.order_id;
    state.selectedLine=null;
    state.expandedBuyerKeys.add(getBuyerKey(first));
    window.labelWindows=[];
    window.open=(url,target,features)=>{labelWindows.push({url,target,features});return null;};
    renderOrders();renderAdminOrderActions();
  });
  await page.locator('.buyer-card-expanded [data-admin-group-select]').check();
  await expect(page.locator('[data-admin-line-select]:checked')).toHaveCount(2);
  await page.locator('[data-buyer-label-key]').click();
  assert.deepEqual(await page.evaluate(()=>labelWindows),[{
    url:'https://www.ebay.com/ship/bulk?t=11-22222-33333',target:'_blank',features:'noopener,noreferrer',
  }]);
  await page.locator('#admin-open-ebay-labels').click();
  assert.equal(await page.evaluate(()=>labelWindows.at(-1).url),'https://www.ebay.com/ship/bulk?t=11-22222-33333');
  await expect(page.locator('[data-admin-line-select]:checked')).toHaveCount(2);
  await page.locator('[data-admin-line-select="line-b"]').uncheck();
  await page.locator('[data-buyer-label-key]').click();
  assert.equal(await page.evaluate(()=>labelWindows.at(-1).url),'https://www.ebay.com/ship/single/11-22222-33333');
  await page.locator('[data-admin-line-select="line-a"]').uncheck();
  await expect(page.locator('[data-buyer-label-key]')).toBeDisabled();
  await expect(page.locator('#admin-open-ebay-labels')).toBeDisabled();
});

test('label launch preserves all selected orders, stays within the clicked buyer, and rejects incomplete identities',async t=>{
  const page=await open(t,database());
  await page.evaluate(()=>{
    const extra={...state.orders[0],id:'other-line',order_id:'other-order',order:{order_number:'22-33333-55555',buyer_username:'other-buyer'}};
    state.orders.push(extra,{...extra,id:'closed-line',line_status:'fulfilled',order:{...extra.order,order_number:'33-44444-66666'}});
    state.adminSelectedLineIds=new Set(state.orders.map(line=>line.id));
    window.labelWindows=[];
    window.open=url=>{labelWindows.push(url);return null;};
    openBuyerGroupSelectedEbayLabelPages({lines:state.orders.slice(0,2)});
    openAdminSelectedEbayLabelPages();
  });
  assert.deepEqual(await page.evaluate(()=>labelWindows),[
    'https://www.ebay.com/ship/bulk?t=11-22222-33333,11-22222-44444',
    'https://www.ebay.com/ship/bulk?t=11-22222-33333,11-22222-44444,22-33333-55555',
  ]);
  await page.evaluate(()=>{
    state.orders[1].order.order_number='';
    openBuyerGroupSelectedEbayLabelPages({lines:state.orders.slice(0,2)});
  });
  assert.equal(await page.evaluate(()=>labelWindows.length),2,'never open a partial batch when an order number is missing');
});

test('eleven selected items across eight orders show the item count and retain the four-item order in the handoff',async t=>{
  const page=await open(t,database());
  await page.evaluate(()=>{
    const sample=state.orders[0];
    const orders=Array.from({length:8},(_,i)=>({...sample.order,id:`batch-order-${i}`,order_number:`11-22222-${33333+i}`}));
    state.orders=orders.flatMap((order,i)=>Array.from({length:i===7?4:1},(_,j)=>({...sample,order,order_id:order.id,id:`batch-line-${i}-${j}`,item_title:`Order ${i+1}, item ${j+1}`})));
    state.filteredOrders=state.orders;state.selectedLine=null;
    state.expandedBuyerKeys.add(getBuyerKey(state.orders[0]));
    window.labelWindows=[];window.open=url=>{labelWindows.push(url);return null;};
    renderOrders();
  });
  await page.locator('.buyer-card-expanded [data-admin-group-select]').check();
  await expect(page.locator('[data-admin-line-select]:checked')).toHaveCount(11);
  await expect(page.locator('[data-buyer-label-key]')).toHaveText('Get labels (11 items)');
  await expect(page.locator('[data-buyer-label-key]')).toHaveAttribute('title',/11 selected item lines across 8 eBay orders/);
  await page.locator('[data-buyer-label-key]').click();
  const address=new URL(await page.evaluate(()=>labelWindows[0]));
  assert.equal(address.pathname,'/ship/bulk');
  const sentOrders=address.searchParams.get('t').split(',');
  assert.equal(sentOrders.length,8);
  assert.equal(new Set(sentOrders).size,8,'send whole orders once instead of requesting duplicate labels for sibling items');
  assert.equal(await page.evaluate(ids=>state.orders.filter(line=>ids.includes(line.order.order_number)).length,sentOrders),11);
  assert.equal(await page.evaluate(ids=>state.orders.filter(line=>line.order_id==='batch-order-7'&&ids.includes(line.order.order_number)).length,sentOrders),4);
  await page.locator('[data-admin-line-select="batch-line-7-3"]').uncheck();
  await expect(page.locator('[data-buyer-label-key]')).toHaveText('Get labels (10 items)');
});

test('injected label selects the full buyer batch in an open modal and completion sends every eligible line',async t=>{
  const db=database(),page=await open(t,db);
  await prepareLabelBatch(page);
  db.orders.push({id:'order-c',order_number:'22-33333-55555',buyer_username:'different-buyer',label_metadata:{}});
  db.lines.push({...db.lines[0],id:'line-a2'}, {...db.lines[1],id:'line-b2'},
    {...db.lines[1],id:'closed',line_status:'fulfilled',fulfilled_quantity:1},
    {...db.lines[1],id:'cancelled',line_status:'cancelled'},
    {...db.lines[1],id:'partial',line_status:'partially_fulfilled',quantity:2,fulfilled_quantity:1},
    {...db.lines[0],id:'unrelated',order_id:'order-c',order:db.orders[2]});
  await page.evaluate(async()=>{
    state.adminSelectedLineIds=new Set(['line-a']);
    state.ebayLaunchOrderNumbers=new Set([lines[0].order.order_number]);
    state.filteredOrders=[lines[0]];
    await openWorkerNoInventoryModal({lineIds:['line-a']});
    document.querySelector('#worker-no-inventory-note').value='Keep this packing note';
    state.noInventoryEvidencePhotos=[{bucket:'test',path:'existing-photo.jpg'}];
  });
  await expect(page.locator('#worker-no-inventory-count')).toHaveText('1 of 2 selected');
  await injectLabel(page,{orderId:db.orders[0].order_number});
  await expect(page.locator('#worker-no-inventory-count')).toHaveText('4 of 4 selected');
  await expect(page.locator('[data-no-inventory-line]:checked')).toHaveCount(4);
  assert.deepEqual(await page.evaluate(()=>[...state.workerNoInventoryLineIds].sort()),['line-a','line-a2','line-b','line-b2']);
  assert.deepEqual(await page.evaluate(()=>[...state.adminSelectedLineIds].sort()),['line-a','line-a2','line-b','line-b2']);
  assert.equal(await page.evaluate(()=>state.noInventoryEvidencePhotos[0].path),'existing-photo.jpg');
  await expect(page.locator('#worker-no-inventory-note')).toHaveValue('Keep this packing note');
  assert.ok(db.reads.some(read=>read.filters.some(([,key])=>key==='ebay_orders.buyer_username')),'associated orders are loaded from the database, even if not in the current view');
  await page.locator('#confirm-worker-no-inventory').click();
  await expect(page.locator('#worker-no-inventory-modal')).toBeHidden();
  const completion=db.calls.find(call=>call.name==='complete_ebay_order_lines_without_inventory_evidence');
  assert.deepEqual([...completion.args._order_line_ids].sort(),['line-a','line-a2','line-b','line-b2']);
  assert.equal(completion.args._notes,'Keep this packing note');
  assert.equal(db.lines.find(line=>line.id==='unrelated').line_status,'pending');
  assert.equal(db.lines.find(line=>line.id==='partial').fulfilled_quantity,1);
});

test('bulk label keeps every declared order and opens a fresh checkout with all associated buyer lines selected',async t=>{
  const db=database();db.orders[1].buyer_username='second-buyer';
  const page=await open(t,db);await prepareLabelBatch(page);
  db.lines.push({...db.lines[0],id:'line-a2'},{...db.lines[1],id:'line-b2'});
  await page.evaluate(()=>{state.adminSelectedLineIds=new Set(['line-a']);});
  const result=await injectLabel(page,{source:'ebay-bulk-label-confirmation',orderIds:db.orders.map(order=>order.order_number)});
  assert.deepEqual(result.orderNumbers,db.orders.map(order=>order.order_number));
  const attachment=db.calls.find(call=>call.name==='append_ebay_shipping_label');
  assert.deepEqual(attachment.args._order_ids.sort(),['order-a','order-b']);
  await expect(page.locator('#worker-no-inventory-count')).toHaveText('4 of 4 selected');
  await expect(page.locator('[data-no-inventory-line]:checked')).toHaveCount(4);
  // Select All is a default, not a forced selection after staff review.
  await page.locator('[data-no-inventory-line="line-b2"]').uncheck();
  await expect(page.locator('#worker-no-inventory-count')).toHaveText('3 of 4 selected');
  await page.locator('#select-all-worker-no-inventory').click();
  await expect(page.locator('[data-no-inventory-line]:checked')).toHaveCount(4);
  await page.locator('[data-no-inventory-line="line-b2"]').uncheck();
  await page.locator('#confirm-worker-no-inventory').click();
  await expect(page.locator('#worker-no-inventory-modal')).toBeHidden();
  assert.deepEqual(db.calls.find(call=>call.name==='complete_ebay_order_lines_without_inventory_evidence').args._order_line_ids.sort(),['line-a','line-a2','line-b']);
  assert.equal(db.lines.find(line=>line.id==='line-b2').line_status,'pending');
});

test('label checkout confirms its checked batch even when the main-page focused line is lost',async t=>{
  const db=database(),page=await open(t,db);await prepareLabelBatch(page);
  db.lines.push({...db.lines[0],id:'line-a2'});
  await injectLabel(page,{orderId:db.orders[0].order_number});
  await expect(page.locator('#worker-no-inventory-count')).toHaveText('3 of 3 selected');
  await page.locator('[data-no-inventory-line="line-b"]').uncheck();
  await page.locator('#worker-no-inventory-note').fill('Reviewed batch');
  // The modal remains the user's reviewed selection when the underlying page loses focus.
  await page.evaluate(()=>{state.selectedLine=null;state.activeBuyerKey='';});
  await expect(page.locator('[data-no-inventory-line]:checked')).toHaveCount(2);
  await page.locator('#confirm-worker-no-inventory').click();
  await expect(page.locator('#worker-no-inventory-error')).toHaveText('');
  await expect(page.locator('#worker-no-inventory-modal')).toBeHidden();
  const completion=db.calls.find(call=>call.name==='complete_ebay_order_lines_without_inventory_evidence');
  assert.deepEqual(completion.args._order_line_ids.sort(),['line-a','line-a2']);
  assert.equal(completion.args._notes,'Reviewed batch');
  assert.equal(db.lines.find(line=>line.id==='line-b').line_status,'pending');
  assert.equal(await page.evaluate(()=>state.selectedLine?.id),'line-b','remaining work is selected from the confirmed buyer');
});

test('confirmation stays scoped to checked modal lines and never substitutes the page selection',async t=>{
  const db=database(),page=await open(t,db);await prepareLabelBatch(page);
  await injectLabel(page,{orderId:db.orders[0].order_number});
  await page.locator('#deselect-all-worker-no-inventory').click();
  // A focused page line must not silently become a selected completion line.
  await page.evaluate(()=>confirmWorkerNoInventoryCompletion());
  await expect(page.locator('#worker-no-inventory-error')).toHaveText('Select at least one pending line to complete.');
  assert.equal(db.calls.filter(call=>call.name==='complete_ebay_order_lines_without_inventory_evidence').length,0);
  await page.locator('[data-no-inventory-line="line-a"]').check();
  await page.evaluate(()=>{
    state.selectedLine={id:'unrelated',order_id:'other-order',order:{buyer_username:'someone-else'}};
    state.activeBuyerKey='someone-else';
  });
  await page.locator('#confirm-worker-no-inventory').click();
  await expect(page.locator('#worker-no-inventory-modal')).toBeHidden();
  assert.deepEqual(db.calls.find(call=>call.name==='complete_ebay_order_lines_without_inventory_evidence').args._order_line_ids,['line-a']);
  assert.equal(await page.evaluate(()=>state.selectedLine?.id),'line-b');
  // A late handler after the modal has closed cannot repeat or redirect the save.
  await page.evaluate(()=>confirmWorkerNoInventoryCompletion());
  assert.equal(db.calls.filter(call=>call.name==='complete_ebay_order_lines_without_inventory_evidence').length,1);
});

test('a missing buyer username never selects unrelated unnamed orders',async t=>{
  const db=database();db.orders.forEach(order=>order.buyer_username='');
  const page=await open(t,db);await prepareLabelBatch(page);
  db.lines.push({...db.lines[0],id:'line-a2'});
  await injectLabel(page,{orderId:db.orders[0].order_number});
  await expect(page.locator('#worker-no-inventory-count')).toHaveText('2 of 2 selected');
  assert.deepEqual(await page.evaluate(()=>[...state.workerNoInventoryLineIds].sort()),['line-a','line-a2']);
});

test('failed full-batch lookup stops the handoff instead of saving a label with a partial default selection',async t=>{
  const db=database(),page=await open(t,db);await prepareLabelBatch(page);
  db.failBuyerBatch=true;
  await assert.rejects(injectLabel(page,{orderId:db.orders[0].order_number}),/Could not load full buyer batch/);
  assert.equal(db.uploads.length,0);
  assert.equal(db.calls.filter(call=>call.name==='append_ebay_shipping_label').length,0);
  await expect(page.locator('#worker-no-inventory-modal')).toBeHidden();
});

test('batch lookup reads every database page rather than stopping at the first page',async t=>{
  const db=database(),page=await open(t,db);await prepareLabelBatch(page);
  const size=await page.evaluate(()=>ORDER_QUEUE_PAGE_SIZE);
  db.lines=Array.from({length:size+1},(_,i)=>({...db.lines[0],id:`page-line-${i}`}));
  const loaded=await page.evaluate(async()=>{
    const matches=await ensureExtensionOrderLinesLoaded({orderNumbers:[lines[0].order.order_number],refresh:true});
    const batch=await loadPendingLabelBuyerBatch(matches);
    return {matches:matches.length,batch:batch.length};
  });
  assert.deepEqual(loaded,{matches:size+1,batch:size+1});
  for (const field of ['ebay_orders.order_number','ebay_orders.buyer_username']) {
    const requests=db.reads.filter(read=>read.filters.some(([,key])=>key===field));
    assert.deepEqual(requests.map(read=>read.start),[0,size]);
  }
});

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
    loadPendingLabelBuyerBatch=async matching=>matching;
    openPendingNoInventorySessionForLabel=async()=>true;
    await openWorkerNoInventoryModal({lineIds:['line-a']});
    window.prints=[];shippingLabelPrint.runLocal=(button,options)=>prints.push(options);
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
  assert.deepEqual(await page.locator('#worker-no-inventory-modal .no-inventory-label button').allTextContents(),
    Array.from({length:4},()=>['Open PDF','Print']).flat());
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
  assert.deepEqual(await mixed.locator('#bundle-review-modal .no-inventory-label button').allTextContents(),['Open PDF','Print']);
  // Pending-upload safety remains enforced even when checkout is opened from another entry point.
  await mixed.evaluate(()=>openOrderShippingLabels(getCompletionPhotoLines('bundle')));await pick(mixed,[['not-saved.pdf',await pdf()]]);
  const count=db.calls.length;
  await mixed.evaluate(()=>fulfillSelectedOrder({skipReview:true}));
  await desktop.evaluate(()=>openOrderShippingLabels(getCompletionPhotoLines('no-inventory')));await pick(desktop,[['not-saved.pdf',await pdf()]]);
  await desktop.evaluate(()=>confirmWorkerNoInventoryCompletion());assert.equal(db.calls.length,count);
  await expect(desktop.locator('#order-shipping-labels-modal')).toBeVisible();
  await mixed.locator('#clear-order-label-selection').click();await mixed.locator('#done-order-labels').click();
  await expect(mixed.locator('#bundle-review-modal')).toBeVisible();
});

test('CSV dates never display placeholder sale or due times, including opposite time zones',async t=>{
  for(const zone of ['America/New_York','America/Los_Angeles','Pacific/Auckland']){
    const db=database();
    Object.assign(db.orders[0],{sale_date:'2026-10-01T12:00:00+00:00',ship_by_date:'2026-10-05T12:00:00+00:00',
      raw_payload:{source:'ebay_orders_report_csv',first_row:{'Sale Date':'Oct-01-26','Ship By Date':'Oct-05-26'}}});
    const page=await open(t,db,false,zone);
    await page.evaluate(()=>{state.expandedBuyerKeys.add(getBuyerKey(lines[0]));renderOrders();});
    await expect(page.locator('.buyer-card-meta')).toContainText('Placed Oct 1 · time not provided');
    await expect(page.locator('.buyer-card-meta')).toContainText('Ship Oct 5');
    await expect(page.locator('[data-line-id="line-a"]')).toContainText('Sale date Oct 1 · time not provided');
    assert.doesNotMatch(await page.locator('.buyer-card-meta').innerText(),/\d:\d{2}/);
    assert.doesNotMatch(await page.locator('[data-line-id="line-a"]').innerText(),/8:00|1:00/);
    const result=await page.evaluate(()=>{
      const row={'Order Number':'23-15215-33555','Item Title':'Ring','Sale Date':'Oct-01-26','Ship By Date':'2026-10-05'};
      const order=buildOrderImportPayload([row])[0].order;
      return {precision:order.raw_payload.date_precision,dates:[order.sale_date,order.ship_by_date],
        parsed:['Oct-01-26','2026-10-01','10/01/2026'].map(parseEbayDate),invalid:parseEbayDate('Feb-31-26')};
    });
    assert.equal(result.precision.sale_date,'day');assert.equal(result.precision.ship_by_date,'day');
    assert.deepEqual(result.dates,['2026-10-01T12:00:00.000Z','2026-10-05T12:00:00.000Z']);
    assert.deepEqual(result.parsed,Array(3).fill('2026-10-01T12:00:00.000Z'));assert.equal(result.invalid,null);
  }
});

test('API-refreshed CSV orders show exact local timestamps and timezone, including genuine 8 AM sales',async t=>{
  const page=await open(t,database());
  const result=await page.evaluate(()=>{
    const order={sale_date:'2026-10-01T20:17:45Z',paid_on_date:'2026-10-01T20:20:00Z',ship_by_date:'2026-10-06T06:59:00Z',
      raw_payload:{source:'ebay_orders_report_csv',first_row:{'Sale Date':'Oct-01-26','Ship By Date':'Oct-05-26'},
        date_precision:{sale_date:'timestamp',paid_on_date:'timestamp',ship_by_date:'timestamp'}}};
    const sale=formatOrderCreatedDate({order}),due=formatOrderDate(order,'ship_by_date');
    order.sale_date='2026-10-01T12:00:00Z';
    return {sale,due,noon:formatOrderDate(order,'sale_date')};
  });
  assert.match(result.sale,/Oct 1.*4:17 PM EDT/);assert.match(result.due,/Oct 6.*2:59 AM EDT/);
  assert.match(result.noon,/Oct 1.*8:00 AM EDT/);assert.doesNotMatch(result.noon,/not provided/);
});

async function prepareDueGroups(page){
  await page.clock.setFixedTime(new Date('2026-10-03T16:00:00Z'));
  await page.evaluate(()=>{
    const rows=[
      ['a-old','client-a','2026-10-02','2026-10-01','Overdue ring'],
      ['a-today','client-a','2026-10-03','2026-10-02','Today chain'],
      ['a-tomorrow','client-a','2026-10-04','2026-10-02','Tomorrow necklace'],
      ['a-later','client-a','2026-10-09','2026-10-03','Later bracelet'],
      ['a-no-date','client-a',null,'2026-10-03','No deadline'],
      ['b-today','client-b','2026-10-03','2026-10-01','Today watch'],
      ['b-later','client-b','2026-10-09','2026-10-02','Later watch'],
      ['c-closed','client-c','2026-10-01','2026-10-01','Closed ring','fulfilled'],
      ['c-later','client-c','2026-10-09','2026-10-02','Pending ring'],
      ['d-tomorrow','client-d','2026-10-04','2026-10-02','Tomorrow watch'],
      ['unknown-old','','2026-10-02','2026-10-01','Unknown customer ring'],
      ['unknown-later','','2026-10-09','2026-10-02','Other unknown customer'],
    ];
    state.orders=rows.map(([id,buyer,due,sold,title,status='pending'])=>normalizeLine({id,order_id:id,item_title:title,
      line_status:status,quantity:1,fulfilled_quantity:status==='fulfilled'?1:0,
      order:{id,order_number:id,buyer_username:buyer,buyer_name:buyer,ship_by_date:due&&due+'T21:00:00Z',sale_date:sold+'T20:00:00Z'}}));
    state.selectedLine=null;state.expandedBuyerKeys.add('client-a');applyOrderFilters();
  });
}
const aLines=['a-old','a-today','a-tomorrow','a-later','a-no-date'];
const visibleIds=page=>page.evaluate(()=>state.filteredOrders.map(line=>line.id));

test('due filters match any pending item and retain every order for the same customer',async t=>{
  const page=await open(t,database());await prepareDueGroups(page);
  const filters=page.getByRole('group',{name:'Shipping due date'});
  const remaining=page.locator('#buyer-remaining-count');
  await expect(remaining).toHaveText('6 customers remaining');
  await filters.getByRole('button',{name:'Overdue',exact:true}).click();
  assert.deepEqual(await visibleIds(page),[...aLines,'unknown-old']);
  await expect(page.locator('#order-count-pill')).toHaveText('6 lines / 2 buyers');
  await expect(remaining).toHaveText('2 customers remaining');
  await expect(filters.getByRole('button',{name:'Overdue',exact:true})).toHaveAttribute('aria-pressed','true');
  assert.equal(await page.locator('.buyer-order-card[data-buyer-key="client-a"] [data-line-id]').count(),5);
  await expect(page.locator('#summary-overdue-orders')).toHaveText('2 groups');
  await expect(page.locator('#summary-overdue-lines')).toContainText('6 item lines');
  await expect(page.locator('#summary-today-orders')).toHaveText('2 groups');
  await expect(page.locator('#summary-tomorrow-orders')).toHaveText('2 groups');
  await page.evaluate(()=>{
    state.selectedLiveLot={id:'fixture-bag'};state.liveLotMatchedLineIds=new Set(['a-later']);applyOrderFilters();
  });
  assert.deepEqual(await visibleIds(page),aLines,'a bag match must not split the customer when a due filter is active');
  await expect(remaining).toHaveText('1 customer remaining');
  await page.evaluate(()=>{state.selectedLiveLot=null;state.liveLotMatchedLineIds.clear();applyOrderFilters();});

  await filters.getByRole('button',{name:'Due today',exact:true}).click();
  assert.deepEqual(await visibleIds(page),[...aLines,'b-today','b-later']);
  await expect(remaining).toHaveText('2 customers remaining');
  await filters.getByRole('button',{name:'Due tomorrow',exact:true}).click();
  assert.deepEqual(await visibleIds(page),[...aLines,'d-tomorrow']);
  await expect(remaining).toHaveText('2 customers remaining');
  await filters.getByRole('button',{name:'All due dates',exact:true}).click();
  assert.equal((await visibleIds(page)).length,12);
  await expect(remaining).toHaveText('6 customers remaining');
  await page.evaluate(()=>{state.orders.find(line=>line.id==='c-later').line_status='fulfilled';applyOrderFilters();});
  await expect(remaining).toHaveText('5 customers remaining'); // Fully completed groups no longer count.
  await page.evaluate(()=>renderPendingOrderSummaryLoading());
  await expect(remaining).toHaveText('Loading...');
  await page.evaluate(()=>applyOrderFilters());
  await expect(remaining).toHaveText('5 customers remaining');
});

test('search and sale dates keep matching buyer bundles intact; finishing the matching item updates the filter',async t=>{
  const page=await open(t,database());await prepareDueGroups(page);
  await page.locator('[data-order-due-filter="overdue"]').click();
  await page.locator('#order-search').fill('later bracelet');
  await page.locator('#order-created-date-filter').fill('2026-10-01');
  assert.deepEqual(await visibleIds(page),aLines);
  await expect(page.locator('#buyer-remaining-count')).toHaveText('1 customer remaining');
  await page.evaluate(()=>{applyOrderFilters();}); // Queue redraws preserve the selected due filter.
  await expect(page.locator('[data-order-due-filter="overdue"]')).toHaveAttribute('aria-pressed','true');
  await page.evaluate(()=>{state.orders.find(line=>line.id==='a-old').line_status='fulfilled';applyOrderFilters();});
  assert.deepEqual(await visibleIds(page),[]);
  await expect(page.locator('#buyer-remaining-count')).toHaveText('0 customers remaining');
  await page.locator('[data-order-due-filter="all"]').click();
  assert.deepEqual(await visibleIds(page),[],'the purchase-date filter remains active when shipping urgency changes');
  await page.locator('#order-created-date-filter').fill('2026-10-02');
  assert.deepEqual(await visibleIds(page),aLines);
  await expect(page.locator('#buyer-remaining-count')).toHaveText('1 customer remaining');
  await page.setViewportSize({width:390,height:900});
  assert.equal(await page.locator('.buyer-due-filters').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await page.locator('.buyer-due-filters').screenshot({path:'test-results/pending-due-filters-phone.png'});
  await page.setViewportSize({width:1440,height:950});
  await page.locator('.buyer-due-filters').screenshot({path:'test-results/pending-due-filters-desktop.png'});
});

test('earliest pending purchase dates retain whole customer groups and move forward after completion',async t=>{
  const page=await open(t,database());await prepareDueGroups(page);
  const date=page.getByLabel('Earliest pending purchase date');
  const remaining=page.locator('#buyer-remaining-count');
  await date.fill('2026-10-01');
  assert.deepEqual(await visibleIds(page),[...aLines,'b-today','b-later','unknown-old']);
  await expect(remaining).toHaveText('3 customers remaining');
  await page.evaluate(()=>applyOrderFilters());
  await expect(date).toHaveValue('2026-10-01');
  await page.setViewportSize({width:390,height:900});
  assert.equal(await page.locator('.buyer-due-filters').evaluate(el=>el.scrollWidth<=el.clientWidth),true);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  await page.locator('.buyer-due-filters').screenshot({path:'test-results/pending-purchase-date-phone.png'});
  await page.setViewportSize({width:1440,height:950});
  await page.locator('.buyer-due-filters').screenshot({path:'test-results/pending-purchase-date-desktop.png'});

  await date.fill('2026-10-02');
  assert.deepEqual(await visibleIds(page),['c-closed','c-later','d-tomorrow','unknown-later'],
    'later purchases must not qualify customers with an earlier pending purchase; older completed rows stay in their group');
  await expect(remaining).toHaveText('3 customers remaining');
  await date.fill('2026-10-03');
  assert.deepEqual(await visibleIds(page),[]);
  await date.fill('2026-10-01');
  await page.locator('#order-search').fill('later bracelet');
  assert.deepEqual(await visibleIds(page),aLines);
  await expect(remaining).toHaveText('1 customer remaining');
  await page.evaluate(()=>{state.orders.find(line=>line.id==='a-old').line_status='fulfilled';applyOrderFilters();});
  assert.deepEqual(await visibleIds(page),[]);
  await expect(remaining).toHaveText('0 customers remaining');
  await date.fill('2026-10-02');
  assert.deepEqual(await visibleIds(page),aLines,'the group moves to its next pending purchase and retains its earlier and later rows');
  await expect(remaining).toHaveText('1 customer remaining');
  await page.locator('#order-search').fill('');
  await expect(remaining).toHaveText('4 customers remaining');
  await page.evaluate(()=>{state.orders.find(line=>line.id==='a-old').line_status='pending';applyOrderFilters();});
  await date.fill('2026-10-01');
  await page.locator('[data-order-due-filter="today"]').click();
  await expect(date).toHaveValue('2026-10-01');
  assert.deepEqual(await visibleIds(page),[...aLines,'b-today','b-later']);
  await page.evaluate(()=>{state.selectedLiveLot={id:'fixture-bag'};state.liveLotMatchedLineIds=new Set(['a-later']);applyOrderFilters();});
  assert.deepEqual(await visibleIds(page),aLines,'matching a later item must preserve the earliest date and the whole customer');
  await page.evaluate(()=>{state.selectedLiveLot=null;state.liveLotMatchedLineIds.clear();applyOrderFilters();});
  await page.locator('[data-order-due-filter="all"]').click();
  await expect(date).toHaveValue('2026-10-01');
  await page.getByRole('button',{name:'Clear purchase date'}).click();
  await expect(date).toHaveValue('');
  assert.equal((await visibleIds(page)).length,12);
  await date.fill('2026-10-01');
  await date.fill('');
  await expect(page.locator('[data-order-due-filter="all"]')).toHaveAttribute('aria-pressed','true');
  assert.equal((await visibleIds(page)).length,12);
  await page.evaluate(()=>{
    state.orders.push(normalizeLine({id:'a-earlier',order_id:'a-earlier',item_title:'Earlier purchase',line_status:'pending',quantity:1,
      order:{id:'a-earlier',order_number:'a-earlier',buyer_username:'client-a',sale_date:'2026-09-30T20:00:00Z'}}));
  });
  await date.fill('2026-09-30');
  assert.deepEqual(await visibleIds(page),[...aLines,'a-earlier'],'an earlier pending purchase brings the entire customer group with it');
  await expect(remaining).toHaveText('1 customer remaining');
  await date.fill('2026-10-01');
  assert.deepEqual(await visibleIds(page),['b-today','b-later','unknown-old']);
});

test('purchase dates match the local sale day and preserve date-only imports across timezones',async t=>{
  for (const timezone of ['America/New_York','Pacific/Kiritimati']) {
    const page=await open(t,database(),false,timezone);
    await page.evaluate(()=>{
      const rows=[
        ['timestamp','2026-10-03T02:00:00Z','timestamp'],
        ['calendar-day','2026-10-02T12:00:00Z','day'],
        ['pure-date','2026-10-02',null],
        ['invalid','invalid',null],
        ['missing',null,null],
      ];
      state.orders=rows.map(([id,sold,precision])=>normalizeLine({id,order_id:id,item_title:id,line_status:'pending',quantity:1,
        order:{id,order_number:id,buyer_username:id,sale_date:sold,ship_by_date:'2026-10-09T20:00:00Z',
          imported_at:'2026-10-02T20:00:00Z',raw_payload:{date_precision:{sale_date:precision}}}}));
      state.selectedLine=null;applyOrderFilters();
    });
    await page.getByLabel('Earliest pending purchase date').fill('2026-10-02');
    assert.deepEqual(await visibleIds(page),timezone==='America/New_York'
      ? ['timestamp','calendar-day','pure-date'] : ['calendar-day','pure-date']);
    await page.getByLabel('Earliest pending purchase date').fill('2026-10-03');
    assert.deepEqual(await visibleIds(page),timezone==='America/New_York' ? [] : ['timestamp']);
  }
});

test('fulfilled view clears pending due filters and label handoff opens its entire batch despite a previous filter',async t=>{
  const page=await open(t,database());await prepareDueGroups(page);
  await page.locator('[data-order-due-filter="today"]').click();
  await page.getByLabel('Earliest pending purchase date').fill('2026-10-01');
  await page.evaluate(()=>{$('order-status-filter').value='fulfilled';applyOrderFilters();});
  await expect(page.locator('[data-order-due-filter="today"]')).toBeDisabled();
  await expect(page.getByLabel('Earliest pending purchase date')).toBeDisabled();
  await expect(page.getByLabel('Earliest pending purchase date')).toHaveValue('');
  await expect(page.locator('#buyer-remaining-count')).toBeHidden();
  await expect(page.locator('[data-order-due-filter="all"]')).toHaveAttribute('aria-pressed','true');
  await page.evaluate(()=>{$('order-status-filter').value='pending';applyOrderFilters();});
  await page.getByLabel('Earliest pending purchase date').fill('2026-10-02');
  await page.evaluate(async()=>{
    await openPendingNoInventorySessionForLabel(['b-today'],{batchLines:state.orders.filter(line=>getBuyerKey(line)==='client-b')});
  });
  assert.deepEqual(await visibleIds(page),['b-today','b-later']);
  await expect(page.locator('#buyer-remaining-count')).toBeVisible();
  await expect(page.locator('#buyer-remaining-count')).toHaveText('1 customer remaining');
  await expect(page.locator('[data-order-due-filter="all"]')).toHaveAttribute('aria-pressed','true');
  await expect(page.getByLabel('Earliest pending purchase date')).toHaveValue('');
  assert.deepEqual(await page.evaluate(()=>[...state.workerNoInventoryLineIds]),['b-today','b-later']);
});
