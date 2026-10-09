import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin;const root=new URL('../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(path)||path.includes('..'))return res.writeHead(404).end();try{let body=await readFile(new URL(path,root));if(path.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':'text/html');res.end(body);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();await mkdir(new URL('test-results/pending-chats/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=390){
 const context=await browser.newContext({viewport:{width,height:844}});t.after(()=>context.close());
 await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(8000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(origin+'/pending-orders.html');await page.addScriptTag({url:origin+'/pending-order-chats.js'});await page.addScriptTag({url:origin+'/pending-orders.js'});
 await page.evaluate(()=>{
  state.user={id:'user',email:'worker@example.test'};state.employee={role:'employee',active:true};isAdminUser=()=>false;
  state.stores=[{id:'store',name:'Main Store'}];state.checkoutStoreId='store';
  state.orders=[{id:'line-a',order_id:'order-a',item_title:'Gold watch with diamond bezel',item_number:'287611495563',line_status:'pending',quantity:1,fulfilled_quantity:0,total_price:899,order:{id:'order-a',order_number:'01-12345-12345',buyer_username:'jewelrylover',sale_date:'2026-10-09T12:00:00Z'}},
  {id:'line-b',order_id:'order-b',item_title:'Silver bracelet',item_number:'287611495564',line_status:'pending',quantity:1,fulfilled_quantity:0,total_price:75,order:{id:'order-b',order_number:'02-12345-12345',buyer_username:'anotherbuyer',sale_date:'2026-10-09T12:00:00Z'}}].map(normalizeLine);
  state.orders.forEach(line=>{state.expandedBuyerKeys.add(getBuyerKey(line));const data={tasks:[],events:[]};state.sharedOrderNoteHistory.set(line.order_id,{data,promise:Promise.resolve(data)});state.queueVideoReceiptLoadedOrderIds.add(line.order_id);});
  window.chatRows=[{line_id:'line-a',buyer_username:'jewelrylover',conversation_ids:['chat-1'],unread_conversation_ids:[],conversation_count:1,unread_count:0,latest_conversation_id:'chat-1',latest_buyer_message_at:'2026-10-09T13:00:00Z',latest_buyer_preview:'Please check the clasp',match_scope:'item'}, {line_id:'line-b',buyer_username:'anotherbuyer',conversation_ids:[],unread_conversation_ids:[],conversation_count:0,unread_count:0}];
  window.chatEvents={};window.rpcCalls=[];
  const channel={on:(_kind,filter,cb)=>{chatEvents[filter.table]=cb;return channel;},subscribe:cb=>{window.chatConnection=cb;cb('SUBSCRIBED');return channel;}};
  window.supabase={channel:()=>channel,removeChannel:async()=>{},rpc:async(name,args)=>{if(name==='list_pending_customer_task_notes')return {data:[]};rpcCalls.push({name,args});if(name!=='list_pending_order_chat_markers')throw Error('Unexpected database action');if(window.failChats)return {error:{message:'Connection lost'}};if(window.delayChats)await new Promise(r=>window.resolveChats=r);return {data:structuredClone(chatRows.filter(r=>args._line_ids.includes(r.line_id)))};}};
  watchQueueCompletionPhotos=watchQueueShippingLabels=scheduleQueueVideoReceiptEvidenceHydration=()=>{};
  loadSelectedOrderTasks=hydrateSelectedOrderDetails=async()=>{};
  setupListeners();renderCheckoutStoreSelect();applyOrderFilters();
  window.chatController=PendingOrderChats.start({client:supabase,userId:state.user.id,getLines:()=>state.orders});
 });
 await page.addScriptTag({url:origin+'/pending-orders-mobile.js'});
 await expect(page.locator('[data-line-chat-marker="line-a"]')).toContainText('Item chat');return page;
}
for(const width of [320,390,1440])test(`${width}px: chat markers fit the real pending-order cards and arrive without replacing work`,async t=>{
 const page=await open(t,width);const line=page.locator('[data-line-chat-marker="line-a"]');
 await page.evaluate(()=>{window.originalCard=document.querySelector('[data-buyer-username="jewelrylover"]');const input=document.createElement('textarea');input.id='in-progress-note';input.value='Keep my packing note';originalCard.append(input);chatRows[0].unread_count=1;chatRows[0].unread_conversation_ids=['chat-1'];chatRows[0].latest_buyer_message_at='2026-10-09T18:00:00Z';chatEvents.ebay_conversation_messages({new:{conversation_id:'chat-1',sender_username:'jewelrylover',direction:'inbound'}});});
 await expect(line).toContainText('New buyer message');await expect(page.locator('[data-buyer-username="jewelrylover"] [data-buyer-chat-marker]')).toContainText('New buyer message');
 assert.equal(await page.evaluate(()=>originalCard===document.querySelector('[data-buyer-username="jewelrylover"]')),true);await expect(page.locator('#in-progress-note')).toHaveValue('Keep my packing note');
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
 await expect(line.locator('a')).toHaveAttribute('href',/orderLineId=line-a&from=pending&conversationId=chat-1/);
 await page.screenshot({path:`test-results/pending-chats/${width}.png`});
 assert.ok((await page.evaluate(()=>rpcCalls)).every(c=>c.name==='list_pending_order_chat_markers'));
});
test('personal read events clear the warning; failed refresh retains it and reconnect recovers',async t=>{
 const page=await open(t);const badge=page.locator('[data-line-chat-marker="line-a"]');
 await page.evaluate(()=>{chatRows[0].unread_count=1;chatRows[0].unread_conversation_ids=['chat-1'];chatEvents.ebay_conversations({new:{id:'chat-1',other_party_username:'jewelrylover'}});});await expect(badge).toContainText('New buyer message');
 await page.evaluate(()=>{failChats=true;chatController.refresh();});await expect(page.locator('[data-pending-chat-status]')).toContainText('unavailable');await expect(badge).toContainText('New buyer message');
 await page.evaluate(()=>{failChats=false;chatRows[0].unread_count=0;chatRows[0].unread_conversation_ids=[];chatEvents.ebay_conversation_user_read_states({new:{conversation_id:'chat-1',user_id:'user',read_state:'read'}});});await expect(badge).toContainText('Item chat');
 await page.evaluate(()=>chatConnection('CHANNEL_ERROR'));await expect(page.locator('[data-pending-chat-status]')).toContainText('periodically');await page.evaluate(()=>chatConnection('SUBSCRIBED'));await expect(page.locator('[data-pending-chat-status]')).toContainText('live');
});
test('messages arriving while completion is open update its reminder without closing the dialog',async t=>{
 const page=await open(t);await page.evaluate(()=>{document.getElementById('bundle-review-modal').classList.remove('hidden');PendingOrderChats.review(document.getElementById('bundle-chat-review'),state.orders);chatRows[0].unread_count=1;chatRows[0].unread_conversation_ids=['chat-1'];chatEvents.ebay_conversation_messages({new:{conversation_id:'chat-1'}});});
 await expect(page.locator('#bundle-chat-review')).toBeVisible();await expect(page.locator('#bundle-chat-review')).toContainText('Review buyer messages before completing');await expect(page.locator('#bundle-review-modal')).toBeVisible();
});
test('newly created conversations appear, unrelated buyers do not trigger reads, and refreshes serialize',async t=>{
 const page=await open(t);let calls=await page.evaluate(()=>rpcCalls.length);
 await page.evaluate(()=>chatEvents.ebay_conversations({new:{id:'unrelated',other_party_username:'someoneelse'}}));await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>rpcCalls.length),calls);
 await page.evaluate(()=>{chatRows[1]={...chatRows[1],conversation_ids:['chat-new'],unread_conversation_ids:['chat-new'],conversation_count:1,unread_count:1,latest_conversation_id:'chat-new'};delayChats=true;chatEvents.ebay_conversations({new:{id:'chat-new',other_party_username:'anotherbuyer'}});});
 await expect.poll(()=>page.evaluate(()=>!!window.resolveChats)).toBe(true);calls=await page.evaluate(()=>rpcCalls.length);
 await page.evaluate(()=>{for(let i=0;i<10;i++)chatEvents.ebay_conversation_messages({new:{conversation_id:'chat-1'}});});await page.waitForTimeout(600);assert.equal(await page.evaluate(()=>rpcCalls.length),calls);
 await page.evaluate(()=>{delayChats=false;resolveChats();});await expect(page.locator('[data-line-chat-marker="line-b"]')).toContainText('New buyer message');
});
