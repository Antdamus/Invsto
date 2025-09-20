// timeclock.js — session-required version with Breaks + Camera
let supabaseClient;
let currentUser = null;
let currentEmployee = null;

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

function qs(id){ return document.getElementById(id); }
function show(el, visible){ if (el) el.classList.toggle('hidden', !visible); }
function fmt(ts){ return ts ? new Date(ts).toLocaleString() : '—'; }
function fmtDuration(ms){
  if(ms == null) return '—';
  const h = Math.floor(ms/3600000);
  const m = Math.round((ms%3600000)/60000);
  return `${h}h ${m}m`;
}

async function openCamera(kind, entryId){
  camKind = kind;
  camEntryId = entryId;
  camBlob = null;
  qs('camTitle').textContent =
    kind === 'in' ? 'Take Clock-In Photo' :
    kind === 'out' ? 'Take Clock-Out Photo' :
    kind === 'break_start' ? 'Take Break Start Photo' :
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
  if (!camBlob || !camEntryId) return closeCamera();
  const path = `${currentEmployee.id}/${camEntryId}_${camKind}.jpg`;

  const { error: upErr } = await supabaseClient.storage
    .from('timeclock-photos')
    .upload(path, camBlob, { contentType: 'image/jpeg', upsert: false });
  if (upErr){ alert('Upload failed: ' + upErr.message); closeCamera(); return; }

  const { error: attErr } = await supabaseClient.rpc('attach_punch_photo', {
    _entry_id: camEntryId, _kind: (camKind === 'break_start' || camKind === 'break_end') ? 'in' : camKind, _photo_path: path
  });
  // ^ If you later want separate photos for breaks, store to time_breaks and adjust RPC accordingly.

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
    const geo = await getGeo();
    if (!geo.ok){ alert(geo.msg || 'Unable to get location.'); return; }

    const { data: openRows } = await supabaseClient
      .from('time_entries').select('id')
      .eq('employee_id', currentEmployee.id)
      .is('clock_out', null).limit(1);

    let entry, err, kind;
    if (openRows && openRows.length){
      kind = 'out';
      ({ data: entry, error: err } = await supabaseClient.rpc('clock_out_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy, _store_id: null
      }));
    } else {
      kind = 'in';
      ({ data: entry, error: err } = await supabaseClient.rpc('clock_in_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy, _store_id: null
      }));
    }

    if (err){ alert(err.message); return; }

    await refreshShiftStatus();
    await refreshBreakStatus();
    await loadToday();

    if (entry?.id) openCamera(kind, entry.id);
  } finally {
    isPunching = false;
    btn.disabled = false;
  }
}

async function onBreakAction(){
  if (isBreaking) return;
  isBreaking = true;
  const btn = qs('breakBtn');
  if (btn) btn.disabled = true;

  try {
    const geo = await getGeo();
    if (!geo.ok){ alert(geo.msg || 'Unable to get location.'); return; }

    // ensure on shift
    const { data: openShift } = await supabaseClient
      .from('time_entries')
      .select('id')
      .eq('employee_id', currentEmployee.id)
      .is('clock_out', null)
      .maybeSingle();
    if (!openShift){ alert('You must be clocked in to start/end a break.'); return; }

    // check open break
    const { data: openBreak } = await supabaseClient
      .from('time_breaks')
      .select('id')
      .eq('time_entry_id', openShift.id)
      .is('ended_at', null)
      .maybeSingle();

    if (openBreak){
      // end break
      const { error } = await supabaseClient.rpc('end_break_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy, _store_id: null
      });
      if (error){ alert(error.message); return; }
      // optionally capture a break end photo:
      // openCamera('break_end', openShift.id);
    } else {
      // start break
      const { error } = await supabaseClient.rpc('start_break_now_geo', {
        _employee_id: currentEmployee.id,
        _lat: geo.lat, _lng: geo.lng, _accuracy_m: geo.accuracy, _store_id: null
      });
      if (error){ alert(error.message); return; }
      // optionally capture a break start photo:
      // openCamera('break_start', openShift.id);
    }

    await refreshBreakStatus();
    await loadToday();
  } finally {
    isBreaking = false;
    if (btn) btn.disabled = false;
  }
}

async function loadToday(){
  if (isLoadingToday) return;
  isLoadingToday = true;
  try {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);

    // shifts
    const { data: entries, error } = await supabaseClient
      .from('time_entries')
      .select('*')
      .eq('employee_id', currentEmployee.id)
      .gte('clock_in', start.toISOString())
      .lte('clock_in', end.toISOString())
      .order('clock_in', { ascending: true });
    if (error){ console.error(error); return; }

    // breaks per shift
    const ids = (entries||[]).map(e => e.id);
    let breaksByEntry = {};
    if (ids.length){
      const { data: breaks } = await supabaseClient
        .from('time_breaks')
        .select('time_entry_id, started_at, ended_at')
        .in('time_entry_id', ids)
        .order('started_at', { ascending: true });
      for (const b of (breaks||[])){
        (breaksByEntry[b.time_entry_id] ||= []).push(b);
      }
    }

    const tbody = qs('todayBody');
    tbody.innerHTML = '';

    for (const r of (entries || [])) {
      const tr = document.createElement('tr');
      const dur = r.clock_out ? (new Date(r.clock_out) - new Date(r.clock_in)) : null;

      // breaks summary
      const bks = breaksByEntry[r.id] || [];
      const totalBreakMs = bks.reduce((sum, b) => {
        if (!b.ended_at) return sum;
        return sum + (new Date(b.ended_at) - new Date(b.started_at));
      }, 0);
      const breaksText = bks.length ? `${bks.length} break(s) · ${fmtDuration(totalBreakMs)}` : '—';

      const [photoInCell, photoOutCell] = await Promise.all([
        renderPhotoCell(r.photo_in_path),
        renderPhotoCell(r.photo_out_path)
      ]);

      tr.innerHTML = `
        <td>${fmt(r.clock_in)}</td>
        <td>${fmt(r.clock_out)}</td>
        <td>${fmtDuration(dur)}<div style="color:#9aa0a6;font-size:12px;">Breaks: ${breaksText}</div></td>
        <td class="photo-in"></td>
        <td class="photo-out"></td>
      `;
      tbody.appendChild(tr);
      tr.querySelector('.photo-in').appendChild(photoInCell);
      tr.querySelector('.photo-out').appendChild(photoOutCell);
    }
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

  // Auth state (debounced hydrate)
  let hydrateTimer = null;
  supabaseClient.auth.onAuthStateChange((_event, session) => {
    currentUser = session?.user || null;
    if (!currentUser){ redirectToLogin(); return; }
    clearTimeout(hydrateTimer);
    hydrateTimer = setTimeout(() => { hydrate(); }, 0);
  });

  // UI listeners
  qs('signOutBtn')?.addEventListener('click', signOut);
  qs('clockBtn')?.addEventListener('click', onClockAction);
  qs('breakBtn')?.addEventListener('click', onBreakAction);
  qs('camCaptureBtn')?.addEventListener('click', captureFrame);
  qs('camRetakeBtn')?.addEventListener('click', retakeFrame);
  qs('camUseBtn')?.addEventListener('click', uploadAndAttach);
  qs('camCancelBtn')?.addEventListener('click', closeCamera);

  setInterval(() => { qs('nowTime').textContent = new Date().toLocaleString(); }, 1000);
  qs('nowTime').textContent = new Date().toLocaleString();

  // Initial session check
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session?.user || null;
  if (!currentUser) return redirectToLogin();
  // onAuthStateChange will fire and call hydrate()
});
