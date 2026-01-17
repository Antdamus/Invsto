/* =========================================================
   OG Jewelry — Admin Payroll (Contractors)
   admin-payroll.js  (FULL REPLACEMENT)

   Adds: "Pending review shifts" banner + mini list so admins know
   why payroll lines may be empty (no logic change to payroll rules).

   Requires:
   - window.supabaseClient (from initSupabase.js)
   - admin.html contains a container with id="panelPayroll"

   ========================================================= */

(function () {
  const ORG_TZ = "America/New_York";

  // ----------------------------
  // Supabase + basic helpers
  // ----------------------------
  function sb() {
    if (!window.supabaseClient) throw new Error("supabaseClient not found on window");
    return window.supabaseClient;
  }

  const $ = (sel, root = document) => root.querySelector(sel);

  function toast(msg, type = "ok") {
    if (typeof window.toast === "function") return window.toast(msg, type);
    console[type === "err" ? "error" : "log"](msg);
    if (type === "err") alert(msg);
  }

  function showAdminError(title, message) {
    if (typeof window.showAdminError === "function") return window.showAdminError(title, message);
    alert(`${title}\n\n${message}`);
  }

  function fmtMoney(n) {
    const v = Number(n || 0);
    return v.toLocaleString("en-US", { style: "currency", currency: "USD" });
  }

  function isoDate(d) {
    const dt = d instanceof Date ? d : new Date(d);
    const y = dt.getFullYear();
    const m = String(dt.getMonth() + 1).padStart(2, "0");
    const da = String(dt.getDate()).padStart(2, "0");
    return `${y}-${m}-${da}`;
  }

  function safeErrMsg(e) {
    return e?.message || e?.error_description || e?.details || String(e);
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function escapeAttr(s) {
    return escapeHtml(s).replaceAll("\n", " ");
  }

  function fmtShortDate(d) {
    try {
      const dt = new Date(d);
      return dt.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
    } catch {
      return String(d ?? "");
    }
  }

  function minutesBetween(a, b) {
    try {
      const ms = new Date(b).getTime() - new Date(a).getTime();
      return Math.max(0, Math.round(ms / 60000));
    } catch {
      return 0;
    }
  }

  // ----------------------------
  // UI injection
  // ----------------------------
  function ensureUI() {
    const panel = document.getElementById("panelPayroll");
    if (!panel) return null;
    if (panel.dataset.payrollReady === "1") return panel;

    panel.dataset.payrollReady = "1";
    panel.innerHTML = `
      <div class="og-payroll-shell" style="padding:14px;">
        <div class="og-payroll-top" style="display:flex; gap:10px; flex-wrap:wrap; align-items:center; justify-content:space-between;">
          <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
            <div>
              <div style="font-size:12px; opacity:.75; margin-bottom:4px;">Pay Period</div>
              <select id="prPeriodSelect" style="min-width:260px;"></select>
            </div>

            <div>
              <div style="font-size:12px; opacity:.75; margin-bottom:4px;">Rounding</div>
              <select id="prRoundingMode" style="min-width:180px;">
                <option value="nearest_15">Nearest 15 minutes</option>
                <option value="nearest_5">Nearest 5 minutes</option>
              </select>
            </div>

            <button id="prCreateRunBtn" class="og-btn" type="button">Create Draft Run</button>
            <button id="prBuildLinesBtn" class="og-btn" type="button">Build Lines</button>
            <button id="prFinalizeBtn" class="og-btn" type="button">Finalize Run</button>
            <button id="prExportBtn" class="og-btn" type="button">Export CSV</button>
            <button id="prDeleteRunBtn" class="og-btn" type="button" disabled title="Delete the current draft run">Delete Draft Run</button>
            <button id="prDeletePeriodBtn" class="og-btn" type="button" disabled title="Delete this open pay period (draft-only)">Delete Pay Period</button>
          </div>

          <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
            <button id="prCreateWeeklyPeriodBtn" class="og-btn" type="button">Create Weekly Period</button>
            <button id="prLockBtn" class="og-btn" type="button">Lock Period</button>
            <button id="prUnlockBtn" class="og-btn" type="button">Unlock Period</button>
          </div>
        </div>

        <div style="margin-top:10px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <div id="prPeriodMeta" style="font-size:13px; opacity:.85;"></div>
          <div id="prRunMeta" style="font-size:13px; opacity:.85;"></div>
        </div>

        <!-- Pending review banner (NEW) -->
        <div id="prPendingBox" style="display:none; margin-top:12px; border:1px solid rgba(255,210,110,.25); background:rgba(255,210,110,.08); border-radius:14px; padding:12px 12px;">
          <div style="display:flex; gap:10px; align-items:flex-start; justify-content:space-between; flex-wrap:wrap;">
            <div style="min-width:260px;">
              <div style="font-weight:800; letter-spacing:.2px;">⚠️ Shifts need review before payroll can populate</div>
              <div id="prPendingMsg" style="margin-top:4px; font-size:13px; opacity:.9; line-height:1.35;"></div>
            </div>
            <div style="display:flex; gap:10px; align-items:center;">
              <button id="prGoOverviewBtn" class="og-btn" type="button">Go to Overview</button>
            </div>
          </div>

          <div id="prPendingListWrap" style="margin-top:10px; display:none;">
            <div style="font-size:12px; opacity:.8; margin-bottom:6px;">Showing a few pending shifts:</div>
            <div id="prPendingList" style="display:flex; flex-direction:column; gap:6px;"></div>
          </div>
        </div>

        <div style="margin-top:14px; display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
          <div style="padding:10px 12px; border:1px solid rgba(255,255,255,.08); border-radius:12px;">
            <div style="font-size:12px; opacity:.7;">Total Gross</div>
            <div id="prKpiGross" style="font-size:18px; font-weight:700;">$0.00</div>
          </div>
          <div style="padding:10px 12px; border:1px solid rgba(255,255,255,.08); border-radius:12px;">
            <div style="font-size:12px; opacity:.7;">Total Paid</div>
            <div id="prKpiPaid" style="font-size:18px; font-weight:700;">$0.00</div>
          </div>
          <div style="padding:10px 12px; border:1px solid rgba(255,255,255,.08); border-radius:12px;">
            <div style="font-size:12px; opacity:.7;">Total Due</div>
            <div id="prKpiDue" style="font-size:18px; font-weight:700;">$0.00</div>
          </div>
        </div>

        <div style="margin-top:14px; overflow:auto; border:1px solid rgba(255,255,255,.08); border-radius:14px;">
          <table style="width:100%; border-collapse:collapse; font-size:13px;">
            <thead>
              <tr style="text-align:left; border-bottom:1px solid rgba(255,255,255,.08);">
                <th style="padding:10px 12px;">Contractor</th>
                <th style="padding:10px 12px;">Shifts</th>
                <th style="padding:10px 12px;">Minutes</th>
                <th style="padding:10px 12px;">Paid Break</th>
                <th style="padding:10px 12px;">Unpaid Break</th>
                <th style="padding:10px 12px;">Rounded (min)</th>
                <th style="padding:10px 12px;">Hours</th>
                <th style="padding:10px 12px;">Rate</th>
                <th style="padding:10px 12px;">Gross</th>
                <th style="padding:10px 12px;">Paid</th>
                <th style="padding:10px 12px;">Due</th>
                <th style="padding:10px 12px;">Actions</th>
              </tr>
            </thead>
            <tbody id="prTbody">
              <tr><td colspan="12" style="padding:14px; opacity:.75;">Loading…</td></tr>
            </tbody>
          </table>
        </div>

        <div style="margin-top:12px; font-size:12px; opacity:.7; line-height:1.35;">
          Break policy: pays up to <b>store_locations.paid_break_cap_min</b> per day; any break time beyond that is unpaid (subtracted).<br/>
          Rates: uses historical rate resolution function (rate changes mid-period are documented and applied).
        </div>
      </div>
    `;

    return panel;
  }

  // ----------------------------
  // State
  // ----------------------------
  let currentPeriod = null;
  let currentRun = null;
  let currentLines = [];
  let currentPayments = [];
  let pendingReview = []; // NEW: list of shifts requiring review/approval (missing shift_approvals row)

  // ----------------------------
  // Data loaders
  // ----------------------------
  async function loadPeriodsIntoSelect(selectEl) {
    const { data, error } = await sb()
      .from("pay_periods")
      .select("*")
      .order("start_date", { ascending: false })
      .limit(200);

    if (error) throw error;

    selectEl.innerHTML = "";
    for (const p of data || []) {
      const opt = document.createElement("option");
      opt.value = p.id;
      opt.textContent = `${p.start_date} → ${p.end_date}  (${p.status})`;
      selectEl.appendChild(opt);
    }

    if (data && data.length) {
      selectEl.value = data[0].id;
      return data[0];
    }
    return null;
  }

  async function loadRunsForPeriod(periodId) {
    const { data, error } = await sb()
      .from("payroll_runs")
      .select("*")
      .eq("pay_period_id", periodId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (error) throw error;
    return data || [];
  }

  async function loadLines(runId) {
    const { data, error } = await sb()
      .from("payroll_run_lines")
      .select("*, employees(display_name)")
      .eq("payroll_run_id", runId)
      .order("gross_pay", { ascending: false });

    if (!error) return data || [];

    const { data: d2, error: e2 } = await sb()
      .from("payroll_run_lines")
      .select("*")
      .eq("payroll_run_id", runId)
      .order("gross_pay", { ascending: false });

    if (e2) throw e2;
    return d2 || [];
  }

  async function loadPayments(runId) {
    const { data, error } = await sb()
      .from("contractor_payments")
      .select("*")
      .eq("payroll_run_id", runId)
      .order("paid_at", { ascending: false });

    if (error) throw error;
    return data || [];
  }

  // ----------------------------
  // NEW: Pending review detector
  // ----------------------------
  function periodBoundsUtc(period) {
    // We only need “informational correctness” for the banner.
    // Using UTC midnights on the date boundaries is good enough to explain why payroll is empty.
    const startIso = `${period.start_date}T00:00:00.000Z`;
    const endPlus1 = new Date(`${period.end_date}T00:00:00.000Z`);
    endPlus1.setUTCDate(endPlus1.getUTCDate() + 1);
    const endIsoExclusive = endPlus1.toISOString();
    return { startIso, endIsoExclusive };
  }

  async function fetchPendingReviewForPeriod(period) {
    if (!period) return [];

    const { startIso, endIsoExclusive } = periodBoundsUtc(period);

    // 1) Closed shifts in the period (clock_out not null)
    // NOTE: the payroll builder itself uses ts_local_date() in SQL, but this is a UI hint.
    const { data: entries, error: teErr } = await sb()
      .from("time_entries")
      .select("id, employee_id, clock_in, clock_out")
      .gte("clock_in", startIso)
      .lt("clock_in", endIsoExclusive)
      .not("clock_out", "is", null);

    if (teErr) throw teErr;

    const ids = (entries || []).map((r) => r.id);
    if (!ids.length) return [];

    // 2) Which of these have approvals already?
    const { data: approvals, error: apErr } = await sb()
      .from("shift_approvals")
      .select("time_entry_id")
      .in("time_entry_id", ids);

    if (apErr) throw apErr;

    const approvedSet = new Set((approvals || []).map((a) => a.time_entry_id));

    // 3) Pending = closed shift with NO shift_approvals row yet
    const pending = (entries || []).filter((e) => !approvedSet.has(e.id));

    if (!pending.length) return [];

    // 4) Attach display names (quick lookup)
    const empIds = [...new Set(pending.map((p) => p.employee_id).filter(Boolean))];
    let empMap = new Map();
    if (empIds.length) {
      const { data: emps, error: empErr } = await sb()
        .from("employees")
        .select("id, display_name")
        .in("id", empIds);

      if (empErr) throw empErr;
      empMap = new Map((emps || []).map((e) => [e.id, e.display_name]));
    }

    return pending
      .map((p) => ({
        time_entry_id: p.id,
        employee_id: p.employee_id,
        display_name: empMap.get(p.employee_id) || p.employee_id,
        clock_in: p.clock_in,
        clock_out: p.clock_out,
        minutes: minutesBetween(p.clock_in, p.clock_out),
      }))
      .sort((a, b) => new Date(b.clock_in).getTime() - new Date(a.clock_in).getTime());
  }

  function renderPendingBox() {
    const box = $("#prPendingBox");
    const msg = $("#prPendingMsg");
    const listWrap = $("#prPendingListWrap");
    const list = $("#prPendingList");
    const finalizeBtn = $("#prFinalizeBtn");

    if (!box || !msg || !listWrap || !list) return;

    const count = pendingReview.length;

    if (!count) {
      box.style.display = "none";
      if (finalizeBtn) finalizeBtn.disabled = false;
      return;
    }

    box.style.display = "block";
    msg.innerHTML = `
      This pay period has <b>${count}</b> shift${count === 1 ? "" : "s"} that are <b>closed</b> but still <b>pending review</b>.
      Payroll lines only include shifts that are <b>approved/waived</b>. Review them in <b>Overview</b>, then come back and click <b>Build Lines</b>.
    `;

    // Show a short list (max 5)
    const show = pendingReview.slice(0, 5);
    if (show.length) {
      listWrap.style.display = "block";
      list.innerHTML = show
        .map((s) => {
          return `
            <div style="display:flex; gap:10px; align-items:center; justify-content:space-between; padding:8px 10px; border:1px solid rgba(255,255,255,.08); border-radius:12px; background:rgba(0,0,0,.12);">
              <div style="min-width:220px; font-weight:700;">${escapeHtml(s.display_name)}</div>
              <div style="opacity:.85;">${escapeHtml(fmtShortDate(s.clock_in))}</div>
              <div style="opacity:.85;">${s.minutes} min</div>
              <div style="opacity:.65; font-size:12px;">id: ${escapeHtml(String(s.time_entry_id).slice(0, 8))}…</div>
            </div>
          `;
        })
        .join("");
    } else {
      listWrap.style.display = "none";
      list.innerHTML = "";
    }

    // Safety: disable finalize until approvals exist (informational UX guard)
    if (finalizeBtn) finalizeBtn.disabled = true;
  }

  function tryGoToOverviewTab() {
    // Best-effort: click a tab/button/link with text "Overview"
    const candidates = Array.from(document.querySelectorAll("button, a, [role='tab']"));
    const el = candidates.find((n) => (n.textContent || "").trim().toLowerCase() === "overview");
    if (el) {
      el.click();
      return true;
    }
    toast("Could not locate an Overview tab button automatically.", "err");
    return false;
  }

  // ----------------------------
  // Render
  // ----------------------------
  function computePaidByEmployee(payments) {
    const map = new Map();
    for (const p of payments || []) {
      const k = p.employee_id;
      map.set(k, (map.get(k) || 0) + Number(p.amount || 0));
    }
    return map;
  }

  function setMeta(period, run) {
    const metaEl = $("#prPeriodMeta");
    const runEl = $("#prRunMeta");

    if (period) {
      metaEl.textContent = `Period: ${period.start_date} → ${period.end_date} • Status: ${period.status}`;
    } else {
      metaEl.textContent = `Period: (none)`;
    }

    if (run) {
      runEl.textContent = `Run: ${run.status} • Rounding: ${run.rounding_mode || "(unknown)"} • Created: ${
        run.created_at ? new Date(run.created_at).toLocaleString() : ""
      }`;
    } else {
      runEl.textContent = `Run: (none for this period yet)`;
    }

    // Enable delete only when there's a draft run
    const delBtn = $("#prDeleteRunBtn");
    if (delBtn) {
      const canDelete = !!run && run.status === "draft";
      delBtn.disabled = !canDelete;
      delBtn.title = canDelete ? "Delete this draft run and its lines" : "Only draft runs can be deleted";
    }

    const delPeriodBtn = $("#prDeletePeriodBtn");
    if (delPeriodBtn) {
      const canDeletePeriod = !!period && period.status !== "locked";
      delPeriodBtn.disabled = !canDeletePeriod;
      delPeriodBtn.title = canDeletePeriod
        ? "Delete this open pay period (optionally force-delete draft runs)"
        : "Locked periods cannot be deleted";
    }


  }

  function renderKPIs(lines, payments) {
    const paidMap = computePaidByEmployee(payments);
    let gross = 0;
    let paid = 0;
    for (const l of lines || []) {
      const g = Number(l.gross_pay || 0);
      gross += g;
      paid += Math.min(g, Number(paidMap.get(l.employee_id) || 0));
    }
    const due = gross - paid;

    $("#prKpiGross").textContent = fmtMoney(gross);
    $("#prKpiPaid").textContent = fmtMoney(paid);
    $("#prKpiDue").textContent = fmtMoney(due);
  }

  async function renderLines(lines, payments) {
    const tbody = $("#prTbody");
    if (!tbody) return;

    const paidMap = computePaidByEmployee(payments);

    if (!lines || !lines.length) {
      // If there are pending shifts, explain it right in the empty state.
      const pendingCount = pendingReview.length;
      const hint = pendingCount
        ? `<div style="margin-top:6px; font-size:12px; opacity:.75;">${pendingCount} shift${pendingCount === 1 ? "" : "s"} are pending review. Approve them in Overview, then rebuild.</div>`
        : "";

      tbody.innerHTML = `
        <tr>
          <td colspan="12" style="padding:14px; opacity:.75;">
            No lines yet. Click “Build Lines”.
            ${hint}
          </td>
        </tr>`;
      renderKPIs([], payments);
      return;
    }

    tbody.innerHTML = lines
      .map((l) => {
        const name = l.employees?.display_name || l.display_name || l.employee_id;
        const paid = Number(paidMap.get(l.employee_id) || 0);
        const gross = Number(l.gross_pay || 0);
        const due = Math.max(0, gross - paid);

        const minutesWorked = Number(l.minutes_worked || 0);
        const paidBreak = Number(l.paid_break_minutes || 0);
        const unpaidBreak = Number(l.unpaid_break_minutes || 0);
        const roundedMin = Number(l.rounded_minutes || 0);
        const hours = roundedMin / 60;

        const rate = Number(l.hourly_rate || 0);
        const shiftCount = Number(l.shift_count || 0);

        const canPay = currentRun && currentRun.status === "final";

        return `
          <tr style="border-bottom:1px solid rgba(255,255,255,.06);">
            <td style="padding:10px 12px; font-weight:650;">${escapeHtml(name)}</td>
            <td style="padding:10px 12px;">${shiftCount}</td>
            <td style="padding:10px 12px;">${minutesWorked}</td>
            <td style="padding:10px 12px;">${paidBreak}</td>
            <td style="padding:10px 12px;">${unpaidBreak}</td>
            <td style="padding:10px 12px;">${roundedMin}</td>
            <td style="padding:10px 12px;">${hours.toFixed(2)}</td>
            <td style="padding:10px 12px;">${fmtMoney(rate)}/hr</td>
            <td style="padding:10px 12px; font-weight:700;">${fmtMoney(gross)}</td>
            <td style="padding:10px 12px;">${fmtMoney(paid)}</td>
            <td style="padding:10px 12px; font-weight:700;">${fmtMoney(due)}</td>
            <td style="padding:10px 12px;">
              <button class="og-btn prPayBtn" type="button"
                data-emp="${l.employee_id}"
                data-name="${escapeAttr(name)}"
                data-due="${due}"
                ${canPay ? "" : "disabled"}
                title="${canPay ? "Record payment" : "Finalize run to record payments"}"
              >Pay</button>
            </td>
          </tr>
        `;
      })
      .join("");

    renderKPIs(lines, payments);
  }

  // ----------------------------
  // Actions (RPC wrappers)
  // ----------------------------
  function uiRoundingMode() {
    const v = $("#prRoundingMode")?.value || "nearest_15";
    if (v !== "nearest_15" && v !== "nearest_5") return "nearest_15";
    return v;
  }

  async function refreshAll(periodId) {
    // period row
    const { data: p, error: pe } = await sb().from("pay_periods").select("*").eq("id", periodId).single();
    if (pe) throw pe;
    currentPeriod = p;

    // pending review banner (NEW)
    try {
      pendingReview = await fetchPendingReviewForPeriod(currentPeriod);
    } catch (e) {
      // Don’t block payroll UI if this informational query fails.
      console.warn("Pending review detector failed:", safeErrMsg(e));
      pendingReview = [];
    }
    renderPendingBox();

    // runs
    const runs = await sb()
      .from("payroll_runs")
      .select("*")
      .eq("pay_period_id", periodId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (runs.error) throw runs.error;
    currentRun = (runs.data || [])[0] || null;

    setMeta(currentPeriod, currentRun);

    if (!currentRun) {
      currentLines = [];
      currentPayments = [];
      await renderLines([], []);
      return;
    }

    currentLines = await loadLines(currentRun.id);
    currentPayments = await loadPayments(currentRun.id);
    await renderLines(currentLines, currentPayments);
  }

async function deleteSelectedPayPeriod() {
  if (!currentPeriod) return toast("No pay period selected", "err");

  // UX guard (DB also enforces)
  if (currentPeriod.status === "locked") {
    toast("Cannot delete a locked pay period", "err");
    return;
  }

  const warn =
    "Delete this pay period?\n\n" +
    "This is only allowed while the period is OPEN.\n" +
    "If the period has draft runs, you can optionally force-delete them too.\n\n" +
    "This cannot be undone.";

  const ok = confirm(warn);
  if (!ok) return;

  // Ask whether to force-delete draft runs (only draft runs are allowed by the RPC)
  const force = confirm(
    "Force delete?\n\n" +
      "Press OK to delete the period even if it has draft runs (it will delete those draft runs and their lines too).\n" +
      "Press Cancel to attempt a safe delete only (works only if there are no runs)."
  );

  try {
    const { error } = await sb().rpc("delete_pay_period", {
      _period_id: currentPeriod.id,
      _force: force,
    });
    if (error) throw error;

    toast("Pay period deleted", "ok");

    // Reload periods list and refresh UI to the newest one (or empty state)
    const sel = $("#prPeriodSelect");
    const newest = await loadPeriodsIntoSelect(sel);

    if (!newest) {
      currentPeriod = null;
      currentRun = null;
      currentLines = [];
      currentPayments = [];
      pendingReview = [];
      setMeta(null, null);
      renderPendingBox();
      await renderLines([], []);
      return;
    }

    currentPeriod = newest;
    await refreshAll(sel.value);
  } catch (e) {
    showAdminError("Delete pay period failed", safeErrMsg(e));
    throw e;
  }
}

  async function deleteDraftRun() {
  if (!currentRun) {
    toast("No run selected", "err");
    return;
  }

  // Safety: only allow draft delete from UI (DB also enforces this)
  if (currentRun.status !== "draft") {
    toast("Only draft runs can be deleted", "err");
    return;
  }

  const ok = confirm(
    "Delete this draft payroll run?\n\nThis will delete ALL built lines for this run. This cannot be undone."
  );
  if (!ok) return;

  try {
    const { error } = await sb().rpc("delete_payroll_run", { _run_id: currentRun.id });
    if (error) throw error;

    toast("Draft run deleted", "ok");

    // Refresh everything (run will disappear, lines will clear)
    await refreshAll(currentPeriod.id);
  } catch (e) {
    showAdminError("Delete run failed", safeErrMsg(e));
    throw e;
  }
}


  async function createDraftRun() {
    if (!currentPeriod) return;
    const roundingMode = uiRoundingMode();

    try {
      const { data, error } = await sb().rpc("create_payroll_run", {
        _pay_period_id: currentPeriod.id,
        _rounding_mode: roundingMode,
        _note: null,
      });
      if (error) throw error;

      toast("Draft payroll run created", "ok");
      await refreshAll(currentPeriod.id);
      return data;
    } catch (e) {
      showAdminError("Create run failed", safeErrMsg(e));
      throw e;
    }
  }

  async function buildLines() {
    if (!currentRun) {
      toast("Create a run first", "err");
      return;
    }

    try {
      const { data, error } = await sb().rpc("build_payroll_run_lines", {
        _payroll_run_id: currentRun.id,
      });
      if (error) throw error;

      toast("Payroll lines built", "ok");

      // Refresh pending banner + lines after build
      await refreshAll(currentPeriod.id);

      // If still empty AND pending exists, call it out clearly
      if ((!currentLines || !currentLines.length) && pendingReview.length) {
        toast(`No lines yet: ${pendingReview.length} shift(s) still pending review in Overview`, "err");
      }

      return data;
    } catch (e) {
      showAdminError("Build lines failed", safeErrMsg(e));
      throw e;
    }
  }

  async function finalizeRun() {
    if (!currentRun) return;

    // If we have pending review shifts, prevent finalize (UX guard)
    if (pendingReview.length) {
      toast(`Cannot finalize: ${pendingReview.length} shift(s) still pending review`, "err");
      return;
    }

    try {
      const { data, error } = await sb().rpc("finalize_payroll_run", {
        _payroll_run_id: currentRun.id,
        _note: null,
      });
      if (error) throw error;

      toast("Payroll run finalized", "ok");
      await refreshAll(currentPeriod.id);
      return data;
    } catch (e) {
      showAdminError("Finalize failed", safeErrMsg(e));
      throw e;
    }
  }

  async function lockPeriod() {
    if (!currentPeriod) return;

    try {
      const { data, error } = await sb().rpc("payroll_lock_period", {
        _period_id: currentPeriod.id,
        _note: null,
        _force: false,
      });
      if (error) throw error;

      toast("Pay period locked", "ok");
      await refreshAll(currentPeriod.id);
      return data;
    } catch (e) {
      showAdminError("Lock failed", safeErrMsg(e));
      throw e;
    }
  }

  async function unlockPeriod() {
    if (!currentPeriod) return;

    try {
      const { data, error } = await sb().rpc("payroll_unlock_period", {
        _period_id: currentPeriod.id,
        _note: null,
      });
      if (error) throw error;

      toast("Pay period unlocked", "ok");
      await refreshAll(currentPeriod.id);
      return data;
    } catch (e) {
      showAdminError("Unlock failed", safeErrMsg(e));
      throw e;
    }
  }

  async function createWeeklyPeriod() {
  // Create a BIWEEKLY (14-day) pay period starting on a chosen date (default: today)
  const start = prompt(`Enter pay period start date (YYYY-MM-DD)`, isoDate(new Date()));
  if (!start) return;

  // create_weekly_pay_period(week_start, weeks, p_timezone, p_note)
  try {
    const { data, error } = await sb().rpc("create_weekly_pay_period", {
      week_start: start,
      weeks: 2,              // <-- BIWEEKLY
      p_timezone: ORG_TZ,
      p_note: "Biweekly",    // optional, but helpful for labeling
    });
    if (error) throw error;

    toast("Biweekly pay period created", "ok");

    // reload periods list and select new one
    const sel = $("#prPeriodSelect");
    const newest = await loadPeriodsIntoSelect(sel);
    currentPeriod = newest;
    await refreshAll(sel.value);
    return data;
  } catch (e) {
    showAdminError("Create period failed", safeErrMsg(e));
    throw e;
  }
}


  async function recordPayment(employeeId, amount, method, reference, note) {
    if (!currentRun) return;
    if (currentRun.status !== "final") {
      toast("Finalize the run before recording payments", "err");
      return;
    }

    try {
      const { data, error } = await sb().rpc("record_contractor_payment", {
        _payroll_run_id: currentRun.id,
        _employee_id: employeeId,
        _amount: Number(amount),
        _method: method || "other",
        _reference: reference || null,
        _note: note || null,
        _paid_at: new Date().toISOString(),
      });
      if (error) throw error;

      toast("Payment recorded", "ok");
      await refreshAll(currentPeriod.id);
      return data;
    } catch (e) {
      showAdminError("Record payment failed", safeErrMsg(e));
      throw e;
    }
  }

  // ----------------------------
  // Export CSV
  // ----------------------------
  function buildCsv(lines, payments) {
    const paidMap = computePaidByEmployee(payments);

    const headers = [
      "employee_id",
      "display_name",
      "shift_count",
      "minutes_worked",
      "paid_break_minutes",
      "unpaid_break_minutes",
      "rounded_minutes",
      "hours_rounded",
      "hourly_rate",
      "gross_pay",
      "paid_amount",
      "due_amount",
    ];

    const rows = (lines || []).map((l) => {
      const name = l.employees?.display_name || l.display_name || "";
      const gross = Number(l.gross_pay || 0);
      const paid = Number(paidMap.get(l.employee_id) || 0);
      const due = Math.max(0, gross - paid);

      const roundedMin = Number(l.rounded_minutes || 0);
      const hours = roundedMin / 60;

      const cols = [
        l.employee_id,
        name,
        Number(l.shift_count || 0),
        Number(l.minutes_worked || 0),
        Number(l.paid_break_minutes || 0),
        Number(l.unpaid_break_minutes || 0),
        roundedMin,
        hours.toFixed(2),
        Number(l.hourly_rate || 0).toFixed(2),
        gross.toFixed(2),
        paid.toFixed(2),
        due.toFixed(2),
      ];

      return cols.map(csvCell).join(",");
    });

    return [headers.join(","), ...rows].join("\n");

    function csvCell(v) {
      const s = String(v ?? "");
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replaceAll('"', '""')}"`;
      }
      return s;
    }
  }

  function downloadText(filename, text) {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  async function exportCsv() {
    if (!currentRun) return toast("No run to export", "err");
    const csv = buildCsv(currentLines, currentPayments);
    const fn = `payroll_${currentPeriod?.start_date || "period"}_${currentPeriod?.end_date || ""}_${currentRun.status}.csv`;
    downloadText(fn, csv);
    toast("CSV exported", "ok");
  }

  // ----------------------------
  // Payment prompt UI
  // ----------------------------
  async function promptPayment(empId, empName, due) {
    if (!currentRun || currentRun.status !== "final") return;

    const amtDefault = (Number(due || 0) || 0).toFixed(2);
    const amountStr = prompt(`Record payment for ${empName}\n\nAmount (default = due):`, amtDefault);
    if (amountStr === null) return;

    const amount = Number(amountStr);
    if (!Number.isFinite(amount) || amount < 0) {
      toast("Invalid amount", "err");
      return;
    }

    const method = prompt(`Method (zelle, ach, wire, cash, check, other):`, "zelle") || "other";
    const reference = prompt(`Reference (optional):`, "") || null;
    const note = prompt(`Note (optional):`, "") || null;

    await recordPayment(empId, amount, method, reference, note);
  }

  // ----------------------------
  // Event wiring
  // ----------------------------
  function bindEvents() {
    $("#prPeriodSelect")?.addEventListener("change", async (e) => {
      const id = e.target.value;
      try {
        await refreshAll(id);
      } catch (err) {
        showAdminError("Load period failed", safeErrMsg(err));
      }
    });

    $("#prCreateRunBtn")?.addEventListener("click", async () => {
      try {
        await createDraftRun();
      } catch {}
    });

    $("#prBuildLinesBtn")?.addEventListener("click", async () => {
      try {
        await buildLines();
      } catch {}
    });

    $("#prFinalizeBtn")?.addEventListener("click", async () => {
      try {
        await finalizeRun();
      } catch {}
    });

    $("#prExportBtn")?.addEventListener("click", async () => {
      try {
        await exportCsv();
      } catch {}
    });

    $("#prLockBtn")?.addEventListener("click", async () => {
      try {
        await lockPeriod();
      } catch {}
    });

    $("#prUnlockBtn")?.addEventListener("click", async () => {
      try {
        await unlockPeriod();
      } catch {}
    });

    $("#prCreateWeeklyPeriodBtn")?.addEventListener("click", async () => {
      try {
        await createWeeklyPeriod();
      } catch {}
    });

    $("#prGoOverviewBtn")?.addEventListener("click", () => {
      tryGoToOverviewTab();
    });

    // delegated pay button
    $("#prTbody")?.addEventListener("click", async (e) => {
      const btn = e.target.closest(".prPayBtn");
      if (!btn) return;
      const empId = btn.dataset.emp;
      const empName = btn.dataset.name || empId;
      const due = Number(btn.dataset.due || 0);
      try {
        await promptPayment(empId, empName, due);
      } catch {}
    });

    $("#prDeleteRunBtn")?.addEventListener("click", deleteDraftRun);

    $("#prDeletePeriodBtn")?.addEventListener("click", deleteSelectedPayPeriod);

  }

  // ----------------------------
  // Boot
  // ----------------------------
async function init() {
  const panel = ensureUI();
  if (!panel) return;

  // UI text: make it reflect BIWEEKLY behavior (no logic change)
  const createBtn = $("#prCreateWeeklyPeriodBtn");
  if (createBtn) createBtn.textContent = "Create Biweekly Period";

  try {
    const sel = $("#prPeriodSelect");
    const firstPeriod = await loadPeriodsIntoSelect(sel);

    if (!firstPeriod) {
      $("#prTbody").innerHTML =
        `<tr><td colspan="12" style="padding:14px; opacity:.75;">No pay periods yet. Click “Create Biweekly Period”.</td></tr>`;
      setMeta(null, null);
      renderKPIs([], []);
      bindEvents();
      return;
    }

    currentPeriod = firstPeriod;
    bindEvents();
    await refreshAll(sel.value);
  } catch (err) {
    showAdminError("Payroll init failed", safeErrMsg(err));
  }
}


  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
