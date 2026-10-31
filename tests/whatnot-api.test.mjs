import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {client,mapOrder,seal,unseal,safeUrl,identifier} from '../supabase/functions/whatnot-order-sync/whatnot.mjs';
import model from '../whatnot-orders-model.js';
const order=()=>({id:'1484060355',url:'https://www.whatnot.com/dashboard/orders/opaque',status:'pending_fulfillment',buyer:{id:'999',username:'buyer',display_name:'Buyer Name'},amounts:Object.fromEntries([['subtotal','12'],['shipping','3'],['tax','1'],['total','16']].map(([k,v])=>[k,{amount:v,currency:'USD'}])),created_at:'2026-10-27T22:17:00Z',updated_at:'2026-10-27T22:17:00Z',show_id:null});
const items=()=>[{id:'9999999999999999999',order_id:'1484060355',quantity:2,unit_price:{amount:'6',currency:'USD'},purchased_item:{title:'Silver earrings',sku:'test'},shipment_id:'521043001'}];
const shipments=()=>new Map([['521043001',{id:'521043001',url:'https://www.whatnot.com/dashboard/shipments/521043001',status:'label_generated',tracking:{tracking_code:'9400000000000000000000',carrier:'USPS'},dropoff_due:'2026-10-29T00:00:00-04:00',required_actions:[],replacement_shipment_id:null}]]);
test('official IDs remain strings; line identity is not product or shipment identity',()=>{
 const record=mapOrder(order(),items(),shipments());assert.equal(record.lines[0].id,'9999999999999999999');assert.equal(record.lines[0].tracking_number,'9400000000000000000000');assert.equal(record.lines[0].ship_by_date,'2026-10-29');assert.equal(record.subtotal,'12');assert.equal(record.shipping,'3');assert.equal(record.total,'16');assert.throws(()=>identifier(1484060355));
});
test('replacement shipments never lend old tracking to current items',()=>{const s=shipments();s.get('521043001').replacement_shipment_id='2';const l=mapOrder(order(),items(),s).lines[0];assert.equal(l.tracking_number,null);assert.equal(l.ship_by_date,null);assert.equal(l.replacement_shipment_id,'2');});
test('invalid, duplicate and mismatched items fail rather than silently disappearing',()=>{
 for(const i of [[...items(),...items()],[{...items()[0],order_id:'2'}],[{...items()[0],quantity:0}],[]])assert.throws(()=>mapOrder(order(),i,shipments()));
 assert.throws(()=>mapOrder({...order(),status:'new_unsupported_status'},items(),shipments()));assert.throws(()=>mapOrder(order(),items(),new Map()));
 assert.equal(safeUrl('https://whatnot.com.evil.test/order'),null);assert.equal(safeUrl('https://user:secret@whatnot.com/order'),null);
});
test('due days become overdue the next ET calendar day, including DST weekends',()=>{
 assert.equal(model.urgency('2026-10-31',new Date('2026-11-01T03:30:00Z')).kind,'today');assert.equal(model.urgency('2026-10-31',new Date('2026-11-01T05:30:00Z')).kind,'overdue');assert.equal(model.urgency(null).kind,'unknown');
});
test('item pagination follows all cursors and rejects repeated cursors',async()=>{
 const calls=[],pages=[{data:[{id:'1'}],next_cursor:'abc'},{data:[{id:'2'}],next_cursor:null}];
 const api=client('wn_pat_tk_example123456789',{sleep:async()=>{},fetcher:async(u,opts)=>{calls.push(String(u));assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer wn_pat_tk_example123456789');return Response.json(pages.shift());}});
 assert.equal((await api.items('1')).length,2);assert.match(calls[1],/cursor=abc/);
 const looping=client('wn_pat_tk_example123456789',{sleep:async()=>{},fetcher:async()=>Response.json({data:[],next_cursor:'abc'})});await assert.rejects(looping.items('1'),/cursor/);
});
test('read-only client retries rate limits, never follows redirects or exposes error bodies',async()=>{
 let count=0;const api=client('wn_pat_tk_example123456789',{sleep:async()=>{},fetcher:async()=>++count<3?new Response('secret',{status:429,headers:{'Retry-After':'1'}}):Response.json({id:'1'})});assert.deepEqual(await api.read('/users/me'),{id:'1'});assert.equal(count,3);
 await assert.rejects(api.read('/shipments/1/generate_label'),/Unsupported/);
 const denied=client('wn_pat_tk_example123456789',{sleep:async()=>{},fetcher:async()=>new Response('do-not-disclose',{status:403})});await assert.rejects(denied.read('/users/me'),e=>!e.message.includes('do-not-disclose'));
});
test('stored credentials are authenticated encrypted, randomized and tamper resistant',async()=>{
 const key=randomBytes(32).toString('base64'),a=await seal('private-token',key),b=await seal('private-token',key);assert.notEqual(a,b);assert.ok(!a.includes('private-token'));assert.equal(await unseal(a,key),'private-token');await assert.rejects(unseal(a,randomBytes(32).toString('base64')));
});
