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
async function open(t,width=390,{linked=true}={}){
 const context=await browser.newContext({viewport:{width,height:844},hasTouch:width<1021});t.after(()=>context.close());
 await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const page=await context.newPage();page.setDefaultTimeout(6500);
 const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(`${origin}/email-triage.html`);
 for(const file of ['task-workflow.js','email-triage.api.js','email-triage.state.js','email-triage.render-utils.js','email-triage.classifications.js','email-triage.diagnostics.js','email-triage.operations.js','email-triage.workspace.js'])await page.addScriptTag({url:origin+'/'+file});
 await page.evaluate(linked=>{
  window.fixtureWrites=[];window.fixtureReads=[];window.fixtureTasks=[];window.fixtureFailSave=false;window.fixtureDelaySave=false;
  const now=new Date().toISOString();
  window.fixtureConversations=Array.from({length:32},(_,i)=>({id:`chat-${i}`,ebay_conversation_id:`ebay-${i}`,conversation_type:'FROM_MEMBERS',other_party_username:i===0?'jewelrybuyer':`buyer_${i}`,conversation_title:'Shipping update',latest_message_preview:'Could you check the certificate and let me know when my order will ship?',latest_message_created_at:now,unread_count:1,summary:{order_numbers:['12-34567-89012']}}));
  const session={access_token:'fixture-only',user:{id:'me',email:'manager@example.test'}};
  window.fixtureRealtime={};
  const channel={on:(_kind,filter,callback)=>{fixtureRealtime[filter.table]=callback;return channel;},subscribe:callback=>{window.fixtureSubscribe=callback;callback('SUBSCRIBED');return channel;}};
  const client={channel:()=>channel,removeChannel:()=>{},auth:{getSession:async()=>({data:{session}})},rpc:async(name,args)=>{
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
   if(window.fixtureDelayMailbox)await new Promise(r=>window.finishMailboxReload=r);
   const search=(request.searchTerms||[]).join(' ');
   if(search==='slow')await new Promise(r=>window.finishSlowSearch=r);
   const conversations=search?fixtureConversations.filter(c=>c.other_party_username.includes(search)):fixtureConversations;
   return {conversations,canonical_total:32,matching_total:conversations.length,loaded_at:now,mailbox_mode:'rpc',rpc_version:'v2',has_more:false,smart_folder_counts:{all:32,unread:28,needs_reply_today:8,pending_tasks:3}};
  };
  api.fetchEbayConversationSavedViews=async()=>({views:[]});
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
  api.fetchEbayConversationDrafts=async()=>({drafts:[]});
  api.fetchTeamTaskAssignees=async()=>({assignees:[{user_id:'me',display_name:'Jose',email:'manager@example.test',role:'admin'},{user_id:'worker',display_name:'Sandra',email:'worker@example.test',role:'worker'}]});
  api.fetchOperationalDashboard=async()=>{fixtureReads.push({name:'dashboard'});return {};};
  api.requestEbayConversationDraftAction=async()=>{throw Error('Sending is outside these tests');};
 },linked);
 await page.addScriptTag({url:origin+'/email-triage.js'});
 await expect(page.locator('.ebay-conversation-row')).toHaveCount(32);
 await expect(page.locator('[data-ebay-detail-action="reply"]')).toHaveCount(1);
 return page;
}
const noOverflow=async page=>assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);
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
