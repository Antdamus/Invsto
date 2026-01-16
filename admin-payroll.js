/* =========================================================
   OG Jewelry — Admin Payroll (Biweekly periods, weekly OT)
   admin-payroll.js
   ---------------------------------------------------------
   This file is intentionally self-contained.

   It expects only:
   - supabaseClient (created by initSupabase.js)

   Everything else (date helpers, formatting, UI toasts) is defined locally
   so you can load this before/after admin.js without dependency loops.
   ========================================================= */

(function () {
  // ----- DOM
  const weekSelect = () => document.getElementById("payWeekSelect");
  const weekLabel  = () => document.getElementById("payWeekLabel");
  const prevBtn    = () => document.getElementById("payPrevBtn");
  const nextBtn    = () => document.getElementById("payNextBtn");

  const periodName = () => document.getElementById("periodName");
  const periodBadge = () => document.getElementById("periodBadge");
  const periodHint = () => document.getElementById("periodHint");

  const lockBtn    = () => document.getElementById("lockBtn");
  const unlockBtn  = () => document.getElementById("unlockBtn");
  const exportBtn  = () => document.getElementById("exportBtn");
  const createWeekBtn = () => document.getElementById("createWeekBtn");
  const newPeriodBtn  = () => document.getElementById("newPeriodBtn");

  const tbody      = () => document.getElementById("payTbody");

  const kReg = () => document.getElementById("payTotalReg");
  const kOt  = () => document.getElementById("payTotalOT");
  const kAll = () => document.getElementById("payTotalAll");

  // ----- Local helpers (keep payroll independent of admin.js)
  const pad2 = (n) => String(n).padStart(2, "0");
  
  function showPayrollError(title, message) {
  if (typeof window.showAdminError === "function") {
    window.showAdminError(title, message);
  } else {
    alert(`${title}\n\n${message}`);
  }
}

  function toISODate(d){
    const dt = (d instanceof Date) ? d : new Date(d);
    return `${dt.getFullYear()}-${pad2(dt.getMonth()+1)}-${pad2(dt.getDate())}`;
  }

  function addDays(date, n){
    const d = new Date(date);
    d.setDate(d.getDate() + Number(n || 0));
    return d;
  }

  function startOfWeekSun(date){
    const d = new Date(date);
    d.setHours(0,0,0,0);
    // JS: Sun=0..Sat=6
    const delta = d.getDay();
    d.setDate(d.getDate() - delta);
    return d;
  }

  // ---- Timezone helpers (to keep payroll boundaries consistent with org timezone)
  const ORG_TZ = 'America/New_York';

  function getTzOffsetStr(dateISO, tz = ORG_TZ) {
    // Get a stable UTC offset for the given local date.
    // We sample at 12:00Z to avoid DST transition hour edge cases.
    // Returns like "+05:00" or "-04:00".
    try {
      const d = new Date(`${dateISO}T12:00:00Z`);
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'shortOffset' });
      const part = fmt.formatToParts(d).find(p => p.type === 'timeZoneName')?.value || 'GMT';
      // Examples: "GMT-5", "GMT-05:00", "GMT+1"
      const m = part.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/i);
      if (!m) return '-05:00';
      const sign = m[1] === '+' ? '+' : '-';
      const hh = String(m[2]).padStart(2, '0');
      const mm = String(m[3] || '00').padStart(2, '0');
      return `${sign}${hh}:${mm}`;
    } catch {
      return '-05:00';
    }
  }

  function tzMidnightISO(dateISO, tz = ORG_TZ) {
    // Build an ISO timestamp string that represents local midnight in tz.
    const off = getTzOffsetStr(dateISO, tz);
    return `${dateISO}T00:00:00${off}`;
  }

  function localYMD(ts, tz = ORG_TZ) {
    const d = new Date(ts);
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(d);
    const get = (t) => parts.find(p => p.type === t)?.value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  }

  function weekStartKeyFromLocalYMD(ymd) {
    // Treat the ymd as a calendar date, compute Sunday start using UTC math.
    const [y, m, d] = ymd.split('-').map(n => parseInt(n, 10));
    const utc = Date.UTC(y, (m - 1), d);
    const dow = new Date(utc).getUTCDay(); // 0=Sun
    const sunUtc = utc - dow * 86400000;
    const sun = new Date(sunUtc);
    return `${sun.getUTCFullYear()}-${pad2(sun.getUTCMonth() + 1)}-${pad2(sun.getUTCDate())}`;
  }

  function addDaysISO(ymd, n) {
    // Date math in UTC so it’s not affected by the browser’s local timezone.
    const [y, m, d] = String(ymd).split('-').map(v => parseInt(v, 10));
    const utc = Date.UTC(y, (m - 1), d);
    const out = new Date(utc + (Number(n || 0) * 86400000));
    return `${out.getUTCFullYear()}-${pad2(out.getUTCMonth() + 1)}-${pad2(out.getUTCDate())}`;
  }

  function splitHoursByWeek(clockInIso, clockOutIso, tz = ORG_TZ) {
    // Industry-standard handling for weekly OT: allocate hours to the week(s)
    // where the work actually occurred. Shifts that cross midnight/week boundaries
    // are split at Sunday 00:00 (org week start) in the org/store timezone.
    //
    // Returns Map(weekStartISO -> hours)
    const start = new Date(clockInIso);
    const end = new Date(clockOutIso);
    const out = new Map();
    if (!(start instanceof Date) || !(end instanceof Date)) return out;
    if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime())) return out;
    if (end <= start) return out;

    let cursor = start;
    while (cursor < end) {
      const ymd = localYMD(cursor.toISOString(), tz);
      const wkStartISO = weekStartKeyFromLocalYMD(ymd);
      const wkEndISO = addDaysISO(wkStartISO, 7);

      const wkEndTs = new Date(tzMidnightISO(wkEndISO, tz));
      const segEnd = (wkEndTs < end) ? wkEndTs : end;

      const hrs = (segEnd.getTime() - cursor.getTime()) / 3600000;
      out.set(wkStartISO, safeHours(out.get(wkStartISO)) + safeHours(hrs));

      cursor = segEnd;
    }

    return out;
  }

  function fmtHours(hours){
    const h = Number(hours || 0);
    return (Math.round(h * 100) / 100).toFixed(2);
  }

  function showToast(msg, type){
    // If admin.js defines a fancy toast, use it. Otherwise fall back.
    if (typeof window.showToast === 'function') return window.showToast(msg, type);
    console[(type === 'error') ? 'error' : 'log']('[toast]', msg);
  }

  // ----- State
  let weekAnchor = startOfWeekSun(new Date()); // Sunday (org_week_start_dow() = 0)
  let payPeriodsCache = []; // for quick matching
  let currentPeriod = null; // matched to week

  // ----- Helpers
  function safeHours(n) {
    const x = Number(n);
    return Number.isFinite(x) ? x : 0;
  }

  function weekRangeLabel(sunDate) {
    const start = new Date(sunDate);
    const end = addDays(start, 6);
    return `${start.toLocaleDateString()} — ${end.toLocaleDateString()}`;
  }

  function weekKey(sunDate) {
    // "YYYY-MM-DD" for Sunday
    return toISODate(sunDate);
  }

  function setKpis(reg, ot) {
    const total = reg + ot;
    if (kReg()) kReg().textContent = fmtHours(reg);
    if (kOt())  kOt().textContent  = fmtHours(ot);
    if (kAll()) kAll().textContent = fmtHours(total);
  }

  function setPeriodUI(period) {
    currentPeriod = period || null;

    // DOM may not exist yet if the Payroll tab panel hasn't been rendered.
    // Fail safely instead of throwing and killing the whole boot sequence.
    if (!periodName() || !periodBadge() || !periodHint() || !lockBtn() || !unlockBtn() || !exportBtn() || !createWeekBtn()) {
      return;
    }

    if (!period) {
      periodName().textContent = "—";
      periodBadge().textContent = "—";
      periodBadge().className = "badge";
      periodHint().textContent = "No matching pay period. Create a biweekly period starting this week.";
      lockBtn().disabled = true;
      unlockBtn().disabled = true;
      exportBtn().disabled = true;
      createWeekBtn().disabled = false;
      return;
    }

    const status = period.status || "open";
    const nm = period.note?.trim() ? period.note.trim() : "Pay period";
    periodName().textContent = `${nm} (${period.start_date} → ${period.end_date})`;

    periodBadge().textContent = status.toUpperCase();
    periodBadge().className = `badge ${status === "locked" ? "badgedark" : ""}`;

    if (status === "locked") {
      periodHint().textContent = `Locked${period.locked_at ? ` at ${new Date(period.locked_at).toLocaleString()}` : ""}.`;
      lockBtn().disabled = true;
      unlockBtn().disabled = false;
      exportBtn().disabled = false;
      createWeekBtn().disabled = true;
    } else {
      periodHint().textContent = "Open period. Lock when payroll is finalized.";
      lockBtn().disabled = false;
      unlockBtn().disabled = true;
      exportBtn().disabled = false;
      createWeekBtn().disabled = true;
    }
  }

  function matchPeriodForWeek(sunDate) {
    // Week is Sun..Sat. Pay periods are date (no time), so compare by ISO date.
    const startISO = toISODate(sunDate);
    const endISO = toISODate(addDays(sunDate, 6));

    // Find a pay period that fully covers the week
    return payPeriodsCache.find(p =>
      p.start_date <= startISO && p.end_date >= endISO
    ) || null;
  }

  function periodLabel(period) {
    if (!period) return '—';
    const nm = period.note?.trim() ? period.note.trim() : 'Pay period';
    return `${nm} (${period.start_date} → ${period.end_date})`;
  }

  async function loadPayPeriods() {
    const { data, error } = await supabaseClient
      .from("pay_periods")
      .select("*")
      .order("start_date", { ascending: false });

    if (error) {
      console.error(error);
      showToast("Could not load pay periods.", "error");
      payPeriodsCache = [];
      return;
    }

    payPeriodsCache = data || [];
  }

  function buildWeekSelectAround(anchorSun) {
    // Build 16 weeks: 8 back, anchor, 7 forward
    const sel = weekSelect();
    if (!sel) return;

    sel.innerHTML = "";
    const items = [];

    for (let i = -8; i <= 7; i++) {
      const d = startOfWeekSun(addDays(anchorSun, i * 7));
      items.push(d);
    }

    for (const d of items) {
      const opt = document.createElement("option");
      opt.value = weekKey(d);
      opt.textContent = weekRangeLabel(d);
      sel.appendChild(opt);
    }

    sel.value = weekKey(anchorSun);
  }

  function setWeekUI(sunDate) {
    weekAnchor = startOfWeekSun(sunDate);
    if (weekLabel()) weekLabel().textContent = weekRangeLabel(weekAnchor);
    buildWeekSelectAround(weekAnchor);

    // match period based on cached periods
    const matched = matchPeriodForWeek(weekAnchor);
    setPeriodUI(matched);
  }

  // ----- Core query: weekly payroll totals per employee
  async function loadPayrollForSelection(sunDate) {
    // If a pay period covers this week, load the entire pay period,
    // but compute OT weekly (sum over the weeks inside the period).
    const matched = matchPeriodForWeek(sunDate);

    if (matched) {
      return loadPayPeriodPayroll(matched);
    }

    // Fallback: show a single week totals (still OT weekly) even if no period exists.
    return loadSingleWeekPayroll(sunDate);
  }

  async function loadSingleWeekPayroll(sunDate) {
    const startDateISO = toISODate(startOfWeekSun(sunDate));
    const endDateISO = toISODate(addDays(startOfWeekSun(sunDate), 7)); // exclusive by date

    const startTS = tzMidnightISO(startDateISO);
    const endTS = tzMidnightISO(endDateISO);

    if (tbody()) tbody().innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

    // Pull time_entries for the week with employee info
    // NOTE: this assumes clock_in is always set and clock_out may be null.
    // Pull CLOSED shifts that overlap the week window.
    // IMPORTANT: we cannot just filter by clock_in because shifts can cross midnight/week.
    const { data, error } = await supabaseClient
      .from("time_entries")
      .select(`
        id,
        employee_id,
        clock_in,
        clock_out,
        employees:employee_id (
          id,
          display_name,
          hourly_rate,
          active
        )
      `)
      .lt("clock_in", endTS)
      .not("clock_out", "is", null)
      .gte("clock_out", startTS);

    if (error) {
      console.error(error);
      showToast("Could not load payroll week.", "error");
      if (tbody()) tbody().innerHTML = `<tr><td colspan="4" class="muted">Error loading payroll.</td></tr>`;
      setKpis(0, 0);
      return;
    }

    const rows = data || [];

    // Aggregate hours per employee, splitting shifts at week boundary (Sun 00:00 local).
    const byEmp = new Map();

    for (const r of rows) {
      const emp = r.employees;
      if (!emp) continue;

      const inTs = new Date(r.clock_in).getTime();
      const outTs = new Date(r.clock_out).getTime();
      if (outTs <= inTs) continue;

      // Split shift across weeks and only take the portion that belongs to THIS selected week.
      const segs = splitHoursByWeek(r.clock_in, r.clock_out, ORG_TZ);
      const weekISO = startDateISO; // Sunday start
      const hours = safeHours(segs.get(weekISO));
      if (hours <= 0) continue;

      const key = emp.id;
      const prev = byEmp.get(key) || {
        employee_id: emp.id,
        display_name: emp.display_name || "—",
        hourly_rate: emp.hourly_rate,
        active: emp.active,
        total_hours: 0
      };

      prev.total_hours += hours;
      byEmp.set(key, prev);
    }

    // Split and sum
    const list = Array.from(byEmp.values())
      .sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""));

    let totalReg = 0;
    let totalOt = 0;

    const out = [];

    for (const e of list) {
      const total = safeHours(e.total_hours);
      const reg = Math.min(total, 40);
      const ot = Math.max(0, total - 40);

      totalReg += reg;
      totalOt += ot;

      out.push({ ...e, reg_hours: reg, ot_hours: ot });
    }

    setKpis(totalReg, totalOt);

    // Render
    if (!tbody()) return;

    if (!out.length) {
      tbody().innerHTML = `<tr><td colspan="4" class="muted">No shifts in this week.</td></tr>`;
      return;
    }

    tbody().innerHTML = out.map(e => `
      <tr>
        <td>${e.display_name}</td>
        <td>${fmtHours(e.reg_hours)}</td>
        <td>${fmtHours(e.ot_hours)}</td>
        <td><strong>${fmtHours(e.total_hours)}</strong></td>
      </tr>
    `).join("");
  }

  async function loadPayPeriodPayroll(period) {
    const startDateISO = period.start_date;
    const endExclusiveISO = toISODate(addDays(new Date(`${period.end_date}T00:00:00`), 1));

    const startTS = tzMidnightISO(startDateISO, period.timezone || ORG_TZ);
    const endTS = tzMidnightISO(endExclusiveISO, period.timezone || ORG_TZ);

    if (tbody()) tbody().innerHTML = `<tr><td colspan="4" class="muted">Loading…</td></tr>`;

    // Pull CLOSED shifts that overlap the pay period window.
    // (Shifts can start before the period and end inside, or start inside and end after.)
    const { data, error } = await supabaseClient
      .from("time_entries")
      .select(`
        id,
        employee_id,
        clock_in,
        clock_out,
        employees:employee_id (
          id,
          display_name,
          hourly_rate,
          active
        )
      `)
      .lt("clock_in", endTS)
      .not("clock_out", "is", null)
      .gte("clock_out", startTS);

    if (error) {
      console.error(error);
      showToast("Could not load payroll period.", "error");
      if (tbody()) tbody().innerHTML = `<tr><td colspan="4" class="muted">Error loading payroll.</td></tr>`;
      setKpis(0, 0);
      return;
    }

    const rows = data || [];

    // 1) Sum hours per employee per week (week defined in org/store timezone)
    // 2) Apply OT split for EACH week (40h cap), then sum across the period.
    const byEmp = new Map();

    for (const r of rows) {
      const emp = r.employees;
      if (!emp) continue;

      const inTs = new Date(r.clock_in).getTime();
      const outTs = new Date(r.clock_out).getTime();
      if (!Number.isFinite(inTs) || !Number.isFinite(outTs) || outTs <= inTs) continue;

      const tz = period.timezone || ORG_TZ;

      // Split shift hours across week boundaries (Sun 00:00 local) so weekly OT is correct,
      // even when a shift crosses midnight or a pay period spans multiple weeks.
      const wkMap = splitHoursByWeek(r.clock_in, r.clock_out, tz);

      const key = emp.id;
      const prev = byEmp.get(key) || {
        employee_id: emp.id,
        display_name: emp.display_name || "—",
        hourly_rate: emp.hourly_rate,
        active: emp.active,
        weeks: new Map() // wkKey -> hours
      };

      for (const [wk, hrs] of wkMap.entries()) {
        // Only count hours that fall within the pay-period window.
        // The overlap query already constrains rows, but a shift can extend beyond the period.
        // We clamp by splitting again at period bounds.
        const wkStartTs = new Date(tzMidnightISO(wk, tz));
        const wkEndTs = new Date(tzMidnightISO(addDaysISO(wk, 7), tz));

        const segStart = (wkStartTs < new Date(startTS)) ? new Date(startTS) : wkStartTs;
        const segEnd = (wkEndTs > new Date(endTS)) ? new Date(endTS) : wkEndTs;

        // If the week segment fully outside period, skip.
        if (segEnd <= segStart) continue;

        // hrs is the week-split for the whole shift; for shifts that cross the period edges,
        // we recompute the exact overlap for this week+period intersection.
        // (This avoids subtle off-by-1-hour issues around DST and boundaries.)
        const overlapStart = Math.max(new Date(r.clock_in).getTime(), segStart.getTime());
        const overlapEnd = Math.min(new Date(r.clock_out).getTime(), segEnd.getTime());
        const overlapHours = (overlapEnd - overlapStart) / 3600000;
        if (overlapHours <= 0) continue;

        prev.weeks.set(wk, safeHours(prev.weeks.get(wk)) + overlapHours);
      }
      byEmp.set(key, prev);
    }

    const list = Array.from(byEmp.values()).sort((a, b) => (a.display_name || "").localeCompare(b.display_name || ""));

    let totalReg = 0;
    let totalOt = 0;
    const out = [];

    for (const e of list) {
      let regSum = 0;
      let otSum = 0;
      let total = 0;

      for (const hrs of e.weeks.values()) {
        const wkTotal = safeHours(hrs);
        const wkReg = Math.min(wkTotal, 40);
        const wkOt = Math.max(0, wkTotal - 40);
        regSum += wkReg;
        otSum += wkOt;
        total += wkTotal;
      }

      totalReg += regSum;
      totalOt += otSum;
      out.push({
        employee_id: e.employee_id,
        display_name: e.display_name,
        hourly_rate: e.hourly_rate,
        active: e.active,
        reg_hours: regSum,
        ot_hours: otSum,
        total_hours: total
      });
    }

    setKpis(totalReg, totalOt);

    if (!tbody()) return;
    if (!out.length) {
      tbody().innerHTML = `<tr><td colspan="4" class="muted">No shifts in this pay period.</td></tr>`;
      return;
    }

    tbody().innerHTML = out.map(e => `
      <tr>
        <td>${e.display_name}</td>
        <td>${fmtHours(e.reg_hours)}</td>
        <td>${fmtHours(e.ot_hours)}</td>
        <td><strong>${fmtHours(e.total_hours)}</strong></td>
      </tr>
    `).join("");
  }

  // ----- Actions: create, lock, unlock, export
  async function createPeriodForCurrentWeek() {
    // Create a BIWEEKLY pay period starting at the selected week start.
    const startISO = toISODate(weekAnchor);

    const { data, error } = await supabaseClient
      .rpc('create_weekly_pay_period', {
        week_start: startISO,
        weeks: 2,
        p_timezone: ORG_TZ,
        p_note: 'Biweekly'
      });

    if (error) {
      console.error(error);
      showToast("Could not create period.", "error");
      return;
    }

    showToast("Biweekly pay period created.", "ok");
    await loadPayPeriods();
    setWeekUI(weekAnchor);
  }

  async function lockCurrentPeriod() {
    if (!currentPeriod) return;

    const { data, error } = await supabaseClient
      .rpc('payroll_lock_period', {
        _period_id: currentPeriod.id,
        _note: 'Locked from Admin UI',
        _force: false
      });

    if (error) {
  console.error(error);
  showPayrollError(
    "Payroll Cannot Be Locked",
    error.message || "One or more shifts are still pending approval."
  );
  return;
}

    showToast("Period locked.", "ok");
    await loadPayPeriods();
    setWeekUI(weekAnchor);
  }

  async function unlockCurrentPeriod() {
    if (!currentPeriod) return;

    const { data, error } = await supabaseClient
      .rpc('payroll_unlock_period', {
        _period_id: currentPeriod.id,
        _note: 'Unlocked from Admin UI'
      });

    if (error) {
      console.error(error);
      showToast("Could not unlock period.", "error");
      return;
    }

    showToast("Period unlocked.", "ok");
    await loadPayPeriods();
    setWeekUI(weekAnchor);
  }

  function exportCurrentWeekCsv() {
    // Export what’s currently rendered in the payroll table
    const tb = tbody();
    if (!tb) return;

    const rows = Array.from(tb.querySelectorAll("tr"));
    const csv = [["Worker", "Regular", "OT", "Total"]];

    for (const tr of rows) {
      const tds = Array.from(tr.querySelectorAll("td"));
      if (tds.length !== 4) continue;
      csv.push(tds.map(td => (td.textContent || "").trim()));
    }

    const blob = new Blob([csv.map(r => r.map(v => `"${v.replaceAll('"', '""')}"`).join(",")).join("\n")], {
      type: "text/csv;charset=utf-8"
    });

    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const periodPart = currentPeriod ? `${currentPeriod.start_date}_to_${currentPeriod.end_date}` : weekKey(weekAnchor);
    a.download = `payroll_${periodPart}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
  }

  // ----- Wiring
  function wire() {
    // week nav
    if (prevBtn()) prevBtn().addEventListener("click", async () => {
      setWeekUI(addDays(weekAnchor, -7));
      await loadPayrollForSelection(weekAnchor);
    });

    if (nextBtn()) nextBtn().addEventListener("click", async () => {
      setWeekUI(addDays(weekAnchor, 7));
      await loadPayrollForSelection(weekAnchor);
    });

    if (weekSelect()) weekSelect().addEventListener("change", async (e) => {
      const iso = e.target.value; // Sunday ISO date
      const d = new Date(`${iso}T00:00:00`);
      setWeekUI(d);
      await loadPayrollForSelection(weekAnchor);
    });

    // actions
    if (createWeekBtn()) createWeekBtn().addEventListener("click", createPeriodForCurrentWeek);
    if (lockBtn()) lockBtn().addEventListener("click", lockCurrentPeriod);
    if (unlockBtn()) unlockBtn().addEventListener("click", unlockCurrentPeriod);
    if (exportBtn()) exportBtn().addEventListener("click", exportCurrentWeekCsv);

    // "New custom period…" uses your existing create modal in admin.js.
    // We intentionally leave it to admin.js.
    if (newPeriodBtn()) newPeriodBtn().addEventListener("click", () => {
      // admin.js owns that modal; just trigger the button if it exists there
      const btn = document.getElementById("newPeriodBtn");
      if (btn) btn.blur();
      showToast("Use the custom period modal below (admin.js).", "info");
    });
  }

  // ----- Public entrypoint (called by admin.js when payroll tab is opened)
  window.initPayrollTab = async function initPayrollTab() {
    if (typeof supabaseClient === "undefined" || !supabaseClient) {
      console.error("supabaseClient not ready");
      showToast("Supabase not ready yet.", "error");
      return;
    }

    await loadPayPeriods();
    setWeekUI(weekAnchor);
    wire();
    await loadPayrollForSelection(weekAnchor);
  };
})();
