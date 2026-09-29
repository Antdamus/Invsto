import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit} from '@playwright/test';
import vm from 'node:vm';
const root=new URL('../',import.meta.url), path=n=>new URL(n,root).pathname.replace(/^\/([A-Z]:)/,'$1');
let browser,server,origin;
const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
before(async()=>{
 server=createServer((req,res)=>{res.setHeader('Content-Type',req.url==='/photo.png'?'image/png':'text/html');res.end(req.url==='/photo.png'?Buffer.from(png,'base64'):'<!doctype html><meta name="viewport" content="width=device-width"><main id="ebay-live-panel"><div id="ebay-queue-area"></div></main>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
});
after(async()=>{await browser.close();await new Promise(r=>server.close(r));});
async function phone(t,receiver=false,query='',options={}){
 const p=await browser.newPage({viewport:{width:390,height:844},storageState:options.storageState});t.after(()=>p.close());await p.goto(origin+(receiver?'/?capture=1':'/?')+query);p.errors=[];p.on('pageerror',e=>p.errors.push(e.message));
 await p.evaluate(()=>{
  window.calls=[];window.jobs=[];window.stock={id:'item',barcode:'OG123',title:'Saved watch',description:'A steel watch with replacement strap',photos:['stock.jpg'],available:1,existing_listing_id:null};
  window.supabase={storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:location.origin+'/photo.png'}})})},rpc:async(name,args)=>{
   calls.push({name,args});
   if(name==='lookup_live_listing_item')return {data:stock};
   if(name==='get_live_listing_requests')return {data:jobs};
   if(name==='queue_live_listing'){
    if(stock.existing_listing_id&&!args._existing_listing_checked)return {error:{message:'Check the existing eBay listing quantity'}};
    const j={id:args._id,title:stock.title,barcode:stock.barcode,status:'queued',starting_bid:args._starting_bid,duration_seconds:args._duration};jobs.push(j);return {data:j};
   }
   if(name==='claim_live_listing')return {data:{id:'job',event_id:'EVENT123',status:'preparing',snapshot:{...stock,cost:99,minimum_sale_price:123},starting_bid:5,duration_seconds:30}};
   return {data:null};
  }};
 });
 await p.addStyleTag({path:path('live-listing-intake.css')});await p.addScriptTag({path:path('live-listing-intake.js')});await p.evaluate(selection=>{liveListingIntake.init();liveListingIntake.sync(selection);document.getElementById('live-intake').open=true;},options.selection===undefined?{event_id:'EVENT123'}:options.selection);return p;
}
async function changeEvent(p,url){if(!await p.locator('#live-intake-event-settings').evaluate(el=>el.open))await p.locator('#live-intake-event-settings summary').click();await p.locator('#live-intake-event-url').fill(url);await p.locator('#live-intake-use-event').click();}
test('phone scan uses saved stock, requires bid, queues one item and hides stale preview',async t=>{
 const p=await phone(t);await p.locator('#live-intake-barcode').fill('https://example.invalid/stock?barcode=OG123');await p.locator('#live-intake-barcode').press('Enter');await p.locator('#live-intake-preview').waitFor();
 assert.equal(await p.locator('#live-intake-title').innerText(),'Saved watch');assert.equal(await p.locator('#live-intake-existing').isVisible(),false);
 assert.equal(await p.evaluate(()=>calls.find(x=>x.name==='lookup_live_listing_item').args._barcode),'OG123');
 await p.locator('#live-intake-send').click();assert.match(await p.locator('#live-intake-status').innerText(),/starting bid/);assert.equal(await p.evaluate(()=>jobs.length),0);
 await p.locator('#live-intake-bid').fill('9.99');await p.locator('#live-intake-send').click();await p.waitForFunction(()=>jobs.length===1);assert.equal(await p.locator('#live-intake-preview').isVisible(),false);assert.match(await p.locator('#live-intake-jobs').innerText(),/Waiting for show computer/);
 assert.equal(await p.evaluate(()=>calls.find(x=>x.name==='queue_live_listing').args._event_id),'EVENT123');
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(p.errors,[]);
 await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await p.screenshot({path:path('test-results/live-listing-phone.png'),fullPage:true});
});
test('missing photos block queue and existing listing needs explicit quantity review',async t=>{
 const p=await phone(t);await p.evaluate(()=>stock.photos=[]);await p.locator('#live-intake-barcode').fill('OG123');await p.locator('#live-intake-find').click();await p.locator('#live-intake-preview').waitFor();assert.equal(await p.locator('#live-intake-send').isDisabled(),true);
 await p.evaluate(()=>{stock.photos=['stock.jpg'];stock.existing_listing_id='123456789012';});await p.locator('#live-intake-find').click();await p.locator('#live-intake-existing').waitFor();await p.locator('#live-intake-bid').fill('10');await p.locator('#live-intake-send').click();assert.match(await p.locator('#live-intake-status').innerText(),/existing eBay/);
 await p.locator('#live-intake-existing-check').check();await p.locator('#live-intake-send').click();await p.waitForFunction(()=>jobs.length===1);
 await p.evaluate(()=>liveListingIntake.sync({event_id:'OTHER123',broadcast_ended_at:'now'}));assert.equal(await p.locator('#live-intake').isVisible(),true);
 assert.equal(await p.locator('#live-intake-preview').isVisible(),false);
});

test('listing preparation works without a sales session and keeps the explicit destination',async t=>{
 const p=await phone(t,false,'',{selection:null});
 assert.equal(await p.locator('#live-intake').isVisible(),true);
 await p.locator('#live-intake-find').click();assert.match(await p.locator('#live-intake-status').innerText(),/Choose the eBay event/);
 await changeEvent(p,'https://www.ebay.com/ebaylive/host/events/UPCOMING123');
 await p.evaluate(()=>liveListingIntake.sync({event_id:'OTHER123',review_completed_at:'now'}));
 assert.match(await p.locator('#live-intake-event-status').innerText(),/UPCOMING123/);
 await p.locator('#live-intake-barcode').fill('OG123');await p.locator('#live-intake-find').click();await p.locator('#live-intake-preview').waitFor();
 await p.locator('#live-intake-bid').fill('5');await p.locator('#live-intake-send').click();await p.waitForFunction(()=>jobs.length===1);
 assert.equal(await p.evaluate(()=>calls.find(c=>c.name==='queue_live_listing').args._event_id),'UPCOMING123');
 assert.equal(await p.evaluate(()=>calls.some(c=>/start_.*session|link_ebay_live_event|ingest_ebay_live/.test(c.name))),false);
 await p.locator('#live-intake-event-settings summary').click();await p.locator('#live-intake-use-show').click();assert.match(await p.locator('#live-intake-event-status').innerText(),/OTHER123/);
 assert.equal(await p.locator('#live-intake-preview').isVisible(),false);
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
});

test('ended and completed shows can send stock while event edits invalidate the old preview',async t=>{
 const p=await phone(t);await p.evaluate(()=>liveListingIntake.sync({event_id:'EVENT123',broadcast_ended_at:'now',review_completed_at:'now'}));
 assert.equal(await p.locator('#live-intake').isVisible(),true);
 await p.locator('#live-intake-barcode').fill('OG123');await p.locator('#live-intake-find').click();await p.locator('#live-intake-preview').waitFor();
 await p.locator('#live-intake-bid').fill('5');await p.locator('#live-intake-send').click();await p.waitForFunction(()=>jobs.length===1);
 await p.locator('#live-intake-auto-send').uncheck();await p.locator('#live-intake-find').click();await p.locator('#live-intake-preview').waitFor();
 await p.locator('#live-intake-event-settings summary').click();await p.locator('#live-intake-event-url').fill('https://example.invalid/ebaylive/host/events/WRONG123');
 assert.equal(await p.locator('#live-intake-preview').isVisible(),false);
 await p.locator('#live-intake-use-event').click();assert.match(await p.locator('#live-intake-status').innerText(),/Paste the eBay/);
 assert.equal(await p.evaluate(()=>jobs.length),1);
});

test('receiver link selects its event without linking or reopening any sales session',async t=>{
 const p=await phone(t,true,'&listing_event=UPCOMING123');
 assert.match(await p.locator('#live-intake-event-status').innerText(),/UPCOMING123/);
 await p.evaluate(()=>liveListingIntake.sync(null));
 assert.match(await p.locator('#live-intake-event-url').inputValue(),/UPCOMING123$/);
 assert.equal(await p.locator('#live-intake').isVisible(),true);
});

test('changing event during stock lookup cannot send a stale item to the new event',async t=>{
 const p=await phone(t);await p.evaluate(()=>{const original=supabase.rpc;supabase.rpc=(name,args)=>name==='lookup_live_listing_item'?new Promise(resolve=>window.finishLookup=()=>resolve({data:stock})):original(name,args);});
 await p.locator('#live-intake-barcode').fill('OG123');await p.locator('#live-intake-find').click();
 await changeEvent(p,'https://www.ebay.com/ebaylive/host/events/NEW12345');
 await p.evaluate(()=>finishLookup());
 assert.equal(await p.locator('#live-intake-preview').isVisible(),false);
 assert.equal(await p.locator('#live-intake-send').isDisabled(),true);
 assert.equal(await p.evaluate(()=>jobs.length),0);
});
test('receiver transfers photos and public description without costs or minimum prices',async t=>{
 const p=await phone(t,true);await p.evaluate(()=>{window.replies=[];window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_LISTING_RESPONSE')replies.push(e.data);});window.postMessage({type:'INVSTO_LISTING_REQUEST',id:'request',command:{event_id:'EVENT123',action:'next'}},location.origin);});await p.waitForFunction(()=>replies.length);
 const result=await p.evaluate(()=>replies[0]);assert.equal(result.ok,true,result.error);assert.equal(result.job.images.length,1);assert.ok(result.job.images[0].length>10);assert.match(result.job.title,/OG123/);assert.match(result.job.description,/Inventory reference: OG123/);assert.equal('cost' in result.job,false);assert.equal('minimum_sale_price' in result.job,false);assert.equal(result.job.starting_bid,5);
});
test('event and auction settings survive a fresh visit and scans send without extra clicks',async t=>{
 const p=await phone(t,false,'',{selection:null});await changeEvent(p,'https://www.ebay.com/ebaylive/host/events/UPCOMING123');
 await p.locator('#live-intake-bid').fill('7.50');await p.locator('#live-intake-duration').selectOption('45');
 await p.locator('#live-intake-barcode').fill('OG123');await p.locator('#live-intake-barcode').press('Enter');await p.waitForFunction(()=>jobs.length===1);
 assert.equal(await p.locator('#live-intake-barcode').inputValue(),'');assert.equal(await p.locator('#live-intake-event-settings').evaluate(el=>el.open),false);
 const fresh=await phone(t,false,'',{selection:null,storageState:await p.context().storageState()});
 assert.match(await fresh.locator('#live-intake-event-status').innerText(),/UPCOMING123/);
 assert.equal(await fresh.locator('#live-intake-bid').inputValue(),'7.50');assert.equal(await fresh.locator('#live-intake-duration').inputValue(),'45');
 // A slow status refresh must not hold the scan lock after the item was sent.
 await fresh.evaluate(()=>{const original=supabase.rpc;supabase.rpc=(name,args)=>name==='get_live_listing_requests'?new Promise(()=>{}):original(name,args);});
 for(const barcode of ['OG456','OG789']){
  await fresh.evaluate(barcode=>{stock.barcode=barcode;},barcode);await fresh.locator('#live-intake-barcode').fill(barcode);await fresh.locator('#live-intake-barcode').press('Enter');await fresh.waitForFunction(barcode=>jobs.some(j=>j.barcode===barcode),barcode);
 }
 const queued=await fresh.evaluate(()=>calls.filter(c=>c.name==='queue_live_listing'));
 assert.equal(queued.length,2);assert.ok(queued.every(c=>c.args._event_id==='UPCOMING123'&&c.args._starting_bid===7.5&&c.args._duration===45));
 assert.equal(await fresh.locator('#live-intake-barcode').evaluate(el=>el===document.activeElement),true);
 await changeEvent(fresh,'https://www.ebay.com/ebaylive/host/events/DIFFERENT123');assert.equal(await fresh.locator('#live-intake-bid').inputValue(),'');
 await changeEvent(fresh,'https://www.ebay.com/ebaylive/host/events/UPCOMING123');assert.equal(await fresh.locator('#live-intake-bid').inputValue(),'7.50');
});

test('open eBay event is discovered automatically while multiple events require a choice',async t=>{
 const p=await phone(t,false,'',{selection:null});
 await p.evaluate(()=>window.chrome={runtime:{sendMessage:async()=>({ok:true,events:['OPEN123']})}});await p.addScriptTag({path:path('tools/ebay-live-capture/receiver.js')});await p.waitForFunction(()=>document.getElementById('live-intake-event-status').textContent.includes('OPEN123'));
 assert.equal(await p.locator('#live-intake-event-settings').evaluate(el=>el.open),false);
 const multiple=await phone(t,false,'',{selection:null});
 await multiple.evaluate(()=>window.postMessage({type:'INVSTO_LISTING_EVENTS',events:['OPEN123','OTHER123','bad<id>']},location.origin));await multiple.locator('#live-intake-open-events').waitFor();
 assert.equal(await multiple.locator('#live-intake-event-url').inputValue(),'');assert.equal(await multiple.locator('#live-intake-open-events option').count(),3);
 await multiple.locator('#live-intake-open-events').selectOption('OTHER123');assert.match(await multiple.locator('#live-intake-event-status').innerText(),/OTHER123/);
 await multiple.evaluate(()=>window.postMessage({type:'INVSTO_LISTING_EVENTS',events:['OPEN123']},location.origin));assert.match(await multiple.locator('#live-intake-event-status').innerText(),/OTHER123/);
});

test('automatic scans stop for missing photos, quantity checks, or disabled automatic sending',async t=>{
 const p=await phone(t);await p.locator('#live-intake-bid').fill('5');
 await p.evaluate(()=>stock.photos=[]);await p.locator('#live-intake-barcode').fill('OG123');await p.locator('#live-intake-barcode').press('Enter');await p.locator('#live-intake-preview').waitFor();assert.equal(await p.evaluate(()=>jobs.length),0);
 await p.evaluate(()=>{stock.photos=['stock.jpg'];stock.existing_listing_id='123456789012';});await p.locator('#live-intake-barcode').press('Enter');await p.locator('#live-intake-existing').waitFor();assert.equal(await p.evaluate(()=>jobs.length),0);
 await p.locator('#live-intake-existing-check').check();await p.locator('#live-intake-send').click();await p.waitForFunction(()=>jobs.length===1);
 await p.locator('#live-intake-auto-send').uncheck();await p.evaluate(()=>stock.existing_listing_id=null);await p.locator('#live-intake-barcode').fill('OG123');await p.locator('#live-intake-barcode').press('Enter');await p.locator('#live-intake-preview').waitFor();assert.equal(await p.evaluate(()=>jobs.length),1);
});
async function form(t,automatic=false){
 const p=await browser.newPage();t.after(()=>p.close());await p.goto(origin+'/ebaylive/host/events/EVENT123');
 await p.setContent(`<button role="tab">All (42)</button><div id="template-form-photos-section"><button aria-label="Remove image" onclick="this.nextElementSibling.remove();this.remove()"></button><img alt="Listing photo"><input type="file" multiple></div><input type="number"><input name="title"><select><option value="AUCTION">eBay Live Auction</option></select><input name="bidPrice"><input type="number" name="inStreamDurationSec"><input type="number" name="sequenceNumber"><input type="number" name="duplicate" value="5"><div id="template-form-description-section"><iframe srcdoc="<div contenteditable='true'>Generic template</div>"></iframe></div><button id="create">Create listing</button><button id="start">Start</button>`);
 await p.evaluate(png=>{
  window.calls=[];window.saved={};window.creates=0;window.starts=0;
  window.chrome={storage:{local:{get:async key=>({[key]:saved[key]}),set:async o=>Object.assign(saved,o),remove:async k=>delete saved[k]}},runtime:{sendMessage:async m=>{if(!m.command)return {ok:true};calls.push(m.command);return {ok:true,job:m.command.action==='next'&&!creates?{id:'job',event_id:'EVENT123',status:'preparing',title:'Saved watch [OG123]',description:'Saved description. Inventory reference: OG123',barcode:'OG123',images:[png,png],starting_bid:8.5,duration_seconds:30}:undefined};}}};
  document.querySelector('input[type=file]').onchange=e=>{for(const f of e.target.files){const img=document.createElement('img');img.alt='Listing photo';img.src=URL.createObjectURL(f);document.getElementById('template-form-photos-section').append(img);}};
  document.getElementById('create').onclick=()=>{creates++;document.getElementById('template-form-photos-section').remove();const tile=document.createElement('div');tile.dataset.testid='listing-tile';tile.innerHTML='<button data-testid="inline-edit-title">#043 - Saved watch [OG123]</button><input data-testid="checkbox-123456789012">';document.body.append(tile);};
  document.getElementById('start').onclick=()=>starts++;
 },png);
 await p.addScriptTag({path:path('tools/ebay-live-capture/listing.js')});if(!automatic)await p.locator('[data-auto]').evaluate(el=>el.checked=false);await p.locator('#invsto-listing-helper summary').click();if(!automatic)await p.locator('[data-next]').click();return p;
}
test('helper replaces template content and photos but waits for the human Create action',async t=>{
 const p=await form(t);assert.match(await p.locator('#invsto-listing-helper a').getAttribute('href'),/listing_event=EVENT123/);await p.locator('[data-fill]').click();await p.waitForFunction(()=>calls.some(c=>c.action==='ready'));
 for(const [field,value] of [['title','Saved watch [OG123]'],['bidPrice','8.50'],['inStreamDurationSec','30'],['duplicate','1'],['sequenceNumber','43']])assert.equal(await p.locator(`input[name="${field}"]`).inputValue(),value);
 assert.equal(await p.locator('img[alt="Listing photo"]').count(),2);assert.equal(await p.locator('input[type=file]').evaluate(e=>e.files.length),2);
 assert.match(await p.frameLocator('iframe').locator('[contenteditable]').innerText(),/Saved description/);assert.equal(await p.evaluate(()=>creates+starts),0);assert.equal(await p.locator('[data-release]').isVisible(),false);
 await p.locator('#create').click();await p.waitForFunction(()=>calls.some(c=>c.action==='created'));assert.equal(await p.evaluate(()=>calls.find(c=>c.action==='created').listing_id),'123456789012');assert.equal(await p.evaluate(()=>creates),1);assert.equal(await p.evaluate(()=>starts),0);assert.equal(await p.evaluate(()=>window.InvstoListingPreparing),false);
});
test('template layout mismatch does not publish and can be released before submission',async t=>{
 const p=await form(t);await p.locator('select').evaluate(e=>e.remove());await p.locator('[data-fill]').click();await p.waitForFunction(()=>document.querySelector('[data-note]').textContent.includes('layout changed'));
 assert.equal(await p.evaluate(()=>creates+starts),0);assert.equal(await p.evaluate(()=>calls.some(c=>c.action==='ready')),false);await p.locator('[data-release]').click();await p.waitForFunction(()=>calls.some(c=>c.action==='failed'));assert.equal(await p.evaluate(()=>window.InvstoListingPreparing),false);
});
test('open helper picks up and fills a scan automatically, with one claim and no submission',async t=>{
 const p=await form(t,true);await p.waitForFunction(()=>calls.some(c=>c.action==='ready'));
 assert.equal(await p.locator('input[name=title]').inputValue(),'Saved watch [OG123]');assert.equal(await p.locator('img[alt="Listing photo"]').count(),2);
 assert.equal(await p.evaluate(()=>calls.filter(c=>c.action==='next').length),1);assert.equal(await p.evaluate(()=>creates+starts),0);
 await p.locator('#create').click();await p.waitForFunction(()=>calls.some(c=>c.action==='created'));assert.equal(await p.evaluate(()=>creates),1);assert.equal(await p.evaluate(()=>starts),0);
});
test('automatic preparation pauses on a form error and resumes after a successful manual correction',async t=>{
 const p=await form(t);await p.locator('select').evaluate(el=>el.remove());await p.locator('[data-auto]').check();await p.waitForFunction(()=>document.querySelector('[data-note]').textContent.includes('layout changed'));
 assert.equal(await p.evaluate(()=>creates+starts),0);
 await p.evaluate(()=>{const format=document.createElement('select');format.innerHTML='<option value="AUCTION">eBay Live Auction</option>';document.body.append(format);});
 await p.locator('[data-fill]').click();await p.waitForFunction(()=>calls.some(c=>c.action==='ready'));await p.locator('#create').click();await p.waitForFunction(()=>calls.some(c=>c.action==='created'));
 await p.waitForFunction(()=>calls.filter(c=>c.action==='next').length>=2);assert.equal(await p.evaluate(()=>creates),1);assert.equal(await p.evaluate(()=>starts),0);
});

test('event discovery and preparation ownership keep multiple open eBay tabs separate',async()=>{
 let stored={capture:{events:{},health:{},receivers:{9:Date.now()}}},handler,removed,resolvePhotos,bridges=0;
 const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async value=>Object.assign(stored,structuredClone(value))}},runtime:{id:'extension',onMessage:{addListener:fn=>handler=fn}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{onRemoved:{addListener:fn=>removed=fn},sendMessage:async(tab,message)=>{bridges++;return message.command.action==='next'?new Promise(resolve=>resolvePhotos=resolve):{ok:true};}}};
 vm.runInNewContext(await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8'),{chrome,URL,Date,Promise,Error,Object,Number,String});
 const send=(message,tab=1,url='https://www.ebay.com/ebaylive/host/events/EVENT123')=>new Promise(resolve=>handler(message,{id:'extension',tab:{id:tab,url}},resolve));
 await send({type:'INVSTO_LISTING_HELLO'});await send({type:'INVSTO_LISTING_HELLO'},2,'https://www.ebay.com/ebaylive/host/events/OTHER123');
 const discovery=await send({type:'INVSTO_LISTING_DISCOVER'},9,'https://antdamus.github.io/Invsto/live-sales.html');assert.deepEqual(Array.from(discovery.events).sort(),['EVENT123','OTHER123']);
 const first=send({type:'INVSTO_LISTING_COMMAND',command:{event_id:'EVENT123',action:'next'}});
 await new Promise(resolve=>setImmediate(resolve));
 const second=await send({type:'INVSTO_LISTING_COMMAND',command:{event_id:'EVENT123',action:'next'}},3);assert.equal(second.ok,false);assert.match(second.error,/another eBay tab/);assert.equal(bridges,1);
 resolvePhotos({ok:true,job:{id:'job'}});assert.equal((await first).ok,true);
 await send({type:'INVSTO_LISTING_COMMAND',command:{event_id:'EVENT123',action:'created',job_id:'job'}});assert.equal(stored.capture.listingOwners.EVENT123,undefined);
 await removed(2);const after=await send({type:'INVSTO_LISTING_DISCOVER'},9,'https://antdamus.github.io/Invsto/live-sales.html');assert.deepEqual(Array.from(after.events),['EVENT123']);
});
test('slow photo transfer does not block payment capture delivery',async()=>{
 let stored={capture:{events:{},health:{},receivers:{2:Date.now()}}},handler,resolvePhotos;
 const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>Object.assign(stored,structuredClone(v))}},runtime:{id:'extension',onMessage:{addListener:fn=>handler=fn}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{sendMessage:async(tab,msg)=>msg.type==='INVSTO_LISTING_BRIDGE'?new Promise(r=>resolvePhotos=r):{ok:true}}};
 vm.runInNewContext(await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8'),{chrome,URL,Date,Promise,Error,Object,Number,String});
 const send=msg=>new Promise(r=>handler(msg,{id:'extension',tab:{id:1,url:'https://www.ebay.com/ebaylive/host/events/EVENT123'}},r));
 const listing=send({type:'INVSTO_LISTING_COMMAND',command:{event_id:'EVENT123',action:'next'}});await Promise.resolve();
 const capture=await send({type:'INVSTO_CAPTURE',event_id:'EVENT123',events:[{key:'payment',kind:'paid'}],health:{ready:true}});assert.equal(capture.ok,true);assert.equal(Object.keys(stored.capture.events).length,0);resolvePhotos({ok:true,job:{id:'job'}});assert.equal((await listing).ok,true);
});
