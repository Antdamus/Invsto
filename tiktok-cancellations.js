/* Records a status already verified in TikTok; never cancels/refunds a marketplace sale. */
(() => {
 'use strict';
 let context,canCorrect=false,busy=false,dialog;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const cancelled=o=>['Canceled','Cancelled'].includes(o.marketplace_status);
 function button(o){
  if(!cancelled(o))return `<button type="button" class="tk-card-button" data-tk-confirm-cancel="${esc(o.id)}">Mark cancelled</button>`;
  return `<span class="tk-cancelled-badge">Cancelled${o.cancellation_record?.source==='export'?' · TikTok export verified':''}</span>${canCorrect&&o.cancellation_record?.source==='manual'?`<button type="button" class="tk-text-action" data-tk-correct-cancel="${esc(o.id)}">Correct cancellation mark</button>`:''}`;
 }
 function audit(event){
  if(!['cancellation_confirmed','cancellation_corrected','cancellation_imported','cancellation_refresh_conflict','marketplace_status_updated'].includes(event.action))return '';
  const d=event.details||{};
  return `<br>Recorded by ${esc(d.actor_email||event.actor)} · ${d.source==='export'?'TikTok CSV':'Staff verification'}${d.reported_status?`<br>Export reported ${esc(d.reported_status)}; cancellation kept for review.`:''}${d.inventory_changed===false?'<br>Inventory quantities and fulfillment evidence retained.':''}`;
 }
 function open(id,correct=false){
  if(busy||dialog?.open||correct&&!canCorrect)return;
  const o=context.getOrders().find(o=>o.id===id);if(!o)return;
  const d=document.createElement('dialog');dialog=d;d.className='tk-detail tk-cancellation-dialog';d.setAttribute('aria-labelledby','tk-cancellation-title');
  d.innerHTML=`<button type="button" class="tk-close" data-close aria-label="Close cancellation">×</button><h2 id="tk-cancellation-title">${correct?'Correct cancellation mark':'Record TikTok cancellation'}</h2>
   <p><strong>${esc(o.order_number)}</strong> · ${esc(o.buyer_username)}</p>
   <p>${correct?'Restore the status before this manual mark. Import a fresh All-orders CSV afterward to verify the latest TikTok status.':'Use this after TikTok shows the order as cancelled. It moves this order to OG history and keeps the buyer’s other open orders in the queue.'}</p>
   <a class="tk-action" href="${window.TikTokOrderImport.orderUrl(o.order_number)}" target="_blank" rel="noopener">Check order in TikTok ↗</a>
   <p class="tk-help">${correct?'The correction':'Your name, time, reason and previous status'} will be saved in the audit history. Stock, labels, photos and completed work stay as recorded.</p>
   <form><label>${correct?'Correction reason':'Cancellation reason / evidence'}<textarea name="reason" required minlength="3" maxlength="2000" rows="3"></textarea></label>
   <label class="tk-confirm"><input name="confirmed" type="checkbox" required>${correct?'I checked TikTok: this order is not cancelled and the manual mark was a mistake.':'I checked this exact order in TikTok and it is already cancelled.'}</label>
   <p role="status" data-status aria-live="polite"></p><button type="submit" class="primary-btn">${correct?'Save audited correction':'Mark cancelled in OG'}</button></form>`;
  document.body.append(d);const form=d.querySelector('form'),status=d.querySelector('[data-status]');
  d.querySelector('[data-close]').onclick=()=>{if(!busy)d.close();};d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});d.addEventListener('close',()=>d.remove(),{once:true});
  form.onsubmit=async event=>{
   event.preventDefault();if(busy||!form.reportValidity())return;
   const reason=form.elements.reason.value.trim();if(reason.length<3){status.textContent='Enter a reason using at least 3 characters.';return;}
   busy=true;d.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);status.textContent='Saving cancellation audit…';let saved=false;
   try{const {error}=await context.db.rpc('record_tiktok_cancellation',{_order_id:o.id,_revision:o.revision,_cancelled:!correct,_reason:reason,_confirmed:form.elements.confirmed.checked});if(error)throw error;saved=true;}
   catch(e){status.textContent=e.message||'Could not save this cancellation.';}
   finally{busy=false;d.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=false);}
   if(!saved)return;
   d.close();document.getElementById('tk-detail')?.close();
   try{await context.refresh();context.status(correct?'Cancellation mark corrected. The reason and previous state are in order history.':'Order marked cancelled and moved to TikTok history. The cancellation audit is saved.');}
   catch{context.status('Cancellation audit saved. Refresh the page to load the updated order status.',true);}
  };
  d.showModal();form.elements.reason.focus();
 }
 async function start(config){
  if(context)return;context=config;
  try{const {data,error}=await context.db.rpc('can_revert_order_fulfillment');canCorrect=!error&&data===true;}catch{canCorrect=false;}
  document.addEventListener('click',e=>{const b=e.target.closest('[data-tk-confirm-cancel],[data-tk-correct-cancel]');if(b){e.preventDefault();open(b.dataset.tkConfirmCancel||b.dataset.tkCorrectCancel,Boolean(b.dataset.tkCorrectCancel));}});
 }
 window.TikTokCancellations={start,button,audit};
})();
