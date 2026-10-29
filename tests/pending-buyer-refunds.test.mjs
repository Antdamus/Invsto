import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import vm from 'node:vm';
import api from '../pending-buyer-refunds.js';

const order = (id,buyer,raw={}) => ({id,order_number:`order-${id}`,buyer_username:buyer,total_price:100,status:'fulfilled',raw_payload:raw});
const line = (id,buyer) => ({id,order_id:`current-${buyer}`,order:{buyer_username:buyer}});
const paid = {order:{paymentSummary:{refunds:[{refundId:'paid',refundStatus:'REFUNDED',amount:{value:30,currency:'USD'}}]}}};
function fixture() {
  return {orders:[order('old','BuyerA',paid),order('new','BuyerA'),order('open','BuyerB'),order('ledger','BuyerC'),order('clean','BuyerD'),order('closed','BuyerE'),order('mismatch','BuyerF')],
    lines:[{id:'ledger-line',order_id:'ledger',raw_payload:{ebayFinance:{transactions:[{transactionId:'seller',transactionType:'REFUND',transactionStatus:'SUCCEEDED',amount:{value:28,currency:'USD'}}]}}}],
    returnCases:[{id:'request',order_id:'open',buyer_username:'BuyerB',source_lane:'return',status:'open',ebay_status:'RETURN_REQUESTED'},
      {id:'additional',order_id:'new',buyer_username:'BuyerA',source_lane:'return',status:'open',ebay_status:'RETURN_REQUESTED'},
      {id:'closed-case',order_id:'closed',buyer_username:'BuyerE',source_lane:'return',status:'closed',ebay_status:'CLOSED'},
      {id:'wrong-buyer',order_id:'mismatch',buyer_username:'AnotherBuyer',source_lane:'return',ebay_return_id:'123',status:'closed',ebay_status:'REFUNDED',raw_payload:{ebayReturnId:'123',ebayDetail:{returnId:'123',refundInfo:{actualRefundDetail:{refundStatus:'SUCCESS',actualRefund:{totalAmount:{value:100,currency:'USD'}}}}}}}]};
}
function harness(read=async()=>fixture()) {
  const elements = new Map(['buyer-refund-filter','order-sort','buyer-refund-refresh','buyer-refund-status'].map(id=>[id,{value:id==='order-sort'?'created_asc':'all',dataset:{},events:{},addEventListener(name,fn){this.events[name]=fn;}}]));
  let lines = [line('a1','BuyerA'),line('a2','BUYERA'),line('b','BuyerB'),line('c','BuyerC'),line('d','BuyerD'),line('e','BuyerE'),line('f','BuyerF')],changes=0;
  const controller = api.createController({client:{},getLines:()=>lines,onChange:()=>changes++,document:{getElementById:id=>elements.get(id)},read});
  controller.init();
  return {controller,elements,setLines:value=>lines=value,lines,changes:()=>changes};
}

test('closed order refunds identify buyers while preserving every current order in their bundle',async()=>{
  const {controller,elements,lines}=harness();
  elements.get('buyer-refund-filter').value='confirmed';
  await controller.ensure();
  assert.deepEqual(controller.filter(lines).map(row=>row.id),['a1','a2']);
  const summary=controller.snapshot().records.get('buyera');
  assert.equal(summary.confirmed,1);assert.equal(summary.requested,1);
  assert.match(controller.badge('BuyerA'),/1 refunded order · 1 request \/ pending/);
  assert.match(controller.badge('BuyerA'),/ebay-buyer-report.html\?buyer=BuyerA/);
  elements.get('buyer-refund-filter').value='requested';
  assert.deepEqual(controller.filter(lines).map(row=>row.id),['a1','a2','b']);
});

test('seller ledger debits and mismatched buyers need verification; closed cases alone are not refunds',()=>{
  const summaries=api.summarize(fixture(),['BuyerA','BuyerB','BuyerC','BuyerD','BuyerE','BuyerF','missing']);
  assert.equal(summaries.get('buyera').category,'confirmed');
  assert.equal(summaries.get('buyerb').category,'requested');
  assert.equal(summaries.get('buyerc').category,'verification');
  assert.equal(summaries.get('buyerc').confirmed,0);
  assert.equal(summaries.get('buyerd').category,'none');
  assert.equal(summaries.get('buyere').category,'none');
  assert.equal(summaries.get('buyerf').category,'verification');
  assert.equal(summaries.get('buyerf').confirmed,0);
  assert.equal(summaries.get('missing').category,'unknown');
});

test('history is lazy, cached, and rechecked after queue refresh once enabled',async()=>{
  let calls=0;
  const {controller,elements}=harness(async()=>{calls++;return fixture();});
  await controller.queueChanged();assert.equal(calls,0);
  elements.get('order-sort').value='refund_history';controller.sortChanged();
  await controller.ensure();assert.equal(calls,1);
  await controller.ensure();assert.equal(calls,1);
  await controller.queueChanged();assert.equal(calls,2);
});

test('loading, missing usernames, and failed history reads never pass the no-refunds filter',async()=>{
  let release;
  const {controller,elements,lines}=harness(()=>new Promise(resolve=>release=resolve));
  elements.get('buyer-refund-filter').value='none';
  const task=controller.ensure();assert.deepEqual(controller.filter(lines),[]);
  release(fixture());await task;
  assert.deepEqual(controller.filter([...lines,line('missing','')]).map(row=>row.id),['d','e']);
  const failed=harness(async()=>{throw new Error('Permission denied');});
  failed.elements.get('buyer-refund-filter').value='none';await failed.controller.ensure();
  assert.equal(failed.controller.snapshot().status,'error');
  assert.deepEqual(failed.controller.filter(failed.lines),[]);
  assert.match(failed.controller.emptyMessage(),/retry/);
});

test('an old in-flight read cannot overwrite a refreshed queue',async()=>{
  const releases=[];
  const {controller,setLines}=harness(()=>new Promise(resolve=>releases.push(resolve)));
  const old=controller.ensure();setLines([line('d','BuyerD')]);
  const fresh=controller.queueChanged();
  releases[1](fixture());await fresh;
  releases[0](fixture());await old;
  assert.deepEqual([...controller.snapshot().records.keys()],['buyerd']);
});

test('grouping has one heading per category and uses deterministic category order',async()=>{
  const {controller,elements}=harness();await controller.ensure();
  elements.get('order-sort').value='refund_history';
  const groups=['BuyerD','BuyerC','BuyerB','BuyerA'].map(buyer=>({buyer})).sort(controller.compare);
  assert.deepEqual(groups.map(row=>row.buyer),['BuyerA','BuyerB','BuyerC','BuyerD']);
  assert.match(controller.heading(groups[0],0,groups),/completed refunds/);
  assert.equal(controller.heading(groups[0],1,[groups[0],groups[0]]),'');
});

test('exact buyer filters escape LIKE wildcards and PostgREST separators',()=>{
  assert.equal(api.buyerOr(['Buyer_1','sale%','a,b"c\\d']),String.raw`buyer_username.ilike."Buyer\\_1",buyer_username.ilike."sale\\%",buyer_username.ilike."a,b\"c\\\\d"`);
});

test('compact history reads paginate all orders and rebuild authoritative return refunds',async()=>{
  const calls=[];
  const rows=Array.from({length:251},(_,i)=>({id:`id-${i}`,order_number:`o-${i}`,buyer_username:'Buyer_1',total_price:100}));
  const caseRow={id:'case',order_id:'id-250',buyer_username:'BUYER_1',source_lane:'return',ebay_return_id:'r',status:'closed',ebay_status:'CLOSED',provider_return_id:'r',detail_return_id:'r',summary_return_id:'r',actual_refund:{refundStatus:'SUCCESS',actualRefund:{totalAmount:{value:100,currency:'USD'}}}};
  const client={from(table){const query={table,ids:null,select(columns){this.columns=columns;return this;},or(value){this.orValue=value;return this;},in(column,ids){this.ids=ids;return this;},order(){return this;},async range(start,end){calls.push({...this,start,end});
    const data=table==='ebay_orders'?rows:table==='ebay_order_lines'?[]:!this.ids||this.ids.includes('id-250')?[caseRow]:[];
    return {data:data.slice(start,end+1)};}};return query;}};
  const records=await api.loadRecords(client,['BUYER_1']);
  assert.equal(records.orders.length,251);assert.equal(records.returnCases.length,1);
  assert.equal(api.summarize(records,['buyer_1']).get('buyer_1').confirmed,1);
  assert.equal(calls.filter(call=>call.table==='ebay_orders').length,2);
  assert.ok(calls.every(call=>!/(^|,)raw_payload(,|$)/.test(call.columns)),'do not download full evidence payloads');
});

test('pending queue integration filters before grouping and keeps due dates within refund groups',async()=>{
  const source=await readFile(new URL('../pending-orders.js',import.meta.url),'utf8');
  const {controller,elements,lines}=harness();await controller.ensure();elements.get('order-sort').value='refund_history';
  const context=vm.createContext({console,window:{addEventListener(){},location:{search:''},OGPendingBuyerRefunds:controller},document:{addEventListener(){},getElementById:id=>elements.get(id)}});
  vm.runInContext(source,context);
  context.groups=[{buyer:'BuyerD',nextShipBy:'2026-01-01'},{buyer:'BuyerA',nextShipBy:'2026-02-01'},{buyer:'BuyerB',nextShipBy:'2026-01-01'}];
  assert.equal(vm.runInContext('sortBuyerGroups(groups).map(group=>group.buyer).join(",")',context),'BuyerA,BuyerB,BuyerD');
  vm.runInContext('renderOrderDueFilters=renderSummaryStrip=renderCancellationReviewIndicator=renderAdminOrderActions=renderLiveLotOrderMatches=renderOrders=()=>{};getOrderDeadlineSignature=()=>"";',context);
  context.lines=lines;vm.runInContext('state.orders=lines',context);elements.get('buyer-refund-filter').value='confirmed';
  vm.runInContext('applyOrderFilters()',context);
  assert.equal(vm.runInContext('state.filteredOrders.map(line=>line.id).join(",")',context),'a1,a2');
});
