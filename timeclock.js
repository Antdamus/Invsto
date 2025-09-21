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
    show(qs('clockSection'), true);

    await refreshShiftStatus();
    await refreshBreakStatus();
    await loadToday();
    tryGeo();
  } finally {
    isHydrating = false;
  }
}

async function refreshShiftStatus(){
  const { data, error } = await supabaseClient
    .from('time_entries')
    .select('id, clock_in, clock_out')
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
  } else {
    pill.textContent = 'Not clocked in';
    pill.style.borderColor = 'var(--border)';
    btn.textContent = 'Clock In';
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

async function onClockAction(){
  if (isPunching) return;
  isPunching = true;
  const btn = qs('clockBtn');
  btn.disabled = true;

  try {
    // 1) Geo first
    const geo = await getGeo();
    if (!geo.ok){ alert(geo.msg || 'Unable to get location.'); return; }

    // 2) Determine kind (in/out) based on open shift
    const { data: openRows } = await supabaseClient
      .from('time_entries').select('id')
      .eq('employee_id', currentEmployee.id)
      .is('clock_out', null).limit(1);
    const kind = (openRows && openRows.length) ? 'out' : 'in';

    // 3) Require photo BEFORE calling RPC
    const blob = await awaitPhoto(kind);                // user can retake; cancel aborts
    const photoPath = await uploadPhotoBlob(kind, blob); // store PATH (not URL)

    // 4) Call RPC with required _photo_path
    let entry, err;
    if (kind === 'in') {
      ({ data: entry, error: err } = await supabaseClient.rpc('clock_in_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy,
        _photo_path: photoPath, _store_id: null
      }));
    } else {
      ({ data: entry, error: err } = await supabaseClient.rpc('clock_out_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy,
        _photo_path: photoPath, _store_id: null
      }));
    }
    if (err){ alert(err.message); return; }

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

    // 2) Geo
    const pos = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(resolve, reject, {
        enableHighAccuracy: true, maximumAge: 0, timeout: 15000
      });
    });
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;

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
        _photo_path: photoPath, _store_id: null
      }));
    } else {
      ({ data: brkRow, error: rpcErr } = await supabaseClient.rpc('end_break_now_geo', {
        _employee_id: currentEmployee.id, _lat: lat, _lng: lng, _accuracy_m: accuracy,
        _photo_path: photoPath, _store_id: null
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
      .select('id, clock_in, clock_out, photo_in_path, photo_out_path')
      .eq('employee_id', currentEmployee.id)
      .gte('clock_in', dayStart.toISOString())
      .lt('clock_in', dayEnd.toISOString())
      .order('clock_in', { ascending: true });
    if (eErr) throw eErr;
    const rows = entries || [];
    const ids = rows.map(r => r.id);

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
      for (const r of rows){
        const tr = document.createElement('tr');
        const endTs = r.clock_out ? new Date(r.clock_out) : new Date();
        const durMs = endTs - new Date(r.clock_in);
        tr.innerHTML = `
          <td>${new Date(r.clock_in).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</td>
          <td>${r.clock_out ? new Date(r.clock_out).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'}) : '—'}</td>
          <td>${fmtDur(durMs)}</td>
          <td class="photo-in"></td>
          <td class="photo-out"></td>
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

  // Initial session check (also fetch cap before first hydrate)
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session?.user || null;
  if (!currentUser) return redirectToLogin();

  try { if (typeof fetchBreakCap === 'function') await fetchBreakCap(); } catch {}
  await hydrate(); // don't wait for onAuthStateChange; hydrate now with cap loaded
});
