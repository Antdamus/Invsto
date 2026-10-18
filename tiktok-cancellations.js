/* Audited OG records of cancellations verified in TikTok. */
(() => {
 'use strict';
 let context,canCorrect=false,busy=false,dialog;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const q=()=>window.TikTokOrderQueue;
 function badge(o,l){
  if(l)return q().lineCancelled(l,o)?'<span class="tk-cancelled-badge">Cancelled item</span>':'';
  if(q().cancelled(o))return '<span class="tk-cancelled-badge">Cancelled</span>';
  const n=o.lines?.filter(l=>q().lineCancelled(l,o)).length||0;
  return n?`<span class="tk-cancelled-badge">Partially cancelled · ${n} item${n===1?'':'s'}</span>`:'';
 }
 function button(o){
  if(!q().cancelled(o))return `<button type="button" class="tk-card-button tk-cancel-action" data-tk-confirm-cancel="${esc(o.id)}">Cancel order</button>`;
  return canCorrect&&o.cancellation_record?.source==='manual'?`<button type="button" class="tk-text-action" data-tk-correct-cancel="${esc(o.id)}">Correct cancellation mark</button>`:'';
 }
 function lineButton(l,o){
  if(['Canceled','Cancelled'].includes(o.marketplace_status))return '';
  if(!l.cancelled_at)return `<button type="button" class="tk-card-button tk-cancel-action" data-tk-cancel-line="${esc(l.id)}">Cancel item</button>`;
  return canCorrect?`<button type="button" class="tk-text-action" data-tk-correct-line="${esc(l.id)}">Correct item cancellation</button>`:'';
 }
 function groupButton(g){return g.orders.some(o=>!q().closed(o))?`<button type="button" class="tk-card-button tk-cancel-action" data-tk-cancel-buyer="${esc(g.key)}">Cancel orders</button>`:'';}
 function summary(g){
  const related=context?.getOrders().filter(o=>o.buyer_username.toLowerCase()===g.key)||g.orders;
  const orders=related.filter(o=>q().cancelled(o)).length,items=related.reduce((n,o)=>n+(o.lines||[]).filter(l=>q().lineCancelled(l,o)).length,0);
  return orders||items?`<a class="tk-cancelled-badge" href="pending-tiktok-orders.html?view=cancelled&buyer=${encodeURIComponent(g.buyer)}">${orders?`${orders} cancelled order${orders===1?'':'s'}`:`${items} cancelled item${items===1?'':'s'}`}</a>`:'';
 }
 function audit(event){
  if(!['cancellation_confirmed','cancellation_corrected','cancellation_imported','cancellation_refresh_conflict','marketplace_status_updated','line_cancellation_confirmed','line_cancellation_corrected'].includes(event.action))return '';
  const d=event.details||{};
  return `<br>Recorded by ${esc(d.actor_email||event.actor)} · ${d.source==='export'?'TikTok CSV':'Staff verification'}${d.line_id?`<br>Item: ${esc(d.title)} · SKU ${esc(d.sku_id)} · Qty ${esc(d.quantity)}`:''}${d.reported_status?`<br>Export reported ${esc(d.reported_status)}; cancellation kept for review.`:''}${d.inventory_changed===false?'<br>Inventory quantities and fulfillment evidence retained.':''}`;
 }
 function open(orders,{correct=false,line=null,buyer=false}={}){
  if(busy||dialog?.open||!orders.length||correct&&!canCorrect)return;
  const o=orders[0],label=correct?'Correct cancellation mark':line?'Cancel this item':buyer?'Cancel buyer orders':'Cancel this order';
  const d=document.createElement('dialog');dialog=d;d.className='tk-detail tk-cancellation-dialog';d.setAttribute('aria-labelledby','tk-cancellation-title');
  d.innerHTML=`<button type="button" class="tk-close" data-close aria-label="Close cancellation">×</button><h2 id="tk-cancellation-title">${label}</h2>
   <p><strong>${esc(o.buyer_username)}</strong>${buyer?'':' · Order '+esc(o.order_number)}</p>
   ${line?`<div class="tk-cancellation-scope"><strong>${esc(line.title)}</strong><p>SKU ${esc(line.seller_sku||line.sku_id)} · Qty ${esc(line.quantity)}</p><p>Only this item is affected. Other items in the order remain unchanged.</p></div>`:''}
   <p>${correct?'Correct this manual mark after checking TikTok. The correction is saved in the audit history.':'Record a cancellation already confirmed in TikTok. This updates OG; it does not submit a cancellation or refund to TikTok. Cancelled orders are available in the Cancelled view, and the buyer’s other open orders stay in the queue.'}</p>
   <a class="tk-action" href="${window.TikTokOrderImport.orderUrl(o.order_number)}" target="_blank" rel="noopener">Check order in TikTok ↗</a>
   <p class="tk-help">Your name, time, reason and exact order/item scope are saved in the audit history. Stock, labels, photos and completed work stay as recorded.</p>
   <form>${buyer?`<fieldset class="tk-cancel-order-list"><legend>Select orders to cancel</legend>${orders.map(order=>`<label class="tk-confirm"><input type="checkbox" name="orders" value="${esc(order.id)}" checked><span><strong>${esc(order.order_number)}</strong><small>${esc(order.lines.map(l=>l.title+' × '+l.quantity).join(', '))}</small></span></label>`).join('')}</fieldset>`:''}
   <label>${correct?'Correction reason':'Cancellation reason / evidence'}<textarea name="reason" required minlength="3" maxlength="2000" rows="3"></textarea></label>
   <label class="tk-confirm"><input name="confirmed" type="checkbox" required>${correct?'I checked TikTok and this manual cancellation mark was a mistake.':line?'I checked this exact item in TikTok and confirmed its cancellation.':'I checked the selected order(s) in TikTok and confirmed their cancellation.'}</label>
   <p role="status" data-status aria-live="polite"></p><button type="submit" class="primary-btn">${correct?'Save audited correction':line?'Mark item cancelled in OG':'Mark cancelled in OG'}</button></form>`;
  document.body.append(d);const form=d.querySelector('form'),status=d.querySelector('[data-status]');
  d.querySelector('[data-close]').onclick=()=>{if(!busy)d.close();};d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});d.addEventListener('close',()=>d.remove(),{once:true});
  form.onsubmit=async event=>{
   event.preventDefault();if(busy||!form.reportValidity())return;
   const reason=form.elements.reason.value.trim(),selected=buyer?orders.filter(order=>[...form.querySelectorAll('[name=orders]:checked')].some(box=>box.value===order.id)):orders;
   if(!selected.length){status.textContent='Select at least one order to cancel.';return;}
   if(reason.length<3){status.textContent='Enter a reason using at least 3 characters.';return;}
   const args={_revision:o.revision,_cancelled:!correct,_reason:reason,_confirmed:form.elements.confirmed.checked};
   const name=line?'record_tiktok_line_cancellation':buyer?'record_tiktok_buyer_cancellations':'record_tiktok_cancellation';
   const payload=line?{...args,_line_id:line.id}:buyer?{_order_ids:selected.map(o=>o.id),_revisions:Object.fromEntries(selected.map(o=>[o.id,o.revision])),_reason:reason,_confirmed:args._confirmed}:{...args,_order_id:o.id};
   busy=true;d.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);status.textContent='Saving cancellation audit…';let saved=false;
   try{const {error}=await context.db.rpc(name,payload);if(error)throw error;saved=true;}
   catch(e){status.textContent=e.message||'Could not save this cancellation.';}
   finally{busy=false;d.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=false);}
   if(!saved)return;
   d.close();document.getElementById('tk-detail')?.close();
   try{await context.refresh();window.dispatchEvent(new CustomEvent('tiktok-work-saved'));context.status(correct?'Cancellation mark corrected. The reason and previous state are in order history.':line?'Item marked cancelled and excluded from completion. The cancellation audit is saved.':'Orders marked cancelled. Open Cancelled to review them. The cancellation audit is saved.');}
   catch{context.status('Cancellation audit saved. Refresh the page to load the updated order status.',true);}
  };
  d.showModal();form.elements.reason.focus();
 }
 async function start(config){
  if(context)return;context=config;
  try{const {data,error}=await context.db.rpc('can_revert_order_fulfillment');canCorrect=!error&&data===true;}catch{canCorrect=false;}
  document.addEventListener('click',e=>{
   const b=e.target.closest('[data-tk-confirm-cancel],[data-tk-correct-cancel],[data-tk-cancel-line],[data-tk-correct-line],[data-tk-cancel-buyer]');if(!b)return;e.preventDefault();
   const orders=context.getOrders(),lineId=b.dataset.tkCancelLine||b.dataset.tkCorrectLine;
   if(lineId){const o=orders.find(o=>o.lines.some(l=>l.id===lineId));if(o)open([o],{line:o.lines.find(l=>l.id===lineId),correct:Boolean(b.dataset.tkCorrectLine)});}
   else if(b.dataset.tkCancelBuyer)open(orders.filter(o=>o.buyer_username.toLowerCase()===b.dataset.tkCancelBuyer&&!q().closed(o)),{buyer:true});
   else{const o=orders.find(o=>o.id===(b.dataset.tkConfirmCancel||b.dataset.tkCorrectCancel));if(o)open([o],{correct:Boolean(b.dataset.tkCorrectCancel)});}
  });
 }
 window.TikTokCancellations={start,button,lineButton,groupButton,badge,summary,audit};
})();
