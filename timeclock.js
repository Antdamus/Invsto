// timeclock.js — session-required version with Breaks + Camera
let supabaseClient;
let currentUser = null;
let currentEmployee = null;
let camBreakId = null;    // <-- add this


// concurrency guards
let isHydrating = false;
let isLoadingToday = false;
let isPunching = false;
let isBreaking = false;

// ---- Camera helpers ----
let camStream = null;
let camKind = null;       // 'in' | 'out' | 'break_start' | 'break_end'
let camEntryId = null;    // time_entries.id of the shift
let camBlob = null;

let breakCapMin = 30;            // default, will be fetched from SQL helper
let breakUsedMsToday = 0;

let breakActiveMs = 0;             // ticking while a break is open
let breakTickTimer = null;         // setInterval handle
let todayBreaks = [];              // rows for the Breaks Today table

// ===== Phase 4: Store context + auto store selection =====
let activeStores = [];
let storeById = new Map();

let todayScheduleRow = null;   // get_employee_schedule row for today (if any)
let todayExceptionRow = null;  // timeclock_day_exceptions row for today (if any)

const ANOMALY_LABEL = {
  UNSCHEDULED_DAY: "Unscheduled",
  EARLY_CLOCK_IN: "Early In",
  LATE_CLOCK_IN: "Late In",
  EARLY_CLOCK_OUT: "Early Out",
  LATE_CLOCK_OUT: "Late Out",
};

async function fetchMyTimeEntriesWeek(){
  if (!currentEmployee?.id) return { entries: [], anomalyMap: {} };

  const start = new Date(wsWeekStart);
  start.setHours(0,0,0,0);
  const end = addDays(wsWeekStart, 7);
  end.setHours(0,0,0,0);

  const { data, error } = await supabaseClient
    .from("time_entries")
    .select("id, clock_in, clock_out")
    .eq("employee_id", currentEmployee.id)
    .gte("clock_in", start.toISOString())
    .lt("clock_in", end.toISOString())
    .order("clock_in", { ascending: true });

  if (error){
    console.warn("fetchMyTimeEntriesWeek failed:", error);
    return { entries: [], anomalyMap: {} };
  }

  const entries = data || [];
  const ids = entries.map(e => e.id);
  const anomalyMap = await loadAnomaliesForEntryIds(ids);

  return { entries, anomalyMap };
}

function isoDateLocalFromTs(ts){
  const d = new Date(ts);
  return toISODate(d); // uses your existing toISODate()
}


function anomalyTone(code){
  if (code === "LATE_CLOCK_IN" || code === "EARLY_CLOCK_OUT") return "bad";
  if (code === "EARLY_CLOCK_IN" || code === "LATE_CLOCK_OUT") return "warn";
  if (code === "UNSCHEDULED_DAY") return "warn";
  return "warn";
}

function renderAnomalyBadges(anomalies){
  if (!Array.isArray(anomalies) || anomalies.length === 0) return "";
  return anomalies.map(code => {
    const label = ANOMALY_LABEL[code] || code;
    const tone = anomalyTone(code);
    return `<span class="badge ${tone}" title="${code}">${label}</span>`;
  }).join(" ");
}

function chunkIds(arr, size = 75){
  const out = [];
  for (let i=0;i<arr.length;i+=size) out.push(arr.slice(i, i+size));
  return out;
}

async function loadAnomaliesForEntryIds(entryIds){
  // returns object map: { [time_entry_id]: { anomalies:[], has_anomaly:true/false } }
  const out = {};
  const ids = (entryIds || []).filter(Boolean);
  if (!ids.length) return out;

  for (const batch of chunkIds(ids, 75)){
    const { data, error } = await supabaseClient
      .from("v_shift_anomalies")
      .select("time_entry_id, anomalies, has_anomaly")
      .in("time_entry_id", batch);

    if (error){
      console.warn("loadAnomaliesForEntryIds failed:", error);
      continue;
    }

    (data || []).forEach(r => {
      out[r.time_entry_id] = {
        anomalies: Array.isArray(r.anomalies) ? r.anomalies : [],
        has_anomaly: !!r.has_anomaly
      };
    });
  }

  return out;
}


function haversineMeters(lat1, lon1, lat2, lon2){
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2)**2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function fetchActiveStores(){
  const { data, error } = await supabaseClient
    .from('store_locations')
    .select('id, name, lat, lng, radius_m, active, paid_break_cap_min')
    .eq('active', true)
    .order('created_at', { ascending: true });
  if (error) { console.error('fetchActiveStores', error); return; }
  activeStores = data || [];
  storeById = new Map(activeStores.map(s => [s.id, s]));
}

function directionsUrlForStore(store){
  if (!store) return '';
  const lat = Number(store.lat);
  const lng = Number(store.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(lat + ',' + lng)}`;
}

function fmtStoreLabel(store){
  if (!store) return '—';
  return store.name || 'Store';
}

async function fetchTodayScheduleAndExceptions(){
  if (!currentEmployee?.id) return;
  const now = new Date();
  const todayISO = toISODate(now);

  // Schedule (today)
  try{
    const { data, error } = await supabaseClient.rpc('get_employee_schedule', {
      _employee_id: currentEmployee.id,
      _start: todayISO,
      _end: todayISO
    });
    if (error) throw error;
    todayScheduleRow = (data && data.length) ? data[0] : null;
  }catch(e){
    console.warn('fetch today schedule failed', e);
    todayScheduleRow = null;
  }

  // Day exception (today)
  try{
    const { data, error } = await supabaseClient
      .from('timeclock_day_exceptions')
      .select('allow_clock_in_any_store, clock_in_store_id, allow_clock_out_any_store, clock_out_store_id, note')
      .eq('employee_id', currentEmployee.id)
      .eq('work_date', todayISO)
      .maybeSingle();
    if (error) throw error;
    todayExceptionRow = data || null;
  }catch(e){
    // If table isn't readable due to RLS, we still work (server enforces).
    todayExceptionRow = null;
  }
}

function pickNearestStoreWithinRadius(lat, lng){
  if (!activeStores.length) return null;
  let best = null;
  let bestD = Infinity;
  for (const s of activeStores){
    const d = haversineMeters(lat, lng, Number(s.lat), Number(s.lng));
    if (d < bestD){ bestD = d; best = s; }
  }
  if (!best) return null;
  const r = Number(best.radius_m ?? 0);
  if (Number.isFinite(r) && r > 0 && bestD <= r) return { store: best, distance_m: bestD };
  return { store: best, distance_m: bestD };
}

async function getOpenShiftRow(){
  const { data, error } = await supabaseClient
    .from('time_entries')
    .select('id, store_id')
    .eq('employee_id', currentEmployee.id)
    .is('clock_out', null)
    .order('clock_in', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return data || null;
}

/**
 * Decide what store_id to pass to Supabase for this action.
 * The database remains the source of truth (it can still reject / override).
 */
async function resolveStoreForAction(kind, geo){
  // kind: 'in' | 'out'
  const exc = todayExceptionRow || null;

  // If we're clocking OUT, prefer the open shift store unless an out-exception exists.
  if (kind === 'out'){
    if (exc?.allow_clock_out_any_store){
      const picked = pickNearestStoreWithinRadius(geo.lat, geo.lng);
      return {
        store_id: picked?.store?.id || null,
        store: picked?.store || null,
        hint: 'Clock-out exception: any store allowed',
        distance_m: picked?.distance_m ?? null
      };
    }
    if (exc?.clock_out_store_id){
      const s = storeById.get(exc.clock_out_store_id) || null;
      return { store_id: exc.clock_out_store_id, store: s, hint: 'Clock-out exception: specific store', distance_m: null };
    }
    const open = await getOpenShiftRow();
    const sid = open?.store_id || todayScheduleRow?.store_id || null;
    const s = sid ? (storeById.get(sid) || null) : null;
    return { store_id: sid, store: s, hint: sid ? 'Clock-out at your shift store' : 'Clock-out store unknown', distance_m: null };
  }

  // Clocking IN
  if (exc?.allow_clock_in_any_store){
    const picked = pickNearestStoreWithinRadius(geo.lat, geo.lng);
    return {
      store_id: picked?.store?.id || null,
      store: picked?.store || null,
      hint: 'Clock-in exception: any store allowed',
      distance_m: picked?.distance_m ?? null
    };
  }
  if (exc?.clock_in_store_id){
    const s = storeById.get(exc.clock_in_store_id) || null;
    return { store_id: exc.clock_in_store_id, store: s, hint: 'Clock-in exception: specific store', distance_m: null };
  }

  // Default: must be assigned by schedule
  const sid = todayScheduleRow?.store_id || null;
  const s = sid ? (storeById.get(sid) || null) : null;
  return { store_id: sid, store: s, hint: sid ? 'Assigned store (schedule)' : 'No store assigned today', distance_m: null };
}

function renderStoreContextLine(store, hint){
  const textEl = qs('storeContextText');
  const hintEl = qs('storeContextHint');
  const linkEl = qs('storeDirectionsLink');

  if (textEl) textEl.textContent = fmtStoreLabel(store);
  if (hintEl) hintEl.textContent = hint || '';

  const url = directionsUrlForStore(store);
  if (linkEl){
    if (url){
      linkEl.href = url;
      linkEl.classList.remove('hidden');
    } else {
      linkEl.removeAttribute('href');
      linkEl.classList.add('hidden');
    }
  }
}


async function fetchBreakCap(){
  try {
    const { data, error } = await supabaseClient.rpc('org_paid_break_minutes_per_day');
    if (!error && typeof data === 'number') breakCapMin = data;
  } catch {}
}

function updateBreakHint(){
  const el = qs('breakBudgetHint');
  if (!el) return;
  const usedMin = Math.floor((breakUsedMsToday + breakActiveMs) / 60000);
  const remaining = Math.max(0, (breakCapMin || 30) - usedMin);
  el.textContent = `Paid break remaining today: ${remaining}m`;
}
function fmtTime(iso){ if(!iso) return '—'; const d=new Date(iso); return d.toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'}); }
function fmtDur(ms){ if(!Number.isFinite(ms)||ms<0) return '—'; const m=Math.floor(ms/60000), h=Math.floor(m/60), r=m%60; return `${h}h ${String(r).padStart(2,'0')}m`; }

async function renderBreaksTable(breaks, openEntryId){
  const tbody = qs('breaksBody');
  if (!tbody) return;

  tbody.innerHTML = '';
  if (!breaks.length){
    tbody.innerHTML = `<tr><td colspan="6" class="muted">No breaks yet.</td></tr>`;
    return;
  }

  for (const b of breaks){
    const tr = document.createElement('tr');
    const isOpen = !b.ended_at;
    const durMs = isOpen ? (Date.now() - new Date(b.started_at).getTime())
                         : (new Date(b.ended_at) - new Date(b.started_at));
    tr.dataset.breakId = b.id || '';
    tr.dataset.startedAt = b.started_at;
    tr.dataset.endedAt = b.ended_at || '';
    tr.className = isOpen ? 'row-open-break' : '';

    tr.innerHTML = `
      <td>${fmtTime(b.started_at)}</td>
      <td class="b-end">${isOpen ? 'OPEN' : fmtTime(b.ended_at)}</td>
      <td class="b-dur">${fmtDur(durMs)}</td>
      <td class="b-photo-start"></td>
      <td class="b-photo-end"></td>
      <td>${isOpen ? 'Open' : 'Closed'}</td>
    `;
    tbody.appendChild(tr);

    // Insert signed links (we store PATH, sign on demand)
    const psCell = tr.querySelector('.b-photo-start');
    const peCell = tr.querySelector('.b-photo-end');
    if (psCell) psCell.appendChild(await renderPhotoCell(b.photo_start_path));
    if (peCell) peCell.appendChild(await renderPhotoCell(b.photo_end_path));
  }
}

function randId(n=8){ return Math.random().toString(36).slice(2, 2+n); }

function openCamFor(kind){
  camKind = kind; camEntryId = null; camBreakId = null; camBlob = null;
  qs('camTitle').textContent =
    kind === 'in'           ? 'Take Clock-In Photo' :
    kind === 'out'          ? 'Take Clock-Out Photo' :
    kind === 'break_start'  ? 'Take Break Start Photo' :
                              'Take Break End Photo';

  qs('camCanvas').classList.add('hidden');
  qs('camVideo').classList.remove('hidden');
  qs('camCaptureBtn').classList.remove('hidden');
  qs('camRetakeBtn').classList.add('hidden');
  qs('camUseBtn').classList.remove('hidden'); // we’ll intercept click
  qs('camModal').classList.remove('hidden');
}

async function awaitPhoto(kind){
  try{
    camStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'user' }, audio:false });
    qs('camVideo').srcObject = camStream;
  }catch(e){ throw new Error('Camera permission denied'); }

  openCamFor(kind);

  return new Promise((resolve, reject) => {
    const onUse = async () => {
      if (!camBlob) { alert('Capture a photo first'); return; }
      cleanup(); closeCamera(); resolve(camBlob);
    };
    const onCancel = () => { cleanup(); closeCamera(); reject(new Error('cancelled')); };

    function cleanup(){
      qs('camUseBtn')?.removeEventListener('click', onUse);
      qs('camCancelBtn')?.removeEventListener('click', onCancel);
    }

    qs('camUseBtn')?.addEventListener('click', onUse);
    qs('camCancelBtn')?.addEventListener('click', onCancel);
  });
}

async function uploadPhotoBlob(kind, blob){
  const ts = new Date();
  const yyyy = ts.getFullYear();
  const mm = String(ts.getMonth()+1).padStart(2,'0');
  const dd = String(ts.getDate()).padStart(2,'0');
  const hh = String(ts.getHours()).padStart(2,'0');
  const mi = String(ts.getMinutes()).padStart(2,'0');
  const ss = String(ts.getSeconds()).padStart(2,'0');
  const stamp = `${yyyy}${mm}${dd}_${hh}${mi}${ss}`;
  const base = kind.startsWith('break') ? 'breaks' : 'shifts';
  const path = `${currentEmployee.id}/${base}/${stamp}_${kind}_${randId()}.jpg`;

  const { error: upErr } = await supabaseClient.storage
    .from('timeclock-photos')
    .upload(path, blob, { contentType: 'image/jpeg', upsert: false });
  if (upErr) throw upErr;
  return path;
}

function qs(id){ return document.getElementById(id); }
function show(el, visible){ if (el) el.classList.toggle('hidden', !visible); }
function fmt(ts){ return ts ? new Date(ts).toLocaleString() : '—'; }
function fmtDuration(ms){
  if(ms == null) return '—';
  const h = Math.floor(ms/3600000);
  const m = Math.round((ms%3600000)/60000);
  return `${h}h ${m}m`;
}

async function openCamera(kind, entryId, breakId = null){
  camKind = kind;
  camEntryId = entryId;
  camBreakId = breakId;
  camBlob = null;

  qs('camTitle').textContent =
    kind === 'in'           ? 'Take Clock-In Photo' :
    kind === 'out'          ? 'Take Clock-Out Photo' :
    kind === 'break_start'  ? 'Take Break Start Photo' :
                              'Take Break End Photo';

  qs('camCanvas').classList.add('hidden');
  qs('camVideo').classList.remove('hidden');
  qs('camCaptureBtn').classList.remove('hidden');
  qs('camRetakeBtn').classList.add('hidden');
  qs('camUseBtn').classList.add('hidden');

  try{
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    qs('camVideo').srcObject = camStream;
    qs('camModal').classList.remove('hidden');
  }catch(e){
    alert('Camera permission denied. You can add the photo later from Admin.');
  }
}


function closeCamera(){
  if (camStream){
    camStream.getTracks().forEach(t => t.stop());
    camStream = null;
  }
  qs('camModal').classList.add('hidden');
}

function captureFrame(){
  const video = qs('camVideo');
  const canvas = qs('camCanvas');
  const w = video.videoWidth, h = video.videoHeight || Math.floor(w * 4/3);
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, w, h);
  canvas.toBlob(b => { camBlob = b; }, 'image/jpeg', 0.85);

  qs('camVideo').classList.add('hidden');
  qs('camCanvas').classList.remove('hidden');
  qs('camCaptureBtn').classList.add('hidden');
  qs('camRetakeBtn').classList.remove('hidden');
  qs('camUseBtn').classList.remove('hidden');
}

function retakeFrame(){
  camBlob = null;
  qs('camCanvas').classList.add('hidden');
  qs('camVideo').classList.remove('hidden');
  qs('camCaptureBtn').classList.remove('hidden');
  qs('camRetakeBtn').classList.add('hidden');
  qs('camUseBtn').classList.add('hidden');
}

async function uploadAndAttach(){
  if (!camBlob) { closeCamera(); return; }

  // Build a durable storage path (we store *path*, not signed URL)
  let path;
  if (camKind === 'in' || camKind === 'out') {
    if (!camEntryId) { closeCamera(); return; }
    path = `${currentEmployee.id}/${camEntryId}_${camKind}.jpg`;
  } else {
    // break photos require the break id
    if (!camEntryId || !camBreakId) { closeCamera(); return; }
    const phase = camKind === 'break_start' ? 'start' : 'end';
    path = `${currentEmployee.id}/${camEntryId}_break_${camBreakId}_${phase}.jpg`;
  }

  // Upload the image
  const { error: upErr } = await supabaseClient.storage
    .from('timeclock-photos')
    .upload(path, camBlob, { contentType: 'image/jpeg', upsert: false });
  if (upErr){ alert('Upload failed: ' + upErr.message); closeCamera(); return; }

  // Attach the path to the correct row
  let attErr = null;
  if (camKind === 'in' || camKind === 'out') {
    const { error } = await supabaseClient.rpc('attach_punch_photo', {
      _entry_id: camEntryId,
      _kind: camKind,          // 'in' | 'out'
      _photo_path: path
    });
    attErr = error || null;
  } else {
    const phase = camKind === 'break_start' ? 'start' : 'end';
    const { error } = await supabaseClient.rpc('attach_break_photo', {
      _break_id: camBreakId,
      _phase: phase,           // 'start' | 'end'
      _photo_path: path
    });
    attErr = error || null;
  }

  if (attErr) alert('Attach failed: ' + attErr.message);

  closeCamera();
  await loadToday();
}

function redirectToLogin(){
  const next = encodeURIComponent('timeclock.html');
  window.location.href = `index.html?next=${next}`;
}

async function signOut(){
  await supabaseClient.auth.signOut();
  redirectToLogin();
}

async function enforceContractorAgreementGate(supabase, pageName) {
  const { data, error } = await supabase.functions.invoke("contractor-agreement", {
    body: { action: "status" },
  });

  if (error || !data) {
    const next = encodeURIComponent(pageName || "timeclock.html");
    window.location.href = `set-password.html?mode=agreement&next=${next}`;
    throw new Error("Agreement required");
  }

  if (!data.required) return;

  if (!data.accepted) {
    const next = encodeURIComponent(pageName || "timeclock.html");
    window.location.href = `set-password.html?mode=agreement&next=${next}`;
    throw new Error("Agreement required");
  }
}


async function hydrate(){
  if (isHydrating) return;
  isHydrating = true;
  try {
    const { data: emp, error } = await supabaseClient
      .from('employees').select('*')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (error){ alert(error.message); return; }
    if (!emp){ alert('No employee profile linked. Ask admin.'); return; }

    currentEmployee = emp;
    qs('displayName').textContent = emp.display_name;
    await enforceContractorAgreementGate(supabaseClient, "timeclock.html");
    show(qs('clockSection'), true);

    // Phase 4: preload stores + today's schedule/exception so we can show store context
    await fetchActiveStores();
    await fetchTodayScheduleAndExceptions();
    // Default display: assigned store from schedule (if any)
    const assigned = todayScheduleRow?.store_id ? (storeById.get(todayScheduleRow.store_id) || null) : null;
    renderStoreContextLine(assigned, assigned ? 'Assigned store (schedule)' : 'No store assigned today');

    await refreshShiftStatus();
    await refreshBreakStatus();
    await loadToday();
    document.getElementById('wsWeekDate').value = toISODate(wsWeekStart);
    await loadMySchedule();

    tryGeo();
  } finally {
    isHydrating = false;
  }
}

async function refreshShiftStatus(){
  const { data, error } = await supabaseClient
    .from('time_entries')
    .select('id, clock_in, clock_out, store_id')
    .eq('employee_id', currentEmployee.id)
    .is('clock_out', null)
    .order('clock_in', { ascending: false })
    .limit(1);
  if (error){ console.error(error); return; }

  const open = data?.[0];
  const pill = qs('shiftStatus');
  const btn = qs('clockBtn');

  if (open){
    pill.textContent = `Clocked in since ${fmt(open.clock_in)}`;
    pill.style.borderColor = 'var(--ok)';
    btn.textContent = 'Clock Out';

    // Phase 4: show store for active shift
    const s = open.store_id ? (storeById.get(open.store_id) || null) : (todayScheduleRow?.store_id ? (storeById.get(todayScheduleRow.store_id) || null) : null);
    renderStoreContextLine(s, s ? 'Active shift store' : 'Active shift (store unknown)');
  } else {
    pill.textContent = 'Not clocked in';
    pill.style.borderColor = 'var(--border)';
    btn.textContent = 'Clock In';

    // Phase 4: fall back to schedule assignment for today
    const assigned = todayScheduleRow?.store_id ? (storeById.get(todayScheduleRow.store_id) || null) : null;
    renderStoreContextLine(assigned, assigned ? 'Assigned store (schedule)' : 'No store assigned today');
  }
}

async function refreshBreakStatus(){
  const breakBtn = qs('breakBtn');
  if (!breakBtn) return; // no break button in HTML yet
  // only enable if on shift
  const { data: openShift } = await supabaseClient
    .from('time_entries')
    .select('id')
    .eq('employee_id', currentEmployee.id)
    .is('clock_out', null)
    .maybeSingle();

  if (!openShift){
    breakBtn.disabled = true;
    breakBtn.textContent = 'Start Break';
    return;
  }
  breakBtn.disabled = false;

  const { data: openBreak } = await supabaseClient
    .from('time_breaks')
    .select('id')
    .eq('time_entry_id', openShift.id)
    .is('ended_at', null)
    .maybeSingle();

  breakBtn.textContent = openBreak ? 'End Break' : 'Start Break';
}

// Warn the worker if this punch was outside their scheduled window
async function maybeWarnSchedule(entryId){
  try{
    const { data, error } = await supabaseClient
      .from('v_shift_anomalies')
      .select('time_entry_id, anomalies')
      .eq('time_entry_id', entryId)
      .maybeSingle();

    if (error || !data) return;
    const codes = Array.isArray(data.anomalies) ? data.anomalies : [];
    if (!codes.length) return;

    const msg = codes.map(c => c.replace(/_/g,' ').toLowerCase())
                     .map(s => s[0].toUpperCase()+s.slice(1))
                     .join(', ');
    alert(`Heads up: this punch is outside the scheduled window (${msg}). It was recorded and flagged for admin review.`);
  }catch(_e){}
}

async function onClockAction(){
  if (isPunching) return;
  isPunching = true;

  const btn = qs('clockBtn');
  btn.disabled = true;

  try {
    const geo = await getGeo();
    if (!geo.ok){ alert(geo.msg || 'Unable to get location.'); return; }

    // Are we clocking in or out?
    const { data: openRows, error: openErr } = await supabaseClient
      .from('time_entries')
      .select('id')
      .eq('employee_id', currentEmployee.id)
      .is('clock_out', null)
      .limit(1);

    if (openErr) { alert(openErr.message); return; }

    const kind = (openRows && openRows.length) ? 'out' : 'in';

    // Refresh today's schedule/exception (in case admin changed it)
    await fetchTodayScheduleAndExceptions();

    // Decide store_id (ONLY used for clock-in; clock-out must NOT allow choosing)
    const storeRes = await resolveStoreForAction(kind, geo);

    // Clock-in requires an assigned store (or exception that yields one)
    if (kind === 'in' && !storeRes.store_id){
      renderStoreContextLine(null, 'No store assigned today — contact a manager');
      alert('You are not assigned to any store today. Ask a manager to assign you (or add a day exception).');
      return;
    }

    // UI feedback
    const distTxt = (storeRes?.distance_m != null)
      ? ` (distance ~${Math.round(storeRes.distance_m)}m)`
      : '';
    renderStoreContextLine(
      storeRes.store || (storeRes.store_id ? (storeById.get(storeRes.store_id) || null) : null),
      (storeRes.hint || '') + distTxt
    );

    // Require photo first
    const blob = await awaitPhoto(kind);
    const photoPath = await uploadPhotoBlob(kind, blob);

    // RPC
    let entry, err;

    if (kind === 'in') {
      // ✅ Clock IN: pass store_id (allowed)
      ({ data: entry, error: err } = await supabaseClient.rpc('clock_in_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy,
        _photo_path: photoPath,
        _store_id: storeRes.store_id
      }));
    } else {
      // ✅ Clock OUT: DO NOT pass _store_id (DB forbids non-admin choosing store)
      ({ data: entry, error: err } = await supabaseClient.rpc('clock_out_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy,
        _photo_path: photoPath
      }));
    }

    if (err){ alert(err.message || 'Clock action blocked.'); return; }

    if (entry?.id) await maybeWarnSchedule(entry.id);

    await refreshShiftStatus();
    await refreshBreakStatus();
    await loadToday();

  } catch (e){
    if (e?.message !== 'cancelled') alert(e?.message || 'Clock action failed.');
  } finally {
    isPunching = false;
    btn.disabled = false;
  }
}



// ===== Worker schedule (weekly) =====
const pad2 = (n)=>String(n).padStart(2,'0');
const toISODate = (d)=>`${d.getFullYear()}-${pad2(d.getMonth()+1)}-${pad2(d.getDate())}`;
function startOfWeekSun(d){ const x=new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate()-x.getDay()); return x; }
function addDays(d,n){ const x=new Date(d); x.setDate(x.getDate()+n); return x; }
function weekLabel(a){
  const b = addDays(a,6);
  const aStr = `${a.getMonth()+1}/${a.getDate()}`;
  const bStr = `${b.getMonth()+1}/${b.getDate()}/${b.getFullYear()}`;
  return `${aStr} — ${bStr}`;
}
let wsWeekStart = startOfWeekSun(new Date());

async function fetchMyScheduleWeek(){
  if (!currentEmployee?.id) return new Map();
  const start = toISODate(wsWeekStart);
  const end   = toISODate(addDays(wsWeekStart, 6));
  const { data, error } = await supabaseClient.rpc('get_employee_schedule', {
    _employee_id: currentEmployee.id,
    _start: start,
    _end: end
  });
  if (error) { console.error(error); return new Map(); }
  const byDate = new Map();
  for (const r of (data||[])) byDate.set(r.work_date, r);
  return byDate;
}

function fmtHM(ts){ if(!ts) return '—'; const d=new Date(ts); return d.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}); }

function escHtml(s){
  return String(s ?? '').replace(/[&<>"']/g, ch => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[ch]));
}

function renderMySchedule(byDate, weekEntries = [], anomalyMap = {}){

  const grid = document.getElementById('wsGrid');
  const label = document.getElementById('wsWeekLabel');
  if (label) label.textContent = weekLabel(wsWeekStart);
  if (!grid) return;

  grid.innerHTML = '';
  for (let i=0;i<7;i++){
    const day = addDays(wsWeekStart, i);
    const iso = toISODate(day);
    const dayEntryIds = (weekEntries || [])
  .filter(te => isoDateLocalFromTs(te.clock_in) === iso)
  .map(te => te.id);

const dayAnoms = [];
for (const id of dayEntryIds){
  const a = anomalyMap?.[id];
  if (a?.anomalies?.length) dayAnoms.push(...a.anomalies);
}

// de-dupe
const uniq = [...new Set(dayAnoms)];
const flagsHtml = uniq.length ? `<div class="cal-flags" style="margin-top:6px;">${renderAnomalyBadges(uniq)}</div>` : "";

    const r = byDate.get(iso) || null;

    const cell = document.createElement('div');
    cell.className = 'cal-day';
    const storeObj = r?.store_id ? (storeById.get(r.store_id) || null) : null;
    const storeName = storeObj?.name ? escHtml(storeObj.name) : (r?.store_id ? 'Store' : '');
    const dirUrl = directionsUrlForStore(storeObj);
    const storeLine = r ? (r.store_id ? `<div class="muted" style="font-size:12px;margin-top:4px;">
        Store: ${storeName}${dirUrl ? ` · <a class="pill pill-dir" href="${dirUrl}" target="_blank" rel="noopener">Directions</a>` : ''}
      </div>` : '') : '';

    const dow = day.toLocaleDateString([], { weekday: 'short' });

    cell.innerHTML = `
      <div class="cal-day-header">
        <span class="cal-dow">${dow}</span>
        <span class="cal-date">${day.getMonth()+1}/${day.getDate()}</span>
      </div>
      <div class="cal-slots">
        ${r ? `<div class="cal-slot">
                 <span class="time">${fmtHM(r.start_ts)}–${fmtHM(r.end_ts)}</span>
                 <span class="note">${r.source === 'override' ? '(override)' : ''}</span>
                 ${storeLine}
                 ${flagsHtml}
               </div>` : `<div class="muted" style="font-size:12px;">—</div>`}
      </div>
    `;
    grid.appendChild(cell);
  }
}

async function loadMySchedule(){
  try{
    const schedMap = await fetchMyScheduleWeek();
    const { entries, anomalyMap } = await fetchMyTimeEntriesWeek();
    renderMySchedule(schedMap, entries, anomalyMap);
    document.getElementById('schedSection')?.classList.remove('hidden');
  }catch(err){
    console.error('loadMySchedule failed', err);
  }
}



async function onBreakAction(){
  if (isPunching) return;
  if (!currentEmployee?.id) { alert('No employee loaded. Please sign in again.'); return; }

  try {
    isPunching = true;
    const breakBtn = qs('breakBtn');
    if (breakBtn) { breakBtn.disabled = true; breakBtn.textContent = 'Please wait…'; }

    // 1) Get open shift
    const { data: openShiftId, error: openErr } = await supabaseClient.rpc('get_open_shift_id', { _employee_id: currentEmployee.id });
    if (openErr) throw openErr;
    if (!openShiftId) { alert('No open shift to take a break. Clock in first.'); return; }

    // Phase 4: determine store_id for break validation (prefer the shift's store)
    await fetchActiveStores();
    await fetchTodayScheduleAndExceptions();
    let shiftStoreId = null;
    try{
      const { data: openShiftRow } = await supabaseClient
        .from('time_entries')
        .select('id, store_id')
        .eq('id', openShiftId)
        .maybeSingle();
      shiftStoreId = openShiftRow?.store_id || null;
    }catch(_){ /* ignore */ }

    // 2) Geo
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, maximumAge: 0, timeout: 15000
      });
    });
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;

    // If we still don't know the shift store, fall back to today's assigned store, then nearest store.
    if (!shiftStoreId) shiftStoreId = todayScheduleRow?.store_id || null;
    if (!shiftStoreId) {
      const nearest = pickNearestStoreWithinRadius(lat, lng);
if (nearest?.store && (nearest.distance_m <= (nearest.store.radius_m ?? 0))) {
  shiftStoreId = nearest.store.id;
}
    }

    const shiftStoreObj = shiftStoreId ? (storeById.get(shiftStoreId) || null) : null;
    if (shiftStoreObj) renderStoreContextLine(shiftStoreObj, 'Breaks use active shift store');

    // 3) Determine phase and require photo BEFORE RPC
    const { data: openBreakList } = await supabaseClient
      .from('time_breaks').select('id')
      .eq('time_entry_id', openShiftId).is('ended_at', null).limit(1);
    const hasOpenBreak = (openBreakList && openBreakList.length > 0);
    const phaseKind = hasOpenBreak ? 'break_end' : 'break_start';

    if (!hasOpenBreak) {
      const usedMin = Math.floor((breakUsedMsToday || 0) / 60000);
      if (usedMin >= (breakCapMin || 30)) {
        alert(`Heads up: you’ve already used ${usedMin}m of paid break time today.\nAdditional break time will be unpaid.`);
      }
    }

    const blob = await awaitPhoto(phaseKind);
    const photoPath = await uploadPhotoBlob(phaseKind, blob);

    // 4) Call RPC with required _photo_path
    let brkRow, rpcErr;
    if (!hasOpenBreak) {
      ({ data: brkRow, error: rpcErr } = await supabaseClient.rpc('start_break_now_geo', {
        _employee_id: currentEmployee.id, _lat: lat, _lng: lng, _accuracy_m: accuracy,
        _photo_path: photoPath
      }));
    } else {
      ({ data: brkRow, error: rpcErr } = await supabaseClient.rpc('end_break_now_geo', {
        _employee_id: currentEmployee.id, _lat: lat, _lng: lng, _accuracy_m: accuracy,
        _photo_path: photoPath
      }));
    }
    if (rpcErr){ alert(rpcErr.message); return; }

    await loadToday();
  } catch (err) {
    if (err?.message !== 'cancelled') {
      console.error(err);
      alert(err?.message || 'Break action failed.');
    }
  } finally {
    isPunching = false;
    const breakBtn = qs('breakBtn'); if (breakBtn) breakBtn.disabled = false;
  }
}


/* =========================
   Today (mobile) — render shifts as luxe cards
   Tables look clunky on iPhone; cards read better and feel premium.
   Desktop can keep the table (CSS will toggle visibility).
========================= */

async function signedUrlOrNull(path, seconds = 180){
  if (!path) return null;
  try{
    const { data, error } = await supabaseClient
      .storage
      .from('timeclock-photos')
      .createSignedUrl(path, seconds);
    if (error) return null;
    return data?.signedUrl || null;
  }catch(_e){
    return null;
  }
}

function el(tag, cls){
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  return n;
}

async function renderTodayCards(rows, anomalyMap){
  const wrap = qs('todayCards');
  if (!wrap) return;

  wrap.innerHTML = '';

  if (!rows || !rows.length){
    const empty = el('div', 'today-empty');
    empty.textContent = 'No shifts yet today.';
    wrap.appendChild(empty);
    return;
  }

  for (const r of rows){
    const endTs = r.clock_out ? new Date(r.clock_out) : new Date();
    const durMs = endTs - new Date(r.clock_in);

    const storeObj = r.store_id ? (storeById.get(r.store_id) || null) : null;
    const storeName = storeObj?.name ? escHtml(storeObj.name) : '—';
    const dirUrl = directionsUrlForStore(storeObj);

    const a = anomalyMap?.[r.id] || { anomalies: [], has_anomaly: false };
    const anomalies = Array.isArray(a.anomalies) ? a.anomalies : [];

    const flags = [];
    if (anomalies.length) flags.push(renderAnomalyBadges(anomalies));
    if (r.geo_ok_in === false || r.geo_ok_out === false) {
      flags.push(`<span class="badge bad" title="Geofence issue">Geo</span>`);
    }
    if (Array.isArray(r.schedule_codes) && r.schedule_codes.length) {
      flags.push(`<span class="badge warn" title="${r.schedule_codes.join(", ")}">Schedule</span>`);
    }
    const flagsHtml = flags.length ? flags.join(' ') : '<span class="muted">—</span>';

    const card = el('div', 'today-card');

    // Header
    const top = el('div', 'today-top');
    const store = el('div', 'today-store');
    store.innerHTML = storeObj
      ? `${storeName}${dirUrl ? ` <a class="pill pill-dir" href="${dirUrl}" target="_blank" rel="noopener">Directions</a>` : ''}`
      : '—';
    const durPill = el('div', 'today-dur');
    durPill.textContent = fmtDur(durMs);
    top.appendChild(store);
    top.appendChild(durPill);

    // Times
    const times = el('div', 'today-times');
    const inBlock = el('div', 'tblock');
    inBlock.innerHTML = `<div class="tlabel">In</div><div class="tvalue">${fmtTime(r.clock_in)}</div>`;
    const outBlock = el('div', 'tblock');
    outBlock.innerHTML = `<div class="tlabel">Out</div><div class="tvalue">${r.clock_out ? fmtTime(r.clock_out) : '—'}</div>`;
    const idBlock = el('div', 'tblock');
    idBlock.innerHTML = `<div class="tlabel">Entry</div><div class="tvalue mono">${String(r.id).slice(0,8)}</div>`;
    times.appendChild(inBlock);
    times.appendChild(outBlock);
    times.appendChild(idBlock);

    // Actions
    const actions = el('div', 'today-actions');
    const picIn = el('a', 'chiplink');
    picIn.textContent = 'Pic In';
    picIn.href = '#';
    picIn.setAttribute('aria-disabled', 'true');

    const picOut = el('a', 'chiplink');
    picOut.textContent = 'Pic Out';
    picOut.href = '#';
    picOut.setAttribute('aria-disabled', 'true');

    const flagsWrap = el('div', 'today-flags');
    flagsWrap.innerHTML = flagsHtml;

    actions.appendChild(picIn);
    actions.appendChild(picOut);
    actions.appendChild(flagsWrap);

    card.appendChild(top);
    card.appendChild(times);
    card.appendChild(actions);
    wrap.appendChild(card);

    // Signed URLs (async)
    const uIn = await signedUrlOrNull(r.photo_in_path, 180);
    if (uIn){
      picIn.href = uIn;
      picIn.target = '_blank';
      picIn.rel = 'noopener';
      picIn.removeAttribute('aria-disabled');
      picIn.classList.remove('disabled');
    } else {
      picIn.classList.add('disabled');
    }

    const uOut = await signedUrlOrNull(r.photo_out_path, 180);
    if (uOut){
      picOut.href = uOut;
      picOut.target = '_blank';
      picOut.rel = 'noopener';
      picOut.removeAttribute('aria-disabled');
      picOut.classList.remove('disabled');
    } else {
      picOut.classList.add('disabled');
    }
  }
}

async function renderBreaksCards(breaks){
  const wrap = qs('breaksCards');
  if (!wrap) return;

  wrap.innerHTML = '';

  if (!breaks || !breaks.length){
    const empty = document.createElement('div');
    empty.className = 'today-empty';
    empty.textContent = 'No breaks yet.';
    wrap.appendChild(empty);
    return;
  }

  for (const b of breaks){
    const isOpen = !b.ended_at;
    const durMs = isOpen
      ? (Date.now() - new Date(b.started_at).getTime())
      : (new Date(b.ended_at) - new Date(b.started_at));

    const card = document.createElement('div');
    card.className = `break-card ${isOpen ? 'break-open' : ''}`;
    if (isOpen) card.dataset.startedAt = b.started_at;

    const startUrl = await signedUrlOrNull(b.photo_start_path, 120);
    const endUrl   = await signedUrlOrNull(b.photo_end_path, 120);

    card.innerHTML = `
      <div class="break-top">
        <div class="break-title">Break</div>
        <div class="break-pill js-break-dur">${fmtDur(durMs)}</div>
      </div>

      <div class="break-grid">
        <div class="tblock">
          <div class="tlabel">Start</div>
          <div class="tvalue">${fmtTime(b.started_at)}</div>
        </div>
        <div class="tblock">
          <div class="tlabel">End</div>
          <div class="tvalue">${isOpen ? 'OPEN' : fmtTime(b.ended_at)}</div>
        </div>
      </div>

      <div class="break-actions">
        ${startUrl ? `<a class="pill" href="${startUrl}" target="_blank" rel="noopener">Start photo</a>` : `<span class="chiplink disabled">Start photo —</span>`}
        ${endUrl   ? `<a class="pill" href="${endUrl}" target="_blank" rel="noopener">End photo</a>`   : `<span class="chiplink disabled">End photo —</span>`}
        <span class="chip">${isOpen ? 'Open' : 'Closed'}</span>
      </div>
    `;
    wrap.appendChild(card);
  }
}


async function loadToday(){
  if (isLoadingToday) return;
  if (!currentEmployee?.id) return;

  isLoadingToday = true;
  const breakBtn = qs('breakBtn');
  const tbody = qs('todayBody');

  // clear any previous ticking
  if (breakTickTimer){ clearInterval(breakTickTimer); breakTickTimer = null; }
  breakActiveMs = 0;

  try {
    // Day window [00:00, 24:00)
    const now = new Date();
    const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    const dayEnd   = new Date(now.getFullYear(), now.getMonth(), now.getDate()+1, 0, 0, 0);

    // A) Today’s shifts (include photo paths)
    const { data: entries, error: eErr } = await supabaseClient
      .from('time_entries')
      .select('id, clock_in, clock_out, store_id, photo_in_path, photo_out_path, geo_ok_in, geo_ok_out, schedule_codes')
      .eq('employee_id', currentEmployee.id)
      .gte('clock_in', dayStart.toISOString())
      .lt('clock_in', dayEnd.toISOString())
      .order('clock_in', { ascending: true });
    if (eErr) throw eErr;
    const rows = entries || [];
    const ids = rows.map(r => r.id);
    const anomalyMap = await loadAnomaliesForEntryIds(ids);

    // B) Today’s breaks for those shifts (open and closed) + PHOTO PATHS
    todayBreaks = [];
    if (ids.length){
      const { data: breaks, error: bErr } = await supabaseClient
        .from('time_breaks')
        .select('id, time_entry_id, started_at, ended_at, photo_start_path, photo_end_path')
        .in('time_entry_id', ids)
        .order('started_at',{ascending:true});
      if (bErr) throw bErr;
      todayBreaks = breaks || [];
    }

    // Aggregate ended breaks + detect an active one
    breakUsedMsToday = 0;
    let openBreakRow = null;
    for (const b of todayBreaks){
      if (b.ended_at) {
        const ms = (new Date(b.ended_at) - new Date(b.started_at));
        if (Number.isFinite(ms) && ms > 0) breakUsedMsToday += ms;
      } else {
        openBreakRow = b; // at most one for the current open shift
      }
    }

    // C) Update “paid break remaining” hint (includes active)
    if (openBreakRow){
      breakActiveMs = Date.now() - new Date(openBreakRow.started_at).getTime();
    } else {
      breakActiveMs = 0;
    }
    updateBreakHint();

    // D) Toggle Break button label/state using server truth
    const { data: openShiftId } = await supabaseClient.rpc('get_open_shift_id', { _employee_id: currentEmployee.id });
    if (!openShiftId) {
      if (breakBtn) { breakBtn.disabled = true; breakBtn.textContent = 'Start Break'; }
    } else {
      const hasOpenBreak = !!openBreakRow && openBreakRow.time_entry_id === openShiftId;
      if (breakBtn) { breakBtn.disabled = false; breakBtn.textContent = hasOpenBreak ? 'End Break' : 'Start Break'; }
    }

    // E) Render today's shifts table
    if (tbody){
      tbody.innerHTML = '';
      if (!rows.length){
        tbody.innerHTML = `<tr><td colspan="7" class="muted">No shifts yet today.</td></tr>`;
      }
      for (const r of rows){
        const tr = document.createElement('tr');
        const endTs = r.clock_out ? new Date(r.clock_out) : new Date();
        const durMs = endTs - new Date(r.clock_in);
        const storeObj = r.store_id ? (storeById.get(r.store_id) || null) : null;
        const storeName = storeObj?.name ? escHtml(storeObj.name) : '—';
        const dirUrl = directionsUrlForStore(storeObj);
        const a = anomalyMap?.[r.id] || { anomalies: [], has_anomaly: false };
        const anomalies = Array.isArray(a.anomalies) ? a.anomalies : [];

        const flags = [];
        if (anomalies.length) flags.push(renderAnomalyBadges(anomalies));

        if (r.geo_ok_in === false || r.geo_ok_out === false) {
          flags.push(`<span class="badge bad" title="Geofence issue">Geo</span>`);
        }
        if (Array.isArray(r.schedule_codes) && r.schedule_codes.length) {
          flags.push(`<span class="badge warn" title="${r.schedule_codes.join(", ")}">Schedule</span>`);
        }

        const flagsCell = flags.length ? flags.join(" ") : `<span style="opacity:0.6;">—</span>`;

        tr.innerHTML = `
          <td class="store-cell">${storeObj ? `${storeName}${dirUrl ? ` <a class="pill pill-dir" href="${dirUrl}" target="_blank" rel="noopener">Directions</a>` : ''}` : '—'}</td>
          <td>${new Date(r.clock_in).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
          <td>${r.clock_out ? new Date(r.clock_out).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—'}</td>
          <td>${fmtDur(durMs)}</td>
          <td class="photo-in"></td>
          <td class="photo-out"></td>
          <td class="flags-cell">${flagsCell}</td>
        `;

        
        // Signed photo links (we store PATH, sign on demand)
        const inCell = tr.querySelector('.photo-in');
        const outCell = tr.querySelector('.photo-out');
        if (inCell && r.photo_in_path){
          try {
            const { data:s } = await supabaseClient.storage.from('timeclock-photos').createSignedUrl(r.photo_in_path, 180);
            if (s?.signedUrl){ inCell.innerHTML = `<a href="${s.signedUrl}" target="_blank" rel="noopener">View</a>`; }
          } catch(_e){}
        }
        if (outCell && r.photo_out_path){
          try {
            const { data:s2 } = await supabaseClient.storage.from('timeclock-photos').createSignedUrl(r.photo_out_path, 180);
            if (s2?.signedUrl){ outCell.innerHTML = `<a href="${s2.signedUrl}" target="_blank" rel="noopener">View</a>`; }
          } catch(_e){}
        }
        tbody.appendChild(tr);
      }
    }
    
    await renderTodayCards(rows, anomalyMap);
    await renderBreaksCards(todayBreaks);


    // F) Render Breaks table (async because it signs URLs for paths)
    await renderBreaksTable(todayBreaks, openShiftId || null);

    // G) If a break is open, tick its duration + the remaining hint every second
    if (openBreakRow){
      breakTickTimer = setInterval(() => {
        breakActiveMs = Date.now() - new Date(openBreakRow.started_at).getTime();
        // update the open row duration text
        const table = qs('breaksBody');
        const tr = table?.querySelector('tr.row-open-break');
        if (tr){
          const startedAt = tr.dataset.startedAt;
          const ms = Date.now() - new Date(startedAt).getTime();
          const durEl = tr.querySelector('.b-dur');
          if (durEl) durEl.textContent = fmtDur(ms);
        }

        // Update open break CARD duration too (mobile)
const cards = qs('breaksCards');
const openCard = cards?.querySelector('.break-card.break-open');
if (openCard){
  const startedAt = openCard.dataset.startedAt;
  if (startedAt){
    const ms = Date.now() - new Date(startedAt).getTime();
    const durEl = openCard.querySelector('.js-break-dur');
    if (durEl) durEl.textContent = fmtDur(ms);
  }
}

        // update the hint
        updateBreakHint();
      }, 1000);
    }

  } catch (err) {
    console.error(err);
    if (breakBtn) { breakBtn.disabled = false; breakBtn.textContent = 'Start Break'; }
  } finally {
    isLoadingToday = false;
  }
}



async function renderPhotoCell(path){
  const container = document.createElement('div');
  if (!path){ container.textContent = '—'; return container; }
  try {
    const { data, error } = await supabaseClient.storage
      .from('timeclock-photos')
      .createSignedUrl(path, 60);
    if (error || !data?.signedUrl){ container.textContent = 'Photo'; return container; }
    const a = document.createElement('a');
    a.href = data.signedUrl; a.target = '_blank'; a.rel = 'noopener';
    a.textContent = 'View';
    container.appendChild(a);
  } catch {
    container.textContent = 'Photo';
  }
  return container;
}

function tryGeo(){
  if (!('geolocation' in navigator)) return;
  navigator.geolocation.getCurrentPosition(pos => {
    const { latitude:lat, longitude:lng, accuracy } = pos.coords;
    qs('geoText').textContent = `${lat.toFixed(5)}, ${lng.toFixed(5)} (±${Math.round(accuracy)}m)`;
  }, () => {
    qs('geoText').textContent = 'Location permission denied';
  }, { enableHighAccuracy:true, maximumAge:0, timeout:5000 });
}

function getGeo(){
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)){
      return resolve({ ok:false, msg:'Geolocation not supported in this browser.' });
    }
    navigator.geolocation.getCurrentPosition(pos => {
      resolve({ ok:true, lat:pos.coords.latitude, lng:pos.coords.longitude, accuracy:pos.coords.accuracy });
    }, err => {
      resolve({ ok:false, msg: err?.message || 'Unable to get location.' });
    }, { enableHighAccuracy:true, maximumAge:0, timeout:10000 });
  });
}

// ---- Bootstrap ----
document.addEventListener('DOMContentLoaded', async () => {
  supabaseClient = window.supabase;

  // Auth state (debounced + ensures break cap fetched before hydrate)
  let hydrateTimer = null;
  const scheduleHydrate = async () => {
    clearTimeout(hydrateTimer);
    hydrateTimer = setTimeout(async () => {
      try { if (typeof fetchBreakCap === 'function') await fetchBreakCap(); } catch {}
      await hydrate();
    }, 0);
  };

  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    if (!currentUser){ redirectToLogin(); return; }
    scheduleHydrate();
  });

  // UI listeners
  qs('signOutBtn')?.addEventListener('click', signOut);
  qs('clockBtn')?.addEventListener('click', onClockAction);
  qs('breakBtn')?.addEventListener('click', onBreakAction);
  qs('camCaptureBtn')?.addEventListener('click', captureFrame);
  qs('camRetakeBtn')?.addEventListener('click', retakeFrame);
  //qs('camUseBtn')?.addEventListener('click', uploadAndAttach);
  qs('camCancelBtn')?.addEventListener('click', closeCamera);

  setInterval(() => { qs('nowTime').textContent = new Date().toLocaleString(); }, 1000);
  qs('nowTime').textContent = new Date().toLocaleString();


  // Schedule controls
document.getElementById('wsPrev')?.addEventListener('click', async ()=>{
  wsWeekStart = addDays(wsWeekStart, -7);
  document.getElementById('wsWeekDate').value = toISODate(wsWeekStart);
  await loadMySchedule();
});
document.getElementById('wsNext')?.addEventListener('click', async ()=>{
  wsWeekStart = addDays(wsWeekStart, 7);
  document.getElementById('wsWeekDate').value = toISODate(wsWeekStart);
  await loadMySchedule();
});
document.getElementById('wsWeekDate')?.addEventListener('change', async ()=>{
  const s = document.getElementById('wsWeekDate').value;
  if (!s) return;
  const [y,m,d] = s.split('-').map(Number);
  wsWeekStart = startOfWeekSun(new Date(y,m-1,d));
  await loadMySchedule();
});

// Swipe week navigation (iPhone-friendly, scroll-safe)
(() => {
  const grid = document.getElementById('wsGrid');
  if (!grid) return;

  let x0 = null, y0 = null;
  let startScrollLeft = 0;
  let moved = false;

  grid.addEventListener('touchstart', (e) => {
    const t = e.touches?.[0];
    if (!t) return;
    x0 = t.clientX;
    y0 = t.clientY;
    startScrollLeft = grid.scrollLeft;
    moved = false;
  }, { passive: true });

  grid.addEventListener('touchmove', () => {
    moved = true;
  }, { passive: true });

  grid.addEventListener('touchend', async (e) => {
    if (x0 == null || y0 == null) return;

    const t = e.changedTouches?.[0];
    if (!t) return;

    const dx = t.clientX - x0;
    const dy = t.clientY - y0;

    // reset
    x0 = null; y0 = null;

    // If the carousel actually scrolled, don't treat it as a week-swipe
    const scrolled = Math.abs(grid.scrollLeft - startScrollLeft) > 8;
    if (scrolled) return;

    // ignore mostly-vertical gestures
    if (Math.abs(dy) > Math.abs(dx)) return;

    // threshold
    if (Math.abs(dx) < 70) return;

    wsWeekStart = addDays(wsWeekStart, dx < 0 ? 7 : -7);
    document.getElementById('wsWeekDate').value = toISODate(wsWeekStart);
    await loadMySchedule();
  }, { passive: true });
})();


  // Initial session check (also fetch cap before first hydrate)
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session?.user || null;
  if (!currentUser) return redirectToLogin();

  try { if (typeof fetchBreakCap === 'function') await fetchBreakCap(); } catch {}
  await hydrate(); // don't wait for onAuthStateChange; hydrate now with cap loaded
});
