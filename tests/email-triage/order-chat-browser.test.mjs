import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin;
const root=new URL('../../',import.meta.url),lineId='11111111-1111-4111-8111-111111111111';
before(async()=>{
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(path)||path.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(path,root));if(path.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width,{chats=0,preferred=false,from='pending',requested=''}={}){
 const context=await browser.newContext({viewport:{width,height:844}});t.after(()=>context.close());
 await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(6500);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(`${origin}/email-triage.html?orderLineId=${lineId}&from=${from}&conversationId=${encodeURIComponent(requested)}`);await page.addScriptTag({url:origin+'/email-triage.order-chat.js'});
 await page.evaluate(async({chats,preferred,lineId})=>{
  window.calls=[];window.opened=[];window.sendResult={ok:true,delivery_status:'sent',conversation_id:'new-chat'};
  window.fixtureData={ok:true,line:{id:lineId,item_title:'#049 · 10K gold chain',quantity:1,item_number:'287611495563'},order:{id:'order',order_number:'12-12457-65265',buyer_username:'jewelrybuyer'},conversations:Array.from({length:chats},(_,i)=>({id:'chat-'+i,match:preferred?'listing':'buyer',conversation_title:i?'Certificate inquiry':'Shipping update',latest_message_preview:'Could you check the certificate for my chain?',latest_message_created_at:'2026-10-08T18:30:00Z'})),preferred_conversation_id:preferred?'chat-0':null};
  window.EmailTriageApi={requestEbayConversationDraftAction:async(_ctx,args)=>{calls.push(args);if(args.mode==='order_chat_context'){if(window.loadFailure)throw Error('Unable to load chats.');return fixtureData;}if(window.delaySend)await new Promise(r=>window.finishSend=r);if(window.sendFailure)throw Error('Connection interrupted');return sendResult;}};
  await InvstoOrderChat.init({}, {openConversation:async(id,buyer)=>{opened.push({id,buyer});}});
 },{chats,preferred,lineId});return page;
}
const noOverflow=async page=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
test('pending chat marker opens only a server-verified buyer conversation',async t=>{
 const page=await open(t,390,{chats:2,requested:'chat-1'});assert.deepEqual(await page.evaluate(()=>opened),[{id:'chat-1',buyer:'jewelrybuyer'}]);
 const invalid=await open(t,390,{chats:2,requested:'someone-else-chat'});assert.deepEqual(await invalid.evaluate(()=>opened),[]);
});
for(const width of [320,390,1366])test(`${width}px: order context, existing chat choices and new composer are usable`,async t=>{
 const page=await open(t,width,{chats:2});await expect(page.getByRole('heading',{name:'jewelrybuyer'})).toBeVisible();await expect(page.locator('.order-chat-choice')).toHaveCount(2);await noOverflow(page);
 await page.screenshot({path:`test-results/order-chat-${width}-choices.png`});
 await page.getByRole('button',{name:'Start a new chat for this item'}).click();await expect(page.getByLabel('New message to jewelrybuyer')).toBeFocused();await page.getByLabel('New message to jewelrybuyer').fill('Please confirm which size you need.');
 await page.locator('[data-order-chat-open]').first().click();await expect(page.locator('.ebay-conversation-section')).toBeVisible();assert.equal((await page.evaluate(()=>calls.filter(c=>c.mode==='start_order_chat'))).length,0);
 await page.getByRole('button',{name:'Other chats for this buyer'}).click();await page.getByRole('button',{name:'Start a new chat for this item'}).click();await expect(page.getByLabel('New message to jewelrybuyer')).toHaveValue('Please confirm which size you need.');await noOverflow(page);
 await page.screenshot({path:`test-results/order-chat-${width}-composer.png`});
 await page.evaluate(()=>{document.querySelector('textarea').value='';document.querySelector('textarea').dispatchEvent(new Event('input',{bubbles:true}));});
});
test('unique exact chat opens directly, ambiguous chats require a choice, source return stays correct',async t=>{
 const page=await open(t,390,{chats:1,preferred:true,from:'packaging'});assert.deepEqual(await page.evaluate(()=>opened),[{id:'chat-0',buyer:'jewelrybuyer'}]);await expect(page.getByRole('link',{name:'← Back to packaging'})).toHaveAttribute('href','packaging.html?buyer_order=order');assert.equal((await page.evaluate(()=>calls)).length,1);
});
test('first send requires explicit submit; uncertain response preserves request key and blocks double click',async t=>{
 const page=await open(t,390);await expect(page.getByLabel('New message to jewelrybuyer')).toBeVisible();await page.getByLabel('New message to jewelrybuyer').fill('We are checking your order.');
 await page.evaluate(()=>{delaySend=true;sendFailure=true;});await page.getByRole('button',{name:'Send to buyer'}).click();await expect(page.getByRole('button',{name:'Send to buyer'})).toBeDisabled();await page.evaluate(()=>finishSend());await expect(page.locator('[data-order-chat-status]')).toContainText('Connection interrupted');await expect(page.getByLabel('New message to jewelrybuyer')).toHaveValue('We are checking your order.');
 await page.evaluate(()=>{delaySend=false;sendFailure=false;});await page.getByRole('button',{name:'Send to buyer'}).click();await expect(page.locator('[data-order-chat-status]')).toContainText('Message sent.');const calls=await page.evaluate(()=>window.calls.filter(c=>c.mode==='start_order_chat'));assert.equal(calls.length,2);assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[0].orderLineId,lineId);assert.equal(calls[0].sendConfirmed,true);
});
test('unconfirmed delivery blocks the composer and never claims the message was sent',async t=>{
 const page=await open(t,390);await page.evaluate(()=>sendResult={ok:true,delivery_status:'unknown'});await page.getByLabel('New message to jewelrybuyer').fill('Hello');await page.getByRole('button',{name:'Send to buyer'}).click();await expect(page.locator('.order-chat-delivery')).toContainText('Delivery is uncertain');await expect(page.getByRole('button',{name:'Send to buyer'})).toHaveCount(0);assert.deepEqual(await page.evaluate(()=>opened),[]);
});
