import assert from 'node:assert/strict';
import {test} from 'node:test';
import report from '../ebay-buyer-report.js';

test('item amounts exclude API shipping and apply CSV unit price to quantity once',()=>{
  assert.equal(report.itemPrice({quantity:2,sold_for:55,raw_payload:{line:{lineItemCost:{value:'100',currency:'USD'},total:{value:'110'}}}}).total,100);
  assert.equal(report.itemPrice({quantity:3,raw_payload:{'Sold For':'$12.50'}}).total,37.5);
  assert.equal(report.itemPrice({sold_for:110,raw_payload:{source:'ebay_fulfillment_api',line:{}}}).total,null);
  assert.equal(report.itemPrice({sold_for:0}).total,0);
  assert.equal(report.amount('Unknown'),null);
  assert.equal(report.totalsFor([{price:{total:10,currency:'USD'}},{price:{total:20,currency:'EUR'}},{price:{total:null,currency:'USD'}}]),'$10.00 + €20.00');
});
test('date-only imports keep the sale day; actual timestamps use Eastern time',()=>{
  assert.match(report.purchaseDate({sale_date:'2026-08-29T00:00:00Z',raw_payload:{first_row:{'Sale Date':'Aug-29-26'}}}),/^Aug-29-26 \| Time not recorded$/);
  assert.equal(report.purchaseDate({sale_date:'2026-08-29',raw_payload:{}}),'2026-08-29 | Time not recorded');
  assert.match(report.purchaseDate({sale_date:'2026-10-27T07:22:00Z'}),/Oct 27, 2026.*3:22 AM EDT/);
});
test('screenshots cannot leak from a sibling line or unrelated item',()=>{
  const line={id:'line-a',item_number:'123456789012'};
  const photo={path:'video-receipts/screenshot-123456789012.png',metadata:{selectedItemId:'123456789012'}};
  const event={order_line_ids:['line-a','line-b'],photo_attachments:[photo]};
  assert.equal(report.photosForLine(line,[event]).length,1);
  assert.equal(report.photosForLine({...line,id:'line-c'},[event]).length,0);
  assert.equal(report.photosForLine({...line,item_number:'987654321012'},[event]).length,0);
  assert.equal(report.photosForLine(line,[{...event,photo_attachments:[{...photo,metadata:{selectedItemId:'999999999999'}}]}]).length,0);
  assert.equal(report.photosForLine(line,[{...event,photo_attachments:[{...photo,order_line_ids:['line-b']}]}]).length,0);
  assert.equal(report.photosForLine(line,[event,event]).length,1);
});
test('receipt URLs reject hostile links and select only a purchased item',()=>{
  const photo=url=>({metadata:{videoReceiptUrl:url}});
  assert.equal(report.receiptUrl(photo('javascript:alert(1)'),'123'),'');
  assert.equal(report.receiptUrl(photo('https://evil.test/ebaylive/events/test?selectedItemId=123'),'123'),'');
  assert.equal(report.receiptUrl(photo('https://www.ebay.com/ebaylive/events/test?selectedItemId=999'),'123'),'');
  assert.match(report.receiptUrl(photo('https://www.ebay.com/ebaylive/events/test?selectedItemId=999&itemIds=999,123'),'123'),/selectedItemId=123/);
});
test('grouped purchases retain separate order numbers and missing image states; preview escapes titles',()=>{
  const records={orders:[{id:'a',order_number:'01-test',sale_date:'2026-10-27'},{id:'b',order_number:'02-test',sale_date:'2026-10-28'}],
    lines:[{id:'la',order_id:'a',item_title:'<img onerror=alert(1)>',sold_for:10},{id:'lb',order_id:'b',sold_for:20}],events:[],
    adminEvents:[{id:'group',order_line_ids:['la','lb']}]};
  const rows=report.buildRows(records,'https://example.test/Invsto/ebay-buyer-report.html');
  assert.equal(rows.length,2);assert.deepEqual(rows.map(row=>row.orderNumber),['01-test','02-test']);
  assert.match(rows[0].groups[0],/01-test, 02-test/);
  assert.match(rows[0].imageStatus,/No saved/);
  assert.match(rows[0].historyUrl,/focusLineId=la/);
  const rendered=report.renderReport('buyer',records,rows);
  assert.ok(!rendered.includes('<img onerror='));assert.match(rendered,/&lt;img onerror=/);
});
test('video receipt links are independent of screenshots and select the correct item from order metadata',()=>{
  const wrong='https://www.ebay.com/ebaylive/events/other?selectedItemId=999';
  const saved='https://www.ebay.com/ebaylive/events/correct?selectedItemId=999&amp;itemIds=999,123';
  const records={orders:[{id:'a',order_number:'01-test',label_metadata:{videoReceiptUrl:wrong,returnDetails:{videoReceiptUrls:[saved]}}}],
    lines:[{id:'la',order_id:'a',item_number:'123',transaction_id:'tx',sold_for:10}],events:[],adminEvents:[]};
  const [row]=report.buildRows(records,'https://example.test/Invsto/ebay-buyer-report.html');
  assert.equal(row.photos.length,0);assert.match(row.videoUrl,/events\/correct\?selectedItemId=123/);
  assert.equal(row.transactionId,'tx');assert.equal(report.receiptAction(row).label,'Video receipt');
  assert.match(report.renderReport('buyer',records,[row]),/data-report-receipt="la"[^>]*>Video receipt<\/a>/);
});
test('missing direct receipts always have a find action and an honest PDF fallback',()=>{
  const records={orders:[{id:'a',order_number:'01-test',label_metadata:{videoReceiptUrl:'https://www.ebay.com/ebaylive/events/wrong?selectedItemId=999'}}],
    lines:[{id:'la',order_id:'a',item_number:'123',sold_for:10}],events:[],adminEvents:[]};
  const [row]=report.buildRows(records,'https://example.test/Invsto/ebay-buyer-report.html');
  assert.equal(row.videoUrl,'');assert.equal(report.receiptAction(row).href,row.orderUrl);
  assert.equal(report.receiptAction(row).pdfLabel,'Video receipt via eBay');
  assert.match(report.renderReport('buyer',records,[row]),/>Find video receipt<\/a>/);
});
test('a matching scoped receipt event works before photo capture; receipt binding passes item and transaction to the existing lookup',()=>{
  const line={id:'la',item_number:'123'}, url='https://www.ebay.com/ebaylive/events/saved?selectedItemId=123';
  assert.equal(report.savedReceiptUrl(line,{},[],[{order_line_ids:['other'],payload:{videoReceiptUrl:url}}]),'');
  assert.match(report.savedReceiptUrl(line,{},[],[{order_line_ids:['la'],payload:{videoReceiptUrl:url}}]),/selectedItemId=123/);
  let handler,received;
  const anchor={dataset:{reportReceipt:'la'},addEventListener(name,callback){assert.equal(name,'click');handler=callback;}};
  globalThis.OGVideoReceipts={open(event,receipt){received=receipt;}};
  try{
    report.bindReceiptLinks({querySelectorAll:()=>[anchor]},[{id:'la',orderId:'a',orderNumber:'01-test',item:'123',transactionId:'tx',title:'Watch',videoUrl:''}]);
    handler({currentTarget:anchor});assert.equal(received.itemNumber,'123');assert.equal(received.transactionId,'tx');assert.equal(received.orderId,'a');
  }finally{delete globalThis.OGVideoReceipts;}
});
test('all pages are fetched and a later-page error stops incomplete reports',async()=>{
  let requests=0;const rows=await report.paged(()=>({range:async start=>{requests++;return {data:Array.from({length:start===0?250:2},(_,i)=>({id:start+i}))};}}));
  assert.equal(rows.length,252);assert.equal(requests,2);
  await assert.rejects(()=>report.paged(()=>({range:async start=>start?{error:{message:'Read failed'}}:{data:Array.from({length:250},(_,id)=>({id}))}})),/Read failed/);
  assert.equal(report.exactPattern(' Buyer_% '),'Buyer\\_\\%');
});
test('buyer data reads use exact usernames and keep pending and closed orders',async()=>{
  const calls=[];const client={from(table){const filters=[];const query={
    select(columns){calls.push({table,columns,filters});return query;},ilike(...args){filters.push(['ilike',...args]);return query;},
    in(...args){filters.push(['in',...args]);return query;},overlaps(...args){filters.push(['overlaps',...args]);return query;},order(){return query;},
    async range(){if(table==='ebay_orders')return {data:[{id:'a',order_number:'o1',buyer_username:'BUY_ER',status:'pending'},{id:'b',order_number:'o2',buyer_username:'buy_er',status:'fulfilled'},{id:'c',buyer_username:'buyXer'}]};
      if(table==='ebay_order_lines')return {data:[{id:'l1',order_id:'a'},{id:'l2',order_id:'b'}]};return {data:[]};}};return query;}};
  const records=await report.loadRecords(client,'buy_er');
  assert.equal(records.orders.length,2);
  assert.deepEqual(calls[0].filters,[['ilike','buyer_username','buy\\_er']]);
  assert.ok(calls[0].columns.includes('label_metadata'));
  assert.ok(calls.some(call=>call.table==='ebay_order_admin_events'&&!call.columns.includes('evidence_photos')));
  await assert.rejects(()=>report.loadRecords(client,''),/Choose a buyer/);
});
