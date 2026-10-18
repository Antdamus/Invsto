(function(){
 'use strict';
 const $=id=>document.getElementById(id),BUCKET='tiktok-completion-photos';
 let context,controller,desktop,receiver,activeOrders=[];const urls=new Map(),uploads=new WeakMap();
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const lines=orders=>orders.flatMap(order=>order.lines.map(l=>({...l,item_number:l.sku_id,item_title:l.title,order})));
 async function signed(path){const cached=urls.get(path);if(cached?.until>Date.now())return cached.url;const {data,error}=await context.db.storage.from(BUCKET).createSignedUrl(path,1800);if(error)throw error;urls.set(path,{url:data.signedUrl,until:Date.now()+1500000});return data.signedUrl;}
 async function uploadFile(file){
  const previous=uploads.get(file);if(previous)return finishUpload(previous);
  if(file.size>40*1024*1024)throw Error('Choose a photo smaller than 40 MB.');
  let image;try{image=await createImageBitmap(file);}catch{throw Error('This photo cannot be opened here. Choose a JPEG or take a new photo.');}
  try{
   const blobs=[];for(const [max,quality] of [[1600,.88],[320,.78]]){const scale=Math.min(1,max/Math.max(image.width,image.height)),canvas=document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);const blob=await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality));if(!blob||blob.size>5242880)throw Error('Could not prepare a smaller photo.');blobs.push(blob);canvas.width=canvas.height=0;}
   const path=`${context.user.id}/${crypto.randomUUID()}.jpg`,thumbnail_path=path.replace('.jpg','-thumb.jpg');
   const pending={blobs,done:new Set(),photo:{bucket:BUCKET,path,thumbnail_path,label:file.name||'Completion photo',mime_type:'image/jpeg'}};uploads.set(file,pending);return await finishUpload(pending);
  }finally{image.close();}
 }
 async function finishUpload(pending){
  for(const [i,path] of [pending.photo.path,pending.photo.thumbnail_path].entries()){
   if(pending.done.has(path))continue;
   const {error}=await context.db.storage.from(BUCKET).upload(path,pending.blobs[i],{contentType:'image/jpeg',cacheControl:'3600',upsert:false});
   if(error&&!['409','Duplicate'].includes(String(error.statusCode||error.code))&&!/already exists/i.test(error.message||''))throw error;pending.done.add(path);
  }
  return pending.photo;
 }
 async function view(photo){
  const dialog=document.createElement('dialog');dialog.className='tk-photo-viewer tk-proof-viewer';dialog.setAttribute('aria-label','TikTok completion photo');
  const close=document.createElement('button');close.textContent='Close photo';close.onclick=()=>dialog.close();const img=document.createElement('img');img.alt='TikTok completion photo';dialog.append(close,img);document.body.append(dialog);dialog.addEventListener('close',()=>dialog.remove(),{once:true});dialog.showModal();
  try{img.src=photo.path?await signed(photo.path):photo.previewUrl;}catch(e){dialog.append(document.createTextNode(e.message));}
 }
 function photos(){
  if(!controller)controller=window.TikTokCompletionPhotos.create({getClient:()=>context.db,getCustomerName:o=>o.buyer_nickname||o.buyer_username,getActor:()=>context.user?.email||'Staff',escapeHtml:esc,formatDate:v=>new Date(v).toLocaleString(),hydratePhoto:async p=>({...p,thumbnailUrl:await signed(p.thumbnail_path)}),openPhoto:view,uploadFile,
   onOpen:()=>$('completion-photos-modal').classList.remove('hidden'),onClose:()=>$('completion-photos-modal').classList.add('hidden'),onSaved:()=>{receiver?.saved();Promise.resolve(context.refresh?.()).catch(e=>context.status?.('Photos saved. Refresh the order list: '+e.message));},keepOpen:()=>Boolean(receiver),pollMs:12000});
  return controller;
 }
 function phoneOrders(orders){if(!orders?.length)return;phoneLines(lines(orders));}
 function phoneLines(items){
  if(!desktop)desktop=window.TikTokPhoneCamera.createDesktop({getClient:()=>context.db,getUserId:()=>context.user.id,getCustomerName:o=>o.buyer_nickname||o.buyer_username,
   onOpen:()=>$('phone-camera-pair-modal').classList.remove('hidden'),onClose:()=>$('phone-camera-pair-modal').classList.add('hidden'),
   watchPhotos:(items,node)=>photos().watch(items,result=>photos().renderGrid(node,result)),pollMs:12000});
  desktop.send(items);
 }
 function open(orders){
  if(!orders?.length)return;if(photos().hasPending){photos().open(lines(orders));return;}
  activeOrders=orders;photos().open(lines(orders));let finish=$('tk-completion-finish');
  if(!finish){finish=document.createElement('section');finish.id='tk-completion-finish';finish.innerHTML='<h3>Complete these orders</h3><div id="tk-completion-inventory"></div><p class="tk-help">Save the shipping labels and completion photos first. Completing moves these orders to TikTok history; carrier handoff is tracked separately.</p><label class="tk-confirm"><input id="tk-completion-confirm" type="checkbox">I checked every item, quantity and shipping label, the completion photos show the packed contents, and only the linked inventory quantities above should be deducted.</label><button id="tk-complete-orders" type="button" class="primary-btn">Complete order</button><p id="tk-completion-status" role="status"></p>';$('completion-photo-saved').after(finish);
   $('tk-complete-orders').onclick=async()=>{const button=$('tk-complete-orders');if(button.disabled)return;button.disabled=true;try{
    if(activeOrders.some(o=>window.TikTokOrderQueue.held(o)))throw Error('Resolve the missing-item, CGL or cancellation holds before completing this buyer.');
    if(photos().hasPending)throw Error('Save or remove the selected photos before completing.');
    if(!$('tk-completion-confirm').checked)throw Error('Confirm the contents and labels before completing.');
    const {data,error}=await context.db.rpc('complete_tiktok_orders',{_order_ids:activeOrders.map(o=>o.id),_revisions:Object.fromEntries(activeOrders.map(o=>[o.id,o.revision])),_confirmed:true});if(error)throw error;
    photos().close();await context.refresh();context.status(`Orders completed. ${data?.inventory_units_deducted||0} inventory units deducted. Labels, photos and stock movements are saved in TikTok history.`);
   }catch(e){$('tk-completion-status').textContent=e.message;}finally{button.disabled=false;}};
  }
  window.TikTokInventory?.review($('tk-completion-inventory'),orders);finish.hidden=orders.every(o=>window.TikTokOrderQueue.closed(o));$('tk-completion-confirm').checked=false;$('tk-completion-status').textContent='';$('tk-complete-orders').textContent=orders.length>1?`Complete ${orders.length} orders`:'Complete order';
 }
 function bind(){document.querySelector('[data-phone-camera="photos"]').onclick=()=>phoneLines(photos().lines);}
 function start(config){context=config;bind();window.TikTokLabels?.start(config);window.TikTokInventory?.start(config);const changed=()=>{activeOrders=activeOrders.map(o=>context.getOrders().find(current=>current.id===o.id)).filter(Boolean);if($('tk-completion-inventory')){window.TikTokInventory.review($('tk-completion-inventory'),activeOrders);$('tk-completion-confirm').checked=false;}};document.addEventListener('tiktok-inventory-saved',changed);window.addEventListener('tiktok-work-saved',changed);}
 function connectPhone({db,onUser}){
  const sessionId=window.TikTokPhoneCamera?.sessionIdFromUrl();if(!sessionId)return false;
  context={db,user:null};bind();receiver=window.TikTokPhoneCamera.createReceiver({sessionId,getClient:()=>db,onUser:user=>{context.user=user;onUser(user);},getPhotoController:photos,pollMs:12000});receiver.connect();return true;
 }
 window.TikTokFulfillment={start,connectPhone,open,phone:phoneOrders};
})();
