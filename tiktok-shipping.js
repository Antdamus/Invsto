/* Shipping requests contain TikTok order IDs only. TikTok reviews and purchases postage. */
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.TikTokShipping=api;})(typeof globalThis==='object'?globalThis:this,function(){
 'use strict';
 const MAX_ORDERS=50;
 function eligible(o){return o.marketplace_status==='To ship'&&o.marketplace_substatus==='Awaiting shipment'&&!['dispatched','completed'].includes(o.stage)&&!o.cancel_return&&o.lines?.length>0&&!o.lines.some(l=>l.tracking_number)&&!o.documents?.some(d=>d.kind==='label');}
 function buyerOrders(orders,key){return orders.filter(o=>o.buyer_username.toLowerCase()===key&&eligible(o));}
 function request(orders,keys){
  const selected=[...new Set(keys)].flatMap(key=>buyerOrders(orders,key));
  if(!selected.length)throw Error('No orders awaiting shipment without an existing label are selected.');
  const ids=[...new Set(selected.map(o=>o.order_number))];
  if(ids.some(id=>typeof id!=='string'||!/^\d{10,24}$/.test(id)))throw Error('An order ID is missing or invalid. Import a fresh TikTok export.');
  if(ids.length>MAX_ORDERS)throw Error('Choose fewer buyers: TikTok label batches in OG support up to 50 orders at a time.');
  const url=new URL('https://seller-us.tiktok.com/order?shop_region=US');url.hash=new URLSearchParams({ogLabels:ids.join(';')}).toString();
  return {ids,url:url.href,orders:selected,buyers:new Set(selected.map(o=>o.buyer_username.toLowerCase())).size};
 }
 return {MAX_ORDERS,eligible,buyerOrders,request};
});
