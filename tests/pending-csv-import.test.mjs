import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';

const read = path => readFileSync(new URL('../'+path,import.meta.url),'utf8');
const source=read('pending-orders.js');
function fn(source,name,indent='') {
  const start=source.search(new RegExp('^'+indent+'(?:async )?function '+name+'\\(', 'm'));
  assert.ok(start>=0,name);
  const rest=source.slice(start), next=rest.slice(1).search(new RegExp('^'+indent+'(?:async )?function ', 'm'));
  return next<0?rest:rest.slice(0,next+1);
}
const awaiting='https://www.ebay.com/sh/ord/?filter=status:AWAITING_SHIPMENT';
const all='https://www.ebay.com/sh/ord/?filter=status:ALL_ORDERS';
function app() {
  const ctx={URL,console,state:{user:{id:'staff'}},parseMoney:value=>Number(value)||0,
    CLOSED_EBAY_IMPORT_STATUSES:new Set(['fulfilled','cancelled','archived'])};
  vm.createContext(ctx);
  for(const name of ['parseCsv','rowsFromEbayCsv','normalizeCsvHeader','csvCell','parseEbayDate','isEbayDateOnly',
    'toNumber','estimateEbayPayoutFromRow','buildOrderImportPayload','isClosedEbayImportStatus','buildCompletedHistoryConflict',
    'isVerifiedAwaitingShipmentReportUrl','pendingReportRowIsNotAwaiting','validatePendingOrderReport','importEbayPendingOrdersReport']) {
    vm.runInContext(fn(source,name),ctx);
  }
  return ctx;
}
test('only the active awaiting filter qualifies, even when every page contains Awaiting shipment navigation',()=>{
  const ctx=app();
  const content=read('tools/ebay-og-order-link-extension/content.js');
  const background=read('tools/ebay-og-order-link-extension/background.js');
  const ext={URL,window:{location:{}},getPageTextSample:()=> 'Manage orders Awaiting shipment All orders',
    getDownloadReportButton:()=>true, normalizeUrl:value=>{try{return new URL(value);}catch{return null;}}};
  vm.createContext(ext);
  vm.runInContext(fn(content,'isAwaitingShipmentOrdersPage','  '),ext);
  vm.runInContext(fn(background,'isAwaitingShipmentTab','  '),ext);
  for(const [url,expected] of [[awaiting,true],[awaiting.replace(':','%3A'),false],
    ['https://www.ebay.com/sh/ord/?filter=status%3AAWAITING_SHIPMENT',true],
    [awaiting+',range:90days',true],[all,false],[all+'#AWAITING_SHIPMENT',false],
    [all+'&q=AWAITING_SHIPMENT',false],[awaiting+'&filter=status:ALL_ORDERS',false],
    [awaiting+',status:ALL_ORDERS',false],['https://www.ebay.com/sh/ord/',false],
    [awaiting.replace('www.ebay.com','www.ebay.com.evil.test'),false],['',false]]) {
    assert.equal(ctx.isVerifiedAwaitingShipmentReportUrl(url),expected,url);
    assert.equal(ext.isAwaitingShipmentTab({url,title:'Awaiting shipment'}),expected,url);
    if(url.startsWith('https://')){ext.window.location.href=url;assert.equal(ext.isAwaitingShipmentOrdersPage(),expected,url);}
  }
});
const csv=shipped=>`Order Number,Item Title,Item Number,Transaction ID,Quantity,Sale Date,Shipped On Date\n01-11111-11111,Ring,123,456,1,Aug-02-26,${shipped}\n`;
test('All orders, unknown extension sources and historical manual files fail before any database call',async()=>{
  const ctx=app();let calls=0;
  ctx.loadExistingOrdersByNumber=async()=>{calls++;throw new Error('Unexpected database call');};
  for(const [text,metadata] of [[csv(''),{source:'ebay-awaiting-shipment-report',pageUrl:all}],
    [csv(''),{source:'ebay-awaiting-shipment-report'}],
    [csv('Aug-03-26'),{}],[csv('bad shipped date'),{}],
    [csv('')+'02-22222-22222,Chain,456,789,1,Jul-01-26,Jul-02-26\n',{}]]) {
    await assert.rejects(ctx.importEbayPendingOrdersReport(text,metadata),/Report not imported/);
  }
  assert.equal(calls,0);
  assert.equal(ctx.pendingReportRowIsNotAwaiting({'Shipped on date':'Jul-03-26'}),true);
  assert.equal(ctx.pendingReportRowIsNotAwaiting({'Order Status':'Refunded'}),true);
  assert.equal(ctx.pendingReportRowIsNotAwaiting({'Shipped On Date':'--'}),false);
});
test('valid old pending orders remain importable, while existing closed orders stay closed',async()=>{
  const ctx=app(),writes=[];
  ctx.parseAwaitingSummaryTotal=()=>0;
  ctx.loadExistingPendingLineIdentityIndex=async()=>({exact:new Set(),fallback:new Set()});
  ctx.getPendingLineExactKey=line=>line.item_number;
  ctx.getPendingLineFallbackKey=line=>line.item_title;
  ctx.rememberPendingLineIdentity=()=>{};
  ctx.supabase={from:table=>({insert:rows=>{writes.push({table,rows});return {select:async()=>({data:rows.map((r,i)=>({...r,id:'id-'+i}))})};},
    upsert:rows=>{writes.push({table,rows});return {select:async()=>({data:rows})};}})};
  ctx.loadExistingOrdersByNumber=async()=>new Map();
  let result=await ctx.importEbayPendingOrdersReport(csv(''),{source:'ebay-awaiting-shipment-report',pageUrl:awaiting});
  assert.equal(result.newOrdersAdded,1);assert.equal(result.newLinesAdded,1);
  assert.equal(writes[0].rows[0].status,'pending');assert.equal(writes[1].rows[0].line_status,'pending');
  writes.length=0;
  ctx.loadExistingOrdersByNumber=async()=>new Map([['01-11111-11111',{id:'closed',status:'fulfilled'}]]);
  result=await ctx.importEbayPendingOrdersReport(csv(''),{pageUrl:awaiting});
  assert.equal(result.completedHistoryConflictCount,1);assert.equal(writes.length,0);
});

test('database protects old clients, aborts entire mixed inserts, preserves API imports and completed history',async()=>{
  const db=new PGlite();
  try {
    await db.exec(`create table public.ebay_orders(id uuid primary key, status text, shipped_on_date timestamptz,raw_payload jsonb);
      create table public.ebay_order_lines(id uuid primary key,order_id uuid references public.ebay_orders,line_status text,raw_payload jsonb);`);
    await db.exec(read('supabase/migrations/20261006223000_guard_pending_csv_imports.sql'));
    for(const [url,expected] of [[awaiting,true],[all,false],[awaiting.replace('status:','status%3A'),true],
      [awaiting+'&filter=status:ALL_ORDERS',false],[awaiting+',status:ALL_ORDERS',false],['',false]]) {
      assert.equal((await db.query('select public.is_awaiting_shipment_report_url($1) as ok',[url])).rows[0].ok,expected,url);
    }
    const payload=(url=awaiting,row={})=>({source:'ebay_orders_report_csv',first_row:row,import_metadata:{source:'ebay-awaiting-shipment-report',sourcePageUrl:url}});
    const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
    const insert=(n,p,shipped=null,status='pending')=>db.query('insert into ebay_orders values($1,$2,$3,$4)',[id(n),status,shipped,JSON.stringify(p)]);
    await assert.rejects(insert(1,payload(all)),/All orders reports are blocked/);
    await assert.rejects(insert(1,payload('')),/All orders reports are blocked/);
    await assert.rejects(insert(1,payload(awaiting,{'Shipped On Date':'Jul-10-26'})),/Already-shipped/);
    await assert.rejects(insert(1,payload(awaiting,{'Payment Status':'FULLY_REFUNDED'})),/Already-shipped/);
    await assert.rejects(insert(1,payload(),'2026-07-10'),/Already-shipped/);
    await assert.rejects(db.query(`insert into ebay_orders values($1,'pending',null,$3),($2,'pending',null,$4)`,
      [id(1),id(2),JSON.stringify(payload()),JSON.stringify(payload(all))]),/All orders reports are blocked/);
    assert.equal((await db.query('select count(*)::int as n from ebay_orders')).rows[0].n,0);
    await insert(1,payload());await insert(2,{source:'ebay_fulfillment_api'});
    await insert(3,payload(all),null,'fulfilled');
    await assert.rejects(db.query("update ebay_orders set status='pending' where id=$1",[id(3)]),/cannot reopen/);
    const row={'Order Number':'test','Item Title':'Ring','Shipped On Date':''};
    await db.query('insert into ebay_order_lines values($1,$2,$3,$4)',[id(1),id(1),'pending',JSON.stringify(row)]);
    await assert.rejects(db.query('insert into ebay_order_lines values($1,$2,$3,$4)',[id(2),id(3),'pending',JSON.stringify(row)]),/completed order/);
    await assert.rejects(db.query('insert into ebay_order_lines values($1,$2,$3,$4)',[id(2),id(1),'pending',JSON.stringify({...row,'Shipped On Date':'invalid but nonempty'})]),/completed order/);
    await db.query("update ebay_order_lines set line_status='fulfilled' where id=$1",[id(1)]);
    await assert.rejects(db.query("update ebay_order_lines set line_status='pending' where id=$1",[id(1)]),/cannot reopen/);
    await db.query("update ebay_orders set status='fulfilled' where id=$1",[id(1)]);
    assert.equal((await db.query('select status from ebay_orders where id=$1',[id(1)])).rows[0].status,'fulfilled');
  } finally {await db.close();}
});
