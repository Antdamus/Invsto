import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {before,after,test} from 'node:test';
import {chromium,expect} from '@playwright/test';
const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(path)||path.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(path,root));if(path.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function pageFor(t,file,width){
 const context=await browser.newContext({viewport:{width,height:900}});t.after(()=>context.close());await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));await page.goto(origin+'/'+file);return page;
}
async function ebay(t,width=1366,role='manager'){
 const page=await pageFor(t,'ebay-order-history.html',width);
 await page.evaluate(()=>{
  window.calls=[];window.passwords=[];window.failure=null;window.hold=false;window.reloads=0;
  window.supabase={auth:{signInWithPassword:async args=>{passwords.push(args);return args.password==='bad'?{error:{message:'Invalid'}}:{data:{user:{id:'manager'}}};}},rpc:async(name,args)=>{calls.push({name,args});if(hold)await new Promise(r=>window.release=r);return failure?{error:{message:failure}}:{data:[{reverted_lines:1,restored_units:1}]};}};
 });
 await page.addScriptTag({url:origin+'/ebay-order-history.js'});
 await page.evaluate(role=>{
  state.user={id:'manager',email:'manager@example.test'};state.employee={role,active:true};
  document.body.classList.toggle('history-worker-proof-mode',role!=='admin');
  state.lines=[{id:'line-1',order_id:'order-1',quantity:1,fulfilled_quantity:1,line_status:'fulfilled',item_title:'Gold ring',fulfilled_at:'2026-10-18T12:00:00Z',order:{id:'order-1',order_number:'EBAY-123',buyer_username:'Buyer',status:'fulfilled'}}];
  window.loadOrderHistory=async()=>{reloads++;};
  document.getElementById('confirm-revert').onclick=confirmRevert;document.getElementById('cancel-revert').onclick=closeRevertModal;
  renderHistoryList(buildHistoryGroups(state.lines));
 },role);
 return page;
}
async function tiktok(t,width=1366,allowed=true){
 const page=await pageFor(t,'pending-tiktok-orders.html?view=history',width);
 await page.evaluate(allowed=>{
  window.calls=[];window.passwords=[];window.failure=null;window.hold=false;
  const order={id:'order-1',order_number:'577620684385522369',buyer_username:'buyer',marketplace_status:'Shipped',marketplace_substatus:'In transit',revision:7,stage:'completed',notes:'',source_snapshot_at:'2026-10-18T12:00:00Z'};
  window.tables={tiktok_orders:[order],tiktok_order_lines:[{id:'line-1',order_id:order.id,sku_id:'1732759903849189622',title:'Gold ring',quantity:1}],tiktok_order_documents:[],tiktok_order_events:[],tiktok_order_receipt_photos:[],tiktok_order_imports:[]};
  window.supabase={
   auth:{getSession:async()=>({data:{session:{user:{id:'manager',email:'manager@example.test'}}}}),signInWithPassword:async args=>{passwords.push(args);return args.password==='bad'?{error:{message:'Wrong password'}}:{data:{user:{id:'manager'}}};}},
   from(name){let values=tables[name]||[];const q={select(){return q;},order(){return q;},in(k,v){values=values.filter(r=>v.includes(r[k]));return q;},eq(k,v){values=values.filter(r=>r[k]===v);return q;},range(a,b){return Promise.resolve({data:values.slice(a,b+1)});},limit(n){return Promise.resolve({data:values.slice(0,n)});},then(resolve){return Promise.resolve({data:values}).then(resolve);}};return q;},
   rpc:async(name,args)=>{
    calls.push({name,args});if(name==='can_revert_order_fulfillment')return {data:allowed};
    if(name!=='revert_tiktok_orders')throw Error('Unexpected '+name);
    if(hold)await new Promise(r=>window.release=r);if(failure)return {error:{message:failure}};
    Object.assign(order,{stage:'pending',reopened_at:new Date().toISOString(),revision:8});
    tables.tiktok_order_events.push({id:'audit',order_id:order.id,actor:'manager',action:'order_reverted',created_at:new Date().toISOString(),details:{from:'completed',to:'pending',notes:args._reason,actor_name:'Manager',actor_email:'manager@example.test',actor_role:'manager',restored_units:0}});
    return {data:{reverted_orders:1,restored_units:0}};
   }
  };
  window.TikTokReceiptPhotos={placeholder:()=>'',hydrate(){},start(){}};
 },allowed);
 for(const file of ['tiktok-order-import.js','marketplace-queue-cards.js','tiktok-order-queue.js','tiktok-shipping.js','tiktok-reversal.js','tiktok-orders.js'])await page.addScriptTag({url:origin+'/'+file});
 await expect(page.locator('.tk-expand-button')).toHaveCount(1);await page.locator('.tk-expand-button').click();return page;
}

for(const width of [320,1366])test(`${width}px managers can open eBay order reversal, cancel, validate and sign with their own password`,async t=>{
 const page=await ebay(t,width);if(width<600)await page.locator('[data-history-group-toggle]').click();const button=page.locator('[data-revert-lines]');await expect(button).toBeVisible();await button.click();
 await expect(page.locator('#revert-order-modal')).toBeVisible();await expect(page.locator('#revert-order-list')).toContainText('EBAY-123');
 await page.locator('#confirm-revert').click();await expect(page.locator('#revert-error')).toContainText('note');assert.equal((await page.evaluate(()=>calls)).length,0);
 await page.locator('#cancel-revert').click();await expect(page.locator('#revert-order-modal')).not.toBeVisible();await button.click();
 await page.locator('#revert-note').fill('Completed the wrong order');await page.locator('#revert-password').fill('bad');await page.locator('#confirm-revert').click();await expect(page.locator('#revert-error')).toContainText('Incorrect password');
 await page.locator('#revert-password').fill(' password with spaces ');await page.screenshot({path:`test-results/ebay-manager-reversal-${width}.png`});
 await page.locator('#confirm-revert').click();await expect(page.locator('#revert-order-modal')).not.toBeVisible();
 assert.deepEqual((await page.evaluate(()=>calls))[0],{name:'admin_revert_ebay_order_lines',args:{_order_line_ids:['line-1'],_notes:'Completed the wrong order',_signed_by_email:'manager@example.test'}});
 assert.equal((await page.evaluate(()=>passwords)).at(-1).password,' password with spaces ');assert.equal(await page.evaluate(()=>reloads),1);
});
test('ordinary eBay staff and inactive managers cannot open the reversal; pending save cannot be dismissed or submitted twice',async t=>{
 const page=await ebay(t,1366,'employee');await expect(page.locator('[data-revert-lines]')).toHaveCount(0);
 await page.evaluate(()=>openRevertModal(['line-1']));await expect(page.locator('#revert-order-modal')).not.toBeVisible();
 await page.evaluate(()=>{state.employee={role:'manager',active:false};openRevertModal(['line-1']);});await expect(page.locator('#revert-order-modal')).not.toBeVisible();
 await page.evaluate(()=>{state.employee.active=true;hold=true;openRevertModal(['line-1']);});
 await page.locator('#revert-note').fill('Wrong order');await page.locator('#revert-password').fill('password');await page.locator('#confirm-revert').click();
 await expect(page.locator('#cancel-revert')).toBeDisabled();await page.evaluate(()=>{closeRevertModal();confirmRevert();});await expect(page.locator('#revert-order-modal')).toBeVisible();
 assert.equal((await page.evaluate(()=>calls)).length,1);await page.evaluate(()=>release());await expect(page.locator('#revert-order-modal')).not.toBeVisible();
});
for(const width of [320,1366])test(`${width}px TikTok manager reversal requires reason, signature, confirmation and saves audit visible in order details`,async t=>{
 const page=await tiktok(t,width);await page.locator('[data-tiktok-revert]').click();await expect(page.locator('#tk-revert')).toBeVisible();
 await expect(page.locator('#tk-revert-reason')).toBeFocused();await page.locator('#tk-revert-save').click();await expect(page.locator('#tk-revert-error')).toContainText('3 to 2000');
 await page.keyboard.press('Escape');await expect(page.locator('#tk-revert')).not.toBeVisible();await page.locator('[data-tiktok-revert]').click();
 await page.locator('#tk-revert-reason').fill('Completed wrong order <script>');await page.locator('#tk-revert-password').fill('bad');await page.locator('#tk-revert-confirm').check();
 await page.locator('#tk-revert-save').click();await expect(page.locator('#tk-revert-error')).toContainText('Incorrect');
 assert.equal((await page.evaluate(()=>calls.filter(c=>c.name==='revert_tiktok_orders'))).length,0);
 await page.locator('#tk-revert-password').fill('password');await page.screenshot({path:`test-results/tiktok-manager-reversal-${width}.png`});
 assert.equal(await page.locator('#tk-revert').evaluate(el=>el.scrollWidth>el.clientWidth),false);
 await page.locator('#tk-revert-save').click();await expect(page.locator('#tk-revert')).not.toBeVisible();await expect(page.locator('#tk-status')).toContainText('audit trail is saved');await expect(page.locator('[data-tiktok-revert]')).toHaveCount(0);
 const call=(await page.evaluate(()=>calls.filter(c=>c.name==='revert_tiktok_orders')))[0];assert.deepEqual(call.args,{_order_ids:['order-1'],_revisions:{'order-1':7},_reason:'Completed wrong order <script>',_confirmed:true});
 // After the corrected order is completed again, its reversal remains in history.
 await page.evaluate(()=>{tables.tiktok_orders[0].stage='completed';});await page.locator(width<600?'#tk-phone-refresh':'#tk-refresh').click();
 await page.locator('#tk-orders [data-order]').first().click();
 await expect(page.locator('#tk-detail .tk-history')).toContainText('manager@example.test');
 await expect(page.locator('#tk-detail .tk-history')).toContainText('Completed wrong order <script>');
 await expect(page.locator('#tk-detail .tk-history script')).toHaveCount(0);
});
test('TikTok employees cannot see reversal controls; stale saves retain reason and cannot double-submit',async t=>{
 const employee=await tiktok(t,1366,false);await expect(employee.locator('[data-tiktok-revert]')).toHaveCount(0);
 const page=await tiktok(t);await page.locator('[data-tiktok-revert]').click();await page.locator('#tk-revert-reason').fill('Wrong order');await page.locator('#tk-revert-password').fill('password');
 await page.locator('#tk-revert-save').click();await expect(page.locator('#tk-revert-error')).toContainText('Confirm');
 await page.locator('#tk-revert-confirm').check();await page.evaluate(()=>{hold=true;failure='Order changed. Refresh before reverting.';});await page.locator('#tk-revert-save').click();
 await page.keyboard.press('Escape');await expect(page.locator('#tk-revert')).toBeVisible();await expect(page.locator('#tk-revert-cancel')).toBeDisabled();await page.evaluate(()=>release());
 await expect(page.locator('#tk-revert-error')).toContainText('Order changed');await expect(page.locator('#tk-revert-reason')).toHaveValue('Wrong order');
 assert.equal((await page.evaluate(()=>calls.filter(c=>c.name==='revert_tiktok_orders'))).length,1);
});
