let gcMonthStart = null; // first day of the month being shown (Date)
let schedEmpId = null;
let schedWeekStart = startOfWeekSun(new Date());

function startOfWeekSun(d){
  const x = new Date(d);
  x.setHours(0,0,0,0);
  x.setDate(x.getDate() - x.getDay()); // Sunday start
  return x;
}

window.qs = window.qs || function(id){ return document.getElementById(id); };


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

// Only try v2 if you explicitly enabled it
const TRY_V2 = false;

if (TRY_V2){
  try {
    const { error: v2Err } = await supabaseClient.rpc('admin_set_override_v2', {
      ...base,
      _allow_any_store_in: anyIn,
      _allow_any_store_out: anyOut,
      _clock_in_store_id: inStore,
      _clock_out_store_id: outStore
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
  // If DB doesn’t support these columns, do nothing (prevents 400 spam)
  const ok = await detectOverrideExtrasSupport();
  if (!ok) return;

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

    if (error){
      // If the schema changed mid-session, disable and stop future patch attempts
      const msg = String(error.message || '');
      const code = String(error.code || '');

      const isMissingColumn =
        code === 'PGRST204' ||
        /schema cache/i.test(msg) ||
        /Could not find the .* column/i.test(msg) ||
        /column .* does not exist/i.test(msg);

      if (isMissingColumn){
        _overrideExtrasSupported = false;
        return;
      }

      console.warn('patchOverrideExceptionExtras update error:', error);
    }
  } catch (e){
    console.warn('patchOverrideExceptionExtras failed:', e);
  }
}

