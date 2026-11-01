/* Weekly timesheet on Admin > Overview. Keep totals and shift details on the same read. */
function initWeeklyHours({ client, getActiveEmployees, storeNameById, correctShift, manageShift }) {
  const zone = 'America/New_York';
  const paidBreakAllowance = 30 * 60000;
  // A selected Eastern midnight can fall partway through a store's local day.
  const breakLookback = 36 * 3600000;
  const rangeFormat = new Intl.DateTimeFormat(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
  const dayFormat = new Intl.DateTimeFormat(undefined, { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' });
  const timeFormat = new Intl.DateTimeFormat(undefined, { timeZone: zone, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  const today = () => TimeCorrection.localValue(Date.now(), zone).slice(0, 10);
  const preference = 'admin.hours.weekStartsOn';
  let startsOn = 0;
  try {
    const saved = localStorage.getItem(preference);
    if (/^[0-6]$/.test(saved)) startsOn = Number(saved);
  } catch { /* Storage can be unavailable in private browsing. */ }
  function weekContaining(anchor) {
    const start = dateStrAddDays(anchor, -((fromISO(anchor).getDay() - startsOn + 7) % 7));
    return { mode: 'week', start, end: dateStrAddDays(start, 6), anchor };
  }
  let period = weekContaining(today());
  let loadedPeriod = null;
  let workers = [];
  let request = 0;
  const list = qs('whWorkers');
  const expanded = new Set();
  list.addEventListener('toggle', event => {
    const row = event.target;
    if (!row.matches('.wh-worker')) return;
    if (!row.open) return expanded.delete(row.dataset.worker);
    expanded.add(row.dataset.worker);
    const body = row.querySelector('.wh-breakdown');
    if (!body.hasChildNodes()) {
      body.innerHTML = breakdown(workers.find(w => w.id === row.dataset.worker));
    }
  }, true);

  function rangeLabel() {
    return rangeFormat.formatRange(new Date(period.start), new Date(period.end));
  }

  // Include earlier shifts that may already have used the first store day's allowance.
  async function fetchEntries(start, end) {
    const entries = [];
    const pageSize = 500;
    for (let offset = 0; ; offset += pageSize) {
      const { data, error } = await client.from('time_entries')
        .select('id, employee_id, store_id, clock_in, clock_out, worker:employees!time_entries_employee_id_fkey(display_name), store:store_locations!time_entries_store_id_fkey(timezone), breaks:time_breaks!time_breaks_time_entry_id_fkey(started_at, ended_at)')
        .lt('clock_in', end)
        .or(`clock_out.gt.${new Date(Date.parse(start) - breakLookback).toISOString()},clock_out.is.null`)
        .order('clock_in').order('id').range(offset, offset + pageSize - 1);
      if (error) throw error;
      entries.push(...data);
      if (data.length < pageSize) return entries;
    }
  }

  function overlapMs(from, to, start, end) {
    return Math.max(0, Math.min(to, end) - Math.max(from, start));
  }

  // Find the first instant of the next store day, including DST changes at midnight.
  function endOfDaySegment(calendar, from, end, day) {
    if (calendar.format(end - 1) === day) return end;
    let low = from, high = end - 1;
    while (high - low > 1) {
      const mid = low + Math.floor((high - low) / 2);
      if (calendar.format(mid) === day) low = mid;
      else high = mid;
    }
    return high;
  }

  function allocateBreaks(entries, start, end, now) {
    const byShift = new Map();
    const timeline = [];
    for (const shift of entries) {
      const records = [];
      byShift.set(shift.id, records);
      const shiftEnd = shift.clock_out ? Date.parse(shift.clock_out) : now;
      let coveredUntil = Date.parse(shift.clock_in);
      const ordered = [...shift.breaks].sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at));
      for (const row of ordered) {
        const from = Date.parse(row.started_at);
        const to = row.ended_at ? Date.parse(row.ended_at) : null;
        const record = { from, to, paid: 0, unpaid: 0, asOf: to === null && !shift.clock_out ? now : null };
        records.push(record);
        // A missing end on a finished shift requires review. Never guess its duration.
        if (to === null && !record.asOf) continue;
        // Count overlapping legacy punches only once and only while clocked in.
        const begin = Math.max(from, coveredUntil, start - breakLookback);
        const finish = Math.min(to ?? now, shiftEnd, end);
        if (finish <= begin) continue;
        coveredUntil = finish;
        timeline.push({ begin, finish, shift, record });
      }
    }

    const remaining = new Map();
    const calendars = new Map();
    timeline.sort((a, b) => a.begin - b.begin);
    for (const { begin, finish, shift, record } of timeline) {
      const tz = shift.store?.timezone || zone;
      if (!calendars.has(tz)) calendars.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz }));
      const calendar = calendars.get(tz);
      for (let cursor = begin; cursor < finish;) {
        const day = calendar.format(cursor);
        const stop = endOfDaySegment(calendar, cursor, finish, day);
        const key = `${shift.employee_id}/${shift.store_id || ''}/${day}`;
        const available = remaining.get(key) ?? paidBreakAllowance;
        // Midnight renews the daily allowance, but a single long break still
        // has only its first 30 minutes eligible, including before this range.
        const eligible = Math.max(0, Math.min(stop, record.from + paidBreakAllowance) - cursor);
        const paid = Math.min(eligible, available);
        remaining.set(key, available - paid);
        record.paid += overlapMs(cursor, cursor + paid, start, end);
        record.unpaid += overlapMs(cursor + paid, stop, start, end);
        cursor = stop;
      }
    }
    return byShift;
  }

  function buildWorkers(roster, entries, start, end) {
    const workerRow = (id, name) => ({ id, name: name || 'Unnamed worker', shifts: [], duration: 0 });
    const byId = new Map(roster.map(e => [e.id, workerRow(e.id, e.display_name)]));
    const now = Date.now();
    const breaksByShift = allocateBreaks(entries, start, end, now);
    for (const shift of entries) {
      const clockIn = Date.parse(shift.clock_in);
      const clockOut = shift.clock_out ? Date.parse(shift.clock_out) : now;
      const overlap = Math.min(clockOut, end) - Math.max(clockIn, start);
      if (overlap <= 0) continue;
      const worker = byId.get(shift.employee_id) || workerRow(shift.employee_id, shift.worker?.display_name);
      byId.set(worker.id, worker);
      const breaks = breaksByShift.get(shift.id);
      const unpaid = breaks.reduce((sum, b) => sum + b.unpaid, 0);
      const duration = shift.clock_out ? Math.max(0, overlap - unpaid) : 0;
      worker.duration += duration;
      worker.shifts.push({ ...shift, breaks, duration, gross: overlap, split: clockIn < start || clockOut > end });
    }
    return [...byId.values()].sort((a, b) => b.duration - a.duration || b.shifts.length - a.shifts.length || a.name.localeCompare(b.name));
  }

  function breakMinutes(ms) {
    if (ms > 0 && ms < 60000) return '<1 min';
    return `${Math.round(ms / 60000)} min`;
  }

  function breakInfo(shift) {
    if (!shift.breaks.length) return '<div class="wh-break-note">No breaks recorded</div>';
    const shiftDay = dayFormat.format(new Date(shift.clock_in));
    const stamp = ms => (dayFormat.format(ms) === shiftDay ? '' : dayFormat.format(ms) + ' · ') + timeFormat.format(ms);
    const rows = shift.breaks.map(b => {
      let detail, endLabel;
      if (b.to === null && !b.asOf) {
        endLabel = 'End missing';
        detail = 'Needs review · no deduction calculated';
      } else {
        endLabel = b.asOf ? `In progress at ${timeFormat.format(b.asOf)}` : stamp(b.to);
        const duration = b.paid + b.unpaid;
        detail = duration > 0
          ? `${breakMinutes(duration)}${shift.split ? ' in selected dates' : ''} · ${breakMinutes(b.paid)} paid · ${breakMinutes(b.unpaid)} unpaid`
          : 'No break time counted in these dates';
      }
      return `<li><span>${stamp(b.from)} → ${endLabel}</span><span>${escapeHtml(detail)}</span></li>`;
    }).join('');
    return `<div class="wh-break-info"><strong>${shift.breaks.length === 1 ? 'Break' : 'Breaks'}</strong><ul>${rows}</ul></div>`;
  }

  function shiftRow(shift) {
    const start = new Date(shift.clock_in);
    const end = shift.clock_out && new Date(shift.clock_out);
    const crossesDay = end && dayFormat.format(start) !== dayFormat.format(end);
    const outLabel = end ? (crossesDay ? dayFormat.format(end) + ' · ' : '') + timeFormat.format(end) : 'Still clocked in';
    const store = storeNameById(shift.store_id);
    return `<li class="wh-shift">
      <div><strong>${dayFormat.format(start)}</strong>
        <span>${timeFormat.format(start)} → ${outLabel}</span>
        ${store ? `<small>${escapeHtml(store)}</small>` : ''}
      </div>
      <div class="wh-shift-hours"><strong>${end ? fmtDurationHM(shift.duration) : 'Open'}</strong>
        ${shift.split && end ? '<small>in selected dates</small>' : ''}
        ${end && shift.duration !== shift.gross ? `<small>of ${fmtDurationHM(shift.gross)} clocked</small>` : ''}
      </div>
      <div class="wh-shift-actions">
        <button class="btn small" type="button" data-wh-correct="${escapeHtml(shift.id)}">Correct time</button>
        ${end ? '' : `<button class="btn small" type="button" data-wh-close="${escapeHtml(shift.id)}">Close shift</button>`}
      </div>
      ${breakInfo(shift)}
    </li>`;
  }

  function breakdown({ shifts }) {
    const entries = shifts.length ? `<ul>${shifts.map(shiftRow).join('')}</ul>` :
      '<p class="wh-empty">No shifts recorded in these dates.</p>';
    return `${entries}<button type="button" class="btn small" data-wh-add>Add manual shift</button>`;
  }

  function workerDetails(worker) {
    const { id, name, duration, shifts } = worker;
    const open = shifts.filter(s => !s.clock_out).length;
    const count = shifts.length;
    return `<details class="wh-worker" data-worker="${escapeHtml(id)}" ${expanded.has(id) ? 'open' : ''}>
      <summary><span class="wh-identity"><strong>${escapeHtml(name)}</strong>
        <small>${count} shift${count === 1 ? '' : 's'}${open ? ` · ${open} open` : ''}</small></span>
        <strong class="wh-hours">${fmtDurationHM(duration)}</strong><span class="wh-chevron" aria-hidden="true">›</span>
      </summary>
      <div class="wh-breakdown">${expanded.has(id) ? breakdown(worker) : ''}</div>
    </details>`;
  }

  function renderWorkers() {
    if (loadedPeriod !== period) return;
    const search = qs('whSearch').value.trim().toLowerCase();
    const visible = workers.filter(w => w.name.toLowerCase().includes(search));
    const focused = document.activeElement;
    const focusedWorker = focused.closest('details')?.dataset.worker;
    list.innerHTML = visible.map(workerDetails).join('') ||
      `<p class="wh-empty">${search ? 'No workers match your search.' : 'No workers or shifts in these dates.'}</p>`;
    if (focusedWorker) {
      const row = list.querySelector(`[data-worker="${CSS.escape(focusedWorker)}"]`);
      const action = [...focused.attributes].find(attr => attr.name.startsWith('data-wh-'));
      const selector = action ? `[${action.name}="${CSS.escape(action.value)}"]` : 'summary';
      (row?.querySelector(selector) || row?.querySelector('summary'))?.focus({ preventScroll: true });
    }
  }

  async function load() {
    const current = ++request;
    const isWeek = period.mode === 'week';
    qs('whEyebrow').textContent = isWeek ? 'Weekly hours' : 'Custom date range';
    qs('whRange').textContent = rangeLabel();
    qs('whToday').disabled = isWeek && period.start === weekContaining(today()).start;
    for (const [id, direction] of [['whPrev', 'Previous'], ['whNext', 'Next']]) {
      const label = direction + (isWeek ? ' week' : ' date range');
      qs(id).title = label;
      qs(id).setAttribute('aria-label', label);
    }
    document.querySelectorAll('[data-wh-preset]').forEach(button =>
      button.setAttribute('aria-pressed', String(isWeek && Number(button.dataset.whPreset) === startsOn)));
    if (loadedPeriod !== period) {
      loadedPeriod = null;
      qs('whTotal').textContent = '—';
      qs('whShiftCount').textContent = '';
      list.innerHTML = '<p class="wh-empty" role="status">Loading shifts…</p>';
    }
    list.setAttribute('aria-busy', 'true');
    try {
      // Resolve both midnights independently so a DST week can be 167 or 169 hours.
      const start = TimeCorrection.toISO(period.start + 'T00:00', zone);
      const end = TimeCorrection.toISO(dateStrAddDays(period.end, 1) + 'T00:00', zone);
      const [roster, entries] = await Promise.all([getActiveEmployees(), fetchEntries(start, end)]);
      if (current !== request) return;
      workers = buildWorkers(roster, entries, Date.parse(start), Date.parse(end));
      loadedPeriod = period;
      const closed = workers.reduce((n, w) => n + w.shifts.filter(s => s.clock_out).length, 0);
      qs('whTotal').textContent = fmtDurationHM(workers.reduce((sum, w) => sum + w.duration, 0));
      qs('whShiftCount').textContent = `${closed} closed shift${closed === 1 ? '' : 's'}`;
      renderWorkers();
    } catch (err) {
      if (current !== request) return;
      console.error('Weekly hours:', err);
      loadedPeriod = null;
      qs('whTotal').textContent = '—';
      qs('whShiftCount').textContent = '';
      list.innerHTML = '<p class="wh-empty" role="alert">Couldn’t load hours for these dates. <button class="btn small" type="button" data-wh-retry>Try again</button></p>';
    } finally {
      if (current === request) list.setAttribute('aria-busy', 'false');
    }
  }

  const settings = qs('whDateSettings');
  function closeSettings() {
    settings.hidden = true;
    qs('whSetDates').setAttribute('aria-expanded', 'false');
  }
  function selectPeriod(next) {
    closeSettings();
    period = next;
    return load();
  }
  function selectWeek(anchor, weekday) {
    startsOn = weekday;
    try { localStorage.setItem(preference, String(startsOn)); } catch { /* Session-only preference. */ }
    return selectPeriod(weekContaining(anchor));
  }
  function step(direction) {
    const days = direction * ((Date.parse(period.end) - Date.parse(period.start)) / 86400000 + 1);
    selectPeriod({ ...period, start: dateStrAddDays(period.start, days),
      end: dateStrAddDays(period.end, days), anchor: dateStrAddDays(period.anchor, days) });
  }
  qs('whPrev').addEventListener('click', () => step(-1));
  qs('whNext').addEventListener('click', () => step(1));
  qs('whToday').addEventListener('click', () => selectPeriod(weekContaining(today())));
  document.querySelectorAll('[data-wh-preset]').forEach(button =>
    button.addEventListener('click', () => selectWeek(period.anchor, Number(button.dataset.whPreset))));

  function showDateFields() {
    const custom = settings.elements.whPeriod.value === 'custom';
    qs('whWeekFields').hidden = custom;
    qs('whCustomFields').hidden = !custom;
    qs('whDate').disabled = custom;
    qs('whStartDay').disabled = custom;
    qs('whFrom').disabled = !custom;
    qs('whTo').disabled = !custom;
    qs('whTo').min = qs('whFrom').value;
  }
  qs('whSetDates').addEventListener('click', () => {
    if (!settings.hidden) return closeSettings();
    settings.elements.whPeriod.value = period.mode;
    qs('whStartDay').value = String(startsOn);
    qs('whDate').value = period.anchor;
    qs('whFrom').value = period.start;
    qs('whTo').value = period.end;
    showDateFields();
    settings.hidden = false;
    qs('whSetDates').setAttribute('aria-expanded', 'true');
    settings.querySelector(':checked').focus();
  });
  settings.addEventListener('input', showDateFields);
  function cancelDates() { closeSettings(); qs('whSetDates').focus(); }
  qs('whCancelDates').addEventListener('click', cancelDates);
  settings.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); cancelDates(); }
  });
  settings.addEventListener('submit', e => {
    e.preventDefault();
    if (settings.elements.whPeriod.value === 'week') {
      selectWeek(qs('whDate').value, Number(qs('whStartDay').value));
    } else {
      const start = qs('whFrom').value;
      selectPeriod({ mode: 'custom', start, end: qs('whTo').value, anchor: start });
    }
    qs('whSetDates').focus();
  });
  qs('whSearch').addEventListener('input', renderWorkers);
  list.addEventListener('click', e => {
    if (e.target.closest('[data-wh-retry]')) return load();
    const row = e.target.closest('[data-worker]');
    if (!row) return;
    const worker = workers.find(w => w.id === row.dataset.worker);
    const correction = e.target.closest('[data-wh-correct]');
    if (correction) return correctShift(correction.dataset.whCorrect, worker.name);
    const close = e.target.closest('[data-wh-close]');
    if (!close && !e.target.closest('[data-wh-add]')) return;
    const context = { employeeId: worker.id, displayName: worker.name, periodStart: period.start, periodEnd: period.end, periodLabel: rangeLabel() };
    if (close) return manageShift('close', worker.shifts.find(s => s.id === close.dataset.whClose), context);
    manageShift('manual', null, context);
  });
  return { load };
}
