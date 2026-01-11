/* =========================================
   Worker Dashboard (v0)
   - Authenticated users only
   - Pull employee via employees.user_id = auth.uid()
   - Pull time_entries via time_entries.employee_id = employees.id
   - Pull time_breaks for those entries
   - Compute worked + break totals for:
       today / week (Sun-Sat) / month
   - Show status card + paid break cap + recent shifts
========================================= */

function $(id) { return document.getElementById(id); }

function waitForSupabaseReady() {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(window.supabase);
    document.addEventListener("supabase-ready", () => resolve(window.supabase), { once: true });
  });
}

/** ---------- Time helpers (local timezone, consistent with existing UI defaults) ---------- */
function startOfTodayLocal(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfWeekSunLocal(d = new Date()) {
  const x = new Date(d);
  const day = x.getDay(); // Sun=0
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
}

function startOfMonthLocal(d = new Date()) {
  const x = new Date(d);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function overlapMs(aStart, aEnd, bStart, bEnd) {
  const s = Math.max(aStart.getTime(), bStart.getTime());
  const e = Math.min(aEnd.getTime(), bEnd.getTime());
  return Math.max(0, e - s);
}

function fmtHM(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${h}h ${String(m).padStart(2, "0")}m`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
}

/** ---------- UI helpers ---------- */
function setSoftError(msg) {
  const el = $("soft-error");
  if (!el) return;
  if (!msg) {
    el.style.display = "none";
    el.textContent = "";
    return;
  }
  el.style.display = "block";
  el.textContent = msg;
}

function renderMetricGrid(containerId, cards) {
  const el = $(containerId);
  if (!el) return;

  el.innerHTML = cards.map(c => `
    <div class="metric-card">
      <div style="opacity:0.75; font-size:0.95rem;">${c.label}</div>
      <div style="margin-top:0.35rem; font-size:1.35rem; font-weight:700;">${c.value}</div>
    </div>
  `).join("");
}

function renderRecentShifts(entries, perEntryNetMs, perEntryBreakMs) {
  const container = $("recent-shifts-container");
  if (!container) return;

  if (!entries.length) {
    container.innerHTML = `
      <div class="table-wrapper">
        <table class="summary-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Clock In</th>
              <th>Clock Out</th>
              <th>Worked (Net)</th>
              <th>Break</th>
              <th>Flags</th>
            </tr>
          </thead>
          <tbody>
            <tr><td colspan="6" style="opacity:0.75;">No shifts yet.</td></tr>
          </tbody>
        </table>
      </div>
    `;
    return;
  }

  const rows = entries.map(e => {
    const net = fmtHM(perEntryNetMs[e.id] ?? 0);
    const brk = fmtHM(perEntryBreakMs[e.id] ?? 0);

    const outText = e.clock_out ? fmtTime(e.clock_out) : "In progress";
    const flags = [];

    if (e.geo_ok_in === false || e.geo_ok_out === false) {
      flags.push(`<span class="badge bad">Geo</span>`);
    }
    if (Array.isArray(e.schedule_codes) && e.schedule_codes.length > 0) {
      flags.push(`<span class="badge warn">Schedule</span>`);
    }

    return `
      <tr>
        <td>${fmtDate(e.clock_in)}</td>
        <td>${fmtTime(e.clock_in)}</td>
        <td>${outText}</td>
        <td>${net}</td>
        <td>${brk}</td>
        <td>${flags.join("") || "<span style='opacity:0.6;'>—</span>"}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <div class="table-wrapper">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Clock In</th>
            <th>Clock Out</th>
            <th>Worked (Net)</th>
            <th>Break</th>
            <th>Flags</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function setPill(id, text, tone) {
  const el = $(id);
  if (!el) return;
  el.textContent = text;
  el.classList.remove("good", "warn", "bad");
  if (tone) el.classList.add(tone);
}

/** ---------- Navigation ---------- */
function setupNavigation() {
  $("logout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await window.supabase.auth.signOut();
    window.location.href = "index.html";
  });

  $("logout-mobile")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await window.supabase.auth.signOut();
    window.location.href = "index.html";
  });

  $("menu-toggle")?.addEventListener("click", () => {
    $("mobile-menu")?.classList.toggle("show");
  });

  if (typeof lucide !== "undefined") {
    lucide.createIcons();
  }
}

/** ---------- Data loaders ---------- */
async function getSessionOrRedirect() {
  const { data: { session }, error } = await window.supabase.auth.getSession();
  if (error) console.error("❌ Session error:", error);

  if (!session) {
    window.location.href = "index.html";
    return null;
  }
  return session;
}

async function loadEmployeeByUserId(userId) {
  const { data, error } = await window.supabase
    .from("employees")
    .select("id, display_name, role, active")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function fetchBreakCapMinutes() {
  try {
    const { data, error } = await window.supabase.rpc("org_paid_break_minutes_per_day");
    if (!error && typeof data === "number") return data;
  } catch {}
  return 30; // safe default
}

async function loadEntriesSince(employeeId, earliestIso) {
  const { data, error } = await window.supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, geo_ok_in, geo_ok_out, schedule_codes, store_id")
    .eq("employee_id", employeeId)
    .gte("clock_in", earliestIso)
    .order("clock_in", { ascending: false })
    .limit(500);

  if (error) throw error;
  return data || [];
}

async function loadBreaksForEntryIds(entryIds) {
  if (!entryIds.length) return [];
  const { data, error } = await window.supabase
    .from("time_breaks")
    .select("id, time_entry_id, started_at, ended_at")
    .in("time_entry_id", entryIds)
    .order("started_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

/** ---------- Core computation ---------- */
function computeTotals(entries, breaks) {
  const now = new Date();
  const wToday = startOfTodayLocal(now);
  const wWeek = startOfWeekSunLocal(now);
  const wMonth = startOfMonthLocal(now);

  const windows = {
    today: { start: wToday, end: now },
    week:  { start: wWeek,  end: now },
    month: { start: wMonth, end: now },
  };

  const breaksByEntry = {};
  for (const b of breaks) {
    const id = b.time_entry_id;
    if (!breaksByEntry[id]) breaksByEntry[id] = [];
    breaksByEntry[id].push(b);
  }

  const totals = {
    worked: { today: 0, week: 0, month: 0 },
    break:  { today: 0, week: 0, month: 0 },
  };

  const perEntryBreakMs = {};
  const perEntryNetMs = {};

  for (const e of entries) {
    const s = new Date(e.clock_in);
    const eEnd = e.clock_out ? new Date(e.clock_out) : now;

    // total break for entire shift (used for recent list)
    let shiftBreakTotal = 0;

    const blist = breaksByEntry[e.id] || [];
    for (const b of blist) {
      const bs = new Date(b.started_at);
      const be = b.ended_at ? new Date(b.ended_at) : now;
      shiftBreakTotal += overlapMs(bs, be, s, eEnd);
    }

    perEntryBreakMs[e.id] = shiftBreakTotal;
    perEntryNetMs[e.id] = Math.max(0, (eEnd - s) - shiftBreakTotal);

    // windowed totals
    for (const key of ["today", "week", "month"]) {
      const w = windows[key];
      const gross = overlapMs(s, eEnd, w.start, w.end);

      let bms = 0;
      for (const b of blist) {
        const bs = new Date(b.started_at);
        const be = b.ended_at ? new Date(b.ended_at) : now;
        bms += overlapMs(bs, be, w.start, w.end);
      }

      totals.break[key] += bms;
      totals.worked[key] += Math.max(0, gross - bms);
    }
  }

  // Find current open shift and open break (for status card)
  const openShift = entries.find(x => !x.clock_out) || null;

  let openBreak = null;
  if (openShift) {
    const blist = breaksByEntry[openShift.id] || [];
    openBreak = blist.find(b => !b.ended_at) || null;
  }

  return { totals, perEntryBreakMs, perEntryNetMs, openShift, openBreak };
}

function updateStatusCard({
  employeeName,
  role,
  openShift,
  openBreak,
  breakCapMin,
  totalsBreakTodayMs,
  shiftSoFarMs,
  breakSoFarMs
}) {
  $("status-now").textContent = new Date().toLocaleString();

  const greeting = $("worker-greeting");
  if (greeting) {
    const who = employeeName ? employeeName : "Employee";
    const roleTag = role ? ` (${role})` : "";
    greeting.innerHTML = `<strong>Welcome, ${who}${roleTag}</strong>`;
  }

  // Shift pill
  if (openShift) {
    setPill("pill-shift", "Shift: Clocked in", "good");
  } else {
    setPill("pill-shift", "Shift: Clocked out", "warn");
  }

  // Break pill
  if (openBreak) {
    setPill("pill-break", "Break: On break", "warn");
  } else {
    setPill("pill-break", "Break: Not on break", "good");
  }

  // So-far values
  $("shift-sofar").textContent = openShift ? fmtHM(shiftSoFarMs) : "—";
  $("break-sofar").textContent = openBreak ? fmtHM(breakSoFarMs) : "—";

  // Break cap
  const usedMin = Math.floor(totalsBreakTodayMs / 60000);
  const remainingMin = Math.max(0, Math.floor((breakCapMin || 30) - usedMin));

  $("break-cap-today").textContent = `${breakCapMin || 30}m`;
  $("break-remaining-today").textContent = `${remainingMin}m`;

  const note = $("status-note");
  if (note) {
    note.textContent = "Tip: Worked hours are net (breaks removed). Check your full timesheet for details.";
  }
}

/** ---------- Live timers ---------- */
function computeLiveSoFar(openShift, openBreak, perEntryBreakMs) {
  const now = new Date();

  if (!openShift) {
    return { shiftSoFarMs: 0, breakSoFarMs: 0 };
  }

  const shiftStart = new Date(openShift.clock_in);
  const shiftEndNow = now;

  // total break within open shift so far (includes open break)
  const shiftBreakSoFar = perEntryBreakMs[openShift.id] ?? 0;

  // If open break exists, perEntryBreakMs already includes it via computeTotals(now),
  // but as time advances we need to add extra delta since last compute.
  // We'll handle this by re-evaluating open break delta here if needed.
  let openBreakExtra = 0;
  if (openBreak) {
    const bs = new Date(openBreak.started_at);
    openBreakExtra = Math.max(0, now - bs); // full open break duration right now
    // But perEntryBreakMs might already include it; live calc should be:
    // shiftBreakSoFar computed at last refresh could be stale.
    // We will ignore perEntryBreakMs for open breaks and recompute:
    // (closed breaks sum) + open break duration.
    // To keep it simple, computeTotals is re-run occasionally; the live tick handles so-far directly:
  }

  // We’ll compute breakSoFarMs from open break only (status wants “break so far” for the active break).
  const breakSoFarMs = openBreak ? openBreakExtra : 0;

  // Shift so far should be net:
  // (now - shiftStart) - (total breaks within shift so far)
  // We can’t perfectly know closed-break sum from here alone, so we’ll do a small compromise:
  // shiftSoFarMs = (now - shiftStart) - (shiftBreakSoFar updated by periodic refresh)
  const shiftSoFarMs = Math.max(0, (shiftEndNow - shiftStart) - shiftBreakSoFar);

  return { shiftSoFarMs, breakSoFarMs };
}

/** ---------- Main ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseReady();
  setupNavigation();

  const session = await getSessionOrRedirect();
  if (!session) return;

  try {
    const userId = session.user.id;

    const employee = await loadEmployeeByUserId(userId);
    if (!employee) {
      window.location.href = "index.html";
      return;
    }

    if (employee.active === false) {
      window.location.href = "index.html";
      return;
    }

    // Pull time entries from (start of month - 2 days) to capture boundary overlaps
    const now = new Date();
    const earliest = startOfMonthLocal(now);
    earliest.setDate(earliest.getDate() - 2);
    const entries = await loadEntriesSince(employee.id, earliest.toISOString());

    const entryIds = entries.map(e => e.id);
    const breaks = await loadBreaksForEntryIds(entryIds);

    const breakCapMin = await fetchBreakCapMinutes();

    // Compute totals + status
    let computed = computeTotals(entries, breaks);

    // Metrics
    renderMetricGrid("worked-metrics", [
      { label: "Worked today", value: fmtHM(computed.totals.worked.today) },
      { label: "Worked this week (Sun–Sat)", value: fmtHM(computed.totals.worked.week) },
      { label: "Worked this month", value: fmtHM(computed.totals.worked.month) },
    ]);

    renderMetricGrid("break-metrics", [
      { label: "Break today", value: fmtHM(computed.totals.break.today) },
      { label: "Break this week (Sun–Sat)", value: fmtHM(computed.totals.break.week) },
      { label: "Break this month", value: fmtHM(computed.totals.break.month) },
    ]);

    // Recent shifts (last 10)
    renderRecentShifts(
      entries.slice(0, 10),
      computed.perEntryNetMs,
      computed.perEntryBreakMs
    );

    // Status card initial
    const live0 = computeLiveSoFar(computed.openShift, computed.openBreak, computed.perEntryBreakMs);
    updateStatusCard({
      employeeName: employee.display_name,
      role: employee.role,
      openShift: computed.openShift,
      openBreak: computed.openBreak,
      breakCapMin,
      totalsBreakTodayMs: computed.totals.break.today,
      shiftSoFarMs: live0.shiftSoFarMs,
      breakSoFarMs: live0.breakSoFarMs
    });

    // Live ticking for the “now” and so-far fields
    // (We also do a periodic refresh to keep break sums accurate.)
    let tickTimer = null;
    let refreshTimer = null;

    tickTimer = setInterval(() => {
      const live = computeLiveSoFar(computed.openShift, computed.openBreak, computed.perEntryBreakMs);
      updateStatusCard({
        employeeName: employee.display_name,
        role: employee.role,
        openShift: computed.openShift,
        openBreak: computed.openBreak,
        breakCapMin,
        totalsBreakTodayMs: computed.totals.break.today,
        shiftSoFarMs: live.shiftSoFarMs,
        breakSoFarMs: live.breakSoFarMs
      });
    }, 1000);

    // Refresh totals every 30s to ensure open-break math stays correct and tables stay fresh
    refreshTimer = setInterval(async () => {
      try {
        const freshEntries = await loadEntriesSince(employee.id, earliest.toISOString());
        const freshIds = freshEntries.map(e => e.id);
        const freshBreaks = await loadBreaksForEntryIds(freshIds);

        computed = computeTotals(freshEntries, freshBreaks);

        renderMetricGrid("worked-metrics", [
          { label: "Worked today", value: fmtHM(computed.totals.worked.today) },
          { label: "Worked this week (Sun–Sat)", value: fmtHM(computed.totals.worked.week) },
          { label: "Worked this month", value: fmtHM(computed.totals.worked.month) },
        ]);

        renderMetricGrid("break-metrics", [
          { label: "Break today", value: fmtHM(computed.totals.break.today) },
          { label: "Break this week (Sun–Sat)", value: fmtHM(computed.totals.break.week) },
          { label: "Break this month", value: fmtHM(computed.totals.break.month) },
        ]);

        renderRecentShifts(
          freshEntries.slice(0, 10),
          computed.perEntryNetMs,
          computed.perEntryBreakMs
        );

        setSoftError(null);
      } catch (e) {
        console.warn("⚠️ Worker dashboard refresh failed:", e);
      }
    }, 30000);

    // Cleanup if needed
    window.addEventListener("beforeunload", () => {
      if (tickTimer) clearInterval(tickTimer);
      if (refreshTimer) clearInterval(refreshTimer);
    });

  } catch (err) {
    console.error("❌ Worker dashboard failed:", err);
    setSoftError("Could not load your work summary. If this keeps happening, contact an admin.");
  }
});
