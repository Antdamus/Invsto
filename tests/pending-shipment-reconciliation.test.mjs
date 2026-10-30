import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {PGlite} from '@electric-sql/pglite';
import {stripTypeScriptTypes} from 'node:module';
import vm from 'node:vm';
import ui from '../pending-shipment-evidence.js';
const sql=readFileSync(new URL('../supabase/migrations/20261030140000_pending_shipping_reconciliation.sql',import.meta.url),'utf8').split('-- Fetch the requested lines once')[0];
const note='Done by valentine and verified by otello';
const lineId='11111111-1111-4111-8111-111111111111', orderId='22222222-2222-4222-8222-222222222222';
const shipment={trackingNumber:'9400108106244699797482',fulfillmentId:'fulfillment-a',ebayLineItemId:'txn-a',carrier:'USPS',shippedAt:'2026-10-30T08:30:27Z'};
const entry={lineId,orderId,orderNumber:'07-15355-54309',shipments:[shipment]};
test('atomic reconciliation preserves local workflow, exact line scope, existing labels and audit idempotency',async()=>{
 const db=new PGlite();
 try {
 await db.exec(`create role anon; create role authenticated; create role service_role; create schema auth;
 create function auth.uid() returns uuid language sql as $$ select null::uuid $$;
 create function auth.role() returns text language sql as $$ select current_setting('test.role',true) $$;
 set test.role='service_role';
 create table public.ebay_orders(id uuid primary key,order_number text,status text,raw_payload jsonb,label_metadata jsonb,tracking_number text,updated_at timestamptz);
 create table public.ebay_order_lines(id uuid primary key,order_id uuid,transaction_id text,line_status text,raw_payload jsonb,updated_at timestamptz);
 insert into ebay_orders values('${orderId}','07-15355-54309','pending','{"keep":"order","ebayFinance":{"status":"paid"}}','{"trackingNumber":"old","trackingNumbers":["old"],"labelFile":"keep.pdf"}','old',now());
 insert into ebay_order_lines values('${lineId}','${orderId}','txn-a','pending','{"keep":"line"}',now()),
 ('33333333-3333-4333-8333-333333333333','${orderId}','txn-b','pending','{}',now());`);
 await db.exec(sql);
 const call=(entries=[entry],id='44444444-4444-4444-8444-444444444444')=>db.query('select record_ebay_shipping_reconciliation($1,$2,$3,$4,$5) result',[id,'2026-10-30T03:00Z','2026-10-30T12:00Z',note,JSON.stringify(entries)]);
 // A failure later in a batch rolls back its earlier line.
 await assert.rejects(call([entry,{...entry,lineId:'33333333-3333-4333-8333-333333333333'}]),/does not match/);
 assert.equal((await db.query('select raw_payload from ebay_order_lines where id=$1',[lineId])).rows[0].raw_payload.shipping_reconciliation,undefined);
 assert.equal((await call()).rows[0].result.lines,1);
 const l=(await db.query('select * from ebay_order_lines where id=$1',[lineId])).rows[0];
 const o=(await db.query('select * from ebay_orders')).rows[0];
 assert.equal(l.line_status,'pending');assert.equal(o.status,'pending');assert.equal(l.raw_payload.keep,'line');
 assert.equal(l.raw_payload.shipping_reconciliation.note,note);
 assert.equal(o.raw_payload.ebayFinance.status,'paid');assert.equal(o.label_metadata.labelFile,'keep.pdf');
 assert.deepEqual(new Set(o.label_metadata.trackingNumbers),new Set(['old',shipment.trackingNumber]));
 assert.equal((await db.query("select raw_payload from ebay_order_lines where transaction_id='txn-b'")).rows[0].raw_payload.shipping_reconciliation,undefined);
 assert.equal((await call()).rows[0].result.alreadyApplied,true);
 assert.equal((await db.query('select count(*)::int n from ebay_shipping_reconciliation_batches')).rows[0].n,1);
 await assert.rejects(call([{...entry,shipments:[{...shipment,shippedAt:'2026-10-30T02:59:59Z'}]}],'55555555-5555-4555-8555-555555555555'),/time window/);
 await db.exec("set test.role='authenticated'");await assert.rejects(call(),/Service-role/);
 } finally {await db.close()}
});
test('prominent line and group evidence excludes unmarked siblings, safely links tracking, and supports spaced scans',()=>{
 const line={id:lineId,order_id:orderId,raw_payload:{shipping_reconciliation:{note,shipments:[shipment]}},order:{order_number:entry.orderNumber}};
 const sibling={id:'other',order_id:orderId,order:line.order};
 assert.match(ui.lineMarkup(line),/Done by valentine and verified by otello/);
 assert.match(ui.lineMarkup(line),/4:30 AM EDT/);assert.match(ui.lineMarkup(line),/tools.usps.com/);
 assert.equal(ui.lineMarkup(sibling),'');assert.match(ui.groupMarkup([line,sibling]),/1 of 2 pending item lines/);
 assert(ui.matchesTracking(line,'9400 1081 0624 4699 7974 82'));assert(!ui.matchesTracking(sibling,shipment.trackingNumber));
 assert.match(ui.search(line),new RegExp(shipment.trackingNumber));
 assert(!ui.lineMarkup({...line,raw_payload:{shipping_reconciliation:{note:'<img src=x>',shipments:[shipment]}}}).includes('<img'));
 const labelLine={order:{label_metadata:{labelRows:[{trackingNumbers:['SAVEDTRACK']} ]}}};
 assert(ui.matchesTracking(labelLine,'SAVEDTRACK'));
});
test('shipment inspection only reads explicitly saved order numbers and reports API failures',async()=>{
 const ctx={};vm.createContext(ctx);
 vm.runInContext(stripTypeScriptTypes(readFileSync(new URL('../supabase/functions/ebay-order-sync/shipments.ts',import.meta.url),'utf8').replace('export async function','async function')),ctx);
 const paths=[];const db={from(){return{select(){return{in:async()=>({data:[{order_number:entry.orderNumber}]})}}}}};
 const result=await ctx.inspectShippingFulfillments(db,{orderIds:[entry.orderNumber]},async path=>{paths.push(path);return path.endsWith('shipping_fulfillment')?{fulfillments:[{lineItems:[{lineItemId:'txn-a'}]}]}:{orderFulfillmentStatus:'FULFILLED',lineItems:[]}});
 assert.equal(result.readOnly,true);assert.equal(result.results.length,1);assert.equal(paths.length,2);
 const unknown=await ctx.inspectShippingFulfillments(db,{orderIds:['99-99999-99999']},()=>{throw Error('must not call')});assert.equal(unknown.ok,false);
 await assert.rejects(ctx.inspectShippingFulfillments(db,{orderIds:['../secret']},()=>{}),/explicit eBay/);
});
