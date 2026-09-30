(function () {
  'use strict';
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => value == null ? 'Amount not recorded' : Number(value).toLocaleString('en-US', {style:'currency',currency:'USD'});
  const open = line => ['pending','partially_fulfilled'].includes(line.line_status)
    && ['pending','partially_fulfilled'].includes(line.order?.status)
    && Number(line.fulfilled_quantity || 0) < Number(line.quantity);

  function mount({container, client, lot, onChange = () => {}, onSelect, initialSearch = ''}) {
    let disposed = false, generation = 0, busy = false, data = null, search = String(initialSearch).slice(0,120);
    container.classList.add('bag-order-links');
    container.innerHTML = `<h3>Pending order connection</h3><p>Find or link an order while this bag is still open. Linking does not close the bag or fulfill the order.</p>
      <div class="bag-order-current"></div><p class="bag-order-date-range"></p><form class="bag-order-search"><label>Search all pending orders<input type="search" maxlength="120" placeholder="Username, order number, title or amount" autocomplete="off"></label><button type="submit">Search orders</button></form>
      <p class="bag-order-status" role="status" aria-live="polite"></p><div class="bag-order-results"></div>`;
    const status = container.querySelector('.bag-order-status');
    const results = container.querySelector('.bag-order-results');
    const current = container.querySelector('.bag-order-current');
    const dateRange = container.querySelector('.bag-order-date-range');
    const form = container.querySelector('form');
    const input = form.querySelector('input');
    input.value = search;
    const live = () => !disposed && container.isConnected;
    function message(text, error = false) { status.textContent = text; status.classList.toggle('is-error', error); }
    function controls(disabled) { container.querySelectorAll('button,input').forEach(el => { el.disabled = disabled; }); }
    function render() {
      current.textContent = data.linked_line_id ? `${data.link_source}. Scan this bag again to recover the linked order.` : 'No saved order link yet.';
      dateRange.textContent = data.date_window_start && data.date_window_end
        ? `Suggested date range: ${new Date(data.date_window_start).toLocaleDateString()} – ${new Date(data.date_window_end).toLocaleDateString()}. Exact identities and saved links can appear outside it. Search below checks all pending orders.`
        : 'Dates help rank suggestions. Search below checks all pending orders, regardless of date.';
      results.replaceChildren();
      for (const match of data.matches || []) {
        const line = match.line, order = line.order || {}, linked = match.linked;
        const card = document.createElement('article');
        card.className = `bag-order-card${linked ? ' is-linked' : ''}`;
        card.innerHTML = `<strong>${escape(order.buyer_username || order.buyer_name || 'Buyer not recorded')}</strong>
          <span>${escape(order.order_number)} · ${escape(line.item_title)}</span>
          <small>${escape(money(line.sold_for))} per unit · Qty ${Number(line.quantity)} · ${escape(line.line_status)} · ${escape(order.sale_date ? new Date(order.sale_date).toLocaleDateString() : 'Date not recorded')}</small>
          <small>${escape((match.reasons || []).join(' · ') || 'Manual search result — review before linking')}</small><div class="bag-order-actions"></div>`;
        const actions = card.querySelector('.bag-order-actions');
        if (open(line)) {
          if (onSelect) {
            const view = document.createElement('button'); view.type = 'button'; view.textContent = 'View order';
            view.onclick = async () => {
              if (busy) return;
              try { await onSelect(line); } catch (error) { if (live()) message(error.message || 'Could not open order.', true); }
            };
            actions.append(view);
          } else {
            const view = document.createElement('a'); view.textContent = 'Open in Pending Orders';
            view.href = `pending-orders.html?bag=${encodeURIComponent(lot.lot_code)}&bagLine=${encodeURIComponent(line.id)}&bagSearch=${encodeURIComponent(order.order_number || '')}`;
            actions.append(view);
          }
          if (!linked && data.editable) {
            const link = document.createElement('button'); link.type = 'button'; link.textContent = data.saved_line_id ? 'Move bag link here' : 'Link bag';
            link.onclick = () => save(line.id); actions.append(link);
          }
        } else if (linked) {
          const history = document.createElement('a'); history.textContent = 'View Order History';
          history.href = `ebay-order-history.html?order=${encodeURIComponent(order.order_number || '')}`; actions.append(history);
        }
        if (linked && data.saved_line_id === line.id && data.editable) {
          const unlink = document.createElement('button'); unlink.type = 'button'; unlink.textContent = 'Remove saved link';
          unlink.onclick = () => save(null); actions.append(unlink);
        }
        results.append(card);
      }
    }
    async function load() {
      if (disposed) return null;
      const token = ++generation;
      data = null; results.replaceChildren(); current.textContent = ''; dateRange.textContent = ''; message('Looking for pending orders…');
      try {
        const response = await client.rpc('get_live_bag_order_matches', {_lot_id: lot.id, _search: search});
        if (response.error) throw response.error;
        if (!live() || token !== generation) return null;
        data = response.data; render(); onChange(data);
        message(data.matches?.length ? 'Review the buyer, item and price before linking. Up to 30 results are shown.' : 'No matching pending orders yet. Search manually, or refresh after the eBay order imports.');
        return data;
      } catch (error) {
        if (!live() || token !== generation) return null;
        data = null; onChange(null); message(error.message || 'Could not load order connections. Try again.', true);
        return null;
      }
    }
    async function save(lineId) {
      if (busy || !data || !live()) return;
      const expected = data.saved_line_id || null;
      busy = true; controls(true); message('Saving bag connection…');
      try {
        const response = await client.rpc('set_live_bag_order_link', {_lot_id:lot.id, _order_line_id:lineId, _expected_order_line_id:expected});
        if (response.error) throw response.error;
        if (!live()) return;
        const refreshed = await load();
        if (refreshed && live()) message(lineId ? 'Bag linked. The bag and order stay open.' : 'Saved link removed.');
      } catch (error) {
        if (live()) {
          // Re-read after conflicts; an old tab must not keep offering a stale link.
          await load();
          if (live()) message(error.message || 'Could not save the connection.', true);
        }
      } finally { busy = false; if (live()) controls(false); }
    }
    form.onsubmit = event => { event.preventDefault(); if (!busy) { search = input.value.trim(); load(); } };
    return {load, dispose() { disposed = true; ++generation; }};
  }
  window.bagOrderLinks = {mount, isOpen: open};
})();
