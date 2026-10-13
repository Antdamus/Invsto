/* One customer-promise composer, shared by Messages, Pending Orders and Tasks. */
(function(root) {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let client, userId, onSaved, dialog, opener, saving = false, requestId, generation = 0;
  function button(username = '', label = 'Customer task') {
    return `<button type="button" class="buyer-task-launch" data-buyer-task-username="${escape(username)}">${escape(label)}</button>`;
  }
  function close() {
    if (saving) return;
    generation++;
    dialog?.close(); dialog?.remove(); dialog = null;
    opener?.isConnected && opener.focus({preventScroll:true});
  }
  function viewport() {
    if (dialog) dialog.style.setProperty('--buyer-task-height', `${Math.round(root.visualViewport?.height || root.innerHeight) - 24}px`);
  }
  async function open(username = '') {
    if (!client || dialog) return;
    opener = document.activeElement; requestId = root.crypto.randomUUID();
    const current = ++generation;
    dialog = document.createElement('dialog');
    dialog.className = 'buyer-task-dialog'; dialog.setAttribute('aria-labelledby', 'buyer-task-heading');
    dialog.innerHTML = `<form class="buyer-task-form">
      <div class="buyer-task-heading"><h2 id="buyer-task-heading">Customer task</h2><button type="button" data-buyer-task-close aria-label="Close customer task">×</button></div>
      <p>Save a promise for this customer's next order. Fulfillment requires signed certification. Only an admin can defer it to the next order.</p>
      <label>eBay username<input name="buyerUsername" value="${escape(username)}" maxlength="100" required autocomplete="off" autocapitalize="none" spellcheck="false" placeholder="Exact username, e.g. jewelrybuyer" /></label>
      <small>Matched exactly, ignoring capitalization. Visible to the fulfillment team.</small>
      <label>Task title<input name="title" maxlength="200" required placeholder="Include the promised replacement clasp" /></label>
      <label>Promise / instructions<textarea name="instructions" rows="4" maxlength="10000" required placeholder="Specify exactly what to include or do with their next order."></textarea></label>
      <div class="buyer-task-fields"><label>Responsible person<select name="owner" required disabled><option value="">Loading people…</option></select></label>
      <label>Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="urgent">Urgent</option><option value="low">Low</option></select></label></div>
      <p class="buyer-task-error" role="status" data-buyer-task-error></p>
      <div class="buyer-task-actions"><button type="button" data-buyer-task-retry hidden>Retry people</button><button type="button" data-buyer-task-close>Cancel</button><button type="submit" disabled>Save customer task</button></div>
    </form>`;
    document.body.append(dialog); viewport(); dialog.showModal();
    const form = dialog.querySelector('form');
    form.elements.namedItem(username ? 'title' : 'buyerUsername').focus();
    dialog.addEventListener('cancel', event => {event.preventDefault(); close();});
    dialog.addEventListener('keydown', event => {
      if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); close();}
    });
    dialog.addEventListener('click', event => {
      if (event.target.closest('[data-buyer-task-close]')) close();
      if (event.target.closest('[data-buyer-task-retry]')) void loadPeople();
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
        const {data, error} = await client.rpc('create_buyer_followup_task', {
          _buyer_username: buyer, _request_id: requestId,
          _details: {_title:title, _description:instructions, _assigned_to_user_id:values.get('owner'), _priority:values.get('priority')}
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
  document.addEventListener('click', event => {
    const trigger = event.target.closest('[data-buyer-task-username]');
    if (!trigger || trigger.disabled) return;
    event.preventDefault(); event.stopPropagation(); void open(trigger.dataset.buyerTaskUsername);
  }, true);
  root.visualViewport?.addEventListener('resize', viewport, {passive:true});
  root.OGBuyerTasks = {init, open, button};
})(window);
