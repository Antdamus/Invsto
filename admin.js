// admin.js — Overview + Drawer/Edit/Audit + Payroll Weekly + Period Lock/Unlock (Phase 3.3)
let supabaseClient = null;
let drawerOnlyAnoms = false;
let lastDrawerShifts = []; // keep latest list to re-render on toggle

// ===== Global calendar state =====
let gcMonthStart = null; // first day of the month being shown (Date)
// =========================================================
// Minimal Toast Helper (admin.js needs this)
// =========================================================

import {
  uploadW9ViaEdge,
  listW9ViaEdge,
  getW9SignedUrlViaEdge,
  setW9StatusViaEdge
} from './admin-taxdocs.js';


function toast(message, kind = "ok") {
  try {
    // Create container once
    let wrap = document.getElementById("og-toast-wrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "og-toast-wrap";
      wrap.style.position = "fixed";
      wrap.style.right = "18px";
      wrap.style.bottom = "18px";
      wrap.style.zIndex = "99999";
      wrap.style.display = "flex";
      wrap.style.flexDirection = "column";
      wrap.style.gap = "10px";
      document.body.appendChild(wrap);
    }

    const t = document.createElement("div");
    t.textContent = message || "";
    t.style.padding = "10px 12px";
    t.style.borderRadius = "12px";
    t.style.fontSize = "13px";
    t.style.maxWidth = "360px";
    t.style.backdropFilter = "blur(14px)";
    t.style.webkitBackdropFilter = "blur(14px)";
    t.style.border = "1px solid rgba(255,255,255,0.08)";
    t.style.boxShadow = "0 18px 50px rgba(0,0,0,0.45)";
    t.style.background =
      kind === "err" || kind === "warn"
        ? "rgba(140, 60, 60, 0.55)"
        : "rgba(25, 25, 28, 0.70)";
    t.style.color = "rgba(255,255,255,0.92)";
    t.style.transform = "translateY(8px)";
    t.style.opacity = "0";
    t.style.transition = "all 220ms ease";

    wrap.appendChild(t);

    requestAnimationFrame(() => {
      t.style.transform = "translateY(0)";
      t.style.opacity = "1";
    });

    setTimeout(() => {
      t.style.opacity = "0";
      t.style.transform = "translateY(8px)";
      setTimeout(() => t.remove(), 220);
    }, 2600);
  } catch {
    // fallback
    alert(message);
  }
}

function applyDirectionsLinkFromStoreId(linkEl, storeId) {
  if (!linkEl || typeof storeId !== "string") return;

  const store = storesById[storeId]; // or however you map stores
  if (!store || store.lat == null || store.lng == null) {
    linkEl.href = "#";
    linkEl.classList.add("disabled");
    return;
  }

  linkEl.href = `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}`;
  linkEl.classList.remove("disabled");
}


function storeDirectionsHref(storeId){
  const s = storesById.get(storeId);
  if (!s) return '#';

  const lat = Number(s.lat);
  const lng = Number(s.lng);

  // Fallback: if coords missing, search by name
  if (!Number.isFinite(lat) || !Number.isFinite(lng)){
    const q = encodeURIComponent(s.name || 'store');
    return `https://www.google.com/maps/search/?api=1&query=${q}`;
  }

  // Pin to coordinates
  return `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`;
}

function storeOptionsHTML(selectedId = null){
  let html = `<option value="">— Select store —</option>`;

  for (const s of storesCache){
    const sel = s.id === selectedId ? 'selected' : '';
    html += `<option value="${s.id}" ${sel}>${s.name}</option>`;
  }

  return html;
}

// helpers
const pad2 = n => String(n).padStart(2,'0');
const toISODate = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
const yyyymm = d => `${d.getFullYear()}-${pad2(d.getMonth()+1)}`;
function getMonthStart(d){ return new Date(d.getFullYear(), d.getMonth(), 1); }
function nextMonth(d){ return new Date(d.getFullYear(), d.getMonth()+1, 1); }
function prevMonth(d){ return new Date(d.getFullYear(), d.getMonth()-1, 1); }

// First visible cell in a month-view calendar (the Sunday before/at the 1st)
function startOfMonthGrid(d){
  const x = new Date(d.getFullYear(), d.getMonth(), 1);
  const dow = x.getDay(); // 0=Sun
  return new Date(x.getFullYear(), x.getMonth(), 1 - dow);
}

// Week helpers (Schedule + Payroll)
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function startOfWeekSun(d){
  const x = new Date(d);
  x.setHours(0,0,0,0);
  x.setDate(x.getDate() - x.getDay()); // Sunday start
  return x;
}

function fromISO(yyyyMmDd){
  if (!yyyyMmDd) return new Date(NaN);
  const [y,m,dd] = yyyyMmDd.split('-').map(Number);
  return new Date(y, (m||1)-1, dd||1);
}

function weekLabel(weekStart){
  const a = new Date(weekStart);
  const b = addDays(a, 6);
  return `${a.getMonth()+1}/${a.getDate()}–${b.getMonth()+1}/${b.getDate()}`;
}


function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function fmtHM(ts){ if(!ts) return ''; const dd=new Date(ts); return dd.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }

function qs(id){ return document.getElementById(id); }
function show(el, v){ el.classList.toggle('hidden', !v); }
function fmtHours(n){ if (n == null || Number.isNaN(n)) return '—'; const s = Number(n).toFixed(2); return s.replace(/\.00$/, ''); }
function fmtDurationHM(ms){ if (ms == null || !Number.isFinite(ms)) return '—'; const m=Math.round(ms/60000), h=Math.floor(m/60), r=m%60; return `${h}h ${String(r).padStart(2,'0')}m`; }
function debounce(fn, ms=300){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }
function monthInputToStart(){ const v=qs('monthInput')?.value; if(!v||!/^\d{4}-\d{2}$/.test(v)){ const now=new Date(); return `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-01`; } return `${v}-01`; }
function monthLabel(yyyyMm01){ const d=new Date(yyyyMm01+'T00:00:00'); return d.toLocaleString(undefined,{month:'long',year:'numeric'}); }
function toDatetimeLocalValue(iso){ if(!iso) return ''; const d=new Date(iso); const p=n=>String(n).padStart(2,'0'); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; }
function localInputToOffsetISO(localStr){ const d=new Date(localStr); if(Number.isNaN(d.getTime())) return null; const p=n=>String(n).padStart(2,'0'); const tzMin=-d.getTimezoneOffset(); const sign=tzMin>=0?'+':'-'; const offH=p(Math.floor(Math.abs(tzMin)/60)); const offM=p(Math.abs(tzMin)%60); return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:00${sign}${offH}:${offM}`; }
function fmtLocal(iso){ if(!iso) return '—'; return new Date(iso).toLocaleString(); }
function showToast(msg, type='ok'){ let t=document.querySelector('.toast'); if(!t){ t=document.createElement('div'); t.className='toast'; document.body.appendChild(t); } t.textContent=msg; t.classList.remove('ok','err'); t.classList.add(type); t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2200); }

async function fetchGlobalScheduleRange(gridStart, gridEnd){
  const { data, error } = await supabaseClient.rpc('get_schedule_range_all', {
    _start: toISODate(gridStart),
    _end: toISODate(gridEnd)
  });
  if (error) throw error;
  return data || [];
}

function renderGlobalCalendar(rows, gridStart, monthStart){
  const grid = qs('globalCalGrid'); if (!grid) return;
  grid.innerHTML = '';

  // group rows by work_date (YYYY-MM-DD)
  const byDate = new Map();
  for (const r of rows){
    const key = toISODate(new Date(r.work_date));
    const list = byDate.get(key) || [];
    list.push(r);
    byDate.set(key, list);
  }

  // 6 weeks view (42 cells)
  for (let i=0; i<42; i++){
    const day = addDays(gridStart, i);
    const iso = toISODate(day);
    const outOfMonth = day.getMonth() !== monthStart.getMonth();

    const cell = document.createElement('div');
    cell.className = `cal-day${outOfMonth ? ' out':''}`;

    cell.innerHTML = `
      <div class="cal-day-header">
        <span class="cal-date">${day.getDate()}</span>
      </div>
      <div class="cal-slots"></div>
    `;

    const slotsEl = cell.querySelector('.cal-slots');
    const items = (byDate.get(iso) || []).sort((a,b)=> (a.display_name||'').localeCompare(b.display_name||''));

    // name filter (client-side)
    const q = (qs('gcSearch').value || '').trim().toLowerCase();
    const filtered = q ? items.filter(x => (x.display_name||'').toLowerCase().includes(q)) : items;

    for (const r of filtered){
      const slot = document.createElement('div');
      slot.className = 'cal-slot';
      slot.dataset.employeeId = r.employee_id;
      slot.dataset.monthStart = toISODate(monthStart);

      slot.innerHTML = `
        <span class="name">${r.display_name}</span>
        <span class="time">${fmtHM(r.start_ts)}–${fmtHM(r.end_ts)}</span>
      `;
      slotsEl.appendChild(slot);
    }

    grid.appendChild(cell);
  }
}

// ✅ REPLACE the whole inviteWorkerByEmail(email) with this:
// Uses Edge Function "admin-user" which runs with service role on the server.
async function inviteWorkerByEmail(email) {
  try {
    email = (email || '').trim().toLowerCase();
    if (!email) throw new Error('Email is required.');

    // Minimal defaults for quick testing (you can upgrade UI later)
    const display_name = email.split('@')[0] || 'New Worker';
    const role = 'employee';

    const { data, error } = await supabaseClient.functions.invoke('admin-user', {
      body: { action: 'invite', email, display_name, role }
    });

    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Invite failed.');

    showToast(`Invite sent to ${email}`, 'ok');
  } catch (err) {
    console.error(err);
    showToast(err.message || 'Failed to invite worker', 'err');
  }
}

// --- RAW invoke so we can read JSON even on 400/403/etc ---
// --- RAW invoke so we can read JSON even on 400/403/etc ---
// Works WITHOUT window.SUPABASE_URL / window.SUPABASE_ANON_KEY
async function invokeEdgeJson(functionName, payload) {
  const { data: sessionData, error: sessErr } = await supabaseClient.auth.getSession();
  if (sessErr) throw sessErr;

  const accessToken = sessionData?.session?.access_token;
  if (!accessToken) throw new Error("Missing session access token.");

  // Pull these from the already-initialized client (no globals needed)
  const supaUrl =
    supabaseClient?.supabaseUrl ||
    supabaseClient?.rest?.url?.replace(/\/rest\/v1\/?$/, '') ||
    "";

  const anonKey =
    supabaseClient?.supabaseKey ||
    supabaseClient?.headers?.apikey ||
    supabaseClient?.global?.headers?.apikey ||
    "";

  if (!supaUrl || !anonKey) {
    throw new Error("Supabase client is missing URL/key (initSupabase.js didn’t expose them).");
  }

  const url = `${supaUrl}/functions/v1/${functionName}`;

  const resp = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "apikey": anonKey,
      "Authorization": `Bearer ${accessToken}`,
    },
    body: JSON.stringify(payload),
  });

  let json;
  try { json = await resp.json(); } catch { json = null; }

  if (!resp.ok) {
    const msg = json?.error || json?.message || `Edge Function error (${resp.status})`;
    const detail = json?.detail ? ` — ${json.detail}` : "";
    throw new Error(msg + detail);
  }

  return json;
}

// expose once (optional)
if (!window.invokeEdgeJson) {
  window.invokeEdgeJson = invokeEdgeJson;
}


async function resendInvite(tr){
  const employee_id = tr?.dataset?.employeeId;
  const email = (tr?.querySelector('td.mono')?.textContent || '').trim();

  if (!employee_id && !email) throw new Error('Missing employee reference.');

  const { data, error } = await supabaseClient.functions.invoke('admin-user', {
    body: { action: 'resend', employee_id: employee_id || undefined, email: email || undefined }
  });

  if (error) throw error;
  if (!data?.ok) throw new Error('Resend failed.');

  showToast('Invite resent ✉️', 'ok');
  await loadUsers();
}

function escapeHtml(s){
  return (s ?? '').toString()
    .replaceAll('&','&amp;')
    .replaceAll('<','&lt;')
    .replaceAll('>','&gt;')
    .replaceAll('"','&quot;')
    .replaceAll("'","&#039;");
}

async function markAcceptedIfNeeded() {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;
    await supabaseClient.rpc('mark_invite_accepted');
  } catch (e) {
    console.warn('mark_invite_accepted failed:', e);
  }
}


function wireUsersPanel() {
  const btn = document.getElementById('userAddBtn');
  if (!btn) return;

  // Open the premium invite modal (not the old prompt)
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    openUserModal();
  });
}



async function loadGlobalCalendar(){
  try {
    // month controls
    qs('gcMonth').value = yyyymm(gcMonthStart);

    // calendar grid range (from the Sunday before the 1st to cover 6 weeks)
    const gridStart = startOfMonthGrid(gcMonthStart);

    const gridEnd = addDays(gridStart, 41);

    const rows = await fetchGlobalScheduleRange(gridStart, gridEnd);
    renderGlobalCalendar(rows, gridStart, gcMonthStart);
  } catch (err){
    console.error(err);
    const grid = qs('globalCalGrid'); if (grid) grid.innerHTML = `<div class="muted" style="grid-column:1/-1; padding:10px;">Failed to load global calendar.</div>`;
  }
}

function wireGlobalCalendar(){
  // toggle sections
  const emBtn = qs('modeEmp'), glBtn = qs('modeGlobal');
  const empSec = qs('schedEmpSection'), glbSec = qs('schedGlobalSection');
  emBtn?.addEventListener('click', () => {
    emBtn.classList.add('active'); glBtn.classList.remove('active');
    empSec.classList.remove('hidden'); glbSec.classList.add('hidden');
  });
  glBtn?.addEventListener('click', async () => {
    glBtn.classList.add('active'); emBtn.classList.remove('active');
    glbSec.classList.remove('hidden'); empSec.classList.add('hidden');
    if (!gcMonthStart) gcMonthStart = getMonthStart(new Date());
    await loadGlobalCalendar();
  });

  // controls
  qs('gcPrev')?.addEventListener('click', async () => { gcMonthStart = prevMonth(gcMonthStart); await loadGlobalCalendar(); });
  qs('gcNext')?.addEventListener('click', async () => { gcMonthStart = nextMonth(gcMonthStart); await loadGlobalCalendar(); });
  qs('gcToday')?.addEventListener('click', async () => { gcMonthStart = getMonthStart(new Date()); await loadGlobalCalendar(); });
  qs('gcMonth')?.addEventListener('change', async () => {
    const v = qs('gcMonth').value; // "YYYY-MM"
    if (!v) return;
    const [y,m] = v.split('-').map(Number);
    gcMonthStart = new Date(y, m-1, 1);
    await loadGlobalCalendar();
  });
  qs('gcSearch')?.addEventListener('input', async () => { await loadGlobalCalendar(); });

  // click a slot → open that worker's drawer on the selected month
  qs('globalCalGrid')?.addEventListener('click', async (e) => {
    const slot = e.target.closest('.cal-slot'); if (!slot) return;
    const employeeId = slot.dataset.employeeId;
    const monthStartISO = slot.dataset.monthStart;

    const emps = await getActiveEmployees();
    const displayName = (emps.find(x => x.id === employeeId)?.display_name) || '—';

    drawerContext = { employeeId, monthStart: monthStartISO, displayName };
    renderDrawerHeader(displayName, monthStartISO);
    qs('drawerList').innerHTML = `<div class="drawer-empty">Loading shifts…</div>`;
    openDrawer();
    try{
      const shifts = await fetchWorkerShifts(employeeId, monthStartISO);
      renderDrawerSummary(shifts);
      renderDrawerList(shifts);
    }catch(err){
      console.error(err);
      qs('drawerList').innerHTML = `<div class="drawer-empty">Error loading shifts.</div>`;
    }
  });
}
async function waitForSupabaseReady(timeoutMs = 8000) {
  const start = Date.now();
  while (!window.supabase) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("Supabase client not initialized (window.supabase is undefined)");
    }
    await new Promise(r => setTimeout(r, 50));
  }
  return window.supabase;
}

/* ============== Admin Guard ============== */
/* ============== Admin Guard (table-based, most reliable) ============== */
async function ensureAdmin() {
  // session guard
  const { data: { session }, error: sessErr } = await supabaseClient.auth.getSession();
  if (sessErr) console.warn(sessErr);
  if (!session) {
    window.location.href = "index.html?next=" + encodeURIComponent("admin.html");
    return false;
  }

  // user -> employees row guard
  const { data: { user }, error: userErr } = await supabaseClient.auth.getUser();
  if (userErr || !user) {
    window.location.href = "index.html?next=" + encodeURIComponent("admin.html");
    return false;
  }

  const { data: emp, error: empErr } = await supabaseClient
    .from("employees")
    .select("role, active")
    .eq("user_id", user.id)
    .maybeSingle();

  if (empErr) {
    console.error("Admin guard failed to read employees:", empErr);
    window.location.href = `index.html?reason=${encodeURIComponent("Admin only")}`;
    return false;
  }

  const ok = !!emp && emp.active === true && emp.role === "admin";
  if (!ok) {
    window.location.href = `index.html?reason=${encodeURIComponent("Admin only")}`;
    return false;
  }

  return true;
}



function wireHeaderActions() {
  qs('signOutBtn').addEventListener('click', async () => { await supabaseClient.auth.signOut(); window.location.href = 'index.html'; });
  qs('printBtn').addEventListener('click', () => window.print());
}

function dateStrAddDays(yyyyMmDd, days){
  const d = new Date(yyyyMmDd + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

async function signPath(path, expiresSec = 180){
  if (!path) return null;
  try {
    const { data } = await supabaseClient
      .storage.from('timeclock-photos')
      .createSignedUrl(path, expiresSec);
    return data?.signedUrl || null;
  } catch { return null; }
}

// Cache active employees for joins in Overview/Payroll
let _activeEmployees = null;
async function getActiveEmployees(){
  if (_activeEmployees) return _activeEmployees;
  const { data, error } = await supabaseClient
    .from('employees')
    .select('id, display_name')
    .eq('active', true)
    .order('display_name', { ascending: true });
  if (error) throw error;
  _activeEmployees = data || [];
  return _activeEmployees;
}

/* ============== Overview (monthly) ============== */
// Return ALL active employees for the month, filling zeros when no rows exist
async function fetchMonthlySummary(monthStart){
  const [emps, viewResp] = await Promise.all([
    getActiveEmployees(),
    supabaseClient.from('v_monthly_hours')
      .select('employee_id, month_start, shifts_count, total_hours')
      .eq('month_start', monthStart)
  ]);
  const byId = new Map((viewResp.data || []).map(r => [r.employee_id, r]));
  const rows = emps.map(e => {
    const v = byId.get(e.id) || {};
    return {
      employee_id: e.id,
      display_name: e.display_name,
      month_start: monthStart,
      shifts_count: v.shifts_count || 0,
      total_hours: v.total_hours || 0
    };
  });
  return { rows, source: 'view' };
}

// Pending shift review counts for Overview month (approval_status = 'pending')
// Pending shift review counts for Overview month
// "Pending" = completed time_entry in month with NO row in shift_approvals
async function fetchMonthlyPendingReviewCounts(monthStartStr){
  const start = new Date(`${monthStartStr}T00:00:00`);
  const end = new Date(start);
  end.setMonth(start.getMonth() + 1);

  // 1) get completed shifts in the month
  const { data: entries, error: teErr } = await supabaseClient
    .from('time_entries')
    .select('id, employee_id, clock_out')
    .gte('clock_in', start.toISOString())
    .lt('clock_in', end.toISOString())
    .not('clock_out', 'is', null); // only finished shifts

  if (teErr) throw teErr;

  const rows = entries || [];
  if (!rows.length) return new Map();

  const ids = rows.map(r => r.id);
  const idToEmp = new Map(rows.map(r => [r.id, r.employee_id]));

  // 2) fetch approvals that exist for those shifts
  const { data: approvals, error: apErr } = await supabaseClient
    .from('shift_approvals')
    .select('time_entry_id')
    .in('time_entry_id', ids);

  if (apErr) throw apErr;

  const approvedSet = new Set((approvals || []).map(a => a.time_entry_id));

  // 3) anything NOT in shift_approvals is pending
  const counts = new Map();
  for (const id of ids){
    if (approvedSet.has(id)) continue;
    const empId = idToEmp.get(id);
    if (!empId) continue;
    counts.set(empId, (counts.get(empId) || 0) + 1);
  }

  return counts;
}


// Fetch resolved schedule for the week (recurring+overrides → concrete slots)
async function fetchResolvedWeek(empId, weekStart){
  const start = toISODate(weekStart);
  const end   = toISODate(addDays(weekStart, 6));
  const { data, error } = await supabaseClient.rpc('get_employee_schedule', {
    _employee_id: empId, _start: start, _end: end
  });
  if (error) throw error;
  // Map by work_date (ISO) → { start_ts, end_ts, source, store_id }
  const byDate = new Map();
  for (const r of (data||[])){
    byDate.set(r.work_date, r);
  }
  return byDate;
}

// Fetch overrides for the week so we can prefill that column
async function fetchWeekOverrides(employeeId, weekStart){
  const startISO = toISODate(weekStart);
  const endISO = toISODate(addDays(weekStart, 6));

  const { data, error } = await supabaseClient
    .from('work_schedule_overrides')
    .select('work_date, off, start_local, end_local, store_id, note')
    .eq('employee_id', employeeId)
    .gte('work_date', startISO)
    .lte('work_date', endISO);

  if (error) throw error;

  const map = new Map();
  for (const r of (data || [])){
    map.set(r.work_date, r);
  }
  return map;
}


function fmtTimeHM(ts){
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function storeNameById(storeId){
  if (!storeId) return '';
  const s = _allStores.find(x => x.id === storeId);
  return s?.name || '';
}


function renderScheduleGrid(weekStart, resolvedByDate, overridesByDate){
  const tbody = qs('schedBody');
  tbody.innerHTML = '';

  for (let i=0;i<7;i++){
    const day = addDays(weekStart, i);
    const iso = toISODate(day);

    const resolved = resolvedByDate.get(iso) || null; // { start_ts, end_ts, source, store_id }
    const ov = overridesByDate.get(iso) || null;      // { off, start_local, end_local, store_id, ...exceptions }

    const resolvedStr = resolved
      ? `${fmtTimeHM(resolved.start_ts)}–${fmtTimeHM(resolved.end_ts)}`
      : '—';
    const srcStr = resolved ? (resolved.source === 'override' ? 'override' : 'recurring') : '';
    //const resolvedStoreLabel = resolved?.store_id ? storeName(resolved.store_id) : '—';
    const resolvedStoreLabel = resolved?.store_id ? storeNameById(resolved.store_id) : '—';
    const resolvedDirHref = resolved?.store_id ? storeDirectionsHref(resolved.store_id) : null;

    const resolvedHtml = `
      <div class="sched-resolved">
        ${resolvedStr} ${srcStr ? `<span class="sched-note">(${srcStr})</span>` : ''}
        <div class="sched-sub">
          <span class="sched-store">${resolvedStoreLabel}</span>
          ${resolvedDirHref ? `<a class="mini-link" href="${resolvedDirHref}" target="_blank" rel="noopener noreferrer">Directions</a>` : ''}
        </div>
      </div>
    `;

    const recStartPrefill = (resolved && resolved.source === 'recurring')
      ? new Date(resolved.start_ts).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:false})
      : '';
    const recEndPrefill = (resolved && resolved.source === 'recurring')
      ? new Date(resolved.end_ts).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:false})
      : '';
    const recStorePrefill = (resolved && resolved.source === 'recurring') ? (resolved.store_id || '') : '';

    const ovOff   = ov?.off ? true : false;
    const ovStart = ov?.start_local ? String(ov.start_local).slice(0,5) : '';
    const ovEnd   = ov?.end_local   ? String(ov.end_local).slice(0,5)   : '';
    const ovStore = ov?.store_id ? String(ov.store_id) : '';

    // Phase 3 exception prefill (safe if columns missing)
    const ovAnyIn  = !!ov?.allow_any_store_in;
    const ovAnyOut = !!ov?.allow_any_store_out;
    const ovInStore  = ov?.clock_in_store_id ? String(ov.clock_in_store_id) : '';
    const ovOutStore = ov?.clock_out_store_id ? String(ov.clock_out_store_id) : '';

    const tr = document.createElement('tr');
    tr.className = 'sched-row';

    const recDir = storeDirectionsHref(recStorePrefill);
    const ovDir  = storeDirectionsHref(ovStore);

    const inDir  = storeDirectionsHref(ovAnyIn ? '' : ovInStore);
    const outDir = storeDirectionsHref(ovAnyOut ? '' : ovOutStore);

    tr.innerHTML = `
      <td class="day">${DOW[i]} ${day.getMonth()+1}/${day.getDate()}</td>

      <td>
        <div class="row">
          <input class="time" type="time" id="recStart-${i}" value="${recStartPrefill}">
          <span>–</span>
          <input class="time" type="time" id="recEnd-${i}" value="${recEndPrefill}">
        </div>

        <div class="row" style="margin-top:6px;">
          <select class="store" id="recStore-${i}">
            ${storeOptionsHTML(recStorePrefill)}
          </select>
          <a class="mini-link" id="recDir-${i}" href="${recDir || '#'}" target="_blank" rel="noopener noreferrer">Directions</a>
        </div>

        <div class="sched-buttons" style="margin-top:6px;">
          <button class="btn small" data-save-recurring="${i}">Save recurring</button>
          <button class="btn small ghost" data-clear-recurring="${i}">Remove recurring</button>
        </div>
      </td>

      <td>
        <div class="row">
          <label><input type="checkbox" id="ovOff-${iso}" ${ovOff ? 'checked' : ''}> Off</label>
          <input class="time" type="time" id="ovStart-${iso}" value="${ovStart}" ${ovOff ? 'disabled':''}>
          <span>–</span>
          <input class="time" type="time" id="ovEnd-${iso}" value="${ovEnd}" ${ovOff ? 'disabled':''}>
        </div>

        <div class="row" style="margin-top:6px;">
          <select class="store" id="ovStore-${iso}" ${ovOff ? 'disabled':''}>
            ${storeOptionsHTML(ovStore)}
          </select>
          <a class="mini-link" id="ovDir-${iso}" href="${ovDir || '#'}" target="_blank" rel="noopener noreferrer">Directions</a>
        </div>

        <!-- Phase 3: per-day exceptions -->
        <div class="ex-grid">
          <div class="ex-block">
            <div class="ex-title">Clock-in exception</div>
            <div class="ex-row">
              <label class="switch mini" style="margin:0;">
                <input id="ovAnyIn-${iso}" type="checkbox" ${ovAnyIn ? 'checked' : ''} ${ovOff ? 'disabled':''}/>
                <span>Any store</span>
              </label>
              <select class="store" id="ovInStore-${iso}" ${ovOff || ovAnyIn ? 'disabled':''}>
                ${storeOptionsHTML(ovInStore)}
              </select>
              <a class="mini-link" id="ovInDir-${iso}" href="${inDir || '#'}" target="_blank" rel="noopener noreferrer">Directions</a>
            </div>
          </div>

          <div class="ex-block">
            <div class="ex-title">Clock-out exception</div>
            <div class="ex-row">
              <label class="switch mini" style="margin:0;">
                <input id="ovAnyOut-${iso}" type="checkbox" ${ovAnyOut ? 'checked' : ''} ${ovOff ? 'disabled':''}/>
                <span>Any store</span>
              </label>
              <select class="store" id="ovOutStore-${iso}" ${ovOff || ovAnyOut ? 'disabled':''}>
                ${storeOptionsHTML(ovOutStore)}
              </select>
              <a class="mini-link" id="ovOutDir-${iso}" href="${outDir || '#'}" target="_blank" rel="noopener noreferrer">Directions</a>
            </div>
          </div>
        </div>

        <div class="sched-buttons" style="margin-top:8px;">
          <button class="btn small" data-save-override="${iso}">Save override</button>
          <button class="btn small ghost" data-clear-override="${iso}">Clear override</button>
        </div>
      </td>

      <td>${resolvedHtml}</td>
    `;

    tbody.appendChild(tr);

    applyDirectionsLinkFromStoreId(qs(`recDir-${i}`), recStorePrefill);
    applyDirectionsLinkFromStoreId(ovStore, qs(`ovDir-${iso}`));
    applyDirectionsLinkFromStoreId(ovAnyIn ? '' : ovInStore, qs(`ovInDir-${iso}`));
    applyDirectionsLinkFromStoreId(ovAnyOut ? '' : ovOutStore, qs(`ovOutDir-${iso}`));
  }
}


async function saveRecurring(weekday){
  const empId = schedEmpId;
  const start = qs(`recStart-${weekday}`).value || '';
  const end   = qs(`recEnd-${weekday}`).value || '';
  const storeId = qs(`recStore-${weekday}`)?.value || null;
  const effFrom = qs('schedEffFrom').value || toISODate(new Date());

  if (!start || !end) return alert('Enter start and end time for recurring.');
  if (end <= start) return alert('End must be after start.');
  if (!storeId) return alert('Pick a store for this recurring schedule.');

  const { error } = await supabaseClient.rpc('admin_set_weekday_slot', {
    _employee_id: empId,
    _weekday: weekday,
    _start_local: start,
    _end_local: end,
    _effective_from: effFrom,
    _effective_to: null,
    _store_id: storeId,
    _note: null
  });

  if (error) return alert('Save failed: ' + error.message);
  await loadScheduleWeek();
}

async function clearRecurring(weekday){
  const empId = schedEmpId;
  const effFrom = qs('schedEffFrom')?.value || toISODate(new Date());

  if (!empId) return alert('Pick an employee first.');
  if (!effFrom) return alert('Pick an effective-from date.');

  const dayName = (typeof DOW !== 'undefined' && DOW[weekday]) ? DOW[weekday] : `weekday ${weekday}`;
  const ok = window.confirm(
    `Remove recurring schedule for ${dayName} starting ${effFrom} and forward?\n\n` +
    `This removes future recurring slots, but keeps history.`
  );
  if (!ok) return;

  await markAcceptedIfNeeded();


  // dayBefore = effFrom - 1 day (YYYY-MM-DD)
  const dayBefore = (() => {
    const d = new Date(`${effFrom}T00:00:00`);
    d.setDate(d.getDate() - 1);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  })();

  try {
    // Grab all schedule rows that could apply on/after effFrom
    // (active rows where effective_to is null OR effective_to >= effFrom)
    const { data: rows, error: selErr } = await supabaseClient
      .from('work_schedules')
      .select('id, effective_from, effective_to')
      .eq('employee_id', empId)
      .eq('weekday', weekday)
      .eq('active', true)
      .or(`effective_to.is.null,effective_to.gte.${effFrom}`);

    if (selErr) throw selErr;

    if (!rows || rows.length === 0){
      showToast?.('No recurring schedule to remove', 'ok');
      await loadScheduleWeek();
      return;
    }

    const toDelete = [];
    const toCap = [];

    for (const r of rows){
      const ef = String(r.effective_from);
      if (ef >= effFrom) toDelete.push(r.id);
      else toCap.push(r.id);
    }

    // Cap older rows so they end the day before effFrom.
    // If capping would make effective_to < effective_from, delete instead.
    const capIds = [];
    for (const r of rows){
      if (!toCap.includes(r.id)) continue;
      const ef = String(r.effective_from);
      if (dayBefore < ef) toDelete.push(r.id);
      else capIds.push(r.id);
    }

    if (capIds.length){
      const { error: upErr } = await supabaseClient
        .from('work_schedules')
        .update({ effective_to: dayBefore })
        .in('id', capIds);
      if (upErr) throw upErr;
    }

    if (toDelete.length){
      const { error: delErr } = await supabaseClient
        .from('work_schedules')
        .delete()
        .in('id', toDelete);
      if (delErr) throw delErr;
    }

    showToast?.('Recurring schedule removed', 'ok');
    await loadScheduleWeek();
  } catch (err) {
    console.error(err);
    const msg =
      err?.message ||
      err?.error_description ||
      (typeof err === 'string' ? err : JSON.stringify(err));
    alert('Remove recurring failed: ' + msg);
  }
}

async function patchOverrideExceptionExtras(empId, workISO, extras){
  // This tries to update the override row after your existing RPC runs.
  // If the DB columns don’t exist yet, we fail silently (so you don’t brick the page).
  const patch = {
    allow_any_store_in: !!extras.allow_any_store_in,
    allow_any_store_out: !!extras.allow_any_store_out,
    clock_in_store_id: extras.clock_in_store_id || null,
    clock_out_store_id: extras.clock_out_store_id || null
  };

  try {
    const { error } = await supabaseClient
      .from('work_schedule_overrides')
      .update(patch)
      .eq('employee_id', empId)
      .eq('work_date', workISO);

    // If the row doesn’t exist (or columns missing), don’t hard-fail
    if (error && !/column .* does not exist/i.test(error.message || '')){
      console.warn('patchOverrideExceptionExtras update error:', error);
    }
  } catch (e){
    console.warn('patchOverrideExceptionExtras failed:', e);
  }
}


async function saveOverride(workISO){
  const empId = schedEmpId;

  const off = qs(`ovOff-${workISO}`).checked;
  const s = qs(`ovStart-${workISO}`);
  const e = qs(`ovEnd-${workISO}`);
  const start = s?.value || null;
  const end   = e?.value || null;

  const storeId = qs(`ovStore-${workISO}`)?.value || null;

  // Phase 3 exception UI reads
  const anyIn  = !!qs(`ovAnyIn-${workISO}`)?.checked;
  const anyOut = !!qs(`ovAnyOut-${workISO}`)?.checked;

  const inStore  = anyIn  ? null : (qs(`ovInStore-${workISO}`)?.value || null);
  const outStore = anyOut ? null : (qs(`ovOutStore-${workISO}`)?.value || null);

  if (!off){
    if (!start || !end) return alert('Enter start and end time, or mark Off.');
    if (end <= start) return alert('End must be after start.');
    if (!storeId) return alert('Pick a store for this override.');
  }

  // Base payload (existing RPC)
  const base = {
    _employee_id: empId,
    _work_date: workISO,
    _off: off,
    _start_local: start,
    _end_local: end,
    _store_id: off ? null : storeId,
    _note: null
  };

  // Try a v2 RPC first (if you created it in Supabase)
  // If not available, fall back to old RPC + patch DB columns directly.
  let usedV2 = false;

  try {
    const { error: v2Err } = await supabaseClient.rpc('admin_set_override_v2', {
      ...base,
      _allow_any_store_in: anyIn,
      _allow_any_store_out: anyOut,
      _clock_in_store_id: inStore,
      _clock_out_store_id: outStore
    });

    if (!v2Err){
      usedV2 = true;
    }
  } catch (e){
    // ignore
  }

  if (!usedV2){
    const { error } = await supabaseClient.rpc('admin_set_override', base);
    if (error) return alert('Override failed: ' + error.message);

    // Patch exception columns (if present)
    await patchOverrideExceptionExtras(empId, workISO, {
      allow_any_store_in: anyIn,
      allow_any_store_out: anyOut,
      clock_in_store_id: inStore,
      clock_out_store_id: outStore
    });
  }

  await loadScheduleWeek();
}



async function clearOverride(workISO){
  // Just delete the row; RLS allows admin writes
  const { error } = await supabaseClient
    .from('work_schedule_overrides')
    .delete()
    .eq('employee_id', schedEmpId)
    .eq('work_date', workISO);
  if (error) return alert('Clear failed: ' + error.message);
  await loadScheduleWeek();
}

async function loadScheduleWeek(){
  try {
    // UI labels
    qs('schedWeekLabel').textContent = weekLabel(schedWeekStart);
    qs('schedWeekDate').value = toISODate(schedWeekStart);

    // data
    const [resolvedByDate, overridesByDate] = await Promise.all([
      fetchResolvedWeek(schedEmpId, schedWeekStart),
      fetchWeekOverrides(schedEmpId, schedWeekStart)
    ]);

    renderScheduleGrid(schedWeekStart, resolvedByDate, overridesByDate);
  } catch (err){
    console.error(err);
    qs('schedBody').innerHTML = `<tr><td colspan="4" class="muted">Failed to load schedule.</td></tr>`;
  }
}

// --- Stores cache (for schedule store assignment) ---
let storesCache = [];
let storesById = new Map();
let _storesCacheLoaded = false;

async function ensureStoresCache(force = false){
  if (_storesCacheLoaded && !force) return;
  await loadStoresCache();
  _storesCacheLoaded = true;
}

async function loadStoresCache(){
  const { data, error } = await supabaseClient
    .from('store_locations')
    .select('id, name, lat, lng, radius_m, active, timezone, schedule_enforce')
    .order('active', { ascending: false })
    .order('name', { ascending: true });

  if (error) throw error;

  storesCache = data || [];
  storesById = new Map(storesCache.map(s => [s.id, s]));
}

// ---- Schedule state (required by initSchedulePanel / week nav)
let schedEmpId = null;
let schedWeekStart = startOfWeekSun(new Date()); // Sunday start

async function initSchedulePanel(){
  // Ensure stores are loaded for dropdowns
  await ensureStoresCache();

  // employees
  const emps = await getActiveEmployees();
  const sel = qs('schedEmpSelect');
  sel.innerHTML = emps.map(e => `<option value="${e.id}">${e.display_name}</option>`).join('');
  schedEmpId = emps[0]?.id || null;

  // defaults
  qs('schedEffFrom').value = toISODate(new Date());
  qs('schedWeekDate').value = toISODate(schedWeekStart);

  // event delegation for table buttons
  qs('schedBody').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;

  if (btn.hasAttribute('data-save-recurring')){
  const weekday = Number(btn.getAttribute('data-save-recurring'));
  saveRecurring(weekday);
} else if (btn.hasAttribute('data-clear-recurring')){
  const weekday = Number(btn.getAttribute('data-clear-recurring'));
  clearRecurring(weekday);
} else if (btn.hasAttribute('data-save-override')){
  const iso = btn.getAttribute('data-save-override');
  saveOverride(iso);
} else if (btn.hasAttribute('data-clear-override')){
  const iso = btn.getAttribute('data-clear-override');
  clearOverride(iso);
}


  });

  // change handlers (Off toggle + store change → update directions)
  qs('schedBody').addEventListener('change', (e) => {
    const id = e.target?.id || '';

    // Off toggled → disable times + store select
    if (id.startsWith('ovOff-')){
      const iso = id.slice('ovOff-'.length);
      const on = e.target.checked;

      const s = qs(`ovStart-${iso}`);
      const en = qs(`ovEnd-${iso}`);
      const st = qs(`ovStore-${iso}`);

      if (s) s.disabled = on;
      if (en) en.disabled = on;
      if (st) st.disabled = on;


      const anyIn = qs(`ovAnyIn-${iso}`);
      const anyOut = qs(`ovAnyOut-${iso}`);
      const inSel = qs(`ovInStore-${iso}`);
      const outSel = qs(`ovOutStore-${iso}`);

      if (anyIn) anyIn.disabled = on;
      if (anyOut) anyOut.disabled = on;

      if (inSel) inSel.disabled = on || !!anyIn?.checked;
      if (outSel) outSel.disabled = on || !!anyOut?.checked;

      applyDirectionsLinkFromStoreId(anyIn?.checked ? '' : inSel?.value, qs(`ovInDir-${iso}`));
      applyDirectionsLinkFromStoreId(anyOut?.checked ? '' : outSel?.value, qs(`ovOutDir-${iso}`));

      // Also dim directions if disabled
      if (st) applyDirectionsLinkFromStoreId(st.value, qs(`ovDir-${iso}`));
      return;
    }

    // Recurring store changed → update directions
    if (id.startsWith('recStore-')){
      const weekday = id.slice('recStore-'.length);
      const selEl = qs(`recStore-${weekday}`);
      applyDirectionsLinkFromStoreId(selEl?.value, qs(`recDir-${weekday}`));
      return;
    }

    // Override store changed → update directions
    if (id.startsWith('ovStore-')){
      const iso = id.slice('ovStore-'.length);
      const selEl = qs(`ovStore-${iso}`);
      applyDirectionsLinkFromStoreId(selEl?.value, qs(`ovDir-${iso}`));
      return;
    }

        // Phase 3: Any-store toggles → disable/enable specific store dropdowns + directions
    if (id.startsWith('ovAnyIn-')){
      const iso = id.slice('ovAnyIn-'.length);
      const any = !!qs(`ovAnyIn-${iso}`)?.checked;
      const selEl = qs(`ovInStore-${iso}`);
      if (selEl) selEl.disabled = any || !!qs(`ovOff-${iso}`)?.checked;
      applyDirectionsLinkFromStoreId(any ? '' : selEl?.value, qs(`ovInDir-${iso}`));
      return;
    }

    if (id.startsWith('ovAnyOut-')){
      const iso = id.slice('ovAnyOut-'.length);
      const any = !!qs(`ovAnyOut-${iso}`)?.checked;
      const selEl = qs(`ovOutStore-${iso}`);
      if (selEl) selEl.disabled = any || !!qs(`ovOff-${iso}`)?.checked;
      applyDirectionsLinkFromStoreId(any ? '' : selEl?.value, qs(`ovOutDir-${iso}`));
      return;
    }

    // Phase 3: In/Out store changed → update directions
    if (id.startsWith('ovInStore-')){
      const iso = id.slice('ovInStore-'.length);
      const selEl = qs(`ovInStore-${iso}`);
      applyDirectionsLinkFromStoreId(selEl?.value, qs(`ovInDir-${iso}`));
      return;
    }

    if (id.startsWith('ovOutStore-')){
      const iso = id.slice('ovOutStore-'.length);
      const selEl = qs(`ovOutStore-${iso}`);
      applyDirectionsLinkFromStoreId(selEl?.value, qs(`ovOutDir-${iso}`));
      return;
    }

  });

  // selectors
  sel.addEventListener('change', async () => {
    schedEmpId = sel.value;
    await loadScheduleWeek();
  });

  qs('schedPrev').addEventListener('click', async () => {
    schedWeekStart = addDays(schedWeekStart, -7);
    await loadScheduleWeek();
  });

  qs('schedNext').addEventListener('click', async () => {
    schedWeekStart = addDays(schedWeekStart, 7);
    await loadScheduleWeek();
  });

  qs('schedWeekDate').addEventListener('change', async () => {
    const d = fromISO(qs('schedWeekDate').value);
    schedWeekStart = startOfWeekSun(d);
    await loadScheduleWeek();
  });

  await loadScheduleWeek();
}

function showPanel(id){
  // Back-compat wrapper (older code used showPanel). Prefer activateTab().
  const map = {
    panelOverview: 'overview',
    panelPayroll: 'payroll',
    panelSchedule: 'schedule',
    panelStores: 'stores'
  };
  const key = map[id];
  if (key) activateTab(key);
}

function wireScheduleTab(){
  qs('tabSchedule')?.addEventListener('click', async () => {
    activateTab('schedule');

    // lazy init once
    if (!qs('schedEmpSelect').options.length){
      try {
        await initSchedulePanel();
      } catch (e){
        console.error(e);
        const body = qs('schedBody');
        if (body){
          body.innerHTML = `<tr><td colspan="4" class="muted">Failed to load schedule. Check console for details.</td></tr>`;
        }
      }
    }
  });
}


/* ============== Stores (Phase 1 — Store setup) ============== */
let _storesInitialized = false;
let _allStores = []; // cached list

const STORE_DEFAULTS = {
  radius_m: 50,
  timezone: 'America/New_York',
  schedule_enforce: false,
  schedule_grace_in_m: 5,
  schedule_grace_out_m: 5,
  paid_break_cap_min: 30,
  active: true
};

function directionsUrl(lat, lng){
  if (lat == null || lng == null) return '#';
  const q = `${Number(lat)},${Number(lng)}`;
  // Works in desktop + mobile (Google Maps web). If user has the app, browser will often deep-link.
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}

function setStoreError(msg){
  const el = qs('storeError');
  if (!el) return;
  el.textContent = msg || '';
  show(el, !!msg);
}

function openStoreModal(store=null){
  setStoreError('');

  // Defaults
  const s = {
    id: store?.id || '',
    name: store?.name ?? '',
    lat: store?.lat ?? '',
    lng: store?.lng ?? '',
    radius_m: store?.radius_m ?? STORE_DEFAULTS.radius_m,
    timezone: store?.timezone ?? STORE_DEFAULTS.timezone,
    schedule_enforce: store?.schedule_enforce ?? STORE_DEFAULTS.schedule_enforce,
    schedule_grace_in_m: store?.schedule_grace_in_m ?? STORE_DEFAULTS.schedule_grace_in_m,
    schedule_grace_out_m: store?.schedule_grace_out_m ?? STORE_DEFAULTS.schedule_grace_out_m,
    paid_break_cap_min: store?.paid_break_cap_min ?? STORE_DEFAULTS.paid_break_cap_min,
    active: store?.active ?? STORE_DEFAULTS.active
  };

  qs('storeTitle').textContent = store?.id ? 'Edit store' : 'Add store';
  qs('storeId').value = s.id;
  qs('storeName').value = s.name;
  qs('storeLat').value = s.lat;
  qs('storeLng').value = s.lng;
  qs('storeRadius').value = s.radius_m;
  qs('storeTz').value = s.timezone;
  qs('storeGraceIn').value = s.schedule_grace_in_m;
  qs('storeGraceOut').value = s.schedule_grace_out_m;
  qs('storePaidBreakCap').value = s.paid_break_cap_min;
  qs('storeScheduleEnforce').checked = !!s.schedule_enforce;
  qs('storeActive').checked = !!s.active;

  updateDirectionsPreview();

  qs('storeModal').classList.add('open');
  qs('storeModal').classList.remove('hidden');
  qs('storeModalBackdrop').classList.add('show');
  qs('storeModalBackdrop').classList.remove('hidden');
}

function closeStoreModal(){
  qs('storeModal').classList.remove('open');
  qs('storeModalBackdrop').classList.remove('show');
  setTimeout(() => {
    qs('storeModal').classList.add('hidden');
    qs('storeModalBackdrop').classList.add('hidden');
  }, 180);
}

function updateDirectionsPreview(){
  const lat = qs('storeLat')?.value;
  const lng = qs('storeLng')?.value;
  const link = qs('storeDirLink');
  const hint = qs('storeDirHint');
  if (!link || !hint) return;

  const ok = lat !== '' && lng !== '' && Number.isFinite(Number(lat)) && Number.isFinite(Number(lng));
  if (!ok){
    link.href = '#';
    link.setAttribute('aria-disabled', 'true');
    link.style.pointerEvents = 'none';
    link.style.opacity = '0.55';
    hint.textContent = 'Enter lat/lng to enable Directions';
    return;
  }
  link.href = directionsUrl(lat, lng);
  link.removeAttribute('aria-disabled');
  link.style.pointerEvents = '';
  link.style.opacity = '';
  hint.textContent = `Directions to ${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
}

function readStoreForm(){
  const id = (qs('storeId').value || '').trim() || null;
  const name = (qs('storeName').value || '').trim();
  const lat = Number(qs('storeLat').value);
  const lng = Number(qs('storeLng').value);
  const radius_m = Number(qs('storeRadius').value);
  const timezone = (qs('storeTz').value || STORE_DEFAULTS.timezone).trim() || STORE_DEFAULTS.timezone;
  const schedule_enforce = !!qs('storeScheduleEnforce').checked;
  const schedule_grace_in_m = Number(qs('storeGraceIn').value || STORE_DEFAULTS.schedule_grace_in_m);
  const schedule_grace_out_m = Number(qs('storeGraceOut').value || STORE_DEFAULTS.schedule_grace_out_m);
  const paid_break_cap_min = Number(qs('storePaidBreakCap').value || STORE_DEFAULTS.paid_break_cap_min);
  const active = !!qs('storeActive').checked;

  if (!name) return { ok:false, msg:'Store name is required.' };
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok:false, msg:'Latitude and longitude must be valid numbers.' };
  if (!Number.isFinite(radius_m) || radius_m <= 0) return { ok:false, msg:'Radius must be a positive number.' };
  if (!Number.isFinite(schedule_grace_in_m) || schedule_grace_in_m < 0) return { ok:false, msg:'Grace in must be 0 or more.' };
  if (!Number.isFinite(schedule_grace_out_m) || schedule_grace_out_m < 0) return { ok:false, msg:'Grace out must be 0 or more.' };
  if (!Number.isFinite(paid_break_cap_min) || paid_break_cap_min < 0) return { ok:false, msg:'Paid break cap must be 0 or more.' };

  return {
    ok:true,
    data: {
      ...(id ? { id } : {}),
      name,
      lat,
      lng,
      radius_m,
      timezone,
      schedule_enforce,
      schedule_grace_in_m,
      schedule_grace_out_m,
      paid_break_cap_min,
      active
    }
  };
}

async function upsertStore(){
  const parsed = readStoreForm();
  if (!parsed.ok) return setStoreError(parsed.msg);
  setStoreError('');

  const payload = parsed.data;

  try {
    let resp;
    if (payload.id){
      resp = await supabaseClient
        .from('store_locations')
        .update(payload)
        .eq('id', payload.id)
        .select()
        .single();
    } else {
      resp = await supabaseClient
        .from('store_locations')
        .insert(payload)
        .select()
        .single();
    }
    if (resp.error) throw resp.error;

    closeStoreModal();
    showToast('Store saved', 'ok');
    await loadStores();
  } catch (err){
    console.error(err);
    setStoreError(err?.message || 'Failed to save store');
  }
}

function storeStatusPill(active){
  return `<span class="pill ${active ? 'work' : ''} store-pill">${active ? 'Active' : 'Inactive'}</span>`;
}

function renderStoresTable(){
  const tb = qs('storesTbody');
  if (!tb) return;

  const q = (qs('storeSearchInput')?.value || '').trim().toLowerCase();
  const showInactive = !!qs('storeShowInactive')?.checked;

  const rows = _allStores
    .filter(s => showInactive ? true : !!s.active)
    .filter(s => q ? (s.name || '').toLowerCase().includes(q) : true)
    .sort((a,b) => (a.name||'').localeCompare(b.name||''));

  tb.innerHTML = '';
  if (!rows.length){
    tb.innerHTML = `<tr><td colspan="9" class="muted">No stores found.</td></tr>`;
    return;
  }

  for (const s of rows){
    const lat = (s.lat == null) ? '—' : Number(s.lat).toFixed(5);
    const lng = (s.lng == null) ? '—' : Number(s.lng).toFixed(5);
    const dir = directionsUrl(s.lat, s.lng);

    const tr = document.createElement('tr');
    tr.dataset.storeId = s.id;
    tr.innerHTML = `
      <td><div style="font-weight:600;">${s.name || '—'}</div></td>
      <td>${storeStatusPill(!!s.active)}</td>
      <td><span class="coords">${lat}, ${lng}</span></td>
      <td>${s.radius_m ?? '—'}</td>
      <td>${s.timezone || '—'}</td>
      <td>${s.schedule_enforce ? 'Yes' : 'No'}</td>
      <td>${(s.schedule_grace_in_m ?? '—')}/${(s.schedule_grace_out_m ?? '—')}</td>
      <td>${s.paid_break_cap_min ?? '—'} min</td>
      <td>
        <div class="store-actions">
          <button class="btn small" data-store-edit="${s.id}">Edit</button>
          <a class="btn small ghost" href="${dir}" target="_blank" rel="noopener">Directions</a>
          <button class="btn small ghost" data-store-emerg="${s.id}">Emergency</button>
          <button class="btn small ghost" data-store-toggle="${s.id}">${s.active ? 'Deactivate' : 'Activate'}</button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  }
}

async function loadStores(){
  const tb = qs('storesTbody');
  if (tb) tb.innerHTML = `<tr><td colspan="9" class="muted">Loading…</td></tr>`;

  const { data, error } = await supabaseClient
    .from('store_locations')
    .select('id,name,lat,lng,radius_m,timezone,schedule_enforce,schedule_grace_in_m,schedule_grace_out_m,paid_break_cap_min,active,created_at')
    .order('name', { ascending: true });
  if (error) throw error;

  _allStores = data || [];
  renderStoresTable();
}

async function toggleStoreActive(storeId){
  const s = _allStores.find(x => x.id === storeId);
  if (!s) return;
  const next = !s.active;
  const verb = next ? 'activate' : 'deactivate';
  if (!confirm(`Are you sure you want to ${verb} “${s.name}”?`)) return;

  try {
    const { error } = await supabaseClient
      .from('store_locations')
      .update({ active: next })
      .eq('id', storeId);
    if (error) throw error;
    showToast(`Store ${next ? 'activated' : 'deactivated'}`, 'ok');
    await loadStores();
  } catch (err){
    console.error(err);
    showToast(err?.message || 'Failed to update store', 'err');
  }
}

function setEmergError(msg){
  const el = qs('emergError');
  if (!el) return;
  el.textContent = msg || '';
  show(el, !!msg);
}

function openEmergModal(storeId){
  setEmergError('');
  const s = _allStores.find(x => x.id === storeId);
  if (!s) return;

  qs('emergStoreId').value = s.id;
  qs('emergStoreName').textContent = s.name || '—';

  const today = toISODate(new Date());
  qs('emergStart').value = today;
  qs('emergEnd').value = today;

  // Populate store dropdowns
  const opt = storeOptionsHTML('');
  qs('emergInStore').innerHTML = opt;
  qs('emergOutStore').innerHTML = opt;

  qs('emergAnyIn').checked = false;
  qs('emergAnyOut').checked = false;

  qs('emergInStore').disabled = false;
  qs('emergOutStore').disabled = false;

  // Initial directions disabled until store chosen
  applyDirectionsLinkFromStoreId('', qs('emergInDir'));
  applyDirectionsLinkFromStoreId('', qs('emergOutDir'));

  qs('emergReason').value = '';

  qs('emergModal').classList.add('open');
  qs('emergModal').classList.remove('hidden');
  qs('emergModalBackdrop').classList.add('show');
  qs('emergModalBackdrop').classList.remove('hidden');
}

function closeEmergModal(){
  qs('emergModal').classList.remove('open');
  qs('emergModalBackdrop').classList.remove('show');
  setTimeout(() => {
    qs('emergModal').classList.add('hidden');
    qs('emergModalBackdrop').classList.add('hidden');
  }, 180);
}

async function saveEmergException(){
  setEmergError('');

  const storeId = (qs('emergStoreId').value || '').trim();
  const start = qs('emergStart').value; // YYYY-MM-DD
  const end = qs('emergEnd').value;     // YYYY-MM-DD
  if (!storeId) return setEmergError('Missing store id.');
  if (!start || !end) return setEmergError('Start and end date are required.');
  if (end < start) return setEmergError('End date must be on/after start date.');

  const allowAnyIn = !!qs('emergAnyIn').checked;
  const allowAnyOut = !!qs('emergAnyOut').checked;

  const inStoreId = allowAnyIn ? null : (qs('emergInStore').value || null);
  const outStoreId = allowAnyOut ? null : (qs('emergOutStore').value || null);

  const note = (qs('emergReason').value || '').trim() || null;

  // Build one row per day (Option A)
  const rows = [];
  for (const d of enumerateIsoDates(start, end)){
    rows.push({
      store_id: storeId,
      work_date: d,
      allow_clock_in_any_store: allowAnyIn,
      clock_in_store_id: inStoreId,
      allow_clock_out_any_store: allowAnyOut,
      clock_out_store_id: outStoreId,
      note
    });
  }

  try{
    const { error } = await supabaseClient
      .from('timeclock_store_exceptions')
      .upsert(rows, { onConflict: 'store_id,work_date' });

    if (error) throw error;

    showToast?.('Emergency exception saved', 'ok');
    closeEmergModal();
  }catch(e){
    console.error(e);
    setEmergError(e?.message || 'Failed to save emergency exception');
  }
}

function enumerateIsoDates(startIso, endIso){
  // inputs: 'YYYY-MM-DD' -> yields each day inclusive
  const out = [];
  const start = new Date(startIso + 'T00:00:00');
  const end = new Date(endIso + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)){
    out.push(d.toISOString().slice(0,10));
  }
  return out;
}

async function clearEmergException(){
  setEmergError('');

  const storeId = (qs('emergStoreId').value || '').trim();
  const start = qs('emergStart').value;
  const end = qs('emergEnd').value;

  if (!storeId) return setEmergError('Missing store id.');
  if (!start || !end) return setEmergError('Start and end date are required.');
  if (end < start) return setEmergError('End date must be on/after start date.');

  try{
    const { error } = await supabaseClient
      .from('timeclock_store_exceptions')
      .delete()
      .eq('store_id', storeId)
      .gte('work_date', start)
      .lte('work_date', end);

    if (error) throw error;

    showToast?.('Emergency exception cleared', 'ok');
    closeEmergModal();
  }catch(e){
    console.error(e);
    setEmergError(e?.message || 'Failed to clear emergency exception');
  }
}



async function initStoresPanel(){
  if (_storesInitialized) return;
  _storesInitialized = true;

  // Filters
  qs('storeSearchInput')?.addEventListener('input', () => renderStoresTable());
  qs('storeShowInactive')?.addEventListener('change', () => renderStoresTable());

  // Add button
  qs('storeAddBtn')?.addEventListener('click', () => openStoreModal(null));

  // Table actions
  qs('storesTbody')?.addEventListener('click', (e) => {
    const edit = e.target.closest('[data-store-edit]');
    if (edit){
      const id = edit.getAttribute('data-store-edit');
      const s = _allStores.find(x => x.id === id);
      openStoreModal(s || null);
      return;
    }
    const tog = e.target.closest('[data-store-toggle]');
    if (tog){
      toggleStoreActive(tog.getAttribute('data-store-toggle'));
      return;
    }
        const em = e.target.closest('[data-store-emerg]');
    if (em){
      openEmergModal(em.getAttribute('data-store-emerg'));
      return;
    }

  });

  // Modal close + save
  qs('storeCloseBtn')?.addEventListener('click', closeStoreModal);
  qs('storeCancelBtn')?.addEventListener('click', closeStoreModal);
  qs('storeModalBackdrop')?.addEventListener('click', closeStoreModal);
  qs('storeSaveBtn')?.addEventListener('click', upsertStore);

    // Emergency modal close + save
  qs('emergCloseBtn')?.addEventListener('click', closeEmergModal);
  qs('emergCancelBtn')?.addEventListener('click', closeEmergModal);
  qs('emergModalBackdrop')?.addEventListener('click', closeEmergModal);
  qs('emergSaveBtn')?.addEventListener('click', saveEmergException);

  // Emergency modal live enable/disable + directions
  qs('emergAnyIn')?.addEventListener('change', () => {
    const any = !!qs('emergAnyIn').checked;
    qs('emergInStore').disabled = any;
    applyDirectionsLinkFromStoreId(any ? '' : qs('emergInStore').value, qs('emergInDir'));
  });

  qs('emergAnyOut')?.addEventListener('change', () => {
    const any = !!qs('emergAnyOut').checked;
    qs('emergOutStore').disabled = any;
    applyDirectionsLinkFromStoreId(any ? '' : qs('emergOutStore').value, qs('emergOutDir'));
  });

  qs('emergInStore')?.addEventListener('change', () => {
    applyDirectionsLinkFromStoreId(qs('emergInStore').value, qs('emergInDir'));
  });

  qs('emergOutStore')?.addEventListener('change', () => {
    applyDirectionsLinkFromStoreId(qs('emergOutStore').value, qs('emergOutDir'));
  });


  // Directions preview
  ['storeLat','storeLng'].forEach(id => qs(id)?.addEventListener('input', updateDirectionsPreview));

  await loadStores();
}

function wireStoresTab(){
  qs('tabStores')?.addEventListener('click', async () => {
    activateTab('stores');
    try { await initStoresPanel(); }
    catch (e){ console.error(e); showToast('Failed to load stores','err'); }
  });
}

function renderKPIs(rows){
  const tot = rows.reduce((a,r)=>a+(+r.total_hours||0),0);
  const shf = rows.reduce((a,r)=>a+(+r.shifts_count||0),0);
  const avg = shf>0? tot/shf : 0;
  qs('kpiTotalHours').textContent = fmtHours(tot);
  qs('kpiTotalShifts').textContent = String(shf);
  qs('kpiAvgHrs').textContent = fmtHours(avg);
}
let currentRows=[], sortState={ key:'display_name', dir:'asc' };
let pendingReviewCounts = new Map();
function sortRows(rows){
  const a=rows.slice(), {key,dir}=sortState, m = dir==='asc'?1:-1;
  a.sort((x,y)=>{
    let xv=x[key], yv=y[key];
    if (key==='shifts_count' || key==='total_hours'){ xv=+xv||0; yv=+yv||0; return (xv-yv)*m; }
    const xs=(xv||'').toString().toLowerCase(), ys=(yv||'').toString().toLowerCase();
    return xs<ys?-1*m: xs>ys?1*m: 0;
  });
  return a;
}
function applySortIndicators(){
  [{el:qs('thWorker'),key:'display_name'},{el:qs('thShifts'),key:'shifts_count'},{el:qs('thHours'),key:'total_hours'}].forEach(({el,key})=>{
    const s = sortState.key===key? sortState.dir : 'none';
    el.setAttribute('aria-sort', s==='asc'?'ascending':s==='desc'?'descending':'none');
    el.querySelector('.sort-indicator').textContent = s==='asc'?'▲':s==='desc'?'▼':'↕';
  });
}
function renderTable(rows){
  const tb=qs('summaryTbody'); tb.innerHTML='';
  const data = sortRows(rows);
  if (!data.length){ tb.innerHTML=`<tr><td colspan="3" class="muted">No results for this month/search.</td></tr>`; return; }
  for(const r of data){
    const tr=document.createElement('tr');
    tr.dataset.employeeId=r.employee_id; tr.dataset.monthStart=r.month_start; tr.dataset.displayName=r.display_name||'';
    tr.className='summary-row';
    const pendingN = pendingReviewCounts.get(r.employee_id) || 0;
    const flag = pendingN > 0 ? `<span class="review-flag" title="Pending shifts for review">Pending review: ${pendingN}</span>` : '';
    tr.innerHTML=`<td class="worker-cell"><span class="worker-name">${r.display_name||'—'}</span>${flag}</td><td>${r.shifts_count??'—'}</td><td>${fmtHours(r.total_hours)}</td>`;
    tb.appendChild(tr);
  }
  applySortIndicators();
}
let isLoading = false;
async function loadSummary(){
  if (isLoading) return; isLoading = true; qs('summaryTbody').style.opacity = '0.6';
  try{
    const monthStart = monthInputToStart();
    const search = (qs('searchInput').value || '').trim().toLowerCase();
    qs('printMonthLabel').textContent = monthLabel(monthStart);

    const [{ rows }, pendingMap] = await Promise.all([
      fetchMonthlySummary(monthStart), // all employees
      fetchMonthlyPendingReviewCounts(monthStart)
    ]);

    pendingReviewCounts = pendingMap || new Map();
    const filtered = search
      ? rows.filter(r => (r.display_name || '').toLowerCase().includes(search))
      : rows;

    currentRows = filtered;
    renderKPIs(filtered);
    renderTable(filtered);
  }catch(err){
    console.error(err);
    qs('summaryTbody').innerHTML = `<tr><td colspan="3" class="muted">Error loading data. Check console.</td></tr>`;
    qs('kpiTotalHours').textContent = qs('kpiTotalShifts').textContent = qs('kpiAvgHrs').textContent = '—';
  }finally{
    qs('summaryTbody').style.opacity = '1';
    isLoading = false;
  }
}


function wireFilters(){ qs('monthInput').addEventListener('change', loadSummary); qs('searchInput').addEventListener('input', debounce(loadSummary,300)); }
function toggleSort(key){ if (sortState.key===key) sortState.dir = sortState.dir==='asc'?'desc':'asc'; else sortState={key,dir:'asc'}; renderTable(currentRows); }
function wireSorting(){ qs('thWorker').addEventListener('click',()=>toggleSort('display_name')); qs('thShifts').addEventListener('click',()=>toggleSort('shifts_count')); qs('thHours').addEventListener('click',()=>toggleSort('total_hours')); }

/* ============== Drawer + Edit/Audit ============== */
async function fetchPeriodSummary(periodId){
  const [emps, viewResp] = await Promise.all([
    getActiveEmployees(),
    supabaseClient.from('v_payroll_period_hours')
      .select('employee_id, regular_hours, overtime_hours, total_hours, shifts_count')
      .eq('period_id', periodId)
  ]);
  const byId = new Map((viewResp.data || []).map(r => [r.employee_id, r]));
  return emps.map(e => {
    const v = byId.get(e.id) || {};
    return {
      employee_id: e.id,
      display_name: e.display_name,
      regular_hours: v.regular_hours || 0,
      overtime_hours: v.overtime_hours || 0,
      total_hours: v.total_hours || 0,
      shifts_count: v.shifts_count || 0
    };
  });
}

let currentShiftsById = new Map(), drawerContext = { employeeId:null, displayName:null, monthStart:null }, auditCache = new Map();

async function fetchWorkerShifts(employeeId, monthStartStr){
  const start = new Date(`${monthStartStr}T00:00:00`);
  const end   = new Date(start); end.setMonth(start.getMonth()+1);

  // 1) Fetch ALL shifts (closed + OPEN)
  const { data: entries, error } = await supabaseClient.from('time_entries')
    .select('id, clock_in, clock_out, store_id, photo_in_path, photo_out_path')
    .eq('employee_id', employeeId)
    .gte('clock_in', start.toISOString())
    .lt('clock_in', end.toISOString())
    .order('clock_in', { ascending: true });
  if (error) throw error;

  const rows = entries || [];
  const ids = rows.map(r => r.id);

  // 2) Anomalies + approvals
  let anomalyById = new Map();
  if (ids.length){
    const { data: anoms } = await supabaseClient.from('v_shift_anomalies')
      .select('time_entry_id, anomalies, has_anomaly, approval_status, approval_note, approved_at')
      .in('time_entry_id', ids);
    anomalyById = new Map((anoms||[]).map(a => [a.time_entry_id, a]));
  }

  // 3) Breaks (with photo paths)
  let breaksByEntry = new Map();
  if (ids.length){
    const { data: breaks } = await supabaseClient.from('time_breaks')
      .select('id, time_entry_id, started_at, ended_at, photo_start_path, photo_end_path')
      .in('time_entry_id', ids)
      .order('started_at', { ascending: true });

    for (const b of (breaks||[])){
      // prepare signed URLs now (thumbnails + links)
      const photo_start_url = await signPath(b.photo_start_path);
      const photo_end_url   = await signPath(b.photo_end_path);
      const list = breaksByEntry.get(b.time_entry_id) || [];
      list.push({ ...b, photo_start_url, photo_end_url });
      breaksByEntry.set(b.time_entry_id, list);
    }
  }

  // 4) Build final records (+ signed shift photos)
  const map = new Map(), out = [];
  for (const r of rows){
    const isOpen = !r.clock_out;
    const durMs  = (isOpen ? Date.now() : new Date(r.clock_out).getTime()) - new Date(r.clock_in).getTime();

    // Break summary
    const bks = breaksByEntry.get(r.id) || [];
    const breakMs = bks.reduce((sum, b) => {
      const done = b.ended_at ? (new Date(b.ended_at) - new Date(b.started_at)) : 0;
      return sum + Math.max(0, done);
    }, 0);

    let inUrl=null, outUrl=null;
    if (r.photo_in_path)  inUrl  = await signPath(r.photo_in_path);
    if (r.photo_out_path) outUrl = await signPath(r.photo_out_path);

    const a = anomalyById.get(r.id) || {};
    const rec = {
      id: r.id,
      clock_in: r.clock_in,
      clock_out: r.clock_out,
      duration_ms: durMs,
      store_id: r.store_id || null,
      photo_in_url: inUrl,
      photo_out_url: outUrl,
      // anomalies + approvals
      anomalies: Array.isArray(a.anomalies) ? a.anomalies : [],
      has_anomaly: !!a.has_anomaly,
      approval_status: a.approval_status || null,
      approval_note: a.approval_note || null,
      approved_at: a.approved_at || null,
      // breaks (with signed URLs)
      breaks: bks,                 // [{ id, started_at, ended_at, photo_start_url, photo_end_url, ... }]
      break_count: bks.length,
      break_ms: breakMs,
      is_open: isOpen
    };
    map.set(r.id, rec); out.push(rec);
  }
  currentShiftsById = map;
  lastDrawerShifts = out;
  return out;
}



function openDrawer(){ qs('drawer').classList.add('open'); qs('drawer').classList.remove('hidden'); qs('drawerBackdrop').classList.add('show'); qs('drawerBackdrop').classList.remove('hidden'); }
function closeDrawer(){ qs('drawer').classList.remove('open'); qs('drawerBackdrop').classList.remove('show'); setTimeout(()=>{ qs('drawer').classList.add('hidden'); qs('drawerBackdrop').classList.add('hidden'); },250); }
function renderDrawerHeader(name,monthStartStr){ qs('drawerTitle').textContent=name||'—'; qs('drawerSubtitle').textContent=monthLabel(monthStartStr); }
function renderDrawerSummary(shifts){ const n=shifts.length, tot=shifts.reduce((a,s)=>a+(s.duration_ms||0),0)/3600000, avg=n?tot/n:0; qs('dsShifts').textContent=String(n); qs('dsHours').textContent=fmtHours(tot); qs('dsAvg').textContent=fmtHours(avg); }

function renderDrawerList(shifts){
  const host = qs('drawerList'); host.innerHTML = '';

  const src = drawerOnlyAnoms ? shifts.filter(s => s.has_anomaly) : shifts;
  if (!src.length){
    host.innerHTML = `<div class="drawer-empty">${drawerOnlyAnoms ? 'No anomalies in this month.' : 'No shifts in this month.'}</div>`;
    return;
  }

  for (const s of src){
    const inStr  = fmtLocal(s.clock_in);
    const outStr = s.is_open ? 'OPEN' : fmtLocal(s.clock_out);
    const durStr = fmtDurationHM(s.duration_ms);

    // Status chip (don't show approve buttons for an OPEN shift)
    const st = s.approval_status || (s.is_open ? 'open' : 'pending');
    const stClass = s.is_open ? 'pending' : (st === 'approved' ? 'approved' : st === 'waived' ? 'waived' : 'pending');
    const statusChip = `<span class="chip ${stClass}">${(s.is_open?'OPEN':st.toUpperCase())}</span>`;

    // Anomaly chips
    const anomChips = (s.anomalies||[]).map(code => `<span class="chip anom">⚠︎ ${code}</span>`).join('');

    // Break summary + block
    const breaksText = s.break_count ? `${s.break_count} break(s) • ${fmtDurationHM(s.break_ms)}` : 'No breaks';

    let breaksBlock = '';
    if (s.break_count){
      const parts = s.breaks.map(b => {
        const open = !b.ended_at;
        const dur = open ? 0 : (new Date(b.ended_at) - new Date(b.started_at));
        const durStrB = open ? '—' : fmtDurationHM(dur);
        const startImg = b.photo_start_url ? `<a href="${b.photo_start_url}" target="_blank" rel="noopener"><img class="thumb" src="${b.photo_start_url}" alt="Break start photo"></a>` : `<span class="muted">No start photo</span>`;
        const endImg   = b.photo_end_url   ? `<a href="${b.photo_end_url}"   target="_blank" rel="noopener"><img class="thumb" src="${b.photo_end_url}"   alt="Break end photo"></a>`   : `<span class="muted">No end photo</span>`;
        return `
          <div class="break">
            <div class="br-times"><strong>${new Date(b.started_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</strong> → ${open ? 'OPEN' : new Date(b.ended_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</div>
            <div class="br-dur">${open ? '<span class="muted">(active)</span>' : durStrB}</div>
            <div class="br-photos">${startImg} ${endImg}</div>
          </div>`;
      }).join('');
      breaksBlock = `<div class="breaks">${parts}</div>`;
    }

    // Actions per status (disable for OPEN shifts)
    let actions = '';
    if (!s.is_open){
      if (st === 'approved'){
        actions = `
          <button class="btn small" data-waive-id="${s.id}">Waive…</button>
          <button class="btn small ghost" data-unapprove-id="${s.id}">Unapprove</button>
        `;
      } else if (st === 'waived'){
        actions = `
          <button class="btn small" data-approve-id="${s.id}">Approve</button>
          <button class="btn small ghost" data-unapprove-id="${s.id}">Unapprove</button>
        `;
      } else {
        actions = `
          <button class="btn small" data-approve-id="${s.id}">Approve</button>
          <button class="btn small" data-waive-id="${s.id}">Waive…</button>
        `;
      }
    }

    const noteLine = s.approval_note ? `<div class="shift-meta">Note: ${s.approval_note}</div>` : '';

    const div = document.createElement('div');
    div.className = 'shift';
    div.innerHTML = `
      <div class="shift-row" style="justify-content:space-between;">
        <div class="shift-time"><strong>In:</strong> ${inStr}</div>
        <div class="shift-time"><strong>Out:</strong> ${outStr}</div>
        <div class="shift-meta">${durStr}</div>
      </div>

      <div class="shift-row" style="margin-top:6px; justify-content:space-between;">
        <div class="chips">
          ${statusChip}
          ${anomChips}
          <span class="chip">${breaksText}</span>
        </div>
        <div class="shift-actions">
          ${s.photo_in_url ? `<a href="${s.photo_in_url}" target="_blank" rel="noopener">Photo In</a>` : ''}
          ${s.photo_out_url ? `<a href="${s.photo_out_url}" target="_blank" rel="noopener">Photo Out</a>` : ''}
          <button class="btn small" data-edit-id="${s.id}" ${s.is_open?'disabled':''}>Edit</button>
          <button class="btn small" data-audit-id="${s.id}">Audit</button>
          ${actions}
        </div>
      </div>

      ${noteLine}
      ${breaksBlock}

      <div class="audit hidden" id="audit-${s.id}">
        <div class="drawer-empty">Loading…</div>
      </div>`;
    host.appendChild(div);
  }
}


async function fetchAuditsForShift(shiftId){
  const { data, error } = await supabaseClient.from('v_shift_adjustments')
    .select('id, time_entry_id, editor_name, editor_user_id, edited_at, reason, fields_changed, old_value, new_value')
    .eq('time_entry_id', shiftId).order('edited_at',{ascending:false});
  if (error) throw error; return data||[];
}
async function toggleAudit(shiftId){
  const c=document.getElementById(`audit-${shiftId}`); if(!c) return;
  if (!c.classList.contains('hidden')){ c.classList.add('hidden'); return; }
  c.classList.remove('hidden'); c.innerHTML=`<div class="drawer-empty">Loading…</div>`;
  try{ const audits = auditCache.get(shiftId) || await fetchAuditsForShift(shiftId); auditCache.set(shiftId,audits); renderAuditList(c,audits,shiftId); }
  catch(err){ console.error(err); c.innerHTML=`<div class="drawer-empty">Error loading audit trail.</div>`; }
}
function renderAuditList(container, audits, shiftId){
  if (!audits.length){ container.innerHTML=`<div class="drawer-empty">No adjustments yet.</div>`; return; }
  const parts=audits.map(a=>{
    const who=a.editor_name||'(unknown)', when=fmtLocal(a.edited_at), why=a.reason||'';
    const fields=Array.isArray(a.fields_changed)?a.fields_changed:[]; const oldIn=a.old_value?.clock_in, oldOut=a.old_value?.clock_out, newIn=a.new_value?.clock_in, newOut=a.new_value?.clock_out;
    const diffs=[]; if(fields.includes('clock_in')) diffs.push(`<div>clock_in: <code>${fmtLocal(oldIn)}</code> → <code>${fmtLocal(newIn)}</code></div>`); if(fields.includes('clock_out')) diffs.push(`<div>clock_out: <code>${fmtLocal(oldOut)}</code> → <code>${fmtLocal(newOut)}</code></div>`);
    return `
      <div class="ai" data-adjustment-id="${a.id}">
        <div class="row ai-hd">
          <div class="who">${who}</div>
          <div class="when">• ${when}</div>
          <div class="acts" style="margin-left:auto;">
            <button class="btn small" data-revert="${a.id}" title="Revert to OLD values">Revert</button>
          </div>
        </div>
        <div class="why">${why}</div>
        ${diffs.length?`<div class="chg">${diffs.join('')}</div>`:''}
      </div>`;
  });
  container.innerHTML = `<div class="ai-list">${parts.join('')}</div>`;
  container.querySelectorAll('button[data-revert]').forEach(btn=>btn.addEventListener('click',()=>onRevertClick(shiftId, btn.getAttribute('data-revert'))));
}
async function onRevertClick(shiftId, adjustmentId){
  const audits=auditCache.get(shiftId)||[]; const a=audits.find(x=>x.id===adjustmentId); if(!a) return;
  const oldIn=a.old_value?.clock_in, oldOut=a.old_value?.clock_out; if(!oldIn||!oldOut){ showToast('Cannot revert: missing old values','err'); return; }
  const reason=window.prompt('Reason for revert (required):', `Revert to ${fmtLocal(oldIn)} – ${fmtLocal(oldOut)}`); if(!reason||reason.trim().length<3){ showToast('Revert cancelled (reason required)','err'); return; }
  try{
    const { error } = await supabaseClient.rpc('admin_update_shift_time', { _time_entry_id: shiftId, _new_clock_in: oldIn, _new_clock_out: oldOut, _reason: reason.trim() });
    if (error) throw error;
    showToast('Shift reverted','ok'); auditCache.delete(shiftId);
    const { employeeId, monthStart } = drawerContext;
    const shifts=await fetchWorkerShifts(employeeId, monthStart); renderDrawerSummary(shifts); renderDrawerList(shifts);
    await toggleAudit(shiftId); await loadSummary();
  }catch(err){ console.error(err); showToast(err?.message||'Failed to revert','err'); }
}
let editingShiftId=null, saving=false;
function openEditModal(shift){ editingShiftId=shift.id; qs('editIn').value=toDatetimeLocalValue(shift.clock_in); qs('editOut').value=toDatetimeLocalValue(shift.clock_out); qs('editReason').value=''; qs('editError').textContent=''; show(qs('editError'),false); updateEditDuration(); qs('editModal').classList.add('open'); qs('editModal').classList.remove('hidden'); qs('editModalBackdrop').classList.add('show'); qs('editModalBackdrop').classList.remove('hidden'); qs('editIn').focus(); }
function closeEditModal(){ editingShiftId=null; saving=false; qs('editModal').classList.remove('open'); qs('editModalBackdrop').classList.remove('show'); setTimeout(()=>{ qs('editModal').classList.add('hidden'); qs('editModalBackdrop').classList.add('hidden'); },180); }
function updateEditDuration(){ const a=qs('editIn').value, b=qs('editOut').value; if(!a||!b){ qs('editDuration').textContent='—'; return; } const diff=new Date(b)-new Date(a); qs('editDuration').textContent = diff>0? fmtDurationHM(diff):'—'; }
function setEditError(msg){ const el=qs('editError'); el.textContent=msg||''; show(el,!!msg); }
async function saveEdit(){
  if(saving||!editingShiftId) return;
  const iv=qs('editIn').value, ov=qs('editOut').value, reason=(qs('editReason').value||'').trim();
  if(!iv||!ov) return setEditError('Both times are required.');
  const s=new Date(iv), e=new Date(ov); if(isNaN(s)||isNaN(e)) return setEditError('Invalid date/time values.'); if(e<s) return setEditError('Clock-out must be after clock-in.'); if(reason.length<3) return setEditError('Reason is required (min 3 characters).');
  setEditError(''); saving=true; qs('editSaveBtn').disabled=true; qs('editSaveBtn').textContent='Saving…';
  try{
    const inISO=localInputToOffsetISO(iv), outISO=localInputToOffsetISO(ov);
    const { error } = await supabaseClient.rpc('admin_update_shift_time', { _time_entry_id: editingShiftId, _new_clock_in: inISO, _new_clock_out: outISO, _reason: reason });
    if (error) throw error;
    showToast('Shift updated','ok'); closeEditModal();
    auditCache.delete(editingShiftId);
    const { employeeId, monthStart } = drawerContext;
    const shifts=await fetchWorkerShifts(employeeId, monthStart); renderDrawerSummary(shifts); renderDrawerList(shifts); await loadSummary();
  }catch(err){ console.error(err); setEditError(err?.message||'Failed to save changes'); }
  finally{ saving=false; qs('editSaveBtn').disabled=false; qs('editSaveBtn').textContent='Save'; }
}
function wireEditModal(){
  qs('editCloseBtn').addEventListener('click', closeEditModal);
  qs('editCancelBtn').addEventListener('click', closeEditModal);
  qs('editModalBackdrop').addEventListener('click', closeEditModal);
  qs('editIn').addEventListener('input', updateEditDuration);
  qs('editOut').addEventListener('input', updateEditDuration);
  qs('editSaveBtn').addEventListener('click', saveEdit);
  document.addEventListener('keydown',(e)=>{ const open=!qs('editModal').classList.contains('hidden'); if(!open) return; if((e.metaKey||e.ctrlKey)&&e.key==='Enter'){ e.preventDefault(); const b=qs('editSaveBtn'); if(b&&!b.disabled) b.click(); }});
}
async function onRowClick(e){
  const tr=e.target.closest('tr.summary-row'); if(!tr) return;
  const employeeId=tr.dataset.employeeId, monthStart=tr.dataset.monthStart, displayName=tr.dataset.displayName||'—';
  drawerContext={ employeeId, monthStart, displayName };
  renderDrawerHeader(displayName, monthStart);
  qs('dsShifts').textContent=qs('dsHours').textContent=qs('dsAvg').textContent='…';
  qs('drawerList').innerHTML=`<div class="drawer-empty">Loading shifts…</div>`; openDrawer();
  try{ const shifts=await fetchWorkerShifts(employeeId, monthStart); renderDrawerSummary(shifts); renderDrawerList(shifts); }
  catch(err){ console.error(err); qs('drawerList').innerHTML=`<div class="drawer-empty">Error loading shifts.</div>`; }
}

let liveTickTimer = null;

// recompute durations from data-* timestamps (no network)
function tickLiveNow(){
  const cards = document.querySelectorAll('.live-card');
  const now = Date.now();

  for (const card of cards){
    const clockInMs = Number(card.dataset.clockInMs || 0);
    if (!clockInMs) continue;

    // update "since … • HHh MMm"
    const timesEl = card.querySelector('.live-times');
    if (timesEl){
      const sinceStr = new Date(clockInMs).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
      const durStr = fmtDurationHM(now - clockInMs);
      timesEl.textContent = `since ${sinceStr} • ${durStr}`;
    }

    // if on break, update pill to show current break duration
    if (card.dataset.status === 'break'){
      const bs = Number(card.dataset.breakStartMs || 0);
      const pill = card.querySelector('.pill.break');
      if (bs && pill){
        pill.textContent = `On break ${fmtDurationHM(now - bs)}`;
      }
    }
  }
}

function startLiveTicker(intervalMs = 30000){ // 30s default; use 1000 for every second
  if (liveTickTimer) clearInterval(liveTickTimer);
  liveTickTimer = setInterval(tickLiveNow, intervalMs);
  // also do an immediate tick so UI updates right away
  tickLiveNow();
}

function stopLiveTicker(){
  if (liveTickTimer) { clearInterval(liveTickTimer); liveTickTimer = null; }
}

async function fetchLiveNow(){
  // 1) open shifts
  const { data: entries, error } = await supabaseClient
    .from('time_entries')
    .select('id, employee_id, clock_in, photo_in_path, schedule_codes')
    .is('clock_out', null)
    .order('clock_in', { ascending: true });
  if (error) throw error;
  const rows = entries || [];
  const ids = rows.map(r => r.id);

  // 2) open breaks for those shifts
  let openBreaks = [];
  if (ids.length){
    const { data: b, error: bErr } = await supabaseClient
      .from('time_breaks')
      .select('id, time_entry_id, started_at, photo_start_path')
      .in('time_entry_id', ids)
      .is('ended_at', null);
    if (bErr) throw bErr;
    openBreaks = b || [];
  }
  const breakByEntry = new Map(openBreaks.map(b => [b.time_entry_id, b]));

  // 3) names
  const emps = await getActiveEmployees();
  const nameById = new Map(emps.map(e => [e.id, e.display_name]));

  // 4) shape + sign photo links + anomaly flags
  const out = [];
  for (const r of rows){
    const now = Date.now();
    const bk = breakByEntry.get(r.id) || null;
    const codes = Array.isArray(r.schedule_codes) ? r.schedule_codes : [];
    out.push({
      entry_id: r.id,
      employee_id: r.employee_id,
      display_name: nameById.get(r.employee_id) || '(unknown)',
      clock_in: r.clock_in,
      duration_ms: now - new Date(r.clock_in).getTime(),
      status: bk ? 'break' : 'work',
      break_started_at: bk?.started_at || null,
      break_ms: bk ? (now - new Date(bk.started_at).getTime()) : 0,
      photo_in_url: r.photo_in_path ? await signPath(r.photo_in_path) : null,
      break_photo_url: bk?.photo_start_path ? await signPath(bk.photo_start_path) : null,
      has_anomaly: codes.length > 0,
      anomalies: codes
    });
  }
  return out;
}

function renderLiveNow(rows){
  const list = qs('liveList'); if (!list) return;
  const updated = qs('liveUpdated');

  // header stamp + anomaly count
  const flagged = rows.filter(r => r.has_anomaly).length;
  if (updated){
    updated.textContent = `Updated ${new Date().toLocaleTimeString()}${flagged ? ` • ⚠︎ ${flagged} flagged` : ''}`;
  }

  list.innerHTML = '';
  if (!rows.length){
    list.innerHTML = `<div class="muted">No one is clocked in right now.</div>`;
    if (typeof tickLiveNow === 'function') tickLiveNow();
    return;
  }

  for (const r of rows){
    const clockInMs = new Date(r.clock_in).getTime();
    const breakStartMs = r.break_started_at ? new Date(r.break_started_at).getTime() : 0;

    const div = document.createElement('div');
    div.className = 'live-card';
    div.dataset.employeeId   = r.employee_id;
    div.dataset.clockInMs    = String(clockInMs);
    div.dataset.status       = r.status; // 'work' | 'break'
    div.dataset.breakStartMs = breakStartMs ? String(breakStartMs) : '';

    const sinceStr = new Date(clockInMs).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const durStr   = fmtDurationHM(Date.now() - clockInMs);

    const pill = r.status === 'break'
      ? `<span class="pill break">On break ${fmtDurationHM(r.break_ms)}</span>`
      : `<span class="pill work">Working</span>`;

    const anomHtml = r.has_anomaly && r.anomalies?.length
      ? `<div class="live-anoms">${r.anomalies.map(a => `<span class="chip anom">⚠︎ ${a}</span>`).join(' ')}</div>`
      : '';

    div.innerHTML = `
      <div class="live-name">${r.display_name}</div>
      <div class="live-times">since ${sinceStr} • ${durStr}</div>
      <div class="live-status">${pill}</div>
      ${anomHtml}
      <div class="live-actions">
        ${r.photo_in_url ? `<a href="${r.photo_in_url}" target="_blank" rel="noopener">Photo In</a>` : ''}
        ${r.break_photo_url ? `<a href="${r.break_photo_url}" target="_blank" rel="noopener">Break Photo</a>` : ''}
        <button class="btn small ghost">Details →</button>
      </div>
    `;
    list.appendChild(div);
  }

  // immediately recompute durations so labels are fresh after render
  if (typeof tickLiveNow === 'function') tickLiveNow();
}


async function loadLiveNow(){
  try{
    const rows = await fetchLiveNow();
    renderLiveNow(rows);
  }catch(err){
    console.error(err);
    const list = qs('liveList');
    if (list) list.innerHTML = `<div class="muted">Failed to load live status.</div>`;
  }
}

// Click a live card → open drawer for that worker (current month)
function wireLiveList(){
  const list = qs('liveList'); if (!list) return;
  list.addEventListener('click', async (e) => {
    const card = e.target.closest('.live-card'); if (!card) return;
    const employeeId = card.dataset.employeeId;
    const emps = await getActiveEmployees();
    const displayName = (emps.find(x => x.id === employeeId)?.display_name) || '—';
    const monthStart = monthInputToStart();

    drawerContext = { employeeId, monthStart, displayName };
    renderDrawerHeader(displayName, monthStart);
    qs('drawerList').innerHTML = `<div class="drawer-empty">Loading shifts…</div>`;
    openDrawer();
    try{
      const shifts = await fetchWorkerShifts(employeeId, monthStart);
      renderDrawerSummary(shifts);
      renderDrawerList(shifts);
    }catch(err){
      console.error(err);
      qs('drawerList').innerHTML = `<div class="drawer-empty">Error loading shifts.</div>`;
    }
  });
}


function wireDrawer(){
  // Close actions
  const closeBtn = qs('drawerCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

  const backdrop = qs('drawerBackdrop');
  if (backdrop) backdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeDrawer();
  });

  // Click a summary row to open drawer
  const tbody = qs('summaryTbody');
  if (tbody) tbody.addEventListener('click', onRowClick);

  // Delegated actions inside the drawer list
  const list = qs('drawerList');
  if (list) {
    list.addEventListener('click', (e) => {
      const t = e.target;

      // Edit shift
      const editBtn = t.closest('button[data-edit-id]');
      if (editBtn) {
        const id = editBtn.getAttribute('data-edit-id');
        const shift = currentShiftsById.get(id);
        if (shift) openEditModal(shift);
        return;
      }

      // Audit toggle
      const auditBtn = t.closest('button[data-audit-id]');
      if (auditBtn) {
        toggleAudit(auditBtn.getAttribute('data-audit-id'));
        return;
      }

      // Approvals
      const approveBtn = t.closest('button[data-approve-id]');
      if (approveBtn) {
        onApproveClick(approveBtn.getAttribute('data-approve-id'));
        return;
      }

      const waiveBtn = t.closest('button[data-waive-id]');
      if (waiveBtn) {
        onWaiveClick(waiveBtn.getAttribute('data-waive-id'));
        return;
      }

      const unapproveBtn = t.closest('button[data-unapprove-id]');
      if (unapproveBtn) {
        onUnapproveClick(unapproveBtn.getAttribute('data-unapprove-id'));
        return;
      }
    });
  }

  // Toggle: only anomalies
  const toggle = qs('toggleAnoms');
  if (toggle) {
    toggle.addEventListener('change', () => {
      drawerOnlyAnoms = !!toggle.checked;
      renderDrawerList(lastDrawerShifts); // re-render with current cache
    });
  }
}

/* ============== Tabs ============== */
function activateTab(which){
  const tabs = [
    { key:'overview', btn:'tabOverview', panel:'panelOverview' },
    { key:'payroll',  btn:'tabPayroll',  panel:'panelPayroll' },
    { key:'schedule', btn:'tabSchedule', panel:'panelSchedule' },
    { key:'stores',   btn:'tabStores',   panel:'panelStores' },
    { key:'users',    btn:'tabUsers',    panel:'panelUsers' }, // ✅ NEW
    { key:'taxdocs',  btn:'tabTaxDocs',  panel:'panelTaxDocs' },
    { key:'agreements', btn:'tabAgreements', panel:'panelAgreements' },
  ];

  for (const t of tabs){
    const b = qs(t.btn);
    const p = qs(t.panel);
    const active = t.key === which;
    if (b){
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    if (p) show(p, active);
  }
}

let _payrollInitialized = false;
function wireTabs(){
  qs('tabOverview')?.addEventListener('click', ()=> activateTab('overview'));
  qs('tabPayroll')?.addEventListener('click', async ()=>{
    activateTab('payroll');
    if (!_payrollInitialized && typeof window.initPayrollTab === 'function') {
      _payrollInitialized = true;
      try { await window.initPayrollTab(); } catch (e) { console.error(e); }
    }
  });
  qs('tabSchedule')?.addEventListener('click', ()=> activateTab('schedule'));
  qs('tabStores')?.addEventListener('click',   ()=> activateTab('stores'));
  qs('tabAgreements')?.addEventListener('click', ()=> activateTab('agreements'));
  qs('tabUsers')?.addEventListener('click',    ()=> activateTab('users')); // ✅ NEW
  let _taxDocsInitialized = false;
  qs('tabTaxDocs')?.addEventListener('click', async () => {
    activateTab('taxdocs');
    if (_taxDocsInitialized) return;
    _taxDocsInitialized = true;
    try { await window.initTaxDocsTab(); }
    catch (e) { console.error(e); showToast('Failed to load Tax Docs','err'); }
  });

}



let rtChannel = null;
const onRealtimeChange = debounce(async () => {
  try {
    // Refresh Overview
    await loadSummary();

    // If drawer is open for a worker/month, refresh it too
    const isOpen = !qs('drawer').classList.contains('hidden') && qs('drawer').classList.contains('open');
    if (isOpen && drawerContext?.employeeId && drawerContext?.monthStart){
      const shifts = await fetchWorkerShifts(drawerContext.employeeId, drawerContext.monthStart);
      renderDrawerSummary(shifts);
      renderDrawerList(shifts);
    }
    await loadLiveNow(); // <— add this
  } catch {}
}, 400);

function bootRealtime(){
  try{
rtChannel = supabaseClient.channel('admin-live')
  .on('postgres_changes', { event: '*', schema: 'public', table: 'time_entries' }, onRealtimeChange)
  .on('postgres_changes', { event: '*', schema: 'public', table: 'time_breaks'  }, onRealtimeChange)
  .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'employees' }, async (payload) => {
    // Only refresh Users if the users panel is initialized (and optionally if visible)
    try {
      if (typeof loadUsers === 'function') {
        await loadUsers();
      }
    } catch {}
  })
  .subscribe();
  }catch(err){ console.error('Realtime subscribe failed', err); }
}

window.addEventListener('beforeunload', () => {
  try { if (rtChannel) supabaseClient.removeChannel(rtChannel); } catch {}
});


/* ============== Users (Invite + Roles) ============== */
let _usersInitialized = false;
let _usersRows = []; // cached for filtering

function setUserError(msg){
  const el = qs('userError');
  if (!el) return;
  el.textContent = msg || '';
  show(el, !!msg);
}

function openUserModal() {
  const bd = qs('userModalBackdrop');
  const md = qs('userModal');

  // Reset fields
  const email = qs('userEmail');
  const name = qs('userDisplayName');
  if (email) email.value = '';
  if (name) name.value = '';

  // Default role = employee (if present)
  const role = qs('userRole');
  if (role) role.value = 'employee';

  // Make visible with the classes your CSS expects
  bd?.classList.remove('hidden');
  md?.classList.remove('hidden');

  // Force a frame so transitions apply nicely
  requestAnimationFrame(() => {
    bd?.classList.add('show');
    md?.classList.add('open');
  });

  // Optional: focus email for a premium feel
  setTimeout(() => email?.focus(), 50);
}

function closeUserModal() {
  const bd = qs('userModalBackdrop');
  const md = qs('userModal');

  bd?.classList.remove('show');
  md?.classList.remove('open');

  // Wait for transition before hiding (matches your CSS ~180-200ms)
  setTimeout(() => {
    bd?.classList.add('hidden');
    md?.classList.add('hidden');
  }, 220);
}

// =========================================================
// Shift Approval Handlers (restore missing functions)
// Uses Supabase function: public.approve_shift(_time_entry_id, _status, _note)
// =========================================================

async function onApproveClick(timeEntryId) {
  try {
    if (!timeEntryId) return;

    const { error } = await supabaseClient.rpc("approve_shift", {
      _time_entry_id: timeEntryId,
      _status: "approved",
      _note: null,
    });
    if (error) throw error;

    toast("Shift approved", "ok");
    await refreshDrawerAfterApprovalChange();
  } catch (err) {
    console.error(err);
    toast(err?.message || "Approve failed", "warn");
  }
}

async function onWaiveClick(timeEntryId) {
  try {
    if (!timeEntryId) return;

    const note = prompt("Waive reason / note (optional):", "") ?? "";
    // If user hit cancel, do nothing
    if (note === null) return;

    const { error } = await supabaseClient.rpc("approve_shift", {
      _time_entry_id: timeEntryId,
      _status: "waived",
      _note: note.trim() || null,
    });
    if (error) throw error;

    toast("Shift waived", "ok");
    await refreshDrawerAfterApprovalChange();
  } catch (err) {
    console.error(err);
    toast(err?.message || "Waive failed", "warn");
  }
}

async function onUnapproveClick(timeEntryId) {
  try {
    if (!timeEntryId) return;

    const ok = confirm("Unapprove this shift? This will remove the approval/waiver.");
    if (!ok) return;

    // No RPC exists in your functions list for "unapprove",
    // so we remove the shift_approvals row directly.
    const { error } = await supabaseClient
      .from("shift_approvals")
      .delete()
      .eq("time_entry_id", timeEntryId);

    if (error) throw error;

    toast("Approval removed", "ok");
    await refreshDrawerAfterApprovalChange();
  } catch (err) {
    console.error(err);
    toast(err?.message || "Unapprove failed", "warn");
  }
}

// Re-fetch and re-render the drawer so chips/buttons update
async function refreshDrawerAfterApprovalChange() {
  if (!drawerContext?.employeeId || !drawerContext?.monthStart) return;

  const shifts = await fetchWorkerShifts(drawerContext.employeeId, drawerContext.monthStart);
  renderDrawerSummary(shifts);
  renderDrawerList(shifts);
}



function getUsersFilters(){
  const q = (qs('userSearchInput')?.value || '').trim().toLowerCase();
  const showInactive = !!qs('userShowInactive')?.checked;
  return { q, showInactive };
}

function applyUsersFilterAndRender(){
  const { q, showInactive } = getUsersFilters();

  let rows = _usersRows.slice();
  if (!showInactive) rows = rows.filter(r => !!r.active);

  if (q){
    rows = rows.filter(r => {
      const name = (r.display_name || '').toLowerCase();
      const email = (r.email || '').toLowerCase();
      return name.includes(q) || email.includes(q);
    });
  }

  // NEW: cards renderer can live in admin-users.js
  if (typeof window.renderUsers === "function") {
    window.renderUsers(rows);
  } 
}


const esc = escapeHtml;


async function loadUsers(){
  const { data, error } = await supabaseClient
    .from('employees')
    .select('id, user_id, display_name, email, role, worker_type, hourly_rate, active, created_at, invited_at, accepted_at')
    .order('display_name', { ascending: true });

  if (error) throw error;

  _usersRows = (data || []).map(r => {
    const role = (r.role || 'employee').toLowerCase();
    const worker_type = (r.worker_type || 'employee').toLowerCase();

    return {
      ...r,
      role: ['employee','manager','admin'].includes(role) ? role : 'employee',
      worker_type: ['employee','contractor'].includes(worker_type) ? worker_type : 'employee',
      active: !!r.active,
      email: r.email || '',
      display_name: r.display_name || '',
      invited_at: r.invited_at || null,
      accepted_at: r.accepted_at || null,
    };
  });

  applyUsersFilterAndRender();
}

async function inviteUser(){
  try{
    const email = (qs('userEmail')?.value || '').trim().toLowerCase();
    const display_name = (qs('userDisplayName')?.value || '').trim();
    const role = (qs('userRole')?.value || 'employee').toLowerCase();

    // NEW: worker_type (must exist in admin.html as <select id="userWorkerType">)
    const worker_type = (qs('userWorkerType')?.value || 'employee').trim().toLowerCase();

    const hrRaw = (qs('userHourlyRate')?.value || '').trim();
    const hourly_rate = hrRaw === '' ? null : Number(hrRaw);

    if (!email) throw new Error('Email is required.');
    if (!display_name) throw new Error('Display name is required.');
    if (!['employee','manager','admin'].includes(role)) throw new Error('Invalid role.');
    if (!['employee','contractor'].includes(worker_type)) throw new Error('Invalid worker type.');
    if (hrRaw !== '' && (!Number.isFinite(hourly_rate) || hourly_rate < 0)) {
      throw new Error('Hourly rate must be a non-negative number.');
    }

    const btn = qs('userInviteBtn');
    if (btn){
      btn.disabled = true;
      btn.classList.add('loading');
    }

    // IMPORTANT: use raw invoke so 400 shows real message
    const data = await invokeEdgeJson('admin-user', {
      action: 'invite',
      email,
      display_name,
      role,
      worker_type,
      hourly_rate
    });


    if (!data?.ok) throw new Error(data?.error || 'Invite failed.');

    closeUserModal();
    await loadUsers();
    showToast('Invite sent ✉️', 'ok');
  } catch (err) {
    console.error(err);
    setUserError(err?.message || 'Invite failed');
    throw err;
  } finally {
    const btn = qs('userInviteBtn');
    if (btn){
      btn.disabled = false;
      btn.classList.remove('loading');
    }
  }
}

async function saveUserRow(tr){
  const employee_id = tr?.dataset?.employeeId;

  const display_name = (tr.querySelector('.user-name')?.value || '').trim();
  const role = (tr.querySelector('.user-role')?.value || 'employee').toLowerCase();
  const worker_type = (tr.querySelector('.user-worker-type')?.value || 'employee').toLowerCase();
  const active = !!tr.querySelector('.user-active')?.checked;

  // hourly_rate: blank -> null, number -> number
  const hrRaw = (tr.querySelector('.user-hourly-rate')?.value || '').trim();
  const hourly_rate = hrRaw === '' ? null : Number(hrRaw);

  if (!employee_id) throw new Error('Missing employee id.');
  if (!display_name) throw new Error('Display name is required.');
  if (!['employee','manager','admin'].includes(role)) throw new Error('Invalid role.');
  if (!['employee','contractor'].includes(worker_type)) throw new Error('Invalid worker type.');
  if (hrRaw !== '' && (!Number.isFinite(hourly_rate) || hourly_rate < 0)) {
    throw new Error('Hourly rate must be a non-negative number.');
  }

  const { data, error } = await supabaseClient.functions.invoke('admin-user', {
    body: { action: 'update', employee_id, role, worker_type, active, display_name, hourly_rate }
  });

  if (error) throw error;
  if (!data?.ok) throw new Error(data?.error || 'Update failed.');

  showToast('Saved ✅', 'ok');
  await loadUsers();
}

// =========================================================
// Expose Users helpers for non-module scripts (admin-users.js)
// =========================================================
window.loadUsers = loadUsers;
window.saveUserRow = saveUserRow;
window.resendInvite = resendInvite;
window.showToast = showToast;


function wireUsersTab(){
  // tab click: activate + lazy init
  qs('tabUsers')?.addEventListener('click', async () => {
    activateTab('users');

    if (_usersInitialized) return;
    _usersInitialized = true;
  // NEW: initialize cards renderer (admin-users.js)
  // (safe: does nothing if admin-users.js not loaded)
  if (typeof window.initUsersCardsTab === 'function') {
    await window.initUsersCardsTab();
  }



    // modal controls
    qs('userAddBtn')?.addEventListener('click', openUserModal);
    qs('userCloseBtn')?.addEventListener('click', closeUserModal);
    qs('userCancelBtn')?.addEventListener('click', closeUserModal);
    qs('userModalBackdrop')?.addEventListener('click', closeUserModal);

    // invite
    qs('userInviteBtn')?.addEventListener('click', () => {
      inviteUser().catch(err => {
        console.error(err);
        setUserError(err?.message || 'Invite failed');
      });
    });

    // filters
    qs('userSearchInput')?.addEventListener('input', debounce(() => {
      applyUsersFilterAndRender();
    }, 150));

    qs('userShowInactive')?.addEventListener('change', () => {
      applyUsersFilterAndRender();
    });

    // initial load
    loadUsers().catch(err => {
      console.error(err);
      const cards = qs('usersCards');
      if (cards) cards.innerHTML = `<div class="muted">Failed to load users.</div>`;

    });
  });
}


//* ============== Boot ============== */
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

  // Header + tabs
  wireHeaderActions();
  wireTabs();
  activateTab('overview');

  // Prefill month for Overview
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const monthInput = qs('monthInput');
  if (monthInput) monthInput.value = ym;

  // Overview + Drawer/Edit/Audit wiring
  wireFilters();
  wireSorting();
  wireDrawer();
  wireEditModal();

  // Live now wiring
  wireLiveList();
  await loadLiveNow();
  startLiveTicker(1000);

  // Initial data loads
  await loadSummary();
  bootRealtime();
  wireScheduleTab();
  wireStoresTab();
  wireUsersTab();
  wireUsersPanel();
  wireGlobalCalendar();
if (!gcMonthStart) gcMonthStart = getMonthStart(new Date());

// Optional: auto-open schedule tab for admins the first time
// qs('tabSchedule').click();


});

// Kickoff if init already ran
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  if (window.supabase) {
    document.dispatchEvent(new Event('supabase-ready'));
  } else {
    setTimeout(() => {
      if (window.supabase) document.dispatchEvent(new Event('supabase-ready'));
    }, 0);
  }
}
