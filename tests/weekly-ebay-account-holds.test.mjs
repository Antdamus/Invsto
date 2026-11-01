import assert from 'node:assert/strict';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';
import {chromium} from '@playwright/test';
import {heldBalance} from '../supabase/functions/ebay-order-sync/account-holds.ts';
const path=n=>fileURLToPath(new URL(n,import.meta.url));

test('a missing or foreign-currency account balance is never treated as zero',()=>{
 for(const p of [{},{fundsOnHold:{currency:'EUR',value:'30.00'}},{fundsOnHold:{currency:'USD',value:''}}])assert.throws(()=>heldBalance(p));
 assert.equal(heldBalance({fundsOnHold:{currency:'USD',value:'0.00'}}),0);
 assert.equal(heldBalance({fundsOnHold:{currency:'USD',value:'23.99'}}),2399);
});
test('the report separates older reserves, unknown dates and a newer balance change; drilldowns survive refresh',async()=>{
 const b=await chromium.launch();try{
  const p=await b.newPage({viewport:{width:390,height:780}});
  await p.setContent('<section id="host" class="wh-panel"></section>');await p.addStyleTag({path:path('../weekly-marketplace-sales.css')});
  await p.addScriptTag({path:path('../weekly-ebay-holds.js')});
  const d={month:'2026-10-01',ebay_account_holds:{verified_at:'2026-11-01T04:00Z',ledger_cents:3600,
   entries:[{kind:'sale',ref:'01-10000-00011',oid:'01-10000-00011',cents:2000,placed:'2026-10-20',date:'2026-10-19'},
    {kind:'return',ref:'100005',oid:'21-10000-00011',cents:1100,placed:'2026-10-05',date:'2026-09-14'},
    {kind:'other',ref:'HOLD_1',cents:500,placed:'2026-10-05'}]}};
  const draw=()=>p.evaluate(data=>window.WeeklyEbayHolds.update(document.querySelector('#host'),data,{},()=>{}),d);await draw();
  assert.match(await p.locator('.wh-cohorts p').innerText(),/October 2026 purchases: \$20.00.*\$11.00 belongs to earlier purchases.*unknown: \$5.00/);
  await p.locator('[data-wh-month="2026-09"]').click();assert.match(await p.locator('.wh-list').innerText(),/1 entry · \$11.00/);
  assert.match(await p.locator('.wh-list a').last().getAttribute('href'),/DISPUTE_DISPLAY-100005/);
  d.ebay_account_holds.api_at='2026-11-01T05:00Z';d.ebay_account_holds.api_cents=3200;await draw();
  assert.match(await p.locator('.wh-account').innerText(),/\$4.00 lower/);assert.equal(await p.locator('.wh-month').inputValue(),'2026-09');
  await p.locator('[data-wh-kind="other"]').click();assert.match(await p.locator('.wh-list').innerText(),/Order not yet matched/);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 }finally{await b.close();}
});
test('Seller Hub page reader counts visible net money once and resolves sale, return, dispute and retro records',async()=>{
 const b=await chromium.launch();try{
  const p=await b.newPage();
  const oid='01-20000-00001',rows=[
   [`Order <a href="https://www.ebay.com/sh/ord/details?orderid=${oid}">${oid}</a>`,null,'10.00'],
   ['Hold $2.20 held for return ID 111','DISPUTE_DISPLAY__DISPUTE_DISPLAY-111','2.20'],
   ['Hold $3.00 held for payment dispute ID 222','DISPUTE_DISPLAY__DISPUTE_DISPLAY-222','3.00'],
   ['Hold '+oid,'RETRO_FUNDS_DISPLAY__RETRO_DISPLAY-333&relatedTransactionId='+oid,'4.00']];
  await p.setContent('<a href="https://www.ebay.com/usr/ogjewelers">ogjewelers View profile</a><button aria-pressed="true">On hold (4)</button><div class="funds-details-container--fund-details">On hold <span class="funds-details-container--fund-details-amount">$19.20</span></div><span class="each-as-row">Transactions: 1-4 of 4</span>'+
   rows.map(([desc,uid,v])=>`<div class="transaction--content-wrapper"><div class="transactions-date">Oct 28, 2026<br>3:00 PM</div><div class="transaction--desc">${desc}</div><div class="transaction--net">$${v}<br>$${v}</div><div class="transaction--details">${uid?'<a href="https://www.ebay.com/mes/transactiondetails?type=RESERVE&uuid='+uid+'">Details</a>':''}</div></div>`).join(''));
  await p.evaluate(()=>{window.chrome??={};window.chrome.runtime={id:'id',onMessage:{addListener:f=>window.readPage=()=>new Promise(done=>f({type:'OG_HOLDS_PAGE'},{id:'id'},done))}};});
  await p.addScriptTag({path:path('../tools/ebay-og-order-link-extension/holds-reader.js')});
  const r=await p.evaluate(()=>window.readPage());assert.equal(r.ok,true,r.message);
  assert.equal(r.page.rows.reduce((s,v)=>s+v.cents,0),r.page.total);
  assert.deepEqual(r.page.rows.map(x=>x.kind),['sale','return','dispute','retro']);assert.equal(r.page.rows[3].oid,oid);
  await p.locator('.transaction--net').first().evaluate(e=>e.innerText='$10.00\n$11.00');assert.equal((await p.evaluate(()=>window.readPage())).ok,false);
 }finally{await b.close();}
});
