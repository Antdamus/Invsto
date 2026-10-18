import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {chromium,expect} from '@playwright/test';
const root=new URL('../',import.meta.url);let server,browser,origin;
const csv='Order ID,Order Status,Order Substatus,SKU ID,Seller SKU,Product Name,Quantity,Buyer Username,Package ID,Order Amount\n577623648796643332,To ship,Awaiting shipment,1732765489814737142,1,JEWELRY AS SEEN ON SCREEN,1,fixture-buyer,987654321123456789,25.68';
before(async()=>{server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();try{let content=await readFile(new URL(name,root));if(name.endsWith('.html')&&!new URL(req.url,'http://localhost').searchParams.has('boot'))content=content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);}catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch();await mkdir(new URL('../outputs/tiktok-pipeline/',import.meta.url),{recursive:true});});
after(async()=>{await browser?.close();if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});});
test('published script order waits for the real Supabase initializer before using auth',async()=>{
 const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js',route=>route.fulfill({contentType:'text/javascript',body:`window.supabase={createClient(){return {auth:{getSession:async()=>({data:{session:{user:{id:'fixture-user'}}}})},from(){const q={select(){return q},order(){return q},eq(){return q},maybeSingle:async()=>({data:null}),range:async()=>({data:[]}),limit:async()=>({data:[]})};return q}}}};`}));
 await page.goto(origin+'/pending-tiktok-orders.html?boot=1');
 await expect(page.locator('#tk-status')).toContainText('Import your first');await expect(page.locator('#tk-orders')).toContainText('No TikTok orders imported yet');assert.deepEqual(errors,[]);await page.close();
});
async function setup(page,{receiptId=''}={}){
 await page.goto(origin+'/pending-tiktok-orders.html'+(receiptId?'?tiktokReceipt='+receiptId:''));
 await page.evaluate(()=>{
  const tables={tiktok_orders:[],tiktok_order_lines:[],tiktok_order_imports:[],tiktok_order_events:[],tiktok_order_documents:[],tiktok_order_receipt_photos:[]};window.fixtureTables=tables;window.fixtureCalls=[];
  window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:'fixture-user'}}}})},from(name){if(!name.startsWith('tiktok_'))throw Error('Cross-marketplace access: '+name);let matches=tables[name]||[];const q={select(){return q;},order(){return q;},in(k,values){matches=matches.filter(x=>values.includes(x[k]));return q;},eq(k,v){matches=matches.filter(x=>x[k]===v);return q;},range(a,b){return Promise.resolve({data:matches.slice(a,b+1)});},limit(n){return Promise.resolve({data:matches.slice(0,n)});},then(resolve){return Promise.resolve({data:matches}).then(resolve);}};return q;},rpc:async(name,args)=>{window.fixtureCalls.push({name,args});if(name==='import_tiktok_orders'){for(const r of args._rows){tables.tiktok_orders.push({...r,id:'order-1',revision:1,stage:'pending',notes:'',source_snapshot_at:args._snapshot_at});tables.tiktok_order_lines.push({...r,id:'line-1',order_id:'order-1'});}tables.tiktok_order_imports.push({filename:args._filename,snapshot_at:args._snapshot_at,imported_at:new Date().toISOString()});return {data:{added:1,refreshed:0,stale:0,history_skipped:0}};}if(name==='update_tiktok_order'){Object.assign(tables.tiktok_orders[0],{stage:args._stage,notes:args._notes,ship_by_date:args._ship_by,revision:2});return {data:tables.tiktok_orders[0]};}throw Error('Unexpected RPC '+name);}};
 });
 for(const src of ['vendor/pdf-lib/pdf-lib.min.js','tiktok-order-import.js','tiktok-order-packet.js','tiktok-order-queue.js','tiktok-receipt-photos.js','tiktok-orders.js'])await page.addScriptTag({url:origin+'/'+src});
 await expect(page.locator('#tk-status')).toContainText('Import your first');
}
test('TikTok preview, import, preparation/history and packet download use only TikTok data on desktop and mobile',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);
 await expect(page.getByRole('navigation',{name:'Order marketplace'}).getByRole('link')).toHaveCount(2);
 await page.locator('#tk-import').evaluate(e=>e.open=true);await page.locator('#tk-file').setInputFiles({name:'To Ship order-2026-10-17-22_04.csv',mimeType:'text/csv',buffer:Buffer.from(csv)});await expect(page.locator('#tk-preview')).toContainText('1 orders');assert.equal(await page.evaluate(()=>window.fixtureCalls.length),0);
 await page.locator('#tk-import-confirm').click();await expect(page.locator('#tk-orders')).toContainText('fixture-buyer');await expect(page.locator('#tk-status')).toContainText('1 new');
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({animations:'disabled',path:new URL('../outputs/tiktok-pipeline/tiktok-desktop.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});
 const card=page.locator('.tk-buyer');await card.locator('.buyer-card-compact-count').click();await expect(card).toHaveClass(/is-expanded/);
 await card.locator('.tk-order-heading').click();await expect(card).toHaveClass(/is-expanded/);
 await card.locator('.buyer-card-meta span').first().click();await expect(card).toHaveClass(/is-collapsed/);
 await card.getByRole('button',{name:'Open',exact:true}).click();await expect(card.getByRole('button',{name:'Hide',exact:true})).toHaveAttribute('aria-expanded','true');
 await page.getByRole('button',{name:'Open order',exact:true}).click();await expect(page.getByRole('link',{name:'Watch full receipt in TikTok'})).toHaveAttribute('href',/ogReceipt=1/);
 await page.locator('#tk-order-notes').fill('Locate matching bag');await page.locator('#tk-order-stage').selectOption('waiting');await page.locator('#tk-save-work').click();await expect(page.locator('#tk-detail-status')).toContainText('Preparation saved');
 const download=page.waitForEvent('download');await page.getByRole('button',{name:'Download order PDF',exact:true}).click();const file=await download;const bytes=await readFile(await file.path());assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({animations:'disabled',path:new URL('../outputs/tiktok-pipeline/tiktok-detail.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});
 await page.locator('#tk-close-detail').click();await page.setViewportSize({width:390,height:844});await page.evaluate(()=>scrollTo(0,0));await page.screenshot({animations:'disabled',path:new URL('../outputs/tiktok-pipeline/tiktok-mobile.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 assert.deepEqual(errors,[]);await page.close();
});

test('late receipt capture saves to the exact SKU, shows its image, and duplicate deliveries do not save again',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),id='00000000-0000-4000-8000-000000000002';await setup(page,{receiptId:id});
 await page.evaluate(()=>{
  const t=window.fixtureTables;t.tiktok_orders.push({id:'capture-order',order_number:'577620684385522369',buyer_username:'capture-buyer',stage:'pending',marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',notes:'',revision:1});
  for(const [id,sku] of [['line-a','1732759903849189622'],['line-b','1732759903849189623']])t.tiktok_order_lines.push({id,order_id:'capture-order',sku_id:sku,title:'Fixture jewelry',seller_sku:id,quantity:1});
  const canvas=document.createElement('canvas');canvas.width=180;canvas.height=320;const ctx=canvas.getContext('2d');ctx.fillStyle='#8d6b3e';ctx.fillRect(0,0,180,320);ctx.strokeStyle='#edce82';ctx.lineWidth=12;ctx.beginPath();ctx.arc(90,150,45,0,Math.PI*2);ctx.stroke();window.fixturePhoto=canvas.toDataURL('image/jpeg');
  window.uploads=[];window.photoSaves=0;window.supabase.storage={from(bucket){if(bucket!=='tiktok-receipt-photos')throw Error('Wrong bucket');return {upload:async(path,blob,options)=>{const image=await createImageBitmap(blob);window.uploads.push({path,type:blob.type,size:blob.size,width:image.width,height:image.height,options});image.close();return {};},createSignedUrls:async paths=>({data:paths.map(path=>({path,signedUrl:window.fixturePhoto}))})};}};
  const previous=window.supabase.rpc;window.supabase.rpc=async(name,args)=>{if(name!=='attach_tiktok_receipt_photo_v2')return previous(name,args);window.photoSaves++;const line=t.tiktok_order_lines.find(l=>l.sku_id===args._sku_id);t.tiktok_order_receipt_photos.push({id:'photo-1',line_id:line.id,transfer_id:args._transfer_id,path:args._path,thumbnail_path:args._thumbnail_path,video_time:args._video_time});return {data:{id:'photo-1'}};};
  window.receiptDone=0;window.addEventListener('message',event=>{if(event.data?.type==='OG_TIKTOK_RECEIPT_DONE')window.receiptDone++;if(event.data?.type==='OG_TIKTOK_RECEIPT_READY')window.postMessage({type:'OG_TIKTOK_RECEIPT_DATA',payload:{transferId:new URLSearchParams(location.search).get('tiktokReceipt'),orderNumber:'577620684385522369',skuId:'1732759903849189623',videoTime:337,image:window.fixturePhoto}},location.origin);});
 });
 await page.locator('#tk-refresh').click();await page.evaluate(()=>window.postMessage({type:'OG_TIKTOK_RECEIPT_BRIDGE_READY'},location.origin));
 await expect(page.locator('.tk-receipt-transfer')).toContainText('Receipt photo saved');
 await expect(page.locator('dialog[open]')).toHaveCount(0);
 await expect(page.locator('#tk-orders [data-tk-photo-line="line-b"] img')).toBeVisible();await expect(page.locator('#tk-orders [data-tk-photo-line="line-a"] img')).toHaveCount(0);
 await expect(page.locator('.tk-capture-saved')).toContainText('Capture saved');await expect(page.locator('.tk-capture-saved')).toContainText('5:37');
 assert.equal(await page.locator('.tk-capture-saved').evaluate(el=>el===document.activeElement),true);
 await page.evaluate(()=>window.postMessage({type:'OG_TIKTOK_RECEIPT_BRIDGE_READY'},location.origin));
 await expect(page.locator('#tk-orders [data-tk-photo-line="line-b"] img')).toBeVisible();assert.equal(await page.evaluate(()=>window.photoSaves),1);assert.equal(await page.evaluate(()=>window.receiptDone),1);
 const uploads=await page.evaluate(()=>window.uploads);assert.equal(uploads.length,2);assert.match(uploads[1].path,/-thumb\.jpg$/);for(const file of uploads){assert.equal(file.type,'image/jpeg');assert.equal(file.options.cacheControl,'3600');assert.equal(file.options.upsert,false);}assert.ok(Math.max(uploads[1].width,uploads[1].height)<=320);
 await page.screenshot({animations:'disabled',path:new URL('../outputs/tiktok-pipeline/tiktok-receipt-saved-test.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});await page.close();
});

test('an already-open TikTok tab reveals repeated captures through filters and history without opening dialogs',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);
 await page.evaluate(()=>{
  const t=fixtureTables;t.tiktok_orders.push({id:'return-order',order_number:'577620684385522369',buyer_username:'return-buyer',stage:'pending',marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',revision:1});
  t.tiktok_order_lines.push({id:'return-line',order_id:'return-order',sku_id:'1732759903849189622',title:'Saved capture item',quantity:1});
  const canvas=document.createElement('canvas');canvas.width=160;canvas.height=320;canvas.getContext('2d').fillRect(0,0,160,320);window.photo=canvas.toDataURL('image/jpeg');
  t.tiktok_order_receipt_photos.push({id:'p1',line_id:'return-line',path:'main.jpg',thumbnail_path:'thumb.jpg',video_time:12});
  supabase.storage={from:()=>({createSignedUrls:async paths=>({data:paths.map(path=>({path,signedUrl:photo}))})})};
  window.addEventListener('message',e=>{if(e.data?.type==='OG_TIKTOK_RECEIPT_READY'&&e.data.transferId){t.tiktok_order_receipt_photos[0].transfer_id=e.data.transferId;window.postMessage({type:'OG_TIKTOK_RECEIPT_DATA',payload:{transferId:e.data.transferId,orderNumber:'577620684385522369',skuId:'1732759903849189622',completed:true}},location.origin);}});
 });
 await page.locator('#tk-refresh').click();await page.locator('#tk-search').fill('different-buyer');await page.locator('#tk-stage-filter').selectOption('waiting');
 await page.evaluate(()=>window.postMessage({type:'OG_TIKTOK_RECEIPT_AVAILABLE',transferId:'00000000-0000-4000-8000-000000000003'},location.origin));
 await expect(page.locator('.tk-capture-saved img')).toBeVisible();await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(page.locator('#tk-search')).toHaveValue('');await expect(page.locator('#tk-stage-filter')).toHaveValue('');
 await page.getByRole('button',{name:'Open order',exact:true}).click();await expect(page.locator('#tk-detail')).toBeVisible();
 await page.evaluate(()=>{fixtureTables.tiktok_orders[0].stage='dispatched';window.postMessage({type:'OG_TIKTOK_RECEIPT_AVAILABLE',transferId:'00000000-0000-4000-8000-000000000004'},location.origin);});
 await expect(page.locator('#tk-title')).toHaveText('TikTok Order History');await expect(page.locator('dialog[open]')).toHaveCount(0);await expect(page.locator('.tk-capture-saved img')).toBeVisible();await expect(page.locator('#tk-history-link')).toHaveAttribute('aria-current','page');assert.equal(new URL(page.url()).searchParams.get('view'),'history');
 await page.evaluate(()=>{fixtureTables.tiktok_orders[0].stage='pending';window.postMessage({type:'OG_TIKTOK_RECEIPT_AVAILABLE',transferId:'00000000-0000-4000-8000-000000000005'},location.origin);});
 await expect(page.locator('#tk-title')).toHaveText('Pending TikTok Orders');await expect(page.locator('#tk-pending-link')).toHaveAttribute('aria-current','page');await expect(page.locator('dialog[open]')).toHaveCount(0);assert.equal(page.context().pages().length,1);await page.close();
});

test('TikTok capture button tracks the receipt clicked on a multi-SKU order and sends the paused video area',async()=>{
 const page=await browser.newPage({viewport:{width:1200,height:800}}),order='577620684385522369';
 await page.route('https://seller-us.tiktok.com/**',route=>route.fulfill({contentType:'text/html',body:`<html><body><article>SKU ID: 1732759903849189622<button id="first">Video receipt</button></article><article>SKU ID: 1732759903849189623<button id="second">Video receipt</button></article><div id="auction-video-receipt-${order}"><video style="width:200px;height:400px"></video></div></body></html>`}));
 await page.goto('https://seller-us.tiktok.com/order/detail?order_no='+order);
 await page.evaluate(async()=>{window.captures=[];window.chrome={runtime:{sendMessage:async m=>{window.captures.push(m);return {ok:true};}}};const c=document.createElement('canvas');c.width=200;c.height=400;c.getContext('2d').fillRect(0,0,200,400);const v=document.querySelector('video');v.muted=true;v.srcObject=c.captureStream(1);await v.play();});
 await page.addScriptTag({content:await readFile(new URL('../tools/ebay-og-order-link-extension/tiktok-receipt-capture.js',import.meta.url),'utf8')});
 const button=page.getByRole('button',{name:'Capture item photo → OG'});await expect(button).toBeDisabled();
 await page.locator('#second').click();await expect(button).toBeEnabled();await expect(page.locator('#og-tiktok-receipt-capture')).toContainText('1732759903849189623');await button.click();
 await expect(page.locator('#og-tiktok-receipt-capture')).toContainText('Sent to OG');
 const message=await page.evaluate(()=>window.captures[0]);assert.equal(message.orderNumber,order);assert.equal(message.skuId,'1732759903849189623');assert.equal(message.rect.width,200);assert.equal(message.rect.height,400);assert.equal(await page.locator('video').evaluate(v=>v.paused),true);
 await page.locator('#first').click();await expect(page.locator('#og-tiktok-receipt-capture')).toContainText('1732759903849189622');
 await page.screenshot({animations:'disabled',path:new URL('../outputs/tiktok-pipeline/tiktok-receipt-button-test.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});await page.close();
});
test('late extension bridge delivers preview, completed transfers do not import again',async()=>{
 const page=await browser.newPage();await setup(page);const id='11111111-1111-4111-8111-111111111111';await page.evaluate(id=>history.replaceState(null,'','?tiktokReport='+id),id);
 await page.evaluate(({csv,id})=>{window.addEventListener('message',e=>{if(e.data?.type==='OG_TIKTOK_REPORT_READY')window.postMessage({type:'OG_TIKTOK_REPORT_DATA',payload:{transferId:id,text:csv,filename:'TikTok.csv'}},location.origin);});window.postMessage({type:'OG_TIKTOK_BRIDGE_READY'},location.origin);},{csv,id});await expect(page.locator('#tk-preview')).toContainText('Review before importing');assert.equal(await page.evaluate(()=>window.fixtureCalls.length),0);await page.close();
});
test('buyer cards filter deadlines without splitting a buyer and expose only their TikTok receipts and labels',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);
 await page.evaluate(()=>{
  const t=window.fixtureTables,day=window.TikTokOrderQueue.calendarDate(),offset=n=>new Date(Date.parse(day+'T12:00:00Z')+n*86400000).toISOString().slice(0,10);
  const order=(id,buyer,due,stage='pending')=>({id,order_number:'57762364879664333'+id,buyer_username:buyer,buyer_nickname:buyer,ship_by_date:due,stage,marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',order_amount:'25.68',created_time:'10/17/2026 11:48:52 AM',source_snapshot_at:new Date().toISOString(),notes:'',revision:1});
  t.tiktok_orders.push(order('1','Alice',offset(-1),'waiting'),order('2','Alice',offset(2)),order('3','Bob',day),order('4','Carol',null),order('5','Done',offset(-3),'dispatched'));
  for(const o of t.tiktok_orders)t.tiktok_order_lines.push({id:'line-'+o.id,order_id:o.id,title:'Gold ring',quantity:1,seller_sku:o.id,sku_id:'173276548981473714'+o.id,tracking_number:'TRACK'+o.id});
  t.tiktok_order_documents.push({id:'label-2',order_id:'2',kind:'label',path:'tiktok-orders/fixture/label.pdf',filename:'Alice-order-2.pdf',created_at:new Date().toISOString()},{id:'packet-1',order_id:'1',kind:'packet',path:'tiktok-orders/fixture/packet.pdf',filename:'Packing.pdf'});
  window.printCalls=[];window.shippingLabelPrint={printSaved:async value=>{window.printCalls.push(value);return {message:'Opened printer chooser'};}};
 });
 await page.locator('#tk-refresh').click();await expect(page.locator('#tk-orders .tk-buyer')).toHaveCount(3);
 await page.locator('.buyer-shipping-due-options [data-tk-due=overdue]').click();await expect(page.locator('.tk-buyer')).toHaveCount(1);const card=page.locator('.tk-buyer');await expect(card).toHaveClass(/is-overdue/);await expect(card).toContainText('2 orders');await expect(card).toContainText('1/2 orders with labels');
 await card.getByRole('button',{name:'Open video receipts',exact:true}).click();await expect(page.locator('#tk-buyer-tools a').filter({hasText:'Open video receipt'})).toHaveCount(2);const links=await page.locator('#tk-buyer-tools a').filter({hasText:'Open video receipt'}).evaluateAll(nodes=>nodes.map(n=>n.href));assert.ok(links.every(l=>l.includes('seller-us.tiktok.com/order/detail?order_no=57762364879664333')&&l.includes('ogReceipt=1')));await page.locator('#tk-close-buyer-tools').click();
 await card.getByRole('button',{name:'Shipping labels',exact:true}).click();await expect(page.locator('#tk-buyer-tools')).toContainText('Alice-order-2.pdf');await expect(page.locator('#tk-buyer-tools')).not.toContainText('Packing.pdf');await page.getByRole('button',{name:'Print shipping label',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.printCalls),[{path:'tiktok-orders/fixture/label.pdf',title:'TikTok shipping label'}]);await page.locator('#tk-close-buyer-tools').click();
 await page.locator('.buyer-shipping-due-options [data-tk-due=unknown]').click();await expect(page.locator('.tk-buyer')).toHaveCount(1);await expect(page.locator('.tk-buyer')).toContainText('Carol');await expect(page.locator('.tk-buyer')).not.toHaveClass(/is-overdue/);
 await page.locator('.tk-buyer [data-buyer-tool=dates]').click();await expect(page.locator('#tk-buyer-tools')).toContainText('Date needed');await page.getByRole('button',{name:'Edit ship-by date',exact:true}).click();await expect(page.locator('#tk-order-deadline')).toBeVisible();
 await page.close();
});
