import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin;
const root=new URL('../../',import.meta.url);
before(async()=>{
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1);
  if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
  try{let body=await readFile(new URL(name,root));if(name.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');
   res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
 await mkdir(new URL('test-results/',root),{recursive:true});
});
after(async()=>{await browser?.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
async function open(t,width=390,{linked=true,orderChoices=false,orderEntry=false,sendReply=false,sourceEntry=false}={}){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<1021});t.after(()=>context.close());
 await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(6500);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(`${origin}/email-triage.html${sourceEntry?'?ebayConversationDbId=chat-0&ebayMessageDbId=message-chat-0':orderEntry?'?orderLineId=11111111-1111-4111-8111-111111111111&from=pending':''}`);
 for(const file of ['task-workflow.js','email-triage.api.js','email-triage.state.js','email-triage.render-utils.js','email-triage.classifications.js','email-triage.diagnostics.js','email-triage.operations.js','email-triage.workspace.js','email-triage.read-tracking.js'])await page.addScriptTag({url:origin+'/'+file});
 await page.evaluate(({linked,orderChoices,orderEntry,sendReply})=>{
  window.fixtureWrites=[];window.fixtureReads=[];window.fixtureTasks=[];window.fixtureFailSave=false;window.fixtureDelaySave=false;
  window.fixtureReadReceipts={};window.fixtureReadEvents=[];window.fixtureReadFail=false;
  const now=new Date().toISOString();
  window.fixtureConversations=Array.from({length:32},(_,i)=>({id:`chat-${i}`,ebay_conversation_id:`ebay-${i}`,conversation_type:'FROM_MEMBERS',other_party_username:i===0?'jewelrybuyer':`buyer_${i}`,conversation_title:'Shipping update',latest_message_preview:'Could you check the certificate and let me know when my order will ship?',latest_message_created_at:now,unread_count:1,summary:{order_numbers:['12-34567-89012']}}));
  const session={access_token:'fixture-only',user:{id:'me',email:'manager@example.test'}};
  window.fixtureRealtime={};
  const teamStatus=id=>{const messageIds=[`message-${id}`,...(id==='chat-0'?(window.fixtureExtraMessages||[]).filter(m=>m.direction!=='outbound').map(m=>m.id):[])];const message_states=messageIds.map(message_id=>({message_id,...(fixtureReadReceipts[message_id]||{is_read:false})}));const last=message_states.find(m=>m.read_at);return {conversation_id:id,is_read:message_states.every(m=>m.is_read),read_by:last?.read_by||null,read_at:last?.read_at||null,message_states};};
  const channel={on:(_kind,filter,callback)=>{fixtureRealtime[filter.table]=callback;return channel;},subscribe:callback=>{window.fixtureSubscribe=callback;callback('SUBSCRIBED');return channel;}};
  const client={channel:()=>channel,removeChannel:()=>{},auth:{getSession:async()=>({data:{session}})},rpc:async(name,args)=>{
   if(name==='list_team_task_assignees')return {data:[{user_id:'me',display_name:'Jose',email:'manager@example.test'}]};
   if(name==='get_ebay_team_read_status')return {data:args._conversation_ids.map(teamStatus)};
   if(name==='get_ebay_daily_read_activity'){
    const rows=fixtureConversations.filter(c=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c.latest_message_created_at))===args._date).map(c=>({...c,...teamStatus(c.id),activity_at:c.latest_message_created_at}));
    const found=rows.filter(r=>args._state==='all'||r.is_read===(args._state==='read'));
    return {data:{counts:{all:rows.length,read:rows.filter(r=>r.is_read).length,unread:rows.filter(r=>!r.is_read).length},total:found.length,rows:found.slice(args._offset,args._offset+args._limit)}};
   }
   if(name==='get_ebay_read_history')return {data:fixtureReadEvents};
   if(name==='set_ebay_team_read_state'){
    fixtureWrites.push({name,args});if(fixtureReadFail)return {error:{message:'Read status could not be saved. Try again.'}};
    for(const m of teamStatus(args._conversation_id).message_states.filter(m=>!args._message_id||m.message_id===args._message_id)){
     fixtureReadReceipts[m.message_id]={...m,is_read:args._read_state==='read',...(args._read_state==='read'?{read_by:'Sandra',read_at:now}:{})};
     fixtureReadEvents.push({actor_name:'Sandra',is_read:args._read_state==='read',created_at:now});
    }
    return {data:teamStatus(args._conversation_id)};
   }
   if(name==='get_ebay_message_recovery_health')return {data:null,error:null};
   if(name==='list_ebay_conversation_task_workspace'){fixtureReads.push({name,args});return {data:fixtureTasks.filter(t=>args._conversation_ids.includes(t.conversation_id)),error:null};}
   fixtureWrites.push({name,args});
   if(fixtureDelaySave)await new Promise(r=>window.finishFixtureSave=r);
   if(fixtureFailSave)return {data:null,error:{code:'fixture_save_failed',message:'Network unavailable — try again'}};
   fixtureTasks=[{task_id:'new-task',conversation_id:args._details._conversation_id,message_id:args._details._message_id,title:args._details._title,status:'assigned',source:args._source==='message'?'team':'order',metadata:{request_kind:args._request_kind},next_actor_label:`${args._request_kind==='decision'?'Decision':'Next'}: Sandra`,created_at:now,events:[]}];
   return {data:{id:'new-task'},error:null};
  }};
  const api=window.EmailTriageApi;
  fixtureConversations.forEach(c=>c.last_detail_synced_at=now);
  api.requireAdmin=async()=>({client,session});
  api.fetchEbayConversations=async(_context,request)=>{
   fixtureReads.push({name:'mailbox',request});
   if(window.fixtureFailMailbox){fixtureFailMailbox=false;throw Error('Mailbox connection interrupted');}
   if(window.fixtureDelayMailbox)await new Promise(r=>window.finishMailboxReload=r);
   const search=(request.searchTerms||[]).join(' ');
   if(search==='slow')await new Promise(r=>window.finishSlowSearch=r);
   const date=request.structuredFilters?.activityDate,readState=request.structuredFilters?.teamReadState||'all';
   const matching=fixtureConversations.filter(c=>(!search||c.other_party_username.includes(search))&&(!date||new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(c.latest_message_created_at))===date));
   const filtered=matching.filter(c=>readState==='all'||teamStatus(c.id).is_read===(readState==='read'));
   const start=request.offset||0,size=request.limit||100;
   const conversations=filtered.slice(start,start+size).map(c=>({...c,team_read:teamStatus(c.id)}));
   return {conversations,canonical_total:fixtureConversations.length,matching_total:filtered.length,read_counts:{all:matching.length,read:matching.filter(c=>teamStatus(c.id).is_read).length,unread:matching.filter(c=>!teamStatus(c.id).is_read).length},loaded_at:now,mailbox_mode:'rpc',rpc_version:'v2',has_more:start+size<filtered.length,page_size:size,next_offset:start+size<filtered.length?start+size:null,smart_folder_counts:{all:32,unread:28,needs_reply_today:8,pending_tasks:3}};
  };
  api.fetchEbayConversationSavedViews=async()=>({views:[]});
  api.fetchEbayConversationById=async(_ctx,id)=>({conversation:fixtureConversations.find(c=>c.id===id)});
  api.fetchEbayConversationUserReadStates=async()=>({read_states:[]});
  api.runEbayMessageSync=async(_context,values)=>{fixtureReads.push({name:'provider-sync',values});return {ok:true};};
  api.fetchEbayConversationMessages=async(_context,id)=>{
   fixtureReads.push({name:'messages',id});
   const messages=[{id:`message-${id}`,conversation_id:id,direction:'inbound',sender_username:id==='chat-0'?'jewelrybuyer':id.replace('chat-','buyer_'),recipient_username:'ogjewelers',body:'Could you check the certificate and let me know when my order will ship?',created_at:now},...(window.fixtureExtraMessages||[])];
   if(window.fixtureDelayMessages)await new Promise(r=>window.finishMessageFetch=r);
   return {messages};
  };
  api.fetchEbayConversationContext=async()=>({context:{buyer:{username:'jewelrybuyer'},matched_orders:[{id:'order-1',order_number:'12-34567-89012',status:'pending',total_price:305}],matched_order_lines:[{id:'line-1',order_id:'order-1',order_number:'12-34567-89012',line_status:'pending',item_title:'#008 — 10K solid gold chain',quantity:1,total_price:305}],links:[{ebay_order_id:'order-1',ebay_order_line_id:'line-1',status:'confirmed'}]}});
  if(!linked)api.fetchEbayConversationContext=async()=>({context:{buyer:{username:'jewelrybuyer'},matched_orders:[],matched_order_lines:[]}});
  if(orderChoices){
   window.fixtureSelectedOrder=null;window.fixtureOrderLinkFail=false;
   const orders=[{id:'choice-1',order_number:'01-11111-11111',buyer_username:'jewelrybuyer',status:'fulfilled',sale_date:'2026-10-01T12:00:00Z',total_price:200,lines:[{id:'choice-line-1',order_id:'choice-1',line_status:'fulfilled',item_title:'Gold watch',quantity:1}]},{id:'choice-2',order_number:'02-22222-22222',buyer_username:'jewelrybuyer',status:'pending',sale_date:'2026-10-06T12:00:00Z',total_price:300,lines:[{id:'choice-line-2',order_id:'choice-2',line_status:'pending',item_title:'Diamond chain',quantity:1}]}];
   api.fetchEbayConversationContext=async()=>{
    const order=orders.find(o=>o.id===fixtureSelectedOrder);
    return {context:{buyer:{username:'jewelrybuyer'},buyer_orders_available:true,buyer_order_options:orders,
     matched_orders:order?[order]:[],matched_order_lines:order?order.lines:[],links:order?[{ebay_order_id:order.id,status:'confirmed',match_method:'operator_selected_order'}]:[]}};
   };
   api.selectEbayConversationOrder=async(_context,id,orderId)=>{
    fixtureWrites.push({name:'select-order',id,orderId});if(fixtureOrderLinkFail)throw Error('Could not save. Try again.');
    fixtureSelectedOrder=orderId;return api.fetchEbayConversationContext();
   };
  }
  api.fetchEbayConversationDrafts=async()=>({drafts:[]});
  api.fetchTeamTaskAssignees=async()=>({assignees:[{user_id:'me',display_name:'Jose',email:'manager@example.test',role:'admin'},{user_id:'worker',display_name:'Sandra',email:'worker@example.test',role:'worker'}]});
  api.fetchOperationalDashboard=async()=>{fixtureReads.push({name:'dashboard'});return {};};
  api.requestEbayConversationDraftAction=async()=>{throw Error('Sending is outside these tests');};
  if(sendReply){
   window.fixtureSendOutcome='failed';
   api.requestEbayConversationDraftAction=async(_ctx,args)=>{
    fixtureWrites.push({name:'reply',args});
    if(args.mode!=='send')throw Error('Unexpected draft action');
    if(fixtureSendOutcome==='failed')throw Error('Send failed. Please retry.');
    const stamp=new Date().toISOString();
    fixtureReadReceipts[`message-${args.conversationId}`]={is_read:true,read_by:'Sandra',read_at:stamp};
    fixtureReadEvents.push({actor_name:'Sandra',is_read:true,created_at:stamp});
    const message={id:'sent-reply',conversation_id:args.conversationId,direction:'outbound',message_body:args.draftText,created_at_ebay:stamp};
    fixtureExtraMessages=[message];
    fixtureConversations.find(c=>c.id===args.conversationId).latest_message_created_at=stamp;
    return {mode:'send',send_attempt:{id:'send-1',attempt_status:'succeeded',sent_at:stamp},local_outbound_message:message};
   };
  }
  if(orderEntry){
   api.fetchEbayConversationById=async(_ctx,id)=>({conversation:fixtureConversations.find(c=>c.id===id)});
   api.requestEbayConversationDraftAction=async(_ctx,args)=>{if(args.mode!=='order_chat_context')throw Error('No live sends');return {ok:true,line:{id:'11111111-1111-4111-8111-111111111111',item_title:'Gold chain',item_number:'287123456789',quantity:1},order:{id:'order-1',order_number:'12-34567-89012',buyer_username:'jewelrybuyer'},conversations:[{...fixtureConversations[0],match:'item'}],preferred_conversation_id:'chat-0'};};
  }
 },{linked,orderChoices,orderEntry,sendReply});
 await page.addScriptTag({url:origin+'/email-triage.order-chat.js'});
 await page.addScriptTag({url:origin+'/buyer-tasks.js'});
 await page.addScriptTag({url:origin+'/email-triage.js'});
 await expect(page.locator('.ebay-conversation-row')).toHaveCount(orderEntry?1:32);
 await expect(page.locator('[data-ebay-detail-action="reply"]')).toHaveCount(1);
 return page;
}
const noOverflow=async page=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
test('original task conversation link opens the message pane directly on a phone',async t=>{
 const page=await open(t,390,{sourceEntry:true});
 await expect(page.getByRole('button',{name:'Message',exact:true})).toHaveAttribute('aria-pressed','true');
 await expect(page.getByRole('region',{name:'Selected eBay conversation'})).toBeVisible();
 await expect(page.getByRole('button',{name:'Customer task',exact:true})).toBeVisible();
 assert.equal(await page.evaluate(()=>fixtureWrites.length),0,'Opening a source message must not mark it read');
});
for(const width of [390,1366])test(`customer promise starts from message with exact username at ${width}px`,async t=>{
 const page=await open(t,width);
 await page.locator('.ebay-conversation-row').first().click();
 await page.getByRole('button',{name:'Customer task',exact:true}).click();
 await expect(page.getByRole('dialog').getByLabel('eBay username')).toHaveValue('jewelrybuyer');
 await expect(page.getByRole('dialog').getByLabel('Responsible person')).toHaveValue('me');
 await expect(page.getByRole('dialog').getByLabel('Task title')).toBeFocused();
 await expect(page.getByRole('dialog')).toContainText('original conversation and message');
 await page.getByRole('dialog').getByLabel('Task title').fill('Include the certificate');
 await page.getByRole('dialog').getByLabel('Promise / instructions').fill('Include the certificate with the next order');
 await page.getByRole('dialog').getByRole('button',{name:'Save customer task',exact:true}).click();
 await expect(page.getByRole('dialog')).toContainText('Customer task saved');
 const saved=await page.evaluate(()=>fixtureWrites[0]);
 assert.equal(saved.name,'create_buyer_followup_task');assert.equal(saved.args._details._conversation_id,'chat-0');assert.equal(saved.args._details._message_id,'message-chat-0');
});
for(const width of [390,1366])test(`Reply read receipts ${width}px refresh after successful sends without requiring realtime`,async t=>{
 const page=await open(t,width,{sendReply:true});
 await page.locator('.ebay-conversation-row').first().click();
 await expect(page.locator('[data-read-filter="read"]')).toHaveText('Read 0');
 await page.getByRole('button',{name:'Reply',exact:true}).click();
 await page.locator('[name="draftText"]').fill('Your order will ship tomorrow.');
 const control=page.locator('.triage-read-summary [data-team-read]');
 await expect(control).toHaveText('Mark read','writing a draft is not a read');
 await page.locator('[data-ebay-draft-action="send"]').click();
 await expect(page.locator('.ebay-conversation-detail')).toContainText('Send failed');
 await expect(control).toHaveText('Mark read');
 await expect(page.locator('[data-read-filter="read"]')).toHaveText('Read 0');
 await page.evaluate(()=>fixtureSendOutcome='succeeded');
 await page.locator('[data-ebay-draft-action="send"]').click();
 await expect(control).toHaveText('Mark unread');
 await expect(page.locator('.triage-read-summary')).toContainText('Read by Sandra');
 await expect(page.locator('[data-read-filter="read"]')).toHaveText('Read 1');
 assert.equal((await page.evaluate(()=>fixtureWrites)).filter(w=>w.name==='set_ebay_team_read_state').length,0,'the browser uses the persisted server receipt');
});
for(const width of [390,1366])test(`Team read tracking ${width}px requires an explicit click and supports dates, read filters and history`,async t=>{
 const page=await open(t,width);
 await page.locator('.ebay-conversation-row').first().click();
 await expect(page.locator('.ebay-message-bubble')).toBeVisible();
 assert.equal(await page.evaluate(()=>fixtureWrites.length),0,'opening never marks read');
 const mark=page.locator('.ebay-message-actions [data-team-read]').first();
 await expect(mark).toHaveText('Mark read');await mark.click();
 await expect(mark).toHaveText('Mark unread');
 await expect(page.locator('.ebay-message-actions')).toContainText('Read by Sandra');
 assert.equal((await page.evaluate(()=>fixtureWrites))[0].args._message_id,'message-chat-0');
 if(width<1021)await page.locator('[data-ebay-mobile-view="inbox"]').click();
 await expect(page.locator('[data-read-filter="read"]')).toContainText('1');
 await expect(page.locator('[data-read-filter="unread"]')).toContainText('31');
 await page.locator('[data-read-filter="read"]').click();await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);
 await page.locator('[data-read-date]').fill('2020-01-01');await page.locator('[data-read-date]').press('Tab');await expect(page.locator('#ebay-conversation-list')).toContainText('No messages');
 await expect(page.locator('[data-read-filter="all"] b')).toHaveText('0');
 await page.locator('[data-read-all-dates]').click();await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);
 await page.locator('.ebay-conversation-row').click();
 await page.locator('[data-read-history]').click();await expect(page.getByRole('dialog',{name:'Read history',exact:true})).toContainText('Sandra');
 await page.getByRole('button',{name:'Close read history'}).click();
 await page.evaluate(()=>fixtureReadFail=true);await mark.click();
 await expect(page.locator('[data-read-error]').first()).toContainText('could not be saved');await expect(mark).toHaveText('Mark unread');
 const laterDay=await page.evaluate(()=>{
  fixtureReadFail=false;const timestamp=new Date(Date.now()+86400000).toISOString();
  fixtureConversations[0].latest_message_created_at=timestamp;fixtureConversations[0].latest_message_id='new-provider-message';
  fixtureExtraMessages=[{id:'new-incoming',conversation_id:'chat-0',direction:'inbound',message_body:'One more question',created_at_ebay:timestamp}];
  fixtureRealtime.ebay_conversation_messages({new:fixtureExtraMessages[0]});
  return new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(timestamp));
 });
 // The new unread reply leaves the active Read filter and returns the phone to
 // the inbox. Wait for that refresh before choosing another date.
 await expect(page.locator('[data-read-filter="read"] b')).toHaveText('0');
 await expect(page.locator('.ebay-conversation-row')).toHaveCount(0);
 await expect(page.locator('[data-read-date]')).toBeVisible();
 await page.locator('[data-read-date]').fill(laterDay);await page.locator('[data-read-date]').press('Tab');
 await page.locator('[data-read-filter="unread"]').click();
 await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);await expect(page.locator('[data-read-filter="read"]')).toContainText('0');
 assert.equal(await page.evaluate(()=>fixtureWrites.length),2,'new replies and date navigation never mark read');
 await page.screenshot({path:`test-results/triage-${width}-read-tracking.png`});
 await noOverflow(page);
});
test('phone task typing preserves the live field, spaces and caret during background updates and keyboard resize',async t=>{
 const page=await open(t,390);await page.locator('.ebay-conversation-row').first().click();
 await page.locator('[data-ebay-message-task-action="create"]').first().click();
 const instructions=page.locator('[name="taskDescription"]');await instructions.fill('Check the clasp  \n');
 await instructions.evaluate(el=>{window.originalTaskField=el;el.focus();el.setSelectionRange(6,6);});
 await page.evaluate(()=>EmailTriageReadTracking.invalidate());
 await expect.poll(()=>page.evaluate(()=>document.querySelector('[name="taskDescription"]')===originalTaskField)).toBe(true);
 await expect(instructions).toBeFocused();await expect(instructions).toHaveValue('Check the clasp  \n');
 assert.equal(await instructions.evaluate(el=>el.selectionStart),6);
 await page.setViewportSize({width:390,height:420});await expect(instructions).toBeFocused();
 await page.keyboard.type('carefully ');await expect(instructions).toHaveValue('Check carefully the clasp  \n');
 await page.locator('[name="assignedToUserId"]').selectOption('worker');
 await page.locator('[data-ebay-message-task-form] button[type="submit"]').click();
 await expect(page.getByRole('dialog',{name:'Create task'})).toBeHidden();
 assert.equal((await page.evaluate(()=>fixtureWrites)).filter(w=>w.name==='create_task_request').length,1);
});

for(const width of [320,390,1366])test(`Date filter ${width}px replaces the main inbox, preserves filters when returning from a message, and supports day navigation`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>{fixtureConversations[0].latest_message_created_at='2026-10-01T16:00:00Z';fixtureConversations[1].latest_message_created_at='2026-10-02T16:00:00Z';fixtureReadReceipts['message-chat-0']={is_read:true,read_by:'Sandra',read_at:'2026-10-01T17:00:00Z'};});
 const date=page.locator('[data-read-date]');await date.fill('2026-10-01');await date.press('Tab');
 await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);await expect(page.locator('[data-read-filter="all"] b')).toHaveText('1');await expect(page.locator('[data-read-filter="read"] b')).toHaveText('1');
 assert.equal(await page.locator('.triage-read-day-list').count(),0,'there is only the regular inbox');
 await page.screenshot({path:`test-results/triage-date-filter-${width}.png`});await noOverflow(page);
 await page.locator('.ebay-conversation-row').click();await expect(page.locator('.ebay-message-bubble')).toBeVisible();
 if(width<1021){await expect(page.locator('#triage-read-tracking')).not.toBeVisible();await page.locator('[data-ebay-mobile-view="inbox"]').click();}
 await expect(date).toHaveValue('2026-10-01');await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);
 await page.locator('[data-read-day="1"]').click();await expect(date).toHaveValue('2026-10-02');await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);await expect(page.locator('[data-read-filter="unread"] b')).toHaveText('1');
 await page.locator('[data-read-filter="read"]').click();await expect(page.locator('.ebay-conversation-row')).toHaveCount(0);await expect(page.locator('[data-read-filter="unread"] b')).toHaveText('1');
 await page.locator('[data-read-day="-1"]').click();await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);
 await page.locator('[data-read-all-dates]').click();await expect(date).toHaveValue('');await expect(page.locator('[data-read-filter="read"]')).toHaveAttribute('aria-pressed','true');
 await page.locator('[data-read-filter="all"]').click();await expect(page.locator('.ebay-conversation-row')).toHaveCount(32);
 assert.equal(await page.evaluate(()=>fixtureWrites.length),0,'date changes and opening a message are read-only');
});

test('daily counts cover later pages and a stale date response cannot replace a newer selection',async t=>{
 const page=await open(t,390);
 await page.evaluate(()=>{
  const sample=fixtureConversations[0];fixtureConversations=Array.from({length:135},(_,n)=>({...sample,id:`chat-${n}`,other_party_username:`buyer_${n}`,latest_message_created_at:'2026-10-01T16:00:00Z'}));
 });
 const date=page.locator('[data-read-date]');await date.fill('2026-10-01');await date.press('Tab');await expect(page.locator('.ebay-conversation-row')).toHaveCount(100);await expect(page.locator('[data-read-filter="all"] b')).toHaveText('135');
 await page.locator('#ebay-conversation-load-more').click();await expect(page.locator('.ebay-conversation-row')).toHaveCount(135);await expect(page.locator('[data-read-filter="all"] b')).toHaveText('135');
 await page.evaluate(()=>fixtureDelayMailbox=true);await date.fill('2026-10-02');await date.press('Tab');await page.waitForFunction(()=>typeof finishMailboxReload==='function');
 await page.evaluate(()=>{window.oldDayRequest=finishMailboxReload;fixtureDelayMailbox=false;});await date.fill('2026-10-01');await date.press('Tab');await expect(page.locator('.ebay-conversation-row')).toHaveCount(100);
 await page.evaluate(()=>oldDayRequest());await expect(page.locator('[data-read-filter="all"] b')).toHaveText('135');await expect(date).toHaveValue('2026-10-01');
 await page.evaluate(()=>fixtureFailMailbox=true);await date.fill('2026-10-03');await date.press('Tab');await expect(page.locator('[data-read-results]')).toContainText('Could not load');await expect(page.locator('.ebay-conversation-row')).toHaveCount(0);await expect(page.locator('[data-read-filter="all"] b')).toHaveText('—');
 await page.locator('#ebay-conversation-refresh').click();await expect(page.locator('[data-read-filter="all"] b')).toHaveText('0');await expect(page.locator('[data-read-results]')).toBeHidden();
});
for(const width of [390,1366])test(`Order entry ${width}px opens the correct chat inside the actual triage workspace`,async t=>{
 const page=await open(t,width,{orderEntry:true});await expect(page.locator('#order-chat-entry')).toContainText('Gold chain');await expect(page.locator('.ebay-message-bubble')).toBeVisible();await expect(page.getByRole('button',{name:'Reply',exact:true})).toBeVisible();await noOverflow(page);
 assert.ok(new URL(page.url()).searchParams.get('ebayConversationDbId')==='chat-0');assert.equal(await page.evaluate(()=>fixtureWrites.length),0);
 await page.screenshot({path:`test-results/order-chat-${width}-integrated.png`});
});
for(const width of [320,390,768,1024,1366,1920])test(`Messaging ${width}px: inbox first, conversation, task and filters remain usable`,async t=>{
 const page=await open(t,width);await noOverflow(page);
 await page.screenshot({path:`test-results/triage-${width}-inbox-local.png`});
 const first=page.locator('.ebay-conversation-row').first();assert.ok((await first.boundingBox()).y<580,`inbox must be visible without scrolling past tools: ${(await first.boundingBox()).y}`);
 assert.equal(await page.evaluate(()=>fixtureReads.some(r=>r.name==='dashboard')),false,'collapsed operations dashboard must not load');
 await page.screenshot({path:`test-results/triage-${width}-inbox-local.png`});
 await first.click();
 await expect(page.locator('.ebay-message-bubble')).toBeVisible();
 if(width<1021)await expect(page.locator('.ebay-conversation-list-panel')).toBeHidden();
 await noOverflow(page);
 await page.getByRole('button',{name:'Reply',exact:true}).click();
 await expect(page.locator('[name="draftText"]')).toBeFocused();
 await page.locator('[name="draftText"]').fill('I will check the certificate.');
 await page.locator('[data-ebay-message-task-action="create"]').first().click();
 await expect(page.getByRole('dialog',{name:'Create task'})).toBeVisible();
 await page.locator('[name="taskDescription"]').fill('Find the certificate before shipping.');
 await page.locator('[name="assignedToUserId"]').selectOption('worker');
 await noOverflow(page);
 await page.screenshot({path:`test-results/triage-${width}-task-local.png`});
 await page.getByRole('button',{name:'Close task creator'}).click();
 await expect(page.locator('[name="draftText"]')).toHaveValue('I will check the certificate.');
 if(width<1021)await page.locator('[data-ebay-mobile-view="inbox"]').click();
 await page.getByRole('button',{name:'Filters',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'Find the exact chats you need'})).toBeVisible();await noOverflow(page);
 await page.getByRole('button',{name:'Done',exact:true}).click();
 assert.equal(await page.evaluate(()=>fixtureWrites.length),0,'UI inspection must not submit messages or tasks');
});
for(const kind of ['work','decision'])for(const linked of [false,true])test(`${kind} task, ${linked?'order line':'message'}: draft survives failure and routes once`,async t=>{
 const page=await open(t,390,{linked});
 await page.locator('.ebay-conversation-row').first().click();
 await page.locator('[data-ebay-message-task-action="create"]').first().click();
 await page.locator(`[name="message-task-request-kind"][value="${kind}"]`).check();
 if(!linked)await page.locator('[name="taskTargetKey"][value="chat"]').check();
 await page.locator('[name="taskDescription"]').fill('Please confirm this certificate.');
 await page.locator('[name="assignedToUserId"]').selectOption('worker');
 await page.evaluate(()=>fixtureFailSave=true);
 const submit=page.locator('[data-ebay-message-task-form] button[type="submit"]');await submit.click();
 await expect(page.getByText('Network unavailable — try again',{exact:true})).toBeVisible();
 await expect(page.locator('[name="taskDescription"]')).toHaveValue('Please confirm this certificate.');
 await expect(page.locator(`[name="message-task-request-kind"][value="${kind}"]`)).toBeChecked();
 await page.evaluate(()=>{fixtureFailSave=false;fixtureDelaySave=true;});await submit.click();
 await expect(submit).toBeDisabled();await expect(page.getByRole('button',{name:'Close task creator'})).toBeDisabled();
 await page.evaluate(()=>finishFixtureSave());
 await expect(page.getByRole('dialog',{name:'Create task'})).toBeHidden();
 const writes=await page.evaluate(()=>fixtureWrites);assert.equal(writes.length,2);const write=writes[1];
 assert.equal(write.name,'create_task_request');assert.equal(write.args._source,linked?'linked_message':'message');assert.equal(write.args._request_kind,kind);assert.equal(write.args._details._assigned_to_user_id,'worker');
 if(linked)assert.deepEqual(write.args._details._order_line_ids,['line-1']);
 await expect(page.locator('.triage-task-strip')).toContainText(kind==='decision'?'Decision: Sandra':'Next: Sandra');
 await page.getByRole('button',{name:'View updates',exact:true}).click();
 await expect(page.getByRole('dialog',{name:'jewelrybuyer',exact:true})).toBeVisible();
 assert.equal(await page.evaluate(()=>fixtureReads.some(r=>r.name==='list_ebay_conversation_task_workspace'&&r.args._include_events)),true);
});
test('unrelated redraw keeps saved reply and expanded details; unchanged markup keeps DOM',async t=>{
 const page=await open(t,1366);const input=page.locator('[name="draftText"]');await input.fill('Please check this');
 await page.evaluate(()=>{const input=document.querySelector('[name="draftText"]');input.focus();input.setSelectionRange(4,4);window.oldInput=input;});
 await page.locator('.triage-conversation-more > summary').click();await input.focus();
 await page.locator('[data-ebay-panel-toggle="folders"]').click();
 assert.equal(await page.evaluate(()=>oldInput===document.querySelector('[name="draftText"]')),false,'first render incorporates draft text');
 await input.focus();await page.evaluate(()=>{document.querySelector('[name="draftText"]').setSelectionRange(4,4);window.oldInput=document.querySelector('[name="draftText"]');});
 await page.locator('[data-ebay-panel-toggle="folders"]').click();
 assert.equal(await page.evaluate(()=>oldInput===document.querySelector('[name="draftText"]')),true,'unrelated changes do not replace composer');
 await expect(page.locator('.triage-conversation-more')).toHaveAttribute('open','');
 await expect(input).toHaveValue('Please check this');
});

test('refresh finishing while writing preserves the latest conversation, draft and caret',async t=>{
 const page=await open(t,1366);
 await page.evaluate(()=>fixtureDelayMailbox=true);
 await page.locator('#ebay-conversation-refresh').click();
 await page.waitForFunction(()=>typeof finishMailboxReload==='function');
 await page.locator('.ebay-conversation-row').nth(1).click();
 const input=page.locator('[name="draftText"]');await input.fill('I will check your order.');
 await page.evaluate(()=>document.querySelector('[name="draftText"]').setSelectionRange(7,7));
 await page.evaluate(()=>{fixtureDelayMailbox=false;finishMailboxReload();});
 await expect(page.locator('#ebay-conversation-status')).toContainText('Inbox loaded');
 await expect(page.locator('[data-triage-selected]')).toHaveAttribute('data-triage-selected','chat-1');
 await expect(input).toHaveValue('I will check your order.');await expect(input).toBeFocused();
 assert.equal(await input.evaluate(el=>el.selectionStart),7);
});
test('a slow earlier search cannot overwrite the latest search results',async t=>{
 const page=await open(t,390);const search=page.getByRole('searchbox',{name:'Search eBay conversations'});
 await search.fill('slow');await page.waitForFunction(()=>typeof finishSlowSearch==='function');
 await search.fill('jewelrybuyer');await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);
 await expect(page.locator('#ebay-conversation-status')).toContainText('Inbox loaded');
 await page.evaluate(()=>finishSlowSearch());
 await expect(page.locator('.ebay-conversation-row')).toHaveCount(1);await expect(search).toHaveValue('jewelrybuyer');
});
test('phone can return to the same inbox row and use all folders',async t=>{
 const page=await open(t);const row=page.locator('.ebay-conversation-row').nth(12);
 await row.scrollIntoViewIfNeeded();const before=(await row.boundingBox()).y;
 await row.click();await expect(page.locator('.ebay-conversation-detail-panel')).toBeVisible();
 await page.locator('[data-ebay-mobile-view="inbox"]').click();
 await expect.poll(async()=>Math.abs((await row.boundingBox()).y-before)).toBeLessThan(80);
 const select=page.getByRole('combobox',{name:'Message folder'});assert.ok(await select.locator('option').count()>4);
 await select.selectOption({label:'Unread (28)'});
 await expect(page.locator('#ebay-conversation-status')).toContainText('Inbox loaded');
 assert.equal(await page.evaluate(()=>fixtureReads.filter(r=>r.name==='mailbox').at(-1).request.systemFilter),'unread');
});

test('reconnected mailbox catches replies without losing the composed draft',async t=>{
 const page=await open(t,1366);const input=page.locator('[name="draftText"]');await input.fill('Unsent reply remains here');
 await page.evaluate(()=>{
  fixtureSubscribe('CHANNEL_ERROR');
  fixtureExtraMessages=[{id:'new-reply',conversation_id:'chat-0',direction:'inbound',body:'A reply sent while disconnected',created_at:new Date().toISOString()}];
  fixtureSubscribe('SUBSCRIBED');
 });
 await expect(page.locator('#ebay-conversation-detail')).toContainText('A reply sent while disconnected');
 await expect(input).toHaveValue('Unsent reply remains here');
});

test('late HTTP response cannot erase a newer realtime reply',async t=>{
 const page=await open(t,1366);
 await page.evaluate(()=>{fixtureDelayMessages=true;window.dispatchEvent(new Event('online'));});
 await page.waitForFunction(()=>typeof finishMessageFetch==='function');
 await page.evaluate(()=>{
  window.finishOldMessageFetch=finishMessageFetch;fixtureDelayMessages=false;
  fixtureExtraMessages=[{id:'live-reply',conversation_id:'chat-0',direction:'inbound',message_body:'New reply wins the race',created_at_ebay:new Date().toISOString()}];
  fixtureRealtime.ebay_conversation_messages({new:fixtureExtraMessages[0]});
 });
 await expect(page.locator('#ebay-conversation-detail')).toContainText('New reply wins the race');
 await page.evaluate(()=>finishOldMessageFetch());
 await expect(page.locator('#ebay-conversation-detail')).toContainText('New reply wins the race');
});

test('Refresh checks eBay as well as saved data; repeated selection uses fresh cache',async t=>{
 const page=await open(t,1366);
 const before=await page.evaluate(()=>fixtureReads.filter(r=>r.name==='messages').length);
 await page.locator('.ebay-conversation-row').first().click();await page.locator('.ebay-conversation-row').first().click();
 assert.equal(await page.evaluate(()=>fixtureReads.filter(r=>r.name==='messages').length),before);
 await page.locator('#ebay-conversation-refresh').click();
 await expect.poll(()=>page.evaluate(()=>fixtureReads.filter(r=>r.name==='provider-sync').length)).toBe(1);
 assert.equal(await page.evaluate(()=>fixtureReads.find(r=>r.name==='provider-sync').values.syncRecentOrdersBeforeMessages),false);
});

for(const width of [390,1366])test(`Buyer order choices ${width}px: review, link, task target and undo`,async t=>{
 const page=await open(t,width,{linked:false,orderChoices:true});
 if(width<1021)await page.locator('.ebay-conversation-row').first().click();
 await expect(page.getByRole('button',{name:'View buyer orders',exact:true})).toBeVisible();
 await page.getByRole('button',{name:'View buyer orders',exact:true}).click();
 await expect(page.getByRole('region',{name:'Buyer orders'})).toBeVisible();await noOverflow(page);
 const card=page.locator('.triage-buyer-order').filter({hasText:'Diamond chain'});
 await expect(card).toContainText('Oct 06, 2026');
 await card.getByRole('button',{name:'Link this order'}).click();
 await expect(card.getByRole('button',{name:'Remove selection'})).toBeVisible();
 await expect(page.locator('.ebay-context-compact-summary')).toContainText('Order linked');
 assert.deepEqual(await page.evaluate(()=>fixtureWrites.filter(w=>w.name==='select-order').map(w=>w.orderId)),['choice-2']);
 await page.screenshot({path:`test-results/triage-order-links-${width}.png`});
 if(width<1021)await page.locator('[data-ebay-mobile-view="message"]').click();
 await page.locator('[data-ebay-message-task-action="create"]').first().click();
 const taskDialog=page.getByRole('dialog',{name:'Create task'});
 await expect(taskDialog).toContainText('Entire pending order 02-22222-22222');await expect(taskDialog).not.toContainText('01-11111-11111');
 await page.getByRole('button',{name:'Close task creator'}).click();
 if(width<1021)await page.locator('[data-ebay-mobile-view="context"]').click();

 await card.getByRole('button',{name:'Remove selection'}).click();
 await expect(page.getByRole('button',{name:'Remove selection'})).toHaveCount(0);
 await expect(page.locator('.ebay-context-compact-summary')).toContainText('2 buyer orders available');
 await page.evaluate(()=>fixtureOrderLinkFail=true);
 await card.getByRole('button',{name:'Link this order'}).click();
 await expect(page.getByRole('alert')).toContainText('Could not save');
 await expect(card.getByRole('button',{name:'Link this order'})).toBeEnabled();
});
