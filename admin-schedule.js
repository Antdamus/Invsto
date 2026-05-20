let gcMonthStart = null; // first day of the month being shown (Date)
let schedEmpId = null;
let schedWeekStart = startOfWeekSun(new Date());
let schedEmployeesCache = [];
let scheduleWeekState = { resolvedByDate: new Map(), overridesByDate: new Map(), dayExceptionsByDate: new Map() };
let scheduleFlowState = {
  selectedStoreId: '',
  selectedDayIndex: new Date().getDay(),
  assignmentType: 'store_work',
  workerSearch: '',
  syncEffectiveFromToWeek: true,
  saving: false
};
let scheduleSaveBusy = false;
let scheduleSaveModalResolve = null;
let scheduleSaveModalHideTimer = null;

function startOfWeekSun(d){
  const x = new Date(d);
  x.setHours(0,0,0,0);
  x.setDate(x.getDate() - x.getDay()); // Sunday start
  return x;
}

window.qs = window.qs || function(id){ return document.getElementById(id); };

// ---- Global Calendar cache (so click uses EXACT same data as render) ----
window.__gcCache = window.__gcCache || {
  monthStartISO: null,
  gridStartISO: null,
  gridEndISO: null,
  rows: []
};

async function markAcceptedIfNeeded() {
  try {
    const { data: { user } } = await supabaseClient.auth.getUser();
    if (!user) return;
    await supabaseClient.rpc('mark_invite_accepted');
  } catch (e) {
    console.warn('mark_invite_accepted failed:', e);
  }
}


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
    cell.dataset.workDate = iso;


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

    // ✅ cache what we rendered (desktop + mobile click will use this)
    window.__gcCache = {
      monthStartISO: toISODate(gcMonthStart),
      gridStartISO: toISODate(gridStart),
      gridEndISO: toISODate(gridEnd),
      rows: rows || []
    };

    renderGlobalCalendar(rows, gridStart, gcMonthStart);
  } catch (err){
    console.error(err);
    const grid = qs('globalCalGrid');
    if (grid) grid.innerHTML = `<div class="muted" style="grid-column:1/-1; padding:10px;">Failed to load global calendar.</div>`;
  }
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

async function fetchWeekDayExceptions(employeeId, weekStart){
  const startISO = toISODate(weekStart);
  const endISO = toISODate(addDays(weekStart, 6));

  const { data, error } = await supabaseClient
    .from('timeclock_day_exceptions')
    .select('work_date, allow_clock_in_any_store, clock_in_store_id, allow_clock_out_any_store, clock_out_store_id, allowed_clock_in_store_ids, allowed_clock_out_store_ids, note')
    .eq('employee_id', employeeId)
    .gte('work_date', startISO)
    .lte('work_date', endISO);

  if (error) {
    console.warn('Could not load timeclock day exceptions:', error);
    return new Map();
  }

  const map = new Map();
  for (const r of (data || [])){
    map.set(String(r.work_date).slice(0, 10), r);
  }
  return map;
}

function escSched(value){
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function scheduleTypeLabel(type = scheduleFlowState.assignmentType){
  return type === 'live_show' ? 'Live show session' : 'Store work hours';
}

function scheduleTypeNote(){
  return `[OG schedule type: ${scheduleFlowState.assignmentType}] ${scheduleTypeLabel()}`;
}

function scheduleAssignmentTypeFromNote(note = ''){
  const text = String(note || '');
  if (/\[OG schedule type:\s*live_show\]/i.test(text)) return 'live_show';
  if (/\[OG schedule type:\s*store_work\]/i.test(text)) return 'store_work';
  return '';
}

function selectedScheduleStoreId(){
  return scheduleFlowState.selectedStoreId || qs(`recStore-${scheduleFlowState.selectedDayIndex}`)?.value || '';
}

function selectedScheduleEmployee(){
  return schedEmployeesCache.find((employee) => String(employee.id) === String(schedEmpId)) || null;
}

function renderScheduleWorkerPicker(){
  const grid = qs('schedWorkerGrid');
  if (!grid) return;
  const q = String(scheduleFlowState.workerSearch || '').trim().toLowerCase();
  const rows = q
    ? schedEmployeesCache.filter((employee) => String(employee.display_name || '').toLowerCase().includes(q))
    : schedEmployeesCache;

  if (!rows.length){
    grid.innerHTML = `<div class="muted" style="padding:12px;">No workers match that search.</div>`;
    return;
  }

  grid.innerHTML = rows.map((employee) => {
    const active = String(employee.id) === String(schedEmpId) ? ' active' : '';
    return `
      <button type="button" class="schedule-pick-card${active}" data-sched-worker="${escSched(employee.id)}">
        <strong>${escSched(employee.display_name || 'Unnamed worker')}</strong>
        <span>${active ? 'Currently editing' : 'Tap to edit schedule'}</span>
      </button>
    `;
  }).join('');
}

function renderScheduleStorePicker(){
  const grid = qs('schedStoreGrid');
  if (!grid) return;
  const temp = document.createElement('select');
  temp.innerHTML = storeOptionsHTML(scheduleFlowState.selectedStoreId);
  const source = [...temp.options]
    .filter((option) => option.value)
    .map((option) => ({ id: option.value, name: option.textContent || 'Store' }));
  if (!source.length){
    grid.innerHTML = `<div class="muted" style="padding:12px;">No active stores are available.</div>`;
    return;
  }

  if (!scheduleFlowState.selectedStoreId) {
    scheduleFlowState.selectedStoreId = source[0]?.id || '';
  }

  grid.innerHTML = source.map((store) => {
    const active = String(store.id) === String(scheduleFlowState.selectedStoreId) ? ' active' : '';
    return `
      <button type="button" class="schedule-store-card${active}" data-sched-store="${escSched(store.id)}">
        <strong>${escSched(store.name || 'Store')}</strong>
        <span>Schedule location</span>
      </button>
    `;
  }).join('');
}

function syncScheduleFlowDates(){
  const weekDate = qs('schedFlowWeekDate');
  const effFrom = qs('schedFlowEffFrom');
  const syncBox = qs('schedFlowEffSync');
  const label = qs('schedFlowWeekLabel');
  const weekISO = toISODate(schedWeekStart);
  if (weekDate) weekDate.value = weekISO;
  if (syncBox) syncBox.checked = !!scheduleFlowState.syncEffectiveFromToWeek;
  if (effFrom) {
    if (scheduleFlowState.syncEffectiveFromToWeek || !effFrom.value) {
      effFrom.value = weekISO;
    }
    effFrom.disabled = !!scheduleFlowState.syncEffectiveFromToWeek;
  }
  if (qs('schedEffFrom')) qs('schedEffFrom').value = effFrom?.value || weekISO;
  if (label) label.textContent = weekLabel(schedWeekStart);
}

function setScheduleType(type){
  scheduleFlowState.assignmentType = type === 'live_show' ? 'live_show' : 'store_work';
  document.querySelectorAll('#panelSchedule [data-sched-type]').forEach((button) => {
    button.classList.toggle('active', button.dataset.schedType === scheduleFlowState.assignmentType);
  });
  renderScheduleDayDetail();
}

function renderScheduleDayPicker(){
  const picker = qs('schedDayPicker');
  if (!picker) return;
  picker.innerHTML = '';
  for (let i = 0; i < 7; i++){
    const day = addDays(schedWeekStart, i);
    const iso = toISODate(day);
    const resolved = scheduleWeekState.resolvedByDate.get(iso) || null;
    const ov = scheduleWeekState.overridesByDate.get(iso) || null;
    const active = i === scheduleFlowState.selectedDayIndex ? ' active' : '';
    const time = resolved ? `${fmtTimeHM(resolved.start_ts)}-${fmtTimeHM(resolved.end_ts)}` : 'No assignment';
    const source = ov?.off ? 'Off this week' : (resolved?.source || 'Open');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `schedule-day-card${active}`;
    button.dataset.schedDay = String(i);
    button.innerHTML = `
      <strong>${DOW[i]} ${day.getMonth()+1}/${day.getDate()}</strong>
      <span>${escSched(time)}</span>
      <small>${escSched(source)}</small>
    `;
    picker.appendChild(button);
  }
}

function renderScheduleDayDetail(){
  const detail = qs('schedDayDetail');
  if (!detail) return;

  if (!schedEmpId){
    detail.innerHTML = `
      <div class="schedule-current-card">
        <h4>Choose a worker first</h4>
        <p>Select a worker above, then this panel will show the week, day, store, and schedule assignment options.</p>
      </div>
    `;
    return;
  }

  const i = scheduleFlowState.selectedDayIndex;
  const day = addDays(schedWeekStart, i);
  const iso = toISODate(day);
  const resolved = scheduleWeekState.resolvedByDate.get(iso) || null;
  const ov = scheduleWeekState.overridesByDate.get(iso) || null;
  const dayException = scheduleWeekState.dayExceptionsByDate.get(iso) || null;
  const employee = selectedScheduleEmployee();
  const storeId = selectedScheduleStoreId();
  const storeLabel = storeId ? storeNameById(storeId) : 'Choose a store';
  const resolvedStore = resolved?.store_id ? storeNameById(resolved.store_id) : '-';
  const resolvedTime = resolved ? `${fmtTimeHM(resolved.start_ts)}-${fmtTimeHM(resolved.end_ts)}` : 'Nothing assigned';
  const saveDisabled = scheduleFlowState.saving ? 'disabled' : '';
  const startValue = ov?.start_local ? String(ov.start_local).slice(0,5) : (resolved ? new Date(resolved.start_ts).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:false}) : '');
  const endValue = ov?.end_local ? String(ov.end_local).slice(0,5) : (resolved ? new Date(resolved.end_ts).toLocaleTimeString('en-CA',{hour:'2-digit',minute:'2-digit',hour12:false}) : '');
  const defaultRouteStoreId = storeId || resolved?.store_id || '';
  const clockInStores = Array.isArray(dayException?.allowed_clock_in_store_ids) && dayException.allowed_clock_in_store_ids.length
    ? dayException.allowed_clock_in_store_ids
    : [dayException?.clock_in_store_id || defaultRouteStoreId].filter(Boolean);
  const clockOutStores = Array.isArray(dayException?.allowed_clock_out_store_ids) && dayException.allowed_clock_out_store_ids.length
    ? dayException.allowed_clock_out_store_ids
    : [dayException?.clock_out_store_id || defaultRouteStoreId].filter(Boolean);
  const routeSummary = `${scheduleStoreNameList(clockInStores)} -> ${scheduleStoreNameList(clockOutStores)}`;
  const copyOptions = Array.from({ length: 7 }, (_, index) => {
    const sourceDay = addDays(schedWeekStart, index);
    const sourceIso = toISODate(sourceDay);
    const sourceResolved = scheduleWeekState.resolvedByDate.get(sourceIso) || null;
    const sourceOff = !!scheduleWeekState.overridesByDate.get(sourceIso)?.off;
    const label = `${DOW[index]} ${sourceDay.getMonth()+1}/${sourceDay.getDate()}${sourceOff ? ' - Off' : sourceResolved ? ` - ${fmtTimeHM(sourceResolved.start_ts)}-${fmtTimeHM(sourceResolved.end_ts)}` : ' - No assignment'}`;
    return `<option value="${index}" ${index === i ? 'disabled' : ''}>${escSched(label)}</option>`;
  }).join('');

  detail.innerHTML = `
    <div class="schedule-current-card">
      <h4>${escSched(DOW[i])} ${day.getMonth()+1}/${day.getDate()} for ${escSched(employee?.display_name || 'worker')}</h4>
      <p><strong>Currently assigned:</strong> ${escSched(resolvedTime)} ${resolved?.source ? `(${escSched(resolved.source)})` : ''}</p>
      <p><strong>Store:</strong> ${escSched(resolvedStore)} ${ov?.off ? '<span class="sched-pill ov">Off override</span>' : ''}</p>
      <p><strong>New assignment:</strong> ${escSched(scheduleTypeLabel())} at ${escSched(storeLabel)}</p>
      <p><strong>Clock route:</strong> ${escSched(routeSummary)}</p>
    </div>

    <div class="schedule-copy-card">
      <div>
        <span class="schedule-eyebrow">Copy Schedule</span>
        <h4>Use another day as the template</h4>
        <p>Copies the time, store, and assignment type into this editor. Review it, then save it for this week or as weekly recurring.</p>
      </div>
      <div class="schedule-copy-actions">
        <button type="button" class="btn ghost" data-sched-copy-offset="-1" ${i === 0 ? 'disabled' : ''}>Copy previous day</button>
        <button type="button" class="btn ghost" data-sched-copy-offset="1" ${i === 6 ? 'disabled' : ''}>Copy next day</button>
        <label>
          Copy specific day
          <select id="schedCopySourceDay">
            <option value="">Choose day...</option>
            ${copyOptions}
          </select>
        </label>
        <button type="button" class="btn ghost" id="schedCopySourceApply">Copy into editor</button>
      </div>
      <small id="schedCopyStatus" class="schedule-copy-status"></small>
    </div>

    <div class="schedule-day-form">
      <label>
        Start
        <input id="schedFlowStart" type="time" value="${escSched(startValue)}" />
      </label>
      <label>
        End
        <input id="schedFlowEnd" type="time" value="${escSched(endValue)}" />
      </label>
      <label>
        Store
        <select id="schedFlowStore">${storeOptionsHTML(storeId)}</select>
      </label>
      <label>
        Type
        <input value="${escSched(scheduleTypeLabel())}" readonly />
      </label>
    </div>

    <div class="schedule-route-card">
      <div>
        <span class="schedule-eyebrow">Multi-Store Route</span>
        <h4>Clock-in and clock-out stores</h4>
        <p>Use this when a worker starts in one store and ends in another. The timeclock will enforce these locations for this day.</p>
      </div>
      <div class="schedule-route-grid">
        <div class="schedule-route-store-list">
          <strong>Allowed clock-in stores</strong>
          ${renderScheduleStoreChecklist('schedFlowClockInStores', clockInStores)}
        </div>
        <div class="schedule-route-store-list">
          <strong>Allowed clock-out stores</strong>
          ${renderScheduleStoreChecklist('schedFlowClockOutStores', clockOutStores)}
        </div>
      </div>
    </div>

    <div class="schedule-day-actions">
      <button type="button" class="btn primary" id="schedFlowSaveOverride" ${saveDisabled}>Save this week only</button>
      <button type="button" class="btn" id="schedFlowSaveRecurring" ${saveDisabled}>Save weekly recurring</button>
      <button type="button" class="btn ghost" id="schedFlowMarkOff" ${saveDisabled}>Mark off this week</button>
      <button type="button" class="btn ghost" id="schedFlowClearOverride">Clear this week</button>
      <button type="button" class="btn ghost" id="schedFlowClearRecurring">Remove recurring</button>
    </div>
  `;
}

function renderScheduleFlow(){
  renderScheduleWorkerPicker();
  renderScheduleStorePicker();
  syncScheduleFlowDates();
  renderScheduleDayPicker();
  renderScheduleDayDetail();
}

function timeInputFromScheduleTimestamp(value){
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false });
}

function getScheduleCopySource(dayIndex){
  const sourceDay = addDays(schedWeekStart, dayIndex);
  const sourceIso = toISODate(sourceDay);
  const sourceResolved = scheduleWeekState.resolvedByDate.get(sourceIso) || null;
  const sourceOverride = scheduleWeekState.overridesByDate.get(sourceIso) || null;
  const sourceException = scheduleWeekState.dayExceptionsByDate.get(sourceIso) || null;

  if (sourceOverride?.off) {
    return {
      ok: false,
      message: `${DOW[dayIndex]} is marked off. Use "Mark off this week" if you want this day off too.`,
    };
  }

  if (!sourceResolved) {
    return {
      ok: false,
      message: `${DOW[dayIndex]} has no schedule to copy.`,
    };
  }

  return {
    ok: true,
    dayIndex,
    start: sourceOverride?.start_local ? String(sourceOverride.start_local).slice(0, 5) : timeInputFromScheduleTimestamp(sourceResolved.start_ts),
    end: sourceOverride?.end_local ? String(sourceOverride.end_local).slice(0, 5) : timeInputFromScheduleTimestamp(sourceResolved.end_ts),
    storeId: sourceOverride?.store_id || sourceResolved.store_id || '',
    clockInStoreIds: Array.isArray(sourceException?.allowed_clock_in_store_ids) && sourceException.allowed_clock_in_store_ids.length
      ? sourceException.allowed_clock_in_store_ids
      : [sourceException?.clock_in_store_id || sourceOverride?.store_id || sourceResolved.store_id].filter(Boolean),
    clockOutStoreIds: Array.isArray(sourceException?.allowed_clock_out_store_ids) && sourceException.allowed_clock_out_store_ids.length
      ? sourceException.allowed_clock_out_store_ids
      : [sourceException?.clock_out_store_id || sourceOverride?.store_id || sourceResolved.store_id].filter(Boolean),
    assignmentType: scheduleAssignmentTypeFromNote(sourceOverride?.note) || scheduleFlowState.assignmentType,
  };
}

function getScheduleStoreChoices(selectedIds = []){
  const selected = new Set((selectedIds || []).filter(Boolean).map(String));
  const temp = document.createElement('select');
  temp.innerHTML = storeOptionsHTML('');
  return [...temp.options]
    .filter((option) => option.value)
    .map((option) => ({ id: option.value, name: option.textContent || 'Store', checked: selected.has(String(option.value)) }));
}

function renderScheduleStoreChecklist(name, selectedIds = []){
  const stores = getScheduleStoreChoices(selectedIds);
  if (!stores.length) return `<div class="muted">No active stores are available.</div>`;
  return stores.map((store) => `
    <label class="schedule-route-store-chip">
      <input type="checkbox" name="${escSched(name)}" value="${escSched(store.id)}" ${store.checked ? 'checked' : ''} />
      <span>${escSched(store.name)}</span>
    </label>
  `).join('');
}

function getCheckedScheduleStoreIds(name){
  return [...document.querySelectorAll(`#panelSchedule input[name="${name}"]:checked`)]
    .map((input) => input.value)
    .filter(Boolean);
}

function scheduleStoreNameList(ids = []){
  const names = [...new Set((ids || []).filter(Boolean).map((id) => storeNameById(id)).filter(Boolean))];
  if (!names.length) return 'No store selected';
  if (names.length === 1) return names[0];
  return names.join(', ');
}

function scheduleModalById(id){
  return document.getElementById(id);
}

function ensureScheduleSaveModal(){
  if (scheduleModalById('scheduleSaveModal')) return;

  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div id="scheduleSaveBackdrop" class="schedule-save-backdrop hidden" aria-hidden="true"></div>
    <div id="scheduleSaveModal" class="schedule-save-modal hidden" role="dialog" aria-modal="true" aria-labelledby="scheduleSaveTitle">
      <div class="schedule-save-card">
        <button id="scheduleSaveClose" class="schedule-save-close" type="button" aria-label="Close">x</button>
        <div id="scheduleSaveMark" class="schedule-save-mark" aria-hidden="true">OK</div>
        <p id="scheduleSaveKicker" class="schedule-save-kicker">Schedule saved</p>
        <h3 id="scheduleSaveTitle">Schedule saved</h3>
        <p id="scheduleSaveMessage">The schedule was updated.</p>
        <div id="scheduleSaveDetails" class="schedule-save-details"></div>
        <div class="schedule-save-actions">
          <button id="scheduleSaveSecondary" class="btn ghost" type="button">Cancel</button>
          <button id="scheduleSavePrimary" class="btn primary" type="button">Done</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(wrap);

  scheduleModalById('scheduleSaveBackdrop')?.addEventListener('click', () => hideScheduleSaveModal('close'));
  scheduleModalById('scheduleSaveClose')?.addEventListener('click', () => hideScheduleSaveModal('close'));
  scheduleModalById('scheduleSaveSecondary')?.addEventListener('click', () => hideScheduleSaveModal('secondary'));
  scheduleModalById('scheduleSavePrimary')?.addEventListener('click', () => hideScheduleSaveModal('primary'));
  document.addEventListener('keydown', (event) => {
    const modal = scheduleModalById('scheduleSaveModal');
    if (event.key === 'Escape' && modal && !modal.classList.contains('hidden')) {
      hideScheduleSaveModal('close');
    }
  });
}

function hideScheduleSaveModal(result = 'close'){
  const backdrop = scheduleModalById('scheduleSaveBackdrop');
  const modal = scheduleModalById('scheduleSaveModal');
  if (scheduleSaveModalHideTimer) clearTimeout(scheduleSaveModalHideTimer);
  backdrop?.classList.remove('show');
  modal?.classList.remove('show');
  scheduleSaveModalHideTimer = setTimeout(() => {
    backdrop?.classList.add('hidden');
    modal?.classList.add('hidden');
    modal?.classList.remove('is-success', 'is-info', 'is-warning', 'is-danger');
    scheduleSaveModalHideTimer = null;
  }, 180);

  const resolver = scheduleSaveModalResolve;
  scheduleSaveModalResolve = null;
  if (resolver) resolver(result);
}

function showScheduleSaveModal({
  variant = 'success',
  kicker = 'Schedule saved',
  title = 'Schedule saved',
  message = '',
  details = [],
  primaryText = 'Done',
  secondaryText = '',
} = {}){
  ensureScheduleSaveModal();
  if (scheduleSaveModalHideTimer) {
    clearTimeout(scheduleSaveModalHideTimer);
    scheduleSaveModalHideTimer = null;
  }
  const backdrop = scheduleModalById('scheduleSaveBackdrop');
  const modal = scheduleModalById('scheduleSaveModal');
  const mark = scheduleModalById('scheduleSaveMark');
  const kickerEl = scheduleModalById('scheduleSaveKicker');
  const titleEl = scheduleModalById('scheduleSaveTitle');
  const messageEl = scheduleModalById('scheduleSaveMessage');
  const detailsEl = scheduleModalById('scheduleSaveDetails');
  const primary = scheduleModalById('scheduleSavePrimary');
  const secondary = scheduleModalById('scheduleSaveSecondary');

  modal?.classList.remove('is-success', 'is-info', 'is-warning', 'is-danger');
  modal?.classList.add(`is-${variant}`);
  if (mark) mark.textContent = variant === 'warning' || variant === 'danger' ? '!' : 'OK';
  if (kickerEl) kickerEl.textContent = kicker;
  if (titleEl) titleEl.textContent = title;
  if (messageEl) messageEl.textContent = message;
  if (primary) primary.textContent = primaryText || 'Done';
  if (secondary) {
    secondary.textContent = secondaryText || '';
    secondary.classList.toggle('hidden', !secondaryText);
  }
  if (detailsEl) {
    detailsEl.innerHTML = (details || [])
      .filter((item) => item && (item.value != null || item.text))
      .map((item) => {
        if (item.text) return `<div class="schedule-save-detail-full">${escSched(item.text)}</div>`;
        return `
          <div class="schedule-save-detail">
            <span>${escSched(item.label || '')}</span>
            <strong>${escSched(item.value || '')}</strong>
          </div>
        `;
      })
      .join('');
    detailsEl.classList.toggle('hidden', !detailsEl.innerHTML);
  }

  backdrop?.classList.remove('hidden');
  modal?.classList.remove('hidden');
  requestAnimationFrame(() => {
    backdrop?.classList.add('show');
    modal?.classList.add('show');
  });
  setTimeout(() => primary?.focus?.(), 80);

  return new Promise((resolve) => {
    scheduleSaveModalResolve = resolve;
  });
}

function setScheduleSaveBusy(on){
  scheduleSaveBusy = !!on;
  scheduleFlowState.saving = !!on;
  document
    .querySelectorAll('#panelSchedule button[id^="schedFlowSave"], #panelSchedule button[data-save-recurring], #panelSchedule button[data-save-override], #panelSchedule button[id="schedFlowMarkOff"]')
    .forEach((button) => {
      button.disabled = !!on;
      button.classList.toggle('is-saving', !!on);
    });
}

async function runScheduleSave(task){
  if (scheduleSaveBusy) {
    showScheduleSaveModal({
      variant: 'info',
      kicker: 'Schedule is saving',
      title: 'Already working on it',
      message: 'The previous schedule save is still finishing. Give it a moment before saving again.',
      primaryText: 'Got it'
    });
    return null;
  }

  setScheduleSaveBusy(true);
  try {
    return await task();
  } catch (err) {
    console.error('Schedule save failed:', err);
    const msg =
      err?.message ||
      err?.error_description ||
      (typeof err === 'string' ? err : 'The schedule could not be saved.');
    showScheduleSaveModal({
      variant: 'danger',
      kicker: 'Schedule failed',
      title: 'Schedule save failed',
      message: msg,
      primaryText: 'Done'
    });
    return null;
  } finally {
    setScheduleSaveBusy(false);
  }
}

function normalizeScheduleTime(value){
  return String(value || '').slice(0, 5);
}

function normalizeScheduleDate(value){
  return String(value || '').slice(0, 10);
}

function normalizeScheduleId(value){
  return value ? String(value) : '';
}

function normalizeScheduleNote(value){
  return String(value || '').trim();
}

function previousISODate(iso){
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - 1);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sameScheduleIdSet(a = [], b = []){
  const left = [...new Set((a || []).filter(Boolean).map(String))].sort();
  const right = [...new Set((b || []).filter(Boolean).map(String))].sort();
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function scheduleDraftSummary(draft){
  if (draft.off) return 'Off this week';
  const route = draft.allowedInStores || draft.allowedOutStores
    ? ` · Clock route: ${scheduleStoreNameList(draft.allowedInStores)} -> ${scheduleStoreNameList(draft.allowedOutStores)}`
    : '';
  return `${draft.start}-${draft.end} · ${storeNameById(draft.storeId)} · ${scheduleTypeLabel(draft.assignmentType)}${route}`;
}

function scheduleModalDetailsForDraft(draft){
  return [
    { label: 'Worker', value: draft.employeeName || selectedScheduleEmployee()?.display_name || 'Worker' },
    { label: 'When', value: draft.whenLabel || '' },
    { label: 'Schedule', value: scheduleDraftSummary(draft) },
  ];
}

function getRecurringDraft(weekday){
  const empId = schedEmpId;
  const start = normalizeScheduleTime(qs(`recStart-${weekday}`)?.value || '');
  const end = normalizeScheduleTime(qs(`recEnd-${weekday}`)?.value || '');
  const storeId = qs(`recStore-${weekday}`)?.value || '';
  const effFrom = qs('schedEffFrom')?.value || toISODate(new Date());
  const employee = selectedScheduleEmployee();
  return {
    empId,
    weekday,
    start,
    end,
    storeId,
    effFrom,
    note: scheduleTypeNote(),
    assignmentType: scheduleFlowState.assignmentType,
    employeeName: employee?.display_name || '',
    whenLabel: `${DOW[weekday]} weekly from ${effFrom}`
  };
}

function recurringRowSameAssignment(row, draft){
  return normalizeScheduleTime(row?.start_local) === draft.start &&
    normalizeScheduleTime(row?.end_local) === draft.end &&
    normalizeScheduleId(row?.store_id) === normalizeScheduleId(draft.storeId) &&
    normalizeScheduleNote(row?.note) === normalizeScheduleNote(draft.note);
}

function recurringRowCoversDate(row, iso){
  const effectiveFrom = normalizeScheduleDate(row?.effective_from);
  const effectiveTo = normalizeScheduleDate(row?.effective_to);
  return effectiveFrom <= iso && (!effectiveTo || effectiveTo >= iso);
}

async function fetchOverlappingRecurringRows(empId, weekday, effFrom){
  const { data, error } = await supabaseClient
    .from('work_schedules')
    .select('id, weekday, start_local, end_local, effective_from, effective_to, store_id, note, active')
    .eq('employee_id', empId)
    .eq('weekday', weekday)
    .eq('active', true)
    .or(`effective_to.is.null,effective_to.gte.${effFrom}`);

  if (error) throw error;
  return (data || []).filter((row) => !normalizeScheduleDate(row.effective_to) || normalizeScheduleDate(row.effective_to) >= effFrom);
}

async function closeRecurringRowsFromDate(empId, weekday, effFrom, excludeIds = []){
  const rows = await fetchOverlappingRecurringRows(empId, weekday, effFrom);
  if (!rows.length) return;

  const excluded = new Set((excludeIds || []).filter(Boolean).map(String));
  const dayBefore = previousISODate(effFrom);
  const toDelete = [];
  const capIds = [];

  for (const row of rows){
    if (excluded.has(String(row.id))) continue;
    const effectiveFrom = normalizeScheduleDate(row.effective_from);
    if (effectiveFrom >= effFrom) {
      toDelete.push(row.id);
    } else if (dayBefore < effectiveFrom) {
      toDelete.push(row.id);
    } else {
      capIds.push(row.id);
    }
  }

  if (capIds.length){
    const { error } = await supabaseClient
      .from('work_schedules')
      .update({ effective_to: dayBefore })
      .in('id', capIds);
    if (error) throw error;
  }

  if (toDelete.length){
    const { error } = await supabaseClient
      .from('work_schedules')
      .delete()
      .in('id', toDelete);
    if (error) throw error;
  }
}

function getOverrideDraft(workISO){
  const empId = schedEmpId;
  const off = !!qs(`ovOff-${workISO}`)?.checked;
  const start = off ? null : normalizeScheduleTime(qs(`ovStart-${workISO}`)?.value || '');
  const end = off ? null : normalizeScheduleTime(qs(`ovEnd-${workISO}`)?.value || '');
  const storeId = off ? '' : (qs(`ovStore-${workISO}`)?.value || '');
  const anyIn = !!qs(`ovAnyIn-${workISO}`)?.checked;
  const anyOut = !!qs(`ovAnyOut-${workISO}`)?.checked;
  const inStore = anyIn ? null : (qs(`ovInStore-${workISO}`)?.value || null);
  const outStore = anyOut ? null : (qs(`ovOutStore-${workISO}`)?.value || null);
  const allowedInStores = off ? [] : getCheckedScheduleStoreIds('schedFlowClockInStores');
  const allowedOutStores = off ? [] : getCheckedScheduleStoreIds('schedFlowClockOutStores');
  const employee = selectedScheduleEmployee();
  const dayDate = fromISO(workISO);

  return {
    empId,
    workISO,
    off,
    start,
    end,
    storeId,
    anyIn,
    anyOut,
    inStore,
    outStore,
    allowedInStores,
    allowedOutStores,
    note: off ? null : scheduleTypeNote(),
    assignmentType: scheduleFlowState.assignmentType,
    employeeName: employee?.display_name || '',
    whenLabel: `${DOW[dayDate.getDay()]} ${dayDate.getMonth() + 1}/${dayDate.getDate()}`
  };
}

function exceptionStoresForDay(dayException, type, fallbackStoreId = ''){
  const allowedKey = type === 'in' ? 'allowed_clock_in_store_ids' : 'allowed_clock_out_store_ids';
  const singleKey = type === 'in' ? 'clock_in_store_id' : 'clock_out_store_id';
  const allowed = Array.isArray(dayException?.[allowedKey]) ? dayException[allowedKey].filter(Boolean) : [];
  if (allowed.length) return allowed.map(String);
  if (dayException?.[singleKey]) return [String(dayException[singleKey])];
  return fallbackStoreId ? [String(fallbackStoreId)] : [];
}

function dayExceptionSameAsDraft(dayException, draft){
  if (draft.off) {
    return !dayException ||
      (!dayException.allow_clock_in_any_store &&
       !dayException.allow_clock_out_any_store &&
       !dayException.clock_in_store_id &&
       !dayException.clock_out_store_id &&
       !exceptionStoresForDay(dayException, 'in').length &&
       !exceptionStoresForDay(dayException, 'out').length);
  }

  const allowInSame = !!dayException?.allow_clock_in_any_store === !!draft.anyIn;
  const allowOutSame = !!dayException?.allow_clock_out_any_store === !!draft.anyOut;
  const inStores = draft.anyIn ? [] : exceptionStoresForDay(dayException, 'in', draft.storeId);
  const outStores = draft.anyOut ? [] : exceptionStoresForDay(dayException, 'out', draft.storeId);
  return allowInSame &&
    allowOutSame &&
    sameScheduleIdSet(inStores, draft.allowedInStores) &&
    sameScheduleIdSet(outStores, draft.allowedOutStores);
}

function overrideRowSameAsDraft(row, draft){
  if (!row) return false;
  if (!!row.off !== !!draft.off) return false;
  if (draft.off) return true;
  return normalizeScheduleTime(row.start_local) === draft.start &&
    normalizeScheduleTime(row.end_local) === draft.end &&
    normalizeScheduleId(row.store_id) === normalizeScheduleId(draft.storeId) &&
    normalizeScheduleNote(row.note) === normalizeScheduleNote(draft.note);
}

function resolvedScheduleSameAsDraft(row, draft){
  if (!row || draft.off) return false;
  return normalizeScheduleTime(new Date(row.start_ts).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })) === draft.start &&
    normalizeScheduleTime(new Date(row.end_ts).toLocaleTimeString('en-CA', { hour: '2-digit', minute: '2-digit', hour12: false })) === draft.end &&
    normalizeScheduleId(row.store_id) === normalizeScheduleId(draft.storeId);
}

function setScheduleCopyStatus(message = '', type = 'info'){
  const el = qs('schedCopyStatus');
  if (!el) return;
  el.textContent = message;
  el.classList.toggle('is-error', type === 'error');
  el.classList.toggle('is-success', type === 'success');
}

function copyScheduleSourceIntoEditor(dayIndex){
  const source = getScheduleCopySource(dayIndex);
  if (!source.ok) {
    setScheduleCopyStatus(source.message || 'Nothing to copy from that day.', 'error');
    return;
  }

  const start = qs('schedFlowStart');
  const end = qs('schedFlowEnd');
  const store = qs('schedFlowStore');

  if (start) start.value = source.start || '';
  if (end) end.value = source.end || '';
  if (store) store.value = source.storeId || '';

  scheduleFlowState.selectedStoreId = source.storeId || scheduleFlowState.selectedStoreId;
  setScheduleType(source.assignmentType || scheduleFlowState.assignmentType);

  const refreshedStart = qs('schedFlowStart');
  const refreshedEnd = qs('schedFlowEnd');
  const refreshedStore = qs('schedFlowStore');
  if (refreshedStart) refreshedStart.value = source.start || '';
  if (refreshedEnd) refreshedEnd.value = source.end || '';
  if (refreshedStore) refreshedStore.value = source.storeId || '';
  document.querySelectorAll('#panelSchedule input[name="schedFlowClockInStores"]').forEach((input) => {
    input.checked = source.clockInStoreIds.includes(input.value);
  });
  document.querySelectorAll('#panelSchedule input[name="schedFlowClockOutStores"]').forEach((input) => {
    input.checked = source.clockOutStoreIds.includes(input.value);
  });

  setScheduleCopyStatus(`Copied ${DOW[dayIndex]} into this day. Review it, then save.`, 'success');
}

function syncGuidedFieldsToHidden(){
  const i = scheduleFlowState.selectedDayIndex;
  const iso = toISODate(addDays(schedWeekStart, i));
  const start = qs('schedFlowStart')?.value || '';
  const end = qs('schedFlowEnd')?.value || '';
  const storeId = qs('schedFlowStore')?.value || selectedScheduleStoreId();
  const flowInStores = getCheckedScheduleStoreIds('schedFlowClockInStores');
  const flowOutStores = getCheckedScheduleStoreIds('schedFlowClockOutStores');
  const flowInStore = flowInStores[0] || storeId || '';
  const flowOutStore = flowOutStores[0] || storeId || '';
  const flowEffFrom = scheduleFlowState.syncEffectiveFromToWeek
    ? toISODate(schedWeekStart)
    : (qs('schedFlowEffFrom')?.value || '');
  if (flowEffFrom && qs('schedEffFrom')) qs('schedEffFrom').value = flowEffFrom;
  scheduleFlowState.selectedStoreId = storeId || scheduleFlowState.selectedStoreId;

  const recStart = qs(`recStart-${i}`);
  const recEnd = qs(`recEnd-${i}`);
  const recStore = qs(`recStore-${i}`);
  if (recStart) recStart.value = start;
  if (recEnd) recEnd.value = end;
  if (recStore) recStore.value = storeId || '';

  const ovOff = qs(`ovOff-${iso}`);
  const ovStart = qs(`ovStart-${iso}`);
  const ovEnd = qs(`ovEnd-${iso}`);
  const ovStore = qs(`ovStore-${iso}`);
  if (ovOff) ovOff.checked = false;
  if (ovStart) {
    ovStart.disabled = false;
    ovStart.value = start;
  }
  if (ovEnd) {
    ovEnd.disabled = false;
    ovEnd.value = end;
  }
  if (ovStore) {
    ovStore.disabled = false;
    ovStore.value = storeId || '';
  }

  const ovAnyIn = qs(`ovAnyIn-${iso}`);
  const ovAnyOut = qs(`ovAnyOut-${iso}`);
  const ovInStore = qs(`ovInStore-${iso}`);
  const ovOutStore = qs(`ovOutStore-${iso}`);
  if (ovAnyIn) ovAnyIn.checked = false;
  if (ovAnyOut) ovAnyOut.checked = false;
  if (ovInStore) {
    ovInStore.disabled = false;
    ovInStore.value = flowInStore || '';
  }
  if (ovOutStore) {
    ovOutStore.disabled = false;
    ovOutStore.value = flowOutStore || '';
  }

  const flowStore = qs('schedFlowStore');
  if (flowStore) flowStore.value = storeId || '';
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
    const dayException = scheduleWeekState.dayExceptionsByDate.get(iso) || null;
    const ovAnyIn  = !!dayException?.allow_clock_in_any_store;
    const ovAnyOut = !!dayException?.allow_clock_out_any_store;
    const ovInStore  = dayException?.clock_in_store_id ? String(dayException.clock_in_store_id) : (ovStore || resolved?.store_id || '');
    const ovOutStore = dayException?.clock_out_store_id ? String(dayException.clock_out_store_id) : (ovStore || resolved?.store_id || '');

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
  return runScheduleSave(async () => {
    const draft = getRecurringDraft(weekday);
    const empId = draft.empId;
    if (!empId) return alert('Choose a worker first.');

    if (!draft.start || !draft.end) return alert('Enter start and end time for recurring.');
    if (draft.end <= draft.start) return alert('End must be after start.');
    if (!draft.storeId) return alert('Pick a store for this recurring schedule.');

    await markAcceptedIfNeeded();

    const overlapping = await fetchOverlappingRecurringRows(empId, weekday, draft.effFrom);
    const openSame = overlapping.some((row) =>
      recurringRowCoversDate(row, draft.effFrom) &&
      !normalizeScheduleDate(row.effective_to) &&
      recurringRowSameAssignment(row, draft)
    );
    const futureDifferent = overlapping.some((row) =>
      !recurringRowSameAssignment(row, draft) ||
      (normalizeScheduleDate(row.effective_to) && normalizeScheduleDate(row.effective_to) >= draft.effFrom)
    );

    if (openSame && !futureDifferent) {
      showScheduleSaveModal({
        variant: 'info',
        kicker: 'Already applied',
        title: 'This weekly schedule is already set',
        message: 'No duplicate recurring schedule was created.',
        details: scheduleModalDetailsForDraft(draft),
        primaryText: 'Done'
      });
      await loadScheduleWeek();
      return;
    }

    if (overlapping.length) {
      const result = await showScheduleSaveModal({
        variant: 'warning',
        kicker: 'Replace recurring schedule',
        title: 'Change the existing weekly schedule?',
        message: 'There is already a recurring schedule for this worker and weekday. Replacing it will keep history before the selected start date, then apply this new schedule going forward.',
        details: scheduleModalDetailsForDraft(draft),
        primaryText: 'Replace schedule',
        secondaryText: 'Cancel'
      });
      if (result !== 'primary') return;
    }

    const { data: savedRecurring, error } = await supabaseClient.rpc('admin_set_weekday_slot', {
      _employee_id: empId,
      _weekday: weekday,
      _start_local: draft.start,
      _end_local: draft.end,
      _effective_from: draft.effFrom,
      _effective_to: null,
      _store_id: draft.storeId,
      _note: draft.note
    });

    if (error) return alert('Save failed: ' + error.message);
    if (overlapping.length) {
      const savedRecurringId = Array.isArray(savedRecurring) ? savedRecurring[0]?.id : savedRecurring?.id;
      if (!savedRecurringId) throw new Error('The new recurring schedule was saved, but the app could not confirm its row id to safely close the old schedule.');
      await closeRecurringRowsFromDate(empId, weekday, draft.effFrom, [savedRecurringId]);
    }
    await loadScheduleWeek();
    showScheduleSaveModal({
      variant: 'success',
      kicker: 'Recurring schedule saved',
      title: 'Weekly schedule updated',
      message: 'The worker schedule is now applied from the selected recurring start date.',
      details: scheduleModalDetailsForDraft(draft),
      primaryText: 'Done'
    });
  });
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

async function saveOverride(workISO){
  return runScheduleSave(async () => {
    const draft = getOverrideDraft(workISO);
    const empId = draft.empId;
    if (!empId) return alert('Choose a worker first.');

    if (!draft.off){
      if (!draft.start || !draft.end) return alert('Enter start and end time, or mark Off.');
      if (draft.end <= draft.start) return alert('End must be after start.');
      if (!draft.storeId) return alert('Pick a store for this override.');
      if (!draft.allowedInStores.length) return alert('Pick at least one allowed clock-in store.');
      if (!draft.allowedOutStores.length) return alert('Pick at least one allowed clock-out store.');
    }

    const existingOverride = scheduleWeekState.overridesByDate.get(workISO) || null;
    const existingResolved = scheduleWeekState.resolvedByDate.get(workISO) || null;
    const existingException = scheduleWeekState.dayExceptionsByDate.get(workISO) || null;
    const sameOverride = existingOverride &&
      overrideRowSameAsDraft(existingOverride, draft) &&
      dayExceptionSameAsDraft(existingException, draft);
    const sameResolved = !existingOverride &&
      (draft.off ? !existingResolved : resolvedScheduleSameAsDraft(existingResolved, draft)) &&
      dayExceptionSameAsDraft(existingException, draft);

    if (sameOverride || sameResolved) {
      showScheduleSaveModal({
        variant: 'info',
        kicker: 'Already applied',
        title: 'This schedule is already set',
        message: 'No duplicate one-week schedule was created.',
        details: scheduleModalDetailsForDraft(draft),
        primaryText: 'Done'
      });
      await loadScheduleWeek();
      return;
    }

    if (existingOverride || existingResolved) {
      const result = await showScheduleSaveModal({
        variant: 'warning',
        kicker: 'Replace this day',
        title: existingOverride ? 'Replace the one-week schedule?' : 'Create a one-week change?',
        message: existingOverride
          ? 'This worker already has a saved one-week schedule for this date. Replace it with the schedule below?'
          : 'This worker already has a resolved schedule for this date. Save this as a one-week change for that day?',
        details: scheduleModalDetailsForDraft(draft),
        primaryText: existingOverride ? 'Replace schedule' : 'Save one-week change',
        secondaryText: 'Cancel'
      });
      if (result !== 'primary') return;
    }

    await markAcceptedIfNeeded();

    // Base payload (existing RPC)
    const base = {
      _employee_id: empId,
      _work_date: workISO,
      _off: draft.off,
      _start_local: draft.start,
      _end_local: draft.end,
      _store_id: draft.off ? null : draft.storeId,
      _note: draft.off ? null : draft.note
    };

    // Try a v2 RPC first (if you created it in Supabase)
    // If not available, fall back to old RPC + patch DB columns directly.
    let usedV2 = false;

// Only try v2 if you explicitly enabled it
const TRY_V2 = false;

if (TRY_V2){
  try {
    const { error: v2Err } = await supabaseClient.rpc('admin_set_override_v2', {
      ...base,
      _allow_any_store_in: draft.anyIn,
      _allow_any_store_out: draft.anyOut,
      _clock_in_store_id: draft.inStore,
      _clock_out_store_id: draft.outStore
    });
    if (!v2Err) usedV2 = true;
  } catch (e){
    // ignore
  }
}


  if (!usedV2){
    const { error } = await supabaseClient.rpc('admin_set_override', base);
    if (error) return alert('Override failed: ' + error.message);

    // Patch exception columns (if present)
    await patchOverrideExceptionExtras(empId, workISO, {
      allow_any_store_in: draft.anyIn,
      allow_any_store_out: draft.anyOut,
      clock_in_store_id: draft.inStore,
      clock_out_store_id: draft.outStore,
      allowed_clock_in_store_ids: draft.off ? [] : draft.allowedInStores,
      allowed_clock_out_store_ids: draft.off ? [] : draft.allowedOutStores
    });
  }

  await loadScheduleWeek();
    showScheduleSaveModal({
      variant: 'success',
      kicker: 'Schedule saved',
      title: draft.off ? 'Worker marked off' : 'One-week schedule saved',
      message: draft.off
        ? 'This worker is marked off for the selected date.'
        : 'The schedule for this specific week was updated.',
      details: scheduleModalDetailsForDraft(draft),
      primaryText: 'Done'
    });
  });
}

async function clearOverride(workISO){
  if (!schedEmpId) return alert('Choose a worker first.');
  // Just delete the row; RLS allows admin writes
  const { error } = await supabaseClient
    .from('work_schedule_overrides')
    .delete()
    .eq('employee_id', schedEmpId)
    .eq('work_date', workISO);
  if (error) return alert('Clear failed: ' + error.message);
  await supabaseClient
    .from('timeclock_day_exceptions')
    .delete()
    .eq('employee_id', schedEmpId)
    .eq('work_date', workISO);
  await loadScheduleWeek();
}

async function loadScheduleWeek(){
  try {
    // UI labels
    qs('schedWeekLabel').textContent = weekLabel(schedWeekStart);
    qs('schedWeekDate').value = toISODate(schedWeekStart);
    syncScheduleFlowDates();

    if (!schedEmpId){
      scheduleWeekState = { resolvedByDate: new Map(), overridesByDate: new Map() };
      if (qs('schedBody')) qs('schedBody').innerHTML = `<tr><td colspan="4" class="muted">Choose a worker first.</td></tr>`;
      if (qs('schedCards')) qs('schedCards').innerHTML = '';
      renderScheduleFlow();
      return;
    }

    // data
    const [resolvedByDate, overridesByDate, dayExceptionsByDate] = await Promise.all([
      fetchResolvedWeek(schedEmpId, schedWeekStart),
      fetchWeekOverrides(schedEmpId, schedWeekStart),
      fetchWeekDayExceptions(schedEmpId, schedWeekStart)
    ]);

    scheduleWeekState = { resolvedByDate, overridesByDate, dayExceptionsByDate };
    renderScheduleGrid(schedWeekStart, resolvedByDate, overridesByDate);
    renderScheduleFlow();
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

async function initSchedulePanel(){
  // Ensure stores are loaded for dropdowns
  await ensureStoresCache();

  // employees
  const emps = await getActiveEmployees();
  schedEmployeesCache = emps || [];
  const sel = qs('schedEmpSelect');
  sel.innerHTML = `<option value="">Choose worker...</option>` + emps.map(e => `<option value="${e.id}">${e.display_name}</option>`).join('');
  schedEmpId = null;

  // defaults
  qs('schedEffFrom').value = toISODate(schedWeekStart);
  qs('schedWeekDate').value = toISODate(schedWeekStart);
  qs('schedFlowEffFrom').value = qs('schedEffFrom').value;
  qs('schedFlowWeekDate').value = qs('schedWeekDate').value;
  qs('schedFlowEffSync').checked = true;
  qs('schedFlowEffFrom').disabled = true;

qs('schedEmpSection').addEventListener('click', async (e) => {
  const btn = e.target.closest('button');
  if (!btn) return;

  if (btn.hasAttribute('data-sched-worker')){
    schedEmpId = btn.dataset.schedWorker || schedEmpId;
    if (sel) sel.value = schedEmpId;
    loadScheduleWeek();
  } else if (btn.hasAttribute('data-sched-store')){
    scheduleFlowState.selectedStoreId = btn.dataset.schedStore || '';
    renderScheduleFlow();
  } else if (btn.hasAttribute('data-sched-day')){
    scheduleFlowState.selectedDayIndex = Number(btn.dataset.schedDay || 0);
    renderScheduleFlow();
  } else if (btn.hasAttribute('data-sched-type')){
    setScheduleType(btn.dataset.schedType);
  } else if (btn.hasAttribute('data-sched-copy-offset')){
    const offset = Number(btn.dataset.schedCopyOffset || 0);
    copyScheduleSourceIntoEditor(scheduleFlowState.selectedDayIndex + offset);
  } else if (btn.id === 'schedCopySourceApply'){
    const sourceValue = qs('schedCopySourceDay')?.value || '';
    const sourceDay = Number(sourceValue);
    if (!sourceValue || !Number.isInteger(sourceDay) || sourceDay < 0 || sourceDay > 6) {
      setScheduleCopyStatus('Choose a source day first.', 'error');
      return;
    }
    copyScheduleSourceIntoEditor(sourceDay);
  } else if (btn.id === 'schedFlowSaveOverride'){
    syncGuidedFieldsToHidden();
    const iso = toISODate(addDays(schedWeekStart, scheduleFlowState.selectedDayIndex));
    await saveOverride(iso);
  } else if (btn.id === 'schedFlowSaveRecurring'){
    syncGuidedFieldsToHidden();
    await saveRecurring(scheduleFlowState.selectedDayIndex);
  } else if (btn.id === 'schedFlowMarkOff'){
    const iso = toISODate(addDays(schedWeekStart, scheduleFlowState.selectedDayIndex));
    const off = qs(`ovOff-${iso}`);
    if (off) off.checked = true;
    await saveOverride(iso);
  } else if (btn.id === 'schedFlowClearOverride'){
    const iso = toISODate(addDays(schedWeekStart, scheduleFlowState.selectedDayIndex));
    await clearOverride(iso);
  } else if (btn.id === 'schedFlowClearRecurring'){
    await clearRecurring(scheduleFlowState.selectedDayIndex);
  } else if (btn.hasAttribute('data-save-recurring')){
    const weekday = Number(btn.getAttribute('data-save-recurring'));
    await saveRecurring(weekday);
  } else if (btn.hasAttribute('data-clear-recurring')){
    const weekday = Number(btn.getAttribute('data-clear-recurring'));
    await clearRecurring(weekday);
  } else if (btn.hasAttribute('data-save-override')){
    const iso = btn.getAttribute('data-save-override');
    await saveOverride(iso);
  } else if (btn.hasAttribute('data-clear-override')){
    const iso = btn.getAttribute('data-clear-override');
    await clearOverride(iso);
  }
});

qs('schedEmpSection').addEventListener('change', (e) => {
  const id = e.target?.id || '';

  if (id === 'schedWorkerSearch'){
    scheduleFlowState.workerSearch = e.target.value || '';
    renderScheduleWorkerPicker();
    return;
  }

  if (id === 'schedFlowEffFrom'){
    const hidden = qs('schedEffFrom');
    if (hidden) hidden.value = e.target.value || toISODate(new Date());
    return;
  }

  if (id === 'schedFlowEffSync'){
    scheduleFlowState.syncEffectiveFromToWeek = !!e.target.checked;
    syncScheduleFlowDates();
    return;
  }

  if (id === 'schedFlowWeekDate'){
    const d = fromISO(e.target.value);
    schedWeekStart = startOfWeekSun(d);
    qs('schedWeekDate').value = toISODate(schedWeekStart);
    loadScheduleWeek();
    return;
  }

  if (id === 'schedFlowStore'){
    scheduleFlowState.selectedStoreId = e.target.value || '';
    renderScheduleStorePicker();
    renderScheduleDayDetail();
    return;
  }

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

qs('schedEmpSection').addEventListener('input', (e) => {
  if (e.target?.id === 'schedWorkerSearch'){
    scheduleFlowState.workerSearch = e.target.value || '';
    renderScheduleWorkerPicker();
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

  qs('schedFlowPrev')?.addEventListener('click', async () => {
    schedWeekStart = addDays(schedWeekStart, -7);
    qs('schedWeekDate').value = toISODate(schedWeekStart);
    await loadScheduleWeek();
  });

  qs('schedFlowNext')?.addEventListener('click', async () => {
    schedWeekStart = addDays(schedWeekStart, 7);
    qs('schedWeekDate').value = toISODate(schedWeekStart);
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

// ---- Capability flag: do we have Phase 3 override exception columns in DB? ----
// null = unknown, true/false = known
let _overrideExtrasSupported = null;

async function detectOverrideExtrasSupport(){
  if (_overrideExtrasSupported !== null) return _overrideExtrasSupported;

  try {
    // Probe: ask PostgREST for the columns (limit 1 so it’s cheap)
    const { error } = await supabaseClient
      .from('work_schedule_overrides')
      .select('allow_any_store_in,allow_any_store_out,clock_in_store_id,clock_out_store_id')
      .limit(1);

    if (error){
      const msg = String(error.message || '');
      const code = String(error.code || '');

      // Missing column / schema cache -> feature not present
      if (
        code === 'PGRST204' ||
        /schema cache/i.test(msg) ||
        /Could not find the .* column/i.test(msg) ||
        /column .* does not exist/i.test(msg)
      ){
        _overrideExtrasSupported = false;
        return _overrideExtrasSupported;
      }

      // Other errors (RLS, etc.) — assume not supported so we stop spamming network
      console.warn('detectOverrideExtrasSupport probe error:', error);
      _overrideExtrasSupported = false;
      return _overrideExtrasSupported;
    }

    _overrideExtrasSupported = true;
    return _overrideExtrasSupported;
  } catch (e){
    console.warn('detectOverrideExtrasSupport failed:', e);
    _overrideExtrasSupported = false;
    return _overrideExtrasSupported;
  }
}

async function patchOverrideExceptionExtras(empId, workISO, extras){
  const patch = {
    employee_id: empId,
    work_date: workISO,
    allow_clock_in_any_store: !!extras.allow_any_store_in,
    allow_clock_out_any_store: !!extras.allow_any_store_out,
    clock_in_store_id: extras.clock_in_store_id || null,
    clock_out_store_id: extras.clock_out_store_id || null,
    allowed_clock_in_store_ids: extras.allowed_clock_in_store_ids || [],
    allowed_clock_out_store_ids: extras.allowed_clock_out_store_ids || [],
    note: 'Schedule multi-store route'
  };

  try {
    const { error } = await supabaseClient
      .from('timeclock_day_exceptions')
      .upsert(patch, { onConflict: 'employee_id,work_date' });

    if (error) console.warn('patchOverrideExceptionExtras update error:', error);
  } catch (e){
    console.warn('patchOverrideExceptionExtras failed:', e);
  }
}



