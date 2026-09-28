import assert from 'node:assert/strict';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import {test,before,after} from 'node:test';
import {chromium,webkit} from '@playwright/test';
import vm from 'node:vm';

const root=new URL('../',import.meta.url);let server,browser,origin;
before(async()=>{
  server=createServer(async(req,res)=>{
    const name=new URL(req.url,'http://localhost').pathname.slice(1);
    if(!/^[\w./-]+$/.test(name)||name.includes('..'))return res.writeHead(404).end();
    try {
      let content=await readFile(new URL(name,root));
      if(name.endsWith('.html'))content=content.toString().replace(/<script\b[\s\S]*?<\/script>/gi,tag=>/src="(?:bag-lookup|live-bag-label|barcode-scanner)\.js/.test(tag)?tag:'');
      res.setHeader('Content-Type',name.endsWith('.wasm')?'application/wasm':name.endsWith('.js')?'text/javascript':name.endsWith('.css')?'text/css':'text/html');res.end(content);
    }catch{res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
  browser=await(process.env.INVSTO_ITEM_BROWSER==='webkit'?webkit:chromium).launch();
});
after(async()=>{await browser.close();await new Promise(resolve=>{server.close(resolve);server.closeAllConnections();});});

async function open(t,{query='?bag=LIVE-AAAAAAAAAA',signedIn=true}={}){
  const context=await browser.newContext({viewport:{width:390,height:844}});t.after(()=>context.close());
  await context.route('**/*',r=>[origin,'blob:'+origin,'data:image/'].some(prefix=>r.request().url().startsWith(prefix))?r.continue():r.abort());
  await context.addInitScript(({signedIn})=>{
    window.signedIn=signedIn;window.calls=[];window.failItems=false;window.delayA=0;
    const stamp='2026-09-28T17:00:00Z';
    window.lots=[{id:'lot-a',lot_code:'LIVE-AAAAAAAAAA',auction_number:'EB-010-A',status:'reserved',closed_at:stamp,created_at:stamp,owner_employee_id:'seller',owner_snapshot:{display_name:'Sydney Miller'},session:{id:'show-a',title:'Monday show',session_code:'LS-A',status:'ended',started_at:stamp}},{id:'lot-b',lot_code:'LIVE-BBBBBBBBBB',auction_number:'EB-010-B',status:'open',owner_employee_id:'seller',session:{id:'show-b',title:'Tuesday show',session_code:'LS-B',status:'active',started_at:stamp}}];
    window.auctions=[{id:'auction-a',lot_id:'lot-a',listing_title:'#010 - Cuban Chain',buyer:'long-winner-name-123456789',amount:100,payment_state:'paid',seller_id:'seller',closed_at:stamp,stream_offset_seconds:65,time_estimated:true,win_time_label:'1:01 PM',listing_id:'123'},{id:'auction-b',lot_id:'lot-b',listing_title:'#010 - Watch',buyer:'different-winner',amount:200,payment_state:'paid',seller_id:'seller'}];
    window.items=[{id:'item-a',lot_id:'lot-a',status:'reserved',quantity:2,live_unit_minimum:30,show_elapsed_seconds:60,scanned_at:stamp,item:{title:'Gold chain',description:'10K chain',barcode:'OG123'},source_location:{location_name:'Tray 3'}}];
    window.manual=[{id:'manual-a',lot_id:'lot-a',status:'packed',quantity:1,live_unit_minimum:50,item_category:'Pendant',item_description:'Hand-entered pendant',photo_path:'live-manual/fixture.jpg',show_elapsed_seconds:65,created_at:stamp},{id:'removed',lot_id:'lot-a',status:'released',quantity:4,live_unit_minimum:1000,item_category:'Removed ring'}];
    window.supabase={auth:{getSession:async()=>({data:{session:window.signedIn?{user:{id:'worker'}}:null}}),onAuthStateChange(fn){window.authChange=fn;}},storage:{from:()=>({createSignedUrl:async(path)=>{calls.push({signed:path});return {data:{signedUrl:'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg=='}};}})},from(table){
      calls.push({table});let filters=[];
      const all=()=>table==='employees'?[{id:'employee',user_id:'worker',active:true}]:table==='live_sale_lots'?lots:table==='ebay_live_attempts'?auctions:table==='live_sale_lot_items'?items:table==='live_sale_manual_lot_items'?manual:[];
      const result=async single=>{
        const data=structuredClone(all().filter(row=>filters.every(([k,v])=>row[k]===v)));
        if(table==='live_sale_lots'&&data[0]?.id==='lot-a'&&window.delayA)await new Promise(r=>setTimeout(r,window.delayA));
        return table==='live_sale_lot_items'&&window.failItems?{error:{message:'Connection interrupted'}}:{data:single?data[0]||null:data};
      };
      const q={select(){return q},eq(k,v){filters.push([k,v]);return q},order(){return q},maybeSingle:()=>result(true),then:fn=>result(false).then(fn)};return q;
    },rpc:async name=>{calls.push({rpc:name});if(name!=='get_live_sale_seller_directory')throw new Error('Unexpected mutation');return {data:[{id:'seller',display_name:'Sydney Miller'}]};}};
    window.printStations={printLabel:async(xml,options)=>{calls.push({print:xml,options});return {mode:'remote-queue',stationName:'Main show printer'};}};
  },{signedIn});
  const p=await context.newPage();p.errors=[];p.on('pageerror',e=>p.errors.push(e.message));t.after(()=>assert.deepEqual(p.errors,[]));
  await p.goto(origin+'/bag-lookup.html'+query);
  await p.waitForFunction(()=>!document.getElementById('bag-status').textContent.includes('Checking')&&!document.getElementById('bag-status').textContent.includes('Loading'));
  return p;
}

test('unique QR survives repeated eBay numbers; label prints reference and crops winner safely',async()=>{
  const context={window:{}};vm.runInNewContext(await readFile(new URL('../live-bag-label.js',import.meta.url),'utf8'),context);
  const {identity,build}=context.window.liveBagLabel;
  const a=identity({lot_code:'LIVE-AAAAAAAAAA',auction_number:'EB-FAKE'},{listing_title:'#010 - Chain',buyer:'very-long-winner-1234&',ordinal:'99'});
  const xml=build(a);
  assert.equal(a.auctionNumber,'010');assert.match(xml,/<Text>#010<\/Text>/);assert.match(xml,/<Text>VERY-LONG-WINNE[^<]*\.\.\.<\/Text>/);
  assert.deepEqual([...xml.matchAll(/<DataString>(.*?)<\/DataString>/g)].map(m=>m[1]),Array(4).fill('LIVE-AAAAAAAAAA'));
  assert.doesNotMatch(xml,/EB-FAKE|>99</);
  assert.notEqual(xml,build({...a,lotCode:'LIVE-BBBBBBBBBB'}));
  assert.match(build({...a,freeText:'A&B<"'}),/A&amp;B&lt;&quot;/);
  assert.equal(identity({lot_code:'LIVE-A',auction_number:'EB-FAKE'},{listing_title:'No reference',ordinal:'99'}).auctionNumber,'');
});

test('staff scan loads full winner, seller, manual photos and signed negative result from ended shows',async t=>{
  const p=await open(t);assert.equal(await p.locator('#bag-result h2').innerText(),'#010');
  const details=await p.locator('#bag-result').innerText();
  for(const text of ['long-winner-name-123456789','Sydney Miller','Gold chain','Hand-entered pendant','3 units','$110.00','-$10.00','Payment confirmed'])assert.ok(details.includes(text),text);
  assert.equal(await p.locator('[data-photo="manual-a"]').isEnabled(),true);await p.locator('[data-photo="manual-a"]').click();
  assert.equal(await p.locator('#bag-photo-dialog').isVisible(),true);await p.locator('#bag-photo-close').click();
  await p.getByText('Show and timing',{exact:true}).click();assert.match(await p.locator('#bag-result').innerText(),/Monday show.*LS-A · ended/s);
  assert.equal(await p.evaluate(()=>calls.some(c=>c.rpc&&c.rpc!=='get_live_sale_seller_directory')),false);
});

test('scan resolves exact bag across repeated auctions and old auction-only QR is rejected',async t=>{
  const p=await open(t);await p.locator('#bag-code').fill('010');await p.locator('#bag-find').click();
  await p.waitForFunction(()=>document.getElementById('bag-result').hidden);assert.match(await p.locator('#bag-status').innerText(),/other QR/);
  await p.locator('#bag-code').fill('live-bbbbbbbbbb');await p.locator('#bag-find').click();await p.locator('.bag-winner').waitFor();
  assert.match(await p.locator('.bag-winner').innerText(),/different-winner/);assert.match(await p.locator('#bag-result').innerText(),/No items saved/);assert.doesNotMatch(await p.locator('#bag-result').innerText(),/\+\$200/);
});

test('missing minimum and cancelled payments never imply profit; zero is a known minimum',async t=>{
  const p=await open(t);await p.evaluate(()=>manual[0].live_unit_minimum=null);await p.locator('#bag-refresh').click();await p.waitForFunction(()=>document.getElementById('bag-result').textContent.includes('missing a minimum'));
  assert.doesNotMatch(await p.locator('#bag-result').innerText(),/\+\$|\-\$/);
  await p.evaluate(()=>{manual[0].live_unit_minimum=0;});await p.locator('#bag-refresh').click();await p.waitForFunction(()=>document.getElementById('bag-result').textContent.includes('+$40.00'));
  await p.evaluate(()=>{auctions[0].payment_state='failed';});await p.locator('#bag-refresh').click();await p.waitForFunction(()=>document.getElementById('bag-result').textContent.includes('Payment failed'));assert.doesNotMatch(await p.locator('#bag-result').innerText(),/\+\$40/);
  await p.evaluate(()=>{auctions[0].payment_state='paid';auctions[0].resolved_at=new Date().toISOString();});await p.locator('#bag-refresh').click();await p.waitForFunction(()=>document.getElementById('bag-result').textContent.includes('excluded from running result'));assert.doesNotMatch(await p.locator('#bag-result').innerText(),/\+\$40/);
});

test('lookup failure clears prior bag and cannot print stale contents',async t=>{
  const p=await open(t);await p.evaluate(()=>failItems=true);await p.locator('#bag-refresh').click();await p.waitForFunction(()=>document.getElementById('bag-status').textContent.includes('Connection interrupted'));
  assert.equal(await p.locator('#bag-result').isVisible(),false);assert.equal(await p.locator('#bag-print').count(),0);
});

test('racing scans never replace the latest selected bag',async t=>{
  const p=await open(t);await p.evaluate(()=>delayA=600);await p.locator('#bag-refresh').click();await p.locator('#bag-code').fill('LIVE-BBBBBBBBBB');await p.locator('#bag-find').click();await p.locator('.bag-winner').waitFor();
  await p.waitForTimeout(750);assert.match(await p.locator('.bag-winner').innerText(),/different-winner/);assert.match(p.url(),/BBBBBBBBBB/);
});

test('printing rechecks identity, uses chosen-station flow, and does not close or modify a bag',async t=>{
  const p=await open(t);await p.evaluate(()=>{auctions[0].buyer='corrected-buyer';});await p.locator('#bag-print').click();await p.waitForFunction(()=>calls.some(c=>c.print));
  const job=await p.evaluate(()=>calls.find(c=>c.print));assert.match(job.print,/CORRECTED-BUYER/);assert.match(job.print,/<Text>#010<\/Text>/);assert.equal(job.options.barcode,'LIVE-AAAAAAAAAA');assert.match(await p.locator('#bag-status').innerText(),/Main show printer/);
  assert.equal(await p.evaluate(()=>calls.some(c=>c.rpc&&c.rpc!=='get_live_sale_seller_directory')),false);
  await p.evaluate(()=>{lots[0].status='cancelled';});await p.locator('#bag-print').click();await p.waitForFunction(()=>document.getElementById('bag-status').textContent.includes('cancelled or released'));
  assert.equal(await p.evaluate(()=>calls.filter(c=>c.print).length),1);assert.equal(await p.locator('#bag-print').isDisabled(),true);
});

test('authentication is required and signing out removes loaded data',async t=>{
  const p=await open(t,{signedIn:false});assert.match(await p.locator('#bag-status').innerText(),/Sign in/);assert.equal(await p.locator('#bag-result').isVisible(),false);assert.equal(await p.evaluate(()=>calls.length),0);
  await p.evaluate(()=>signedIn=true);await p.locator('#bag-refresh').click();await p.locator('.bag-winner').waitFor();
  await p.evaluate(()=>{signedIn=false;authChange('SIGNED_OUT',null);});assert.equal(await p.locator('#bag-result').isVisible(),false);assert.equal(await p.locator('#bag-result').innerText(),'');
});

test('phone scanner decodes a real bag QR photo and loads contents only after Use code',async t=>{
  const p=await open(t,{query:''});await p.evaluate(()=>{
    if(!navigator.mediaDevices)Object.defineProperty(navigator,'mediaDevices',{value:{},configurable:true});
    navigator.mediaDevices.getUserMedia=async()=>{throw new DOMException('Denied','NotAllowedError');};
  });
  await p.addScriptTag({url:origin+'/vendor/zxing-browser-0.1.5.min.js'});
  const png=await p.evaluate(async()=>{
    const svg=new ZXingBrowser.BrowserQRCodeSvgWriter().write('LIVE-AAAAAAAAAA',360,360);
    const url=URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)],{type:'image/svg+xml'}));
    const img=new Image();img.src=url;await img.decode();const canvas=document.createElement('canvas');canvas.width=canvas.height=360;canvas.getContext('2d').drawImage(img,0,0);URL.revokeObjectURL(url);return canvas.toDataURL('image/png');
  });
  await p.locator('#bag-camera').click();await p.locator('[data-camera="photo"]').setInputFiles({name:'bag.png',mimeType:'image/png',buffer:Buffer.from(png.split(',')[1],'base64')});
  await p.waitForFunction(()=>!document.querySelector('[data-camera="use"]').disabled);assert.equal(await p.locator('#bag-result').isVisible(),false);
  await p.locator('[data-camera="use"]').click();await p.locator('.bag-winner').waitFor();assert.match(await p.locator('.bag-winner').innerText(),/long-winner/);
});

test('small phone and desktop layouts fit, including hostile long buyer text',async t=>{
  const p=await open(t);await p.evaluate(()=>{auctions[0].buyer='<img src=x onerror="window.injected=true">'+'W'.repeat(70);});await p.locator('#bag-refresh').click();await p.locator('.bag-winner').waitFor();
  assert.equal(await p.evaluate(()=>!!window.injected),false);
  await p.evaluate(()=>{auctions[0].buyer='long-winner-name-123456789';});await p.locator('#bag-refresh').click();await p.waitForFunction(()=>document.querySelector('.bag-winner')?.textContent.includes('long-winner-name'));
  await mkdir(new URL('../test-results',import.meta.url),{recursive:true});
  for(const width of [320,1280]){
    await p.setViewportSize({width,height:900});assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await p.screenshot({path:new URL(`../test-results/bag-lookup-${width}.png`,import.meta.url).pathname.replace(/^\/([A-Z]:)/,'$1'),fullPage:true});
  }
});


test('past-show reprints use the same eBay reference and buyer as current labels',async()=>{
 let printed;
 const q={select(){return q},eq(){return q},maybeSingle:async()=>({data:{listing_title:'#010 - Chain',buyer:'correct-winner'}})};
 const context={window:{printStations:{printLabel:async xml=>{printed=xml;return {};},deliveryMessage:()=>''}},document:{addEventListener(){}},supabase:{from:()=>q,rpc:async()=>({})},console};
 vm.createContext(context);
 vm.runInContext(await readFile(new URL('../live-bag-label.js',import.meta.url),'utf8'),context);
 vm.runInContext(await readFile(new URL('../past-live-sales.js',import.meta.url),'utf8'),context);
 await vm.runInContext(`state.user={email:'fixture@example.invalid'};state.lots=[{id:'lot',session_id:'show',lot_code:'LIVE-AAAAAAAAAA',auction_number:'EB-WRONG'}];state.sessions=[{id:'show',title:'Old show'}];setStatus=()=>{};loadPastLiveSales=async()=>{};printLiveSaleBagLabel('lot');`,context);
 assert.match(printed,/<Text>#010<\/Text>/);assert.match(printed,/CORRECT-WINNER/);assert.doesNotMatch(printed,/EB-WRONG/);
});
