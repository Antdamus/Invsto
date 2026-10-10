(() => {
 'use strict';
 const C=window.Catalogue,$=id=>document.getElementById(id);
 const [token,receiptFromLink]=location.hash.slice(1).split('/'),preview=new URLSearchParams(location.search).get('preview')==='1';
 const endpoint='https://byhytmarmigalvawkedi.supabase.co/functions/v1/storefront-catalog';
 let catalogue=null,selected=new Set(),category='',detailId=null,busy=false,started=false,lastSuccess=0;
 const storageKey=`og-catalogue-selection:${token}`;
 let receiptKey=receiptFromLink || '',receipt=null,sending=false,editing=false;
 try {receiptKey ||= sessionStorage.getItem(storageKey+':receipt') || '';} catch {}
 function message(text,error=false){$('client-message').textContent=text;$('client-message').className=error?'error-message':'';}
 function reconcile(){selected=new Set([...selected].filter(id=>catalogue.items.some(i=>i.id===id)));try{if(!preview)sessionStorage.setItem(storageKey,JSON.stringify([...selected]));}catch{}}
 function renderFeature(){
  if(!$('hero-feature'))return; // Older branded shells may be cached during rollout.
  const item=catalogue.items.find(i=>C.safeImage(i.images?.[0]));
  $('hero-feature').hidden=!item;$('hero-actions').hidden=!catalogue.items.length;
  $('hero-piece-count').textContent=`${catalogue.items.length} carefully chosen ${catalogue.items.length===1?'piece':'pieces'}`;
  document.querySelector('.catalogue-hero').classList.toggle('without-feature',!item);
  if(!item)return;
  const html=`<button class="featured-piece" data-details="${C.escape(item.id)}" aria-label="Explore ${C.escape(item.name)}"><span class="feature-topline"><span>IN YOUR COLLECTION</span><span aria-hidden="true">01 / ${String(catalogue.items.length).padStart(2,'0')}</span></span><span class="feature-image"><img src="${C.escape(C.safeImage(item.images[0]))}" alt="${C.escape(item.name)}" fetchpriority="high" decoding="async"></span><span class="feature-caption"><span><small>${C.escape(item.category)}</small><strong>${C.escape(item.name)}</strong></span><span class="feature-arrow" aria-hidden="true">↗</span></span></button>`;
  if($('hero-feature').innerHTML!==html)$('hero-feature').innerHTML=html;
 }
 function render(){
  if(!catalogue)return;
  const focus=document.activeElement,focusCategory=focus?.dataset?.category,focusSelection=focus?.dataset?.select;
  $('catalogue-title').textContent=catalogue.title;$('catalogue-intro').textContent=catalogue.introduction||'Discover the pieces selected especially for you.';
  document.title=`${catalogue.title} · OG Jewelers`;
  const credit=catalogue.credit!==null && catalogue.credit!==undefined;
  $('credit-panel').hidden=!credit;renderFeature();
  const categories=[...new Set(catalogue.items.map(i=>i.category))];if(!categories.includes(category))category='';
  $('client-categories').innerHTML=['',...C.categories.filter(c=>categories.includes(c))].map(c=>`<button data-category="${C.escape(c)}" aria-pressed="${category===c}">${C.escape(c||'All pieces')}</button>`).join('');
  const items=C.filter(catalogue.items,{category,search:$('client-search').value,min:$('client-min').value,max:$('client-max').value,sort:$('client-sort').value});
  $('piece-count').textContent=`${items.length} ${items.length===1?'piece':'pieces'}${items.length!==catalogue.items.length?` of ${catalogue.items.length}`:''}`;
  $('client-grid').innerHTML=items.length?items.map(i=>C.card(i,selected.has(i.id))).join(''):'<p class="empty-collection">No pieces match these filters. Try another search or clear your filters.</p>';
  $('catalogue-content').hidden=false;$('selection-open').disabled=false;
  totals();if(receipt && !editing)renderReceipt();
  // Keep keyboard users on the control they just activated after replacing cards.
  if(focusCategory!==undefined)[...$('client-categories').querySelectorAll('button')].find(b=>b.dataset.category===focusCategory)?.focus({preventScroll:true});
  if(focusSelection && !focus?.isConnected)[...$('client-grid').querySelectorAll('[data-select]')].find(b=>b.dataset.select===focusSelection)?.focus({preventScroll:true});
 }
 function totals(){
  const t=C.totals(catalogue.items,selected,catalogue.credit),credit=catalogue.credit!==null && catalogue.credit!==undefined;
  $('selection-count').textContent=t.count;$('bar-count').textContent=t.count;
  $('selection-bar').hidden=!t.count;$('bar-total').textContent=C.money(t.total);
  $('bar-credit-wrap').hidden=!credit;$('bar-credit').textContent=C.money(t.remaining);
  if($('bar-due-wrap'))$('bar-due-wrap').hidden=!credit;
  $('credit-amount').textContent=C.money(t.remaining);if($('credit-caption'))$('credit-caption').textContent=t.count?'Remaining after your selection':'Available to use on your selection';
  $('bar-due-label').textContent=credit?'ABOVE CREDIT':'TOTAL';$('bar-due').textContent=C.money(t.due);
  if($('selection-dialog').open)renderSelection();
 }
 function toggle(id){
  if(sending)return;if(receipt && !editing){showReceipt();return;}
  if(!catalogue?.items.some(i=>i.id===id))return;
  selected.has(id)?selected.delete(id):selected.add(id);reconcile();render();
  if($('piece-dialog').open && detailId===id){const b=$('piece-detail').querySelector('[data-select]');b.textContent=selected.has(id)?'✓ In your selection':'＋ Select this piece';b.setAttribute('aria-pressed',String(selected.has(id)));b.classList.toggle('chosen',selected.has(id));}
 }
 function showDetails(id){
  const i=catalogue.items.find(i=>i.id===id);if(!i)return;detailId=id;
  const imgs=(i.images||[]).map(C.safeImage).filter(Boolean);
  $('piece-detail').innerHTML=`<div class="piece-detail-layout"><div class="detail-gallery">${imgs.length?`<img class="detail-main-photo" id="detail-photo" src="${C.escape(imgs[0])}" alt="${C.escape(i.name)}"><div class="detail-thumbnails" aria-label="Piece photographs" ${imgs.length<2?'hidden':''}>${imgs.map((src,n)=>`<button data-photo="${n}" aria-label="Photo ${n+1}" aria-pressed="${n===0}"><img src="${C.escape(src)}" alt="" loading="lazy"></button>`).join('')}</div>`:'<p>Photo unavailable</p>'}</div><div class="detail-copy"><p class="eyebrow">${C.escape(i.category)} · THE PRIVATE EDIT</p><h2 id="piece-heading">${C.escape(i.name)}</h2><p class="detail-description">${C.escape(i.description)}</p><p class="detail-price">${C.money(i.retail_price)} <small>USD</small></p><button class="choose-piece ${selected.has(id)?'chosen':''}" data-select="${C.escape(id)}" aria-pressed="${selected.has(id)}">${selected.has(id)?'✓ In your selection':'＋ Select this piece'}</button><p class="selection-explainer">Yours to consider. Our team will confirm availability and help with the next steps.</p></div></div>`;
  $('piece-dialog').setAttribute('aria-labelledby','piece-heading');
  if(receipt && !editing)$('piece-detail').querySelector('[data-select]').hidden=true;
  if(!$('piece-dialog').open)$('piece-dialog').showModal();
 }
 function renderSelection(){
  const items=catalogue.items.filter(i=>selected.has(i.id)),t=C.totals(catalogue.items,selected,catalogue.credit),credit=catalogue.credit!==null && catalogue.credit!==undefined;
  $('selection-items').innerHTML=items.length?items.map(i=>`<article class="selection-row">${C.safeImage(i.images?.[0])?`<img src="${C.escape(C.safeImage(i.images[0]))}" alt="">`:'<span></span>'}<div><h3>${C.escape(i.name)}</h3><p>${C.money(i.retail_price)}</p></div><button data-select="${C.escape(i.id)}" aria-label="Remove ${C.escape(i.name)}">Remove</button></article>`).join(''):'<p class="empty-collection">Select a piece to start your collection.</p>';
  const row=(label,v)=>`<div class="total-row"><span>${label}</span><span>${C.money(v)}</span></div>`;
  $('selection-totals').innerHTML=row('Retail total',t.total)+(credit?row('Credit applied',t.applied)+row('Credit remaining',t.remaining):'')+row(credit?'Amount above credit':'Selection total',t.due);
  $('continue-selection').disabled=!items.length || sending;
  $('send-summary').textContent=`${t.count} ${t.count===1?'piece':'pieces'} · ${C.money(t.total)}${credit?` · ${C.money(t.applied)} credit · ${C.money(t.due)} balance`:''}`;
 }
 function showSelection(){if(!receipt && !preview && receiptKey){void refreshReceipt().then(()=>{if(receipt)showReceipt();else openSelection();});return;}openSelection();}
 function openSelection(){if(receipt && !editing){showReceipt();return;}selectionStep(false);renderSelection();$('selection-message').textContent='';$('selection-dialog').showModal();}
 async function load(){
  if(busy||preview||sending||$('selection-dialog').open)return;busy=true;
  try{
   if(!/^[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12}$/i.test(token))throw new Error('This catalogue link is incomplete. Please ask the store for the full link.');
   const response=await fetch(`${endpoint}?catalogue=${encodeURIComponent(token)}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});
   if(response.status===404){catalogue=null;selected.clear();$('catalogue-content').hidden=true;$('selection-bar').hidden=true;$('credit-panel').hidden=true;for(const id of ['hero-feature','hero-actions'])if($(id))$(id).hidden=true;document.querySelector('.catalogue-hero').classList.add('without-feature');$('selection-open').disabled=true;$('piece-dialog').close();$('selection-dialog').close();$('catalogue-title').textContent='This selection is unavailable.';$('catalogue-intro').textContent='Please contact the store for an updated catalogue link.';message('');return;}
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
  if(b.hasAttribute('data-photo')){const i=catalogue.items.find(i=>i.id===detailId);const src=(i?.images||[]).map(C.safeImage).filter(Boolean)[Number(b.dataset.photo)];if(src){$('detail-photo').src=src;$('piece-detail').querySelectorAll('[data-photo]').forEach(p=>p.setAttribute('aria-pressed',String(p===b)));}}
 });
 for(const id of ['client-search','client-min','client-max'])$(id).addEventListener('input',render);
 $('client-sort').addEventListener('change',render);
 $('filter-toggle').addEventListener('click',()=>{$('client-filters').hidden=!$('client-filters').hidden;$('filter-toggle').setAttribute('aria-expanded',String(!$('client-filters').hidden));});
 $('clear-filters').addEventListener('click',()=>{for(const id of ['client-search','client-min','client-max'])$(id).value='';category='';$('client-sort').value='curated';render();});
 $('selection-open').addEventListener('click',showSelection);$('review-selection').addEventListener('click',showSelection);
 document.querySelector('.brand').addEventListener('click',e=>{e.preventDefault();window.scrollTo({top:0,behavior:'smooth'});});
 // Catalogue and receipt secrets live in the hash; in-page links must preserve it.
 document.querySelectorAll('a[href="#catalogue-content"]').forEach(a=>a.addEventListener('click',e=>{e.preventDefault();if($('catalogue-content').hidden)return;$('catalogue-content').scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});$('catalogue-content').focus({preventScroll:true});}));
 function selectionStep(contact){$('selection-review').hidden=contact;$('selection-form').hidden=!contact;$('review-step').classList.toggle('current',!contact);$('contact-step').classList.toggle('current',contact);}
 const statusCopy={
  pending_review:['Selection received.','Our team will review your pieces, confirm availability and help with the next steps.'],
  changes_requested:['A note from our team.','Please review our message, adjust your selection and send it back when you are ready.'],
  approved:['Your selection is approved.','Our team will arrange checkout and delivery with you. No payment has been taken on this page.'],
  fulfilled:['Your collection is complete.','Your request has been marked fulfilled by our team. Thank you for choosing OG Jewelers.'],
  declined:['An update on your selection.','Please see the message from our team below.'],
  cancelled:['This request is closed.','Please contact our team if you would like help with a new selection.']
 };
 function renderReceipt(){
  if(!receipt)return;const [heading,description]=statusCopy[receipt.status]||['Your request','Our team is reviewing this selection.'];
  $('receipt-heading').textContent=heading;$('receipt-description').textContent=description;
  $('receipt-content').innerHTML=`<p class="receipt-reference">REQUEST ${C.escape(receipt.reference)} · ${C.escape(new Date(receipt.updated_at).toLocaleDateString())}</p>${receipt.message?`<div class="concierge-message"><span class="eyebrow">FROM OG JEWELERS</span><p>${C.escape(receipt.message)}</p></div>`:''}<div class="receipt-pieces">${receipt.items.map(i=>`<div><span>${C.escape(i.name)}</span><strong>${C.money(i.retail_price)}</strong></div>`).join('')}</div><div class="total-row"><span>Selected pieces</span><span>${C.money(receipt.total)}</span></div><div class="total-row"><span>Catalogue credit</span><span>${C.money(receipt.credit_applied)}</span></div><div class="total-row"><span>Balance before shipping / tax</span><span>${C.money(receipt.balance)}</span></div>`;
  $('edit-request').hidden=receipt.status!=='changes_requested';$('copy-status-link').classList.toggle('dark-button',receipt.status!=='changes_requested');$('copy-status-link').classList.toggle('quiet-button',receipt.status==='changes_requested');
  $('selection-open').firstChild.textContent='Your request ↗ ';$('selection-count').hidden=true;$('selection-open').disabled=false;
  $('selection-bar').hidden=true;
  if(!editing)document.querySelectorAll('[data-select]').forEach(b=>{b.hidden=true;});
 }
 function showReceipt(){renderReceipt();if(!$('receipt-dialog').open)$('receipt-dialog').showModal();void refreshReceipt();}
 async function refreshReceipt(){
  if(!receiptKey||preview||sending)return;
  try{const response=await fetch(`${endpoint}?catalogue=${encodeURIComponent(token)}&receipt=${encodeURIComponent(receiptKey)}`,{cache:'no-store',credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(20000)});
   if(response.status===404){if(receiptFromLink)$('receipt-error').textContent='This request link could not be found. Contact the store for help.';return;}
   if(!response.ok)throw Error();receipt=await response.json();$('receipt-error').textContent='';renderReceipt();
  }catch{$('receipt-error').textContent='The status could not be refreshed. Please try again.';}
 }
 $('continue-selection').addEventListener('click',()=>{selectionStep(true);$('client-name').focus();});
 $('back-selection').addEventListener('click',()=>selectionStep(false));
 $('selection-dialog').addEventListener('cancel',e=>{if(sending)e.preventDefault();});
 $('selection-form').addEventListener('submit',async event=>{
  event.preventDefault();if(sending||!catalogue||!selected.size)return;
  if(preview){$('selection-message').textContent='Staff preview only. Clients can submit from the published catalogue link.';return;}
  sending=true;for(const el of $('selection-dialog').querySelectorAll('button,input,select,textarea'))el.disabled=true;
  $('selection-message').textContent='Sending your selection…';
  try {
   receiptKey ||= crypto.randomUUID();try{sessionStorage.setItem(storageKey+':receipt',receiptKey);}catch{}
   const response=await fetch(`${endpoint}?catalogue=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/json'},credentials:'omit',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(25000),
    body:JSON.stringify({receipt:receiptKey,revision:editing?receipt?.revision:null,name:$('client-name').value.trim(),contact:$('client-contact').value.trim(),delivery:$('client-delivery').value,note:$('client-note').value.trim(),credit:catalogue.credit,
     items:catalogue.items.filter(i=>selected.has(i.id)).map(i=>({id:i.id,retail_price:Number(i.retail_price)}))})});
   const result=await response.json();
   if(!response.ok){
    const errors={selection_changed:'The prices, pieces or credit have changed. Reopen your selection to review the latest details.',request_limit:'This catalogue has received several requests. Please contact our team before sending another.',catalogue_unavailable:'This catalogue is no longer available. Please contact the store.',invalid_contact:'Please check your name and contact details.'};
    if(result.error==='selection_changed'){sending=false;$('selection-dialog').close();await load();showSelection();}
    throw Error(errors[result.error]||'We could not confirm your request. Please try again; a retry will not create a duplicate.');
   }
   receipt=result;editing=false;selected.clear();reconcile();$('selection-dialog').close();
   history.replaceState(null,'',`${location.pathname}${location.search}#${token}/${receiptKey}`);renderReceipt();$('receipt-dialog').showModal();
  } catch(error){$('selection-message').textContent=error.message||'Please try again. Your selection is still here.';}
  finally{sending=false;for(const el of $('selection-dialog').querySelectorAll('button,input,select,textarea'))el.disabled=false;}
 });
 $('copy-status-link').addEventListener('click',async()=>{try{await navigator.clipboard.writeText(`${location.origin}${location.pathname}#${token}/${receiptKey}`);$('receipt-error').textContent='Private status link copied.';}catch{$('receipt-error').textContent='Copy the address from your browser to save your private status link.';}});
 $('refresh-request').addEventListener('click',refreshReceipt);
 $('edit-request').addEventListener('click',async()=>{editing=true;$('receipt-dialog').close();await load();if(!catalogue)return;selected=new Set(receipt.items.map(i=>i.id));reconcile();render();showSelection();});
 if(preview){
  message('STAFF PREVIEW · This catalogue is not shared by opening this preview.');
  window.addEventListener('message',event=>{if(event.origin!==location.origin || event.source!==window.opener || event.data?.type!=='og-catalogue-preview')return;catalogue=event.data.catalogue;reconcile();render();});
  window.opener?.postMessage({type:'og-catalogue-preview-ready'},location.origin);
 }else{
  void (async()=>{await load();await refreshReceipt();if(receiptFromLink && receipt)showReceipt();})();setInterval(()=>{if(document.visibilityState==='visible'){load();refreshReceipt();}},60000);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){load();refreshReceipt();}});
  window.addEventListener('online',load);
  window.addEventListener('hashchange',()=>location.reload());
 }
})();
