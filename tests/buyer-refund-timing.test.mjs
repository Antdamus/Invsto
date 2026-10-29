import assert from 'node:assert/strict';
import {test} from 'node:test';
import refunds from '../buyer-report-refunds.js';
import report from '../ebay-buyer-report.js';
const payment=at=>({order:{paymentSummary:{refunds:[{refundId:'r',refundStatus:'REFUNDED',refundDate:at,amount:{value:100,currency:'USD'}}]}}});
const order=(raw=payment('2026-10-08T12:00:00Z'))=>({id:'o',order_number:'00-00000-00001',buyer_username:'buyer',total_price:100,raw_payload:raw});
const line=(extra={})=>({id:'l',order_id:'o',item_title:'Test watch',quantity:1,sold_for:100,line_status:'fulfilled',fulfilled_at:'2026-10-02T12:00:00Z',raw_payload:{source:'ebay_fulfillment_api'},...extra});
const data=(o,lines=[line()],cases=[])=>({orders:[o],lines,returnCases:cases,events:[],adminEvents:[]});
const timing=(o,lines,cases)=>refunds.model(data(o,lines,cases)).orders[0].timing;

test('an issued refund after a real shipment and a refund before shipment are different',()=>{
  const o=order();o.shipped_on_date='2026-10-04T12:00:00Z';
  assert.deepEqual(timing(o).flags,['after_shipment']);
  o.shipped_on_date='2026-10-10T12:00:00Z';assert.deepEqual(timing(o).flags,['before_shipment']);
});
test('a cancellation with recorded unshipped status is distinct even without a refund date',()=>{
  const o=order({orderPaymentStatus:'FULLY_REFUNDED',orderFulfillmentStatus:'NOT_STARTED'});o.status='cancelled';
  assert.deepEqual(timing(o,[line({line_status:'cancelled'})]).flags,['before_shipment']);
  o.status='fulfilled';assert.deepEqual(timing(o).flags,['timing_unknown'],'NOT_STARTED alone is not proof of a cancellation before shipment');
});
test('original request date takes precedence over a later refund payment',()=>{
  const o=order();o.shipped_on_date='2026-10-04T12:00:00Z';
  const c={id:'c',order_id:'o',ebay_return_id:'r',source_lane:'return',status:'closed',ebay_status:'CLOSED',raw_payload:{ebayReturnId:'r',apiExtractedDetails:{requestedAt:'2026-10-01T12:00:00Z'},ebayDetail:{returnId:'r',refundInfo:{actualRefundDetail:{refundStatus:'SUCCESS',actualRefund:{totalAmount:{value:100,currency:'USD'}},refundIssuedDate:{value:'2026-10-08T12:00:00Z'}}}}}};
  assert.deepEqual(timing(o,[line()], [c]).flags,['before_shipment']);
  assert.equal(timing(o,[line()],[c]).events[0].kind,'Request opened');
});
test('system completion is not proof of shipment, and canceled lines are not packed lines',()=>{
  assert.deepEqual(timing(order()).flags,['after_completion']);
  assert.deepEqual(timing(order(),[line({line_status:'cancelled'})]).flags,['timing_unknown']);
  assert.deepEqual(timing(order(),[line(),line({id:'unpacked',line_status:'pending',fulfilled_at:null})]).flags,['timing_unknown']);
});
test('legacy imported purchase/completion and last-modified shipment dates cannot prove shipment',()=>{
  const o=order({...payment('2026-10-08T12:00:00Z'),source:'ebay_account_history_sync'});o.shipped_on_date='2026-10-04T12:00:00Z';
  assert.deepEqual(timing(o,[line({raw_payload:{source:'ebay_account_history_sync',history_date_corrected_at:'2026-10-20T12:00:00Z'}})]).flags,['timing_unknown']);
  o.raw_payload.order.shippingFulfillment={shippedDate:'2026-10-04T12:00:00Z'};
  assert.deepEqual(timing(o,[line({raw_payload:{source:'ebay_account_history_sync'}})]).flags,['after_shipment']);
});
test('case import time, label creation and latest status alone cannot invent a shipment timeline',()=>{
  const o=order({orderFulfillmentStatus:'FULFILLED'});o.status='fulfilled';o.label_metadata={createdAt:'2026-10-01T12:00:00Z'};
  const c={id:'c',order_id:'o',source_lane:'return',status:'open',ebay_status:'RETURN_REQUESTED',opened_at:'2026-10-10T12:00:00Z',raw_payload:{}};
  assert.deepEqual(timing(o,[line()],[c]).flags,['timing_unknown']);
});
test('date-only shipments and partial shipments are not ordered within ambiguous time ranges',()=>{
  const o=order(payment('2026-10-04T15:00:00Z'));o.shipped_on_date='2026-10-04T12:00:00Z';o.raw_payload.date_precision={shipped_on_date:'day'};
  assert.deepEqual(timing(o).flags,['timing_unknown']);
  o.raw_payload=payment('2026-10-08T12:00:00Z');o.raw_payload.orderFulfillmentStatus='IN_PROGRESS';
  assert.deepEqual(timing(o).flags,['timing_unknown']);
});
test('separate requests before and after shipment retain both timings, counted once each per order',()=>{
  const o=order();o.shipped_on_date='2026-10-04T12:00:00Z';
  const cases=['2026-10-01T12:00:00Z','2026-10-08T12:00:00Z'].map((at,i)=>({id:`c-${i}`,order_id:'o',source_lane:'return',status:'open',ebay_status:'RETURN_REQUESTED',raw_payload:{requestedAt:at}}));
  const f=refunds.model(data(o,[line()],cases));
  assert.deepEqual(f.orders[0].timing.flags,['before_shipment','after_shipment']);
  assert.equal(refunds.timingCounts(f).before_shipment,1);assert.equal(refunds.timingCounts(f).after_shipment,1);
});
test('reports expose timing and supporting dates without changing refund totals',()=>{
  const o=order();o.shipped_on_date='2026-10-04T12:00:00Z';const records=data(o),f=refunds.model(records);
  assert.equal(f.totals[0].refunds,10000);assert.equal(f.totals[0].net,0);
  const text=refunds.detailLines(f.orders[0]).join('\n');
  assert.match(text,/Refund \/ cancellation timing: After shipment/);assert.match(text,/Recorded shipment: Oct 4, 2026/);assert.match(text,/Refund issued: Oct 8, 2026/);
  assert.match(report.renderReport('buyer',records,report.buildRows(records,'https://example.test/')),/1 after shipment; 0 before shipment/);
});
