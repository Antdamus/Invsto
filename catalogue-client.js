(() => {
 'use strict';
 const C=window.Catalogue,$=id=>document.getElementById(id);
 const token=location.hash.slice(1),preview=new URLSearchParams(location.search).get('preview')==='1';
 const endpoint='https://byhytmarmigalvawkedi.supabase.co/functions/v1/storefront-catalog';
 let catalogue=null,selected=new Set(),category='',detailId=null,busy=false,started=false,lastSuccess=0;
 const storageKey=`og-catalogue-selection:${token}`;
 function message(text,error=false){$('client-message').textContent=text;$('client-message').className=error?'error-message':'';}
 function reconcile(){selected=new Set([...selected].filter(id=>catalogue.items.some(i=>i.id===id)));try{if(!preview)sessionStorage.setItem(storageKey,JSON.stringify([...selected]));}catch{}}
 function render(){
  if(!catalogue)return;
  $('catalogue-title').textContent=catalogue.title;$('catalogue-intro').textContent=catalogue.introduction||'Discover the pieces selected especially for you.';
  document.title=`${catalogue.title} · OG Jewelers`;
  const credit=catalogue.credit!==null && catalogue.credit!==undefined;
  $('credit-panel').hidden=!credit;$('credit-amount').textContent=C.money(catalogue.credit);
  const categories=[...new Set(catalogue.items.map(i=>i.category))];if(!categories.includes(category))category='';
  $('client-categories').innerHTML=['',...C.categories.filter(c=>categories.includes(c))].map(c=>`<button data-category="${C.escape(c)}" aria-pressed="${category===c}">${C.escape(c||'All pieces')}</button>`).join('');
  const items=C.filter(catalogue.items,{category,search:$('client-search').value,min:$('client-min').value,max:$('client-max').value,sort:$('client-sort').value});
  $('piece-count').textContent=`${items.length} ${items.length===1?'piece':'pieces'}${items.length!==catalogue.items.length?` of ${catalogue.items.length}`:''}`;
  $('client-grid').innerHTML=items.length?items.map(i=>C.card(i,selected.has(i.id))).join(''):'<p class="empty-collection">No pieces match these filters. Try another search or clear your filters.</p>';
  $('catalogue-content').hidden=false;$('selection-open').disabled=false;
  totals();
 }
 function totals(){
  const t=C.totals(catalogue.items,selected,catalogue.credit),credit=catalogue.credit!==null && catalogue.credit!==undefined;
  $('selection-count').textContent=t.count;$('bar-count').textContent=t.count;
  $('selection-bar').hidden=!t.count;$('bar-total').textContent=C.money(t.total);
  $('bar-credit-wrap').hidden=!credit;$('bar-credit').textContent=C.money(t.remaining);
  $('bar-due-label').textContent=credit?'ABOVE CREDIT':'TOTAL';$('bar-due').textContent=C.money(t.due);
  if($('selection-dialog').open)renderSelection();
 }
 function toggle(id){
  if(!catalogue?.items.some(i=>i.id===id))return;
  selected.has(id)?selected.delete(id):selected.add(id);reconcile();render();
  if($('piece-dialog').open && detailId===id){const b=$('piece-detail').querySelector('[data-select]');b.textContent=selected.has(id)?'✓ In your selection':'＋ Select this piece';b.setAttribute('aria-pressed',String(selected.has(id)));b.classList.toggle('chosen',selected.has(id));}
 }
 function showDetails(id){
  const i=catalogue.items.find(i=>i.id===id);if(!i)return;detailId=id;
  const imgs=(i.images||[]).map(C.safeImage).filter(Boolean);
  $('piece-detail').innerHTML=`<div class="piece-detail-layout"><div>${imgs.length?`<img class="detail-main-photo" id="detail-photo" src="${C.escape(imgs[0])}" alt="${C.escape(i.name)}"><div class="detail-thumbnails">${imgs.map((src,n)=>`<button data-photo="${n}" aria-label="Photo ${n+1}"><img src="${C.escape(src)}" alt=""></button>`).join('')}</div>`:'<p>Photo unavailable</p>'}</div><div class="detail-copy"><p class="eyebrow">${C.escape(i.category)}</p><h2>${C.escape(i.name)}</h2><p>${C.escape(i.description)}</p><p class="detail-price">${C.money(i.retail_price)} <small>USD</small></p><button class="choose-piece ${selected.has(id)?'chosen':''}" data-select="${C.escape(id)}" aria-pressed="${selected.has(id)}">${selected.has(id)?'✓ In your selection':'＋ Select this piece'}</button><p class="selection-explainer">Select to see your total. Contact the store to confirm availability.</p></div></div>`;
  if(!$('piece-dialog').open)$('piece-dialog').showModal();
 }
 function renderSelection(){
  const items=catalogue.items.filter(i=>selected.has(i.id)),t=C.totals(catalogue.items,selected,catalogue.credit),credit=catalogue.credit!==null && catalogue.credit!==undefined;
  $('selection-items').innerHTML=items.length?items.map(i=>`<article class="selection-row">${C.safeImage(i.images?.[0])?`<img src="${C.escape(C.safeImage(i.images[0]))}" alt="">`:'<span></span>'}<div><h3>${C.escape(i.name)}</h3><p>${C.money(i.retail_price)}</p></div><button data-select="${C.escape(i.id)}" aria-label="Remove ${C.escape(i.name)}">Remove</button></article>`).join(''):'<p class="empty-collection">Select a piece to start your collection.</p>';
  const row=(label,v)=>`<div class="total-row"><span>${label}</span><span>${C.money(v)}</span></div>`;
  $('selection-totals').innerHTML=row('Retail total',t.total)+(credit?row('Credit applied',t.applied)+row('Credit remaining',t.remaining):'')+row(credit?'Amount above credit':'Selection total',t.due);
  $('copy-selection').disabled=!items.length;
 }
 function showSelection(){renderSelection();$('selection-message').textContent='';$('selection-dialog').showModal();}
 async function load(){
  if(busy||preview)return;busy=true;
  try{
   if(!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(token))throw new Error('This catalogue link is incomplete. Please ask the store for the full link.');
   const response=await fetch(`${endpoint}?catalogue=${encodeURIComponent(token)}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});
   if(response.status===404){catalogue=null;selected.clear();$('catalogue-content').hidden=true;$('selection-bar').hidden=true;$('credit-panel').hidden=true;$('selection-open').disabled=true;$('piece-dialog').close();$('selection-dialog').close();$('catalogue-title').textContent='This selection is unavailable.';$('catalogue-intro').textContent='Please contact the store for an updated catalogue link.';message('');return;}
   if(!response.ok)throw new Error('The catalogue could not be refreshed. Please try again shortly.');
   catalogue=await response.json();lastSuccess=Date.now();
   if(!started){started=true;try{const saved=JSON.parse(sessionStorage.getItem(storageKey)||'[]');if(Array.isArray(saved))selected=new Set(saved.filter(v=>typeof v==='string'));}catch{}}
   reconcile();message('');render();
   if($('piece-dialog').open){if(catalogue.items.some(i=>i.id===detailId))showDetails(detailId);else $('piece-dialog').close();}
  }catch(error){message(error.message || 'Unable to load the catalogue.',true);if(!catalogue)$('catalogue-intro').textContent='Please check your connection and reload.';}
  finally{busy=false;}
 }
 document.addEventListener('click',event=>{
  const b=event.target.closest('button');if(!b)return;
  if(b.dataset.select)toggle(b.dataset.select);
  if(b.dataset.details)showDetails(b.dataset.details);
  if(b.hasAttribute('data-category')){category=b.dataset.category;render();}
  if(b.dataset.close)$(b.dataset.close).close();
  if(b.hasAttribute('data-photo')){const i=catalogue.items.find(i=>i.id===detailId);const src=(i?.images||[]).map(C.safeImage).filter(Boolean)[Number(b.dataset.photo)];if(src)$('detail-photo').src=src;}
 });
 for(const id of ['client-search','client-min','client-max'])$(id).addEventListener('input',render);
 $('client-sort').addEventListener('change',render);
 $('filter-toggle').addEventListener('click',()=>{$('client-filters').hidden=!$('client-filters').hidden;$('filter-toggle').setAttribute('aria-expanded',String(!$('client-filters').hidden));});
 $('clear-filters').addEventListener('click',()=>{for(const id of ['client-search','client-min','client-max'])$(id).value='';category='';$('client-sort').value='curated';render();});
 $('selection-open').addEventListener('click',showSelection);$('review-selection').addEventListener('click',showSelection);
 document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();window.scrollTo({top:0,behavior:'smooth'});});
 $('copy-selection').addEventListener('click',async()=>{
  if(!preview && Date.now()-lastSuccess>60000)await load();if(!catalogue)return;
  const items=catalogue.items.filter(i=>selected.has(i.id)),t=C.totals(catalogue.items,selected,catalogue.credit);
  const text=[catalogue.title,...items.map(i=>`${i.name} — ${C.money(i.retail_price)}`),`Retail total: ${C.money(t.total)}`,...(catalogue.credit!==null?[`Catalogue credit: ${C.money(catalogue.credit)}`,`Credit remaining: ${C.money(t.remaining)}`,`Amount above credit: ${C.money(t.due)}`]:[]),'Selection only; availability and final total to be confirmed by OG Jewelers.',...(preview?[]:[location.href])].join('\n');
  try{await navigator.clipboard.writeText(text);$('selection-message').textContent='Copied. You can paste this in your conversation with the store.';}catch{$('selection-message').textContent='Copying is unavailable in this browser. You can share a screenshot of your selection.';}
 });
 if(preview){
  message('STAFF PREVIEW · This catalogue is not shared by opening this preview.');
  window.addEventListener('message',event=>{if(event.origin!==location.origin || event.source!==window.opener || event.data?.type!=='og-catalogue-preview')return;catalogue=event.data.catalogue;reconcile();render();});
  window.opener?.postMessage({type:'og-catalogue-preview-ready'},location.origin);
 }else{
  load();setInterval(()=>{if(document.visibilityState==='visible')load();},240000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible')load();});
  window.addEventListener('online',load);
 }
})();
