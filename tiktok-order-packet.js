/* 4 × 6 packing slips, kept distinct from postage labels. */
(function(root) {
 'use strict';
 async function create(orders, PDFLib=root.PDFLib) {
  if (!orders.length) throw Error('Choose at least one TikTok order.');
  if (orders.length>250) throw Error('Narrow the view to 250 orders or fewer for one packet.');
  const doc=await PDFLib.PDFDocument.create(), font=await doc.embedFont(PDFLib.StandardFonts.Helvetica), bold=await doc.embedFont(PDFLib.StandardFonts.HelveticaBold);
  doc.setTitle('TikTok order packet');doc.setSubject('Packing slips — not shipping labels');
  const safe=value=>Array.from(String(value??'')).map(c=>{try{font.encodeText(c);return c;}catch{return `[U+${c.codePointAt(0).toString(16).toUpperCase()}]`;}}).join('');
  let page,y,order;
  function newPage(){page=doc.addPage([288,432]);y=410;page.drawText('OG JEWELRY / TIKTOK',{x:16,y,size:10,font:bold});y-=16;page.drawText('ORDER PACKET - NOT POSTAGE',{x:16,y,size:8,font});y-=20;if(order){let buyer=safe(order.buyer_username).replace(/\s+/g,' ');while(bold.widthOfTextAtSize(buyer,12)>256)buyer=buyer.slice(0,-4)+'...';page.drawText(buyer,{x:16,y,size:12,font:bold});y-=16;line('Order '+order.order_number,9,true);y-=4;}}
  function line(value,size=9,strong=false){
   const f=strong?bold:font,text=safe(value).replace(/\r/g,''),max=256;
   for(const paragraph of text.split('\n')){
    let current='';
    for(const word of paragraph.split(/\s+/)){
     if(current&&f.widthOfTextAtSize(current+' '+word,size)>max){draw(current);current='';}
     for(const c of (current?' ':'')+word){if(f.widthOfTextAtSize(current+c,size)>max){draw(current);current='';}current+=c;}
    }
    draw(current||' ');
   }
   function draw(t){if(y<34)newPage();page.drawText(t,{x:16,y,size,font:f});y-=size+4;}
  }
  for(order of orders){
   newPage();if(bold.widthOfTextAtSize(safe(order.buyer_username).replace(/\s+/g,' '),12)>256)line('Buyer: '+order.buyer_username,8);line('TikTok: '+order.marketplace_status+' / '+order.marketplace_substatus,8);
   line('OG preparation: '+order.stage,8);line('Ship by: '+(order.ship_by_date||'Unavailable in export'),8);
   line('Source export: '+new Date(order.source_snapshot_at).toLocaleString(),7);y-=8;
   for(const item of order.lines||[]){line(`${item.quantity} × ${item.title}`,10,true);line('Seller SKU: '+(item.seller_sku||'—')+' / Variation: '+(item.variation||'—'),8);line('SKU ID: '+item.sku_id,7);if(item.package_id)line('Package: '+item.package_id,7);if(item.tracking_number)line('Tracking: '+item.tracking_number,8);y-=7;}
   if(order.order_amount!=null)line('Order total: USD '+Number(order.order_amount).toFixed(2),9,true);
   if(order.buyer_message)line('Buyer message: '+order.buyer_message,8);
   if(order.seller_note)line('Seller note: '+order.seller_note,8);
   if(order.notes)line('OG notes: '+order.notes,8);
   y-=5;line('Check the physical items and full video receipt in TikTok before packing. Use TikTok postage on the parcel.',8);
  }
  const pages=doc.getPages();pages.forEach((p,i)=>p.drawText(`TikTok only | ${i+1}/${pages.length}`,{x:16,y:14,size:7,font}));
  return doc.save();
 }
 if(typeof module==='object'&&module.exports)module.exports={create};else root.TikTokOrderPacket={create};
})(typeof globalThis==='object'?globalThis:this);
