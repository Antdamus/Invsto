import {test} from 'node:test';
import assert from 'node:assert/strict';
import '../customer-issue-review-model.js';
import P from '../customer-issue-review-pdf.js';

test('carrier table preserves every saved scan, date, location and unstructured note',()=>{
 const text='Delivered, In/At Mailbox\nEXAMPLE CITY, FL 33152\nOctober 5, 2026 11:44 AM\n\nOut for Delivery\nOctober 5, 2026 6:10 AM\n\nUSPS in possession of item\nSeptember 29, 2026 8:52 PM\n\nNote without a date';
 const rows=P.carrierRows(text);assert.equal(rows.length,4);assert.equal(rows[0].date,'October 5, 2026 11:44 AM');
 const lines=s=>s.split('\n').map(s=>s.trim()).filter(Boolean).sort();assert.deepEqual(lines(rows.map(r=>r.date+'\n'+r.body).join('\n')),lines(text));
 const unstructured='Arrived\nOctober 5, 2026 5:00 AM\nDelivered\nOctober 5, 2026 11:44 AM';assert.equal(P.carrierRows(unstructured)[0].body,unstructured);
});
test('PDF chronology consolidates a linked opening and duplicate syncs while preserving messages and real status changes',()=>{
 const at='2026-10-12T12:00:00Z',events=[{title:'Case opened',body:'Case A · ITEM_NOT_RECEIVED',at},{title:'Inquiry opened',body:'Case A · UNKNOWN',at},{title:'Inquiry opened',body:'Case B · UNKNOWN',at},{title:'Evidence saved',body:'Photo whose timestamp is retained in caption',at},{title:'Buyer message',body:'Full buyer statement',at},{title:'Our response',body:'Full seller response',at},{title:'Internal Note',body:'Private staff note',at,internal:true}];
 const tracking={code:'FAKE',status:'Delivered',events:[{title:'eBay tracking status: Delivered',at:'2026-10-01T12:00Z'},{title:'eBay tracking status: In transit',at:'2026-10-02T12:00Z'},{title:'eBay tracking status: Delivered',at:'2026-10-03T12:00Z'},{title:'eBay tracking status: Delivered',at:'2026-10-04T12:00Z'},{title:'Shipping label attached',at:'2026-09-29T12:00Z',body:'Staff provenance retained'}]};
 const i={timeline:events,tracking:[tracking]},copy=JSON.stringify(i),rows=P.timelineRows(i,false);
 assert.equal(rows.filter(e=>e.title==='Issue opened').length,2);assert(rows.some(e=>e.body==='Full buyer statement'));assert(rows.some(e=>e.body==='Full seller response'));assert(!rows.some(e=>e.title==='Evidence saved'));assert(!rows.some(e=>e.internal));
 assert.equal(rows.filter(e=>e.title==='eBay tracking status: Delivered').length,1);assert(rows.some(e=>e.title==='eBay tracking status: In transit'));assert(rows.some(e=>e.body?.includes('Staff provenance retained')));assert.equal(JSON.stringify(i),copy);
 assert(P.timelineRows(i,true).some(e=>e.body==='Private staff note'));
});
