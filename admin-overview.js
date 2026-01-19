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
    monthLabel,
    monthInputToStart,
    fetchMonthlySummary,
    fetchMonthlyPendingReviewCounts,
    openWorkerDrawer,
  } = deps;

  // ---------- state ----------
  let currentRows = [];
  let sortState = { key: "display_name", dir: "asc" };
  let pendingReviewCounts = new Map();
  let isLoading = false;

  // ---------- helpers ----------
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
      tb.innerHTML = `<tr><td colspan="3" class="muted">No results for this month/search.</td></tr>`;
      return;
    }

    for (const r of data) {
      const tr = document.createElement("tr");
      tr.dataset.employeeId = r.employee_id;
      tr.dataset.monthStart = r.month_start;
      tr.dataset.displayName = r.display_name || "";
      tr.className = "summary-row";

      const pendingN = pendingReviewCounts.get(r.employee_id) || 0;
      const flag =
        pendingN > 0
          ? `<span class="review-flag" title="Pending shifts for review">Pending review: ${pendingN}</span>`
          : "";

      tr.innerHTML = `
        <td class="worker-cell">
          <span class="worker-name">${r.display_name || "—"}</span>${flag}
        </td>
        <td>${r.shifts_count ?? "—"}</td>
        <td>${fmtHours(r.total_hours)}</td>
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
      const pendingN = pendingReviewCounts.get(r.employee_id) || 0;

      const card = document.createElement("div");
      card.className = "summary-card";
      card.dataset.employeeId = r.employee_id;
      card.dataset.monthStart = r.month_start;
      card.dataset.displayName = r.display_name || "";

      card.innerHTML = `
        <div class="summary-card-top">
          <div>
            <div class="summary-card-name">${r.display_name || "—"}</div>
            <div class="summary-card-sub">
              ${pendingN > 0 ? `Pending review: ${pendingN}` : "No pending review"}
            </div>
          </div>
        </div>

        <div class="summary-card-metrics">
          <div class="summary-metric">
            <div class="lbl">Shifts</div>
            <div class="val">${r.shifts_count ?? "—"}</div>
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
          <button class="btn" type="button">Open</button>
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
      const search = (qs("searchInput")?.value || "")
        .trim()
        .toLowerCase();

      if (qs("printMonthLabel")) qs("printMonthLabel").textContent = monthLabel(monthStart);

      const [{ rows }, pendingMap] = await Promise.all([
        fetchMonthlySummary(monthStart),
        fetchMonthlyPendingReviewCounts(monthStart),
      ]);

      pendingReviewCounts = pendingMap || new Map();

      const filtered = search
        ? (rows || []).filter((r) =>
            (r.display_name || "").toLowerCase().includes(search)
          )
        : (rows || []);

      currentRows = filtered;

      renderKPIs(filtered);
      renderTable(filtered);
      renderSummaryCards(filtered); // ✅ this is what fixes mobile
    } catch (err) {
      console.error(err);

      if (qs("summaryTbody")) {
        qs("summaryTbody").innerHTML =
          `<tr><td colspan="3" class="muted">Error loading data. Check console.</td></tr>`;
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

  // ---------- public ----------
  async function bootOverview() {
    wireFilters();
    wireSorting();
    wireTableClicks();
    wireCardClicks();
    await loadSummary();
  }

  return { bootOverview, loadSummary };
}
