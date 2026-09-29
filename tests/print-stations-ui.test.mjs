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
  if(name==='fixture.html'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><button id="start">Print</button><script src="print-stations.js"></script><script src="additem-dymolabel.js"></script>');return;}
  if(name!=='vendor/pdf-lib/pdf-lib.min.js'&&!/^[a-z0-9.-]+$/i.test(name)){res.writeHead(404).end();return;}
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
  window.testWrites=[];window.testUploads=[];window.testToasts=[];window.showToast=message=>window.testToasts.push(message);window.calls=[];window.testAdmin=admin;window.testJobs=[];window.testListError=false;window.testSendError=false;window.testRetryError=false;
  window.testStations=[{id:'a',name:'Florida counter',paired:true,online:true,printer_connected:true,printer_name:'DYMO A'},{id:'b',name:'New York counter',paired:true,online:false,printer_connected:false,printer_name:'DYMO B'}];
  window.supabase={storage:{from:bucket=>({upload:async(path,blob)=>{window.testUploads.push({bucket,path,xml:await blob.text()});return {data:{path}};}})},from:table=>{
   const query={select(){return query;},eq(){return query;},limit(){return query;},maybeSingle:async()=>({data:null}),insert(payload){window.testWrites.push({table,payload});return query;},single:async()=>({data:{id:'saved-bag'}})};return query;
  },auth:{getSession:async()=>({data:{session:{user:{id:'staff'}}}})},rpc:async(name,args)=>{
   window.calls.push({name,args});
   if(name==='receive_bulk_bag')return window.testBagError?{error:{message:'Stock save failed'}}:{data:{bag:{id:'saved-bag',bag_barcode:args._bag_barcode},stock_location_id:args._location_id?'stock-bag':null,transaction_id:args._location_id?'bag-tx':null,quantity_added:args._location_id?args._payload.estimated_qty:0}};
   if(name==='can_manage_print_stations')return {data:window.testAdmin};
   if(name==='list_print_stations')return window.testListError?{error:{message:'Connection unavailable'}}:{data:window.testStations};
   if(name==='list_label_print_jobs')return {data:window.testJobs};
   if(name==='enqueue_label_print'||name==='enqueue_shipping_label_print')return window.testSendError?{error:{message:'Connection lost'}}:{data:{id:'job-1',status:'queued'}};
   if(name==='retry_label_print')return window.testRetryError?{error:{message:'Connection lost'}}:{data:{id:'job-2',status:'queued'}};
   if(name==='configure_print_station_rolls'){Object.assign(window.testStations.find(s=>s.id===args._station_id),{default_roll:args._default_roll,left_roll_label:args._left_label,right_roll_label:args._right_label});return {data:null};}
   if(name==='register_print_station')return {data:{station_id:'c',code:'1234567890ABCDEF',expires_at:new Date(Date.now()+900000).toISOString()}};
   return {data:null};
  }};
 },{admin});
 const page=await context.newPage();const errors=[];page.on('pageerror',error=>errors.push(error.message));t.after(()=>assert.deepEqual(errors,[],'No unhandled browser errors'));await page.goto(`${origin}/${path}`);await page.waitForFunction(()=>window.printStations);return page;
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

test('inline location draft uses the captured XML and selected station without a file popup',async t=>{
 const page=await openPage(t);await page.evaluate(xml=>{window.printStations.mountLabelButton(document.querySelector('#start').parentElement,async()=>({xml,barcode:'LOC-123',title:'Shelf 1'}));},label);
 await page.getByRole('button',{name:'Print DYMO Label',exact:true}).click();await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-destination]').selectOption('b');await page.locator('[data-send]').click();await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('Queued'));
 const sent=await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args);assert.equal(sent._station_id,'b');assert.equal(sent._barcode,'LOC-123');assert.equal(sent._label_xml,label);
});
async function openBulk(t){
 const page=await openPage(t,true,'add-item.html');await page.addScriptTag({url:origin+'/additem-dymolabel.js'});await page.addScriptTag({url:origin+'/additembulk.js'});
 await page.evaluate(()=>{window.testCaptured=[];window.addEventListener('bulkbag:captured',event=>window.testCaptured.push(event.detail));window.addItemBulkModule.setupBulkModalOpeners();window.addItemBulkModule.openModal();});
 await page.locator('#bulk-item-title').fill('Small charms');await page.locator('#bulk-tare').fill('1');await page.locator('#bulk-gross').fill('6');await page.locator('#bulk-unit-override').fill('1');await page.locator('#bulk-save').click();await page.locator('[data-destination]:enabled').waitFor();return page;
}
test('bulk bag capture prints via the station and saves its label even if item globals later change',async t=>{
 const page=await openBulk(t);await page.locator('[data-destination]').selectOption('a');await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testToasts.some(text=>text.includes('Queued')));
 const before=await page.evaluate(()=>({captured:window.testCaptured,xml:window.latestDymoXml,call:window.calls.find(c=>c.name==='enqueue_label_print').args}));assert.equal(before.captured.length,1);assert.equal(before.captured[0].estimated_qty,5);assert.equal(before.call._barcode,before.captured[0].bag_barcode);assert.equal(before.call._label_xml,before.xml);
 await page.evaluate(async()=>{const bag=window.testCaptured[0];window.latestDymoXml='<DifferentItem/>';window.latestDymoBarcode='ITEM';await window.addItemBulkModule.saveRegistryForItem('item-id',bag.bag_barcode);});
 const saved=await page.evaluate(()=>({uploads:window.testUploads,writes:window.testWrites,call:window.calls.find(c=>c.name==='receive_bulk_bag').args}));assert.equal(saved.uploads.length,1);assert.equal(saved.uploads[0].xml,before.xml);assert.equal(saved.call._bag_barcode,before.captured[0].bag_barcode);assert.equal(saved.call._bag_label_url,saved.uploads[0].path);assert.equal(saved.writes.length,0,'no separate registry/stock/audit writes');
});
test('cancelled bag printing keeps the captured barcode and retry never captures a second bag',async t=>{
 const page=await openBulk(t);await page.locator('[data-cancel]').click();await page.waitForFunction(()=>window.testToasts.some(text=>text.includes('retained')));const barcode=await page.evaluate(()=>window.testCaptured[0].bag_barcode);
 await page.evaluate(()=>window.addItemBulkModule.openModal());await page.locator('#bulk-print-label').click();await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-destination]').selectOption('b');await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testToasts.some(text=>text.includes('Queued')));
 assert.equal(await page.evaluate(()=>window.testCaptured.length),1);assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._barcode),barcode);
});
test('Stock edit label uses its edited facts and retains staged XML when printing is cancelled',async t=>{
 const page=await openPage(t);await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<div id="toast-container"></div><input id="edit-barcode" value="WATCH-42"><input id="edit-qr" value="https://example.invalid/watch"><input id="edit-weight" value="50"><input id="edit-qr-type" value="website"><input id="edit-title" value="Edited watch"><button id="generate-edit-dymo-label">Generate and Print</button>');});await page.addScriptTag({url:origin+'/stock-editcards.js'});await page.evaluate(()=>window.editCardModule.setupEditCardListeners());
 await page.locator('#generate-edit-dymo-label').click();await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-cancel]').click();await page.locator('#generate-edit-dymo-label:enabled').waitFor();assert.match(await page.evaluate(()=>window.latestDymoXml),/WATCH-42/);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_label_print').length),0);
 await page.locator('#generate-edit-dymo-label').click();await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-destination]').selectOption('a');await page.locator('[data-send]').click();await page.waitForFunction(()=>document.getElementById('toast-container').textContent.includes('Queued'));assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._title),'Edited watch');
});
test('Past Live Sales reprint is audited only after the chosen station accepts the enqueue',async t=>{
 const page=await openPage(t);const source=await readFile(new URL('past-live-sales.js',root),'utf8');const start=source.indexOf('async function printLiveSaleBagLabel('),end=source.indexOf('\nfunction ',start);assert.ok(end>start);
 await page.evaluate(xml=>{window.state={lots:[{id:'lot',session_id:'session',auction_number:'12',lot_code:'BAG12',label_path:'labels/12.dymo'}],sessions:[{id:'session'}],user:{email:'staff@example.invalid'}};window.getLiveSaleLabelBaseName=()=> 'OGJewelers_Test';window.setStatus=message=>window.testToasts.push(message);window.loadPastLiveSales=async()=>{};},label);await page.addScriptTag({url:`${origin}/live-bag-label.js`});await page.addScriptTag({content:source.slice(start,end)});
 await page.evaluate(()=>{void printLiveSaleBagLabel('lot');});await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-cancel]').click();await page.waitForFunction(()=>window.testToasts.length);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='record_live_sale_label_reprint').length),0);
 await page.evaluate(()=>{void printLiveSaleBagLabel('lot');});await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-destination]').selectOption('b');await page.locator('[data-send]').click();await page.waitForFunction(()=>window.calls.some(c=>c.name==='record_live_sale_label_reprint'));const names=await page.evaluate(()=>window.calls.map(c=>c.name));assert.ok(names.indexOf('enqueue_label_print')<names.indexOf('record_live_sale_label_reprint'));assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._station_id),'b');
});
test('location detail print prepares and saves the location label before offering the station picker',async t=>{
 const page=await openPage(t);const source=await readFile(new URL('locations.js',root),'utf8');const functionStart=source.indexOf('async function regenerateLocationDymoLabel('),functionEnd=source.indexOf('\nasync function uploadCreateLocationPhoto',functionStart);const clickStart=source.indexOf('  document.getElementById("location-detail-body")?.addEventListener("click"'),clickEnd=source.indexOf('  document.getElementById("location-detail-body")?.addEventListener("submit"',clickStart);assert.ok(clickStart>0&&functionEnd>functionStart&&clickEnd>clickStart);
 await page.evaluate(xml=>{document.body.insertAdjacentHTML('beforeend','<div id="location-detail-body"><button data-open-location-dymo="loc">Print DYMO Label</button><p id="location-dymo-status"></p></div>');window.state={locations:[{id:'loc',location_code:'LOC42',location_name:'Case 2'}],dymoUrls:new Map()};window.asTrimmedString=value=>String(value||'').trim();window.buildLocationDymoXml=()=>xml;window.uploadCreateLocationDymo=async(code,name,xml)=>{window.testUploads.push({code,name,xml});return 'labels/loc.dymo';};window.renderLocationsTable=()=>{};window.renderLocationDetail=async()=>{};window.setLocationDymoStatus=text=>document.getElementById('location-dymo-status').textContent=text;window.supabase.from=table=>({update:value=>({eq:async(key,id)=>{window.testWrites.push({table,value,key,id});return {};}})});},label);
 await page.addScriptTag({content:source.slice(functionStart,functionEnd)+'\n'+source.slice(clickStart,clickEnd)});await page.locator('[data-open-location-dymo]').click();await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-destination]').selectOption('a');await page.locator('[data-send]').click();await page.waitForFunction(()=>document.getElementById('location-dymo-status').textContent.includes('Queued'));
 const sent=await page.evaluate(()=>({uploads:window.testUploads,writes:window.testWrites,call:window.calls.find(c=>c.name==='enqueue_label_print').args}));assert.equal(sent.uploads[0].xml,label);assert.equal(sent.writes[0].id,'loc');assert.equal(sent.call._barcode,'LOC42');assert.equal(sent.call._label_xml,label);
});
test('automatic item-label preparation stays silent while the explicit print action uses the station',async t=>{
 const page=await openPage(t);await page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<input id="scanned-barcode" value="COIN42"><input id="qr-code" value="https://example.invalid/coin"><input id="qr-type" value="website"><input id="title" value="Silver coin"><input id="weight" value="31.1"><div id="dymo-status"></div><button id="generate-dymo-label">Generate and Print</button>');});
 await page.evaluate(()=>window.dymoModule.generateDymoLabelFromForm({downloadPreview:false,silent:true}));assert.equal(await page.locator('.print-station-dialog').count(),0);assert.equal(await page.evaluate(()=>window.calls.length),0);
 await page.evaluate(()=>window.dymoModule.setupGenerateDymoButtonListener());await page.locator('#generate-dymo-label').click();await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-destination]').selectOption('a');await page.locator('[data-send]').click();await page.waitForFunction(()=>document.getElementById('dymo-status').textContent.includes('Queued'));assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._barcode),'COIN42');assert.match(await page.locator('#dymo-status').innerText(),/not been saved yet/);
});

async function twinStation(page,extra={}){
 await page.evaluate(extra=>Object.assign(window.testStations[0],{printer_model:'DYMO LabelWriter 450 Twin Turbo',roll_selection_ready:true,left_roll_label:'30299 jewelry tags',right_roll_label:'Address labels',default_roll:null},extra),extra);
}
test('Twin Turbo requires a roll and sends an explicit override of the saved default',async t=>{
 const page=await openPage(t);await twinStation(page);await begin(page);await page.locator('[data-destination]').selectOption('a');assert.equal(await page.locator('[data-send]').isDisabled(),true);assert.match(await page.locator('[data-roll]').innerText(),/Left roll - 30299 jewelry tags/);await page.locator('[data-roll]').selectOption('Right');await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testResult);assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._printer_roll),'Right');
 await twinStation(page,{default_roll:'Left'});await begin(page);assert.equal(await page.locator('[data-roll]').inputValue(),'Left');await page.locator('[data-roll]').selectOption('Right');await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testResult);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_label_print').at(-1).args._printer_roll),'Right');
});
test('old Twin Turbo helper cannot send a roll-specific request and single-roll destinations hide the choice',async t=>{
 const page=await openPage(t);await twinStation(page,{roll_selection_ready:false,default_roll:'Right'});await begin(page);await page.locator('[data-destination]').selectOption('a');assert.equal(await page.locator('[data-roll-update]').isVisible(),true);assert.equal(await page.locator('[data-send]').isDisabled(),true);
 await page.locator('[data-destination]').selectOption('b');assert.equal(await page.locator('[data-roll-section]').isVisible(),false);await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testResult);assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._printer_roll),'default');
});
test('lost response cannot silently change rolls and preserves its request id after reload',async t=>{
 const page=await openPage(t);await twinStation(page,{default_roll:'Left'});await page.evaluate(()=>window.testSendError=true);await begin(page);await send(page,'a');const request=await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._request_id);
 await begin(page);await page.locator('[data-roll]').selectOption('Right');await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testError);assert.match(await page.evaluate(()=>window.testError.message),/original computer and roll/);assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_label_print').length),1);
 await page.reload();await twinStation(page,{default_roll:'Left'});await begin(page);await send(page,'a');assert.equal(await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_label_print').args._request_id),request);
});
test('mobile roll configuration survives refresh and appears in the print picker and job history',async t=>{
 const page=await openPage(t,true,'print-stations.html');await twinStation(page);await page.getByRole('button',{name:'Refresh status'}).click();await page.locator('[data-configure-rolls]').click();await page.locator('[data-left]').fill('30299 tags');await page.locator('[data-right]').fill('Address <label>');await page.locator('[data-default-roll]').selectOption('Right');await page.getByRole('button',{name:'Save roll settings'}).click();await page.waitForFunction(()=>window.calls.some(c=>c.name==='configure_print_station_rolls'));await page.locator('[data-configure-rolls]').waitFor();
 await page.evaluate(()=>window.testJobs=[{id:'roll-job',status:'queued',title:'Tag',station_name:'Florida',printer_name:'DYMO',printer_roll:'Right',copies:1,submitted_copies:0,created_at:new Date().toISOString()}]);await page.getByRole('button',{name:'Refresh status'}).click();assert.match(await page.locator('.print-job-card').innerText(),/Right roll/);
 await begin(page);await page.locator('[data-destination]').selectOption('a');assert.equal(await page.locator('[data-roll]').inputValue(),'Right');assert.match(await page.locator('[data-roll]').innerText(),/Address <label>/);await page.setViewportSize({width:320,height:740});assert.ok(await page.locator('.print-station-dialog').evaluate(el=>el.scrollWidth<=el.clientWidth));await page.screenshot({path:new URL('../test-results/print-rolls-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:false});await page.locator('[data-cancel]').click();
});


test('bag measurements cannot be replaced by a later capture and failed stock saves stay failures',async t=>{
 const page=await openBulk(t);await page.locator('[data-cancel]').click();await page.waitForFunction(()=>window.testToasts.some(text=>text.includes('retained')));
 const first=await page.evaluate(()=>window.testCaptured[0]);
 await page.evaluate(()=>window.addItemBulkModule.openModal());await page.locator('#bulk-gross').fill('9');await page.locator('#bulk-save').click();await page.locator('[data-destination]:enabled').waitFor();await page.locator('[data-cancel]').click();
 await page.waitForFunction(()=>window.testCaptured.length===2);
 const result=await page.evaluate(async first=>{window.testBagError=true;return window.addItemBulkModule.saveRegistryForItem('first-item',first.bag_barcode,'tray');},first);
 assert.equal(result.data,null);assert.match(result.error.message,/Stock save failed/);
 let calls=await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_bulk_bag'));assert.equal(calls[0].args._payload.estimated_qty,5);assert.equal(calls[0].args._bag_barcode,first.bag_barcode);
 const retry=await page.evaluate(async first=>{window.testBagError=false;return window.addItemBulkModule.saveRegistryForItem('first-item',first.bag_barcode,'tray');},first);
 assert.equal(retry.receipt.quantity_added,5);calls=await page.evaluate(()=>window.calls.filter(c=>c.name==='receive_bulk_bag'));assert.deepEqual(calls[0].args,calls[1].args);
 assert.equal(await page.evaluate(()=>window.testWrites.length),0);
 await page.evaluate(()=>window.addItemBulkModule.clearCapture());assert.equal(await page.evaluate(()=>window.addItemBulkModule.getCapturedBag()),null);
 assert.equal((await page.evaluate(()=>window.addItemBulkModule.saveRegistryForItem('next-item',null))).skipped,true);
});

test('bag capture rejects negative tare and quantities below one unit',async t=>{
 const page=await openBulk(t);await page.locator('[data-cancel]').click();await page.waitForFunction(()=>window.testToasts.some(text=>text.includes('retained')));await page.evaluate(()=>window.addItemBulkModule.openModal());
 await page.locator('#bulk-tare').fill('-1');assert.equal(await page.locator('#bulk-save').isDisabled(),true);
 await page.locator('#bulk-tare').fill('1');await page.locator('#bulk-gross').fill('1.5');assert.equal(await page.locator('#bulk-save').isDisabled(),true);
 await page.locator('#bulk-gross').fill('6');assert.equal(await page.locator('#bulk-save').isEnabled(),true);
 await page.locator('#bulk-tare').fill('0');await page.locator('#bulk-gross').fill('0.3');await page.locator('#bulk-unit-override').fill('0.1');assert.equal(await page.locator('#bulk-estimated-qty').innerText(),'3');
});

async function setupShipping(page){
 await page.addScriptTag({url:origin+'/vendor/pdf-lib/pdf-lib.min.js'});
 await page.addScriptTag({url:origin+'/shipping-pdf.js'});
 await page.addScriptTag({url:origin+'/shipping-label-print.js'});
 await page.evaluate(async()=>{
  window.testStations.push({id:'pdf',name:'Sandra shipping',paired:true,online:true,printer_connected:true,printer_name:'DYMO LabelWriter 5XL',pdf_print_ready:true});
  window.testStations.push({id:'old-pdf',name:'Old shipping helper',paired:true,online:true,printer_connected:true,printer_name:'DYMO LabelWriter 5XL',pdf_print_ready:false});
  const doc=await PDFLib.PDFDocument.create();doc.addPage([288,432]);doc.addPage([288,432]);
  window.pdfBytes=await doc.save();
  window.supabase.storage.from=()=>({createSignedUrl:async()=>({data:{signedUrl:URL.createObjectURL(new Blob([window.pdfBytes],{type:'application/pdf'}))}})});
 });
}
async function beginShipping(page){
 await page.evaluate(()=>{
  window.testResult=null;window.testError=null;
  window.shippingLabelPrint.printSaved({path:'test/label.pdf',title:'Order shipping label'}).then(value=>window.testResult=value).catch(error=>window.testError={message:error.message,cancelled:error.cancelled});
 });
 await page.locator('[data-destination]:enabled').waitFor();
}
test('mobile shipping PDF picker isolates 5XL, requires pages and preserves page/copy selection',async t=>{
 const page=await openPage(t);await setupShipping(page);await beginShipping(page);
 const options=await page.locator('[data-destination] option').allTextContents();assert.equal(options.length,3);assert.equal(options.some(text=>text.includes('Florida')||text.includes('local helper')),false);
 await page.locator('[data-destination]').selectOption('old-pdf');assert.equal(await page.locator('[data-send]').isDisabled(),true);assert.match(await page.locator('[data-destination-status]').innerText(),/Update/);
 await page.locator('[data-destination]').selectOption('pdf');await page.locator('[data-send]').click();assert.match(await page.locator('[data-message]').innerText(),/Choose.*page/);
 await page.locator('[data-pages]').fill('2');await page.locator('[data-copies]').fill('2');
 await page.setViewportSize({width:320,height:640});assert.ok(await page.locator('dialog').evaluate(el=>el.getBoundingClientRect().width<=innerWidth));
 await page.screenshot({path:new URL('../test-results/shipping-print-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 await page.locator('[data-send]').click();await page.waitForFunction(()=>window.testResult||window.testError);
 const result=await page.evaluate(()=>({error:window.testError,result:window.testResult,call:window.calls.find(c=>c.name==='enqueue_shipping_label_print')}));
 assert.equal(result.error,null);assert.deepEqual(result.call.args._source_pages,[2]);assert.equal(result.call.args._copies,2);assert.equal(result.call.args._station_id,'pdf');assert.match(result.call.args._pdf_base64,/^JVBER/);assert.match(result.result.message,/2 shipping/);
});
test('shipping PDF lost acknowledgement uses the same request on retry and rejects unsupported sheets',async t=>{
 const page=await openPage(t);await setupShipping(page);await page.evaluate(()=>window.testSendError=true);await beginShipping(page);await page.locator('[data-pages]').fill('1');await send(page,'pdf');
 const first=await page.evaluate(()=>window.calls.find(c=>c.name==='enqueue_shipping_label_print').args._request_id);
 await page.evaluate(()=>window.testSendError=false);await beginShipping(page);await page.locator('[data-pages]').fill('1');await send(page,'pdf');
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_shipping_label_print')[1].args._request_id),first);
 await page.evaluate(async()=>{const doc=await PDFLib.PDFDocument.create();doc.addPage([612,792]);window.pdfBytes=await doc.save();});
 await beginShipping(page);await send(page,'pdf');assert.match(await page.evaluate(()=>window.testError.message),/4 × 6/);
 assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.name==='enqueue_shipping_label_print').length),2);
});
