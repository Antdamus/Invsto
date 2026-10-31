import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {webkit,expect} from '@playwright/test';
let server,browser,origin,bs;
const root=new URL('../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1);if(path.includes('..'))return res.writeHead(400).end();try{res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(await readFile(new URL(path,root)));}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 bs=await webkit.launchServer();browser=await webkit.connect(bs.wsEndpoint());await mkdir(new URL('../output/whatnot',import.meta.url),{recursive:true});
});
after(async()=>{await browser?.close();await bs?.close();if(server)await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function fixture(page){
 await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js',route=>route.fulfill({contentType:'text/javascript',body:`window.supabase={createClient(){
 const order={id:'1484060355',status:'pending_fulfillment',buyer_id:'9',username:'fixture_buyer',customer_name:'Fixture Customer',purchased_at:'2026-10-27T22:17:00Z',url:'https://www.whatnot.com/dashboard/orders/opaque',show_id:'show',show_title:'Afternoon jewelry show'};
 const lines=[1,2].map(n=>({id:'900'+n,order_id:order.id,title:n===1?'925 Silver Earrings — exact purchased item':'Gold bracelet',quantity:1,unit_price:25,currency:'USD',ship_by_date:'2026-10-29',tracking_number:'9400111000000000001234',shipment_status:'label_generated',carrier:'USPS',work_state:'pending',revision:1,holds:[],item_missing:n===1,line_number:n,order_lines:2,order_units:2,order_missing_screenshots:1,screenshot_count:n===1?0:2,scope:'pending',label_state:n===1?'issued':'attached',order_label_pdfs:1,order_labels_issued_only:1,order_label_pdfs_to_check:0,order_record:order}));
 window.calls=[];window.fixtureLines=lines;
 return {auth:{getUser:async()=>({data:{user:{id:'user'}}})},functions:{invoke:async(name,{body})=>{calls.push({name,body});return {data:{admin:true,configured:true,connection:{seller_name:'ogjewelers',enabled:true,last_synced_at:'2026-10-31T16:00:00Z',last_full_sync_at:'2026-10-31T16:00:00Z'}}}}},
 rpc:async(name,args)=>{calls.push({name,args});if(name==='can_manage_inventory')return {data:true};if(name==='whatnot_queue_summary'){const ls=['missing','no_screenshot'].includes(args._filter)?lines.filter(l=>l.item_missing):lines;const totals=n=>({lines:n,orders:n?1:0,buyers:n?1:0,units:n,amounts:n?{USD:{sales:n*25,shipping:n*2,fees:n*1.5}}:{}});return {data:{groups:[{buyer_key:'9',buyer:'fixture_buyer',customer:'Fixture Customer',lines:ls}],buyers:1,visible_lines:ls.length,visible_items:ls.length,counts:{pending:2,review:0,history:0,all:2},market_counts:{market_open:1,unfulfilled:1},facets:{'due:all':totals(ls.length),'due:overdue':totals(ls.length),'work:no_screenshot':totals(1),'work:missing':totals(1),'work:ready':totals(1),'work:waiting':totals(1),shown:totals(ls.length)},filters:{all:2,missing:1,cgl:0,overdue:2,today:0,tomorrow:0,no_tracking:0,unknown:0}}};}if(name==='attach_whatnot_file')return {data:'fixture-file-id'};if(name==='whatnot_work_action')return {data:{updated:args._lines.length}};throw Error('Unexpected RPC '+name);},
 storage:{from(){return {upload:async(path,file)=>{calls.push({name:'upload',path,filename:file.name});return {error:null};}}}},from(name){if(!name.startsWith('whatnot_')&&!['marketplace_order_notes','marketplace_order_note_summaries'].includes(name))throw Error('Cross marketplace query');const q={select(){return q},overlaps(){return q},in(){return q},eq(){return q},is(){return q},order(){return q},limit:async()=>({data:[]}),range:async()=>({data:[]}),then(r){return Promise.resolve({data:[]}).then(r)}};return q;}};
 }}` }));
 await page.goto(origin+'/pending-whatnot-orders.html');await expect(page.locator('#wn-selection-totals h2')).toHaveText('Queue overview');
}
test('desktop and phone queues show exact lines, customer name, due urgency and tracking',async()=>{
 const page=await browser.newPage({viewport:{width:1366,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await fixture(page);
 await expect(page.locator('.wn-line')).toHaveCount(2);await expect(page.locator('.wn-buyer')).toContainText('Fixture Customer');await expect(page.locator('.wn-line').first()).toContainText('Overdue');
 await page.screenshot({path:'output/whatnot/queue-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
 await expect(page.locator('.mq-deadline-grid button')).toHaveCount(4);
 await expect(page.locator('[data-mq-key=tomorrow]')).toBeInViewport({ratio:1});
 await page.locator('[data-mq-key="missing"]').click();await expect(page.locator('.wn-line')).toHaveCount(1);await expect(page.locator('#wn-selection-totals')).toContainText('1 item line');
 await expect(page.locator('[data-mq-key=overdue] .mq-chip-count')).toHaveText('1');
 await expect(page.locator('.wn-order-block>header')).toContainText('2 order lines · 2 items · Showing 1 of 2');
 await expect(page.locator('.wn-order-block>header')).toContainText('1 line needs a screenshot');
 await expect(page.locator('.wn-order-block>header .mq-shipping-label')).toHaveText('Shipping label attached · 1 of 2 lines · 1 line with a Whatnot label only');
 await expect(page.locator('.wn-line .mq-shipping-label')).toHaveText('Whatnot label issued · No PDF attached');
 await expect(page.locator('.wn-line .mq-item-title')).toHaveText('925 Silver Earrings — exact purchased item');
 await expect(page.locator('#wn-selection-totals')).toContainText('$25.00');await expect(page.locator('.mq-metrics')).toHaveCount(1);await expect(page.locator('#wn-money-cards')).not.toContainText('Shipping collected');
 await page.locator('[data-mq-key="overdue"]').click();await expect.poll(()=>page.evaluate(()=>calls.filter(c=>c.name==='whatnot_queue_summary').at(-1).args._due)).toBe('overdue');
 await expect(page.locator('[data-mq-key="missing"]')).toHaveAttribute('aria-pressed','true');
 await page.evaluate(()=>scrollTo(0,0));await page.screenshot({path:'output/whatnot/queue-phone.png',fullPage:true});
 await page.locator('[data-mq-key=no_screenshot]').click();await expect(page.locator('.wn-line')).toHaveCount(1);
 await expect(page.locator('.wn-line .mq-coverage')).toHaveText('Needs screenshot');
 await page.getByRole('button',{name:'Select shown items'}).click();await page.getByRole('button',{name:'Note selected lines',exact:true}).click();
 await page.locator('#wn-value').fill('Checked tray 12; item is missing.');await page.locator('#wn-action-submit').click();
 const update=await page.evaluate(()=>calls.find(c=>c.name==='whatnot_work_action'));assert.equal(update.args._lines.length,1);assert.equal(update.args._lines[0].id,'9001');assert.deepEqual(errors,[]);await page.close();
});
test('completion needs explicit physical check and receipt links retain exact item identity',async()=>{
 const page=await browser.newPage();await fixture(page);const href=await page.getByRole('link',{name:'Video receipt ↗'}).first().getAttribute('href');assert.match(href,/#invsto-receipt=9001&order=1484060355$/);
 await page.locator('[data-select-line="9002"]').check();await page.getByRole('button',{name:'Complete selected'}).click();await page.locator('#wn-action-submit').click();await expect(page.locator('#wn-action-error')).toContainText('Confirm');
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='whatnot_work_action').length),0);
 await page.locator('#wn-confirm').check();await page.locator('#wn-action-submit').click();assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.name==='whatnot_work_action').args._lines),[{id:'9002',revision:1,verified_tracking_number:'9400111000000000001234'}]);await page.close();
});
test('token form sends only to authenticated edge connection and clears on close',async()=>{
 const page=await browser.newPage();await fixture(page);await page.locator('#wn-connection>summary').click();await page.getByRole('button',{name:'Reconnect Whatnot'}).click();await page.locator('#wn-token').fill('test-only-token');await page.getByRole('button',{name:'Connect account & start sync'}).click();await expect(page.locator('#wn-token')).toHaveValue('');
 assert.equal(await page.evaluate(()=>localStorage.getItem('whatnotToken')),null);assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='whatnot-order-sync'&&c.body.action==='connect').length),1);await page.close();
});
test('report has buyer and item indexes, tracking and receipt links without inventing refunds',async()=>{
 const page=await browser.newPage();await fixture(page);await page.evaluate(()=>{fixtureLines[1].work_state='completed';fixtureLines[1].scope='history';fixtureLines[1].order_record={...fixtureLines[1].order_record,status:'completed'};});await page.getByRole('button',{name:'↻ Reload saved orders'}).click();await page.getByText('Buyer reports',{exact:true}).click();const opened=page.waitForEvent('popup');await page.getByRole('button',{name:'Shown items report / PDF'}).click();const report=await opened;
 await expect(report.locator('h1')).toContainText('Whatnot items in this view');await expect(report.locator('.item')).toHaveCount(2);await expect(report.getByText('Refund amounts are not supplied',{exact:false})).toBeVisible();
 assert.equal(await report.locator('a[href="#directory"]').count()>1,true);await expect(report.locator('body')).toContainText('Fixture Customer');await expect(report.locator('body')).toContainText('$25.00');
 await expect(report.locator('.item').first()).toContainText('Overdue');await expect(report.locator('.item').nth(1)).not.toContainText('Overdue');await expect(report.locator('.item').nth(1)).toContainText('Scheduled due day');
 await report.screenshot({path:'output/whatnot/report-preview.png',fullPage:true});await report.close();await page.close();
});
test('Whatnot shadow-player capture identifies the exact order and crops the visible video',async()=>{
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 await page.route('https://www.whatnot.com/**',r=>r.fulfill({contentType:'text/html',body:'<section>Order #1484060355 <button aria-label="Close order details">Close</button></section><div class="react-tiny-popover-container" style="position:relative;width:300px;height:500px"><hls-video></hls-video></div>'}));
 await page.goto('https://www.whatnot.com/dashboard/orders/opaque#invsto-receipt=1484056123&order=1484060355');
 await page.evaluate(()=>{const h=document.querySelector('hls-video');h.attachShadow({mode:'open'}).innerHTML='<video style="display:block;width:250px;height:440px"></video>';const v=h.shadowRoot.querySelector('video');Object.defineProperty(v,'readyState',{get:()=>2});Object.defineProperty(v,'videoWidth',{get:()=>250});document.body.addEventListener('click',e=>{const popover=document.querySelector('.react-tiny-popover-container');if(popover&&!popover.contains(e.target))popover.remove();},true);window.chrome={runtime:{sendMessage:async m=>{window.captureRequest=m;return {ok:true}}}};});
 await page.addScriptTag({content:await readFile(new URL('../tools/ebay-og-order-link-extension/whatnot-receipt-capture.js',import.meta.url),'utf8')});
 await page.getByRole('button',{name:'Capture item photo → Invsto'}).click();await expect(page.getByText('Sent to Invsto.',{exact:false})).toBeVisible();
 const request=await page.evaluate(()=>captureRequest);assert.equal(request.itemId,'1484056123');assert.equal(request.orderNumber,'1484060355');assert.equal(request.rect.width,250);assert.equal(request.rect.height,440);await expect(page.locator('hls-video')).toHaveCount(1);await page.close();
});
test('receipt opening retries a server-rendered button before its handler is ready',async()=>{
 const page=await browser.newPage();
 await page.route('https://www.whatnot.com/**',r=>r.fulfill({contentType:'text/html',body:'<section>Order #1484060355 <button aria-label="Close order details">Close</button></section><button id="receipt">View Receipt</button>'}));
 await page.goto('https://www.whatnot.com/dashboard/orders/opaque#invsto-receipt=1484056123&order=1484060355');
 await page.addScriptTag({content:await readFile(new URL('../tools/ebay-og-order-link-extension/whatnot-receipt-capture.js',import.meta.url),'utf8')});
 await page.evaluate(()=>{document.querySelector('#receipt').onclick=()=>{window.receiptOpens=(window.receiptOpens||0)+1;const v=document.createElement('video');v.style.cssText='width:200px;height:300px';document.body.append(v);};});
 await expect(page.getByRole('button',{name:'Capture item photo → Invsto'})).toBeVisible({timeout:8000});
 assert.equal(await page.evaluate(()=>receiptOpens),1);await page.close();
});

test('marketplace filters show order counts, a separate closing checklist and accessible status history',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});await fixture(page);
 await expect(page.locator('[data-view="unfulfilled"]')).toContainText('1');await page.locator('[data-view="unfulfilled"]').click();
 await expect(page.locator('#wn-selection-totals h2')).toHaveText('Unfulfilled on Whatnot');
 await page.evaluate(()=>{for(const l of fixtureLines){l.order_record.status='completed';l.order_record.source_updated_at='2026-10-31T15:00:00Z';}});
 await page.locator('[data-view="closeout"]').click();await expect(page.locator('.wn-closeout-alert')).toContainText('Pending information to close');
 await expect(page.locator('.wn-order-status-head')).toContainText('Whatnot · Completed');
 await page.getByText('Whatnot status history',{exact:true}).click();await expect(page.locator('.wn-market-timeline')).toContainText('No recorded status changes.');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);await page.close();
});

test('phone scans a routed physical barcode across queues then takes a packing photo for one verified line',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});await fixture(page);
 try{
  await page.locator('[data-view="closeout"]').click();await page.getByRole('button',{name:'Scan tracking'}).click();
  await expect(page.locator('#camera-scanner-title')).toHaveText('Scan a shipping label');
  await page.addScriptTag({url:origin+'/node_modules/jsbarcode/dist/JsBarcode.all.min.js'});
  const image=await page.evaluate(()=>{const c=document.createElement('canvas');JsBarcode(c,'420331319400111000000000001234',{format:'CODE128',height:140,width:3,margin:30,displayValue:false});return c.toDataURL('image/png').split(',')[1];});
  const photo={name:'test.png',mimeType:'image/png',buffer:Buffer.from(image,'base64')};
  await page.locator('[data-camera="photo"]').setInputFiles(photo);await page.locator('[data-camera="use"]').click();
  await expect(page.locator('#wn-status')).toContainText('2 matching order lines');
  const lookup=await page.evaluate(()=>calls.filter(c=>c.name==='whatnot_queue_summary').at(-1).args);
  assert.equal(lookup._view,'all');assert.equal(lookup._search,'!scan:420331319400111000000000001234');
  await page.getByRole('button',{name:'Photo & close line'}).click();await expect(page.locator('#wn-pack-camera')).toHaveAttribute('capture','environment');
  await page.locator('#wn-pack-camera').setInputFiles(photo);await page.locator('#wn-confirm').check();await page.locator('#wn-action-submit').click();
  await expect(page.locator('#wn-action-dialog')).not.toBeVisible();
  const writes=await page.evaluate(()=>calls.filter(c=>c.name==='attach_whatnot_file'||c.name==='whatnot_work_action'));
  assert.deepEqual(writes.map(c=>c.name),['attach_whatnot_file','whatnot_work_action']);
  assert.equal(writes[0].args._kind,'completion_photo');assert.deepEqual(writes[0].args._lines,[{id:'9002',revision:1}]);
  assert.deepEqual(writes[1].args._lines,[{id:'9002',revision:1,verified_tracking_number:'9400111000000000001234'}]);
 }finally{await page.close();}
});

test('Whatnot order and line note buttons open the exact scope without selecting checkboxes',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});await fixture(page);
 try{
  await page.locator('.wn-order-block>header').getByRole('button',{name:'Add order note'}).click();
  await expect(page.locator('#mn-context')).toHaveText('Order #1484060355 · Whole order');await page.locator('#mn-close').click();
  await page.locator('#wn-item-9002').getByRole('button',{name:'Add line note'}).click();
  await expect(page.locator('#mn-context')).toContainText('Gold bracelet · Line 9002');await expect(page.locator('#mn-feed')).toHaveText('No staff notes yet.');
  await expect(page.locator('[data-select-line]:checked')).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Take photo'})).toBeVisible();await page.locator('#mn-close').click();
  await page.locator('#wn-item-9002 [data-select-line]').check();await page.getByRole('button',{name:'Note selected lines'}).click();
  const png=await page.evaluate(()=>{
   const db=window.supabaseClient;db.auth.getSession=async()=>({data:{session:{user:{id:'user'}}}});
   const orig=db.rpc;db.rpc=async(name,args)=>{if(name!=='add_marketplace_order_photo_note')return orig(name,args);calls.push({name,args});return {};};
   return document.createElement('canvas').toDataURL().split(',')[1];
  });
  await page.locator('#wn-note-photos [data-file]').setInputFiles({name:'bracelet.png',mimeType:'image/png',buffer:Buffer.from(png,'base64')});
  await page.locator('#wn-value').fill('Check the clasp');await page.locator('#wn-action-submit').click();await expect(page.locator('#wn-action-dialog')).toBeHidden();
  const args=await page.evaluate(()=>calls.find(c=>c.name==='add_marketplace_order_photo_note').args);
  assert.deepEqual(args._targets,[{order_id:'1484060355',line_id:'9002',revision:1}]);assert.equal(args._note,'Check the clasp');assert.equal(args._market,'whatnot');
 }finally{await page.close();}
});
