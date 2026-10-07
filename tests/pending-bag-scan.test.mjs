import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test, before, after} from 'node:test';
import {chromium, webkit, expect} from '@playwright/test';

const root = new URL('../', import.meta.url);
let server, browser, browserServer, origin;
before(async () => {
  server = createServer(async (req, res) => {
    const name = new URL(req.url,'http://localhost').pathname.slice(1);
    if (!/^[\w./-]+$/.test(name) || name.includes('..')) return res.writeHead(404).end();
    try {
      let content = await readFile(new URL(name,root));
      if (name.endsWith('.html')) content = content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');
      res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');
      res.end(content);
    } catch {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); origin=`http://127.0.0.1:${server.address().port}`;
  const engine = process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium;
  browserServer = await engine.launchServer(); browser = await engine.connect(browserServer.wsEndpoint());
  await mkdir(new URL('../test-results', import.meta.url),{recursive:true});
});
after(async () => {
  const timer=setTimeout(()=>browserServer?.kill().catch(()=>{}),5000);
  try {await browser?.close();await browserServer?.close();} finally {clearTimeout(timer);}
  await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});
});

async function open(t,width=390) {
  const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<800});t.after(()=>context.close());
  await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  const page=await context.newPage();page.setDefaultTimeout(7000);
  const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin+'/pending-orders.html');
  for (const file of ['pending-orders.js','pending-bag-scan.js']) await page.addScriptTag({url:origin+'/'+file});
  await page.evaluate(()=>{
    state.user={id:'worker',email:'worker@example.test'};state.employee={role:'employee',active:true};isAdminUser=()=>false;
    state.stores=[{id:'main',name:'Main Store'}];state.checkoutStoreId='';
    state.orders=Array.from({length:9},(_,i)=>normalizeLine({id:'line-'+i,order_id:'order-'+i,item_number:'listing-'+i,
      item_title:`#00${i<2?5:i} - ${i%2?'Silver bracelet':'Gold chain'}`,quantity:1,fulfilled_quantity:0,line_status:'pending',sold_for:100,total_price:100,
      order:{id:'order-'+i,order_number:`12-34567-8900${i}`,buyer_username:'buyer_'+i,buyer_name:'Customer '+i,status:'pending',sale_date:'2026-10-06T12:00:00Z',ship_by_date:'2026-10-09T12:00:00Z'}}));
    state.orders.forEach(line=>{state.queueVideoReceiptLoadedOrderIds.add(line.order_id);state.sharedOrderNoteHistory.set(line.order_id,{data:{tasks:[],events:[]},promise:Promise.resolve({tasks:[],events:[]})});});
    window.calls=[];window.scanDelay=0;window.photoFailure=false;window.saveFailure=false;
    window.bagPhotos=[];window.bagPhotoFailure=false;window.bagPhotoDelay=0;window.bagAmbiguous=false;
    window.supabase={rpc:async(name,args)=>{
      calls.push({name,args});
      if(name==='find_pending_order_bag'){
        const code=args._scan;
        if(code==='LIVE-SLOW') await new Promise(r=>setTimeout(r,scanDelay));
        if(code==='ERROR')return {error:{message:'Connection interrupted. Try again.'}};
        if(code==='CLOSED')return {data:{matches:[],linked_closed:true}};
        const indices=code==='005'?[0,1]:code==='LIVE-B'?[7]:code==='LIVE-C'?[6]:code==='MISSING'?[]:[8];
        return {data:{matches:indices.map(i=>({line:structuredClone(state.orders[i])}))}};
      }
      if(name==='set_pending_order_item_missing'){
        if(saveFailure)return {error:{message:'Save failed'}};
        return {data:{order_line_id:args._order_line_id,is_missing:args._is_missing,updated_at:new Date().toISOString(),updated_by_email:'worker@example.test'}};
      }
      if(name==='get_pending_bag_photo_review'){
        const photos=structuredClone(bagPhotos);
        if(bagPhotoDelay)await new Promise(r=>setTimeout(r,bagPhotoDelay));
        if(bagPhotoFailure)return {error:{message:'Photos unavailable'}};
        return {data:{bag:photos.length?{id:'bag-1',lot_code:args._scan}:null,photos,ambiguous:bagAmbiguous}};
      }
      if(name==='confirm_pending_bag_photos'){
        if(saveFailure)return {error:{message:'Order changed. Scan again.'}};
        bagPhotos.forEach(photo=>{photo.attached=true;});
        return {data:{item_search:{is_missing:false},task:{id:'photo-task',order_id:'order-8',order_line_ids:['line-8'],metadata:{source:'pending_order_line_note'}},
          event:{id:'photo-event',task_id:'photo-task',order_id:'order-8',notes:'Bag verified.',photo_attachments:bagPhotos.map(photo=>({bucket:'photos',path:photo.photo_path,label:'Live photo',metadata:{source:'live_bag_video_receipt'}}))}}};
      }
      throw Error('Unexpected database operation: '+name);
    }};
    watchQueueCompletionPhotos=watchQueueShippingLabels=scheduleQueueVideoReceiptEvidenceHydration=()=>{};
    loadSelectedOrderTasks=hydrateSelectedOrderDetails=hydrateQueueVideoReceiptEvidenceThumbnails=async()=>{};
    ensureQueueVideoReceiptTasksLoaded=async()=>{if(photoFailure)throw Error('Photos offline');};
    const photo='data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="240" height="200"><rect width="240" height="200" fill="#eee8dc"/><ellipse cx="120" cy="95" rx="60" ry="65" fill="none" stroke="#b59140" stroke-width="9"/><text x="120" y="186" text-anchor="middle" font-size="12">Test item screenshot</text></svg>');
    supabase.storage={from:()=>({createSignedUrl:async()=>({data:{signedUrl:photo}})})};
    getVideoReceiptEvidencePhotosForLine=line=>line.id==='line-0'?[{previewUrl:photo,thumbnailUrl:photo}]:[];
    ensureEvidencePhotoPreviewUrls=async photo=>photo;
    setupListeners();renderCheckoutStoreSelect();applyOrderFilters();
  });
  for(const file of ['pending-orders-mobile.js','barcode-scanner.js'])await page.addScriptTag({url:origin+'/'+file});
  await expect(page.locator('.buyer-order-card')).toHaveCount(9);
  return page;
}
async function scan(page,code) {await page.locator('#pending-bag-scan').fill(code);await page.locator('#pending-bag-scan').press('Enter');}

for (const width of [390, 1280]) test(`${width}px: task link expands its order and notes without opening packing`, async t => {
  const page = await open(t, width);
  const result = await page.evaluate(async () => {
    state.launchOrderTaskId = 'task-8';
    state.checkoutStoreId = 'main';
    state.stagedFulfillments.set('line-1', {lineId: 'line-1', quantity: 1});
    state.orderDueFilter = 'overdue';
    document.getElementById('order-search').value = 'no match';
    document.getElementById('order-created-date-filter').value = '2020-01-01';
    setBuyerGroupExpanded('buyer_8', false, {render: false});
    const task = {id: 'task-8', order_id: 'order-8', order_line_ids: ['line-8'], ebay_orders: {order_number: '12-34567-89008'}};
    supabase.from = table => {
      if (table !== 'ebay_order_tasks') throw Error('Unexpected read: ' + table);
      const query = {select: () => query, eq: () => query, maybeSingle: async () => ({data: task})}; return query;
    };
    const data = {tasks: [{id: 'note-8', order_id: 'order-8', order_line_ids: ['line-8'], metadata: {source: 'pending_order_line_note'}}],
      events: [{id: 'event-8', task_id: 'note-8', order_id: 'order-8', notes: 'Keep the original certificate with this item.', signed_by_email: 'sam@example.test', created_at: '2026-10-07T15:00:00Z', payload: {order_line_id: 'line-8'}}]};
    state.sharedOrderNoteHistory.set('order-8', {data, promise: Promise.resolve(data)});
    return await openRequestedOrderTask();
  });
  assert.equal(result, true);
  const card = page.locator('[data-buyer-key="buyer_8"]');
  await expect(card.locator('[data-line-id="line-8"]')).toBeVisible();
  await expect(card.locator('.buyer-card-note-details')).toBeVisible();
  await expect(card.locator('.buyer-card-note-details')).toContainText('Keep the original certificate');
  await expect(page.locator('#fulfillment-workflow')).toBeHidden();
  await expect(page.locator('#phone-packing-tools-modal')).toBeHidden();
  await expect(page.locator('.modal:not(.hidden), dialog[open]')).toHaveCount(0);
  assert.equal(await page.evaluate(() => state.stagedFulfillments.size), 1);
  assert.deepEqual(await page.evaluate(() => calls), []);
  const box = await card.boundingBox(); assert.ok(box.y >= 0 && box.y < 300);
  if (width === 390) await page.screenshot({path: 'test-results/task-order-link-phone.png'});
});

test('task link loads a missing pending order and never opens a closed order for packing', async t => {
  const page = await open(t);
  const result = await page.evaluate(async () => {
    const wanted = state.orders[8]; state.orders = state.orders.slice(0, 8); state.launchOrderTaskId = 'task-8';
    supabase.from = () => {
      const query = {select: () => query, eq: () => query, maybeSingle: async () => ({data: {id: 'task-8', order_id: 'order-8', order_line_ids: ['line-8'], ebay_orders: {order_number: '12-34567-89008'}}})}; return query;
    };
    const lookups = [];
    ensureExtensionOrderLinesLoaded = async options => {lookups.push(options.orderNumbers); if (lookups.length === 1) state.orders.push(wanted);};
    const opened = await openRequestedOrderTask();
    wanted.line_status = 'fulfilled'; wanted.fulfilled_quantity = 1;
    const closed = await openRequestedOrderTask();
    return {opened, closed, lookups};
  });
  assert.equal(result.opened, true); assert.equal(result.closed, false);
  assert.deepEqual(result.lookups, [['12-34567-89008'], ['12-34567-89008']]);
  await expect(page.locator('#fulfillment-workflow')).toBeHidden();
});

for(const width of [320,390,1280])test(`${width}px: scan opens the exact line, clears filters and preserves packing`,async t=>{
  const page=await open(t,width);
  await page.evaluate(()=>{
    state.stagedFulfillments.set('line-1',{lineId:'line-1',quantity:1});state.activeBuyerKey='buyer_1';state.selectedLine=state.orders[1];
    state.orderDueFilter='overdue';document.getElementById('order-search').value='nobody';document.getElementById('order-created-date-filter').value='2020-01-01';applyOrderFilters();
  });
  await scan(page,'live-a');
  const target=page.locator('[data-line-id="line-8"]');
  await expect(target).toHaveClass(/is-bag-scan-target/);
  assert.equal(await page.evaluate(()=>state.stagedFulfillments.size),1);
  assert.equal(await page.evaluate(()=>state.selectedLine.id),'line-1');
  await expect(page.locator('#fulfillment-workflow')).toBeHidden();
  await expect(page.locator('#phone-packing-tools-modal')).toBeHidden();
  await expect(page.locator('#bag-scan-found')).toBeEnabled();
  const box=await target.boundingBox();assert.ok(box.y<844&&box.y+box.height>70);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  assert.equal(await page.evaluate(()=>calls.filter(c=>!['find_pending_order_bag','get_pending_bag_photo_review'].includes(c.name)).length),0);
  if(width===390)await page.screenshot({path:'test-results/bag-scan-phone-found.png'});
  await page.locator('#bag-scan-found').click();
  await expect(page.locator('#bag-scan-found')).toHaveText('✓ Item found');
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.name==='set_pending_order_item_missing').map(c=>c.args)),[{_order_line_id:'line-8',_is_missing:false}]);
});

test('multiple matches show screenshots and identifying details; selection only navigates',async t=>{
  const page=await open(t);
  await scan(page,'005');
  await expect(page.locator('#bag-scan-choice')).toBeVisible();
  await expect(page.locator('.bag-scan-choice-card')).toHaveCount(2);
  await expect(page.locator('[data-bag-photo="0"] img')).toBeVisible();
  await expect(page.locator('[data-bag-photo="1"]')).toHaveText('No screenshot saved');
  await expect(page.locator('#bag-scan-choices')).toContainText('buyer_0');
  await expect(page.locator('#bag-scan-choices')).toContainText('12-34567-89001');
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await page.screenshot({path:'test-results/bag-scan-phone-choices.png'});
  await page.locator('[data-bag-choice="1"]').click();
  await expect(page.locator('#bag-scan-choice')).toBeHidden();
  await expect(page.locator('[data-line-id="line-1"]')).toHaveClass(/is-bag-scan-target/);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='find_pending_order_bag').length),1);
});

test('fast scans are queued in arrival order, with explicit found or next to advance',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{scanDelay=200;void PendingBagScan.enqueue('LIVE-SLOW');void PendingBagScan.enqueue('LIVE-SLOW');void PendingBagScan.enqueue('LIVE-B');void PendingBagScan.enqueue('LIVE-C');});
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_8');
  await expect(page.locator('#bag-scan-next')).toHaveText('Next bag (2) →');
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.name==='find_pending_order_bag').map(c=>c.args._scan)),['LIVE-SLOW']);
  await page.locator('#bag-scan-next').click();
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_7');
  await page.locator('#bag-scan-found').click();
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_6');
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.name==='find_pending_order_bag').map(c=>c.args._scan)),['LIVE-SLOW','LIVE-B','LIVE-C']);
  await page.locator('#bag-scan-recent').selectOption('0');
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_8');
});

test('errors, closed items, cancel and stale responses cannot leave an old item actionable',async t=>{
  const page=await open(t);
  await scan(page,'LIVE-A');await expect(page.locator('#bag-scan-found')).toBeEnabled();
  for(const code of ['ERROR','CLOSED','MISSING']){
    await scan(page,code);await expect(page.locator('#bag-scan-found')).toBeDisabled();
    await expect(page.locator('#bag-scan-dock-status')).toHaveClass(/is-error/);
  }
  await scan(page,'005');await expect(page.locator('#bag-scan-choice')).toBeVisible();
  await page.locator('#bag-scan-choice-cancel').press('Escape');await expect(page.locator('#bag-scan-choice')).toBeHidden();
  await expect(page.locator('#bag-scan-found')).toBeDisabled();
  await page.evaluate(()=>{scanDelay=250;void PendingBagScan.enqueue('LIVE-SLOW');PendingBagScan.reset();});
  await page.waitForTimeout(350);
  await expect(page.locator('#bag-scan-dock')).toBeHidden();
  await expect(page.locator('.is-bag-scan-target')).toHaveCount(0);
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='set_pending_order_item_missing').length),0);
});

test('photo failure keeps selection usable; failed found save stays retryable and does not advance',async t=>{
  const page=await open(t,1280);
  await page.evaluate(()=>{photoFailure=true;saveFailure=true;});
  await scan(page,'005');
  await expect(page.locator('[data-bag-photo="0"]')).toHaveText('Could not load screenshots');
  await page.locator('[data-bag-choice="0"]').click();
  await page.locator('#bag-scan-found').click();
  await expect(page.locator('#bag-scan-dock-status')).toContainText('Could not mark');
  await expect(page.locator('#bag-scan-found')).toBeEnabled();
  assert.equal(await page.evaluate(()=>state.orders[0].line_status),'pending');
});

test('camera-style input and global bag lookup use the same flow; URLs are parsed without navigating',async t=>{
  const page=await open(t);
  await page.locator('#pending-bag-scan').fill('https://example.test/bag-lookup.html?bag=LIVE-A');
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_8');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='find_pending_order_bag').length),1);
  await page.locator('#phone-orders-tools').click();
  await page.locator('#global-live-lot-scan').fill('LIVE-B');
  await page.locator('#global-live-lot-scan').press('Enter');
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_7');
  await expect(page.locator('#phone-packing-tools-modal')).toBeHidden();
});

test('hardware scans continue from the focused order row without another tap',async t=>{
  const page=await open(t,1280);
  await scan(page,'LIVE-A');
  await expect(page.locator('[data-line-id="line-8"]')).toBeFocused();
  await page.keyboard.type('LIVE-B');await page.keyboard.press('Enter');
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_7');
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='find_pending_order_bag').length),2);
});

for(const width of [320,390,1280])test(`${width}px: bag photos are reviewed inline, attached once, and marked found without closing or packing`,async t=>{
  const page=await open(t,width);
  await page.evaluate(()=>{bagPhotos=[1,2].map(i=>({id:'photo-'+i,photo_path:'live-bags/bag-1/'+i+'.jpg',captured_at:'2026-10-07T16:00:00Z',attached:false}));});
  await scan(page,'LIVE-A');
  await expect(page.locator('[data-bag-review] img')).toHaveCount(2);
  await expect(page.locator('#bag-scan-found')).toBeEnabled();
  await expect(page.locator('#bag-scan-found')).toHaveText('Confirm & attach');
  assert.equal(await page.evaluate(()=>calls.some(c=>c.name==='confirm_pending_bag_photos')),false);
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
  await expect(page.locator('#fulfillment-workflow')).toBeHidden();
  if(width===390)await page.screenshot({path:'test-results/bag-photo-review-phone.png'});
  const beforeRefresh=await page.locator('[data-bag-review]').boundingBox();
  await page.evaluate(async()=>{renderOrders();await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));});
  await expect(page.locator('#bag-scan-found')).toBeEnabled();
  const afterRefresh=await page.locator('[data-bag-review]').boundingBox();
  assert.ok(Math.abs(beforeRefresh.y-afterRefresh.y)<3,`Background refresh preserves the visible scanned order (${beforeRefresh.y} → ${afterRefresh.y})`);
  await page.locator('#bag-scan-found').click();
  await expect(page.locator('#bag-scan-found')).toHaveText('✓ Item found');
  await expect(page.locator('[data-bag-review]')).toContainText('already attached');
  assert.deepEqual(await page.evaluate(()=>calls.filter(c=>c.name==='confirm_pending_bag_photos').map(c=>c.args)),
    [{_scan:'LIVE-A',_lot_id:'bag-1',_order_line_id:'line-8',_photo_ids:['photo-1','photo-2']}]);
  const result=await page.evaluate(()=>({status:state.orders[8].line_status,photos:state.queueVideoReceiptTaskEvents.get('photo-task')[0].photo_attachments.length,found:state.orders[8].item_search.is_missing,notes:state.orders[8].line_note_count}));
  assert.deepEqual(result,{status:'pending',photos:2,found:false,notes:1});
  await scan(page,'LIVE-A');
  await expect(page.locator('#bag-scan-found')).toBeDisabled();
  assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='confirm_pending_bag_photos').length),1);
});

test('bags without photos stay uncluttered; failed or ambiguous photo checks cannot confirm; retries and stale scans stay safe',async t=>{
  const page=await open(t);
  await scan(page,'LIVE-A');await expect(page.locator('#bag-scan-found')).toBeEnabled();
  await expect(page.locator('[data-bag-review]')).toHaveCount(0);
  await page.evaluate(()=>{bagPhotoFailure=true;});
  await scan(page,'LIVE-B');await expect(page.getByRole('button',{name:'Retry photos'})).toBeVisible();
  await expect(page.locator('#bag-scan-found')).toBeDisabled();
  await page.evaluate(()=>{bagPhotoFailure=false;});
  await page.getByRole('button',{name:'Retry photos'}).click();await expect(page.locator('#bag-scan-found')).toBeEnabled();
  await page.evaluate(()=>{bagAmbiguous=true;});
  await scan(page,'LIVE-C');await expect(page.locator('[data-bag-review]')).toContainText('unique LIVE code');
  await expect(page.locator('#bag-scan-found')).toBeDisabled();
  await page.evaluate(()=>{bagAmbiguous=false;bagPhotoDelay=300;bagPhotos=[{id:'old',photo_path:'old.jpg'}];void PendingBagScan.enqueue('LIVE-A');});
  await expect(page.locator('[data-bag-review]')).toContainText('Checking');
  await page.evaluate(()=>{bagPhotoDelay=0;bagPhotos=[];void PendingBagScan.enqueue('LIVE-B');});
  await expect(page.locator('#bag-scan-current')).toContainText('buyer_7');
  await expect(page.locator('#bag-scan-found')).toBeEnabled();await page.waitForTimeout(400);
  await expect(page.locator('[data-bag-review]')).toHaveCount(0);
});

test('failed confirmation preserves photos and can retry; already-found items can still attach missing bag photos',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{state.orders[8].item_search={is_missing:false};saveFailure=true;bagPhotos=[{id:'new',photo_path:'new.jpg',captured_at:'2026-10-07T16:00:00Z',attached:false}];});
  await scan(page,'LIVE-A');await expect(page.locator('#bag-scan-found')).toBeEnabled();
  await page.locator('#bag-scan-found').click();await expect(page.locator('#bag-scan-dock-status')).toContainText('Order changed');
  await expect(page.locator('#bag-scan-found')).toBeEnabled();
  assert.equal(await page.evaluate(()=>state.queueVideoReceiptTasks.length),0);
  await page.evaluate(()=>{saveFailure=false;});await page.locator('#bag-scan-found').click();
  await expect(page.locator('#bag-scan-found')).toHaveText('✓ Item found');
});
