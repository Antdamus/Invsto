import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit,expect} from '@playwright/test';
let server,browser,origin;
before(async()=>{
 server=createServer(async(req,res)=>{
  const name=new URL(req.url,'http://localhost').pathname.slice(1);
  if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
  try{let body=await readFile(new URL('../'+name,import.meta.url));if(name.endsWith('.html'))body=body.toString().replace(/<script\b[\s\S]*?<\/script>/gi,'');
   res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(body);
  }catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
});
after(async()=>{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
async function open(t,width=390,admin=false){
 const ctx=await browser.newContext({viewport:{width,height:844},hasTouch:width<800});t.after(()=>ctx.close());
 await ctx.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
 const page=await ctx.newPage();page.setDefaultTimeout(7000);const errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
 await page.goto(origin+'/team-tasks.html');
 for(const file of ['buyer-tasks.js','buyer-promise-checkout.js'])await page.addScriptTag({url:origin+'/'+file});
 await page.evaluate(admin=>{
  window.writes=[];window.uploads=[];window.failUpload=false;window.failSave=false;window.failLoad=false;window.delaySave=false;
  window.requirements=[{task_id:'task-1',order_id:'order-1',order_number:'12-34567-89012',buyer_username:'buyer.one',title:'Promised clasp',instructions:'Include <one> silver clasp',version:'v1',can_defer:admin}];
  const client={storage:{from:bucket=>({upload:async(path,file)=>{uploads.push({bucket,path,name:file.name});return failUpload?{error:{message:'Photo upload failed'}}:{};}})},rpc:async(name,args)=>{
   if(name==='list_team_task_assignees')return {data:[{user_id:'me',display_name:'Alex',email:'alex@example.test'}]};
   if(name==='list_buyer_promise_requirements')return failLoad?{error:{message:'Connection unavailable'}}:{data:requirements};
   writes.push({name,args});if(delaySave)await new Promise(resolve=>window.finishSave=resolve);
   if(failSave)return {error:{message:'Network unavailable. Retry.'}};
   if(name==='sign_buyer_promise'){requirements[0]={...requirements[0],decision:args._decision,signature:args._signature,reason:args._reason,signed_by_email:'alex@example.test',signed_at:new Date().toISOString()};return {};}
   return {data:{id:'task-created'}};
  }};
  OGBuyerTasks.init({client,userId:'me'});OGBuyerPromiseCheckout.init({client});
 },admin);
 return page;
}
for(const width of [390,1366])test(`customer task ${width}px keeps typing stable, defaults owner, preserves failed saves and retries once`,async t=>{
 const page=await open(t,width);
 await page.getByRole('button',{name:'Customer task',exact:true}).click();
 const dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Responsible person')).toHaveValue('me');
 await dialog.getByLabel('eBay username').fill('Buyer.ONE');await dialog.getByLabel('Task title').fill('Promised clasp');
 const instructions=dialog.getByLabel('Promise / instructions');await instructions.pressSequentially('Include one silver clasp',{delay:15});
 await expect(instructions).toBeFocused();await page.setViewportSize({width,height:520});await expect(instructions).toHaveValue('Include one silver clasp');
 await page.evaluate(()=>failSave=true);await dialog.getByRole('button',{name:'Save customer task'}).click();
 await expect(dialog.getByRole('status')).toContainText('Network unavailable');await expect(instructions).toHaveValue('Include one silver clasp');
 await page.evaluate(()=>{failSave=false;delaySave=true;});await dialog.getByRole('button',{name:'Save customer task'}).click();
 await expect(dialog.getByRole('button',{name:'Saving…'})).toBeDisabled();await page.keyboard.press('Escape');await expect(dialog).toBeVisible();
 await page.evaluate(()=>finishSave());await expect(dialog).toContainText('Customer task saved');
 const writes=await page.evaluate(()=>writes);assert.equal(writes.length,2);assert.equal(writes[0].args._request_id,writes[1].args._request_id);assert.equal(writes[1].args._buyer_username,'buyer.one');
 await expect(dialog.getByRole('link',{name:'Open task'})).toHaveAttribute('href','team-tasks.html?taskId=task-created');
 assert.equal(await dialog.evaluate(el=>el.scrollWidth>el.clientWidth),false);
 await dialog.getByRole('button',{name:'Done'}).click();await expect(dialog).toHaveCount(0);
});
for(const admin of [false,true])test(`${admin?'admin deferral':'staff certification'} requires explicit checkbox and typed signature, and persists audit display`,async t=>{
 const page=await open(t,390,admin);
 assert.match(await page.evaluate(async()=>{try{await OGBuyerPromiseCheckout.assertReady([{order_id:'order-1'}]);}catch(e){return e.message;}}),/Review and sign/);
 const dialog=page.getByRole('dialog');await expect(dialog).toContainText('Include <one> silver clasp');assert.equal(await dialog.locator('one').count(),0);
 await expect(dialog.getByLabel('Decision',{exact:true})).toHaveCount(admin?1:0);
 if(admin)await dialog.getByLabel('Decision',{exact:true}).selectOption('defer');
 await dialog.getByLabel('Fulfillment details / reason').fill(admin?'Clasp not available until tomorrow':'Silver clasp packed');
 await dialog.getByLabel('Your signature').fill('Alex Person');
 await dialog.getByRole('button',{name:'Sign and save decision'}).click();assert.equal(await page.evaluate(()=>writes.length),0,'checkbox required');
 await dialog.getByRole('checkbox').check();await page.evaluate(()=>failSave=true);await dialog.getByRole('button',{name:'Sign and save decision'}).click();
 await expect(dialog.locator('[data-sign-error]')).toContainText('Network unavailable');await expect(dialog.getByLabel('Your signature')).toHaveValue('Alex Person');
 await page.evaluate(()=>failSave=false);await dialog.getByRole('button',{name:'Sign and save decision'}).click();
 await expect(dialog).toContainText(admin?'deferred to next order':'Certified · finish checkout');await expect(dialog).toContainText('alex@example.test');
 await dialog.getByRole('button',{name:'Done'}).click();
 await page.evaluate(()=>OGBuyerPromiseCheckout.assertReady([{order_id:'order-1'}]));
 const writes=await page.evaluate(()=>writes);assert.equal(writes.at(-1).args._decision,admin?'defer':'certify');
});
test('failed requirement lookup blocks fulfillment without making a business write',async t=>{
 const page=await open(t);await page.evaluate(()=>failLoad=true);
 assert.match(await page.evaluate(async()=>{try{await OGBuyerPromiseCheckout.assertReady([{order_id:'order-1'}]);}catch(e){return e.message;}}),/Connection unavailable/);
 assert.equal(await page.evaluate(()=>writes.length),0);
});
const png={name:'watch.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aFQAAAABJRU5ErkJggg==','base64')};
for(const width of [390,1366])test(`customer photo attachment ${width}px previews, removes, and survives upload/save retries`,async t=>{
 const page=await open(t,width);
 await page.evaluate(()=>OGBuyerTasks.open('buyer.one',{conversationId:'conversation-original',messageId:'message-original'}));
 const dialog=page.getByRole('dialog');await dialog.getByLabel('Task title').fill('Include certificate');await dialog.getByLabel('Promise / instructions').fill('Include this certificate on their next order');
 await dialog.getByLabel('Add photos (optional)').setInputFiles([png,{...png,name:'extra.png'}]);
 await expect(dialog.getByRole('img')).toHaveCount(2);await dialog.getByRole('button',{name:'Remove photo 2',exact:true}).click();await expect(dialog.getByRole('img')).toHaveCount(1);
 await page.evaluate(()=>failUpload=true);await dialog.getByRole('button',{name:'Save customer task'}).click();
 await expect(dialog.getByRole('status')).toContainText('Photo upload failed');assert.equal(await page.evaluate(()=>writes.length),0);
 await page.evaluate(()=>{failUpload=false;failSave=true;});await dialog.getByRole('button',{name:'Save customer task'}).click();await expect(dialog.getByRole('status')).toContainText('Network unavailable');
 await page.evaluate(()=>failSave=false);await dialog.getByRole('button',{name:'Save customer task'}).click();await expect(dialog).toContainText('Customer task saved');
 const result=await page.evaluate(()=>({uploads,writes}));assert.equal(result.uploads.length,2);assert.equal(result.uploads[0].path,result.uploads[1].path);
 assert.equal(result.writes[1].args._details._photo_attachments.length,1);assert.equal(result.writes[1].args._details._photo_attachments[0].label,'watch.png');
 assert.deepEqual(result.writes[0].args,result.writes[1].args);assert.equal(result.writes[1].args._details._message_id,'message-original');
});
test('existing customer task can link its original message without creating another task',async t=>{
 const page=await open(t);const conversation='00000000-0000-4000-8000-000000000200',message='00000000-0000-4000-8000-000000000210';
 await page.evaluate(()=>{const button=document.createElement('button');button.dataset.buyerTaskLinkSource='existing-task';button.dataset.buyerUsername='buyer.one';button.textContent='Link original conversation';document.body.append(button);});
 await page.getByRole('button',{name:'Link original conversation',exact:true}).click();const dialog=page.getByRole('dialog');
 await dialog.getByLabel('Conversation link or ID').fill(`email-triage.html?ebayConversationDbId=${conversation}&ebayMessageDbId=${message}`);
 await dialog.getByRole('button',{name:'Save conversation link'}).click();await expect(dialog).toHaveCount(0);
 const write=await page.evaluate(()=>writes[0]);assert.equal(write.name,'attach_buyer_followup_message');assert.deepEqual(write.args,{_task_id:'existing-task',_conversation_id:conversation,_message_id:message});
});
