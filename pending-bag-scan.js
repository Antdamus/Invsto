/* Fast bag locating is independent of inventory checkout and its staged items. */
(() => {
  const byId = id => document.getElementById(id);
  let initialized = false, processing = false, waiting = false, saving = false, active = false, version = 0;
  let processingCode = '';
  let current = null, choose = null, inputTimer = null;
  const queue = [], recent = [];
  let choiceMatches = [];
  const escape = value => escapeHtml(String(value ?? ''));
  const isPending = line => line && ['pending', 'partially_fulfilled'].includes(line.line_status)
    && Number(line.fulfilled_quantity || 0) < Number(line.quantity);

  function normalize(value) {
    let code = String(value || '').trim();
    if (/^https?:\/\//i.test(code)) {
      try { code = new URL(code).searchParams.get('bag') || ''; } catch { code = ''; }
    }
    code = code.toUpperCase();
    if (!/^#?[A-Z0-9][A-Z0-9-]{0,119}$/.test(code)) throw new Error('Scan the bag label or enter its bag number.');
    return code;
  }

  function status(message, error = false) {
    for (const id of ['bag-scan-status', 'bag-scan-dock-status']) {
      const element = byId(id);
      if (element) { element.textContent = message; element.classList.toggle('is-error', error); }
    }
  }

  function refresh() {
    const dock = byId('bag-scan-dock');
    const visible = active;
    dock?.classList.toggle('hidden', !visible);
    document.body.classList.toggle('has-bag-scan', visible);
    const line = current && state.orders.find(line => line.id === current.line.id);
    const found = isItemFound(line || {});
    const review = current?.review;
    const photos = review?.photos || [];
    const attach = photos.some(photo => !photo.attached);
    const button = byId('bag-scan-found');
    if (button) {
      button.disabled = !line || !isPending(line) || (found && !attach) || processing || saving || itemSearchBusy.has(line.id)
        || current?.photoLoading || current?.photoError || review?.ambiguous || photos.some(photo => !photo.ready || photo.attached_elsewhere);
      button.textContent = saving ? 'Saving…' : attach ? 'Confirm & attach' : found ? '✓ Item found' : 'Item found';
    }
    byId('bag-scan-current').textContent = current ? `${current.code} · ${getBuyerLabel(current.line)}` : processing ? 'Finding your bag…' : 'Bag lookup';
    const next = byId('bag-scan-next');
    next.textContent = queue.length ? `Next bag (${queue.length}) →` : 'Scan next';
    next.disabled = processing || saving;
    if (byId('pending-scan-next')) byId('pending-scan-next').disabled = processing || saving || state.busy;
    byId('bag-scan-queued').textContent = queue.length ? `${queue.length} scan${queue.length === 1 ? '' : 's'} waiting` : '';
    byId('bag-scan-close').disabled = saving;
    byId('bag-scan-recent').disabled = processing || saving || waiting;
    renderBagPhotos();
  }

  function renderBagPhotos() {
    const entry = current;
    const lineId = current?.line.id;
    const row = [...document.querySelectorAll('.buyer-line-btn[data-line-id]')].find(row => row.dataset.lineId === lineId);
    document.querySelectorAll('[data-bag-review]').forEach(panel => { if (panel.dataset.bagReview !== lineId) panel.remove(); });
    if (!row || row.querySelector('[data-bag-review]')) return;
    const review = current.review, photos = review?.photos || [];
    if (!current.photoLoading && !current.photoError && !review?.ambiguous && !photos.length) return;
    const panel = document.createElement('section'); panel.className = 'bag-photo-review'; panel.dataset.bagReview = lineId;
    panel.setAttribute('aria-label', 'Scanned bag photos');
    const heading = document.createElement('strong'); heading.textContent = 'Photos from this bag'; panel.append(heading);
    const help = document.createElement('p'); panel.append(help);
    if (current.photoLoading) help.textContent = 'Checking bag photos…';
    else if (current.photoError) {
      help.textContent = 'Bag photos could not load. Try again before confirming.';
      const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'secondary-btn'; retry.textContent = 'Retry photos';
      retry.onclick = () => loadBagPhotos(current, version); panel.append(retry);
    } else if (review?.ambiguous) help.textContent = 'More than one bag has photos for this item. Scan the unique LIVE code on its label to choose the right bag.';
    else {
      heading.textContent = `Bag photos · ${photos.length}`;
      help.textContent = photos.some(photo => photo.attached_elsewhere) ? 'A photo is attached to another order. Review that connection before confirming.'
        : photos.every(photo => photo.attached) ? 'These photos are already attached to this order.'
        : 'Check these photos against the item and order. Confirm & attach saves them here and marks the item found.';
      const grid = document.createElement('div'); grid.className = 'bag-photo-review-grid'; panel.append(grid);
      photos.forEach((photo, index) => {
        const tile = document.createElement('button'); tile.type = 'button'; tile.className = 'bag-photo-review-tile';
        tile.setAttribute('aria-label', `Enlarge bag photo ${index + 1}`);
        const img = document.createElement('img'); img.alt = `Bag photo ${index + 1}`; img.src = photo.url;
        img.onload = () => {if (current === entry && panel.isConnected) {photo.ready = true; refresh();}};
        img.onerror = () => {if (current === entry && panel.isConnected) {photo.ready = false; entry.photoError = true; panel.remove(); refresh();}};
        const caption = document.createElement('span'); caption.textContent = `${photo.attached ? '✓ Attached · ' : ''}${formatDate(photo.captured_at)}`;
        tile.append(img, caption); tile.onclick = () => openEvidencePhotoObjectViewer({bucket:'photos',path:photo.photo_path,previewUrl:photo.url,
          label:`Bag photo ${index + 1}`,auditText:`Live photo · ${formatDate(photo.captured_at)}`}, 'bag-scan-found'); grid.append(tile);
      });
    }
    row.querySelector('.buyer-line-copy')?.append(panel);
  }

  async function loadBagPhotos(entry, run) {
    if (!entry) return;
    entry.photoLoading = true; entry.photoError = false; entry.review = null;
    document.querySelectorAll('[data-bag-review]').forEach(panel => panel.remove()); refresh();
    try {
      const {data,error} = await supabase.rpc('get_pending_bag_photo_review', {_scan:entry.code,_order_line_id:entry.line.id});
      if (error) throw error;
      const photos = await Promise.all((data?.photos || []).map(async photo => {
        const {data:signed,error} = await supabase.storage.from('photos').createSignedUrl(photo.photo_path,3600);
        if (error || !signed?.signedUrl) throw error || Error('Photo unavailable');
        return {...photo,url:signed.signedUrl,ready:false};
      }));
      if (run !== version || current !== entry) return;
      entry.review = {...data,photos};
    } catch {
      if (run !== version || current !== entry) return;
      entry.photoError = true;
    } finally {
      if (run === version && current === entry) {
        entry.photoLoading = false; document.querySelectorAll('[data-bag-review]').forEach(panel => panel.remove()); refresh();
        const panel = document.querySelector('[data-bag-review]');
        if (panel) panel.scrollIntoView({block:'center',behavior:'instant'});
      }
    }
  }

  async function confirmBagPhotos(entry) {
    const {data,error} = await supabase.rpc('confirm_pending_bag_photos', {_scan:entry.code,_lot_id:entry.review.bag.id,
      _order_line_id:entry.line.id,_photo_ids:entry.review.photos.map(photo => photo.id)});
    if (error) throw error;
    const line = state.orders.find(line => line.id === entry.line.id);
    if (line) line.item_search = data.item_search;
    if (data.task && data.event) {
      const taskIndex = state.queueVideoReceiptTasks.findIndex(task => task.id === data.task.id);
      if (taskIndex < 0) state.queueVideoReceiptTasks.push(data.task); else state.queueVideoReceiptTasks[taskIndex] = data.task;
      const photosByPath = new Map(entry.review.photos.map(photo => [photo.photo_path,photo]));
      const event = {...data.event,photo_attachments:data.event.photo_attachments.map(photo => ({...photo,
        previewUrl:photosByPath.get(photo.path)?.url,thumbnailUrl:photosByPath.get(photo.path)?.url}))};
      const events = state.queueVideoReceiptTaskEvents.get(data.task.id) || [];
      if (!events.some(saved => saved.id === event.id)) events.push(event);
      state.queueVideoReceiptTaskEvents.set(data.task.id,events);
      // The selected-task cache takes precedence over queue evidence for the same task.
      const selected = state.selectedOrderTasks.findIndex(task => task.id === data.task.id);
      if (selected >= 0) {state.selectedOrderTasks[selected]=data.task; state.selectedOrderTaskEvents.set(data.task.id,events);}
      state.sharedOrderNoteHistory.delete(entry.line.order_id);
      if (line) {line.line_note_count=getLineNoteCount(line)+1;line.latest_line_note=event.notes;}
    }
    entry.review.photos.forEach(photo => {photo.attached=true;});
    state.sharedOrderNoteHistory.delete(entry.line.order_id);
    if (!data.event) state.queueVideoReceiptLoadedOrderIds.delete(entry.line.order_id);
    document.querySelectorAll('[data-bag-review]').forEach(panel => panel.remove());
    renderOrders();
    void hydrateQueueVideoReceiptEvidenceThumbnails([line],{skipTaskLoad:Boolean(data.event)});
  }

  function renderRecent() {
    const select = byId('bag-scan-recent');
    select.innerHTML = '<option value="">Recent scans</option>' + recent.map((entry, index) =>
      `<option value="${index}">${index + 1}. ${escape(entry.code)} · ${escape(getBuyerLabel(entry.line))}</option>`).join('');
    select.classList.toggle('hidden', !recent.length);
  }

  async function navigate(line) {
    const run = version;
    if (!isPending(line)) throw new Error('This item is no longer pending. Scan another bag.');
    if (byId('order-status-filter').value === 'fulfilled') {
      byId('order-status-filter').value = 'pending';
      await loadOrders();
      if (run !== version) return;
    }
    const existing = state.orders.find(row => row.id === line.id);
    // Keep hydrated photos, notes and checkout data. Refresh only the matching line's status.
    if (existing) Object.assign(existing, {line_status: line.line_status, quantity: line.quantity,
      fulfilled_quantity: line.fulfilled_quantity, ...(line.item_search !== undefined ? {item_search: line.item_search} : {})});
    else state.orders.push(normalizeLine(line));
    const key = getBuyerKey(existing || line);
    clearLiveLotSelection({render: false});
    clearEbayLaunchFilter({apply: false});
    byId('order-search').value = '';
    byId('order-status-filter').value = 'pending';
    state.orderDueFilter = 'all';
    clearOrderCreatedDateFilter({apply: false});
    setBuyerGroupExpanded(key, true, {render: false});
    state.bagScanLineId = line.id;
    window.PendingOrdersMobile?.closeTools({restoreFocus: false});
    // Leave any staged bundle intact so packing can be resumed later.
    byId('fulfillment-workflow')?.classList.add('hidden');
    document.body.classList.remove('pending-order-detail-open', 'pending-mobile-sheet-open');
    applyOrderFilters();
    window.PendingOrdersMobile?.sync();
    await new Promise(resolve => {
      let attempts = 0;
      const focus = () => {
        if (run !== version) return resolve();
        const target = [...document.querySelectorAll('.buyer-line-btn[data-line-id]')].find(row => row.dataset.lineId === line.id);
        if (!target && ++attempts < 120) return requestAnimationFrame(focus);
        if (target) {
          target.classList.add('is-bag-scan-target');
          target.tabIndex = -1;
          target.scrollIntoView({block: 'center', behavior: 'instant'});
          target.focus({preventScroll: true});
        }
        resolve();
      };
      focus();
    });
  }

  function finishChoice(match) {
    if (!choose) return;
    const resolve = choose; choose = null;
    byId('bag-scan-choice').close();
    resolve(match);
  }

  async function loadChoicePhotos(matches, run) {
    const list = byId('bag-scan-choices');
    const uncached = matches.map(match => match.line.order_id).filter(id => !state.queueVideoReceiptLoadedOrderIds.has(id));
    try {
      await ensureQueueVideoReceiptTasksLoaded(matches.map(match => match.line));
      for (const [index, match] of matches.entries()) {
        if (run !== version || !choose) return;
        const host = list.querySelector(`[data-bag-photo="${index}"]`);
        const photos = getVideoReceiptEvidencePhotosForLine(match.line);
        if (!photos.length) { host.textContent = 'No screenshot saved'; continue; }
        const hydrated = await Promise.all(photos.slice(0, 3).map(photo => ensureEvidencePhotoPreviewUrls(photo)));
        if (run !== version || !choose || !host.isConnected) return;
        host.replaceChildren();
        for (const [photoIndex, photo] of hydrated.entries()) {
          const url = photo.previewUrl || photo.thumbnailUrl;
          if (!url) continue;
          const link = document.createElement('a');
          link.href = url; link.target = '_blank'; link.rel = 'noopener';
          link.setAttribute('aria-label', `Enlarge screenshot ${photoIndex + 1} for ${getBuyerLabel(match.line)}`);
          const image = document.createElement('img');
          image.src = photo.thumbnailUrl || url; image.alt = `Item screenshot ${photoIndex + 1}`; image.loading = 'lazy';
          image.addEventListener('error', () => { link.textContent = 'Open screenshot'; });
          link.append(image); host.append(link);
        }
        if (!host.children.length) host.textContent = 'Screenshot unavailable';
      }
    } catch {
      uncached.forEach(id => state.queueVideoReceiptLoadedOrderIds.delete(id));
      if (run !== version || !choose) return;
      list.querySelectorAll('[data-bag-photo]').forEach(host => {
        if (!host.children.length) host.textContent = 'Could not load screenshots';
      });
    }
  }

  function chooseMatch(matches, code, truncated) {
    choiceMatches = matches;
    byId('bag-scan-choice-title').textContent = `Which order is ${code}?`;
    byId('bag-scan-choice-help').textContent = truncated
      ? 'Showing the first 40 matches. Scan the unique QR on the bag to narrow this down, or verify the buyer and screenshot below.'
      : `${matches.length} matches. Check the buyer, item and screenshot, then choose the correct order.`;
    byId('bag-scan-choices').innerHTML = matches.map((match, index) => {
      const line = match.line, order = line.order || {};
      return `<article class="bag-scan-choice-card">
        <div class="bag-scan-photo-strip" data-bag-photo="${index}">Loading screenshots…</div>
        <div class="bag-scan-choice-copy"><strong>${escape(getBuyerLabel(line))}</strong>
          <p>${escape(line.item_title || 'Untitled item')}</p>
          <dl><div><dt>Order</dt><dd>${escape(order.order_number || '—')}</dd></div>
            <div><dt>Sale</dt><dd>${escape(formatDate(order.sale_date || order.paid_on_date))}</dd></div>
            <div><dt>Item</dt><dd>${escape(line.item_number || '—')}</dd></div>
            <div><dt>Price · Qty</dt><dd>${escape(formatMoney(line.sold_for))} · ${escape(line.quantity)}</dd></div></dl>
          <button type="button" class="primary-btn" data-bag-choice="${index}">Open this order →</button>
        </div></article>`;
    }).join('');
    const promise = new Promise(resolve => { choose = resolve; });
    byId('bag-scan-choice').showModal();
    byId('bag-scan-choice-cancel').focus();
    void loadChoicePhotos(matches, version);
    return promise;
  }

  async function processNext() {
    if (processing || saving || !queue.length) return;
    processing = active = true; waiting = false; current = null;
    state.bagScanLineId = '';
    document.querySelectorAll('.is-bag-scan-target').forEach(row => row.classList.remove('is-bag-scan-target'));
    const code = queue.shift(), run = ++version;
    processingCode = code;
    status(`Finding ${code}…`); refresh();
    try {
      const {data, error} = await supabase.rpc('find_pending_order_bag', {_scan: code});
      if (run !== version) return;
      if (error) throw new Error(error.message || 'Could not look up this bag. Try scanning again.');
      const matches = [...new Map((data?.matches || []).filter(match => isPending(match.line)).map(match => [match.line.id, match])).values()];
      if (!matches.length) throw new Error(data?.linked_closed
        ? 'This bag’s linked item is already closed. It has not been reopened.'
        : 'No pending item matches this bag. Check the number, or search the buyer in the order queue.');
      const match = matches.length === 1 && !data?.truncated ? matches[0] : await chooseMatch(matches, code, data?.truncated);
      if (run !== version) return;
      if (!match) { status(`Skipped ${code}. Scan another bag when ready.`); return; }
      await navigate(match.line);
      if (run !== version) return;
      current = {code, line: match.line};
      recent.push(current); if (recent.length > 30) recent.shift();
      renderRecent();
      status(`Opened ${match.line.order?.order_number || 'order'} · ${match.line.item_title || 'Item'}`);
      void loadBagPhotos(current, run);
    } catch (error) {
      if (run === version) status(error.message || 'Bag lookup failed. Try again.', true);
    } finally {
      if (run === version) { processing = false; waiting = !!queue.length; refresh(); }
    }
  }

  function enqueue(value) {
    clearTimeout(inputTimer);
    if (state.busy) { status('Finish the current save, then scan your bag.', true); return; }
    let code;
    try { code = normalize(value); } catch (error) { status(error.message, true); return; }
    // Camera input + Enter, and hardware scanners with Enter suffixes, submit just once.
    if (queue.includes(code) || (processing && processingCode === code)) return;
    byId('pending-bag-scan').value = '';
    queue.push(code);
    refresh();
    if (!processing && !waiting && !saving) return processNext();
  }

  function focusScanner() {
    if (state.busy || saving || processing) return;
    window.PendingOrdersMobile?.closeTools({restoreFocus: false});
    // Navigation only: keep staged checkout items, bag photos and queued scans.
    byId('fulfillment-workflow')?.classList.add('hidden');
    document.body.classList.remove('pending-order-detail-open', 'pending-mobile-sheet-open');
    window.PendingOrdersMobile?.sync();
    byId('pending-bag-scan').scrollIntoView({block: 'center', behavior: 'instant'});
    byId('pending-bag-scan').focus({preventScroll: true});
  }

  function nextBag() {
    if (state.busy || saving || processing) return;
    window.OGTaskNotifications?.dismiss();
    return queue.length ? processNext() : focusScanner();
  }

  function reset() {
    if (saving) return;
    clearTimeout(inputTimer); clearLiveLotSearchTimer();
    byId('pending-bag-scan').value = '';
    window.PendingOrdersMobile?.closeTools({restoreFocus: false});
    ++version; finishChoice(null); queue.length = 0;
    processing = waiting = active = false; current = null; state.bagScanLineId = '';
    document.querySelectorAll('.is-bag-scan-target').forEach(row => row.classList.remove('is-bag-scan-target'));
    status('Scan a bag to open its order.'); refresh(); focusScanner();
  }

  function init() {
    if (initialized || !byId('pending-bag-scan')) return;
    initialized = true;
    byId('bag-scan-form').addEventListener('submit', event => { event.preventDefault(); enqueue(byId('pending-bag-scan').value); });
    byId('pending-bag-scan').addEventListener('input', () => {
      clearTimeout(inputTimer);
      const value = byId('pending-bag-scan').value.trim();
      if (value) inputTimer = setTimeout(() => enqueue(value), 700);
    });
    byId('bag-scan-next').addEventListener('click', nextBag);
    byId('pending-scan-next')?.addEventListener('click', nextBag);
    byId('bag-scan-close').addEventListener('click', reset);
    byId('bag-scan-found').addEventListener('click', async () => {
      if (!current || processing || saving || state.busy || !isPending(state.orders.find(line => line.id === current.line.id))) return;
      if (byId('bag-scan-found').disabled) return;
      const id = current.line.id, entry = current;
      saving = true; refresh();
      try {
        if (entry.review?.photos?.length) await confirmBagPhotos(entry);
        else await setItemMissing(id, false);
      } catch (error) {
        saving = false; status(error.message || 'Could not save. Review and try again.', true); refresh(); return;
      }
      saving = false;
      const saved = state.orders.find(line => line.id === id);
      if (isItemFound(saved || {})) {
        status(entry.review?.photos?.length ? '✓ Photos attached · item found. Ready for the next bag.' : '✓ Item found. Ready for the next bag.');
        refresh();
        if (queue.length) void processNext();
      } else { status('Could not mark the item found. Please try again.', true); refresh(); }
    });
    byId('bag-scan-recent').addEventListener('change', async event => {
      if (event.target.value === '' || processing || saving || waiting) return;
      const entry = recent[Number(event.target.value)];
      if (!entry) return;
      const line = state.orders.find(line => line.id === entry.line.id);
      if (!isPending(line)) { status('This item is no longer pending.', true); return; }
      ++version; active = true; current = {...entry, line}; await navigate(line);
      status(`Opened ${line.order?.order_number || 'order'} · ${line.item_title}`); refresh();
      void loadBagPhotos(current, version);
    });
    byId('bag-scan-choice-cancel').addEventListener('click', () => finishChoice(null));
    byId('bag-scan-choice').addEventListener('cancel', event => { event.preventDefault(); finishChoice(null); });
    byId('bag-scan-choices').addEventListener('click', event => {
      const button = event.target.closest('[data-bag-choice]');
      if (button) finishChoice(choiceMatches[Number(button.dataset.bagChoice)]);
    });
    // Keep the dock synchronized when the same item's row button or live update marks it found.
    new MutationObserver(() => { if (current) refresh(); }).observe(byId('orders-list'), {childList: true, subtree: true});
    // USB scanners type a rapid burst followed by Enter. Keep scanning after the
    // first result without focusing a text field or opening the phone keyboard.
    let burst = '', lastKeyAt = 0;
    document.addEventListener('keydown', event => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing
        || event.target.closest('input,textarea,select,[contenteditable="true"]')) { burst = ''; return; }
      if (!byId('fulfillment-workflow').classList.contains('hidden')
        || [...document.querySelectorAll('.modal:not(.hidden), dialog[open]')].some(modal => modal.id !== 'bag-scan-choice')) { burst = ''; return; }
      const gap = event.timeStamp - lastKeyAt;
      lastKeyAt = event.timeStamp;
      if (event.key === 'Enter') {
        const code = burst; burst = '';
        if (gap <= 120 && code.length >= 3) { event.preventDefault(); event.stopPropagation(); enqueue(code); }
      } else if (event.key.length === 1 && /^[#a-z\d-]$/i.test(event.key)) {
        burst = (gap <= 120 ? burst : '') + event.key;
        if (burst.length > 120) burst = '';
      } else burst = '';
    }, true);
  }
  async function openLine(line) {
    if (processing || saving || state.busy) return;
    ++version; active = true;
    const code = state.selectedLiveLot?.lot_code || 'Selected bag';
    await navigate(line);
    current = {code, line};
    status(`Opened ${line.order?.order_number || 'order'} · ${line.item_title || 'Item'}`); refresh();
    void loadBagPhotos(current, version);
  }
  window.PendingBagScan = {init, enqueue, reset, normalize, openLine, nextBag};
})();
