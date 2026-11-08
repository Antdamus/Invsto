import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test} from 'node:test';
const ctx=vm.createContext({console,URL,URLSearchParams,window:{addEventListener(){},location:{search:''}},document:{addEventListener(){}}});
vm.runInContext(readFileSync(new URL('../ebay-order-history.js',import.meta.url),'utf8'),ctx);
const run=code=>vm.runInContext(code,ctx);
const purchase=order=>ctx.getHistoryPurchaseTime({order});
test('purchase uses the sale timestamp in Eastern, never completion or payment time',()=>{
 const value=ctx.getHistoryPurchaseTime({fulfilled_at:'2026-11-03T20:12:00Z',order:{sale_date:'2026-11-02T20:54:24Z',paid_on_date:'2026-11-04T01:00:00Z'}});
 assert.match(value.text,/Nov 2, 2026/);assert.match(value.text,/3:54:24 PM EST/);
 assert.match(purchase({sale_date:'2026-07-02T20:54:24Z'}).text,/4:54:24 PM EDT/);
 assert.match(purchase({sale_date:'2026-11-03T01:30:00Z'}).text,/Nov 2, 2026.*8:30:00 PM EST/);
});
test('date-only CSV placeholders do not fabricate a purchase time',()=>{
 for(const raw_payload of [{date_precision:{sale_date:'day'}},{first_row:{'Sale Date':'Nov-02-26'}}]){
  const result=purchase({sale_date:'2026-11-02T12:00:00Z',raw_payload});
  assert.equal(result.precision,'day');assert.equal(result.text,'Nov 2, 2026 · time not provided');
 }
 assert.equal(purchase({sale_date:'2026-11-02'}).precision,'day');
 assert.equal(purchase({sale_date:'invalid',paid_on_date:'2026-11-02T20:54:24Z'}).precision,'unknown');
 assert.equal(purchase({}).text,'Purchase time unavailable');
});
test('official API purchase evidence supersedes old day-only placeholder and supports archived orders',()=>{
 const raw_payload={date_precision:{sale_date:'day'},order:{creationDate:'2026-11-02T20:54:24Z'}};
 assert.match(purchase({sale_date:'2026-11-02T12:00:00Z',raw_payload}).text,/3:54:24 PM EST/);
 assert.match(purchase({raw_payload:{ebay_order_dates:{sale_date:'2026-11-02T20:54:24Z'}}}).text,/3:54:24 PM EST/);
});
const item='287699891874',url=`https://www.ebay.com/ebaylive/events/example/stream?playback=true&selectedItemId=${item}&itemIds=${item}`;
const line={id:'line-one',item_number:item,order:{order_number:'03-15391-51989',sale_date:'2026-11-02T20:54:24Z'}};
const event={id:'receipt',order_line_ids:['line-one'],photo_attachments:[{bucket:'proof',path:`video-receipts/${item}.png`,label:`Video receipt - ${item}`,metadata:{videoReceiptUrl:url}}]};
test('existing item receipt supplies both receipt and live-show links alongside purchase timestamp',()=>{
 const markup=ctx.renderHistoryLineVideoReceiptPhotos(line,[event]);
 assert.match(markup,/Purchased/);assert.match(markup,/3:54:24 PM EST/);
 assert.match(markup,/Open video receipt/);assert.match(markup,/Open live show/);
 assert.match(markup,/href="https:\/\/www.ebay.com\/ebaylive\/events\/example\/stream\?playback=true"/);
 assert.match(markup,/selectedItemId=287699891874/);assert.match(markup,/View screenshot/);
});
test('unrelated or unsafe receipts never supply a show link; existing eBay order fallback remains',()=>{
 for(const events of [[{...event,order_line_ids:['other']}],[{...event,photo_attachments:[{...event.photo_attachments[0],metadata:{videoReceiptUrl:url.replaceAll(item,'999999999999')}}]}],[{...event,photo_attachments:[{...event.photo_attachments[0],metadata:{videoReceiptUrl:'https://evil.test/ebaylive/events/example'}}]}]]){
  const html=ctx.renderHistoryLineVideoReceiptPhotos(line,events);
  assert.doesNotMatch(html,/Open live show/);assert.match(html,/Open video receipt/);assert.match(html,/orderid=03-15391-51989/);
 }
 assert.match(ctx.renderHistoryLineVideoReceiptPhotos({order:{sale_date:'2026-11-02'}}),/time not provided/);
});

