import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import tracking from '../order-tracking-search.js';
import pending from '../pending-shipment-evidence.js';
const full='9400108106245736262406';
test('full, partial, postal routing and GS1 scans find the saved tracking without changing it',()=>{
 for(const scan of [full,'5736262406','262406',']C142033131'+full,']C142033131\x1d'+full,']C142033131␝'+full,'9400 1081 0624 5736 2624 06']){
  assert(tracking.isScan(scan),scan);assert(tracking.matches(full,scan),scan);
  assert(pending.matchesTracking({order:{tracking_number:full}},scan),scan);
 }
 assert(!tracking.isScan('26406'));assert(!tracking.isScan('buyer-name'));assert(!tracking.isScan('123456),id.eq.other'));
 assert.equal(tracking.normalize('000012345678'),'000012345678');
 assert(tracking.matches('1Z999AA10123456784','1z999aa10123456784'));
 const siblings=[{order:{tracking_number:full}},{order:{label_metadata:{trackingNumbers:['9400101111111111262406']}}}];
 assert.equal(siblings.filter(l=>pending.matchesTracking(l,'262406')).length,2,'ambiguous fragments keep both matches');
 assert(!tracking.matches(full,'999999999999'));
});
test('Order History uses one bounded database query per tracking source for partial and prefixed scans',async()=>{
 const calls=[];
 const context=vm.createContext({console,URLSearchParams,setTimeout:()=>0,clearTimeout,
  window:{OGTrackingSearch:tracking,addEventListener(){},location:{search:''}},document:{addEventListener(){}}});
 vm.runInContext(readFileSync(new URL('../ebay-order-history.js',import.meta.url),'utf8'),context);
 context.testClient={from(table){const call={table};calls.push(call);return {select(select){call.select=select;return {or(filter){call.filter=filter;return {async limit(limit){call.limit=limit;return {data:table==='ebay_orders'?[{id:'order-a'},{id:'order-b'}]:table==='ebay_return_cases'?[{order_id:'return-order'}]:[{id:'event',order_ids:['order-a']}],error:null}}}}}}}}};
 vm.runInContext('supabase=testClient',context);
 const orders=await vm.runInContext(`fetchOrderIdsByLabelMetadataSearch('262406')`,context);
 assert.deepEqual(Array.from(orders),['order-a','order-b']);
 await vm.runInContext(`fetchOrderIdsByReturnTrackingSearch('262406')`,context);
 const events=await vm.runInContext(`fetchLabelEventsByTrackingSearch(']C142033131${full}')`,context);
 assert.equal(events.data[0].id,'event');assert.equal(calls.length,3);
 assert(calls.every(c=>c.limit===250&&c.filter.includes('.ilike.*')));
 assert(calls[0].filter.includes('label_metadata->>trackingNumbers.ilike.*262406*'));
 assert(calls[2].filter.includes('label_metadata->>labelRows.ilike.*245736262406*'));
 assert(vm.runInContext(`historySearchTextIncludes('tracking ${full}',']C142033131${full}')`,context));
 assert(vm.runInContext(`historySearchLooksLikeLabelScan('262406')`,context));
});
