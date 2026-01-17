/* =========================================================
   OG Jewelry — Admin Payroll (Contractors)
   admin-payroll.js  (FULL REPLACEMENT)

   Requires:
   - window.supabaseClient (from initSupabase.js)
   - admin.html contains a container with id="panelPayroll"

   Uses Supabase RPC signatures exactly as created:
   - create_payroll_run(_pay_period_id, _rounding_mode, _note)
   - build_payroll_run_lines(_payroll_run_id)
   - finalize_payroll_run(_payroll_run_id, _note)
   - record_contractor_payment(_payroll_run_id, _employee_id, _amount, _method, _reference, _note, _paid_at)
   - payroll_lock_period(_period_id, _note, _force)
   - payroll_unlock_period(_period_id, _note)
   - create_weekly_pay_period(week_start, weeks, p_timezone, p_note)

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
    // Uses global toast if you have one; otherwise fallback
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

  function fmtHoursFromMinutes(min) {
    const m = Number(min || 0);
    return (m / 60).toFixed(2);
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

  // ----------------------------
  // UI injection
  // ----------------------------
  function ensureUI() {
    const panel = document.getElementById("panelPayroll");
    if (!panel) return null;

    // Only inject once
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
  let currentPeriod = null;   // pay_periods row
  let currentRun = null;      // payroll_runs row
  let currentLines = [];      // payroll_run_lines rows
  let currentPayments = [];   // contractor_payments rows

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

    // pick first
    if (data && data.length) {
      selectEl.value = data[0].id;
      return data[0];
    }
    return null;
  }

  async function loadRunsForPeriod(periodId) {
    // If you have multiple runs per period, we pick newest draft/final.
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
    // Try to pull employee display names via relationship; fallback to manual.
    const { data, error } = await sb()
      .from("payroll_run_lines")
      .select("*, employees(display_name)")
      .eq("payroll_run_id", runId)
      .order("gross_pay", { ascending: false });

    if (!error) return data || [];

    // fallback (if relationship not configured)
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
      runEl.textContent = `Run: ${run.status} • Rounding: ${run.rounding_mode || "(unknown)"} • Created: ${run.created_at ? new Date(run.created_at).toLocaleString() : ""}`;
    } else {
      runEl.textContent = `Run: (none for this period yet)`;
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
      tbody.innerHTML = `<tr><td colspan="12" style="padding:14px; opacity:.75;">No lines yet. Click “Build Lines”.</td></tr>`;
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

  // ----------------------------
  // Actions (RPC wrappers)
  // ----------------------------
  function uiRoundingMode() {
    const v = $("#prRoundingMode")?.value || "nearest_15";
    // Must match DB function expectation.
    if (v !== "nearest_15" && v !== "nearest_5") return "nearest_15";
    return v;
  }

  async function refreshAll(periodId) {
    // period row
    const { data: p, error: pe } = await sb()
      .from("pay_periods")
      .select("*")
      .eq("id", periodId)
      .single();

    if (pe) throw pe;
    currentPeriod = p;

    // runs
    const runs = await loadRunsForPeriod(periodId);
    currentRun = runs[0] || null;

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

  async function createDraftRun() {
    if (!currentPeriod) return;
    const roundingMode = uiRoundingMode();

    // Correct RPC signature: create_payroll_run(_pay_period_id, _rounding_mode, _note)
    try {
      const { data, error } = await sb().rpc("create_payroll_run", {
        _pay_period_id: currentPeriod.id,
        _rounding_mode: roundingMode,
        _note: null,
      });
      if (error) throw error;

      toast("Draft payroll run created", "ok");
      // data may be a row or null depending on PostgREST; refresh from table either way
      await refreshAll(currentPeriod.id);
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

    // Correct signature: build_payroll_run_lines(_payroll_run_id)
    try {
      const { data, error } = await sb().rpc("build_payroll_run_lines", {
        _payroll_run_id: currentRun.id,
      });
      if (error) throw error;

      toast("Payroll lines built", "ok");
      await refreshAll(currentPeriod.id);
      return data;
    } catch (e) {
      showAdminError("Build lines failed", safeErrMsg(e));
      throw e;
    }
  }

  async function finalizeRun() {
    if (!currentRun) return;

    // Correct signature: finalize_payroll_run(_payroll_run_id, _note)
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

    // payroll_lock_period(_period_id, _note, _force)
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

    // payroll_unlock_period(_period_id, _note)
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
    // Create a 7-day period starting on a chosen date (default: today)
    const start = prompt(`Enter week start date (YYYY-MM-DD)`, isoDate(new Date()));
    if (!start) return;

    // create_weekly_pay_period(week_start, weeks, p_timezone, p_note)
    try {
      const { data, error } = await sb().rpc("create_weekly_pay_period", {
        week_start: start,
        weeks: 1,
        p_timezone: ORG_TZ,
        p_note: null,
      });
      if (error) throw error;

      toast("Weekly pay period created", "ok");

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

    // record_contractor_payment(_payroll_run_id, _employee_id, _amount, _method, _reference, _note, _paid_at)
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
  }

  // ----------------------------
  // Boot
  // ----------------------------
  async function init() {
    const panel = ensureUI();
    if (!panel) return;

    try {
      const sel = $("#prPeriodSelect");
      const firstPeriod = await loadPeriodsIntoSelect(sel);

      if (!firstPeriod) {
        $("#prTbody").innerHTML =
          `<tr><td colspan="12" style="padding:14px; opacity:.75;">No pay periods yet. Click “Create Weekly Period”.</td></tr>`;
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

  // Initialize after DOM ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
