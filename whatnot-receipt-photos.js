(function(){
 'use strict';
 const saving=new Set();
 document.documentElement.dataset.wnReceiptReceiver='2';
 const tell=(text)=>{const status=document.getElementById('wn-status');if(status)status.textContent=text;};
 window.addEventListener('message',async event=>{
  if(event.source!==window||event.origin!==location.origin)return;const m=event.data;
  if(m?.type==='OG_WHATNOT_RECEIPT_AVAILABLE')window.postMessage({type:'OG_WHATNOT_RECEIPT_READY',transferId:m.transferId},location.origin);
  if(m?.type==='OG_WHATNOT_RECEIPT_BRIDGE_READY')window.postMessage({type:'OG_WHATNOT_RECEIPT_READY'},location.origin);
  if(m?.type!=='OG_WHATNOT_RECEIPT_DATA')return;
  const p=m.payload;if(!p||!/^[a-f0-9-]{36}$/i.test(p.transferId||'')||saving.has(p.transferId))return;
  if(p.error){tell(p.error);return;}if(p.completed)return;
  saving.add(p.transferId);document.documentElement.dataset.wnReceiptSaving='true';
  try{
   if(!/^\d{1,19}$/.test(p.itemId||'')||!/^\d{1,19}$/.test(p.orderNumber||'')||!/^data:image\/jpeg;base64,/.test(p.image||'')||p.image.length>8*1024*1024)throw Error('Invalid Whatnot photo handoff.');
   const db=window.supabaseClient,auth=await db.auth.getUser();if(!auth.data.user)throw Error('Sign in to Invsto before saving the receipt photo.');
   const r=await db.from('whatnot_order_lines').select('id,order_id,revision,whatnot_orders!inner(url)').eq('id',p.itemId).eq('order_id',p.orderNumber).maybeSingle();
   if(r.error||!r.data)throw Error('This exact order item has not synced yet. Sync Whatnot and capture again.');
   const expected=new URL(r.data.whatnot_orders.url),source=new URL(p.sourceUrl);
   if(expected.origin!==source.origin||expected.pathname!==source.pathname)throw Error('The receipt does not belong to this saved order.');
   const path=`${auth.data.user.id}/${p.transferId}.jpg`,blob=await(await fetch(p.image)).blob();
   const existing=await db.from('whatnot_order_files').select('id').eq('path',path).maybeSingle();
   if(existing.error)throw Error(existing.error.message);
   if(!existing.data){
    const up=await db.storage.from('whatnot-order-evidence').upload(path,blob,{contentType:'image/jpeg',upsert:false});
    if(up.error&&!/already exists|Duplicate/i.test(up.error.message))throw Error(up.error.message);
    const save=await db.rpc('attach_whatnot_file',{_path:path,_kind:'item_photo',_name:`Whatnot order ${p.orderNumber} receipt.jpg`,_mime:'image/jpeg',_lines:[{id:r.data.id,revision:r.data.revision}]});if(save.error)throw Error(save.error.message);
   }
   window.postMessage({type:'OG_WHATNOT_RECEIPT_DONE',transferId:p.transferId},location.origin);
   document.querySelectorAll(`[data-evidence="${p.itemId}"]`).forEach(d=>{delete d.dataset.loaded;d.open=false;});const message=`Photo saved successfully · Whatnot order ${p.orderNumber}, item ${p.itemId}. Open its photos to review.`;tell(message);
   document.dispatchEvent(new CustomEvent('whatnot-item-photo-saved',{detail:message}));
  }catch(e){tell(e.message);}finally{saving.delete(p.transferId);document.documentElement.dataset.wnReceiptSaving=String(saving.size>0);}
 });
 window.postMessage({type:'OG_WHATNOT_RECEIPT_READY'},location.origin);
})();
