import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
let server,browser,origin;const root=new URL('../',import.meta.url);
const actor='00000000-0000-4000-8000-000000000001',transfer='00000000-0000-4000-8000-000000000002';
before(async()=>{
 server=createServer(async(req,res)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');return res.end('<!doctype html><body><p id="tk-status"></p><main id="photos"></main></body>');}res.writeHead(404).end();});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch();await mkdir(new URL('../outputs/tiktok-pipeline/',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function fixture(){
 const page=await browser.newPage({viewport:{width:1200,height:800}});await page.goto(origin);
 await page.addStyleTag({content:await readFile(new URL('../tiktok-orders.css',import.meta.url),'utf8')});
 await page.addStyleTag({content:'body{margin:24px;background:#121514;--text:#eee;--muted:#bcbcbc;--gold:#ebc78c;--line-strong:#526558}#photos{display:flex;gap:20px}.hidden{display:none}'});
 await page.evaluate(({actor,transfer})=>{
  document.body.className='tiktok-workspace';window.actor=actor;window.transfer=transfer;
  const canvas=document.createElement('canvas');canvas.width=1600;canvas.height=900;const ctx=canvas.getContext('2d');
  let seed=42;for(let y=0;y<900;y+=5)for(let x=0;x<1600;x+=5){seed=(seed*1664525+1013904223)>>>0;ctx.fillStyle=`hsl(${seed%360} 45% 40%)`;ctx.fillRect(x,y,5,5);}
  ctx.fillStyle='#edce82';ctx.font='bold 90px sans-serif';ctx.fillText('TikTok receipt fixture',90,430);window.photoData=canvas.toDataURL('image/jpeg',0.9);
  window.calls={sign:[],uploads:[],rpc:[],ack:0};window.files=new Map();window.photos=[];
  window.db={auth:{getSession:async()=>({data:{session:{user:{id:actor}}}})},storage:{from(bucket){if(bucket!=='tiktok-receipt-photos')throw Error('Wrong bucket');return {
   upload:async(path,blob,options)=>{const image=await createImageBitmap(blob);calls.uploads.push({path,bytes:blob.size,width:image.width,height:image.height,options});image.close();if(window.failThumbnail&&path.endsWith('-thumb.jpg'))return {error:{message:'Thumbnail upload interrupted'}};if(files.has(path))return {error:{statusCode:409,message:'Already exists'}};files.set(path,blob);return {};},
   createSignedUrls:async paths=>{calls.sign.push(paths);return {data:paths.map(path=>({path,signedUrl:location.origin+'/image/'+encodeURIComponent(path)}))};}
  };}},rpc:async(name,args)=>{
   calls.rpc.push({name,args});if(window.failRpc)return {error:{message:'Database unavailable'}};
   const photo={id:'photo-1',line_id:'line-1',transfer_id:transfer,path:`${actor}/${transfer}.jpg`,thumbnail_path:args._thumbnail_path,video_time:337};window.photos=[photo];return {data:photo};
  }};
  window.render=(items=window.photos)=>{document.querySelector('#photos').innerHTML=items.map(p=>`<section data-tk-photo-line="${p.line_id}"></section>`).join('');TikTokReceiptPhotos.hydrate(document.querySelector('#photos'),db,items);};
  window.addEventListener('message',e=>{if(e.data?.type==='OG_TIKTOK_RECEIPT_DONE')calls.ack++;});
 },{actor,transfer});
 const jpeg=Buffer.from((await page.evaluate(()=>window.photoData)).split(',')[1],'base64');
 await page.route(origin+'/image/**',route=>route.fulfill({contentType:'image/jpeg',body:jpeg,headers:{'Cache-Control':'max-age=3600'}}));
 await page.addScriptTag({content:await readFile(new URL('../tiktok-receipt-photos.js',import.meta.url),'utf8')});return page;
}
test('visible thumbnails are batched and reused; hidden and distant photos wait, and full size loads only on click',async()=>{
 const page=await fixture();const downloads=[];page.on('request',req=>{if(req.url().includes('/image/'))downloads.push(decodeURIComponent(req.url().split('/image/')[1]));});
 await page.evaluate(()=>{
  photos=[1,2,3,4].map(n=>({id:'p'+n,line_id:'l'+n,path:`main-${n}.jpg`,thumbnail_path:`thumb-${n}.jpg`,video_time:337}));
  const root=document.querySelector('#photos');root.innerHTML='<section data-tk-photo-line="l1"></section><section data-tk-photo-line="l2"></section><section class="hidden" data-tk-photo-line="l3"></section><section style="position:absolute;top:3500px" data-tk-photo-line="l4"></section>';
  TikTokReceiptPhotos.hydrate(root,db,photos);TikTokReceiptPhotos.hydrate(root,db,photos);
 });
 await expect(page.locator('[data-tk-photo-line=l1] img')).toHaveAttribute('src',/thumb-1/);await expect(page.locator('[data-tk-photo-line=l2] img')).toHaveAttribute('src',/thumb-2/);
 assert.deepEqual(await page.evaluate(()=>calls.sign),[['thumb-1.jpg','thumb-2.jpg']]);assert.deepEqual(downloads.sort(),['thumb-1.jpg','thumb-2.jpg']);
 await expect(page.locator('[data-tk-photo-line=l1] button')).toHaveCount(1);
 await page.locator('[data-tk-photo-line=l1] button').click();await expect(page.locator('.tk-photo-viewer img')).toHaveAttribute('src',/main-1/);await expect.poll(()=>downloads.includes('main-1.jpg')).toBe(true);
 await page.getByRole('button',{name:'Close photo'}).click();
 await page.evaluate(()=>{document.querySelector('[data-tk-photo-line=l3]').classList.remove('hidden');});await expect(page.locator('[data-tk-photo-line=l3] img')).toHaveAttribute('src',/thumb-3/);
 await page.locator('[data-tk-photo-line=l4]').scrollIntoViewIfNeeded();await expect(page.locator('[data-tk-photo-line=l4] img')).toHaveAttribute('src',/thumb-4/);
 const requests=await page.evaluate(()=>calls.sign.length);await page.evaluate(()=>{scrollTo(0,0);render(photos.slice(0,2));});await expect(page.locator('[data-tk-photo-line=l1] img')).toHaveAttribute('src',/thumb-1/);
 assert.equal(await page.evaluate(()=>calls.sign.length),requests);await page.close();
});
async function deliver(page){
 await page.evaluate(()=>{
  history.replaceState(null,'','?tiktokReceipt='+transfer);
  TikTokReceiptPhotos.start({db,user:{id:actor},getOrders:()=>[{id:'order-1',order_number:'577620684385522369',lines:[{id:'line-1',sku_id:'1732759903849189622'}]}],refresh:async()=>{},reveal:async()=>render(),status:()=>{}});
  window.postMessage({type:'OG_TIKTOK_RECEIPT_DATA',payload:{transferId:transfer,orderNumber:'577620684385522369',skuId:'1732759903849189622',videoTime:337,image:photoData}},location.origin);
 });
}
test('capture creates two JPEG files in the browser, records sizes, and keeps the original unchanged',async()=>{
 const page=await fixture();await deliver(page);await expect(page.locator('.tk-receipt-transfer')).toContainText('Receipt photo saved');
 const calls=await page.evaluate(()=>window.calls);assert.equal(calls.uploads.length,2);const [large,small]=calls.uploads;
 assert.deepEqual([large.width,large.height],[1600,900]);assert.deepEqual([small.width,small.height],[320,180]);assert.ok(small.bytes<large.bytes/5,JSON.stringify({large,small}));
 assert.equal(calls.rpc[0].name,'attach_tiktok_receipt_photo_v2');assert.equal(calls.rpc[0].args._image_bytes,large.bytes);assert.equal(calls.rpc[0].args._thumbnail_bytes,small.bytes);assert.equal(calls.ack,1);
 assert.equal(await page.evaluate(async()=>{const original=await(await fetch(photoData)).arrayBuffer(),saved=await files.get(`${actor}/${transfer}.jpg`).arrayBuffer();return new Uint8Array(original).every((x,i)=>x===new Uint8Array(saved)[i]);}),true);
 console.log(`Receipt fixture bytes: larger=${large.bytes}, thumbnail=${small.bytes} (${Math.round(small.bytes/large.bytes*100)}% of larger)`);
 await page.getByRole('button',{name:'Open receipt photo at 5:37'}).click();await expect(page.locator('.tk-photo-viewer img')).toBeVisible();
 await page.screenshot({path:new URL('../outputs/tiktok-pipeline/tiktok-photo-viewer-test.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});
 await page.setViewportSize({width:390,height:844});await expect(page.locator('.tk-photo-viewer img')).toBeVisible();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await page.keyboard.press('Escape');await expect(page.locator('.tk-photo-viewer')).toHaveCount(0);await page.close();
});
test('interrupted thumbnail upload and failed database save retain handoff for safe retry',async()=>{
 const page=await fixture();await page.evaluate(()=>window.failThumbnail=true);await deliver(page);
 await expect(page.locator('.tk-receipt-transfer')).toContainText('Thumbnail upload interrupted');assert.equal(await page.evaluate(()=>calls.rpc.length),0);assert.equal(await page.evaluate(()=>calls.ack),0);
 await page.evaluate(()=>{window.failThumbnail=false;window.failRpc=true;});await page.getByRole('button',{name:'Retry saving capture'}).click();
 await expect(page.locator('.tk-receipt-transfer')).toContainText('Database unavailable');assert.equal(await page.evaluate(()=>calls.ack),0);
 await page.evaluate(()=>window.failRpc=false);await page.getByRole('button',{name:'Retry saving capture'}).click();await expect(page.locator('.tk-receipt-transfer')).toContainText('Receipt photo saved');
 assert.equal(await page.evaluate(()=>calls.ack),1);assert.equal(await page.evaluate(()=>files.size),2);assert.equal(await page.evaluate(()=>photos.length),1);await page.close();
});
test('legacy capture generates one saved thumbnail across duplicate views and later rerenders',async()=>{
 const page=await fixture();await page.evaluate(()=>{
  photos=[{id:'photo-1',line_id:'line-1',transfer_id:transfer,path:`${actor}/${transfer}.jpg`,video_time:337}];
  document.querySelector('#photos').innerHTML='<section data-tk-photo-line="line-1"></section><section data-tk-photo-line="line-1"></section>';
  TikTokReceiptPhotos.hydrate(document.querySelector('#photos'),db,photos);
 });
 await expect(page.locator('.tk-receipt-photo img').first()).toHaveAttribute('src',/-thumb/);await expect(page.locator('.tk-receipt-photo img').last()).toHaveAttribute('src',/-thumb/);
 assert.equal(await page.evaluate(()=>calls.uploads.length),1);assert.equal(await page.evaluate(()=>calls.rpc.filter(c=>c.name==='finish_tiktok_receipt_thumbnail').length),1);
 await page.evaluate(()=>render());await expect(page.locator('.tk-receipt-photo img')).toHaveAttribute('src',/-thumb/);assert.equal(await page.evaluate(()=>calls.uploads.length),1);await page.close();
});
