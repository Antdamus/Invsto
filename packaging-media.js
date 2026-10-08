/* Read-only photo references for Packaging. Item associations use saved IDs,
   never a bag number guess. Viewing media never changes package quantities. */
(() => {
 'use strict';
 const array=v=>Array.isArray(v)?v:[], unique=v=>[...new Set(v.filter(Boolean).map(String))];
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const date=v=>v?new Date(v).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}):'';
 const type=p=>p.media_type==='video'||/^video\//.test(p.mime_type||p.content_type||'')||/\.(mp4|mov|webm)$/i.test(p.path||'')?'video':/\.pdf$/i.test(p.path||'')?'file':'image';
 function scope(p,e,lines) {
  const orders=unique([e.order_id,...array(e.order_ids)]), candidates=lines.filter(l=>orders.includes(l.order_id));
  const m=p.metadata||{},payload=e.payload||{};
  const explicit=unique([...array(p.order_line_ids),...array(p.orderLineIds),p.order_line_id,...array(m.order_line_ids),...array(m.orderLineIds),m.order_line_id]);
  const numbers=unique([p.itemNumber,p.item_number,p.selectedItemId,m.itemNumber,m.item_number,m.selectedItemId]);
  // A photo's own identifiers override a task that covers multiple items.
  if(explicit.length||numbers.length)return candidates.filter(l=>(!explicit.length||explicit.includes(l.id))&&(!numbers.length||numbers.includes(l.item_number))).map(l=>l.id);
  const eventIds=unique([...array(payload.order_line_ids),payload.order_line_id]);
  const inherited=eventIds.length?eventIds:array(e.task_line_ids);
  if(inherited.length)return candidates.filter(l=>inherited.includes(l.id)).map(l=>l.id);
  const itemNumbers=unique([payload.itemNumber,payload.item_number,e.task_metadata?.item_number]);
  if(itemNumbers.length)return candidates.filter(l=>itemNumbers.includes(l.item_number)).map(l=>l.id);
  const legacy=String(p.label||'').match(/video[-_\s]?receipt\s*[-:]?\s*(\d{6,})/i)?.[1];
  if(legacy)return candidates.filter(l=>l.item_number===legacy).map(l=>l.id);
  return candidates.length===1?[candidates[0].id]:[];
 }
 function index(detail) {
  const entries=new Map(),lines=detail.lines||[],orderIds=new Set(detail.orders.map(o=>o.id));
  function add(p,kind,orders,lineIds,meta={}) {
   if(!p?.bucket||!p.path)return;
   orders=unique(orders).filter(id=>orderIds.has(id));if(!orders.length)return;
   lineIds=unique(lineIds).filter(id=>lines.some(l=>l.id===id&&orders.includes(l.order_id)));
   const key=p.bucket+'/'+p.path,old=entries.get(key);
   const value={...meta,...p,key,kind,media_type:type(p),order_ids:orders,order_line_ids:lineIds};
   if(old){value.order_ids=unique([...old.order_ids,...orders]);value.order_line_ids=unique([...old.order_line_ids,...lineIds]);value.kind=old.kind==='completion'||kind==='completion'?'completion':old.kind==='item'||kind==='item'?'item':'reference';Object.assign(old,value);}
   else entries.set(key,value);
  }
  for(const p of detail.bag_photos||[])add(p,'item',p.order_ids||[],p.order_line_ids||[]);
  const events=detail.reference_events||detail.order_events||[];
  for(const e of events){if(e.payload?.history_removed===true||e.payload?.history_removed==='true')continue;for(const p of array(e.photo_attachments)) {
   const source=[p.metadata?.source,p.label,p.path,e.payload?.proof_type].filter(Boolean).join(' ');
   const kind=/completion[-_ ]photo/i.test(source)?'completion':/video[-_ ]?receipt|live[-_ ]bag|live photo/i.test(source)?'item':'reference';
   add(p,kind,[e.order_id],scope(p,e,lines),{created_at:e.created_at,signed_by_email:e.signed_by_email});
  }}
  for(const e of detail.completion_events||[])for(const p of array(e.photo_attachments)) {
   const source=[p.metadata?.source,p.label,p.path].join(' '),kind=/video[-_ ]?receipt/i.test(source)?'item':'completion';
   add(p,kind,e.order_ids,scope(p,{...e,payload:{order_line_ids:e.order_line_ids}},lines),{created_at:e.created_at,signed_by_email:e.signed_by_email});
  }
  return [...entries.values()].sort((a,b)=>String(b.created_at||'').localeCompare(String(a.created_at||'')));
 }
 function create({signed}) {
  let detail,refs=[],observer,revision=0,active=0,pending=[],galleryId=0,viewerVersion=0,viewer=null,focusBack=null;
  const galleries=new Map(),dialog=document.getElementById('pack-photo-viewer');
  const $=id=>document.getElementById(id);
  function reset(data){revision++;observer?.disconnect();pending=[];galleries.clear();galleryId=0;detail=data;refs=index(data);if(dialog.open)dialog.close();}
  function caption(p){return (p.kind==='completion'?'Order completion':p.kind==='item'?'Item screenshot':'Order reference')+' · '+p.order_ids.map(id=>detail.orders.find(o=>o.id===id)?.order_number).filter(Boolean).join(' · ');}
  function gallery(list,style='item'){
   if(!list.length)return '';
   const id=String(++galleryId);galleries.set(id,list);
   return `<div class="pack-gallery pack-gallery--${style}" data-gallery="${id}">${list.map((p,i)=>`<figure class="pack-reference"><button type="button" class="pack-photo-thumb" data-reference="${id}" data-photo="${i}" aria-label="Enlarge ${esc(p.label||'photo')} · ${i+1} of ${list.length}"><span class="pack-photo-loading">${p.media_type==='video'?'▶ Video':p.media_type==='file'?'Document':'Loading photo…'}</span><span class="pack-photo-enlarge">${p.media_type==='image'?'⤢ Enlarge':'Open'}</span></button><figcaption><strong>${esc(p.label||'Order photo')}</strong><span>${esc(caption(p))}</span>${p.created_at?`<small>${esc(date(p.created_at))}${p.signed_by_email?' · '+esc(p.signed_by_email):''}</small>`:''}</figcaption></figure>`).join('')}</div>`;
  }
  function linePhotos(line){return refs.filter(p=>p.kind!=='completion'&&p.order_line_ids.includes(line.id));}
  function lineHtml(line){const photos=linePhotos(line);return `<div class="pack-line-photos"><div class="pack-photo-heading">Item screenshots <span>${photos.length||'None saved'}</span></div>${photos.length?gallery(photos):'<div class="pack-photo-empty"><span aria-hidden="true">▧</span><strong>No item screenshot saved</strong><small>Check the order notes before packing.</small></div>'}</div>`;}
  function completionHtml(){const photos=refs.filter(p=>p.kind==='completion');return `<section class="pack-section pack-completion" id="pack-completion-photos"><div class="pack-section-head"><div><span class="pack-eyebrow">FROM PENDING ORDERS</span><h3>Order completion photos</h3></div><span>${photos.length} photo${photos.length===1?'':'s'}</span></div><p class="pack-instructions">Compare what the order team handed over with the items you are packaging.</p>${photos.length?gallery(photos,'completion'):'<p class="pack-photo-missing">No order completion photos were saved.</p>'}</section>`;}
  function otherHtml(){const photos=refs.filter(p=>p.kind!=='completion'&&!p.order_line_ids.length);return photos.length?`<section class="pack-section"><div class="pack-section-head"><h3>Other order references</h3><span>${photos.length} files</span></div><p class="pack-instructions">These files belong to the order, but a specific item was not identified.</p>${gallery(photos,'reference')}</section>`:'';}
  function summary(){const pictured=detail.lines.filter(l=>linePhotos(l).some(p=>p.media_type==='image')).length,completion=refs.filter(p=>p.kind==='completion').length;return `<nav class="pack-photo-nav" aria-label="Package reference photos"><a href="#pack-items">Item screenshots <b>${pictured}/${detail.lines.length}</b></a><a href="#pack-completion-photos">Completion photos <b>${completion}</b></a></nav>`;}
  function variant(p){const v=p.variants?.preview||p.derivatives?.preview;return v?.path?{bucket:v.bucket||p.bucket,path:v.path}:p.preview_path?{bucket:p.preview_bucket||p.bucket,path:p.preview_path}:p.thumbnail_path?{bucket:p.thumbnail_bucket||p.bucket,path:p.thumbnail_path}:p;}
  async function thumbnail(el,run){const p=galleries.get(el.dataset.reference)?.[Number(el.dataset.photo)];if(!p||p.media_type!=='image')return;let candidate=variant(p);
   async function attempt(ref){const url=await signed(ref);if(run!==revision||!el.isConnected)return;const img=new Image();img.alt=p.label||'Item photo';img.decoding='async';await new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Photo timed out')),12000);img.onload=()=>{clearTimeout(timeout);resolve();};img.onerror=()=>{clearTimeout(timeout);reject(Error('Photo unavailable'));};img.src=url;});if(run!==revision||!el.isConnected)return;el.querySelector('.pack-photo-loading')?.replaceWith(img);}
   try{await attempt(candidate);}catch{try{if(candidate.path===p.path)throw Error();await attempt(p);}catch{if(run===revision&&el.isConnected){const box=el.querySelector('.pack-photo-loading');if(box)box.textContent='Photo unavailable · Tap to retry';el.classList.add('has-photo-error');}}}
  }
  function pump(){while(active<4&&pending.length){const job=pending.shift();active++;thumbnail(job.el,job.run).finally(()=>{active--;pump();});}}
  function mount(){observer?.disconnect();observer=new IntersectionObserver(entries=>{for(const e of entries)if(e.isIntersecting){observer.unobserve(e.target);pending.push({el:e.target,run:revision});}pump();},{rootMargin:'400px'});document.querySelectorAll('[data-reference]').forEach(el=>observer.observe(el));}
  async function showPhoto(force=false){const run=++viewerVersion,{list,position}=viewer,p=list[position];$('pack-view-stage').classList.remove('is-zoomed');$('pack-view-zoom').textContent='Zoom in';$('pack-view-zoom').setAttribute('aria-pressed','false');$('pack-view-zoom').hidden=p.media_type!=='image';$('pack-view-title').textContent=p.label||'Order photo';$('pack-view-context').textContent=caption(p);$('pack-view-items').textContent=p.order_line_ids.map(id=>detail.lines.find(l=>l.id===id)?.item_title).filter(Boolean).join(' · ');$('pack-view-audit').textContent=[date(p.created_at),p.signed_by_email].filter(Boolean).join(' · ');$('pack-view-count').textContent=`${position+1} / ${list.length}`;$('pack-view-prev').disabled=position===0;$('pack-view-next').disabled=position===list.length-1;
   const stage=$('pack-view-stage');stage.replaceChildren();stage.textContent='Loading full-size photo…';$('pack-view-original').hidden=true;
   try{const url=await signed(p,force);if(run!==viewerVersion||!dialog.open)return;const link=$('pack-view-original');link.href=url;link.hidden=false;
    if(p.media_type==='file'){stage.textContent='Open the original file to view this document.';return;}
    const media=document.createElement(p.media_type==='video'?'video':'img');media.src=url;media.alt=p.label||'Order photo';if(p.media_type==='video'){media.controls=true;media.playsInline=true;media.preload='metadata';}else media.decoding='async';
    let triedPreview=false;
    media.onerror=async()=>{if(run!==viewerVersion)return;const preview=variant(p);
     if(p.media_type==='image'&&!triedPreview&&preview.path!==p.path){triedPreview=true;try{const previewUrl=await signed(preview);if(run!==viewerVersion)return;media.src=previewUrl;return;}catch{}}
     if(run===viewerVersion){stage.textContent='This file could not be displayed. Retry, or open the original file.';const retry=document.createElement('button');retry.className='pack-button';retry.textContent='Retry photo';retry.onclick=()=>showPhoto(true);stage.append(retry);}};stage.replaceChildren(media);
   }catch{if(run===viewerVersion){stage.textContent='Photo could not load. Your package has not changed.';const retry=document.createElement('button');retry.className='pack-button';retry.textContent='Retry photo';retry.onclick=()=>showPhoto(true);stage.append(retry);}}
  }
  function open(el){const list=galleries.get(el.dataset.reference);if(!list)return;focusBack=el;viewer={list,position:Number(el.dataset.photo)};window.OGTaskNotifications?.dismiss();dialog.showModal();void showPhoto();}
  function move(delta){if(!viewer)return;const next=viewer.position+delta;if(next<0||next>=viewer.list.length)return;viewer.position=next;void showPhoto();}
  document.querySelector('.packaging-page').addEventListener('click',e=>{const el=e.target.closest('[data-reference]');if(el){e.preventDefault();open(el);}});
  $('pack-view-close').onclick=()=>dialog.close();$('pack-view-prev').onclick=()=>move(-1);$('pack-view-next').onclick=()=>move(1);
  $('pack-view-zoom').onclick=()=>{const zoom=$('pack-view-stage').classList.toggle('is-zoomed');$('pack-view-zoom').textContent=zoom?'Fit photo':'Zoom in';$('pack-view-zoom').setAttribute('aria-pressed',String(zoom));};
  document.addEventListener('keydown',e=>{if(!dialog.open)return;if(e.key==='ArrowRight'){e.preventDefault();move(1);}if(e.key==='ArrowLeft'){e.preventDefault();move(-1);}});
  dialog.addEventListener('close',()=>{viewerVersion++;$('pack-view-stage').replaceChildren();viewer=null;if(focusBack?.isConnected)focusBack.focus({preventScroll:true});});
  return {reset,lineHtml,completionHtml,otherHtml,summary,mount};
 }
 window.OGPackagingMedia={create,index};
})();
