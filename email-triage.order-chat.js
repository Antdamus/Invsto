/* Order entry point for the existing messaging workspace. No send occurs on open. */
(function(root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when = value => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString([], {month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'}) : 'No message date';
  async function init(context, {openConversation}) {
    const params = new URLSearchParams(location.search), lineId = params.get('orderLineId');
    if (!lineId) return {opened:false};
    const panel = document.getElementById('order-chat-entry');
    if (!panel) return {opened:false};
    const api = root.EmailTriageApi;
    let data, busy = false, opened = false, composing = false, draft = '', requestId = null, delivery = null;
    const call = values => api.requestEbayConversationDraftAction(context, {orderLineId:lineId, ...values});
    const controls = () => panel.querySelectorAll('button,textarea');
    function lock(value) { busy = value; controls().forEach(el => el.disabled = value); panel.setAttribute('aria-busy',String(value)); }
    function status(message, error = false) { const el=panel.querySelector('[data-order-chat-status]'); if(el){el.textContent=message;el.classList.toggle('is-error',error);} }
    function returnUrl() { return params.get('from') === 'packaging' ? `packaging.html?buyer_order=${encodeURIComponent(data.order.id)}` : `pending-orders.html?orderId=${encodeURIComponent(data.order.order_number)}&buyerUsername=${encodeURIComponent(data.order.buyer_username)}`; }
    function render() {
      panel.hidden=false;
      panel.classList.toggle('is-chat-open', opened);
      document.body.classList.toggle('order-chat-choosing', !opened);
      if (!data) { panel.innerHTML='<p role="status">Finding this order’s eBay chat…</p><p data-order-chat-status role="status"></p><button type="button" class="secondary-btn" data-order-chat-reload>Try again</button>'; return; }
      const exact = data.conversations.filter(c=>c.match!=='buyer');
      const blocked = delivery || data.start?.status;
      panel.innerHTML=`<div class="order-chat-heading"><div><span class="eyebrow">${opened?'Order conversation':'Message the buyer'}</span><h2>${escape(data.order.buyer_username)}</h2><p>${escape(data.line.item_title)}</p><small>Order ${escape(data.order.order_number)} · Item ${escape(data.line.item_number)} · Qty ${escape(data.line.quantity)}</small></div><a class="secondary-btn" href="${escape(returnUrl())}">← Back to ${params.get('from')==='packaging'?'packaging':'order'}</a></div>
        ${opened?'<button type="button" class="secondary-btn" data-order-chat-change>Other chats for this buyer</button>':`
        <div class="order-chat-body">
        ${data.conversations.length?`<div class="order-chat-choices"><h3>${exact.length?'Conversations for this order':'Other conversations with this buyer'}</h3><p>Choose a conversation to read and reply.</p>${data.conversations.map(c=>`<button type="button" class="order-chat-choice" data-order-chat-open="${escape(c.id)}"><span><strong>${escape(c.conversation_title||'eBay conversation')}</strong><small>${({item:'This item',order:'This order',listing:'Same listing',buyer:'Same buyer · Check the conversation'})[c.match]} · ${escape(when(c.latest_message_created_at))}</small><span>${escape(c.latest_message_preview||'Open conversation')}</span></span><b aria-hidden="true">→</b></button>`).join('')}${data.has_more?'<p>Showing a limited set. Use the buyer’s inbox to see more.</p>':''}</div>`:'<p>No saved conversation for this item yet.</p>'}
        ${blocked ? `<div class="order-chat-delivery" role="status">${blocked==='sent'?'Message sent. Your conversation will appear when eBay finishes syncing.':blocked==='unknown'?'Delivery is uncertain. Check the conversation in eBay before sending again.':'A message is being processed. Refresh to check its delivery.'}</div>` : !exact.length ? `${composing||!data.conversations.length?`<form data-order-chat-compose><label for="order-chat-message">New message to ${escape(data.order.buyer_username)}</label><textarea id="order-chat-message" name="orderChatMessage" rows="5" maxlength="2000" required placeholder="Write to the buyer about this item…">${escape(draft)}</textarea><div class="order-chat-compose-footer"><small>Your message will be sent through eBay.</small><button type="submit" class="primary-btn">Send to buyer</button></div></form>`:'<button type="button" class="secondary-btn" data-order-chat-compose-new>Start a new chat for this item</button>'}` : ''}
        <div class="order-chat-tools"><button type="button" class="secondary-btn" data-order-chat-reload>Refresh chats</button><a href="email-triage.html?ebayBuyer=${encodeURIComponent(data.order.buyer_username)}">Buyer’s inbox ↗</a></div></div>`}
        <p data-order-chat-status role="status"></p>`;
    }
    async function openChat(id) {
      lock(true);
      try { await openConversation(id, data.order.buyer_username); opened=true; composing=false; render(); }
      catch(e){status(e.message||'Could not open this chat. Try again.',true);}
      finally{lock(false);}
    }
    async function load(autoOpen=false, refreshProvider=false) {
      lock(true);
      try {
        if (refreshProvider && data && api.runEbayMessageSync) {
          status('Checking the latest conversations in eBay…');
          await api.runEbayMessageSync(context, {otherPartyUsername:data.order.buyer_username,conversationTypes:['FROM_MEMBERS'],maxConversationPages:2,classificationMode:'none',suppressConversationActivityEvents:true});
        }
        data=await call({mode:'order_chat_context'}); delivery=null; render();
        // Only open a requested marker's chat after the server verifies this buyer.
        const requested=params.get('conversationId');
        const preferred=data.conversations.some(c=>c.id===requested)?requested:data.preferred_conversation_id;
        if(autoOpen&&preferred) await openChat(preferred);
      }
      catch(e){status(e.message||'Could not load this order’s chats. Try again.',true);}
      finally{lock(false);}
    }
    panel.addEventListener('input',event=>{if(event.target.name==='orderChatMessage') draft=event.target.value;});
    panel.addEventListener('click',async event=>{
      if(busy)return;
      const open=event.target.closest('[data-order-chat-open]');
      if(open)await openChat(open.dataset.orderChatOpen);
      else if(event.target.closest('[data-order-chat-reload]'))await load(false,true);
      else if(event.target.closest('[data-order-chat-change]')){opened=false;render();}
      else if(event.target.closest('[data-order-chat-compose-new]')){composing=true;render();panel.querySelector('textarea')?.focus();}
    });
    panel.addEventListener('submit',async event=>{
      if(!event.target.matches('[data-order-chat-compose]'))return;
      event.preventDefault();if(busy||!draft.trim())return;
      requestId ||= crypto.randomUUID();lock(true);status('Sending…');
      try {
        const result=await call({mode:'start_order_chat',requestId,draftText:draft,sendConfirmed:true});
        if(result.delivery_status==='failed'){requestId=null;status(result.message||'eBay rejected this message. Review it before trying again.',true);return;}
        delivery=result.delivery_status;render();
        if(result.delivery_status==='sent'&&result.conversation_id){draft='';await openChat(result.conversation_id);status('Message sent.');}
      } catch(e) {
        // Retain the request key and text: a timeout is not proof of non-delivery.
        status(e.message||'Could not confirm delivery. Refresh chats before trying again.',true);
      } finally {lock(false);}
    });
    // Unsaved text remains in this tab while staff switch between candidate chats.
    window.addEventListener('beforeunload',event=>{if(draft.trim()&&!delivery){event.preventDefault();event.returnValue='';}});
    render();await load(true);return {opened};
  }
  root.InvstoOrderChat={init};
})(window);
