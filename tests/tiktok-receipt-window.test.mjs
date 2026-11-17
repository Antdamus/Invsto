import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {chromium,expect} from '@playwright/test';
const base=new URL('../tools/ebay-og-order-link-extension/',import.meta.url);
const code=await readFile(new URL('tiktok-receipt-image.js',base),'utf8'),sandbox={};vm.runInNewContext(code,sandbox);const pixels=sandbox.ogTikTokReceiptImage;
const colors=[[245,35,235],[15,230,68],[46,35,245],[240,220,50]];
function fixture(scale=1){const width=800*scale,height=700*scale,data=new Uint8ClampedArray(width*height*4);for(let i=3;i<data.length;i+=4)data[i]=255;const paint=(x,y,w,h,color)=>{for(let dy=y*scale;dy<(y+h)*scale;dy++)for(let dx=x*scale;dx<(x+w)*scale;dx++)data.set([...color,255],(dy*width+dx)*4);};[[88,88],[302,88],[88,502],[302,502]].forEach(([x,y],i)=>paint(x,y,12,12,colors[i]));return {data,width,height,paint};}
test('window crop follows four matching corners at different display scales',()=>{for(const scale of [1,2]){const result=pixels.locate(fixture(scale),colors,{width:200,height:400});assert.deepEqual(JSON.parse(JSON.stringify(result)),{x:100*scale,y:100*scale,width:200*scale,height:400*scale});}});
test('wrong windows, stale markers, missing corners and resized players are rejected',()=>{
 const f=fixture();assert.throws(()=>pixels.locate(f,colors.map(c=>c.map(x=>x+10)),{width:200,height:400}));
 f.paint(302,502,12,12,[0,0,0]);assert.throws(()=>pixels.locate(f,colors,{width:200,height:400}));
 assert.throws(()=>pixels.locate(fixture(),colors,{width:250,height:400}));
 const duplicate=fixture();duplicate.paint(400,50,12,12,colors[0]);assert.throws(()=>pixels.locate(duplicate,colors,{width:200,height:400}));
});
test('black video with bright player controls is considered blank, while a visible item is accepted',()=>{
 const context={getImageData(x,y,w,h){assert.ok(y+h<500,'ignore player controls at bottom');return {data:new Uint8ClampedArray(w*h*4)};}};assert.equal(pixels.blank(context,250,500),true);
 assert.equal(pixels.blank({getImageData:()=>({data:Uint8ClampedArray.from([32,100,150,255])})},250,500),false);
});
test('window capture previews only the item, stops sharing before review, and saves only after confirmation',async t=>{
 const browser=await chromium.launch({headless:true});t.after(()=>browser.close());const page=await browser.newPage({viewport:{width:1000,height:750}});
 const order='900000000000000001',sku='900000000000000002';
 await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<body style="background:#ff0000"><p>SKU ID: ${sku}</p><div id="auction-video-receipt-${order}" style="margin:60px"><video style="width:200px;height:400px"></video></div></body>`}));
 await page.goto('https://seller-us.tiktok.com/order/detail?order_no='+order);
 await page.evaluate(async()=>{
  window.sent=[];window.chrome={runtime:{sendMessage:async m=>{window.sent.push(m);return {ok:true};}}};
  const item=document.createElement('canvas');item.width=200;item.height=400;const c=item.getContext('2d');c.fillStyle='#00aaff';c.fillRect(0,0,200,400);const video=document.querySelector('video');video.muted=true;video.srcObject=item.captureStream(1);await video.play();
  window.sharedCanvas=document.createElement('canvas');sharedCanvas.width=1000;sharedCanvas.height=750;
  navigator.mediaDevices.getDisplayMedia=async()=>{window.sharedStream=sharedCanvas.captureStream(10);return sharedStream;};
 });
 for(const name of ['tiktok-receipt-image.js','tiktok-receipt-window.js','tiktok-receipt-capture.js'])await page.addScriptTag({path:fileURLToPath(new URL(name,base))});
 async function capture(){
  await page.getByRole('button',{name:'Capture from window'}).click();await expect(page.locator('#og-tiktok-window-markers')).toBeVisible();
  const shot=await page.screenshot();await page.evaluate(async data=>{const img=new Image();img.src=data;await img.decode();sharedCanvas.getContext('2d').drawImage(img,0,0);},'data:image/png;base64,'+shot.toString('base64'));
  await expect(page.getByRole('dialog')).toBeVisible();assert.equal(await page.evaluate(()=>sharedStream.getTracks()[0].readyState),'ended');
  assert.equal(await page.evaluate(()=>sent.length),0,'preview must not upload');
 }
 await capture();await page.getByRole('button',{name:'Cancel',exact:true}).click();assert.equal(await page.evaluate(()=>sent.length),0);
 await capture();await page.getByRole('button',{name:'Save photo to OG'}).click();await expect.poll(()=>page.evaluate(()=>sent.length)).toBe(1);
 const result=await page.evaluate(async()=>{const m=sent[0],img=new Image();img.src=m.image;await img.decode();const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return {...m,width:img.width,height:img.height,pixel:[...ctx.getImageData(100,200,1,1).data]};});
 assert.equal(result.orderNumber,order);assert.equal(result.skuId,sku);assert.equal(result.captureMode,'window');assert.equal(result.width,200);assert.equal(result.height,400);assert.ok(result.pixel[0]<10&&result.pixel[2]>240);
});
