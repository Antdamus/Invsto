(function boot(){
 'use strict';
 if(!window.supabase?.auth){document.addEventListener('supabase-ready',boot,{once:true});document.addEventListener('supabase-init-error',event=>{document.getElementById('tk-status').textContent=event.detail?.message||'Could not connect. Refresh and try again.';},{once:true});return;}
 const $=id=>document.getElementById(id), db=window.supabase, adapter=window.TikTokOrderImport, queue=window.TikTokOrderQueue;
 let historyView=new URLSearchParams(location.search).get('view')==='history';
 const state={user:null,orders:[],photos:[],preview:null,transferId:null,busy:false,detail:null,loadSequence:0,due:'all',expanded:new Set(),labelBuyers:new Set()};
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const stages={pending:'Pending',preparing:'Preparing',waiting:'Waiting',packed:'Packed',dispatched:'Dispatched',completed:'Completed'};
 const sha=async value=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',value)),b=>b.toString(16).padStart(2,'0')).join('');
 const date=v=>v?new Date(v).toLocaleString():'—';
 const closed=queue.closed;
 const money=v=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD'}).format(v);
 const placed=g=>g.created?new Intl.DateTimeFormat('en-US',{month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZone:'UTC'}).format(new Date(g.created)):'Unavailable in export';
 const receiptAction=g=>g.orders.length===1?`<a class="tk-card-button" href="${adapter.orderUrl(g.orders[0].order_number,true)}" target="_blank" rel="noopener">Open video receipt</a>`:`<button type="button" class="tk-card-button" data-buyer-tool="receipts" data-buyer="${esc(g.key)}">Open video receipts</button>`;
 function marketplaceNavigation(){for(const nav of document.querySelectorAll('.nav-links,.mobile-nav-links')){for(const a of nav.querySelectorAll('a')){const href=a.getAttribute('href');if(href==='pending-orders.html')a.href='pending-tiktok-orders.html';if(href==='ebay-order-history.html')a.href='pending-tiktok-orders.html?view=history';if(a.getAttribute('href')?.startsWith('pending-tiktok-orders.html')){a.classList.toggle('active',a.getAttribute('href')===(historyView?'pending-tiktok-orders.html?view=history':'pending-tiktok-orders.html'));a.title=a.getAttribute('href').includes('history')?'TikTok order history':'TikTok pending orders';}}}}
 marketplaceNavigation();for(const nav of document.querySelectorAll('.nav-links,.mobile-nav-links'))new MutationObserver(marketplaceNavigation).observe(nav,{childList:true});
 function status(message,error=false){$('tk-status').textContent=message;$('tk-status').dataset.error=String(error);}
 async function rpc(name,args){const {data,error}=await db.rpc(name,args);if(error)throw error;return data;}
 function message(error){return /tiktok_.*(does not exist|schema cache)|Could not find.*tiktok/i.test(error.message||'')?'TikTok setup has not been activated on the server yet. Your CSV is not imported.':error.message||String(error);}
 async function busy(fn){if(state.busy)return;state.busy=true;try{return await fn();}catch(e){if(e.cancelled)return;status(message(e),true);const el=$('tk-buyer-tools').open?$('tk-buyer-tools-status'):$('tk-detail-status');if(el)el.textContent=message(e);}finally{state.busy=false;}}
 async function rows(query){let result=[];for(let from=0;from<25000;from+=500){const {data,error}=await query().range(from,from+499);if(error)throw error;result.push(...data);if(data.length<500)return result;}throw Error('This view exceeds 25,000 records. Contact an administrator to archive older records.');}
 async function refresh(){
  const seq=++state.loadSequence;
  const orders=await rows(()=>db.from('tiktok_orders').select('*').order('order_number'));
  const lines=[],documents=[];for(let i=0;i<orders.length;i+=100){const ids=orders.slice(i,i+100).map(o=>o.id);const [batchLines,batchDocuments]=await Promise.all([rows(()=>db.from('tiktok_order_lines').select('*').in('order_id',ids).order('id')),rows(()=>db.from('tiktok_order_documents').select('*').in('order_id',ids).order('id'))]);lines.push(...batchLines);documents.push(...batchDocuments);}
  if(seq!==state.loadSequence)return;
  const grouped=new Map();for(const line of lines){if(!grouped.has(line.order_id))grouped.set(line.order_id,[]);grouped.get(line.order_id).push(line);}
  const photos=[];for(let i=0;i<lines.length;i+=100)photos.push(...await rows(()=>db.from('tiktok_order_receipt_photos').select('*').in('line_id',lines.slice(i,i+100).map(l=>l.id)).order('created_at',{ascending:false})));
  if(window.TikTokInventory){for(let i=0;i<lines.length;i+=100){const links=await rows(()=>db.from('tiktok_inventory_attachments').select('*').in('line_id',lines.slice(i,i+100).map(l=>l.id)).order('line_id'));for(const link of links){const line=lines.find(l=>l.id===link.line_id);if(line)line.inventory=link;}}}
  if(window.TikTokWork){
   for(let i=0;i<lines.length;i+=100){const work=await rows(()=>db.from('tiktok_line_work').select('*').in('line_id',lines.slice(i,i+100).map(l=>l.id)).order('line_id'));for(const w of work){const line=lines.find(l=>l.id===w.line_id);if(line)line.work=w;}}
   for(let i=0;i<orders.length;i+=100){const cancellations=await rows(()=>db.from('tiktok_order_cancellations').select('*').in('order_id',orders.slice(i,i+100).map(o=>o.id)).order('order_id'));for(const c of cancellations){const o=orders.find(o=>o.id===c.order_id);if(o)o.cancellation=c;}}
  }
  if(seq!==state.loadSequence)return;state.photos=photos;
  state.orders=orders.map(o=>({...o,lines:grouped.get(o.id)||[],documents:documents.filter(d=>d.order_id===o.id)}));render();
  const {data,error}=await db.from('tiktok_order_imports').select('filename,imported_at,snapshot_at,result').order('imported_at',{ascending:false}).limit(1);
  if(error)throw error;
  const last=data?.[0];$('tk-last-import').textContent=last?'Last import '+date(last.imported_at):'No imports yet';
  status(last?`Latest export: ${date(last.snapshot_at)}. Imports are snapshots; refresh from TikTok to update shipping status.`:'Import your first TikTok export to begin.');
 }
 function groups(){return queue.select(state.orders,{history:historyView,term:$('tk-search').value,stage:$('tk-stage-filter').value,work:$('tk-work-filter').value,due:state.due,purchase:$('tk-purchase-date').value,sort:$('tk-sort').value});}
 function filtered(){return groups().flatMap(g=>g.orders);}
 function toggleBuyer(key){if(state.expanded.has(key))state.expanded.delete(key);else state.expanded.add(key);render();}
 function createLabelButton(key){
  if(historyView)return '';
  const orders=window.TikTokShipping.buyerOrders(state.orders,key);if(!orders.length)return '';
  return `<button type="button" class="tk-card-button tk-label-create" data-create-labels="${esc(key)}">${esc(window.TikTokShipping.actionLabel(orders))}</button>`;
 }
 function updateLabelSelection(){
  const visible=new Set(groups().filter(g=>window.TikTokShipping.buyerOrders(state.orders,g.key).length).map(g=>g.key));
  for(const key of state.labelBuyers)if(!visible.has(key))state.labelBuyers.delete(key);
  const count=[...state.labelBuyers].reduce((n,key)=>n+window.TikTokShipping.buyerOrders(state.orders,key).length,0);
  $('tk-label-batch').hidden=historyView;
  $('tk-create-labels').disabled=!count;$('tk-create-labels').textContent=`Create / get shipping labels${count?' ('+count+')':''}`;
  $('tk-label-selection').textContent=count?`${state.labelBuyers.size} buyers · ${count} orders selected`:'Select buyers for a bulk label batch (up to 50 orders).';
  for(const box of $('tk-orders').querySelectorAll('[data-label-buyer]'))box.checked=state.labelBuyers.has(box.dataset.labelBuyer);
 }
 function shippingExtension(){return new Promise(resolve=>{
  const requestId=crypto.randomUUID();let timer;
  const listener=e=>{if(e.source!==window||e.origin!==location.origin||e.data?.type!=='OG_EBAY_EXTENSION_VERSION_RESPONSE'||e.data.requestId!==requestId)return;clearTimeout(timer);window.removeEventListener('message',listener);const parts=String(e.data.version||'').split('.').map(Number);resolve(parts[0]>1||(parts[0]===1&&(parts[1]>0||(parts[1]===0&&parts[2]>=20))));};
  window.addEventListener('message',listener);timer=setTimeout(()=>{window.removeEventListener('message',listener);resolve(false);},2000);
  window.postMessage({type:'OG_EBAY_EXTENSION_VERSION_REQUEST',requestId},location.origin);
 });}
 async function openLabels(keys){
  let request;try{request=window.TikTokShipping.request(state.orders,keys);}catch(e){status(e.message,true);return;}
  const tab=window.open('about:blank','_blank');if(!tab){status('Allow popups, then click the shipping label button again.',true);return;}tab.opener=null;
  if(!await shippingExtension()){tab.close();$('extension-updates').open=true;$('extension-updates').scrollIntoView({block:'center'});status('Update OG eBay Order Link to v1.0.20 or newer, refresh TikTok and OG, then open the labels.',true);return;}
  tab.location.replace(request.url);status(`Checking ${request.ids.length} TikTok order(s) across ${request.buyers} buyer(s). TikTok opens shipment review for new labels or Print documents for existing labels. Choose Print through OG, then review and save the returned labels here.`);
 }
 function revealCapture(id,lineId,transferId){
  const order=state.orders.find(o=>o.id===id);if(!order)return;
  if(!state.photos.some(p=>p.transfer_id===transferId&&!p.removed_at))throw Error('This capture is no longer on the order. Take a new capture in TikTok.');
  if(closed(order)!==historyView){
   historyView=closed(order);const url=new URL(location.href);
   if(historyView)url.searchParams.set('view','history');else url.searchParams.delete('view');
   history.replaceState(null,'',url);updateView();marketplaceNavigation();
  }
  // A saved capture must stay visible even when the queue was filtered to another buyer.
  if(!filtered().some(o=>o.id===id)){$('tk-search').value='';$('tk-stage-filter').value='';$('tk-work-filter').value='';$('tk-purchase-date').value='';state.due='all';}
  state.expanded.add(order.buyer_username.toLowerCase());
  for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();
  render();
  const slot=$('tk-orders').querySelector('[data-tk-photo-line="'+lineId+'"]'),line=slot?.closest('.tk-order-item');
  if(!line)return;
  line.classList.add('tk-capture-saved');line.tabIndex=-1;
  const notice=document.createElement('span');notice.className='tk-capture-confirmation';notice.setAttribute('role','status');notice.textContent='✓ Capture saved';slot.before(notice);
  line.scrollIntoView({block:'center'});line.focus({preventScroll:true});
 }
 function dueBadge(order){const u=queue.urgency(order.ship_by_date);return `<span class="tk-date ${u.level}">${esc(historyView?'Ship '+queue.shortDate(order.ship_by_date):u.label)}</span>`;}
 const cardIcon=name=>`<svg class="tk-card-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{chevron:'<path d="m6 9 6 6 6-6"/>',phone:'<rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/>',check:'<path d="m5 12 4 4L19 6"/>',tools:'<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',play:'<path d="m9 5 11 7-11 7z"/>'}[name]||''}</svg>`;
 function itemRow(l,o){
  return `<div class="tk-order-item">
   <div class="tk-item-media"><span class="tk-section-label">Receipt capture</span>${window.TikTokReceiptPhotos.placeholder(l)}<a class="tk-line-receipt-link" href="${adapter.orderUrl(o.order_number,true,l.sku_id)}" target="_blank" rel="noopener">${cardIcon('play')}<span>Open item video receipt</span></a></div>
   <div class="tk-item-content"><div class="tk-item-title"><div><h4>${esc(l.title)}</h4><p>Seller SKU ${esc(l.seller_sku||'—')}${l.variation?' · '+esc(l.variation):''}</p></div><span class="tk-item-quantity">Qty <strong>${l.quantity}</strong></span></div>
    <div class="tk-item-task-actions"><button type="button" class="tk-card-button tk-create-task" data-tk-task-order="${esc(o.id)}" data-tk-task-line="${esc(l.id)}">Create task</button>${historyView?'':`<button type="button" class="tk-card-button tk-complete-button" data-tk-line-finish="${esc(o.id)}">Complete order</button>`}</div>
    ${window.TikTokWork?.line(l,o)||''}${window.TikTokInventory?.button(l)||''}
    <details class="tk-item-identifiers"><summary>SKU &amp; shipping details</summary><dl><div><dt>SKU ID</dt><dd>${esc(l.sku_id||'Unavailable')}</dd></div><div><dt>Package</dt><dd>${esc(l.package_id||'Not assigned')}</dd></div><div><dt>Tracking</dt><dd>${esc(l.tracking_number||'Not available yet')}</dd></div></dl></details>
   </div></div>`;
 }
 function orderRow(o){
  const labels=o.documents.filter(d=>d.kind==='label');
  return `<article class="tk-order-row" data-tiktok-order="${esc(o.id)}">
   <header class="tk-order-heading"><div class="tk-order-identity"><span class="tk-section-label">Order</span><strong>${esc(o.order_number)}</strong><span class="tk-stage ${esc(o.stage)}">${esc(stages[o.stage])}</span></div><div class="tk-order-deadline">${dueBadge(o)}<button type="button" class="tk-text-action" data-order="${esc(o.id)}" data-section="preparation">${o.ship_by_date?'Edit ship-by date':'Add ship-by date'}</button></div></header>
   <div class="tk-order-task-actions"><button type="button" class="tk-card-button tk-create-task" data-tk-task-order="${esc(o.id)}">Create order task</button></div>
   <div class="tk-order-items">${o.lines.map(l=>itemRow(l,o)).join('')}</div>
   <footer class="tk-order-footer"><div class="tk-order-links"><button type="button" class="tk-card-button" data-order="${esc(o.id)}">Open order</button><button type="button" class="tk-text-action" data-order="${esc(o.id)}" data-section="labels">Shipping labels${labels.length?' · '+labels.length:''}</button>${window.TikTokReversal?.button(o)||''}${window.TikTokCancellations?.button(o)||''}<span class="tk-market-status">${esc(o.marketplace_substatus||o.marketplace_status)}</span></div><div class="tk-order-cancel">${window.TikTokWork?.cancellation(o)||''}</div></footer>
   ${o.cancel_return?'<p class="tk-warning">Cancellation / return review required</p>':''}${o.notes?`<p class="tk-note">${esc(o.notes)}</p>`:''}
  </article>`;
 }
 function buyerCard(g,index){
  const open=state.expanded.has(g.key),u=g.urgency,urgencyClass=historyView?'':u.level==='today'?'is-due-today':u.level==='tomorrow'?'is-due-tomorrow':u.level==='overdue'?'is-overdue':'';
  const nickname=g.orders[0].buyer_nickname,canLabel=!historyView&&window.TikTokShipping.buyerOrders(state.orders,g.key).length;
  return `<section class="tk-buyer buyer-order-card ${open?'is-expanded':'is-collapsed'} ${urgencyClass} ${index%2?'is-alt-group':''}" data-buyer-key="${esc(g.key)}">
   <div class="tk-buyer-header"><div class="tk-buyer-identity">${canLabel?`<label class="tk-label-select"><input type="checkbox" data-label-buyer="${esc(g.key)}" aria-label="Select ${esc(g.buyer)} for shipping labels"><span class="tk-sr-only">Select for labels</span></label>`:''}<span class="tk-buyer-avatar" aria-hidden="true">${esc(g.buyer.slice(0,2).toUpperCase())}</span><div class="tk-buyer-name"><button type="button" class="buyer-card-buyer-name" data-expand="${esc(g.key)}" aria-expanded="${open}" aria-controls="tk-lines-${index}">${esc(g.buyer)}</button><span class="buyer-card-compact-count">${g.orders.length} ${g.orders.length===1?'order':'orders'} · ${g.quantity} ${g.quantity===1?'item':'items'}${nickname&&nickname.toLowerCase()!==g.buyer.toLowerCase()?' · '+esc(nickname):''}</span></div></div>
    <div class="tk-buyer-overview">${historyView?'':`<span class="tk-buyer-due tk-date ${u.level}">${esc(u.label)}</span>`}${g.waiting?`<span class="tk-stage waiting">${g.waiting} waiting</span>`:''}<span class="buyer-card-value">${money(g.total)}</span><button type="button" class="tk-card-button tk-expand-button" data-expand="${esc(g.key)}" aria-expanded="${open}" aria-controls="tk-lines-${index}"><span>${open?'Hide':'Open'}</span>${cardIcon('chevron')}</button></div></div>
   <div class="buyer-card-meta tk-buyer-meta"><span>Placed ${esc(placed(g))}</span><button type="button" class="tk-text-action" data-buyer-tool="dates" data-buyer="${esc(g.key)}">${g.shipBy?'Ship by '+esc(queue.shortDate(g.shipBy)):'Set shipping date'}${g.unknown&&g.shipBy?` · ${g.unknown} dates needed`:''}</button><span class="${g.labelCount?'tk-label-saved':'tk-label-missing'}">${g.labelCount?`${g.labelCount}/${g.orders.length} orders with labels`:'No labels saved'}</span>${window.TikTokWork?.summary(g)||''}</div>
   <div class="tk-buyer-workflow"><div class="tk-workflow-group"><span class="tk-section-label">Tasks</span><div><button type="button" class="tk-card-button tk-create-task" data-tk-task-buyer="${esc(g.key)}">Create task</button></div></div><div class="tk-workflow-group"><span class="tk-section-label">Shipping</span><div>${createLabelButton(g.key)}<button type="button" class="tk-card-button" data-buyer-tool="labels" data-buyer="${esc(g.key)}">Shipping labels</button></div></div><div class="tk-workflow-group tk-packing-actions"><span class="tk-section-label">${historyView?'Order evidence':'Packing'}</span><div><button type="button" class="tk-card-button" data-tiktok-phone="${esc(g.key)}">${cardIcon('phone')}Use my phone</button><button type="button" class="tk-card-button tk-complete-button" data-tiktok-finish="${esc(g.key)}">${cardIcon('check')}${historyView?'Completion photos':'Complete order'}</button></div></div>
    <details class="tk-card-tools"><summary>${cardIcon('tools')}<span>Order tools</span></summary><div class="tk-tools-list">${receiptAction(g)}<button type="button" data-buyer-packet="${esc(g.key)}">Buyer packet PDF</button><button type="button" data-buyer-tool="dates" data-buyer="${esc(g.key)}">Shipping dates</button><button type="button" data-buyer-tool="preparation" data-buyer="${esc(g.key)}">Preparation &amp; notes</button></div></details>
   </div>
   ${open?`<div class="buyer-card-expanded" id="tk-lines-${index}"><div class="tk-items-heading"><h3>${historyView?'Order items':'Items to prepare'}</h3><span>${g.lines.length} ${g.lines.length===1?'line':'lines'}</span></div><div class="buyer-line-list">${g.orders.map(orderRow).join('')}</div></div>`:`<div id="tk-lines-${index}" hidden></div>`}
  </section>`;
 }
 function render(){
  $('tk-clear-purchase-date').hidden=!$('tk-purchase-date').value;
  const all=queue.group(state.orders.filter(o=>closed(o)===historyView)),visible=groups(),list=visible.flatMap(g=>g.orders);
  const total=all.reduce((n,g)=>n+g.orders.length,0),items=all.reduce((n,g)=>n+g.quantity,0),unknown=all.reduce((n,g)=>n+g.unknown,0);
  const tile=(title,count,help,filter='',tone='')=>`<div class="summary-urgency ${tone}"><button type="button" class="tk-summary-button" ${filter?`data-tk-due="${filter}" aria-pressed="${state.due===filter}"`:''}><span>${title}</span><strong>${count}</strong><small>${help}</small></button></div>`;
  $('tk-summary').innerHTML=tile(historyView?'TikTok history':'Open queue',`${total} orders`,`${items} items · ${all.length} buyer groups`,'all')+(historyView?tile('Buyers',all.length,'TikTok only')+tile('Items',items,'Saved order items'):['overdue','today','tomorrow'].map((level,i)=>{const g=all.filter(g=>g.urgency.level===level);return tile(['Overdue','Due today','Due tomorrow'][i],`${g.length} groups`,`${g.reduce((n,g)=>n+g.orders.length,0)} orders · ${g.filter(g=>g.waiting).length} waiting`,level,'is-'+level);}).join('')+tile('Date needed',`${unknown} orders`,'Verify the ship-by date in TikTok','unknown','is-unknown'))+tile('Waiting',`${all.filter(g=>g.waiting).length} groups`,`${all.reduce((n,g)=>n+g.waiting,0)} orders`);
  $('tk-deadline-help').textContent=historyView?'Historical TikTok orders and their saved documents stay in this workflow.':unknown?`${unknown} orders need a verified ship-by date. TikTok’s CSV omits deadlines. Open Shipping dates on a buyer card to check and save them; unverified dates are not counted as overdue.`:'Deadlines are verified calendar dates from TikTok or staff. Overdue starts on the next calendar day in America/New_York.';
  $('tk-queue-count').textContent=`${list.length} orders · ${visible.length} buyers · ${visible.reduce((n,g)=>n+g.quantity,0)} items`;
  document.querySelectorAll('[data-tk-due]').forEach(b=>{b.setAttribute('aria-pressed',String(state.due===b.dataset.tkDue));b.onclick=()=>{state.due=b.dataset.tkDue;render();};});
  const waitingButton=$('tk-summary').lastElementChild.querySelector('button');waitingButton.setAttribute('aria-pressed',String($('tk-work-filter').value==='waiting'));waitingButton.onclick=()=>{$('tk-work-filter').value=$('tk-work-filter').value==='waiting'?'':'waiting';state.due='all';render();};
  $('tk-orders').innerHTML=visible.length?visible.map(buyerCard).join(''):`<div class="tk-empty">${state.orders.length?'No TikTok orders match this view.':'No TikTok orders imported yet.'}</div>`;
  $('tk-orders').querySelectorAll('[data-expand]').forEach(b=>b.onclick=()=>toggleBuyer(b.dataset.expand));
  $('tk-orders').querySelectorAll('[data-buyer-key]').forEach(card=>card.onclick=event=>{
   if(event.target.closest('button,a,input,label,select,textarea,[contenteditable],details,summary,.tk-buyer-workflow,.buyer-card-expanded'))return;
   toggleBuyer(card.dataset.buyerKey);
  });
  window.TikTokReceiptPhotos.hydrate($('tk-orders'),db,state.photos);
  bindOrderButtons($('tk-orders'));
  $('tk-orders').querySelectorAll('[data-create-labels]').forEach(b=>b.onclick=()=>busy(()=>openLabels([b.dataset.createLabels])));
  $('tk-orders').querySelectorAll('[data-label-buyer]').forEach(b=>b.onchange=()=>{if(b.checked)state.labelBuyers.add(b.dataset.labelBuyer);else state.labelBuyers.delete(b.dataset.labelBuyer);updateLabelSelection();});
  updateLabelSelection();
  $('tk-orders').querySelectorAll('[data-tiktok-finish]').forEach(b=>b.onclick=()=>window.TikTokFulfillment.open(state.orders.filter(o=>o.buyer_username.toLowerCase()===b.dataset.tiktokFinish&&closed(o)===historyView)));
  bindLineCompletion($('tk-orders'));
  $('tk-orders').querySelectorAll('[data-tiktok-phone]').forEach(b=>b.onclick=()=>window.TikTokFulfillment.phone(state.orders.filter(o=>o.buyer_username.toLowerCase()===b.dataset.tiktokPhone&&closed(o)===historyView)));
  $('tk-orders').querySelectorAll('[data-buyer-tool]').forEach(b=>b.onclick=()=>busy(()=>buyerTools(b.dataset.buyer,b.dataset.buyerTool)));
  $('tk-orders').querySelectorAll('[data-buyer-packet]').forEach(b=>b.onclick=()=>busy(()=>packet(list.filter(o=>o.buyer_username.toLowerCase()===b.dataset.buyerPacket))));
 }
 $('tk-purchase-date').onchange=render;
 $('tk-clear-purchase-date').onclick=()=>{$('tk-purchase-date').value='';render();};
 $('tk-sync-orders').onclick=()=>{$('tk-import').open=true;$('tk-import').scrollIntoView({block:'start'});};
 $('tk-create-labels').onclick=()=>busy(()=>openLabels([...state.labelBuyers]));
 $('tk-select-labels').onclick=()=>{for(const g of groups())if(window.TikTokShipping.buyerOrders(state.orders,g.key).length)state.labelBuyers.add(g.key);updateLabelSelection();};
 $('tk-clear-labels').onclick=()=>{state.labelBuyers.clear();updateLabelSelection();};
 function bindLineCompletion(root){root.querySelectorAll('[data-tk-line-finish]').forEach(b=>b.onclick=()=>{const order=state.orders.find(o=>o.id===b.dataset.tkLineFinish);if(order){if($('tk-detail').open)$('tk-detail').close();window.TikTokFulfillment.open(state.orders.filter(o=>o.buyer_username.toLowerCase()===order.buyer_username.toLowerCase()&&closed(o)===historyView));}});}
 function bindOrderButtons(root){root.querySelectorAll('[data-order]').forEach(b=>b.onclick=()=>busy(async()=>{if($('tk-buyer-tools').open)$('tk-buyer-tools').close();await detail(b.dataset.order,b.dataset.section);}));}
 async function previewDocument(d){const {data,error}=await db.storage.from('ebay-labels').createSignedUrl(d.path,120);if(error)throw error;const a=document.createElement('a');a.href=data.signedUrl;a.target='_blank';a.rel='noopener';a.click();}
 async function buyerTools(key,tool){
  const orders=state.orders.filter(o=>o.buyer_username.toLowerCase()===key&&closed(o)===historyView);if(!orders.length)return;
  const title={receipts:'Video receipts',labels:'Shipping labels',dates:'Shipping dates',preparation:'Preparation & notes'}[tool];
  const help={receipts:'Open the full receipt on the matching TikTok order. TikTok may ask you to sign in.',labels:'Check each order’s saved PDF and tracking before printing. Add labels to the order they cover.',dates:'TikTok’s CSV does not include ship-by dates. Open the TikTok order, verify its deadline, then save that date here.',preparation:'Open an order to update its stage, waiting reason, and notes.'}[tool];
  $('tk-buyer-tools-body').innerHTML=`<p class="tk-eyebrow">TIKTOK · ${esc(orders[0].buyer_username)}</p><h2 id="tk-buyer-tools-title">${title}</h2><p class="tk-help">${help}</p>${orders.map(o=>`<section><h3>Order ${esc(o.order_number)}</h3><p>${o.lines.map(l=>`${l.quantity} × ${esc(l.title)} · SKU ${esc(l.seller_sku||l.sku_id)}`).join('<br>')}</p>${tool==='labels'?`<p class="tk-help">Tracking: ${esc(o.lines.map(l=>l.tracking_number).filter(Boolean).join(', ')||'Not available in the latest export')}</p>${o.documents.filter(d=>d.kind==='label').map(d=>`<div class="tk-doc"><span>${esc(d.filename)}<small> · ${esc(date(d.created_at))}</small></span><button type="button" data-preview-label="${esc(d.id)}">Preview label</button><button type="button" data-print-label="${esc(d.id)}">Print shipping label</button></div>`).join('')||'<p class="tk-muted">No shipping labels saved for this order.</p>'}`:''}${tool==='dates'?`<p>${dueBadge(o)} · ${queue.shortDate(o.ship_by_date)}</p>`:''}<div class="tk-actions">${tool==='receipts'?`<a class="tk-action" href="${adapter.orderUrl(o.order_number,true)}" target="_blank" rel="noopener">Open video receipt</a>`:`<button type="button" data-order="${esc(o.id)}" data-section="${tool==='labels'?'labels':'preparation'}">${tool==='labels'?'Attach / manage labels':tool==='dates'?'Edit ship-by date':'Open preparation'}</button>`}<a class="tk-action" href="${adapter.orderUrl(o.order_number)}" target="_blank" rel="noopener">Open TikTok order</a></div></section>`).join('')}`;
  $('tk-buyer-tools-status').textContent='';bindOrderButtons($('tk-buyer-tools'));
  const docs=orders.flatMap(o=>o.documents);$('tk-buyer-tools').querySelectorAll('[data-preview-label]').forEach(b=>b.onclick=()=>busy(()=>previewDocument(docs.find(d=>d.id===b.dataset.previewLabel))));
  $('tk-buyer-tools').querySelectorAll('[data-print-label]').forEach(b=>b.onclick=()=>busy(async()=>{const d=docs.find(d=>d.id===b.dataset.printLabel),r=await window.shippingLabelPrint.printSaved({path:d.path,title:'TikTok shipping label'});$('tk-buyer-tools-status').textContent=r.message||'Print dialog opened.';}));
  $('tk-buyer-tools').showModal();
 }
 function localTimeInput(value){const d=new Date(value);if(!Number.isFinite(d.getTime()))return '';return new Date(d-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}
 function fileTime(filename){const m=/order-(\d{4})-(\d{2})-(\d{2})-(\d{2})[:_](\d{2})/i.exec(filename);return m?`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}`:'';}
 async function preview(text,filename,metadata={}){
  const parsed=adapter.parse(text),hash=await sha(new TextEncoder().encode(text));
  for(const row of parsed.rows){const due=metadata.deadlines?.[row.order_number];if(typeof due==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(due))row.ship_by_date=due;}
  state.preview={...parsed,hash,filename};state.transferId=metadata.transferId||null;
  $('tk-import').open=true;$('tk-snapshot').value=fileTime(filename)||localTimeInput(metadata.modifiedAt||Date.now());
  $('tk-preview').hidden=false;$('tk-import-confirm').hidden=false;$('tk-import-cancel').hidden=false;
  $('tk-preview').innerHTML=`<h3>Review before importing</h3><p><strong>${parsed.orderCount} orders · ${parsed.buyerCount} buyers · ${parsed.rows.length} item rows</strong></p><p>${parsed.awaitingShipment} awaiting shipment · ${parsed.awaitingCollection} awaiting collection · ${parsed.cancelledCount} cancelled · ${parsed.historyCount-parsed.cancelledCount} other-status orders</p><p class="tk-help">${parsed.duplicateRows} identical duplicate rows removed. Verify the export time above. Order IDs are preserved as text. Known cancelled orders move to TikTok history. An order missing from a report is never assumed cancelled. New historical orders are skipped.</p><div class="tk-preview-scroll"><table><thead><tr><th>Order</th><th>Buyer</th><th>TikTok status</th><th>Item / SKU</th><th>Qty</th></tr></thead><tbody>${parsed.rows.slice(0,50).map(r=>`<tr><td>${esc(r.order_number)}</td><td>${esc(r.buyer_username)}</td><td>${esc(r.marketplace_status)}</td><td>${esc(r.title)} / ${esc(r.seller_sku)}</td><td>${r.quantity}</td></tr>`).join('')}</tbody></table></div>${parsed.rows.length>50?'<p>Showing the first 50 rows. All validated rows will be imported.</p>':''}`;
  status(`Preview ready: ${filename}. Confirm to save these orders in TikTok only.`);
 }
 function discard(){state.preview=null;state.transferId=null;$('tk-preview').hidden=true;$('tk-import-confirm').hidden=true;$('tk-import-cancel').hidden=true;$('tk-file').value='';}
 async function confirmImport(){
  if(!state.preview)return;const p=state.preview,transferId=state.transferId;
  const snapshot=new Date($('tk-snapshot').value);if(!Number.isFinite(snapshot.getTime()))throw Error('Enter when TikTok generated this export.');
  const result=await rpc('import_tiktok_orders',{_rows:p.rows,_file_hash:p.hash,_filename:p.filename,_snapshot_at:snapshot.toISOString()});
  if(transferId)window.postMessage({type:'OG_TIKTOK_REPORT_DONE',transferId},location.origin);
  discard();await refresh();status(result.already_imported?'This exact file was already imported. No duplicate orders were created.':`Imported into TikTok: ${result.added} new, ${result.refreshed} refreshed, ${result.stale} older snapshots skipped, ${result.history_skipped} new historical/unpaid orders skipped.`);
 }
 function download(bytes,name,type){const url=URL.createObjectURL(new Blob([bytes],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),60000);}
 async function packet(orders){const bytes=await window.TikTokOrderPacket.create(orders);download(bytes,`TikTok-order-packet-${new Date().toISOString().slice(0,10)}.pdf`,'application/pdf');status(`Downloaded a 4 × 6 order packet for ${orders.length} TikTok orders. This is a packing document, not postage.`);}
 async function savePdf(bytes,filename,kind,order){
  if(bytes.length>10*1024*1024)throw Error('Choose a PDF smaller than 10 MB.');await window.shippingLabelPrint.assertComplete(bytes);
  const hash=await sha(bytes),path=`tiktok-orders/${state.user.id}/${hash}.pdf`;
  const {error}=await db.storage.from('ebay-labels').upload(path,new Blob([bytes],{type:'application/pdf'}),{contentType:'application/pdf',upsert:false});
  if(error&&!['409','Duplicate'].includes(String(error.statusCode||error.code))&&!/already exists/i.test(error.message||''))throw error;
  return rpc('attach_tiktok_order_document',{_order_id:order.id,_path:path,_filename:filename,_kind:kind,_tracking:[...new Set(order.lines.map(l=>l.tracking_number).filter(Boolean))].join(', ')});
 }
 async function detail(id,section){
  const order=state.orders.find(o=>o.id===id);if(!order)throw Error('Refresh to load this order.');state.detail=order;
  const [docs,events]=await Promise.all([db.from('tiktok_order_documents').select('*').eq('order_id',id).order('created_at',{ascending:false}),db.from('tiktok_order_events').select('*').eq('order_id',id).order('created_at',{ascending:false}).limit(50)]);
  if(docs.error||events.error)throw docs.error||events.error;
  order.documents=docs.data;render();
  $('tk-detail-body').innerHTML=`<p class="tk-eyebrow">TIKTOK ORDER</p><h2 id="tk-detail-title">${esc(order.buyer_username)} · ${esc(order.order_number)}</h2><p>TikTok: <strong>${esc(order.marketplace_status)} / ${esc(order.marketplace_substatus)}</strong><br>Latest export: ${esc(date(order.source_snapshot_at))}</p>${order.cancel_return?`<p class="tk-warning">Review ${esc(order.cancel_return)} in TikTok before packing.</p>`:''}<div class="tk-actions"><a class="tk-action" href="${adapter.orderUrl(order.order_number,true)}" target="_blank" rel="noopener">Watch full receipt in TikTok</a><a class="tk-action" href="${adapter.orderUrl(order.order_number)}" target="_blank" rel="noopener">Open TikTok order</a><button id="tk-one-packet" type="button">Download order PDF</button><button id="tk-print-packet" type="button">Print order packet</button></div><p class="tk-help">With the updated extension, Watch receipt opens the video panel automatically. Otherwise, click Video receipt on the TikTok order.</p><div class="tk-detail-items">${order.lines.map(l=>itemRow(l,order)).join('')}</div>${order.buyer_message?`<p>Buyer message: ${esc(order.buyer_message)}</p>`:''}${order.seller_note?`<p>Seller note: ${esc(order.seller_note)}</p>`:''}${window.TikTokWork?.cancellation(order)||''}${window.TikTokReversal?.button(order)||''}${window.TikTokCancellations?.button(order)||''}<section id="tk-preparation-section"><h3>OG preparation</h3><div class="tk-fields"><label>Stage<select id="tk-order-stage">${Object.entries(stages).map(([v,l])=>`<option value="${v}" ${order.stage===v?'selected':''}>${l}</option>`).join('')}</select></label><label>Ship-by date from TikTok<input id="tk-order-deadline" type="date" value="${esc(order.ship_by_date||'')}"><small>Leave blank if unverified. TikTok’s CSV omits this date.</small></label></div><label>Notes / waiting reason<textarea id="tk-order-notes" maxlength="4000">${esc(order.notes)}</textarea></label><label class="tk-confirm"><input id="tk-work-confirm" type="checkbox">For Packed, I checked every item and quantity in this order. For Dispatched, I confirm the parcel was handed to the carrier.</label><button id="tk-save-work" type="button">Save preparation</button><p class="tk-help">Preparation tracking is separate from inventory checkout and from TikTok’s status. A printed label alone does not confirm dispatch.</p></section><section id="tk-labels-section"><h3>Shipping labels &amp; order PDFs</h3><p>Download the shipping label from TikTok, then attach it here. Confirm it covers this order, including any combined-package contents.</p><label>Shipping-label PDF<input id="tk-label-file" type="file" accept="application/pdf,.pdf"></label><label class="tk-confirm"><input id="tk-label-confirm" type="checkbox">I checked the recipient and order number(s) on this PDF.</label><button id="tk-save-label" type="button">Attach shipping label</button><div id="tk-docs">${docs.data.map(d=>`<div class="tk-doc"><span>${d.kind==='label'?'Shipping label':'Order packet'} · ${esc(d.filename)}<small> · ${esc(date(d.created_at))}</small>${d.tracking_number?`<br>Attached tracking: ${esc(d.tracking_number)}`:''}</span><button type="button" data-doc-preview="${esc(d.id)}">Preview</button><button type="button" data-doc-print="${esc(d.id)}">Choose printer</button></div>`).join('')||'<p class="tk-muted">No PDFs attached yet.</p>'}</div></section><section><h3>TikTok order history</h3><ol class="tk-history">${events.data.map(e=>`<li><strong>${esc(e.action.replaceAll('_',' '))}</strong> · ${esc(date(e.created_at))}${e.details.to?`<br>${esc(e.details.from)} → ${esc(e.details.to)}`:''}${e.details.notes?`<br>${esc(e.details.notes)}`:''}${window.TikTokReversal?.audit(e)||''}${window.TikTokCancellations?.audit(e)||''}${e.details.snapshot_at?`<br>Source export: ${esc(date(e.details.snapshot_at))}`:''}</li>`).join('')}</ol></section><p id="tk-detail-status" role="status"></p>`;
  window.TikTokReceiptPhotos.hydrate($('tk-detail-body'),db,state.photos);bindLineCompletion($('tk-detail-body'));
  if(!$('tk-detail').open)$('tk-detail').showModal();
  if(section)$('tk-'+section+'-section')?.scrollIntoView({block:'start'});
  $('tk-one-packet').onclick=()=>busy(()=>packet([order]));
  $('tk-print-packet').onclick=()=>busy(async()=>{const bytes=await window.TikTokOrderPacket.create([order]);const d=await savePdf(bytes,`TikTok-order-${order.order_number}.pdf`,'packet',order);const result=await window.shippingLabelPrint.printSaved({path:d.path,title:'TikTok order packet'});await detail(id);$('tk-detail-status').textContent=result.message||'Print dialog opened.';});
  $('tk-save-work').onclick=()=>busy(async()=>{const result=await rpc('update_tiktok_order',{_order_id:id,_revision:order.revision,_stage:$('tk-order-stage').value,_notes:$('tk-order-notes').value,_ship_by:$('tk-order-deadline').value||null,_confirmed:$('tk-work-confirm').checked});await refresh();await detail(result.id);$('tk-detail-status').textContent='Preparation saved to TikTok history.';});
  $('tk-save-label').onclick=()=>busy(async()=>{const file=$('tk-label-file').files[0];if(!file||!$('tk-label-confirm').checked)throw Error('Choose the PDF and confirm its recipient and order numbers.');if(file.size>10*1024*1024)throw Error('Choose a PDF smaller than 10 MB.');await savePdf(new Uint8Array(await file.arrayBuffer()),file.name,'label',order);await refresh();await detail(id,'labels');$('tk-detail-status').textContent='Shipping PDF attached. Preview it or choose your printer.';});
  $('tk-docs').querySelectorAll('[data-doc-print]').forEach(b=>b.onclick=()=>busy(async()=>{const d=docs.data.find(x=>x.id===b.dataset.docPrint);const result=await window.shippingLabelPrint.printSaved({path:d.path,title:d.kind==='label'?'TikTok shipping label':'TikTok order packet'});$('tk-detail-status').textContent=result.message||'Print dialog opened.';}));
  $('tk-docs').querySelectorAll('[data-doc-preview]').forEach(b=>b.onclick=()=>busy(async()=>{const d=docs.data.find(x=>x.id===b.dataset.docPreview),{data,error}=await db.storage.from('ebay-labels').createSignedUrl(d.path,120);if(error)throw error;const a=document.createElement('a');a.href=data.signedUrl;a.target='_blank';a.rel='noopener';a.click();}));
 }
 function exportView(){const list=filtered();if(!list.length)throw Error('No orders in this view.');const quote=v=>'"'+String(v??'').replace(/^\s*[=+@-]/,"'$&").replaceAll('"','""')+'"';const data=[['Marketplace','Order ID','Buyer Username','TikTok Status','TikTok Substatus','OG Stage','SKU ID','Seller SKU','Product','Quantity','Package ID','Tracking ID','Ship By','Notes','Export Snapshot','Item Search','Watch','Watch Missing','CGL Required','CGL Confirmed','Pending Cancellation','Inventory Barcode','Inventory Linked Qty','Inventory Deducted Qty']];for(const o of list)for(const l of o.lines)data.push(['TikTok',o.order_number,o.buyer_username,o.marketplace_status,o.marketplace_substatus,o.stage,l.sku_id,l.seller_sku,l.title,l.quantity,l.package_id,l.tracking_number,o.ship_by_date,o.notes,o.source_snapshot_at,l.work?.item_search,l.work?.is_watch,l.work?.watch_missing,l.work?.cgl_required,Boolean(l.work?.certificate_id),o.cancellation?.pending,l.inventory?.display_snapshot?.barcode,l.inventory?.quantity,l.inventory?.consumed_quantity]);download('\uFEFF'+data.map(r=>r.map(quote).join(',')).join('\r\n'),'OG-TikTok-'+(historyView?'history':'pending')+'.csv','text/csv');status('Exported this TikTok view. This tracking export is not a TikTok import file.');}
 $('tk-close-detail').onclick=()=>$('tk-detail').close();$('tk-close-buyer-tools').onclick=()=>$('tk-buyer-tools').close();$('tk-search').oninput=render;$('tk-stage-filter').onchange=render;$('tk-work-filter').onchange=render;$('tk-sort').onchange=render;$('tk-phone-refresh').onclick=()=>busy(refresh);
 $('tk-refresh').onclick=()=>busy(refresh);$('tk-packet').onclick=()=>busy(()=>packet(filtered()));$('tk-export').onclick=()=>busy(exportView);
 $('tk-file').onchange=()=>busy(async()=>{const f=$('tk-file').files[0];if(!f)return;if(f.size>adapter.MAX_BYTES)throw Error('Choose a CSV smaller than 10 MB.');await preview(await f.text(),f.name,{modifiedAt:f.lastModified});});
 $('tk-import-confirm').onclick=()=>busy(confirmImport);$('tk-import-cancel').onclick=discard;
 function updateView(){
  $('tk-title').textContent=historyView?'TikTok Order History':'Pending TikTok Orders';$('tk-greeting').textContent=$('tk-title').textContent;$('tk-phone-title').textContent=historyView?'Order history':'Pending orders';$('tk-queue-title').textContent=historyView?'TikTok order history':'Orders to Pack';document.querySelector('.buyer-due-filters').hidden=historyView;
  $('tk-history-link').removeAttribute('aria-current');$('tk-pending-link').removeAttribute('aria-current');$(historyView?'tk-history-link':'tk-pending-link').setAttribute('aria-current','page');$('ebay-tab').href=historyView?'ebay-order-history.html':'pending-orders.html';
 }
 updateView();
 document.addEventListener('click',event=>{for(const menu of document.querySelectorAll('.tk-card-tools[open]')){if(!menu.contains(event.target)||event.target.closest('button,a'))menu.open=false;}});
 document.addEventListener('keydown',event=>{if(event.key==='Escape'){for(const menu of document.querySelectorAll('.tk-card-tools[open]')){menu.open=false;menu.querySelector('summary').focus();}}});
 window.addEventListener('tiktok-work-saved',()=>{if($('tk-detail').open&&state.detail)busy(()=>detail(state.detail.id));});
 document.addEventListener('tiktok-inventory-saved',()=>{if($('tk-detail').open&&state.detail)busy(()=>detail(state.detail.id));});
 let currentDay=queue.calendarDate();setInterval(()=>{const today=queue.calendarDate();if(today!==currentDay){currentDay=today;render();}},60000);
 let ready=false;
 window.addEventListener('message',event=>{if(event.source!==window||event.origin!==location.origin)return;if(event.data?.type==='OG_TIKTOK_BRIDGE_READY'&&ready){window.postMessage({type:'OG_TIKTOK_REPORT_READY'},location.origin);return;}if(event.data?.type!=='OG_TIKTOK_REPORT_DATA')return;const p=event.data.payload;if(p?.transferId!==new URLSearchParams(location.search).get('tiktokReport'))return;if(state.preview?.hash||state.transferId===p.transferId)return;busy(async()=>{if(p.error)throw Error(p.error);if(p.completed){status('This export handoff was already imported.');return;}await preview(p.text,p.filename,p);});});
 if(window.TikTokFulfillment?.connectPhone({db,onUser:user=>state.user=user}))return;
 busy(async()=>{const {data,error}=await db.auth.getSession();if(error)throw error;if(!data.session){location.href='index.html';return;}state.user=data.session.user;await window.TikTokReversal?.start({db,user:state.user,refresh,status,getOrders:()=>state.orders});await window.TikTokCancellations?.start({db,user:state.user,refresh,status,getOrders:()=>state.orders});await refresh();}).finally(()=>{if(state.user){ready=true;window.TikTokTasks?.start({db,user:state.user,getOrders:()=>state.orders});window.TikTokWork?.start({db,user:state.user,refresh,status,getOrders:()=>state.orders});window.TikTokFulfillment?.start({db,user:state.user,refresh,status,getOrders:()=>state.orders,getReceiptPhotos:()=>state.photos});window.TikTokReceiptPhotos.start({db,user:state.user,getOrders:()=>state.orders,refresh,status,reveal:revealCapture});window.postMessage({type:'OG_TIKTOK_REPORT_READY'},location.origin);}});
})();
