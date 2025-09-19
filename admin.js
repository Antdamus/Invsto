// admin.js — Phase 1 (Steps 1–4) + Phase 2.1 (Edit shift modal)
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
function monthInputToStart(){
  const v = qs('monthInput').value; // "YYYY-MM"
  if (!v || !/^\d{4}-\d{2}$/.test(v)) {
    const now = new Date();
    return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`;
  }
  return `${v}-01`;
}
function monthLabel(yyyyMm01){
  const d = new Date(yyyyMm01 + 'T00:00:00');
  return d.toLocaleString(undefined, { month:'long', year:'numeric' });
}
function toDatetimeLocalValue(iso){
  // -> "YYYY-MM-DDTHH:MM" in local time
  if (!iso) return '';
  const d = new Date(iso);
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  const hh = String(d.getHours()).padStart(2,'0');
  const mm = String(d.getMinutes()).padStart(2,'0');
  return `${y}-${m}-${day}T${hh}:${mm}`;
}
function localInputToOffsetISO(localStr){
  // local "YYYY-MM-DDTHH:MM" -> "YYYY-MM-DDTHH:MM:00±HH:MM"
  const d = new Date(localStr);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n)=>String(n).padStart(2,'0');
  const y=d.getFullYear(), m=pad(d.getMonth()+1), day=pad(d.getDate()), hh=pad(d.getHours()), mm=pad(d.getMinutes());
  const tzMin = -d.getTimezoneOffset(); // minutes east of UTC
  const sign = tzMin >= 0 ? '+' : '-';
  const offH = pad(Math.floor(Math.abs(tzMin)/60));
  const offM = pad(Math.abs(tzMin)%60);
  return `${y}-${m}-${day}T${hh}:${mm}:00${sign}${offH}:${offM}`;
}

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

/* ==================== Data Sources ==================== */
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
  if (!error && data && data.length > 0) return { rows: data, source: 'mv' };

  const res = await applyFilters(
    supabaseClient.from('v_monthly_hours').select('employee_id, display_name, month_start, shifts_count, total_hours')
  );
  if (res.error) throw res.error;
  return { rows: res.data || [], source: 'view' };
}

async function fetchWorkerShifts(employeeId, monthStartStr){
  const start = new Date(`${monthStartStr}T00:00:00`);
  const end = new Date(start); end.setMonth(start.getMonth() + 1);

  const { data, error } = await supabaseClient
    .from('time_entries')
    .select('id, clock_in, clock_out, store_id, photo_in_path, photo_out_path')
    .eq('employee_id', employeeId)
    .gte('clock_in', start.toISOString())
    .lt('clock_in', end.toISOString())
    .not('clock_out', 'is', null)
    .order('clock_in', { ascending: true });

  if (error) throw error;
  const rows = data || [];

  const map = new Map();
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
    }catch(_e){}
    const rec = { id:r.id, clock_in:r.clock_in, clock_out:r.clock_out, duration_ms:durMs,
                  store_id:r.store_id||null, photo_in_url:inUrl, photo_out_url:outUrl };
    map.set(r.id, rec);
    out.push(rec);
  }
  currentShiftsById = map;
  return out;
}

/* ==================== Rendering & Sorting ==================== */
function renderKPIs(rows){
  const totalHours = rows.reduce((a, r) => a + (Number(r.total_hours)||0), 0);
  const totalShifts = rows.reduce((a, r) => a + (Number(r.shifts_count)||0), 0);
  const avg = totalShifts > 0 ? (totalHours / totalShifts) : 0;
  qs('kpiTotalHours').textContent = fmtHours(totalHours);
  qs('kpiTotalShifts').textContent = String(totalShifts);
  qs('kpiAvgHrs').textContent = fmtHours(avg);
}

let currentRows = [];
let sortState = { key: 'display_name', dir: 'asc' }; // default A→Z
let currentShiftsById = new Map();
let drawerContext = { employeeId: null, displayName: null, monthStart: null };

function sortRows(rows){
  const arr = rows.slice();
  const { key, dir } = sortState;
  const mult = dir === 'asc' ? 1 : -1;

  arr.sort((a,b) => {
    let av = a[key], bv = b[key];
    if (key === 'shifts_count' || key === 'total_hours') {
      av = Number(av) || 0; bv = Number(bv) || 0;
      return (av - bv) * mult;
    }
    const as = (av || '').toString().toLowerCase();
    const bs = (bv || '').toString().toLowerCase();
    if (as < bs) return -1 * mult;
    if (as > bs) return  1 * mult;
    return 0;
  });
  return arr;
}

function applySortIndicators(){
  const heads = [
    { el: qs('thWorker'), key: 'display_name' },
    { el: qs('thShifts'), key: 'shifts_count' },
    { el: qs('thHours'),  key: 'total_hours'  },
  ];
  heads.forEach(({el,key}) => {
    const is = sortState.key === key ? sortState.dir : 'none';
    el.setAttribute('aria-sort', is === 'asc' ? 'ascending' : is === 'desc' ? 'descending' : 'none');
    const span = el.querySelector('.sort-indicator');
    if (span) span.textContent = is === 'asc' ? '▲' : is === 'desc' ? '▼' : '↕';
  });
}

function renderTable(rows){
  const tbody = qs('summaryTbody');
  tbody.innerHTML = '';

  const sorted = sortRows(rows);
  if (!sorted.length){
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="3" class="muted">No results for this month/search.</td>`;
    tbody.appendChild(tr);
    return;
  }

  for (const r of sorted){
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
  applySortIndicators();
}

/* ==================== Controller ==================== */
let isLoading = false;

async function loadSummary(){
  if (isLoading) return;
  isLoading = true;
  qs('summaryTbody').style.opacity = '0.6';

  try{
    const monthStart = monthInputToStart();
    const search = qs('searchInput').value || '';
    qs('printMonthLabel').textContent = monthLabel(monthStart);

    const { rows, source } = await fetchMonthlySummary(monthStart, search);
    currentRows = rows;

    renderKPIs(currentRows);
    renderTable(currentRows);
    console.info(`Admin summary loaded from ${source}: ${currentRows.length} rows`);
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

function toggleSort(nextKey){
  if (sortState.key === nextKey) {
    sortState.dir = sortState.dir === 'asc' ? 'desc' : sortState.dir === 'desc' ? 'asc' : 'asc';
  } else {
    sortState = { key: nextKey, dir: 'asc' };
  }
  renderTable(currentRows);
}
function wireSorting(){
  qs('thWorker').addEventListener('click', () => toggleSort('display_name'));
  qs('thShifts').addEventListener('click', () => toggleSort('shifts_count'));
  qs('thHours').addEventListener('click',  () => toggleSort('total_hours'));
}

/* ==================== Drawer (Step 3) ==================== */
function openDrawer(){
  qs('drawer').classList.add('open'); qs('drawer').classList.remove('hidden');
  qs('drawerBackdrop').classList.add('show'); qs('drawerBackdrop').classList.remove('hidden');
}
function closeDrawer(){
  qs('drawer').classList.remove('open'); qs('drawerBackdrop').classList.remove('show');
  setTimeout(() => { qs('drawer').classList.add('hidden'); qs('drawerBackdrop').classList.add('hidden'); }, 250);
}
function renderDrawerHeader(name, monthStartStr){
  qs('drawerTitle').textContent = name || '—';
  qs('drawerSubtitle').textContent = monthLabel(monthStartStr);
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
          <button class="btn small" data-edit-id="${s.id}">Edit</button>
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
  const monthStart = tr.dataset.monthStart;
  const displayName = tr.dataset.displayName || '—';
  drawerContext = { employeeId, monthStart, displayName };

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
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDrawer(); });
  qs('summaryTbody').addEventListener('click', onRowClick);

  // Delegate edit clicks inside drawer
  qs('drawerList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-edit-id]');
    if (!btn) return;
    const shiftId = btn.getAttribute('data-edit-id');
    const shift = currentShiftsById.get(shiftId);
    if (shift) openEditModal(shift);
  });
}

/* ==================== Edit Modal (Step 2.1) ==================== */
let editingShiftId = null;
let saving = false;

function openEditModal(shift){
  editingShiftId = shift.id;
  qs('editIn').value  = toDatetimeLocalValue(shift.clock_in);
  qs('editOut').value = toDatetimeLocalValue(shift.clock_out);
  qs('editReason').value = '';
  qs('editError').textContent = ''; show(qs('editError'), false);
  updateEditDuration();

  // show
  qs('editModal').classList.add('open'); qs('editModal').classList.remove('hidden');
  qs('editModalBackdrop').classList.add('show'); qs('editModalBackdrop').classList.remove('hidden');
  qs('editIn').focus();
}
function closeEditModal(){
  editingShiftId = null; saving = false;
  qs('editModal').classList.remove('open'); qs('editModalBackdrop').classList.remove('show');
  setTimeout(() => { qs('editModal').classList.add('hidden'); qs('editModalBackdrop').classList.add('hidden'); }, 180);
}
function updateEditDuration(){
  const a = qs('editIn').value; const b = qs('editOut').value;
  if (!a || !b){ qs('editDuration').textContent = '—'; return; }
  const ms = new Date(a) - new Date(a); // trick to force parse; real diff below
  const start = new Date(a); const end = new Date(b);
  const diff = end - start;
  qs('editDuration').textContent = diff > 0 ? fmtDurationHM(diff) : '—';
}
function showToast(msg, type='ok'){
  let t = document.querySelector('.toast');
  if (!t){
    t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('ok','err'); t.classList.add(type);
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}
function setEditError(msg){
  const el = qs('editError');
  el.textContent = msg || '';
  show(el, !!msg);
}
async function saveEdit(){
  if (saving) return;
  if (!editingShiftId) return;

  const inVal  = qs('editIn').value;
  const outVal = qs('editOut').value;
  const reason = (qs('editReason').value || '').trim();

  // client-side validations
  if (!inVal || !outVal){ setEditError('Both times are required.'); return; }
  const start = new Date(inVal), end = new Date(outVal);
  if (!(start instanceof Date) || isNaN(start) || !(end instanceof Date) || isNaN(end)){
    setEditError('Invalid date/time values.'); return;
  }
  if (end < start){ setEditError('Clock-out must be after clock-in.'); return; }
  if (reason.length < 3){ setEditError('Reason is required (min 3 characters).'); return; }

  setEditError('');
  saving = true;
  qs('editSaveBtn').disabled = true;
  qs('editSaveBtn').textContent = 'Saving…';

  try{
    const inISO  = localInputToOffsetISO(inVal);
    const outISO = localInputToOffsetISO(outVal);

    const { data, error } = await supabaseClient.rpc('admin_update_shift_time', {
      _time_entry_id: editingShiftId,
      _new_clock_in:  inISO,
      _new_clock_out: outISO,
      _reason:        reason
    });

    if (error) throw error;

    showToast('Shift updated', 'ok');
    closeEditModal();

    // Refresh drawer + summary
    const { employeeId, monthStart } = drawerContext;
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
    await loadSummary();
  }catch(err){
    console.error('Edit failed', err);
    const msg = err?.message || 'Failed to save changes';
    setEditError(msg);
  }finally{
    saving = false;
    qs('editSaveBtn').disabled = false;
    qs('editSaveBtn').textContent = 'Save';
  }
}

function wireEditModal(){
  qs('editCloseBtn').addEventListener('click', closeEditModal);
  qs('editCancelBtn').addEventListener('click', closeEditModal);
  qs('editModalBackdrop').addEventListener('click', closeEditModal);
  qs('editIn').addEventListener('input', updateEditDuration);
  qs('editOut').addEventListener('input', updateEditDuration);
  qs('editSaveBtn').addEventListener('click', saveEdit);
  document.addEventListener('keydown', (e) => {
    if (!qs('editModal').classList.contains('hidden') && e.key === 'Escape') closeEditModal();
  });
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
  wireSorting();
  wireDrawer();
  wireEditModal();

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
