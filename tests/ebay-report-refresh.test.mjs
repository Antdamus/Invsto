import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {chromium} from '@playwright/test';
import {deliveryResults} from '../supabase/functions/ebay-order-sync/report-delivery.ts';
const file=p=>new URL('../'+p,import.meta.url);
test('signed-in worker certifies a new reader, retries a transient page, and skips a fresh verified list on the next run',async()=>{
 const source=await readFile(file('ebay-report-refresh.js'),'utf8'),local=new Map();
 async function run({replies=[],failSave=false,ledger=false}={}){
  let boot,handler,reads=0,saves=0,note;const origin='https://antdamus.github.io';
  const db={auth:{getSession:async()=>({data:{session:{}}})},rpc:async(name,p)=>{
   if(name==='claim_ebay_browser_reports')return {data:{ticket:'t',orders:[],ledger}};
   if(name==='refresh_ebay_hold_ledger'){saves++;return {error:failSave};}
   if(name==='finish_ebay_browser_reports'){note=p._note;return {};}
   assert.fail(name);}};
  const win={supabaseClient:db,addEventListener(k,f){if(k==='load')boot=f;else handler=f;},removeEventListener(){},
   postMessage(m){if(m.type==='OG_REPORT_FINISH')return;assert.equal(m.type,'OG_READ_ACCOUNT_HOLDS');const reply=replies[reads++];
    queueMicrotask(()=>handler({origin,source:win,data:{channel:'invstoReportResult',id:m.id,reply}}));}};
  win.top=win;runInNewContext(source,{window:win,location:{origin,href:origin+'/Invsto/ebay-report-refresh.html?job=1'},URL,crypto:{randomUUID:()=> 'msg'},
   localStorage:{getItem:k=>local.get(k),setItem:(k,v)=>local.set(k,v)},setTimeout:()=>0,clearTimeout:()=>{},Date,document:{querySelector:()=>({})}});
  await boot();return {reads,saves,note};
 }
 const ok={ok:true,packet:{count:1,total:100,rows:[{}]}},transient={ok:false,message:'Waiting for the Seller Hub On hold list.'};
 assert.deepEqual(await run({replies:[transient,ok]}),{reads:2,saves:1,note:'1 hold entry verified.'});
 assert.deepEqual(await run(),{reads:0,saves:0,note:''});
 const failed=await run({replies:[ok],ledger:true,failSave:true});assert.match(failed.note,/did not reconcile/);
 assert.equal((await run()).reads,0,'an unverified reader cools down before a new certification attempt');
 const auth=await run({replies:[{ok:false,message:'Sign in to the ogjewelers Seller Hub account.'}],ledger:true});assert.equal(auth.reads,1);
});
test('manual refresh waits for the Edge bridge and verifies exactly the requested sources',async()=>{
 const source=await readFile(file('ebay-report-refresh.js'),'utf8'),calls=[],origin='https://antdamus.github.io';
 let boot,handler;const root={dataset:{}},doc={documentElement:root,querySelector:()=>({})};
 const db={auth:{getSession:async()=>({data:{session:{}}})},rpc:async(n,p)=>{
  calls.push([n,p]);if(n==='claim_requested_ebay_performance_checks')return {data:[{kind:'cases',id:'register',ticket:'c'},{kind:'orders',id:'2026-11-02',ticket:'o'}]};
  assert.equal(n,'finish_ebay_health_job');return {};
 }};
 const win={supabaseClient:db,close(){},addEventListener(k,f){if(k==='load')boot=f;else handler=f;},removeEventListener(){},
  postMessage(m){if(m.type==='OG_REPORT_FINISH')return;assert.equal(m.type,'OG_PERFORMANCE_READ');
   queueMicrotask(()=>handler({origin,source:win,data:{channel:'invstoReportResult',id:m.id,reply:m.job.kind==='cases'?{ok:false,message:'Sign in to Seller Hub'}:{ok:true,rows:[{id:'o'}]}}}));}};
 win.top=win;const observer=class{constructor(fn){this.fn=fn;}observe(){root.dataset.invstoPerformanceWorker='1';queueMicrotask(this.fn);}disconnect(){}};
 runInNewContext(source,{window:win,document:doc,MutationObserver:observer,location:{origin,href:origin+'/Invsto/ebay-report-refresh.html?job=1&performance=manual'},URL,crypto:{randomUUID:()=> 'msg'},setTimeout:()=>0,clearTimeout:()=>{},Date});
 await boot();assert.equal(calls.length,3);assert.equal(calls[1][1]._error,'Sign in to Seller Hub');assert.equal(calls[2][1]._count,1);
});
test('held-list worker requests exact ranges in its own tab and never publishes a partial or changing ledger',async()=>{
 const src=await readFile(file('tools/ebay-og-order-link-extension/holds-background.js'),'utf8');
 async function run(bad){
  let handler,offset=0,removed=false;
  const offsets=[],goto=({url})=>{const u=new URL(url);assert.equal(u.searchParams.get('limit'),'30');assert.equal(u.searchParams.get('pillFilterId'),'FUNDS_ON_HOLD_FILTER');offset=+u.searchParams.get('offset');offsets.push(offset);};
  const page=()=>({start:offset+1,end:Math.min(31,offset+30),count:31,total:bad==='balance'&&offset?32:31,rows:Array.from({length:offset?1:30},(_,i)=>({kind:'sale',ref:String(bad==='duplicate'&&offset?0:offset+i),cents:bad==='sum'&&offset?2:1}))});
  const chrome={runtime:{onMessage:{addListener:f=>{handler=f;}}},tabs:{
   create:async o=>{assert.equal(o.active,false);goto(o);return {id:7};},update:async(id,o)=>{assert.equal(id,7);goto(o);},
   sendMessage:async(id,m)=>{assert.equal(id,7);assert.deepEqual(Object.keys(m),['type']);return {ok:true,page:page()};},remove:async id=>{assert.equal(id,7);removed=true;}}};
  runInNewContext(src,{chrome,URL,Date,setTimeout});const result=await new Promise(r=>handler({type:'OG_READ_ACCOUNT_HOLDS'},{tab:{id:2},frameId:0,url:'https://antdamus.github.io/Invsto/dashboard.html'},r));
  assert.deepEqual(offsets,[0,30]);assert.equal(removed,true);return result;
 }
 assert.equal((await run()).packet.rows.length,31);
 for(const bad of ['balance','duplicate','sum'])assert.equal((await run(bad)).ok,false);
});
test('actual delivery is conditional on seller, order and all purchased lines and packages',()=>{
 const id='01-12345-12345',ts='2026-01-02T12:00:00Z',pkg=d=>'<ShippingPackageInfo>'+d+'</ShippingPackageInfo>',line=p=>'<Transaction>'+p+'</Transaction>';
 const actual=pkg('<ActualDeliveryTime>'+ts+'</ActualDeliveryTime>'),estimate=pkg('<ScheduledDeliveryTimeMax>'+ts+'</ScheduledDeliveryTimeMax>');
 const parse=(content,seller='ogjewelers')=>deliveryResults('<GetOrdersResponse><Ack>Success</Ack><Order><OrderID>'+id+'</OrderID><SellerUserID>'+seller+'</SellerUserID>'+content+'</Order></GetOrdersResponse>',[id],'ogjewelers');
 assert.equal(parse(line(actual)+line(actual)).get(id),'2026-01-02T12:00:00.000Z');
 for(const xml of [line(''),line(estimate),line(actual+estimate),line(actual)+line('')])assert.equal(parse(xml).get(id),null);
 assert.equal(parse(line(actual),'another-shop').size,0);
});
test('Seller Hub statement requires a full month and a reconciliation to the cent',async()=>{
 const ctx={};runInNewContext(await readFile(file('tools/ebay-og-order-link-extension/report-reader.js'),'utf8'),ctx);
 const chart='Transaction summary for Sep 01, 2026 - Sep 30, 2026\nOpening funds:\n$10.00\nOrders:\n$7.34\nClaims:\n-$1.00\nClosing funds:\n$16.34';
 const s=ctx.InvstoReadStatement(chart);assert.equal(s._month,'2026-09-01');assert.equal(s._movements[1].cents,-100);
 assert.throws(()=>ctx.InvstoReadStatement(chart.replace('$16.34','$16.33')));
 assert.throws(()=>ctx.InvstoReadStatement(chart.replace('Sep 30','Sep 29')));
});
test('the extension reads only a matched seller and order and the passive helper returns normalized facts',async()=>{
 const browser=await chromium.launch();try{
 const page=await browser.newPage();const source=await readFile(file('tools/ebay-og-order-link-extension/report-reader.js'),'utf8'),id='12-12345-12345';
 await page.route('https://www.ebay.com/**',r=>r.fulfill({body:'<a href="https://www.ebay.com/usr/ogjewelers">ogjewelers View profile</a><h2>Delivered on Oct 31</h2><h2>Order</h2><p>'+id+'</p><h2>Payment</h2><p>PRIVATE BUYER ADDRESS</p>',contentType:'text/html'}));
 await page.goto('https://www.ebay.com/mesh/ord/details?orderid='+id);
 await page.evaluate(()=>{window.chrome={runtime:{id:'test',onMessage:{addListener(fn){window.reader=fn;}}}};});
 await page.addScriptTag({content:source});
 const call=id=>page.evaluate(id=>new Promise(r=>window.reader({type:'OG_REPORT_READ',order:id},{id:'test'},r)),id);
 assert.deepEqual(await call(id),{ok:true,observation:{id,heading:'Delivered on Oct 31'}});
 assert.equal((await call('90-12345-12345')).ok,false);
 await page.locator('a').evaluate(e=>e.href='https://www.ebay.com/usr/someoneelse');
 assert.equal((await call(id)).ok,false);
 }finally{await browser.close();}
});
test('closed orders stay watched after disappearing from Seller Hub; only a newer explicit released credit ends the watch',async()=>{
 const db=new PGlite(),id='12-12345-12345';try{
 await db.exec("create role anon;create role authenticated;create role service_role;create schema auth;create schema cron;create function auth.uid() returns uuid language sql as $$select '00000000-0000-4000-8000-000000000001'::uuid$$;create table employees(user_id uuid,active boolean,role text);insert into employees values(auth.uid(),true,'admin');create function cron.schedule(text,text,text) returns int language sql as $$select 1$$;create table ebay_orders(order_number text primary key,raw_payload jsonb);create table ebay_account_holds(singleton boolean,entries jsonb,verified_at timestamptz,api_at timestamptz,api_cents bigint,ledger_cents bigint,next_api_at timestamptz);insert into ebay_account_holds values(true,'[]',now()-interval '1 day',now(),0,0,now());create table weekly_ebay_payment_observations(order_number text,funds text,checked_at timestamptz);create table ebay_finance_jobs(last_checked_at timestamptz,order_id uuid);create table weekly_ebay_account_cash(month date primary key,checked_at timestamptz,source text,opening bigint,closing bigint,movements jsonb);create table weekly_ebay_claim_exports(month date,checked_at timestamptz);create table weekly_ebay_change_cursor(last_success timestamptz);create table weekly_ebay_payout_scan(last_success timestamptz);create table queued(ids text[]);create function enqueue_ebay_finance_jobs(text[],boolean) returns void language sql as $$insert into public.queued values($1)$$;create function weekly_ebay_hold_evidence(jsonb) returns jsonb language sql as $$select '{}'::jsonb$$;create function weekly_ebay_hold_snapshot() returns jsonb language sql as $$select public.weekly_ebay_hold_evidence(e.raw_payload) from public.ebay_orders e$$;create function weekly_ebay_item_payments(date,date,timestamp,jsonb) returns jsonb language sql as $$select public.weekly_ebay_hold_evidence(o.raw) from (select order_number,raw_payload raw from public.ebay_orders) o$$;create function get_weekly_sales_for_market(m date,_market text) returns jsonb language sql as $$select jsonb_build_object('ebay_account_holds',public.weekly_ebay_hold_snapshot())$$;");
 await db.exec(await readFile(file('supabase/migrations/20261101150000_ebay_background_report_refresh.sql'),'utf8'));
 const raw=(state,at,other=id)=>JSON.stringify({ebayFinance:{source:'ebay_finances_api',orderNumber:id,syncedAt:at,transactions:[{orderNumber:other,transactionType:'SALE',bookingEntry:'CREDIT',transactionStatus:state}]}});
 await db.query('insert into ebay_orders values($1,$2)',[id,raw('FUNDS_ON_HOLD','2025-01-01')]);
 await db.exec("update ebay_account_holds set entries='[]',verified_at=now();select maintain_ebay_report_jobs();");
 assert.deepEqual((await db.query('select ids from queued order by array_length(ids,1) desc nulls last limit 1')).rows[0].ids,[id]);
 const active=async()=>(await db.query('select active from ebay_report_watch')).rows[0].active;
 await db.query('update ebay_orders set raw_payload=$1',[raw('FUNDS_AVAILABLE_FOR_PAYOUT','2025-01-02','99-00000-00000')]);assert.equal(await active(),true);
 await db.query('update ebay_orders set raw_payload=$1',[raw('FUNDS_AVAILABLE_FOR_PAYOUT','2024-12-01')]);assert.equal(await active(),true);
 const job=(await db.query('select claim_ebay_browser_reports() j')).rows[0].j;
 assert.deepEqual(job.orders,[id]);assert.equal((await db.query('select claim_ebay_browser_reports() j')).rows[0].j,null);
 await db.query('select finish_ebay_browser_reports($1,$2,$3,null)',[job.ticket,JSON.stringify([{id,heading:'Delivered on Oct 31'}]),'Verified.']);
 assert.equal((await db.query('select ebay_report_delivery($1) d',[id])).rows[0].d.description,'Delivered on Oct 31');
 await db.query('update ebay_orders set raw_payload=$1',[raw('FUNDS_AVAILABLE_FOR_PAYOUT','2025-01-03')]);assert.equal(await active(),false);
 assert.equal((await db.query("select has_function_privilege('anon','finish_ebay_browser_reports(uuid,jsonb,text,text)','execute') ok")).rows[0].ok,false);
 }finally{await db.close();}
});
