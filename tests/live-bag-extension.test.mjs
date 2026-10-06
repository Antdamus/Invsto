import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import vm from 'node:vm';
import {chromium,expect} from '@playwright/test';
const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
  server=createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1);
    if(name.startsWith('ebaylive/'))return res.end('<!doctype html><html><head><meta charset="utf-8"></head><body style="background:#f4f5f6;font:16px system-ui"><h1>Stream Manager · fixture</h1><div id="og-ebay-cancellation-panel">Finding eBay cancellations...</div></body></html>');
    if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
    try{const data=await readFile(new URL(name,root));res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(data);}catch{res.writeHead(404).end();}
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;browser=await chromium.launch();
});
after(async()=>{await browser?.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});
async function open(t,{configured=true}={}){
  const context=await browser.newContext({viewport:{width:1280,height:760}});t.after(()=>context.close());
  await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin+'/ebaylive/host/events/EVENT123?capture=1');
  await page.evaluate(configured=>{
    window.calls=[];window.jobs=[];window.failAfterQueue=false;window.delayedPrint=false;window.runtimeListeners=[];
    window.sales=[
      {id:'00000000-0000-4000-8000-000000000001',listing_title:'#004 - Gold chain',buyer:'earlier-winner',payment_state:'paid',sold_at:'2026-10-06T15:01:00Z',event_id:'EVENT123'},
      {id:'00000000-0000-4000-8000-000000000002',listing_title:'#012 - Silver bracelet',buyer:'current-winner',payment_state:'paid',sold_at:'2026-10-06T15:03:00Z',event_id:'EVENT123'},
      {id:'00000000-0000-4000-8000-000000000003',listing_title:'#013 - Watch',buyer:'waiting-winner',payment_state:'waiting',sold_at:'2026-10-06T15:04:00Z',event_id:'EVENT123'},
      {id:'00000000-0000-4000-8000-000000000004',listing_title:'#014 - Watch',buyer:'held-winner',payment_state:'paid',payment_hold:true,sold_at:'2026-10-06T15:05:00Z',event_id:'EVENT123'}];
    window.lots=[];window.stations=[{id:'station-a',name:'Show computer',printer_name:'DYMO LabelWriter 450 Twin Turbo',paired:true,online:true,printer_connected:true,roll_selection_ready:true,default_roll:'Left'}];
    if(configured)localStorage.setItem('invsto.print.destination.v1','station-a');
    window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:'staff-a'}}}})},from(table){let selected;
      const q={select(){return q},eq(key,value){selected=value;return q},maybeSingle:async()=>({data:table==='ebay_live_connections'?{event_id:selected,session_id:'session-'+selected}:null})};return q;
    },rpc:async(name,args)=>{
      calls.push({name,args});
      if(name==='list_print_stations')return {data:stations};
      if(name==='get_ebay_live_dashboard')return {data:{connection:{event_id:args._session_id.replace('session-','')},attempts:sales.filter(s=>args._session_id==='session-'+s.event_id)}};
      if(name==='prepare_ebay_live_bag_label'){
        const sale=sales.find(s=>s.id===args._attempt_id);if(!sale||sale.payment_state!=='paid')return {error:{message:'Payment not confirmed'}};
        let lot=lots.find(l=>l.id===sale.lot_id);if(!lot){lot={id:'lot-'+sale.id,lot_code:'LIVE-'+sale.id.slice(-8),auction_number:'EB-12-TEST'};lots.push(lot);sale.lot_id=lot.id;}return {data:lot};
      }
      if(name==='enqueue_label_print'){
        let job=jobs.find(j=>j.requestId===args._request_id);
        if(job){if(JSON.stringify(job.args)!==JSON.stringify(args))return {error:{message:'Request changed'}};return {data:job};}
        job={id:'job-'+jobs.length,status:'queued',requestId:args._request_id,args};jobs.push(job);
        if(delayedPrint)await new Promise(resolve=>window.finishPrint=resolve);
        if(failAfterQueue){failAfterQueue=false;return {error:{message:'Acknowledgement lost'}};}
        return {data:job};
      }return {data:null};
    }};
    window.chrome={runtime:{id:'fixture',onMessage:{addListener:fn=>runtimeListeners.push(fn)},sendMessage:async message=>{
      if(message.type!=='INVSTO_BAG_LABEL_COMMAND')return {ok:true,events:[]};
      return new Promise(resolve=>runtimeListeners.forEach(fn=>fn({type:'INVSTO_BAG_LABEL_BRIDGE',command:message.command},{id:'fixture'},resolve)));
    }}};
  },configured);
  for(const script of ['live-bag-label.js','print-stations.js','live-bag-print-bridge.js','tools/ebay-live-capture/receiver.js','tools/ebay-live-capture/bag-label.js'])await page.addScriptTag({url:origin+'/'+script});
  await page.evaluate(()=>{
    liveBagPrintBridge.install({async printBag(id,options){
      calls.push({name:'existing-live-sales-print',id,options});
      const lot=lots.find(l=>l.id===id),sale=sales.find(s=>s.lot_id===id);
      return printStations.printLabel(liveBagLabel.build(liveBagLabel.identity(lot,sale)),{...options,title:sale.listing_title,barcode:lot.lot_code});
    }},rows=>rows.toSorted((a,b)=>Date.parse(b.sold_at)-Date.parse(a.sold_at)));
    const box=document.createElement('div');box.id='invsto-capture-helper';document.body.append(box);InvstoBagLabelPanel.mount(box);
  });
  await expect(page.locator('.bag-number')).toHaveText('#012');return page;
}
test('compact panel prints the exact saved paid bag through the existing queue and preserves QR identity',async t=>{
  const page=await open(t);
  await expect(page.locator('.bag-buyer')).toHaveText('current-winner');
  await expect(page.locator('#og-ebay-cancellation-panel')).toBeHidden();
  assert.equal(await page.locator('#invsto-listing-helper').count(),0);
  assert.equal(await page.locator('[data-bag-choice] option').count(),3,'waiting and held sales are not printable');
  assert.equal(await page.evaluate(()=>calls.some(c=>/prepare|enqueue|claim/.test(c.name))),false,'viewing the panel does not create a bag or print');
  await page.getByRole('button',{name:'Print label',exact:true}).click();
  await expect(page.locator('[data-bag-status]')).toContainText('Label queued');
  const result=await page.evaluate(()=>({jobs,lots,calls}));assert.equal(result.jobs.length,1);
  assert.equal(result.calls.filter(c=>c.name==='existing-live-sales-print').length,1);
  assert.equal(result.jobs[0].args._station_id,'station-a');assert.equal(result.jobs[0].args._printer_roll,'Left');
  assert.match(result.jobs[0].args._label_xml,/#012/);assert.match(result.jobs[0].args._label_xml,/CURRENT-WINNER/);
  assert.ok(result.jobs[0].args._label_xml.includes(result.lots[0].lot_code));
  assert.equal(result.calls.some(c=>/claim_ebay|close_ebay|inventory/.test(c.name)),false);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await page.locator('#invsto-capture-helper').screenshot({path:'test-results/live-bag-extension.png'});
  await page.getByRole('button',{name:'Reprint label',exact:true}).click();await expect.poll(()=>page.evaluate(()=>jobs.length)).toBe(2);
  assert.notEqual((await page.evaluate(()=>jobs))[0].requestId,(await page.evaluate(()=>jobs))[1].requestId);
});
test('printer setup uses the existing picker once, then an interrupted send retries without duplicate jobs',async t=>{
  const page=await open(t,{configured:false});await page.locator('[data-bag-print]').click();
  await expect(page.locator('.print-destination-picker')).toBeVisible();
  await page.locator('[data-destination]').selectOption('station-a');await page.locator('[data-roll]').selectOption('Right');
  await page.getByRole('button',{name:'Use this printer',exact:true}).click();
  await expect(page.locator('[data-bag-print]')).toHaveText('Print label');assert.equal(await page.evaluate(()=>jobs.length),0);
  await page.evaluate(()=>{failAfterQueue=true;});await page.locator('[data-bag-print]').click();
  await expect(page.locator('[data-bag-print]')).toHaveText('Retry send');assert.equal(await page.evaluate(()=>jobs.length),1);
  await page.locator('[data-bag-print]').click();await expect(page.locator('[data-bag-status]')).toContainText('Label queued');
  const jobs=await page.evaluate(()=>window.jobs);assert.equal(jobs.length,1);assert.equal(jobs[0].args._printer_roll,'Right');
  assert.equal(await page.locator('.print-destination-picker').count(),0);
});
test('the visible dropdown prints an earlier bag even after many newer sales and stays on that buyer',async t=>{
  const page=await open(t),choice=page.getByRole('combobox',{name:'Choose a bag to print'});
  await expect(choice).toBeVisible();assert.equal(await page.locator('#invsto-capture-helper details').getAttribute('open'),null);
  await page.evaluate(()=>{
    for(let i=20;i<56;i++)sales.push({...sales[1],id:`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`,listing_title:`#${i} - Ring`,buyer:`winner-${i}`,sold_at:`2026-10-06T16:${i}:00Z`,lot_id:null});
  });
  await expect(choice.locator('option')).toHaveCount(39,{timeout:8000});
  await choice.selectOption('00000000-0000-4000-8000-000000000001');
  await expect(page.locator('.bag-number')).toHaveText('#004');await expect(page.locator('.bag-buyer')).toHaveText('earlier-winner');
  await expect(page.locator('[data-bag-heading]')).toHaveText('Selected bag');
  assert.equal(await page.evaluate(()=>jobs.length),0,'selection alone does not send a label');
  await page.evaluate(()=>{sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000099',listing_title:'#099 - Pendant',buyer:'latest-winner',sold_at:'2026-10-06T17:00:00Z',lot_id:null});});
  await expect(choice.locator('option')).toHaveCount(40,{timeout:8000});await expect(page.locator('.bag-number')).toHaveText('#004');
  await page.getByRole('button',{name:'Print label',exact:true}).click();await expect(page.locator('[data-bag-status]')).toContainText('Label queued · #004');
  const job=await page.evaluate(()=>jobs[0]);assert.match(job.args._label_xml,/#004/);assert.match(job.args._label_xml,/EARLIER-WINNER/);
  assert.doesNotMatch(job.args._label_xml,/LATEST-WINNER/);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await page.locator('#invsto-capture-helper').screenshot({path:'test-results/live-bag-extension-previous.png'});
  await choice.selectOption('');await expect(page.locator('.bag-number')).toHaveText('#099');await expect(page.locator('[data-bag-heading]')).toHaveText('Latest paid bag');
});
test('a sale arriving during print cannot replace the bag being sent and stale payment blocks printing',async t=>{
  const page=await open(t);await page.evaluate(()=>{delayedPrint=true;});await page.locator('[data-bag-print]').click();
  await expect.poll(()=>page.evaluate(()=>jobs.length)).toBe(1);
  await page.evaluate(()=>{sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000009',listing_title:'#020 - Ring',buyer:'new-winner',sold_at:'2026-10-06T16:00:00Z',lot_id:null});finishPrint();});
  await expect(page.locator('[data-bag-status]')).toContainText('Label queued');
  assert.match(await page.evaluate(()=>jobs[0].args._label_xml),/CURRENT-WINNER/);
  await expect(page.locator('.bag-number')).toHaveText('#020',{timeout:8000});
  await page.evaluate(()=>{sales.at(-1).payment_state='failed';});await page.locator('[data-bag-print]').click();
  await expect(page.locator('[data-bag-status]')).toContainText('not cleared');assert.equal(await page.evaluate(()=>jobs.length),1);
});
test('receiver requests are scoped to the supplied event, never the selected show or another auction attempt',async t=>{
  const page=await open(t);
  const result=await page.evaluate(async()=>{
    const requestId=crypto.randomUUID();
    return chrome.runtime.sendMessage({type:'INVSTO_BAG_LABEL_COMMAND',command:{action:'print',event_id:'OTHER123',attemptId:sales[1].id,requestId}});
  });assert.equal(result.ok,false);assert.match(result.error,/not cleared/);assert.equal(await page.evaluate(()=>jobs.length),0);
});
test('worker binds bag requests to their eBay event and does not automatically duplicate a disconnected print',async()=>{
  const source=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');let handler,sent=[],focused=[],fail=false;
  const stored={capture:{events:{},health:{},receivers:{8:2,9:1}}};
  const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>Object.assign(stored,v)}},runtime:{id:'extension',onMessage:{addListener:fn=>handler=fn}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{update:async(id)=>focused.push(id),sendMessage:async(id,message)=>{sent.push({id,message});if(fail)throw Error('Closed');return {ok:true,printer:{name:'Show printer'}};}}};
  vm.runInNewContext(source,{chrome,URL,Date,Promise,Error,Object,Number,String});
  const send=command=>new Promise(resolve=>handler({type:'INVSTO_BAG_LABEL_COMMAND',command},{id:'extension',tab:{id:3,url:'https://www.ebay.com/ebaylive/host/events/EVENT123'}},resolve));
  assert.equal((await send({action:'status',event_id:'WRONG123'})).ok,false);assert.equal(sent.length,0);
  assert.equal((await send({action:'configure',event_id:'EVENT123'})).ok,true);assert.deepEqual(focused,[8,3]);
  sent=[];fail=true;assert.equal((await send({action:'print',event_id:'EVENT123'})).ok,false);assert.equal(sent.length,1);
});
