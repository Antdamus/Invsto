// admin.js — Overview + Drawer/Edit/Audit + Payroll Weekly + Period Lock/Unlock (Phase 3.3)
let supabaseClient = null;
let drawerOnlyAnoms = false;
let lastDrawerShifts = []; // keep latest list to re-render on toggle

// ===== Global calendar state =====
let gcMonthStart = null; // first day of the month being shown (Date)

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

/* ============== Admin Guard ============== */
async function ensureAdmin() {
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (!session) { window.location.href = "index.html?next=" + encodeURIComponent("admin.html"); return false; }
  const { data: isAdmin, error } = await supabaseClient.rpc('is_admin');
  if (error || !isAdmin) { window.location.href = `index.html?reason=${encodeURIComponent('Admin only')}`; return false; }
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
async function fetchWeekOverrides(empId, weekStart){
  const start = toISODate(weekStart);
  const end   = toISODate(addDays(weekStart, 6));
  const { data, error } = await supabaseClient
    .from('work_schedule_overrides')
    .select('work_date, off, start_local, end_local, note')
    .eq('employee_id', empId)
    .gte('work_date', start)
    .lte('work_date', end);
  if (error) throw error;
  const byDate = new Map();
  for (const r of (data||[])) byDate.set(r.work_date, r);
  return byDate;
}

function fmtTimeHM(ts){
  if (!ts) return '—';
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' });
}

function renderScheduleGrid(weekStart, resolvedByDate, overridesByDate){
  const tbody = qs('schedBody');
  tbody.innerHTML = '';

  for (let i=0;i<7;i++){
    const day = addDays(weekStart, i);
    const iso = toISODate(day);
    const resolved = resolvedByDate.get(iso) || null;
    const ov = overridesByDate.get(iso) || null;

    const resolvedStr = resolved
      ? `${fmtTimeHM(resolved.start_ts)}–${fmtTimeHM(resolved.end_ts)}`
      : '—';
    const srcStr = resolved ? (resolved.source === 'override' ? 'override' : 'recurring') : '';
    const resolvedHtml = `
      <div class="sched-resolved">${resolvedStr} ${srcStr ? `<span class="sched-note">(${srcStr})</span>`:''}</div>
    `;

    // Prefill recurring fields from resolved only when it came from recurring (no override)
    const recStartPrefill = (resolved && resolved.source === 'recurring')
      ? new Date(resolved.start_ts).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:false})
      : '';
    const recEndPrefill = (resolved && resolved.source === 'recurring')
      ? new Date(resolved.end_ts).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:false})
      : '';

    // Prefill override inputs from existing override row
    const ovOff   = ov?.off ? 'checked' : '';
    const ovStart = ov?.start_local ? String(ov.start_local).slice(0,5) : '';
    const ovEnd   = ov?.end_local   ? String(ov.end_local).slice(0,5)   : '';

    const tr = document.createElement('tr');
    tr.className = 'sched-row';
    tr.innerHTML = `
      <td class="day">${DOW[i]} ${day.getMonth()+1}/${day.getDate()}</td>

      <td>
        <div class="row">
          <input class="time" type="time" id="recStart-${i}" value="${recStartPrefill}">
          <span>–</span>
          <input class="time" type="time" id="recEnd-${i}" value="${recEndPrefill}">
        </div>
        <div class="sched-buttons" style="margin-top:6px;">
          <button class="btn small" data-save-recurring="${i}">Save recurring</button>
        </div>
      </td>

      <td>
        <div class="row">
          <label><input type="checkbox" id="ovOff-${iso}" ${ovOff}> Off</label>
          <input class="time" type="time" id="ovStart-${iso}" value="${ovStart}" ${ovOff ? 'disabled':''}>
          <span>–</span>
          <input class="time" type="time" id="ovEnd-${iso}" value="${ovEnd}" ${ovOff ? 'disabled':''}>
        </div>
        <div class="sched-buttons" style="margin-top:6px;">
          <button class="btn small" data-save-override="${iso}">Save override</button>
          <button class="btn small ghost" data-clear-override="${iso}">Clear override</button>
        </div>
      </td>

      <td>${resolvedHtml}</td>
    `;
    tbody.appendChild(tr);
  }
}

async function saveRecurring(weekday){
  const empId = schedEmpId;
  const start = qs(`recStart-${weekday}`).value || '';
  const end   = qs(`recEnd-${weekday}`).value || '';
  const effFrom = qs('schedEffFrom').value || toISODate(new Date());

  if (!start || !end) return alert('Enter start and end time for recurring.');
  if (end <= start) return alert('End must be after start.');

  const { error } = await supabaseClient.rpc('admin_set_weekday_slot', {
    _employee_id: empId,
    _weekday: weekday,
    _start_local: start,
    _end_local: end,
    _effective_from: effFrom,
    _effective_to: null,
    _store_id: null,
    _note: null
  });
  if (error) return alert('Save failed: ' + error.message);
  await loadScheduleWeek(); // refresh
}

async function saveOverride(workISO){
  const empId = schedEmpId;
  const off = qs(`ovOff-${workISO}`).checked;
  const s = qs(`ovStart-${workISO}`);
  const e = qs(`ovEnd-${workISO}`);
  const start = s.value || null;
  const end   = e.value || null;

  if (!off){
    if (!start || !end) return alert('Enter start and end time, or mark Off.');
    if (end <= start) return alert('End must be after start.');
  }

  const { error } = await supabaseClient.rpc('admin_set_override', {
    _employee_id: empId,
    _work_date: workISO,
    _off: off,
    _start_local: start,
    _end_local: end,
    _store_id: null,
    _note: null
  });
  if (error) return alert('Override failed: ' + error.message);
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

async function initSchedulePanel(){
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
    } else if (btn.hasAttribute('data-save-override')){
      const iso = btn.getAttribute('data-save-override');
      saveOverride(iso);
    } else if (btn.hasAttribute('data-clear-override')){
      const iso = btn.getAttribute('data-clear-override');
      clearOverride(iso);
    }
  });

  // enable/disable override time inputs when Off toggled
  qs('schedBody').addEventListener('change', (e) => {
    if (e.target.id && e.target.id.startsWith('ovOff-')){
      const iso = e.target.id.slice('ovOff-'.length);
      const on = e.target.checked;
      qs(`ovStart-${iso}`).disabled = on;
      qs(`ovEnd-${iso}`).disabled = on;
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
  // Hide all panels you have; list the known ones
  ['panelOverview','panelPayroll','panelSchedule'].forEach(pid => {
    const el = qs(pid); if (el) el.classList.add('hidden');
  });
  const p = qs(id); if (p) p.classList.remove('hidden');
}

function wireScheduleTab(){
  qs('tabSchedule')?.addEventListener('click', async () => {
    showPanel('panelSchedule');
    // lazy init once
    if (!qs('schedEmpSelect').options.length){
      try { await initSchedulePanel(); } catch (e){ console.error(e); }
    }
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
    tr.innerHTML=`<td>${r.display_name||'—'}</td><td>${r.shifts_count??'—'}</td><td>${fmtHours(r.total_hours)}</td>`;
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

    const { rows } = await fetchMonthlySummary(monthStart); // all employees
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

/* ============== Payroll (weekly) ============== */
let payWeeks=[], paySelected=null, payRows=[];
function formatWeekRange(weekStartStr){ const s=new Date(weekStartStr+'T00:00:00'); const e=new Date(s); e.setDate(s.getDate()+6); const f=d=>d.toLocaleDateString(undefined,{month:'short',day:'numeric',year:'numeric'}); return `${f(s)} — ${f(e)}`; }
async function fetchWeekList(){
  const get = async t => { const {data,error}=await supabaseClient.from(t).select('week_start').order('week_start',{descending:true}).limit(2000); if(error) throw error; return (data||[]).map(r=>r.week_start); };
  let weeks=[]; try{ weeks=await get('mv_weekly_hours'); }catch(_e){}
  if(!weeks.length){ const {data}=await supabaseClient.from('v_weekly_hours').select('week_start').order('week_start',{descending:true}).limit(2000); weeks=(data||[]).map(r=>r.week_start); }
  const set=new Set(), out=[]; for(const w of weeks){ if(!set.has(w)){ set.add(w); out.push(w); } } return out;
}

// ===== Schedule: utilities & state =====
const DOW = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

const fromISO = s => { const [y,m,d] = s.split('-').map(Number); return new Date(y, m-1, d); };

function startOfWeekSun(d){
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const dow = x.getDay(); // 0=Sun
  x.setDate(x.getDate() - dow);
  return x;
}
function weekLabel(weekStart){
  const a = weekStart, b = addDays(weekStart, 6);
  const sameMonth = a.getMonth() === b.getMonth();
  const aStr = `${DOW[a.getDay()]} ${a.getMonth()+1}/${a.getDate()}`;
  const bStr = `${DOW[b.getDay()]} ${b.getMonth()+1}/${b.getDate()}/${b.getFullYear()}`;
  return sameMonth ? `${aStr}–${b.getDate()}/${b.getFullYear()}` : `${aStr} – ${bStr}`;
}

// local state
let schedEmpId = null;
let schedWeekStart = startOfWeekSun(new Date());


// Weekly payroll: include ALL active employees with zeros if absent
async function fetchWeeklyHours(weekStartStr){
  const [emps, viewResp] = await Promise.all([
    getActiveEmployees(),
    supabaseClient.from('v_weekly_hours')
      .select('employee_id, regular_hours, overtime_hours, total_hours, week_start')
      .eq('week_start', weekStartStr)
  ]);
  const byId = new Map((viewResp.data || []).map(r => [r.employee_id, r]));
  const rows = emps.map(e => {
    const v = byId.get(e.id) || {};
    return {
      employee_id: e.id,
      display_name: e.display_name,
      week_start: weekStartStr,
      regular_hours: v.regular_hours || 0,
      overtime_hours: v.overtime_hours || 0,
      total_hours: v.total_hours || 0
    };
  });
  return { rows, source: 'view' };
}

function renderPayWeekOptions(){
  const sel=qs('payWeekSelect'); sel.innerHTML=''; for(const w of payWeeks){ const o=document.createElement('option'); o.value=w; o.textContent=formatWeekRange(w); sel.appendChild(o); }
  if (paySelected) sel.value=paySelected;
}
function renderPayKPIs(rows){
  const reg=rows.reduce((a,r)=>a+(+r.regular_hours||0),0), ot=rows.reduce((a,r)=>a+(+r.overtime_hours||0),0), tot=rows.reduce((a,r)=>a+(+r.total_hours||0),0);
  qs('payTotalReg').textContent=fmtHours(reg); qs('payTotalOT').textContent=fmtHours(ot); qs('payTotalAll').textContent=fmtHours(tot);
}
function renderPayTable(rows){
  const tb=qs('payTbody'); tb.innerHTML=''; if(!rows.length){ tb.innerHTML=`<tr><td colspan="4" class="muted">No data for this week.</td></tr>`; return; }
  for(const r of rows){ const tr=document.createElement('tr'); tr.innerHTML=`<td>${r.display_name||'—'}</td><td>${fmtHours(r.regular_hours)}</td><td>${fmtHours(r.overtime_hours)}</td><td>${fmtHours(r.total_hours)}</td>`; tb.appendChild(tr); }
}
async function loadPayroll(){
  if(!paySelected){ qs('payTbody').innerHTML=`<tr><td colspan="4" class="muted">Pick a week.</td></tr>`; return; }
  qs('payWeekLabel').textContent = formatWeekRange(paySelected); qs('payTbody').style.opacity='0.6';
  try{
    const { rows } = await fetchWeeklyHours(paySelected); payRows=rows;
    renderPayKPIs(rows); renderPayTable(rows);
    await updatePeriodForSelectedWeek(); // NEW: sync period UI
  }catch(err){
    console.error(err);
    qs('payTbody').innerHTML = `<tr><td colspan="4" class="muted">Error loading payroll.</td></tr>`;
    qs('payTotalReg').textContent=qs('payTotalOT').textContent=qs('payTotalAll').textContent='—';
  }finally{ qs('payTbody').style.opacity='1'; }
}
async function bootPayroll(){
  payWeeks = await fetchWeekList();
  if (payWeeks.length){ paySelected = payWeeks[0]; renderPayWeekOptions(); qs('payWeekLabel').textContent = formatWeekRange(paySelected); await loadPayroll(); }
  else { qs('payWeekSelect').innerHTML=`<option value="">No weeks found</option>`; qs('payTbody').innerHTML=`<tr><td colspan="4" class="muted">No weekly data yet.</td></tr>`; }
}
function wirePayroll(){
  qs('payWeekSelect').addEventListener('change', async (e)=>{ paySelected=e.target.value||null; await loadPayroll(); });
  qs('payPrevBtn').addEventListener('click', async ()=>{ if(!paySelected) return; const i=payWeeks.indexOf(paySelected); if(i<payWeeks.length-1){ paySelected=payWeeks[i+1]; qs('payWeekSelect').value=paySelected; await loadPayroll(); }});
  qs('payNextBtn').addEventListener('click', async ()=>{ if(!paySelected) return; const i=payWeeks.indexOf(paySelected); if(i>0){ paySelected=payWeeks[i-1]; qs('payWeekSelect').value=paySelected; await loadPayroll(); }});
}

/* ============== Periods (lock/unlock) — NEW in 3.3 ============== */
let payPeriods = [];     // rows from pay_periods
let selectedPeriod = null;

async function fetchPayPeriods(){
  const { data, error } = await supabaseClient.from('pay_periods')
    .select('id, start_date, end_date, timezone, status, locked_at, locked_by, note')
    .order('start_date', { ascending: false });
  if (error) throw error;
  return data || [];
}
function dateOnly(str){ return new Date(str + 'T00:00:00'); }
function rangesOverlap(aStart, aEnd, bStart, bEnd){ return aStart <= bEnd && aEnd >= bStart; }
function findPeriodForWeek(weekStartStr){
  const ws=dateOnly(weekStartStr), we=new Date(ws); we.setDate(ws.getDate()+6);
  for (const p of payPeriods){
    const ps=dateOnly(p.start_date), pe=dateOnly(p.end_date); // inclusive end
    if (rangesOverlap(ws, we, ps, pe)) return p;
  }
  return null;
}
function setBadge(el, status){
  el.classList.remove('locked','open','warn');
  if (status==='locked'){ el.classList.add('locked'); el.textContent='LOCKED'; }
  else if (status==='open'){ el.classList.add('open'); el.textContent='OPEN'; }
  else { el.classList.add('warn'); el.textContent='NO PERIOD'; }
}

function renderPeriodUI(){
  const nameEl    = qs('periodName');
  const badgeEl   = qs('periodBadge');
  const hintEl    = qs('periodHint');
  const lockBtn   = qs('lockBtn');
  const unlockBtn = qs('unlockBtn');
  const exportBtn = qs('exportBtn');
  const createWeekBtn = qs('createWeekBtn');
  const newPeriodBtn  = qs('newPeriodBtn');

  function setBadge(status){
    badgeEl.classList.remove('locked','open','warn');
    if (status === 'locked') { badgeEl.classList.add('locked'); badgeEl.textContent = 'LOCKED'; }
    else if (status === 'open') { badgeEl.classList.add('open'); badgeEl.textContent = 'OPEN'; }
    else { badgeEl.classList.add('warn'); badgeEl.textContent = 'NO PERIOD'; }
  }

  if (!selectedPeriod){
    nameEl.textContent = 'No defined pay period covers this week';
    setBadge(null);
    hintEl.textContent = 'Tip: create a pay period that covers this week, then lock it for payroll.';
    if (lockBtn)   lockBtn.disabled   = true;
    if (unlockBtn) unlockBtn.disabled = true;
    if (exportBtn) exportBtn.disabled = true;
    if (createWeekBtn) createWeekBtn.disabled = false;   // enable quick-create
    if (newPeriodBtn)  newPeriodBtn.disabled  = false;
    return;
  }

  const p = selectedPeriod;
  nameEl.textContent = `${p.start_date} → ${p.end_date} (${p.timezone})`;
  setBadge(p.status);
  hintEl.textContent = p.status === 'locked'
    ? 'Edits inside this period are blocked.'
    : 'Open period — you can still edit shifts.';

  if (lockBtn)   lockBtn.disabled   = (p.status !== 'open');
  if (unlockBtn) unlockBtn.disabled = (p.status !== 'locked');
  if (exportBtn) exportBtn.disabled = false;
  if (createWeekBtn) createWeekBtn.disabled = true;  // avoid creating an overlapping week
  if (newPeriodBtn)  newPeriodBtn.disabled  = false; // allowed; RPC prevents overlaps anyway
}


async function updatePeriodForSelectedWeek(){
  payPeriods = await fetchPayPeriods();
  selectedPeriod = paySelected ? findPeriodForWeek(paySelected) : null;
  renderPeriodUI();
}
async function onLock(){
  if (!selectedPeriod) return;
  const note = window.prompt('Optional note for this lock:', 'Locked for payroll');
  try{
    const { error } = await supabaseClient.rpc('payroll_lock_period', { _period_id: selectedPeriod.id, _note: note||null, _force: false });
    if (error) throw error;
    showToast('Period locked','ok');
    await updatePeriodForSelectedWeek();
  }catch(err){
    console.error(err);
    showToast(err?.message || 'Failed to lock period','err');
  }
}
async function onUnlock(){
  if (!selectedPeriod) return;
  const note = window.prompt('Optional note for this unlock:', 'Re-opened for corrections');
  try{
    const { error } = await supabaseClient.rpc('payroll_unlock_period', { _period_id: selectedPeriod.id, _note: note||null });
    if (error) throw error;
    showToast('Period unlocked','ok');
    await updatePeriodForSelectedWeek();
  }catch(err){
    console.error(err);
    showToast(err?.message || 'Failed to unlock period','err');
  }
}
function csvEscape(value){
  if (value == null) return '';
  const s = String(value);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowsToCSV(rows){
  const header = ['Employee','Regular Hours','OT Hours','Total Hours','Shifts'];
  const lines = [header.map(csvEscape).join(',')];

  let totalReg=0, totalOT=0, totalAll=0, totalShifts=0;

  for (const r of rows){
    const reg = Number(r.regular_hours)||0, ot = Number(r.overtime_hours)||0, tot = Number(r.total_hours)||0, sh = Number(r.shifts_count)||0;
    totalReg += reg; totalOT += ot; totalAll += tot; totalShifts += sh;
    lines.push([
      r.display_name || '',
      reg.toFixed(2),
      ot.toFixed(2),
      tot.toFixed(2),
      String(sh)
    ].map(csvEscape).join(','));
  }
  // Totals row
  lines.push(['TOTAL', totalReg.toFixed(2), totalOT.toFixed(2), totalAll.toFixed(2), String(totalShifts)].map(csvEscape).join(','));
  return lines.join('\n');
}
function downloadText(filename, text, mime='text/csv;charset=utf-8;'){
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
async function onExport(){
  if (!selectedPeriod) return;
  try{
    const rows = await fetchPeriodSummary(selectedPeriod.id);
    const csv = rowsToCSV(rows);
    const fname = `payroll_${selectedPeriod.start_date}_to_${selectedPeriod.end_date}_${selectedPeriod.status}.csv`;
    downloadText(fname, csv);
    showToast('CSV exported','ok');
  }catch(err){
    console.error(err);
    showToast(err?.message || 'Failed to export CSV','err');
  }
}

function dateStrAddDays(yyyyMmDd, days){
  const d = new Date(yyyyMmDd + 'T00:00:00');
  d.setDate(d.getDate() + days);
  const p = n => String(n).padStart(2,'0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}`;
}

async function onCreateThisWeek(){
  if (!paySelected) return;
  try {
    const { error } = await supabaseClient.rpc('create_weekly_pay_period', {
      week_start: paySelected, weeks: 1, p_note: 'Created from Payroll UI'
    });
    if (error) throw error;
    showToast('Pay period created','ok');
    await updatePeriodForSelectedWeek();
  } catch (err) {
    console.error(err); showToast(err?.message || 'Failed to create period','err');
  }
}

async function approveShift(shiftId, note){
  const { error } = await supabaseClient.rpc('approve_shift', {
    _time_entry_id: shiftId, _status: 'approved', _note: note || null
  });
  if (error) throw error;
}
async function waiveShift(shiftId, note){
  const n = (note || '').trim();
  if (n.length < 3) throw new Error('Waive requires a brief note (min 3 chars).');
  const { error } = await supabaseClient.rpc('approve_shift', {
    _time_entry_id: shiftId, _status: 'waived', _note: n
  });
  if (error) throw error;
}
async function unapproveShift(shiftId){
  const { error } = await supabaseClient.rpc('unapprove_shift', { _time_entry_id: shiftId });
  if (error) throw error;
}

// Click handlers
async function onApproveClick(shiftId){
  try{
    const note = window.prompt('Optional note for approval:', '');
    await approveShift(shiftId, note);
    showToast('Shift approved','ok');
    // refresh drawer list
    const { employeeId, monthStart } = drawerContext;
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
  }catch(err){ console.error(err); showToast(err?.message || 'Failed to approve','err'); }
}
async function onWaiveClick(shiftId){
  try{
    const note = window.prompt('Reason for waiver (required):', '');
    await waiveShift(shiftId, note);
    showToast('Shift waived','ok');
    const { employeeId, monthStart } = drawerContext;
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
  }catch(err){ console.error(err); showToast(err?.message || 'Failed to waive','err'); }
}
async function onUnapproveClick(shiftId){
  try{
    if (!window.confirm('Remove approval/waiver for this shift?')) return;
    await unapproveShift(shiftId);
    showToast('Approval removed','ok');
    const { employeeId, monthStart } = drawerContext;
    const shifts = await fetchWorkerShifts(employeeId, monthStart);
    renderDrawerSummary(shifts);
    renderDrawerList(shifts);
  }catch(err){ console.error(err); showToast(err?.message || 'Failed to unapprove','err'); }
}


function openCreateModal(){
  const start = paySelected || (payWeeks[0] || new Date().toISOString().slice(0,10));
  qs('createStart').value = start;
  qs('createEnd').value = dateStrAddDays(start, 6);
  qs('createNote').value = '';
  qs('createError').textContent = ''; show(qs('createError'), false);
  qs('createModal').classList.add('open'); qs('createModal').classList.remove('hidden');
  qs('createModalBackdrop').classList.add('show'); qs('createModalBackdrop').classList.remove('hidden');
}
function closeCreateModal(){
  qs('createModal').classList.remove('open'); qs('createModalBackdrop').classList.remove('show');
  setTimeout(() => { qs('createModal').classList.add('hidden'); qs('createModalBackdrop').classList.add('hidden'); }, 180);
}
function setCreateError(msg){ const el=qs('createError'); el.textContent=msg||''; show(el, !!msg); }

async function createCustomPeriod(){
  const s = qs('createStart').value, e = qs('createEnd').value;
  const note = (qs('createNote').value||'').trim();
  if (!s || !e) return setCreateError('Start and end dates are required.');
  if (new Date(s) > new Date(e)) return setCreateError('End date must be after start date.');
  setCreateError('');
  try {
    const { error } = await supabaseClient.rpc('create_pay_period', {
      p_start_date: s, p_end_date: e, p_note: note || null
    });
    if (error) throw error;
    closeCreateModal(); showToast('Pay period created','ok');
    await updatePeriodForSelectedWeek();
  } catch (err) {
    console.error(err); setCreateError(err?.message || 'Failed to create pay period');
  }
}

function wireCreatePeriodUI(){
  const cw = qs('createWeekBtn');
  const np = qs('newPeriodBtn');
  if (cw) cw.addEventListener('click', onCreateThisWeek);
  if (np){
    np.addEventListener('click', openCreateModal);
    qs('createCloseBtn').addEventListener('click', closeCreateModal);
    qs('createCancelBtn').addEventListener('click', closeCreateModal);
    qs('createModalBackdrop').addEventListener('click', closeCreateModal);
    qs('createSaveBtn').addEventListener('click', createCustomPeriod);
  }
}

/* ============== Tabs ============== */
function switchTab(which){
  const ovBtn=qs('tabOverview'), pyBtn=qs('tabPayroll');
  const ov=qs('panelOverview'),  py=qs('panelPayroll');
  const set=(btn,panel,active)=>{ btn.classList.toggle('active',active); btn.setAttribute('aria-selected', String(active)); show(panel, active); };
  if (which==='payroll'){ set(pyBtn,py,true); set(ovBtn,ov,false); }
  else { set(ovBtn,ov,true); set(pyBtn,py,false); }
}
function wireTabs(){
  qs('tabOverview').addEventListener('click', ()=> switchTab('overview'));
  qs('tabPayroll').addEventListener('click',  ()=> switchTab('payroll'));
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
      .subscribe();
  }catch(err){ console.error('Realtime subscribe failed', err); }
}

window.addEventListener('beforeunload', () => {
  try { if (rtChannel) supabaseClient.removeChannel(rtChannel); } catch {}
});

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

  // Payroll wiring
  wirePayroll();
  wireCreatePeriodUI();
  wireLiveList();
await loadLiveNow();
startLiveTicker(1000); // change to 1000 if you want a per-second tick




  // Period actions
  qs('lockBtn').addEventListener('click', onLock);
  qs('unlockBtn').addEventListener('click', onUnlock);
  qs('exportBtn').addEventListener('click', onExport);   // <- NEW: export CSV

  // Initial data loads
  await loadSummary();
  await bootPayroll(); // loadPayroll() inside will call updatePeriodForSelectedWeek()
  bootRealtime();
  wireScheduleTab();
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
