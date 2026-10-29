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

test('deadlines display Eastern and Pacific dates for the same instant, including midnight and DST changes',()=>{
  const due=report.deadline({ship_by_date:'2026-10-29T06:59:59Z'},now);
  assert.match(due.dueEastern,/Oct 29, 2026.*2:59 AM EDT/);
  assert.match(due.duePacific,/Oct 28, 2026.*11:59 PM PDT/);
  assert.match(due.since,/Eastern \(your time\): Oct 29, 2026.*2:59 AM EDT\nPacific \(eBay\): Oct 28, 2026.*11:59 PM PDT/);
  assert.equal(report.timeline({sale_date:'2026-10-20'},null,due,now).find(e=>e.label==='Shipping deadline').text,due.due);
  for(const [value,eastern,pacific] of [
    ['2026-03-08T09:30:00Z',/5:30 AM EDT/,/1:30 AM PST/],
    ['2026-11-01T08:30:00Z',/3:30 AM EST/,/1:30 AM PDT/],
  ]){
    const result=report.deadline({ship_by_date:value},new Date(value));
    assert.match(result.dueEastern,eastern);assert.match(result.duePacific,pacific);
    assert.equal(result.sort,Date.parse(value));
  }
  const dateOnly=report.deadline({ship_by_date:'2026-10-28'},now);
  assert.match(dateOnly.dueEastern,/Before Oct 29, 2026.*3:00 AM EDT/);
  assert.match(dateOnly.duePacific,/Oct 28, 2026 - end of eBay Pacific day/);
  assert.equal(report.deadline({}).due,'Not recorded');
});

test('customer names are prominent in profiles and each item, retaining eBay usernames and order-specific names',()=>{
  const data=record();data.orders[0].buyer_name='Saved Order Name';
  const c=customer(data),html=report.render(report.makeReport([c],'all',now.toISOString()));
  assert.equal(c.name,'Sample Customer');assert.equal(c.rows[0].customerName,'Saved Order Name');
  assert.match(html,/<h2>Sample Customer<\/h2>/);
  assert.match(html,/class="item-customer">Saved Order Name<\/strong>/);
  assert.match(html,/class="item-owner">eBay: sample_buyer<\/span>/);
  data.orders[0].buyer_name='<img onerror=attack()>';
  const unsafe=report.render(report.makeReport([customer(data)],'all',now.toISOString()));
  assert.ok(!unsafe.includes('<img onerror'));assert.match(unsafe,/&lt;img onerror=/);
  const q=queue();delete q[0].buyer_name;delete data.orders[0].buyer_name;
  assert.match(report.render(report.makeReport([customer(data,q)],'all',now.toISOString())),/class="item-customer">Customer name not recorded/);
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
  const c=customer();c.rows[0].notes=[{text:'A detailed staff note with important item information. '.repeat(100),author:'staff@example.test',date:'Oct 29, 2026, 2:00 PM EDT'}];
  const bytes=await pdfReport.build(report.makeReport([c],'all',now.toISOString()));
  const pdf=await PDFLib.PDFDocument.load(bytes);assert.ok(pdf.getPageCount()>=6);
  let internal=0,external=0;
  const directoryRef=pdf.getPages()[1].ref.toString(),profileRef=pdf.getPages()[2].ref.toString();
  for(const [i,page] of pdf.getPages().entries()){
    const footerLinks=(page.node.lookup(PDFLib.PDFName.of('Annots'))?.asArray()||[]).map(ref=>pdf.context.lookup(ref)).filter(a=>a.lookup(PDFLib.PDFName.of('Rect')).asArray()[1].asNumber()===23);
    assert.ok(footerLinks.some(a=>a.lookup(PDFLib.PDFName.of('Dest')).asArray()[0].toString()===directoryRef),`Directory footer missing on page ${i+1}`);
    if(i>=2&&i<pdf.getPageCount()-1)assert.ok(footerLinks.some(a=>a.lookup(PDFLib.PDFName.of('Dest')).asArray()[0].toString()===profileRef),`Customer footer missing on page ${i+1}`);
  }
  for(const page of pdf.getPages())for(const ann of page.node.lookup(PDFLib.PDFName.of('Annots'))?.asArray()||[]){
    const value=pdf.context.lookup(ann);if(value.has(PDFLib.PDFName.of('Dest')))internal++;if(value.has(PDFLib.PDFName.of('A')))external++;
  }
  assert.ok(internal>=2);assert.ok(external>=10);
});


test('directory totals only missing lines and shows the oldest overdue missing line',()=>{
  const data=record();data.orders[0].ship_by_date='2026-10-25T06:59:59Z';data.orders[2].ship_by_date='2026-10-28T06:59:59Z';
  data.orders[1].ship_by_date='2026-09-01T06:59:59Z';
  const c=customer(data,[...queue(),{...line('c1','c'),item_search:{is_missing:true}}]);
  assert.equal(c.missingValue,'$200.00');
  assert.deepEqual(report.directoryUrgency(c),{level:'overdue',label:'Oldest overdue',value:'4 days 11 hours'});
  const index=report.render(report.makeReport([c],'all',now.toISOString())).match(/<nav class="customer-index"[\s\S]*?<\/nav>/)[0];
  assert.match(index,/Missing-item value/);assert.match(index,/\$200.00/);assert.match(index,/4 days 11 hours/);
  c.rows.forEach(r=>r.deadline=report.deadline({ship_by_date:'2026-10-30T06:59:59Z'},now));
  assert.equal(report.directoryUrgency(c).value,'Due today');
  c.rows.forEach(r=>r.deadline=report.deadline({}));
  assert.equal(report.directoryUrgency(c).value,'Deadline not recorded');
});

test('all written item notes include saved author and Eastern timestamp, newest first',()=>{
  const data=record(),base={order_line_ids:['a1'],action:'commented',payload:{source:'pending_order_line_note'}};
  data.events=[{...base,id:'old',notes:'First search',signed_by_email:'first@example.test',created_at:'2026-10-28T18:00:00Z'},
    {...base,id:'new',notes:'Second search',signed_by_email:'second@example.test',created_at:'2026-10-29T03:00:00Z'},
    {...base,id:'unknown',notes:'Legacy note'}];
  data.events.push(data.events[0]);
  const c=customer(data),notes=c.rows[0].notes;
  assert.deepEqual(notes.map(n=>n.text),['Second search','First search','Legacy note']);
  assert.equal(notes[0].author,'second@example.test');assert.match(notes[0].date,/Oct 28, 2026.*11:00 PM EDT/);
  assert.equal(notes[2].author,'Author not recorded');assert.equal(notes[2].date,'Not recorded');
  const html=report.render(report.makeReport([c],'all',now.toISOString()));
  for(const expected of ['First search','Second search','first@example.test','second@example.test','Eastern time','Date/time not recorded'])assert.ok(html.includes(expected));
  assert.match(html,/href="#customer-directory"/);assert.match(html,/href="#customer-0">↑ Customer profile/);
  const q=queue();q[0].latest_line_note='Saved summary';
  assert.equal(customer(record(),q).rows[0].notes[0].author,'Author not recorded');
});


test('each missing index line retains its own amount and time since its current missing marker',()=>{
  const data=record();data.lines[1].sold_for=42;data.lines[1].quantity=2;
  const q=[...queue(),{...data.lines[1],item_search:{is_missing:true,updated_at:'2026-10-29T16:30:00Z',updated_by_email:'second@example.test'}}];
  const c=customer(data,q),first=c.rows.find(r=>r.id==='a1'),second=c.rows.find(r=>r.id==='a2');
  assert.equal(first.price.total,100);assert.equal(second.price.total,84);
  assert.equal(first.missingAge,'21 hours');assert.equal(second.missingAge,'1 hour 30 min');
  assert.equal(first.deadline.age,'11 hours');assert.equal(second.deadline.age,'11 hours');
  assert.match(first.timeline.find(e=>e.label==='Marked missing').text,/Marked by: staff@example.test/);
  assert.match(second.timeline.find(e=>e.label==='Marked missing').text,/Marked by: second@example.test/);
  const html=report.render(report.makeReport([c],'all',now.toISOString()));
  const index=html.match(/<nav class="missing-item-index"[\s\S]*?<\/nav>/)[0];
  for(const expected of ['$100.00','$84.00','21 hours','1 hour 30 min','Overdue: 11 hours','href="#missing-item-a1"','href="#missing-item-a2"'])assert.ok(index.includes(expected),expected);
});

test('missing watch markers use the recorded creator and keep unknown or future marker times honest',()=>{
  const q=queue();delete q[0].item_search;
  q[0].missingWatch={created_at:'2026-10-27T15:00:00Z',created_by_email:'creator@example.test',assignee:'Different task owner'};
  let row=customer(record(),q).rows[0];
  assert.equal(row.missingAge,'2 days 3 hours');assert.equal(row.markedBy,'creator@example.test');
  assert.match(row.timeline.find(e=>e.label==='Marked missing').text,/creator@example.test/);
  delete q[0].missingWatch.created_by_email;delete q[0].missingWatch.created_at;
  row=customer(record(),q).rows[0];assert.equal(row.markedBy,'Not recorded');assert.equal(row.missingAge,'Not recorded');
  assert.equal(row.timeline.some(e=>e.label==='Marked missing'),false);
  q[0].item_search={is_missing:true,updated_by_email:'<script>bad</script>',updated_at:'2026-10-30T18:00:00Z'};
  row=customer(record(),q).rows[0];assert.equal(row.missingAge,'Date needs verification');
  const html=report.render(report.makeReport([customer(record(),q)],'all',now.toISOString()));
  assert.ok(!html.includes('<script>bad'));assert.match(html,/Marked by: &lt;script&gt;bad/);
  assert.equal(report.missingAge('not-a-date',now),'Not recorded');
});
