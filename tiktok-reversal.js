(function(){
  'use strict';
  let context, allowed=false, saving=false, selected=null, returnFocus=null;
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const $=id=>document.getElementById(id);
  const eligible=o=>['completed','dispatched'].includes(o.stage)&&['To ship','Shipped','Completed'].includes(o.marketplace_status)&&!o.cancel_return;
  function button(o){return allowed&&eligible(o)?`<button type="button" class="tk-card-button tk-revert-button" data-tiktok-revert="${esc(o.id)}">Revert order</button>`:'';}
  function audit(e){
    if(e.action!=='order_reverted')return '';
    const d=e.details||{};
    return `<br>Signed by ${esc(d.actor_name||d.actor_email||e.actor)}${d.actor_name&&d.actor_email?` (${esc(d.actor_email)})`:''} · ${esc(d.actor_role||'')}<br>${Number(d.restored_units||0)} inventory unit(s) restored. Original order, photos, labels, and fulfillment details retained.`;
  }
  function close(){if(saving)return;$('tk-revert').close();selected=null;$('tk-revert-password').value='';returnFocus?.focus();}
  function open(id){
    if(saving||!allowed)return;
    const order=context.getOrders().find(o=>o.id===id);if(!order||!eligible(order))return;
    selected={id:order.id,revision:order.revision};returnFocus=document.activeElement;
    $('tk-revert-order').textContent=`${order.buyer_username} · ${order.order_number}`;
    const units=(order.lines||[]).reduce((n,l)=>n+Number(l.inventory?.consumed_quantity||0),0);
    $('tk-revert-impact').textContent=`Move this ${order.stage} order back to Pending in Invsto. ${units} deducted inventory unit(s) will be restored. TikTok status and saved labels, photos, and certificates remain unchanged.`;
    $('tk-revert-reason').value='';$('tk-revert-password').value='';$('tk-revert-confirm').checked=false;$('tk-revert-error').textContent='';
    $('tk-revert').showModal();$('tk-revert-reason').focus();
  }
  async function save(event){
    event?.preventDefault();if(saving||!selected||!allowed)return;
    const reason=$('tk-revert-reason').value.trim(),password=$('tk-revert-password').value;
    const error=$('tk-revert-error');error.textContent='';
    if(reason.length<3||reason.length>2000){error.textContent='Explain the reversal using 3 to 2000 characters.';$('tk-revert-reason').focus();return;}
    if(!password){error.textContent='Enter your password to sign this reversal.';$('tk-revert-password').focus();return;}
    if(!$('tk-revert-confirm').checked){error.textContent='Confirm this order needs to return to Pending.';return;}
    const order={...selected};let result=null;saving=true;
    $('tk-revert').querySelectorAll('input,textarea,button').forEach(el=>el.disabled=true);$('tk-revert-save').textContent='Reverting…';
    try{
      const signed=await context.db.auth.signInWithPassword({email:context.user.email,password});
      if(signed.error)throw Error('Incorrect password. Please try again.');
      if(signed.data?.user&&signed.data.user.id!==context.user.id)throw Error('Your account changed. Reload before reverting.');
      const {data,error:failure}=await context.db.rpc('revert_tiktok_orders',{_order_ids:[order.id],_revisions:{[order.id]:order.revision},_reason:reason,_confirmed:true});
      if(failure)throw failure;result=data;
    }catch(e){error.textContent=e.message||'Could not revert this order.';}
    finally{saving=false;$('tk-revert').querySelectorAll('input,textarea,button').forEach(el=>el.disabled=false);$('tk-revert-save').textContent='Sign and revert';}
    if(!result)return;
    close();document.getElementById('tk-detail')?.close();
    try{await context.refresh();context.status(`Order reverted to Pending. ${result.restored_units||0} inventory unit(s) restored; the audit trail is saved.`);}
    catch(e){context.status('Order reverted and audit saved. Refresh to reload the latest orders.',true);}
  }
  async function start(options){
    context=options;
    try{const {data,error}=await context.db.rpc('can_revert_order_fulfillment');allowed=!error&&data===true;}catch{allowed=false;}
    if(!$('tk-revert')){
      const dialog=document.createElement('dialog');dialog.id='tk-revert';dialog.className='tk-revert-dialog';dialog.setAttribute('aria-labelledby','tk-revert-title');
      dialog.innerHTML=`<form id="tk-revert-form" novalidate><header><span class="tk-eyebrow">AUDITED REVERSAL</span><h2 id="tk-revert-title">Revert TikTok order</h2><strong id="tk-revert-order"></strong></header><p id="tk-revert-impact"></p><p class="tk-help">Your name, date, reason, previous order state, and stock adjustments are saved in order history.</p><label>Reversal reason<textarea id="tk-revert-reason" required minlength="3" maxlength="2000" rows="3" placeholder="Example: Completed the wrong order by mistake."></textarea></label><label>Your password<input id="tk-revert-password" type="password" autocomplete="current-password" required></label><label class="tk-confirm"><input id="tk-revert-confirm" type="checkbox">This order needs to return to Pending for correction. I have checked that restoring stock is appropriate.</label><p id="tk-revert-error" role="alert"></p><footer><button id="tk-revert-cancel" type="button">Cancel</button><button id="tk-revert-save" type="submit">Sign and revert</button></footer></form>`;
      document.body.append(dialog);$('tk-revert-form').addEventListener('submit',save);$('tk-revert-cancel').addEventListener('click',close);
      dialog.addEventListener('cancel',e=>{e.preventDefault();close();});
      document.addEventListener('click',e=>{const b=e.target.closest('[data-tiktok-revert]');if(b){e.preventDefault();open(b.dataset.tiktokRevert);}});
    }
  }
  window.TikTokReversal={start,button,audit};
})();
