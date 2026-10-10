(() => {
 'use strict';
 const C=window.Catalogue,$=id=>document.getElementById(id),E=C.escape;
 const names={pending_review:'Needs review',changes_requested:'Awaiting client',approved:'Approved · ready for checkout',fulfilled:'Fulfilled',declined:'Declined',cancelled:'Cancelled'};
 const stageOf=r=>['fulfilled','declined','cancelled'].includes(r.status)?'history':r.status;
 let client,rows=[],stage='pending_review',selectedId=new URLSearchParams(location.search).get('requestId'),current=null,action='',busy=false,loading=false,limit=100,total=0,generation=0,reloadQueued=false,lastSignedAt=0;
 const photos=new Map(),date=v=>new Date(v).toLocaleString([],{dateStyle:'medium',timeStyle:'short'}),ref=r=>r.id.replaceAll('-','').slice(0,8).toUpperCase();
 const fields='id,catalogue_id,catalogue_title,customer_name,contact,delivery,customer_note,items,total,credit_applied,balance,status,public_message,fulfillment_reference,revision,created_at,updated_at';
 function message(text,error=false){$('request-message').textContent=text;$('request-message').className=error?'error':'';}
 async function rpc(name,args){const {data,error}=await client.rpc(name,args);if(error)throw error;return data;}
 function render(){
  for(const b of document.querySelectorAll('[data-stage]'))b.setAttribute('aria-pressed',String(b.dataset.stage===stage));
  const term=$('request-search').value.trim().toLowerCase();const visible=rows.filter(r=>stageOf(r)===stage && (!term || [r.customer_name,r.contact,r.catalogue_title,ref(r)].join(' ').toLowerCase().includes(term)));
  $('request-count').textContent=`${visible.length} shown${total>rows.length?` · ${total} requests in this stage`:''}`;
  $('request-list').innerHTML=visible.length?visible.map(r=>`<button class="request-card ${selectedId===r.id?'selected':''}" data-request="${E(r.id)}" aria-pressed="${selectedId===r.id}"><div class="request-card-top"><span class="request-badge ${E(r.status)}">${E(names[r.status])}</span><span>#${ref(r)}</span></div><h2>${E(r.customer_name)}</h2><p>${E(r.catalogue_title)}</p><div class="request-card-bottom"><span>${r.items.length} ${r.items.length===1?'piece':'pieces'} · ${E(date(r.created_at))}</span><strong>${C.money(r.total)}</strong></div>${r.customer_note?`<p class="request-note-preview">${E(r.customer_note)}</p>`:''}</button>`).join(''):'<div class="request-empty"><h2>All clear.</h2><p>No requests match this view.</p></div>';
  $('load-requests').hidden=rows.length>=total;
 }
 async function signPhotos(items){
  if(Date.now()-lastSignedAt>240000){photos.clear();lastSignedAt=Date.now();}
  const sign=new Map();
  for(const i of items)for(const path of (i.photos||[]).slice(0,8)){
   if(photos.has(path))continue;
   if(/^https:\/\//i.test(path)){try{const u=new URL(path),m=u.pathname.match(/^\/storage\/v1\/object\/(?:sign|public|authenticated)\/photos\/(.+)$/);if(u.origin===window.SUPABASE_URL && m)sign.set(path,decodeURIComponent(m[1]));else photos.set(path,C.safeImage(path));}catch{}}
   else sign.set(path,path.replace(/^\/+/,''));
  }
  if(sign.size){const {data,error}=await client.storage.from('photos').createSignedUrls([...new Set(sign.values())],300);if(error)throw Error('Photos could not load. Refresh to try again.');const urls=new Map((data||[]).map(r=>[r.path,r.signedUrl]));for(const [p,k]of sign)photos.set(p,C.safeImage(urls.get(k)));}
 }
 async function detail(r){
  current=r;selectedId=r.id;const version=++generation;render();
  history.replaceState(null,'',`?requestId=${encodeURIComponent(r.id)}`);
  $('request-detail').innerHTML='<p class="request-empty">Opening selection…</p>';
  let imageError='';try{await signPhotos(r.items);}catch(e){imageError=e.message;}
  if(version!==generation)return;
  const t=(label,v)=>`<div><span>${label}</span><strong>${C.money(v)}</strong></div>`;
  $('request-detail').innerHTML=`<header class="request-detail-header"><div><p class="eyebrow">REQUEST ${ref(r)}</p><h2>${E(r.customer_name)}</h2><p>${E(r.catalogue_title)}</p></div><span class="request-badge ${E(r.status)}">${E(names[r.status])}</span></header>
   <div class="request-contact"><div><small>CONTACT</small><strong>${E(r.contact)}</strong></div><div><small>PREFERENCE</small><strong>${E({discuss:'Discuss with client',pickup:'Collect in store',shipping:'Shipping'}[r.delivery])}</strong></div><div><small>RECEIVED</small><span>${E(date(r.created_at))}</span></div></div>
   ${r.customer_note?`<div class="request-client-note"><p class="eyebrow">FROM THE CLIENT</p><p>${E(r.customer_note)}</p></div>`:''}
   <div class="request-money">${t('Selection total',r.total)}${t(r.status==='pending_review'?'Proposed credit':'Catalogue credit',r.credit_applied)}${t('Balance before tax / shipping',r.balance)}</div>
   <h3 class="request-section-title">Their selected pieces <span>${r.items.length}</span></h3>${imageError?`<p role="status">${E(imageError)}</p>`:''}
   <div class="request-pieces">${r.items.map(i=>`<article><div class="request-photo-strip">${(i.photos||[]).map(p=>photos.get(p)).filter(Boolean).map(src=>`<a href="${E(src)}" target="_blank" rel="noopener" aria-label="Enlarge ${E(i.name)}"><img src="${E(src)}" alt="${E(i.name)}" loading="lazy"></a>`).join('')||'<span>Photo unavailable</span>'}</div><div><p class="eyebrow">${E(i.category)}</p><h3>${E(i.name)}</h3><p>${E(i.description)}</p><strong>${C.money(i.retail_price)}</strong><a class="inventory-link" href="stock.html?highlightItem=${encodeURIComponent(i.id)}" target="_blank" rel="noopener">Inspect stock ↗</a></div></article>`).join('')}</div>
   ${r.public_message?`<div class="request-client-note"><p class="eyebrow">YOUR MESSAGE TO THE CLIENT</p><p>${E(r.public_message)}</p></div>`:''}
   <div class="request-next"><p class="eyebrow">NEXT STEP</p><p>${E(r.status==='pending_review'?'Confirm the pieces are available and the credit is correct. Approve this selection or leave clear instructions for a revision.':r.status==='approved'?'Complete payment and stock checkout, then arrange collection or shipping. Record the completed checkout reference here when the pieces have been handed over.':r.status==='changes_requested'?'The client can revise their selection from their private status link. Their resubmission will return to Needs review.':'This request is saved in History with its selection and review trail.')}</p><small>Approving allocates this catalogue’s credit. Stock is reserved or deducted only through your normal stock checkout. This request does not create an eBay order.</small>
   <div class="request-actions">${r.status==='pending_review'?'<button data-action="approve" class="gold-button">Approve selection</button><button data-action="changes">Request changes</button><button data-action="decline" class="text-action">Decline</button>':r.status==='approved'?'<a class="manager-button" href="stock.html" target="_blank" rel="noopener">Open stock checkout ↗</a><button data-action="fulfill" class="gold-button">Mark fulfilled</button><button data-action="cancel" class="text-action">Cancel request</button>':r.status==='changes_requested'?'<button data-action="cancel">Cancel request</button>':''}</div></div>
   ${r.fulfillment_reference?`<p>Checkout reference: <strong>${E(r.fulfillment_reference)}</strong></p>`:''}<details class="request-history"><summary>Review history</summary><div id="request-events">Loading history…</div></details>`;
  const {data,error}=await client.from('catalogue_request_events').select('revision,status,message,created_at').eq('request_id',r.id).order('revision',{ascending:false});
  if(version===generation)$('request-events').innerHTML=error?'History could not load. Refresh to retry.':(data||[]).map(e=>`<p><strong>${E(names[e.status])}</strong> · ${E(date(e.created_at))}${e.message?`<br>${E(e.message)}`:''}</p>`).join('');
 }
 async function load(){
  if(busy)return;if(loading){reloadQueued=true;return;}loading=true;const requestedStage=stage;
  try{
   const counts=await Promise.all(['pending_review','changes_requested','approved','history'].map(async s=>{let q=client.from('catalogue_requests').select('id',{count:'exact',head:true});q=s==='history'?q.in('status',['fulfilled','declined','cancelled']):q.eq('status',s);const {count,error}=await q;if(error)throw error;return[s,count||0];}));
   for(const [s,count]of counts)document.querySelector(`[data-stage="${s}"] b`).textContent=count;
   let q=client.from('catalogue_requests').select(fields,{count:'exact'});q=stage==='history'?q.in('status',['fulfilled','declined','cancelled']):q.eq('status',stage);
   const {data,count,error}=await q.order('created_at',{ascending:false}).limit(limit);if(error)throw error;if(stage!==requestedStage){reloadQueued=true;return;}rows=data||[];total=count||0;
   // A notification link must select both the matching card and its details,
   // even if it is outside the first page or changed stage after notification.
   if(selectedId && !rows.some(r=>r.id===selectedId)){
    const {data:target,error:targetError}=await client.from('catalogue_requests').select(fields).eq('id',selectedId).maybeSingle();if(targetError)throw targetError;
    if(target){if(stageOf(target)!==stage){stage=stageOf(target);loading=false;return load();}rows.unshift(target);}
   }
   render();message('');if(selectedId){const r=rows.find(r=>r.id===selectedId);if(r && (!current || current.revision!==r.revision || current.id!==r.id))await detail(r);}
  }catch(e){message(e.message||'Could not load requests. Try Refresh.',true);}finally{loading=false;if(reloadQueued){reloadQueued=false;void load();}}
 }
 function review(next){
  if(!current||busy)return;action=next;
  const titles={approve:'Approve this selection',changes:'Request a thoughtful revision',decline:'Decline this selection',fulfill:'Complete this request',cancel:'Close this request'};
  $('review-title').textContent=titles[action];$('review-message').value='';$('fulfillment-reference').value='';$('review-check').checked=false;$('review-error').textContent='';
  $('review-message').required=['changes','decline','cancel'].includes(action);$('review-message-label').textContent=$('review-message').required?'Required':'Optional';
  $('reference-field').hidden=action!=='fulfill';$('fulfillment-reference').required=action==='fulfill';
  $('review-help').textContent=action==='approve'?`Approve ${current.items.length} ${current.items.length===1?'piece':'pieces'} at ${C.money(current.total)}, including ${C.money(current.credit_applied)} catalogue credit. The submitted prices are preserved.`:action==='fulfill'?'Use this after the sale and inventory checkout are recorded and the pieces are handed over or dispatched.':'Your message will appear on the client’s private status page. No email or text is sent automatically.';
  $('review-confirmation').textContent=action==='approve'?'I checked availability and authorize this catalogue credit. I will complete the stock checkout separately.':action==='fulfill'?'Payment and stock checkout are recorded, and the pieces have been collected or dispatched.':'I reviewed this decision and the message visible to the client.';
  $('confirm-review').textContent=action==='approve'?'Approve selection':action==='fulfill'?'Save to History':'Save decision';$('review-dialog').showModal();
 }
 $('review-form').addEventListener('submit',async e=>{
  e.preventDefault();if(busy)return;busy=true;$('confirm-review').disabled=true;$('cancel-review').disabled=true;
  try{const r=await rpc('review_catalogue_request',{_id:current.id,_revision:current.revision,_action:action,_message:$('review-message').value.trim(),_reference:$('fulfillment-reference').value.trim()});
   $('review-dialog').close();stage=stageOf(r);current=null;selectedId=r.id;busy=false;await load();message('Saved. The client can see this update through their private status link.');
  }catch(e){$('review-error').textContent=e.message||'Could not save. Refresh and retry.';}finally{busy=false;$('confirm-review').disabled=false;$('cancel-review').disabled=false;}
 });
 $('review-dialog').addEventListener('cancel',e=>{if(busy)e.preventDefault();});$('cancel-review').onclick=()=>$('review-dialog').close();
 $('request-detail').addEventListener('click',e=>{const b=e.target.closest('[data-action]');if(b)review(b.dataset.action);});
 $('request-list').addEventListener('click',e=>{const b=e.target.closest('[data-request]');if(b){void detail(rows.find(r=>r.id===b.dataset.request));if(matchMedia('(max-width:800px)').matches)$('request-detail').scrollIntoView({behavior:'smooth',block:'start'});}});
 document.querySelectorAll('[data-stage]').forEach(b=>b.onclick=()=>{stage=b.dataset.stage;selectedId=null;current=null;generation++;limit=100;history.replaceState(null,'',location.pathname);$('request-detail').innerHTML='<div class="request-empty"><h2>Choose a request.</h2><p>Select a client on the left to review their pieces.</p></div>';void load();});
 $('request-search').oninput=render;$('refresh-requests').onclick=()=>{photos.clear();current=null;void load();};$('load-requests').onclick=()=>{limit+=100;void load();};
 let booted=false;async function boot(){if(booted||!window.supabase?.auth)return;booted=true;client=window.supabase;const {data}=await client.auth.getSession();if(!data.session){message('Sign in to Invsto to review client requests.',true);return;}if(selectedId && !/^[a-f\d-]{36}$/i.test(selectedId))selectedId=null;await load();setInterval(()=>{if(document.visibilityState==='visible' && !$('review-dialog').open)void load();},60000);}
 document.addEventListener('supabase-ready',boot);void boot();
})();
