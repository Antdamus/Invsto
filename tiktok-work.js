/* TikTok item preparation; no eBay state or mutations. */
(() => {
 'use strict';
 let context,busy=false;
 const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 const lookup=id=>{const order=context?.getOrders().find(o=>o.lines.some(l=>l.id===id));return {order,line:order?.lines.find(l=>l.id===id)};};
 const closed=id=>{const {order,line}=lookup(id);return !order||window.TikTokOrderQueue.lineCancelled(line||{},order)||Boolean(line?.fulfilled_at)||window.TikTokOrderQueue.closed(order);};
 function line(l,o){
  const w=l.work||{},readonly=window.TikTokOrderQueue.lineCancelled(l,o)||Boolean(l.fulfilled_at)||window.TikTokOrderQueue.closed(o);
  const button=(action,title,selected=false)=>`<button type="button" class="secondary-btn ${selected?'is-selected':''}" data-tk-work="${action}" data-line="${esc(l.id)}" aria-pressed="${selected}" ${readonly||selected?'disabled':''}>${title}</button>`;
  return `<div class="tk-work-line" data-tk-work-line="${esc(l.id)}">
   ${l.fulfilled_at?'<p class="tk-work-ok">Completed · '+esc(new Date(l.fulfilled_at).toLocaleString())+'</p>':''}<div class="tk-item-check"><span class="tk-section-label">Item check</span><div class="tk-found-options" role="group" aria-label="Item found status">${button('found','Mark found',w.item_search==='found')}${button('not_found','Mark lost',w.item_search==='not_found')}</div><small class="tk-check-status">${w.item_search==='not_found'?'Lost · excluded from completion':w.item_search==='found'?'Found · located and checked':'Mark when you locate the item'}</small></div>
   <div class="tk-item-processing"><span class="tk-section-label">Watch &amp; certificate</span><div class="tk-processing-buttons">${button(w.is_watch?'unwatch':'watch',w.is_watch?'Watch · Extra processing':'Watch')}<button type="button" class="certificate-trigger secondary-btn" data-certificate-line="${esc(l.id)}" data-certificate-title="${esc(o.order_number+' · '+l.title)}">CGL certificate</button></div>${w.is_watch?`<div class="tk-watch-options">${button(w.watch_missing?'watch_found':'missing',w.watch_missing?'Mark watch found':'Watch missing')}${button(w.cgl_required?'remove_cgl':'require_cgl',w.cgl_required?'Remove CGL requirement':'Set Pending CGL')}</div>`:''}<div class="tk-processing-status">${w.watch_missing?'<span class="tk-work-alert">Watch missing</span>':''}${w.cgl_required?`<span class="${w.certificate_id?'tk-work-ok':'tk-work-alert'}">${w.certificate_id?'CGL confirmed':'Pending CGL'}</span>`:''}</div></div>
   ${w.updated_at?`<small class="tk-work-updated">Updated ${esc(new Date(w.updated_at).toLocaleString())}</small>`:''}<p data-work-status role="status"></p></div>`;
 }
 function cancellation(o){return `<button type="button" class="secondary-btn" data-tk-cancel="${esc(o.id)}" ${window.TikTokOrderQueue.closed(o)||o.marketplace_status!=='To ship'?'disabled':''}>${o.cancellation?.pending?'Manage cancellation hold':'Cancellation hold'}</button>${o.cancellation?.pending?`<span class="tk-work-alert">Pending cancellation · ${esc(o.cancellation.reason)}</span>`:''}`;}
 async function save(args){const {error}=await context.db.rpc('save_tiktok_line_work',args);if(error)throw error;await changed();}
 async function changed(){await context.refresh();window.dispatchEvent(new CustomEvent('tiktok-work-saved'));}
 function modal(title,body,onSave){
  const d=document.createElement('dialog');d.className='tk-detail tk-work-dialog';d.setAttribute('aria-label',title);d.innerHTML=`<button type="button" class="tk-close" data-close aria-label="Close">×</button><h2>${esc(title)}</h2>${body}<p data-status role="status"></p><button type="button" class="primary-btn" data-save>Save</button>`;document.body.append(d);
  const close=()=>{if(!busy)d.close();};d.querySelector('[data-close]').onclick=close;d.addEventListener('cancel',e=>{if(busy)e.preventDefault();});d.addEventListener('close',()=>d.remove(),{once:true});
  d.querySelector('[data-save]').onclick=async()=>{if(busy)return;busy=true;d.querySelector('[data-save]').disabled=true;try{await onSave(d);d.close();}catch(e){d.querySelector('[data-status]').textContent=e.message;}finally{busy=false;d.querySelector('[data-save]').disabled=false;}};d.showModal();return d;
 }
 async function action(button){
  if(busy)return;const {line:l,order}=lookup(button.dataset.line);if(!l||window.TikTokOrderQueue.lineCancelled(l,order)||l.fulfilled_at||window.TikTokOrderQueue.closed(order))return;
  const action=button.dataset.tkWork,args={_line_id:l.id,_revision:l.work?.revision||0,_action:action};
  if(action==='watch_found'||action==='remove_cgl'){
   modal(action==='watch_found'?'Mark watch found':'Remove CGL requirement',`<p>${esc(order.order_number+' · '+l.title)}</p>${action==='watch_found'?'<label class="tk-confirm"><input type="checkbox" data-confirm>I physically located and checked this watch.</label><p>Its CGL requirement stays in place.</p>':'<label>Correction reason<textarea maxlength="1000" data-note required></textarea></label><p>The certificate copies remain in history.</p>'}`,async d=>{
    if(action==='watch_found'&&!d.querySelector('[data-confirm]').checked)throw Error('Confirm you physically located and checked the watch.');
    const note=d.querySelector('[data-note]')?.value.trim()||'';if(action==='remove_cgl'&&!note)throw Error('Enter a correction reason.');await save({...args,_confirmed:action==='watch_found',_note:note});
   });return;
  }
  busy=true;const buttons=[...document.querySelectorAll('[data-tk-work],[data-tk-cancel]')].map(b=>[b,b.disabled]);for(const [b]of buttons)b.disabled=true;try{await save(args);}catch(e){button.closest('.tk-work-line').querySelector('[data-work-status]').textContent=e.message;}finally{busy=false;for(const [b,disabled]of buttons)if(b.isConnected)b.disabled=disabled;}
 }
 function cancel(id){
  const o=context.getOrders().find(o=>o.id===id);if(!o||window.TikTokOrderQueue.closed(o)||busy)return;
  const pending=!!o.cancellation?.pending;
  modal(pending?'Manage cancellation hold':'Pending cancellation hold',`<p><strong>${esc(o.order_number)}</strong> · ${esc(o.buyer_username)}</p><p>Marking pending cancellation holds this buyer’s orders in OG. When TikTok confirms cancellation, use Mark cancelled on the order or import a fresh All-orders / Canceled CSV.</p><a class="tk-action" href="${window.TikTokOrderImport.orderUrl(o.order_number)}" target="_blank" rel="noopener">Open order in TikTok</a>${pending?`<p class="tk-work-alert">Pending cancellation: ${esc(o.cancellation.reason)}</p><label class="tk-confirm"><input type="checkbox" data-release>Release the OG hold; this order should continue being prepared.</label>`:''}<label>${pending?'Update / release reason':'Cancellation reason'}<textarea data-note maxlength="1000" required></textarea></label>`,async d=>{
   const reason=d.querySelector('[data-note]').value.trim();if(!reason)throw Error('Enter a reason.');
   const {error}=await context.db.rpc('set_tiktok_cancellation',{_order_id:o.id,_revision:o.cancellation?.revision||0,_pending:!d.querySelector('[data-release]')?.checked,_reason:reason});if(error)throw error;await changed();
  }).querySelector('[data-save]').textContent=pending?'Save cancellation review':'Mark pending cancellation';
 }
 function start(config){context=config;
  document.addEventListener('click',e=>{const work=e.target.closest('[data-tk-work]'),cancelButton=e.target.closest('[data-tk-cancel]');if(work){e.preventDefault();void action(work);}else if(cancelButton){e.preventDefault();cancel(cancelButton.dataset.tkCancel);}});
  window.addEventListener('tiktok-work-changed',()=>{void changed().catch(e=>context.status('Certificate saved. Refresh the order list: '+e.message,true));});
 }
 function summary(g){const count=fn=>g.lines.filter(l=>!window.TikTokOrderQueue.lineCancelled(l,g.orders.find(o=>o.id===l.order_id))&&fn(l)).length,found=count(l=>l.work?.item_search==='found'),missing=count(l=>l.work?.item_search==='not_found'),watches=count(l=>l.work?.watch_missing),cgl=count(l=>l.work?.cgl_required&&!l.work?.certificate_id),cancel=g.orders.filter(o=>o.cancellation?.pending).length;return [[found,'items found','tk-work-ok'],[missing,'items lost','tk-work-alert'],[watches,'watches missing','tk-work-alert'],[cgl,'pending CGL','tk-work-alert'],[cancel,'pending cancellation','tk-work-alert']].filter(([n])=>n).map(([n,label,cls])=>`<span class="buyer-card-meta-pill ${cls}">${n} ${label}</span>`).join('');}
 window.TikTokWork={line,cancellation,start,closed,summary};
})();
