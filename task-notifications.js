(function () {
  'use strict';
  if (window.OGTaskNotifications) return;

  const PAGE_SIZE = 30;
  const REFRESH_MS = 60000;
  const FIELDS = 'id,recipient_user_id,source,task_id,notification_type,title,body,actor_email,priority,read_at,created_at';
  const labels = {task_assigned: 'New assignment', subtask_assigned: 'New subtask', shipment_assigned: 'Shipping assignment',
    packaging_assigned: 'Packaging assignment', return_task_assigned: 'Return assignment', task_progress_update: 'Reply / update',
    task_ready_for_review: 'Ready for review', task_completed: 'Work completed', subtask_completed: 'Subtask completed',
    task_due_reminder: 'Task reminder', task_overdue: 'Overdue task'};
  let client, userId = '', generation = 0, channel, timer, flight, queued = false;
  let root, launcher, launcherHost, unread = [], recent = [], unreadCount = 0, limit = PAGE_SIZE, view = 'unread', opened = false;
  let minimizedId = '', errorMessage = '', loading = false, busyIds = new Set(), returnFocus;
  let listSignature = '', publishedSignature = '', announcedId = '', resolveReady, readRevision = 0, authRevision = 0;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[char]));
  const key = suffix => `og-task-updates:${userId}:${suffix}`;
  const dateText = value => {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '' : date.toLocaleString([], {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'});
  };
  const href = entry => /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(entry.task_id || '')
    ? `team-tasks.html?taskId=${encodeURIComponent(entry.task_id)}` : 'team-tasks.html';
  const snapshot = () => ({userId, notifications: [...new Map([...recent, ...unread].map(row => [row.id, row])).values()], unreadCount});
  function publish() {
    const detail = snapshot(), signature = JSON.stringify(detail);
    if (signature === publishedSignature) return;
    publishedSignature = signature;
    document.dispatchEvent(new CustomEvent('og-task-notifications-changed', {detail}));
  }
  function readMinimized() { try { minimizedId = localStorage.getItem(key('minimized')) || ''; } catch { minimizedId = ''; } }
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
      style.id = 'og-task-updates-style'; style.rel = 'stylesheet'; style.href = 'task-notifications.css?v=20261008-header-actions';
      document.head.append(style);
    }
    root = document.createElement('div');
    root.id = 'og-task-updates';
    root.innerHTML = `
      <div class="og-tu-announce" role="status" aria-live="polite" aria-atomic="true"></div>
      <button type="button" class="og-tu-launcher" aria-controls="og-tu-panel" aria-expanded="false" aria-label="Task updates">
        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/></svg>
        <span class="og-tu-label-full">Task updates</span><span class="og-tu-label-short" aria-hidden="true">Updates</span><strong class="og-tu-count" hidden>0</strong>
      </button>
      <section class="og-tu-alert" aria-label="New task updates" hidden>
        <div class="og-tu-alert-head"><strong>Tasks & replies</strong><button type="button" data-tu-minimize aria-label="Minimize task alert">−</button></div>
        <p class="og-tu-alert-title"></p><p class="og-tu-alert-body"></p>
        <button type="button" class="og-tu-primary" data-tu-review>Review updates</button>
      </section>
      <section id="og-tu-panel" class="og-tu-panel" role="region" aria-label="Task updates inbox" hidden>
        <header><div><span class="og-tu-eyebrow">Stay in the loop</span><h2>Tasks & replies</h2><p class="og-tu-summary"></p></div>
          <button type="button" data-tu-close aria-label="Close task updates">×</button></header>
        <div class="og-tu-tabs" role="group" aria-label="Notification view"><button type="button" data-tu-view="unread">Unread</button><button type="button" data-tu-view="recent">Recent</button></div>
        <div class="og-tu-error" role="status" hidden><span></span><button type="button" data-tu-retry>Retry</button></div>
        <div class="og-tu-list" aria-label="Notifications"></div>
        <footer><button type="button" data-tu-more hidden>Load more</button><a href="team-tasks.html">Go to Tasks →</a><small>Reading an update does not complete the task.</small></footer>
      </section>`;
    document.body.append(root);
    launcher = root.querySelector('.og-tu-launcher');
    launcherHost = document.getElementById('task-updates-slot');
    if (launcherHost) { launcherHost.append(launcher); root.classList.add('is-docked'); }
    launcher.addEventListener('click', () => opened ? close() : open());
    root.querySelector('[data-tu-review]').addEventListener('click', open);
    root.querySelector('[data-tu-minimize]').addEventListener('click', minimize);
    root.querySelector('[data-tu-close]').addEventListener('click', close);
    root.querySelector('[data-tu-retry]').addEventListener('click', () => void refresh());
    root.querySelector('[data-tu-more]').addEventListener('click', () => { limit += PAGE_SIZE; void refresh(); });
    root.querySelectorAll('[data-tu-view]').forEach(button => button.addEventListener('click', () => {
      view = button.dataset.tuView; listSignature = ''; render(); void refresh();
    }));
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
    launcher.setAttribute('aria-label', `Task updates, ${unreadCount} unread`);
    launcher.hidden = opened && !launcherHost;
    const alert = root.querySelector('.og-tu-alert');
    alert.hidden = opened || !latest || latest.id === minimizedId;
    root.querySelector('.og-tu-alert-title').textContent = latest?.title || 'Task update';
    root.querySelector('.og-tu-alert-body').textContent = latest?.body || '';
    root.querySelector('[data-tu-review]').textContent = `Review ${unreadCount} update${unreadCount === 1 ? '' : 's'}`;
    root.querySelector('#og-tu-panel').hidden = !opened;
    root.querySelector('.og-tu-summary').textContent = unreadCount ? `${unreadCount} unread update${unreadCount === 1 ? '' : 's'}` : 'You’re all caught up';
    root.querySelectorAll('[data-tu-view]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.tuView === view)));
    const error = root.querySelector('.og-tu-error');
    error.hidden = !errorMessage; error.querySelector('span').textContent = errorMessage;
    const rows = view === 'recent' ? recent : unread;
    const signature = JSON.stringify([view, rows, [...busyIds], rows.length ? false : loading]);
    if (signature !== listSignature) {
      listSignature = signature;
      const list = root.querySelector('.og-tu-list');
      const focused = document.activeElement?.closest('[data-tu-read], [data-tu-open]');
      const focusedId = focused?.dataset.tuRead || focused?.dataset.tuOpen;
      const scrollTop = list.scrollTop;
      list.innerHTML = rows.length ? rows.map(entry => `<article class="og-tu-entry ${entry.read_at ? '' : 'is-unread'}">
        <div class="og-tu-entry-meta"><span>${escape(labels[entry.notification_type] || 'Task update')}</span><time datetime="${escape(entry.created_at)}">${escape(dateText(entry.created_at))}</time></div>
        <h3>${escape(entry.title || 'Task update')}</h3>
        ${entry.actor_email ? `<small class="og-tu-actor">From ${escape(entry.actor_email)}</small>` : ''}
        <p>${escape(entry.body || 'Open the task to see the instructions.')}</p>
        <div class="og-tu-entry-actions"><a href="${escape(href(entry))}" data-tu-open="${escape(entry.id)}">Open task</a>
        ${entry.read_at ? '<span>Read</span>' : `<button type="button" data-tu-read="${escape(entry.id)}" ${busyIds.has(entry.id) ? 'disabled' : ''}>${busyIds.has(entry.id) ? 'Saving…' : 'Mark read'}</button>`}</div>
      </article>`).join('') : `<div class="og-tu-empty">${loading ? 'Loading updates…' : view === 'unread' ? 'No unread updates. New assignments and replies will appear here.' : 'No recent updates.'}</div>`;
      list.scrollTop = scrollTop;
      if (focusedId && opened) {
        const next = [...list.querySelectorAll('[data-tu-read], [data-tu-open]')].find(button => (button.dataset.tuRead || button.dataset.tuOpen) === focusedId);
        (next || root.querySelector('[data-tu-close]')).focus({preventScroll: true});
      }
    }
    root.querySelector('[data-tu-more]').hidden = view !== 'unread' || unread.length >= unreadCount;
    root.querySelector('[data-tu-more]').disabled = loading;
    if (latest && latest.id !== announcedId) {
      announcedId = latest.id;
      root.querySelector('.og-tu-announce').textContent = `${unreadCount} unread task updates. ${latest.title || 'New task update'}`;
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
    const expectedGeneration = generation, expectedReadRevision = readRevision, recipient = userId;
    loading = true; render();
    flight = (async () => {
      try {
        const queries = [client.from('task_notifications').select(FIELDS, {count: 'exact'})
          .eq('recipient_user_id', recipient).is('read_at', null).order('created_at', {ascending: false}).order('id', {ascending: false}).range(0, limit - 1)];
        if (view === 'recent') queries.push(client.from('task_notifications').select(FIELDS)
          .eq('recipient_user_id', recipient).order('created_at', {ascending: false}).order('id', {ascending: false}).limit(PAGE_SIZE));
        const results = await Promise.all(queries);
        if (expectedGeneration !== generation) return;
        if (expectedReadRevision !== readRevision) { queued = true; return; }
        if (results.some(result => result.error)) throw new Error('notification read failed');
        unread = (results[0].data || []).filter(row => row.recipient_user_id === recipient && !row.read_at);
        unreadCount = results[0].count ?? unread.length;
        if (results[1]) recent = (results[1].data || []).filter(row => row.recipient_user_id === recipient);
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
      unreadCount = Math.max(0, unreadCount - unread.filter(row => selected.includes(row.id)).length);
      unread = unread.filter(row => !selected.includes(row.id));
      recent = recent.map(row => selected.includes(row.id) ? {...row, read_at: readAt} : row);
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
    userId = ''; unread = []; recent = []; unreadCount = 0; opened = false; loading = false;
    limit = PAGE_SIZE; view = 'unread'; minimizedId = ''; announcedId = ''; errorMessage = ''; listSignature = ''; busyIds = new Set();
    launcher?.remove(); launcher = null; launcherHost = null;
    root?.remove(); root = null; publish();
  }
  async function changeUser(user) {
    if (user?.id === userId) return;
    stop();
    if (!user?.id) { resolveReady(); return; }
    userId = user.id; readMinimized(); mount(); render();
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
