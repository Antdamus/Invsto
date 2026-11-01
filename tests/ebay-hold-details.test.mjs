import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import vm from 'node:vm';
import {PGlite} from '@electric-sql/pglite';
import {chromium} from '@playwright/test';
import '../ebay-hold-details.js';
const api=globalThis.OGEbayHoldDetails,id='12-12345-67890',id2='16-12345-67890',file=s=>fileURLToPath(new URL('../'+s,import.meta.url));
const transaction=(memo,over={})=>({orderNumber:id,transactionType:'SALE',bookingEntry:'CREDIT',transactionStatus:'FUNDS_ON_HOLD',memo,...over});
const evidence=(memo='Funds on hold: open return')=>({finance:{source:'ebay_finances_api',orderNumber:id,syncedAt:'2026-11-01T16:30:00Z',transactions:[transaction(memo)]},modified:'2026-10-18T07:38:21Z',payments:[{paymentHolds:[{holdState:'HELD',holdReason:'Reactive_FAD',expectedReleaseDate:'2026-11-28T07:00:00Z',releaseDate:'2026-10-18T07:36:42Z'}]}]});
test('only order-scoped held sale credits explain the hold, not labels, other orders or released transactions',()=>{
 const e=evidence();e.finance.transactions.push(transaction('Wrong shipping memo',{transactionType:'SHIPPING_LABEL',bookingEntry:'DEBIT'}),transaction('Wrong order',{orderNumber:id2}),transaction('Old reason',{transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT'}));
 const m=api.model(id,e,true);assert.deepEqual(m.memos,['Funds on hold: open return']);assert.deepEqual(m.categories,['return']);
 assert.equal(api.model(id,e,false),null);
 assert.deepEqual(m.estimates,['2026-11-28T07:00:00Z']);assert.equal('releaseDate' in m,false);
 assert.match(api.render(m),/Nov 28, 2026, 2:00 AM EST/);assert.match(api.render(m),/may predate/);
 assert.equal(api.category('Funds on Hold'),'unknown');assert.equal(api.category('Estimated release on Nov 3'),'scheduled');assert.equal(api.category('Funds available within 24 hours of order authentication'),'authentication');
 e.finance.transactions=[transaction('',{orderNumber:undefined})];assert.deepEqual(api.model(id,e,true).categories,['unknown']);
 e.finance.transactions=[transaction('Funds available within 2 days of order delivery',{orderNumber:undefined})];assert.deepEqual(api.model(id,e,true).categories,['delivery']);
 e.finance.source='untrusted';assert.deepEqual(api.model(id,e,true).categories,['unknown']);
 e.finance.transactions=[transaction('Funds available within 2 days of order delivery',{transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT'})];assert.equal(api.model(id,e),null,'released finance supersedes an old HELD order record');
 const attack=evidence('<img src=x onerror=alert(1)>');assert.doesNotMatch(api.render(api.model(id,attack,true)),/<img/);
});

test('pending-order selection uses the newest financial snapshot, filters exact orders and counts each order once',async()=>{
 const elements=new Map([['pending-hold-reason',{value:'return',innerHTML:''}]]);
 const context=vm.createContext({console,URL,URLSearchParams,Date,Intl,window:{OGEbayHoldDetails:api,location:{search:''},addEventListener(){}},document:{addEventListener(){},getElementById:id=>elements.get(id)}});
 vm.runInContext(await readFile(file('pending-orders.js'),'utf8'),context);
 const e=evidence(),order={order_number:id,buyer_username:'same-buyer',raw_payload:{order:{paymentSummary:{payments:e.payments}},ebayFinance:e.finance}};
 const lines=[{id:'a',order},{id:'b',order},{id:'c',order:{...order,order_number:id2,raw_payload:{ebayFinance:{...e.finance,orderNumber:id2,transactions:[transaction('Funds available within 2 days of order delivery',{orderNumber:id2})]}}}}];
 assert.deepEqual(context.filterOrderHoldReasons(lines).map(l=>l.id),['a','b']);
 assert.match(elements.get('pending-hold-reason').innerHTML,/Open return · 1/);assert.match(elements.get('pending-hold-reason').innerHTML,/Waiting for delivery · 1/);
 assert.match(context.renderGroupHoldReasons(lines),/2 orders with funds on hold/);
 lines[0].raw_payload={ebayFinance:{...e.finance,syncedAt:'2026-10-01T00:00Z',transactions:[transaction('Old explanation')]}};
 assert.deepEqual(api.fromLine(lines[0]).memos,['Funds on hold: open return']);
 order.raw_payload.ebayFinance={...e.finance,syncedAt:'2026-11-02T16:30Z',transactions:[transaction('Released',{transactionStatus:'FUNDS_AVAILABLE_FOR_PAYOUT'})]};
 assert.equal(context.filterOrderHoldReasons(lines).length,0);assert.match(elements.get('pending-hold-reason').innerHTML,/Open return · 0/);
});

test('report includes only hold evidence and account snapshot enrichment leaves verified totals unchanged',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create table ebay_orders(order_number text,raw_payload jsonb);create table ebay_account_holds(singleton bool,entries jsonb,verified_at timestamptz,ledger_cents bigint,next_api_at timestamptz);
 create function weekly_ebay_item_payments(_start date,_end date,_cutoff timestamp,_sales jsonb) returns jsonb language sql as $$select jsonb_build_object('held',o.held,'id',o.order_number) from (select 100 held,order_number,raw_payload raw,'held' fund from ebay_orders) o$$;
 create function get_weekly_sales_for_market(m date,_market text) returns jsonb language sql as $$select (select to_jsonb(h)-'singleton'-'next_api_at' from public.ebay_account_holds h where singleton)$$;`);
 await db.exec(await readFile(file('supabase/migrations/20261101121500_ebay_hold_explanations.sql'),'utf8'));
 const e=evidence(),raw={buyer:{name:'PRIVATE'},ebayFinance:e.finance,order:{lastModifiedDate:e.modified,paymentSummary:{payments:e.payments}}};
 await db.query('insert into ebay_orders values($1,$2)',[id,JSON.stringify(raw)]);
 await db.query('insert into ebay_account_holds values(true,$1,now(),10000,now())',[JSON.stringify([{kind:'sale',oid:id,cents:10000},{kind:'return',oid:id,ref:'123',cents:3000}])]);
 const report=(await db.query("select weekly_ebay_item_payments('2026-10-01','2026-11-01',now()::timestamp,'[]') v")).rows[0].v;
 assert.deepEqual(api.model(id,report.hold_detail,true).memos,['Funds on hold: open return']);assert.doesNotMatch(JSON.stringify(report),/PRIVATE/);
 const snap=(await db.query("select get_weekly_sales_for_market('2026-10-01','ebay') v")).rows[0].v;
 assert.equal(snap.ledger_cents,10000);assert.equal(snap.entries[0].cents,10000);assert.equal(snap.entries[1].hold_detail,undefined);
 assert.deepEqual(api.model(id,snap.entries[0].hold_detail,true).categories,['return']);
 assert.equal((await db.query("select has_function_privilege('authenticated','weekly_ebay_hold_evidence(jsonb)','execute') ok")).rows[0].ok,false);
 }finally{await db.close();}
});

test('phone report shows reasons, keeps a reason filter through refresh and removes released orders',async()=>{
 const b=await chromium.launch();try{
 const p=await b.newPage({viewport:{width:390,height:844}});
 await p.setContent('<style>body{margin:12px;background:#101b15;color:#f5f3eb;font-family:Arial;--dash-muted:#b6c4ba;--dash-line:#35463b;--dash-gold:#efd38d}button,select,input{font:inherit}</style><section id="items" class="wi-panel"></section><section id="holds" class="wh-panel"></section>');
 for(const css of ['weekly-marketplace-sales.css','ebay-hold-details.css'])await p.addStyleTag({path:file(css)});
 for(const js of ['ebay-hold-details.js','weekly-ebay-items.js','weekly-ebay-holds.js'])await p.addScriptTag({path:file(js)});
 const order=(n,e)=>({id:n,week:'2026-10-12',date:'2026-10-18T07:36:00Z',fund:'held',buyer:'paid',credit:125,held:125,hold_detail:e,items:[{title:'10K SOLID GOLD',sold:125,kept:125,credit:125,qty:1}]});
 const d={month:'2026-10-01',rows:[{market:'ebay',week:'2026-10-12',first_day:'2026-10-12',end_day:'2026-10-19'}],ebay_item_orders:[order(id,evidence()),order(id2,{finance:{...evidence().finance,orderNumber:id2,transactions:[transaction('Funds available within 2 days of order delivery',{orderNumber:id2})]}})],ebay_account_holds:{verified_at:'2026-11-01T17:00Z',ledger_cents:25000,entries:[{kind:'sale',oid:id,ref:id,cents:12500,date:'2026-10-18',placed:'2026-10-18',hold_detail:evidence()},{kind:'return',oid:id2,ref:'12345678',cents:12500,date:'2026-10-18',placed:'2026-10-20'}]}};
 const draw=()=>p.evaluate(d=>{WeeklyEbayItems.update(document.querySelector('#items'),d);WeeklyEbayHolds.update(document.querySelector('#holds'),d);},d);await draw();
 await p.locator('.wi-browser>summary').click();await p.locator('.wi-hold-reason').selectOption('return');
 assert.equal(await p.locator('.wi-order').count(),1);assert.match(await p.locator('.wi-order').innerText(),/Funds on hold: open return/);
 await p.locator('.wi-order .ebay-hold-detail summary').click();assert.match(await p.locator('.wi-order').innerText(),/2:00 AM EST/);
 await draw();assert.equal(await p.locator('.wi-hold-reason').inputValue(),'return');assert.equal(await p.locator('.wi-order').count(),1);
 await p.locator('.wh-browser>summary').click();await p.locator('.wh-reason').selectOption('return');assert.equal(await p.locator('.wh-list article').count(),2);
 assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 if(process.env.HOLD_PREVIEW)await p.locator('.wi-order').screenshot({path:process.env.HOLD_PREVIEW});
 d.ebay_item_orders[0].fund='available';await draw();assert.equal(await p.locator('.wi-order').count(),0);assert.equal(await p.locator('.wi-hold-reason').inputValue(),'return');
 await p.locator('.wi-total [data-bucket="released"]').click();assert.equal(await p.locator('.wi-hold-reason').inputValue(),'all');assert.equal(await p.locator('.wi-order .ebay-hold-detail').count(),0);
 }finally{await b.close();}
});
