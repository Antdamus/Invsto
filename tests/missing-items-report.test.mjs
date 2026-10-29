import assert from 'node:assert/strict';
import {test} from 'node:test';
import report from '../ebay-missing-report.js';
import buyer from '../ebay-buyer-report.js';
import pdfReport from '../ebay-missing-report-pdf.js';
import PDFLib from '../vendor/pdf-lib/pdf-lib.min.js';

const now=new Date('2026-10-29T18:00:00Z');
const order=(id,total=100)=>({id,order_number:`order-${id}`,buyer_username:'sample_buyer',sale_date:'2026-10-20T18:00:00Z',ship_by_date:'2026-10-29T06:59:59Z',total_price:total,raw_payload:{}});
const line=(id,orderId)=>({id,order_id:orderId,line_status:'pending',item_number:`item-${id}`,item_title:'Vintage gold watch',quantity:1,sold_for:100});
const record=()=>({orders:[order('a'),order('b'),order('c')],lines:[line('a1','a'),line('a2','a'),{...line('b1','b'),line_status:'fulfilled'},line('c1','c')],events:[],adminEvents:[],returnCases:[]});
const queue=()=>[{...line('a1','a'),buyer_name:'Sample Customer',order_number:'order-a',item_search:{is_missing:true,updated_at:'2026-10-28T21:00:00Z',updated_by_email:'staff@example.test'}}];
const customer=(data=record(),q=queue())=>report.makeCustomer('sample_buyer',data,q,'https://example.test/Invsto/ebay-missing-report.html',now);

test('missing scopes contain only explicitly marked open lines, deduplicated across markers',()=>{
  const rows=[{id:'a',line_status:'pending',item_search:{is_missing:true},missingWatch:{id:'h'}},
    {id:'b',line_status:'pending',missingWatch:{id:'h'}},{id:'c',line_status:'pending',item_search:{is_missing:false}},
    {id:'d',line_status:'fulfilled',item_search:{is_missing:true}},{id:'e',line_status:'pending'}];
  assert.deepEqual(report.selectMissing([...rows,rows[0]]).map(r=>r.id),['a','b']);
  assert.deepEqual(report.selectMissing(rows,'not-found').map(r=>r.id),['a']);
  assert.deepEqual(report.selectMissing(rows,'watches').map(r=>r.id),['a','b']);
});

test('exact timestamps, Pacific calendar dates and DST match the pending queue',()=>{
  const due='2026-10-29T06:59:59Z';
  assert.equal(report.deadline({ship_by_date:due},new Date(due)).level,'today');
  assert.equal(report.deadline({ship_by_date:due},new Date('2026-10-29T07:00:00Z')).level,'overdue');
  assert.equal(report.deadline({ship_by_date:'2026-10-30T06:59:59Z'},new Date('2026-10-29T05:00:00Z')).level,'tomorrow');
  for(const raw_payload of [{date_precision:{ship_by_date:'day'}},{first_row:{'Ship By Date':'Oct-28-26'}}]){
    const o={ship_by_date:'2026-10-28T12:00:00Z',raw_payload};
    assert.equal(report.deadline(o,new Date('2026-10-29T06:59:59Z')).level,'today');
    assert.equal(report.deadline(o,new Date('2026-10-29T07:00:00Z')).level,'overdue');
  }
  assert.equal(report.deadline({ship_by_date:'2026-10-28'} ,new Date('2026-10-29T05:00:00Z')).level,'today');
  for(const [day,cutoff] of [['2026-03-08','2026-03-09T07:00:00Z'],['2026-11-01','2026-11-02T08:00:00Z']]){
    assert.equal(report.deadline({ship_by_date:day},new Date(Date.parse(cutoff)-1)).level,'today');
    assert.equal(report.deadline({ship_by_date:day},new Date(cutoff)).level,'overdue');
  }
  assert.equal(report.deadline({}).level,'unknown');
  assert.equal(report.deadline({ship_by_date:'not-a-date'}).level,'unknown');
  assert.match(report.deadline({ship_by_date:due},now).since,/Oct 28, 2026.*11:59 PM PDT/);
  assert.equal(report.deadline({ship_by_date:due},now).age,'11 hours');
});

test('timeline is chronological, dates are labeled, and unavailable milestones are not invented',()=>{
  const o=order('a'),due=report.deadline(o,now),events=report.timeline(o,'2026-10-29T12:00:00Z',due,now);
  assert.deepEqual(events.map(e=>e.label),['Purchased','Shipping deadline','Marked missing','Still missing / 11 hours overdue']);
  assert.match(events[0].text,/Oct 20, 2026/);
  assert.match(events[3].text,/Oct 29, 2026/);
  assert.equal(report.timeline({},undefined,report.deadline({}),now).length,1);
});

test('customer figures include closed history while only missing lines are listed; completed partial refunds are counted once',()=>{
  const data=record();data.orders[1].raw_payload={orderPaymentStatus:'FULLY_REFUNDED'};
  const paid={refundReferenceId:'r',refundStatus:'REFUNDED',amount:{value:25,currency:'USD'}};
  data.orders[2].raw_payload={order:{paymentSummary:{refunds:[paid,paid,{refundReferenceId:'p',refundStatus:'PENDING',amount:{value:50,currency:'USD'}}]}}};
  const c=customer(data);assert.equal(c.rows.length,1);assert.equal(c.orderCount,3);assert.equal(c.itemCount,4);
  assert.deepEqual(c.financial.totals.map(t=>[t.gross,t.refunds,t.net]),[[30000,12500,17500]]);
  assert.deepEqual(c.full,{count:1,amount:'$100.00'});assert.deepEqual(c.partial,{count:1,amount:'$25.00'});
  assert.equal(c.financial.requestedOrders,1);assert.match(c.rows[0].pendingUrl,/orderId=order-a/);
  assert.equal(c.rows[0].price.total,100);assert.match(buyer.receiptAction(c.rows[0]).pdfLabel,/via eBay/);
  const missing=record();missing.orders[1].raw_payload={ebayFinance:{transactions:[{transactionType:'REFUND',amount:23.54}]}};
  assert.equal(customer(missing).financial.totals[0].net,null);
});

test('refreshes omit newly closed lines; absent item history fails clearly instead of publishing partial totals',()=>{
  const data=record();data.lines[0].line_status='fulfilled';assert.equal(customer(data).rows.length,0);
  data.lines.shift();assert.throws(()=>customer(data),/could not be loaded/);
});

test('latest written notes respect event item scope and exclude removed tasks and screenshot messages',()=>{
  const note={order_line_ids:['a1','a2'],action:'commented',notes:'Find the blue tray',created_at:'2026-10-28',payload:{source:'pending_order_line_note',order_line_id:'a1'}};
  const data={events:[note,{...note,created_at:'2026-10-29',notes:'Wrong sibling',payload:{...note.payload,order_line_id:'a2'}},
    {...note,created_at:'2026-10-30',notes:'Removed',task_metadata:{history_removed_at:'2026-10-31'}},
    {...note,created_at:'2026-10-31',notes:'Video receipt screenshot uploaded for eBay item 123.\nScreenshot'}]};
  assert.equal(report.latestNote(data,'a1'),'Find the blue tray');assert.equal(report.latestNote(data,'a2'),'Wrong sibling');
});

test('preview escapes buyer/item/note data and preserves grouped order context and receipt fallback',()=>{
  const data=record();data.lines[0].item_title='<img onerror=attack()>';data.adminEvents=[{id:'group',order_line_ids:['a1','b1']}];
  const q=queue();q[0].latest_line_note='<script>attack()</script>';
  const c=customer(data,q),model=report.makeReport([c],'all',now.toISOString()),html=report.render(model);
  assert.ok(!html.includes('<script>attack'));assert.ok(!html.includes('<img onerror'));assert.match(html,/&lt;script&gt;/);
  assert.match(html,/Grouped order context/);assert.match(html,/order-a, order-b/);
  assert.match(html,/Overdue since/);assert.match(html,/Item timeline/);assert.match(html,/Find video receipt/);
});

test('queue reads all pages and missing holds, and fails on partial reads',async()=>{
  let calls=0;const client={rpc(name,args){if(name==='list_pending_ebay_order_queue_v2'){
    calls++;return Promise.resolve({data:Array.from({length:args._offset?1:1000},(_,i)=>({id:`l${args._offset+i}`,line_status:'pending'}))});
  }return {async range(offset){return {data:offset?[]:[{id:'active',kind:'watch_missing',active:true,line_ids:['l1000']},{id:'inactive',kind:'watch_missing',active:false,line_ids:['l1']},{id:'cgl',kind:'cgl',active:true,line_ids:['l2']}]};}};}};
  const rows=await report.loadQueue(client);assert.equal(calls,2);assert.equal(rows.length,1001);
  assert.deepEqual(report.selectMissing(rows).map(r=>r.id),['l1000']);
  const failed={rpc(name,args){return name==='list_pending_ebay_order_queue_v2'?client.rpc(name,args):{range:async()=>({error:{message:'Markers unavailable'}})};}};
  await assert.rejects(()=>report.loadQueue(failed),/Markers unavailable/);
});

test('scoped screenshots retain full financial history and use only missing-line evidence queries',async()=>{
  const calls=[],data=record();const client={from(table){const filters=[],q={select(){return q;},ilike(){return q;},order(){return q;},
    in(field,ids){filters.push([field,ids]);return q;},overlaps(field,ids){filters.push([field,ids]);return q;},
    async range(){calls.push({table,filters});return {data:table==='ebay_orders'?data.orders:table==='ebay_order_lines'?data.lines:[]};}};return q;}};
  const result=await buyer.loadRecords(client,'sample_buyer',()=>{},{evidenceLineIds:['a1']});
  assert.equal(result.orders.length,3);assert.equal(result.lines.length,4);
  assert.deepEqual(calls.filter(c=>c.table==='ebay_order_admin_events')[0].filters,[['order_line_ids',['a1']]]);
  assert.deepEqual(calls.filter(c=>c.table==='ebay_return_cases')[0].filters,[['order_id',['a','b','c']]]);
});

test('PDF is generated locally with clickable customer, item and external links; long notes flow to extra pages',async()=>{
  globalThis.PDFLib=PDFLib;
  const c=customer();c.rows[0].note='A detailed staff note with important item information. '.repeat(100);
  const bytes=await pdfReport.build(report.makeReport([c],'all',now.toISOString()));
  const pdf=await PDFLib.PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>=6);
  let internal=0,external=0;
  for(const page of pdf.getPages())for(const ann of page.node.lookup(PDFLib.PDFName.of('Annots'))?.asArray()||[]){
    const value=pdf.context.lookup(ann);if(value.has(PDFLib.PDFName.of('Dest')))internal++;if(value.has(PDFLib.PDFName.of('A')))external++;
  }
  assert.ok(internal>=2);assert.ok(external>=10);
});
