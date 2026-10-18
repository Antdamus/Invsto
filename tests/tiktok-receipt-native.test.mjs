import {test} from 'node:test';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {chromium,expect} from '@playwright/test';

test('real extension returns a video-only capture to the existing OG tab without opening or reloading tabs',async t=>{
 const extensionPath=fileURLToPath(new URL('../tools/ebay-og-order-link-extension',import.meta.url));
 const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,viewport:{width:1200,height:800},args:[`--disable-extensions-except=${extensionPath}`,`--load-extension=${extensionPath}`]});
 t.after(()=>context.close());const order='577620684385522369',sku='1732759903849189622';
 await context.route('**/*',async route=>{
  const u=new URL(route.request().url());
  if(u.origin==='https://seller-us.tiktok.com')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><body style="background:#ff0000"><article>SKU ID: ${sku}<p>Video receipt</p></article><div id="auction-video-receipt-${order}"><video style="width:200px;height:400px"></video></div></body></html>`});
  if(u.origin==='https://og.example')return route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><p id="status">Waiting</p><img id="photo"><script>
  document.documentElement.dataset.tkReceiptReceiver='2';window.keepDraft='unsaved fixture';
  window.addEventListener('message',event=>{if(event.source!==window||event.origin!==location.origin)return;if(event.data?.type==='OG_TIKTOK_RECEIPT_AVAILABLE')window.postMessage({type:'OG_TIKTOK_RECEIPT_READY',transferId:event.data.transferId},location.origin);if(event.data?.type==='OG_TIKTOK_RECEIPT_BRIDGE_READY')window.postMessage({type:'OG_TIKTOK_RECEIPT_READY'},location.origin);if(event.data?.type==='OG_TIKTOK_RECEIPT_DATA'){window.received=event.data.payload;document.querySelector('#photo').src=event.data.payload.image;document.querySelector('#status').textContent=event.data.payload.error||'Received';window.postMessage({type:'OG_TIKTOK_RECEIPT_DONE',transferId:event.data.payload.transferId},location.origin);}});window.postMessage({type:'OG_TIKTOK_RECEIPT_READY'},location.origin);
  </script></body></html>`});
  return route.abort();
 });
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');await worker.evaluate(()=>chrome.storage.sync.set({ogPendingOrdersUrl:'https://og.example/pending-orders.html'}));
 const receiver=await context.newPage();await receiver.goto('https://og.example/pending-tiktok-orders.html');await receiver.evaluate(()=>window.keepDraft='draft survives capture');
 const page=await context.newPage();await page.goto('https://seller-us.tiktok.com/order/detail?order_no='+order);
 await page.evaluate(async()=>{const c=document.createElement('canvas');c.width=200;c.height=400;const ctx=c.getContext('2d');ctx.fillStyle='#0000ff';ctx.fillRect(0,0,200,400);const v=document.querySelector('video');v.muted=true;v.srcObject=c.captureStream(1);await v.play();});
 const button=page.getByRole('button',{name:'Capture item photo → OG'});await expect(button).toBeEnabled();await page.bringToFront();
 const tabCount=context.pages().length;await button.click();await expect(receiver.locator('#status')).toHaveText('Received');assert.equal(context.pages().length,tabCount);assert.equal(await receiver.evaluate(()=>window.keepDraft),'draft survives capture');
 const result=await receiver.evaluate(async()=>{const img=document.querySelector('#photo');await img.decode();const c=document.createElement('canvas');c.width=img.naturalWidth;c.height=img.naturalHeight;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return {order:window.received.orderNumber,sku:window.received.skuId,width:c.width,height:c.height,pixel:[...ctx.getImageData(c.width/2,c.height/2,1,1).data],id:window.received.transferId};});
 assert.equal(result.order,order);assert.equal(result.sku,sku);assert.equal(result.width,200);assert.equal(result.height,400);assert.ok(result.pixel[2]>240&&result.pixel[0]<15,'only the blue video frame is captured, not the red page');
 await expect.poll(()=>worker.evaluate(async id=>(await chrome.storage.local.get('ogTikTokReceipt:'+id))['ogTikTokReceipt:'+id]?.completed,result.id)).toBe(true);
 const stored=await worker.evaluate(async id=>(await chrome.storage.local.get('ogTikTokReceipt:'+id))['ogTikTokReceipt:'+id],result.id);assert.equal(stored.image,undefined);
 await expect.poll(()=>worker.evaluate(async()=>{const [tab]=await chrome.tabs.query({active:true,lastFocusedWindow:true});return tab?.url;})).toBe('https://og.example/pending-tiktok-orders.html');
});
