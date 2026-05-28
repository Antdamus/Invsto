/* =========================================================
   OG Jewelry — Admin Overview (Monthly Summary)
   NEW FILE: admin-overview.js  (ES module)
   - Renders KPIs + desktop table + mobile cards
   - Mobile cards open the same drawer (via openWorkerDrawer callback)
   ========================================================= */

export function initOverview(deps) {
  const {
    qs,
    debounce,
    fmtHours,
    fmtDurationHM,           // ✅ needed by Live Now ticking + pills
    monthLabel,
    monthInputToStart,
    fetchMonthlySummary,
    fetchMonthlyPendingReviewCounts,
    fetchMonthlyExceptionCounts,
    fetchLiveNow,            // ✅ Live Now data fetcher (kept in admin.js for now)
    openWorkerDrawer,        // ✅ only drawer API Overview should use
  } = deps;

  // ---------- state ----------
  let currentRows = [];
  let sortState = { key: "display_name", dir: "asc" };
  let overviewFocus = "all";
  let pendingReviewCounts = new Map();
  let exceptionCounts = new Map();
  let isLoading = false;

  // ---------- helpers ----------
  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function getInitials(name = "") {
    const parts = String(name || "")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    return (parts[0]?.[0] || "W") + (parts[1]?.[0] || "");
  }

  function getPendingCount(row = {}) {
    return pendingReviewCounts.get(row.employee_id) || 0;
  }

  function getExceptionCount(row = {}) {
    return exceptionCounts.get(row.employee_id) || 0;
  }

  function applyOverviewFocus(rows = []) {
    if (overviewFocus === "review") return rows.filter((row) => getPendingCount(row) > 0);
    if (overviewFocus === "exceptions") return rows.filter((row) => getExceptionCount(row) > 0);
    return rows;
  }

  function setText(id, value) {
    const el = qs(id);
    if (el) el.textContent = value;
  }

  function renderOverviewPulse(rows = []) {
    const reviewCount = rows.filter((row) => getPendingCount(row) > 0).length;
    const exceptionCount = rows.filter((row) => getExceptionCount(row) > 0).length;

    setText("overviewAllCount", String(rows.length));
    setText("overviewReviewCount", String(reviewCount));
    setText("overviewExceptionCount", String(exceptionCount));
    setText("overviewAllChip", String(rows.length));
    setText("overviewReviewChip", String(reviewCount));
    setText("overviewExceptionChip", String(exceptionCount));

    document.querySelectorAll("[data-overview-focus]").forEach((button) => {
      button.classList.toggle("active", button.dataset.overviewFocus === overviewFocus);
      button.setAttribute("aria-pressed", button.dataset.overviewFocus === overviewFocus ? "true" : "false");
    });
  }

  function sortRows(rows) {
    const a = rows.slice();
    const { key, dir } = sortState;
    const m = dir === "asc" ? 1 : -1;

    a.sort((x, y) => {
      let xv = x[key],
        yv = y[key];

      if (key === "shifts_count" || key === "total_hours") {
        xv = +xv || 0;
        yv = +yv || 0;
        return (xv - yv) * m;
      }
      const xs = (xv || "").toString().toLowerCase();
      const ys = (yv || "").toString().toLowerCase();
      return xs < ys ? -1 * m : xs > ys ? 1 * m : 0;
    });

    return a;
  }

  function applySortIndicators() {
    const map = [
      { el: qs("thWorker"), key: "display_name" },
      { el: qs("thShifts"), key: "shifts_count" },
      { el: qs("thHours"), key: "total_hours" },
    ];

    map.forEach(({ el, key }) => {
      if (!el) return;
      const s = sortState.key === key ? sortState.dir : "none";
      el.setAttribute(
        "aria-sort",
        s === "asc" ? "ascending" : s === "desc" ? "descending" : "none"
      );
      const ind = el.querySelector(".sort-indicator");
      if (ind) ind.textContent = s === "asc" ? "▲" : s === "desc" ? "▼" : "↕";
    });
  }

  // ---------- render ----------
  function renderKPIs(rows) {
    const tot = rows.reduce((a, r) => a + (+r.total_hours || 0), 0);
    const shf = rows.reduce((a, r) => a + (+r.shifts_count || 0), 0);
    const avg = shf > 0 ? tot / shf : 0;

    if (qs("kpiTotalHours")) qs("kpiTotalHours").textContent = fmtHours(tot);
    if (qs("kpiTotalShifts")) qs("kpiTotalShifts").textContent = String(shf);
    if (qs("kpiAvgHrs")) qs("kpiAvgHrs").textContent = fmtHours(avg);
  }

function renderTable(rows) {
  const tb = qs("summaryTbody");
  if (!tb) return;

  tb.innerHTML = "";
  const data = sortRows(rows);

  if (!data.length) {
    tb.innerHTML = `<tr><td colspan="4" class="muted">No results for this month/search.</td></tr>`;
    return;
  }

  for (const r of data) {
    const tr = document.createElement("tr");
    tr.dataset.employeeId = r.employee_id;
    tr.dataset.monthStart = r.month_start;
    tr.dataset.displayName = r.display_name || "";
    tr.className = "summary-row";

    const pendingN = getPendingCount(r);
    const exN = getExceptionCount(r);

    const pendingFlag =
      pendingN > 0
        ? `<span class="review-flag" title="Pending shifts for review">Pending review: ${pendingN}</span>`
        : "";

    const exFlag =
      exN > 0
        ? `<span class="exception-flag" title="Approved (Exception) this month">Exceptions: ${exN}</span>`
        : "";

    tr.innerHTML = `
      <td class="worker-cell">
        <span class="worker-avatar" aria-hidden="true">${escapeHtml(getInitials(r.display_name))}</span>
        <span class="worker-name">${escapeHtml(r.display_name || "-")}</span>${pendingFlag}${exFlag}
      </td>
      <td>${escapeHtml(r.shifts_count ?? "-")}</td>
      <td>${fmtHours(r.total_hours)}</td>
      <td class="summary-action-cell"><button class="btn small ghost summary-open-btn" type="button">${pendingN ? "Review" : "Open"}</button></td>
    `;

    tb.appendChild(tr);
  }

  applySortIndicators();
}

  // Mobile cards go into #summaryCards
function renderSummaryCards(rows) {
  const host = qs("summaryCards");
  if (!host) return;

  host.innerHTML = "";
  const data = sortRows(rows);

  if (!data.length) {
    host.innerHTML = `<div class="muted" style="padding:10px 2px;">No results for this month/search.</div>`;
    return;
  }

  for (const r of data) {
    const pendingN = getPendingCount(r);
    const exN = getExceptionCount(r);

    const parts = [];
    parts.push(pendingN > 0 ? `Pending review: ${pendingN}` : "Ready");
    if (exN > 0) parts.push(`Exceptions: ${exN}`);

    const card = document.createElement("div");
    card.className = "summary-card";
    card.dataset.employeeId = r.employee_id;
    card.dataset.monthStart = r.month_start;
    card.dataset.displayName = r.display_name || "";

    card.innerHTML = `
      <div class="summary-card-top">
        <div>
          <div class="summary-card-name-row">
            <span class="worker-avatar" aria-hidden="true">${escapeHtml(getInitials(r.display_name))}</span>
            <div>
              <div class="summary-card-name">${escapeHtml(r.display_name || "-")}</div>
              <div class="summary-card-sub">${escapeHtml(parts.join(" / "))}</div>
            </div>
          </div>
        </div>
      </div>

      <div class="summary-card-metrics">
        <div class="summary-metric">
          <div class="lbl">Shifts</div>
          <div class="val">${escapeHtml(r.shifts_count ?? "-")}</div>
        </div>
        <div class="summary-metric">
          <div class="lbl">Total Hours</div>
          <div class="val">${fmtHours(r.total_hours)}</div>
        </div>
        <div class="summary-metric">
          <div class="lbl">Avg / Shift</div>
          <div class="val">${
            (+r.shifts_count || 0) > 0
              ? fmtHours((+r.total_hours || 0) / (+r.shifts_count || 0))
              : fmtHours(0)
          }</div>
        </div>
      </div>

      <div class="summary-card-actions">
        <button class="btn" type="button">${pendingN ? "Review shifts" : "Open details"}</button>
      </div>
    `;

    host.appendChild(card);
  }
}

  // ---------- actions ----------
async function loadSummary() {
  if (isLoading) return;
  isLoading = true;

  const tb = qs("summaryTbody");
  if (tb) tb.style.opacity = "0.6";

  try {
    const monthStart = monthInputToStart();
    const search = (qs("searchInput")?.value || "").trim().toLowerCase();

    if (qs("printMonthLabel")) {
      qs("printMonthLabel").textContent = monthLabel(monthStart);
    }

    const [{ rows }, pendingMap, exceptionMap] = await Promise.all([
      fetchMonthlySummary(monthStart),
      fetchMonthlyPendingReviewCounts(monthStart),
      // If you haven’t wired it yet, don’t crash the overview
      fetchMonthlyExceptionCounts
        ? fetchMonthlyExceptionCounts(monthStart)
        : Promise.resolve(new Map()),
    ]);

    pendingReviewCounts = pendingMap || new Map();
    exceptionCounts = exceptionMap || new Map();

    const filtered = search
      ? (rows || []).filter((r) =>
          (r.display_name || "").toLowerCase().includes(search)
        )
      : (rows || []);

    renderOverviewPulse(filtered);

    currentRows = applyOverviewFocus(filtered);

    renderKPIs(currentRows);
    renderTable(currentRows);
    renderSummaryCards(currentRows);
  } catch (err) {
    console.error(err);

    if (qs("summaryTbody")) {
      qs("summaryTbody").innerHTML =
        `<tr><td colspan="4" class="muted">Error loading data. Check console.</td></tr>`;
    }
    if (qs("summaryCards")) {
      qs("summaryCards").innerHTML =
        `<div class="muted" style="padding:10px 2px;">Error loading data. Check console.</div>`;
    }

    if (qs("kpiTotalHours")) qs("kpiTotalHours").textContent = "—";
    if (qs("kpiTotalShifts")) qs("kpiTotalShifts").textContent = "—";
    if (qs("kpiAvgHrs")) qs("kpiAvgHrs").textContent = "—";
  } finally {
    if (tb) tb.style.opacity = "1";
    isLoading = false;
  }
}

  function toggleSort(key) {
    if (sortState.key === key) sortState.dir = sortState.dir === "asc" ? "desc" : "asc";
    else sortState = { key, dir: "asc" };

    renderTable(currentRows);
    renderSummaryCards(currentRows);
  }

  function wireFilters() {
    const mi = qs("monthInput");
    const si = qs("searchInput");
    if (mi) mi.addEventListener("change", loadSummary);
    if (si) si.addEventListener("input", debounce(loadSummary, 300));
  }

  function wireSorting() {
    qs("thWorker")?.addEventListener("click", () => toggleSort("display_name"));
    qs("thShifts")?.addEventListener("click", () => toggleSort("shifts_count"));
    qs("thHours")?.addEventListener("click", () => toggleSort("total_hours"));
  }

  function wireOverviewFocus() {
    document.querySelectorAll("[data-overview-focus]").forEach((button) => {
      button.addEventListener("click", () => {
        overviewFocus = button.dataset.overviewFocus || "all";
        loadSummary();
      });
    });
  }

  // Desktop table row click
  function wireTableClicks() {
    qs("summaryTbody")?.addEventListener("click", (e) => {
      const tr = e.target.closest("tr.summary-row");
      if (!tr) return;

      openWorkerDrawer({
        employeeId: tr.dataset.employeeId,
        monthStart: tr.dataset.monthStart,
        displayName: tr.dataset.displayName || "—",
      });
    });
  }

  // Mobile card click
  function wireCardClicks() {
    qs("summaryCards")?.addEventListener("click", (e) => {
      const card = e.target.closest(".summary-card");
      if (!card) return;

      openWorkerDrawer({
        employeeId: card.dataset.employeeId,
        monthStart: card.dataset.monthStart,
        displayName: card.dataset.displayName || "—",
      });
    });
  }



// recompute durations from data-* timestamps (no network)
  let liveTickTimer = null;
  function tickLiveNow(){
    const cards = document.querySelectorAll('.live-card');
    const now = Date.now();

    for (const card of cards){
      const clockInMs = Number(card.dataset.clockInMs || 0);
      if (!clockInMs) continue;

      // update "since HH:MM / HHh MMm"
      const timesEl = card.querySelector('.live-times');
      if (timesEl){
        const sinceStr = new Date(clockInMs).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
        const durStr = fmtDurationHM(now - clockInMs);
        timesEl.textContent = `since ${sinceStr} / ${durStr}`;
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

  function renderLiveNow(rows){
  const list = qs('liveList'); if (!list) return;
  const updated = qs('liveUpdated');

  // header stamp + anomaly count
  const flagged = rows.filter(r => r.has_anomaly).length;
  if (updated){
    updated.textContent = `Updated ${new Date().toLocaleTimeString()}${flagged ? ` / ${flagged} flagged` : ''}`;
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
    div.dataset.employeeId  = r.employee_id;
    div.dataset.displayName  = r.display_name || '';
    div.dataset.clockInMs    = String(clockInMs);
    div.dataset.status       = r.status; // 'work' | 'break'
    div.dataset.breakStartMs = breakStartMs ? String(breakStartMs) : '';

    const sinceStr = new Date(clockInMs).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'});
    const durStr   = fmtDurationHM(Date.now() - clockInMs);

    const pill = r.status === 'break'
      ? `<span class="pill break">On break ${fmtDurationHM(r.break_ms)}</span>`
      : `<span class="pill work">Working</span>`;

    const anomHtml = r.has_anomaly && r.anomalies?.length
      ? `<div class="live-anoms">${r.anomalies.map(a => `<span class="chip anom">Flagged: ${escapeHtml(a)}</span>`).join(' ')}</div>`
      : '';

    div.innerHTML = `
      <div class="live-main">
        <span class="worker-avatar live-avatar" aria-hidden="true">${escapeHtml(getInitials(r.display_name))}</span>
        <div>
          <div class="live-name">${escapeHtml(r.display_name || "Worker")}</div>
          <div class="live-times">since ${sinceStr} / ${durStr}</div>
        </div>
      </div>
      <div class="live-status">${pill}</div>
      ${anomHtml}
      <div class="live-actions">
        ${r.photo_in_url ? `<a href="${escapeHtml(r.photo_in_url)}" target="_blank" rel="noopener">Photo In</a>` : ''}
        ${r.break_photo_url ? `<a href="${escapeHtml(r.break_photo_url)}" target="_blank" rel="noopener">Break Photo</a>` : ''}
        <button class="btn small ghost" type="button">Details</button>
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
  const list = qs('liveList');
  if (!list) return;

  list.addEventListener('click', (e) => {
    if (e.target.closest('a')) return;

    const card = e.target.closest('.live-card');
    if (!card) return;

    const employeeId  = card.dataset.employeeId;
    const displayName = card.dataset.displayName || '-';
    const monthStart  = monthInputToStart();

    openWorkerDrawer({ employeeId, monthStart, displayName });
  });
}


// ---------- public ----------
async function bootOverview() {
  wireFilters();
  wireOverviewFocus();
  wireSorting();
  wireTableClicks();
  wireCardClicks();

  // ✅ Live Now
  wireLiveList();
  await loadLiveNow();
  startLiveTicker(30000);

  // ✅ Monthly summary
  await loadSummary();
}

  return { bootOverview, loadSummary, loadLiveNow };
}
