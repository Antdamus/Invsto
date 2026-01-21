/* =========================================================
   OG Jewelers — Admin Payroll (Mobile-first Console)
   admin-payroll.js (FULL REPLACEMENT)

   Adds:
   - Employee-side FICA estimate display (SS + Medicare) + Net before federal withholding
   - Persists FICA amounts to DB via RPC: apply_fica_deductions_to_run(_run_id)
   - Contractors show "no withholding"

   Requires DB migration + RPC from instructions.
   ========================================================= */

(function () {
  const ORG_TZ = "America/New_York";

  // ----------------------------
  // Supabase + helpers
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

  function minutesBetween(a, b) {
    try {
      const ms = new Date(b).getTime() - new Date(a).getTime();
      return Math.max(0, Math.round(ms / 60000));
    } catch {
      return 0;
    }
  }

  // ----------------------------
  // FICA (employee-side) estimate helpers
  // ----------------------------
  function isEmployeeLine(line) {
    const wt = (line?.employees?.worker_type || line?.worker_type || "employee").toLowerCase();
    return wt === "employee";
  }

  function computeFicaFallback(gross) {
    const g = Number(gross || 0);
    const ss = round2(g * 0.062);
    const med = round2(g * 0.0145);
    const fica = round2(ss + med);
    const net = round2(g - fica);
    return { ss, med, fica, net, estimate: true };
  }

  function round2(x) {
    const n = Number(x || 0);
    return Math.round(n * 100) / 100;
  }

  function ficaFromLine(line) {
    // Prefer persisted DB values if present, else fallback compute.
    const gross = Number(line?.gross_pay || 0);

    const ssDb = line?.employee_ss;
    const medDb = line?.employee_medicare;
    const ficaDb = line?.employee_fica;
    const netDb = line?.net_before_federal;

    const hasDb =
      Number.isFinite(Number(ssDb)) &&
      Number.isFinite(Number(medDb)) &&
      Number.isFinite(Number(ficaDb)) &&
      Number.isFinite(Number(netDb));

    if (hasDb) {
      return {
        ss: Number(ssDb),
        med: Number(medDb),
        fica: Number(ficaDb),
        net: Number(netDb),
        estimate: !!line?.fica_is_estimate,
        fromDb: true,
      };
    }

    const fb = computeFicaFallback(gross);
    return { ...fb, fromDb: false };
  }

  // ----------------------------
  // Ensure required DOM exists
  // ----------------------------
  function ensureDom() {
    const panel = document.getElementById("panelPayroll");
    if (!panel) return false;

    const required = [
      "prPeriodSelect",
      "prTbody",
      "prCards",
      "prOverlay",
      "prActionSheet",
      "prDetailSheet",
      "prPaySheet",
    ];
    for (const id of required) {
      if (!document.getElementById(id)) {
        console.error("Payroll HTML missing:", id);
        return false;
      }
    }
    return true;
  }

  // ----------------------------
  // State
  // ----------------------------
  let currentPeriod = null;
  let currentRun = null;
  let currentLines = [];
  let currentPayments = [];
  let pendingReview = [];

  let detailEmpId = null;
  let payEmpId = null;

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

  async function loadLines(runId) {
    // ✅ include worker_type and the new fica columns (they live on payroll_run_lines)
    const { data, error } = await sb()
      .from("payroll_run_lines")
      .select("*, employees(display_name, worker_type)")
      .eq("payroll_run_id", runId)
      .order("gross_pay", { ascending: false });

    if (!error) return data || [];

    // fallback without join
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
  // Pending review detector (unchanged logic)
  // ----------------------------
  function periodBoundsUtc(period) {
    const startIso = `${period.start_date}T00:00:00.000Z`;
    const endPlus1 = new Date(`${period.end_date}T00:00:00.000Z`);
    endPlus1.setUTCDate(endPlus1.getUTCDate() + 1);
    const endIsoExclusive = endPlus1.toISOString();
    return { startIso, endIsoExclusive };
  }

  async function fetchPendingReviewForPeriod(period) {
    if (!period) return [];

    const { startIso, endIsoExclusive } = periodBoundsUtc(period);

    const { data: entries, error: teErr } = await sb()
      .from("time_entries")
      .select("id, employee_id, clock_in, clock_out")
      .gte("clock_in", startIso)
      .lt("clock_in", endIsoExclusive)
      .not("clock_out", "is", null);

    if (teErr) throw teErr;

    const ids = (entries || []).map((r) => r.id);
    if (!ids.length) return [];

    const { data: approvals, error: apErr } = await sb()
      .from("shift_approvals")
      .select("time_entry_id")
      .in("time_entry_id", ids);

    if (apErr) throw apErr;

    const approvedSet = new Set((approvals || []).map((a) => a.time_entry_id));
    const pending = (entries || []).filter((e) => !approvedSet.has(e.id));
    if (!pending.length) return [];

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

  // ----------------------------
  // Sheets: overlay + open/close
  // ----------------------------
  function closeAllSheets() {
    $("#prActionSheet")?.classList.add("hidden");
    $("#prDetailSheet")?.classList.add("hidden");
    $("#prPaySheet")?.classList.add("hidden");
    $("#prOverlay")?.classList.add("hidden");
    document.body.classList.remove("pr-sheet-open");
  }

  function openSheet(sheetId) {
    closeAllSheets();
    $("#prOverlay")?.classList.remove("hidden");
    document.body.classList.add("pr-sheet-open");
    document.getElementById(sheetId)?.classList.remove("hidden");
  }

  // ----------------------------
  // Meta + KPI + helpers
  // ----------------------------
  function computePaidByEmployee(payments) {
    const map = new Map();
    for (const p of payments || []) {
      const k = p.employee_id;
      map.set(k, (map.get(k) || 0) + Number(p.amount || 0));
    }
    return map;
  }

  function extractTotalsFromDetails(l) {
    const breakdown = l?.details?.day_breakdown;
    if (!Array.isArray(breakdown) || !breakdown.length) {
      const paidSeconds = Number(l.paid_seconds || 0);
      const roundedMin = Math.round(paidSeconds / 60);
      return {
        minutesWorked: roundedMin,
        paidBreak: 0,
        unpaidBreak: 0,
        roundedMin,
        hoursRounded: roundedMin / 60,
      };
    }

    let workedMin = 0;
    let paidBreakMin = 0;
    let unpaidBreakMin = 0;
    let roundedMin = 0;

    for (const d of breakdown) {
      const wh = Number(d.worked_hours || 0);
      const breakMin = Number(d.break_minutes || 0);
      const unpaidMin = Number(d.unpaid_break_minutes || 0);
      const paidRoundedHrs = Number(d.paid_hours_rounded || 0);

      workedMin += Math.round(wh * 60);
      unpaidBreakMin += Math.round(unpaidMin);
      paidBreakMin += Math.max(0, Math.round(breakMin - unpaidMin));
      roundedMin += Math.round(paidRoundedHrs * 60);
    }

    const minutesWorked = Math.max(0, workedMin - unpaidBreakMin);

    return {
      minutesWorked,
      paidBreak: paidBreakMin,
      unpaidBreak: unpaidBreakMin,
      roundedMin,
      hoursRounded: roundedMin / 60,
    };
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

    $("#prKpiLines").textContent = String((lines || []).length);
    $("#prKpiGross").textContent = fmtMoney(gross);
    $("#prKpiPaid").textContent = fmtMoney(paid);
    $("#prKpiDue").textContent = fmtMoney(due);
  }

  function renderPendingBanner() {
    const wrap = $("#prPendingWrap");
    const countEl = $("#prPendingCount");
    const finalizeDesktop = $("#prFinalizeRun");
    const finalizeMobile = $("#prMobileFinalize");

    if (!wrap || !countEl) return;

    const count = pendingReview.length;

    if (!count) {
      wrap.classList.add("hidden");
      if (finalizeDesktop) finalizeDesktop.disabled = false;
      if (finalizeMobile) finalizeMobile.disabled = false;
      return;
    }

    countEl.textContent = String(count);
    wrap.classList.remove("hidden");

    if (finalizeDesktop) finalizeDesktop.disabled = true;
    if (finalizeMobile) finalizeMobile.disabled = true;
  }

  function tryGoToOverviewTab() {
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
  // Rendering
  // ----------------------------
  async function renderLines(lines, payments) {
    renderKPIs(lines, payments);
    renderTable(lines, payments);
    renderCards(lines, payments);
  }

  function renderEmptyState(payments) {
    const tbody = $("#prTbody");
    const cards = $("#prCards");

    const pendingCount = pendingReview.length;
    const hint = pendingCount
      ? `<div class="og-payroll-hint">${pendingCount} shift${pendingCount === 1 ? "" : "s"} are pending review. Approve them in Overview, then rebuild.</div>`
      : "";

    if (tbody) {
      tbody.innerHTML = `
        <tr>
          <td colspan="6" style="padding:14px; opacity:.75;">
            No lines yet. Click “Build Lines”.
            ${hint}
          </td>
        </tr>
      `;
    }

    if (cards) {
      cards.innerHTML = `
        <div class="og-payroll-empty">
          <div class="og-payroll-empty-title">No lines yet</div>
          <div class="og-payroll-empty-sub">Tap <b>Build</b> to generate payroll lines.</div>
          ${pendingCount ? `<div class="og-payroll-empty-warn">${pendingCount} shift(s) still need review in Overview.</div>` : ""}
        </div>
      `;
    }

    renderKPIs([], payments);
  }

  function renderTable(lines, payments) {
    const tbody = $("#prTbody");
    if (!tbody) return;

    if (!lines || !lines.length) {
      renderEmptyState(payments);
      return;
    }

    const paidMap = computePaidByEmployee(payments);
    const canPay = !!currentRun && currentRun.status === "final";

    tbody.innerHTML = lines
      .map((l) => {
        const name = l.employees?.display_name || l.display_name || l.employee_id;
        const paid = Number(paidMap.get(l.employee_id) || 0);
        const gross = Number(l.gross_pay || 0);
        const due = Math.max(0, gross - paid);
        const t = extractTotalsFromDetails(l);

        // small hint in subline for employees
        let sub2 = "";
        if (isEmployeeLine(l)) {
          const fica = ficaFromLine(l);
          sub2 = ` • Net(pre-fed): ${fmtMoney(fica.net)}`;
        }

        return `
          <tr class="og-pr-row">
            <td class="og-pr-cell">
              <div class="og-pr-name">${escapeHtml(name)}</div>
              <div class="og-pr-sub">${Number(l.shift_count || 0)} shifts • ${t.hoursRounded.toFixed(2)} hrs${sub2}</div>
            </td>
            <td class="og-pr-cell num">${t.hoursRounded.toFixed(2)}</td>
            <td class="og-pr-cell num">${fmtMoney(gross)}</td>
            <td class="og-pr-cell num">${fmtMoney(paid)}</td>
            <td class="og-pr-cell num"><b>${fmtMoney(due)}</b></td>
            <td class="og-pr-cell actions">
              <button class="btn ghost prDetailBtn"
                type="button"
                data-emp="${escapeAttr(l.employee_id)}"
              >Details</button>

              <button class="btn prPayBtn"
                type="button"
                data-emp="${escapeAttr(l.employee_id)}"
                data-name="${escapeAttr(name)}"
                data-due="${due}"
                ${canPay ? "" : "disabled"}
                title="${canPay ? "Record payment" : "Finalize run to record payments"}"
              >Pay</button>

              <button class="btn ghost prPdfBtn"
                type="button"
                data-run="${escapeAttr(currentRun?.id || "")}"
                data-emp="${escapeAttr(l.employee_id)}"
              >PDF</button>
            </td>
          </tr>
        `;
      })
      .join("");
  }

  function renderCards(lines, payments) {
    const root = $("#prCards");
    if (!root) return;

    if (!lines || !lines.length) return;

    const paidMap = computePaidByEmployee(payments);
    const canPay = !!currentRun && currentRun.status === "final";

    root.innerHTML = lines
      .map((l) => {
        const name = l.employees?.display_name || l.display_name || l.employee_id;
        const paid = Number(paidMap.get(l.employee_id) || 0);
        const gross = Number(l.gross_pay || 0);
        const due = Math.max(0, gross - paid);
        const t = extractTotalsFromDetails(l);
        const shifts = Number(l.shift_count || 0);

        let netLine = "";
        if (isEmployeeLine(l)) {
          const fica = ficaFromLine(l);
          netLine = `<div><span>Net (pre-fed)</span><b>${fmtMoney(fica.net)}</b></div>`;
        }

        return `
          <div class="og-payroll-card">
            <div class="og-payroll-card-top">
              <div class="og-payroll-card-name">${escapeHtml(name)}</div>
              <div class="og-payroll-card-due">${fmtMoney(due)}</div>
            </div>

            <div class="og-payroll-card-mini">
              <div><span>Shifts</span><b>${shifts}</b></div>
              <div><span>Hours</span><b>${t.hoursRounded.toFixed(2)}</b></div>
              <div><span>Gross</span><b>${fmtMoney(gross)}</b></div>
              ${netLine}
              <div><span>Paid</span><b>${fmtMoney(paid)}</b></div>
            </div>

            <div class="og-payroll-card-actions">
              <button class="btn ghost prDetailBtn" type="button" data-emp="${escapeAttr(l.employee_id)}">Details</button>
              <button class="btn prPayBtn" type="button"
                data-emp="${escapeAttr(l.employee_id)}"
                data-name="${escapeAttr(name)}"
                data-due="${due}"
                ${canPay ? "" : "disabled"}
                title="${canPay ? "Record payment" : "Finalize run to record payments"}"
              >Pay</button>
              <button class="btn ghost prPdfBtn" type="button"
                data-run="${escapeAttr(currentRun?.id || "")}"
                data-emp="${escapeAttr(l.employee_id)}"
              >PDF</button>
            </div>
          </div>
        `;
      })
      .join("");
  }

  // ----------------------------
  // Detail + Payment sheets
  // ----------------------------
  function renderPaymentsList(employeeId, payments) {
    const list = (payments || []).filter((p) => p.employee_id === employeeId).slice(0, 10);

    if (!list.length) {
      return `<div class="og-payroll-pay-empty">No payments recorded for this run.</div>`;
    }

    return `
      <div class="og-payroll-paylist">
        ${list
          .map((p) => {
            const dt = p.paid_at ? new Date(p.paid_at).toLocaleString() : "";
            return `
              <div class="og-payroll-payitem">
                <div class="og-payroll-payitem-top">
                  <b>${fmtMoney(p.amount)}</b>
                  <span>${escapeHtml(p.method || "other")}</span>
                </div>
                <div class="og-payroll-payitem-sub">
                  ${escapeHtml(dt)}${p.reference ? ` • ${escapeHtml(p.reference)}` : ""}${p.note ? ` • ${escapeHtml(p.note)}` : ""}
                </div>
              </div>
            `;
          })
          .join("")}
      </div>
    `;
  }

  function buildDetailHtml(line, payments) {
    const paidMap = computePaidByEmployee(payments);
    const name = line.employees?.display_name || line.display_name || line.employee_id;

    const paid = Number(paidMap.get(line.employee_id) || 0);
    const gross = Number(line.gross_pay || 0);
    const due = Math.max(0, gross - paid);

    const t = extractTotalsFromDetails(line);
    const rate = Number(line.hourly_rate || 0);
    const shifts = Number(line.shift_count || 0);

    // ✅ FICA panel (employees only)
    let ficaBlock = `
      <div class="og-payroll-detail-divider"></div>
      <div class="og-payroll-detail-row">
        <div class="og-payroll-detail-k">Withholding</div>
        <div class="og-payroll-detail-v">Not withheld (1099 contractor)</div>
      </div>
    `;

    if (isEmployeeLine(line)) {
      const fica = ficaFromLine(line);
      const badge = fica.fromDb ? "" : " (est.)";
      ficaBlock = `
        <div class="og-payroll-detail-divider"></div>

        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Social Security (6.2%)</div>
          <div class="og-payroll-detail-v">-${fmtMoney(fica.ss)}${badge}</div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Medicare (1.45%)</div>
          <div class="og-payroll-detail-v">-${fmtMoney(fica.med)}${badge}</div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k"><b>Total FICA (7.65%)</b></div>
          <div class="og-payroll-detail-v"><b>-${fmtMoney(fica.fica)}${badge}</b></div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k"><b>Net before federal</b></div>
          <div class="og-payroll-detail-v"><b>${fmtMoney(fica.net)}${badge}</b></div>
        </div>

        <div class="og-payroll-detail-row" style="opacity:.75;">
          <div class="og-payroll-detail-k">Federal withholding</div>
          <div class="og-payroll-detail-v">Handled by accountant (W-4)</div>
        </div>
      `;
    }

    return `
      <div class="og-payroll-detail-block">
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Employee</div>
          <div class="og-payroll-detail-v"><b>${escapeHtml(name)}</b></div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Shifts</div>
          <div class="og-payroll-detail-v">${shifts}</div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Minutes (paid)</div>
          <div class="og-payroll-detail-v">${t.minutesWorked}</div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Paid break</div>
          <div class="og-payroll-detail-v">${t.paidBreak} min</div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Unpaid break</div>
          <div class="og-payroll-detail-v">${t.unpaidBreak} min</div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Rounded</div>
          <div class="og-payroll-detail-v">${t.roundedMin} min (${t.hoursRounded.toFixed(2)} hrs)</div>
        </div>

        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Rate</div>
          <div class="og-payroll-detail-v">${fmtMoney(rate)}/hr</div>
        </div>

        <div class="og-payroll-detail-divider"></div>

        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Gross</div>
          <div class="og-payroll-detail-v"><b>${fmtMoney(gross)}</b></div>
        </div>

        ${ficaBlock}

        <div class="og-payroll-detail-divider"></div>

        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Paid</div>
          <div class="og-payroll-detail-v">${fmtMoney(paid)}</div>
        </div>
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Due</div>
          <div class="og-payroll-detail-v"><b>${fmtMoney(due)}</b></div>
        </div>
      </div>

      <div class="og-payroll-detail-payments">
        <div class="og-payroll-detail-payments-title">Payments (latest)</div>
        ${renderPaymentsList(line.employee_id, payments)}
      </div>
    `;
  }

  function openDetailSheet(empId) {
    const line = (currentLines || []).find((l) => l.employee_id === empId);
    if (!line) return;

    detailEmpId = empId;

    const title = $("#prDetailTitle");
    const body = $("#prDetailBody");

    const name = line.employees?.display_name || line.display_name || line.employee_id;
    if (title) title.textContent = name;
    if (body) body.innerHTML = buildDetailHtml(line, currentPayments);

    const canPay = !!currentRun && currentRun.status === "final";
    const payBtn = $("#prDetailPayBtn");
    if (payBtn) {
      payBtn.disabled = !canPay;
      payBtn.title = canPay ? "" : "Finalize run to record payments";
    }

    openSheet("prDetailSheet");
  }

  function setMethodSeg(method) {
    const segBtns = Array.from(document.querySelectorAll("#prPaySheet .og-seg-btn"));
    segBtns.forEach((b) => b.classList.toggle("is-active", b.dataset.method === method));
    const hidden = $("#prPayMethod");
    if (hidden) hidden.value = method;
  }

  function openPaySheet(empId, empName, due) {
    payEmpId = empId;

    $("#prPayAmount").value = (Number(due || 0) || 0).toFixed(2);
    $("#prPayRef").value = "";
    $("#prPayNote").value = "";

    setMethodSeg("zelle");

    const sheet = $("#prPaySheet");
    sheet.dataset.emp = empId;
    sheet.dataset.name = empName || empId;
    sheet.dataset.due = String(Number(due || 0));

    openSheet("prPaySheet");
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

  async function previewPdfForEmployee(runId, empId) {
    let w = null;

    try {
      w = window.open("", "_blank");
      if (w) {
        w.document.title = "Generating PDF…";
        w.document.body.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial";
        w.document.body.style.padding = "18px";
        w.document.body.innerHTML = `
          <div style="max-width:640px;margin:0 auto;">
            <div style="font-size:18px;font-weight:800;letter-spacing:.2px;">Generating payroll PDF…</div>
            <div style="margin-top:8px;opacity:.75;line-height:1.4;">
              Please keep this tab open. It will load automatically.
            </div>
            <div style="margin-top:14px;height:10px;border-radius:999px;background:rgba(0,0,0,.12);overflow:hidden;">
              <div style="width:60%;height:100%;background:rgba(0,0,0,.35);border-radius:999px;animation:pulse 1.2s ease-in-out infinite;"></div>
            </div>
            <style>
              @keyframes pulse { 0%{transform:translateX(-40%)} 50%{transform:translateX(20%)} 100%{transform:translateX(120%)} }
            </style>
          </div>
        `;
      }

      const session = (await sb().auth.getSession()).data.session;
      if (!session) {
        toast("Not authenticated", "err");
        if (w) w.close();
        return;
      }

      const res = await fetch(`${sb().supabaseUrl}/functions/v1/payroll-statement-pdf`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ run_id: runId, employee_id: empId }),
      });

      if (!res.ok) {
        const text = await res.text();
        console.error("PDF function error:", text);
        throw new Error(text || `PDF generation failed (${res.status})`);
      }

      const blob = await res.blob();
      const blobUrl = URL.createObjectURL(blob);

      if (w && !w.closed) {
        try {
          w.location.href = blobUrl;
        } catch {
          w.document.body.innerHTML = `
            <div style="font-family:system-ui;padding:18px;">
              <div style="font-weight:800;">Tap to open PDF</div>
              <a href="${blobUrl}" target="_blank" rel="noopener" style="display:inline-block;margin-top:10px;">
                Open PDF
              </a>
            </div>
          `;
        }
      } else {
        const a = document.createElement("a");
        a.href = blobUrl;
        a.download = `payroll_statement_${empId}.pdf`;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }

      setTimeout(() => URL.revokeObjectURL(blobUrl), 120000);
    } catch (err) {
      showAdminError("PDF preview failed", safeErrMsg(err));
      if (w && !w.closed) {
        try {
          w.document.body.innerHTML = `
            <div style="font-family:system-ui;padding:18px;">
              <div style="font-weight:900;">PDF failed</div>
              <div style="margin-top:8px;opacity:.8;white-space:pre-wrap;">${escapeHtml(safeErrMsg(err))}</div>
            </div>
          `;
        } catch {}
      }
    }
  }

  // ----------------------------
  // Actions (RPC wrappers)
  // ----------------------------
  function uiRoundingMode() {
    const v = $("#prRoundingSelect")?.value || "none";
    if (v === "5") return "nearest_5";
    if (v === "15") return "nearest_15";
    if (v === "10") return "nearest_10";
    return "none";
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

      // ✅ Persist FICA estimates right after building lines
      try {
        const r2 = await sb().rpc("apply_fica_deductions_to_run", { _run_id: currentRun.id });
        if (r2?.error) throw r2.error;
      } catch (e2) {
        // Don’t fail build if this RPC isn't deployed yet
        console.warn("apply_fica_deductions_to_run failed:", safeErrMsg(e2));
      }

      toast("Payroll lines built", "ok");
      await refreshAll(currentPeriod.id);

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

      // ✅ Ensure deductions exist in DB at the end (final)
      try {
        const r2 = await sb().rpc("apply_fica_deductions_to_run", { _run_id: currentRun.id });
        if (r2?.error) throw r2.error;
      } catch (e2) {
        console.warn("apply_fica_deductions_to_run failed:", safeErrMsg(e2));
      }

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

  async function deleteDraftRun() {
    if (!currentRun) return toast("No run selected", "err");
    if (currentRun.status !== "draft") return toast("Only draft runs can be deleted", "err");

    const ok = confirm("Delete this draft payroll run?\n\nThis will delete ALL built lines for this run. This cannot be undone.");
    if (!ok) return;

    try {
      const { error } = await sb().rpc("delete_payroll_run", { _run_id: currentRun.id });
      if (error) throw error;

      toast("Draft run deleted", "ok");
      await refreshAll(currentPeriod.id);
    } catch (e) {
      showAdminError("Delete run failed", safeErrMsg(e));
      throw e;
    }
  }

  async function deleteSelectedPayPeriod() {
    if (!currentPeriod) return toast("No pay period selected", "err");
    if (currentPeriod.status === "locked") return toast("Cannot delete a locked pay period", "err");

    const ok = confirm(
      "Delete this pay period?\n\nThis is only allowed while the period is OPEN.\nIf the period has draft runs, you can optionally force-delete them too.\n\nThis cannot be undone."
    );
    if (!ok) return;

    const force = confirm(
      "Force delete?\n\nOK = delete the period even if it has draft runs (deletes those draft runs and their lines too).\nCancel = safe delete only (works only if there are no runs)."
    );

    try {
      const { error } = await sb().rpc("delete_pay_period", {
        _period_id: currentPeriod.id,
        _force: force,
      });
      if (error) throw error;

      toast("Pay period deleted", "ok");

      const sel = $("#prPeriodSelect");
      const newest = await loadPeriodsIntoSelect(sel);

      if (!newest) {
        currentPeriod = null;
        currentRun = null;
        currentLines = [];
        currentPayments = [];
        pendingReview = [];
        renderPendingBanner();
        renderEmptyState([]);
        return;
      }

      currentPeriod = newest;
      await refreshAll(sel.value);
    } catch (e) {
      showAdminError("Delete pay period failed", safeErrMsg(e));
      throw e;
    }
  }

  // ----------------------------
  // Export CSV (unchanged, but you can add fica columns later if you want)
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
      "employee_ss",
      "employee_medicare",
      "employee_fica",
      "net_before_federal",
      "paid_amount",
      "due_amount",
    ];

    const rows = (lines || []).map((l) => {
      const name = l.employees?.display_name || l.display_name || "";
      const gross = Number(l.gross_pay || 0);
      const paid = Number(paidMap.get(l.employee_id) || 0);
      const due = Math.max(0, gross - paid);
      const t = extractTotalsFromDetails(l);

      const fica = isEmployeeLine(l) ? ficaFromLine(l) : { ss: 0, med: 0, fica: 0, net: gross };

      const cols = [
        l.employee_id,
        name,
        Number(l.shift_count || 0),
        t.minutesWorked,
        t.paidBreak,
        t.unpaidBreak,
        t.roundedMin,
        t.hoursRounded.toFixed(2),
        Number(l.hourly_rate || 0).toFixed(2),
        gross.toFixed(2),
        Number(fica.ss || 0).toFixed(2),
        Number(fica.med || 0).toFixed(2),
        Number(fica.fica || 0).toFixed(2),
        Number(fica.net || gross).toFixed(2),
        paid.toFixed(2),
        due.toFixed(2),
      ];

      return cols.map(csvCell).join(",");
    });

    return [headers.join(","), ...rows].join("\n");

    function csvCell(v) {
      const s = String(v ?? "");
      if (s.includes(",") || s.includes('"') || s.includes("\n")) return `"${s.replaceAll('"', '""')}"`;
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
  // Refresh
  // ----------------------------
  async function refreshAll(periodId) {
    const { data: p, error: pe } = await sb().from("pay_periods").select("*").eq("id", periodId).single();
    if (pe) throw pe;
    currentPeriod = p;

    try {
      pendingReview = await fetchPendingReviewForPeriod(currentPeriod);
    } catch (e) {
      console.warn("Pending review detector failed:", safeErrMsg(e));
      pendingReview = [];
    }
    renderPendingBanner();

    const runs = await sb()
      .from("payroll_runs")
      .select("*")
      .eq("pay_period_id", periodId)
      .order("created_at", { ascending: false })
      .limit(20);

    if (runs.error) throw runs.error;
    currentRun = (runs.data || [])[0] || null;

    if (!currentRun) {
      currentLines = [];
      currentPayments = [];
      renderPendingBanner();
      renderEmptyState([]);
      return;
    }

    currentLines = await loadLines(currentRun.id);
    currentPayments = await loadPayments(currentRun.id);

    if (!currentLines.length) renderEmptyState(currentPayments);
    else await renderLines(currentLines, currentPayments);
  }

  // ----------------------------
  // Event wiring
  // ----------------------------
  function bindEvents() {
    $("#prOverlay")?.addEventListener("click", closeAllSheets);

    document.addEventListener("click", (e) => {
      const closeBtn = e.target.closest("[data-pr-close]");
      if (!closeBtn) return;
      closeAllSheets();
    });

    $("#prPeriodSelect")?.addEventListener("change", async (e) => {
      const id = e.target.value;
      try {
        await refreshAll(id);
      } catch (err) {
        showAdminError("Load period failed", safeErrMsg(err));
      }
    });

    $("#prCreateDraft")?.addEventListener("click", async () => {
      try { await createDraftRun(); } catch {}
    });

    $("#prBuildLines")?.addEventListener("click", async () => {
      try { await buildLines(); } catch {}
    });

    $("#prFinalizeRun")?.addEventListener("click", async () => {
      try { await finalizeRun(); } catch {}
    });

    $("#prExportCsv")?.addEventListener("click", async () => {
      try { await exportCsv(); } catch {}
    });

    $("#prLockPeriod")?.addEventListener("click", async () => {
      try { await lockPeriod(); } catch {}
    });

    $("#prUnlockPeriod")?.addEventListener("click", async () => {
      try { await unlockPeriod(); } catch {}
    });

    $("#prDeleteDraft")?.addEventListener("click", async () => {
      try { await deleteDraftRun(); } catch {}
    });

    $("#prDeletePeriod")?.addEventListener("click", async () => {
      try { await deleteSelectedPayPeriod(); } catch {}
    });

    $("#prPendingBtn")?.addEventListener("click", tryGoToOverviewTab);

    $("#prMobileBuild")?.addEventListener("click", async () => {
      try { await buildLines(); } catch {}
    });

    $("#prMobileFinalize")?.addEventListener("click", async () => {
      try { await finalizeRun(); } catch {}
    });

    $("#prMobileMore")?.addEventListener("click", () => openSheet("prActionSheet"));

    $("#prSheetCreateDraft")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await createDraftRun(); } catch {}
    });

    $("#prSheetBuild")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await buildLines(); } catch {}
    });

    $("#prSheetFinalize")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await finalizeRun(); } catch {}
    });

    $("#prSheetExport")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await exportCsv(); } catch {}
    });

    $("#prSheetLock")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await lockPeriod(); } catch {}
    });

    $("#prSheetUnlock")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await unlockPeriod(); } catch {}
    });

    $("#prSheetDeleteDraft")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await deleteDraftRun(); } catch {}
    });

    $("#prSheetDeletePeriod")?.addEventListener("click", async () => {
      closeAllSheets();
      try { await deleteSelectedPayPeriod(); } catch {}
    });

    $("#prDetailPayBtn")?.addEventListener("click", () => {
      if (!detailEmpId) return;
      const line = (currentLines || []).find((l) => l.employee_id === detailEmpId);
      if (!line) return;
      const name = line.employees?.display_name || line.display_name || line.employee_id;

      const paidMap = computePaidByEmployee(currentPayments);
      const paid = Number(paidMap.get(line.employee_id) || 0);
      const gross = Number(line.gross_pay || 0);
      const due = Math.max(0, gross - paid);

      openPaySheet(line.employee_id, name, due);
    });

    $("#prDetailPdfBtn")?.addEventListener("click", async () => {
      if (!detailEmpId || !currentRun) return;
      await previewPdfForEmployee(currentRun.id, detailEmpId);
    });

    document.addEventListener("click", (e) => {
      const btn = e.target.closest("#prPaySheet .og-seg-btn");
      if (!btn) return;
      setMethodSeg(btn.dataset.method || "other");
    });

    $("#prPayConfirm")?.addEventListener("click", async () => {
      const sheet = $("#prPaySheet");
      const empId = sheet?.dataset.emp;
      if (!empId) return;

      const amountStr = String($("#prPayAmount")?.value || "").trim();
      const amount = Number(amountStr);

      if (!Number.isFinite(amount) || amount < 0) {
        toast("Invalid amount", "err");
        return;
      }

      const method = ($("#prPayMethod")?.value || "other").trim() || "other";
      const reference = String($("#prPayRef")?.value || "").trim() || null;
      const note = String($("#prPayNote")?.value || "").trim() || null;

      try {
        await recordPayment(empId, amount, method, reference, note);
        closeAllSheets();
      } catch {}
    });

    document.addEventListener("click", async (e) => {
      const detailBtn = e.target.closest(".prDetailBtn");
      if (detailBtn) {
        const empId = detailBtn.dataset.emp;
        if (empId) openDetailSheet(empId);
        return;
      }

      const payBtn = e.target.closest(".prPayBtn");
      if (payBtn) {
        const empId = payBtn.dataset.emp;
        const empName = payBtn.dataset.name || empId;
        const due = Number(payBtn.dataset.due || 0);
        if (empId) openPaySheet(empId, empName, due);
        return;
      }

      const pdfBtn = e.target.closest(".prPdfBtn");
      if (pdfBtn) {
        const runId = pdfBtn.dataset.run || currentRun?.id;
        const empId = pdfBtn.dataset.emp;
        if (runId && empId) await previewPdfForEmployee(runId, empId);
        return;
      }
    });
  }

  // ----------------------------
  // Boot
  // ----------------------------
  async function init() {
    if (!ensureDom()) {
      console.warn("Payroll console HTML not found; skipping payroll init.");
      return;
    }

    try {
      const sel = $("#prPeriodSelect");
      const first = await loadPeriodsIntoSelect(sel);

      bindEvents();

      if (!first) {
        renderEmptyState([]);
        toast("No pay periods yet. Create one first.", "err");
        return;
      }

      currentPeriod = first;
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
