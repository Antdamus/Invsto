/* One customer-promise composer, shared by Messages, Pending Orders and Tasks. */
(function(root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let client, userId, onSaved, dialog, opener, saving = false, requestId, generation = 0, photos = [];
  function button(username = '', label = 'Customer task', context = {}) {
    return `<button type="button" class="buyer-task-launch" data-buyer-task-username="${escape(username)}" data-buyer-conversation-id="${escape(context.conversationId || '')}" data-buyer-message-id="${escape(context.messageId || '')}">${escape(label)}</button>`;
  }
  function close() {
    if (saving) return;
    generation++;
    photos.forEach(photo => URL.revokeObjectURL(photo.preview)); photos = [];
    dialog?.close(); dialog?.remove(); dialog = null;
    opener?.isConnected && opener.focus({preventScroll:true});
  }
  function viewport() {
    if (dialog) dialog.style.setProperty('--buyer-task-height', `${Math.round(root.visualViewport?.height || root.innerHeight) - 24}px`);
  }
  async function open(username = '', context = {}) {
    if (!client || dialog) return;
    opener = document.activeElement; requestId = root.crypto.randomUUID();
    const current = ++generation;
    const origin = {conversationId:context.conversationId || '', messageId:context.messageId || ''};
    dialog = document.createElement('dialog');
    dialog.className = 'buyer-task-dialog'; dialog.setAttribute('aria-labelledby', 'buyer-task-heading');
    dialog.innerHTML = `<form class="buyer-task-form">
      <div class="buyer-task-heading"><h2 id="buyer-task-heading">Customer task</h2><button type="button" data-buyer-task-close aria-label="Close customer task">×</button></div>
      <p>Save a promise for this customer's next order. Fulfillment requires signed certification. Only an admin can defer it to the next order.</p>
      <label>eBay username<input name="buyerUsername" value="${escape(username)}" maxlength="100" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Exact username, e.g. jewelrybuyer" /></label>
      <small>Matched exactly, ignoring capitalization. Visible to the fulfillment team.</small>
      ${origin.conversationId ? '<p class="buyer-task-source">The original conversation and message will be linked in this task.</p>' : ''}
      <label>Task title<input name="title" maxlength="200" required placeholder="Include the promised replacement clasp" /></label>
      <label>Promise / instructions<textarea name="instructions" rows="4" maxlength="10000" required placeholder="Specify exactly what to include or do with their next order."></textarea></label>
      <label>Add photos (optional)<input type="file" name="photos" accept="image/*,.heic,.heif" multiple /></label>
      <small>Take a photo or choose pictures from your phone. Up to 10 photos, 20 MB each.</small>
      <div class="buyer-task-photos" data-buyer-task-photos></div>
      <div class="buyer-task-fields"><label>Responsible person<select name="owner" required disabled><option value="">Loading people…</option></select></label>
      <label>Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></label></div>
      <p class="buyer-task-error" role="status" data-buyer-task-error></p>
      <div class="buyer-task-actions"><button type="button" data-buyer-task-retry hidden>Retry people</button><button type="button" data-buyer-task-close>Cancel</button><button type="submit" disabled>Save customer task</button></div>
    </form>`;
    document.body.append(dialog); viewport(); dialog.showModal();
    const form = dialog.querySelector('form');
    function renderPhotos() {
      form.querySelector('[data-buyer-task-photos]').innerHTML = photos.map((photo,index) => `<div class="buyer-task-photo"><img src="${escape(photo.preview)}" alt="Selected photo ${index+1}" /><span>${escape(photo.file.name)}</span><button type="button" data-remove-buyer-photo="${index}" aria-label="Remove photo ${index+1}">Remove</button></div>`).join('');
    }
    form.elements.namedItem('photos').addEventListener('change', event => {
      const files = [...event.target.files]; event.target.value = '';
      const errorNode = form.querySelector('[data-buyer-task-error]');
      if (photos.length + files.length > 10) {errorNode.textContent = 'Choose up to 10 photos.'; return;}
      if (files.some(file => (!file.type.startsWith('image/') && !/\.(heic|heif)$/i.test(file.name)) || file.size > 20*1024*1024 || !file.size)) {
        errorNode.textContent = 'Choose image files up to 20 MB each.'; return;
      }
      errorNode.textContent = '';
      files.forEach(file => photos.push({file,preview:URL.createObjectURL(file),path:`team-tasks/customer-promises/${userId}/${requestId}/${root.crypto.randomUUID()}.${/\.(png|webp|gif|heic|heif|jpe?g)$/i.exec(file.name)?.[1].toLowerCase() || 'jpg'}`}));
      renderPhotos();
    });
    form.elements.namedItem(username ? 'title' : 'buyerUsername').focus();
    dialog.addEventListener('cancel', event => {event.preventDefault(); close();});
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close();}
    });
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-buyer-task-close]')) close();
      if (event.target.closest('[data-buyer-task-retry]')) void loadPeople();
      const remove = event.target.closest('[data-remove-buyer-photo]');
      if (remove && !saving) {URL.revokeObjectURL(photos.splice(Number(remove.dataset.removeBuyerPhoto),1)[0].preview); renderPhotos();}
    });
    async function loadPeople() {
      const errorNode = form.querySelector('[data-buyer-task-error]');
      const retry = form.querySelector('[data-buyer-task-retry]');
      errorNode.textContent = ''; retry.hidden = true;
      try {
        const {data, error} = await client.rpc('list_team_task_assignees');
        if (error) throw error;
        if (!dialog || current !== generation) return;
        const people = (data || []).filter(person => person.user_id);
        if (!people.length) throw Error('No active people are available. Refresh and try again.');
        const owner = form.elements.namedItem('owner');
        owner.innerHTML = '<option value="">Choose a person</option>' + people.map(person => `<option value="${escape(person.user_id)}">${escape(person.display_name || person.email || 'Staff member')}${person.user_id === userId ? ' (you)' : ''}</option>`).join('');
        owner.value = people.some(person => person.user_id === userId) ? userId : '';
        owner.disabled = false; form.querySelector('[type="submit"]').disabled = false;
      } catch (error) {
        if (!dialog || current !== generation) return;
        errorNode.textContent = error.message || 'Could not load people.'; retry.hidden = false;
      }
    }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (saving || !form.reportValidity()) return;
      const values = new FormData(form);
      const buyer = String(values.get('buyerUsername') || '').trim().toLowerCase();
      const title = String(values.get('title') || '').trim();
      const instructions = String(values.get('instructions') || '').trim();
      const errorNode = form.querySelector('[data-buyer-task-error]');
      if (!buyer || /[\s<>/@]/.test(buyer)) {errorNode.textContent = 'Enter the exact eBay username, without a name, @ sign or profile URL.'; return;}
      if (!title || !instructions) {errorNode.textContent = 'Add a title and specific instructions.'; return;}
      saving = true; errorNode.textContent = '';
      form.querySelectorAll('button,input,textarea,select').forEach(el => {el.disabled = true;});
      form.querySelector('[type="submit"]').textContent = 'Saving…';
      try {
        const attachments = [];
        for (const photo of photos) {
          if (!photo.saved) {
            const {error} = await client.storage.from('team-task-evidence').upload(photo.path, photo.file, {contentType:photo.file.type || 'image/heic',upsert:false});
            // A lost upload response may leave this unique object stored already.
            if (error && String(error.statusCode) !== '409' && error.error !== 'Duplicate') throw error;
            photo.saved = {bucket:'team-task-evidence',path:photo.path,label:photo.file.name,mime_type:photo.file.type || 'image/heic',media_type:'image',size_bytes:photo.file.size};
          }
          attachments.push(photo.saved);
        }
        const {data, error} = await client.rpc('create_buyer_followup_task', {
          _buyer_username: buyer, _request_id: requestId,
          _details: {_title:title, _description:instructions, _assigned_to_user_id:values.get('owner'), _priority:values.get('priority'), _photo_attachments:attachments,
            ...(origin.conversationId ? {_conversation_id:origin.conversationId,_message_id:origin.messageId || null} : {})}
        });
        if (error) throw error;
        if (!data?.id) throw Error('No saved task was returned. Retry to confirm the save.');
        form.innerHTML = `<div class="buyer-task-heading"><h2 id="buyer-task-heading">Customer task saved</h2></div>
          <p>Saved for <strong>${escape(buyer)}</strong>. Pending Orders will require a signed certification, or admin permission to defer this promise.</p>
          <p>${escape(instructions)}</p><div class="buyer-task-actions"><a href="team-tasks.html?taskId=${encodeURIComponent(data.id)}" target="_blank" rel="noopener">Open task ↗</a><button type="button" data-buyer-task-close>Done</button></div>`;
        form.querySelector('[data-buyer-task-close]').focus();
        Promise.resolve().then(() => onSaved?.(data)).catch(error => console.warn('Customer task saved; refresh the task list:', error));
      } catch (error) {
        errorNode.textContent = error.message || 'Could not save. Your instructions are kept—please retry.';
        form.querySelectorAll('button,input,textarea,select').forEach(el => {el.disabled = false;});
        form.querySelector('[type="submit"]').textContent = 'Save customer task';
      } finally {saving = false;}
    });
    await loadPeople();
  }
  function init(options) {
    client = options.client; userId = options.userId; onSaved = options.onSaved;
  }
  function attachSource(taskId, username) {
    if (!client || dialog) return;
    opener = document.activeElement;
    dialog = document.createElement('dialog'); dialog.className = 'buyer-task-dialog';
    dialog.setAttribute('aria-labelledby','buyer-task-heading');
    dialog.innerHTML = `<form class="buyer-task-form"><div class="buyer-task-heading"><h2 id="buyer-task-heading">Link original conversation</h2></div>
      <p>Link the message behind the promise for <strong>${escape(username)}</strong>. The conversation must belong to this exact customer.</p>
      <label>Conversation link or ID<input name="sourceLink" required autocomplete="off" placeholder="Paste an Invsto conversation link or conversation ID" /></label>
      <p class="buyer-task-error" role="status"></p><div class="buyer-task-actions"><button type="button" data-buyer-task-close>Cancel</button><button type="submit">Save conversation link</button></div></form>`;
    document.body.append(dialog); viewport(); dialog.showModal();
    const form = dialog.querySelector('form'); form.elements.sourceLink.focus();
    dialog.addEventListener('cancel',event=>{event.preventDefault();close();});
    dialog.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close();}});
    dialog.addEventListener('click',event=>{if(event.target.closest('[data-buyer-task-close]'))close();});
    form.addEventListener('submit',async event=>{
      event.preventDefault(); if(saving || !form.reportValidity())return;
      const errorNode=form.querySelector('[role="status"]');
      try {
        const value=form.elements.sourceLink.value.trim();
        const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
        const url=uuid.test(value)?null:new URL(value,root.location.href);
        if(url && (url.origin!==root.location.origin || !url.pathname.endsWith('/email-triage.html')))throw Error('Use an Invsto Messages conversation link.');
        const conversationId=url?url.searchParams.get('ebayConversationDbId'):value;
        const messageId=url?.searchParams.get('ebayMessageDbId') || null;
        if(!uuid.test(conversationId || '') || (messageId && !uuid.test(messageId)))throw Error('The link needs the original conversation ID.');
        saving=true; form.querySelectorAll('button,input').forEach(el=>el.disabled=true); errorNode.textContent='Saving…';
        const {data,error}=await client.rpc('attach_buyer_followup_message',{_task_id:taskId,_conversation_id:conversationId,_message_id:messageId});
        if(error)throw error;
        saving=false;close();await onSaved?.(data);
      }catch(error){errorNode.textContent=error.message || 'Could not save the conversation link.';}
      finally{saving=false;form.querySelectorAll('button,input').forEach(el=>el.disabled=false);}
    });
  }
  document.addEventListener('click', event => {
    const sourceTrigger=event.target.closest('[data-buyer-task-link-source]');
    if(sourceTrigger && !sourceTrigger.disabled){event.preventDefault();event.stopPropagation();attachSource(sourceTrigger.dataset.buyerTaskLinkSource,sourceTrigger.dataset.buyerUsername);return;}
    const trigger = event.target.closest('[data-buyer-task-username]');
    if (!trigger || trigger.disabled) return;
    event.preventDefault(); event.stopPropagation(); void open(trigger.dataset.buyerTaskUsername,{conversationId:trigger.dataset.buyerConversationId,messageId:trigger.dataset.buyerMessageId});
  }, true);
  root.visualViewport?.addEventListener('resize', viewport, {passive:true});
  root.OGBuyerTasks = {init, open, button};
})(window);
