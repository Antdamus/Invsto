import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit} from '@playwright/test';
const root=new URL('../',import.meta.url);
let server,browser,origin;
const label='<DesktopLabel Version="1"></DesktopLabel>';
before(async()=>{
 server=createServer(async(req,res)=>{
  const name=req.url.split('?')[0].slice(1);
  if(name==='fixture.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><button id="start">Print</button><script src="print-stations.js"></script><script src="additem-dymolabel.js"></script>');return;}
  if(!/^[a-z0-9.-]+$/i.test(name)){res.writeHead(404).end();return;}
  try{let content=await readFile(new URL(name,root),'utf8');if(name.endsWith('.html'))content=content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,tag=>tag.includes('src="print-stations.js')?tag:'');res.setHeader('Content-Type',name.endsWith('.js')?'application/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await (process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
});
after(async()=>{if(server)await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});await browser?.close();});
async function openPage(t,admin=true,path='fixture.html'){
 const context=await browser.newContext({viewport:{width:390,height:844},acceptDownloads:true});t.after(()=>context.close());
 await context.route('**/*',route=>route.request().url().startsWith(origin)||route.request().url().startsWith('blob:')?route.continue():route.abort());
 await context.addInitScript(({admin})=>{
  window.calls=[];window.testAdmin=admin;window.testJobs=[];window.testListError=false;window.testSendError=false;window.testRetryError=false;
  window.testStations=[{id:'a',name:'Florida counter',paired:true,online:true,printer_connected:true,printer_name:'DYMO A'},{id:'b',name:'New York counter',paired:true,online:false,printer_connected:false,printer_name:'DYMO B'}];
  window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:'staff'}}}})},rpc:async(name,args)=>{
   window.calls.push({name,args});
   if(name==='can_manage_print_stations')return {data:window.testAdmin};
   if(name==='list_print_stations')return window.testListError?{error:{message:'Connection unavailable'}}:{data:window.testStations};
   if(name==='list_label_print_jobs')return {data:window.testJobs};
   if(name==='enqueue_label_print')return window.testSendError?{error:{message:'Connection lost'}}:{data:{id:'job-1',status:'queued'}};
   if(name==='retry_label_print')return window.testRetryError?{error:{message:'Connection lost'}}:{data:{id:'job-2',status:'queued'}};
   if(name==='register_print_station')return {data:{station_id:'c',code:'1234567890ABCDEF',expires_at:new Date(Date.now()+900000).toISOString()}};
   return {data:null};
  }};
 },{admin});
 const page=await context.newPage();await page.goto(`${origin}/${path}`);await page.waitForFunction(()=>window.printStations);return page;
}
async function begin(page,options={},dymo=false){await page.evaluate(({xml,options,dymo})=>{window.testResult=null;window.testError=null;const action=dymo?dymoModule.printDymoLabelXml(xml,options):window.printStations.printLabel(xml,options);action.then(value=>window.testResult=value).catch(error=>window.testError={message:error.message,cancelled:error.cancelled});},{xml:label,options,dymo});await page.locator('[data-destination]:enabled').waitFor();}
async function send(page,station,copies){await page.locator('[data-destination]').selectOption(station);if(copies)await page.locator('[data-copies]').fill(String(copies));await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testResult||window.testError);}
test('phone DYMO integration sends copies only to the explicitly chosen offline computer',async t=>{
 const page=await openPage(t);let downloads=0;page.on('download',()=>downloads++);await begin(page,{listenerOnly:true,title:'Watch',barcode:'123'},true);await page.locator('[data-destination]').selectOption('b');assert.match(await page.locator('[data-destination-status]').innerText(),/offline.*stay assigned/);await send(page,'b',3);
 const result=await page.evaluate(()=>({result:window.testResult,calls:window.calls.filter(c=>c.name==='enqueue_label_print'),pref:localStorage.getItem('invsto.print.destination.v1')}));
 assert.equal(result.result.mode,'remote-queue');assert.equal(result.result.copies,3);assert.equal(result.calls.length,1);assert.equal(result.calls[0].args._station_id,'b');assert.equal(result.calls[0].args._copies,3);assert.equal(result.pref,'b');assert.equal(downloads,0);
});
test('ambiguous send survives reload with the same request ID and cannot reroute',async t=>{
 const page=await openPage(t);await page.evaluate(()=>window.testSendError=true);await begin(page);await send(page,'a');const original=await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._request_id);
 await begin(page);await send(page,'b');assert.match(await page.evaluate(()=>window.testError.message),/original computer/);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_label_print').length),1);
 await page.reload();await begin(page);await send(page,'a');assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._request_id),original);assert.equal(await page.evaluate(()=>Object.keys(localStorage).filter(key=>key.startsWith('invsto.print.pending.')).length),0);
});
test('viewing a confirmed job never erases the id needed to safely retry a lost enqueue response',async t=>{
 const page=await openPage(t,true,'print-stations.html');await page.locator('.print-station-card').first().waitFor();await page.evaluate(()=>window.testSendError=true);await begin(page);await send(page,'a');const original=await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._request_id);
 await page.evaluate(requestId=>{window.testJobs=[{id:'job-1',request_id:requestId,status:'queued',title:'Watch',station_name:'Florida counter',printer_name:'DYMO A',copies:1,submitted_copies:0,created_at:new Date().toISOString()}];window.testSendError=false;},original);await page.getByRole('button',{name:'Refresh status'}).click();await page.locator('[data-cancel-job]').waitFor();await begin(page);await send(page,'a');assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_label_print')[1].args._request_id),original);
});
test('closing the picker cancels without enqueuing or downloading',async t=>{
 const page=await openPage(t);let downloads=0;page.on('download',()=>downloads++);await begin(page);await page.getByRole('button',{name:'Close print destination'}).click();await page.waitForFunction(()=>window.testError);assert.equal(await page.evaluate(()=>window.testError.cancelled),true);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_label_print').length),0);assert.equal(downloads,0);
});
test('cloud outage still allows explicit local download with selected copies in filename',async t=>{
 const page=await openPage(t);await page.evaluate(()=>window.testListError=true);await begin(page,{filename:'OGJewelers_Label_Copies_1_Test.dymo'});assert.match(await page.locator('[data-message]').innerText(),/unavailable/);const downloaded=page.waitForEvent('download');await send(page,'local',4);assert.match((await downloaded).suggestedFilename(),/_Copies_4_/);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_label_print').length),0);
});
test('mobile station management safely displays names, creates a code and fits a narrow screen',async t=>{
 const page=await openPage(t,true,'print-stations.html');await page.locator('#print-setup:visible').waitFor();await page.locator('#print-station-name').fill('Florida workroom');await page.getByRole('button',{name:'Create pairing code'}).click();await page.locator('#print-pairing:visible').waitFor();assert.equal(await page.locator('#print-pair-code').innerText(),'1234-5678-90AB-CDEF');
 await page.evaluate(()=>{window.testStations[0].name='<img src=x onerror="window.injected=true">';});await page.getByRole('button',{name:'Refresh status'}).click();assert.equal(await page.locator('#print-station-list img').count(),0);assert.equal(await page.evaluate(()=>Boolean(window.injected)),false);
 await page.setViewportSize({width:320,height:740});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await page.screenshot({path:new URL('../test-results/print-stations-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
});
test('inventory staff can see stations but cannot see administration controls',async t=>{
 const page=await openPage(t,false,'print-stations.html');await page.locator('.print-station-card').first().waitFor();assert.equal(await page.locator('#print-setup').isVisible(),false);assert.equal(await page.locator('[data-disconnect]').count(),0);assert.equal(await page.locator('[data-renew]').count(),0);
});
test('uncertain reprints require confirmation and retain retry ID after a lost response and refresh',async t=>{
 const page=await openPage(t,true,'print-stations.html');await page.locator('.print-station-card').first().waitFor();await page.evaluate(()=>{window.testRetryError=true;window.testJobs=[{id:'job-a',request_id:'r-a',status:'uncertain',title:'Watch',station_name:'Florida counter',printer_name:'DYMO A',copies:2,submitted_copies:1,created_at:new Date().toISOString()}];});await page.getByRole('button',{name:'Refresh status'}).click();
 const warnings=[];page.on('dialog',dialog=>{warnings.push(dialog.message());dialog.accept();});await page.locator('[data-retry-job]').click();await page.waitForFunction(()=>window.calls.some(c=>c.name==='retry_label_print'));const firstId=await page.evaluate(()=>window.calls.find(c=>c.name==='retry_label_print').args._request_id);await page.evaluate(()=>window.testRetryError=false);await page.getByRole('button',{name:'Refresh status'}).click();await page.locator('[data-retry-job]').click();await page.waitForFunction(()=>window.calls.filter(c=>c.name==='retry_label_print').length===2);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='retry_label_print')[1].args._request_id),firstId);assert.match(warnings[0],/may already have printed/);assert.equal(await page.evaluate(()=>localStorage.getItem('invsto.print.retry.job-a')),null);
});
