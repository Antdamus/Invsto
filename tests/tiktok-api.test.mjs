import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHmac, randomBytes} from 'node:crypto';
import {sign,seal,unseal,mapOrder,validateTokens,chooseProductionShop,client,ORDER_PATH} from '../supabase/functions/tiktok-order-sync/tiktok.ts';
const sample=()=>({id:'577637745070936130',user_id:'7021436810468230477',status:'AWAITING_SHIPMENT',buyer_nickname:'Test buyer',recipient_address:{name:'Test Person'},payment:{currency:'USD',total_amount:'12.30'},create_time:1792950000,paid_time:1792950020,update_time:1792950050,line_items:[{id:'577637745070936131',sku_id:'1732789145515889437',product_id:'1732789133450515229',product_name:'Test item',display_status:'AWAITING_SHIPMENT',sale_price:'12.30',currency:'USD'}]});
const tokens=()=>({user_type:0,seller_base_region:'US',granted_scopes:['seller.order.info','seller.authorization.info'],access_token:'test-access',refresh_token:'test-refresh',access_token_expire_in:2e9,refresh_token_expire_in:2.1e9});
test('API signature sorts query fields, excludes access token/sign, and signs the exact body',async()=>{
 const query={timestamp:'123',app_key:'app',shop_cipher:'shop',access_token:'private',sign:'old'},body='{"hello":1}';
 assert.equal(await sign('/order/path',query,body,'secret'),createHmac('sha256','secret').update('secret/order/pathapp_keyappshop_ciphershoptimestamp123'+body+'secret').digest('hex'));
 assert.notEqual(await sign('/order/path',query,'{}','secret'),await sign('/order/path',query,body,'secret'));
});
test('credentials use authenticated encryption with randomized nonces and reject tampering/wrong keys',async()=>{
 const key=randomBytes(32).toString('base64'),value=tokens(),a=await seal(value,key),b=await seal(value,key);
 assert.notEqual(a,b);assert.ok(!a.includes('test-access'));assert.deepEqual(await unseal(a,key),value);
 await assert.rejects(unseal(a,randomBytes(32).toString('base64')));
 const parts=a.split('.');const bytes=Buffer.from(parts[2],'base64');bytes[0]^=1;parts[2]=bytes.toString('base64');await assert.rejects(unseal(parts.join('.'),key));
});
test('seller, region, scopes and expiries are checked; sandbox and accidental shop switches are rejected',()=>{
 assert.equal(validateTokens(tokens(),100).user_type,0);
 for(const patch of [{user_type:1},{seller_base_region:'GB'},{granted_scopes:['seller.order.info']},{access_token_expire_in:1}])assert.throws(()=>validateTokens({...tokens(),...patch},100));
 const shop={id:'7494924429697648999',cipher:'opaque',name:'OG Jewelers',region:'US'};
 assert.equal(chooseProductionShop([shop]).id,shop.id);
 for(const shops of [[],[shop,shop],[{...shop,name:'SANDBOX_US_TEST'}],[{...shop,id:'7494924429697648413'}],[{...shop,region:'GB'}]])assert.throws(()=>chooseProductionShop(shops));
 assert.throws(()=>chooseProductionShop([shop],'7494924429697648111'));
});
test('order mapping keeps long IDs as text, groups unit lines, and never invents a buyer username',()=>{
 const order=sample();order.line_items.push({...order.line_items[0],id:'577637745070936132'});const [row]=mapOrder(order);
 assert.equal(row.quantity,2);assert.equal(row.line_amount,'24.60');assert.equal(row.order_number,order.id);assert.equal(row.buyer_username,'TikTok buyer '+order.user_id);
 assert.equal(mapOrder(order,'existing.handle')[0].buyer_username,'existing.handle');assert.equal(row.recipient_name,'Test Person');
 order.recipient_address.name='T*** P***';assert.equal(mapOrder(order)[0].recipient_name,'');
});
test('partial same-SKU cancellations hold fulfillment; full cancelled SKUs remain explicitly cancelled',()=>{
 const order=sample();order.line_items.push({...order.line_items[0],id:'577637745070936132',display_status:'CANCELLED'});
 assert.match(mapOrder(order)[0].cancel_return,/partially cancelled/);assert.equal(mapOrder(order)[0].api_cancelled,false);
 order.line_items[0].display_status='CANCELLED';assert.equal(mapOrder(order)[0].api_cancelled,true);
 order.status='CANCELLED';assert.equal(mapOrder(order)[0].marketplace_status,'Canceled');
});
test('API purchase dates and shipping deadlines use the US shop calendar instead of the UTC date',()=>{
 const order=sample();order.create_time=Date.parse('2026-10-25T01:30:00Z')/1000;order.shipping_due_time=Date.parse('2026-10-27T02:00:00Z')/1000;
 const row=mapOrder(order);assert.equal(row[0].created_time,'2026-10-24 21:30:00');assert.equal(row[0].ship_by_date,'2026-10-26');
});
test('unknown status, unsafe numeric IDs, duplicate lines, missing items and foreign currency fail closed',()=>{
 for(const mutate of [o=>o.id=577637745070936130,o=>o.status='NEW_UNKNOWN_STATE',o=>o.line_items=[],o=>o.payment.currency='EUR',o=>o.line_items.push(o.line_items[0]),o=>o.line_items[0].sale_price='1e5',o=>o.line_items[0].display_status='UNKNOWN']){
  const o=sample();mutate(o);assert.throws(()=>mapOrder(o));
 }
});
test('HTTP client permits only the two read APIs, sends seller token in header, and suppresses vendor secret echoes',async()=>{
 const api=client('key','secret',async(url,options)=>{
  assert.equal(new URL(url).origin,'https://open-api.tiktokglobalshop.com');assert.equal(options.redirect,'error');
  assert.equal(options.headers['x-tts-access-token'],'private');assert.ok(!String(url).includes('private'));
  return Response.json({code:123,message:'secret=secret&access_token=private',request_id:'ABC123'});
 });
 await assert.rejects(api.read('/product/202309/products','private'),/Unsupported/);
 await assert.rejects(api.read(ORDER_PATH,'private',{page_size:'50'},{}),error=>error.message==='TikTok request failed (123; request ABC123).');
});

import {checkoutFacts,statementCharge,unsettledFees} from '../supabase/functions/tiktok-order-sync/queue-money.ts';
test('checkout basis excludes tax, includes platform discount, and only complete order statements replace estimates',()=>{
 assert.deepEqual(checkoutFacts({currency:'USD',total_amount:'42.50',tax:'2.50',platform_discount:'5.00',shipping_fee:'3.25'}),{buyer_shipping:3.25,referral_basis:45});
 assert.deepEqual(checkoutFacts({currency:'USD'}),{buyer_shipping:null,referral_basis:null});
 const data={order_id:'123',currency:'USD',total_count:1,fee_and_tax_amount:'-2.19',sku_transactions:[{sku_id:'sku',quantity:2,statement_id:'stmt'}]};
 assert.equal(statementCharge(data,'123',[{sku_id:'sku',quantity:2}]),2.19);
 assert.equal(statementCharge(data,'456',[{sku_id:'sku',quantity:2}]),null);
 assert.equal(statementCharge(data,'123',[{sku_id:'sku',quantity:3}]),null);
 assert.equal(statementCharge({...data,total_count:2},'123',[{sku_id:'sku',quantity:2}]),null);
});

test('unsettled fee lookups omit adjustments, incomplete pages, and ambiguous transactions',()=>{
 const row={order_id:'123',status:'UNSETTLED',type:'ORDER',currency:'USD',est_fee_tax_amount:'-1.20'};
 assert.equal(unsettledFees({transactions:[row,{...row,type:'CHARGE_BACK'}],total_count:2}).get('123'),1.2);
 assert.equal(unsettledFees({transactions:[row,row],total_count:2}).get('123'),null);
 assert.equal(unsettledFees({transactions:[row],total_count:3,next_page_token:'more'}).size,0);
});
