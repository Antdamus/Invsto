import {test} from 'node:test';
import assert from 'node:assert/strict';
import T from '../customer-issue-review-tracking.js';
import M from '../customer-issue-review-model.js';

const entry=(history_text,overrides={})=>({direction:'outbound',code:'940001234567890',carrier:'USPS',status:'Delivered',events:[],history:{history_text},...overrides});
const member=(detail={},overrides={})=>({outcome:'against_us',case:{source_lane:'case',ebay_return_id:'C1',closed_at:'2026-10-31T15:00:00Z',synced_at:'2026-10-31T16:00:00Z',raw_payload:{ebayDetail:{caseId:'C1',sellerOutcome:'LOSE',...detail}},...overrides}});
const issue=overrides=>({tracking:[],shipmentDates:[],openedDate:{value:'Oct 17, 2026, 11:01 AM EDT'},decisions:[],statuses:[{outcome:'against_us'}],against:true,...overrides});

test('acceptance and delivery use actual dated scans and retain carrier-local time',()=>{
 const t=entry('Delivered, In/At Mailbox\nSAINT PAUL, MN 55117\nOctober 5, 2026 11:44 AM\n\nOut for Delivery\nOctober 5, 2026 6:10 AM\n\nUSPS in possession of item\nMIAMI, FL 33152\nSeptember 29, 2026 8:52 PM\n\nShipping Label Created\nSeptember 29, 2026 11:56 AM');
 const scans=T.milestones(t);
 assert.equal(scans.shipped.value,'Tuesday, September 29, 2026 8:52 PM');assert.equal(scans.delivered.value,'Monday, October 5, 2026 11:44 AM');
 assert.match(scans.delivered.source,/carrier local time \(zone not supplied\)/);assert.doesNotMatch(scans.delivered.value,/EDT/);assert.equal(scans.delivered.location,'SAINT PAUL, MN 55117');
 assert.equal(T.milestones(entry('Delivered\nOctober 5, 2026 11:44 AM CDT')).delivered.source,'USPS delivery scan · carrier time CDT');
});

test('labels, delivery estimates, failed attempts, return-to-sender and observed status times are not delivery dates',()=>{
 const t=entry('Shipping Label Created\nSeptember 29, 2026 11:56 AM\nDelivered\nEstimated delivery October 5, 2026\nOut for Delivery\nOctober 5, 2026 6:10 AM\nDelivery Attempted\nOctober 5, 2026 11:44 AM\nDelivered to Original Sender\nOctober 8, 2026 11:44 AM\nShipment Received, Package Acceptance Pending\nSeptember 29, 2026 11:56 AM', {statusAt:'2026-10-31T15:00:00Z',events:[{at:'2026-10-31T15:00:00Z',title:'eBay tracking status: Delivered'},{at:'2026-09-29T15:00:00Z',title:'Shipping label captured'}]});
 assert.deepEqual(T.milestones(t),{shipped:null,delivered:null});
 assert.equal(T.milestones(entry('Delivered\nFebruary 31, 2026 9:10 AM')).delivered,null);
});

test('eBay fulfillment shipment date is a labeled fallback, never a delivery date',()=>{
 const t=entry('',{events:[{at:'2026-09-29T15:00:00Z',title:'Shipment recorded by eBay'}]});const scans=T.milestones(t);
 assert.equal(scans.shipped.value,'Tuesday, Sep 29, 2026, 11:00 AM EDT');assert.match(scans.shipped.source,/carrier acceptance scan not saved/);assert.equal(scans.delivered,null);
});

test('case closure uses a dated eBay resolution, not messages, money movement, last modified or internal closure',()=>{
 const events=[{actor:'BUYER',action:'Claim was resolved.',date:{value:'2026-10-30T15:00:00Z'}},{actor:'CSR',action:'System request money movement',date:{value:'2026-10-23T17:32:50Z'}},{actor:'CSR',action:'Claim was resolved.',date:{value:'2026-10-23T17:37:07Z'}}];
 const m=member({lastModifiedDate:{value:'2026-10-31T15:00:00Z'},caseHistoryDetails:{history:events}});
 assert.equal(M.decisionDate(m).value,'Friday, Oct 23, 2026, 1:37 PM EDT');assert.match(M.decisionDate(m).source,/eBay resolution event/);
 assert.equal(M.decisionDate(member({lastModifiedDate:{value:'2026-10-31T15:00:00Z'}})),null);
 assert.equal(M.decisionDate({...m,outcome:'open'}),null);
 assert.equal(M.decisionDate(member({caseId:'OTHER',caseHistoryDetails:{history:events}})),null);
 assert.equal(M.decisionDate(member({closedDate:{value:'2026-10-23T17:38:00Z'}})).value,'Friday, Oct 23, 2026, 1:38 PM EDT');
});

test('overview excludes return scans and makes missing dates and multiple outbound shipments explicit',()=>{
 const delivered=entry('Delivered\nOctober 5, 2026 11:44 AM');
 let dates=M.keyDates(issue({tracking:[{...delivered,direction:'return'}]}));assert.equal(dates[2].value,'Date not recorded');
 dates=M.keyDates(issue({tracking:[delivered,entry('')]}));assert.equal(dates[2].value,'1 of 2 dates recorded');assert.match(dates[2].source,/Multiple shipments/);
 dates=M.keyDates(issue({tracking:[entry('')]}));assert.equal(dates[2].value,'Date not recorded');assert.match(dates[2].source,/Marked delivered by eBay/);assert.equal(dates[4].value,'Decision date not recorded');
 assert.deepEqual(dates.map(d=>d.label),['Purchased','Shipped','Delivered','Issue opened','Closed against us']);
});

test('saved carrier history replaces the fallback immediately and does not use an earlier inquiry closure for the escalated case',()=>{
 const t=entry(''),i=issue({tracking:[t],shipmentDates:[{value:'Sep 29, 2026',source:'Saved order shipment date'}]});
 assert.equal(M.keyDates(i)[1].value,'Sep 29, 2026');
 t.history.history_text='USPS in possession of item\nSeptember 29, 2026 8:52 PM\nDelivered\nOctober 5, 2026 11:44 AM';
 assert.equal(M.keyDates(i)[1].value,'Tuesday, September 29, 2026 8:52 PM');assert.equal(M.keyDates(i)[2].value,'Monday, October 5, 2026 11:44 AM');
 const inquiry={outcome:'final',case:{source_lane:'inquiry',ebay_return_id:'C1',raw_payload:{ebayDetail:{inquiryId:'C1',closedDate:'2026-10-20T12:00:00Z'}}}};
 const stages=M.currentCaseStages([inquiry,member()]);assert.equal(stages.length,1);assert.equal(M.decisionDate(stages[0].member),null);
});


test('purchase weekday uses Eastern for real timestamps and preserves imported calendar-only dates',()=>{
 const timestamp=M.purchaseMoment({sale_date:'2026-09-27T04:09:59Z'});
 assert.equal(timestamp.value,'Sunday, Sep 27, 2026, 12:09 AM EDT');
 assert.equal(M.purchaseMoment({sale_date:'2026-09-27T02:00:00Z'}).value,'Saturday, Sep 26, 2026, 10:00 PM EDT');
 const day=M.purchaseMoment({sale_date:'2026-09-27T00:00:00Z',raw_payload:{date_precision:{sale_date:'day'}}});
 assert.equal(day.value,'Sunday, Sep 27, 2026');assert.match(day.source,/time not recorded/);
 const imported=M.purchaseMoment({sale_date:'2026-09-26T00:00:00Z',raw_payload:{first_row:{'Sale Date':'Sep-27-26'}}});
 assert.equal(imported.value,'Sunday, Sep 27, 2026');
 assert.equal(M.purchaseMoment({sale_date:'2026-09-27'}).value,'Sunday, Sep 27, 2026');
 assert.equal(M.purchaseMoment({sale_date:'bad'}),null);assert.equal(M.purchaseMoment({sale_date:'2026-02-31'}),null);
 const dates=M.keyDates(issue({purchaseDates:[timestamp]}));assert.equal(dates[0].label,'Purchased');assert.equal(dates[0].value,timestamp.value);
 const grouped=M.keyDates(issue({purchaseDates:[timestamp,M.purchaseMoment({sale_date:'2026-09-25'})]}));assert.equal(grouped[0].label,'First purchase');assert.equal(grouped[0].value,'Friday, Sep 25, 2026');assert.match(grouped[0].source,/2 linked orders/);
});
