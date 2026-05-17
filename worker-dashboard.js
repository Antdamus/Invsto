/* =========================================
   Worker Dashboard (v1)
   - Real-time Today/Week (current period)
   - Selectable Month for Month totals + Recent Shifts
   - Efficient: fetch only the month you need + cache previous months
========================================= */

function $(id) { return document.getElementById(id); }

function waitForSupabaseReady() {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(window.supabase);
    document.addEventListener("supabase-ready", () => resolve(window.supabase), { once: true });
  });
}

/* ---------- Phase 4: Store lookup (name + directions) ---------- */
let activeStores = [];
let storeById = new Map();

function directionsUrlForStore(store) {
  if (!store || store.lat == null || store.lng == null) return null;
  const lat = encodeURIComponent(String(store.lat));
  const lng = encodeURIComponent(String(store.lng));
  return `https://www.google.com/maps/dir/?api=1&destination=${lat}%2C${lng}`;
}

async function fetchActiveStores() {
  const { data, error } = await window.supabase
    .from("store_locations")
    .select("id, name, lat, lng, radius_m, paid_break_cap_min, active")
    .eq("active", true)
    .order("created_at", { ascending: true });
  if (error) throw error;
  activeStores = Array.isArray(data) ? data : [];
  storeById = new Map(activeStores.map(s => [s.id, s]));
}

/** ---------- Time helpers (local timezone, consistent with existing UI defaults) ---------- */
function startOfTodayLocal(d = new Date()) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

async function markAcceptedIfNeeded(supabase) {
  try {
    const { data: { user }, error } = await supabase.auth.getUser();
    if (error) throw error;
    if (!user) return;

    // This RPC sets employees.accepted_at = now() if null for auth.uid()
    await supabase.rpc("mark_invite_accepted");
  } catch (e) {
    console.warn("mark_invite_accepted failed (worker dashboard):", e);
  }
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

function nextMonthStartLocal(monthStart) {
  const x = new Date(monthStart);
  x.setMonth(x.getMonth() + 1);
  x.setDate(1);
  x.setHours(0, 0, 0, 0);
  return x;
}

function monthKey(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

function monthLabel(d) {
  return d.toLocaleDateString([], { month: "long", year: "numeric" });
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

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sameLocalDay(a, b = new Date()) {
  if (!a) return false;
  const date = new Date(a);
  if (Number.isNaN(date.getTime())) return false;
  return date.getFullYear() === b.getFullYear()
    && date.getMonth() === b.getMonth()
    && date.getDate() === b.getDate();
}

function getOrderFromLine(line) {
  const order = line?.ebay_orders || line?.order || {};
  return Array.isArray(order) ? order[0] || {} : order;
}

function getRemainingLineQuantity(line) {
  return Math.max(0, Number(line?.quantity || 0) - Number(line?.fulfilled_quantity || 0));
}

function getUrgentOrderState(shipByDate) {
  if (!shipByDate) return { label: "No ship date", className: "is-normal", rank: 4, dueDate: null };

  const now = new Date();
  const dueDate = new Date(shipByDate);
  if (Number.isNaN(dueDate.getTime())) return { label: "No ship date", className: "is-normal", rank: 4, dueDate: null };

  const msUntilDue = dueDate.getTime() - now.getTime();
  if (msUntilDue < 0) return { label: "Overdue", className: "is-overdue", rank: 0, dueDate };
  if (sameLocalDay(dueDate, now)) return { label: "Due today", className: "is-today", rank: 1, dueDate };
  if (msUntilDue <= 48 * 60 * 60 * 1000) return { label: "Due soon", className: "is-soon", rank: 2, dueDate };
  return { label: "Upcoming", className: "is-normal", rank: 3, dueDate };
}

function formatShipBy(value) {
  if (!value) return "No ship date";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "No ship date";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function groupUrgentOrderLines(lines) {
  const groups = new Map();
  (lines || []).forEach((line) => {
    const order = getOrderFromLine(line);
    const key = order.id || order.order_number || line.order_id || line.id;
    if (!groups.has(key)) {
      groups.set(key, {
        buyer: order.buyer_username || "No buyer username",
        orderNumber: order.order_number || "eBay order",
        shipByDate: order.ship_by_date || null,
        pendingLines: 0,
        remainingQty: 0,
        titles: [],
      });
    }

    const group = groups.get(key);
    const remaining = getRemainingLineQuantity(line);
    if (remaining <= 0) return;
    group.pendingLines += 1;
    group.remainingQty += remaining;
    if (line.item_title) group.titles.push(line.item_title);
  });

  return [...groups.values()]
    .filter((group) => group.pendingLines > 0)
    .map((group) => ({ ...group, urgency: getUrgentOrderState(group.shipByDate) }))
    .sort((a, b) => {
      if (a.urgency.rank !== b.urgency.rank) return a.urgency.rank - b.urgency.rank;
      const aTime = a.urgency.dueDate?.getTime?.() ?? Number.MAX_SAFE_INTEGER;
      const bTime = b.urgency.dueDate?.getTime?.() ?? Number.MAX_SAFE_INTEGER;
      return aTime - bTime;
    });
}

async function loadWorkerUrgentOrders() {
  const container = $("worker-urgent-orders-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading urgent orders...</div>`;

  const { data, error } = await window.supabase
    .from("ebay_order_lines")
    .select(`
      id,
      order_id,
      item_title,
      quantity,
      fulfilled_quantity,
      line_status,
      ebay_orders!inner(
        id,
        order_number,
        buyer_username,
        ship_by_date,
        status
      )
    `)
    .in("line_status", ["pending", "partially_fulfilled"])
    .limit(300);

  if (error) {
    console.error("Failed to load urgent eBay orders:", error);
    container.innerHTML = `<div class="urgent-orders-empty">Could not load urgent eBay orders.</div>`;
    return;
  }

  const groups = groupUrgentOrderLines(data || []);
  const urgentGroups = groups.filter((group) => group.urgency.rank <= 2).slice(0, 6);

  if (!urgentGroups.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No orders are overdue or due in the next 48 hours.</div>`;
    return;
  }

  container.innerHTML = urgentGroups.map((group) => {
    const titlePreview = group.titles.slice(0, 2).join(" / ") || "Pending item";
    const extra = group.titles.length > 2 ? ` +${group.titles.length - 2} more` : "";
    return `
      <a class="urgent-order-card ${group.urgency.className}" href="pending-orders.html">
        <div class="urgent-order-top">
          <div>
            <strong>${escapeHtml(group.buyer)}</strong>
            <span>${escapeHtml(group.orderNumber)}</span>
          </div>
          <span class="urgent-order-badge">${escapeHtml(group.urgency.label)}</span>
        </div>
        <small>${escapeHtml(titlePreview)}${escapeHtml(extra)}</small>
        <div class="urgent-order-meta">
          <span>Ship by <b>${escapeHtml(formatShipBy(group.shipByDate))}</b></span>
          <span><b>${group.pendingLines}</b> line(s) / <b>${group.remainingQty}</b> unit(s)</span>
        </div>
      </a>
    `;
  }).join("");
}

async function loadWorkerStoreTransferAlerts() {
  const container = $("worker-store-transfer-alerts-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading store transfers...</div>`;

  const { data: sessionData } = await window.supabase.auth.getSession();
  const userId = sessionData?.session?.user?.id;
  if (!userId) return;

  const { data, error } = await window.supabase
    .from("store_transfers")
    .select("id, transfer_number, source_store_id, destination_store_id, status, sender_email, created_at")
    .eq("receiver_user_id", userId)
    .in("status", ["pending_receipt", "partially_received", "exception"])
    .order("created_at", { ascending: true })
    .limit(6);

  if (error) {
    container.innerHTML = `<div class="urgent-orders-empty">Could not load store transfers.</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No store transfers are currently assigned to you.</div>`;
    return;
  }

  const storeIds = [...new Set(data.flatMap((row) => [row.source_store_id, row.destination_store_id]).filter(Boolean))];
  const { data: stores } = await window.supabase
    .from("store_locations")
    .select("id, name")
    .in("id", storeIds);
  const storeMap = Object.fromEntries((stores || []).map((store) => [store.id, store.name]));

  container.innerHTML = data.map((transfer) => `
    <a class="urgent-order-card ${transfer.status === "exception" ? "is-overdue" : "is-soon"}" href="store-transfers.html">
      <div class="urgent-order-top">
        <strong>${escapeHtml(transfer.transfer_number || "Store transfer")}</strong>
        <span class="urgent-order-badge">${escapeHtml(transfer.status.replace(/_/g, " "))}</span>
      </div>
      <div class="urgent-order-meta">
        <span>${escapeHtml(storeMap[transfer.source_store_id] || "Source")} to ${escapeHtml(storeMap[transfer.destination_store_id] || "Destination")}</span>
        <span>Sender: ${escapeHtml(transfer.sender_email || "-")}</span>
        <span>Created ${escapeHtml(fmtDate(transfer.created_at))}</span>
      </div>
    </a>
  `).join("");
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

function chunk(arr, size = 100) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

const ANOMALY_LABEL = {
  UNSCHEDULED_DAY: "Unscheduled",
  EARLY_CLOCK_IN: "Early In",
  LATE_CLOCK_IN: "Late In",
  EARLY_CLOCK_OUT: "Early Out",
  LATE_CLOCK_OUT: "Late Out",
};

function anomalyTone(code) {
  // “bad” for tardy/early-out style problems, “warn” for unscheduled/other
  if (code === "LATE_CLOCK_IN" || code === "EARLY_CLOCK_OUT") return "bad";
  if (code === "EARLY_CLOCK_IN" || code === "LATE_CLOCK_OUT") return "warn";
  if (code === "UNSCHEDULED_DAY") return "warn";
  return "warn";
}

function renderAnomalyBadges(anomalies) {
  if (!Array.isArray(anomalies) || anomalies.length === 0) return "";
  return anomalies.map(code => {
    const label = ANOMALY_LABEL[code] || code;
    const tone = anomalyTone(code);
    return `<span class="badge ${tone}" title="${code}">${label}</span>`;
  }).join("");
}


function renderRecentShifts(entries, perEntryNetMs, perEntryBreakMs, anomalyMap = {}) {
  const container = $("recent-shifts-container");
  if (!container) return;

  const isMobile = window.matchMedia && window.matchMedia("(max-width: 768px)").matches;

  // Empty state
  if (!Array.isArray(entries) || entries.length === 0) {
    container.innerHTML = isMobile
      ? `<div class="shift-empty">No shifts in this month.</div>`
      : `
        <div class="table-wrapper">
          <table class="summary-table">
            <thead>
              <tr>
                <th>Date</th><th>Store</th><th>Clock In</th><th>Clock Out</th>
                <th>Worked (Net)</th><th>Break</th><th>Flags</th>
              </tr>
            </thead>
            <tbody>
              <tr><td colspan="7" style="opacity:0.75;">No shifts in this month.</td></tr>
            </tbody>
          </table>
        </div>
      `;
    return;
  }

  // ---------- MOBILE: render as cards ----------
  if (isMobile) {
    const cards = entries.map(e => {
      const a = anomalyMap?.[e.id] || { anomalies: [], has_anomaly: false };
      const anomalies = Array.isArray(a.anomalies) ? a.anomalies : [];

      const net = fmtHM(perEntryNetMs?.[e.id] ?? 0);
      const brk = fmtHM(perEntryBreakMs?.[e.id] ?? 0);

      const store = e.store_id ? storeById.get(e.store_id) : null;
      const storeName = store?.name ? String(store.name) : "—";
      const dirUrl = directionsUrlForStore(store);
      const storeHtml = dirUrl
        ? `<span class="shift-store">${storeName} · <a href="${dirUrl}" target="_blank" rel="noopener">Directions</a></span>`
        : `<span class="shift-store">${storeName}</span>`;

      const outText = e.clock_out ? fmtTime(e.clock_out) : "In progress";

      const flagsHtml = [];

      // anomalies
      if (anomalies.length) flagsHtml.push(renderAnomalyBadges(anomalies));

      // geo flags
      if (e.geo_ok_in === false || e.geo_ok_out === false) {
        flagsHtml.push(`<span class="badge bad" title="Geofence issue">Geo</span>`);
      }

      // schedule flags
      if (Array.isArray(e.schedule_codes) && e.schedule_codes.length > 0) {
        flagsHtml.push(`<span class="badge warn" title="${e.schedule_codes.join(", ")}">Schedule</span>`);
      }

      const flags = flagsHtml.length ? flagsHtml.join(" ") : `<span style="opacity:0.6;">—</span>`;

      return `
        <div class="shift-card">
          <div class="shift-card-top">
            <div class="shift-date">${fmtDate(e.clock_in)}</div>
            ${storeHtml}
          </div>

          <div class="shift-grid">
            <div>
              <div class="shift-k">Clock In</div>
              <div class="shift-v">${fmtTime(e.clock_in)}</div>
            </div>
            <div>
              <div class="shift-k">Clock Out</div>
              <div class="shift-v">${outText}</div>
            </div>

            <div>
              <div class="shift-k">Worked (Net)</div>
              <div class="shift-v">${net}</div>
            </div>
            <div>
              <div class="shift-k">Break</div>
              <div class="shift-v">${brk}</div>
            </div>
          </div>

          <div class="shift-flags">${flags}</div>
        </div>
      `;
    }).join("");

    container.innerHTML = `<div class="shift-cards">${cards}</div>`;
    return;
  }

  // ---------- DESKTOP: render as table ----------
  const rows = entries.map(e => {
    const a = anomalyMap?.[e.id] || { anomalies: [], has_anomaly: false };
    const anomalies = Array.isArray(a.anomalies) ? a.anomalies : [];

    const net = fmtHM(perEntryNetMs?.[e.id] ?? 0);
    const brk = fmtHM(perEntryBreakMs?.[e.id] ?? 0);

    const store = e.store_id ? storeById.get(e.store_id) : null;
    const storeName = store?.name ? String(store.name) : "—";
    const dirUrl = directionsUrlForStore(store);
    const storeCell = dirUrl
      ? `${storeName} <a href="${dirUrl}" target="_blank" rel="noopener" style="margin-left:6px; opacity:0.85;">Directions</a>`
      : storeName;

    const outText = e.clock_out ? fmtTime(e.clock_out) : "In progress";

    const flagsHtml = [];
    if (anomalies.length) flagsHtml.push(renderAnomalyBadges(anomalies));
    if (e.geo_ok_in === false || e.geo_ok_out === false) flagsHtml.push(`<span class="badge bad" title="Geofence issue">Geo</span>`);
    if (Array.isArray(e.schedule_codes) && e.schedule_codes.length > 0) flagsHtml.push(`<span class="badge warn" title="${e.schedule_codes.join(", ")}">Schedule</span>`);

    const flagsCell = flagsHtml.length ? flagsHtml.join(" ") : `<span style="opacity:0.6;">—</span>`;

    return `
      <tr>
        <td>${fmtDate(e.clock_in)}</td>
        <td>${storeCell}</td>
        <td>${fmtTime(e.clock_in)}</td>
        <td>${outText}</td>
        <td>${net}</td>
        <td>${brk}</td>
        <td>${flagsCell}</td>
      </tr>
    `;
  }).join("");

  container.innerHTML = `
    <div class="table-wrapper">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Date</th><th>Store</th><th>Clock In</th><th>Clock Out</th>
            <th>Worked (Net)</th><th>Break</th><th>Flags</th>
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
    .select("id, display_name, role, active, created_at, worker_type, agreement_version_required")
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
  return 30;
}

async function loadEntriesOverlapping(employeeId, windowStartIso, windowEndIso) {
  // Include shifts that overlap window:
  // clock_in < windowEnd AND (clock_out IS NULL OR clock_out >= windowStart)
  const { data, error } = await window.supabase
    .from("time_entries")
    .select("id, clock_in, clock_out, geo_ok_in, geo_ok_out, schedule_codes, store_id")
    .eq("employee_id", employeeId)
    .lt("clock_in", windowEndIso)
    .or(`clock_out.is.null,clock_out.gte.${windowStartIso}`)
    .order("clock_in", { ascending: false })
    .limit(800);

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

async function loadAnomaliesForEntryIds(entryIds) {
  // Returns: { [time_entry_id]: { anomalies: string[], has_anomaly: boolean } }
  const out = {};
  const ids = (entryIds || []).filter(Boolean);
  if (!ids.length) return out;

  for (const batch of chunk(ids, 75)) {
    const { data, error } = await window.supabase
      .from("v_shift_anomalies")
      .select("time_entry_id, anomalies, has_anomaly")
      .in("time_entry_id", batch);

    if (error) {
      console.warn("loadAnomaliesForEntryIds failed:", error);
      continue; // fail open
    }

    (data || []).forEach(row => {
      out[row.time_entry_id] = {
        anomalies: Array.isArray(row.anomalies) ? row.anomalies : [],
        has_anomaly: !!row.has_anomaly
      };
    });
  }

  return out;
}


/** ---------- Computation ---------- */
function computePerEntryMaps(entries, breaks, now = new Date()) {
  const breaksByEntry = {};
  for (const b of breaks) {
    const id = b.time_entry_id;
    if (!breaksByEntry[id]) breaksByEntry[id] = [];
    breaksByEntry[id].push(b);
  }

  const perEntryBreakMs = {};
  const perEntryNetMs = {};

  for (const e of entries) {
    const s = new Date(e.clock_in);
    const eEnd = e.clock_out ? new Date(e.clock_out) : now;

    let shiftBreakTotal = 0;
    const blist = breaksByEntry[e.id] || [];
    for (const b of blist) {
      const bs = new Date(b.started_at);
      const be = b.ended_at ? new Date(b.ended_at) : now;
      shiftBreakTotal += overlapMs(bs, be, s, eEnd);
    }

    perEntryBreakMs[e.id] = shiftBreakTotal;
    perEntryNetMs[e.id] = Math.max(0, (eEnd - s) - shiftBreakTotal);
  }

  return { breaksByEntry, perEntryBreakMs, perEntryNetMs };
}

function computeWindowTotals(entries, breaksByEntry, windowStart, windowEnd, now = new Date()) {
  let worked = 0;
  let brk = 0;

  for (const e of entries) {
    const s = new Date(e.clock_in);
    const eEnd = e.clock_out ? new Date(e.clock_out) : now;

    const gross = overlapMs(s, eEnd, windowStart, windowEnd);

    let bms = 0;
    const blist = breaksByEntry[e.id] || [];
    for (const b of blist) {
      const bs = new Date(b.started_at);
      const be = b.ended_at ? new Date(b.ended_at) : now;
      bms += overlapMs(bs, be, windowStart, windowEnd);
    }

    brk += bms;
    worked += Math.max(0, gross - bms);
  }

  return { workedMs: worked, breakMs: brk };
}

function findOpenShiftAndBreak(entries, breaksByEntry) {
  const openShift = entries.find(x => !x.clock_out) || null;

  let openBreak = null;
  let openShiftClosedBreakMs = 0;

  if (openShift) {
    const blist = breaksByEntry[openShift.id] || [];
    openBreak = blist.find(b => !b.ended_at) || null;

    // Closed break sum (exclude the open break for accurate live tick)
    for (const b of blist) {
      if (!b.ended_at) continue;
      openShiftClosedBreakMs += Math.max(0, new Date(b.ended_at) - new Date(b.started_at));
    }
  }

  return { openShift, openBreak, openShiftClosedBreakMs };
}

/** ---------- Month Picker ---------- */
function buildMonthOptions(employeeCreatedAtIso) {
  const start = startOfMonthLocal(new Date(employeeCreatedAtIso));
  const now = new Date();
  const end = startOfMonthLocal(now);

  const months = [];
  let cursor = new Date(start);

  while (cursor <= end) {
    months.push(new Date(cursor));
    cursor = nextMonthStartLocal(cursor);
  }
  return months;
}

function renderMonthPicker(months, selectedStart) {
  const select = $("month-select");
  if (!select) return;

  const selKey = monthKey(selectedStart);

  select.innerHTML = months.map(m => {
    const key = monthKey(m);
    const label = monthLabel(m);
    const selected = (key === selKey) ? "selected" : "";
    return `<option value="${key}" ${selected}>${label}</option>`;
  }).join("");

  $("month-label").textContent = monthLabel(selectedStart);

  // Disable next if selected is current month
  const curKey = monthKey(startOfMonthLocal(new Date()));
  $("month-next").disabled = (selKey === curKey);
}

/** ---------- Status card ---------- */
function updateStatusCard({
  employeeName,
  role,
  openShift,
  openBreak,
  openShiftClosedBreakMs,
  breakCapMin,
  closedBreakTodayMs,
  todayStart
}) {
  const now = new Date();
  $("status-now").textContent = now.toLocaleString();

  const greeting = $("worker-greeting");
  if (greeting) {
    const who = employeeName ? employeeName : "Employee";
    const roleTag = role ? ` (${role})` : "";
    greeting.innerHTML = `<strong>Welcome, ${who}${roleTag}</strong>`;
  }

  // Shift pill
  if (openShift) setPill("pill-shift", "Shift: Clocked in", "good");
  else setPill("pill-shift", "Shift: Clocked out", "warn");

  // Break pill
  if (openBreak) setPill("pill-break", "Break: On break", "warn");
  else setPill("pill-break", "Break: Not on break", "good");

  // Live so-far math
  let shiftSoFarMs = 0;
  let breakSoFarMs = 0;
  let breakTodayMs = closedBreakTodayMs;

  if (openShift) {
    const shiftStart = new Date(openShift.clock_in);

    const openBreakMs = openBreak ? Math.max(0, now - new Date(openBreak.started_at)) : 0;
    const shiftBreakSoFar = openShiftClosedBreakMs + openBreakMs;

    shiftSoFarMs = Math.max(0, (now - shiftStart) - shiftBreakSoFar);
    breakSoFarMs = openBreak ? openBreakMs : 0;

    // If open break overlaps today window, add it to today's break used
    if (openBreak) {
      const bs = new Date(openBreak.started_at);
      const be = now;
      breakTodayMs += overlapMs(bs, be, todayStart, now);
    }
  }

  $("shift-sofar").textContent = openShift ? fmtHM(shiftSoFarMs) : "—";
  $("break-sofar").textContent = openBreak ? fmtHM(breakSoFarMs) : "—";

  const usedMin = Math.floor(breakTodayMs / 60000);
  const shiftStore = openShift?.store_id ? storeById.get(openShift.store_id) : null;
  const cap = (shiftStore?.paid_break_cap_min ?? breakCapMin ?? 30);
  const remainingMin = Math.max(0, cap - usedMin);

  $("break-cap-today").textContent = `${cap}m`;
  $("break-remaining-today").textContent = `${remainingMin}m`;

  const note = $("status-note");
  if (note) {
    const storeName = shiftStore?.name ? String(shiftStore.name) : null;
    const dirUrl = directionsUrlForStore(shiftStore);

    const storeHtml = storeName
      ? `Current store: <strong>${storeName}</strong>${dirUrl ? ` · <a href="${dirUrl}" target="_blank" rel="noopener">Directions</a>` : ""}<br>`
      : "";

    note.innerHTML = `${storeHtml}Tip: Worked hours are net (breaks removed). Use the month selector to review history.`;
  }
}

async function enforceContractorAgreementGate(supabase) {
  // Ask the server (Edge Function) what the truth is
  const { data, error } = await supabase.functions.invoke("contractor-agreement", {
    body: { action: "status" },
  });

  // Fail-closed: if we can't confirm, block contractors by sending them to agreement flow
  if (error || !data) {
    const next = encodeURIComponent("worker-dashboard.html");
    window.location.href = `set-password.html?mode=agreement&next=${next}`;
    return;
  }

  // If not a contractor (required:false) -> allow
  if (!data.required) return;

  // Contractor but not accepted -> block
  if (!data.accepted) {
    const next = encodeURIComponent("worker-dashboard.html");
    window.location.href = `set-password.html?mode=agreement&next=${next}`;
  }
}

/** ---------- Main ---------- */
document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseReady();
  setupNavigation();

  const session = await getSessionOrRedirect();
  if (!session) return;

  // ✅ mark this user as "accepted" the first time they successfully reach the dashboard
  await markAcceptedIfNeeded(window.supabase);

  const state = {
    employee: null,
    breakCapMin: 30,
    months: [],
    selectedMonthStart: startOfMonthLocal(new Date()),
    monthCache: new Map(), // key -> { entries, breaks, breaksByEntry, perEntryBreakMs, perEntryNetMs, totals }
    currentCache: null,    // { entries, breaks, breaksByEntry, todayTotals, weekTotals, openShift..., closedBreakTodayMs }
    timers: { tick: null, refresh: null }
  };

  try {
    // 1) Employee
    const userId = session.user.id;
    const employee = await loadEmployeeByUserId(userId);

    if (!employee || employee.active === false) {
      window.location.href = "index.html";
      return;
    }

    state.employee = employee;
    await enforceContractorAgreementGate(window.supabase);
    await loadWorkerUrgentOrders();
    await loadWorkerStoreTransferAlerts();

    // 2) Break cap
    state.breakCapMin = await fetchBreakCapMinutes();

    // Phase 4: store lookup for labels + per-store break cap/directions
    await fetchActiveStores();

    // 3) Month options from employee.created_at -> current month
    state.months = buildMonthOptions(employee.created_at);
    state.selectedMonthStart = startOfMonthLocal(new Date()); // default current month
    renderMonthPicker(state.months, state.selectedMonthStart);

    // 4) Hook month controls
    $("month-prev")?.addEventListener("click", async () => {
      const prev = new Date(state.selectedMonthStart);
      prev.setMonth(prev.getMonth() - 1);
      prev.setDate(1);
      prev.setHours(0,0,0,0);

      // Don't go earlier than first month
      if (prev < state.months[0]) return;

      state.selectedMonthStart = prev;
      await refreshMonthView(state);
    });

    $("month-next")?.addEventListener("click", async () => {
      const next = new Date(state.selectedMonthStart);
      next.setMonth(next.getMonth() + 1);
      next.setDate(1);
      next.setHours(0,0,0,0);

      const cur = startOfMonthLocal(new Date());
      if (next > cur) return;

      state.selectedMonthStart = next;
      await refreshMonthView(state);
    });

    $("month-select")?.addEventListener("change", async (e) => {
      const key = e.target.value; // YYYY-MM
      const [y, m] = key.split("-").map(Number);
      const d = new Date();
      d.setFullYear(y);
      d.setMonth(m - 1);
      d.setDate(1);
      d.setHours(0,0,0,0);

      state.selectedMonthStart = d;
      await refreshMonthView(state);
    });

    // 5) Load current (Today/Week) and initial month (current month)
    await refreshCurrentView(state);
    await refreshMonthView(state);

    // 6) Live tick for status card + “now”
    state.timers.tick = setInterval(() => {
      if (!state.currentCache) return;
      const now = new Date();
      const todayStart = startOfTodayLocal(now);

      updateStatusCard({
        employeeName: state.employee.display_name,
        role: state.employee.role,
        openShift: state.currentCache.openShift,
        openBreak: state.currentCache.openBreak,
        openShiftClosedBreakMs: state.currentCache.openShiftClosedBreakMs,
        breakCapMin: state.breakCapMin,
        closedBreakTodayMs: state.currentCache.closedBreakTodayMs,
        todayStart
      });
    }, 1000);

    // 7) Refresh current every 30s, and refresh selected month only if it’s the current month
    state.timers.refresh = setInterval(async () => {
      try {
        await refreshCurrentView(state);

        const curKey = monthKey(startOfMonthLocal(new Date()));
        const selKey = monthKey(state.selectedMonthStart);

        if (selKey === curKey) {
          // current month can change as shifts/breaks happen
          state.monthCache.delete(selKey);
          await refreshMonthView(state);
        }

        setSoftError(null);
      } catch (e) {
        console.warn("⚠️ Worker dashboard refresh failed:", e);
      }
    }, 30000);

    window.addEventListener("beforeunload", () => {
      if (state.timers.tick) clearInterval(state.timers.tick);
      if (state.timers.refresh) clearInterval(state.timers.refresh);
    });

  } catch (err) {
    console.error("❌ Worker dashboard failed:", err);
    setSoftError("Could not load your work summary. If this keeps happening, contact an admin.");
  }
});

/** ---------- Refresh functions ---------- */
async function refreshCurrentView(state) {
  const now = new Date();
  const todayStart = startOfTodayLocal(now);
  const weekStart = startOfWeekSunLocal(now);

  // Query a window that covers week overlaps (end = now)
  const windowStart = new Date(weekStart);
  windowStart.setDate(windowStart.getDate() - 1); // small overlap buffer
  const windowEnd = now;

  const entries = await loadEntriesOverlapping(
    state.employee.id,
    windowStart.toISOString(),
    windowEnd.toISOString()
  );

  const entryIds = entries.map(e => e.id);
  const breaks = await loadBreaksForEntryIds(entryIds);

  const { breaksByEntry, perEntryBreakMs, perEntryNetMs } = computePerEntryMaps(entries, breaks, now);

  const todayTotals = computeWindowTotals(entries, breaksByEntry, todayStart, now, now);
  const weekTotals = computeWindowTotals(entries, breaksByEntry, weekStart, now, now);

  // Closed breaks today (exclude any open break duration; we add live in tick)
  let closedBreakTodayMs = 0;
  for (const e of entries) {
    const blist = breaksByEntry[e.id] || [];
    for (const b of blist) {
      if (!b.ended_at) continue;
      const bs = new Date(b.started_at);
      const be = new Date(b.ended_at);
      closedBreakTodayMs += overlapMs(bs, be, todayStart, now);
    }
  }

  const { openShift, openBreak, openShiftClosedBreakMs } = findOpenShiftAndBreak(entries, breaksByEntry);

  state.currentCache = {
    entries,
    breaks,
    breaksByEntry,
    perEntryBreakMs,
    perEntryNetMs,
    todayTotals,
    weekTotals,
    openShift,
    openBreak,
    openShiftClosedBreakMs,
    closedBreakTodayMs
  };

  // Render today/week metrics (month comes from selected month)
  renderMetricGrid("worked-metrics", [
    { label: "Worked today", value: fmtHM(todayTotals.workedMs) },
    { label: "Worked this week (Sun–Sat)", value: fmtHM(weekTotals.workedMs) },
    { label: "Worked (selected month)", value: "—" }
  ]);

  renderMetricGrid("break-metrics", [
    { label: "Break today", value: fmtHM(todayTotals.breakMs) },
    { label: "Break this week (Sun–Sat)", value: fmtHM(weekTotals.breakMs) },
    { label: "Break (selected month)", value: "—" }
  ]);

  // Status (initial paint; live tick will maintain)
  updateStatusCard({
    employeeName: state.employee.display_name,
    role: state.employee.role,
    openShift,
    openBreak,
    openShiftClosedBreakMs,
    breakCapMin: state.breakCapMin,
    closedBreakTodayMs,
    todayStart
  });
}

async function refreshMonthView(state) {
  const selStart = state.selectedMonthStart;
  const selKey = monthKey(selStart);
  const selEnd = nextMonthStartLocal(selStart);

  // Update UI controls
  renderMonthPicker(state.months, selStart);

  // Check cache first (fast back/forward)
  let cached = state.monthCache.get(selKey);

  if (!cached) {
    // Efficient: fetch only selected month window (include overlap shifts)
    const entries = await loadEntriesOverlapping(
      state.employee.id,
      selStart.toISOString(),
      selEnd.toISOString()
    );

    const entryIds = entries.map(e => e.id);
    const breaks = await loadBreaksForEntryIds(entryIds);
    const anomalyMap = await loadAnomaliesForEntryIds(entryIds);

    const now = new Date();
    const { breaksByEntry, perEntryBreakMs, perEntryNetMs } = computePerEntryMaps(entries, breaks, now);

    // For month totals:
    // - If selected month is current month, end at now
    // - If past month, end at month end
    const isCurrentMonth = (monthKey(startOfMonthLocal(new Date())) === selKey);
    const monthWindowEnd = isCurrentMonth ? now : selEnd;

    const monthTotals = computeWindowTotals(entries, breaksByEntry, selStart, monthWindowEnd, now);

    // Keep entries sorted newest first (query already does)
    const monthEntries = entries
      .filter(e => {
        // Ensure recent list aligns to selected month (by clock_in date in local time)
        const cin = new Date(e.clock_in);
        return cin >= selStart && cin < selEnd;
      });

    cached = {
      entries: monthEntries,
      breaks,
      breaksByEntry,
      perEntryBreakMs,
      perEntryNetMs,
      monthTotals,
       anomalyMap // ✅ ADD THIS
    };

    state.monthCache.set(selKey, cached);
  }

  // Patch the “selected month” cards into existing grids (keep today/week as-is)
  const workedGrid = $("worked-metrics");
  const breakGrid = $("break-metrics");

  if (workedGrid) {
    const cards = workedGrid.querySelectorAll(".metric-card");
    if (cards[2]) {
      const valueEl = cards[2].querySelector("div:last-child");
      const labelEl = cards[2].querySelector("div:first-child");
      if (labelEl) labelEl.textContent = `Worked (${monthLabel(selStart)})`;
      if (valueEl) valueEl.textContent = fmtHM(cached.monthTotals.workedMs);
    }
  }

  if (breakGrid) {
    const cards = breakGrid.querySelectorAll(".metric-card");
    if (cards[2]) {
      const valueEl = cards[2].querySelector("div:last-child");
      const labelEl = cards[2].querySelector("div:first-child");
      if (labelEl) labelEl.textContent = `Break (${monthLabel(selStart)})`;
      if (valueEl) valueEl.textContent = fmtHM(cached.monthTotals.breakMs);
    }
  }

// Recent Shifts for selected month
const recent = cached.entries.slice(0, 10);

// If you cached full-month anomalies already, use them.
// (This is correct because recent entries are a subset of month entries.)
renderRecentShifts(
  recent,
  cached.perEntryNetMs,
  cached.perEntryBreakMs,
  cached.anomalyMap || {}
);


}
