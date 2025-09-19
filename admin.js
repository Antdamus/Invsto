// admin.js — Phase 1: Step 1 (guard) + Step 2 (summary) + Step 3 (drawer drill-down)
let supabaseClient = null;

function qs(id){ return document.getElementById(id); }
function show(el, v){ el.classList.toggle('hidden', !v); }
function fmtHours(n){
  if (n == null || Number.isNaN(n)) return '—';
  const s = Number(n).toFixed(2);
  return s.replace(/\.00$/, '');
}
function fmtDurationHM(ms){
  if (ms == null || !Number.isFinite(ms)) return '—';
  const totalMin = Math.round(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2,'0')}m`;
}
function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

/* ==================== ADMIN GUARD ==================== */
async function ensureAdmin() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) {
    window.location.href = "index.html?next=" + encodeURIComponent("admin.html");
    return false;
  }
  const { data: isAdmin, error } = await supabaseClient.rpc('is_admin');
  if (error) {
    console.error('is_admin RPC failed', error);
    show(qs('guardLoading'), false);
    show(qs('guardDenied'), true);
    return false;
  }
  if (!isAdmin) {
    window.location.href = `index.html?reason=${encodeURIComponent('Admin only')}`;
    return false;
  }
  return true;
}

function wireHeaderActions() {
  qs('signOutBtn').addEventListener('click', async () => {
    await supabaseClient.auth.signOut();
    window.location.href = 'index.html';
  });
  qs('printBtn').addEventListener('click', () => window.print());
}

/* ==================== STEP 2: Monthly Summary ==================== */

function getMonthStartFromInput(){
  const v = qs('monthInput').value; // "YYYY-MM"
  if (!v || !/^\d{4}-\d{2}$/.test(v)) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  }
  return `${v}-01`;
}

async function fetchMonthlySummary(monthStart, searchTerm){
  const applyFilters = (query) => {
    query = query.eq('month_start', monthStart);
    if (searchTerm && searchTerm.trim()) {
      query = query.ilike('display_name', `%${searchTerm.trim()}%`);
    }
    return query.order('display_name', { ascending: true });
  };

  let { data, error } = await applyFilters(
    supabaseClient.from('mv_monthly_hours').select('employee_id, display_name, month_start, shifts_count, total_hours')
  );
  if (!error && data && data.length > 0) {
    return { rows: data, source: 'mv' };
  }
  // fallback to live view
  const res = await applyFilters(
    supabaseClient.from('v_monthly_hours').select('employee_id, display_name, month_start, shifts_count, total_hours')
  );
  if (res.error) throw res.error;
  return { rows: res.data || [], source: 'view' };
}

function renderKPIs(rows){
  const totalHours = rows.reduce((a, r) => a + (Number(r.total_hours)||0), 0);
  const totalShifts = rows.reduce((a, r) => a + (Number(r.shifts_count)||0), 0);
  const avg = totalShifts > 0 ? (totalHours / totalShifts) : 0;
  qs('kpiTotalHours').textContent = fmtHours(totalHours);
  qs('kpiTotalShifts').textContent = String(totalShifts);
  qs('kpiAvgHrs').textContent = fmtHours(avg);
}

function renderTable(rows){
  const tbody = qs('summaryTbody');
  tbody.innerHTML = '';
  if (!rows.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="3" class="muted">No results for this month/search.</td>`;
    tbody.appendChild(tr);
    return;
  }
  for (const r of rows){
    const tr = document.createElement('tr');
    tr.dataset.employeeId = r.employee_id;
    tr.dataset.monthStart = r.month_start;
    tr.dataset.displayName = r.display_name || '';
    tr.className = 'summary-row';
    tr.innerHTML = `
      <td>${r.display_name || '—'}</td>
      <td>${r.shifts_count ?? '—'}</td>
      <td>${fmtHours(r.total_hours)}</td>
    `;
    tbody.appendChild(tr);
  }
}

let isLoading = false;
async function loadSummary(){
  if (isLoading) return;
  isLoading = true;
  qs('summaryTbody').style.opacity = '0.6';
  try{
    const monthStart = getMonthStartFromInput();
    const search = qs('searchInput').value || '';
    const { rows, source } = await fetchMonthlySummary(monthStart, search);
    renderKPIs(rows);
    renderTable(rows);
    console.info(`Admin summary loaded from ${source}: ${rows.length} rows`);
  }catch(err){
    console.error('Failed to load monthly summary:', err);
    const tbody = qs('summaryTbody');
    tbody.innerHTML = `<tr><td colspan="3" class="muted">Error loading data. Check console.</td></tr>`;
    qs('kpiTotalHours').textContent = '—';
    qs('kpiTotalShifts').textContent = '—';
    qs('kpiAvgHrs').textContent = '—';
  }finally{
    qs('summaryTbody').style.opacity = '1';
    isLoading = false;
  }
}

function wireFilters(){
  qs('monthInput').addEventListener('change', () => loadSummary());
  const onSearch = debounce(() => loadSummary(), 300);
  qs('searchInput').addEventListener('input', onSearch);
}

/* ==================== STEP 3: Worker Drawer ==================== */

function monthRangeISO(monthStartStr){
  // monthStartStr: "YYYY-MM-01"
  const start = new Date(`${monthStartStr}T00:00:00`);
  const end = new Date(start);
  end.setMonth(start.getMonth() + 1);
  return { start: start.toISOString(), end: end.toISOString() };
}

async function fetchWorkerShifts(employeeId, monthStartStr){
  const { start, end } = monthRangeISO(monthStartStr);

  // Select closed shifts in the month; include photo paths if present in schema
  const { data, error } = await supabaseClient
    .from('time_entries')
    .select('id, clock_in, clock_out, store_id, photo_in_path, photo_out_path')
    .eq('employee_id', employeeId)
    .gte('clock_in', start)
    .lt('clock_in', end)
    .not('clock_out', 'is', null)
    .order('clock_in', { ascending: true });

  if (error) throw error;
  const rows = data || [];

  // Create signed URLs (short TTL) for any present photos
  const out = [];
  for (const r of rows){
    const durMs = new Date(r.clock_out) - new Date(r.clock_in);

    let inUrl = null, outUrl = null;
    try{
      if (r.photo_in_path){
        const { data: s } = await supabaseClient
          .storage.from('timeclock-photos').createSignedUrl(r.photo_in_path, 180);
        inUrl = s?.signedUrl || null;
      }
      if (r.photo_out_path){
        const { data: s2 } = await supabaseClient
          .storage.from('timeclock-photos').createSignedUrl(r.photo_out_path, 180);
        outUrl = s2?.signedUrl || null;
      }
    }catch(_e){ /* ignore per-row photo errors */ }

    out.push({
      id: r.id,
      clock_in: r.clock_in,
      clock_out: r.clock_out,
      duration_ms: durMs,
      store_id: r.store_id || null,
      photo_in_url: inUrl,
      photo_out_url: outUrl
    });
  }
  return out;
}

function openDrawer(){
  qs('drawer').classList.add('open');
  qs('drawer').classList.remove('hidden');
  qs('drawerBackdrop').classList.add('show');
  qs('drawerBackdrop').classList.remove('hidden');
}
function closeDrawer(){
  qs('drawer').classList.remove('open');
  qs('drawerBackdrop').classList.remove('show');
  // allow transition, then hide
  setTimeout(() => {
    qs('drawer').classList.add('hidden');
    qs('drawerBackdrop').classList.add('hidden');
  }, 250);
}

function renderDrawerHeader(name, monthStartStr){
  // derive "September 2025" style label
  const d = new Date(monthStartStr + 'T00:00:00');
  const label = d.toLocaleString(undefined, { month:'long', year:'numeric' });
  qs('drawerTitle').textContent = name || '—';
  qs('drawerSubtitle').textContent = label;
}

function renderDrawerSummary(shifts){
  const n = shifts.length;
  const totalHrs = shifts.reduce((a, s) => a + (s.duration_ms || 0), 0) / 3600000;
  const avg = n ? (totalHrs / n) : 0;
  qs('dsShifts').textContent = String(n);
  qs('dsHours').textContent = fmtHours(totalHrs);
  qs('dsAvg').textContent = fmtHours(avg);
}

function renderDrawerList(shifts){
  const host = qs('drawerList');
  host.innerHTML = '';
  if (!shifts.length){
    host.innerHTML = `<div class="drawer-empty">No closed shifts in this month.</div>`;
    return;
  }
  for (const s of shifts){
    const inStr  = new Date(s.clock_in).toLocaleString();
    const outStr = new Date(s.clock_out).toLocaleString();
    const durStr = fmtDurationHM(s.duration_ms);

    const div = document.createElement('div');
    div.className = 'shift';
    div.innerHTML = `
      <div class="shift-row">
        <div class="shift-time"><strong>In:</strong> ${inStr}</div>
        <div class="shift-time"><strong>Out:</strong> ${outStr}</div>
        <div class="shift-meta">${durStr}</div>
      </div>
      <div class="shift-row" style="margin-top:6px; justify-content:space-between;">
        <div class="shift-meta">${s.store_id ? `Store: ${s.store_id}` : ''}</div>
        <div class="shift-actions">
          ${s.photo_in_url ? `<a href="${s.photo_in_url}" target="_blank" rel="noopener">Photo In</a>` : ''}
          ${s.photo_out_url ? `<a href="${s.photo_out_url}" target="_blank" rel="noopener">Photo Out</a>` : ''}
        </div>
      </div>
    `;
    host.appendChild(div);
  }
}

async function onRowClick(e){
  const tr = e.target.closest('tr.summary-row');
  if (!tr) return;
  const employeeId = tr.dataset.employeeId;
  const monthStart = tr.dataset.monthStart;  // "YYYY-MM-01"
  const displayName = tr.dataset.displayName || '—';

  // Header & loading state
  renderDrawerHeader(displayName, monthStart);
  qs('dsShifts').textContent = '…';
  qs('dsHours').textContent = '…';
  qs('dsAvg').textContent = '…';
  qs('drawerList').innerHTML = `<div class="drawer-empty">Loading shifts…</div>`;
  openDrawer();

  try{
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
  }catch(err){
    console.error('Failed to load worker shifts:', err);
    qs('drawerList').innerHTML = `<div class="drawer-empty">Error loading shifts.</div>`;
  }
}

function wireDrawer(){
  qs('drawerCloseBtn').addEventListener('click', closeDrawer);
  qs('drawerBackdrop').addEventListener('click', closeDrawer);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Delegate table row clicks
  qs('summaryTbody').addEventListener('click', onRowClick);
}

/* ==================== Boot ==================== */
document.addEventListener('supabase-ready', async () => {
  supabaseClient = window.supabase;

  // Guard UI
  show(qs('guardLoading'), true);
  show(qs('guardDenied'), false);
  show(qs('adminApp'), false);

  const ok = await ensureAdmin();

  show(qs('guardLoading'), false);
  show(qs('guardDenied'), !ok);
  show(qs('adminApp'), ok);

  if (!ok) return;

  wireHeaderActions();

  // Prefill month with current month (YYYY-MM)
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  qs('monthInput').value = ym;

  wireFilters();
  wireDrawer();

  // Initial load
  loadSummary();
});

// If initSupabase.js ran first, ensure we still kick things off
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  if (window.supabase) {
    document.dispatchEvent(new Event('supabase-ready'));
  } else {
    setTimeout(() => {
      if (window.supabase) document.dispatchEvent(new Event('supabase-ready'));
    }, 0);
  }
}
