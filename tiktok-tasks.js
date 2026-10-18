/* TikTok order tasks use the shared assignment, notification and signed task audit workflow. */
(() => {
  'use strict';
  let context, activeDialog;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function open(orders, lineId) {
    if (!orders.length || activeDialog?.open) return;
    const dialog = document.createElement('dialog');
    activeDialog = dialog;
    dialog.className = 'tk-detail tk-task-dialog';
    dialog.setAttribute('aria-labelledby', 'tk-task-title');
    dialog.innerHTML = `<button type="button" class="tk-close" data-close aria-label="Close task">×</button>
      <h2 id="tk-task-title">${lineId ? 'Create item task' : 'Create order task'}</h2>
      <form><fieldset disabled>
        <label>Order<select name="order" ${orders.length === 1 ? 'aria-readonly="true"' : ''}>${orders.map(o => `<option value="${esc(o.id)}">${esc(o.order_number)} · ${esc(o.buyer_username)}</option>`).join('')}</select></label>
        <div class="tk-task-context" data-context></div>
        <div class="tk-fields"><label>What do you need?<select name="kind"><option value="work">Work — do something</option><option value="decision">Decision — approval or instructions</option></select></label>
        <label>Assign to<select name="owner" required><option value="">Choose a person</option></select></label></div>
        <label>Task title<input name="title" required maxlength="180" placeholder="What needs to happen?"></label>
        <label>Instructions<textarea name="instructions" required maxlength="8000" rows="3" placeholder="Describe the work or decision needed"></textarea></label>
        <div class="tk-fields"><label>Priority<select name="priority"><option value="normal">Normal</option><option value="low">Low</option><option value="high">High</option><option value="urgent">Urgent</option></select></label><label>Due date (optional)<input name="due" type="datetime-local"></label></div>
        <p class="tk-task-help">The order and item details are saved with this task in Team Tasks, along with its assignment and audit history.</p>
        <button type="submit" class="primary-btn">Create task</button>
      </fieldset></form><p data-status role="status" aria-live="polite">Loading team members…</p>`;
    document.body.append(dialog);
    const form = dialog.querySelector('form'), fields = form.elements, fieldset = dialog.querySelector('fieldset');
    const status = dialog.querySelector('[data-status]');
    const order = () => orders.find(o => o.id === fields.order.value);
    const lines = () => (order()?.lines || []).filter(l => !lineId || l.id === lineId);
    const details = () => lines().map(l => `${l.title || 'Item'} · Qty ${l.quantity} · SKU ${l.seller_sku || l.sku_id || 'Unavailable'} · Line ${l.id}`);
    function renderContext() {
      dialog.querySelector('[data-context]').innerHTML = `<strong>${lineId ? 'This item only' : 'Whole order'} · ${lines().length} item ${lines().length === 1 ? 'line' : 'lines'}</strong><ul>${lines().map(l => `<li>${esc(l.title)} · Qty ${esc(l.quantity)} · SKU ${esc(l.seller_sku || l.sku_id || 'Unavailable')}</li>`).join('')}</ul>`;
    }
    fields.order.onchange = renderContext;
    renderContext();
    let saving = false;
    dialog.querySelector('[data-close]').onclick = () => { if (!saving) dialog.close(); };
    dialog.addEventListener('cancel', event => { if (saving) event.preventDefault(); });
    dialog.addEventListener('close', () => dialog.remove(), {once:true});
    form.onsubmit = async event => {
      event.preventDefault();
      if (saving || fieldset.disabled || !form.reportValidity()) return;
      const selected = order(), selectedLines = lines();
      if (!selected || !selectedLines.length) { status.textContent = 'This order has no matching item lines. Refresh the orders and try again.'; return; }
      const title = fields.title.value.trim(), instructions = fields.instructions.value.trim();
      if (!title || !instructions) { status.textContent = 'Enter a title and instructions for this task.'; return; }
      // Context is part of the original signed creation event, not just a transient UI label.
      const description = [`TikTok ${lineId ? 'item' : 'whole order'} task`, `Order: ${selected.order_number}`, `Buyer: ${selected.buyer_username}`, `Order ID: ${selected.id}`, ...details(), '', instructions].join('\n');
      const args = {_source:'team', _request_kind:fields.kind.value, _details:{
        _title:`TikTok ${selected.order_number} · ${title}`, _description:description,
        _task_type:'shipping', _assigned_to_user_id:fields.owner.value,
        _priority:fields.priority.value, _due_at:fields.due.value ? new Date(fields.due.value).toISOString() : null,
        _photo_attachments:[], _signed_by_email:context.user.email || null
      }};
      saving = true; fieldset.disabled = true; status.textContent = 'Creating task…';
      try {
        const {data, error} = await context.db.rpc('create_task_request', args);
        if (error) throw error;
        form.hidden = true;
        status.textContent = 'Task created. The assignment and order details are saved in its audit history.';
        const link = document.createElement('a'); link.className = 'tk-action'; link.textContent = 'Open task';
        link.href = 'team-tasks.html' + (data?.id ? '?taskId=' + encodeURIComponent(data.id) : '');
        link.target = '_blank'; link.rel = 'noopener'; status.after(link); link.focus();
      } catch (error) {
        status.textContent = error.message || 'Could not create the task. Please try again.';
        fieldset.disabled = false;
      } finally { saving = false; }
    };
    dialog.showModal();
    try {
      const {data, error} = await context.db.rpc('list_team_task_assignees');
      if (error) throw error;
      if (!dialog.isConnected) return;
      const people = (data || []).filter(p => p.user_id);
      fields.owner.innerHTML += people.map(p => `<option value="${esc(p.user_id)}">${esc(p.display_name || p.email || 'Team member')}${p.role ? ' · ' + esc(p.role) : ''}</option>`).join('');
      if (!people.length) throw Error('No active team members are available. Close this window and try again after a team member is activated.');
      fieldset.disabled = false; status.textContent = ''; fields.title.focus();
    } catch (error) {
      if (dialog.isConnected) status.textContent = 'Could not load team members. ' + (error.message || 'Close and try again.');
    }
  }

  function start(config) {
    if (context) return;
    context = config;
    document.addEventListener('click', event => {
      const button = event.target.closest('[data-tk-task-buyer],[data-tk-task-order]');
      if (!button) return;
      event.preventDefault();
      const history = new URLSearchParams(location.search).get('view') === 'history';
      const orders = context.getOrders().filter(o => button.dataset.tkTaskOrder
        ? o.id === button.dataset.tkTaskOrder
        : o.buyer_username.toLowerCase() === button.dataset.tkTaskBuyer && window.TikTokOrderQueue.closed(o) === history);
      void open(orders, button.dataset.tkTaskLine);
    });
  }
  window.TikTokTasks = {start};
})();
