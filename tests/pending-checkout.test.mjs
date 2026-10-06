import assert from 'node:assert/strict';
import {readFile, mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit} from '@playwright/test';

const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
  server=createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1);
    if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
    try {
      let content=await readFile(new URL(name,root));
      if(name.endsWith('.html'))content=content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');
      res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await (process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
});
after(async()=>{await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});

async function open(t,{width=1280}={}) {
  const context=await browser.newContext({viewport:{width,height:950}});t.after(()=>context.close());
  await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
  const p=await context.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await p.goto(origin+'/pending-orders.html');await p.addScriptTag({url:origin+'/pending-orders.js'});
  await p.evaluate(()=>{
    window.calls=[];window.lookupDelay=0;window.sourceDelay=0;window.saveDelay=0;window.lookupError=false;window.sourceError=false;
    window.loseResponse=false;window.refreshError=false;window.receipts=new Map();window.stockQuantity=5;
    window.item={id:'item-a',title:'Fixture watch',barcode:'OG%,001',sale_price:20,photos:[]};
    window.matches=[item];window.exact=true;
    window.rows=[{id:'stock-a',item_id:'item-a',location_id:'box-a',quantity:5,physical_quantity:5,own_reserved_quantity:0,reserved_quantity:0,
      location:{id:'box-a',location_name:'Container One',location_code:'BOX1',location_role:'container',store_id:'store-a'}}];
    window.databaseLines=[{id:'line-a',order_id:'order-a',item_title:'Fixture watch order',line_status:'pending',quantity:1,fulfilled_quantity:0,sold_for:20,
      order:{order_number:'11-222-333',buyer_username:'fixture-buyer'}},
      {id:'line-b',order_id:'order-a',item_title:'Manual item order',line_status:'pending',quantity:1,fulfilled_quantity:0,
      order:{order_number:'11-222-333',buyer_username:'fixture-buyer'}}];
    window.supabase={rpc:async(name,args)=>{
      calls.push({name,args:structuredClone(args)});
      if(name==='lookup_pending_checkout_items'){
        const result=structuredClone(matches),delay=lookupDelay;lookupDelay=0;
        if(delay)await new Promise(r=>setTimeout(r,delay));
        return lookupError?{error:{message:'Lookup unavailable'}}:{data:{exact,items:result}};
      }
      if(name==='get_pending_checkout_stock'){
        const result=structuredClone(rows);if(sourceDelay)await new Promise(r=>setTimeout(r,sourceDelay));
        return sourceError?{error:{message:'Availability unavailable'}}:{data:result};
      }
      if(name==='fulfill_pending_checkout_bundle'){
        if(saveDelay)await new Promise(r=>setTimeout(r,saveDelay));
        if(!receipts.has(args._request_id)){
          args._lines.forEach(e=>{const line=databaseLines.find(l=>l.id===e.order_line_id);line.fulfilled_quantity+=e.quantity;
            line.line_status=line.fulfilled_quantity>=line.quantity?'fulfilled':'partially_fulfilled';
            if(e.mode!=='without_inventory')stockQuantity-=e.quantity;
          });
          receipts.set(args._request_id,{request_id:args._request_id});
        }
        if(loseResponse){loseResponse=false;return {error:{message:'Connection lost after confirmation'}};}
        return {data:receipts.get(args._request_id)};
      }
      throw new Error(`Unexpected RPC ${name}`);
    }};
    state.user={id:'worker',email:'fixture@example.test'};state.employee={role:'employee',active:true};
    state.stores=[{id:'store-a',name:'Main Store'},{id:'store-b',name:'Other Store'}];state.checkoutStoreId='store-a';
    databaseLines.forEach(line=>line.video_receipt_photo_count=1);
    state.orders=structuredClone(databaseLines);
    window.realRenderOrders=renderOrders;
    renderOrders=renderSelectedOrder=renderLiveLotOrderMatches=renderOrderTaskPanel=renderSummaryStrip=()=>{};
    loadSelectedOrderTasks=hydrateSelectedOrderDetails=async()=>{};
    window.realCompleteShipping=completeFulfilledShippingTasksForLines;
    completeFulfilledShippingTasksForLines=async()=>0;
    loadOrders=async()=>{if(refreshError)throw new Error('Refresh failed');state.orders=structuredClone(databaseLines);};
    window.realPostQueueChanged=postEbayPendingQueueChanged;postEbayPendingQueueChanged=()=>{};
    resolvePhotoUrl=async()=>'';
    window.realClearSelection=clearSelection;
    clearSelection=()=>{invalidateInventoryLookup();state.stagedFulfillments.clear();state.selectedLine=null;};
    setupListeners();renderCheckoutStoreSelect();selectOrderLine('line-a');
  });
  return p;
}

async function scan(p,value='OG%,001'){
  await p.locator('#item-scan').fill(value);await p.locator('#item-scan').press('Enter');
}

async function prepareNoInventoryReview(p) {
  await p.evaluate(() => {
    hydrateNoInventoryVideoReceiptEvidenceThumbnails = async () => {};
    loadNoInventoryCaptureStations = async () => {};
    captureAuditLocation = async () => ({status:'not_available'});
    state.orders[1].video_receipt_photo_count = 0;
    const cached = {...state.orders[1], id:'line-c', item_title:'Recently captured item'};
    state.orders.push(cached);
    state.videoReceiptEvidenceByLineId.set(cached.id, {bucket:'order-evidence-photos', path:'video-receipts/c.png'});
    // Group completion evidence is not a receipt for the missing item.
    state.noInventoryEvidencePhotos = [{bucket:'order-evidence-photos', path:'completion.png'}];
  });
}

test('noninventory bulk review selects only items with saved receipt screenshots and respects the requested scope', async t => {
  const p = await open(t);
  await prepareNoInventoryReview(p);
  await p.evaluate(() => openWorkerNoInventoryModal());
  assert.deepEqual(await p.evaluate(() => [...state.workerNoInventoryLineIds]), ['line-a','line-c']);
  assert.equal(await p.locator('[data-no-inventory-line="line-b"]').isChecked(), false);
  await p.locator('[data-no-inventory-line="line-b"]').check();
  assert.equal(await p.locator('[data-no-inventory-line="line-b"]').isChecked(), true, 'individual selection remains intentional');
  await p.locator('#deselect-all-worker-no-inventory').click();
  await p.locator('#select-all-worker-no-inventory').click();
  assert.deepEqual(await p.evaluate(() => [...state.workerNoInventoryLineIds]), ['line-a','line-c']);
  await p.evaluate(() => {closeWorkerNoInventoryModal();return openWorkerNoInventoryModal({lineIds:['line-b','line-c']});});
  assert.deepEqual(await p.evaluate(() => [...state.workerNoInventoryLineIds]), ['line-c']);
});

test('noninventory review with no receipt screenshots starts empty and cannot accidentally submit', async t => {
  const p = await open(t);
  await prepareNoInventoryReview(p);
  await p.evaluate(() => {
    state.orders.forEach(line => line.video_receipt_photo_count = 0);
    state.videoReceiptEvidenceByLineId.clear();
    return openWorkerNoInventoryModal();
  });
  assert.equal(await p.locator('#confirm-worker-no-inventory').isDisabled(), true);
  await p.evaluate(() => confirmWorkerNoInventoryCompletion());
  assert.equal(await p.evaluate(() => calls.some(c => c.name === 'complete_ebay_order_lines_without_inventory_evidence')), false);
});

test('a noninventory timeout keeps the reviewed selection available and explains that it was not closed', async t => {
  const p = await open(t);
  await prepareNoInventoryReview(p);
  await p.evaluate(async () => {
    supabase.rpc = async (name,args) => {
      calls.push({name,args});
      return {error:{code:'57014',message:'canceling statement due to statement timeout'}};
    };
    await openWorkerNoInventoryModal();
    await confirmWorkerNoInventoryCompletion();
  });
  assert.deepEqual(await p.evaluate(() => calls.at(-1).args._order_line_ids), ['line-a','line-c']);
  assert.deepEqual(await p.evaluate(() => [...state.workerNoInventoryLineIds]), ['line-a','line-c']);
  assert.match(await p.locator('#worker-no-inventory-error').innerText(), /selected items were not closed/);
  assert.equal(await p.locator('#confirm-worker-no-inventory').isEnabled(), true);
});

test('scanner plus manual line share one final review and one atomic request',async t=>{
  const p=await open(t);await scan(p);
  await p.waitForFunction(()=>state.selectedLine.id==='line-b');
  assert.equal(await p.locator('#item-confirm-modal').isVisible(),false);
  assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='fulfill_pending_checkout_bundle').length),0);
  await p.locator('#stage-without-inventory').click();await p.locator('#bundle-review-modal').waitFor({state:'visible'});
  assert.match(await p.locator('#bundle-review-subtitle').innerText(),/1 from inventory, 1 without inventory/);
  assert.match(await p.locator('#bundle-review-list').innerText(),/Inventory — remove scanned stock/);
  assert.match(await p.locator('#bundle-review-list').innerText(),/Without inventory — no stock removed/);
  await p.evaluate(()=>saveDelay=150);await p.locator('#confirm-bundle-review').press('Enter');
  await p.evaluate(()=>fulfillSelectedOrder({skipReview:true}));
  await p.waitForFunction(()=>!state.busy);
  const saved=await p.evaluate(()=>calls.filter(c=>c.name==='fulfill_pending_checkout_bundle'));
  assert.equal(saved.length,1);assert.deepEqual(saved[0].args._lines.map(e=>e.mode),['inventory','without_inventory']);
  assert.equal(saved[0].args._lines[1].stock_location_row_id,null);
  assert.equal(await p.evaluate(()=>stockQuantity),4);
});

for (const mode of ['inventory','without_inventory']) {
  test(`${mode} completion stays in OG, refreshes the buyer, and releases the launch filter for the next order`,async t=>{
    const p=await open(t);
    await p.evaluate(()=>{
      window.ebayReturns=[];
      window.addEventListener('message',event=>{
        if(event.data?.type==='OG_EBAY_PENDING_QUEUE_CHANGED'||event.data?.payload?.returnToAwaiting)ebayReturns.push(event.data);
      });
      postEbayPendingQueueChanged=realPostQueueChanged;renderOrders=realRenderOrders;clearSelection=realClearSelection;
      hydrateBuyerGroupNotes=()=>{};scheduleQueueVideoReceiptEvidenceHydration=()=>{};
      hydrateNoInventoryVideoReceiptEvidenceThumbnails=async()=>{};
      loadNoInventoryCaptureStations=async()=>{};captureAuditLocation=async()=>({status:'not_available'});
      databaseLines.push({id:'line-next',order_id:'order-next',item_title:'Next buyer item',line_status:'pending',quantity:1,fulfilled_quantity:0,
        order:{order_number:'22-33333-44444',buyer_username:'next-buyer'}});
      const rpc=supabase.rpc;
      supabase.rpc=async(name,args)=>{
        if(name!=='complete_ebay_order_lines_without_inventory_evidence')return rpc(name,args);
        calls.push({name,args});
        args._order_line_ids.forEach(id=>{const line=databaseLines.find(line=>line.id===id);line.fulfilled_quantity=line.quantity;line.line_status='fulfilled';});
        return {data:[{updated_lines:args._order_line_ids.length}]};
      };
      loadOrders=async()=>{state.orders=structuredClone(databaseLines).filter(isOpenOrderLine);applyOrderFilters();};
      state.ebayLaunchOrderNumbers=new Set(['11-222-333']);state.ebayLaunchBuyerKeys=new Set(['fixture-buyer']);
      state.ebayLabelReturnContext={transferId:'extension-label',orderNumber:'11-222-333'};
      applyOrderFilters();
    });
    const complete=()=>p.evaluate(async mode=>{
      if(mode==='without_inventory'){
        await openWorkerNoInventoryModal({lineIds:[state.selectedLine.id]});await confirmWorkerNoInventoryCompletion();
      }else{
        state.stagedFulfillments.set(state.selectedLine.id,{line:state.selectedLine,mode,qty:1,item,row:rows[0]});
        await fulfillSelectedOrder({skipReview:true});
      }
    },mode);
    await complete();
    assert.equal(await p.evaluate(()=>state.selectedLine?.id),'line-b','remaining line is ready after partial completion');
    assert.equal(await p.evaluate(()=>state.ebayLabelReturnContext),null);
    assert.deepEqual(await p.evaluate(()=>state.filteredOrders.map(line=>line.id)),['line-b']);
    await complete();
    await p.waitForFunction(()=>!state.busy&&state.selectedLine===null);
    assert.deepEqual(await p.evaluate(()=>state.filteredOrders.map(line=>line.id)),['line-next']);
    assert.match(await p.locator('#orders-list').innerText(),/next-buyer/);
    assert.equal(await p.locator('#worker-no-inventory-modal').isVisible(),false);
    assert.deepEqual(await p.evaluate(()=>ebayReturns),[],'completion never asks the installed extension to activate eBay');
    assert.equal(p.url(),origin+'/pending-orders.html');
  });
}

test('duplicate barcodes require an explicit item choice; exact punctuation is preserved',async t=>{
  const p=await open(t);await p.evaluate(()=>matches.push({...item,id:'item-b',title:'Other watch'}));await scan(p);
  await p.waitForFunction(()=>document.querySelectorAll('#item-results button').length===2);
  assert.equal(await p.evaluate(()=>state.selectedItem),null);
  assert.equal(await p.evaluate(()=>calls[0].args._term),'OG%,001');
  await p.getByRole('button',{name:/Other watch/}).click();await p.locator('#item-confirm-modal').waitFor({state:'visible'});
  assert.match(await p.locator('#item-confirm-name').innerText(),/Other watch/);
});

test('bulk bag scan only offers stock from that bag, with clear source labels',async t=>{
  const p=await open(t);await p.evaluate(()=>{
    matches=[{...item,checkout_batch_ids:['batch-a']}];rows.push({...rows[0],id:'bag-stock',batch_id:'batch-a',bag_barcode:'BAG1'});
  });await scan(p,'BAG1');await p.waitForFunction(()=>state.selectedStockRow?.id==='bag-stock');
  assert.equal(await p.locator('#location-results button').count(),1);
  assert.match(await p.locator('#location-results').innerText(),/Bag BAG1/);
});

test('overlapping scans ignore old responses and changing order cancels source loading',async t=>{
  const p=await open(t);await p.evaluate(()=>lookupDelay=220);await scan(p,'OLD');
  await p.waitForFunction(()=>calls.some(c=>c.args?._term==='OLD'));
  await p.evaluate(()=>matches=[{...item,id:'item-b',title:'New item'}]);await scan(p,'NEW');
  await p.waitForFunction(()=>state.selectedItem?.id==='item-b');await p.waitForTimeout(260);
  assert.equal(await p.evaluate(()=>state.selectedItem.id),'item-b');
  await p.evaluate(()=>{clearQuantityAutoStage();sourceDelay=180;});await scan(p,'NEXT');
  await p.waitForFunction(()=>calls.filter(c=>c.name==='get_pending_checkout_stock').length===2);
  await p.evaluate(()=>selectOrderLine('line-b'));await p.waitForTimeout(220);
  assert.equal(await p.evaluate(()=>state.selectedStockRow),null);
  assert.equal(await p.evaluate(()=>state.stagedFulfillments.size),0);
});

test('failed availability clears old source and allows explicit manual staging',async t=>{
  const p=await open(t);await scan(p);await p.waitForFunction(()=>!!state.selectedStockRow);
  await p.evaluate(()=>sourceError=true);await scan(p,'AGAIN');
  await p.waitForFunction(()=>document.querySelector('#fulfill-status').textContent.includes('Availability unavailable'));
  assert.equal(await p.evaluate(()=>state.selectedStockRow),null);
  await p.locator('#stage-without-inventory').click();
  assert.equal(await p.evaluate(()=>state.stagedFulfillments.get('line-a').mode),'without_inventory');
});

test('quantity validation and staged shared stock prevent overpacking',async t=>{
  const p=await open(t);await p.evaluate(()=>{rows[0].quantity=2;databaseLines[0].quantity=3;state.orders[0].quantity=3;});
  await scan(p);await p.waitForFunction(()=>!!state.selectedStockRow);await p.evaluate(()=>clearQuantityAutoStage());
  await p.locator('#fulfill-quantity').fill('1.5');await p.locator('#stage-current-line').click();
  assert.match(await p.locator('#fulfill-status').innerText(),/positive whole quantity/);
  assert.equal(await p.evaluate(()=>state.stagedFulfillments.size),0);
  await p.locator('#fulfill-quantity').fill('2');await p.locator('#stage-current-line').click();await scan(p);
  await p.waitForFunction(()=>document.querySelector('#fulfill-status').textContent.includes('No available stock'));
  assert.equal(await p.evaluate(()=>state.stockRows.length),0);
});

test('own reserved stock is not subtracted again for another staged line',async t=>{
  const p=await open(t);await p.evaluate(()=>{
    state.stagedFulfillments.set('line-b',{line:state.orders[1],mode:'inventory',qty:2,row:{id:'stock-a',own_reserved_quantity:2}});
    rows[0].quantity=1;rows[0].own_reserved_quantity=1;
  });await scan(p);await p.waitForFunction(()=>!!state.selectedStockRow);
  assert.equal(await p.evaluate(()=>state.selectedStockRow.quantity),1);
});

test('lost-response retry keeps the same request and cannot remove stock again',async t=>{
  const p=await open(t);await scan(p);await p.waitForFunction(()=>state.stagedFulfillments.size===1);
  await p.evaluate(()=>loseResponse=true);await p.locator('#fulfill-order').click();await p.locator('#confirm-bundle-review').click();
  await p.waitForFunction(()=>!state.busy && document.querySelector('#fulfill-status').textContent.includes('Retry the same bundle'));
  assert.equal(await p.evaluate(()=>state.stagedFulfillments.size),1);
  await p.locator('#fulfill-order').click();await p.locator('#confirm-bundle-review').click();await p.waitForFunction(()=>!state.busy);
  const ids=await p.evaluate(()=>calls.filter(c=>c.name==='fulfill_pending_checkout_bundle').map(c=>c.args._request_id));
  assert.equal(ids.length,2);assert.equal(ids[0],ids[1]);assert.equal(await p.evaluate(()=>stockQuantity),4);
  assert.equal(await p.evaluate(()=>state.checkoutRequests.size),0,'acknowledged receipts must not block a deliberately reopened order');
});

test('refresh failure after save leaves no staged items to accidentally resubmit',async t=>{
  const p=await open(t);await p.locator('#stage-without-inventory').click();
  await p.evaluate(()=>refreshError=true);await p.locator('#fulfill-order').click();await p.locator('#confirm-bundle-review').click();
  await p.waitForFunction(()=>!state.busy);
  assert.equal(await p.evaluate(()=>state.stagedFulfillments.size),0);
  assert.match(await p.locator('#fulfill-status').innerText(),/Checkout was saved/);
  assert.equal(await p.evaluate(()=>stockQuantity),5);
});

test('store changes invalidate stock and mixed controls fit phone and desktop',async t=>{
  const p=await open(t,{width:390});await scan(p);await p.waitForFunction(()=>!!state.selectedStockRow);
  await p.evaluate(()=>{document.querySelector('#checkout-store-select').value='store-b';handleCheckoutStoreChange();});
  assert.equal(await p.evaluate(()=>state.selectedStockRow),null);
  await p.evaluate(()=>{state.checkoutStoreId='store-a';updateCheckoutStoreGate();});
  await scan(p);await p.waitForFunction(()=>state.stagedFulfillments.size===1);await p.locator('#stage-without-inventory').click();
  await p.locator('#bundle-review-modal').waitFor({state:'visible'});
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  for(const width of [390,1280]){
    await p.setViewportSize({width,height:950});
    assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.screenshot({path:new URL(`../test-results/mixed-checkout-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
  }
});

test('shipment tasks wait for every line and quantity to finish',async t=>{
  const p=await open(t);const counts=await p.evaluate(async()=>{
    let finished=0;
    const tasks=[{id:'task-a',order_id:'order-a',order_line_ids:[]}];
    let lines=[{id:'line-a',order_id:'order-a',line_status:'fulfilled'},{id:'line-b',order_id:'order-a',line_status:'partially_fulfilled'}];
    supabase.from=table=>{const q={select(){return q},in(){return q},overlaps(){return q},then(fn){return Promise.resolve({data:table==='ebay_order_tasks'?tasks:lines}).then(fn)}};return q;};
    supabase.rpc=async()=>{finished++;return {data:{}};};
    await realCompleteShipping({lineIds:['line-a'],orderIds:['order-a']});const before=finished;
    lines[1].line_status='fulfilled';await realCompleteShipping({lineIds:['line-b'],orderIds:['order-a']});
    return [before,finished];
  });assert.deepEqual(counts,[0,1]);
});

test('manual staging cancels delayed barcode lookup and changing source cancels auto staging',async t=>{
  const p=await open(t);
  await p.locator('#stage-without-inventory').click();
  await p.locator('#item-scan').fill('OG%,001');
  await p.locator('#stage-without-inventory').click();
  await p.waitForTimeout(1700);
  assert.equal(await p.evaluate(()=>calls.length),0);
  assert.deepEqual(await p.evaluate(()=>[...state.stagedFulfillments.values()].map(e=>e.mode)),['without_inventory','without_inventory']);
  await p.locator('#cancel-bundle-review').click();
  await p.evaluate(()=>{state.stagedFulfillments.clear();selectOrderLine('line-a');});
  await scan(p);await p.waitForFunction(()=>!!state.selectedStockRow);
  await p.locator('#location-scan').fill('NOT-THIS-LOCATION');await p.waitForTimeout(1150);
  assert.equal(await p.evaluate(()=>state.selectedStockRow),null);
  assert.equal(await p.evaluate(()=>state.stagedFulfillments.size),0);
});

test('Mixed Checkout opens item scanning with no bag and clears any previously loaded bag',async t=>{
  const p=await open(t,{width:390});await p.evaluate(()=>{
    state.selectedLiveLot={id:'old-bag',lot_code:'LIVE-OLD',auction_number:'019'};
    state.selectedLiveLotItems=[{id:'old-item',item_id:'item-a',quantity:1,status:'reserved'}];
    state.liveLotMatchedLineIds=new Set(['line-a']);
    document.getElementById('optional-live-bag').open=true;
    state.busy=true;openBuyerGroupInventoryCompletion({lines:state.orders});
  });
  assert.equal(await p.evaluate(()=>state.selectedLiveLot.id),'old-bag');
  await p.evaluate(()=>{
    state.busy=false;openBuyerGroupInventoryCompletion({lines:state.orders});
  });
  assert.notEqual(await p.evaluate(()=>document.activeElement?.id),'item-scan', 'opening phone checkout does not summon the keyboard');
  assert.equal(await p.evaluate(()=>state.selectedLiveLot),null);
  assert.equal(await p.evaluate(()=>document.getElementById('optional-live-bag').open),false);
  assert.match(await p.locator('#checkout-item-scan').innerText(),/No bag label required/);
  await scan(p);await p.waitForFunction(()=>state.stagedFulfillments.size===1);
  assert.equal(await p.evaluate(()=>state.stagedFulfillments.get('line-a').row.id),'stock-a');
  await p.locator('#stage-without-inventory').click();await p.locator('#bundle-review-modal').waitFor({state:'visible'});
  await p.locator('#confirm-bundle-review').click();await p.waitForFunction(()=>!state.busy);
  assert.equal(await p.evaluate(()=>stockQuantity),4);
  assert.equal(await p.evaluate(()=>databaseLines.every(l=>l.line_status==='fulfilled')),true);
  assert.equal(await p.evaluate(()=>calls.some(c=>/live_lot|bag/.test(c.name))),false);
});

test('an unsuccessful item scan cannot fall back to packing a previously loaded bag',async t=>{
  const p=await open(t);await p.evaluate(()=>{
    state.selectedLiveLot={id:'old-bag',lot_code:'LIVE-OLD',auction_number:'019'};
    state.selectedLiveLotItems=[{id:'old-item',item_id:'item-a',quantity:1,status:'reserved'}];matches=[];
  });await scan(p,'MISSING');
  await p.waitForFunction(()=>document.getElementById('fulfill-status').textContent.includes('No item found'));
  await p.locator('#fulfill-order').click();
  assert.match(await p.locator('#fulfill-status').innerText(),/Stage at least one/);
  assert.equal(await p.locator('#bundle-review-modal').isVisible(),false);
  assert.equal(await p.evaluate(()=>calls.some(c=>c.name.startsWith('fulfill_'))),false);
  assert.equal(await p.evaluate(()=>state.selectedLiveLot),null);
});

test('optional bag controls return to item checkout without losing the order or staged lines',async t=>{
  const p=await open(t,{width:390});await scan(p);await p.waitForFunction(()=>state.stagedFulfillments.size===1);
  await p.locator('#optional-live-bag > summary').click();assert.equal(await p.locator('#live-lot-scan').isVisible(),true);
  await p.evaluate(()=>{state.selectedLiveLot={id:'old-bag'};});await p.locator('#use-item-checkout').click();
  await p.waitForFunction(()=>document.activeElement?.id==='item-scan');
  assert.equal(await p.evaluate(()=>state.selectedLine.id),'line-b');assert.equal(await p.evaluate(()=>state.stagedFulfillments.size),1);
  assert.equal(await p.evaluate(()=>state.selectedLiveLot),null);assert.equal(await p.locator('#live-lot-scan').isVisible(),false);
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await p.screenshot({path:'test-results/optional-bag-checkout-phone.png'});
});
