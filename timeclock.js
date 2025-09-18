// timeclock.js — session-required version
let supabaseClient;
let currentUser = null;
let currentEmployee = null;
let isHydrating = false;
let isLoadingToday = false;


// ---- Camera helpers ----
let camStream = null;
let camKind = null;       // 'in' | 'out'
let camEntryId = null;
let camBlob = null;
let isPunching = false;

function qs(id){ return document.getElementById(id); }

async function openCamera(kind, entryId){
  camKind = kind;
  camEntryId = entryId;
  camBlob = null;
  qs('camTitle').textContent = kind === 'in' ? 'Take Clock-In Photo' : 'Take Clock-Out Photo';
  qs('camCanvas').classList.add('hidden');
  qs('camVideo').classList.remove('hidden');
  qs('camCaptureBtn').classList.remove('hidden');
  qs('camRetakeBtn').classList.add('hidden');
  qs('camUseBtn').classList.add('hidden');

  // request camera
  try{
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
    qs('camVideo').srcObject = camStream;
    qs('camModal').classList.remove('hidden');
  }catch(e){
    alert('Camera permission denied. You can add the photo later from Admin.');
    // just bail; we already recorded the punch
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

  // switch UI
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

  // Upload to the private bucket (no overwrite)
  const { error: upErr } = await supabaseClient.storage
    .from('timeclock-photos')
    .upload(path, camBlob, { contentType: 'image/jpeg', upsert: false });

  if (upErr){
    alert('Upload failed: ' + upErr.message);
    closeCamera();
    return;
  }

  // Attach to entry via RPC (writes path into time_entries)
  const { error: attErr } = await supabaseClient.rpc('attach_punch_photo', {
    _entry_id: camEntryId,
    _kind: camKind,
    _photo_path: path
  });

  if (attErr){
    alert('Attach failed: ' + attErr.message);
  }

  closeCamera();
  await loadToday();
}

function redirectToLogin(){
  const next = encodeURIComponent('timeclock.html');
  window.location.href = `index.html?next=${next}`;
}

function show(el, visible){ el.classList.toggle('hidden', !visible); }
function fmt(ts){ return ts ? new Date(ts).toLocaleString() : '—'; }
function fmtDuration(ms){
  if(ms == null) return '—';
  const h = Math.floor(ms/3600000);
  const m = Math.round((ms%3600000)/60000);
  return `${h}h ${m}m`;
}

async function signOut(){
  await supabaseClient.auth.signOut();
  redirectToLogin();
}

async function hydrate(){
  if (isHydrating) return;        // prevent overlaps
  isHydrating = true;
  try {
    // Load employee profile tied to this user
    const { data: emp, error } = await supabaseClient
      .from('employees')
      .select('*')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (error) { alert(error.message); return; }
    if (!emp)   { alert('No employee profile linked. Ask admin.'); return; }

    currentEmployee = emp;
    qs('displayName').textContent = emp.display_name;
    show(qs('clockSection'), true);

    await refreshShiftStatus();
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

  if (error) { console.error(error); return; }

  const open = data?.[0];
  const pill = document.getElementById('shiftStatus');
  const btn = document.getElementById('clockBtn');

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

async function onClockAction(){
  if (isPunching) return;
  isPunching = true;
  const btn = document.getElementById('clockBtn');
  btn.disabled = true;

  try {
    const geo = await getGeo();
    if (!geo.ok) { alert(geo.msg || 'Unable to get location.'); return; }

    // check open shift
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

    if (err) { alert(err.message); return; }

    await refreshShiftStatus();
    await loadToday();

    if (entry?.id) openCamera(kind, entry.id);
  } finally {
    isPunching = false;
    btn.disabled = false;
  }
}

async function loadToday(){
  if (isLoadingToday) return;     // prevent overlaps
  isLoadingToday = true;
  try {
    const start = new Date(); start.setHours(0,0,0,0);
    const end = new Date(); end.setHours(23,59,59,999);

    const { data, error } = await supabaseClient
      .from('time_entries')
      .select('*')
      .eq('employee_id', currentEmployee.id)
      .gte('clock_in', start.toISOString())
      .lte('clock_in', end.toISOString())
      .order('clock_in', { ascending: true });

    if (error) { console.error(error); return; }

    const tbody = qs('todayBody');
    tbody.innerHTML = '';

    // Render sequentially to avoid interleaving from other async tasks
    for (const r of (data || [])) {
      const tr = document.createElement('tr');
      const dur = r.clock_out ? (new Date(r.clock_out) - new Date(r.clock_in)) : null;

      const [photoInCell, photoOutCell] = await Promise.all([
        renderPhotoCell(r.photo_in_path),
        renderPhotoCell(r.photo_out_path)
      ]);

      tr.innerHTML = `
        <td>${fmt(r.clock_in)}</td>
        <td>${fmt(r.clock_out)}</td>
        <td>${fmtDuration(dur)}</td>
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
    a.href = data.signedUrl;
    a.target = '_blank';
    a.rel = 'noopener';
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
    document.getElementById('geoText').textContent =
      `${lat.toFixed(5)}, ${lng.toFixed(5)} (±${Math.round(accuracy)}m)`;
  }, () => {
    document.getElementById('geoText').textContent = 'Location permission denied';
  }, { enableHighAccuracy:true, maximumAge:0, timeout:5000 });
}

function getGeo(){
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)){
      return resolve({ ok:false, msg:'Geolocation not supported in this browser.' });
    }
    navigator.geolocation.getCurrentPosition(pos => {
      resolve({
        ok: true,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
        accuracy: pos.coords.accuracy
      });
    }, err => {
      resolve({ ok:false, msg: err?.message || 'Unable to get location.' });
    }, { enableHighAccuracy:true, maximumAge:0, timeout:10000 });
  });
}

document.addEventListener('DOMContentLoaded', async () => {

    supabaseClient = window.supabase;

  // If session changes (logout elsewhere), re-check
let hydrateTimer = null;

supabaseClient.auth.onAuthStateChange((_event, session) => {
  currentUser = session?.user || null;
  if (!currentUser) {
    redirectToLogin();
    return;
  }
  // Cancel any pending hydrate
  clearTimeout(hydrateTimer);
  // Schedule hydrate once (next tick)
  hydrateTimer = setTimeout(() => {
    hydrate();
  }, 0);
});


  // UI
  document.getElementById('signOutBtn').addEventListener('click', signOut);
  document.getElementById('clockBtn').addEventListener('click', onClockAction);
qs('camCaptureBtn').addEventListener('click', captureFrame);
qs('camRetakeBtn').addEventListener('click', retakeFrame);
qs('camUseBtn').addEventListener('click', uploadAndAttach);
qs('camCancelBtn').addEventListener('click', closeCamera);

  setInterval(() => {
    document.getElementById('nowTime').textContent = new Date().toLocaleString();
  }, 1000);
  document.getElementById('nowTime').textContent = new Date().toLocaleString();

  // Initial session check
  const { data: { session } } = await supabaseClient.auth.getSession();
  currentUser = session?.user || null;
  if (!currentUser) return redirectToLogin();
});
