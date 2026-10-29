import assert from 'node:assert/strict';
import {test} from 'node:test';
import customer from '../ebay-customer-report.js';
import PDFLib from '../vendor/pdf-lib/pdf-lib.min.js';
import pdf from '../ebay-customer-report-pdf.js';
const base='https://example.test/Invsto/ebay-buyer-report.html',now=new Date('2026-10-29T16:00:00Z');
function records(){return {
 orders:[
  {id:'o1',order_number:'ONE',buyer_username:'buyer',buyer_name:'Review Customer',sale_date:'2026-10-01T13:00:00Z',ship_by_date:'2026-10-20T06:59:00Z',status:'pending',total_price:100,label_file_path:'one.pdf',label_uploaded_at:'2026-10-02T15:00:00Z',raw_payload:{}},
  {id:'o2',order_number:'TWO',buyer_username:'buyer',sale_date:'2026-10-02T13:00:00Z',ship_by_date:'2026-10-30T06:59:00Z',status:'pending',total_price:50,label_metadata:{trackingNumber:'123'},raw_payload:{}},
  {id:'o3',order_number:'THREE',buyer_username:'buyer',sale_date:'2026-09-01T13:00:00Z',ship_by_date:'2026-09-05T06:59:00Z',status:'fulfilled',total_price:30,raw_payload:{orderPaymentStatus:'FULLY_REFUNDED'}},
 ],
 lines:[{id:'a',order_id:'o1',line_status:'pending',item_title:'Gold ring',quantity:1,sold_for:80},{id:'b',order_id:'o1',line_status:'fulfilled',item_title:'Silver ring',quantity:1,sold_for:20},
 {id:'c',order_id:'o2',line_status:'partially_fulfilled',item_title:'Watch',quantity:1,sold_for:50},{id:'d',order_id:'o3',line_status:'fulfilled',item_title:'Refunded bracelet',quantity:1,sold_for:30}],
 events:[],adminEvents:[{id:'group',order_line_ids:['a','c'],payload:{}}],returnCases:[]
};}
test('pending edition filters item lines, retains full lifetime refunds, and sorts by shipping deadline',()=>{
 const data=records(),all=customer.makeModel('buyer',data,'all',base,now),pending=customer.makeModel('buyer',data,'pending',base,now);
 assert.deepEqual(pending.rows.map(r=>r.id),['a','c']);assert.equal(all.count,4);assert.equal(pending.count,2);
 assert.deepEqual(pending.customer.financial.totals,all.customer.financial.totals);
 assert.equal(pending.customer.financial.totals[0].refunds,3000);assert.equal(pending.itemValue,'$130.00');
 assert.equal(all.overdue,1);assert.equal(all.today,1);assert.equal(all.closed,2);
});
test('label attachment is per order and is never inferred from metadata or a grouped sibling',()=>{
 const model=customer.makeModel('buyer',records(),'pending',base,now);
 assert.equal(model.rows[0].shippingLabel.attached,true);assert.equal(model.rows[1].shippingLabel.attached,false);
 assert.equal(model.rows[1].groups.length,1);assert.equal(model.labeled,1);assert.equal(model.unlabeled,1);
 assert.equal(customer.shippingLabel({label_status:'uploaded',label_metadata:{trackingNumber:'12'},label_file_path:' '}).attached,false);
});
test('closed and unknown lines do not become pending or acquire an overdue warning',()=>{
 const data=records();data.lines.push({id:'unknown',order_id:'o2',line_status:'unexpected'});
 const full=customer.makeModel('buyer',data,'all',base,now);
 assert.equal(full.unknown,1);assert.equal(full.overdue,1);
 const closed=full.rows.find(r=>r.id==='d');assert.equal(customer.urgency(closed),'Closed / fulfilled');
 assert.ok(closed.timeline.every(e=>!e.label.includes('overdue')));
 assert.ok(!closed.timeline.some(e=>e.label==='Recorded ship date'));
 for(const status of ['cancelled','skipped','closed','refunded'])assert.equal(customer.state({line_status:status},{}).kind,'closed');
});
test('render uses one crop, preserves refund coloring and exposes both time zones and navigation',()=>{
 const data=records();data.lines[0].item_title='<script>unsafe</script>';
 const model=customer.makeModel('buyer',data,'all',base,now);model.rows[0].image={crop:'data:image/jpeg;CROP',full:'DUPLICATE_FULL',cropped:true};
 const html=customer.render(model);
 assert.equal((html.match(/src="data:image\/jpeg;CROP"/g)||[]).length,1);assert.ok(!html.includes('DUPLICATE_FULL'));
 assert.match(html,/&lt;script&gt;unsafe&lt;\/script&gt;/);assert.ok(!html.includes('<script>unsafe'));
 assert.match(html,/Eastern \(your time\)/);assert.match(html,/Pacific \(eBay\)/);
 assert.match(html,/purchase closed is-refunded/);assert.match(html,/href="#item-index"/);assert.match(html,/Lifetime purchase summary/);
});
test('empty pending editions remain valid and explain closed history without fabricating items',()=>{
 const data=records();data.lines.forEach(l=>l.line_status='fulfilled');
 const model=customer.makeModel('buyer',data,'pending',base,now);
 assert.equal(model.count,0);assert.match(customer.render(model),/No pending item lines/);assert.equal(model.customer.orderCount,3);
});
test('PDF index destinations and return navigation resolve on all pages including long-note continuations',async()=>{
 globalThis.PDFLib=PDFLib;
 const data=records();data.events=[{id:'note',order_line_ids:['a'],action:'commented',payload:{source:'pending_order_line_note'},signed_by_email:'staff@example.test',created_at:'2026-10-29T14:00:00Z',notes:'Long item review note. '.repeat(220)}];
 const model=customer.makeModel('buyer',data,'all',base,now),bytes=await pdf.build(model),doc=await PDFLib.PDFDocument.load(bytes),pages=doc.getPages(),refs=new Set(pages.map(p=>p.ref.toString()));
 assert.ok(pages.length>model.count+4,'Long notes force continuation pages');
 let external=0,itemLinks=0;
 for(const page of pages){
  const annotations=page.node.lookup(PDFLib.PDFName.of('Annots')).asArray().map(a=>doc.context.lookup(a));
  const internal=annotations.filter(a=>a.has(PDFLib.PDFName.of('Dest')));
  assert.ok(internal.length>=2,'Every page links to index and customer summary');
  for(const link of internal){const dest=link.lookup(PDFLib.PDFName.of('Dest'));assert.ok(refs.has(dest.get(0).toString()));itemLinks++;}
  external+=annotations.filter(a=>a.has(PDFLib.PDFName.of('A'))).length;
 }
 assert.ok(itemLinks>=pages.length*2+model.count);assert.ok(external>=model.count*3);
});
