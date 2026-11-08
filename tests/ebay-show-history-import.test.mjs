import {test} from 'node:test';
import assert from 'node:assert/strict';
import {prepareRows,importSql} from '../tools/prepare-ebay-show-history.mjs';

test('observed catalog import separates unavailable metrics from zero and excludes drafts',()=>{
 const event={cells:['Watches','8/7/25\n9:58pm EDT','Replay\nPublished','Clothing & Accessories','show'],href:'https://www.ebay.com/ebaylive/host/events/show?tab=insights'};
 const observed={event_id:'show',checked_at:'2026-11-08T20:00Z',metrics:[{name:'Length of stream',value:'02:07:54'},{name:'TOTAL SALES',value:'Data unavailable'},{name:'PAID ITEMS',value:'Data unavailable'},{name:'NEW FOLLOWERS',value:'0'}]};
 const rows=prepareRows([event,event,{...event,cells:[...event.cells.slice(0,2),'Replay Draft',...event.cells.slice(3)]}],[observed]);
 assert.equal(rows.length,1);assert.equal(rows[0].starts_at,'2025-08-07T21:58:00-04:00');assert.equal(rows[0].airtime_seconds,7674);
 assert.equal(rows[0].insights.sales_status,'unavailable');assert.equal(rows[0].insights.studio_gross_including_tax_shipping,null);assert.equal(rows[0].insights.paid_items,null);assert.equal(rows[0].insights.new_followers,0);
 const winter=prepareRows([{...event,cells:[event.cells[0],'11/2/25 10:30pm EST',...event.cells.slice(2)]}],[{...observed,metrics:[{name:'Length of stream',value:'03:21:03'},{name:'TOTAL SALES',value:'$0.00'},{name:'PAID ITEMS',value:'0'}]}])[0];
 assert.equal(winter.starts_at,'2025-11-02T22:30:00-05:00');assert.equal(winter.insights.sales_status,'ready');assert.equal(winter.insights.studio_gross_including_tax_shipping,0);
 assert.throws(()=>prepareRows([event],[]),/Missing Insights/);assert.ok(!importSql(rows).includes('seller_override='));
});
