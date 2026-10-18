(function(){
 'use strict';
 const BUCKET='tiktok-receipt-photos',urls=new Map();
 const time=seconds=>{const value=Math.floor(Number(seconds)||0);return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`;};
 function placeholder(line){return `<div class="tk-receipt-photos" data-tk-photo-line="${line.id}"></div>`;}
 async function hydrate(root,db,photos){
  for(const slot of root.querySelectorAll('[data-tk-photo-line]')){
   const matches=photos.filter(p=>p.line_id===slot.dataset.tkPhotoLine);if(!matches.length)continue;
   for(const p of matches){
    try{
     let cached=urls.get(p.path);
     if(!cached||cached.expires<Date.now()){
      const {data,error}=await db.storage.from(BUCKET).createSignedUrl(p.path,1800);if(error)throw error;
      cached={url:data.signedUrl,expires:Date.now()+1500000};urls.set(p.path,cached);
     }
     if(!slot.isConnected)break;
     const a=document.createElement('a'),img=document.createElement('img'),caption=document.createElement('span');
     a.href=cached.url;a.target='_blank';a.rel='noopener';a.className='tk-receipt-photo';
     img.src=cached.url;img.alt='TikTok receipt item photo';img.loading='lazy';
     caption.textContent='Receipt photo · '+time(p.video_time);a.append(img,caption);slot.append(a);
    }catch{
     if(slot.isConnected){const message=document.createElement('span');message.className='tk-help';message.textContent='Receipt photo could not load. Refresh to try again.';slot.append(message);}
    }
   }
  }
 }
 function start({db,user,getOrders,refresh,reveal,status}){
  const id=new URLSearchParams(location.search).get('tiktokReceipt');if(!id)return;
  let receiving=false,finished=false,pending;
  const panel=document.createElement('section');panel.className='tk-receipt-transfer';panel.setAttribute('aria-live','polite');
  const text=document.createElement('p'),retry=document.createElement('button');retry.type='button';retry.textContent='Retry saving capture';retry.hidden=true;
  text.textContent='Receiving the TikTok receipt capture…';panel.append(text,retry);document.getElementById('tk-status').after(panel);
  const request=()=>window.postMessage({type:'OG_TIKTOK_RECEIPT_READY'},location.origin);
  retry.onclick=async()=>{if(!pending||pending.error){pending=null;request();return;}try{await refresh();await receive(pending);}catch(e){text.textContent=e.message;}};
  async function receive(p){
   if(receiving||finished||p?.transferId!==id)return;receiving=true;pending=p;retry.hidden=true;
   try{
    if(p.error)throw Error(p.error);
    if(!/^\d{10,24}$/.test(p.orderNumber||'')||!/^\d{10,24}$/.test(p.skuId||''))throw Error('The capture has no valid order and SKU identity. Capture it again in TikTok.');
    const order=getOrders().find(o=>o.order_number===p.orderNumber),line=order?.lines.find(l=>l.sku_id===p.skuId);
    if(!line)throw Error(`Order ${p.orderNumber}, SKU ${p.skuId} is not imported in OG. Import a fresh TikTok export, then retry this capture within one hour.`);
    if(!p.completed){
     if(!/^[a-f0-9-]{36}$/i.test(id)||typeof p.image!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(p.image)||p.image.length>7100000||!Number.isFinite(p.videoTime)||p.videoTime<0||p.videoTime>604800)throw Error('Invalid receipt photo. Capture it again in TikTok.');
     const blob=await (await fetch(p.image)).blob();if(blob.size>5*1024*1024)throw Error('Receipt photo exceeds 5 MB.');
     const image=await createImageBitmap(blob);if(!image.width||!image.height)throw Error('The capture is empty.');image.close();
     const path=`${user.id}/${id.toLowerCase()}.jpg`;
     text.textContent=`Saving receipt photo to order ${p.orderNumber} · SKU ${p.skuId}…`;
     const {error:uploadError}=await db.storage.from(BUCKET).upload(path,blob,{contentType:'image/jpeg',upsert:false});
     if(uploadError&&String(uploadError.statusCode||uploadError.status)!=='409'&&!/already exists|duplicate/i.test(uploadError.message||''))throw uploadError;
     const {error}=await db.rpc('attach_tiktok_receipt_photo',{_order_number:p.orderNumber,_sku_id:p.skuId,_transfer_id:id,_path:path,_video_time:p.videoTime});if(error)throw error;
     window.postMessage({type:'OG_TIKTOK_RECEIPT_DONE',transferId:id},location.origin);
    }
    await refresh();await reveal(order.id,line.id);finished=true;
    text.textContent=`Receipt photo saved to order ${p.orderNumber} · SKU ${p.skuId}.`;status(text.textContent);
   }catch(e){text.textContent=e.message||'Could not save this capture. Try again.';retry.hidden=false;status(text.textContent,true);}
   finally{receiving=false;}
  }
  window.addEventListener('message',event=>{
   if(event.source!==window||event.origin!==location.origin)return;
   if(event.data?.type==='OG_TIKTOK_RECEIPT_BRIDGE_READY')request();
   if(event.data?.type==='OG_TIKTOK_RECEIPT_DATA')receive(event.data.payload);
  });
  request();setTimeout(()=>{if(!receiving&&!pending&&!finished){text.textContent='Waiting for the extension. Update it, refresh this page, then retry.';retry.hidden=false;}},10000);
 }
 window.TikTokReceiptPhotos={placeholder,hydrate,start};
})();
