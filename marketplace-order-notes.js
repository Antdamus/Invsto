(function(){
 'use strict';
 const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const clock=new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'});
 const stamp=value=>clock.format(new Date(value));
 const $=id=>document.getElementById('mn-'+id);
 const pageSize=30;
 const photoBucket='marketplace-note-photos';
 let market,db,dialog,active,orderPhoto,photoViewer,summaryTimer,summaryVersion=0,historyVersion=0,photoViewerVersion=0;

 function photoPicker(container,onChange=()=>{}){
  container.innerHTML='<strong>Photo <small>(optional)</small></strong><div class="mn-pick-actions"><button type="button" data-camera>Take photo</button><button type="button" data-gallery>Choose photo</button></div>'+
   '<input hidden type="file" data-capture accept="image/*" capture="environment"><input hidden type="file" data-file accept="image/*">'+
   '<div class="mn-picked" hidden><img alt="Selected note photo"><button type="button">Remove photo</button></div><small role="status"></small>';
  const find=s=>container.querySelector(s),preview=find('.mn-picked'),status=find('small[role=status]');
  let photo=null;
  function clear(){
   if(photo)URL.revokeObjectURL(photo.preview);
   photo=null;preview.hidden=true;preview.querySelector('img').removeAttribute('src');status.textContent='';
  }
  function select(file){
   if(!file)return;
   if(!file.type.startsWith('image/')||!file.size||file.size>40*1024*1024){status.textContent='Choose an image up to 40 MB.';return;}
   clear();photo={file,id:crypto.randomUUID(),preview:URL.createObjectURL(file)};
   preview.querySelector('img').src=photo.preview;preview.hidden=false;onChange();
  }
  for(const [button,input] of [['[data-camera]','[data-capture]'],['[data-gallery]','[data-file]']]){
   const picker=find(input);find(button).onclick=()=>picker.click();picker.onchange=()=>{select(picker.files[0]);picker.value='';};
  }
  preview.querySelector('button').onclick=()=>{clear();onChange();};
  return {clear,get photo(){return photo;},disable(disabled){container.querySelectorAll('button,input').forEach(el=>{el.disabled=disabled;});}};
 }

 async function preparePhoto(photo){
  if(photo.blob)return photo.blob;
  const image=new Image();image.src=photo.preview;
  try{await image.decode();}catch{throw Error('This image could not be opened. Choose a JPEG or take a new photo.');}
  const canvas=document.createElement('canvas'),scale=Math.min(1,2000/Math.max(image.naturalWidth,image.naturalHeight));
  canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
  const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(image,0,0,canvas.width,canvas.height);
  const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/jpeg',.88));canvas.width=canvas.height=0;
  if(!blob||blob.size>5242880)throw Error('Could not prepare the photo. Try a smaller image.');
  photo.blob=blob;return blob;
 }

 async function savePhotoNote(photo,targets,body){
  const session=await db.auth.getSession(),user=session.data?.session?.user;
  if(!user)throw Error('Sign in again to save your photo.');
  const path=user.id+'/'+market+'/'+photo.id+'.jpg';
  if(photo.uploaded!==path){
   const blob=await preparePhoto(photo);
   const {error}=await db.storage.from(photoBucket).upload(path,blob,{contentType:'image/jpeg',upsert:false});
   if(error&&String(error.statusCode)!=='409'&&error.code!=='Duplicate'&&!/already exists/i.test(error.message||''))throw error;
   photo.uploaded=path;
  }
  const {error}=await db.rpc('add_marketplace_order_photo_note',{_market:market,_targets:targets,_note:body,_photo_id:photo.id});
  if(error)throw error;
 }

 function photoButton(path){
  return path?'<button type="button" class="mn-view-photo" data-mn-photo="'+esc(path)+'"><img hidden alt="" loading="lazy"><span>View note photo</span></button>':'';
 }
 async function photoThumbnails(root){
  const buttons=Array.from(root.querySelectorAll('[data-mn-photo]')),paths=[...new Set(buttons.map(b=>b.dataset.mnPhoto))];
  if(!paths.length)return;
  try{
   const {data}=await db.storage.from(photoBucket).createSignedUrls(paths,900);
   const urls=new Map((data||[]).filter(r=>r.signedUrl).map(r=>[r.path,r.signedUrl]));
   for(const button of buttons){
    const url=urls.get(button.dataset.mnPhoto);if(!button.isConnected||!url)continue;
    const img=button.querySelector('img');img.onload=()=>{img.hidden=false;};img.src=url;
   }
  }catch{/* The full-size button can request a fresh link even if a thumbnail failed. */}
 }
 async function showPhoto(path){
  const img=photoViewer.querySelector('img'),status=photoViewer.querySelector('[role=status]');
  img.hidden=true;img.removeAttribute('src');status.textContent='Opening photo…';photoViewer.showModal();
  const version=++photoViewerVersion;
  try{
   const {data,error}=await db.storage.from(photoBucket).createSignedUrl(path,900);
   if(error||!data?.signedUrl)throw Error();
   if(version!==photoViewerVersion)return;
   img.src=data.signedUrl;await img.decode();if(version!==photoViewerVersion)return;
   img.hidden=false;status.textContent='';
  }catch{if(version===photoViewerVersion)status.textContent='Could not open this photo. Close and tap View note photo to retry.';}
 }

 function control(orders,line){
  if(!orders.length)return '';
  const targets=orders.map(o=>[String(o.id),String(o.order_number||o.id)]);
  const label=line?'Add line note':'Add order note';
  return '<div class="mn-control" data-mn-targets="'+esc(JSON.stringify(targets))+'" data-mn-line="'+esc(line?.id)+'" data-mn-title="'+esc(line?.title)+'">'+
   '<button type="button" class="mn-add" data-mn-open><span aria-hidden="true">✎</span> '+label+'</button><small class="mn-preview" hidden></small></div>';
 }

 function refresh(){
  if(!db)return;
  const version=++summaryVersion;clearTimeout(summaryTimer);
  summaryTimer=setTimeout(()=>summaries(version),140);
 }
 async function summaries(version){
  const controls=Array.from(document.querySelectorAll('[data-mn-targets]'),node=>({node,ids:JSON.parse(node.dataset.mnTargets).map(t=>t[0])}));
  const ids=[...new Set(controls.flatMap(c=>c.ids))],byOrder=new Map();
  try{
   for(let i=0;i<ids.length;i+=100){
    for(let start=0;;start+=500){
     if(version!==summaryVersion)return;
     const r=await db.from('marketplace_order_note_summaries').select('order_id,line_id,note_count,signer,created_at,preview')
      .eq('market',market).in('order_id',ids.slice(i,i+100)).order('order_id').order('line_id').range(start,start+499);
     if(r.error)throw r.error;
     for(const row of r.data){
      if(!byOrder.has(row.order_id))byOrder.set(row.order_id,[]);
      byOrder.get(row.order_id).push(row);
     }
     if(r.data.length<500)break;
    }
   }
   if(version!==summaryVersion)return;
   for(const {node,ids} of controls){
    const rows=ids.flatMap(id=>byOrder.get(id)||[]).filter(r=>!node.dataset.mnLine||r.line_id===node.dataset.mnLine);
    const count=rows.reduce((n,r)=>n+Number(r.note_count),0),preview=node.querySelector('.mn-preview');
    preview.hidden=!count;node.classList.toggle('has-notes',count>0);
    if(!count)continue;
    const last=rows.reduce((a,b)=>a.created_at>b.created_at?a:b);
    const order=ids.length>1?JSON.parse(node.dataset.mnTargets).find(t=>t[0]===last.order_id)?.[1]:null;
    const scope=(order?' · Order #'+order:'')+(last.line_id&&!node.dataset.mnLine?' · Item note':'');
    preview.textContent=count+(count===1?' note':' notes')+scope+' · Signed by '+last.signer+' · '+stamp(last.created_at)+' — '+last.preview;
   }
  }catch{
   if(version===summaryVersion)for(const {node} of controls){
    const preview=node.querySelector('.mn-preview');preview.hidden=false;preview.textContent='Open notes to check the latest activity.';
   }
  }
 }

 function bind(platform,client){
  if(dialog)return;
  market=platform;db=client;
  dialog=document.createElement('dialog');dialog.id='mn-dialog';dialog.setAttribute('aria-labelledby','mn-heading');
  dialog.innerHTML='<form id="mn-form"><header><div><small>INTERNAL STAFF NOTES</small><h2 id="mn-heading"></h2></div><button type="button" id="mn-close" aria-label="Close notes">×</button></header>'+
   '<label id="mn-chooser">Choose an order<select id="mn-order"></select></label><p id="mn-context"></p>'+
   '<label>New note<textarea id="mn-draft" rows="3" maxlength="4000" placeholder="What should the next person know?"></textarea></label>'+
   '<div class="mn-photo-picker" id="mn-photos"></div>'+
   '<p class="mn-help">Your staff name and the time are saved automatically.</p><button id="mn-save" type="submit">Save signed note</button><p id="mn-status" role="status"></p></form>'+
   '<section><h3>Note history</h3><button type="button" id="mn-refresh">Refresh notes</button><div id="mn-feed" aria-live="polite"></div><button type="button" id="mn-more" hidden>Earlier notes</button></section>';
  document.body.append(dialog);
  orderPhoto=photoPicker($('photos'),syncForm);
  photoViewer=document.createElement('dialog');photoViewer.className='mn-photo-viewer';photoViewer.setAttribute('aria-label','Note photo');
  photoViewer.innerHTML='<button type="button">Close photo</button><p role="status"></p><img alt="Photo attached to the signed staff note" hidden>';
  document.body.append(photoViewer);photoViewer.querySelector('button').onclick=()=>photoViewer.close();
  photoViewer.addEventListener('close',()=>{photoViewerVersion++;photoViewer.querySelector('img').removeAttribute('src');});
  document.addEventListener('click',event=>{
   const photo=event.target.closest('[data-mn-photo]');if(photo){showPhoto(photo.dataset.mnPhoto);return;}
   const button=event.target.closest('[data-mn-open]');if(!button)return;
   const node=button.closest('[data-mn-targets]'),targets=JSON.parse(node.dataset.mnTargets);
   active={line:node.dataset.mnLine||null,title:node.dataset.mnTitle,targets,offset:0};
   $('heading').textContent=active.line?'Item notes':'Order notes';
   $('chooser').hidden=targets.length===1;
   $('order').innerHTML=(targets.length>1?'<option value="">Select an order…</option>':'')+targets.map(([id,num])=>'<option value="'+esc(id)+'">Order #'+esc(num)+'</option>').join('');
   $('draft').value='';$('status').textContent='';dialog.showModal();chooseOrder();
  });
  $('order').onchange=chooseOrder;
  $('draft').oninput=syncForm;
  $('refresh').onclick=()=>loadHistory(false);$('more').onclick=()=>loadHistory(true);
  $('close').onclick=()=>{if(!active?.saving)dialog.close();};
  dialog.addEventListener('cancel',event=>{if(active?.saving)event.preventDefault();});
  dialog.addEventListener('close',()=>{active=null;historyVersion++;orderPhoto.clear();});
  $('form').onsubmit=save;
 }
 function syncForm(){
  if(!active)return;
  $('draft').disabled=!active.order||active.saving;
  orderPhoto.disable(!active.order||active.saving);
  $('save').disabled=!active.order||active.saving||(!$('draft').value.trim()&&!orderPhoto.photo);
  $('order').disabled=Boolean(active.saving||$('draft').value.trim()||orderPhoto.photo);
  $('close').disabled=Boolean(active.saving);
 }
 function chooseOrder(){
  active.order=$('order').value;active.request=null;$('status').textContent='';
  const number=active.targets.find(([id])=>id===active.order)?.[1];
  $('context').textContent=number?'Order #'+number+' · '+(active.line?active.title+' · Line '+active.line:'Whole order'):'Choose the order this note belongs to.';
  syncForm();loadHistory(false);
 }
 async function loadHistory(append){
  const ctx=active,version=++historyVersion;if(!ctx)return;
  const offset=append?ctx.offset:0;
  if(!append)$('feed').replaceChildren();
  $('more').hidden=true;$('refresh').disabled=!ctx.order;
  if(!ctx.order)return;
  if(!append)$('feed').textContent='Loading notes…';
  try{
   let query=db.from('marketplace_order_notes').select('id,line_id,item_title,body,signer,created_at,photo_path').eq('market',market).eq('order_id',ctx.order);
   if(ctx.line)query=query.eq('line_id',ctx.line);
   const r=await query.order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+pageSize);
   if(r.error)throw r.error;if(version!==historyVersion)return;
   if(!append)$('feed').replaceChildren();
   const rows=r.data.slice(0,pageSize);
   if(!offset&&!rows.length)$('feed').textContent='No staff notes yet.';
   for(const row of rows){
    const entry=document.createElement('article');
    entry.innerHTML='<strong>Signed by '+esc(row.signer)+'</strong><time datetime="'+esc(row.created_at)+'">'+esc(stamp(row.created_at))+'</time><small>'+
     (row.line_id?'Item · '+esc(row.item_title||row.line_id):'Whole order')+'</small><p>'+esc(row.body)+'</p>'+photoButton(row.photo_path);
    $('feed').append(entry);
   }
   ctx.offset=offset+rows.length;$('more').hidden=r.data.length<=pageSize;
   photoThumbnails($('feed'));
  }catch{
   if(version!==historyVersion)return;
   if(!append)$('feed').textContent='Could not load notes. Use Refresh notes to retry.';
   else{$('more').hidden=false;$('status').textContent='Could not load earlier notes. Try again.';}
  }
 }
 async function save(event){
  event.preventDefault();const ctx=active,body=$('draft').value.trim(),photo=orderPhoto.photo;if(!ctx?.order||ctx.saving||(!body&&!photo))return;
  if(ctx.request?.body!==body)ctx.request={body,id:crypto.randomUUID()};
  ctx.saving=true;syncForm();$('status').textContent=photo?'Saving note and photo…':'Saving…';
  try{
   if(photo)await savePhotoNote(photo,[{order_id:ctx.order,line_id:ctx.line}],body);
   else{
    const r=await db.rpc('add_marketplace_order_note',{_market:market,_order_id:ctx.order,_line_id:ctx.line,_note:body,_request_id:ctx.request.id});
    if(r.error)throw r.error;
   }
   ctx.request=null;$('draft').value='';orderPhoto.clear();$('status').textContent=photo?'Signed note and photo saved.':'Signed note saved.';refresh();await loadHistory(false);
  }catch(e){$('status').textContent=e.message||'Could not save. Your draft is still here.';}
  finally{ctx.saving=false;syncForm();}
 }
 window.MarketplaceOrderNotes={control,bind,refresh,photoPicker,savePhotoNote,photoButton,photoThumbnails};
})();
