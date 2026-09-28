import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit} from '@playwright/test';
const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w.-]+$/.test(name))return res.writeHead(404).end();
  try{let content=await readFile(new URL(name,root));if(name.endsWith('.html'))content=content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,tag=>/src="(?:inventory-receiving|add-inventory|print-stations|additem-dymolabel)\.js/.test(tag)?tag:'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
});
after(async()=>{await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await browser.close();});
async function open(t,query=''){
 const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 await context.addInitScript(()=>{
  const user={id:'worker',email:'worker@example.invalid'};window.lucide={createIcons(){}};window.calls=[];window.authFail=false;window.failSave='';window.deniedSave=false;
  window.testItems=[{id:'watch',title:'Tissot watch',barcode:'000123',photos:[],weight:48,labels_per_order:1},{id:'coin',title:'Silver collector coin',barcode:'COIN123',photos:[],weight:31.1,labels_per_order:1}];
  const locations=[{id:'tray',location_name:'Show tray',location_code:'TRAY1',store_id:'store',active:true,is_tray:true,location_role:'tray',max_capacity:100},{id:'parent',location_name:'Vault',location_code:'VAULT',store_id:'store',active:true,is_tray:false,location_role:'storage_location'},{id:'box',location_name:'Coin box',location_code:'BOX1',store_id:'store',active:true,is_tray:false,location_role:'container',parent_location_id:'parent'}];
  window.supabase={auth:{getSession:async()=>({data:{session:{user}}}),signInWithPassword:async args=>{window.calls.push({name:'auth',email:args.email});return window.authFail?{error:{message:'Incorrect password'}}:{data:{user,session:{user}}};}},storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:''}})})},from(table){
   const filters=[];let limit=1000,range=null;
   const q={select(){return q;},update(){return q;},eq(k,v){filters.push(row=>row[k]===v);return q;},is(k,v){filters.push(row=>v===null?row[k]==null:row[k]===v);return q;},in(k,v){filters.push(row=>v.includes(row[k]));return q;},ilike(k,v){const term=v.slice(1,-1).replace(/\\([\\%_])/g,'$1').toLowerCase();filters.push(row=>String(row[k]).toLowerCase().includes(term));return q;},order(){return q;},range(a,b){range=[a,b];return q;},limit(v){limit=v;return q;},maybeSingle:async()=>({data:{role:'admin',active:true}}),then(resolve){let rows=table==='item_types'?window.testItems:table==='locations'?locations:table==='store_locations'?[{id:'store',name:'Showroom',active:true}]:table==='item_stock_locations'?[{item_id:'watch',quantity:4,location_id:'tray',condition_status:'good'},{item_id:'coin',quantity:2,location_id:'tray',condition_status:'good'}]:[];rows=rows.filter(row=>filters.every(f=>f(row)));if(range)rows=rows.slice(range[0],range[1]+1);return Promise.resolve({data:rows.slice(0,limit),error:null}).then(resolve);}};return q;
  },rpc:async(name,args)=>{
   window.calls.push({name,args});const receipts=JSON.parse(localStorage.getItem('mock-receipts')||'{}');
   if(name==='get_inventory_receiving_receipt')return {data:receipts[args._request_id]||null};
   if(name==='receive_inventory_batch'){
    if(window.deniedSave)return {error:{code:'22023',message:'This batch exceeds the destination capacity'}};
    if(window.failSave==='before'){window.failSave='';return {error:{message:'Connection lost'}};}
    const result=receipts[args._request_id]||{request_id:args._request_id,location_id:args._location_id,location_name:locations.find(l=>l.id===args._location_id).location_name,quantity_added:args._lines.reduce((n,l)=>n+l.quantity,0),lines:args._lines.map(l=>({item_id:l.item_id,title:window.testItems.find(i=>i.id===l.item_id).title,quantity_added:l.quantity,quantity_after:l.quantity+(l.item_id==='watch'?4:2),transaction_id:'tx-'+l.item_id}))};
    if(!receipts[args._request_id])localStorage.setItem('mock-commits',String(Number(localStorage.getItem('mock-commits')||0)+1));receipts[args._request_id]=result;localStorage.setItem('mock-receipts',JSON.stringify(receipts));
    if(window.failSave==='after'){window.failSave='';return {error:{message:'Response lost'}};}return {data:result};
   }
   return {data:null};
  }};
 });const page=await context.newPage();page.setDefaultTimeout(10000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));await page.goto(origin+'/add-inventory.html'+query);if(query.includes('mode=count'))await page.waitForFunction(()=>window.showPasswordConfirmModal);else await page.locator('#receive-location option[value=tray]').waitFor({state:'attached'});return page;
}
async function scan(page,barcode){await page.locator('#receive-search').fill(barcode);await page.locator('#receive-find').click();await page.waitForFunction(()=>document.getElementById('receive-search').value==='');}
async function prepare(page){await page.locator('#receive-location').selectOption('tray');await scan(page,'000123');}
async function save(page){await page.locator('#receive-save').click();await page.locator('#receive-password').fill('test password');await page.locator('.receiving-confirm button[type=submit]').click();}

test('existing items save together with entered quantities, one password confirmation and one RPC',async t=>{
 const page=await open(t);await prepare(page);await page.locator('[data-quantity=watch]').fill('5');await page.locator('#receive-search').fill('collector');await page.locator('#receive-find').click();await page.locator('[data-add-item=coin]').click();await page.locator('[data-quantity=coin]').fill('3');await page.locator('.receiving-notes summary').click();await page.locator('#receive-notes').fill('New shipment');await save(page);await page.locator('#receive-receipt:visible').waitFor();
 const calls=await page.evaluate(()=>window.calls);const writes=calls.filter(c=>c.name==='receive_inventory_batch');assert.equal(writes.length,1);assert.equal(await page.evaluate(()=>JSON.stringify(localStorage).includes('test password')),false);assert.deepEqual(writes[0].args._lines,[{item_id:'watch',quantity:5},{item_id:'coin',quantity:3}]);assert.equal(writes[0].args._notes,'New shipment');assert.equal(writes[0].args._location_id,'tray');assert.equal(calls.filter(c=>c.name==='auth').length,1);assert.match(await page.locator('#receive-receipt').innerText(),/8 units saved/);assert.equal(await page.locator('#receive-location').inputValue(),'tray');assert.equal(await page.locator('.print-station-dialog').count(),0);
 await page.locator('[data-print=watch]').click();await page.locator('#inventory-label-print-modal:not(.hidden)').waitFor();assert.match(await page.locator('#inventory-label-print-summary').innerText(),/5 units of Tissot watch/);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_inventory_batch').length),1);
});
test('repeated barcode scans increment the draft once per explicit scan and removal can be undone',async t=>{
 const page=await open(t);await prepare(page);await scan(page,'000123');assert.equal(await page.locator('[data-quantity=watch]').inputValue(),'2');await page.locator('[data-remove=watch]').click();assert.equal(await page.locator('[data-line]').count(),0);await page.locator('#receive-undo').click();assert.equal(await page.locator('[data-quantity=watch]').inputValue(),'2');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_inventory_batch').length),0);
});
test('phone interruptions restore quantities and the quick-add link never adds again on reload',async t=>{
 const page=await open(t,'?mode=quick-add&barcode=000123');await page.locator('[data-line=watch]').waitFor();await page.locator('#receive-location').selectOption('box');await page.locator('[data-quantity=watch]').fill('7');await page.reload();await page.locator('[data-line=watch]').waitFor();assert.equal(await page.locator('[data-quantity=watch]').inputValue(),'7');assert.equal(await page.locator('#receive-location').inputValue(),'box');assert.match(await page.locator('#receive-status').innerText(),/restored/);assert.match(page.url(),/add-inventory.html$/);
});
test('lost acknowledgement locks the draft and recovers its receipt after reload without adding stock twice',async t=>{
 const page=await open(t);await prepare(page);await page.evaluate(()=>window.failSave='after');await save(page);await page.waitForFunction(()=>document.getElementById('receive-status').textContent.includes('not confirmed'));assert.equal(await page.locator('[data-quantity=watch]').isDisabled(),true);const original=await page.evaluate(()=>window.calls.find(c=>c.name==='receive_inventory_batch').args._request_id);await page.reload();await page.locator('#receive-save').click();await page.locator('#receive-receipt:visible').waitFor();assert.equal(await page.evaluate(()=>localStorage.getItem('mock-commits')),'1');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_inventory_batch').length),0);assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='get_inventory_receiving_receipt').args._request_id),original);
});
test('a request lost before commit retries the same immutable payload and request id',async t=>{
 const page=await open(t);await prepare(page);await page.evaluate(()=>window.failSave='before');await save(page);await page.waitForFunction(()=>document.getElementById('receive-status').textContent.includes('not confirmed'));await page.locator('.receiving-confirm [data-cancel]').click();const original=await page.evaluate(()=>window.calls.find(c=>c.name==='receive_inventory_batch').args);await save(page);await page.locator('#receive-receipt:visible').waitFor();assert.deepEqual(await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_inventory_batch')[1].args),original);assert.equal(await page.evaluate(()=>localStorage.getItem('mock-commits')),'1');
});
test('invalid quantities, wrong password and server validation never clear the unsaved batch',async t=>{
 const page=await open(t);await prepare(page);for(const value of ['0','1.5','-1','1000000','']){await page.locator('[data-quantity=watch]').fill(value);assert.equal(await page.locator('#receive-save').isDisabled(),true);}await page.locator('[data-quantity=watch]').fill('2');await page.evaluate(()=>window.authFail=true);await save(page);await page.waitForFunction(()=>document.querySelector('[data-confirm-status]').textContent.includes('Incorrect password'));assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_inventory_batch').length),0);await page.locator('.receiving-confirm [data-cancel]').click();await page.evaluate(()=>{window.authFail=false;window.deniedSave=true;});await save(page);await page.waitForFunction(()=>document.querySelector('[data-confirm-status]').textContent.includes('capacity'));await page.locator('.receiving-confirm [data-cancel]').click();assert.equal(await page.locator('[data-quantity=watch]').inputValue(),'2');assert.equal(await page.locator('[data-quantity=watch]').isDisabled(),false);
});
test('location scans select the matching container and show its parent storage',async t=>{
 const page=await open(t);await page.locator('#receive-location-search').fill('BOX1');await page.locator('#receive-location-find').click();assert.equal(await page.locator('#receive-location').inputValue(),'box');assert.match(await page.locator('#receive-location-info').innerText(),/Showroom.*Vault.*Coin box/);assert.equal(await page.locator('#receive-location option[value=parent]').count(),0);
});
test('mobile layout fits 320 pixels and treats catalog names as text',async t=>{
 const page=await open(t);await page.setViewportSize({width:320,height:740});await page.evaluate(()=>window.testItems[0].title='<img src=x onerror="window.injected=true"> watch');await prepare(page);assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../test-results/receiving-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});await page.locator('#receive-save').click();assert.ok(await page.locator('.receiving-confirm').evaluate(el=>el.scrollWidth<=el.clientWidth));
});

test('undo after re-adding the same item combines quantities rather than creating duplicate lines',async t=>{
 const page=await open(t);await prepare(page);await page.locator('[data-quantity=watch]').fill('3');await page.locator('[data-remove=watch]').click();await scan(page,'000123');await page.locator('#receive-undo').click();assert.equal(await page.locator('[data-line=watch]').count(),1);assert.equal(await page.locator('[data-quantity=watch]').inputValue(),'4');
});

test('scan-counting mode retains its UI but ordinary stock writes use the atomic receiving RPC',async t=>{
 const page=await open(t,'?mode=count');assert.equal(await page.locator('#inventory-receiving').isVisible(),false);
 await page.evaluate(()=>{const card=document.createElement('div');document.getElementById('batch-items-container').append(card);const batchItem={item:window.testItems[0],count:2,cardEl:card};currentBatch['000123']=batchItem;window.showPasswordConfirmModal(batchItem,'tray','Show tray',2);});
 await page.locator('#password-confirm-password').fill('test password');await page.locator('#btn-confirm-password').click();await page.locator('#inventory-label-print-modal:not(.hidden)').waitFor();const writes=await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_inventory_batch'));assert.equal(writes.length,1);assert.deepEqual(writes[0].args._lines,[{item_id:'watch',quantity:2}]);assert.equal(await page.locator('#batch-items-container').innerText(),'');
});
