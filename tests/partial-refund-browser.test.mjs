import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,expect} from '@playwright/test';
const root=new URL('../',import.meta.url);let browser,server,origin;
before(async()=>{
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(path)||path.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(path,root));if(path.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,{width=1366,role='manager'}={}){
 const context=await browser.newContext({viewport:{width,height:1000}});t.after(()=>context.close());await context.route('**/*',r=>r.request().url().startsWith(origin)?r.continue():r.abort());
 const page=await context.newPage();page.setDefaultTimeout(5000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(origin+'/pending-orders.html');await page.addScriptTag({url:origin+'/pending-orders.js'});await page.addScriptTag({url:origin+'/pending-partial-refunds.js'});
 await page.evaluate(async role=>{
  window.calls=[];window.passwordCalls=0;window.failure='';window.hold=false;
  state.user={id:'manager',email:'manager@example.test'};state.employee={active:true,role};
  state.orders=[{id:'line-a',order_id:'order-a',item_title:'#300 — Watch auction',quantity:1,fulfilled_quantity:0,line_status:'pending',video_receipt_photo_count:1,raw_payload:{},order:{id:'order-a',order_number:'03-00000-12345',buyer_username:'fixture-buyer',status:'pending',raw_payload:{orderPaymentStatus:'PAID',ebayFinance:{transactions:[{transactionId:'refund-1',transactionType:'REFUND',transactionStatus:'FUNDS_AVAILABLE',amount:100}]}}}}];
  window.review={order_id:'order-a',order_number:'03-00000-12345',items:[{id:'line-a',title:'#300 — Watch auction',quantity:1}],snapshot:{order:{transactions:[{transactionId:'refund-1',amount:100}]},lines:[{id:'line-a'}]},reviewable:true,approval:null};
  window.supabase={auth:{signInWithPassword:async({password})=>{passwordCalls++;return password==='bad'?{error:{message:'Invalid password'}}:{data:{user:{id:'manager'}}};}},rpc:async(name,args)=>{
   if(name==='get_ebay_partial_refund_reviews')return {data:[structuredClone(review)]};
   calls.push({name,args:structuredClone(args)});
   if(hold)await new Promise(r=>window.release=r);
   if(failure)return {error:{message:failure}};
   if(name==='approve_ebay_partial_refund'){review.approval={id:'approval',by:'manager@example.test',at:'2026-10-22T02:00:00Z',reason:args._reason};return {data:review.approval};}
   throw Error('Unexpected write '+name);
  }};
  window.paint=()=>{
   const line=state.orders[0];document.getElementById('orders-list').innerHTML=`<div class="buyer-line-copy"><h2>Order ${review.order_number}</h2><p>${line.item_title}</p><span class="fulfillment-blocked">${getLineFulfillmentBlock(line)}</span>${OGPartialRefunds.markup(line)}<button id="fixture-complete" ${isNoInventoryCompletionLine(line)?'':'disabled'}>Complete order</button></div>`;
   document.querySelector('[data-review-partial-refund]')?.addEventListener('click',()=>OGPartialRefunds.open(line));
  };
  loadOrders=async()=>{await OGPartialRefunds.load(state.orders);paint();};await loadOrders();
 },role);
 return page;
}
async function fill(page,password='correct'){
 await page.locator('#partial-refund-reason').fill('Verified $100 partial refund for a price adjustment; ship the watch.');
 await page.locator('#partial-refund-verified').check();await page.locator('#partial-refund-password').fill(password);
}
for(const width of [390,1366])test(`partial refund review at ${width}px verifies password, saves the exact snapshot and enables ordinary completion`,async t=>{
 const page=await open(t,{width});await expect(page.locator('#fixture-complete')).toBeDisabled();
 await page.getByRole('button',{name:'Review partial refund',exact:true}).click();await expect(page.locator('#partial-refund-dialog')).toBeVisible();
 await expect(page.locator('#partial-refund-items')).toContainText('#300');await fill(page,'bad');await page.locator('#partial-refund-approve').click();
 await expect(page.locator('#partial-refund-error')).toContainText('Incorrect password');assert.equal(await page.evaluate(()=>calls.length),0);
 await page.locator('#partial-refund-cancel').click();await page.getByRole('button',{name:'Review partial refund',exact:true}).click();await fill(page);await page.screenshot({path:`test-results/partial-refund-review-${width}.png`});
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.ok(await page.locator('#partial-refund-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth+1));
 await page.locator('#partial-refund-approve').click();await expect(page.locator('#partial-refund-dialog')).not.toBeVisible();await expect(page.locator('#fixture-complete')).toBeEnabled();
 await expect(page.locator('.fulfillment-refund-approved')).toContainText('manager@example.test');
 const calls=await page.evaluate(()=>window.calls);assert.equal(calls.length,1);assert.equal(calls[0].name,'approve_ebay_partial_refund');assert.equal(calls[0].args._confirmed,true);assert.equal(calls[0].args._snapshot.order.transactions[0].amount,100);assert.equal(JSON.stringify(calls).includes('correct'),false);
 assert.equal(await page.locator('#partial-refund-password').inputValue(),'');assert.equal(await page.evaluate(()=>state.orders[0].line_status),'pending','approval does not itself fulfill the order');
});
test('cancelling a review performs no write, and workers cannot approve',async t=>{
 const page=await open(t);await page.getByRole('button',{name:'Review partial refund',exact:true}).click();await fill(page);await page.locator('#partial-refund-cancel').click();assert.equal(await page.evaluate(()=>calls.length),0);assert.equal(await page.locator('#partial-refund-password').inputValue(),'');
 await page.evaluate(()=>{state.employee.role='worker';paint();});await expect(page.getByRole('button',{name:'Review partial refund',exact:true})).toHaveCount(0);await page.evaluate(()=>OGPartialRefunds.open(state.orders[0]));await expect(page.locator('#partial-refund-dialog')).not.toBeVisible();
});
test('stale evidence errors retain the reason, clear the password and keep completion blocked',async t=>{
 const page=await open(t);await page.getByRole('button',{name:'Review partial refund',exact:true}).click();await fill(page);await page.evaluate(()=>failure='Refund or order items changed. Reopen the review.');await page.locator('#partial-refund-approve').click();
 await expect(page.locator('#partial-refund-error')).toContainText('changed');await expect(page.locator('#partial-refund-reason')).toHaveValue(/Verified \$100/);await expect(page.locator('#partial-refund-password')).toHaveValue('');await expect(page.locator('#fixture-complete')).toBeDisabled();
});
test('double submissions and closing while approval is in flight are blocked',async t=>{
 const page=await open(t);await page.getByRole('button',{name:'Review partial refund',exact:true}).click();await fill(page);await page.evaluate(()=>hold=true);await page.locator('#partial-refund-approve').click();await expect(page.locator('#partial-refund-cancel')).toBeDisabled();
 await page.keyboard.press('Escape');await expect(page.locator('#partial-refund-dialog')).toBeVisible();assert.equal(await page.evaluate(()=>calls.length),1);await page.evaluate(()=>release());await expect(page.locator('#fixture-complete')).toBeEnabled();
});
test('cached approval stops applying after local refund facts change; known full refunds have no review action',async t=>{
 const page=await open(t);await page.evaluate(async()=>{review.approval={by:'manager@example.test',at:new Date().toISOString(),reason:'Verified'};await loadOrders();});await expect(page.locator('#fixture-complete')).toBeEnabled();
 await page.evaluate(()=>{state.orders[0].order.raw_payload.orderPaymentStatus='FULLY_REFUNDED';paint();});await expect(page.locator('#fixture-complete')).toBeDisabled();await expect(page.getByRole('button',{name:'Review partial refund',exact:true})).toHaveCount(0);
});
