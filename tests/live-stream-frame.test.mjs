import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chromium,expect} from '@playwright/test';
import {fileURLToPath} from 'node:url';

test('the installed extension captures only native video pixels from eBay’s nested media frame',async t=>{
 const extension=fileURLToPath(new URL('../tools/ebay-live-capture',import.meta.url));
 const context=await chromium.launchPersistentContext('',{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});t.after(()=>context.close());
 const top='https://www.ebay.com/ebaylive/host/events/EVENT123?tab=dashboard';
 const player='https://ir.ebaystatic.com/cr/ebaylivepubweb/liveassets/shoplive/20260820/player.html';
 await context.route('**/*',async route=>{
  const url=route.request().url();
  if(url===top)return route.fulfill({contentType:'text/html',body:`<!doctype html><body><iframe src="${player}" width="640" height="500"></iframe></body>`});
  if(url===player)return route.fulfill({contentType:'text/html',body:`<!doctype html><body><video muted autoplay width="640" height="360"></video><div style="position:absolute;inset:0;background:blue">CHAT AND PLAYER CONTROLS</div><script>const canvas=document.createElement('canvas');canvas.width=640;canvas.height=360;const ctx=canvas.getContext('2d');ctx.fillStyle='#ff0000';ctx.fillRect(0,0,640,360);const video=document.querySelector('video');video.srcObject=canvas.captureStream(10);video.play();setInterval(()=>ctx.fillRect(0,0,640,360),100);</script></body>`});
  return route.abort();
 });
 const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const page=await context.newPage();await page.goto(top);
 await page.bringToFront();
 const tabId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({active:true,currentWindow:true});return tabs[0].id;});
 await expect.poll(()=>worker.evaluate(async id=>(await chrome.storage.local.get('capture')).capture?.streamFrames?.[id]?.eventId,tabId),{timeout:15000}).toBe('EVENT123');
 const result=await worker.evaluate(async id=>{const frame=(await chrome.storage.local.get('capture')).capture.streamFrames[id];return chrome.tabs.sendMessage(id,{type:'INVSTO_CAPTURE_STREAM_PHOTO'},{frameId:frame.frameId,documentId:frame.documentId});},tabId);
 assert.equal(result.ok,true);assert.equal(result.image.width,640);assert.equal(result.image.height,360);
 const pixel=await page.evaluate(async image=>{const img=new Image();img.src=image.dataUrl;await img.decode();const c=document.createElement('canvas');c.width=640;c.height=360;c.getContext('2d').drawImage(img,0,0);return [...c.getContext('2d').getImageData(320,180,1,1).data];},result.image);
 assert.ok(pixel[0]>240&&pixel[1]<15&&pixel[2]<15,'the output is the red video, not the blue chat overlay');
 await page.frames().find(f=>f.url()===player).evaluate(()=>document.querySelector('video').pause());
 const paused=await worker.evaluate(async id=>{const frame=(await chrome.storage.local.get('capture')).capture.streamFrames[id];return chrome.tabs.sendMessage(id,{type:'INVSTO_CAPTURE_STREAM_PHOTO'},{frameId:frame.frameId});},tabId);
 assert.equal(paused.ok,false);assert.match(paused.error,/not playing/);
});
