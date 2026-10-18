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
async function setup(page){
 await page.goto(origin+'/pending-tiktok-orders.html');
 await page.evaluate(()=>{
  const tables={tiktok_orders:[],tiktok_order_lines:[],tiktok_order_imports:[],tiktok_order_events:[],tiktok_order_documents:[]};window.fixtureTables=tables;window.fixtureCalls=[];
  window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:'fixture-user'}}}})},from(name){if(!name.startsWith('tiktok_'))throw Error('Cross-marketplace access: '+name);let matches=tables[name]||[];const q={select(){return q;},order(){return q;},in(k,values){matches=matches.filter(x=>values.includes(x[k]));return q;},eq(k,v){matches=matches.filter(x=>x[k]===v);return q;},range(a,b){return Promise.resolve({data:matches.slice(a,b+1)});},limit(n){return Promise.resolve({data:matches.slice(0,n)});},then(resolve){return Promise.resolve({data:matches}).then(resolve);}};return q;},rpc:async(name,args)=>{window.fixtureCalls.push({name,args});if(name==='import_tiktok_orders'){for(const r of args._rows){tables.tiktok_orders.push({...r,id:'order-1',revision:1,stage:'pending',notes:'',source_snapshot_at:args._snapshot_at});tables.tiktok_order_lines.push({...r,id:'line-1',order_id:'order-1'});}tables.tiktok_order_imports.push({filename:args._filename,snapshot_at:args._snapshot_at,imported_at:new Date().toISOString()});return {data:{added:1,refreshed:0,stale:0,history_skipped:0}};}if(name==='update_tiktok_order'){Object.assign(tables.tiktok_orders[0],{stage:args._stage,notes:args._notes,ship_by_date:args._ship_by,revision:2});return {data:tables.tiktok_orders[0]};}throw Error('Unexpected RPC '+name);}};
 });
 for(const src of ['vendor/pdf-lib/pdf-lib.min.js','tiktok-order-import.js','tiktok-order-packet.js','tiktok-order-queue.js','tiktok-orders.js'])await page.addScriptTag({url:origin+'/'+src});
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
