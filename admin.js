import { initOverview } from "./admin-overview.js";
import { initStores } from "./admin-stores.js";
import {
  uploadW9ViaEdge,
  listW9ViaEdge,
  getW9SignedUrlViaEdge,
  setW9StatusViaEdge
} from './admin-taxdocs.js';



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
// =========================================================
// Minimal Toast Helper (admin.js needs this)
// =========================================================


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



function wireUsersPanel() {
  const btn = document.getElementById('userAddBtn');
  if (!btn) return;

  // Open the premium invite modal (not the old prompt)
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    openUserModal();
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


function fmtTimeHM(ts){
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
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


// Re-render support (so resize doesn't refetch)
let schedLastResolvedByDate = null;
let schedLastOverridesByDate = null;
let schedLastIsMobile = null;



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
    list.addEventListener('click', async (e) => {
      const t = e.target;

// If this click happened inside a global-day shift card,
// switch drawer context + shift map to the correct employee before acting.
const shiftCard = t.closest('.shift');
if (shiftCard?.dataset?.employeeId && shiftCard?.dataset?.monthStart) {
  const empId = shiftCard.dataset.employeeId;
  const monthStart = shiftCard.dataset.monthStart;

  // Only switch if different
  if (drawerContext.employeeId !== empId || drawerContext.monthStart !== monthStart) {
    drawerContext.employeeId = empId;
    drawerContext.monthStart = monthStart;

    // Rebuild currentShiftsById for THIS employee/month so Edit works
    // (This is required because currentShiftsById is global.)
    fetchWorkerShifts(empId, monthStart).catch(console.warn);
  }

  // Prevent actions on placeholders
  if (shiftCard.dataset.placeholder === '1') {
    e.preventDefault();
    return;
  }
}
  

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

// If we don't have it yet (because we just switched employee), fetch then open
let shift = currentShiftsById.get(id);
if (!shift && drawerContext?.employeeId && drawerContext?.monthStart) {
  await fetchWorkerShifts(drawerContext.employeeId, drawerContext.monthStart);
  shift = currentShiftsById.get(id);
}
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

async function openGlobalDayDrawer(workISO, scheduledRowsForDay){
  // Title/subtitle (don’t use monthLabel here)
  qs('drawerTitle').textContent = 'Global schedule';
  qs('drawerSubtitle').textContent = workISO;

  // Day window (used for overlap + KPI slicing)
  const dayStart = new Date(`${workISO}T00:00:00`);
  const dayEnd   = new Date(`${workISO}T23:59:59.999`);

  // Build a quick lookup of scheduled rows (by employee_id)
  const schedByEmp = new Map();
  for (const r of (scheduledRowsForDay || [])){
    schedByEmp.set(r.employee_id, r);
  }

  // For performance: only fetch month once per employee (few employees per day)
  const monthStartISO = (() => {
    const d = new Date(`${workISO}T00:00:00`);
    const ms = new Date(d.getFullYear(), d.getMonth(), 1);
    return ms.toISOString().slice(0,10);
  })();

  // Fetch actual shifts (Overview-style objects) for each scheduled employee
  const empIds = Array.from(schedByEmp.keys());
  const actualByEmp = new Map();

  await Promise.all(empIds.map(async (empId) => {
    try{
      const monthShifts = await fetchWorkerShifts(empId, monthStartISO); // existing Overview loader

      // Show a shift on this day if it overlaps the day window
      const sameDay = (monthShifts || []).filter(s => {
        const a = s.clock_in ? new Date(s.clock_in) : null;
        const b = s.clock_out ? new Date(s.clock_out) : null;

        // open shift: include if it started before day end
        if (a && !b) return a <= dayEnd;

        if (!a || !b) return false;

        // overlap test
        return (a <= dayEnd) && (b >= dayStart);
      });

      actualByEmp.set(empId, sameDay);
    } catch (e){
      console.warn('openGlobalDayDrawer fetchWorkerShifts failed', empId, e);
      actualByEmp.set(empId, []);
    }
  }));

  // Build a unified list to render
  const nowISO = new Date().toISOString().slice(0,10);
  const isFuture = workISO > nowISO;

  // helper: compute how many ms of a shift fall inside this day
  const daySliceMs = (clockInISO, clockOutISO) => {
    const a = clockInISO ? new Date(clockInISO) : null;
    const b = clockOutISO ? new Date(clockOutISO) : null;

    if (!a) return 0;

    // open shift: slice up to now (but not beyond dayEnd)
    const endMs = b ? b.getTime() : Math.min(Date.now(), dayEnd.getTime());

    const start = Math.max(a.getTime(), dayStart.getTime());
    const end   = Math.min(endMs, dayEnd.getTime());

    return Math.max(0, end - start);
  };

  const rendered = [];

  for (const [empId, sched] of schedByEmp.entries()){
    const displayName = sched.display_name || '—';
    const actualList = actualByEmp.get(empId) || [];

    if (actualList.length){
      for (const s of actualList){
        rendered.push({
          ...s,

          // ✅ for KPIs only (how much of this shift belongs to this clicked day)
          _day_ms: daySliceMs(s.clock_in, s.clock_out),

          _display_name: displayName,
          _employee_id: empId,
          _month_start: monthStartISO
        });
      }
    } else {
      // Placeholder “shift not done” card (still show it on both days via overlap logic above)
      const schedHoursMs = (() => {
        const a = new Date(sched.start_ts).getTime();
        const b = new Date(sched.end_ts).getTime();
        const ms = b - a;
        return Number.isFinite(ms) ? Math.max(0, ms) : 0;
      })();

      rendered.push({
        id: `sched:${empId}:${workISO}`, // ✅ unique fake id so audit-* ids aren't duplicated
        clock_in: sched.start_ts,
        clock_out: sched.end_ts,

        // keep full scheduled duration on the card (you said leave in/out as-is)
        duration_ms: schedHoursMs,

        // ✅ KPI slice for this day only
        _day_ms: daySliceMs(sched.start_ts, sched.end_ts),

        store_id: sched.store_id || null,
        photo_in_url: null,
        photo_out_url: null,
        anomalies: [],
        has_anomaly: false,
        approval_status: isFuture ? 'scheduled' : 'missed',
        approval_note: isFuture
          ? 'Shift has not happened yet.'
          : 'No timesheet entry found for this scheduled shift.',
        approved_at: null,
        breaks: [],
        break_count: 0,
        break_ms: 0,
        is_open: false,

        _display_name: displayName,
        _employee_id: empId,
        _month_start: monthStartISO,
        _placeholder: true
      });
    }
  }

  // ✅ Summary KPIs (ONLY hours inside this clicked day)
  const totalHours = rendered.reduce((sum, s) => sum + ((s._day_ms || 0) / 3600000), 0);
  qs('dsShifts').textContent = String(rendered.length);
  qs('dsHours').textContent  = totalHours.toFixed(2);
  qs('dsAvg').textContent    = (rendered.length ? (totalHours / rendered.length) : 0).toFixed(2);

  // Render using your existing drawer host
  qs('drawerList').innerHTML = '';
  openDrawer();

  // Save a dedicated “global-day” drawer mode
  drawerContext = {
    employeeId: null,
    displayName: 'Global schedule',
    monthStart: monthStartISO
  };

  // Render normally (uses your existing card UI)
  renderDrawerList(rendered);

  // Prepend a worker name header above each card + attach context
  const cards = Array.from(qs('drawerList').querySelectorAll('.shift'));

  for (let i = 0; i < cards.length; i++){
    const card = cards[i];
    const item = rendered[i];
    if (!item) continue;

    card.dataset.employeeId = item._employee_id || '';
    card.dataset.monthStart = item._month_start || '';
    card.dataset.placeholder = item._placeholder ? '1' : '0';

    const nameRow = document.createElement('div');
    nameRow.className = 'drawer-day-name';
    nameRow.style.margin = '10px 0 6px';
    nameRow.style.fontWeight = '900';
    nameRow.style.fontSize = '18px';
    nameRow.textContent = item._display_name || '—';

    card.parentNode.insertBefore(nameRow, card);

    if (item._placeholder){
      card.querySelector('.shift-actions')?.remove();

      const note = document.createElement('div');
      note.className = 'drawer-empty';
      note.style.marginTop = '8px';
      note.textContent = item.approval_note || 'Scheduled';
      card.appendChild(note);
    }
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

qs('globalCalGrid')?.addEventListener('click', async (e) => {
  const slot = e.target.closest('.cal-slot');      // click on a worker row
  const dayCell = e.target.closest('.cal-day');    // click anywhere in day
  if (!dayCell) return;

  const workISO = dayCell.dataset.workDate;
  if (!workISO) return;

  const clickedEmpId = slot?.dataset?.employeeId || null;

  try{
    // ✅ Use the exact same rows that were rendered (prevents mobile/desktop divergence)
    const cache = window.__gcCache;
    let rows = Array.isArray(cache?.rows) ? cache.rows : null;

    // Fallback only if cache is missing
    if (!rows){
      const gridStart = startOfMonthGrid(gcMonthStart);
      const gridEnd = addDays(gridStart, 41);
      rows = await fetchGlobalScheduleRange(gridStart, gridEnd);
    }

    // Respect the current search filter (same as renderGlobalCalendar)
    const q = (qs('gcSearch')?.value || '').trim().toLowerCase();

    let dayRows = (rows || []).filter(r => String(r.work_date || '').slice(0,10) === workISO);

    if (q){
      dayRows = dayRows.filter(r => (String(r.display_name || '').toLowerCase().includes(q)));
    }

    // If they tapped a specific worker slot, open only that worker for the day
    if (clickedEmpId){
      dayRows = dayRows.filter(r => String(r.employee_id || '') === String(clickedEmpId));
    }

    await openGlobalDayDrawer(workISO, dayRows);
  } catch (err){
    console.error(err);
    qs('drawerTitle').textContent = 'Global schedule';
    qs('drawerSubtitle').textContent = workISO;
    qs('drawerList').innerHTML = `<div class="drawer-empty">Error loading date.</div>`;
    openDrawer();
  }
});

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

  // =========================
// Global bridge for non-module scripts (admin-schedule.js)
// =========================
window.supabaseClient = supabaseClient;

// expose shared helpers schedule relies on
window.getActiveEmployees = getActiveEmployees;

window.toISODate = toISODate;
window.fromISO = fromISO;
window.addDays = addDays;
window.weekLabel = weekLabel;
window.yyyymm = yyyymm;
window.getMonthStart = getMonthStart;
window.nextMonth = nextMonth;
window.prevMonth = prevMonth;
window.startOfMonthGrid = startOfMonthGrid;
window.fmtHM = fmtHM;
window.fmtTimeHM = fmtTimeHM;
window.DOW = DOW;

// store helpers (use your existing bridge funcs)
window.ensureStoresCache = ensureStoresCache;
window.storeOptionsHTML = storeOptionsHTML;
window.storeNameById = storeNameById;
window.storeDirectionsHref = storeDirectionsHref;
window.applyDirectionsLinkFromStoreId = applyDirectionsLinkFromStoreId;

// toast if schedule uses it anywhere later
window.showToast = window.showToast || showToast;


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
