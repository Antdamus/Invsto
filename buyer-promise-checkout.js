/* Order-specific, server-verified certification of customer promises. */
(function(root) {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let client, onSaved, dialog, busy = false, opener;
  const ids = lines => [...new Set(lines.map(line => line?.order_id).filter(Boolean))].sort();
  const button = lines => `<button type="button" class="buyer-task-launch" data-buyer-promise-orders="${esc(JSON.stringify(ids(lines)))}">Review & sign customer promises</button>`;
  async function list(orderIds) {
    const rows = [];
    for (let i=0;i<orderIds.length;i+=75) {
      const {data,error} = await client.rpc('list_buyer_promise_requirements', {_order_ids:orderIds.slice(i,i+75)});
      if (error) throw error;
      rows.push(...(data || []));
    }
    return rows;
  }
  function close() {
    if (busy) return;
    dialog?.close(); dialog?.remove(); dialog = null;
    if (opener?.isConnected) opener.focus({preventScroll:true});
  }
  async function review(orderIds) {
    if (!client || dialog) return;
    opener = document.activeElement;
    const node = document.createElement('dialog'); dialog = node;
    node.className = 'buyer-task-dialog'; node.setAttribute('aria-labelledby','buyer-promise-heading');
    node.innerHTML = `<div class="buyer-task-form"><div class="buyer-task-heading"><h2 id="buyer-promise-heading">Customer promises</h2><button type="button" data-promise-close aria-label="Close customer promises">×</button></div>
      <p>Every promise needs a signed decision for this order before fulfillment. Admin permission applies only to this order and keeps the promise for the next order.</p>
      <p role="status" class="buyer-task-error" data-promise-error></p><div data-promise-list>Loading promises…</div>
      <div class="buyer-task-actions"><button type="button" data-promise-retry hidden>Retry</button><button type="button" data-promise-close>Done</button></div></div>`;
    document.body.append(node); node.showModal();
    node.addEventListener('cancel',e=>{e.preventDefault();close();});
    node.addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();close();}});
    node.addEventListener('click',e=>{
      if(e.target.closest('[data-promise-close]'))close();
      if(e.target.closest('[data-promise-retry]'))void render();
    });
    async function render() {
      const errorNode=node.querySelector('[data-promise-error]');
      errorNode.textContent=''; node.querySelector('[data-promise-retry]').hidden=true;
      try {
        const rows=await list(orderIds);
        if(dialog!==node)return;
        node.querySelector('[data-promise-list]').innerHTML=rows.length ? rows.map((row,index)=>`<article class="buyer-promise-review">
          <small>${esc(row.buyer_username)} · Order ${esc(row.order_number || row.order_id)}</small>
          <h3>${esc(row.title)}</h3><p class="buyer-promise-instructions">${esc(row.instructions)}</p>
          ${row.decision ? `<p class="buyer-promise-signed">${row.decision==='defer'?'Admin permission: deferred to next order':row.consumed_at?'Fulfilled with signed certification':'Certified · finish checkout to fulfill'}<br>Signed ${esc(row.signature)} · ${esc(row.signed_by_email)} · ${esc(new Date(row.signed_at).toLocaleString())}<br>${esc(row.reason)}</p>` : '<p class="buyer-task-error">Signature required before fulfillment</p>'}
          ${!row.decision || (row.can_defer && !row.consumed_at) ? `<form data-promise-form="${index}" class="buyer-task-form">
            ${row.can_defer ? `<label>Decision<select name="decision" aria-label="Decision"><option value="certify">Certify this promise was fulfilled</option><option value="defer">Admin: allow this order, keep promise for next order</option></select></label>` : '<input type="hidden" name="decision" value="certify">'}
            <label>Fulfillment details / reason<textarea name="reason" required maxlength="2000" rows="2" placeholder="Describe what you included, or the reason for deferral"></textarea></label>
            <label>Your signature<input name="signature" required minlength="2" maxlength="150" autocomplete="name" placeholder="Type your full name"></label>
            <label class="buyer-promise-certify"><input type="checkbox" name="confirm" required><span>I certify that I fulfilled the promise above for this order, or, as an admin, explicitly authorize the selected deferral.</span></label>
            <p class="buyer-task-error" role="status" data-sign-error></p><button type="submit">Sign and save decision</button>
          </form>` : ''}</article>`).join('') : '<p>No open customer promises for these orders.</p>';
        node.querySelectorAll('[data-promise-form]').forEach(form=>form.addEventListener('submit',async event=>{
          event.preventDefault(); if(busy || !form.reportValidity())return;
          const row=rows[Number(form.dataset.promiseForm)]; const data=new FormData(form);
          busy=true; form.querySelector('[data-sign-error]').textContent='';
          node.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=true;});
          try {
            const {error}=await client.rpc('sign_buyer_promise',{_task_id:row.task_id,_order_id:row.order_id,
              _decision:data.get('decision'),_signature:data.get('signature').trim(),_reason:data.get('reason').trim(),_version:row.version});
            if(error)throw error;
            await render();
            Promise.resolve().then(()=>onSaved?.()).catch(error=>console.warn('Signed promise saved; refresh order notes:',error));
          } catch(error) {form.querySelector('[data-sign-error]').textContent=error.message || 'Could not save. Your signature and details are kept; retry.';}
          finally {busy=false;node.querySelectorAll('button,input,select,textarea').forEach(el=>{el.disabled=false;});}
        }));
      } catch(error) {errorNode.textContent=error.message || 'Could not load customer promises. Fulfillment remains protected.';node.querySelector('[data-promise-retry]').hidden=false;}
    }
    await render();
  }
  async function assertReady(lines) {
    if(!client)throw Error('Customer promise checks are not ready. Refresh before fulfillment.');
    const orderIds=ids(lines); const rows=await list(orderIds);
    if(rows.some(row=>!row.decision)) {
      await review(orderIds);
      throw Error('Review and sign the customer promises, then confirm fulfillment again.');
    }
  }
  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-buyer-promise-orders]');if(!trigger)return;
    event.preventDefault();event.stopPropagation();void review(JSON.parse(trigger.dataset.buyerPromiseOrders));
  },true);
  root.OGBuyerPromiseCheckout={button,review,assertReady,init(options){client=options.client;onSaved=options.onSaved;}};
})(window);
