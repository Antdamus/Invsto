import test from 'node:test';
import assert from 'node:assert/strict';
import '../ebay-performance-model.js';
import '../ebay-refund-analysis.js';
import {requestorPage,discoverRefundOrders} from '../supabase/functions/ebay-order-sync/cancellation-actors.ts';
const M=globalThis.EbayPerformance,F=globalThis.EbayRefundAnalysis,oid='01-12345-67890';
const p={start:'2026-10-01',end:'2026-10-31'},o={id:oid,buyer:'buyer',purchased:'2026-09-20T19:00Z',paid:true,status:'Canceled',items:[{id:'i'}]};
const c={id:'11',linked_order:oid,buyer:'buyer',items:['i'],reason:'Buyer requested',requested:'2026-10-05'};
const refund={order_id:oid,reference:'Return ID 33',day:'2026-10-05',gross:1500,net:1200};
test('posting and purchase periods, requestor and refund issuer, and case rulings stay distinct',()=>{
 const data={orders:[o],cases:[c],payments:[refund],evidence:{requests:[{oid,id:'11',actor:'SELLER',requested_at:'2026-10-05T17:00Z'}],
  payment_times:{[oid]:'2026-10-06T17:00Z'},cases:[{oid,id:'44',decided:true},{oid,id:'45',decided:true}],
  returns:[{oid,id:'33',history:[{action:'SELLER_ISSUE_REFUND',actor:'SELLER',date:'2026-10-05T18:00Z'}]}],
  older_refunds:[{...refund,order_id:'other',reference:'Refund ID 55'}]}};
 const idx=F.index(data,M.index(data)),activity=F.summarize(idx,p,'activity');
 assert.equal(F.summarize(idx,p,'purchase').refunds.length,0);
 assert.deepEqual([activity.old,activity.unknown,activity.oldGross,activity.gross,activity.rulings.size],[1,1,1500,3000,1]);
 assert.deepEqual([activity.cases[0].actor,activity.cases[0].timing,activity.refunds[0].actor,activity.refunds[1].actor],['Seller','Requested before payment','Seller','Unverified']);
 data.evidence.returns[0].history.push({action:'SYSTEM_INITIATED_REFUND',actor:'SYSTEM',date:'2026-10-04T18:00Z'});
 assert.equal(F.index(data,M.index(data)).refunds[0].actor,'Unverified');
 data.evidence.requests=[];data.evidence.payment_times[oid]='2026-10-05T13:00Z';
 assert.equal(F.index(data,M.index(data)).cases[0].timing,'Same day · sequence unknown');
});
test('account-wide reads verify completeness, do not infer an actor and never treat claim signals as refund dollars',async()=>{
 const now=Date.parse('2026-11-02T12:00Z');
 const rows=await requestorPage('2026-10-01',async p=>{assert.equal(p.get('role'),'SELLER');return {paginationOutput:{offset:1,totalEntries:'2'},cancellations:[{cancelId:'1',requestorType:'SELLER'},{cancelId:'2'}]};},now);
 assert.deepEqual(rows.map(r=>r.actor),['SELLER']);
 await assert.rejects(requestorPage('2026-10-01',async()=>({total:1,cancellations:[]}),now));
 assert.deepEqual(await discoverRefundOrders('2026-10-01',async path=>{
  const filters=new URL(path,'https://example.test').searchParams.getAll('filter');assert.equal(filters.length,2);
  return {total:1,transactions:[{orderId:oid,transactionType:'REFUND',bookingEntry:'DEBIT',transactionDate:'2026-10-22T12:00Z'}]};
 },now),[{id:oid,posted:'2026-10-22T12:00:00.000Z'}]);
});
test('a late Pacific sale stays in its ledger month even when its Eastern purchase cohort is next month',()=>{
 const data={orders:[{...o,purchased:'2026-10-01T04:30:00Z'}],cases:[],payments:[{...refund,day:'2026-09-30'}]};
 const idx=F.index(data,M.index(data)),t=idx.refunds[0];assert.deepEqual([t.purchase,t.purchaseLocal,t.age],['2026-10-01','2026-09-30',0]);
 assert.equal(F.summarize(idx,p,'purchase').refunds.length,1);assert.equal(F.summarize(idx,p,'activity').refunds.length,0);
});
