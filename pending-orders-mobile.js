// Phone presentation only. All order actions use the existing checkout handlers.
(() => {
  const media = window.matchMedia('(max-width: 760px)');
  const byId = id => document.getElementById(id);
  const tools = [];
  let returnFocus, queued = false;
  const text = (element, value) => { if (element && element.textContent !== value) element.textContent = value; };
  const isPhone = () => media.matches && !document.body.classList.contains('phone-camera-mode');

  function closeTools({ restoreFocus = true } = {}) {
    byId('phone-packing-tools-modal')?.classList.add('hidden');
    document.body.classList.remove('phone-tools-open');
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  }

  function openTools() {
    if (!isPhone()) return;
    if (!byId('phone-packing-tools-modal')?.classList.contains('hidden')) return;
    returnFocus = document.activeElement;
    byId('phone-packing-tools-modal')?.classList.remove('hidden');
    document.body.classList.add('phone-tools-open');
    byId('phone-close-packing-tools')?.focus({ preventScroll: true });
  }

  function dismissCheckout() {
    if (state.busy) return;
    byId('fulfillment-workflow')?.classList.add('hidden');
    document.body.classList.remove('pending-order-detail-open', 'pending-mobile-sheet-open');
    sync();
    const card = [...document.querySelectorAll('.buyer-order-card')].find(card => card.dataset.buyerKey === state.activeBuyerKey);
    card?.querySelector('[data-buyer-expand-key]')?.focus({ preventScroll: true });
  }

  function sync() {
    const countIds = {overdue: 'summary-overdue-orders', today: 'summary-today-orders', tomorrow: 'summary-tomorrow-orders'};
    const loading = /Loading|Checking|Unavailable/i.test(byId('summary-pending')?.textContent || '');
    text(document.querySelector('[data-phone-count="all"]'), loading ? '—' : groupLinesByBuyer(state.orders.filter(isOpenOrderLine)).length.toLocaleString());
    Object.entries(countIds).forEach(([key, id]) => text(document.querySelector(`[data-phone-count="${key}"]`), loading ? '—' : byId(id)?.textContent.match(/[\d,]+/)?.[0] || '0'));
    const select = byId('checkout-store-select');
    text(byId('phone-packing-store')?.querySelector('span'), select?.value ? select.selectedOptions[0]?.textContent || 'Store' : 'Select store');
    const selectedCount = state.adminSelectedLineIds.size;
    text(byId('phone-selection-count'), String(selectedCount));
    byId('phone-selection-count')?.classList.toggle('hidden', !selectedCount);
    const workflowOpen = !byId('fulfillment-workflow')?.classList.contains('hidden');
    const staged = state.stagedFulfillments.size;
    const showDock = isPhone() && !!state.selectedLine && (workflowOpen || staged > 0);
    byId('phone-checkout-dock')?.classList.toggle('hidden', !showDock);
    document.body.classList.toggle('phone-has-checkout', showDock);
    text(byId('phone-checkout-count'), staged ? `${staged} item${staged === 1 ? '' : 's'} staged` : 'Ready to pack');
    text(byId('phone-checkout-buyer'), state.selectedLine ? getBuyerLabel(state.selectedLine) : '');
    const review = byId('phone-review-checkout');
    text(review, workflowOpen ? (staged ? 'Review bundle →' : 'Find an item →') : 'Resume packing →');
    if (review) review.disabled = state.busy || (workflowOpen && byId('fulfill-order')?.disabled);
    const filtersActive = byId('order-status-filter')?.value !== 'pending' || byId('order-created-date-filter')?.value || byId('order-sort')?.value !== 'created_asc';
    byId('phone-order-filters')?.classList.toggle('is-active', !!filtersActive);
  }

  function scheduleSync() {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; sync(); });
  }

  function decorateCards() {
    document.querySelectorAll('.buyer-order-card:not([data-phone-ready])').forEach(card => {
      card.dataset.phoneReady = 'true';
      const expanded = card.querySelector('.buyer-card-expanded-actions');
      if (!expanded) return;
      const more = document.createElement('button');
      more.type = 'button'; more.className = 'phone-only phone-more-actions';
      more.textContent = 'More actions'; more.setAttribute('aria-expanded', 'false');
      more.addEventListener('click', event => {
        event.stopPropagation();
        const open = card.classList.toggle('phone-actions-open');
        more.setAttribute('aria-expanded', String(open));
        more.textContent = open ? 'Fewer actions' : 'More actions';
      });
      expanded.append(more);
      [['[data-buyer-complete-key]', 'Pack order'], ['[data-buyer-no-inventory-key]', 'No inventory']].forEach(([selector, label]) => {
        const button = card.querySelector(selector);
        if (!button) return;
        const original = document.createElement('span'); original.className = 'phone-desktop-label'; original.textContent = button.textContent;
        const compact = document.createElement('span'); compact.className = 'phone-only'; compact.textContent = label;
        button.replaceChildren(original, compact);
      });
      card.querySelectorAll('.buyer-line-btn').forEach(line => {
        const actions = document.createElement('div'); actions.className = 'phone-only phone-line-actions';
        const pack = document.createElement('button'); pack.type = 'button'; pack.className = 'secondary-btn'; pack.textContent = 'Pack item';
        pack.disabled = !state.orders.some(entry => entry.id === line.dataset.lineId && isOpenOrderLine(entry));
        pack.addEventListener('click', event => { event.stopPropagation(); selectOrderLine(line.dataset.lineId); });
        const details = document.createElement('button'); details.type = 'button'; details.className = 'secondary-btn'; details.textContent = 'Item actions'; details.setAttribute('aria-expanded', 'false');
        details.addEventListener('click', event => {
          event.stopPropagation();
          const open = line.classList.toggle('phone-line-open');
          details.setAttribute('aria-expanded', String(open)); details.textContent = open ? 'Fewer actions' : 'Item actions';
        });
        actions.append(pack, details); line.querySelector('.buyer-line-main')?.append(actions);
      });
    });
  }

  function syncLayout() {
    const container = byId('phone-packing-tools-content');
    tools.forEach(({element, anchor}) => {
      if (isPhone()) container.append(element);
      else anchor.after(element);
    });
    if (!isPhone()) closeTools({restoreFocus: false});
    byId('order-search').placeholder = isPhone() ? 'Search buyer, order or item…' : 'Search order, title, buyer, item number...';
    sync();
  }

  function init() {
    if (!byId('phone-orders-tools') || document.body.classList.contains('phone-camera-mode')) return;
    ['.fulfillment-utility-strip', '#jump-latest-found', '#order-import-panel', '#admin-order-actions-panel', '#extension-updates'].forEach(selector => {
      const element = document.querySelector(selector);
      if (!element) return;
      const anchor = document.createComment('Desktop packing tools position');
      element.before(anchor); tools.push({element, anchor});
    });
    byId('phone-orders-tools').addEventListener('click', openTools);
    byId('phone-packing-store').addEventListener('click', openTools);
    byId('phone-close-packing-tools').addEventListener('click', () => closeTools());
    byId('phone-orders-refresh').addEventListener('click', () => byId('refresh-orders')?.click());
    byId('phone-orders-menu').addEventListener('click', () => byId('menu-toggle')?.click());
    new MutationObserver(() => byId('phone-orders-menu').setAttribute('aria-expanded', String(byId('mobile-menu').classList.contains('show'))))
      .observe(byId('mobile-menu'), {attributes: true, attributeFilter: ['class']});
    byId('phone-order-filters').addEventListener('click', event => {
      const open = document.querySelector('.orders-panel').classList.toggle('phone-filters-open');
      event.currentTarget.setAttribute('aria-expanded', String(open));
    });
    document.querySelectorAll('[data-phone-packing-target]').forEach(button => button.addEventListener('click', () => {
      byId(button.dataset.phonePackingTarget)?.scrollIntoView({block: 'start', behavior: 'smooth'});
    }));
    byId('phone-review-checkout').addEventListener('click', () => {
      if (byId('fulfillment-workflow').classList.contains('hidden')) {
        byId('fulfillment-workflow').classList.remove('hidden'); openMobileOrderDetail(); sync();
      } else if (!state.stagedFulfillments.size) {
        byId('checkout-item-scan')?.scrollIntoView({block: 'start'});
        byId('item-scan')?.focus({preventScroll: true});
      } else byId('fulfill-order')?.click();
    });
    byId('phone-packing-tools-modal').addEventListener('click', event => {
      if (event.target === event.currentTarget) closeTools();
    });
    // Let the existing admin buttons open their own dialogs above the queue.
    byId('phone-packing-tools-content').addEventListener('click', event => {
      if (event.target.closest('#admin-mark-packed-no-stock, #admin-mark-cancelled, #jump-latest-found')) closeTools({restoreFocus: false});
    }, true);
    byId('phone-packing-tools-modal').addEventListener('keydown', event => {
      if (event.key === 'Escape') { event.preventDefault(); closeTools(); }
      if (event.key !== 'Tab') return;
      const focusable = [...event.currentTarget.querySelectorAll('button,select,input,textarea,a[href],summary')].filter(el => !el.disabled && el.getClientRects().length);
      const first = focusable[0], last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    });
    const observer = new MutationObserver(scheduleSync);
    ['summary-strip', 'buyer-bundle-panel', 'checkout-store-select', 'admin-order-selected-count', 'buyer-remaining-count'].forEach(id => {
      if (byId(id)) observer.observe(byId(id), {childList: true, subtree: true, characterData: true});
    });
    observer.observe(byId('fulfillment-workflow'), {attributes: true, attributeFilter: ['class']});
    observer.observe(byId('fulfill-order'), {attributes: true, attributeFilter: ['disabled']});
    new MutationObserver(decorateCards).observe(byId('orders-list'), {childList: true});
    document.addEventListener('change', scheduleSync);
    media.addEventListener('change', syncLayout);
    decorateCards(); syncLayout();
  }
  window.PendingOrdersMobile = {openTools, closeTools, dismissCheckout, sync: scheduleSync};
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
