(() => {
 'use strict';
 const C=window.Catalogue,$=id=>document.getElementById(id),images=new Map(),inventory=new Map();
 let client,record=null,chosen=[],catalogues=[],page=[],total=0,offset=0,tab='browse',dirty=false,busy=false,search='',queryVersion=0,previewWindow=null;
 const paths=i=>[...new Set([...(Array.isArray(i.photos)?i.photos:[]),i.photo_url].filter(p=>typeof p==='string' && p.trim()))];
 const eligible=i=>i && i.pricing_status!=='pending' && Number.isFinite(Number(i.sale_price)) && Number(i.sale_price)>0 && paths(i).length;
 function message(text,error=false){$('manager-message').textContent=text;$('manager-message').className=error?'error':'';}
 async function rpc(name,args){const{data,error}=await client.rpc(name,args);if(error)throw new Error(error.message);return data;}
 function markDirty(){dirty=true;summary();}
 function lock(value){busy=value;for(const e of document.querySelectorAll('.catalogue-editor input,.catalogue-editor textarea,.catalogue-editor button,.catalogue-editor select,#new-catalogue,.saved-card,#confirm-publish'))e.disabled=value;summary();}
 function summary(){
  $('selected-count').textContent=chosen.length;$('editor-summary').textContent=`${chosen.length} / 100 pieces${dirty?' · Unsaved changes':''}`;
  $('preview-catalogue').disabled=busy || !chosen.length;
  $('publish-catalogue').hidden=record?.status==='published';$('save-catalogue').textContent=record?.status==='published'?'Save changes':'Save draft';
  $('catalogue-status').textContent=record?.status==='published'?'Link is live':record?'Private draft':'Unsaved draft';
 }
 async function signPhotos(items){
  const sign=new Map();
  for(const i of items)for(const path of paths(i)){
   if(images.has(path))continue;
   if(/^https:\/\//i.test(path)){
    try{const u=new URL(path);const match=u.pathname.match(/^\/storage\/v1\/object\/(?:sign|public|authenticated)\/photos\/(.+)$/);if(u.origin===window.SUPABASE_URL && match)sign.set(path,decodeURIComponent(match[1]));else images.set(path,C.safeImage(path));}catch{}
   }else sign.set(path,path.replace(/^\/+/,''));
  }
  if(sign.size){const{data,error}=await client.storage.from('photos').createSignedUrls([...new Set(sign.values())],1800);if(error)throw new Error('Item photos could not load. Try searching again.');const urls=new Map((data||[]).map(row=>[row.path,row.signedUrl]));for(const[path,key]of sign)if(urls.get(key))images.set(path,urls.get(key));}
 }
 function renderList(){
  $('catalogue-list').innerHTML=catalogues.length?catalogues.map(c=>`<button class="saved-card" data-open="${C.escape(c.id)}" aria-current="${record?.id===c.id}"><strong>${C.escape(c.title)}</strong><small>${c.status==='published'?'● Live link':'○ Private draft'} · ${c.items.length} pieces</small><small>Updated ${new Date(c.updated_at).toLocaleDateString()}</small></button>`).join(''):'<p class="manager-empty">Your saved catalogues will appear here.</p>';
 }
 async function loadList(){const{data,error}=await client.from('inventory_catalogues').select('id,title,introduction,credit,status,share_token,items,revision,updated_at').order('updated_at',{ascending:false}).limit(200);if(error)throw error;catalogues=data||[];renderList();}
 function share(){const live=record?.status==='published';$('share-panel').hidden=!live;if(live){const url='https://www.og-jewelers.com/private-catalogue#'+record.share_token;$('catalogue-link').value=url;$('open-client-link').href=url;}}
 async function open(c=null){
  if(dirty && !window.confirm('Discard your unsaved catalogue changes?'))return;
  record=c;chosen=JSON.parse(JSON.stringify(c?.items||[]));dirty=false;tab=chosen.length?'selected':'browse';offset=0;search='';$('inventory-search').value='';
  $('catalogue-name').value=c?.title||'';$('catalogue-welcome').value=c?.introduction||'';$('catalogue-credit').value=c?.credit??'';
  $('editor-heading').textContent=c?'Edit catalogue':'New catalogue';$('catalogue-editor').hidden=false;share();renderList();summary();
  if(chosen.length){
   lock(true);message('Loading your selected pieces…');
   try{const result=await rpc('catalogue_inventory',{_ids:chosen.map(i=>i.id)});for(const s of chosen)inventory.delete(s.id);for(const i of result.items)inventory.set(i.id,i);await signPhotos(result.items);message('');}catch(e){message(e.message,true);}finally{lock(false);renderInventory();}
  }else await browse();
 }
 async function browse(){
  const version=++queryVersion;message('Loading inventory…');
  try{const result=await rpc('catalogue_inventory',{_search:search,_offset:offset});if(version!==queryVersion)return;page=result.items;total=result.total;for(const i of page)inventory.set(i.id,i);await signPhotos(page);if(version!==queryVersion)return;renderInventory();message('');}catch(e){if(version===queryVersion)message(e.message,true);}
 }
 function priceEditor(s){return `<label class="custom-price-check"><input type="checkbox" data-custom-price="${C.escape(s.id)}" ${s.retail_override!=null?'checked':''}> Set a custom client price</label><label class="custom-price-input" ${s.retail_override==null?'hidden':''}>Client price · USD<input type="number" data-price-item="${C.escape(s.id)}" value="${C.escape(s.retail_override??'')}" min="0.01" max="99999999.99" step="0.01" inputmode="decimal"></label><p>${s.retail_override!=null?'Only this price is shown to clients. Inventory is unchanged.':'Uses the current inventory retail price.'}</p>`;}
 function itemCard(id){
  const i=inventory.get(id),s=chosen.find(c=>c.id===id),index=chosen.findIndex(c=>c.id===id),itemPhotos=i?paths(i):[];
  const src=images.get(s?.photos?.[0]||itemPhotos[0]),ready=eligible(i);
  return `<article class="inventory-piece ${s?'chosen':''}">${src?`<img loading="lazy" src="${C.escape(src)}" alt="${C.escape(i?.title||'Item')}">`:'<div class="no-image">No photo</div>'}<div class="inventory-piece-body"><h3>${C.escape(i?.title||'Item no longer available')}</h3><small>${C.escape(i?.barcode||'')}</small><div class="retail"><strong>${i?.pricing_status==='pending'?'Pending pricing':Number(i?.sale_price)>0?C.money(i.sale_price):'Price needed'}</strong><span>Retail · USD</span></div>${!ready?`<p class="warning">${!i?'Remove this unavailable item.':!itemPhotos.length?'Add a photo in inventory first.':'Finish pricing before adding.'}</p>`:''}<button data-choose="${C.escape(id)}" ${!s && !ready?'disabled':''}>${s?'✓ Selected · Remove':'＋ Add to catalogue'}</button>${tab==='selected' && s?`<div class="piece-editor">${priceEditor(s)}<label>Client category<select data-category-item="${C.escape(id)}">${C.categories.map(c=>`<option ${c===s.category?'selected':''}>${c}</option>`).join('')}</select></label><label>Photos to share</label><p>The first chosen photo is the cover. Select up to eight.</p><div class="photo-choices">${itemPhotos.map((p,n)=>`<label class="photo-choice">${images.get(p)?`<img loading="lazy" src="${C.escape(images.get(p))}" alt="Photo ${n+1}">`:'<span>Photo</span>'}<input type="checkbox" data-item-photo="${C.escape(id)}" data-photo-index="${n}" aria-label="Share photo ${n+1} of ${C.escape(i.title)}" ${s.photos.includes(p)?'checked':''}></label>`).join('')}</div><div class="piece-order"><button data-move="${id}" data-direction="-1" ${index===0?'disabled':''} aria-label="Move ${C.escape(i?.title)} earlier">↑ Earlier</button><button data-move="${id}" data-direction="1" ${index===chosen.length-1?'disabled':''} aria-label="Move ${C.escape(i?.title)} later">↓ Later</button></div></div>`:''}</div></article>`;
 }
 function renderInventory(){
  $('browse-tab').setAttribute('aria-pressed',String(tab==='browse'));$('selected-tab').setAttribute('aria-pressed',String(tab==='selected'));
  $('inventory-search-bar').hidden=tab==='selected';$('inventory-pagination').hidden=tab==='selected';
  const ids=tab==='selected'?chosen.map(i=>i.id):page.map(i=>i.id);
  $('inventory-results').innerHTML=ids.length?ids.map(itemCard).join(''):`<p class="manager-empty">${tab==='selected'?'Choose inventory to add your first piece.':'No inventory matches this search.'}</p>`;
  $('inventory-range').textContent=total?`${offset+1}–${Math.min(offset+24,total)} of ${total}`:'0 pieces';$('inventory-previous').disabled=offset===0;$('inventory-next').disabled=offset+24>=total;summary();
 }
 function payload(publish){
  const title=$('catalogue-name').value.trim(),credit=$('catalogue-credit').value.trim();
  if(!title)throw new Error('Give your catalogue a name.');
  if(credit && (!/^\d+(\.\d{1,2})?$/.test(credit)||Number(credit)>99999999.99))throw new Error('Use a valid credit amount with at most two decimal places.');
  if(publish&&!chosen.length)throw new Error('Choose at least one piece.');
  for(const s of chosen){if(!eligible(inventory.get(s.id)))throw new Error('Remove unavailable pieces or finish their pricing in inventory.');if(s.photos.length<1||s.photos.length>8)throw new Error('Choose one to eight photos per piece.');if(s.retail_override!=null && (!/^\d+(\.\d{1,2})?$/.test(String(s.retail_override))||Number(s.retail_override)<=0||Number(s.retail_override)>99999999.99))throw new Error('Enter a custom client price greater than zero with at most two decimal places.');}
  return{_id:record?.id||null,_expected_revision:record?.revision||0,_title:title,_introduction:$('catalogue-welcome').value,_credit:credit===''?null:Number(credit),_items:chosen,_publish:publish};
 }
 async function save(publish){
  if(busy)return;
  try{const args=payload(publish);lock(true);message('Saving catalogue…');const saved=await rpc('save_inventory_catalogue',args);record=Array.isArray(saved)?saved[0]:saved;dirty=false;share();await loadList();$('publish-dialog').close();message(publish?'Catalogue saved. Your client link is ready to copy.':'Draft saved. Only your team can view it.');}
  catch(e){message(e.message,true);$('publish-dialog').close();}finally{lock(false);renderInventory();}
 }
 async function previewData(){
  const args=payload(true);await signPhotos(chosen.map(s=>inventory.get(s.id)));
  // Same strict allowlist as the server. Never post full inventory records.
  return{title:args._title,introduction:args._introduction,credit:args._credit,currency:'USD',items:chosen.map(s=>{const i=inventory.get(s.id);return{id:i.id,name:i.title,description:i.description||'',retail_price:s.retail_override??i.sale_price,category:s.category,images:s.photos.map(p=>images.get(p)).filter(Boolean)};})};
 }
 document.addEventListener('click',async event=>{
  const b=event.target.closest('button');if(!b||busy)return;
  if(b.dataset.open){const c=catalogues.find(c=>c.id===b.dataset.open);if(c)await open(c);}
  if(b.dataset.choose){const id=b.dataset.choose,index=chosen.findIndex(s=>s.id===id);if(index>=0)chosen.splice(index,1);else{if(chosen.length>=100){message('A catalogue can contain up to 100 pieces.',true);return;}const i=inventory.get(id);if(!eligible(i))return;chosen.push({id,category:C.categoryFor(i),photos:paths(i).slice(0,1)});}markDirty();renderInventory();}
  if(b.dataset.move){const index=chosen.findIndex(s=>s.id===b.dataset.move),next=index+Number(b.dataset.direction);if(next>=0&&next<chosen.length){[chosen[index],chosen[next]]=[chosen[next],chosen[index]];markDirty();renderInventory();}}
 });
 document.addEventListener('change',event=>{
  const input=event.target;if(input.dataset.categoryItem){chosen.find(s=>s.id===input.dataset.categoryItem).category=input.value;markDirty();}
  if(input.dataset.customPrice){const s=chosen.find(s=>s.id===input.dataset.customPrice);s.retail_override=input.checked?Number(inventory.get(s.id).sale_price):null;markDirty();renderInventory();}
  if(input.dataset.itemPhoto){const s=chosen.find(s=>s.id===input.dataset.itemPhoto),p=paths(inventory.get(s.id))[Number(input.dataset.photoIndex)];if(input.checked){if(s.photos.length>=8){input.checked=false;message('Choose up to eight photos per piece.',true);return;}s.photos.push(p);}else s.photos=s.photos.filter(v=>v!==p);markDirty();}
 });
 document.addEventListener('input',event=>{const input=event.target;if(input.dataset.priceItem){chosen.find(s=>s.id===input.dataset.priceItem).retail_override=input.value;markDirty();}});
 for(const id of ['catalogue-name','catalogue-welcome','catalogue-credit'])$(id).addEventListener('input',markDirty);
 $('new-catalogue').addEventListener('click',()=>open());
 $('browse-tab').addEventListener('click',()=>{tab='browse';browse();});$('selected-tab').addEventListener('click',()=>{tab='selected';renderInventory();});
 const doSearch=()=>{offset=0;search=$('inventory-search').value.trim();browse();};$('inventory-search-button').addEventListener('click',doSearch);$('inventory-search').addEventListener('keydown',e=>{if(e.key==='Enter')doSearch();});
 $('inventory-previous').addEventListener('click',()=>{offset=Math.max(0,offset-24);browse();});$('inventory-next').addEventListener('click',()=>{offset+=24;browse();});
 $('save-catalogue').addEventListener('click',()=>save(record?.status==='published'));
 $('publish-catalogue').addEventListener('click',()=>{try{const p=payload(true);$('publish-summary').textContent=`${p._title} · ${chosen.length} pieces${p._credit!==null?` · ${C.money(p._credit)} client credit`:''}. Anyone with the link can view it.`;$('publish-dialog').showModal();}catch(e){message(e.message,true);}});
 $('cancel-publish').addEventListener('click',()=>$('publish-dialog').close());$('confirm-publish').addEventListener('click',()=>save(true));
 $('copy-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('catalogue-link').value);message('Client link copied.');}catch{$('catalogue-link').select();message('Select and copy the link above.');}});
 $('unpublish-catalogue').addEventListener('click',async()=>{if(!record||busy)return;lock(true);try{const saved=await rpc('unpublish_inventory_catalogue',{_id:record.id,_expected_revision:record.revision});record=Array.isArray(saved)?saved[0]:saved;share();await loadList();message('Link turned off. The catalogue is now a private draft.');}catch(e){message(e.message,true);}finally{lock(false);renderInventory();}});
 $('preview-catalogue').addEventListener('click',()=>{try{payload(true);previewWindow=window.open('catalogue.html?preview=1','og-catalogue-preview');if(!previewWindow)message('Allow this site to open the client preview in a new tab.',true);}catch(e){message(e.message,true);}});
 window.addEventListener('message',async event=>{if(event.origin!==location.origin||event.source!==previewWindow||event.data?.type!=='og-catalogue-preview-ready')return;try{const catalogue=await previewData();previewWindow.postMessage({type:'og-catalogue-preview',catalogue},location.origin);}catch(e){message(e.message,true);}});
 window.addEventListener('beforeunload',event=>{if(dirty){event.preventDefault();event.returnValue='';}});
 let booted=false;
 async function boot(){if(booted||!window.supabase?.auth)return;booted=true;client=window.supabase;try{const{data}=await client.auth.getSession();if(!data.session){message('Please sign in to Invsto, then reopen Client catalogues.',true);return;}await loadList();$('new-catalogue').disabled=false;await open();}catch(e){message(e.message||'Could not load catalogues.',true);}}
 document.addEventListener('supabase-ready',boot);boot();
})();
