// Responsive presentation for History and Stock. Original controls retain their
// event handlers and permissions, and return to their desktop homes on resize.
(() => {
  const page = document.body.dataset.phonePage;
  if (!page) return;
  const media = matchMedia('(max-width: 760px)');
  const byId = id => document.getElementById(id);
  const moves = [];
  let scheduled = false, scrollToStock = false;
  const setText = (el, text) => { if (el && el.textContent !== text) el.textContent = text; };

  function move(selector, destination) {
    const node = document.querySelector(selector);
    if (!node || !destination) return;
    const anchor = document.createComment('phone control home');
    node.before(anchor);
    moves.push({node, anchor, destination});
  }

  function sheet(name, title, subtitle) {
    const dialog = document.createElement('dialog');
    dialog.id = `phone-${name}-sheet`;
    dialog.className = 'phone-workspace-sheet';
    dialog.setAttribute('aria-labelledby', `phone-${name}-title`);
    dialog.innerHTML = `<header><div><span class="phone-eyebrow">${page === 'stock' ? 'Your inventory' : 'Order history'}</span><h2 id="phone-${name}-title">${title}</h2></div><button type="button" data-close-sheet aria-label="Close ${title}">×</button></header><p class="phone-sheet-subtitle">${subtitle}</p><div class="phone-sheet-content"></div><footer><button type="button" data-close-sheet>Done</button></footer>`;
    document.body.append(dialog);
    dialog.querySelectorAll('[data-close-sheet]').forEach(button => button.addEventListener('click', () => dialog.close()));
    dialog.addEventListener('click', event => { if (event.target === dialog) dialog.close(); });
    dialog.addEventListener('close', () => document.body.classList.remove('phone-workspace-sheet-open'));
    return dialog;
  }

  function openSheet(name) {
    if (!media.matches) return;
    const dialog = byId(`phone-${name}-sheet`);
    dialog.showModal();
    document.body.classList.add('phone-workspace-sheet-open');
    dialog.querySelector('[data-close-sheet]').focus({preventScroll: true});
  }

  function arrange() {
    document.querySelectorAll('.phone-workspace-sheet[open]').forEach(dialog => dialog.close());
    moves.forEach(({node, anchor, destination}) => {
      if (media.matches) destination.append(node);
      else anchor.after(node);
    });
    decorateStock();
    sync();
  }

  function decorateStock() {
    if (page !== 'stock') return;
    document.querySelectorAll('#stock-container .stock-card').forEach((card, index) => {
      const content = card.querySelector('.stock-content');
      const controls = card.querySelector('.card-float-controls');
      if (controls) (media.matches ? content : card.querySelector('.stock-image-container')).append(controls);
      if (card.querySelector('.phone-stock-details-toggle')) return;
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'phone-stock-details-toggle phone-workspace-only';
      button.textContent = 'Details & actions'; button.setAttribute('aria-expanded', 'false');
      button.setAttribute('aria-label', `Details and actions for ${card.querySelector('h2')?.textContent || 'item'}`);
      button.addEventListener('click', event => {
        event.stopPropagation();
        const expanded = card.classList.toggle('phone-stock-expanded');
        button.setAttribute('aria-expanded', String(expanded));
        button.textContent = expanded ? 'Close details' : 'Details & actions';
      });
      content.append(button);
      card.querySelectorAll('.stock-metric-grid > span').forEach((metric, i) => { if (i === 1 || i === 2) metric.classList.add('phone-price-metric'); });
      // Always expose an accessible name, including when the icon font is late.
      card.querySelectorAll('.card-float-controls button').forEach(control => {
        if (control.title && !control.getAttribute('aria-label')) control.setAttribute('aria-label', control.title);
      });
      const checkbox = card.querySelector('.select-checkbox');
      if (checkbox) {
        checkbox.setAttribute('aria-label', `Select ${card.querySelector('h2')?.textContent || 'item'}`);
        const label = document.createElement('label'); label.className = 'phone-stock-select';
        checkbox.before(label); label.append(checkbox);
      }
    });
    if (scrollToStock && byId('stock-container')?.children.length) {
      scrollToStock = false;
      byId('stock-container').scrollIntoView({block: 'start'});
    }
  }

  function sync() {
    if (page === 'history') {
      setText(byId('phone-range'), [byId('history-from')?.value, byId('history-to')?.value].filter(Boolean).map(value => new Date(`${value}T12:00:00`).toLocaleDateString(undefined, {month: 'short', day: 'numeric'})).join(' – ') || 'Choose dates');
      ['shipped-orders', 'admin-closeouts', 'cancelled'].forEach(id => setText(document.querySelector(`[data-phone-stat="${id}"]`), byId(`summary-${id}`)?.textContent || '0'));
      const active = ['history-worker', 'history-status', 'history-label-filter', 'history-proof-filter', 'history-sort'].some(id => {
        const field = byId(id); return field && field.value !== field.options[0]?.value;
      });
      byId('phone-filter-button')?.classList.toggle('is-active', active);
    } else {
      setText(byId('phone-stock-count'), byId('filter-summary')?.textContent || 'Loading inventory…');
      const selected = byId('selected-count')?.textContent || '0';
      setText(byId('phone-stock-selection'), /[1-9]/.test(selected) ? `${selected.replace(/\s*selected.*/i, '')} selected · Tools` : '');
      byId('phone-stock-selection')?.classList.toggle('hidden', !/[1-9]/.test(selected));
      byId('phone-filter-button')?.classList.toggle('is-active', !!byId('header-filter-chips')?.children.length);
      setText(byId('phone-checkout-label'), document.body.classList.contains('checkout-mode-active') ? 'Exit checkout mode' : 'Enter checkout mode');
    }
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; sync(); });
  }

  function init() {
    const header = document.querySelector('.mobile-header');
    if (!header || byId('phone-workspace-overview')) return;
    const title = page === 'history' ? 'Order history' : 'Stock';
    header.insertAdjacentHTML('beforeend', `<div class="phone-workspace-context phone-workspace-only"><small>OG JEWELRY</small><strong>${title}</strong></div><button type="button" id="phone-workspace-refresh" class="phone-workspace-only" aria-label="Refresh ${title}">↻</button><button type="button" id="phone-workspace-tools" class="phone-workspace-only">Tools</button>`);
    const overview = document.createElement('section');
    overview.id = 'phone-workspace-overview'; overview.className = 'phone-workspace-only';
    overview.innerHTML = `<div class="phone-overview-heading"><div><span class="phone-eyebrow">${page === 'history' ? 'THE ARCHIVE' : 'YOUR COLLECTION'}</span><h1>${page === 'history' ? 'Every order, in view.' : 'Find the right piece.'}</h1></div></div><div id="phone-primary-search"></div><div class="phone-quick-controls"><button type="button" id="phone-filter-button">Filters & sort</button>${page === 'history' ? '<button type="button" id="phone-range" aria-label="Change history date range">Choose dates</button>' : '<div id="phone-stock-favorite"></div>'}</div>${page === 'history' ? '<div id="phone-history-all-dates"></div><div class="phone-history-stats"><div><strong data-phone-stat="shipped-orders">0</strong><span>Orders shipped</span></div><div><strong data-phone-stat="admin-closeouts">0</strong><span>No-inventory lines</span></div><div><strong data-phone-stat="cancelled">0</strong><span>Canceled lines</span></div></div>' : '<p id="phone-stock-count" aria-live="polite">Loading inventory…</p><div id="phone-stock-chips"></div><button type="button" id="phone-stock-selection" class="hidden"></button>'}`;
    const main = document.querySelector(page === 'history' ? '.order-history-content' : '.stock-main');
    if (page === 'history') main.prepend(overview); else main.before(overview);
    const filters = sheet('filters', 'Filters & sort', page === 'history' ? 'Choose the dates and orders you want to see.' : 'Narrow your collection. Results update as you go.');
    const tools = sheet('tools', 'Workspace tools', page === 'history' ? 'Reports, proof and order management.' : 'Transfers, labels and inventory management.');
    const filterBody = filters.querySelector('.phone-sheet-content');
    const toolBody = tools.querySelector('.phone-sheet-content');
    byId('phone-filter-button').addEventListener('click', () => openSheet('filters'));
    byId('phone-range')?.addEventListener('click', () => openSheet('filters'));
    byId('phone-workspace-tools').addEventListener('click', () => openSheet('tools'));
    byId('phone-stock-selection')?.addEventListener('click', () => openSheet('tools'));
    byId('phone-workspace-refresh').addEventListener('click', async event => {
      const button = event.currentTarget; button.disabled = true;
      try {
        if (page === 'history') await loadOrderHistory();
        else if (typeof refreshInventoryUI === 'function') await refreshInventoryUI();
      } finally { button.disabled = false; schedule(); }
    });
    // Dismiss the top-layer sheet before an existing tool opens its own dialog.
    tools.addEventListener('click', event => {
      if (event.target.closest('.history-actions button, a, #open-storage-transfer, #open-store-transfer, #open-cgl-label, #open-ebay-sync-console, #manual-ebay-sale-btn, #toggle-checkout-mode, #bulk-delete, #bulk-export, #bulk-ebay-category')) tools.close();
    }, true);
    filters.addEventListener('click', event => {
      if (event.target.closest('.camera-scan-button, [data-camera-scan-button]')) filters.close();
    }, true);
    if (page === 'history') {
      // Move the whole label to retain its scanner wrapper.
      const searchLabel = byId('history-search')?.closest('label');
      if (searchLabel) { searchLabel.id = 'phone-history-search-label'; move('#phone-history-search-label', byId('phone-primary-search')); }
      byId('history-search').placeholder = 'Buyer, order, item or tracking…';
      move('.history-filter-toggle', byId('phone-history-all-dates'));
      move('.history-filters', filterBody);
      move('.history-actions', toolBody);
      move('#account-history-sync-status', toolBody);
      move('.history-summary-grid', toolBody);
      const summary = document.querySelector('.history-summary-grid');
      if (summary) new MutationObserver(schedule).observe(summary, {subtree: true, childList: true, characterData: true});
      document.querySelector('.history-filters').addEventListener('change', schedule);
    } else {
      move('.stock-quick-search-label', byId('phone-primary-search'));
      move('.top-controls > .camera-scan-button', byId('phone-primary-search'));
      move('.favorite-toggle', byId('phone-stock-favorite'));
      move('#filter-section', filterBody);
      const sortLabel = document.createElement('label'); sortLabel.className = 'phone-sort-label'; sortLabel.textContent = 'Sort by'; filterBody.prepend(sortLabel);
      byId('sort-select').querySelectorAll('option').forEach(option => {
        const label = document.querySelector(`#sortDropdownMenu [data-value="${option.value}"]`); if (label) option.textContent = label.textContent;
      });
      move('#sort-select', sortLabel);
      move('.page-size', filterBody);
      move('#deleted-items-toggle-wrap', filterBody);
      move('#clear-filters', filterBody);
      ['open-storage-transfer', 'open-store-transfer', 'open-cgl-label', 'open-ebay-sync-console', 'manual-ebay-sale-btn', 'toggle-checkout-mode', 'bulk-toolbar'].forEach(id => move(`#${id}`, toolBody));
      byId('toggle-checkout-mode').insertAdjacentHTML('beforeend', '<span id="phone-checkout-label" class="phone-workspace-only">Enter checkout mode</span>');
      move('#header-filter-chips', byId('phone-stock-chips'));
      const pagination = document.createElement('nav'); pagination.className = 'phone-workspace-only phone-stock-pagination'; pagination.setAttribute('aria-label', 'Stock pages'); main.after(pagination);
      move('#pagination-buttons', pagination);
      pagination.addEventListener('click', event => { if (event.target.closest('button')) scrollToStock = true; }, true);
      new MutationObserver(() => { decorateStock(); schedule(); }).observe(byId('stock-container'), {childList: true});
      ['filter-summary', 'selected-count', 'header-filter-chips'].forEach(id => new MutationObserver(schedule).observe(byId(id), {childList: true, subtree: true, characterData: true}));
      new MutationObserver(schedule).observe(document.body, {attributes: true, attributeFilter: ['class']});
      // Enter submits a search, never reloads the page or clears the cart.
      byId('stock-quick-search').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.dispatchEvent(new Event('change', {bubbles: true})); event.currentTarget.blur(); } });
    }
    media.addEventListener('change', arrange);
    arrange();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
