(function(){
 'use strict';
 const BUCKET='tiktok-receipt-photos',clients=new WeakMap(),observed=new Map();
 function client(db){
  if(!clients.has(db))clients.set(db,{urls:new Map(),inflight:new Map(),queue:new Map(),thumbnails:new Map(),cleanups:new Map(),removed:new Set(),user:null,timer:null,status:null});
  return clients.get(db);
 }
 // Batch visible images, and reuse the same URL for card/detail rerenders.
 function signedUrl(db,path){
  const c=client(db),cached=c.urls.get(path);
  if(cached?.expires>Date.now())return Promise.resolve(cached.url);
  if(c.inflight.has(path))return c.inflight.get(path);
  const promise=new Promise((resolve,reject)=>c.queue.set(path,{resolve,reject}));c.inflight.set(path,promise);
  if(c.timer===null)c.timer=setTimeout(()=>flushUrls(db,c),0);
  return promise;
 }
 async function flushUrls(db,c){
  c.timer=null;const pending=[...c.queue];c.queue.clear();
  for(let i=0;i<pending.length;i+=100){
   const batch=pending.slice(i,i+100);
   try{
    const {data,error}=await db.storage.from(BUCKET).createSignedUrls(batch.map(([path])=>path),1800);if(error)throw error;
    const results=new Map((data||[]).map(row=>[row.path,row]));
    for(const [path,task] of batch){
     const row=results.get(path);c.inflight.delete(path);
     if(row?.signedUrl&&!row.error){c.urls.set(path,{url:row.signedUrl,expires:Date.now()+1500000});task.resolve(row.signedUrl);}
     else task.reject(Error('Receipt photo could not load.'));
    }
   }catch(e){for(const [path,task] of batch){c.inflight.delete(path);task.reject(e);}}
  }
 }
 async function thumbnail(blob){
  const image=await createImageBitmap(blob);
  try{
   if(!image.width||!image.height)throw Error('The capture is empty.');
   const ratio=Math.min(1,320/Math.max(image.width,image.height)),canvas=document.createElement('canvas');
   canvas.width=Math.max(1,Math.round(image.width*ratio));canvas.height=Math.max(1,Math.round(image.height*ratio));
   const ctx=canvas.getContext('2d');ctx.imageSmoothingQuality='high';ctx.drawImage(image,0,0,canvas.width,canvas.height);
   const result=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',0.78));
   if(!result||result.type!=='image/jpeg'||result.size>262144)throw Error('Could not prepare the receipt thumbnail.');
   return result;
  }finally{image.close();}
 }
 async function upload(db,path,blob){
  const {error}=await db.storage.from(BUCKET).upload(path,blob,{contentType:'image/jpeg',cacheControl:'3600',upsert:false});
  if(error&&String(error.statusCode||error.status)!=='409'&&!/already exists|duplicate/i.test(error.message||''))throw error;
 }
 // Backfill only photos actually viewed, once per browser session; never transform on the server.
 function thumbnailPath(db,p){
  if(p.thumbnail_path)return Promise.resolve(p.thumbnail_path);
  const c=client(db);
  if(!c.thumbnails.has(p.id))c.thumbnails.set(p.id,(async()=>{
   const response=await fetch(await signedUrl(db,p.path));if(!response.ok)throw Error('Receipt photo download failed.');
   const blob=await response.blob();if(blob.size>5242880)throw Error('Receipt photo exceeds 5 MB.');
   const small=await thumbnail(blob),session=c.user?null:await db.auth.getSession();
   const user=c.user||session?.data?.session?.user;if(!user)throw Error('Sign in to save the thumbnail.');c.user=user;
   const path=`${user.id}/${p.transfer_id}-thumb.jpg`;await upload(db,path,small);
   const {data,error}=await db.rpc('finish_tiktok_receipt_thumbnail',{_photo_id:p.id,_thumbnail_path:path,_image_bytes:blob.size,_thumbnail_bytes:small.size});if(error)throw error;
   if(!data?.thumbnail_path)throw Error('Receipt thumbnail was not saved.');
   Object.assign(p,data);return data.thumbnail_path;
  })());
  return c.thumbnails.get(p.id);
 }
 const time=seconds=>{const value=Math.floor(Number(seconds)||0);return `${Math.floor(value/60)}:${String(value%60).padStart(2,'0')}`;};
 function placeholder(line){return `<div class="tk-receipt-photos" data-tk-photo-line="${line.id}"></div>`;}
 function cleanupRemovedPhoto(db,p,retry=false){
  if(p.files_deleted_at)return Promise.resolve(p);
  const c=client(db);if(retry)c.cleanups.delete(p.id);
  if(!c.cleanups.has(p.id))c.cleanups.set(p.id,(async()=>{
   const paths=[...new Set([p.path,p.thumbnail_path].filter(Boolean))];
   const {error}=await db.storage.from(BUCKET).remove(paths);if(error)throw error;
   const result=await db.rpc('finish_tiktok_receipt_photo_removal',{_photo_id:p.id});if(result.error)throw result.error;
   Object.assign(p,result.data);return p;
  })());
  return c.cleanups.get(p.id);
 }
 function removalNotice(db,p,message,retry=false){
  for(const wrapper of document.querySelectorAll('.tk-receipt-capture'))if(wrapper.dataset.photoId===p.id){
   const text=document.createElement('span');text.className='tk-photo-message';text.setAttribute('role','status');text.textContent=message;wrapper.replaceChildren(text);
   if(retry){const button=document.createElement('button');button.type='button';button.className='tk-photo-remove';button.textContent='Retry cleanup';button.onclick=()=>finishRemoval(db,p,true);wrapper.append(button);}
  }
 }
 async function finishRemoval(db,p,retry=false){
  removalNotice(db,p,'Removing capture files…');
  try{await cleanupRemovedPhoto(db,p,retry);removalNotice(db,p,'Capture removed.');client(db).status?.('Capture removed. You can take another photo in TikTok.');}
  catch{removalNotice(db,p,'Capture removed; file cleanup needs a retry.',true);client(db).status?.('Capture removed from the order. Retry cleanup below, or refresh OG to finish deleting its files.',true);}
 }
 function removalControls(db,p){
  const controls=document.createElement('div');controls.className='tk-photo-controls';
  const remove=document.createElement('button');remove.type='button';remove.className='tk-photo-remove';remove.textContent='Remove';remove.setAttribute('aria-label','Remove receipt photo at '+time(p.video_time));
  const ask=document.createElement('div');ask.className='tk-photo-confirm';ask.hidden=true;
  const text=document.createElement('span');text.textContent='Remove this capture and its thumbnail?';
  const confirm=document.createElement('button'),cancel=document.createElement('button');confirm.type=cancel.type='button';confirm.textContent='Remove capture';cancel.textContent='Cancel';
  confirm.className=cancel.className='tk-photo-remove';ask.append(text,confirm,cancel);controls.append(remove,ask);
  remove.onclick=()=>{ask.hidden=false;remove.hidden=true;confirm.focus();};cancel.onclick=()=>{ask.hidden=true;remove.hidden=false;remove.focus();};
  confirm.onclick=async()=>{
   confirm.disabled=cancel.disabled=true;text.textContent='Removing capture…';
   try{
    const {data,error}=await db.rpc('remove_tiktok_receipt_photo',{_photo_id:p.id});if(error)throw error;
    if(!data?.removed_at)throw Error('The capture was not removed. Try again.');
    Object.assign(p,data);const c=client(db);c.removed.add(p.id);c.urls.delete(p.path);c.urls.delete(p.thumbnail_path);
    for(const wrapper of document.querySelectorAll('.tk-receipt-capture'))if(wrapper.dataset.photoId===p.id){
     const preview=wrapper.querySelector('.tk-receipt-photo');if(preview){observer.unobserve(preview);observed.delete(preview);}
     const line=wrapper.closest('.tk-order-item');line?.classList.remove('tk-capture-saved');line?.querySelector('.tk-capture-confirmation')?.remove();
    }
    for(const dialog of document.querySelectorAll('.tk-photo-viewer'))if(dialog.dataset.photoId===p.id)dialog.close();
    const url=new URL(location.href);if(url.searchParams.get('tiktokReceipt')===p.transfer_id){url.searchParams.delete('tiktokReceipt');history.replaceState(null,'',url);}
    for(const panel of document.querySelectorAll('.tk-receipt-transfer'))if(panel.dataset.transferId===p.transfer_id)panel.remove();
    await finishRemoval(db,p);
    document.dispatchEvent(new CustomEvent('tiktok-item-photo-removed',{detail:{lineId:p.line_id,photoId:p.id}}));
   }catch(e){text.textContent=e.message||'Could not remove the capture. Try again.';confirm.disabled=cancel.disabled=false;}
  };
  return controls;
 }
 async function openPhoto(db,p){
  if(p.removed_at||client(db).removed.has(p.id))return;
  const dialog=document.createElement('dialog'),close=document.createElement('button'),caption=document.createElement('p'),img=document.createElement('img');
  dialog.className='tk-photo-viewer';dialog.dataset.photoId=p.id;dialog.setAttribute('aria-label','TikTok receipt photo');close.type='button';close.textContent='Close photo';
  caption.textContent='Loading receipt photo · '+time(p.video_time);img.alt='TikTok receipt item photo';
  close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  dialog.append(close,caption,img,removalControls(db,p));document.body.append(dialog);dialog.showModal();
  try{
   const url=await signedUrl(db,p.path);if(!dialog.isConnected)return;
   img.onload=()=>{caption.textContent='Receipt photo · '+time(p.video_time);};
   img.onerror=()=>{caption.textContent='Could not load the photo. Close and try again.';client(db).urls.delete(p.path);};
   img.src=url;
  }catch{if(dialog.isConnected)caption.textContent='Could not load the photo. Close and try again.';}
 }
 const observer=new IntersectionObserver(entries=>{
  for(const entry of entries)if(entry.isIntersecting){const load=observed.get(entry.target);observer.unobserve(entry.target);observed.delete(entry.target);load?.();}
 },{rootMargin:'240px'});
 function hydrate(root,db,photos){
  for(const node of observed.keys())if(!node.isConnected){observer.unobserve(node);observed.delete(node);}
  const byLine=new Map(),c=client(db);for(const p of photos){
   if(p.removed_at){c.removed.add(p.id);if(!p.files_deleted_at)cleanupRemovedPhoto(db,p).catch(()=>{});continue;}
   if(c.removed.has(p.id))continue;
   if(!byLine.has(p.line_id))byLine.set(p.line_id,[]);byLine.get(p.line_id).push(p);
  }
  for(const slot of root.querySelectorAll('[data-tk-photo-line]')){
   const matches=byLine.get(slot.dataset.tkPhotoLine)||[];
   for(const p of matches){
    if([...slot.children].some(node=>node.dataset.photoId===p.id))continue;
    const wrapper=document.createElement('div'),button=document.createElement('button'),img=document.createElement('img'),caption=document.createElement('span');
    wrapper.className='tk-receipt-capture';wrapper.dataset.photoId=p.id;
    button.type='button';button.className='tk-receipt-photo';button.setAttribute('aria-label','Open receipt photo at '+time(p.video_time));
    img.alt='TikTok receipt item photo';img.loading='lazy';img.decoding='async';img.width=160;img.height=180;
    caption.textContent='Receipt photo · '+time(p.video_time);button.append(img,caption);wrapper.append(button,removalControls(db,p));slot.append(wrapper);
    button.onclick=()=>openPhoto(db,p);
    observed.set(button,async()=>{
     try{const path=await thumbnailPath(db,p);if(!button.isConnected)return;const url=await signedUrl(db,path);if(button.isConnected)img.src=url;}
     catch{if(button.isConnected)caption.textContent='Preview unavailable · click to open';}
    });observer.observe(button);
   }
  }
 }
 function start({db,user,getOrders,refresh,reveal,status}){
  client(db).user=user;client(db).status=status;
  const sessions=new Map();let saving=false;
  function begin(id){
  if(!/^[a-f0-9-]{36}$/i.test(id||'')||sessions.has(id))return;
  const url=new URL(location.href);url.searchParams.set('tiktokReceipt',id);history.replaceState(null,'',url);
  let receiving=false,finished=false,pending;
  const panel=document.createElement('section');panel.className='tk-receipt-transfer';panel.dataset.transferId=id;panel.setAttribute('aria-live','polite');
  const text=document.createElement('p'),retry=document.createElement('button');retry.type='button';retry.textContent='Retry saving capture';retry.hidden=true;
  text.textContent='Receiving the TikTok receipt capture…';panel.append(text,retry);document.getElementById('tk-status').after(panel);
  const request=()=>window.postMessage({type:'OG_TIKTOK_RECEIPT_READY',transferId:id},location.origin);
  retry.onclick=async()=>{if(!pending||pending.error){pending=null;request();return;}try{await refresh();await receive(pending);}catch(e){text.textContent=e.message;}};
  async function receive(p){
   if(receiving||finished||p?.transferId!==id)return;
   if(saving){pending=p;text.textContent='Another capture is saving. Retry this capture when it finishes.';retry.hidden=false;return;}
   receiving=true;saving=true;pending=p;retry.hidden=true;document.documentElement.dataset.tkReceiptSaving='true';
   try{
    if(p.error)throw Error(p.error);
    if(!/^\d{10,24}$/.test(p.orderNumber||'')||!/^\d{10,24}$/.test(p.skuId||''))throw Error('The capture has no valid order and SKU identity. Capture it again in TikTok.');
    const order=getOrders().find(o=>o.order_number===p.orderNumber),line=order?.lines.find(l=>l.sku_id===p.skuId);
    if(!line)throw Error(`Order ${p.orderNumber}, SKU ${p.skuId} is not imported in OG. Import a fresh TikTok export, then retry this capture within one hour.`);
    if(!p.completed){
     if(!/^[a-f0-9-]{36}$/i.test(id)||typeof p.image!=='string'||!/^data:image\/jpeg;base64,[A-Za-z0-9+/]+=*$/.test(p.image)||p.image.length>7100000||!Number.isFinite(p.videoTime)||p.videoTime<0||p.videoTime>604800)throw Error('Invalid receipt photo. Capture it again in TikTok.');
     const blob=await (await fetch(p.image)).blob();if(blob.size>5*1024*1024)throw Error('Receipt photo exceeds 5 MB.');
     const small=await thumbnail(blob),path=`${user.id}/${id.toLowerCase()}.jpg`,thumbPath=`${user.id}/${id.toLowerCase()}-thumb.jpg`;
     text.textContent=`Saving receipt photo to order ${p.orderNumber} · SKU ${p.skuId}…`;
     await upload(db,path,blob);await upload(db,thumbPath,small);
     const {error}=await db.rpc('attach_tiktok_receipt_photo_v2',{_order_number:p.orderNumber,_sku_id:p.skuId,_transfer_id:id,_path:path,_video_time:p.videoTime,_thumbnail_path:thumbPath,_image_bytes:blob.size,_thumbnail_bytes:small.size});if(error)throw error;
    }
    await refresh();await reveal(order.id,line.id,id);finished=true;
    text.textContent=`Receipt photo saved to order ${p.orderNumber} · SKU ${p.skuId}.`;status(text.textContent);
    window.postMessage({type:'OG_TIKTOK_RECEIPT_DONE',transferId:id},location.origin);pending=null;
   }catch(e){text.textContent=e.message||'Could not save this capture. Try again.';retry.hidden=false;status(text.textContent,true);}
   finally{receiving=false;saving=false;document.documentElement.dataset.tkReceiptSaving='false';}
  }
  sessions.set(id,{receive,request:()=>{if(!finished)request();}});
  request();setTimeout(()=>{if(!receiving&&!pending&&!finished){text.textContent='Waiting for the extension. Update it, refresh this page, then retry.';retry.hidden=false;}},10000);
  }
  window.addEventListener('message',event=>{
   if(event.source!==window||event.origin!==location.origin)return;
   if(event.data?.type==='OG_TIKTOK_RECEIPT_AVAILABLE')begin(event.data.transferId);
   if(event.data?.type==='OG_TIKTOK_RECEIPT_BRIDGE_READY'){
    for(const session of sessions.values())session.request();
    window.postMessage({type:'OG_TIKTOK_RECEIPT_READY'},location.origin);
   }
   if(event.data?.type==='OG_TIKTOK_RECEIPT_DATA')sessions.get(event.data.payload?.transferId)?.receive(event.data.payload);
  });
  document.documentElement.dataset.tkReceiptReceiver='2';
  begin(new URLSearchParams(location.search).get('tiktokReceipt'));
  window.postMessage({type:'OG_TIKTOK_RECEIPT_READY'},location.origin);
 }
 window.TikTokReceiptPhotos={placeholder,hydrate,start};
})();
