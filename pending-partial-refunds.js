/* A manager reviews a specific refund snapshot; normal fulfillment still applies. */
(() => {
  'use strict';
  const reviews = new Map();
  let dialog, current, saving = false, loading = false, sequence = 0;
  const manager = () => state.employee?.active === true && ['admin', 'manager'].includes(state.employee.role);
  const canonical = value => Array.isArray(value) ? value.map(canonical)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]))
    : value ?? null;
  const refundTransactions = finance => (Array.isArray(finance?.transactions) ? finance.transactions : [])
    .filter(t => String(t.transactionType || '').toUpperCase() === 'REFUND')
    .map(t => JSON.stringify(canonical(t))).sort();
  const statuses = values => [...new Set(values.map(v => String(v || '').trim().toUpperCase()).filter(Boolean))].sort();
  // Match the facts in ebay_refund_review_facts, plus the queue's status projections.
  // Loading labels, receipts or a newer sync timestamp must not expire an approval.
  function reviewFacts(row = {}) {
    const p = row.raw_payload || {}, order = p.order || {}, api = row.ebay_api_status || {};
    return {
      id: row.id, orderId: row.order_id, status: row.status, lineStatus: row.line_status,
      quantity: row.quantity, item: row.item_number, transaction: row.transaction_id,
      total: row.total_price, soldFor: row.sold_for, sourceTotal: order.pricingSummary?.total,
      // The queue repeats API statuses in a synthetic mismatch payload; detail
      // hydration removes that duplicate while retaining the API projection.
      payments: statuses([p.orderPaymentStatus, order.orderPaymentStatus, p.pending_order_sync_mismatch?.ebayPaymentStatus,
        p.api_order_status?.payment_status, order.paymentSummary?.payments?.[0]?.paymentStatus, api.payment_status]),
      cancellations: statuses([p.orderCancelStatus, order.cancelStatus?.cancelState, order.cancelStatus?.cancelStatus,
        p.pending_order_sync_mismatch?.ebayCancelStatus, p.api_order_status?.cancel_status,
        p.api_cancellation_case?.cancelStatus, p.cancellation_page_case?.cancelStatus, api.cancel_status]),
      refunds: order.paymentSummary?.refunds,
      transactions: [p.ebayFinance, row.ebay_finance, row.finance].map(refundTransactions),
    };
  }
  const key = line => JSON.stringify(canonical([reviewFacts(line), reviewFacts(getOrderFromLine(line))]));
  const orderId = line => line.order_id || getOrderFromLine(line).id;
  const cached = line => { const entry = reviews.get(line.id); return entry?.key === key(line) ? entry.review : null; };
  const approved = line => Boolean(cached(line)?.approval);
  const refund = line => /^Refund/.test(getLineFulfillmentBlockUnreviewed(line));
  async function load(lines) {
    const run = ++sequence;
    reviews.clear();
    const candidates = lines.filter(refund), ids = [...new Set(candidates.map(orderId).filter(Boolean))];
    const keys = new Map(candidates.map(line => [line.id, key(line)]));
    try {
      for (let i = 0; i < ids.length; i += 100) {
        const {data, error} = await supabase.rpc('get_ebay_partial_refund_reviews', {_order_ids: ids.slice(i, i + 100)});
        if (error) throw error;
        if (run !== sequence) return;
        for (const review of data || []) for (const line of candidates.filter(l => orderId(l) === review.order_id)) {
          reviews.set(line.id, {key: keys.get(line.id), review});
        }
      }
    } catch (error) {
      if (run === sequence) reviews.clear();
      console.warn('Partial refund reviews unavailable; refund blocks remain active.', error.message);
    }
  }
  function markup(line) {
    const review = cached(line);
    if (review?.approval) return `<span class="fulfillment-refund-approved" role="status" title="${escapeHtml(review.approval.reason)}">Partial refund approved · ${escapeHtml(review.approval.by)} · ${escapeHtml(formatDate(review.approval.at))}</span>`;
    if (!refund(line) || review?.reviewable === false) return '';
    if (['FULLY_REFUNDED','REFUNDED','REFUND_PENDING','PENDING_REFUND'].includes(getLineEbayApiStatus(line).paymentStatus)) return '';
    return manager()
      ? `<button type="button" class="secondary-btn buyer-line-action-btn" data-review-partial-refund="${escapeHtml(line.id)}">Review partial refund</button>`
      : '<small class="partial-refund-help">A manager can review a verified partial refund.</small>';
  }
  function install() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.id = 'partial-refund-dialog'; dialog.className = 'partial-refund-dialog';
    dialog.setAttribute('aria-labelledby', 'partial-refund-title');
    dialog.innerHTML = `<form method="dialog">
      <h2 id="partial-refund-title">Review partial refund</h2>
      <p id="partial-refund-order"></p><ul id="partial-refund-items"></ul>
      <p class="fulfillment-blocked">Verify the partial refund and remaining payment in eBay. Approval allows these items to be completed, labeled, and shipped. Orders reported as fully refunded, cancelled, or unpaid remain blocked.</p>
      <p>Refund history is preserved. Changed refund details or order items require a new review.</p>
      <a id="partial-refund-ebay" target="_blank" rel="noopener">Open order in eBay ↗</a>
      <label>Reason and verified refund amount<textarea id="partial-refund-reason" required minlength="3" maxlength="2000" rows="3" placeholder="Partial refund of $… for …; the customer is keeping the item and it should still ship."></textarea></label>
      <label class="partial-refund-confirm"><input id="partial-refund-verified" type="checkbox" required> I verified this is only a partial refund, payment remains, and these items should still ship.</label>
      <label>Your password<input id="partial-refund-password" type="password" autocomplete="current-password" required></label>
      <p id="partial-refund-error" role="alert"></p>
      <div class="modal-actions"><button id="partial-refund-cancel" type="button" class="secondary-btn">Cancel</button><button id="partial-refund-approve" type="submit" class="primary-btn">Approve partial refund</button></div>
      <p>Signed by your account. After approval, use Complete order to review the items, photos, and inventory.</p>
    </form>`;
    document.body.append(dialog);
    dialog.querySelector('form').addEventListener('submit', event => { event.preventDefault(); void confirm(); });
    dialog.querySelector('#partial-refund-cancel').onclick = () => { if (!saving) close(); };
    dialog.addEventListener('cancel', event => { event.preventDefault(); if (!saving) close(); });
    dialog.addEventListener('close', () => { if (!dialog.open) { dialog.querySelector('#partial-refund-password').value = ''; current = null; } });
  }
  function close() { dialog.querySelector('#partial-refund-password').value = ''; current = null; dialog.close(); }
  async function open(line) {
    if (!manager() || saving || loading || state.busy) return;
    loading = true;
    try {
      const {data, error} = await supabase.rpc('get_ebay_partial_refund_reviews', {_order_ids: [orderId(line)]});
      if (error) throw error;
      const review = data?.[0];
      if (!review?.reviewable) throw Error(review?.blocked_reason || 'No reviewable refund found. Refresh the order.');
      install(); current = review;
      dialog.querySelector('form').reset();
      dialog.querySelector('#partial-refund-error').textContent = '';
      dialog.querySelector('#partial-refund-order').textContent = `Order ${review.order_number} · ${review.items.length} item line(s)`;
      dialog.querySelector('#partial-refund-items').innerHTML = review.items.map(item => `<li>${escapeHtml(item.title)} · Qty ${escapeHtml(item.quantity)}</li>`).join('');
      dialog.querySelector('#partial-refund-ebay').href = `https://www.ebay.com/sh/ord/details?orderid=${encodeURIComponent(review.order_number)}`;
      dialog.showModal();
    } catch (error) { setStatus(error.message || 'Could not open the partial refund review.', 'error'); }
    finally { loading = false; }
  }
  async function confirm() {
    if (saving || !current || !manager() || state.busy) return;
    const reason = dialog.querySelector('#partial-refund-reason').value.trim();
    const password = dialog.querySelector('#partial-refund-password').value;
    const confirmed = dialog.querySelector('#partial-refund-verified').checked;
    const errorEl = dialog.querySelector('#partial-refund-error');
    if (reason.length < 3 || !confirmed || !password) { errorEl.textContent = 'Enter a reason, confirm the partial refund, and enter your password.'; return; }
    const review = current, actor = state.user?.id, email = state.user?.email;
    saving = true; state.busy = true;
    dialog.querySelectorAll('button,input,textarea').forEach(el => el.disabled = true);
    errorEl.textContent = '';
    let saved = false;
    try {
      const {data, error} = await supabase.auth.signInWithPassword({email, password});
      if (error || data?.user?.id !== actor) throw Error('Incorrect password or signed-in account changed. Try again.');
      const response = await supabase.rpc('approve_ebay_partial_refund', {_order_id: review.order_id, _snapshot: review.snapshot, _reason: reason, _confirmed: true});
      if (response.error) throw response.error;
      saved = true;
      close();
      await loadOrders();
      setStatus(`Partial refund approved for ${review.order_number}. Review the items using Complete order. The approval was saved in the audit history.`, 'info');
    } catch (error) {
      if (saved) setStatus('Partial refund approval was saved. Refresh the queue before completing the order.', 'info');
      else errorEl.textContent = error.message || 'Could not approve this partial refund.';
    } finally {
      dialog.querySelector('#partial-refund-password').value = '';
      dialog.querySelectorAll('button,input,textarea').forEach(el => el.disabled = false);
      saving = false; state.busy = false;
    }
  }
  window.OGPartialRefunds = {load, approved, markup, open};
})();
