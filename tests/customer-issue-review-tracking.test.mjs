import {test} from 'node:test';
import assert from 'node:assert/strict';
import T from '../customer-issue-review-tracking.js';
import M from '../customer-issue-review-model.js';
const base='https://antdamus.github.io/Invsto/customer-issue-review-report.html';
test('saved label metadata supplies missing order tracking and eBay case delivery is attributed to its source',()=>{
 const m={case:{source_lane:'case',ebay_return_id:'CASE',synced_at:'2026-10-31T04:00Z',raw_payload:{ebayDetail:{caseId:'CASE',caseHistoryDetails:{shipmentTrackingDetails:{trackingNumber:'940001234567890',currentStatus:'DELIVERED',estimateFromDate:{value:'2026-09-29'}}}}}},orders:[{id:'order',order_number:'01-12345-12345',tracking_number:'',label_metadata:{trackingNumber:'940001234567890',carrier:'USPS',capturedAt:'2026-09-29T15:00Z'}}],lines:[{id:'line',order_id:'order'}],order_line_count:1};
 const [entry]=T.build([m],[{id:'line',orderId:'order'}],base);assert.equal(entry.code,'940001234567890');assert.equal(entry.status,'Delivered');assert.equal(entry.statusSource,'eBay case tracking');assert.match(entry.url,/tools.usps.com/);assert.match(entry.historyUrl,/orderHistorySearch=940001234567890/);assert.equal(entry.events.length,2);assert(entry.events.every(e=>e.at!=='2026-09-29'),'estimated delivery date is not a carrier scan');
});
test('labels for other item lines are excluded and return tracking stays separate',()=>{
 const m={case:{return_tracking_number:'940001111111111'},orders:[{id:'order',label_file_path:'other.pdf',label_metadata:{trackingNumber:'940009999999999'}}],lines:[{id:'line',order_id:'order',raw_payload:{shipping_reconciliation:{shipments:[{trackingNumber:'940001111111111'}]}}}],label_events:[{order_line_ids:['other'],label_file_path:'other.pdf',label_metadata:{trackingNumber:'940009999999999'}},{order_line_ids:['line'],label_metadata:{trackingNumber:'940001111111111'}}]};
 const result=T.build([m],[{id:'line'}],base);assert.equal(result.length,2);assert.deepEqual(result.map(t=>t.direction).sort(),['outbound','return']);assert(result.every(t=>t.code==='940001111111111'));
});
test('only explicitly linked earlier stages are folded into the current case',()=>{
 const inquiry={case:{id:'i',source_lane:'inquiry',ebay_return_id:'A'}},c={case:{id:'c',source_lane:'case',ebay_return_id:'A',raw_payload:{ebayDetail:{returnId:'R'}}}},ret={case:{id:'r',source_lane:'return',ebay_return_id:'R'}},other={case:{id:'o',source_lane:'inquiry',ebay_return_id:'B'}};
 const stages=M.currentCaseStages([inquiry,other,ret,c]);assert.equal(stages.length,2);assert.deepEqual(stages.find(s=>s.member===c).previous,[inquiry,ret]);assert.equal(M.currentCaseStages([inquiry]).length,1);
});
