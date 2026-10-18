(function(){
 'use strict';
 const $=id=>document.getElementById(id),BUCKET='tiktok-completion-photos';
 let context,controller,desktop,receiver,activeOrders=[],reviewLoading=false,completing=false,selectedIds=new Set(),historical=false;const urls=new Map(),uploads=new WeakMap();
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const lines=orders=>orders.flatMap(order=>order.lines.map(l=>({...l,item_number:l.sku_id,item_title:l.title,order})));
 const selectable=(l,o)=>!window.TikTokOrderQueue.closed(o)&&!l.fulfilled_at&&!window.TikTokOrderQueue.lineCancelled(l,o)&&!window.TikTokOrderQueue.lineHeld(l)&&!o.cancellation?.pending;
 const selectedOrders=()=>activeOrders.map(o=>({...o,lines:o.lines.filter(l=>selectedIds.has(l.id)&&selectable(l,o))})).filter(o=>o.lines.length);
 function updateSelection(retarget=true){
  for(const o of activeOrders)for(const l of o.lines)if(!selectable(l,o))selectedIds.delete(l.id);
  const selected=selectedOrders();
  const photoLines=lines(historical?activeOrders:selected),scopeKey=items=>JSON.stringify(items.map(l=>[l.id,l.sku_id,l.quantity]));
  if(retarget&&!photos().hasPending&&scopeKey(photos().lines)!==scopeKey(photoLines))photos().open(photoLines,'',true);
  renderReview();window.TikTokInventory?.review($('tk-completion-inventory'),historical?activeOrders:selected);$('tk-completion-confirm').checked=false;
  $('tk-complete-orders').disabled=reviewLoading||completing||!selected.length;
  $('tk-complete-orders').textContent=selected.length?`Complete ${lines(selected).length} selected item${lines(selected).length===1?'':'s'}`:'Select items to complete';
 }
 function changeSelection(change,focus){
  if(photos().hasPending||completing){$('tk-completion-status').textContent='Save or remove the selected photos before changing the items.';renderReview();return;}
  change();updateSelection();if(focus)$('tk-completion-review').querySelector(focus)?.focus({preventScroll:true});
  $('tk-completion-status').textContent=selectedOrders().length?'Selection updated. Check the final photos and confirm again.':'No items selected. Select a found item to continue.';
 }
 async function signed(path){const cached=urls.get(path);if(cached?.until>Date.now())return cached.url;const {data,error}=await context.db.storage.from(BUCKET).createSignedUrl(path,1800);if(error)throw error;urls.set(path,{url:data.signedUrl,until:Date.now()+1500000});return data.signedUrl;}
 async function uploadFile(file){
  const previous=uploads.get(file);if(previous)return finishUpload(previous);
  if(file.size>40*1024*1024)throw Error('Choose a photo smaller than 40 MB.');
  let image;try{image=await createImageBitmap(file);}catch{throw Error('This photo cannot be opened here. Choose a JPEG or take a new photo.');}
  try{
   const blobs=[];for(const [max,quality] of [[1600,.88],[320,.78]]){const scale=Math.min(1,max/Math.max(image.width,image.height)),canvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(1,1):document.createElement('canvas');canvas.width=Math.max(1,Math.round(image.width*scale));canvas.height=Math.max(1,Math.round(image.height*scale));const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);const blob=canvas.convertToBlob?await canvas.convertToBlob({type:'image/jpeg',quality}):await new Promise(r=>canvas.toBlob(r,'image/jpeg',quality));if(!blob||blob.size>5242880)throw Error('Could not prepare a smaller photo.');blobs.push(blob);canvas.width=canvas.height=0;}
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
   onOpen:()=>$('completion-photos-modal').classList.remove('hidden'),onClose:()=>{$('completion-photos-modal').classList.add('hidden');activeOrders=[];},onSaved:()=>{receiver?.saved();Promise.resolve(context.refresh?.()).then(()=>{syncReview();if(activeOrders.length)$('tk-completion-status').textContent='Final order photos saved. Review the orders and confirm when ready.';}).catch(e=>context.status?.('Photos saved. Refresh the order list: '+e.message));},keepOpen:()=>Boolean(receiver),pollMs:12000});
  return controller;
 }
 function phoneOrders(orders){if(!orders?.length)return;phoneLines(lines(orders.every(o=>window.TikTokOrderQueue.closed(o))?orders:orders.map(o=>({...o,lines:o.lines.filter(l=>selectable(l,o))}))));}
 function phoneLines(items){
  if(!items.length){context.status?.('No available items selected for final photos. Mark lost items found before continuing.');return;}
  if(!desktop)desktop=window.TikTokPhoneCamera.createDesktop({getClient:()=>context.db,getUserId:()=>context.user.id,getCustomerName:o=>o.buyer_nickname||o.buyer_username,
   onOpen:()=>$('phone-camera-pair-modal').classList.remove('hidden'),onClose:()=>$('phone-camera-pair-modal').classList.add('hidden'),
   watchPhotos:(items,node)=>photos().watch(items,result=>photos().renderGrid(node,result)),pollMs:12000});
  desktop.send(items);
 }
 function renderReview(){
  const root=$('tk-completion-review');if(!root||!activeOrders.length)return;
  const selected=historical?activeOrders:selectedOrders(),receipts=(context.getReceiptPhotos?.()||[]).filter(p=>!p.removed_at),allLabels=activeOrders.flatMap(o=>o.documents.filter(d=>d.kind==='label')),labelCount=selected.flatMap(o=>o.documents.filter(d=>d.kind==='label')).length;
  const missing=selected.filter(o=>!o.documents.some(d=>d.kind==='label')).length,multiple=selected.filter(o=>o.documents.filter(d=>d.kind==='label').length>1).length;
  const quantity=selected.reduce((n,o)=>n+o.lines.reduce((n,l)=>n+Number(l.quantity||0),0),0);
  root.hidden=false;root.innerHTML=`<div class="tk-review-heading"><div><span class="tk-section-label">${historical?'Completed order evidence':'Selected for completion'}</span><h3>${selected.length} order${selected.length===1?'':'s'} · ${quantity} item${quantity===1?'':'s'}</h3><p>${esc([...new Set(activeOrders.map(o=>o.buyer_nickname||o.buyer_username))].join(', '))} · TikTok ${esc([...new Set(activeOrders.map(o=>'@'+o.buyer_username))].join(', '))}</p></div><button type="button" class="secondary-btn" id="tk-refresh-completion-review" ${reviewLoading||completing?'disabled':''}>${reviewLoading?'Refreshing…':'Refresh review'}</button></div>
   ${historical?'':`<div class="tk-review-selection"><button type="button" class="secondary-btn" id="tk-select-available">Select available</button><button type="button" class="secondary-btn" id="tk-deselect-all">Deselect all</button><p>Only checked items will be completed. Lost and cancelled items are automatically excluded. Unchecked items stay pending.</p></div>`}
   <div class="tk-review-label-summary" role="status"><strong>${labelCount} shipping-label attachment${labelCount===1?'':'s'}</strong><span class="${missing?'tk-review-warning':'tk-review-ok'}">${!selected.length?'No items selected':missing?`${missing} order${missing===1?' is':'s are'} missing a shipping label`:'Every selected order has a saved label'}</span>${multiple?`<span class="tk-review-warning">${multiple} order${multiple===1?' has':'s have'} multiple labels — check which to use.</span>`:''}</div>
   <div class="tk-review-orders">${activeOrders.map(o=>{
    const labels=o.documents.filter(d=>d.kind==='label');return `<article class="tk-review-order" data-review-order="${esc(o.id)}"><header><div><span class="tk-section-label">${historical?'Completed order':`${o.lines.filter(l=>selectedIds.has(l.id)).length} of ${o.lines.length} items selected`}</span><h4>${esc(o.order_number)}</h4></div><span class="${labels.length===1?'tk-review-ok':'tk-review-warning'}">${labels.length===0?'Shipping label missing':labels.length===1?'1 shipping label attached':`${labels.length} shipping labels attached`}</span></header>
     ${o.buyer_message?`<p class="tk-note"><strong>Buyer message:</strong> ${esc(o.buyer_message)}</p>`:''}${o.notes?`<p class="tk-note"><strong>Preparation note:</strong> ${esc(o.notes)}</p>`:''}
     <div class="tk-review-items">${o.lines.map(l=>`<div class="tk-review-item ${!historical&&!selectedIds.has(l.id)?'is-excluded':''}" data-review-line="${esc(l.id)}"><div class="tk-review-captures"><span class="tk-section-label">Receipt capture</span>${receipts.some(p=>p.line_id===l.id)?window.TikTokReceiptPhotos.placeholder(l):'<p class="tk-muted">No receipt capture saved</p>'}<a class="tk-text-action" href="${esc(window.TikTokOrderImport.orderUrl(o.order_number,true,l.sku_id))}" target="_blank" rel="noopener">Open video receipt</a></div><div>${historical?'':`<label class="tk-review-select"><input type="checkbox" data-complete-line="${esc(l.id)}" aria-label="Complete ${esc(l.title)} · ${esc(o.order_number)}" ${selectedIds.has(l.id)?'checked':''} ${!selectable(l,o)||completing?'disabled':''}>Include in completion</label>`}<h4>${esc(l.title)}</h4><p>Qty <strong>${esc(l.quantity)}</strong> · SKU ${esc(l.seller_sku||l.sku_id||'Unavailable')}</p>${window.TikTokOrderQueue.lineCancelled(l,o)?'<p class="tk-cancelled-badge">Cancelled · excluded from completion</p>':l.fulfilled_at?'<p class="tk-review-ok">Already completed</p>':window.TikTokOrderQueue.lost(l)?'<p class="tk-review-warning">Lost · automatically excluded. Mark found on the pending order when located.</p>':window.TikTokOrderQueue.lineHeld(l)||o.cancellation?.pending?'<p class="tk-review-warning">On hold · resolve before completing</p>':!historical&&!selectedIds.has(l.id)?'<p class="tk-muted">Not selected · stays pending</p>':''}${l.variation?`<p>${esc(l.variation)}</p>`:''}<p class="tk-muted">Tracking: ${esc(l.tracking_number||'Not available yet')}</p></div></div>`).join('')}</div>
     <section class="tk-review-labels" aria-label="Shipping labels for order ${esc(o.order_number)}"><h4>Shipping labels</h4>${labels.map(d=>`<div class="tk-review-label"><div><strong>${esc(d.filename||'Shipping label PDF')}</strong>${d.tracking_number?`<span>Tracking: ${esc(d.tracking_number)}</span>`:''}${d.created_at?`<small>Attached ${esc(new Date(d.created_at).toLocaleString())}</small>`:''}</div><button type="button" class="secondary-btn" data-review-label="${esc(d.id)}">Preview label</button></div>`).join('')||'<p class="tk-review-warning">Save a shipping-label PDF to this order before completing.</p>'}</section></article>`;
   }).join('')}</div>`;
  window.TikTokReceiptPhotos.hydrate(root,context.db,receipts);
  root.querySelectorAll('[data-complete-line]').forEach(input=>input.onchange=()=>changeSelection(()=>input.checked?selectedIds.add(input.dataset.completeLine):selectedIds.delete(input.dataset.completeLine),`[data-complete-line="${CSS.escape(input.dataset.completeLine)}"]`));
  if(!historical){$('tk-select-available').onclick=()=>changeSelection(()=>{for(const o of activeOrders)for(const l of o.lines)if(selectable(l,o))selectedIds.add(l.id);},'#tk-select-available');$('tk-deselect-all').onclick=()=>changeSelection(()=>selectedIds.clear(),'#tk-deselect-all');}
  root.querySelectorAll('[data-review-label]').forEach(button=>button.onclick=async()=>{
   const doc=allLabels.find(d=>d.id===button.dataset.reviewLabel);if(!doc)return;
   const tab=window.open('about:blank','_blank');if(!tab){$('tk-completion-status').textContent='Allow popups to preview this label.';return;}tab.opener=null;
   try{const {data,error}=await context.db.storage.from('ebay-labels').createSignedUrl(doc.path,120);if(error)throw error;tab.location.replace(data.signedUrl);}catch(e){tab.close();$('tk-completion-status').textContent=e.message;}
  });
  $('tk-refresh-completion-review').onclick=async()=>{
   if(reviewLoading)return;if(photos().hasPending){$('tk-completion-status').textContent='Save or remove the selected photos before refreshing this review.';return;}
   reviewLoading=true;renderReview();$('tk-complete-orders').disabled=true;
   try{await context.refresh();syncReview();focusReview();$('tk-completion-status').textContent='Review refreshed. Check the selected items and confirm again.';}catch(e){$('tk-completion-status').textContent=e.message;}finally{reviewLoading=false;updateSelection(false);}
  };
 }
 function syncReview(){
  if(!activeOrders.length||!context.getOrders)return;
  activeOrders=activeOrders.map(o=>context.getOrders().find(current=>current.id===o.id)).filter(Boolean);
  if($('tk-completion-finish'))updateSelection();
 }
 function focusReview(){const title=$('completion-photos-title');title.tabIndex=-1;title.focus({preventScroll:true});title.closest('.packing-modal-card').scrollTop=0;}
 function open(orders){
  if(!orders?.length)return;if(photos().hasPending){photos().open(lines(orders));return;}
  activeOrders=orders;historical=orders.every(o=>window.TikTokOrderQueue.closed(o));selectedIds=new Set(orders.flatMap(o=>o.lines.filter(l=>selectable(l,o)).map(l=>l.id)));photos().open(lines(historical?orders:selectedOrders()));let finish=$('tk-completion-finish');
  if(!finish){finish=document.createElement('section');finish.id='tk-completion-finish';finish.innerHTML='<h3>Complete these orders</h3><div id="tk-completion-inventory"></div><label class="tk-completion-note-label">Optional completion note<textarea id="tk-completion-note" rows="3" maxlength="4000" placeholder="Packing details or anything the team should know…"></textarea><small>Saved to every selected order’s audit history when you complete. Existing preparation notes stay unchanged.</small></label><p class="tk-help">Save the shipping labels and final order photos first. Only checked items are completed. Orders move to history when every item is complete; unchecked items stay pending.</p><label class="tk-confirm"><input id="tk-completion-confirm" type="checkbox">I checked every selected order, item, quantity and shipping label, the final photos show the packed contents, and only the linked inventory quantities above should be deducted.</label><button id="tk-complete-orders" type="button" class="primary-btn">Complete order</button><p id="tk-completion-status" role="status"></p>';$('completion-photo-saved').after(finish);
   $('tk-complete-orders').onclick=async()=>{const button=$('tk-complete-orders');if(button.disabled)return;completing=true;button.disabled=true;renderReview();try{
    if(reviewLoading)throw Error('Wait for the review to finish refreshing.');
    const selected=selectedOrders();if(!selected.length)throw Error('Select at least one available item to complete.');
    if(photos().hasPending)throw Error('Save or remove the selected photos before completing.');
    if(!$('tk-completion-confirm').checked)throw Error('Confirm the contents and labels before completing.');
    if(selected.some(o=>!o.documents.some(d=>d.kind==='label')))throw Error('Save the shipping label for every selected order first, then refresh this review.');
    const {data,error}=await context.db.rpc('complete_tiktok_order_lines_review',{_line_ids:lines(selected).map(l=>l.id),_revisions:Object.fromEntries(selected.map(o=>[o.id,o.revision])),_confirmed:true,_note:$('tk-completion-note').value.trim()||null});if(error)throw error;
    photos().close();await context.refresh();context.status(`${data?.completed===selected.length?'Orders completed.':'Selected items completed. Remaining items stay pending.'} ${data?.inventory_units_deducted||0} inventory units deducted. Evidence and notes are saved in the order audit history.`);
   }catch(e){$('tk-completion-status').textContent=e.message;}finally{completing=false;button.disabled=!selectedOrders().length;renderReview();}};
  }
  $('completion-photos-title').textContent=historical?'TikTok order evidence':'Review & complete TikTok orders';$('completion-photo-context').hidden=true;updateSelection(false);
  finish.hidden=historical;$('tk-completion-note').value='';$('tk-completion-status').textContent='';
  finish.parentElement.append(finish);focusReview();
 }
 function bind(){document.querySelector('[data-phone-camera="photos"]').onclick=()=>phoneLines(photos().lines);}
 function start(config){context=config;bind();window.TikTokLabels?.start(config);window.TikTokInventory?.start(config);document.addEventListener('tiktok-inventory-saved',syncReview);window.addEventListener('tiktok-work-saved',syncReview);}
 function connectPhone({db,onUser}){
  const sessionId=window.TikTokPhoneCamera?.sessionIdFromUrl();if(!sessionId)return false;
  context={db,user:null};bind();receiver=window.TikTokPhoneCamera.createReceiver({sessionId,getClient:()=>db,onUser:user=>{context.user=user;onUser(user);},getPhotoController:photos,pollMs:12000});receiver.connect();return true;
 }
 window.TikTokFulfillment={start,connectPhone,open,phone:phoneOrders};
})();
