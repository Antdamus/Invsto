import {test} from 'node:test';
import assert from 'node:assert/strict';
import customer from '../ebay-customer-report.js';
import map from '../ebay-order-map.js';
import PDFLib from '../vendor/pdf-lib/pdf-lib.min.js';
import pdf from '../ebay-customer-report-pdf.js';
const row={id:'line',item:'123',title:'#005 - AS SEEN ON SCREEN',sortDate:'2026-10-29T20:45:00Z'};
const show={event_id:'abc',started_at:'2026-10-29T18:00:00Z',title:'Afternoon silver'};
const evidence={shows:[show],attempts:[],listings:[{event_id:'abc',item_number:'123',listing_status:'Sold',ordinal:5}]};
test('Sydney afternoon includes a 4:45 PM Eastern purchase after a 2 PM start',()=>{
 assert.equal(map.schedule(show.started_at).label,'Sydney · afternoon');
 assert.equal(map.resolve(row,evidence).show.event_id,'abc');
});
test('overnight grouping uses the previous Eastern evening including winter DST offset',()=>{
 assert.deepEqual(map.schedule('2026-10-27T05:57:00Z'),{label:'Otello · evening / overnight',day:'2026-10-26',estimated:true});
 assert.equal(map.schedule('2026-12-02T10:45:00Z').day,'2026-12-01');
 assert.equal(map.schedule('2026-12-02T15:00:00Z').label,'Sydney · morning');
 assert.equal(map.schedule(show.started_at,'Recorded Seller').estimated,false);
});
test('regular purchases never get assigned from time or a watch/gold title alone',()=>{
 const regular={...row,item:'other',title:'10K Gold watch'};
 assert.equal(map.resolve(regular,evidence).show,undefined);
 assert.equal(map.resolve(regular,evidence).likelyLive,false);
 assert.equal(map.resolve({...row,item:'other'},evidence).likelyLive,true);
});
test('capture links outrank listing windows, while conflicts and reused listings remain unassigned',()=>{
 assert.equal(map.resolve({...row,sortDate:'2026-11-10T20:00Z'},{...evidence,attempts:[{order_line_id:'line',event_id:'abc',ordinal:9}]}).number,5);
 const repeated={...evidence,shows:[show,{...show,event_id:'def'}],listings:[...evidence.listings,{...evidence.listings[0],event_id:'def'}]};
 assert.equal(map.resolve(row,repeated).conflict,true);
 assert.equal(map.resolve({...row,sortDate:'2026-10-31T20:00:00Z'},evidence).show,undefined);
 assert.equal(map.resolve(row,{...evidence,listings:[{...evidence.listings[0],listing_status:'Reserved for Live'}]}).show,undefined);
});
function fixture(){const records={orders:[{id:'o',order_number:'01-12345-12345',buyer_username:'buyer',buyer_name:'Sample Buyer',sale_date:row.sortDate,ship_by_date:'2026-10-29T06:59:00Z',status:'pending',total_price:90,raw_payload:{}}],lines:[{id:'line',order_id:'o',item_number:'123',item_title:row.title,line_status:'pending',sold_for:50,quantity:2},{id:'regular',order_id:'o',item_number:'456',item_title:'Regular ring',line_status:'pending',sold_for:40,quantity:1}],events:[],adminEvents:[],returnCases:[]};return map.attach(customer.makeModel('buyer',records,'pending','https://example.test/',new Date('2026-10-30T12:00:00Z')),evidence);}
test('map counts only matched pending lines and keeps regular purchases outside its totals',()=>{
 const model=fixture();assert.equal(model.count,1);assert.equal(model.orderMap.excluded.length,1);assert.equal(model.orderMap.groups[0].quantity,2);assert.equal(model.orderCount,1);assert.equal(model.itemValue,'$100.00');
 const html=customer.render(model);assert.match(html,/One buyer\. Every show/);assert.match(html,/href="#show-abc"/);assert.match(html,/HOST: SCHEDULE ESTIMATE/);assert.ok(!html.includes('id="purchase-regular"'));
});
test('PDF show directory and every item return link resolve to existing pages',async()=>{
 globalThis.PDFLib=PDFLib;const bytes=await pdf.build(fixture());const doc=await PDFLib.PDFDocument.load(bytes),refs=new Set(doc.getPages().map(p=>p.ref.toString()));let count=0;
 for(const p of doc.getPages())for(const ref of p.node.lookup(PDFLib.PDFName.of('Annots')).asArray()){
  const a=doc.context.lookup(ref);if(a.has(PDFLib.PDFName.of('Dest'))){assert.ok(refs.has(a.lookup(PDFLib.PDFName.of('Dest')).get(0).toString()));count++;}
 }
 assert.ok(count>=doc.getPageCount()*2);
});
