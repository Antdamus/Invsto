(function () {
  'use strict';
  if (window.OGTaskNotifications) return;

  const PAGE_SIZE = 30;
  const REFRESH_MS = 60000;
  const categories = {all: 'All', tasks: 'Tasks', buyers: 'Buyer issues', returns: 'Returns', system: 'System'};
  const descriptions = {all: 'Assignments, replies and eBay updates.', tasks: 'Your assignments, replies and approvals.', buyers: 'Buyer requests, disputes and eBay deadlines.', returns: 'Return case updates and eBay deadlines.', system: 'Connection and synchronization alerts.'};
  const labels = {task_assigned: 'New assignment', subtask_assigned: 'New subtask', shipment_assigned: 'Shipping assignment',
    packaging_assigned: 'Packaging assignment', return_task_assigned: 'Return assignment', task_progress_update: 'Reply / update',
    task_ready_for_review: 'Ready for review', task_completed: 'Work completed', subtask_completed: 'Subtask completed',
    task_due_reminder: 'Task reminder', task_overdue: 'Overdue task',customer_issue_sync:'eBay sync',customer_issue_action:'eBay case update',customer_issue_deadline:'eBay deadline'};
  let client, userId = '', generation = 0, channel, timer, flight, queued = false;
  let root, launcher, launcherHost, unread = [], entries = [], unreadCount = 0, entryTotal = 0, counts = {}, limit = PAGE_SIZE, view = 'unread', category = 'all', opened = false;
  let minimizedId = '', errorMessage = '', loading = false, busyIds = new Set(), returnFocus;
  let listSignature = '', publishedSignature = '', announcedId = '', resolveReady, readRevision = 0, authRevision = 0, filterRevision = 0;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const key = suffix => `og-task-updates:${userId}:${suffix}`;
  const dateText = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  };
  const issueAlert = entry => ['customer_issue_action','customer_issue_deadline'].includes(entry.notification_type) && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(entry.metadata?.case_id || '');
  const syncAlert = entry => entry.notification_type === 'customer_issue_sync';
  const href = entry => syncAlert(entry) ? 'ebay-returns.html?syncHealth=1' : issueAlert(entry) ? `ebay-returns.html?caseId=${encodeURIComponent(entry.metadata.case_id)}` : /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(entry.task_id || '')
    ? `team-tasks.html?taskId=${encodeURIComponent(entry.task_id)}` : 'team-tasks.html';
  const snapshot = () => ({userId, notifications: [...new Map([...unread, ...entries].map(row => [row.id, row])).values()], unreadCount});
  function publish() {
    const detail = snapshot(), signature = JSON.stringify(detail);
    if (signature === publishedSignature) return;
    publishedSignature = signature;
    document.dispatchEvent(new CustomEvent('og-task-notifications-changed', {detail}));
  }
  function readMinimized() { try { minimizedId = localStorage.getItem(key('minimized')) || ''; } catch { minimizedId = ''; } }
  function readCategory() { try { const saved = localStorage.getItem(key('category')); category = Object.hasOwn(categories, saved) ? saved : 'all'; } catch { category = 'all'; } }
  function filter(nextCategory, nextView = view) {
    if (!Object.hasOwn(categories, nextCategory) || !['unread', 'recent'].includes(nextView)) return;
    category = nextCategory; view = nextView; filterRevision += 1; limit = PAGE_SIZE;
    entries = []; entryTotal = 0; listSignature = ''; loading = true;
    try { localStorage.setItem(key('category'), category); } catch { /* Optional preference. */ }
    root.querySelector('.og-tu-list').scrollTop = 0;
    render(); void refresh();
  }
  function minimize() {
    minimizedId = unread[0]?.id || '';
    try { localStorage.setItem(key('minimized'), minimizedId); } catch { /* Storage is optional. */ }
    opened = false;
    render();
  }

  function mount() {
    if (root) return;
    if (!document.getElementById('og-task-updates-style')) {
      const style = document.createElement('link');
      style.id = 'og-task-updates-style'; style.rel = 'stylesheet'; style.href = 'task-notifications.css?v=20261009-categories';
      document.head.append(style);
    }
    root = document.createElement('div');
    root.id = 'og-task-updates';
    root.innerHTML = `
      <div class="og-tu-announce" role="status" aria-live="polite" aria-atomic="true"></div>
      <button type="button" class="og-tu-launcher" aria-controls="og-tu-panel" aria-expanded="false" aria-label="Updates">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
        <span class="og-tu-label-full">Updates</span><span class="og-tu-label-short" aria-hidden="true">Updates</span><strong class="og-tu-count" hidden>0</strong>
      </button>
      <section class="og-tu-alert" aria-label="New updates" hidden>
        <div class="og-tu-alert-head"><strong>Updates</strong><button type="button" data-tu-minimize aria-label="Minimize update alert">−</button></div>
        <p class="og-tu-alert-title"></p><p class="og-tu-alert-body"></p>
        <button type="button" class="og-tu-primary" data-tu-review>Review updates</button>
      </section>
      <section id="og-tu-panel" class="og-tu-panel" role="region" aria-label="Updates inbox" hidden>
        <header><div><span class="og-tu-eyebrow">Stay in the loop</span><h2>Updates</h2><p class="og-tu-summary"></p></div>
          <button type="button" data-tu-close aria-label="Close updates">×</button></header>
        <div class="og-tu-categories" role="group" aria-label="Filter updates by category">${Object.entries(categories).map(([id,label]) => `<button type="button" data-tu-category="${id}" aria-pressed="false"><span>${label}</span><b>0</b></button>`).join('')}</div>
        <p class="og-tu-category-help"></p>
        <div class="og-tu-tabs" role="group" aria-label="Notification view"><button type="button" data-tu-view="unread">Unread</button><button type="button" data-tu-view="recent">Recent</button></div>
        <div class="og-tu-error" role="status" hidden><span></span><button type="button" data-tu-retry>Retry</button></div>
        <div class="og-tu-list" aria-label="Notifications"></div>
        <footer><button type="button" data-tu-more hidden>Load more</button><a data-tu-destination href="team-tasks.html">Go to Tasks →</a><small>Marking read only clears the notification. Work and cases stay open.</small></footer>
      </section>`;
    document.body.append(root);
    launcher = root.querySelector('.og-tu-launcher');
    launcherHost = document.getElementById('task-updates-slot');
    if (launcherHost) { launcherHost.append(launcher); root.classList.add('is-docked'); }
    launcher.addEventListener('click', () => opened ? close() : open());
    root.querySelector('[data-tu-review]').addEventListener('click', () => { filter(unread[0]?.category || 'all', 'unread'); open(); });
    root.querySelector('[data-tu-minimize]').addEventListener('click', minimize);
    root.querySelector('[data-tu-close]').addEventListener('click', close);
    root.querySelector('[data-tu-retry]').addEventListener('click', () => void refresh());
    root.querySelector('[data-tu-more]').addEventListener('click', () => { limit += PAGE_SIZE; void refresh(); });
    root.querySelectorAll('[data-tu-view]').forEach(button => button.addEventListener('click', () => {
      filter(category, button.dataset.tuView);
    }));
    root.querySelectorAll('[data-tu-category]').forEach(button => button.addEventListener('click', () => filter(button.dataset.tuCategory)));
    root.querySelector('.og-tu-list').addEventListener('click', async event => {
      const button = event.target.closest('[data-tu-read]');
      if (button) { await markRead([button.dataset.tuRead]); return; }
      const link = event.target.closest('[data-tu-open]');
      if (!link || event.button || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      event.preventDefault();
      const expectedUser = userId;
      const target = link.getAttribute('href');
      if (await markRead([link.dataset.tuOpen]) && userId === expectedUser) window.location.assign(target);
    });
    // No focus stealing when an alert arrives, and no outside-click dismissal.
    root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && opened) { event.preventDefault(); event.stopPropagation(); close(); }
    });
  }

  function render() {
    if (!root || !userId) return;
    const latest = unread[0];
    launcher.setAttribute('aria-expanded', String(opened));
    const badge = launcher.querySelector('.og-tu-count');
    badge.hidden = !unreadCount; badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    launcher.setAttribute('aria-label', `Updates, ${unreadCount} unread`);
    launcher.hidden = opened && !launcherHost;
    const alert = root.querySelector('.og-tu-alert');
    alert.hidden = opened || !latest || latest.id === minimizedId;
    root.querySelector('.og-tu-alert-head strong').textContent = categories[latest?.category] || 'Updates';
    root.querySelector('.og-tu-alert-title').textContent = latest?.title || 'Task update';
    root.querySelector('.og-tu-alert-body').textContent = latest?.body || '';
    root.querySelector('[data-tu-review]').textContent = 'Review updates';
    root.querySelector('#og-tu-panel').hidden = !opened;
    root.querySelector('.og-tu-summary').textContent = unreadCount ? `${unreadCount} unread update${unreadCount === 1 ? '' : 's'}` : 'You’re all caught up';
    root.querySelectorAll('[data-tu-category]').forEach(button => {
      const id = button.dataset.tuCategory, count = counts[id] || 0;
      button.setAttribute('aria-pressed', String(id === category));
      button.setAttribute('aria-label', `${categories[id]}, ${count} unread`);
      button.querySelector('b').textContent = count > 99 ? '99+' : String(count);
    });
    root.querySelector('.og-tu-category-help').textContent = descriptions[category];
    const destination = root.querySelector('[data-tu-destination]');
    destination.href = ['buyers','returns','system'].includes(category) ? `ebay-returns.html${category === 'system' ? '?syncHealth=1' : ''}` : 'team-tasks.html';
    destination.textContent = category === 'system' ? 'View connection status →' : ['buyers','returns'].includes(category) ? 'Go to Customer Issues →' : 'Go to Tasks →';
    root.querySelectorAll('[data-tu-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tuView === view)));
    const error = root.querySelector('.og-tu-error');
    error.hidden = !errorMessage; error.querySelector('span').textContent = errorMessage;
    const rows = entries;
    const signature = JSON.stringify([view, category, rows, [...busyIds], rows.length ? false : loading]);
    if (signature !== listSignature) {
      listSignature = signature;
      const list = root.querySelector('.og-tu-list');
      const focused = document.activeElement?.closest('[data-tu-read], [data-tu-open]');
      const focusedId = focused?.dataset.tuRead || focused?.dataset.tuOpen;
      const scrollTop = list.scrollTop;
      list.innerHTML = rows.length ? rows.map(entry => `<article class="og-tu-entry ${entry.read_at ? '' : 'is-unread'}">
        <div class="og-tu-entry-meta"><span>${escape(categories[entry.category] || 'Tasks')} · ${escape(labels[entry.notification_type] || 'Task update')}</span><time datetime="${escape(entry.created_at)}">${escape(dateText(entry.created_at))}</time></div>
        <h3>${escape(entry.title || 'Task update')}</h3>
        ${entry.actor_email ? `<small class="og-tu-actor">From ${escape(entry.actor_email)}</small>` : ''}
        <p>${escape(entry.body || 'Open the task to see the instructions.')}</p>
        <div class="og-tu-entry-actions"><a href="${escape(href(entry))}" data-tu-open="${escape(entry.id)}">${syncAlert(entry)?'Open sync status':issueAlert(entry)?'Open case':'Open task'}</a>
        ${entry.read_at ? '<span>Read</span>' : `<button type="button" data-tu-read="${escape(entry.id)}" ${busyIds.has(entry.id) ? 'disabled' : ''}>${busyIds.has(entry.id) ? 'Saving…' : 'Mark read'}</button>`}</div>
      </article>`).join('') : `<div class="og-tu-empty">${loading ? 'Loading updates…' : `No ${view === 'unread' ? 'unread' : 'recent'} ${category === 'all' ? 'updates' : categories[category].toLowerCase() + ' updates'}.${category !== 'all' && unreadCount ? ' Other updates are available under All.' : ''}`}</div>`;
      list.scrollTop = scrollTop;
      if (focusedId && opened) {
        const next = [...list.querySelectorAll('[data-tu-read], [data-tu-open]')].find(button => (button.dataset.tuRead || button.dataset.tuOpen) === focusedId);
        (next || root.querySelector('[data-tu-close]')).focus({preventScroll: true});
      }
    }
    root.querySelector('[data-tu-more]').hidden = entries.length >= entryTotal;
    root.querySelector('[data-tu-more]').disabled = loading;
    if (latest && latest.id !== announcedId) {
      announcedId = latest.id;
      root.querySelector('.og-tu-announce').textContent = `${unreadCount} unread updates. ${categories[latest.category] || 'Tasks'}: ${latest.title || 'New update'}`;
    }
  }

  function open() {
    if (!root || !userId) return;
    returnFocus = document.activeElement; opened = true; render();
    root.querySelector('[data-tu-close]').focus({preventScroll: true});
    void refresh();
  }
  function close() { minimize(); (launcherHost ? launcher : returnFocus?.isConnected ? returnFocus : launcher)?.focus({preventScroll: true}); }

  function refresh() {
    if (!client || !userId) return Promise.resolve();
    if (flight) { queued = true; return flight; }
    const expectedGeneration = generation, expectedReadRevision = readRevision, expectedFilterRevision = filterRevision, recipient = userId;
    loading = true; render();
    flight = (async () => {
      try {
        const result = await client.rpc('notification_inbox', {_category: category, _view: view, _limit: limit});
        if (expectedGeneration !== generation) return;
        if (expectedReadRevision !== readRevision || expectedFilterRevision !== filterRevision) { queued = true; return; }
        if (result.error) throw new Error('notification read failed');
        unread = (result.data.unread || []).filter(row => row.recipient_user_id === recipient && !row.read_at);
        entries = (result.data.entries || []).filter(row => row.recipient_user_id === recipient);
        unreadCount = result.data.unread_count || 0; entryTotal = result.data.total || 0; counts = result.data.counts || {};
        errorMessage = ''; publish();
      } catch {
        if (expectedGeneration === generation) errorMessage = 'Updates could not refresh. Your unread alerts are still saved.';
      } finally {
        if (expectedGeneration === generation) {
          flight = null; loading = false; render();
          if (queued) { queued = false; queueMicrotask(() => void refresh()); }
        }
      }
    })();
    return flight;
  }

  async function markRead(ids = []) {
    const selected = [...new Set(ids)].filter(Boolean);
    if (!client || !userId || !selected.length) return false;
    const recipient = userId, expectedGeneration = generation, readAt = new Date().toISOString();
    selected.forEach(id => busyIds.add(id)); render();
    try {
      const {data, error} = await client.from('task_notifications').update({read_at: readAt})
        .eq('recipient_user_id', recipient).in('id', selected).select('id');
      if (expectedGeneration !== generation) return false;
      if (error || selected.some(id => !(data || []).some(row => row.id === id))) throw new Error('read not saved');
      readRevision += 1;
      const readRows = snapshot().notifications.filter(row => selected.includes(row.id) && !row.read_at);
      unreadCount = Math.max(0, unreadCount - readRows.length);
      for (const row of readRows) { counts.all = Math.max(0, (counts.all || 0) - 1); counts[row.category] = Math.max(0, (counts[row.category] || 0) - 1); }
      if (view === 'unread') entryTotal = Math.max(0, entryTotal - entries.filter(row => selected.includes(row.id)).length);
      unread = unread.filter(row => !selected.includes(row.id));
      entries = view === 'unread' ? entries.filter(row => !selected.includes(row.id)) : entries.map(row => selected.includes(row.id) ? {...row, read_at: readAt} : row);
      errorMessage = ''; publish();
      try { localStorage.setItem(key('changed'), `${Date.now()}:${Math.random()}`); } catch { /* Realtime also syncs reads. */ }
      void refresh();
      return true;
    } catch {
      if (expectedGeneration === generation) errorMessage = 'Could not mark this update read. Please try again.';
      return false;
    } finally {
      if (expectedGeneration === generation) { selected.forEach(id => busyIds.delete(id)); render(); }
    }
  }

  function stop() {
    generation += 1;
    if (channel) void client?.removeChannel(channel);
    channel = null; clearInterval(timer); timer = null; flight = null; queued = false;
    userId = ''; unread = []; entries = []; counts = {}; unreadCount = 0; entryTotal = 0; opened = false; loading = false;
    limit = PAGE_SIZE; view = 'unread'; category = 'all'; filterRevision += 1; minimizedId = ''; announcedId = ''; errorMessage = ''; listSignature = ''; busyIds = new Set();
    launcher?.remove(); launcher = null; launcherHost = null;
    root?.remove(); root = null; publish();
  }
  async function changeUser(user) {
    if (user?.id === userId) return;
    stop();
    if (!user?.id) { resolveReady(); return; }
    userId = user.id; readMinimized(); readCategory(); mount(); render();
    const expectedGeneration = generation;
    if (typeof client.channel === 'function') {
      channel = client.channel(`global-task-updates-${userId}`)
        .on('postgres_changes', {event: '*', schema: 'public', table: 'task_notifications', filter: `recipient_user_id=eq.${userId}`}, () => {
          if (expectedGeneration === generation) void refresh();
        }).subscribe(status => {
          if (status === 'SUBSCRIBED' && expectedGeneration === generation) void refresh();
        });
    }
    timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, REFRESH_MS);
    await refresh(); resolveReady();
  }

  async function boot() {
    client = window.supabaseClient?.auth ? window.supabaseClient : window.supabase;
    if (!client?.auth?.getSession) return;
    // Supabase auth callbacks must not await another auth operation.
    client.auth.onAuthStateChange?.((_event, session) => {
      const revision = ++authRevision;
      if (!session?.user) { stop(); resolveReady(); }
      else setTimeout(() => { if (revision === authRevision) void changeUser(session.user); }, 0);
    });
    try {
      const revision = authRevision;
      const {data, error} = await client.auth.getSession();
      if (error) throw error;
      if (revision === authRevision) await changeUser(data?.session?.user);
    } catch { resolveReady(); }
  }
  window.OGTaskNotifications = {ready, open, dismiss: minimize, refresh, markRead, snapshot};
  window.addEventListener('storage', event => {
    if (!userId) return;
    if (event.key === key('changed')) void refresh();
    if (event.key === key('minimized')) { readMinimized(); render(); }
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'hidden') void refresh(); });
  window.addEventListener('online', () => void refresh());
  window.addEventListener('pageshow', event => { if (event.persisted) void refresh(); });
  let booted = false;
  function start() {
    if (booted || !(window.supabaseClient?.auth || window.supabase?.auth)) return;
    booted = true; void boot();
  }
  document.addEventListener('supabase-ready', start);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
