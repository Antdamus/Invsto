import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';
import {chromium,expect} from '@playwright/test';
const shipping=createRequire(import.meta.url)('../tiktok-shipping.js');
const source=await readFile(new URL('../tools/ebay-og-order-link-extension/tiktok-shipping.js',import.meta.url),'utf8');
const a='577620684385522369',b='577620723998233281';let browser;
before(async()=>{browser=await chromium.launch();});after(async()=>{await browser?.close();});
const order=(id,buyer='buyer',extra={})=>({order_number:id,buyer_username:buyer,marketplace_status:'To ship',marketplace_substatus:'Awaiting shipment',stage:'pending',lines:[{quantity:1}],documents:[],...extra});
test('label requests include missing PDFs for new and already-created labels, preserve string IDs, and exclude saved or blocked orders',()=>{
 const orders=[order(a),order(b),order('577620723998233282','other'),order('577620723998233283','buyer',{cancel_return:'Cancellation requested'}),order('577620723998233284','buyer',{marketplace_substatus:'Awaiting collection'}),order('577620723998233285','buyer',{lines:[{tracking_number:'USPS'}]}),order('577620723998233286','buyer',{documents:[{kind:'label'}]}),order('577620723998233287','buyer',{stage:'dispatched'})];
 const r=shipping.request(orders,['buyer']);assert.deepEqual(r.ids,[a,b,'577620723998233284','577620723998233285']);assert.equal(r.buyers,1);assert.equal(new URL(r.url).origin,'https://seller-us.tiktok.com');assert.equal(new URLSearchParams(new URL(r.url).hash.slice(1)).get('ogLabels'),r.ids.join(';'));
 assert.equal(shipping.actionLabel([orders[0]]),'Create shipping label');assert.equal(shipping.actionLabel(orders.slice(0,2)),'Create combined label');assert.equal(shipping.actionLabel([orders[4]]),'Get shipping label');assert.equal(shipping.actionLabel([orders[0],orders[4]]),'Create / get labels');
 assert.equal(shipping.eligible(order(a,'buyer',{cancellation:{pending:true}})),false);
 assert.throws(()=>shipping.request([order(Number(a))],['buyer']),/invalid/);assert.throws(()=>shipping.request([],['buyer']),/No open TikTok orders/);
 assert.throws(()=>shipping.request(Array.from({length:51},(_,i)=>order(String(577620000000000000n+BigInt(i)))),['buyer']),/50 orders/);
});
async function fixture({ids=[a,b],wrongCount=false,blocked=false,missing=false,noHash=false,existing=false,mixed=false,noPanel=false}={}){
 const context=await browser.newContext();const page=await context.newPage();
 await page.route('https://seller-us.tiktok.com/**',r=>r.fulfill({contentType:'text/html',body:`<!doctype html><html><body><input placeholder="Search by order ID. Separate multiple entries with semicolons."><button role="switch" aria-checked="false">AI</button><div role="combobox" aria-controls="sizes">20/Page</div><div id="sizes" hidden><div role="option">50/Page</div></div><table><thead><tr><th></th></tr></thead><tbody></tbody></table><button data-id="fulfillment.manage_order.batch_arrange_shipment">Arrange shipment (0)</button><button data-id="fulfillment.manage_order.batch_print_document">Print documents</button></body></html>`}));
 await page.goto('https://seller-us.tiktok.com/order?shop_region=US'+(noHash?'':'#ogLabels='+encodeURIComponent(ids.join(';'))));
 await page.evaluate(({wrongCount,blocked,missing,existing,mixed,noPanel,b})=>{
  window.nativeCalls={search:[],review:0,print:0,purchase:0,pageSize:0};let searched=[];
  const render=()=>{const size=document.querySelector('[role=combobox]').textContent==='50/Page'?50:20;document.querySelector('tbody').innerHTML=searched.slice(0,missing?1:size).map((id,i)=>`<tr><td><input type="checkbox"></td><td><a href="/order/detail?order_no=${id}">${id}</a></td><td>${blocked&&i===0?'Canceled':existing||(mixed&&id===b)?'Awaiting collection':'Awaiting shipment'}</td></tr>`).join('');
   document.querySelectorAll('input[type=checkbox]').forEach(c=>c.onchange=()=>{const n=document.querySelectorAll('input:checked').length+(wrongCount?1:0);document.querySelector('[data-id]').textContent='Arrange shipment ('+n+')';document.querySelector('th').textContent=`All ${n} orders on this page are selected.`;});};
  document.querySelector('input').onkeydown=e=>{if(e.key==='Enter'){searched=e.target.value.split(';');nativeCalls.search.push(searched);render();}};
  document.querySelector('[role=combobox]').onclick=()=>document.querySelector('#sizes').hidden=false;
  document.querySelector('[role=option]').onclick=()=>{nativeCalls.pageSize++;document.querySelector('[role=combobox]').textContent='50/Page';document.querySelector('#sizes').hidden=true;render();};
  document.querySelector('[data-id]').onclick=()=>{nativeCalls.review++;if(noPanel)return;const single=searched.length===1,d=document.createElement(single?'div':'dialog');d.className=single?'core-drawer':'';d.innerHTML=`<h2>${single?'Arrange shipment':'Combine orders'}</h2><button id="purchase">Buy postage</button>`;document.body.append(d);if(!single)d.showModal();d.querySelector('button').onclick=()=>nativeCalls.purchase++;};
  document.querySelector('[data-id$="batch_print_document"]').onclick=()=>{nativeCalls.print++;const d=document.createElement('dialog');d.innerHTML='<h2>Print document</h2><p>Shipping label</p><button>Print</button>';document.body.append(d);d.showModal();};
 },{wrongCount,blocked,missing,existing,mixed,noPanel,b});
 await page.addScriptTag({content:source});return {page,close:()=>context.close()};
}
test('single and combined requests select exact orders and open only the first shipment review',async()=>{
 for(const ids of [[a],[a,b]]){const f=await fixture({ids});try{await expect(f.page.locator('dialog,.core-drawer')).toBeVisible();await expect(f.page.locator('#og-tiktok-shipping')).toContainText('Print through OG');assert.deepEqual(await f.page.evaluate(()=>nativeCalls),{search:[ids],review:1,print:0,purchase:0,pageSize:0});assert.equal(new URL(f.page.url()).hash,'');}finally{await f.close();}}
});
test('larger batches switch to 50/Page before selecting every requested order',async()=>{
 const ids=Array.from({length:25},(_,i)=>String(577620000000000000n+BigInt(i))),f=await fixture({ids});try{await expect(f.page.locator('dialog,.core-drawer')).toBeVisible();assert.equal(await f.page.locator('input:checked').count(),25);assert.equal(await f.page.evaluate(()=>nativeCalls.pageSize),1);}finally{await f.close();}
});
test('changed statuses and extra selections stop before shipment review',async()=>{
 for(const option of [{blocked:true},{wrongCount:true}]){const f=await fixture(option);try{await expect(f.page.getByRole('button',{name:'Retry preparation'})).toBeVisible();assert.equal(await f.page.evaluate(()=>nativeCalls.review),0);assert.equal(await f.page.evaluate(()=>nativeCalls.purchase),0);}finally{await f.close();}}
});
test('ordinary TikTok visits are untouched and unmatched orders never open a partial batch',async()=>{
 const ordinary=await fixture({noHash:true});assert.equal(await ordinary.page.locator('#og-tiktok-shipping').count(),0);assert.equal(await ordinary.page.evaluate(()=>nativeCalls.search.length),0);await ordinary.close();
 const f=await fixture({missing:true});try{await expect(f.page.getByRole('button',{name:'Retry preparation'})).toBeVisible({timeout:25000});await expect(f.page.locator('#og-tiktok-shipping')).toContainText('did not return every requested order');assert.equal(await f.page.evaluate(()=>nativeCalls.review),0);assert.equal(await f.page.locator('input:checked').count(),0);}finally{await f.close();}
});
test('already-created labels open Print documents instead of failing or buying postage again',async()=>{
 const f=await fixture({existing:true});try{await expect(f.page.getByRole('heading',{name:'Print document'})).toBeVisible();await expect(f.page.locator('#og-tiktok-shipping')).toContainText('already exist');assert.equal(await f.page.evaluate(()=>nativeCalls.review),0);assert.equal(await f.page.evaluate(()=>nativeCalls.print),1);assert.equal(await f.page.evaluate(()=>nativeCalls.purchase),0);assert.deepEqual(await f.page.evaluate(()=>JSON.parse(sessionStorage.getItem('ogTikTokLabelContext')).ids),[a,b]);}finally{await f.close();}
});
test('mixed live statuses offer explicit separate groups and preserve only the chosen label context',async()=>{
 for(const kind of ['create','existing']){const f=await fixture({mixed:true});try{
  const button=f.page.getByRole('button',{name:kind==='create'?'Create new labels (1)':'Get existing labels (1)',exact:true});await expect(button).toBeVisible();assert.equal(await f.page.evaluate(()=>nativeCalls.review+nativeCalls.print),0);assert.equal(await f.page.locator('input:checked').count(),0);
  await button.click();await expect(f.page.locator('dialog,.core-drawer')).toBeVisible();await expect(f.page.locator('#og-tiktok-shipping')).toContainText('Print through OG');
  assert.deepEqual(await f.page.evaluate(()=>JSON.parse(sessionStorage.getItem('ogTikTokLabelContext')).ids),[kind==='create'?a:b]);assert.equal(await f.page.evaluate(()=>nativeCalls.purchase),0);
 }finally{await f.close();}}
});
test('existing-label selection mismatches stop before opening print settings',async()=>{
 const f=await fixture({existing:true,wrongCount:true});try{await expect(f.page.getByRole('button',{name:'Retry preparation'})).toBeVisible();assert.equal(await f.page.evaluate(()=>nativeCalls.print),0);}finally{await f.close();}
});
test('a native action that fails to open review keeps a retry instead of reporting success',async()=>{
 const f=await fixture({noPanel:true});try{await expect(f.page.getByRole('button',{name:'Retry preparation'})).toBeVisible({timeout:25000});await expect(f.page.locator('#og-tiktok-shipping')).toContainText('did not open the shipping panel');assert.notEqual(new URL(f.page.url()).hash,'');}finally{await f.close();}
});
