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

  // ✅ DB columns from apply_fica_deductions_to_run
  const ssDb = line?.ss_employee;
  const medDb = Number(line?.medicare_employee || 0) + Number(line?.addl_medicare_employee || 0);
  const ficaDb = line?.fica_employee_total;
  const netDb = line?.net_pre_fed;

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
      estimate: false,
      fromDb: true,
      ytd: Number(line?.ytd_wages || 0),
      ssTaxableThisRun: Number(line?.ss_taxable_this_run || 0),
    };
  }

  // Fallback estimate (simple 7.65% on entire gross)
  const fb = computeFicaFallback(gross);
  return { ...fb, fromDb: false, ytd: Number(line?.ytd_wages || 0), ssTaxableThisRun: Number(line?.ss_taxable_this_run || 0) };
}

  function hasNumber(v) {
    return v !== null && v !== undefined && v !== "" && Number.isFinite(Number(v));
  }

  function taxFromLine(line) {
    const gross = Number(line?.gross_pay || 0);
    const fica = isEmployeeLine(line) ? ficaFromLine(line) : { ss: 0, med: 0, fica: 0, net: gross, ytd: 0 };
    const federal = Number(line?.federal_income_tax || 0);
    const state = Number(line?.state_income_tax || 0);
    const local = Number(line?.local_income_tax || 0);
    const employeeTax = hasNumber(line?.employee_tax_total)
      ? Number(line.employee_tax_total)
      : (isEmployeeLine(line) ? Number(fica.fica || 0) : 0);
    const net = hasNumber(line?.net_pay)
      ? Number(line.net_pay)
      : (isEmployeeLine(line) ? Number(fica.net || gross) : gross);
    const employerTax = Number(line?.employer_tax_total || 0);

    return {
      gross,
      federal,
      state,
      local,
      employeeTax,
      net,
      employerTax,
      ssEmployer: Number(line?.ss_employer || 0),
      medicareEmployer: Number(line?.medicare_employer || 0),
      futa: Number(line?.futa_employer || 0),
      suta: Number(line?.suta_employer || 0),
      sutaState: line?.suta_state || line?.tax_details?.work_state || "",
      stateStatus: line?.tax_details?.state_withholding?.status || "",
      fica,
    };
  }

  function payableAmount(line) {
    return taxFromLine(line).net;
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
      "prVoidPaySheet",
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
  let payrollReadiness = null;
  let runsForPeriod = [];

  let detailEmpId = null;
  let payEmpId = null;
  let voidPaymentId = null;

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
      .select("*, employees(display_name, worker_type, role)")
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

  async function loadPayrollReadiness(periodId) {
    if (!periodId) return null;
    const { data, error } = await sb().rpc("payroll_period_readiness", { _period_id: periodId });
    if (error) throw error;
    return data || null;
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
    $("#prVoidPaySheet")?.classList.add("hidden");
    $("#prOverlay")?.classList.add("hidden");
    $("#prPeriodSheet")?.classList.add("hidden");
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
      if (String(p.status || "paid").toLowerCase() !== "paid") continue;
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
        regularMin: Math.round(Number(l.regular_seconds || 0) / 60),
        overtimeMin: Math.round(Number(l.overtime_seconds || 0) / 60),
        hoursRounded: roundedMin / 60,
      };
    }

    let workedMin = 0;
    let paidBreakMin = 0;
    let unpaidBreakMin = 0;
    let roundedMin = 0;
    let regularMin = 0;
    let overtimeMin = 0;

    for (const d of breakdown) {
      const wh = Number(d.worked_hours || 0);
      const breakMin = Number(d.break_minutes || 0);
      const unpaidMin = Number(d.unpaid_break_minutes || 0);
      const paidRoundedHrs = Number(d.paid_hours_rounded || 0);
      const regularHrs = Number(d.regular_hours || 0);
      const overtimeHrs = Number(d.overtime_hours || 0);

      workedMin += Math.round(wh * 60);
      unpaidBreakMin += Math.round(unpaidMin);
      paidBreakMin += Math.max(0, Math.round(breakMin - unpaidMin));
      roundedMin += Math.round(paidRoundedHrs * 60);
      regularMin += Math.round(regularHrs * 60);
      overtimeMin += Math.round(overtimeHrs * 60);
    }

    const minutesWorked = Math.max(0, workedMin - unpaidBreakMin);

    return {
      minutesWorked,
      paidBreak: paidBreakMin,
      unpaidBreak: unpaidBreakMin,
      roundedMin,
      regularMin,
      overtimeMin,
      hoursRounded: roundedMin / 60,
    };
  }

  function renderKPIs(lines, payments) {
    const paidMap = computePaidByEmployee(payments);

    let gross = 0;
    let paid = 0;

    for (const l of lines || []) {
      const g = Number(l.gross_pay || 0);
      const payable = payableAmount(l);
      gross += g;
      paid += Math.min(payable, Number(paidMap.get(l.employee_id) || 0));
    }

    const due = (lines || []).reduce((sum, l) => {
      const paidForLine = Math.min(payableAmount(l), Number(paidMap.get(l.employee_id) || 0));
      return sum + Math.max(0, payableAmount(l) - paidForLine);
    }, 0);

    $("#prKpiLines").textContent = String((lines || []).length);
    $("#prKpiGross").textContent = fmtMoney(gross);
    $("#prKpiPaid").textContent = fmtMoney(paid);
    $("#prKpiDue").textContent = fmtMoney(due);
  }

  function readinessItems(readiness = payrollReadiness) {
    if (!readiness) {
      return pendingReview.length
        ? [{ key: "pending_approval", label: "Pending review", count: pendingReview.length }]
        : [];
    }

    const defs = [
      ["open_shifts", "Open shifts"],
      ["open_breaks", "Open breaks"],
      ["pending_approval", "Pending approvals"],
      ["unwaived_anomalies", "Unwaived anomalies"],
      ["missing_rates", "Missing rates"],
      ["missing_work_location_tax_addresses", "Missing work-state setup"],
      ["pending_state_withholding_engine", "State tax engine pending"],
    ];

    return defs
      .map(([key, label]) => ({ key, label, count: Number(readiness[key] || 0) }))
      .filter((item) => item.count > 0);
  }

  function readinessWarnings(readiness = payrollReadiness) {
    const warnings = [];
    if (!readiness) return warnings;

    const drafts = Number(readiness.draft_runs || 0);
    const sellers = Number(readiness.seller_excluded || 0);
    const taxWarnings = readiness.tax_readiness?.warnings || {};
    const missingW4 = Number(taxWarnings.missing_w4_uses_irs_default_single_no_adjustments || 0);
    const missingStateRate = Number(taxWarnings.missing_state_account_uses_new_employer_estimate || 0);
    const missingI9 = Number(taxWarnings.missing_i9_should_be_fixed_before_production || 0);
    const missingTin = Number(taxWarnings.missing_tax_id_blocks_w2_filing || 0);

    if (drafts > 1) warnings.push(`${drafts} draft runs exist for this period`);
    if (sellers > 0) warnings.push(`${sellers} seller time entr${sellers === 1 ? "y is" : "ies are"} excluded from hourly payroll`);
    if (missingW4 > 0) warnings.push(`${missingW4} employee${missingW4 === 1 ? "" : "s"} using IRS default W-4`);
    if (missingStateRate > 0) warnings.push(`${missingStateRate} state account/rate estimate${missingStateRate === 1 ? "" : "s"}`);
    if (missingI9 > 0) warnings.push(`${missingI9} I-9 record${missingI9 === 1 ? "" : "s"} missing`);
    if (missingTin > 0) warnings.push(`${missingTin} tax ID record${missingTin === 1 ? "" : "s"} missing`);
    return warnings;
  }

  function readinessBlockCount() {
    return readinessItems().reduce((sum, item) => sum + item.count, 0);
  }

  function readinessBlockerText() {
    const items = readinessItems();
    if (!items.length) return "";
    return items.map((item) => `${item.label}: ${item.count}`).join(" • ");
  }

  function assertPayrollReady(actionLabel) {
    const items = readinessItems();
    if (!items.length) return true;

    showAdminError(
      "Payroll is not ready",
      `${actionLabel} is blocked until these are fixed:\n\n${items.map((i) => `- ${i.label}: ${i.count}`).join("\n")}`
    );
    return false;
  }

  function setBtnState(id, disabled, title = "") {
    const el = document.getElementById(id);
    if (!el) return;
    el.disabled = !!disabled;
    if (title) el.title = title;
    else el.removeAttribute("title");
  }

  function syncActionState() {
    const blockers = readinessBlockCount();
    const hasRun = !!currentRun;
    const isDraft = currentRun?.status === "draft";
    const isFinal = currentRun?.status === "final";
    const periodLocked = currentPeriod?.status === "locked";
    const finalExists = Number(payrollReadiness?.final_runs || 0) > 0 || isFinal;

    const blockerTitle = blockers ? readinessBlockerText() : "";

    setBtnState("prCreateDraft", finalExists, finalExists ? "This period already has a final payroll run" : "");
    setBtnState("prSheetCreateDraft", finalExists, finalExists ? "This period already has a final payroll run" : "");

    setBtnState("prBuildLines", !hasRun || !isDraft || blockers, blockers ? blockerTitle : (!isDraft ? "Only draft runs can be rebuilt" : ""));
    setBtnState("prMobileBuild", !hasRun || !isDraft || blockers, blockers ? blockerTitle : (!isDraft ? "Only draft runs can be rebuilt" : ""));
    setBtnState("prSheetBuild", !hasRun || !isDraft || blockers, blockers ? blockerTitle : (!isDraft ? "Only draft runs can be rebuilt" : ""));

    setBtnState("prFinalizeRun", !hasRun || !isDraft || blockers, blockers ? blockerTitle : (!isDraft ? "Only draft runs can be finalized" : ""));
    setBtnState("prMobileFinalize", !hasRun || !isDraft || blockers, blockers ? blockerTitle : (!isDraft ? "Only draft runs can be finalized" : ""));
    setBtnState("prSheetFinalize", !hasRun || !isDraft || blockers, blockers ? blockerTitle : (!isDraft ? "Only draft runs can be finalized" : ""));

    setBtnState("prLockPeriod", periodLocked || blockers, periodLocked ? "Pay period is already locked" : blockerTitle);
    setBtnState("prSheetLock", periodLocked || blockers, periodLocked ? "Pay period is already locked" : blockerTitle);
    setBtnState("prUnlockPeriod", !periodLocked || finalExists, finalExists ? "Final payroll runs keep the period locked" : "");
    setBtnState("prSheetUnlock", !periodLocked || finalExists, finalExists ? "Final payroll runs keep the period locked" : "");
  }

  function renderPendingBanner() {
    const wrap = $("#prPendingWrap");
    const countEl = $("#prPendingCount");
    const titleEl = $("#prPendingTitle");
    const subEl = $("#prPendingSub");

    if (!wrap || !countEl) return;

    const items = readinessItems();
    const warnings = readinessWarnings();
    const count = items.reduce((sum, item) => sum + item.count, 0);

    if (!count && !warnings.length) {
      wrap.classList.add("hidden");
      syncActionState();
      return;
    }

    countEl.textContent = String(count);
    if (titleEl) {
      titleEl.innerHTML = count
        ? `<span id="prPendingCount">${count}</span> payroll blocker${count === 1 ? "" : "s"}`
        : "Payroll note";
    }
    if (subEl) {
      const blockerText = items.map((item) => `${item.label}: ${item.count}`).join(" • ");
      const warningText = warnings.join(" • ");
      subEl.textContent = [blockerText, warningText].filter(Boolean).join(" • ");
    }
    wrap.classList.remove("hidden");

    syncActionState();
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
    const blockerText = readinessBlockerText();
    const hint = blockerText
      ? `<div class="og-payroll-hint">${escapeHtml(blockerText)}. Fix these before building payroll.</div>`
      : pendingCount
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
          ${blockerText ? `<div class="og-payroll-empty-warn">${escapeHtml(blockerText)}</div>` : pendingCount ? `<div class="og-payroll-empty-warn">${pendingCount} shift(s) still need review in Overview.</div>` : ""}
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
        const taxes = taxFromLine(l);
        const due = Math.max(0, taxes.net - paid);
        const t = extractTotalsFromDetails(l);
        const overtimeNote = t.overtimeMin > 0 ? ` • OT ${(t.overtimeMin / 60).toFixed(2)} hrs` : "";
        const canPayLine = canPay && due > 0.009;

        // small hint in subline for employees
        let sub2 = "";
        if (isEmployeeLine(l)) {
          sub2 = ` • Net pay: ${fmtMoney(taxes.net)}`;
        }

        return `
          <tr class="og-pr-row">
            <td class="og-pr-cell">
              <div class="og-pr-name">${escapeHtml(name)}</div>
              <div class="og-pr-sub">${Number(l.shift_count || 0)} shifts • ${t.hoursRounded.toFixed(2)} hrs${overtimeNote}${sub2}</div>
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
                ${canPayLine ? "" : "disabled"}
                title="${canPay ? (due > 0.009 ? "Record payment" : "Already paid") : "Finalize run to record payments"}"
              >Pay</button>

              <button class="btn ghost prPdfBtn"
                type="button"
                data-run="${escapeAttr(currentRun?.id || "")}"
                data-emp="${escapeAttr(l.employee_id)}"
              >Statement</button>
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
        const taxes = taxFromLine(l);
        const due = Math.max(0, taxes.net - paid);
        const t = extractTotalsFromDetails(l);
        const shifts = Number(l.shift_count || 0);
        const canPayLine = canPay && due > 0.009;

        let netLine = "";
        if (isEmployeeLine(l)) {
          netLine = `<div><span>Net pay</span><b>${fmtMoney(taxes.net)}</b></div>`;
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
              <div><span>Regular</span><b>${(t.regularMin / 60).toFixed(2)}</b></div>
              <div><span>Overtime</span><b>${(t.overtimeMin / 60).toFixed(2)}</b></div>
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
                ${canPayLine ? "" : "disabled"}
                title="${canPay ? (due > 0.009 ? "Record payment" : "Already paid") : "Finalize run to record payments"}"
              >Pay</button>
              <button class="btn ghost prPdfBtn" type="button"
                data-run="${escapeAttr(currentRun?.id || "")}"
                data-emp="${escapeAttr(l.employee_id)}"
              >Statement</button>
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
            const status = String(p.status || "paid").toLowerCase();
            const statusText = status === "void" ? "void" : (p.method || "other");
            const reason = status === "void" && p.void_reason ? `Voided: ${p.void_reason}` : "";
            const canVoid = status === "paid" && currentRun?.status === "final";
            return `
              <div class="og-payroll-payitem ${status === "void" ? "is-void" : ""}">
                <div class="og-payroll-payitem-top">
                  <b>${fmtMoney(p.amount)}</b>
                  <span>${escapeHtml(statusText)}</span>
                </div>
                <div class="og-payroll-payitem-sub">
                  ${escapeHtml(dt)}${p.reference ? ` • ${escapeHtml(p.reference)}` : ""}${p.note ? ` • ${escapeHtml(p.note)}` : ""}${reason ? ` • ${escapeHtml(reason)}` : ""}
                </div>
                ${canVoid ? `<button type="button" class="og-payroll-payitem-void prVoidPaymentBtn" data-payment="${escapeHtml(p.id)}">Void payment</button>` : ""}
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
    const taxes = taxFromLine(line);
    const due = Math.max(0, taxes.net - paid);

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
  const fica = taxes.fica;
  const stateLabel = taxes.sutaState ? ` (${escapeHtml(taxes.sutaState)})` : "";
  const stateStatus = taxes.stateStatus === "calculation_pending"
    ? `<div class="og-payroll-detail-row" style="opacity:.75;">
        <div class="og-payroll-detail-k">State withholding${stateLabel}</div>
        <div class="og-payroll-detail-v">Engine pending</div>
      </div>`
    : `<div class="og-payroll-detail-row">
        <div class="og-payroll-detail-k">State withholding${stateLabel}</div>
        <div class="og-payroll-detail-v">-${fmtMoney(taxes.state)}</div>
      </div>`;

  ficaBlock = `
    <div class="og-payroll-detail-divider"></div>

    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">YTD wages (est.)</div>
      <div class="og-payroll-detail-v">${fmtMoney(fica.ytd || 0)}</div>
    </div>

    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">Social Security (6.2%)</div>
      <div class="og-payroll-detail-v">-${fmtMoney(fica.ss)}</div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">Medicare (1.45% + addl if applicable)</div>
      <div class="og-payroll-detail-v">-${fmtMoney(fica.med)}</div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k"><b>Total FICA</b></div>
      <div class="og-payroll-detail-v"><b>-${fmtMoney(fica.fica)}</b></div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">Federal withholding</div>
      <div class="og-payroll-detail-v">-${fmtMoney(taxes.federal)}</div>
    </div>
    ${stateStatus}
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">Local withholding</div>
      <div class="og-payroll-detail-v">-${fmtMoney(taxes.local)}</div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k"><b>Employee tax total</b></div>
      <div class="og-payroll-detail-v"><b>-${fmtMoney(taxes.employeeTax)}</b></div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k"><b>Net pay</b></div>
      <div class="og-payroll-detail-v"><b>${fmtMoney(taxes.net)}</b></div>
    </div>

    <div class="og-payroll-detail-divider"></div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">Employer FICA</div>
      <div class="og-payroll-detail-v">${fmtMoney(taxes.ssEmployer + taxes.medicareEmployer)}</div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">FUTA reserve</div>
      <div class="og-payroll-detail-v">${fmtMoney(taxes.futa)}</div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k">SUTA reserve${stateLabel}</div>
      <div class="og-payroll-detail-v">${fmtMoney(taxes.suta)}</div>
    </div>
    <div class="og-payroll-detail-row">
      <div class="og-payroll-detail-k"><b>Employer tax reserve</b></div>
      <div class="og-payroll-detail-v"><b>${fmtMoney(taxes.employerTax)}</b></div>
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
          <div class="og-payroll-detail-k">Regular / OT</div>
          <div class="og-payroll-detail-v">${(t.regularMin / 60).toFixed(2)} / ${(t.overtimeMin / 60).toFixed(2)} hrs</div>
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
        <div class="og-payroll-detail-row">
          <div class="og-payroll-detail-k">Regular / OT pay</div>
          <div class="og-payroll-detail-v">${fmtMoney(line.regular_pay || 0)} / ${fmtMoney(line.overtime_pay || 0)}</div>
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
    const paidMap = computePaidByEmployee(currentPayments);
    const due = Math.max(0, payableAmount(line) - Number(paidMap.get(line.employee_id) || 0));
    const payBtn = $("#prDetailPayBtn");
    if (payBtn) {
      payBtn.disabled = !canPay || due <= 0.009;
      payBtn.title = canPay ? (due > 0.009 ? "" : "Already paid") : "Finalize run to record payments";
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

  function openVoidPaySheet(paymentId) {
    const payment = (currentPayments || []).find((p) => p.id === paymentId);
    if (!payment || String(payment.status || "paid").toLowerCase() !== "paid") return;

    openSheet("prVoidPaySheet");
    voidPaymentId = paymentId;

    const meta = $("#prVoidPayMeta");
    if (meta) {
      const dt = payment.paid_at ? new Date(payment.paid_at).toLocaleString() : "unknown date";
      meta.textContent = `${fmtMoney(payment.amount)} ${payment.method || "other"} payment from ${dt}. This keeps an audit record and recalculates due.`;
    }

    const reason = $("#prVoidPayReason");
    if (reason) reason.value = "";
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

  async function voidPayment(paymentId, reason) {
    if (!paymentId) return;
    const cleanReason = String(reason || "").trim();
    if (cleanReason.length < 3) {
      toast("Void reason is required", "err");
      return;
    }

    try {
      const { error } = await sb().rpc("void_contractor_payment", {
        _payment_id: paymentId,
        _reason: cleanReason,
      });
      if (error) throw error;

      toast("Payment voided", "ok");
      voidPaymentId = null;
      await refreshAll(currentPeriod.id);
      if (detailEmpId) openDetailSheet(detailEmpId);
    } catch (e) {
      showAdminError("Void payment failed", safeErrMsg(e));
      throw e;
    }
  }

  function payrollStatementHtml(stmt) {
    const employee = stmt?.employee || {};
    const period = stmt?.pay_period || {};
    const summary = stmt?.summary || {};
    const fica = stmt?.fica || {};
    const taxes = stmt?.taxes || {};
    const payments = Array.isArray(stmt?.payments) ? stmt.payments : [];
    const flags = Array.isArray(stmt?.flags) ? stmt.flags : [];
    const days = Array.isArray(stmt?.details?.day_breakdown) ? stmt.details.day_breakdown : [];

    const name = employee.display_name || employee.email || employee.employee_id || "Payroll statement";
    const rows = [
      ["Period", `${period.start_date || ""} to ${period.end_date || ""}`],
      ["Status", stmt?.run?.status || ""],
      ["Shifts", summary.shift_count || 0],
      ["Paid hours", Number(summary.hours_paid || 0).toFixed(2)],
      ["Regular hours", (Number(summary.regular_minutes || 0) / 60).toFixed(2)],
      ["Overtime hours", (Number(summary.overtime_minutes || 0) / 60).toFixed(2)],
      ["Gross", fmtMoney(summary.gross_pay || 0)],
      ["Regular pay", fmtMoney(summary.regular_pay || 0)],
      ["Overtime pay", fmtMoney(summary.overtime_pay || 0)],
      ["Employee FICA", fmtMoney(fica.fica_employee_total || 0)],
      ["Federal withholding", fmtMoney(taxes.federal_income_tax || 0)],
      ["State withholding", fmtMoney(taxes.state_income_tax || 0)],
      ["Local withholding", fmtMoney(taxes.local_income_tax || 0)],
      ["Employee tax total", fmtMoney(taxes.employee_tax_total || fica.fica_employee_total || 0)],
      ["Net pay", fmtMoney(taxes.net_pay || fica.net_pre_fed || summary.gross_pay || 0)],
      ["Employer tax reserve", fmtMoney(taxes.employer_tax_total || 0)],
      ["Paid", fmtMoney(summary.paid_total || 0)],
      ["Due", fmtMoney(summary.due_total || 0)],
    ];

    const paymentRows = payments.length
      ? payments.map((p) => `
          <tr>
            <td>${escapeHtml(p.paid_at ? new Date(p.paid_at).toLocaleString() : "")}</td>
            <td>${escapeHtml(p.status || "paid")}</td>
            <td>${escapeHtml(p.method || "other")}</td>
            <td>${escapeHtml(p.reference || "")}</td>
            <td class="num">${fmtMoney(p.amount || 0)}</td>
          </tr>
        `).join("")
      : `<tr><td colspan="5">No payments recorded.</td></tr>`;

    const flagRows = flags.length
      ? flags.map((f) => `<li>${escapeHtml(f.message || f.type || "Flag")}</li>`).join("")
      : "<li>No statement flags.</li>";

    const dayRows = days.length
      ? days.map((d) => {
          const stores = Array.isArray(d.stores) ? d.stores.map((s) => s.store_name).filter(Boolean).join(", ") : "";
          return `
            <tr>
              <td>${escapeHtml(d.work_date || "")}</td>
              <td>${escapeHtml(stores)}</td>
              <td class="num">${Number(d.worked_hours || 0).toFixed(2)}</td>
              <td class="num">${Number(d.unpaid_break_minutes || 0).toFixed(0)}</td>
              <td class="num">${Number(d.regular_hours || 0).toFixed(2)}</td>
              <td class="num">${Number(d.overtime_hours || 0).toFixed(2)}</td>
              <td class="num">${fmtMoney(d.hourly_rate || 0)}</td>
              <td class="num">${fmtMoney(d.gross_for_day || 0)}</td>
            </tr>
          `;
        }).join("")
      : `<tr><td colspan="8">No day breakdown available.</td></tr>`;

    return `<!doctype html>
      <html>
        <head>
          <meta charset="utf-8" />
          <title>Payroll Statement - ${escapeHtml(name)}</title>
          <style>
            body { font-family: Inter, system-ui, -apple-system, Segoe UI, sans-serif; margin: 0; color: #151515; background: #f5f2eb; }
            .page { max-width: 880px; margin: 0 auto; padding: 32px; }
            .top { display: flex; justify-content: space-between; gap: 20px; align-items: flex-start; border-bottom: 3px solid #1f1b16; padding-bottom: 18px; }
            h1 { margin: 0; font-size: 30px; letter-spacing: 0; }
            .muted { color: #6c655c; margin-top: 6px; }
            .print { border: 0; border-radius: 10px; background: #1f1b16; color: white; padding: 10px 14px; font-weight: 800; cursor: pointer; }
            .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-top: 22px; }
            .cell { background: white; border: 1px solid #ddd6ca; border-radius: 10px; padding: 12px; }
            .k { color: #6c655c; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
            .v { font-size: 20px; font-weight: 850; margin-top: 4px; }
            table { width: 100%; border-collapse: collapse; margin-top: 22px; background: white; border: 1px solid #ddd6ca; }
            th, td { padding: 10px 12px; border-bottom: 1px solid #ece5db; text-align: left; }
            th { background: #1f1b16; color: white; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; }
            .num { text-align: right; font-variant-numeric: tabular-nums; }
            .flags { margin-top: 22px; background: white; border: 1px solid #ddd6ca; border-radius: 10px; padding: 14px 18px; }
            @media print { .print { display: none; } body { background: white; } .page { padding: 0; } }
          </style>
        </head>
        <body>
          <main class="page">
            <div class="top">
              <div>
                <h1>${escapeHtml(name)}</h1>
                <div class="muted">Payroll statement • ${escapeHtml(period.start_date || "")} to ${escapeHtml(period.end_date || "")}</div>
              </div>
              <button class="print" onclick="window.print()">Print / Save PDF</button>
            </div>
            <section class="grid">
              ${rows.map(([k, v]) => `<div class="cell"><div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div></div>`).join("")}
            </section>
            <table>
              <thead><tr><th>Date</th><th>Store</th><th class="num">Worked</th><th class="num">Unpaid break</th><th class="num">Reg</th><th class="num">OT</th><th class="num">Rate</th><th class="num">Gross</th></tr></thead>
              <tbody>${dayRows}</tbody>
            </table>
            <table>
              <thead><tr><th>Paid at</th><th>Status</th><th>Method</th><th>Reference</th><th class="num">Amount</th></tr></thead>
              <tbody>${paymentRows}</tbody>
            </table>
            <section class="flags">
              <div class="k">Audit flags</div>
              <ul>${flagRows}</ul>
            </section>
          </main>
        </body>
      </html>`;
  }

  async function previewStatementForEmployee(runId, empId) {
    let w = window.open("", "_blank");
    if (w) {
      w.document.title = "Generating payroll statement";
      w.document.body.style.fontFamily = "system-ui, -apple-system, Segoe UI, Roboto, Inter, Arial";
      w.document.body.style.padding = "18px";
      w.document.body.innerHTML = "Generating payroll statement...";
    }

    try {
      const { data, error } = await sb().rpc("preview_payroll_statement", {
        _run_id: runId,
        _employee_id: empId,
      });
      if (error) throw error;

      const html = payrollStatementHtml(data);
      if (w && !w.closed) {
        w.document.open();
        w.document.write(html);
        w.document.close();
      } else {
        const blob = new Blob([html], { type: "text/html" });
        const url = URL.createObjectURL(blob);
        window.open(url, "_blank", "noopener");
        setTimeout(() => URL.revokeObjectURL(url), 120000);
      }
    } catch (err) {
      showAdminError("Statement preview failed", safeErrMsg(err));
      if (w && !w.closed) {
        w.document.body.innerHTML = `
          <div style="font-family:system-ui;padding:18px;">
            <div style="font-weight:900;">Statement failed</div>
            <div style="margin-top:8px;opacity:.8;white-space:pre-wrap;">${escapeHtml(safeErrMsg(err))}</div>
          </div>
        `;
      }
    }
  }

  async function previewPdfForEmployee(runId, empId) {
    return previewStatementForEmployee(runId, empId);
    /*
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

    */
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
    if (Number(payrollReadiness?.final_runs || 0) > 0) {
      toast("This period already has a final payroll run", "err");
      return;
    }
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
    if (currentRun.status !== "draft") {
      toast("Only draft payroll runs can be rebuilt", "err");
      return;
    }
    if (!assertPayrollReady("Build lines")) return;

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

    if (currentRun.status !== "draft") {
      toast("Only draft payroll runs can be finalized", "err");
      return;
    }
    if (!assertPayrollReady("Finalize payroll")) return;

    const ok = confirm(
      "Finalize this payroll run?\n\nThis will lock the pay period, rebuild the payroll lines from audited shifts, calculate payroll taxes/reserves, and generate statements."
    );
    if (!ok) return;

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
    if (!assertPayrollReady("Lock period")) return;

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


// ============================
// Pay Period: Generate + Next
// ============================
function addDaysISO(dateISO, days) {
  const d = new Date(`${dateISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(days || 0));
  return d.toISOString().slice(0, 10);
}

function isSunday(iso) {
  // Uses UTC to avoid local offset surprises
  const d = new Date(`${iso}T00:00:00.000Z`);
  return d.getUTCDay() === 0;
}

function openPayPeriodSheet(prefillStartISO = null) {
  // Prefer chaining from current period end_date + 1 day
  const startISO =
    prefillStartISO ||
    (currentPeriod?.end_date
      ? addDaysISO(currentPeriod.end_date, 1)
      : new Date().toISOString().slice(0, 10));

  const startEl = document.getElementById("prPeriodStart");
  const noteEl = document.getElementById("prPeriodNote");

  if (startEl) startEl.value = startISO;
  if (noteEl) noteEl.value = "";

  // Use your standard sheet open behavior
  openSheet("prPeriodSheet");
}

async function createPayPeriodFromSheet() {
  const weekStart = (document.getElementById("prPeriodStart")?.value || "").trim();
  const noteRaw = (document.getElementById("prPeriodNote")?.value || "").trim();
  const note = noteRaw ? noteRaw : null;

  if (!weekStart) return toast("Pick a start date", "err");

  // Optional: enforce your own convention (your label says Sunday)
  if (!isSunday(weekStart)) {
    const ok = confirm(
      `That start date is not a Sunday.\n\nStart: ${weekStart}\n\nContinue anyway?`
    );
    if (!ok) return;
  }

  try {
    // Biweekly = weeks: 2
    let rpc = await sb().rpc("create_weekly_pay_period", {
      week_start: weekStart,
      weeks: 2,
      p_note: note,
    });

    // Defensive fallback if your RPC arg names differ (common in your other RPCs)
    if (rpc?.error && /argument|parameter|unknown|week_start/i.test(String(rpc.error.message || rpc.error))) {
      rpc = await sb().rpc("create_weekly_pay_period", {
        _week_start: weekStart,
        _weeks: 2,
        _note: note,
      });
    }

    if (rpc.error) throw rpc.error;

    toast("Pay period created", "ok");
    closeAllSheets();

    // Reload dropdown + jump to new period
    const sel = document.getElementById("prPeriodSelect");
    const newest = await loadPeriodsIntoSelect(sel);

    if (rpc.data?.id) sel.value = rpc.data.id;
    else if (newest?.id) sel.value = newest.id;

    await refreshAll(sel.value);
  } catch (e) {
    showAdminError("Create pay period failed", safeErrMsg(e));
  }
}

async function createNextPayPeriod() {
  // Needs a current selected period to chain from
  if (!currentPeriod?.end_date) {
    // If none selected yet, just open the sheet
    openPayPeriodSheet(null);
    return;
  }

  const nextStart = addDaysISO(currentPeriod.end_date, 1);

  try {
    let rpc = await sb().rpc("create_weekly_pay_period", {
      week_start: nextStart,
      weeks: 2,
      p_note: null,
    });

    if (rpc?.error && /argument|parameter|unknown|week_start/i.test(String(rpc.error.message || rpc.error))) {
      rpc = await sb().rpc("create_weekly_pay_period", {
        _week_start: nextStart,
        _weeks: 2,
        _note: null,
      });
    }

    if (rpc.error) throw rpc.error;

    toast("Next pay period created", "ok");

    const sel = document.getElementById("prPeriodSelect");
    const newest = await loadPeriodsIntoSelect(sel);

    if (rpc.data?.id) sel.value = rpc.data.id;
    else if (newest?.id) sel.value = newest.id;

    await refreshAll(sel.value);
  } catch (e) {
    showAdminError("Generate next pay period failed", safeErrMsg(e));
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
  "worker_type",
  "shift_count",
  "minutes_worked",
  "paid_break_minutes",
  "unpaid_break_minutes",
  "rounded_minutes",
  "hours_rounded",
  "regular_hours",
  "overtime_hours",
  "hourly_rate",
  "regular_pay",
  "overtime_pay",
  "gross_pay",
  "ytd_wages",
  "ss_employee",
  "medicare_employee_total",
  "fica_employee_total",
  "federal_income_tax",
  "state_income_tax",
  "local_income_tax",
  "employee_tax_total",
  "net_pay",
  "ss_employer",
  "medicare_employer",
  "futa_employer",
  "suta_state",
  "suta_employer",
  "employer_tax_total",
  "paid_amount",
  "due_amount",
];


    const rows = (lines || []).map((l) => {
      const name = l.employees?.display_name || l.display_name || "";
      const gross = Number(l.gross_pay || 0);
      const paid = Number(paidMap.get(l.employee_id) || 0);
      const taxes = taxFromLine(l);
      const due = Math.max(0, taxes.net - paid);
      const t = extractTotalsFromDetails(l);

const wt = (l.employees?.worker_type || l.worker_type || "").toLowerCase();
const fica = taxes.fica;

const cols = [
  l.employee_id,
  name,
  wt,
  Number(l.shift_count || 0),
  t.minutesWorked,
  t.paidBreak,
  t.unpaidBreak,
  t.roundedMin,
  t.hoursRounded.toFixed(2),
  (t.regularMin / 60).toFixed(2),
  (t.overtimeMin / 60).toFixed(2),
  Number(l.hourly_rate || 0).toFixed(2),
  Number(l.regular_pay || 0).toFixed(2),
  Number(l.overtime_pay || 0).toFixed(2),
  gross.toFixed(2),
  Number(fica.ytd || 0).toFixed(2),
  Number(fica.ss || 0).toFixed(2),
  Number(fica.med || 0).toFixed(2),
  Number(fica.fica || 0).toFixed(2),
  Number(taxes.federal || 0).toFixed(2),
  Number(taxes.state || 0).toFixed(2),
  Number(taxes.local || 0).toFixed(2),
  Number(taxes.employeeTax || 0).toFixed(2),
  Number(taxes.net || gross).toFixed(2),
  Number(taxes.ssEmployer || 0).toFixed(2),
  Number(taxes.medicareEmployer || 0).toFixed(2),
  Number(taxes.futa || 0).toFixed(2),
  taxes.sutaState || "",
  Number(taxes.suta || 0).toFixed(2),
  Number(taxes.employerTax || 0).toFixed(2),
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
      payrollReadiness = await loadPayrollReadiness(currentPeriod.id);
    } catch (e) {
      console.warn("Payroll readiness check failed:", safeErrMsg(e));
      payrollReadiness = null;
    }

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
    runsForPeriod = runs.data || [];
    currentRun =
      runsForPeriod.find((r) => r.status === "final") ||
      runsForPeriod.find((r) => r.status === "draft") ||
      runsForPeriod[0] ||
      null;

    if (!currentRun) {
      currentLines = [];
      currentPayments = [];
      renderPendingBanner();
      renderEmptyState([]);
      syncActionState();
      return;
    }

    currentLines = await loadLines(currentRun.id);
    currentPayments = await loadPayments(currentRun.id);

    // ✅ Auto-heal: if lines exist but net_pre_fed is missing, compute/persist FICA once and reload
try {
  const needsTax = (currentLines || []).some((l) => isEmployeeLine(l) && (l.net_pre_fed == null || l.net_pay == null));
  if (needsTax) {
    await sb().rpc("apply_fica_deductions_to_run", { _run_id: currentRun.id });
    currentLines = await loadLines(currentRun.id); // reload after persist
  }
} catch (e) {
  console.warn("Auto payroll tax heal failed:", safeErrMsg(e));
}


    if (!currentLines.length) renderEmptyState(currentPayments);
    else await renderLines(currentLines, currentPayments);
    renderPendingBanner();
    syncActionState();
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

// Pay period buttons (desktop + mobile sheet)
document.getElementById("prCreatePeriod")?.addEventListener("click", () => openPayPeriodSheet(null));
document.getElementById("prNextPeriod")?.addEventListener("click", () => createNextPayPeriod());

document.getElementById("prSheetCreatePeriod")?.addEventListener("click", () => {
  closeAllSheets();
  openPayPeriodSheet(null);
});

document.getElementById("prSheetNextPeriod")?.addEventListener("click", () => {
  closeAllSheets();
  createNextPayPeriod();
});

document.getElementById("prPeriodCreateConfirm")?.addEventListener("click", () => {
  createPayPeriodFromSheet();
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

      if (!Number.isFinite(amount) || amount <= 0) {
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
      const voidBtn = e.target.closest(".prVoidPaymentBtn");
      if (voidBtn) {
        const paymentId = voidBtn.dataset.payment;
        openVoidPaySheet(paymentId);
        return;
      }

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

    $("#prVoidPayConfirm")?.addEventListener("click", async () => {
      if (!voidPaymentId) return;
      const reason = String($("#prVoidPayReason")?.value || "").trim();
      try { await voidPayment(voidPaymentId, reason); } catch {}
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
