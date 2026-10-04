import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit} from '@playwright/test';
import vm from 'node:vm';
const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
 server=createServer(async(req,res)=>{const name=new URL(req.url,'http://localhost').pathname.slice(1);if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();try{let content=await readFile(new URL(name,root));if(name.endsWith('.html'))content=content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,tag=>/src="(?:ebay-live|live-sales|live-manual-items|live-bag-label|live-show-drafts|live-listing-intake|live-capture-setup)\.js/.test(tag)?tag:'');res.setHeader('Content-Type',name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);}catch{res.writeHead(404).end();}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));origin=`http://127.0.0.1:${server.address().port}`;
 browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
});
after(async()=>{await browser.close();await new Promise(r=>{server.close(r);server.closeAllConnections();});});
const historyStream={source:'ebay_event_information',start_local:'2026-09-30T14:05',timezone_label:'EDT',title:'Original eBay show',activity_timezone:'America/New_York'};
const streamQuery='&stream='+encodeURIComponent(JSON.stringify(historyStream));
async function streamFixture(page){await page.evaluate(metadata=>{const original=window.chrome?.runtime?.sendMessage;if(original)window.chrome.runtime.sendMessage=async message=>message.type==='INVSTO_READ_STREAM'?{ok:true,stream:metadata}:original(message);document.body.insertAdjacentHTML('beforeend','<button role="tab" aria-selected="true">Stream manager</button><button role="tab">Event information</button><div hidden><input id="startDate" type="datetime-local" value="2026-09-30T14:05"><input id="timezone" value="EDT"><input id="title" value="Original eBay show"></div>');},historyStream);}
const tile=(id='123456789012',status='Paid',title='#001 - Watch',buyer='testbuyer')=>`<div data-testid="listing-tile"><input data-testid="checkbox-${id}" type="checkbox"><span class="_statusPill_hash_1">${status}</span><input data-testid="ordinal-id" value="29"><button data-testid="inline-edit-title"><span>${title}</span></button><span class="_price_hash_1">$100.00</span><span class="_soldLabel_hash_1" title="${buyer}">${buyer}</span><span class="_statusText_hash_1">${status}</span></div>`;
const row=(action='won the auction',buyer='testbuyer',title='#001 - Watch')=>`<div class="_rowContent_hash_1"><div class="_messageLine_hash_1"><span class="_username_hash_1">${buyer}</span><span class="_actionSuccess_hash_1">${action}</span><span class="_timestamp_hash_1">10:03 AM</span></div><div class="_itemSummary_hash_1"><span>$100.00</span><span class="_listingTitle_hash_1">${title}</span></div></div>`;
async function parser(t,html){const page=await browser.newPage();t.after(()=>page.close());await page.setContent(html);await page.addScriptTag({path:new URL('../tools/ebay-live-capture/parser.js',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});return page;}
test('parser distinguishes explicit paid badge from auction wins and AUC labels',async t=>{const page=await parser(t,tile()+'<div id="activity-panel">'+row()+'</div>');const r=await page.evaluate(()=>InvstoLiveParser.parse(document));assert.deepEqual(r.events.map(e=>e.kind),['paid','won']);assert.equal(r.events[1].listing_id,'123456789012');await page.setContent(tile('123456789012','AUC'));assert.equal((await page.evaluate(()=>InvstoLiveParser.parse(document))).events.length,0);});
test('ambiguous listing titles and unfamiliar payment text remain unverified',async t=>{const page=await parser(t,tile()+tile('222222222222')+'<div id="activity-panel">'+row('payment maybe received')+'</div>');const r=await page.evaluate(()=>InvstoLiveParser.parse(document));const activity=r.events.find(e=>e.source==='activity');assert.equal(activity.kind,'unknown');assert.equal(activity.listing_id,undefined);});
test('failures without buyer details and identical repeated auction notifications require review',async t=>{const page=await parser(t,tile('123456789012','Payment failed','#001 - Watch','')+'<div id="activity-panel">'+row()+row()+'</div>');const r=await page.evaluate(()=>InvstoLiveParser.parse(document));assert.equal(r.events[0].kind,'failed');assert.equal(r.events[0].buyer,'');assert.ok(r.events.some(e=>e.kind==='unknown'&&e.key.startsWith('ambiguous|')));});
test('unrecognized currencies are never parsed as a USD paid price',async t=>{const page=await parser(t,tile().replace('$100.00','C$100.00'));assert.equal((await page.evaluate(()=>InvstoLiveParser.parse(document))).events.length,0);});
async function open(t,query='',resume=false,drafts=false){
 const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());await context.route('**/*',r=>(r.request().url().startsWith(origin)||r.request().url().startsWith('blob:'+origin)||r.request().url().startsWith('data:image/'))?r.continue():r.abort());
 await context.addInitScript(({resume,drafts})=>{
  const user={id:'worker',email:'worker@example.invalid'},employee={id:'seller',user_id:'worker',display_name:'Test seller',active:true,role:'admin'};
  window.lucide={createIcons(){}};window.calls=[];window.mockItems=[];window.mockManualItems=[];window.mockLots=[];window.failUpload=false;window.failManual=false;window.uploadedPhoto="";window.failDashboard=false;window.failClose=false;
  window.showSession={id:'show',session_code:'SHOW',title:'Test show',status:'active',store_id:'store',primary_seller_employee_id:'seller',started_at:new Date().toISOString()};
  window.dashboard={connection:{event_id:'EVENT123',session_id:'show',capture_ready:true,source_seen_at:new Date().toISOString(),active_seller_id:'seller',fee_percent:null,fee_fixed:null,shipping_per_sale:null},attempts:[{id:'sale',event_id:'EVENT123',listing_id:'123456789012',listing_title:'#001 - Test watch',buyer:'testbuyer',amount:100,payment_state:'paid',seller_id:'seller',seller_name:'Test seller',created_at:new Date().toISOString(),units:0}],unmatched:[]};
  window.printStations={printLabel:async(xml)=>{window.calls.push({name:'print',xml});return {mode:'remote-queue',stationName:'Test printer'};}};
  const nextSeller={id:'next-seller',display_name:'Sydney Miller',active:true,role:'employee'};
  window.supabase={auth:{getSession:async()=>({data:{session:{user}}})},storage:{from:()=>({createSignedUrl:async()=>({data:{signedUrl:window.uploadedPhoto||''}}),upload:async(path,blob)=>{calls.push({name:'upload',path,type:blob.type});if(failUpload)return {error:{message:'Photo upload interrupted'}};uploadedPhoto=await new Promise(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.readAsDataURL(blob);});return {data:{path}};}})},from(table){
   let filters=[],limit=1000;const all=()=>table==='employees'?[employee]:table==='store_locations'?[{id:'store',name:'Showroom',active:true}]:table==='live_sale_sessions'?(window.showSessions||[window.showSession]):table==='ebay_live_connections'?(window.dashboardByShow?Object.values(window.dashboardByShow).map(d=>d.connection):[window.dashboard.connection]):table==='ebay_live_attempts'?window.dashboard.attempts:table==='live_sale_lots'?window.mockLots:table==='live_sale_lot_items'?window.mockItems:table==='live_sale_manual_lot_items'?window.mockManualItems:[];
   const q={select(){return q},eq(k,v){filters.push(r=>r[k]===v);return q},in(){return q},is(){return q},order(){return q},limit(n){limit=n;return q},maybeSingle:async()=>({data:all().find(r=>filters.every(f=>f(r)))||null}),single:async()=>({data:all().find(r=>filters.every(f=>f(r)))||null}),then(fn){return Promise.resolve({data:all().filter(r=>filters.every(f=>f(r))).slice(0,limit)}).then(fn)}};return q;
  },rpc:async(name,args)=>{window.calls.push({name,args});if(name==='get_live_sale_seller_directory')return {data:[employee,nextSeller]};if(name==='get_ebay_live_dashboard')return window.failDashboard?{error:{message:'Network interrupted'}}:{data:structuredClone(window.dashboardByShow?.[args._session_id]||window.dashboard)};
   if(name==='save_live_sale_manual_item'){
    if(failManual)return {error:{message:'Manual item save interrupted'}};
    let row=mockManualItems.find(i=>i.id===args._item_id);if(row&&args._expected_revision!==row.edit_revision)return {error:{message:'This item changed. Reopen Edit to load the latest details'}};
    const saved={id:args._item_id,lot_id:args._lot_id,item_category:args._category,item_description:args._description,quantity:args._quantity,live_unit_minimum:args._unit_minimum,photo_path:args._photo_path,edit_revision:(row?.edit_revision||0)+1,status:args._quantity===0?'released':'reserved',created_at:new Date().toISOString(),show_elapsed_seconds:120};
    if(row)Object.assign(row,saved);else mockManualItems.push(saved);
    const attempt=dashboard.attempts.find(a=>a.lot_id===args._lot_id);if(attempt){const entries=[...mockItems,...mockManualItems].filter(i=>i.lot_id===args._lot_id&&['reserved','packed'].includes(i.status));attempt.units=entries.reduce((n,i)=>n+i.quantity,0);attempt.minimum_total=entries.length&&entries.every(i=>i.live_unit_minimum!=null)?entries.reduce((n,i)=>n+i.quantity*Number(i.live_unit_minimum),0):null;}
    return {data:saved};
   }
   if(name==='correct_ebay_live_sale_sellers'){if(window.failSellerCorrection)return {error:{message:'Seller correction interrupted'}};for(const a of dashboard.attempts)if(args._attempt_ids.includes(a.id)){a.seller_id=args._seller_id;a.seller_name=args._seller_id==='next-seller'?'Sydney Miller':'Test seller';const lot=mockLots.find(l=>l.id===a.lot_id);if(lot)lot.owner_employee_id=args._seller_id;}return {data:args._attempt_ids.length};}
   if(name==='set_ebay_live_seller'){dashboard.connection.active_seller_id=args._seller_id;dashboard.connection.active_seller_name=args._seller_id==='next-seller'?'Sydney Miller':'Test seller';if(args._correct_existing){for(const l of mockLots)l.owner_employee_id=args._seller_id;for(const a of dashboard.attempts){a.seller_id=args._seller_id;a.seller_name=dashboard.connection.active_seller_name;}}return {data:args._correct_existing?dashboard.attempts.length:0};}
   if(name==='mark_ebay_live_broadcast_ended'){dashboard.connection.broadcast_ended_at=new Date().toISOString();dashboard.connection.capture_ready=false;return {data:null};}
   if(name==='complete_ebay_live_session'){if(window.failComplete)return {error:{message:'A payment changed; review the outstanding issue'}};showSession.status='ended';return {data:null};}
   if(name==='reopen_ebay_live_bag'){const a=dashboard.attempts.find(a=>a.id===args._attempt_id);a.closed_at=null;a.claimed_by='worker';const lot=mockLots.find(l=>l.id===a.lot_id);lot.closed_at=null;return {data:lot};}
   if(name==='set_live_sale_session_draft'){if(window.failDraft)return {error:{message:'Draft save interrupted'}};const s=(window.showSessions||[showSession]).find(s=>s.id===args._session_id);if(!s||s.status!=='active')return {error:{message:'This show is already closed or unavailable'}};s.saved_for_later_at=args._saved?new Date().toISOString():null;s.saved_for_later_by=args._saved?'worker':null;return {data:structuredClone(s)};}
   if(name==='start_ebay_live_session'||name==='start_ebay_live_capture_from_stream'){if(window.failCaptureStart)return {error:{message:'Connection interrupted'}};window.showSession={...window.showSession,id:'newshow',workflow_mode:'ebay_live',title:args._title||'Captured show',store_id:args._store_id||null,primary_seller_employee_id:args._primary_seller_employee_id,co_seller_employee_ids:args._co_seller_employee_ids};window.dashboard.connection={...window.dashboard.connection,session_id:'newshow',event_id:args._event_id};if(window.showSessions)window.showSessions.push(window.showSession);if(window.dashboardByShow){window.dashboard.attempts=[];window.dashboardByShow[window.showSession.id]=window.dashboard;}return {data:window.showSession};}
   if(name==='prepare_ebay_live_bag_label'){const a=window.dashboard.attempts.find(a=>a.id===args._attempt_id);if(window.failPrepare||a?.payment_state!=='paid'||a.resolved_at)return {error:{message:'Payment is not confirmed for this bag'}};let lot=mockLots.find(l=>l.id===a.lot_id);if(!lot){lot={id:'label-'+a.id,session_id:'show',auction_number:'EB-001-SALE',lot_code:'LIVE-LABEL',status:'open',owner_employee_id:a.seller_id};mockLots.push(lot);a.lot_id=lot.id;}return {data:lot};}
   if(name==='claim_ebay_live_bag'){const a=window.dashboard.attempts.find(a=>a.id===args._attempt_id);a.claimed_by='worker';let lot=mockLots.find(l=>l.id===a.lot_id);if(!lot){a.lot_id='lot';lot={id:'lot',session_id:'show',auction_number:'EB-29-SALE',lot_code:'LIVE-TEST',status:'open',owner_employee_id:'seller'};window.mockLots.push(lot);}return {data:lot};}
   if(name==='close_ebay_live_bag'){if(window.failClose)return {error:{message:'Payment is not confirmed for this bag'}};window.dashboard.attempts[0].closed_at=new Date().toISOString();return {data:null};}
   if(name==='resolve_ebay_live_attempt'){const a=window.dashboard.attempts.find(a=>a.id===args._attempt_id);if(args._action==='cancel_release'){a.resolved_at=new Date().toISOString();a.payment_state='cancelled';}return {data:null};}
   if(name==='create_live_sale_lot'){const l={id:'ordinary',session_id:'show',auction_number:args._auction_number,status:'open'};window.mockLots=[l];return {data:l};}
   return {data:null};
  }};
  if(resume){dashboard.attempts[0].claimed_by='worker';dashboard.attempts[0].lot_id='lot';mockLots=[{id:'lot',session_id:'show',auction_number:'EB-29-SALE',lot_code:'LIVE-TEST',status:'open',owner_employee_id:'seller'}];}
  if(drafts){showSession.saved_for_later_at=new Date().toISOString();window.showSessions=[showSession,...Array.from({length:25},(_,i)=>({...showSession,id:'older-'+i,title:'Earlier show '+i,session_code:'EARLIER-'+i}))];}
 },{resume,drafts});
 const page=await context.newPage();page.errors=[];page.on('pageerror',e=>page.errors.push(e.message));await page.goto(origin+'/live-sales.html'+query);if(drafts){await page.waitForFunction(()=>document.getElementById('show-drafts-open')?.textContent.includes('(26)'));return page;}await page.locator('#ebay-live-connected:visible').waitFor();if(resume)await page.waitForFunction(()=>!document.getElementById('item-scan').disabled);else await page.locator('[data-action="scan"]').waitFor();return page;
}
test('linked show waits for paid selection and claims a bag through existing scan UI',async t=>{const p=await open(t);assert.equal(await p.locator('#item-scan').isDisabled(),true);assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='create_live_sale_lot')),false);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);assert.equal(await p.locator('#auction-number').getAttribute('readonly'),'');assert.match(await p.locator('#ebay-live-current').innerText(),/testbuyer.*\$100/);assert.deepEqual(p.errors,[]);});
test('late failure disables active phone scanner and removes the sale from completed totals',async t=>{const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);await p.evaluate(()=>{dashboard.attempts[0].payment_state='failed';});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('item-scan').disabled);await p.locator('#ebay-back-to-queue').click();await p.locator('#ebay-live-filter').selectOption('attention');assert.match(await p.locator('#ebay-live-queue').innerText(),/STOP.*check this bag/);assert.equal(await p.locator('[data-action=scan]').count(),0);await p.locator('#ebay-show-totals > summary').click();assert.match(await p.locator('#ebay-live-totals').innerText(),/0 \/ \$0.00/);});
test('stale capture and network failure block new scans',async t=>{const p=await open(t);await p.evaluate(()=>{dashboard.connection.source_seen_at=new Date(Date.now()-60000).toISOString();});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.querySelector('[data-action=scan]').disabled);assert.match(await p.locator('#ebay-live-health').innerText(),/Capture paused/);await p.evaluate(()=>{dashboard.connection.source_seen_at=new Date().toISOString();failDashboard=true;});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-live-message').textContent.includes('Network interrupted'));assert.equal(await p.locator('#item-scan').isDisabled(),true);});
test('bag closes without invoking a printer; rejected close keeps the selected bag',async t=>{const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);await p.evaluate(()=>{failClose=true;});await p.evaluate(()=>ebayLive.closeCurrent());assert.match(await p.locator('#ebay-live-message').innerText(),/not confirmed/);assert.equal(await p.evaluate(()=>ebayLive.current().id),'sale');await p.evaluate(()=>{failClose=false;});await p.evaluate(()=>ebayLive.closeCurrent());assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='print').length),0);assert.equal(await p.locator('#ebay-live-filter').inputValue(),'ready');assert.equal(await p.locator('#ebay-closed-receipt').isVisible(),true);await p.locator('#ebay-print-last').click();await p.waitForFunction(()=>calls.some(c=>c.name==='print'));assert.match(await p.evaluate(()=>calls.find(c=>c.name==='print').xml),/TESTBUYER/);assert.doesNotMatch(await p.evaluate(()=>calls.find(c=>c.name==='print').xml),/EB-29-SALE/);});
test('local cancellation requires physical bag confirmation and records the reason',async t=>{const p=await open(t);await p.locator('[data-action=review]').click();await p.locator('#ebay-review-action').selectOption('cancel_release');await p.locator('#ebay-review-note').fill('Checked eBay and removed the watch from the bag');await p.locator('#ebay-review-save').click();assert.match(await p.locator('#ebay-review-error').innerText(),/physical bag/);assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='resolve_ebay_live_attempt')),false);await p.locator('#ebay-review-physical').check();await p.locator('#ebay-review-save').click();await p.locator('#ebay-live-review').waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>calls.find(c=>c.name==='resolve_ebay_live_attempt').args._action),'cancel_release');});
test('phone layout fits, seller data is escaped, and missing prices stay explicit',async t=>{const p=await open(t);await p.setViewportSize({width:320,height:740});await p.evaluate(()=>{dashboard.attempts[0].listing_title='<img src=x onerror="window.injected=true">';dashboard.attempts[0].closed_at=new Date().toISOString();dashboard.attempts[0].minimum_total=null;dashboard.attempts[0].estimated_profit=null;});await p.locator('#ebay-live-refresh').click();await p.locator('#ebay-live-filter').selectOption('closed');assert.equal(await p.evaluate(()=>!!window.injected),false);await p.locator('#ebay-show-totals > summary').click();assert.match(await p.locator('#ebay-live-totals').innerText(),/1 bags missing/);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),JSON.stringify(await p.evaluate(()=>[...document.querySelectorAll('body *')].filter(e=>e.getBoundingClientRect().right>innerWidth).slice(0,18).map(e=>({tag:e.tagName,id:e.id,cls:e.className,width:e.getBoundingClientRect().width,right:e.getBoundingClientRect().right})))));await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:new URL('../test-results/ebay-live-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});assert.deepEqual(p.errors,[]);});
test('receiver acknowledges only the linked event after ingest succeeds',async t=>{const p=await open(t,'?capture=1');await p.evaluate(()=>{window.acks=[];window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_LIVE_ACK')acks.push(e.data)});window.postMessage({type:'INVSTO_LIVE_BATCH',id:'wrong',payload:{event_id:'OTHER',events:[],health:{}}},location.origin);});await p.waitForFunction(()=>acks.length===1);assert.equal(await p.evaluate(()=>acks[0].ok),false);await p.evaluate(()=>window.postMessage({type:'INVSTO_LIVE_BATCH',id:'right',payload:{event_id:'EVENT123',events:[],health:{}}},location.origin));await p.waitForFunction(()=>acks.length===2);assert.equal(await p.evaluate(()=>acks[1].ok),true);assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='ingest_ebay_live_events').length),1);});
test('receiver clears its recovered capture error without hiding later operator feedback',async t=>{
 const p=await open(t,'?capture=1');
 await p.evaluate(()=>{
  window.acks=[];window.failCapture=true;
  window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_LIVE_ACK')acks.push(e.data);});
  const original=supabase.rpc;supabase.rpc=async(name,args)=>name==='ingest_ebay_live_events'&&failCapture?{error:{message:'Capture connection interrupted'}}:original(name,args);
 });
 const send=async id=>{await p.evaluate(id=>window.postMessage({type:'INVSTO_LIVE_BATCH',id,payload:{event_id:'EVENT123',events:[],health:{}}},location.origin),id);await p.waitForFunction(id=>acks.some(a=>a.id===id),id);};
 await send('failed');assert.match(await p.locator('#ebay-live-message').innerText(),/Capture connection interrupted/);
 await p.evaluate(()=>{failCapture=false;});await send('recovered');assert.match(await p.locator('#ebay-live-message').innerText(),/Capture connected/);
 assert.equal(await p.locator('#ebay-live-message').evaluate(el=>el.classList.contains('is-error')),false);
 await p.evaluate(()=>{failCapture=true;});await send('failed-again');
 await p.evaluate(()=>ebayLive.reviewCurrent());assert.match(await p.locator('#ebay-live-message').innerText(),/Choose an eBay auction/);
 await p.evaluate(()=>{failCapture=false;});await send('recovered-again');assert.match(await p.locator('#ebay-live-message').innerText(),/Choose an eBay auction/);
});
test('a background event connection error is acknowledged without mislabelling the selected show',async t=>{
 const p=await open(t,'?capture=1');const before=await p.locator('#ebay-live-message').innerText();
 await p.evaluate(()=>{
  window.acks=[];window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_LIVE_ACK')acks.push(e.data);});
  const original=supabase.from;supabase.from=table=>{const q=original(table);if(table==='ebay_live_connections')q.maybeSingle=async()=>({error:{message:'Network interrupted'}});return q;};
  window.postMessage({type:'INVSTO_LIVE_BATCH',id:'background',payload:{event_id:'UNKNOWN123',events:[],health:{}}},location.origin);
 });
 await p.waitForFunction(()=>acks.length===1);assert.equal(await p.evaluate(()=>acks[0].ok),false);
 assert.match(await p.evaluate(()=>acks[0].error),/Could not check the eBay connection: Network interrupted/);
 assert.equal(await p.locator('#ebay-live-message').innerText(),before);
});
test('extension outbox persists failures until receiver commit and retries after worker restart',async()=>{
 const source=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');let stored={},handler,accept=false,received=[];
 const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>{stored=structuredClone(v)}}},runtime:{id:'extension',onMessage:{addListener:fn=>{handler=fn}}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{sendMessage:async(tab,msg)=>{received.push(msg);return {ok:accept,error:'Offline'}}}};
 const boot=()=>vm.runInNewContext(source,{chrome,URL,Date,Promise,Error,Object,Number,String});boot();
 const send=(message,url,id=1)=>new Promise(resolve=>handler(message,{id:'extension',tab:{id,url}},resolve));
 await send({type:'INVSTO_CAPTURE',event_id:'EVENT123',events:[{key:'failure',kind:'failed'}],health:{ready:true}},'https://www.ebay.com/ebaylive/host/events/EVENT123');assert.equal(Object.keys(stored.capture.events).length,1);
 await send({type:'INVSTO_RECEIVER'},'https://antdamus.github.io/Invsto/live-sales.html?capture=1',2);assert.equal(Object.keys(stored.capture.events).length,1);
 boot();accept=true;await send({type:'INVSTO_RECEIVER'},'https://antdamus.github.io/Invsto/live-sales.html?capture=1',2);assert.equal(Object.keys(stored.capture.events).length,0);assert.equal(received.at(-1).payload.events[0].kind,'failed');
});
test('capture sends explicit payment evidence and emits a stopped heartbeat',async t=>{
 const page=await browser.newPage();t.after(()=>page.close());await page.goto(origin+'/ebaylive/host/events/EVENT123');await page.setContent('<button role="tab" aria-selected="true">Activity</button><button role="tab" aria-selected="true">Sold (1)</button>'+tile()+'<div id="activity-panel"><div aria-label="Filter activity"><button aria-pressed="true">All</button></div>'+row()+'</div>');
 await page.evaluate(()=>{window.packets=[];window.chrome={runtime:{sendMessage:async m=>{if(m.type==='INVSTO_CAPTURE')packets.push(m);return {ok:true,status:'Connected'}}}};});
 await streamFixture(page);for(const name of ['parser','capture'])await page.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 assert.equal(await page.evaluate(()=>packets.length),0);await page.getByRole('button',{name:'Start Invsto capture',exact:true}).click();await page.waitForFunction(()=>packets.some(p=>p.health.ready));const first=await page.evaluate(()=>packets[0]);assert.equal(first.event_id,'EVENT123');assert.deepEqual(first.events.map(e=>e.kind),['paid','won']);await page.getByRole('button',{name:'Stop Invsto capture',exact:true}).click();await page.waitForFunction(()=>packets.some(p=>!p.health.ready));
});
test('ordinary unlinked sessions retain the manual bag workflow',async t=>{const p=await open(t);await p.evaluate(async()=>{dashboard.connection=null;dashboard.attempts=[];await prepareNextBag();});assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='create_live_sale_lot')),true);assert.equal(await p.locator('#auction-number').getAttribute('readonly'),null);assert.equal(await p.locator('#item-scan').isDisabled(),false);assert.deepEqual(p.errors,[]);});

test('automatic show setup needs an event URL and no starting number; manual mode is explicit',async t=>{
 const p=await open(t);await p.locator('#manage-live-show').click();
 assert.equal(await p.locator('#session-start-auction-number').isVisible(),false);
 await p.locator('#session-workflow').selectOption('manual');assert.equal(await p.locator('#session-start-auction-number').isVisible(),true);
 await p.locator('#session-workflow').selectOption('ebay_live');await p.locator('#session-ebay-url').fill('https://example.com/ebaylive/host/events/OTHER12');await p.locator('#start-session').click();
 assert.match(await p.locator('#session-feedback').innerText(),/event URL/);assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='start_ebay_live_session')),false);
 await p.locator('#session-ebay-url').fill('https://www.ebay.com/ebaylive/host/events/NEW1234?tab=dashboard');assert.equal(await p.locator('#session-store-select').isVisible(),false);await p.locator('#start-session').click();
 await p.waitForFunction(()=>calls.some(c=>c.name==='start_ebay_live_session'));
 assert.equal(await p.evaluate(()=>calls.find(c=>c.name==='start_ebay_live_session').args._event_id),'NEW1234');
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='create_live_sale_lot')),false);assert.deepEqual(p.errors,[]);
});
test('phone switches between queue and bag; desktop shows both; refresh restores the owned bag',async t=>{
 const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 assert.equal(await p.locator('#ebay-queue-area').isVisible(),false);assert.equal(await p.locator('#scan-stage').isVisible(),true);
 await p.locator('#ebay-back-to-queue').click();assert.equal(await p.locator('#ebay-queue-area').isVisible(),true);assert.equal(await p.locator('#scan-stage').isVisible(),false);
 await p.locator('#ebay-return-to-bag').click();assert.equal(await p.locator('#scan-stage').isVisible(),true);
 await p.setViewportSize({width:1440,height:1000});assert.equal(await p.locator('#ebay-queue-area').isVisible(),true);
 const q=await p.locator('#ebay-live-panel').boundingBox(),s=await p.locator('#scan-stage').boundingBox();assert.ok(q.x+q.width<=s.x+2);
 await p.evaluate(()=>window.scrollTo(0,0));await p.screenshot({path:new URL('../test-results/ebay-live-desktop.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 const restored=await open(t,'',true);assert.equal(await restored.evaluate(()=>ebayLive.current()?.id),'sale');assert.equal(await restored.evaluate(()=>calls.filter(c=>c.name==='claim_ebay_live_bag').length),0);
});
test('nonblocking metadata does not disable paid auctions or steal button focus during polling',async t=>{
 const p=await open(t);await p.evaluate(()=>{dashboard.unmatched=[{source_key:'missing-title',kind:'won',evidence:'Win still matching',blocking:false}];});await p.locator('#ebay-live-refresh').click();
 const scan=p.locator('[data-action=scan]');assert.equal(await scan.isDisabled(),false);await scan.focus();await p.evaluate(()=>ebayLive.refresh());assert.equal(await scan.evaluate(e=>e===document.activeElement),true);
 assert.match(await p.locator('#ebay-live-unmatched-count').innerText(),/still being matched/);
});
test('background capture requires an advancing stream clock and pauses again when it stalls',async t=>{
 const p=await browser.newPage();t.after(()=>p.close());await p.goto(origin+'/ebaylive/host/events/EVENT123');
 await p.setContent('<button role="tab" aria-selected="true">Activity</button><button role="tab" aria-selected="true">Sold (1)</button><span id="metric-elapsed-time-value">00:01:00</span>'+tile()+'<div id="activity-panel"><div aria-label="Filter activity"><button aria-pressed="true">All</button></div>'+row()+'</div>');
 await p.evaluate(()=>{window.packets=[];window.fakeNow=Date.now();Date.now=()=>window.fakeNow;Object.defineProperty(document,'visibilityState',{value:'hidden',configurable:true});window.chrome={runtime:{sendMessage:async m=>{if(m.type==='INVSTO_CAPTURE')packets.push(m);return {ok:true,status:'Connected'}}}};});
 await streamFixture(p);for(const name of ['parser','capture'])await p.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await p.getByRole('button',{name:'Start Invsto capture',exact:true}).click();await p.waitForFunction(()=>packets.length);assert.equal(await p.evaluate(()=>packets.at(-1).health.ready),false);
 await p.locator('#metric-elapsed-time-value').evaluate(e=>{e.textContent='00:01:01'});await p.waitForFunction(()=>packets.at(-1).health.ready);
 await p.evaluate(()=>{fakeNow+=21000;});await p.waitForFunction(()=>!packets.at(-1).health.ready);
});

test('phone can review and close a scanned bag using touch buttons, then stays on ready auctions',async t=>{
 const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 await p.evaluate(async()=>{mockItems=[{id:'entry',lot_id:'lot',item_id:'watch',quantity:1,status:'reserved',item:{id:'watch',title:'Test watch',barcode:'WATCH123'},show_elapsed_seconds:60}];await loadLotItems();});
 await p.locator('#review-scanned-bag').click();assert.equal(await p.locator('#bag-label-panel').isVisible(),true);assert.equal(await p.locator('#scan-stage').isVisible(),false);
 assert.equal(await p.locator('#confirm-auction-number').innerText(),'#001 - Test watch');assert.equal(await p.locator('#auction-number').isVisible(),false);
 assert.match(await p.locator('#label-review-manifest').innerText(),/Test watch/);await p.locator('#generate-live-label').click();
 await p.locator('#ebay-closed-receipt').waitFor();assert.equal(await p.locator('#ebay-live-filter').inputValue(),'ready');assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='print')),false);
 assert.deepEqual(p.errors,[]);
});

test('live queue keeps sale chronology across batch capture, claimed bags, filters and new arrivals',async t=>{
 const p=await open(t);
 await p.evaluate(()=>{
  const base=dashboard.attempts[0];
  dashboard.attempts=[
   {...base,id:'six',ordinal:'6',stream_offset_seconds:1832,claimed_by:'worker'},
   {...base,id:'seven',ordinal:'7',stream_offset_seconds:2012},
   {...base,id:'one',ordinal:'1',stream_offset_seconds:120,created_at:new Date(Date.parse(base.created_at)+5000).toISOString()},
   {...base,id:'eight',ordinal:'8',stream_offset_seconds:2012}
  ];
 });
 const ids=()=>p.locator('#ebay-live-queue article').evaluateAll(rows=>rows.map(row=>row.dataset.attempt));
 await p.locator('#ebay-live-refresh').click();
 assert.deepEqual(await ids(),['eight','seven','six','one']);
 // A different RPC row order or payment update must not reshuffle tied captures.
 await p.evaluate(()=>{dashboard.attempts.reverse();dashboard.attempts.find(a=>a.id==='one').updated_at=new Date().toISOString();});
 await p.locator('#ebay-live-refresh').click();
 assert.deepEqual(await ids(),['eight','seven','six','one']);
 for(const filter of ['waiting','attention','closed','all','ready']){
  await p.evaluate(filter=>{for(const a of dashboard.attempts){a.payment_state=filter==='waiting'?'waiting':filter==='attention'?'failed':'paid';a.closed_at=filter==='closed'?new Date().toISOString():null;}},filter);
  await p.evaluate(()=>ebayLive.refresh());await p.locator('#ebay-live-filter').selectOption(filter);
  assert.deepEqual(await ids(),['eight','seven','six','one']);
 }
 // With no stream time yet, a newly received sale still appears above earlier sales.
 await p.evaluate(()=>{dashboard.attempts.push({...dashboard.attempts.find(a=>a.id==='seven'),id:'new-sale',ordinal:'9',stream_offset_seconds:null,created_at:new Date(Date.now()+10000).toISOString()});});
 await p.waitForFunction(()=>document.querySelector('#ebay-live-queue article')?.dataset.attempt==='new-sale');
 assert.deepEqual(await ids(),['new-sale','eight','seven','six','one']);
 await p.setViewportSize({width:1440,height:1000});await p.evaluate(()=>ebayLive.refresh());
 assert.deepEqual(await ids(),['new-sale','eight','seven','six','one']);
 assert.deepEqual(p.errors,[]);
});

test('live queue falls back to capture time when stream times are unavailable',async t=>{
 const p=await open(t);await p.evaluate(()=>{dashboard.attempts[0].claimed_by='worker';dashboard.attempts.push({...dashboard.attempts[0],id:'new-sale',claimed_by:null,created_at:new Date(Date.now()+1000).toISOString()});});
 await p.locator('#ebay-live-refresh').click();assert.equal(await p.locator('#ebay-live-queue article').first().getAttribute('data-attempt'),'new-sale');
});

test('scanner refocus does not interrupt item notes or payment-review dialogs',async t=>{
 const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 await p.locator('.manual-live-item-box > summary').click();await p.locator('#manual-live-item-description').fill('Gold watch with replacement strap');
 assert.equal(await p.evaluate(()=>shouldReturnFocusToScanner()),false);
 await p.locator('#cancel-lot').click();assert.equal(await p.locator('#ebay-live-review').isVisible(),true);assert.equal(await p.evaluate(()=>shouldReturnFocusToScanner()),false);
});

async function addManualPhoto(p,input='manual-live-item-photo'){
 const base64=await p.evaluate(()=>{const c=document.createElement('canvas');c.width=40;c.height=30;const x=c.getContext('2d');x.fillStyle='gold';x.fillRect(0,0,40,30);return c.toDataURL('image/png').split(',')[1];});
 await p.locator('#'+input).setInputFiles({name:'phone-photo.png',mimeType:'image/png',buffer:Buffer.from(base64,'base64')});
 const prefix=input.startsWith('manual-edit')?'manual-edit':'manual-live-item';
 await p.waitForFunction(prefix=>{const text=document.getElementById(prefix+'-photo-status').textContent;return text&&!text.includes('Preparing');},prefix,{timeout:10000});
 assert.match(await p.locator('#'+prefix+'-photo-status').innerText(),/Photo ready/);
 await p.locator('#'+prefix+'-preview').waitFor({state:'visible'});
}
test('manual item photo and break-even can be added then edited directly in final review on a phone',async t=>{
 const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 await p.locator('.manual-live-item-box > summary').click();await p.locator('#manual-live-item-category').selectOption('Chain');await p.locator('#manual-live-item-description').fill('Gold chain');await p.locator('#manual-live-item-quantity').fill('2');await p.locator('#manual-live-item-minimum').fill('40');
 assert.equal(await p.locator('#manual-live-item-camera').getAttribute('capture'),'environment');await addManualPhoto(p);assert.equal(await p.locator('#add-manual-live-item').isEnabled(),true);await p.locator('#add-manual-live-item').click();await p.waitForFunction(()=>mockManualItems.length===1);
 assert.equal(await p.evaluate(()=>calls.find(c=>c.name==='upload').type),'image/jpeg');assert.match(await p.evaluate(()=>mockManualItems[0].photo_path),/^live-manual\/lot\//);
 await p.waitForFunction(()=>document.getElementById('ebay-running-total').textContent==='+$20.00');assert.match(await p.locator('#ebay-current-result').innerText(),/\$100.00 sold.*\$80.00 break-even.*\+\$20.00/);assert.equal(await p.locator('#ebay-running-margin').isVisible(),true);
 await p.locator('#review-scanned-bag').click();assert.match(await p.locator('#manual-break-even-summary').innerText(),/Break-even \$80.00.*\$20.00/);await p.locator('[data-edit-manual]').click();
 assert.equal(await p.locator('#manual-edit-minimum').inputValue(),'40');await p.locator('#manual-edit-quantity').fill('3');await p.locator('#manual-edit-minimum').fill('35');await p.locator('#manual-edit-description').fill('Gold chain, corrected');await p.locator('#manual-edit-save').click();await p.locator('#manual-item-editor').waitFor({state:'hidden'});
 assert.equal(await p.locator('#bag-label-panel').isVisible(),true);assert.match(await p.locator('#label-review-manifest').innerText(),/Gold chain, corrected/);assert.match(await p.locator('#manual-break-even-summary').innerText(),/Break-even \$105.00.*-\$5.00/);
 assert.equal(await p.locator('#ebay-running-total').innerText(),'-$5.00');assert.match(await p.locator('#ebay-running-total').getAttribute('class'),/is-loss/);assert.match(await p.locator('#ebay-current-result').innerText(),/below break-even/);
 assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='upload').length),1);assert.equal(await p.evaluate(()=>mockManualItems[0].edit_revision),2);
 await p.locator('[data-edit-manual]').click();await p.locator('#manual-edit-remove-photo').click();await p.locator('#manual-edit-save').click();await p.locator('#manual-item-editor').waitFor({state:'hidden'});assert.equal(await p.evaluate(()=>mockManualItems[0].photo_path),null);
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(p.errors,[]);
 await p.screenshot({path:new URL('../test-results/manual-item-review-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
});
test('failed manual photo upload keeps the draft and does not create an item until retry succeeds',async t=>{
 const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);await p.locator('.manual-live-item-box > summary').click();await p.locator('#manual-live-item-description').fill('Keep this description');await addManualPhoto(p);
 await p.evaluate(()=>{failUpload=true;});await p.locator('#add-manual-live-item').click();await p.waitForFunction(()=>document.getElementById('manual-live-item-photo-status').textContent.includes('interrupted'));
 assert.equal(await p.evaluate(()=>mockManualItems.length),0);assert.equal(await p.locator('#manual-live-item-description').inputValue(),'Keep this description');assert.equal(await p.locator('#manual-live-item-preview').isVisible(),true);
 await p.evaluate(()=>{failUpload=false;});await p.locator('#add-manual-live-item').click();await p.waitForFunction(()=>mockManualItems.length===1);assert.equal(await p.evaluate(()=>mockManualItems[0].live_unit_minimum),null);
});
test('on-air seller switch preserves previous sales; correcting the whole show is explicit',async t=>{
 const p=await open(t);assert.match(await p.locator('#ebay-on-air-name').innerText(),/Test seller/);await p.locator('#ebay-seller-control > summary').click();await p.locator('#ebay-live-seller').selectOption('next-seller');await p.evaluate(()=>{document.getElementById('ebay-seller-control').dispatchEvent(new Event('toggle'));return ebayLive.refresh();});assert.equal(await p.locator('#ebay-live-seller').inputValue(),'next-seller');
 await p.locator('#ebay-save-seller').click();await p.waitForFunction(()=>document.getElementById('ebay-on-air-name').textContent.includes('Sydney'));
 assert.equal(await p.evaluate(()=>calls.find(c=>c.name==='set_ebay_live_seller').args._correct_existing),false);assert.match(await p.locator('#ebay-live-queue').innerText(),/Sold by Test seller/);
 await p.locator('#ebay-seller-control > summary').click();await p.locator('#ebay-correct-existing').check();await p.locator('#ebay-save-seller').click();assert.match(await p.locator('#ebay-seller-error').innerText(),/Explain/);
 await p.locator('#ebay-seller-reason').fill('All sales in this show were actually made by Sydney');await p.locator('#ebay-save-seller').click();await p.waitForFunction(()=>dashboard.attempts[0].seller_id==='next-seller');assert.match(await p.locator('#ebay-live-queue').innerText(),/Sold by Sydney Miller/);assert.deepEqual(p.errors,[]);
});

test('correcting the seller refreshes the already open bag without crediting the scanner',async t=>{
 const p=await open(t);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 await p.locator('#ebay-seller-control > summary').click();await p.locator('#ebay-live-seller').selectOption('next-seller');await p.locator('#ebay-correct-existing').check();await p.locator('#ebay-seller-reason').fill('The full show was sold by Sydney, not the scanner');await p.locator('#ebay-save-seller').click();
 await p.waitForFunction(()=>document.getElementById('manifest-bag-meta').textContent.includes('Sydney'));
 assert.match(await p.locator('#manifest-bag-meta').innerText(),/Sold by Sydney Miller/);assert.doesNotMatch(await p.locator('#manifest-bag-meta').innerText(),/Owner Test seller/);assert.equal(await p.evaluate(()=>dashboard.attempts[0].claimed_by),'worker');assert.deepEqual(p.errors,[]);
});

test('post-show allows missing item scans without a live clock but never bypasses payment or connection failures',async t=>{
 const p=await open(t);await p.evaluate(()=>{dashboard.connection.broadcast_ended_at=new Date().toISOString();dashboard.connection.capture_ready=false;dashboard.connection.source_seen_at='2020-01-01';});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>!document.querySelector('[data-action=scan]').disabled);
 assert.match(await p.locator('#ebay-live-health').innerText(),/Broadcast ended/);await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 await p.evaluate(()=>{dashboard.unmatched=[{kind:'failed',blocking:true,evidence:'Unmatched failure'}];dashboard.attempts[0].payment_hold=true;});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('item-scan').disabled);
 assert.match(await p.locator('#ebay-scan-payment-banner').innerText(),/notification needs review for this sale/);
 await p.evaluate(()=>{dashboard.unmatched=[];dashboard.attempts[0].payment_state='failed';});await p.locator('#ebay-live-refresh').click();assert.equal(await p.locator('#item-scan').isDisabled(),true);
 await p.evaluate(()=>{dashboard.attempts[0].payment_state='paid';failDashboard=true;});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-live-message').textContent.includes('Network interrupted'));assert.equal(await p.locator('#item-scan').isDisabled(),true);assert.deepEqual(p.errors,[]);
});

test('payment holds affect only their sale while other paid bags stay scannable after the show',async t=>{
 const p=await open(t);await p.evaluate(()=>{
  dashboard.connection.broadcast_ended_at=new Date().toISOString();dashboard.connection.capture_ready=false;dashboard.connection.source_seen_at='2020-01-01';
  dashboard.attempts[0].payment_hold=false;
  dashboard.attempts.push({...dashboard.attempts[0],id:'held-sale',listing_title:'#002 - Review watch',payment_hold:true});
  dashboard.unmatched=[{source_key:'unmatched-failure',kind:'failed',blocking:true,evidence:'Payment failed for another sale'}];
  dashboard.post_show={open_paid_bags:2,payment_issues:0,unmatched_notifications:1,unlinked_bags:0,paid_bags:2,closed_bags:0};
 });await p.locator('#ebay-live-refresh').click();
 const paid=p.locator('[data-attempt="sale"]'),held=p.locator('[data-attempt="held-sale"]');
 await p.waitForFunction(()=>document.querySelector('[data-attempt="held-sale"]'));
 assert.equal(await paid.locator('[data-action=scan]').isEnabled(),true);
 assert.equal(await held.locator('[data-action=scan]').isDisabled(),true);
 assert.match(await held.innerText(),/Scanning is on hold for this sale/);
 await held.locator('[data-action=notification]').click();assert.equal(await p.locator('#ebay-live-unmatched').getAttribute('open'),'');
 await paid.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 assert.equal(await p.locator('#ebay-complete-show').isDisabled(),true);
 await p.evaluate(()=>{dashboard.attempts[0].payment_hold=true;dashboard.attempts[0].verified_at=new Date().toISOString();dashboard.connection.capture_ready=true;dashboard.connection.source_seen_at=new Date().toISOString();});
 await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('item-scan').disabled);
 assert.match(await p.locator('#ebay-scan-payment-banner').innerText(),/notification needs review for this sale/);
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(p.errors,[]);
});

test('unscoped payment notices stay reviewable without disabling paid bags during or after the show',async t=>{
 const p=await open(t);await p.evaluate(()=>{dashboard.unmatched=[{source_key:'unknown',kind:'unknown',blocking:true,evidence:'Unreadable notification'}];dashboard.attempts[0].payment_hold=false;});
 await p.locator('#ebay-live-refresh').click();assert.equal(await p.locator('[data-action=scan]').isEnabled(),true);
 await p.evaluate(()=>{dashboard.connection.broadcast_ended_at=new Date().toISOString();dashboard.connection.capture_ready=false;});await p.locator('#ebay-live-refresh').click();
 assert.equal(await p.locator('[data-action=scan]').isEnabled(),true);assert.equal(await p.locator('#ebay-live-unmatched').isVisible(),true);
 assert.equal(await p.locator('#ebay-complete-show').isDisabled(),true);assert.deepEqual(p.errors,[]);
});

test('post-show completion requires finished bags, physical checks and a successful server recheck',async t=>{
 const p=await open(t);p.on('dialog',d=>d.accept());await p.locator('#ebay-mark-ended').click();await p.locator('#ebay-post-show').waitFor({state:'visible'});assert.equal(await p.evaluate(()=>showSession.status),'active');
 await p.evaluate(()=>{dashboard.post_show={open_paid_bags:1,payment_issues:0,unmatched_notifications:0,unlinked_bags:0,paid_bags:1,closed_bags:0};});await p.locator('#ebay-live-refresh').click();await p.locator('#ebay-final-checklist>summary').click();await p.locator('#ebay-final-bags').check();await p.locator('#ebay-final-payments').check();assert.equal(await p.locator('#ebay-complete-show').isDisabled(),true);
 await p.evaluate(()=>{dashboard.post_show.open_paid_bags=0;dashboard.post_show.closed_bags=1;});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>!document.getElementById('ebay-complete-show').disabled);
 await p.evaluate(()=>{failComplete=true;});await p.locator('#ebay-complete-show').click();await p.waitForFunction(()=>document.getElementById('ebay-complete-error').textContent.includes('payment changed'));assert.equal(await p.evaluate(()=>showSession.status),'active');
 await p.setViewportSize({width:320,height:740});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.screenshot({path:new URL('../test-results/post-show-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
 await p.evaluate(()=>{failComplete=false;});await p.locator('#ebay-complete-show').click();await p.waitForFunction(()=>showSession.status==='ended');assert.deepEqual(p.errors,[]);
});

test('closed paid bags can reopen for post-show corrections without changing the seller',async t=>{
 const p=await open(t,'',true);await p.evaluate(()=>{dashboard.connection.broadcast_ended_at=new Date().toISOString();dashboard.connection.capture_ready=false;dashboard.attempts[0].closed_at=new Date().toISOString();});await p.locator('#ebay-live-refresh').click();await p.locator('#ebay-live-filter').selectOption('closed');await p.locator('[data-action=reopen]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);assert.equal(await p.evaluate(()=>dashboard.attempts[0].closed_at),null);assert.equal(await p.evaluate(()=>dashboard.attempts[0].seller_id),'seller');assert.deepEqual(p.errors,[]);
});

test('end detection requires the explicit terminal control and ignores a reset clock',async t=>{
 const p=await parser(t,'<span id="metric-elapsed-time-value">00:00:00</span><p>Event ended</p>');assert.equal(await p.evaluate(()=>InvstoLiveParser.parse(document).broadcastEnded),false);
 await p.setContent('<button disabled>Event ended</button><span id="metric-elapsed-time-value">00:00:00</span>');const r=await p.evaluate(()=>InvstoLiveParser.parse(document));assert.equal(r.broadcastEnded,true);assert.equal(r.elapsed,null);
});

test('a stopped helper still reports the explicit ended event without inventing auction payments',async t=>{
 const p=await browser.newPage();t.after(()=>p.close());await p.goto(origin+'/ebaylive/host/events/EVENT123');await p.setContent('<button disabled>Event ended</button>');await p.evaluate(()=>{window.packets=[];window.chrome={runtime:{sendMessage:async m=>{if(m.type==='INVSTO_CAPTURE')packets.push(m);return {ok:true,status:'Connected'}}}};});
 await streamFixture(p);for(const name of ['parser','capture'])await p.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});await p.waitForFunction(()=>packets.length>0);const result=await p.evaluate(()=>packets[0]);assert.equal(result.health.broadcast_ended,true);assert.equal(result.health.ready,false);assert.deepEqual(result.events,[]);
});

test('running counter includes priced open bags, separates closed results, and excludes unpaid or incomplete bags',async t=>{
 const p=await open(t);
 await p.evaluate(()=>{const a=dashboard.attempts[0];Object.assign(a,{units:1,minimum_total:80});dashboard.attempts=[a,
 {...a,id:'closed-loss',seller_id:'next-seller',seller_name:'Sydney Miller',amount:50,minimum_total:70,closed_at:new Date().toISOString()},
 {...a,id:'free-cost',amount:40,minimum_total:0},
 {...a,id:'unknown-minimum',amount:80,minimum_total:null},
 {...a,id:'empty-bag',amount:150,minimum_total:0,units:0},
 {...a,id:'failed',amount:999,payment_state:'failed'},
 {...a,id:'waiting',amount:999,payment_state:'waiting'},
 {...a,id:'resolved',amount:999,resolved_at:new Date().toISOString()}];});
 await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-running-total').textContent==='+$40.00');
 assert.equal(await p.locator('#ebay-running-open').innerText(),'+$60.00');assert.equal(await p.locator('#ebay-running-closed').innerText(),'-$20.00');assert.match(await p.locator('#ebay-running-coverage').innerText(),/3 priced paid bags.*2 missing/);
 await p.locator('#ebay-running-margin summary').click();assert.match(await p.locator('#ebay-running-sellers').innerText(),/Sydney Miller\s*-\$20.00/);
 await p.locator('[data-attempt="sale"] [data-action=scan]').click();assert.equal(await p.locator('#ebay-running-margin').isVisible(),true);assert.match(await p.locator('#ebay-current-result').innerText(),/\+\$20.00 above break-even/);
 await p.setViewportSize({width:320,height:740});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));await p.locator('#ebay-running-margin').screenshot({path:new URL('../test-results/running-margin-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await p.evaluate(()=>{dashboard.attempts[0].payment_state='failed';});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-running-total').textContent==='+$20.00');assert.match(await p.locator('#ebay-current-result').innerText(),/excluded from totals/);
 await p.evaluate(()=>{failDashboard=true;});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-running-freshness').textContent.includes('Updates paused'));assert.deepEqual(p.errors,[]);
});

test('running counter shows missing data rather than inventing zero profit and uses exact cents',async t=>{
 const p=await open(t);assert.equal(await p.locator('#ebay-running-total').innerText(),'—');assert.match(await p.locator('#ebay-running-coverage').innerText(),/0 priced paid bags.*1 missing/);
 await p.evaluate(()=>{const a=dashboard.attempts[0];Object.assign(a,{units:1,amount:1,minimum_total:.9});dashboard.attempts=[a,{...a,id:'two',minimum_total:.8},{...a,id:'three',minimum_total:1.3}];});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-running-total').textContent==='$0.00');assert.doesNotMatch(await p.locator('#ebay-running-total').getAttribute('class')||'',/is-loss|is-gain/);
 await p.evaluate(()=>{dashboard.attempts[0].minimum_total=1.9;});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-running-total').textContent==='-$1.00');assert.match(await p.locator('#ebay-running-total').getAttribute('class'),/is-loss/);assert.deepEqual(p.errors,[]);
});


test('phone bag lookup entry stays visible during a linked show and reprints identify the bag on every QR',async t=>{
 const p=await open(t);await p.setViewportSize({width:320,height:740});
 assert.equal(await p.locator('#scan-bag-label').isVisible(),true);
 assert.equal(await p.locator('#scan-bag-label').getAttribute('href'),'bag-lookup.html');
 await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 await p.evaluate(()=>ebayLive.closeCurrent());await p.locator('#ebay-print-last').click();await p.waitForFunction(()=>calls.some(c=>c.name==='print'));
 const xml=await p.evaluate(()=>calls.find(c=>c.name==='print').xml);
 assert.deepEqual([...xml.matchAll(/<DataString>(.*?)<\/DataString>/g)].map(m=>m[1]),Array(4).fill('LIVE-TEST'));
 assert.match(xml,/<Text>#001<\/Text>/);
});


test('print is one tap from scanning and final review without closing the current bag',async t=>{
 const p=await open(t);assert.equal(await p.locator('[data-action=print]').count(),1);
 await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);
 assert.equal(await p.locator('#ebay-print-scan').isVisible(),true);await p.locator('#ebay-print-scan').click();
 await p.waitForFunction(()=>document.getElementById('ebay-print-scan-status').textContent.includes('Label queued for Test printer'));
 assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='close_ebay_live_bag').length),0);assert.equal(await p.evaluate(()=>ebayLive.current().id),'sale');
 await p.evaluate(async()=>{mockItems=[{id:'entry',lot_id:'lot',item_id:'watch',quantity:1,status:'reserved',item:{title:'Test watch'},show_elapsed_seconds:60}];await loadLotItems();});
 await p.locator('#review-scanned-bag').click();assert.equal(await p.locator('#ebay-print-review').isVisible(),true);
 await p.locator('#ebay-print-review').click();await p.waitForFunction(()=>calls.filter(c=>c.name==='print').length===2);
 assert.match(await p.locator('#ebay-print-review-status').innerText(),/Label queued/);assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='close_ebay_live_bag')),false);
 await p.locator('#generate-live-label').click();await p.waitForFunction(()=>{const r=document.getElementById('ebay-closed-receipt').getBoundingClientRect(),b=document.getElementById('ebay-print-last').getBoundingClientRect();return r.top>=90&&r.top<=130&&b.bottom<=innerHeight;});
 assert.match(await p.locator('#ebay-closed-heading').innerText(),/label queued/);assert.equal(await p.locator('#ebay-print-last').innerText(),'Reprint bag label');
 assert.ok(await p.locator('#ebay-closed-receipt').evaluate(e=>!!(e.compareDocumentPosition(document.getElementById('ebay-running-margin'))&Node.DOCUMENT_POSITION_FOLLOWING)));
 await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await p.screenshot({path:new URL('../test-results/bag-print-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});assert.deepEqual(p.errors,[]);
});

test('each generated bag has its own queue print action and errors stay next to the active bag',async t=>{
 const p=await open(t,'',true);await p.evaluate(()=>{
  dashboard.attempts.push({...dashboard.attempts[0],id:'other',lot_id:'other-lot',listing_title:'#002 - Other sale',buyer:'other-winner',claimed_by:'other-worker'});
  mockLots.push({id:'other-lot',session_id:'show',lot_code:'LIVE-OTHER',auction_number:'EB-OTHER'});
 });await p.locator('#ebay-live-refresh').click();await p.locator('#ebay-back-to-queue').click();
 await p.locator('[data-attempt="other"] [data-action=print]').click();await p.waitForFunction(()=>calls.some(c=>c.name==='print'));
 const xml=await p.evaluate(()=>calls.find(c=>c.name==='print').xml);assert.match(xml,/LIVE-OTHER/);assert.match(xml,/OTHER-WINNER/);assert.doesNotMatch(xml,/LIVE-TEST/);
 assert.equal(await p.evaluate(()=>ebayLive.current().id),'sale');assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='close_ebay_live_bag')),false);
 await p.locator('#ebay-return-to-bag').click();await p.evaluate(()=>{printStations.printLabel=async()=>{throw Error('Choose a label roll before sending');};});
 await p.locator('#ebay-print-scan').click();await p.waitForFunction(()=>document.getElementById('ebay-print-scan-status').textContent.includes('Choose a label roll'));
 assert.equal(await p.locator('#ebay-print-scan').isEnabled(),true);assert.deepEqual(p.errors,[]);
});

test('print rechecks payment and does not send a cancelled bag or allow repeated taps',async t=>{
 const p=await open(t,'',true);
 await p.evaluate(()=>{auctionsBeforePrint=structuredClone(dashboard.attempts);dashboard.attempts[0].payment_state='failed';});
 await p.locator('#ebay-print-scan').click();await p.waitForFunction(()=>document.getElementById('ebay-print-scan-status').textContent.includes('check payment'));
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='print')),false);assert.equal(await p.locator('#ebay-print-scan').isDisabled(),true);
 await p.evaluate(()=>{dashboard.attempts=auctionsBeforePrint;});await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>!document.getElementById('ebay-print-scan').disabled);
 await p.evaluate(()=>{printStations.printLabel=async()=>{calls.push({name:'print'});return new Promise(resolve=>window.finishPrint=()=>resolve({mode:'remote-queue',stationName:'Test printer'}));};});
 await p.locator('#ebay-print-scan').click();await p.waitForFunction(()=>!!window.finishPrint);assert.equal(await p.locator('#ebay-print-scan').isDisabled(),true);
 await p.evaluate(()=>document.getElementById('ebay-print-scan').click());assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='print').length),1);
 await p.evaluate(()=>finishPrint());await p.waitForFunction(()=>!document.getElementById('ebay-print-scan').disabled);assert.deepEqual(p.errors,[]);
});


test('save a show draft, start the next show, then restore the original bag and totals',async t=>{
 const p=await open(t,'',true);
 await p.evaluate(async()=>{
  showSessions=[showSession];dashboardByShow={show:structuredClone(dashboard)};
  mockManualItems=[{id:'saved-manual',lot_id:'lot',session_id:'show',item_category:'Watch',item_description:'First show watch',quantity:1,live_unit_minimum:70,photo_path:'live-manual/saved.jpg',status:'reserved'}];
  dashboardByShow.show.attempts[0].minimum_total=70;dashboardByShow.show.attempts[0].units=1;
  await loadLotItems();
 });
 await p.locator('#show-draft-save').click();await p.locator('#show-drafts-dialog').waitFor();
 assert.match(await p.locator('#show-draft-list').innerText(),/Draft · finish later/);
 assert.equal(await p.evaluate(()=>showSessions[0].status),'active');assert.equal(await p.evaluate(()=>mockManualItems[0].status),'reserved');
 assert.equal(await p.evaluate(()=>calls.some(c=>['end_live_sale_session','complete_ebay_live_session','cancel_live_sale_lot'].includes(c.name))),false);
 await p.locator('#show-list-new').click();assert.equal(await p.locator('#session-setup-panel').isVisible(),true);assert.equal(await p.locator('#session-ebay-url').inputValue(),'');
 assert.equal(await p.locator('#session-store-select').isVisible(),false);await p.locator('#session-primary-seller').selectOption('next-seller');await p.locator('#session-ebay-url').fill('https://www.ebay.com/ebaylive/host/events/SECOND123');await p.locator('#session-title').fill('Second show today');await p.locator('#start-session').click();
 await p.waitForFunction(()=>document.getElementById('show-current-name').textContent.includes('Second show today'));
 assert.match(await p.locator('#ebay-live-event').innerText(),/SECOND123/);assert.equal(await p.evaluate(()=>showSessions.length),2);
 await p.locator('#show-drafts-open').click();await p.locator('[data-resume-show="show"]').click();await p.waitForFunction(()=>document.getElementById('ebay-live-event').textContent.includes('EVENT123')&&!document.getElementById('item-scan').disabled);
 assert.equal(await p.evaluate(()=>ebayLive.current().lot_id),'lot');assert.match(await p.locator('#lot-manifest').innerText(),/First show watch/);assert.match(await p.locator('#ebay-running-total').innerText(),/30.00/);
 assert.equal(await p.evaluate(()=>showSessions[0].saved_for_later_at),null);assert.ok(await p.evaluate(()=>showSessions[1].saved_for_later_at));assert.equal(await p.evaluate(()=>mockManualItems[0].photo_path),'live-manual/saved.jpg');assert.deepEqual(p.errors,[]);
});

test('draft save failure and unsaved manual input keep the current show intact',async t=>{
 const p=await open(t,'',true);await p.evaluate(()=>failDraft=true);await p.locator('#show-draft-save').click();await p.waitForFunction(()=>document.getElementById('show-draft-status').textContent.includes('Draft save interrupted'));
 assert.equal(await p.evaluate(()=>ebayLive.current().lot_id),'lot');assert.equal(await p.locator('#show-drafts-dialog').isVisible(),false);
 await p.evaluate(()=>failDraft=false);await p.locator('.manual-live-item-box > summary').click();await p.locator('#manual-live-item-description').fill('Not yet added');await p.locator('#show-draft-save').click();
 assert.match(await p.locator('#show-draft-status').innerText(),/Add your manual item/);assert.equal(await p.locator('#manual-live-item-description').inputValue(),'Not yet added');assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='set_live_sale_session_draft').length),1);
});

test('drafts are loaded from the account on another device and fit small phone screens',async t=>{
 const p=await open(t,'',false,true);await p.locator('#show-drafts-open').click();await p.waitForFunction(()=>document.querySelectorAll('[data-resume-show]').length===26);
 assert.equal(await p.locator('#show-draft-save').isVisible(),false);assert.match(await p.locator('#show-draft-list').innerText(),/Earlier show 24/);
 await p.setViewportSize({width:320,height:740});assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await mkdir(new URL('../test-results',import.meta.url),{recursive:true});await p.screenshot({path:new URL('../test-results/show-drafts-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});assert.deepEqual(p.errors,[]);
});

test('capture routes a saved show by event while another show is selected, never to the selected show',async t=>{
 const p=await open(t,'?capture=1');await p.evaluate(()=>{
  dashboardByShow={show:dashboard,older:{connection:{event_id:'OLDER123',session_id:'older-show'},attempts:[],unmatched:[]}};
  acks=[];window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_LIVE_ACK')acks.push(e.data);});
  window.postMessage({type:'INVSTO_LIVE_BATCH',id:'old',payload:{event_id:'OLDER123',events:[{key:'late-failure',kind:'failed'}],health:{}}},location.origin);
 });await p.waitForFunction(()=>acks.length===1);assert.equal(await p.evaluate(()=>acks[0].ok),true);
 assert.equal(await p.evaluate(()=>calls.find(c=>c.name==='ingest_ebay_live_events').args._event_id),'OLDER123');assert.match(await p.locator('#ebay-live-event').innerText(),/EVENT123/);
 await p.evaluate(()=>window.postMessage({type:'INVSTO_LIVE_BATCH',id:'unknown',payload:{event_id:'UNKNOWN123',events:[],health:{}}},location.origin));await p.waitForFunction(()=>acks.length===2);assert.equal(await p.evaluate(()=>acks[1].ok),false);assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='ingest_ebay_live_events').length),1);
});

test('capture waits before the first sale and automatically moves from disabled Sold to the first paid auction',async t=>{
 const p=await browser.newPage();t.after(()=>p.close());await p.goto(origin+'/ebaylive/host/events/EVENT123');
 await p.setContent('<button role="tab" aria-selected="true">Activity</button><button role="tab" aria-selected="true" id="all-listings">All (57)</button><button role="tab" aria-selected="false" id="sold-listings" disabled>Sold</button><span id="metric-elapsed-time-value">00:25:42</span><div id="listings"></div><div id="activity-panel"><div aria-label="Filter activity"><button aria-pressed="true">All</button></div><p>No activity found</p></div>');
 await p.evaluate(()=>{
  window.packets=[];window.disabledClicks=0;window.chrome={runtime:{sendMessage:async m=>{if(m.type==='INVSTO_CAPTURE')packets.push(m);return {ok:true,status:'Connected · 0 pending'}}}};
  document.getElementById('sold-listings').onclick=e=>{if(e.currentTarget.disabled)disabledClicks++;else{e.currentTarget.setAttribute('aria-selected','true');document.getElementById('all-listings').setAttribute('aria-selected','false');}};
 });
 await streamFixture(p);for(const name of ['parser','capture'])await p.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await p.getByRole('button',{name:'Start Invsto capture',exact:true}).click();await p.waitForFunction(()=>packets.length);
 assert.equal(await p.evaluate(()=>packets.at(-1).health.ready),true);assert.match(await p.evaluate(()=>packets.at(-1).health.message),/waiting for the first sale/);assert.equal(await p.evaluate(()=>packets.at(-1).events.length),0);assert.equal(await p.evaluate(()=>disabledClicks),0);
 await p.evaluate(({listing,activity})=>{document.getElementById('sold-listings').disabled=false;document.getElementById('listings').innerHTML=listing;document.getElementById('activity-panel').insertAdjacentHTML('beforeend',activity);},{listing:tile(),activity:row()});
 await p.waitForFunction(()=>packets.at(-1).health.ready&&packets.at(-1).events.some(e=>e.kind==='paid'));
 assert.equal(await p.locator('#sold-listings').getAttribute('aria-selected'),'true');assert.match(await p.evaluate(()=>packets.at(-1).health.message),/Reading Activity and Sold/);
 await p.locator('#sold-listings').evaluate(el=>el.remove());await p.waitForFunction(()=>!packets.at(-1).health.ready);assert.match(await p.evaluate(()=>packets.at(-1).health.message),/Waiting for the Sold or All listings panel/);
});

test('refresh never carries the previous show bag into another unfinished show',async t=>{
 const p=await open(t,'',true);await p.evaluate(()=>{
  const next={...showSession,id:'other',title:'Other show'};
  showSession.status='ended';showSessions=[showSession,next];
  dashboardByShow={show:dashboard,other:{connection:{...dashboard.connection,event_id:'OTHER123',session_id:'other'},attempts:[],unmatched:[]}};
 });await p.setViewportSize({width:1280,height:900});await p.locator('#refresh-live-sales').click();
 await p.waitForFunction(()=>document.getElementById('show-current-name').textContent.includes('Other show'));
 assert.equal(await p.evaluate(()=>ebayLive.current()?.lot_id||null),null);assert.equal(await p.locator('#lot-manifest [data-item-id]').count(),0);assert.deepEqual(p.errors,[]);
});


test('paid auction can print its label before scanning, keep its QR on retry, and claim the same bag later',async t=>{
 const p=await open(t);await p.locator('[data-action=print]').click();await p.waitForFunction(()=>calls.some(c=>c.name==='print'));
 assert.equal(await p.evaluate(()=>dashboard.attempts[0].claimed_by||null),null);assert.equal(await p.evaluate(()=>dashboard.attempts[0].closed_at||null),null);
 assert.equal(await p.evaluate(()=>calls.some(c=>['claim_ebay_live_bag','close_ebay_live_bag','reserve_live_sale_item','save_live_sale_manual_item'].includes(c.name))),false);
 assert.match(await p.locator('#ebay-live-queue').innerText(),/Label queued for Test printer/);assert.match(await p.evaluate(()=>calls.find(c=>c.name==='print').xml),/LIVE-LABEL/);
 await p.locator('[data-action=print]').click();await p.waitForFunction(()=>calls.filter(c=>c.name==='print').length===2);assert.equal(await p.evaluate(()=>mockLots.length),1);
 await p.locator('[data-action=scan]').click();await p.waitForFunction(()=>!document.getElementById('item-scan').disabled);assert.equal(await p.evaluate(()=>ebayLive.current().lot_id),'label-sale');assert.equal(await p.evaluate(()=>mockLots.length),1);assert.deepEqual(p.errors,[]);
});

test('server payment rejection prevents an early label and leaves a retry beside the sale',async t=>{
 const p=await open(t);await p.evaluate(()=>failPrepare=true);await p.locator('[data-action=print]').click();await p.waitForFunction(()=>document.getElementById('ebay-live-queue').textContent.includes('Payment is not confirmed'));
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='print')),false);assert.equal(await p.evaluate(()=>mockLots.length),0);assert.equal(await p.locator('[data-action=print]').isEnabled(),true);
 await p.evaluate(()=>{failPrepare=false;dashboard.attempts[0].payment_state='failed';});await p.locator('#ebay-live-refresh').click();await p.locator('#ebay-live-filter').selectOption('attention');assert.equal(await p.locator('[data-action=print]').count(),0);assert.deepEqual(p.errors,[]);
});


test('stock-to-auction intake fits the existing phone screen and keeps scanner focus out of its fields',async t=>{
 const p=await open(t);await p.locator('#live-intake > summary').click();
 await p.locator('#live-intake-barcode').fill('OG123');
 assert.equal(await p.evaluate(()=>shouldReturnFocusToScanner()),false);
 assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await p.locator('#live-intake').scrollIntoViewIfNeeded();
 await p.screenshot({path:new URL('../test-results/live-intake-integrated-phone.png',import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 assert.deepEqual(p.errors,[]);
});

test('capture leaves dialogs and item helper still, supports manual hold, and resumes only when free',async t=>{
 const p=await browser.newPage();t.after(()=>p.close());await p.goto(origin+'/ebaylive/host/events/EVENT123');
 await p.setContent('<button role="tab" aria-selected="false">Activity</button><button role="tab" aria-selected="false">Sold (1)</button><div id="activity-panel"><div aria-label="Filter activity"><button aria-pressed="true">All</button></div><div class="_list_" style="height:80px;overflow:auto"><div style="height:900px">'+row()+'</div></div></div>'+tile()+'<div role="dialog">Add listings</div>');
 await p.evaluate(()=>{window.packets=[];window.clicks=0;window.fakeNow=Date.now();Date.now=()=>fakeNow;document.querySelectorAll('[role=tab]').forEach(el=>el.onclick=()=>{clicks++;el.setAttribute('aria-selected','true');});document.querySelector('._list_').scrollTop=45;window.chrome={runtime:{sendMessage:async m=>{if(m.type==='INVSTO_CAPTURE')packets.push(m);return {ok:true,status:'Connected'}}}};});
 await streamFixture(p);for(const name of ['parser','capture'])await p.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await p.getByRole('button',{name:'Start Invsto capture',exact:true}).click();assert.equal(await p.evaluate(()=>packets.length),0);assert.match(await p.locator('#invsto-capture-helper').innerText(),/Finish editing/);
 await p.evaluate(()=>document.querySelector('[role=dialog]').remove());await p.getByRole('button',{name:'Start Invsto capture',exact:true}).click();await p.waitForFunction(()=>packets.length>0);
 await p.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<div role="dialog">Add listings</div>');clicks=0;document.querySelectorAll('[role=tab]').forEach(el=>{if(/^(Activity|Sold)/.test(el.textContent))el.setAttribute('aria-selected','false');});document.querySelector('._list_').scrollTop=45;});await p.waitForFunction(()=>packets.at(-1).health.mode==='working');
 assert.equal(await p.evaluate(()=>packets.at(-1).health.mode),'working');assert.equal(await p.evaluate(()=>packets.at(-1).health.ready),false);assert.equal(await p.evaluate(()=>clicks),0);assert.equal(await p.locator('._list_').evaluate(e=>e.scrollTop),45);assert.ok(await p.evaluate(()=>packets[0].events.some(e=>e.kind==='paid')));
 await p.evaluate(()=>{document.querySelector('[role=dialog]').remove();const d=document.createElement('details');d.id='invsto-listing-helper';d.open=true;document.body.append(d);fakeNow+=16000;});
 await p.getByRole('button',{name:'Keep page still',exact:true}).click();assert.equal(await p.evaluate(()=>clicks),0);
 await p.evaluate(()=>document.getElementById('invsto-listing-helper').remove());await p.getByRole('button',{name:'Resume automatic capture',exact:true}).click();await p.waitForFunction(()=>packets.at(-1).health.ready);
 assert.ok(await p.evaluate(()=>clicks>=2));assert.equal(await p.evaluate(()=>packets.at(-1).health.mode),'automatic');
 assert.match(await p.getByRole('link',{name:'Open Invsto receiver',exact:true}).getAttribute('href'),/capture=1/);
 await p.evaluate(()=>{const i=document.createElement('input');i.id='working-input';document.body.append(i);});await p.locator('#working-input').fill('editing an auction');await p.waitForFunction(()=>packets.at(-1).health.mode==='working');
 const count=await p.evaluate(()=>clicks);await p.evaluate(()=>fakeNow+=16000);await p.waitForFunction(()=>packets.at(-1).health.ready===false);assert.equal(await p.evaluate(()=>clicks),count);
});

test('working and stopped tabs cannot replace a fresh dedicated capture; quiet receivers stay reachable',async()=>{
 const source=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');let now=Date.now(),stored={capture:{events:{},health:{},receivers:{9:now-120000}}},handler,deliveries=[];
 class Clock extends Date{static now(){return now;}}
 const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>Object.assign(stored,structuredClone(v))}},runtime:{id:'extension',onMessage:{addListener:fn=>handler=fn}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{sendMessage:async(tab,msg)=>{deliveries.push(msg);return {ok:true,job:null}}}};
 vm.runInNewContext(source,{chrome,URL,Date:Clock,Promise,Error,Object,Number,String});
 const send=(id,health)=>new Promise(r=>handler({type:'INVSTO_CAPTURE',event_id:'EVENT123',events:[],health},{id:'extension',tab:{id,url:'https://www.ebay.com/ebaylive/host/events/EVENT123'}},r));
 await send(1,{ready:true,running:true,mode:'automatic'});assert.equal(deliveries.at(-1).payload.health.ready,true,'throttled receiver still receives data');
 now+=1000;await send(2,{ready:false,running:true,mode:'working'});assert.equal(deliveries.at(-1).payload.health.ready,true,'working tab cannot pause healthy capture');
 await send(2,{ready:false,running:false,mode:'automatic'});assert.equal(deliveries.at(-1).payload.health.ready,true,'stopped second tab cannot pause first');
 now+=21000;await send(2,{ready:false,running:true,mode:'working'});assert.equal(deliveries.at(-1).payload.health.ready,false,'stale dedicated tab cannot retain ready state');
 await send(1,{ready:true,running:true,mode:'automatic'});assert.equal(deliveries.at(-1).payload.health.ready,true);
 await send(1,{ready:false,running:false,mode:'automatic'});assert.equal(deliveries.at(-1).payload.health.ready,false,'stopping the only dedicated capture takes effect');
 const result=await new Promise(r=>handler({type:'INVSTO_LISTING_COMMAND',command:{event_id:'EVENT123',action:'next'}},{id:'extension',tab:{id:2,url:'https://www.ebay.com/ebaylive/host/events/EVENT123'}},r));assert.equal(result.ok,true,'listing preparation also reaches the quiet receiver');
 await send(1,{ready:false,running:true,mode:'automatic',broadcast_ended:true});await send(2,{ready:true,running:true,mode:'automatic'});assert.equal(deliveries.at(-1).payload.health.broadcast_ended,true);assert.equal(deliveries.at(-1).payload.health.ready,false,'another tab cannot undo explicit end evidence');
});


test('capture supplies its event and asks only for sellers before creating the show',async t=>{
 const p=await open(t,'?capture=1&capture_event=NEXTSHOW123'+streamQuery);
 await p.locator('#capture-main-seller:enabled').waitFor();
 assert.equal(await p.locator('#live-capture-setup').isVisible(),true);
 assert.match(await p.locator('#capture-setup-event').textContent(),/Original eBay show/);
 assert.equal(await p.locator('#live-capture-setup input[type=url]').count(),0);
 assert.equal(await p.locator('#capture-main-seller').inputValue(),'');
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='start_ebay_live_capture_from_stream')),false);
 await p.locator('#capture-main-seller').selectOption('seller');
 await p.locator('#capture-additional summary').click();
 assert.equal(await p.locator('[name=capture-co-seller][value=seller]').isDisabled(),true);
 await p.locator('[name=capture-co-seller][value=next-seller]').check();
 await p.screenshot({path:'test-results/live-capture-sellers.png'});
 await p.locator('#capture-start-show').click();
 await p.locator('#live-capture-setup').waitFor({state:'hidden'});
 const args=await p.evaluate(()=>calls.find(c=>c.name==='start_ebay_live_capture_from_stream').args);
 assert.deepEqual(args,{_event_id:'NEXTSHOW123',_primary_seller_employee_id:'seller',_co_seller_employee_ids:['next-seller'],_stream:historyStream});
 assert.equal(await p.evaluate(()=>state.currentSession.store_id),null);
 assert.equal(await p.evaluate(()=>state.currentSession.id),'newshow');
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='create_live_sale_lot')),false);
 assert.deepEqual(p.errors,[]);
});

test('capture reconnects to an existing show without asking again or changing its sellers',async t=>{
 const p=await open(t,'?capture=1&capture_event=EVENT123');
 await p.locator('#live-capture-setup').waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>state.currentSession.id),'show');
 assert.equal(await p.evaluate(()=>calls.some(c=>/^start_/.test(c.name))),false);
 assert.equal(await p.evaluate(()=>calls.some(c=>c.name==='set_ebay_live_seller')),false);
 assert.deepEqual(p.errors,[]);
});

test('failed capture setup retains seller selection and ignores repeated setup requests',async t=>{
 const p=await open(t,'?capture=1&capture_event=NEXTSHOW123'+streamQuery);
 await p.locator('#capture-main-seller:enabled').waitFor();
 await p.locator('#capture-main-seller').selectOption('next-seller');
 await p.evaluate(()=>{failCaptureStart=true;window.postMessage({type:'INVSTO_CAPTURE_SETUP',event_id:'NEXTSHOW123'},location.origin);});
 assert.equal(await p.locator('#capture-main-seller').inputValue(),'next-seller');
 await p.locator('#capture-start-show').click();
 await p.waitForFunction(()=>document.querySelector('#capture-setup-status').textContent.includes('Connection interrupted'));
 assert.equal(await p.locator('#capture-main-seller').inputValue(),'next-seller');
 await p.evaluate(()=>{failCaptureStart=false;});
 await p.locator('#capture-start-show').click();await p.locator('#live-capture-setup').waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>state.currentSession.primary_seller_employee_id),'next-seller');
 assert.deepEqual(p.errors,[]);
});

test('extension opens setup for the exact source event once and returns to the capture tab',async()=>{
 const source=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');
 let stored={},handler,created=[],updated=[],alive=true;
 const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>{stored=structuredClone(v)}}},runtime:{id:'extension',onMessage:{addListener:fn=>{handler=fn}}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{create:async opts=>{created.push(opts);return {id:9};},update:async(id,opts)=>{updated.push({id,...opts});},sendMessage:async()=>({ok:alive})}};
 vm.runInNewContext(source,{chrome,URL,Date,Promise,Error,Object,Number,String,encodeURIComponent});
 const send=(message,url,id=1)=>new Promise(resolve=>handler(message,{id:'extension',tab:{id,url}},resolve));
 const url='https://www.ebay.com/ebaylive/host/events/EVENT123?tab=dashboard';
 assert.equal((await send({type:'INVSTO_START_CAPTURE',event_id:'WRONG123'},url)).ok,false);assert.equal(created.length,0);
 await Promise.all([send({type:'INVSTO_START_CAPTURE',event_id:'EVENT123'},url),send({type:'INVSTO_START_CAPTURE',event_id:'EVENT123'},url)]);
 assert.equal(created.length,1);assert.equal(new URL(created[0].url).searchParams.get('capture_event'),'EVENT123');
 assert.equal(created[0].active,true);assert.equal(updated.at(-1).id,9);
 await send({type:'INVSTO_CAPTURE_CONNECTED',event_id:'EVENT123'},created[0].url,9);
 assert.equal(updated.at(-1).id,1);
 alive=false;await send({type:'INVSTO_START_CAPTURE',event_id:'EVENT123'},url);assert.equal(created.length,2);
});


test('capture setup rejects invalid events, leaves closed shows closed and prevents double submission',async t=>{
 const p=await open(t,'?capture=1');
 await p.evaluate(()=>liveCaptureSetup.request('bad'));
 assert.equal(await p.locator('#live-capture-setup').count(),0);
 await p.evaluate(()=>{showSession.status='ended';});
 await p.evaluate(()=>liveCaptureSetup.request('EVENT123'));
 assert.match(await p.locator('#capture-setup-status').textContent(),/already closed/);
 assert.equal(await p.evaluate(()=>calls.some(c=>/^start_/.test(c.name))),false);
 await p.locator('#capture-setup-cancel').click();
 await p.evaluate(metadata=>liveCaptureSetup.request('NEXT1234',metadata),historyStream);
 await p.locator('#capture-main-seller').selectOption('seller');
 await p.evaluate(()=>{const original=supabase.rpc;supabase.rpc=async(name,args)=>{if(name==='start_ebay_live_capture_from_stream')await new Promise(r=>setTimeout(r,250));return original(name,args);};});
 await p.locator('#capture-start-show').click();
 assert.equal(await p.locator('#capture-start-show').isDisabled(),true);
 await p.evaluate(()=>{liveCaptureSetup.request('OTHER1234');document.querySelector('#capture-seller-form').dispatchEvent(new Event('submit',{cancelable:true}));});
 assert.match(await p.locator('#capture-setup-event').textContent(),/Original eBay show/);
 await p.locator('#live-capture-setup').waitFor({state:'hidden'});
 assert.equal(await p.evaluate(()=>calls.filter(c=>c.name==='start_ebay_live_capture_from_stream').length),1);
 assert.deepEqual(p.errors,[]);
});

test('signed-out capture keeps its receiver open while offering sign-in in another tab',async t=>{
 const p=await open(t,'?capture=1');
 await p.evaluate(async()=>{supabase.auth.getSession=async()=>({data:{session:null}});await loadCurrentWorker();});
 assert.equal(await p.getByRole('heading',{name:'Sign in to start capture'}).isVisible(),true);
 assert.match(p.url(),/live-sales.html\?capture=1/);
 assert.equal(await p.locator('#live-capture-setup a').getAttribute('href'),'index.html');
 assert.equal(await p.locator('#live-capture-setup a').getAttribute('target'),'_blank');
 assert.equal(await p.evaluate(()=>calls.some(c=>/^start_/.test(c.name))),false);
 assert.deepEqual(p.errors,[]);
});

test('capture reads saved Event information before seller setup, ignores hidden dialogs and never updates eBay',async t=>{
 const p=await browser.newPage();t.after(()=>p.close());await p.goto(origin+'/ebaylive/host/events/EVENT123?invsto_metadata=reader-test');
 await p.setContent('<button role="tab" id="manager" aria-selected="true">Stream manager</button><button role="tab" id="info" aria-selected="false">Event information</button><div role="dialog" hidden>Chat settings</div><div id="fields"></div>');
 await p.evaluate(()=>{
  window.messages=[];window.updated=false;window.chrome={runtime:{sendMessage:async m=>{messages.push(m);return {ok:true}}}};
  document.getElementById('info').onclick=()=>{document.getElementById('info').setAttribute('aria-selected','true');document.getElementById('manager').setAttribute('aria-selected','false');document.getElementById('fields').innerHTML='<input id="startDate" type="datetime-local" value="2026-08-23T23:30"><input id="timezone" value="EDT"><input id="title" value="Old show"><button id="update">Update</button>';document.getElementById('update').onclick=()=>updated=true;};
  document.getElementById('manager').onclick=()=>{document.getElementById('manager').setAttribute('aria-selected','true');document.getElementById('info').setAttribute('aria-selected','false');document.getElementById('fields').replaceChildren();};
 });
 for(const name of ['parser','capture'])await p.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await p.waitForFunction(()=>messages.some(m=>m.type==='INVSTO_STREAM_METADATA'));
 const result=await p.evaluate(()=>messages.find(m=>m.type==='INVSTO_STREAM_METADATA'));
 assert.equal(result.stream.start_local,'2026-08-23T23:30');assert.equal(result.stream.timezone_label,'EDT');assert.equal(result.stream.source,'ebay_event_information');assert.equal(await p.evaluate(()=>updated),false);assert.equal(await p.locator('#info').getAttribute('aria-selected'),'true');
 assert.equal(await p.evaluate(()=>messages.some(m=>m.type==='INVSTO_CAPTURE')),false);assert.equal(await p.locator('#invsto-capture-helper').count(),0);
});

test('capture refuses unsaved event changes and missing original dates',async t=>{
 const p=await browser.newPage();t.after(()=>p.close());await p.goto(origin+'/ebaylive/host/events/EVENT123');await p.setContent('');await streamFixture(p);
 await p.evaluate(()=>{document.querySelector('#startDate').parentElement.hidden=false;window.messages=[];window.chrome={runtime:{sendMessage:async m=>{messages.push(m);return {ok:true,stream:{source:'ebay_event_information',start_local:'2026-09-30T14:05',timezone_label:'EDT',title:'Original eBay show',activity_timezone:'America/New_York'}}}}};});
 for(const name of ['parser','capture'])await p.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});
 await p.locator('#title').fill('Unsaved title');await p.getByRole('button',{name:'Start Invsto capture',exact:true}).click();assert.match(await p.locator('#invsto-capture-helper').innerText(),/Save your Event information/);assert.equal(await p.evaluate(()=>messages.filter(m=>m.type!=="INVSTO_RESUME_CAPTURE").length),0);
 const q=await open(t,'?capture=1&capture_event=NO_DATE123');await q.locator('#capture-main-seller:enabled').waitFor();await q.locator('#capture-main-seller').selectOption('seller');await q.locator('#capture-start-show').click();assert.match(await q.locator('#capture-setup-status').innerText(),/original show date/);assert.equal(await q.evaluate(()=>calls.some(c=>c.name.startsWith('start_'))),false);
});

test('sale chronology and displayed dates use eBay times instead of recovery dates',async t=>{
 const p=await open(t);await p.evaluate(metadata=>{
  dashboard.connection.stream_start_at='2026-08-24T03:30:00Z';dashboard.connection.stream_metadata=metadata;
  const a=dashboard.attempts[0];Object.assign(a,{sold_at:'2026-08-24T04:15:00Z',sale_time_source:'ebay_activity',sale_time_precision:'minute',win_time_label:'12:15 AM',created_at:'2026-09-30T20:00:00Z'});
  dashboard.attempts.push({...a,id:'later',listing_title:'#002 - Later sale',sold_at:'2026-08-24T04:20:00Z',created_at:'2026-09-30T19:00:00Z'});
 },historyStream);await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.querySelector('[data-attempt]')?.dataset.attempt==='later');
 assert.match(await p.locator('[data-attempt=sale] small').first().innerText(),/Aug 24, 2026.*12:15 AM EDT.*minute precision/);assert.doesNotMatch(await p.locator('[data-attempt=sale] small').first().innerText(),/Sep 30/);assert.deepEqual(p.errors,[]);
});

test('selected seller corrections on a phone survive errors and update only selected sales',async t=>{
 const p=await open(t);await p.evaluate(()=>{dashboard.attempts.push({...dashboard.attempts[0],id:'sale-2',listing_title:'#002 - Another sale'},{...dashboard.attempts[0],id:'sale-3',listing_title:'#003 - Untouched sale'});});await p.locator('#ebay-live-refresh').click();await p.locator('[data-seller-select=sale-2]').waitFor();
 await p.locator('[data-seller-select=sale]').check();await p.locator('[data-seller-select=sale-2]').check();await p.locator('#ebay-change-selected-seller').click();
 await p.locator('#ebay-selected-seller').selectOption('next-seller');await p.locator('#ebay-selected-seller-reason').fill('Sydney sold these two historical bags.');assert.equal(await p.evaluate(()=>shouldReturnFocusToScanner()),false);
 await p.evaluate(()=>failSellerCorrection=true);await p.locator('#ebay-selected-seller-save').click();await p.waitForFunction(()=>document.getElementById('ebay-selected-seller-error').textContent.includes('interrupted'));
 assert.equal(await p.locator('#ebay-selected-seller').inputValue(),'next-seller');await p.screenshot({path:'test-results/live-selected-seller-phone.png'});
 await p.evaluate(()=>failSellerCorrection=false);await p.locator('#ebay-selected-seller-save').click();await p.locator('#ebay-selected-seller-dialog').waitFor({state:'hidden'});
 assert.deepEqual(await p.evaluate(()=>dashboard.attempts.map(a=>a.seller_id)),['next-seller','next-seller','seller']);assert.equal(await p.evaluate(()=>dashboard.connection.active_seller_id),'seller');assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));assert.deepEqual(p.errors,[]);
 await p.locator('[data-attempt=sale-3] [data-action=seller]').click();assert.match(await p.locator('#ebay-selected-seller-summary').innerText(),/1 selected sale/);await p.locator('#ebay-selected-seller-cancel').click();
});

test('background date lookup keeps broadcasting tab and payment capture available, then closes only its reader',async()=>{
 const source=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');let handler,stored={},created=[],removed=[];
 const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>{stored=structuredClone(v)}}},runtime:{id:'extension',onMessage:{addListener:fn=>{handler=fn}}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{create:async opts=>{created.push(opts);return {id:40}},remove:async id=>removed.push(id)}};
 vm.runInNewContext(source,{chrome,crypto:{randomUUID:()=> 'metadata-task'},setTimeout,clearTimeout,URL,Date,Promise,Error,Object,Number,String,encodeURIComponent});
 const send=(message,url,id=1)=>new Promise(resolve=>handler(message,{id:'extension',tab:{id,url}},resolve));
 const url='https://www.ebay.com/ebaylive/host/events/EVENT123?tab=dashboard';
 const reading=send({type:'INVSTO_READ_STREAM',event_id:'EVENT123'},url);
 assert.equal((await send({type:'INVSTO_CAPTURE',event_id:'EVENT123',events:[{key:'win'}],health:{ready:true}},url)).ok,true);
 assert.equal(created.length,1);assert.equal(created[0].active,false);assert.equal(new URL(created[0].url).searchParams.get('tab'),'information');assert.equal(Object.keys(stored.capture.events).length,1);
 assert.equal((await send({type:'INVSTO_STREAM_METADATA',event_id:'WRONG123',task:'metadata-task',stream:historyStream},created[0].url,40)).ok,false);
 assert.equal((await send({type:'INVSTO_STREAM_METADATA',event_id:'EVENT123',task:'metadata-task',stream:historyStream},url,40)).ok,true);
 assert.deepEqual((await reading).stream,historyStream);assert.deepEqual(removed,[40]);
});

test('history recovery reads every settled viewport twice and separates listings from rerun attempts',async t=>{
 const p=await parser(t,'<button role="tab" aria-selected="true">Sold (3)</button><div class="_list_tiles" id="sold"></div><div id="activity-panel"><div class="_list_activity" id="activity"></div></div>');
 const result=await p.evaluate(()=>{
  const nodes=[document.getElementById('sold'),document.getElementById('activity')];
  for(const node of nodes){Object.defineProperty(node,'clientHeight',{value:100});Object.defineProperty(node,'scrollHeight',{value:300,configurable:true});let top=0;Object.defineProperty(node,'scrollTop',{get:()=>top,set:v=>{top=v;},configurable:true});}
  const seen=new Set(),tracker=InvstoLiveParser.createHistoryTracker('12345678-1234-1234-1234-123456789012');let now=10000,cache={},status;
  const sample=()=>{
   const slot=Math.min(2,Math.floor(nodes[0].scrollTop/100));seen.add(slot);
   nodes[0].innerHTML=`<div data-testid="listing-tile"><input data-testid="checkbox-${123456789012+slot}"></div>`;
   const index=Math.min(2,Math.floor(nodes[1].scrollTop/100));
   const events=[{key:'win-'+index,kind:'won',source:'activity',listing_id:String(123456789012+index),buyer:'buyer',amount:100},...(index===1?[{key:'rerun',kind:'won',source:'activity',listing_id:'123456789013',buyer:'other',amount:120}]:[])];
   now+=1300;return tracker.observe(document,{broadcastEnded:true,events},{canRead:true,now});
  };
  const first=sample();for(let i=0;i<90;i++)status=sample();
  const complete=structuredClone(status);for(let i=0;i<10;i++)sample();
  const paused=tracker.observe(document,{broadcastEnded:true,events:[]},{canRead:false,reason:'working',now:now+1300});
  Object.defineProperty(nodes[1],'scrollHeight',{value:400,configurable:true});const resized=sample();
  return {first,complete,paused,resized,seen:[...seen]};
 });
 assert.equal(result.first.phase,'reading');assert.equal(result.first.activity_passes,0);assert.equal(result.complete.phase,'read');assert.equal(result.complete.sold_seen,3);assert.equal(result.complete.observed_wins,4);assert.deepEqual(result.seen,[0,1,2]);assert.equal(result.paused.phase,'read');assert.equal(result.resized.phase,'reading');assert.equal(result.resized.activity_passes,0);
});

test('history recovery reports only the exact eBay Live sales metric for event scope checks',async t=>{
 const p=await parser(t,'<div id="metric-live-sales-value"><span>$6,730.00</span></div><div>Unrelated total $8,083.00</div>');
 const result=await p.evaluate(()=>{
  const tracker=InvstoLiveParser.createHistoryTracker('12345678-1234-1234-1234-123456789012');
  const read=()=>tracker.observe(document,{broadcastEnded:true,events:[]},{canRead:false}).live_sales;
  const values=[read()];document.querySelector('#metric-live-sales-value').textContent='Unavailable';values.push(read());
  document.querySelector('#metric-live-sales-value').textContent='$0.00';values.push(read());
  document.querySelector('#metric-live-sales-value').remove();values.push(read());return values;
 });
 assert.deepEqual(result,[6730,null,0,null]);
});

test('history recovery scrolls the real viewport outside a named inner list and reads all 27 sold items',async t=>{
 const p=await parser(t,'<button role="tab" aria-selected="true">Sold (27)</button><div id="sold-viewport" style="height:180px;overflow-y:auto"><div class="_list_tiles" id="sold"></div></div><div id="activity-panel"><div id="activity-viewport" style="height:120px;overflow-y:auto"><div class="_list_activity" id="activity"></div></div></div>');
 const result=await p.evaluate(()=>{
  const sold=document.getElementById('sold'),activity=document.getElementById('activity');
  sold.innerHTML=Array.from({length:27},(_,i)=>`<div data-testid="listing-tile" style="height:60px"><input data-testid="checkbox-${123456789012+i}"></div>`).join('');
  activity.innerHTML=Array.from({length:27},(_,i)=>`<div class="_rowContent_row" style="height:40px">${i}</div>`).join('');
  const containers=InvstoLiveParser.historyContainers(document),tracker=InvstoLiveParser.createHistoryTracker('12345678-1234-1234-1234-123456789012');
  const seen=new Set();let now=10000,status;
  for(let i=0;i<400;i++){
   const top=containers.listings.scrollTop;
   for(const [index,tile] of [...sold.children].entries()){
    const visible=index*60+60>top&&index*60<top+containers.listings.clientHeight;
    tile.removeAttribute('data-testid');if(visible){tile.setAttribute('data-testid','listing-tile');seen.add(index);}
   }
   status=tracker.observe(document,{broadcastEnded:true,events:[]},{canRead:true,now:now+=1300});
  }
  return {containers:{activity:containers.activity.id,listings:containers.listings.id},status,seen:[...seen]};
 });
 assert.deepEqual(result.containers,{activity:'activity-viewport',listings:'sold-viewport'});
 assert.equal(result.seen.length,27);assert.equal(result.status.sold_seen,27);assert.equal(result.status.phase,'read');
});

test('history recovery refuses missing layout and count mismatch and invalidates completion on new evidence',async t=>{
 const p=await parser(t,'<section><div role="tablist"><button role="tab" aria-selected="true">Sold (2)</button></div><div class="_list_tiles" id="sold">'+tile()+'</div></section><div id="activity-panel"><div class="_list_activity" id="activity"></div></div>');
 const result=await p.evaluate(()=>{
  for(const id of ['sold','activity'])for(const key of ['clientHeight','scrollHeight'])Object.defineProperty(document.getElementById(id),key,{value:100});
  const tracker=InvstoLiveParser.createHistoryTracker('12345678-1234-1234-1234-123456789012');let now=10000;const parsed={broadcastEnded:true,events:[{key:'first',kind:'won',source:'activity'}]};
  const step=()=>tracker.observe(document,parsed,{canRead:true,now:now+=1300});let state;for(let i=0;i<25;i++)state=step();const mismatch=state;
  document.querySelector('[role=tab]').textContent='Sold (1)';const changed=step();for(let i=0;i<25;i++)state=step();const complete=state;
  parsed.events.push({key:'late-failure',kind:'failed',source:'activity'});const late=step();
  const top=document.getElementById('activity').scrollTop;const paused=tracker.observe(document,parsed,{canRead:false,reason:'working',now:now+=1300});
  document.getElementById('activity').remove();const layout=step();
  return {mismatch,changed,complete,late,paused,layout,top};
 });
 assert.equal(result.mismatch.phase,'needs_review');assert.equal(result.mismatch.reason,'counts');assert.equal(result.changed.phase,'reading');assert.equal(result.complete.phase,'read');assert.equal(result.late.phase,'reading');assert.equal(result.late.activity_passes,0);assert.equal(result.paused.phase,'paused');assert.equal(result.layout.reason,'layout');assert.equal(result.layout.phase,'needs_review');
});

test('history recovery completes when eBay remeasures virtual card heights at every viewport',async t=>{
 const p=await parser(t,'<button role="tab" aria-selected="true">Sold (27)</button><div class="_list_tiles" id="sold"></div><div id="activity-panel"><div class="_list_activity" id="activity"></div></div>');
 const result=await p.evaluate(()=>{
  const sold=document.getElementById('sold'),activity=document.getElementById('activity');let top=0,height=4536,now=10000,state;
  Object.defineProperties(sold,{clientHeight:{value:615},scrollHeight:{get:()=>height},scrollTop:{get:()=>top,set:v=>{top=Math.max(0,Math.min(v,height-615));}}});
  Object.defineProperties(activity,{clientHeight:{value:792},scrollHeight:{value:792}});
  const tracker=InvstoLiveParser.createHistoryTracker('12345678-1234-1234-1234-123456789012'),seen=new Set();
  for(let tick=0;tick<250;tick++){
   // React-window's estimate changes when a different group of cards is mounted.
   height=4536-(Math.floor(top/350)%3)*5;
   const first=Math.floor(top/168),last=Math.min(26,Math.floor((top+615)/168));
   sold.innerHTML=Array.from({length:last-first+1},(_,i)=>{const n=first+i;seen.add(n);return `<div data-testid="listing-tile"><input data-testid="checkbox-${123456789012+n}"></div>`;}).join('');
   state=tracker.observe(document,{broadcastEnded:true,events:[]},{canRead:true,now:now+=1300});
  }
  return {state,seen:seen.size};
 });
 assert.equal(result.seen,27);assert.equal(result.state.sold_seen,27);assert.equal(result.state.listing_passes,2);assert.equal(result.state.phase,'read');
});

test('capture diagnostics expose the actual viewport without collecting private page content or moving it',async t=>{
 const p=await parser(t,'<input type="password" value="PRIVATE_PASSWORD"><input type="search" value="PRIVATE_SEARCH"><div id="sold-viewport" style="height:180px;overflow-y:auto"><div class="_list_tiles" style="height:800px">'+tile()+'</div></div><div id="activity-panel"><div class="_list_activity" style="height:100px;overflow-y:auto"><div class="_rowContent_row" style="height:500px">PRIVATE_CHAT</div></div></div><button>Next page</button><button>PRIVATE_BUTTON</button>');
 const result=await p.evaluate(()=>{
  const viewport=document.getElementById('sold-viewport');viewport.scrollTop=120;
  const diagnostics=InvstoLiveParser.captureDiagnostics(document);
  return {diagnostics,top:viewport.scrollTop};
 });
 assert.equal(result.top,120);assert.equal(result.diagnostics.search_active,true);assert.equal(result.diagnostics.activity_rows,1);
 assert.ok(result.diagnostics.listings.some(n=>n.selected&&n.top===120&&n.viewport===180&&n.height>=800));
 assert.ok(result.diagnostics.activity.some(n=>n.selected&&n.viewport===100));
 assert.equal(result.diagnostics.tile_ids.length,1);assert.deepEqual(result.diagnostics.controls,[{label:'Next page',disabled:false}]);
 assert.doesNotMatch(JSON.stringify(result.diagnostics),/PRIVATE_/);
});

async function recoveryWorker(){
 const source=await readFile(new URL('../tools/ebay-live-capture/worker.js',import.meta.url),'utf8');let stored={},handler,checkState='active',checkHook=null;const opened=[],sent=[],focused=[];
 const chrome={storage:{local:{get:async()=>structuredClone(stored),set:async v=>{stored=structuredClone(v)}}},runtime:{id:'extension',onMessage:{addListener:fn=>{handler=fn}}},alarms:{create(){},onAlarm:{addListener(){}}},tabs:{create:async v=>{opened.push(v);return {id:9};},update:async(id,v)=>{focused.push({id,...v});},sendMessage:async(id,msg)=>{sent.push({id,...msg});if(msg.type==='INVSTO_CHECK_CAPTURE'){if(checkHook)return checkHook();if(checkState==='missing')throw Error('Tab closed');return {ok:true,state:checkState};}return {ok:true};}}};
 const boot=()=>vm.runInNewContext(source,{chrome,URL,Date,Promise,Error,Object,Number,String});boot();
 const send=(message,url='https://www.ebay.com/ebaylive/host/events/EVENT123',id=1)=>new Promise(resolve=>handler(message,{id:'extension',tab:{id,url}},resolve));
 return {send,boot,opened,sent,focused,get data(){return stored.capture;},setState(v){checkState=v;},setHook(v){checkHook=v;}};
}

test('refresh resumes only the saved unfinished event without seller setup, and Stop survives worker restart',async()=>{
 const w=await recoveryWorker();await w.send({type:'INVSTO_START_CAPTURE',event_id:'EVENT123',stream:historyStream});assert.equal(w.opened.length,1);w.boot();
 const resumed=await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'});assert.equal(resumed.resume,true);assert.deepEqual(resumed.stream,historyStream);assert.equal(w.opened.length,1);assert.equal(w.focused.length,0);
 assert.equal((await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'OTHER123'},'https://www.ebay.com/ebaylive/host/events/OTHER123')).resume,false);
 assert.equal((await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'},undefined,4)).resume,false);
 await w.send({type:'INVSTO_STOP_CAPTURE',event_id:'EVENT123'});w.boot();assert.equal((await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'})).resume,false);assert.equal(w.data.captureRuns[1].enabled,false);
});

test('closed shows stop saved capture; signed-out and missing receivers never open seller setup',async()=>{
 const w=await recoveryWorker();await w.send({type:'INVSTO_START_CAPTURE',event_id:'EVENT123',stream:historyStream});
 w.setState('signed_out');assert.equal((await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'})).retry,true);assert.equal(w.opened.length,1);
 w.setState('missing');assert.equal((await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'})).retry,true);assert.equal(w.opened.length,2);assert.equal(w.opened[1].active,false);assert.match(w.opened[1].url,/resume_event=EVENT123/);assert.doesNotMatch(w.opened[1].url,/capture_event/);
 await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'});assert.equal(w.opened.length,2);
 w.setState('closed');const closed=await w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'});assert.equal(closed.closed,true);assert.equal(w.data.captureRuns[1].enabled,false);assert.equal(w.sent.at(-1).type,'INVSTO_STOP_CAPTURE');
 assert.equal((await w.send({type:'INVSTO_START_CAPTURE',event_id:'EVENT123',stream:historyStream})).closed,true);assert.equal(w.opened.length,2);
});

test('Stop racing a resume status check wins without restarting the show',async()=>{
 const w=await recoveryWorker();await w.send({type:'INVSTO_START_CAPTURE',event_id:'EVENT123',stream:historyStream});
 let release,started;const checking=new Promise(r=>{started=r;});w.setHook(()=>{started();return new Promise(r=>{release=r;});});
 const pending=w.send({type:'INVSTO_RESUME_CAPTURE',event_id:'EVENT123'});await checking;await w.send({type:'INVSTO_STOP_CAPTURE',event_id:'EVENT123'});release({ok:true,state:'active'});assert.equal((await pending).resume,false);
});

test('capture reload resumes without rereading metadata, while explicit Stop remains stopped on refresh',async t=>{
 const p=await browser.newPage();t.after(()=>p.close());await p.addInitScript(metadata=>{
  window.messages=[];window.chrome={runtime:{sendMessage:async m=>{messages.push(m);return m.type==='INVSTO_RESUME_CAPTURE'?{ok:true,resume:true,stream:metadata}:{ok:true};}}};
 },historyStream);
 const load=async()=>{await p.setContent('<button role="tab" aria-selected="true">Activity</button><button role="tab" aria-selected="true">Sold (1)</button>'+tile()+'<div id="activity-panel"><div aria-label="Filter activity"><button aria-pressed="true">All</button></div>'+row()+'</div>');for(const name of ['parser','capture'])await p.addScriptTag({path:new URL(`../tools/ebay-live-capture/${name}.js`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1')});};
 await p.goto(origin+'/ebaylive/host/events/EVENT123');await load();await p.getByRole('button',{name:'Stop Invsto capture',exact:true}).waitFor();await p.waitForFunction(()=>messages.some(m=>m.type==='INVSTO_CAPTURE'));
 assert.equal(await p.evaluate(()=>messages.some(m=>['INVSTO_START_CAPTURE','INVSTO_READ_STREAM'].includes(m.type))),false);
 await p.reload();await load();await p.getByRole('button',{name:'Stop Invsto capture',exact:true}).waitFor();
 await p.getByRole('button',{name:'Stop Invsto capture',exact:true}).click();await p.reload();await load();await p.waitForFunction(()=>messages.some(m=>m.type==='INVSTO_STOP_CAPTURE'));
 assert.equal(await p.getByRole('button',{name:'Start Invsto capture',exact:true}).count(),1);assert.equal(await p.evaluate(()=>messages.some(m=>['INVSTO_RESUME_CAPTURE','INVSTO_START_CAPTURE','INVSTO_CAPTURE'].includes(m.type))),false);
});

test('receiver resume checks existing shows without opening seller setup or changing sellers',async t=>{
 const p=await open(t,'?capture=1&resume_event=EVENT123');assert.equal(await p.locator('#live-capture-setup[open]').count(),0);
 await p.evaluate(()=>{window.captureChecks=[];window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_CAPTURE_CHECK_RESULT')captureChecks.push(e.data);});});
 const check=async(id,event_id='EVENT123')=>{await p.evaluate(({id,event_id})=>window.postMessage({type:'INVSTO_CAPTURE_CHECK',id,event_id},location.origin),{id,event_id});await p.waitForFunction(id=>captureChecks.some(c=>c.id===id),id);return p.evaluate(id=>captureChecks.find(c=>c.id===id).state,id);};
 assert.equal(await check('active'),'active');assert.equal(await check('unlinked','MISSING123'),'unlinked');await p.evaluate(()=>showSession.status='ended');assert.equal(await check('closed'),'closed');await p.evaluate(()=>supabase.auth.getSession=async()=>({data:{session:null}}));assert.equal(await check('signedout'),'signed_out');
 assert.equal(await p.evaluate(()=>calls.some(c=>/start_ebay_live|set_ebay_live_seller|apply_ebay_live_stream_metadata/.test(c.name))),false);assert.equal(await p.evaluate(()=>dashboard.connection.active_seller_id),'seller');
});

test('finished capture checks official orders automatically without delaying the save acknowledgement',async t=>{
 const p=await open(t,'?capture=1');await p.evaluate(()=>{
  window.orderCalls=[];window.acks=[];window.completeCheck=null;
  supabase.functions={invoke:async(name,args)=>{orderCalls.push({name,args});return new Promise(resolve=>completeCheck=()=>resolve({data:{ok:true,orderCheck:{state:'complete'}}}));}};
  window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_LIVE_ACK')acks.push(e.data);});
  for(const id of ['one','two'])window.postMessage({type:'INVSTO_LIVE_BATCH',id,payload:{event_id:'EVENT123',events:[],health:{recovery:{phase:'read',run_id:'run-a'}}}},location.origin);
 });await p.waitForFunction(()=>acks.length===2&&orderCalls.length===1);
 assert.equal(await p.evaluate(()=>acks.every(a=>a.ok)),true);
 assert.deepEqual(await p.evaluate(()=>orderCalls[0]),{name:'ebay-order-sync',args:{body:{captureEventId:'EVENT123'}}});
 await p.evaluate(()=>completeCheck());
 await p.evaluate(()=>window.postMessage({type:'INVSTO_LIVE_BATCH',id:'three',payload:{event_id:'EVENT123',events:[],health:{recovery:{phase:'read',run_id:'run-a'}}}},location.origin));
 await p.waitForFunction(()=>acks.length===3);assert.equal(await p.evaluate(()=>orderCalls.length),1);
 await p.evaluate(()=>{dashboard.recovery={phase:'checking_orders',order_check:{checked:8,total:55},can_close:false,saved_auctions:63,paid_auctions:57,payment_issues:6,unmatched_notifications:0};});
 await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-history-phase').textContent==='Checking current eBay orders…');
 assert.match(await p.locator('#ebay-history-sync').innerText(),/8 of 55 matching orders checked/);
 assert.deepEqual(p.errors,[]);
});

test('complete history keeps real payment holds visible and separates failed bids from sales',async t=>{
 const p=await open(t);await p.evaluate(()=>{
  dashboard.connection.broadcast_ended_at=new Date().toISOString();
  dashboard.recovery={phase:'read',can_close:true,requires_manual_note:false,saved_auctions:14,observed_wins:10,paid_auctions:7,payment_issues:7,unmatched_notifications:0,sold_seen:14,sold_expected:14,pending:0,captured_total:6604,live_sales:6604,failed_without_win:4,failed_without_win_total:13032};
 });await p.locator('#ebay-live-refresh').click();
 await p.waitForFunction(()=>document.getElementById('ebay-history-phase').textContent==='History read — payment review needed');
 assert.match(await p.locator('#ebay-history-counts').innerText(),/14 auction attempts saved · 10 auction wins · 7 paid · 7 payment issues/);
 assert.match(await p.locator('#ebay-history-coverage').innerText(),/Captured item sales: \$6,604.00. eBay Live sales: \$6,604.00/);
 assert.match(await p.locator('#ebay-history-coverage').innerText(),/4 failed attempts without a win \(\$13,032.00\) are outside the sales total/);
 assert.match(await p.locator('#ebay-history-detail').innerText(),/later cancelled or refunded/);
 assert.equal(await p.locator('#ebay-history-phase').evaluate(e=>e.classList.contains('is-error')),true);
 await p.evaluate(()=>Object.assign(dashboard.recovery,{payment_issues:0,unmatched_notifications:1}));await p.locator('#ebay-live-refresh').click();
 await p.waitForFunction(()=>document.getElementById('ebay-history-phase').textContent==='History read — notifications need review');
 assert.deepEqual(p.errors,[]);
});

test('phone recovery progress separates reading from sync and requires a manual comparison when paused',async t=>{
 const p=await open(t);await p.setViewportSize({width:320,height:740});await p.evaluate(()=>{
  dashboard.connection.broadcast_ended_at=new Date().toISOString();dashboard.connection.health={pending:0};dashboard.post_show={open_paid_bags:0,payment_issues:0,unmatched_notifications:0,unlinked_bags:0,paid_bags:2,closed_bags:2};
  dashboard.recovery={phase:'reading',can_close:false,requires_manual_note:false,saved_auctions:3,paid_auctions:2,payment_issues:0,unmatched_notifications:0,sold_seen:2,sold_expected:3,pending:0};
 });await p.locator('#ebay-live-refresh').click();await p.waitForFunction(()=>document.getElementById('ebay-history-phase').textContent==='Reading show history…');
 assert.match(await p.locator('#ebay-history-counts').innerText(),/3 auction attempts saved · 2 paid/);assert.match(await p.locator('#ebay-history-coverage').innerText(),/2 of 3 listings/);assert.match(await p.locator('#ebay-history-sync').innerText(),/does not confirm complete history/);
 await p.evaluate(()=>Object.assign(dashboard.recovery,{captured_total:200,live_sales:300,excluded_listings:1}));await p.locator('#ebay-live-refresh').click();
 await p.waitForFunction(()=>document.getElementById('ebay-history-coverage').textContent.includes('$200.00'));
 assert.match(await p.locator('#ebay-history-coverage').innerText(),/Captured item sales: \$200.00. eBay Live sales: \$300.00/);
 assert.match(await p.locator('#ebay-history-counts').innerText(),/1 later-date listings excluded/);
 await p.locator('#ebay-final-checklist>summary').click();await p.locator('#ebay-final-bags').check();await p.locator('#ebay-final-payments').check();assert.equal(await p.locator('#ebay-complete-show').isDisabled(),true);
 await p.evaluate(()=>Object.assign(dashboard.recovery,{phase:'paused',can_close:true,requires_manual_note:true}));await p.locator('#ebay-live-refresh').click();await p.locator('#ebay-history-note:visible').waitFor();assert.equal(await p.locator('#ebay-complete-show').isDisabled(),true);
 await p.locator('#ebay-history-note').fill('Compared all eBay orders and accounted for the missing auction.');await p.waitForFunction(()=>!document.getElementById('ebay-complete-show').disabled);assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
 await p.locator('#ebay-history-recovery').scrollIntoViewIfNeeded();await p.screenshot({path:'test-results/live-recovery-phone.png'});
 await p.evaluate(()=>{window.finished=[];window.addEventListener('message',e=>{if(e.data?.type==='INVSTO_CAPTURE_FINISHED')finished.push(e.data);});});await p.locator('#ebay-complete-show').click();await p.waitForFunction(()=>finished.length===1);
 assert.equal(await p.evaluate(()=>finished[0].event_id),'EVENT123');assert.match(await p.evaluate(()=>calls.find(c=>c.name==='complete_ebay_live_session').args._history_note),/Compared all eBay orders/);assert.deepEqual(p.errors,[]);
});
