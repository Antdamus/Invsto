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
 await page.route('https://cdn.jsdelivr.net/npm/@supabase/supabase-js',route=>route.fulfill({contentType:'text/javascript',body:`window.supabase={createClient(){return {auth:{getSession:async()=>({data:{session:{user:{id:'fixture-user',email:'staff@fixture.test'}}}})},from(){const q={select(){return q},order(){return q},eq(){return q},maybeSingle:async()=>({data:null}),range:async()=>({data:[]}),limit:async()=>({data:[]})};return q}}}};`}));
 await page.goto(origin+'/pending-tiktok-orders.html?boot=1');
 await expect(page.locator('#tk-status')).toContainText('Import your first');await expect(page.locator('#tk-orders')).toContainText('No TikTok orders imported yet');assert.deepEqual(errors,[]);await page.close();
});
async function setup(page,{receiptId='',cancellations=false,view=''}={}){
 await page.goto(origin+'/pending-tiktok-orders.html'+(receiptId?'?tiktokReceipt='+receiptId:view?'?view='+view:''));
 await page.evaluate(()=>{
  const tables={tiktok_orders:[],tiktok_order_lines:[],tiktok_order_imports:[],tiktok_order_events:[],tiktok_order_documents:[],tiktok_order_receipt_photos:[]};window.fixtureTables=tables;window.fixtureCalls=[];
  window.supabase={auth:{signInWithPassword:async({password})=>password==='fixture-password'?{data:{user:{id:'fixture-user'}}}:{error:{message:'Invalid login'}},getSession:async()=>({data:{session:{user:{id:'fixture-user',email:'staff@fixture.test'}}}})},from(name){if(!name.startsWith('tiktok_'))throw Error('Cross-marketplace access: '+name);let matches=tables[name]||[];const q={select(){return q;},order(){return q;},in(k,values){matches=matches.filter(x=>values.includes(x[k]));return q;},eq(k,v){matches=matches.filter(x=>x[k]===v);return q;},range(a,b){return Promise.resolve({data:matches.slice(a,b+1)});},limit(n){return Promise.resolve({data:matches.slice(0,n)});},then(resolve){return Promise.resolve({data:matches}).then(resolve);}};return q;},rpc:async(name,args)=>{if(name==='can_access_tiktok_messages')return {data:true};if(name==='list_tiktok_order_chat_markers')return {data:args._order_ids.map(id=>({order_id:id,buyer_linked:true,chats:[]}))};if(name==='can_revert_order_fulfillment')return {data:true};window.fixtureCalls.push({name,args});if(name==='import_tiktok_orders'){for(const r of args._rows){tables.tiktok_orders.push({...r,id:'order-1',revision:1,stage:'pending',notes:'',source_snapshot_at:args._snapshot_at});tables.tiktok_order_lines.push({...r,id:'line-1',order_id:'order-1'});}tables.tiktok_order_imports.push({filename:args._filename,snapshot_at:args._snapshot_at,imported_at:new Date().toISOString()});return {data:{added:1,refreshed:0,stale:0,history_skipped:0}};}if(name==='update_tiktok_order'){Object.assign(tables.tiktok_orders[0],{stage:args._stage,notes:args._notes,ship_by_date:args._ship_by,revision:2});return {data:tables.tiktok_orders[0]};}throw Error('Unexpected RPC '+name);}};
 });
 for(const src of ['vendor/pdf-lib/pdf-lib.min.js','tiktok-order-import.js','tiktok-order-packet.js','marketplace-queue-cards.js','tiktok-order-queue.js','tiktok-receipt-photos.js','tiktok-shipping.js','tiktok-tasks.js','tiktok-order-chats.js',...(cancellations?['tiktok-cancellations.js']:[]),'tiktok-orders.js'])await page.addScriptTag({url:origin+'/'+src});
 await expect(page.locator('#tk-status')).toContainText('Import your first');
}

async function chatFixture(page){
 await setup(page);await page.evaluate(()=>{
  for(const [id,buyer] of [['a','morgan.ell'],['b','morgan.ell'],['c','other.buyer'],['d','no.chat']]){
   fixtureTables.tiktok_orders.push({id,order_number:'57762072399823328'+id.charCodeAt(0),buyer_username:buyer,recipient_name:id==='d'?'No saved conversation':id==='c'?'Taylor Lee':'Morgan Ellis',stage:'pending',marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',ship_by_date:'2026-11-07',order_amount:45});
   fixtureTables.tiktok_order_lines.push({id:'line-'+id,order_id:id,title:'925 Silver Ring · '+id.toUpperCase(),quantity:1,sku_id:'1732759903849189622'});
  }
  window.chatRows={a:{order_id:'a',buyer_linked:true,chats:[{id:'chat-morgan',unread_count:2,synced_at:new Date().toISOString(),latest_message_at:new Date().toISOString()}]},b:{order_id:'b',buyer_linked:true,chats:[]},c:{order_id:'c',buyer_linked:true,chats:[{id:'chat-taylor',unread_count:0,synced_at:new Date().toISOString()}]},d:{order_id:'d',buyer_linked:false,chats:[]}};chatRows.b.chats=chatRows.a.chats;
  window.chatFailure=false;window.chatAllowed=true;window.markerCalls=[];window.chatListeners=[];
  supabase.channel=()=>({on(type,filter,callback){chatListeners.push(callback);return this;},subscribe(callback){callback('SUBSCRIBED');return this;}});supabase.removeChannel=async()=>{};
  const previous=supabase.rpc;supabase.rpc=async(name,args)=>{if(name==='can_access_tiktok_messages')return {data:chatAllowed};if(name==='list_tiktok_order_chat_markers'){markerCalls.push(args);return chatFailure?{error:{message:'Offline'}}:{data:args._order_ids.map(id=>chatRows[id])};}return previous(name,args);};
 });await page.locator('#tk-refresh').click();await expect(page.locator('.tk-buyer.has-tk-unread-chat')).toHaveCount(1);
}

test('TikTok chat colors deduplicate buyer counts, mark each line, preserve selections and open exact buyer chat',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1050}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await chatFixture(page);
 const card=page.locator('[data-buyer-key="morgan.ell"]');await expect(card.locator('.tk-chat-badge')).toHaveText('Buyer chat · 2 unread');await expect(page.locator('[data-buyer-key="other.buyer"] .tk-chat-badge')).toHaveClass(/has-chat/);
 await expect(page.locator('[data-buyer-key="no.chat"] .tk-chat-badge')).toHaveText('Buyer chat · buyer ID needed');
 await card.locator('[data-label-buyer]').check();await card.getByRole('button',{name:'Open',exact:true}).click();await expect(card.locator('.tk-order-item.has-tk-unread-chat')).toHaveCount(2);
 const link=card.locator('[data-tiktok-line="line-a"] .tk-chat-badge');await expect(link).toHaveAttribute('href','tiktok-messages.html?order=a&conversation=chat-morgan');await expect(link).toHaveAttribute('target','_blank');
 await page.evaluate(()=>{chatRows.a.chats[0].unread_count=3;chatListeners.forEach(fn=>fn());});await expect(link).toHaveText('Buyer chat · 3 unread');await expect(card.locator('[data-label-buyer]')).toBeChecked();await expect(card).toHaveClass(/is-expanded/);
 await page.evaluate(()=>{chatRows.a.chats[0].unread_count=0;window.dispatchEvent(new Event('focus'));});await expect(link).toHaveClass(/has-chat/);await expect(card.locator('.tk-order-item.has-tk-unread-chat')).toHaveCount(0);
 assert.equal((await page.evaluate(()=>fixtureCalls)).some(c=>/read|send|triage/.test(c.name)),false);assert.deepEqual(errors,[]);await page.close();
});

test('chat refresh keeps unread alerts on failure and drafts in open orders, recovers, and fits phones',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1050}});await chatFixture(page);const card=page.locator('[data-buyer-key="morgan.ell"]');await card.getByRole('button',{name:'Open',exact:true}).click();await card.getByRole('button',{name:'Open order',exact:true}).first().click();await page.locator('#tk-order-notes').fill('Packing work remains here');
 await page.evaluate(()=>{chatFailure=true;window.dispatchEvent(new Event('online'));});await expect(page.locator('#tk-chat-status')).toContainText('unavailable');await expect(page.locator('#tk-detail .tk-chat-badge')).toContainText('2 unread · Check updates');await expect(page.locator('#tk-order-notes')).toHaveValue('Packing work remains here');
 await page.evaluate(()=>{chatFailure=false;chatRows.a.chats[0].unread_count=0;window.dispatchEvent(new Event('focus'));});await expect(page.locator('#tk-detail .tk-chat-badge')).toHaveClass(/has-chat/);await expect(page.locator('#tk-order-notes')).toHaveValue('Packing work remains here');await page.locator('#tk-close-detail').click();
 await page.evaluate(()=>{chatRows.a.chats[0].unread_count=2;window.dispatchEvent(new Event('focus'));});await expect(card.locator('.tk-chat-badge').first()).toContainText('2 unread');
 await page.evaluate(()=>{const banner=document.createElement('p');banner.textContent='PREVIEW · SYNTHETIC DEMO ORDERS';banner.style='color:#ffe3a0;font-weight:bold';document.querySelector('#tk-chat-status').before(banner);});
 await mkdir(new URL('../output/tiktok-messages/',import.meta.url),{recursive:true});await card.screenshot({path:'output/tiktok-messages/order-chat-desktop.png'});
 await page.setViewportSize({width:390,height:844});await expect(card.locator('.tk-chat-badge').first()).toBeVisible();await page.screenshot({path:'output/tiktok-messages/order-chat-mobile.png',fullPage:true});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth)).toBe(false);
 await page.evaluate(()=>{chatAllowed=false;window.dispatchEvent(new Event('focus'));});await expect(card.locator('.tk-chat-badge').first()).toContainText('access required');await expect(card).not.toHaveClass(/has-tk-unread-chat/);await page.close();
});

test('old TikTok chat sync stays visibly stale, and returning to a filtered buyer fetches fresh counts',async()=>{
 const page=await browser.newPage();await chatFixture(page);await page.locator('#tk-search').fill('other.buyer');await expect(page.locator('.tk-buyer')).toHaveCount(1);
 await page.evaluate(()=>{chatRows.a.chats[0].unread_count=5;chatRows.a.chats[0].synced_at='2020-01-01T00:00:00Z';});await page.locator('#tk-search').fill('morgan.ell');await expect(page.locator('.tk-chat-badge')).toContainText('5 unread · Check updates');await expect(page.locator('#tk-chat-status')).toContainText('sync is delayed');await page.close();
});
test('customer name and username remain visible in collapsed summaries and every line on desktop and mobile',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:950}});await setup(page);await page.evaluate(()=>{
  for(const [id,name,nickname] of [['a','Pat Rivera','Pat shop'],['b','Jamie Rivera',''],['c','','Taylor Shop']]){fixtureTables.tiktok_orders.push({id,order_number:'57762072399823328'+({a:'1',b:'2',c:'3'}[id]),buyer_username:'shared-buyer',recipient_name:name,buyer_nickname:nickname,stage:'pending',marketplace_status:'To ship'});fixtureTables.tiktok_order_lines.push({id:'line-'+id,order_id:id,title:'Ring '+id,quantity:1,sku_id:'1732759903849189622'});}
 });await page.locator('#tk-refresh').click();const card=page.locator('.tk-buyer');await expect(card).toContainText('Pat Rivera · Jamie Rivera · Taylor Shop');await expect(card).toContainText('shared-buyer');await expect(card.locator('.tk-order-item')).toHaveCount(0);
 await page.getByRole('button',{name:'shared-buyer',exact:true}).click();for(const [id,name] of [['a','Pat Rivera'],['b','Jamie Rivera'],['c','Taylor Shop']]){const line=page.locator(`[data-tiktok-line="line-${id}"]`);await expect(line.locator('.tk-customer-identity')).toContainText(name);await expect(line.locator('.tk-customer-identity')).toContainText('@shared-buyer');}
 await page.getByRole('searchbox',{name:'Search TikTok orders'}).fill('Jamie Rivera');await expect(card.locator('.tk-order-item')).toHaveCount(3);
 await page.setViewportSize({width:390,height:844});await expect.poll(()=>page.locator('body').evaluate(el=>el.scrollWidth<=innerWidth)).toBe(true);await expect(card.locator('.tk-buyer-customer')).toBeVisible();await card.scrollIntoViewIfNeeded();await card.screenshot({animations:'disabled',path:new URL('../outputs/tiktok-pipeline/customer-names-mobile.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});await page.close();
});
test('front TikTok tasks retain exact order/item context, require an owner, handle errors and prevent double submission',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:950}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);
 await page.evaluate(()=>{
  for(const id of ['a','b']){fixtureTables.tiktok_orders.push({id,order_number:'57762072399823328'+(id==='a'?'1':'2'),buyer_username:'task-buyer',stage:'pending',marketplace_status:'To ship'});for(const suffix of ['1','2'])fixtureTables.tiktok_order_lines.push({id:id+suffix,order_id:id,title:'Jewelry '+id+suffix,quantity:1,sku_id:'1732765489814737'+(id==='a'?'1':'2')+suffix});}
  const previous=supabase.rpc;window.taskWrites=[];window.failTask=true;
  supabase.rpc=async(name,args)=>{
   if(name==='list_team_task_assignees')return {data:[{user_id:'worker',display_name:'Pat',role:'employee'}]};
   if(name==='create_task_request'){taskWrites.push(args);await new Promise(r=>setTimeout(r,100));if(failTask){failTask=false;return {error:{message:'Connection interrupted'}};}return {data:{id:'created-task'}};}
   return previous(name,args);
  };
 });
 await page.locator('#tk-refresh').click();await expect(page.locator('.tk-buyer')).toHaveCount(1);await page.setViewportSize({width:390,height:844});const card=page.locator('.tk-buyer');
 await expect(card.locator('[data-tk-task-buyer]')).toBeVisible();await card.locator('[data-tk-task-buyer]').click();
 const dialog=page.locator('.tk-task-dialog');await expect(dialog.locator('[name=title]')).toBeEnabled();
 await dialog.locator('[name=order]').selectOption('b');await expect(dialog.locator('[data-context]')).toContainText('Whole order · 2 item lines');
 await dialog.locator('[name=title]').fill('Check package');await dialog.locator('[name=instructions]').fill('Confirm contents before shipping.');
 await dialog.locator('button[type=submit]').click();assert.equal(await page.evaluate(()=>taskWrites.length),0);
 await dialog.locator('[name=owner]').selectOption('worker');await dialog.locator('[name=kind]').selectOption('decision');
 await dialog.locator('button[type=submit]').click();await expect(dialog.locator('[data-status]')).toContainText('Connection interrupted');await expect(dialog.locator('[name=instructions]')).toHaveValue('Confirm contents before shipping.');
 await dialog.locator('form').evaluate(form=>{form.requestSubmit();form.requestSubmit();});await expect(dialog.getByRole('link',{name:'Open task'})).toHaveAttribute('href','team-tasks.html?taskId=created-task');
 const writes=await page.evaluate(()=>taskWrites);assert.equal(writes.length,2);assert.equal(writes[1]._source,'team');assert.equal(writes[1]._request_kind,'decision');assert.equal(writes[1]._details._assigned_to_user_id,'worker');assert.match(writes[1]._details._description,/Order: 577620723998233282/);assert.match(writes[1]._details._description,/Line b1/);assert.match(writes[1]._details._description,/Line b2/);assert.doesNotMatch(writes[1]._details._description,/Line a1/);
 await dialog.locator('[data-close]').click();await card.getByRole('button',{name:'Open',exact:true}).click();
 const item=card.locator('.tk-order-item').first();await expect(item.locator('[data-tk-task-line]')).toBeVisible();await expect(item.locator('[data-tk-line-finish]')).toBeVisible();await expect(card.locator('[data-tk-task-order]:not([data-tk-task-line])').first()).toBeVisible();
 await item.locator('[data-tk-task-line]').click();await expect(dialog.locator('[name=title]')).toBeEnabled();await expect(dialog.locator('[data-context]')).toContainText('This item only · 1 item line');await expect(dialog.locator('[data-context]')).toContainText('Jewelry a1');
 await dialog.locator('[name=title]').fill('Locate bag');await dialog.locator('[name=instructions]').fill('Check the shelf.');await dialog.locator('[name=owner]').selectOption('worker');await dialog.locator('button[type=submit]').click();await expect(dialog.getByRole('link',{name:'Open task'})).toBeVisible();
 const itemTask=await page.evaluate(()=>taskWrites.at(-1));assert.equal(itemTask._request_kind,'work');assert.match(itemTask._details._description,/Line a1/);assert.doesNotMatch(itemTask._details._description,/Line a2|Line b/);
 await dialog.locator('[data-close]').click();assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await mkdir(new URL('../test-results/',import.meta.url),{recursive:true});await card.screenshot({path:'test-results/tiktok-front-actions-mobile.png'});
 await page.evaluate(()=>{const previous=supabase.rpc;supabase.rpc=async(name,args)=>name==='list_team_task_assignees'?{error:{message:'Offline'}}:previous(name,args);});
 await card.locator('[data-tk-task-buyer]').click();await expect(dialog.locator('[data-status]')).toContainText('Offline');await expect(dialog.locator('button[type=submit]')).toBeDisabled();await dialog.locator('[data-close]').click();
 assert.deepEqual(errors,[]);await page.close();
});

test('TikTok preview, import, preparation/history and packet download use only TikTok data on desktop and mobile',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});const errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page);
 await expect(page.getByRole('navigation',{name:'Order marketplace'}).getByRole('link')).toHaveText(['eBay','TikTok','Whatnot']);
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

test('shipping buttons prepare single buyers and selected batches, including siblings hidden by an order search',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);
 await page.evaluate(()=>{
  const t=fixtureTables;for(const [id,number,buyer] of [['a','577620684385522369','one'],['b','577620723998233281','one'],['c','577620723998233282','two']]){t.tiktok_orders.push({id,order_number:number,buyer_username:buyer,marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',stage:'pending'});t.tiktok_order_lines.push({id:'line-'+id,order_id:id,title:'Jewelry',quantity:1});}
  window.opened=[];window.closedPopups=0;window.open=()=>({opener:null,close(){closedPopups++;},location:{replace:url=>opened.push(url)}});
  window.extensionVersion='1.0.20';window.addEventListener('message',e=>{if(e.data?.type==='OG_EBAY_EXTENSION_VERSION_REQUEST')window.postMessage({type:'OG_EBAY_EXTENSION_VERSION_RESPONSE',requestId:e.data.requestId,version:extensionVersion},location.origin);});
 });
 await page.locator('#tk-refresh').click();await expect(page.getByRole('button',{name:'Create combined label',exact:true})).toHaveCount(1);await expect(page.getByRole('button',{name:'Create shipping label',exact:true})).toHaveCount(1);
 await page.locator('#tk-search').fill('577620684385522369');await page.getByRole('button',{name:'Create combined label',exact:true}).click();await expect.poll(()=>page.evaluate(()=>opened.length)).toBe(1);
 assert.equal(new URLSearchParams(new URL(await page.evaluate(()=>opened[0])).hash.slice(1)).get('ogLabels'),'577620684385522369;577620723998233281');
 await page.locator('#tk-search').fill('');await page.locator('#tk-label-batch>summary').click();await page.getByRole('button',{name:'Select visible buyers',exact:true}).click();await expect(page.locator('#tk-label-selection')).toContainText('2 buyers · 3 orders');await page.locator('#tk-create-labels').click();await expect.poll(()=>page.evaluate(()=>opened.length)).toBe(2);
 assert.equal(new URLSearchParams(new URL(await page.evaluate(()=>opened[1])).hash.slice(1)).get('ogLabels').split(';').length,3);
 await page.getByRole('button',{name:'Clear selection',exact:true}).click();await expect(page.locator('#tk-create-labels')).toBeDisabled();
 await page.evaluate(()=>extensionVersion='1.0.19');await page.getByRole('button',{name:'Create shipping label',exact:true}).click();await expect(page.locator('#tk-status')).toContainText('v1.0.20');assert.equal(await page.evaluate(()=>opened.length),2);assert.equal(await page.evaluate(()=>closedPopups),1);await page.close();
});

test('missing saved PDFs offer retrieval or mixed creation and stop offering saved labels',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);
 await page.evaluate(()=>{
  const t=fixtureTables;
  for(const [id,buyer,substatus] of [['a','existing-buyer','Awaiting collection'],['b','mixed-buyer','Awaiting collection'],['c','mixed-buyer','Awaiting shipment']]){
   t.tiktok_orders.push({id,order_number:'57762072399823328'+id.charCodeAt(0),buyer_username:buyer,marketplace_status:'To ship',marketplace_substatus:substatus,stage:'pending'});
   t.tiktok_order_lines.push({id:'line-'+id,order_id:id,title:'Jewelry',quantity:1,tracking_number:substatus==='Awaiting collection'?'9234690390470913256596':''});
  }
 });
 await page.locator('#tk-refresh').click();await expect(page.getByRole('button',{name:'Get shipping label',exact:true})).toHaveCount(1);await expect(page.getByRole('button',{name:'Create / get labels',exact:true})).toHaveCount(1);
 await page.locator('#tk-label-batch>summary').click();await page.getByRole('button',{name:'Select visible buyers',exact:true}).click();await expect(page.locator('#tk-label-selection')).toContainText('2 buyers · 3 orders');
 await page.screenshot({animations:'disabled',path:new URL('../outputs/tiktok-pipeline/tiktok-label-recovery.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});
 await page.evaluate(()=>fixtureTables.tiktok_order_documents.push({id:'doc-a',order_id:'a',kind:'label',path:'saved.pdf'}));await page.locator('#tk-refresh').click();await expect(page.getByRole('button',{name:'Get shipping label',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Create / get labels',exact:true})).toHaveCount(1);await page.close();
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
 await page.locator('#tk-refresh').click();await page.locator('#tk-search').fill('different-buyer');await page.locator('#tk-refine>summary').click();await page.locator('#tk-stage-filter').selectOption('waiting');
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
 await page.locator('[data-mq-key=overdue]').click();await expect(page.locator('.tk-buyer')).toHaveCount(1);const card=page.locator('.tk-buyer');await expect(card).toHaveClass(/is-overdue/);await expect(card).toContainText('2 orders');await expect(card.locator('.tk-buyer-meta .mq-shipping-label')).toHaveText('Shipping label attached · 1 of 2 orders');await expect(card.locator('.tk-buyer-meta .mq-shipping-label')).toHaveClass(/is-partial/);
 await card.locator('.tk-expand-button').click();
 await expect(card.locator('[data-tiktok-order="1"] .mq-order-summary .mq-shipping-label')).toHaveText('No shipping label attached');
 await expect(card.locator('[data-tiktok-order="2"] .mq-order-summary .mq-shipping-label')).toHaveText('Shipping label attached');
 await card.locator('.tk-expand-button').click();
 await card.locator('.tk-card-tools > summary').click();await expect(card).toHaveClass(/is-collapsed/);await card.getByRole('button',{name:'Open video receipts',exact:true}).click();await expect(card.locator('.tk-card-tools')).not.toHaveAttribute('open','');await expect(page.locator('#tk-buyer-tools a').filter({hasText:'Open video receipt'})).toHaveCount(2);const links=await page.locator('#tk-buyer-tools a').filter({hasText:'Open video receipt'}).evaluateAll(nodes=>nodes.map(n=>n.href));assert.ok(links.every(l=>l.includes('seller-us.tiktok.com/order/detail?order_no=57762364879664333')&&l.includes('ogReceipt=1')));await page.locator('#tk-close-buyer-tools').click();
 await card.getByRole('button',{name:'Shipping labels',exact:true}).click();await expect(page.locator('#tk-buyer-tools')).toContainText('Alice-order-2.pdf');await expect(page.locator('#tk-buyer-tools')).not.toContainText('Packing.pdf');await page.getByRole('button',{name:'Print shipping label',exact:true}).click();assert.deepEqual(await page.evaluate(()=>window.printCalls),[{path:'tiktok-orders/fixture/label.pdf',title:'TikTok shipping label'}]);await page.locator('#tk-close-buyer-tools').click();
 await page.locator('[data-mq-key=unknown]').click();await expect(page.locator('.tk-buyer')).toHaveCount(1);await expect(page.locator('.tk-buyer')).toContainText('Carol');await expect(page.locator('.tk-buyer')).not.toHaveClass(/is-overdue/);
 await page.locator('.tk-buyer-meta [data-buyer-tool=dates]').click();await expect(page.locator('#tk-buyer-tools')).toContainText('Date needed');await page.getByRole('button',{name:'Edit ship-by date',exact:true}).click();await expect(page.locator('#tk-order-deadline')).toBeVisible();
 await page.close();
});

test('purchase-date filter keeps whole buyer bundles on mobile and clear restores the queue',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page);
 await page.evaluate(()=>{for(const [id,buyer,created_time] of [['1','Alice','10/16/2026 11:59:00 PM'],['2','alice','10/17/2026 12:01:00 AM'],['3','Alice','10/18/2026 12:01:00 AM'],['4','Bob','10/16/2026']]){fixtureTables.tiktok_orders.push({id,order_number:'57762364879664333'+id,buyer_username:buyer,created_time,marketplace_status:'To ship',stage:'pending',revision:1});fixtureTables.tiktok_order_lines.push({id:'line-'+id,order_id:id,sku_id:'173276548981473714'+id,title:'Ring '+id,quantity:1});}});
 await page.locator('#tk-refresh').click();await page.setViewportSize({width:390,height:844});await expect(page.locator('.tk-buyer')).toHaveCount(2);await page.locator('#tk-refine>summary').click();await page.locator('#tk-purchase-date').fill('2026-10-17');await expect(page.locator('.tk-buyer')).toHaveCount(1);await expect(page.locator('.tk-buyer')).toContainText('3 orders');await page.getByRole('button',{name:'Open',exact:true}).click();await expect(page.locator('.tk-order-row')).toHaveCount(3);await expect(page.locator('.tk-order-item')).toHaveCount(3);
 await page.locator('#tk-reset-queue').click();await expect(page.locator('.tk-buyer')).toHaveCount(2);await expect(page.locator('#tk-purchase-date')).toHaveValue('');
 await page.locator('#tk-data-tools>summary').click();await page.locator('#tk-import-title').click();await expect(page.locator('#tk-import')).toHaveAttribute('open','');await expect(page.locator('#tk-import')).toContainText('All orders under current tab');assert.equal(await page.evaluate(()=>fixtureCalls.length),0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await page.close();
});
test('cancellation requires a valid password, survives save errors and signs only the chosen order once',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page,{cancellations:true});
 await page.evaluate(()=>{for(const id of ['1','2']){fixtureTables.tiktok_orders.push({id,order_number:'57762364879664333'+id,buyer_username:'Alice',marketplace_status:'To ship',stage:'pending',revision:7});fixtureTables.tiktok_order_lines.push({id:'line-'+id,order_id:id,sku_id:'173276548981473714'+id,title:'Ring '+id,quantity:1});}const previous=supabase.rpc;window.cancelWrites=[];window.failCancellation=true;supabase.rpc=async(name,args)=>{if(name!=='sign_tiktok_cancellations')return previous(name,args);cancelWrites.push(args);await new Promise(r=>setTimeout(r,80));if(failCancellation){failCancellation=false;return {error:{message:'Connection interrupted'}};}Object.assign(fixtureTables.tiktok_orders.find(o=>o.id===args._order_ids[0]),{marketplace_status:'Canceled',revision:8,cancellation_signed_at:'2026-10-18',cancellation_record:{source:'manual'}});return {data:{}};};});
 await page.locator('#tk-refresh').click();await page.setViewportSize({width:390,height:844});await page.getByRole('button',{name:'Open',exact:true}).click();await page.locator('[data-tk-confirm-cancel="1"]').click();const d=page.locator('.tk-cancellation-dialog');await expect(d).toBeVisible();await expect(d).toContainText('577623648796643331');await expect(d).toContainText('other open orders');await d.locator('button[type=submit]').click();assert.equal(await page.evaluate(()=>cancelWrites.length),0);
 await d.locator('[name=password]').fill('wrong-password');await d.locator('button[type=submit]').click();await expect(d.locator('[data-status]')).toContainText('Incorrect password');assert.equal(await page.evaluate(()=>cancelWrites.length),0);await d.locator('[name=reason]').fill('Buyer cancellation confirmed in TikTok');await d.locator('[name=password]').fill('fixture-password');await d.locator('button[type=submit]').click();await expect(d.locator('[data-status]')).toContainText('Connection interrupted');await expect(d.locator('[name=reason]')).toHaveValue('Buyer cancellation confirmed in TikTok');await d.locator('[name=password]').fill('fixture-password');await d.locator('form').evaluate(f=>{f.requestSubmit();f.requestSubmit();});await expect(d).toHaveCount(0);await expect(page.locator('#tk-status')).toContainText('audit is saved');await expect(page.locator('.tk-buyer')).toContainText('1 order');await expect(page.locator('[data-tk-confirm-cancel="1"]')).toHaveCount(0);await expect(page.locator('[data-tk-confirm-cancel="2"]')).toBeVisible();const calls=await page.evaluate(()=>cancelWrites);assert.equal(calls.length,2);assert.deepEqual(calls[1],{_order_ids:['1'],_line_ids:[],_revisions:{'1':7},_note:'Buyer cancellation confirmed in TikTok'});assert.deepEqual(errors,[]);await page.close();
});
test('manual extension fallback opens native export without submitting a report',async()=>{
 const page=await browser.newPage();await page.route('https://seller-us.tiktok.com/**',r=>r.fulfill({contentType:'text/html',body:'<button data-log_click_for="all" data-log_module_name="order_list_tab" onclick="this.textContent=\'All selected\'">All</button><button data-log_click_for="export_entry" onclick="this.textContent=\'Export opened\'">Export</button>'}));await page.goto('https://seller-us.tiktok.com/order');await page.addScriptTag({content:await readFile(new URL('../tools/ebay-og-order-link-extension/tiktok-orders.js',import.meta.url),'utf8')});const panel=page.locator('#og-tiktok-order-tools');await panel.locator('summary').click();await expect(panel.getByRole('button',{name:'Export all → OG'})).toBeVisible();await panel.getByRole('button',{name:'Open export manually'}).click();await expect(page.locator('[data-log_click_for=export_entry]')).toHaveText('Export opened');await expect(panel).toContainText('Missing rows never imply cancellation');await page.close();
});

test('front buyer, order and item cancellation actions retain exact scope and show cancelled badges',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page,{cancellations:true});
 await page.evaluate(()=>{
  for(const id of ['1','2','3']){fixtureTables.tiktok_orders.push({id,order_number:'57762364879664333'+id,buyer_username:'Alice',marketplace_status:id==='3'?'Canceled':'To ship',stage:'pending',revision:7});fixtureTables.tiktok_order_lines.push({id:'line-'+id,order_id:id,sku_id:'173276548981473714'+id,title:'Ring '+id,quantity:1});}
  fixtureTables.tiktok_order_lines.push({id:'extra',order_id:'1',sku_id:'1732765489814737145',title:'Necklace',quantity:2});
  const previous=supabase.rpc;supabase.rpc=async(name,args)=>{if(name!=='sign_tiktok_cancellations')return previous(name,args);fixtureCalls.push({name,args});if(args._line_ids.length)Object.assign(fixtureTables.tiktok_order_lines.find(l=>l.id===args._line_ids[0]),{cancelled_at:'2026-10-18',cancellation_signed_at:'2026-10-18'});else for(const o of fixtureTables.tiktok_orders.filter(o=>args._order_ids.includes(o.id)))o.marketplace_status='Canceled';return {data:{}};};
 });
 await page.locator('#tk-refresh').click();await expect(page.locator('#tk-cancelled-link')).toHaveText('Cancellations (1)');await expect(page.locator('.tk-buyer-overview .tk-cancelled-badge')).toHaveCount(0);await expect(page.locator('[data-tk-cancel-buyer="alice"]')).toBeVisible();
 await page.getByRole('button',{name:'Open',exact:true}).click();await expect(page.locator('.tk-order-task-actions [data-tk-confirm-cancel="1"]')).toBeVisible();await page.locator('[data-tk-cancel-line="line-1"]').click();let d=page.locator('.tk-cancellation-dialog');await expect(d).toContainText('Only this item is affected');await expect(d).toContainText('Ring 1');await d.locator('[name=reason]').fill('This SKU was cancelled in TikTok');await d.locator('[name=password]').fill('fixture-password');await d.locator('[type=submit]').click();await expect(d).toHaveCount(0);
 const item=page.locator('[data-tiktok-line="line-1"]');await expect(item).toHaveCount(0);await expect(page.locator('[data-tiktok-line="extra"] [data-tk-line-finish]')).toBeVisible();await expect(page.locator('[data-tiktok-order="1"] .tk-order-heading .tk-cancelled-badge')).toHaveCount(0);
 await page.locator('[data-tk-cancel-buyer="alice"]').click();d=page.locator('.tk-cancellation-dialog');await d.locator('[name=orders][value="1"]').uncheck();await d.locator('[name=reason]').fill('Second order cancelled by buyer');await d.locator('[name=password]').fill('fixture-password');await d.locator('[type=submit]').click();await expect(d).toHaveCount(0);await expect(page.locator('[data-tiktok-order="1"]')).toBeVisible();await expect(page.locator('[data-tiktok-order="2"]')).toHaveCount(0);
 const calls=await page.evaluate(()=>fixtureCalls);assert.equal(calls[0].name,'sign_tiktok_cancellations');assert.deepEqual(calls[0].args._line_ids,['line-1']);assert.deepEqual(calls[1].args._order_ids,['2']);assert.deepEqual(calls[1].args._revisions,{'2':7});await page.close();
});
test('queue Cancellations button counts unsigned orders and opens all cancellations through packing filters',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await setup(page,{cancellations:true});
 await page.evaluate(()=>{
  for(const id of ['1','2','3','4']){
   fixtureTables.tiktok_orders.push({id,order_number:'57762364879664333'+id,buyer_username:'buyer-'+id,marketplace_status:['1','4'].includes(id)?'Canceled':'To ship',stage:'pending',revision:1,created_time:'10/17/2026 11:00:00 AM',cancellation_signed_at:id==='4'?'2026-10-18':null});
   fixtureTables.tiktok_order_lines.push({id:'line-'+id,order_id:id,title:'Jewelry '+id,quantity:1,cancelled_at:id==='2'?'2026-10-18':null,cancellation_signed_at:id==='4'?'2026-10-18':null});
  }
  fixtureTables.tiktok_order_lines.push({id:'active',order_id:'2',title:'Still available',quantity:1});
 });
 await page.locator('#tk-refresh').click();const toggle=page.locator('#tk-cancelled-link');
 await expect(toggle).toBeVisible();await expect(toggle).toHaveClass(/has-cancellations/);await expect(toggle).not.toHaveAttribute('aria-current','page');await expect(toggle).toHaveText('Cancellations (2)');
 await page.locator('#tk-search').fill('buyer-3');await page.locator('#tk-refine>summary').click();await page.locator('#tk-stage-filter').selectOption('waiting');await page.locator('[data-mq-key=missing_watch]').click();await page.locator('#tk-purchase-date').fill('2026-10-01');await page.locator('[data-mq-key="overdue"]').click();await expect(page.locator('.tk-buyer')).toHaveCount(0);
 await toggle.click();await expect(toggle).toHaveAttribute('aria-current','page');await expect(page).toHaveURL(/view=cancellations/);await expect(page.locator('#tk-queue-title')).toHaveText('Cancellations');
 for(const id of ['tk-search','tk-stage-filter','tk-work-filter','tk-purchase-date'])await expect(page.locator('#'+id)).toHaveValue('');
 await expect(page.locator('.tk-buyer')).toHaveCount(2);await expect(page.locator('#tk-orders')).toContainText('buyer-1');await expect(page.locator('#tk-orders')).toContainText('buyer-2');await expect(page.locator('#tk-orders')).not.toContainText('buyer-3');await expect(page.locator('#tk-orders')).not.toContainText('buyer-4');await expect(page.locator('#tk-label-batch')).toBeHidden();
 await page.locator('[data-tk-cancel-buyer="buyer-1"]').click();const dialog=page.locator('.tk-cancellation-dialog');await expect(dialog).toContainText('577623648796643331');await expect(dialog.locator('[name=password]')).toBeVisible();await dialog.locator('[data-close]').click();
 await toggle.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('../outputs/tiktok-pipeline/cancellation-button-desktop.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});
 await page.setViewportSize({width:390,height:844});await expect(toggle).toBeVisible();await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);await toggle.scrollIntoViewIfNeeded();await page.screenshot({path:new URL('../outputs/tiktok-pipeline/cancellation-button-mobile.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1')});
 await page.locator('#tk-pending-link').click();await expect(toggle).not.toHaveAttribute('aria-current','page');await expect(page).not.toHaveURL(/view=/);await expect(page.locator('#tk-queue-title')).toHaveText('Orders to Pack');await expect(page.locator('.tk-buyer')).toHaveCount(2);await expect(page.locator('#tk-orders')).not.toContainText('buyer-1');await expect(page.locator('#tk-label-batch')).toBeVisible();await expect(page.locator('[data-mq-type="due"][data-mq-key="all"]')).toHaveAttribute('aria-pressed','true');
 await toggle.click();await page.evaluate(()=>{for(const o of fixtureTables.tiktok_orders)o.cancellation_signed_at='2026-10-18';for(const l of fixtureTables.tiktok_order_lines)l.cancellation_signed_at='2026-10-18';});await page.locator('#tk-phone-refresh').click();await expect(toggle).toHaveText('Cancellations (0)');await expect(toggle).not.toHaveClass(/has-cancellations/);await expect(page.locator('.tk-buyer')).toHaveCount(0);await page.locator('#tk-pending-link').click();await expect(page.locator('#tk-queue-title')).toHaveText('Orders to Pack');assert.deepEqual(errors,[]);await page.close();
});

test('Cancelled view highlights full and partial cancellations on desktop and mobile',async()=>{
 const page=await browser.newPage({viewport:{width:1440,height:1000}});await setup(page,{cancellations:true,view:'cancelled'});
 await page.evaluate(()=>{for(const id of ['1','2','3']){fixtureTables.tiktok_orders.push({id,order_number:'57762364879664333'+id,buyer_username:id==='1'?'cancelled-buyer':'mixed-buyer',marketplace_status:id==='1'?'Canceled':'To ship',stage:'pending',revision:1});fixtureTables.tiktok_order_lines.push({id:'line-'+id,order_id:id,sku_id:'173276548981473714'+id,title:'Jewelry '+id,quantity:1,cancelled_at:id==='2'?'2026-10-18':null});}fixtureTables.tiktok_order_lines.push({id:'active',order_id:'2',sku_id:'1732765489814737149',title:'Still available',quantity:1});});
 await page.locator('#tk-refresh').click();await expect(page.locator('#tk-title')).toHaveText('TikTok Cancellations');await expect(page.locator('#tk-cancelled-link')).toHaveAttribute('aria-current','page');await expect(page.getByRole('link',{name:/^Cancellations/})).toHaveCount(1);await expect(page.locator('.tk-buyer')).toHaveCount(2);await expect(page.locator('.tk-buyer-overview .tk-cancelled-badge')).toHaveCount(2);await page.locator('[data-expand="cancelled-buyer"]').first().click();await expect(page.locator('[data-tiktok-order="1"] .tk-order-heading .tk-cancelled-badge')).toHaveText('Cancelled');await expect(page.locator('[data-tiktok-line="line-1"]')).toHaveClass(/is-cancelled/);await page.locator('[data-expand="mixed-buyer"]').first().click();await expect(page.locator('[data-tiktok-order="3"]')).toHaveCount(0);await expect(page.locator('[data-tiktok-line="active"]')).toHaveCount(0);await expect(page.locator('[data-tiktok-finish]:visible')).toHaveCount(0);await expect(page.locator('[data-tk-confirm-cancel="2"]')).toHaveCount(0);
 await page.screenshot({path:new URL('../outputs/tiktok-pipeline/cancellation-desktop.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});await page.setViewportSize({width:390,height:844});await page.screenshot({path:new URL('../outputs/tiktok-pipeline/cancellation-mobile.png',import.meta.url).pathname.replace(/^\/(.:)/,'$1'),fullPage:true});await expect.poll(()=>page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1)).toBe(false);await page.screenshot({path:new URL('../outputs/tiktok-pipeline/cancellation-mobile.png',import.meta.url).pathname.replace(/^\/(\w:)/,'$1'),fullPage:true});await page.close();
});

test('work cards show line values, allocated fees and shipping, and limit a buyer to matching lines',async()=>{
 const page=await browser.newPage({viewport:{width:390,height:844}});await setup(page);
 await page.evaluate(()=>{
  const o={id:'demo',order_number:'577600000000009001',buyer_username:'demo.buyer',stage:'pending',marketplace_status:'To ship',ship_by_date:'2020-10-01',order_amount:33,buyer_shipping:3,referral_basis:33};
  fixtureTables.tiktok_orders.push(o);
  fixtureTables.tiktok_order_receipt_photos.push(...['p1','p2'].map(id=>({id,line_id:'two',path:id})),{id:'old',line_id:'one',removed_at:'2026-10-01',files_deleted_at:'2026-10-01'});
  for(const [id,title,price] of [['one','Watch',20],['two','Earrings',10]])fixtureTables.tiktok_order_lines.push({id,order_id:o.id,title,line_amount:price,quantity:1});
 });
 await page.locator('#tk-phone-refresh').click();
 const watches=page.locator('[data-mq-key="watches"]');await expect(watches).toContainText('$20.00');
 for(const width of [390,1366]){
  await page.setViewportSize({width,height:850});await page.evaluate(()=>scrollTo(0,0));
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await expect(page.locator('.mq-deadline-grid button')).toHaveCount(4);
  await expect(page.locator('[data-mq-key=tomorrow]')).toBeInViewport({ratio:1});
  await expect(page.locator('.mq-metrics:visible')).toHaveCount(1);
  await expect(page.locator('#tk-work-filter')).toBeHidden();
  await page.screenshot({path:'outputs/tiktok-pipeline/order-queue-'+width+'.png',animations:'disabled',fullPage:true});
 }
 await page.setViewportSize({width:390,height:844});
 await page.locator('[data-mq-key=no_screenshot]').click();
 await expect(page.locator('.tk-order-item')).toHaveCount(1);
 await expect(page.locator('.tk-order-item h4')).toHaveText('Watch');
 await expect(page.locator('.mq-order-summary')).toContainText('2 order lines · 2 items · Showing 1 of 2');
 await expect(page.locator('.mq-order-summary')).toContainText('1 line needs a screenshot');
 await expect(page.locator('.tk-order-item .mq-coverage')).toHaveText('Needs screenshot');
 assert.ok((await page.locator('.tk-order-item h4').boundingBox()).y<(await page.locator('.tk-item-media').boundingBox()).y);
 await page.locator('.tk-order-row').screenshot({path:'outputs/tiktok-pipeline/queue-line-phone.png'});
 await watches.click();
 await expect(page.locator('.tk-order-item')).toHaveCount(1);await expect(page.locator('.tk-order-item')).toContainText('Watch');
 await expect(page.locator('.mq-metrics div').filter({hasText:'Shipping collected'}).locator('dd')).toHaveText('$2.00');await expect(page.locator('.mq-metrics div').filter({hasText:'Est. fees'}).locator('dd')).toHaveText('$1.32');await expect(page.locator('.mq-metrics')).toHaveCount(1);await expect(page.locator('#tk-money-cards')).not.toContainText('Shipping collected');
 await page.locator('[data-mq-key="overdue"]').click();await expect(page.locator('[data-mq-key="overdue"]')).toHaveAttribute('aria-pressed','true');
 await page.locator('[data-context]').click();await expect(page.locator('.tk-order-item')).toHaveCount(2);await expect(page.locator('#tk-selection-totals')).toContainText('1 item line');
 await page.locator('#tk-reset-queue').click();await expect(page.locator('#tk-selection-totals')).toContainText('$30.00');
 await page.close();
});
