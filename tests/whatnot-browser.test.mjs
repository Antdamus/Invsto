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
 const lines=[1,2].map(n=>({id:'900'+n,order_id:order.id,title:n===1?'925 Silver Earrings — exact purchased item':'Gold bracelet',quantity:1,unit_price:25,currency:'USD',ship_by_date:'2026-10-29',tracking_number:'9400111000000000001234',shipment_status:'label_generated',carrier:'USPS',work_state:'pending',revision:1,holds:[],item_missing:n===1,scope:'pending',order_record:order}));
 window.calls=[];window.fixtureLines=lines;
 return {auth:{getUser:async()=>({data:{user:{id:'user'}}})},functions:{invoke:async(name,{body})=>{calls.push({name,body});return {data:{admin:true,configured:true,connection:{seller_name:'ogjewelers',enabled:true,last_synced_at:'2026-10-31T16:00:00Z',last_full_sync_at:'2026-10-31T16:00:00Z'}}}}},
 rpc:async(name,args)=>{calls.push({name,args});if(name==='can_manage_inventory')return {data:true};if(name==='whatnot_workspace'){const ls=args._filter==='missing'?lines.filter(l=>l.item_missing):lines;return {data:{groups:[{buyer_key:'9',buyer:'fixture_buyer',customer:'Fixture Customer',lines:ls}],buyers:1,visible_lines:ls.length,visible_items:ls.length,counts:{pending:2,review:0,history:0},filters:{all:2,missing:1,cgl:0,overdue:2,today:0,tomorrow:0,no_tracking:0,unknown:0}}};}if(name==='whatnot_work_action')return {data:{updated:args._lines.length}};throw Error('Unexpected RPC '+name);},
 from(name){if(!name.startsWith('whatnot_'))throw Error('Cross marketplace query');const q={select(){return q},overlaps(){return q},in(){return q},eq(){return q},order(){return q},limit:async()=>({data:[]}),range:async()=>({data:[]}),then(r){return Promise.resolve({data:[]}).then(r)}};return q;}};
 }}` }));
 await page.goto(origin+'/pending-whatnot-orders.html');await expect(page.locator('#wn-status')).toContainText('Saved orders loaded');
}
test('desktop and phone queues show exact lines, customer name, due urgency and tracking',async()=>{
 const page=await browser.newPage({viewport:{width:1366,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await fixture(page);
 await expect(page.locator('.wn-line')).toHaveCount(2);await expect(page.locator('.wn-buyer')).toContainText('Fixture Customer');await expect(page.locator('.wn-line').first()).toContainText('Overdue');
 await page.screenshot({path:'output/whatnot/queue-desktop.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.equal(await page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth),true);
 await page.locator('[data-filter="missing"]').click();await expect(page.locator('.wn-line')).toHaveCount(1);await expect(page.locator('#wn-count')).toContainText('1 matching order lines');
 await page.screenshot({path:'output/whatnot/queue-phone.png',fullPage:true});
 await page.getByRole('button',{name:'Select shown items'}).click();await page.getByRole('button',{name:'Add note',exact:true}).click();
 await page.locator('#wn-value').fill('Checked tray 12; item is missing.');await page.locator('#wn-action-submit').click();
 const update=await page.evaluate(()=>calls.find(c=>c.name==='whatnot_work_action'));assert.equal(update.args._lines.length,1);assert.equal(update.args._lines[0].id,'9001');assert.deepEqual(errors,[]);await page.close();
});
test('completion needs explicit physical check and receipt links retain exact item identity',async()=>{
 const page=await browser.newPage();await fixture(page);const href=await page.getByRole('link',{name:'Video receipt ↗'}).first().getAttribute('href');assert.match(href,/#invsto-receipt=9001&order=1484060355$/);
 await page.locator('[data-select-line="9002"]').check();await page.getByRole('button',{name:'Complete selected'}).click();await page.locator('#wn-action-submit').click();await expect(page.locator('#wn-action-error')).toContainText('Confirm');
 assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='whatnot_work_action').length),0);
 await page.locator('#wn-confirm').check();await page.locator('#wn-action-submit').click();assert.deepEqual(await page.evaluate(()=>calls.find(c=>c.name==='whatnot_work_action').args._lines),[{id:'9002',revision:1}]);await page.close();
});
test('token form sends only to authenticated edge connection and clears on close',async()=>{
 const page=await browser.newPage();await fixture(page);await page.getByRole('button',{name:'Reconnect Whatnot'}).click();await page.locator('#wn-token').fill('test-only-token');await page.getByRole('button',{name:'Connect account & start sync'}).click();await expect(page.locator('#wn-token')).toHaveValue('');
 assert.equal(await page.evaluate(()=>localStorage.getItem('whatnotToken')),null);assert.equal(await page.evaluate(()=>calls.filter(c=>c.name==='whatnot-order-sync'&&c.body.action==='connect').length),1);await page.close();
});
test('report has buyer and item indexes, tracking and receipt links without inventing refunds',async()=>{
 const page=await browser.newPage();await fixture(page);const opened=page.waitForEvent('popup');await page.getByRole('button',{name:'Shown items report / PDF'}).click();const report=await opened;
 await expect(report.locator('h1')).toContainText('Whatnot items in this view');await expect(report.locator('.item')).toHaveCount(2);await expect(report.getByText('Refund amounts are not supplied',{exact:false})).toBeVisible();
 assert.equal(await report.locator('a[href="#directory"]').count()>1,true);await expect(report.locator('body')).toContainText('Fixture Customer');await expect(report.locator('body')).toContainText('$25.00');
 await report.screenshot({path:'output/whatnot/report-preview.png',fullPage:true});await report.close();await page.close();
});
test('Whatnot shadow-player capture identifies the exact order and crops the visible video',async()=>{
 const page=await browser.newPage({viewport:{width:1000,height:800}});
 await page.route('https://www.whatnot.com/**',r=>r.fulfill({contentType:'text/html',body:'<section>Order #1484060355 <button aria-label="Close order details">Close</button></section><hls-video></hls-video>'}));
 await page.goto('https://www.whatnot.com/dashboard/orders/opaque#invsto-receipt=1484056123&order=1484060355');
 await page.evaluate(()=>{const h=document.querySelector('hls-video');h.attachShadow({mode:'open'}).innerHTML='<video style="display:block;width:250px;height:440px"></video>';const v=h.shadowRoot.querySelector('video');Object.defineProperty(v,'readyState',{get:()=>2});Object.defineProperty(v,'videoWidth',{get:()=>250});window.chrome={runtime:{sendMessage:async m=>{window.captureRequest=m;return {ok:true}}}};});
 await page.addScriptTag({content:await readFile(new URL('../tools/ebay-og-order-link-extension/whatnot-receipt-capture.js',import.meta.url),'utf8')});
 await page.getByRole('button',{name:'Capture item photo → Invsto'}).click();await expect(page.getByText('Sent to Invsto.',{exact:false})).toBeVisible();
 const request=await page.evaluate(()=>captureRequest);assert.equal(request.itemId,'1484056123');assert.equal(request.orderNumber,'1484060355');assert.equal(request.rect.width,250);assert.equal(request.rect.height,440);await page.close();
});
