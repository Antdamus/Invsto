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
  const p=await context.newPage();p.setDefaultTimeout(8000);const errors=[];p.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
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
  await p.addScriptTag({url:origin+'/pending-inventory.js'});
  await p.evaluate(()=>{PendingInventory.init();window.attachments=new Map();window.failAttach=false;const oldRpc=supabase.rpc;supabase.rpc=async(name,args)=>{
    if(name==='get_pending_inventory_attachments')return {data:[...attachments.values()].filter(a=>args._order_line_ids.includes(a.order_line_id))};
    if(name==='save_pending_inventory_attachment'){calls.push({name,args});if(failAttach)return {error:{message:'Stock changed. Scan again.'}};const a={order_line_id:args._order_line_id,item_id:args._item_id,stock_location_row_id:args._stock_location_row_id,checkout_store_id:args._checkout_store_id,quantity:args._quantity,remaining_quantity:args._quantity,status:args._quantity?'reserved':'released',revision:(attachments.get(args._order_line_id)?.revision||0)+1,item,location:{location_name:'Tray 4'},store_name:'Main Store'};attachments.set(a.order_line_id,a);return {data:[a]};}
    return oldRpc(name,args);
  }; document.getElementById('orders-list').innerHTML='<div data-line-inventory="line-a"></div><div data-line-inventory="line-b"></div>';PendingInventory.paint();});
  await p.evaluate(()=>{document.getElementById('fulfillment-workflow').classList.add('hidden');document.body.classList.remove('pending-order-detail-open','pending-mobile-sheet-open');});
  return p;
}

async function scan(p,value='OG%,001'){
  await p.locator('#item-scan').fill(value);await p.locator('#item-scan').press('Enter');
}

for(const width of [320,390,1366]) test(`attach inventory at ${width}px saves only after confirmation and survives reopening`,async t=>{
 const p=await open(t,{width});
 await p.evaluate(()=>{state.orders[0].quantity=3;});
 await p.locator('[data-attach-inventory="line-a"]').click();
 await p.locator('#attach-inventory-scan').fill('OG%,001');await p.locator('#attach-inventory-scan').press('Enter');
 await p.locator('#attach-inventory-quantity-wrap').waitFor({state:'visible'});
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='save_pending_inventory_attachment')),false);
 await p.locator('#attach-inventory-quantity').fill('2');
 const layout=await p.evaluate(()=>{const modal=document.querySelector('.attach-inventory-card').getBoundingClientRect();return {left:modal.left,right:modal.right,width:innerWidth,overflow:document.documentElement.scrollWidth>innerWidth};});
 assert.ok(layout.left>=0&&layout.right<=layout.width,JSON.stringify(layout));assert.equal(layout.overflow,false);
 if(width===390||width===1366) await p.screenshot({path:`test-results/inventory-attach-${width}.png`});
 await p.locator('#attach-inventory-save').click();await p.locator('#attach-inventory-modal').waitFor({state:'hidden'});
 assert.match(await p.locator('[data-line-inventory="line-a"]').innerText(),/Qty 2/);
 const writes=await p.evaluate(()=>calls.filter(c=>c.name==='save_pending_inventory_attachment'));
 assert.equal(writes.length,1);assert.equal(writes[0].args._order_line_id,'line-a');assert.equal(writes[0].args._quantity,2);
 assert.equal(await p.evaluate(()=>stockQuantity),5,'attachment does not call checkout');
 await p.locator('[data-attach-inventory="line-a"]').click();
  assert.match(await p.locator('#attach-inventory-status').innerText(),/2 reserved/);
 assert.equal(await p.locator('#attach-inventory-quantity').inputValue(),'2','saved quantity can be edited without rescanning');
 await p.locator('#attach-inventory-remove').click();await p.locator('#attach-inventory-modal').waitFor({state:'hidden'});
 assert.match(await p.locator('[data-line-inventory="line-a"]').innerText(),/Attach inventory/);
});

test('duplicate inventory matches and multiple sources require an explicit choice',async t=>{
 const p=await open(t);await p.evaluate(()=>{matches.push({...item,id:'item-b',title:'Other watch'});rows.push({...rows[0],id:'stock-b',location:{...rows[0].location,location_name:'Second tray'}});});
 await p.locator('[data-attach-inventory="line-a"]').click();await p.locator('#attach-inventory-scan').fill('OG%,001');await p.locator('#attach-inventory-scan').press('Enter');
 await p.locator('#attach-inventory-results button').first().waitFor();
 assert.equal(await p.locator('#attach-inventory-save').isDisabled(),true);
 await p.locator('#attach-inventory-results button').first().click();await p.locator('#attach-inventory-sources button').first().waitFor();
 assert.equal(await p.locator('#attach-inventory-save').isDisabled(),true);
 await p.locator('#attach-inventory-sources button').nth(1).click();await p.locator('#attach-inventory-save').click();
 await p.locator('#attach-inventory-modal').waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>calls.find(c=>c.name==='save_pending_inventory_attachment').args._stock_location_row_id),'stock-b');
});

test('invalid quantity and failed saves stay open; closing does not change the draft bundle',async t=>{
 const p=await open(t);await p.evaluate(()=>state.stagedFulfillments.set('line-b',{line:state.orders[1],qty:1,mode:'without_inventory',row:{}}));
 await p.locator('[data-attach-inventory="line-a"]').click();await p.locator('#attach-inventory-scan').fill('OG%,001');await p.locator('#attach-inventory-scan').press('Enter');
 await p.locator('#attach-inventory-quantity-wrap').waitFor({state:'visible'});
 await p.locator('#attach-inventory-quantity').fill('9');await p.locator('#attach-inventory-save').click();
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='save_pending_inventory_attachment')),false);
 await p.locator('#attach-inventory-quantity').fill('1');await p.evaluate(()=>failAttach=true);await p.locator('#attach-inventory-save').click();
 assert.match(await p.locator('#attach-inventory-status').innerText(),/Stock changed/);
 assert.equal(await p.locator('#attach-inventory-modal').isVisible(),true);
 await p.locator('#attach-inventory-close').click();assert.equal(await p.evaluate(()=>state.stagedFulfillments.has('line-b')),true);
});

test('late scanner responses cannot attach inventory to a different item line',async t=>{
 const p=await open(t);await p.evaluate(()=>lookupDelay=180);
 await p.locator('[data-attach-inventory="line-a"]').click();await p.locator('#attach-inventory-scan').fill('OG%,001');await p.locator('#attach-inventory-scan').press('Enter');
 await p.locator('#attach-inventory-close').click();await p.locator('[data-attach-inventory="line-b"]').click();
 await p.waitForTimeout(250);assert.equal(await p.locator('#attach-inventory-save').isDisabled(),true);
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='save_pending_inventory_attachment')),false);
});
