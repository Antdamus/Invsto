import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
import {chromium} from '@playwright/test';
import '../ebay-performance-model.js';
import '../ebay-hold-details.js';
const M=globalThis.EbayPerformance;
const root=new URL('../',import.meta.url);
const order={id:'01-12345-67890',purchased:'2026-10-29T16:00:00Z',buyer:'seller_buyer',paid:true,original_cents:5000,status:'Partially refunded',items:[{id:'123',title:'Lot A'},{id:'124',title:'Lot B'}]};
const c={id:'100',buyer:'seller_buyer',requested:'2026-11-02',reason:'Buyer requested',items:['123'],gross:3000,linked_order:order.id,purchase_day:'2026-10-29'};
const transactions=[{order_id:order.id,reference:'Cancel ID 100',day:'2026-11-02',gross:3000,net:2780,title:'Lot A'},{order_id:order.id,reference:'Refund ID 200',day:'2026-11-02',gross:800,net:750,title:'Lot B'}];
const data={orders:[order],cases:[c,{...c,id:'prior',linked_order:'other',buyer:'other',items:['900'],purchase_day:'2026-06-01'}],payments:transactions,
 config:{coverage_start:'2026-07-02',cancellation:60,buyer:null,refund:null},
 sources:{version:'x',sources:Object.fromEntries(['cases','orders','payments'].map(k=>[k,{last:new Date().toISOString(),errors:0}]))}};
test('purchase cohorts keep distinct lines, cancellation reasons, and money refunded after purchase',()=>{
 const idx=M.index(data),s=M.summarize(idx,{start:'2026-10-01',end:'2026-10-31'});
 assert.deepEqual([s.lines,s.canceled,s.buyer,s.other,s.cancelGross,s.otherNet],[2,1,1,1,3000,750]);
 assert.equal(M.summarize(idx,{start:'2026-11-01',end:'2026-11-30'}).canceled,0);
 const uncertain=M.summarize(M.index({...data,payments:[{...transactions[1],title:''}]}),{start:'2026-10-01',end:'2026-10-31'});
 assert.deepEqual([uncertain.other,uncertain.unassigned,uncertain.otherGross],[0,1,800]);
 assert.deepEqual(M.priorPeriod('month',M.period('month','2026-03-31')),{start:'2026-02-01',end:'2026-02-28'});
});
test('release timing uses the final signed close, preserves orders without closure, and skips a newer released sale',()=>{
 const ev={finance:{transactions:[{orderNumber:order.id,transactionType:'SALE',bookingEntry:'CREDIT',transactionStatus:'FUNDS_ON_HOLD',memo:'Estimated release on Nov 5'}]}};
 const x={id:order.id,cents:5000,evidence:ev,lines:['2026-10-27','2026-10-29'].map(d=>({closed:d+'T16:00Z',signed:true,full:true,status:'fulfilled'}))};
 const packet={verified_at:'2026-11-02T20:00Z',entries:[x,{...x,cents:15}]};
 const run=()=>M.releaseRows(packet,'2026-11-02',globalThis.OGEbayHoldDetails).groups[0];
 assert.deepEqual([run().rows.length,run().cents,run().rows[0].wait],[1,5015,7]);
 x.lines[0].signed=false;assert.equal(run().rows[0].wait,null);
});
test('only admins see the report; a failed or replayed refresh cannot overwrite a verified result',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create schema auth;
 create function auth.uid() returns uuid language sql as $$ select '00000000-0000-4000-8000-000000000001'::uuid $$;
 create table employees(user_id uuid,active boolean,role text);insert into employees values(auth.uid(),true,'admin');
 create table ebay_orders(id uuid, order_number text,raw_payload jsonb,sale_date timestamptz,buyer_username text,paid_on_date timestamptz);
 create table ebay_order_lines(id uuid,order_id uuid,item_number text,item_title text,sold_for numeric,quantity int,fulfilled_at timestamptz,fulfilled_by uuid,fulfilled_by_email text,line_status text,fulfilled_quantity int,raw_payload jsonb);
 create function weekly_sales_money(text) returns numeric language sql as $$select null::numeric$$;
 create function weekly_ebay_hold_snapshot() returns jsonb language sql as $$select '{"entries":[]}'::jsonb$$;
 create function ebay_report_manual_actions(date) returns jsonb language sql as $$select '[]'::jsonb$$;`);
 await db.exec(await fs.readFile(new URL('supabase/migrations/20261102210000_ebay_performance_reports.sql',root),'utf8'));
 await db.exec(await fs.readFile(new URL('supabase/migrations/20261102212000_verify_performance_cancel_details.sql',root),'utf8'));
 const query=async(s,p)=>(await db.query(s,p)).rows[0]?.v;
 await db.query("select store_ebay_health_rows('orders',$1)",[JSON.stringify([order])]);
 await db.query("select store_ebay_health_rows('payments',$1)",[JSON.stringify(transactions)]);
 const next=await query('select claim_ebay_health_jobs() v');const job=next.find(j=>j.kind==='cases');assert.ok(job);
 await assert.rejects(db.query("select finish_ebay_health_job($1,$2,2,null)",[job.ticket,JSON.stringify([c])]),/Incomplete/);
 await db.query("select finish_ebay_health_job($1,$2,1,null)",[job.ticket,JSON.stringify([c])]);
 await assert.rejects(db.query("select finish_ebay_health_job($1,'[]',0,null)",[job.ticket]),/Expired/);
 assert.equal((await query('select ebay_health_report() v')).cases.length,1);
 const archived={...c,id:'101',items:['999'],linked_order:null,purchase_day:null};
 await db.query("select store_ebay_health_rows('cases',$1)",[JSON.stringify([archived])]);
 await db.exec("insert into ebay_health_jobs(kind,id) values('case_detail','101')");
 const detail=(await query('select claim_ebay_health_jobs() v')).find(j=>j.kind==='case_detail'&&j.id==='101');
 const record={...archived,purchase_day:'2026-10-29',linked_order:'02-12345-67890'};
 await assert.rejects(db.query("select finish_ebay_health_job($1,$2,1,null)",[detail.ticket,JSON.stringify([{...record,buyer:'different'}])]),/store register/);
 await db.query("select finish_ebay_health_job($1,$2,1,null)",[detail.ticket,JSON.stringify([record])]);
 await db.exec("update ebay_health_jobs set due=now() where kind='cases'");
 const retry=(await query('select claim_ebay_health_jobs() v')).find(j=>j.kind==='cases');
 await db.query("select finish_ebay_health_job($1,'[]',0,'Not signed in')",[retry.ticket]);
 assert.equal((await query('select ebay_health_report() v')).cases.length,2);
 await db.exec('select set_ebay_health_targets(5,1,2)');assert.equal((await query('select ebay_health_report() v')).config.buyer,1);
 await assert.rejects(db.exec('select set_ebay_health_targets(105,1,2)'));
 assert.equal(await query("select has_table_privilege('authenticated','ebay_health_refunds','select') v"),false);
 await db.exec("update employees set role='worker'");await assert.rejects(db.exec('select ebay_health_report()'),/admin/);
 }finally{await db.close();}
});
test('mobile admin dashboard report opens, changes period, saves targets and prints each view',async()=>{
 const browser=await chromium.launch();try{
  const p=await browser.newPage({viewport:{width:390,height:844}});const errors=[];
  p.on('pageerror',e=>errors.push(e.message));const html=await fs.readFile(new URL('ebay-performance.html',root),'utf8');
  await p.route('https://report.test/**',async route=>{
   const path=new URL(route.request().url()).pathname.slice(1)||'ebay-performance.html';
   const body=path==='ebay-performance.html'?html.replace(/<script src="https:[^>]+><\/script>/,''):path==='initSupabase.js'?
    'window.supabaseClient={auth:{getSession:async()=>({data:{session:{}}})},rpc:async(n,p)=>{if(n==="set_ebay_health_targets")window.sample.config.buyer=p._buyer;return {data:n==="ebay_health_report"?window.sample:n==="ebay_health_release_evidence"?{verified_at:new Date(),entries:[]}:window.sample.sources}}}':
    await fs.readFile(new URL(path,root),'utf8');
   await route.fulfill({contentType:path.endsWith('html')?'text/html':path.endsWith('css')?'text/css':'text/javascript',body});
  });
  await p.addInitScript(sample=>{window.sample=sample;window.print=()=>window.printed=true;},data);
  await p.goto('https://report.test/ebay-performance.html');await p.getByText('Are we on track?').waitFor();
  await p.selectOption('#period','month');await p.locator('#targets summary').click();await p.fill('#goal-buyer','2.5');await p.getByRole('button',{name:'Save targets'}).click();await p.getByText('Targets saved for this store.').waitFor();
  await p.click('#refunds-tab');await p.getByText('Where the refunds came from').waitFor();
  await p.click('#last-months');await p.selectOption('#refund-basis','purchase');
  await p.getByText('Refunds on purchases from each period').waitFor();
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await p.click('#release-tab');await p.getByText('Upcoming estimated releases').waitFor();await p.click('#print');
  assert.equal(await p.evaluate(()=>window.printed),true);
  assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
 }finally{await browser.close();}
});
test('Seller Hub reader verifies its seller, date and transaction filter before reading amounts',async()=>{
 const browser=await chromium.launch();try{
  const p=await browser.newPage(),profile='<a href="https://www.ebay.com/usr/ogjewelers">ogjewelers</a>';
  let html='';
  await p.route('https://www.ebay.com/**',r=>r.fulfill({contentType:'text/html',body:html}));
  await p.addInitScript(()=>{window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.readPerformance=fn;}}}};});
  const read=async(path,job)=>{
   await p.goto('https://www.ebay.com'+path);
   await p.addScriptTag({path:new URL('tools/ebay-og-order-link-extension/performance-reader.js',root).pathname.replace(/^\/(\w:)/,'$1')});
   return p.evaluate(job=>new Promise(r=>window.readPerformance({type:'OG_PERFORMANCE_PAGE',job},{id:'test'},r)),job);
  };
  html=profile+'<div class="app-date-picker"><input value="7/1/2026"><input value="7/7/2026"></div><div class="grid-summary">Results: 1-1 of 1</div><table><tbody><tr class="order-info orderid_01-12345-67890"><td class="buyer-modal-trigger-wrapper"><button>Seller Buyer<br>seller_buyer</button></td><td class="date-column">Jul 6<br>11:25pm PDT</td><td class="date-column">Jul 6</td><td class="actions-cell">Paid</td><td class="price-column">$20.00<br>+$1.00 shipping</td></tr><tr class="item-info orderid_01-12345-67890"><td><a href="/itm/123">Lot A</a></td></tr><tr class="item-info orderid_01-12345-67890"><td><a href="/itm/124">Lot B</a></td></tr></tbody></table>';
  const span={kind:'orders',from:'2026-07-01',to:'2026-07-07'};
  let result=await read('/sh/ord/',span);
  assert.deepEqual([result.page.rows[0].purchased,result.page.rows[0].items.length,result.page.rows[0].original_cents],['2026-07-07T06:25:00.000Z',2,2000]);
  assert.equal((await read('/sh/ord/',{...span,from:'2026-07-02'})).ok,false);
  html=profile+'<button>Status:<br>Canceled</button><p>Results: 1-1 of 1</p><table><tr><td>See details</td><td></td><td><a href="/itm/123">Lot A</a></td><td>Canceled</td><td>Cancel ID: 100<br>Requested: Nov 2, 2026<br>Reason: Buyer requested</td><td>$30.00</td><td>seller_buyer</td></tr></table>';
  result=await read('/sh/ord/cancel',{kind:'cases'});assert.deepEqual(result.page.rows[0],{id:'100',buyer:'seller_buyer',reason:'Buyer requested',requested:'2026-11-02',items:['123'],gross:3000});
  const transaction=(kind)=>'<div class="transaction--content-wrapper"><div>Nov 2, 2026</div><div class="transaction--desc">'+kind+' for order number 01-12345-67890<button>Open in OG</button><br>Cancel ID: 100<br>#100 Lot A</div><div>-$30.00</div><div>$2.20</div><div class="transaction--net">-$27.80<br>negative $27.80</div></div>';
  html=profile+'<input type="search" aria-label="search-field" value="01-12345-67890"><p>Transactions: 1-2 of 2</p>'+transaction('Refund')+transaction('Claim');
  result=await read('/mes/transactionlist?sh=true',{kind:'payments',id:order.id});
  assert.deepEqual(result.page.rows.map(x=>[x.reference,x.gross,x.net]),[['Cancel ID 100',3000,2780]]);
  assert.equal((await read('/mes/transactionlist?sh=true',{kind:'payments',id:'02-12345-67890'})).ok,false);
  html=html.replace(profile,'');assert.equal((await read('/mes/transactionlist?sh=true',{kind:'payments',id:order.id})).ok,false);
  html='<div id="cancelDetails"><h1>This order is canceled</h1>Item ID:<br>Item ID:<br>123<br>123</div><p>Buyer<br>Buyer<br>seller_buyer</p><p>Order number<br>01-12345-67890</p><p>Date purchased<br>Oct 29, 2026</p>';
  result=await read('/Cancel/Details?cancelId=100',{kind:'case_detail',id:'100'});assert.deepEqual(result.page.rows[0],{id:'100',buyer:'seller_buyer',items:['123'],purchase_day:'2026-10-29',linked_order:order.id});
 }finally{await browser.close();}
});
