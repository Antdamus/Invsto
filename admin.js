import { initOverview } from "./admin-overview.js";
import { initStores } from "./admin-stores.js";

// admin.js — Overview + Drawer/Edit/Audit + Payroll Weekly + Period Lock/Unlock (Phase 3.3)
let supabaseClient = null;
let drawerOnlyAnoms = false;
let lastDrawerShifts = []; // keep latest list to re-render on toggle



/* =========================================================
   Phase 3.5 — Clamp long anomaly chip lists in drawer cards
   - Shows first N chips + "+X more" toggle
   ========================================================= */

function applyChipClamp(root, limit = 2) {
  if (!root) return;

  const cards = Array.from(root.querySelectorAll(".shift"));
  cards.forEach((card) => {
    const chipsWrap = card.querySelector(".shift-chips");
    if (!chipsWrap) return;

    // Only clamp anomaly chips (the badges inside the chips row)
    const badges = Array.from(chipsWrap.querySelectorAll(".badge"));
    if (badges.length <= limit) return;

    // If we already clamped once, do nothing
    if (chipsWrap.querySelector(".chip-more-btn")) return;

    // Hide extras
    badges.forEach((b, idx) => {
      if (idx >= limit) b.classList.add("chip-hidden");
    });

    const hiddenCount = badges.length - limit;

    // Create "+N more" toggle chip
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "badge chip-more-btn";
    btn.setAttribute("data-chip-toggle", "1");
    btn.textContent = `+${hiddenCount} more`;
    chipsWrap.appendChild(btn);
  });
}

function toggleChipClamp(btn) {
  const chipsWrap = btn.closest(".shift-chips");
  if (!chipsWrap) return;

  const isOpen = chipsWrap.classList.toggle("chips-expanded");

  const hidden = Array.from(chipsWrap.querySelectorAll(".badge.chip-hidden"));
  hidden.forEach((b) => {
    b.style.display = isOpen ? "inline-flex" : "";
  });

  // Update button label
  if (isOpen) {
    btn.textContent = "Show less";
  } else {
    // Recompute count (in case flags changed)
    const all = Array.from(chipsWrap.querySelectorAll(".badge"));
    const limit = +chipsWrap.getAttribute("data-chip-limit") || 2;
    const nHidden = Math.max(0, all.length - 1 - limit); // -1 excludes the button badge itself
    btn.textContent = `+${nHidden} more`;
  }
}


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

function applyDirectionsLinkFromStoreId(a, b) {
  // Accept both call styles:
  // 1) (linkEl, storeId)  [older code]
  // 2) (storeId, linkEl)  [newer code / modules]
  let linkEl, storeId;

  if (a && typeof a === "object" && ("href" in a || a.tagName)) {
    linkEl = a;
    storeId = b;
  } else {
    storeId = a;
    linkEl = b;
  }

  if (!linkEl || typeof storeId !== "string") return;

  // storesById is a Map, so use .get()
  const store = (typeof storesById?.get === "function")
    ? storesById.get(storeId)
    : null;

  if (!store || store.lat == null || store.lng == null) {
    linkEl.href = "#";
    linkEl.classList.add("disabled");
    return;
  }

  linkEl.href = `https://www.google.com/maps/dir/?api=1&destination=${store.lat},${store.lng}`;
  linkEl.classList.remove("disabled");
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
    const ymd = String(r.work_date || '').slice(0, 10);   // handles 'YYYY-MM-DD' or 'YYYY-MM-DDTHH...'
    const key = toISODate(fromISO(ymd));                  // local date, no UTC shift

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




function renderScheduleGrid(weekStart, resolvedByDate, overridesByDate){
  const tbody = qs('schedBody');
  const cards = qs('schedCards');

  const isMobile = window.matchMedia && window.matchMedia('(max-width: 820px)').matches;

  // IMPORTANT: render ONLY ONE view (prevents duplicate IDs)
  if (isMobile){
    if (tbody) tbody.innerHTML = `<tr><td colspan="4" class="muted">Use mobile cards below.</td></tr>`;
    if (!cards) return;
    cards.innerHTML = '';
  } else {
    if (cards) cards.innerHTML = '';
    if (!tbody) return;
    tbody.innerHTML = '';
  }

  for (let i=0;i<7;i++){
    const day = addDays(weekStart, i);
    const iso = toISODate(day);

    const resolved = resolvedByDate.get(iso) || null; // { start_ts, end_ts, source, store_id }
    const ov = overridesByDate.get(iso) || null;      // { off, start_local, end_local, store_id, ...exceptions }

    const resolvedStr = resolved
      ? `${fmtTimeHM(resolved.start_ts)}–${fmtTimeHM(resolved.end_ts)}`
      : '—';
    const srcStr = resolved ? (resolved.source === 'override' ? 'override' : 'recurring') : '';
    const resolvedStoreLabel = resolved?.store_id ? storeNameById(resolved.store_id) : '—';
    const resolvedDirHref = resolved?.store_id ? storeDirectionsHref(resolved.store_id) : null;

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

    // Phase 3 exceptions
    const ovAnyIn  = !!ov?.allow_any_store_in;
    const ovAnyOut = !!ov?.allow_any_store_out;
    const ovInStore  = ov?.clock_in_store_id ? String(ov.clock_in_store_id) : '';
    const ovOutStore = ov?.clock_out_store_id ? String(ov.clock_out_store_id) : '';

    const recDir = storeDirectionsHref(recStorePrefill);
    const ovDir  = storeDirectionsHref(ovStore);
    const inDir  = storeDirectionsHref(ovAnyIn ? '' : ovInStore);
    const outDir = storeDirectionsHref(ovAnyOut ? '' : ovOutStore);

    const dayLabel = `${DOW[i]} ${day.getMonth()+1}/${day.getDate()}`;
    const preview = `${resolvedStr}${srcStr ? ` (${srcStr})` : ''} • ${resolvedStoreLabel}`;

    if (!isMobile){
      // -------------------------
      // Desktop table
      // -------------------------
      const resolvedHtml = `
        <div class="sched-resolved">
          ${resolvedStr} ${srcStr ? `<span class="sched-note">(${srcStr})</span>` : ''}
          <div class="sched-sub">
            <span class="sched-store">${resolvedStoreLabel}</span>
            ${resolvedDirHref ? `<a class="mini-link" href="${resolvedDirHref}" target="_blank" rel="noopener noreferrer">Directions</a>` : ''}
          </div>
        </div>
      `;

      const tr = document.createElement('tr');
      tr.className = 'sched-row';
      tr.innerHTML = `
        <td class="day">${dayLabel}</td>

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
    } else {
      // -------------------------
      // Mobile day-card (matches your CSS: .sched-card + details/summary)
      // -------------------------
      const card = document.createElement('div');
      card.className = 'sched-card';

      const recPill = (resolved && resolved.source === 'recurring') ? `<span class="sched-pill rec">REC</span>` : '';
      const ovPill  = (ov ? `<span class="sched-pill ov">OV</span>` : '');

      card.innerHTML = `
        <details>
          <summary>
            <div class="head-left">
              <div class="dayline">
                <span class="dayname">${DOW[i]}</span>
                <span class="datechip">${day.getMonth()+1}/${day.getDate()}</span>
              </div>
              <div class="preview">${preview}</div>
            </div>
            <div class="head-right">
              ${recPill}${ovPill}
            </div>
          </summary>

          <div class="body">

            <div class="sched-block">
              <div class="block-title">
                <span class="t">Resolved (this week)</span>
                <span class="hint">${srcStr || '—'}</span>
              </div>
              <div class="sched-resolved">
                ${resolvedStr}
                <div class="sched-sub">
                  <span class="sched-store">${resolvedStoreLabel}</span>
                  ${resolvedDirHref ? `<a class="btn ghost" style="text-decoration:none;" href="${resolvedDirHref}" target="_blank" rel="noopener noreferrer">Directions</a>` : ''}
                </div>
              </div>
            </div>

            <div class="sched-block">
              <div class="block-title">
                <span class="t">Recurring (weekly)</span>
                <span class="hint">Sets the normal schedule</span>
              </div>

              <div class="sched-formrow">
                <input type="time" id="recStart-${i}" value="${recStartPrefill}">
                <span>–</span>
                <input type="time" id="recEnd-${i}" value="${recEndPrefill}">
                <select class="store" id="recStore-${i}">
                  ${storeOptionsHTML(recStorePrefill)}
                </select>
              </div>

              <div class="sched-actions">
                <button class="btn primary" data-save-recurring="${i}">Save recurring</button>
                <button class="btn ghost" data-clear-recurring="${i}">Remove recurring</button>
                <a class="btn ghost" id="recDir-${i}" href="${recDir || '#'}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Directions</a>
              </div>
            </div>

            <div class="sched-block">
              <div class="block-title">
                <span class="t">Override (this week)</span>
                <span class="hint">Only affects this week</span>
              </div>

              <div class="sched-formrow">
                <label style="display:flex; align-items:center; gap:10px; font-weight:800;">
                  <input type="checkbox" id="ovOff-${iso}" ${ovOff ? 'checked' : ''}>
                  Off
                </label>
                <input type="time" id="ovStart-${iso}" value="${ovStart}" ${ovOff ? 'disabled':''}>
                <span>–</span>
                <input type="time" id="ovEnd-${iso}" value="${ovEnd}" ${ovOff ? 'disabled':''}>
                <select class="store" id="ovStore-${iso}" ${ovOff ? 'disabled':''}>
                  ${storeOptionsHTML(ovStore)}
                </select>
              </div>

              <div class="sched-actions">
                <button class="btn primary" data-save-override="${iso}">Save override</button>
                <button class="btn ghost" data-clear-override="${iso}">Clear override</button>
                <a class="btn ghost" id="ovDir-${iso}" href="${ovDir || '#'}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Directions</a>
              </div>

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
                    <a class="btn ghost" id="ovInDir-${iso}" href="${inDir || '#'}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Directions</a>
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
                    <a class="btn ghost" id="ovOutDir-${iso}" href="${outDir || '#'}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;">Directions</a>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </details>
      `;

      cards.appendChild(card);

      applyDirectionsLinkFromStoreId(qs(`recDir-${i}`), recStorePrefill);
      applyDirectionsLinkFromStoreId(ovStore, qs(`ovDir-${iso}`));
      applyDirectionsLinkFromStoreId(ovAnyIn ? '' : ovInStore, qs(`ovInDir-${iso}`));
      applyDirectionsLinkFromStoreId(ovAnyOut ? '' : ovOutStore, qs(`ovOutDir-${iso}`));
    }
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
if (qs('schedBody')){
  qs('schedBody').innerHTML = `<tr><td colspan="4" class="muted">Failed to load schedule.</td></tr>`;
}
if (qs('schedCards')){
  qs('schedCards').innerHTML = `<div class="muted" style="padding:12px;">Failed to load schedule.</div>`;
}

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

// Re-render support (so resize doesn't refetch)
let schedLastResolvedByDate = null;
let schedLastOverridesByDate = null;
let schedLastIsMobile = null;


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

qs('schedEmpSection').addEventListener('click', (e) => {
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

qs('schedEmpSection').addEventListener('change', (e) => {
  const id = e.target?.id || '';

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
    if (st) applyDirectionsLinkFromStoreId(st.value, qs(`ovDir-${iso}`));
    return;
  }

  if (id.startsWith('recStore-')){
    const weekday = id.slice('recStore-'.length);
    const selEl = qs(`recStore-${weekday}`);
    applyDirectionsLinkFromStoreId(selEl?.value, qs(`recDir-${weekday}`));
    return;
  }

  if (id.startsWith('ovStore-')){
    const iso = id.slice('ovStore-'.length);
    const selEl = qs(`ovStore-${iso}`);
    applyDirectionsLinkFromStoreId(selEl?.value, qs(`ovDir-${iso}`));
    return;
  }

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

  let _schedLastMobile = window.matchMedia('(max-width: 820px)').matches;
window.addEventListener('resize', () => {
  const now = window.matchMedia('(max-width: 820px)').matches;
  if (now !== _schedLastMobile){
    _schedLastMobile = now;
    loadScheduleWeek(); // re-render in the other layout
  }
});

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
  const host = qs('drawerList');
  host.innerHTML = '';

  const src = drawerOnlyAnoms ? shifts.filter(s => s.has_anomaly) : shifts;
  if (!src.length){
    host.innerHTML = `<div class="drawer-empty">${drawerOnlyAnoms ? 'No anomalies in this month.' : 'No shifts in this month.'}</div>`;
    return;
  }

  const storeName = (storeId) => {
    const n = storeNameById(storeId);
    return n ? n : '—';
  };

  const statusBadgeHTML = (s) => {
    if (s.is_open) return `<span class="badge warn">OPEN</span>`;
    const st = (s.approval_status || 'pending').toLowerCase();
    if (st === 'approved') return `<span class="badge open">APPROVED</span>`;
    if (st === 'waived')   return `<span class="badge warn">WAIVED</span>`;
    return `<span class="badge">PENDING</span>`;
  };

  const anomBadgesHTML = (s) => {
    const arr = Array.isArray(s.anomalies) ? s.anomalies : [];
    if (!arr.length) return '';
    return arr.map(code => `<span class="badge warn">⚠︎ ${escapeHtml(code)}</span>`).join('');
  };

  const photoThumb = (url, label) => {
    if (!url) return '';
    const safeUrl = escapeHtml(url);
    const safeLabel = escapeHtml(label || 'Photo');
    return `
      <a href="${safeUrl}" data-photo-url="${safeUrl}" aria-label="${safeLabel}">
        <img class="thumb" src="${safeUrl}" alt="${safeLabel}">
      </a>
    `;
  };

  const breakPhotosBlock = (b) => {
    const start = b.photo_start_url ? photoThumb(b.photo_start_url, 'Break start photo') : `<span class="muted">No start photo</span>`;
    const end   = b.photo_end_url   ? photoThumb(b.photo_end_url,   'Break end photo')   : `<span class="muted">No end photo</span>`;
    return `<div class="br-photos">${start}${end}</div>`;
  };

  const fmtDateShort = (isoOrDate) => {
    const d = new Date(isoOrDate);
    return d.toLocaleDateString([], { weekday:'short', month:'short', day:'numeric' });
  };

  for (const s of src){
    const inStr  = fmtLocal(s.clock_in);
    const outStr = s.is_open ? 'OPEN' : fmtLocal(s.clock_out);
    const durStr = fmtDurationHM(s.duration_ms);

    const breaksText = s.break_count ? `${s.break_count} break(s) • ${fmtDurationHM(s.break_ms)}` : 'No breaks';
    const storeLabel = storeName(s.store_id);
    const dirHref = s.store_id ? (storeDirectionsHref(s.store_id) || '#') : '#';

    // Actions: hide approve/waive for OPEN shifts
// Actions: hide approve/waive for OPEN shifts
const showApprovalBtns = !s.is_open;

// Only allow Approve/Waive when still pending
const st = String(s.approval_status || 'pending').toLowerCase();

const approvalBtns = showApprovalBtns ? `
  ${st === 'pending' ? `
    <button class="btn small" type="button" data-approve-id="${s.id}">Approve</button>
    <button class="btn small ghost" type="button" data-waive-id="${s.id}">Waive</button>
  ` : ``}

  ${(st === 'approved' || st === 'waived') ? `
    <button class="btn small ghost" type="button" data-unapprove-id="${s.id}">Remove</button>
  ` : ``}
` : '';


    // Shift-level photo strip (clock in/out)
    const shiftPhotos = (s.photo_in_url || s.photo_out_url) ? `
      <div class="br-photos" aria-label="Shift photos">
        ${photoThumb(s.photo_in_url, 'Clock-in photo')}
        ${photoThumb(s.photo_out_url, 'Clock-out photo')}
      </div>
    ` : '';

    // Waive note block (computed OUTSIDE the HTML string)
    const waiveNoteBlock =
      (String(s.approval_status || '').toLowerCase() === 'waived' && (s.approval_note || '').trim().length)
        ? `<div class="shift-waive-note">
             <div class="wn-label">Waived note</div>
             <div class="wn-text">${escapeHtml(s.approval_note)}</div>
           </div>`
        : ``;

    // Breaks block
    let breaksBlock = '';
    if (s.break_count){
      const blocks = (s.breaks || []).map(b => {
        const open = !b.ended_at;
        const dur = open ? 0 : (new Date(b.ended_at) - new Date(b.started_at));
        const durStrB = open ? '—' : fmtDurationHM(dur);

        return `
          <div class="break">
            <div class="br-times">
              <strong>${new Date(b.started_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</strong>
              → ${open ? 'OPEN' : new Date(b.ended_at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}
            </div>
            <div class="br-dur">${open ? 'Break is still open' : `Duration: ${durStrB}`}</div>
            ${breakPhotosBlock(b)}
          </div>
        `;
      }).join('');

      breaksBlock = `<div class="breaks">${blocks}</div>`;
    }

    const dateLine = fmtDateShort(s.clock_in);

    const card = document.createElement('div');
    card.className = 'shift';
    card.innerHTML = `
      <div class="shift-top">
        <div class="shift-title">
          <div class="shift-date"><strong>${dateLine}</strong></div>
          <div class="shift-range">${inStr} → ${outStr}</div>
        </div>

        <div class="shift-status">
          ${statusBadgeHTML(s)}
          ${(() => {
            const st = String(s.approval_status || 'pending').toLowerCase();
            const unresolved = s.has_anomaly && (st === 'pending');
            return unresolved
              ? `<span class="badge warn">Needs review</span>`
              : `<span class="badge">OK</span>`;
          })()}

        </div>
      </div>

      <div class="shift-meta-grid">
        <div class="shift-meta-line">
          <span class="shift-meta-label">Duration</span>
          <span class="shift-meta-value">${durStr}</span>
        </div>

        <div class="shift-meta-line">
          <span class="shift-meta-label">Breaks</span>
          <span class="shift-meta-value">${breaksText}</span>
        </div>

        <div class="shift-meta-line shift-meta-store">
          <span class="shift-meta-label">Store</span>
          <span class="shift-meta-value">${escapeHtml(storeLabel)}</span>
        </div>
      </div>

      <div class="shift-chips-row">
        <div class="shift-chips" data-chip-limit="2">
          ${anomBadgesHTML(s)}
        </div>

        <div class="shift-chip-actions">
          ${s.store_id ? `<a class="btn small ghost" href="${escapeHtml(dirHref)}" target="_blank" rel="noopener">Directions</a>` : ``}
        </div>
      </div>

      ${waiveNoteBlock}

      ${shiftPhotos ? `<div class="shift-photos">${shiftPhotos}</div>` : ``}

      <div class="shift-actions">
        <button class="btn small ghost" type="button" data-audit-id="${s.id}">Audit</button>
        <button class="btn small ghost" type="button" data-edit-id="${s.id}">Edit</button>
        ${approvalBtns}
      </div>

      <div class="audit hidden" id="audit-${s.id}"></div>

      ${breaksBlock}
    `;

    host.appendChild(card);
  }

  // ✅ Clamp after everything renders (once)
  applyChipClamp(host, 2);
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

let waivingShiftId = null;
let waiveSaving = false;

function openWaiveModal(shiftId, presetNote){
  waivingShiftId = shiftId;
  qs('waiveNote').value = (presetNote || '').trim();
  qs('waiveError').textContent = '';
  show(qs('waiveError'), false);
  updateWaiveCount();

  qs('waiveModal').classList.add('open');
  qs('waiveModal').classList.remove('hidden');
  qs('waiveModalBackdrop').classList.add('show');
  qs('waiveModalBackdrop').classList.remove('hidden');

  // focus
  setTimeout(()=>qs('waiveNote')?.focus(), 0);
}

function closeWaiveModal(){
  waivingShiftId = null;
  waiveSaving = false;

  qs('waiveModal')?.classList.remove('open');
  qs('waiveModal')?.classList.add('hidden');
  qs('waiveModalBackdrop')?.classList.remove('show');
  qs('waiveModalBackdrop')?.classList.add('hidden');
}

function updateWaiveCount(){
  const v = (qs('waiveNote')?.value || '');
  const c = qs('waiveCount');
  if (c) c.textContent = String(v.length);
}

async function saveWaiveNote(){
  if (waiveSaving) return;
  if (!waivingShiftId) return;

  const noteRaw = (qs('waiveNote')?.value || '').trim();
  if (noteRaw.length < 3){
    qs('waiveError').textContent = 'Waive reason is required (minimum 3 characters).';
    show(qs('waiveError'), true);
    return;
  }

  waiveSaving = true;
  try{
    // Uses your existing approval RPC (same as approve/unapprove flow)
    const { error } = await supabaseClient.rpc('approve_shift', {
      _time_entry_id: waivingShiftId,
      _status: 'waived',
      _note: noteRaw
    });
    if (error) throw error;

    showToast('Waived (saved with note)', 'ok');
    const changedId = waivingShiftId;
    closeWaiveModal();

    // refresh drawer + overview counts so "Needs review" disappears
    if (typeof refreshDrawerAfterApprovalChange === 'function'){
      await refreshDrawerAfterApprovalChange(changedId);
    }else{
      // fallback: reload current drawer
      const { employeeId, monthStart } = drawerContext;
      const shifts = await fetchWorkerShifts(employeeId, monthStart);
      renderDrawerSummary(shifts);
      renderDrawerList(shifts);
      await loadSummary();
    }
  }catch(err){
    console.error(err);
    qs('waiveError').textContent = err?.message || 'Failed to save waive note.';
    show(qs('waiveError'), true);
  }finally{
    waiveSaving = false;
  }
}



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



function ensurePhotoViewer(){
  if (document.getElementById('og-imgv')) return;

  const bd = document.createElement('div');
  bd.id = 'og-imgv-backdrop';
  bd.className = 'og-imgv-backdrop';
  bd.setAttribute('aria-hidden','true');

  const wrap = document.createElement('div');
  wrap.id = 'og-imgv';
  wrap.className = 'og-imgv';
  wrap.setAttribute('role','dialog');
  wrap.setAttribute('aria-modal','true');

  wrap.innerHTML = `
    <div class="og-imgv-top">
      <button type="button" class="og-imgv-close" id="og-imgv-close" aria-label="Close">✕</button>
    </div>
    <div class="og-imgv-stage">
      <img id="og-imgv-img" alt="Photo preview" />
    </div>
  `;

  document.body.appendChild(bd);
  document.body.appendChild(wrap);

  const close = () => closePhotoViewer();
  bd.addEventListener('click', close);
  wrap.querySelector('#og-imgv-close')?.addEventListener('click', close);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePhotoViewer();
  });
}

function openPhotoViewer(url){
  try{
    ensurePhotoViewer();
    const bd = document.getElementById('og-imgv-backdrop');
    const wrap = document.getElementById('og-imgv');
    const img = document.getElementById('og-imgv-img');
    if (!bd || !wrap || !img) return;

    img.src = url;
    bd.classList.add('show');
    wrap.classList.add('show');
  }catch(e){
    console.warn(e);
    window.open(url, '_blank', 'noopener');
  }
}

function closePhotoViewer(){
  const bd = document.getElementById('og-imgv-backdrop');
  const wrap = document.getElementById('og-imgv');
  const img = document.getElementById('og-imgv-img');
  if (img) img.src = '';
  bd?.classList.remove('show');
  wrap?.classList.remove('show');
}

/* =========================================================
   Drawer approvals — required by wireDrawer()
   - Approve: sets status=approved
   - Waive: opens your waive modal (already implemented)
   - Remove: clears approval back to pending (or deletes row)
   ========================================================= */

async function refreshDrawerAfterApprovalChange(changedShiftId) {
  // Re-fetch and re-render the drawer so chips/buttons update
  if (!drawerContext?.employeeId || !drawerContext?.monthStart) return;

  const shifts = await fetchWorkerShifts(drawerContext.employeeId, drawerContext.monthStart);
  renderDrawerSummary(shifts);
  renderDrawerList(shifts);

  // Optional: also reopen the audit panel if it was open
  if (changedShiftId) {
    const auditEl = document.getElementById(`audit-${changedShiftId}`);
    if (auditEl && !auditEl.classList.contains('hidden')) {
      auditCache.delete(changedShiftId);
      await toggleAudit(changedShiftId);
    }
  }
}

async function setShiftApprovalStatus(timeEntryId, status, note = null) {
  // status: 'approved' | 'waived' | 'pending'
  if (!timeEntryId) throw new Error("Missing time entry id.");

  // "pending" means: remove the approval row (back to default state)
if (String(status).toLowerCase() === "pending") {
  const { error } = await supabaseClient.rpc("unapprove_shift", {
    _time_entry_id: timeEntryId
  });
  if (error) throw error;
  return;
}


  // Approved / waived go through the RPC
  const { error } = await supabaseClient.rpc("approve_shift", {
    _time_entry_id: timeEntryId,
    _status: status,
    _note: note,
  });
  if (error) throw error;
}

async function onApproveClick(shiftId) {
  if (!shiftId) return;

  const s = currentShiftsById.get(shiftId);
const st = String(s?.approval_status || 'pending').toLowerCase();
if (st === 'waived') {
  showToast("This shift was waived. Use Remove to return to pending first.", "warn");
  return;
}

  const ok = window.confirm('Approve this shift?');
  if (!ok) return;

  try {
    await setShiftApprovalStatus(shiftId, 'approved', null);
    showToast('Approved ✅', 'ok');

    await refreshDrawerAfterApprovalChange(shiftId);
    if (typeof overviewApi?.loadSummary === 'function') await overviewApi.loadSummary();
    else await loadSummary?.();
  } catch (err) {
    console.error(err);
    showToast(err?.message || 'Failed to approve shift', 'err');
  }
}

function onWaiveClick(shiftId) {
  if (!shiftId) return;

  // Open your existing waive modal (already wired to saveWaiveNote())
  // Prefill with existing waive note if present
  const s = currentShiftsById.get(shiftId);
  const preset = (s?.approval_note || '').trim();
  openWaiveModal(shiftId, preset);
}

async function onUnapproveClick(shiftId) {
  if (!shiftId) return;

  const ok = window.confirm(
    'Remove approval/waive and return this shift to PENDING?\n\n' +
    'This will make it show as “Needs review” again if there are anomalies.'
  );
  if (!ok) return;

  try {
    await setShiftApprovalStatus(shiftId, 'pending', null);
    showToast('Removed (back to pending)', 'ok');

    await refreshDrawerAfterApprovalChange(shiftId);
    if (typeof overviewApi?.loadSummary === 'function') await overviewApi.loadSummary();
    else await loadSummary?.();
} catch (err) {
  console.error(err);
  const msg = err?.message || "Failed to remove approval";
  if (msg.toLowerCase().includes("locked pay period")) {
    showToast("Locked pay period: you can’t remove review for this shift.", "err");
  } else {
    showToast(msg, "err");
  }
}

}


function wireDrawer(){
  ensurePhotoViewer();

  // Close actions
  const closeBtn = qs('drawerCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeDrawer);

  // ---- Waive modal wiring ----
  const wb = qs('waiveModalBackdrop');
  if (wb) wb.addEventListener('click', closeWaiveModal);

  const wc = qs('waiveCloseBtn');
  if (wc) wc.addEventListener('click', closeWaiveModal);

  const wcan = qs('waiveCancelBtn');
  if (wcan) wcan.addEventListener('click', closeWaiveModal);

  const wn = qs('waiveNote');
  if (wn) wn.addEventListener('input', updateWaiveCount);

  const ws = qs('waiveSaveBtn');
  if (ws) ws.addEventListener('click', saveWaiveNote);


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

      // ✅ Photo viewer (thumbnails)
      const photoLink = t.closest('a[data-photo-url]');
      if (photoLink) {
        e.preventDefault();
        const url = photoLink.getAttribute('data-photo-url');
        if (url) openPhotoViewer(url);
        return;
      }

      // Phase 3.5: "+N more" anomaly chip toggle
        const moreBtn = t.closest(".chip-more-btn");
        if (moreBtn) {
          toggleChipClamp(moreBtn);
          return;
        }


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
    if (window.overviewApi?.loadSummary) await window.overviewApi.loadSummary();
    else await loadSummary();


    // If drawer is open for a worker/month, refresh it too
    const isOpen = !qs('drawer').classList.contains('hidden') && qs('drawer').classList.contains('open');
    if (isOpen && drawerContext?.employeeId && drawerContext?.monthStart){
      const shifts = await fetchWorkerShifts(drawerContext.employeeId, drawerContext.monthStart);
      renderDrawerSummary(shifts);
      renderDrawerList(shifts);
    }
    if (overviewApi?.loadLiveNow) await overviewApi.loadLiveNow();
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

let overviewApi = null;

let storesApi = null;

function setupStores() {
  storesApi = initStores({
    qs,
    show,
    showToast,

    // give the module access to the current supabase client
    getSupabase: () => supabaseClient,

    // shared utils it needs
    activateTab,
    toISODate,
    storeOptionsHTML,

    // IMPORTANT: your admin.js calls are inconsistent (sometimes (linkEl, storeId), sometimes (storeId, linkEl)).
    // We'll pass the same function after we make it tolerant in Step 3B.
    applyDirectionsLinkFromStoreId,
  });
}

// =========================================================
// Stores bridge (admin.js -> admin-stores.js module)
// - keeps legacy calls working (drawer, schedule, etc.)
// =========================================================

function storeNameById(storeId) {
  // Prefer module cache (best)
  try {
    if (storesApi?.storeNameById) return storesApi.storeNameById(storeId);
  } catch {}

  // Fallback: schedule store cache (Map)
  if (!storeId) return "";
  const s = (typeof storesById?.get === "function") ? storesById.get(storeId) : null;
  return s?.name || "";
}

function storeDirectionsHref(storeId) {
  try {
    if (storesApi?.storeDirectionsHref) return storesApi.storeDirectionsHref(storeId);
  } catch {}

  // Fallback: build from storesById
  if (!storeId) return null;
  const s = (typeof storesById?.get === "function") ? storesById.get(storeId) : null;
  if (!s || s.lat == null || s.lng == null) return null;

  const q = `${Number(s.lat)},${Number(s.lng)}`;
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(q)}`;
}

// Optional back-compat (some older code may still call this name)
async function ensureStoreNameCache() {
  if (storesApi?.ensureStoreNameCache) return storesApi.ensureStoreNameCache();
  if (typeof ensureStoresCache === "function") return ensureStoresCache();
}



function setupOverview() {
  overviewApi = initOverview({
    qs,
    debounce,
    fmtHours,


        // ✅ add these two
    fmtDurationHM,
    fetchLiveNow,

    monthLabel,
    monthInputToStart,
    fetchMonthlySummary,
    fetchMonthlyPendingReviewCounts,

    // This is the bridge into your existing drawer system:
    openWorkerDrawer: ({ employeeId, monthStart, displayName }) => {
      // Reuse the exact drawer open flow you already have
      drawerContext = { employeeId, monthStart, displayName };
      renderDrawerHeader(displayName, monthStart);

      qs("dsShifts").textContent = qs("dsHours").textContent = qs("dsAvg").textContent = "…";
      qs("drawerList").innerHTML = `<div class="drawer-empty">Loading shifts…</div>`;
      openDrawer();

      fetchWorkerShifts(employeeId, monthStart)
        .then((shifts) => {
          renderDrawerSummary(shifts);
          renderDrawerList(shifts);
        })
        .catch((err) => {
          console.error(err);
          qs("drawerList").innerHTML = `<div class="drawer-empty">Error loading shifts.</div>`;
        });
    },
  });
}

//* ============== Boot ============== */
document.addEventListener("supabase-ready", async () => {
  supabaseClient = window.supabase;

  // Guard UI
  show(qs("guardLoading"), true);
  show(qs("guardDenied"), false);
  show(qs("adminApp"), false);

  const ok = await ensureAdmin();

  show(qs("guardLoading"), false);
  show(qs("guardDenied"), !ok);
  show(qs("adminApp"), ok);

  if (!ok) return;

setupStores();

// ✅ Preload store names for Overview drawer + anywhere
try { await storesApi.ensureStoreNameCache(); }
catch(e){ console.warn("ensureStoreNameCache failed:", e); }

  // Header + tabs
  wireHeaderActions();
  wireTabs();
  activateTab("overview");

  // Prefill month for Overview
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const monthInput = qs("monthInput");
  if (monthInput) monthInput.value = ym;

  // ✅ Overview (desktop table + mobile cards)
  setupOverview();
  wireDrawer();
  wireEditModal();
  await overviewApi.bootOverview();



  // The rest of the dashboard
  bootRealtime();
  wireScheduleTab();
 storesApi.bootStores();


  wireUsersTab();
  wireUsersPanel();
  wireGlobalCalendar();
  if (!gcMonthStart) gcMonthStart = getMonthStart(new Date());
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
