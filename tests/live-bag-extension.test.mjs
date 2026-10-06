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
async function open(t,{configured=true,sharedContext,seed}={}){
  const context=sharedContext||await browser.newContext({viewport:{width:1280,height:760}});if(!sharedContext)t.after(()=>context.close());
  await context.route('**/*',route=>route.request().url().startsWith(origin)?route.continue():route.abort());
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));t.after(()=>assert.deepEqual(errors,[]));
  await page.goto(origin+'/ebaylive/host/events/EVENT123?capture=1');
  await page.evaluate(({configured,seed})=>{
    window.calls=[];window.jobs=[];window.ended=false;window.failAfterQueue=false;window.delayedPrint=false;window.runtimeListeners=[];window.photoFiles={};window.photos=[];window.captureCount=0;
    window.sales=[
      {id:'00000000-0000-4000-8000-000000000001',listing_title:'#004 - Gold chain',buyer:'earlier-winner',payment_state:'paid',sold_at:'2026-10-06T15:01:00Z',event_id:'EVENT123'},
      {id:'00000000-0000-4000-8000-000000000002',listing_title:'#012 - Silver bracelet',buyer:'current-winner',payment_state:'paid',sold_at:'2026-10-06T15:03:00Z',event_id:'EVENT123'},
      {id:'00000000-0000-4000-8000-000000000003',listing_title:'#013 - Watch',buyer:'waiting-winner',payment_state:'waiting',sold_at:'2026-10-06T15:04:00Z',event_id:'EVENT123'},
      {id:'00000000-0000-4000-8000-000000000004',listing_title:'#014 - Watch',buyer:'held-winner',payment_state:'paid',payment_hold:true,sold_at:'2026-10-06T15:05:00Z',event_id:'EVENT123'}];
    window.lots=[];window.stations=[{id:'station-a',name:'Show computer',printer_name:'DYMO LabelWriter 450 Twin Turbo',paired:true,online:true,printer_connected:true,roll_selection_ready:true,default_roll:'Left'}];
    if(configured)localStorage.setItem('invsto.print.destination.v1','station-a');
    window.supabase={auth:{getSession:async()=>({data:{session:{user:{id:'staff-a'}}}})},storage:{from:()=>({upload:async(path,blob,options)=>{
      calls.push({name:'upload-bag-photo',path,size:blob.size,options});
      if(photoFiles[path])return {error:{statusCode:'409'}};photoFiles[path]=await blob.text();return {data:{path}};
    }})},from(table){let selected;
      const q={select(){return q},eq(key,value){selected=value;return q},maybeSingle:async()=>({data:table==='ebay_live_connections'?{event_id:selected,session_id:'session-'+selected}:null})};return q;
    },rpc:async(name,args)=>{
      calls.push({name,args});
      if(name==='list_print_stations')return {data:stations};
      if(name==='attach_ebay_live_bag_photo'){
        const sale=sales.find(s=>s.id===args._attempt_id);if(sale?.payment_state!=='paid')return {error:{message:'Payment is not confirmed'}};
        let photo=photos.find(p=>p.id===args._photo_id);if(!photo){photo={id:args._photo_id,...args};photos.push(photo);}
        if(window.delayedPhoto)await new Promise(resolve=>window.finishPhoto=resolve);
        if(window.failPhotoAck){window.failPhotoAck=false;return {error:{message:'Photo confirmation lost'}};}
        return {data:photo};
      }
      if(name==='get_ebay_live_dashboard')return {data:{server_time:new Date().toISOString(),connection:{event_id:args._session_id.replace('session-',''),broadcast_ended_at:ended?'2026-10-06':null},attempts:sales.filter(s=>args._session_id==='session-'+s.event_id)}};
      if(name==='get_ebay_live_bag_print_status'){
        if(window.receiptsUnavailable)return {error:{message:'Status temporarily unavailable'}};
        return {data:sales.filter(s=>s.event_id===args._event_id).flatMap(s=>{
          const lot=lots.find(l=>l.id===s.lot_id),job=lot&&jobs.findLast(j=>j.args._label_xml?.includes(lot.lot_code));
          return job?[{attempt_id:s.id,job_id:job.id,status:job.status,station_name:'Show computer',printer_roll:job.args._printer_roll,copies:1,submitted_copies:job.status==='submitted'?1:0,updated_at:job.updated_at}]:[];
        })};
      }
      if(name==='prepare_ebay_live_bag_label'){
        const sale=sales.find(s=>s.id===args._attempt_id);if(!sale||sale.payment_state!=='paid')return {error:{message:'Payment not confirmed'}};
        let lot=lots.find(l=>l.id===sale.lot_id);if(!lot){lot={id:'lot-'+sale.id,lot_code:'LIVE-'+sale.id.slice(-8),auction_number:'EB-12-TEST'};lots.push(lot);sale.lot_id=lot.id;}return {data:lot};
      }
      if(name==='enqueue_ebay_live_auto_label'){const prior=jobs.find(j=>j.requestId===args._attempt_id);if(prior)return {data:prior};args={...args,_request_id:args._attempt_id};}
      if(name==='enqueue_label_print'||name==='enqueue_ebay_live_auto_label'){
        let job=jobs.find(j=>j.requestId===args._request_id);
        if(job){if(JSON.stringify(job.args)!==JSON.stringify(args))return {error:{message:'Request changed'}};return {data:job};}
        job={id:'job-'+jobs.length,status:'queued',requestId:args._request_id,args,updated_at:new Date().toISOString()};jobs.push(job);
        if(delayedPrint)await new Promise(resolve=>window.finishPrint=resolve);
        if(failAfterQueue){failAfterQueue=false;return {error:{message:'Acknowledgement lost'}};}
        return {data:job};
      }return {data:null};
    }};
    window.chrome={runtime:{id:'fixture',onMessage:{addListener:fn=>runtimeListeners.push(fn)},sendMessage:async message=>{
      if(message.type!=='INVSTO_BAG_LABEL_COMMAND')return {ok:true,events:[]};
      if(message.command.action==='capture'){
        captureCount++;if(window.failFrame)return {ok:false,error:'Video is not playing'};
        const canvas=document.createElement('canvas');canvas.width=360;canvas.height=640;const ctx=canvas.getContext('2d');ctx.fillStyle=window.frameColor||'#bf9558';ctx.fillRect(0,0,360,640);
        return {ok:true,image:{dataUrl:canvas.toDataURL('image/jpeg',.9),width:360,height:640,capturedAt:new Date().toISOString()}};
      }
      return new Promise(resolve=>runtimeListeners.forEach(fn=>fn({type:'INVSTO_BAG_LABEL_BRIDGE',command:message.command},{id:'fixture'},resolve)));
    }}};
    if(seed){sales=seed.sales;jobs=seed.jobs;lots=seed.lots;}
  },{configured,seed});
  for(const script of ['live-bag-label.js','print-stations.js','live-bag-print-bridge.js','tools/ebay-live-capture/receiver.js','tools/ebay-live-capture/bag-label.js'])await page.addScriptTag({url:origin+'/'+script});
  await page.evaluate(()=>{
    liveBagPrintBridge.install({async printBag(id,options){
      calls.push({name:'existing-live-sales-print',id,options});
      const lot=lots.find(l=>l.id===id),sale=sales.find(s=>s.lot_id===id);
      return printStations.printLabel(liveBagLabel.build(liveBagLabel.identity(lot,sale)),{...options,title:sale.listing_title,barcode:lot.lot_code});
    }},rows=>rows.toSorted((a,b)=>Date.parse(b.sold_at)-Date.parse(a.sold_at)));
    const box=document.createElement('div');box.id='invsto-capture-helper';document.body.append(box);InvstoBagLabelPanel.mount(box);
  });
  await expect(page.locator('.bag-number')).not.toHaveText('—');return page;
}
test('compact panel prints the exact saved paid bag through the existing queue and preserves QR identity',async t=>{
  const page=await open(t);
  await expect(page.locator('.bag-buyer')).toHaveText('current-winner');
  await expect(page.locator('#og-ebay-cancellation-panel')).toBeHidden();
  assert.equal(await page.locator('#invsto-listing-helper').count(),0);
  assert.equal(await page.locator('[data-bag-choice] option').count(),3,'waiting and held sales are not printable');
  assert.equal(await page.evaluate(()=>calls.some(c=>/prepare|enqueue|claim/.test(c.name))),false,'viewing the panel does not create a bag or print');
  await page.getByRole('button',{name:'Print label',exact:true}).click();
  await expect(page.locator('[data-bag-receipt]')).toContainText('Waiting for printer');
  const result=await page.evaluate(()=>({jobs,lots,calls}));assert.equal(result.jobs.length,1);
  assert.equal(result.calls.filter(c=>c.name==='existing-live-sales-print').length,1);
  assert.equal(result.jobs[0].args._station_id,'station-a');assert.equal(result.jobs[0].args._printer_roll,'Left');
  assert.match(result.jobs[0].args._label_xml,/#012/);assert.match(result.jobs[0].args._label_xml,/CURRENT-WINNER/);
  assert.ok(result.jobs[0].args._label_xml.includes(result.lots[0].lot_code));
  assert.equal(result.calls.some(c=>/claim_ebay|close_ebay|inventory/.test(c.name)),false);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await page.locator('#invsto-capture-helper').screenshot({path:'test-results/live-bag-extension.png'});
  await expect(page.locator('[data-bag-print]')).toBeDisabled();
  await page.evaluate(()=>{jobs[0].status='submitted';});
  await expect(page.locator('[data-bag-receipt]')).toContainText('Sent to printer');
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
  await page.locator('[data-bag-print]').click();await expect(page.locator('[data-bag-receipt]')).toContainText('Waiting for printer');
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
  await page.getByRole('button',{name:'Print label',exact:true}).click();await expect(page.locator('[data-bag-receipt]')).toContainText('Waiting for printer');
  const job=await page.evaluate(()=>jobs[0]);assert.match(job.args._label_xml,/#004/);assert.match(job.args._label_xml,/EARLIER-WINNER/);
  assert.doesNotMatch(job.args._label_xml,/LATEST-WINNER/);
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await page.locator('#invsto-capture-helper').screenshot({path:'test-results/live-bag-extension-previous.png'});
  await choice.selectOption('');await expect(page.locator('.bag-number')).toHaveText('#099');await expect(page.locator('[data-bag-heading]')).toHaveText('Latest paid bag');
});
test('a sale arriving during print cannot replace the bag being sent and stale payment blocks printing',async t=>{
  const page=await open(t);await page.evaluate(()=>{delayedPrint=true;});await page.locator('[data-bag-print]').click();
  await expect.poll(()=>page.evaluate(()=>jobs.length)).toBe(1);
  await page.evaluate(()=>{sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000009',listing_title:'#020 - Ring',buyer:'new-winner',sold_at:'2026-10-06T16:00:00Z',lot_id:null});finishPrint();});
  await expect(page.locator('[data-bag-receipt]')).toContainText('Waiting for printer');
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
test('new paid sales print automatically, retain the earlier-bag selection, and survive receiver reloads without duplicates',async t=>{
  const page=await open(t);await expect(page.locator('[data-bag-auto-state]')).toContainText('Auto print on');
  await page.getByRole('combobox',{name:'Choose a bag to print'}).selectOption('00000000-0000-4000-8000-000000000001');
  await page.evaluate(()=>{sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000080',listing_title:'#080 - Pendant',buyer:'auto-winner',sold_at:new Date().toISOString(),lot_id:null});sales[2].payment_state='paid';});
  await expect.poll(()=>page.evaluate(()=>jobs.length),{timeout:10000}).toBe(2);
  const sent=await page.evaluate(()=>jobs);assert.ok(sent.every(j=>j.args._attempt_id));assert.ok(sent.some(j=>j.args._label_xml.includes('AUTO-WINNER')));
  await expect(page.locator('.bag-number')).toHaveText('#004');
  const seed=await page.evaluate(()=>({sales,jobs,lots}));
  const reloaded=await open(t,{sharedContext:page.context(),seed});
  await expect(reloaded.locator('[data-bag-receipt]')).toContainText('Waiting for printer');
  assert.equal(await reloaded.evaluate(()=>calls.some(c=>c.name==='enqueue_ebay_live_auto_label')),false);
  assert.equal(await reloaded.evaluate(()=>jobs.length),2);
  await reloaded.locator('#invsto-capture-helper').screenshot({path:'test-results/live-bag-extension-auto.png'});
});
test('automatic retries reuse the same job after a lost acknowledgement and ignore historical backfills',async t=>{
  const page=await open(t);await page.evaluate(()=>{failAfterQueue=true;sales[2].payment_state='paid';sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000070',listing_title:'#070 - History',sold_at:'2026-01-01T00:00:00Z'});});
  await expect(page.locator('[data-bag-auto-status]')).toContainText('Acknowledgement lost',{timeout:8000});
  await expect(page.locator('[data-bag-auto-status]')).toBeHidden({timeout:8000});
  await expect(page.locator('[data-bag-receipt]')).toContainText('Waiting for printer');
  assert.equal(await page.evaluate(()=>jobs.length),1);assert.equal(await page.evaluate(()=>jobs[0].requestId), '00000000-0000-4000-8000-000000000003');
});
test('a Paid card waits for its later auction time across reloads, then prints exactly once',async t=>{
  const page=await open(t);
  await page.evaluate(()=>{sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000088',listing_title:'#088 - Paid before Activity',sold_at:null,lot_id:null});});
  await expect(page.locator('[data-bag-auto-status]')).toContainText('1 bag label waiting for auto print',{timeout:8000});
  assert.equal(await page.evaluate(()=>jobs.length),0);
  const seed=await page.evaluate(()=>({sales,jobs,lots}));await page.close();
  const resumed=await open(t,{sharedContext:page.context(),seed});
  await expect(resumed.locator('[data-bag-auto-status]')).toContainText('1 bag label waiting for auto print');
  assert.equal(await resumed.evaluate(()=>jobs.length),0,'polling an unknown timestamp must not mistake it for a witnessed payment transition');
  await resumed.evaluate(()=>{sales.at(-1).sold_at=new Date().toISOString();});
  await expect.poll(()=>resumed.evaluate(()=>jobs.length),{timeout:8000}).toBe(1);
  assert.equal(await resumed.evaluate(()=>jobs[0].requestId),'00000000-0000-4000-8000-000000000088');
  await resumed.evaluate(()=>{jobs[0].status='submitted';});await expect(resumed.locator('[data-bag-receipt]')).toContainText('Sent to printer');
  assert.equal(await resumed.evaluate(()=>jobs.length),1);
});
test('late timestamps for historical or paused paid cards never backfill automatic labels',async t=>{
  const page=await open(t);
  const add=async id=>page.evaluate(id=>{sales.push({...sales[1],id,listing_title:'#089 - Unknown time',sold_at:null,lot_id:null});},id);
  await add('00000000-0000-4000-8000-000000000089');
  await expect(page.locator('[data-bag-auto-status]')).toContainText('1 bag label waiting for auto print');
  await page.evaluate(()=>{sales.at(-1).sold_at='2026-01-01T00:00:00Z';});
  await expect(page.locator('[data-bag-auto-status]')).toBeHidden();assert.equal(await page.evaluate(()=>jobs.length),0);
  await add('00000000-0000-4000-8000-000000000090');
  await expect(page.locator('[data-bag-auto-status]')).toContainText('1 bag label waiting for auto print');
  await page.getByRole('button',{name:'Pause automatic printing'}).click();
  await page.evaluate(()=>{sales.at(-1).sold_at=new Date().toISOString();});
  await page.getByRole('button',{name:'Resume automatic printing'}).click();
  await expect(page.locator('[data-bag-auto-status]')).toBeHidden();assert.equal(await page.evaluate(()=>jobs.length),0);
});
test('auto pause, resume and completed shows do not dump old sales into the printer',async t=>{
  const page=await open(t);await page.getByRole('button',{name:'Pause automatic printing'}).click();
  await expect(page.locator('[data-bag-auto-state]')).toHaveText('Auto print paused');
  await page.evaluate(()=>{sales[2].payment_state='paid';});
  await expect(page.locator('[data-bag-choice] option')).toHaveCount(4,{timeout:8000});
  assert.equal(await page.evaluate(()=>jobs.length),0);
  await page.getByRole('button',{name:'Resume automatic printing'}).click();
  assert.equal(await page.evaluate(()=>jobs.length),0);
  await page.evaluate(()=>{ended=true;sales[3].payment_hold=false;});
  await expect(page.locator('[data-bag-choice] option')).toHaveCount(5,{timeout:8000});assert.equal(await page.evaluate(()=>jobs.length),0);
});
test('pausing during an in-flight automatic send is retained before the next bag',async t=>{
  const page=await open(t);await page.evaluate(()=>{delayedPrint=true;sales[2].payment_state='paid';});
  await expect.poll(()=>page.evaluate(()=>jobs.length),{timeout:8000}).toBe(1);
  await page.getByRole('button',{name:'Pause automatic printing'}).click();
  await page.evaluate(()=>{sales[3].payment_hold=false;finishPrint();});
  await expect(page.locator('[data-bag-auto-state]')).toHaveText('Auto print paused',{timeout:8000});
  await expect(page.locator('[data-bag-choice] option')).toHaveCount(5,{timeout:8000});assert.equal(await page.evaluate(()=>jobs.length),1);
});
test('two receiver tabs share automatic sends and missing printers wait without downloading files',async t=>{
  const page=await open(t,{configured:false});await expect(page.locator('[data-bag-auto-status]')).toContainText('Choose a paired printer');
  await page.evaluate(()=>{sales[2].payment_state='paid';});await expect(page.locator('[data-bag-choice] option')).toHaveCount(4,{timeout:8000});
  assert.equal(await page.evaluate(()=>jobs.length),0);
  const seed=await page.evaluate(()=>({sales,jobs,lots})),other=await open(t,{sharedContext:page.context(),seed,configured:true});
  await expect.poll(async()=>await page.evaluate(()=>jobs.length)+await other.evaluate(()=>jobs.length),{timeout:8000}).toBe(1);
});
test('receipts follow the real queue through submission and failures, including previous bags and a fresh receiver',async t=>{
  const page=await open(t);await page.locator('[data-bag-print]').click();
  await expect(page.locator('[data-bag-receipt]')).toContainText('Waiting for printer');
  const states={claimed:'Sending to printer',submitted:'Sent to printer',failed:'Print failed',uncertain:'Check printer',cancelled:'Print cancelled'};
  for(const [state,label] of Object.entries(states)){
    await page.evaluate(state=>{jobs[0].status=state;jobs[0].updated_at='2026-10-06T19:08:00Z';},state);
    await expect(page.locator('[data-bag-receipt]')).toContainText(label,{timeout:8000});
    await expect(page.locator('[data-bag-choice] option').filter({hasText:'#012'})).toContainText(label);
  }
  await page.evaluate(()=>{jobs[0].status='submitted';});
  await expect(page.locator('[data-bag-receipt]')).toContainText('Left roll');
  const seed=await page.evaluate(()=>({sales,jobs,lots}));
  const fresh=await open(t,{seed});
  await expect(fresh.locator('[data-bag-receipt]')).toContainText('Sent to printer');
  await expect(fresh.locator('[data-bag-print]')).toHaveText('Reprint label');
  await expect(fresh.locator('[data-bag-status]')).toHaveText('');
  await fresh.getByRole('combobox',{name:'Choose a bag to print'}).selectOption('00000000-0000-4000-8000-000000000001');
  await expect(fresh.locator('[data-bag-receipt]')).toContainText('Not sent yet');
  await fresh.getByRole('combobox',{name:'Choose a bag to print'}).selectOption('00000000-0000-4000-8000-000000000002');
  await expect(fresh.locator('[data-bag-receipt]')).toContainText('Sent to printer');
  assert.equal(await fresh.evaluate(()=>calls.some(c=>/enqueue|prepare/.test(c.name))),false,'checking receipts never prints or prepares a bag');
  await fresh.locator('#invsto-capture-helper').screenshot({path:'test-results/live-bag-extension-status.png'});
});
test('missing receipts cannot claim a bag was sent and do not stop automatic printing',async t=>{
  const page=await open(t);await page.evaluate(()=>{window.receiptsUnavailable=true;sales[2].payment_state='paid';});
  await expect(page.locator('[data-bag-receipt]')).toContainText('Print status unavailable',{timeout:8000});
  assert.equal(await page.evaluate(()=>jobs.length),1);
  await page.evaluate(()=>{jobs[0].status='submitted';window.receiptsUnavailable=false;});
  await expect(page.locator('[data-bag-receipt]')).toContainText('Sent to printer',{timeout:8000});
  const result=await page.evaluate(()=>chrome.runtime.sendMessage({type:'INVSTO_BAG_LABEL_COMMAND',command:{action:'status',event_id:'EVENT123'}}));
  assert.equal(result.automatic.last.status,'submitted','older installed panels also receive the current automatic receipt');
  assert.equal(await page.evaluate(()=>jobs.length),1);
});
test('one camera click saves only the selected paid bag and retries the original photo after a lost confirmation',async t=>{
  const page=await open(t),camera=page.locator('[data-bag-camera]');
  await page.getByRole('combobox',{name:'Choose a bag to print'}).selectOption('00000000-0000-4000-8000-000000000001');
  await page.evaluate(()=>{window.failPhotoAck=true;});await camera.click();
  await expect(page.locator('[data-bag-status]')).toContainText('Photo confirmation lost');
  await expect(camera).toHaveAttribute('aria-label','Retry saving photo to bag #004');
  await page.evaluate(()=>{window.frameColor='#00ff00';sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000099',listing_title:'#099 - Newer bag',sold_at:'2026-10-06T18:00:00Z'});});
  await camera.click();await expect(page.locator('[data-bag-status]')).toContainText('Photo saved to #004');
  const saved=await page.evaluate(()=>({photos,captureCount,uploads:calls.filter(c=>c.name==='upload-bag-photo'),jobs}));
  assert.equal(saved.captureCount,1);assert.equal(saved.photos.length,1);assert.equal(saved.photos[0]._attempt_id,'00000000-0000-4000-8000-000000000001');
  assert.equal(saved.uploads[0].path,saved.uploads[1].path);assert.equal(saved.jobs.length,0,'photos neither print nor add inventory');
  await camera.click();await expect.poll(()=>page.evaluate(()=>photos.length)).toBe(2);
  assert.equal(await page.evaluate(()=>captureCount),2,'a deliberate second photo gets a new capture');
  await page.locator('#invsto-capture-helper').screenshot({path:'test-results/live-bag-camera.png'});
});
test('the selected bag is frozen during a photo save, while failed capture and changed payment cannot attach a photo',async t=>{
  const page=await open(t);await page.evaluate(()=>{window.failFrame=true;});await page.locator('[data-bag-camera]').click();
  await expect(page.locator('[data-bag-status]')).toContainText('Video is not playing');assert.equal(await page.evaluate(()=>photos.length),0);
  await page.evaluate(()=>{window.failFrame=false;window.delayedPhoto=true;});await page.locator('[data-bag-camera]').click();
  await expect.poll(()=>page.evaluate(()=>photos.length)).toBe(1);
  await page.evaluate(()=>{sales.push({...sales[1],id:'00000000-0000-4000-8000-000000000099',listing_title:'#099 - Newer bag',sold_at:'2026-10-06T18:00:00Z'});});
  await expect(page.locator('.bag-number')).toHaveText('#012');await expect(page.locator('[data-bag-choice]')).toBeDisabled();
  await page.evaluate(()=>{window.delayedPhoto=false;finishPhoto();});await expect(page.locator('[data-bag-status]')).toContainText('Photo saved to #012');
  await expect(page.locator('.bag-number')).toHaveText('#099',{timeout:8000});
  await page.evaluate(()=>{sales.at(-1).payment_state='failed';});await page.locator('[data-bag-camera]').click();
  await expect(page.locator('[data-bag-status]')).toContainText('not cleared');assert.equal(await page.evaluate(()=>photos.length),1);
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
