(function(){
 'use strict';
 const M=window.WhatnotOrdersModel,E=M.escape,$=id=>document.getElementById(id);
 let db,groups=[],view=new URLSearchParams(location.search).get('view')||'pending',filter='all',due='all',offset=0,totalBuyers=0,connection=null,admin=false,loading=false,action=null,generation=0,scannedTracking=null;
 const workflowViews={pending:'Pending',review:'Review',closeout:'Pending information to close',history:'History',all:'All orders'};
 const marketViews={market_open:'Open',unfulfilled:'Unfulfilled',market_completed:'Completed',market_cancelled:'Cancelled',market_failed:'Failed'};
 const knownViews={...workflowViews,...marketViews};
 const marketStatus=status=>({pending:'Pending confirmation',pending_fulfillment:'Open · awaiting fulfillment',completed:'Completed',cancelled:'Cancelled',failed:'Failed'}[status]||status||'Unknown');
 if(!knownViews[view])view='pending';
 const status=(text,error=false)=>{$('wn-status').textContent=text;$('wn-status').classList.toggle('wn-error',error);};
 const link=(href,label)=>href?`<a href="${E(href)}" target="_blank" rel="noopener">${E(label)} ↗</a>`:'';
 const counted=(n,label)=>n+' '+label+(n===1?'':'s');
 const allLines=()=>groups.flatMap(g=>g.lines);
 const selected=g=>{const node=document.querySelector(`[data-buyer="${CSS.escape(g.buyer_key)}"]`);return g.lines.filter(l=>node?.querySelector(`[data-select-line="${l.id}"]`)?.checked);};
 async function rpc(name,args){const r=await db.rpc(name,args);if(r.error)throw Error(r.error.message);return r.data;}
 async function api(action,body={}){const r=await db.functions.invoke('whatnot-order-sync',{body:{action,...body}});if(r.error){let detail;try{detail=await r.error.context?.json();}catch{}throw Error(detail?.error||'Could not reach Whatnot sync. Try again.');}if(r.data?.error)throw Error(r.data.error);return r.data;}
 async function loadConnection(){
  const previousSync=connection?.last_synced_at;const r=await api('status');connection=r.connection;admin=r.admin;
  $('wn-connect').hidden=!admin;$('wn-connect').disabled=!r.configured;$('wn-connect').textContent=connection?'Reconnect Whatnot':'Connect Whatnot';
  $('wn-sync').hidden=!connection;$('wn-sync').disabled=!connection?.enabled;
  $('wn-pause').hidden=!admin||!connection;$('wn-pause').textContent=connection?.enabled?'Pause auto sync':'Resume auto sync';$('wn-full-sync').hidden=!admin||!connection;
  const c=connection,health=$('wn-tools-health');
  health.dataset.alert=String(!c?.enabled||Boolean(c?.last_error));
  health.textContent=!c?'Setup needed':c.last_error?'Needs attention':!c.enabled?'Paused':c.full_in_progress?'Importing':'Connected';
  $('wn-connection-status').textContent=!r.configured?'Server setup is being completed.':!c?'Connect ogjewelers to import all available order history.':`${c.seller_name} · ${c.enabled?'Automatic sync enabled':'Sync paused'} · ${c.full_in_progress?`Importing full history · ${c.orders_processed} orders processed`:`Last update ${M.time(c.last_synced_at)}`} · ${c.last_full_sync_at?`Full history checked ${M.time(c.last_full_sync_at)}`:'Initial history import not finished'}${c.expires_at?` · Token expires on ${c.expires_at.slice(0,10)} (Whatnot)`:''}${c.last_error?' · '+c.last_error:''}`;
  if(c?.last_synced_at&&c.last_synced_at!==previousSync&&!loading){if(!document.querySelector('dialog[open],[data-select-line]:checked,details[data-evidence][open],details[data-market-timeline][open],html[data-wn-receipt-saving="true"]'))await refresh();else status('New Whatnot updates are available. Finish reviewing or editing, then reload saved orders.');}
 }
 function tags(l){const o=l.order_record,d=M.urgency(l.ship_by_date);return `<span class="wn-tag ${E(l.work_state)}">${E(l.work_state==='external_history'?'Imported marketplace history':l.work_state==='completed'?'Completed in Invsto':o.status==='cancelled'?'In Invsto history':o.status==='completed'?'Pending information to close':'Pending in Invsto')}</span>${l.scope!=='history'&&o.status!=='completed'?`<span class="wn-tag ${d.kind}">${E(d.text)}</span>`:''}${l.item_missing?'<span class="wn-tag missing">Item not found</span>':''}${l.watch_missing?'<span class="wn-tag missing">Missing watch</span>':''}${l.cancel_pending?'<span class="wn-tag review">Flagged to cancel in Invsto</span>':''}${l.cgl_pending?'<span class="wn-tag review">Pending CGL</span>':''}${l.holds?.map(h=>`<span class="wn-tag review">${E(h==='order_pending_cancellation'?'Cancellation requested on Whatnot':h.replaceAll('_',' '))}</span>`).join('')||''}${l.replacement_shipment_id?'<span class="wn-tag review">Shipment changed · awaiting exact new assignment</span>':''}`;}
 const noteControl=(o,l)=>window.MarketplaceOrderNotes?.control([o],l)||'';
 const notePhotos=window.MarketplaceOrderNotes.photoPicker($('wn-note-photos'));
 $('wn-action-dialog').addEventListener('close',()=>notePhotos.clear());
 $('wn-action-dialog').addEventListener('cancel',event=>{if(action?.saving)event.preventDefault();});
 function lineHtml(l){const o=l.order_record;return `<article class="wn-line ${l.item_missing?'missing':''}" id="wn-item-${l.id}"><label aria-label="Select order ${E(o.id)} item ${l.id}"><input type="checkbox" data-select-line="${l.id}"></label><div><span class="mq-line-number">Line ${l.line_number} of ${l.order_lines}</span><h3 class="mq-item-title">${E(l.title||'Item title unavailable')}</h3><div class="wn-line-status">${l.order_lines>1?shownLabelBadge([l]):''}${window.PendingQueueCards.linePhoto(l.screenshot_count)}${tags(l)}</div><p>Purchased ${E(M.time(o.purchased_at))} · Qty ${l.quantity}${l.sku?' · SKU '+E(l.sku):''}</p>${o.show_title?`<p>Show: ${E(o.show_title)}</p>`:''}${noteControl(o,l)}<div class="wn-line-links">${link(M.url(o.url),'Whatnot order')}${o.show_id?link(M.receipt(l),l.receipt_url?'Saved receipt':'Video receipt'):''}${link(M.url(l.shipment_url),'Shipment / label')}${link(M.url(o.show_url),'Show')}</div><details class="wn-details" data-evidence="${l.id}"><summary>Photos, labels, notes & timeline</summary><div class="wn-evidence-body">Open to load saved evidence.</div></details></div><aside class="wn-line-side"><div class="wn-price">${E(M.money(Number(l.unit_price)*l.quantity,l.currency))}</div>${l.quantity>1?`<p>${E(M.money(l.unit_price,l.currency))} per item</p>`:''}<p><strong>${E((l.shipment_status||'No shipment assigned').replaceAll('_',' '))}</strong></p>${l.tracking_number?`<strong class="wn-track-caption">Assigned tracking</strong><div class="wn-tracking">${link(M.tracking(l.tracking_number,l.carrier),l.tracking_number)||E(l.tracking_number)}</div><p>${E(l.carrier||'Carrier not supplied')}</p>`:'<p>No tracking number yet</p>'}${l.last_mile_tracking&&l.last_mile_tracking!==l.tracking_number?`<p>Last-mile tracking: ${E(l.last_mile_tracking)}</p>`:''}${l.shipment_id?`<p>Package ${E(l.shipment_id)}</p>`:''}${M.ready(l)?`<button class="wn-pack-line" data-line-action="complete" data-line="${E(l.id)}">Photo &amp; close line</button>`:''}<button data-line-action="receipt" data-line="${l.id}">Save receipt link</button></aside></article>`;}
 function orderLabelBadge(l){
  return window.PendingQueueCards.shippingLabelBadge(l.order_label_pdfs,l.order_lines,'line',l.order_labels_issued_only,l.order_label_pdfs_to_check);
 }
 function shownLabelBadge(lines){
  const count=state=>lines.filter(l=>l.label_state===state).length;
  const review=count('review');
  return window.PendingQueueCards.shippingLabelBadge(count('attached')+review,lines.length,'line',count('issued'),review);
 }
 function orderBlocks(lines){
  const orders=new Map();
  for(const l of lines){
   if(!orders.has(l.order_id))orders.set(l.order_id,[]);
   orders.get(l.order_id).push(l);
  }
  return [...orders.values()].map(items=>{
   const order=items[0];
   return `<section class="wn-order-block"><header><div class="wn-order-status-head"><strong>Order #${E(order.order_id)}</strong><span class="wn-tag ${E(order.order_record.status)}">Whatnot · ${E(marketStatus(order.order_record.status))}</span></div>${order.order_record.cancelled_at?`<small>Cancelled ${E(M.time(order.order_record.cancelled_at))}</small>`:order.order_record.status==='completed'&&order.order_record.source_updated_at?`<small>Whatnot last updated ${E(M.time(order.order_record.source_updated_at))}</small>`:''}${items.some(l=>l.order_record.status==='completed'&&l.work_state==='pending')?'<p class="wn-closeout-alert"><strong>Pending information to close</strong> · Check the shipping label, tracking and packing photo, then complete the selected lines in Invsto.</p>':''}<div class="mq-order-summary"><span>${window.PendingQueueCards.orderCounts(order.order_lines,order.order_units,items.length)}</span>${orderLabelBadge(order)}${window.PendingQueueCards.screenshotBadge(order.order_missing_screenshots)}</div>${noteControl(order.order_record)}</header>${items.map(lineHtml).join('')}<details class="wn-market-timeline" data-market-timeline="${E(order.order_id)}"><summary>Whatnot status history</summary><div></div></details></section>`;
  }).join('');
 }
 function render(){
  $('wn-orders').innerHTML=groups.length?groups.map(g=>`<section class="wn-buyer" data-buyer="${E(g.buyer_key)}"><header><div><span class="eyebrow">BUYER</span><h2>${E(g.buyer)}</h2>${g.customer&&g.customer.toLowerCase()!==g.buyer.toLowerCase()?`<p>${E(g.customer)}</p>`:''}</div><div>${filter!=='all'||due!=='all'||$('wn-search').value.trim()?'Shown · ':''}<strong>${counted(new Set(g.lines.map(l=>l.order_id)).size,'order')}</strong> · ${window.PendingQueueCards.orderCounts(g.lines.length,g.lines.reduce((n,l)=>n+l.quantity,0))}<div class="wn-summary-badges">${shownLabelBadge(g.lines)}${window.PendingQueueCards.screenshotBadge(g.lines.filter(l=>!l.screenshot_count).length)}</div></div></header><div class="wn-actions"><button data-group-action="select">Select shown items</button><button data-group-action="complete">Complete selected</button><button data-group-action="upload">Add photos / label</button><button data-group-action="note">Note selected lines</button><details class="mq-actions"><summary>Item status</summary><div><button data-group-action="missing">Item not found</button><button data-group-action="found">Item found</button><button data-group-action="cgl">Pending CGL</button><button data-group-action="cgl_done">CGL ready</button><button data-group-action="watch_missing">Watch missing</button><button data-group-action="watch_found">Watch found</button><button data-group-action="cancel_pending">Mark pending to cancel</button><button data-group-action="cancel_clear">Clear cancellation mark</button></div></details><details class="mq-actions"><summary>Buyer reports</summary><div><button data-group-action="report">Shown items report / PDF</button><button data-group-action="full_report">Full buyer history / PDF</button></div></details><button data-group-action="expand">${g.matched?'Show matching items':'Show buyer’s other items'}</button>${admin?'<button data-group-action="reopen">Reopen selected</button>':''}</div>${orderBlocks(g.lines)}</section>`).join(''):'<div class="wn-empty">No matching items in this view.</div>';
  window.MarketplaceOrderNotes?.refresh();
  $('wn-page').textContent=totalBuyers?`Buyers ${offset+1}–${Math.min(offset+groups.length,totalBuyers)} of ${totalBuyers}`:'No buyers';$('wn-prev').disabled=offset===0;$('wn-next').disabled=offset+groups.length>=totalBuyers;
  for(const details of document.querySelectorAll('[data-market-timeline]'))details.ontoggle=async()=>{
   if(!details.open||details.dataset.loaded||details.dataset.loading)return;
   details.dataset.loading='true';const body=details.querySelector('div');body.textContent='Loading status changes…';
   try{
    const events=[];for(let start=0;;start+=100){
     const r=await db.from('whatnot_order_events').select('id,action,details,created_at').eq('order_id',details.dataset.marketTimeline).is('line_id',null).in('action',['order_imported','status_updated']).order('created_at').order('id').range(start,start+99);
     if(r.error)throw r.error;events.push(...r.data);if(r.data.length<100)break;
    }
    body.innerHTML=events.map(e=>`<p><strong>${e.details.previous_status?E(marketStatus(e.details.previous_status))+' → ':'First seen as '}${E(marketStatus(e.details.status))}</strong> · Observed by Invsto ${E(M.time(e.created_at))}</p>`).join('')||'No recorded status changes.';
    details.dataset.loaded='yes';
   }catch(e){body.textContent=e.message||'Could not read the status history. Close and reopen to retry.';}finally{delete details.dataset.loading;}
  };
  for(const details of document.querySelectorAll('[data-evidence]'))details.addEventListener('toggle',()=>{if(details.open&&!details.dataset.loaded)loadEvidence(details).catch(e=>{details.querySelector('.wn-evidence-body').textContent=e.message;});});
 }
 async function refresh(){
  const seq=++generation;loading=true;$('wn-orders').inert=true;$('wn-report').disabled=true;status('Loading saved Whatnot orders…');
  try{const r=await rpc('whatnot_queue_summary',{_view:view,_search:scannedTracking?'!scan:'+scannedTracking:$('wn-search').value.trim(),_filter:filter,_due:due,_purchase:$('wn-purchase').value||null,_sort:$('wn-sort').value,_buyer_history:$('wn-buyer-history').value,_offset:offset});
   if(seq!==generation)return;
   groups=r.groups;totalBuyers=r.buyers;
   $('wn-views').innerHTML=Object.entries(workflowViews).map(([v,label])=>`<button data-view="${v}" ${view===v?'aria-current="page"':''}>${label}<strong>${r.counts[v]||0}</strong></button>`).join('');
   $('wn-market-status').hidden=false;
   $('wn-market-views').innerHTML=Object.entries(marketViews).map(([v,label])=>`<button data-view="${v}" aria-pressed="${v===view}">${label} <strong>${r.market_counts?.[v]||0}</strong></button>`).join('');
   const pending=view==='pending'||view==='review'||view==='unfulfilled';
   $('wn-money-cards').hidden=!pending;$('wn-money-notes').hidden=!r.facets.shown?.lines;
   $('wn-filters').hidden=pending;
   if(pending)window.PendingQueueCards.render($('wn-money-cards'),r.facets,due,filter);
   else{
    const names={all:'All items',missing:'Item not found',watches:'Watches',missing_watch:'Missing watches',cgl:'Pending CGL',cancel:'Pending to cancel',no_tracking:'No tracking'};
    $('wn-filters').innerHTML=Object.entries(names).map(([k,label])=>`<button data-filter="${k}" aria-pressed="${filter===k}">${label}<span>${r.facets['work:'+k]?.lines||0}</span></button>`).join('');
   }
   const extra=[$('wn-purchase').value,$('wn-buyer-history').value!=='all',$('wn-sort').value!=='due'].filter(Boolean).length;
   $('wn-refine-count').textContent=extra?' · '+extra+' active':'';
   const filtered=$('wn-search').value.trim()||$('wn-purchase').value||$('wn-buyer-history').value!=='all'||due!=='all'||filter!=='all';
   $('wn-reset-filters').disabled=!filtered&&$('wn-sort').value==='due';
   const title=filtered?'Filtered totals':marketViews[view]?marketViews[view]+' on Whatnot':view==='closeout'?'Pending information to close':view==='history'?'History overview':view==='review'?'Review overview':view==='all'?'All order totals':'Queue overview';
   window.PendingQueueCards.shown($('wn-selection-totals'),r.facets.shown,{title,target:'wn-orders'});
   $('wn-orders').inert=false;$('wn-report').disabled=false;
   render();status(scannedTracking?(r.visible_lines?counted(r.visible_lines,'matching order line')+'. Check the full tracking number before taking the packing photo.':'No order lines match that tracking barcode.'):'');
  }catch(e){if(seq===generation){groups=[];totalBuyers=0;render();$('wn-market-status').hidden=true;for(const id of ['wn-money-cards','wn-selection-totals','wn-filters'])$(id).replaceChildren();status(e.message,true);}}finally{if(seq===generation)loading=false;}
 }
 async function filesFor(ids){const r=await db.from('whatnot_order_files').select('*').overlaps('line_ids',ids).order('created_at');if(r.error)throw Error(r.error.message);return r.data;}
 async function signed(file){const r=await db.storage.from('whatnot-order-evidence').createSignedUrl(file.path,1800);if(r.error)throw Error('Could not open this saved file.');return r.data.signedUrl;}
 async function loadEvidence(details){
  const id=details.dataset.evidence,body=details.querySelector('.wn-evidence-body');body.textContent='Loading…';
  const [files,ev]=await Promise.all([filesFor([id]),db.from('whatnot_order_events').select('*').eq('line_id',id).order('created_at',{ascending:false}).limit(100)]);if(ev.error)throw Error(ev.error.message);
  const images=await Promise.all(files.map(async f=>({...f,url:await signed(f)})));
  body.innerHTML=`<div class="wn-files">${images.map(f=>f.mime.startsWith('image/')?`<button data-photo="${E(f.url)}"><img src="${E(f.url)}" loading="lazy" alt="${E(f.kind.replaceAll('_',' '))}"><small>${E(f.kind.replaceAll('_',' '))} · ${E(f.actor_name)}<br>${E(M.time(f.created_at))}</small></button>`:`<div>${link(f.url,'Shipping-label PDF')}<small>${E(f.actor_name)} · ${E(M.time(f.created_at))}</small></div>`).join('')||'<p>No files saved yet.</p>'}</div>${ev.data.map(e=>`<div class="wn-event"><strong>${E(e.action.replaceAll('_',' '))}</strong>${e.details.note?'<br>'+E(e.details.note):''}${window.MarketplaceOrderNotes.photoButton(e.details.note_photo_path)}<small>${E(e.actor_name)} · ${E(M.time(e.created_at))}</small></div>`).join('')||'<p>No staff updates yet.</p>'}`;
  details.dataset.loaded='yes';
  window.MarketplaceOrderNotes.photoThumbnails(body);
 }
 function beginAction(kind,lines){
  if(!lines.length){status('Select the exact order lines first.',true);return;}
  notePhotos.clear();$('wn-note-photos').hidden=kind!=='note';
  action={kind,lines};const titles={complete:'Complete selected order lines',upload:'Attach evidence to selected items',note:'Add an internal note',watch_missing:'Mark selected watches missing',watch_found:'Mark selected watches found',cancel_pending:'Flag selected items for cancellation review',cancel_clear:'Clear internal cancellation mark',missing:'Mark selected items not found',found:'Mark selected items found',cgl:'Mark selected items Pending CGL',cgl_done:'Confirm CGL is ready',receipt:'Save this item’s receipt link',reopen:'Reopen selected items'};
  $('wn-action-title').textContent=titles[kind];$('wn-action-items').innerHTML=lines.map(l=>`<div class="wn-choice"><strong>Order #${E(l.order_id)} · ${E(l.title)}</strong><small>Qty ${l.quantity} · ${E(l.tracking_number||'No tracking')} · ${E(M.money(Number(l.unit_price)*l.quantity,l.currency))}</small></div>`).join('');
  $('wn-value-label').hidden=kind==='upload';$('wn-value-label').firstChild.textContent=kind==='receipt'?'Whatnot receipt / order URL':'Note';$('wn-value').value=kind==='receipt'?lines[0].receipt_url||'':'';
  $('wn-pack-photo').hidden=kind!=='complete';$('wn-pack-filename').textContent='';
  $('wn-pack-camera').value='';$('wn-pack-gallery').value='';
  $('wn-upload-fields').hidden=kind!=='upload';$('wn-files').value='';$('wn-confirm-label').hidden=!['complete','upload','cgl_done'].includes(kind);$('wn-confirm').checked=false;$('wn-action-error').textContent='';$('wn-action-submit').disabled=false;$('wn-action-dialog').showModal();
 }
 for(const id of ['wn-pack-camera','wn-pack-gallery'])$(id).onchange=()=>{
  if(!action||action.saving||!$(id).files.length)return;
  action.photo=$(id).files[0];action.photoAttached=false;action.photoPath=null;
  $(id==='wn-pack-camera'?'wn-pack-gallery':'wn-pack-camera').value='';
  $('wn-pack-filename').textContent='Selected: '+action.photo.name;
 };
 function validateFile(file,type){
  if(file.size>15*1024*1024)throw Error('Each file must be 15 MB or smaller.');
  if(type==='label'?file.type!=='application/pdf':!['image/jpeg','image/png','image/webp'].includes(file.type))throw Error(type==='label'?'Choose a PDF shipping label.':'Use a JPG, PNG or WebP packing photo.');
 }
 async function attachFile(file,type,lines,attempt){
  const ext=file.type==='application/pdf'?'pdf':file.type==='image/png'?'png':file.type==='image/webp'?'webp':'jpg';
  let path=attempt?.photoPath;
  if(!path){
   path=(await db.auth.getUser()).data.user.id+'/'+crypto.randomUUID()+'.'+ext;
   const uploaded=await db.storage.from('whatnot-order-evidence').upload(path,file,{contentType:file.type,upsert:false});
   if(uploaded.error)throw Error(uploaded.error.message);
   if(attempt)attempt.photoPath=path;
  }
  await rpc('attach_whatnot_file',{_path:path,_kind:type,_name:file.name.slice(0,200),_mime:file.type,_lines:M.snapshot(lines)});
 }
 async function submitAction(event){event.preventDefault();if(!action||action.saving)return;const attempt=action,{kind,lines}=attempt;attempt.saving=true;$('wn-action-submit').disabled=true;
  notePhotos.disable(true);$('wn-value').readOnly=true;
  try{
   if(['complete','upload','cgl_done'].includes(kind)&&!$('wn-confirm').checked)throw Error('Confirm the selected items and evidence first.');
   if(kind==='upload'){
    const files=[...$('wn-files').files],type=$('wn-kind').value;if(!files.length)throw Error('Choose at least one file.');if(files.length>20)throw Error('Choose up to 20 files at a time.');
    for(const f of files)validateFile(f,type);
    for(const f of files){$('wn-action-error').textContent='Saving '+f.name+'…';await attachFile(f,type,lines);}
   }else if(kind==='note'&&notePhotos.photo){
    $('wn-action-error').textContent='Saving note and photo…';
    await window.MarketplaceOrderNotes.savePhotoNote(notePhotos.photo,lines.map(l=>({order_id:l.order_id,line_id:l.id,revision:l.revision})),$('wn-value').value.trim());
   }else{
    if(kind==='complete'&&attempt.photo&&!attempt.photoAttached){
     validateFile(attempt.photo,'completion_photo');
     $('wn-action-error').textContent='Saving packing photo…';await attachFile(attempt.photo,'completion_photo',lines,attempt);attempt.photoAttached=true;
    }
    const snapshot=M.snapshot(lines);
    if(kind==='complete')snapshot.forEach((row,i)=>{row.verified_tracking_number=lines[i].tracking_number;});
    await rpc('whatnot_work_action',{_action:kind,_lines:snapshot,_value:$('wn-value').value.trim()||null});
   }
   $('wn-action-dialog').close();action=null;await refresh();status('Saved successfully. Only the selected order lines were updated.');
  }catch(e){$('wn-action-error').textContent=e.message;}finally{attempt.saving=false;$('wn-action-submit').disabled=false;notePhotos.disable(false);$('wn-value').readOnly=false;}
 }
 async function expandBuyer(g){
  const field=g.buyer_key.startsWith('order:')?'id':'buyer_id',value=field==='id'?g.lines[0].order_id:g.buyer_key;
  const orders=[];for(let start=0;;start+=500){const r=await db.from('whatnot_orders').select('*').eq(field,value).order('id').range(start,start+499);if(r.error)throw Error(r.error.message);orders.push(...r.data);if(r.data.length<500)break;}
  const lines=[];for(let i=0;i<orders.length;i+=100){const ids=orders.slice(i,i+100).map(o=>o.id);for(let start=0;;start+=500){const r=await db.from('whatnot_queue_lines').select('*').in('order_id',ids).order('id').range(start,start+499);if(r.error)throw Error(r.error.message);lines.push(...r.data);if(r.data.length<500)break;}}
  return lines.map(l=>{const order_record=orders.find(o=>o.id===l.order_id);return {...l,order_record,scope:M.scope(l,order_record)};});
 }
 async function report(lines,title){
  if(!lines.length)throw Error('There are no items to report.');
  const reportWindow=window.open('about:blank','_blank');if(!reportWindow)throw Error('Allow the report window to open.');reportWindow.document.write('<p>Preparing your Whatnot report…</p>');reportWindow.document.close();
  try{
   const files=[];for(let i=0;i<lines.length;i+=100)files.push(...await filesFor(lines.slice(i,i+100).map(l=>l.id)));
   const events=[];for(let i=0;i<lines.length;i+=100){for(let start=0;;start+=500){const r=await db.from('whatnot_order_events').select('*').in('line_id',lines.slice(i,i+100).map(l=>l.id)).order('created_at').range(start,start+499);if(r.error)throw Error(r.error.message);events.push(...r.data);if(r.data.length<500)break;}}
   const unique=[...new Map(files.map(f=>[f.id,f])).values()];const images=await Promise.all(unique.map(async f=>({...f,url:await signed(f)})));
   const buyers=[...new Set(lines.map(l=>l.order_record.buyer_id||'order:'+l.order_id))];
   const sections=buyers.map((buyer,idx)=>{const items=lines.filter(l=>(l.order_record.buyer_id||'order:'+l.order_id)===buyer),o=items[0].order_record;
    const orders=[...new Map(items.map(l=>[l.order_id,l.order_record])).values()];
    return `<section class="buyer" id="buyer-${idx}"><nav><a href="#directory">↑ Buyer directory</a> · <a href="#buyer-${idx}">${E(o.username||'Buyer')}</a></nav><header><span>BUYER ${String(idx+1).padStart(2,'0')}</span><h2>${E(o.username||'Buyer not supplied')}</h2><p>${E(o.customer_name||'Name not supplied')}</p><p>${items.length} order lines · ${items.reduce((n,l)=>n+l.quantity,0)} items · ${orders.length} orders</p></header><div class="index"><h3>Item index</h3>${items.map(l=>`<a href="#line-${l.id}"><strong>Order #${E(l.order_id)}</strong> · ${E(l.title)} · ${E(M.money(Number(l.unit_price)*l.quantity,l.currency))} · ${E(l.order_record.status)} · ${l.tracking_number?'Tracking attached':'No tracking'}${M.scope(l)!=='history'?' · '+E(M.deadline(l)):''}</a>`).join('')}</div>${items.map(l=>`<article id="line-${l.id}" class="item ${l.item_missing?'missing':''}"><nav><a href="#directory">↑ Directory</a> · <a href="#buyer-${idx}">↑ ${E(o.username||'Buyer')} index</a></nav><span>ORDER #${E(l.order_id)} / ITEM ${l.id}</span><h3>${E(l.title)}</h3><div class="stats"><div><small>Item value</small><strong>${E(M.money(Number(l.unit_price)*l.quantity,l.currency))}</strong>Qty ${l.quantity}</div><div><small>Whatnot</small><strong>${E(l.order_record.status.replaceAll('_',' '))}</strong>${E(l.work_state.replaceAll('_',' '))}</div><div><small>Purchased · Eastern</small><strong>${E(M.time(l.order_record.purchased_at))}</strong></div><div><small>Shipping deadline</small><strong>${E(M.deadline(l))}</strong>Seller-local due day</div></div>${l.item_missing?'<p class="urgent">ITEM NOT FOUND · Locate promptly to meet the shipment deadline.</p>':''}<p>Show: ${E(l.order_record.show_title||'Not provided')}</p><p>Tracking: ${link(M.tracking(l.tracking_number,l.carrier),l.tracking_number)||E(l.tracking_number||'Not yet assigned')} · ${E(l.shipment_status||'Status not supplied')}</p><p>${link(new URL('pending-whatnot-orders.html?view=all&search='+encodeURIComponent(l.order_id),location.href).href,'Invsto order')} ${link(M.url(l.order_record.url),'Whatnot order')} ${l.order_record.show_id?link(M.receipt(l),'Video receipt'):''} ${link(M.url(l.shipment_url),'Shipment / label')}</p><div class="photos">${images.filter(f=>f.line_ids.includes(l.id)).map(f=>f.mime.startsWith('image/')?`<figure><a href="${E(f.url)}" target="_blank"><img src="${E(f.url)}" alt="${E(f.kind.replaceAll('_',' '))}"></a><figcaption>${E(f.kind.replaceAll('_',' '))} · ${E(f.actor_name)} · ${E(M.time(f.created_at))}</figcaption></figure>`:`<p>${link(f.url,'Saved shipping-label PDF')}</p>`).join('')||'<p>No saved evidence photo yet.</p>'}</div>${events.filter(e=>e.line_id===l.id&&e.details.note).map(e=>`<p><strong>${E(e.action.replaceAll('_',' '))} · ${E(e.actor_name)} · ${E(M.time(e.created_at))}</strong><br>${E(e.details.note)}</p>`).join('')}</article>`).join('')}</section>`;
   });
   reportWindow.document.open();reportWindow.document.write(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${E(title)}</title><style>*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f5f3ec;color:#16382c;font:15px/1.6 system-ui}main{max-width:1180px;margin:auto;padding:36px}h1,h2{font-family:Georgia,serif;font-weight:400}h1{font-size:46px}h2{font-size:36px}a{color:#236454;text-underline-offset:3px}header{padding:22px 0}header span,article>span{color:#9b752d;font-weight:700;letter-spacing:2px;font-size:11px}.buyer{margin-top:38px}nav{padding:12px 0;font-size:12px}.index,.item{background:white;border:1px solid #d8e0d9;border-radius:16px;padding:26px;margin:20px 0}.index a{display:block;padding:10px 0;border-bottom:1px solid #e7ebe6}.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}.stats>div{background:#f1f5ef;padding:14px;border-radius:10px}.stats small,.stats strong{display:block}.stats small{color:#61756a}.stats strong{margin:6px 0}.photos{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px}.photos img{width:100%;height:330px;object-fit:contain}.photos figure{margin:10px 0;break-inside:avoid}.photos figcaption{font-size:11px;color:#61756a}.missing{border-left:5px solid #b7603f}.urgent{background:#fbede5;padding:12px;color:#974628}.tools{position:sticky;top:0;padding:12px;background:#17382c;display:flex;gap:20px}.tools button{padding:10px 20px;border:0;border-radius:8px;background:#ecd291;cursor:pointer}.tools a{color:white}@media(max-width:650px){main{padding:18px}h1{font-size:34px}.stats{grid-template-columns:repeat(2,1fr)}.photos{grid-template-columns:1fr}.index,.item{padding:18px}.photos img{height:280px}}@media print{@page{size:A4;margin:13mm}body{background:white;font-size:10pt}main{padding:0}.tools{display:none}.buyer{break-before:page}.item{break-inside:auto;border-radius:0;padding:16px;margin:14px 0}.stats{grid-template-columns:repeat(4,1fr);break-inside:avoid}.photos img{height:65mm}.photos{grid-template-columns:repeat(2,minmax(0,1fr))}h3,nav{break-after:avoid}a{overflow-wrap:anywhere}*{print-color-adjust:exact;-webkit-print-color-adjust:exact}}</style></head><body><div class="tools"><button onclick="window.print()">Print / Save PDF</button><a href="#directory">Buyer directory</a></div><main><header id="directory"><span>INVSTO / WHATNOT</span><h1>${E(title)}</h1><p>Generated ${E(M.time(new Date().toISOString()))} · ${lines.length} order lines · ${buyers.length} buyers</p><p>Item values are shown separately from buyer-paid shipping and tax. Refund amounts are not supplied by the order API; a cancelled status is not presented as a confirmed refund.</p></header><div class="index">${buyers.map((b,i)=>{const ls=lines.filter(l=>(l.order_record.buyer_id||'order:'+l.order_id)===b);return `<a href="#buyer-${i}"><strong>${E(ls[0].order_record.username||'Buyer not supplied')}</strong> · ${E(ls[0].order_record.customer_name||'')} · ${ls.length} order lines</a>`;}).join('')}</div>${sections.join('')}</main></body></html>`);reportWindow.document.close();
  }catch(e){reportWindow.document.body.textContent=e.message;throw e;}
 }
 async function start(){
  db=window.supabaseClient;window.MarketplaceOrderNotes?.bind('whatnot',db);const auth=await db.auth.getUser();$('wn-search').value=new URLSearchParams(location.search).get('search')||'';if(!auth.data.user){status('Sign in to Invsto to open Whatnot orders.',true);const a=document.createElement('a');a.href='index.html';a.textContent=' Sign in';$('wn-status').append(a);return;}
  if(!await rpc('can_manage_inventory',{}))throw Error('Inventory staff access required.');
  await Promise.all([refresh(),loadConnection()]);
  setInterval(()=>{if(!document.hidden)loadConnection().catch(e=>status(e.message,true));},60000);
 }
 document.addEventListener('whatnot-item-photo-saved',async e=>{
  if(!db)return;
  const selectedIds=new Set([...document.querySelectorAll('[data-select-line]:checked')].map(input=>input.dataset.selectLine));
  await refresh();
  for(const input of document.querySelectorAll('[data-select-line]'))if(selectedIds.has(input.dataset.selectLine))input.checked=true;
  if(!$('wn-status').classList.contains('wn-error'))status(e.detail);
 });
 $('wn-refresh').onclick=()=>Promise.all([refresh(),loadConnection()]).catch(e=>status(e.message,true));
 $('wn-sync').onclick=async()=>{try{await api('sync');await loadConnection();status('Sync queued. Reload saved orders after the update finishes.');}catch(e){status(e.message,true);}};
 $('wn-full-sync').onclick=async()=>{try{await api('full_sync');await loadConnection();status('Full history reconciliation queued.');}catch(e){status(e.message,true);}};
 $('wn-pause').onclick=async()=>{try{await api(connection?.enabled?'pause':'resume');await loadConnection();}catch(e){status(e.message,true);}};
 $('wn-connect').onclick=()=>{$('wn-token').value='';$('wn-connect-dialog').showModal();};
 $('wn-connect-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;try{const token=$('wn-token').value.trim();await api('connect',{token,expiresAt:$('wn-expires').value||null});$('wn-token').value='';$('wn-connect-dialog').close();await loadConnection();await refresh();}catch(e){$('wn-connect-error').textContent=e.message;}finally{button.disabled=false;}};
 $('wn-connect-dialog').addEventListener('close',()=>{$('wn-token').value='';});
 $('wn-action-dialog').addEventListener('cancel',e=>{if(action?.saving)e.preventDefault();});
 $('wn-action-form').onsubmit=submitAction;
 let searchTimer;$('wn-search').addEventListener('input',()=>{scannedTracking=null;clearTimeout(searchTimer);searchTimer=setTimeout(()=>{offset=0;refresh();},300);});
 $('wn-search').addEventListener('change',()=>{clearTimeout(searchTimer);offset=0;refresh();});
 $('wn-find-package').onclick=()=>{
  clearTimeout(searchTimer);const code=window.OGTrackingSearch.normalize($('wn-search').value);
  if(!/^[a-z0-9]{6,128}$/.test(code)){status('Scan the shipping tracking barcode again, or enter the printed tracking number.',true);return;}
  scannedTracking=code;view='all';offset=0;filter='all';due='all';$('wn-purchase').value='';$('wn-buyer-history').value='all';
  const url=new URL(location.href);url.searchParams.set('view',view);history.replaceState(null,'',url);
  refresh();
 };
 for(const id of ['wn-sort','wn-purchase','wn-buyer-history'])$(id).onchange=()=>{offset=0;refresh();};
 $('wn-reset-filters').onclick=()=>{scannedTracking=null;filter='all';due='all';offset=0;$('wn-purchase').value='';$('wn-search').value='';$('wn-sort').value='due';$('wn-buyer-history').value='all';refresh();};
 $('wn-prev').onclick=()=>{offset=Math.max(0,offset-40);refresh();};$('wn-next').onclick=()=>{offset+=40;refresh();};
 $('wn-report').onclick=()=>report(allLines(),'Whatnot order review · displayed buyers').catch(e=>status(e.message,true));
 document.addEventListener('click',async event=>{
  const close=event.target.closest('[data-close]');if(close){if(close.dataset.close!=='wn-action-dialog'||!action?.saving)$(close.dataset.close).close();return;}
  const v=event.target.closest('[data-view]');if(v){view=v.dataset.view;offset=0;filter='all';due='all';const url=new URL(location.href);url.searchParams.set('view',view);history.replaceState(null,'',url);refresh();return;}
  const card=event.target.closest('[data-mq-key]');if(card){const key=card.dataset.mqKey;if(card.dataset.mqType==='due')due=due===key?'all':key;else filter=filter===key?'all':key;offset=0;refresh();return;}
  const f=event.target.closest('[data-filter]');if(f){filter=f.dataset.filter;offset=0;refresh();return;}
  const photo=event.target.closest('[data-photo]');if(photo){$('wn-expanded-photo').src=photo.dataset.photo;$('wn-photo-dialog').showModal();return;}
  const one=event.target.closest('[data-line-action]');if(one){beginAction(one.dataset.lineAction,allLines().filter(l=>l.id===one.dataset.line));return;}
  const button=event.target.closest('[data-group-action]');if(!button)return;const g=groups.find(g=>g.buyer_key===button.closest('[data-buyer]').dataset.buyer),kind=button.dataset.groupAction;
  try{if(kind==='select'){const nodes=button.closest('[data-buyer]').querySelectorAll('[data-select-line]'),checked=[...nodes].every(n=>n.checked);for(const n of nodes)n.checked=!checked;return;}
   if(kind==='expand'){if(g.matched){g.lines=g.matched;delete g.matched;}else{button.disabled=true;const expanded=await expandBuyer(g);if(!groups.includes(g))return;g.matched=g.lines;g.lines=expanded.filter(l=>l.queue_views.includes(view));}render();return;}
   if(kind==='report'){await report(g.lines,`${g.buyer} · Whatnot items in this view`);return;}
   if(kind==='full_report'){await report(await expandBuyer(g),`${g.buyer} · Full Whatnot purchase history`);return;}
   beginAction(kind,selected(g));
  }catch(e){status(e.message,true);button.disabled=false;}
 });
 if(window.supabaseClient)start().catch(e=>status(e.message,true));else document.addEventListener('supabase-ready',()=>start().catch(e=>status(e.message,true)),{once:true});
})();
