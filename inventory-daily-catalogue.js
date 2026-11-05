(() => {
 'use strict';
 const C=window.Catalogue,$=id=>document.getElementById(id);
 const base='https://byhytmarmigalvawkedi.supabase.co',params=new URLSearchParams(location.search),token=params.get('share');
 const publicShell=document.body?.dataset?.catalogueAudience==='public';
 const dayKey='invsto:manny-catalogue-date',datePattern=/^\d{4}-\d{2}-\d{2}$/;
 const easternDay=()=>new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const dateLabel=value=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',weekday:'long',month:'long',day:'numeric',year:'numeric'}).format(new Date(value+'T12:00:00Z'));
 const timeLabel=value=>new Intl.DateTimeFormat('en-US',{timeZone:'America/New_York',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'}).format(new Date(value));
 let client,record=null,data=null,busy=false,booted=false,signedAt=0;
 function message(text,error=false){$('message').textContent=text;$('message').className=error?'error':'';}
 function missing(items){return items.filter(i=>!(Number(i.retail_price)>0)||!i.images?.length);}
 function lock(value){busy=value;for(const el of document.querySelectorAll('#staff-panel button,#staff-panel input'))el.disabled=value;$('print-report').disabled=value;updateActions();}
 function updateActions(){
  if(!$('staff-panel'))return;
  $('draft-actions').hidden=!record;$('share-panel').hidden=!record?.published;
  $('publish').disabled=busy||!data?.items?.length||missing(data.items).length>0;
  $('publish').textContent=record?.published?'Update published link':'Publish share link';
  if(record){$('draft-status').textContent=`${record.draft.items.length} item styles · Draft gathered ${timeLabel(record.draft.prepared_at)}`;}
  if(record?.published){const url=new URL('https://www.og-jewelers.com/representative-catalogue');url.searchParams.set('share',record.share_token);$('share-link').value=url.href;$('open-link').href=url.href;}
 }
 function render(){
  const items=data.items||[],groups=[...new Set(items.map(i=>i.category||'Other'))],prices=items.map(i=>Number(i.retail_price)).filter(p=>p>0);
  document.title=`${data.recipient} · eBay catalogue · ${data.source_date} | OG Jewelers`;
  $('report').hidden=false;$('print-report').hidden=!items.length;
  $('recipient').textContent=`Prepared for ${data.recipient} · eBay`;$('footer-recipient').textContent=`${data.recipient} at eBay`;
  $('report-date').textContent=`Inventory added ${dateLabel(data.source_date)} · Eastern time`;
  $('prepared-at').textContent=`Prepared ${timeLabel(data.prepared_at)}`;
  $('style-count').textContent=items.length;$('type-count').textContent=groups.length;
  $('price-range').textContent=prices.length?(Math.min(...prices)===Math.max(...prices)?C.money(prices[0]):`${C.money(Math.min(...prices))} – ${C.money(Math.max(...prices))}`):'Pricing in progress';
  const hero=items.find(i=>i.images?.length);$('hero-image').innerHTML=hero?`<button class="hero-zoom" data-photo="${C.escape(hero.id)}" aria-label="Expand featured photo of ${C.escape(hero.name)}"><img src="${C.escape(C.safeImage(hero.images[0]))}" alt="${C.escape(hero.name)}"><span>View & zoom ↗</span></button>`:'';
  $('hero-image').hidden=!hero;
  const incomplete=missing(items);$('readiness').hidden=Boolean(token)||!incomplete.length;
  $('readiness').innerHTML=`<strong>${incomplete.length} ${incomplete.length===1?'item needs':'items need'} attention before publishing</strong><p>All additions are included below. Finish their photos or retail prices in Stock, then gather again.</p>`+incomplete.map(i=>`<a href="#piece-${C.escape(i.id)}">${C.escape(i.name)} · ${[!(Number(i.retail_price)>0)&&'Retail price needed',!i.images?.length&&'Photo needed'].filter(Boolean).join(' · ')}</a>`).join('');
  $('category-index').innerHTML=groups.map((g,n)=>`<a href="#category-${n}">${C.escape(g)}<b>${items.filter(i=>(i.category||'Other')===g).length}</b></a>`).join('');
  $('item-index').innerHTML=items.length?`<ol class="index-list">${items.map((i,n)=>`<li><span class="index-number">${String(n+1).padStart(2,'0')}</span><a href="#piece-${C.escape(i.id)}">${C.escape(i.name)}</a><strong>${i.retail_price>0?C.money(i.retail_price):'Price pending'}</strong></li>`).join('')}</ol>`:'<p>No new item styles were added on this date.</p>';
  $('collection').innerHTML=groups.map((g,n)=>`<section class="category-section" id="category-${n}"><header class="category-heading"><div><p class="eyebrow">THE SELECTION / ${String(n+1).padStart(2,'0')}</p><h2>${C.escape(g)}</h2></div><a href="#index">Back to index ↑</a></header><div class="review-grid">${items.filter(i=>(i.category||'Other')===g).map(i=>piece(i,items.indexOf(i)+1)).join('')}</div></section>`).join('');
  updateActions();
 }
 function piece(i,n){
  const images=(i.images||[]).map(C.safeImage).filter(Boolean);
  const facts=[i.purity_basis_points?C.purityLabel(String(i.purity_basis_points),i.material):i.material&&String(i.material).replace(/^./,c=>c.toUpperCase()),Number(i.weight)>0&&`${Number(i.weight)} g`].filter(Boolean);
  return `<article class="review-piece" id="piece-${C.escape(i.id)}">${images.length?`<button class="piece-photo" data-photo="${C.escape(i.id)}" aria-label="Expand photo of ${C.escape(i.name)}"><img src="${C.escape(images[0])}" loading="lazy" alt="${C.escape(i.name)}"><span>View & zoom ↗</span></button>`:'<div class="empty-photo">Photo coming soon</div>'}<div class="piece-copy"><div class="piece-topline"><span>${String(n).padStart(2,'0')} / ${C.escape(i.reference||i.category)}</span><a href="#index">Index ↑</a></div><h3>${C.escape(i.name)}</h3><div class="piece-facts">${facts.map(f=>`<span>${C.escape(f)}</span>`).join('')}</div>${i.description?`<p class="piece-description">${C.escape(i.description)}</p>`:''}${images.length>1?`<div class="photo-strip">${images.map((src,index)=>`<button data-photo="${C.escape(i.id)}" data-index="${index}" aria-label="View photo ${index+1} of ${C.escape(i.name)}"><img src="${C.escape(src)}" loading="lazy" alt="${C.escape(i.name)} · photo ${index+1}"></button>`).join('')}</div>`:''}<div class="piece-price"><small>RETAIL / USD</small><strong>${i.retail_price>0?C.money(i.retail_price):'Price pending'}</strong></div></div></article>`;
 }
 async function rpc(name,args){const{data,error}=await client.rpc(name,args);if(error)throw new Error(error.message);return Array.isArray(data)?data[0]:data;}
 async function signDraft(draft){
  const keys=new Map(),external=new Map();
  for(const i of draft.items)for(const p of i.photos||[]){
   if(/^https:\/\//i.test(p)){try{const u=new URL(p),m=u.pathname.match(/^\/storage\/v1\/object\/(?:sign|public|authenticated)\/photos\/(.+)$/);if(u.origin===base&&m)keys.set(p,decodeURIComponent(m[1]));else if(u.origin!==base)external.set(p,C.safeImage(p));}catch{}}
   else if(!p.includes(':')&&!p.split('/').includes('..'))keys.set(p,p.replace(/^\//,''));
  }
  const urls=new Map(),paths=[...new Set(keys.values())];
  // Sign in bounded batches; the catalogue itself is never truncated.
  for(let n=0;n<paths.length;n+=100){const{data,error}=await client.storage.from('photos').createSignedUrls(paths.slice(n,n+100),1800);if(error)throw new Error('Photos could not load. Please gather again.');for(const p of data||[])if(p.signedUrl)urls.set(p.path,p.signedUrl);}
  signedAt=Date.now();return{...draft,items:draft.items.map(i=>({...i,images:(i.photos||[]).map(p=>urls.get(keys.get(p))||external.get(p)).filter(Boolean)}))};
 }
 async function useRecord(row){record=row;data=await signDraft(row.draft);render();}
 async function gather(){
  if(busy||!client)return;
  const date=$('source-date').value;if(!datePattern.test(date)){message('Choose the date the inventory was added.',true);return;}
  lock(true);message('Gathering every item added on the selected Eastern date…');
  try{const row=await rpc('prepare_inventory_daily_catalogue',{_date:date,_recipient:'Manny'});await useRecord(row);try{localStorage.setItem(dayKey,date);}catch{}history.replaceState(null,'',`?date=${date}`);message(`${data.items.length} item styles gathered for Manny. ${missing(data.items).length?'See the items needing attention below.':'Review the selection, then publish the share link when ready.'}`);}
  catch(e){message(e.message,true);}finally{lock(false);}
 }
 async function publish(value){
  if(busy||!record)return;lock(true);message(value?'Publishing the reviewed selection…':'Turning the shared link off…');
  try{record=await rpc('publish_inventory_daily_catalogue',{_id:record.id,_revision:record.revision,_publish:value});updateActions();message(value?'The catalogue link is ready to share with Manny.':'The shared link is off. Your draft is kept.');}
  catch(e){message(e.message,true);}finally{lock(false);}
 }
 async function loadPublic(){
  const response=await fetch(`${base}/functions/v1/storefront-catalog?daily_catalogue=${encodeURIComponent(token)}`,{cache:'no-store'});
  if(!response.ok)throw new Error(response.status===404?'This catalogue is not available. Please ask OG Jewelers for the current link.':'The catalogue could not load. Please refresh in a moment.');
  data=await response.json();signedAt=Date.now();render();message('');
 }
 function script(src){return new Promise((resolve,reject)=>{const el=document.createElement('script');el.src=src;el.onload=resolve;el.onerror=()=>reject(new Error('Sign-in could not load. Please refresh.'));document.head.append(el);});}
 async function bootStaff(){
  if(booted||!window.supabase?.auth)return;booted=true;client=window.supabase;
  try{
   const{data:auth}=await client.auth.getSession();if(!auth.session)throw new Error('Please sign in to Invsto, then reopen the Manny catalogue.');
   const{data:rows,error}=await client.from('inventory_daily_catalogues').select('*').eq('recipient','Manny').order('updated_at',{ascending:false}).limit(50);if(error)throw error;
   let remembered='';try{remembered=localStorage.getItem(dayKey)||'';}catch{}
   const explicit=params.get('date'),latest=rows?.[0];
   const date=datePattern.test(explicit||'')?explicit:latest?.source_date||(datePattern.test(remembered)?remembered:easternDay());
   $('source-date').value=date;$('source-date').max=easternDay();$('staff-panel').hidden=false;$('back-catalogues').hidden=false;
   const saved=rows?.find(r=>r.source_date===date);
   if(saved){await useRecord(saved);message('Your saved draft is ready. Gather all items again to include the latest additions before sharing.');}
   else message('Choose the inventory date, then click Gather all items.');
  }catch(e){message(e.message,true);}
 }
 $('gather')?.addEventListener('click',gather);
 function clearDate(){record=null;data=null;$('report').hidden=true;$('print-report').hidden=true;updateActions();message('Click Gather all items for this date.');}
 $('today')?.addEventListener('click',()=>{$('source-date').value=easternDay();clearDate();});$('source-date')?.addEventListener('change',clearDate);
 $('publish')?.addEventListener('click',()=>publish(true));$('unpublish')?.addEventListener('click',()=>publish(false));
 $('copy-link')?.addEventListener('click',async()=>{try{await navigator.clipboard.writeText($('share-link').value);message('Catalogue link copied.');}catch{$('share-link').select();message('Select and copy the catalogue link above.');}});
 document.addEventListener('click',e=>{const b=e.target.closest('[data-photo]');if(!b||!data)return;const i=data.items.find(i=>i.id===b.dataset.photo);if(i)window.CatalogueViewer.open(i,Number(b.dataset.index||0),b);});
 async function printImage(src){
  // Keep originals for zoom; use a sharp, bounded raster only in the PDF.
  const img=new Image();img.crossOrigin='anonymous';
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Photo conversion timed out')),15000);img.onload=()=>{clearTimeout(timer);resolve();};img.onerror=()=>{clearTimeout(timer);reject(new Error('Photo conversion unavailable'));};img.src=src;});
  const scale=Math.min(1,1280/Math.max(img.naturalWidth,img.naturalHeight)),canvas=document.createElement('canvas');
  canvas.width=Math.round(img.naturalWidth*scale);canvas.height=Math.round(img.naturalHeight*scale);
  const ctx=canvas.getContext('2d');ctx.fillStyle='#ffffff';ctx.fillRect(0,0,canvas.width,canvas.height);ctx.drawImage(img,0,0,canvas.width,canvas.height);
  return canvas.toDataURL('image/jpeg',.88);
 }
 $('print-report').addEventListener('click',async()=>{
  if(busy||!data)return;lock(true);message('Preparing all photographs for your PDF…');
  const originals=new Map();const restore=()=>{for(const [img,src]of originals)if(img.isConnected)img.src=src;originals.clear();};
  try{
   if(Date.now()-signedAt>(token?180000:1200000)){if(token)await loadPublic();else{data=await signDraft(record.draft);render();}}
   const photos=[...document.querySelectorAll('#report img')];photos.forEach(i=>i.loading='eager');
   await Promise.all(photos.map(i=>new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('A photo is taking too long to load. Try Print / Save PDF again.')),30000);const done=()=>{clearTimeout(timer);i.naturalWidth?resolve():reject(new Error('A photo could not load. Refresh before saving the PDF.'));};if(i.complete)done();else{i.addEventListener('load',done,{once:true});i.addEventListener('error',done,{once:true});}})));
   const converted=new Map(),sources=[...new Set(photos.map(img=>img.src))];
   for(let start=0;start<sources.length;start+=4)await Promise.all(sources.slice(start,start+4).map(async src=>{try{converted.set(src,await printImage(src));}catch{converted.set(src,src);}}));
   for(const img of photos){originals.set(img,img.src);img.src=converted.get(img.src);await img.decode();}
   window.addEventListener('afterprint',restore,{once:true});
   message('');window.print();
  }catch(e){restore();message(e.message,true);}finally{lock(false);}
 });
 if(token){loadPublic().catch(e=>message(e.message,true));setInterval(()=>{if(!document.hidden&&!busy&&!window.CatalogueViewer.isOpen)loadPublic().catch(e=>message(e.message,true));},240000);}
 else if(publicShell)message('Open the complete catalogue link shared by OG Jewelers to view your selection.');
 else{document.addEventListener('supabase-ready',bootStaff);script('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2').then(()=>script('initSupabase.js')).then(bootStaff).catch(e=>message(e.message,true));}
})();
