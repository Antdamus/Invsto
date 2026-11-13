"use strict";

const state = {
  user: null,
  employee: null,
  stores: [],
  rows: [],
  notifications: [],
  requests: [],
  ledger: [],
  payouts: [],
  liveSessions: [],
  unassignedSales: [],
  smsHealth: null,
  sellers: [],
  currentMonth: startOfMonth(new Date()),
  selectedDate: startOfToday(new Date()),
  selectedChannel: "ebay",
  busy: false,
};

function $(id) {
  return document.getElementById(id);
}

function waitForSupabaseReady() {
  return new Promise((resolve, reject) => {
    if (window.supabase?.auth?.getSession) return resolve(window.supabase);
    const ready = () => { clearTimeout(timer); resolve(window.supabase); };
    const timer = setTimeout(() => {
      document.removeEventListener("supabase-ready", ready);
      reject(new Error("Could not connect. Check your connection and reload the page."));
    }, 10000);
    document.addEventListener("supabase-ready", ready, { once: true });
  });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function startOfToday(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function startOfMonth(date) {
  const next = startOfToday(date);
  next.setDate(1);
  return next;
}

function endOfMonth(date) {
  const next = new Date(date.getFullYear(), date.getMonth() + 1, 0);
  next.setHours(0, 0, 0, 0);
  return next;
}

function dateKey(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function dateFromKey(value) {
  const [year, month, day] = String(value || "").split("-").map(Number);
  if (!year || !month || !day) return startOfToday(new Date());
  return new Date(year, month - 1, day);
}

function addDays(date, days) {
  const next = startOfToday(date);
  next.setDate(next.getDate() + Number(days || 0));
  return next;
}

function nextFriday(date) {
  const start = startOfToday(date);
  const daysUntilFriday = (5 - start.getDay() + 7) % 7;
  return addDays(start, daysUntilFriday);
}

function formatMonth(date) {
  return date.toLocaleDateString([], { month: "long", year: "numeric" });
}

function formatDayTitle(date) {
  return date.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
}

function formatTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatTimeRange(row) {
  return showTimeRange(row);
}

function formatCurrency(value) {
  const amount = Number(value || 0);
  return amount.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatLedgerKind(value) {
  const kind = String(value || "sale").replace(/_/g, " ");
  return kind.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function getStoreName(storeId) {
  return state.stores.find((store) => String(store.id) === String(storeId))?.name || "";
}

function getSellerLabel(seller = {}) {
  return seller.seller_name || seller.display_name || seller.email || seller.seller_email || "Unnamed seller";
}

function getSessionSellerLabel(session = {}) {
  const primary = session.seller_snapshot?.primary || {};
  const primaryLabel = primary.display_name || primary.email || "Main seller";
  const coSellerCount = Array.isArray(session.co_seller_employee_ids) ? session.co_seller_employee_ids.length : 0;
  return `${primaryLabel}${coSellerCount ? ` + ${coSellerCount} more` : ""}`;
}

function minutesBetween(start, end) {
  const startDate = new Date(start);
  const endDate = new Date(end);
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) return 0;
  return Math.max(0, Math.round((endDate.getTime() - startDate.getTime()) / 60000));
}

function formatHours(minutes) {
  const safe = Math.max(0, Number(minutes || 0));
  const hours = Math.floor(safe / 60);
  const mins = safe % 60;
  if (!mins) return `${hours}h`;
  return `${hours}h ${String(mins).padStart(2, "0")}m`;
}

function normalizeChannel(value) {
  return ["ebay", "whatnot", "tiktok"].includes(String(value).toLowerCase()) ? String(value).toLowerCase() : "ebay";
}

function isActiveShift(row) {
  return ["booked", "edit_pending", "cancel_pending", "checked_in", "in_progress"].includes(String(row?.status || ""));
}

function canManageSellers() {
  return ["admin", "manager"].includes(String(state.employee?.role || "").toLowerCase());
}

function setEmailTriageAccessLinks(canAccess) {
  document.querySelectorAll("[data-email-triage-access-link]").forEach((link) => {
    link.hidden = canAccess !== true;
  });
}

async function checkEmailTriageAccess(employee) {
  const role = String(employee?.role || "").toLowerCase();
  if (role === "admin" || employee?.email_triage_access === true) return true;

  try {
    const { data, error } = await window.supabase.rpc("can_access_email_triage");
    if (error) throw error;
    return data === true;
  } catch (error) {
    console.warn("Email Triage access check failed:", error);
    return false;
  }
}

function isSameDateKey(value, key) {
  if (!value) return false;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return false;
  return dateKey(date) === key;
}

function overlaps(startA, endA, startB, endB) {
  return startA < endB && endA > startB;
}

function getSelectedChannel() {
  return state.selectedChannel;
}

function setSelectedChannel(channel) {
  state.selectedChannel = normalizeChannel(channel);
  document.querySelectorAll(".seller-segment button").forEach((button) => {
    button.classList.toggle("active", button.dataset.channel === state.selectedChannel);
    button.setAttribute("aria-pressed", String(button.dataset.channel === state.selectedChannel));
  });
  updateAvailabilityPreview();
}

function setStatus(message, type = "success") {
  const el = $("seller-form-status");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("is-error", type === "error");
}

async function markAcceptedIfNeeded() {
  try {
    await window.supabase.rpc("mark_invite_accepted");
  } catch (error) {
    console.warn("mark_invite_accepted failed on seller dashboard:", error);
  }
}

async function loadCurrentUser() {
  const { data: sessionData, error: sessionError } = await window.supabase.auth.getSession();
  if (sessionError || !sessionData?.session) {
    window.location.href = "index.html";
    return false;
  }

  state.user = sessionData.session.user;

  const { data: employee, error } = await window.supabase
    .from("employees")
    .select("id, user_id, display_name, email, role, active, email_triage_access")
    .eq("user_id", state.user.id)
    .maybeSingle();

  if (error || !employee || employee.active === false) {
    await window.supabase.auth.signOut();
    window.location.href = "index.html";
    return false;
  }

  const role = String(employee.role || "").toLowerCase();
  let assignedHost = false;
  if (role === "employee") {
    const { data, error: accessError } = await window.supabase.rpc("current_user_can_use_seller_schedule");
    if (accessError) throw accessError;
    assignedHost = data === true;
  }
  if (!["seller", "admin", "manager"].includes(role) && !assignedHost) {
    window.location.href = role === "employee" ? "worker-dashboard.html" : "index.html";
    return false;
  }

  state.employee = employee;
  setEmailTriageAccessLinks(await checkEmailTriageAccess(employee));
  return true;
}

async function loadStores() {
  const { data, error } = await window.supabase
    .from("store_locations")
    .select("id, name, active")
    .eq("active", true)
    .order("created_at", { ascending: true });

  if (error) throw error;
  state.stores = Array.isArray(data) ? data : [];
}

async function loadSchedule() { await loadShowRange(); }

async function loadNotifications() {
  const { data, error } = await window.supabase
    .from("seller_notifications")
    .select("id, title, body, urgency, read_at, created_at, shift_id, request_id")
    .order("created_at", { ascending: false })
    .limit(20);

  if (error) {
    console.warn("Seller notifications unavailable:", error);
    state.notifications = [];
    return;
  }

  state.notifications = Array.isArray(data) ? data : [];
}

async function loadRequests() {
  if (!canManageSellers()) {
    state.requests = [];
    return;
  }

  const { data, error } = await window.supabase
    .from("seller_shift_change_requests")
    .select("id, shift_id, seller_employee_id, request_type, requested_channel, requested_store_id, requested_start_at, requested_end_at, reason, status, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(50);

  if (error) {
    console.warn("Seller shift requests unavailable:", error);
    state.requests = [];
    return;
  }

  state.requests = Array.isArray(data) ? data : [];
}

async function loadCommission() {
  const ledgerResult = await window.supabase
    .from("seller_commission_ledger")
    .select("id, channel, source_type, source_label, net_store_proceeds, commission_amount, status, return_case_id, return_proof_url, created_at")
    .order("created_at", { ascending: false })
    .limit(30);

  if (ledgerResult.error) {
    console.warn("Seller commission ledger unavailable:", ledgerResult.error);
    state.ledger = [];
  } else {
    state.ledger = Array.isArray(ledgerResult.data) ? ledgerResult.data : [];
  }

  const payoutResult = await window.supabase
    .from("seller_commission_payouts")
    .select("id, period_start, period_end, payout_date, gross_commission, deductions, net_commission, status")
    .order("payout_date", { ascending: false })
    .limit(8);

  if (payoutResult.error) {
    console.warn("Seller commission payouts unavailable:", payoutResult.error);
    state.payouts = [];
  } else {
    state.payouts = Array.isArray(payoutResult.data) ? payoutResult.data : [];
  }
}

async function loadLiveSessions() {
  const { data, error } = await window.supabase
    .from("live_sale_sessions")
    .select("id, session_code, title, store_id, status, started_at, primary_seller_employee_id, co_seller_employee_ids, seller_snapshot")
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(6);

  if (error) {
    console.warn("Live sale sessions unavailable:", error);
    state.liveSessions = [];
    return;
  }

  state.liveSessions = Array.isArray(data) ? data : [];
}

async function loadSellerDirectory() {
  if (!canManageSellers()) {
    state.sellers = [];
    return;
  }

  let data = [];
  let error = null;
  const rpcResult = await window.supabase.rpc("get_live_sale_seller_directory");
  if (rpcResult.error) {
    const fallback = await window.supabase
      .from("employees")
      .select("id, display_name, email, role, active")
      .eq("active", true)
      .in("role", ["seller", "employee", "manager", "admin"])
      .order("display_name", { ascending: true });
    data = fallback.data || [];
    error = fallback.error;
  } else {
    data = rpcResult.data || [];
  }

  if (error) {
    console.warn("Seller directory unavailable:", error);
    data = [];
  }

  state.sellers = [...data, state.employee].filter(Boolean)
    .reduce((map, seller) => {
      if (!seller.id) return map;
      map.set(String(seller.id), {
        id: seller.id,
        display_name: seller.display_name || seller.email || "Unnamed seller",
        email: seller.email || "",
        role: seller.role || "",
        active: seller.active !== false,
      });
      return map;
    }, new Map());
  state.sellers = [...state.sellers.values()]
    .filter((seller) => seller.active !== false)
    .sort((a, b) => getSellerLabel(a).localeCompare(getSellerLabel(b)));
}

async function loadUnassignedSales() {
  if (!canManageSellers()) {
    state.unassignedSales = [];
    return;
  }

  const { data, error } = await window.supabase.rpc("get_unassigned_seller_sales", {
    _limit: 50,
  });

  if (error) {
    console.warn("Unassigned seller sales unavailable:", error);
    state.unassignedSales = [];
    return;
  }

  state.unassignedSales = Array.isArray(data) ? data : [];
}

async function loadSellerSmsHealth() {
  if (!canManageSellers()) {
    state.smsHealth = null;
    return;
  }

  const { data, error } = await window.supabase.rpc("get_seller_sms_health", {
    _hours_back: 24,
  });

  if (error) {
    console.warn("Seller SMS health unavailable:", error);
    state.smsHealth = null;
    return;
  }

  state.smsHealth = data || null;
}

async function refreshAll(options = {}) {
  if (state.busy && !options.afterMutation) return false;
  const wasBusy = state.busy;
  state.busy = true;
  $("seller-refresh").disabled = true;
  $("ss-prev").disabled = true; $("ss-next").disabled = true;
  showPageStatus("Refreshing your schedule…");
  try {
    await Promise.all([loadSchedule(), loadNotifications(), loadCommission(), loadRequests(), loadLiveSessions(), loadSellerDirectory(), loadUnassignedSales(), loadSellerSmsHealth(), loadShowSmsReadiness()]);
    renderAll();
    showPageStatus("");
    return true;
  } catch (error) {
    console.error("Seller schedule refresh failed:", error);
    showPageStatus("Could not load the schedule. " + (error.message || "Try Refresh again."), true);
    return false;
  } finally {
    state.busy = wasBusy;
    $("seller-refresh").disabled = false;
    $("ss-prev").disabled = false; $("ss-next").disabled = false;
  }
}

function rowsForDate(key) { return showRowsForDay(dateFromKey(key)); }

function renderCalendar() { renderShowPlanner(); }

function renderDayEvent(row) {
  const classes = [
    "seller-event",
    row.channel === "whatnot" ? "is-whatnot" : "",
    row.is_mine ? "is-mine" : "",
    row.is_blocked ? "is-blocked" : "",
  ].filter(Boolean).join(" ");
  const title = row.is_blocked
    ? `${row.channel === "all" ? "All" : row.channel} blocked`
    : `${row.channel} ${row.seller_name || "Seller"}`;
  return `<span class="${classes}">${escapeHtml(formatTime(row.start_at))} ${escapeHtml(title)}</span>`;
}

function renderSelectedDay() {
  const selectedKey = dateKey(state.selectedDate);
  const title = $("selected-day-title");
  if (title) title.textContent = formatDayTitle(state.selectedDate);

  const dateInput = $("booking-date");
  if (dateInput && !$("booking-shift-id")?.value) dateInput.value = selectedKey;

  const roster = $("selected-day-roster");
  if (!roster) return;

  const dayRows = rowsForDate(selectedKey);
  if (!dayRows.length) {
    roster.innerHTML = `<div class="seller-empty">No shows planned for this day. A fresh stage awaits.</div>`;
    return;
  }

  roster.innerHTML = dayRows.map((row) => {
    const channel = showPlatforms[row.channel] || row.channel;
    const name = row.is_blocked ? "Blocked" : row.seller_name || "Seller";
    const status = row.status ? `<span class="seller-pill">${escapeHtml(row.status.replace(/_/g, " "))}</span>` : "";
    const mineActions = showEditable(row)
      ? `
        <div class="seller-row-actions">
          <button type="button" data-action="edit" data-shift-id="${escapeHtml(row.shift_id)}">Edit</button>
          <button type="button" data-action="cancel" data-shift-id="${escapeHtml(row.shift_id)}">Cancel</button>
        </div>
      `
      : "";

    return `
      <div class="seller-roster-row">
        <strong>${escapeHtml(channel)} - ${escapeHtml(name)}</strong>
        <span>${escapeHtml(formatTimeRange(row))}${row.store_name ? ` at ${escapeHtml(row.store_name)}` : ""}</span>
        <div>${status}</div>
        ${mineActions}
      </div>
    `;
  }).join("");
}

function renderMyShifts() {
  const list = $("my-shifts-list");
  if (!list) return;

  const now = new Date();
  const rows = state.rows
    .filter((row) => row.is_mine && !row.is_blocked && isActiveShift(row) && new Date(row.end_at) >= now)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))
    .slice(0, 8);

  if (!rows.length) {
    list.innerHTML = `<div class="seller-empty">No upcoming seller shifts.</div>`;
    return;
  }

  list.innerHTML = rows.map((row) => `
    <div class="seller-list-row">
      <strong>${escapeHtml(showPlatforms[row.channel] || row.channel)} - ${escapeHtml(formatDateTime(row.start_at))}</strong>
      <span>${escapeHtml(formatTimeRange(row))}${row.store_name ? ` at ${escapeHtml(row.store_name)}` : ""}</span>
      <div><span class="seller-pill">${escapeHtml(String(row.status).replace(/_/g, " "))}</span></div>
      <div class="seller-row-actions">
        <button type="button" data-action="edit" data-shift-id="${escapeHtml(row.shift_id)}">Edit</button>
        <button type="button" data-action="cancel" data-shift-id="${escapeHtml(row.shift_id)}">Cancel</button>
      </div>
    </div>
  `).join("");
}

function renderCommission() {
  const list = $("commission-list");
  if (!list) return;

  const ledger = state.ledger.slice(0, 5);
  const payouts = state.payouts.slice(0, 3);

  if (!ledger.length && !payouts.length) {
    list.innerHTML = `<div class="seller-empty">No commission entries yet.</div>`;
    return;
  }

  const ledgerHtml = ledger.map((row) => {
    const isDeduction = Number(row.commission_amount || 0) < 0 || ["return", "cancellation"].includes(String(row.source_type || ""));
    const proofLink = row.return_proof_url
      ? `<a class="seller-proof-link" href="${escapeHtml(row.return_proof_url)}" target="_blank" rel="noopener">Return proof</a>`
      : "";
    return `
    <div class="seller-list-row ${isDeduction ? "is-deduction" : ""}">
      <strong>${escapeHtml(row.source_label || formatLedgerKind(row.source_type))} - ${escapeHtml(row.channel || "")}</strong>
      <span>Net ${escapeHtml(formatCurrency(row.net_store_proceeds))} / Commission ${escapeHtml(formatCurrency(row.commission_amount))}</span>
      ${proofLink}
      <div><span class="seller-pill">${escapeHtml(row.status || "pending")}</span></div>
    </div>
  `;
  }).join("");

  const payoutHtml = payouts.map((row) => `
    <div class="seller-list-row">
      <strong>${escapeHtml(row.payout_date || "Friday payout")}</strong>
      <span>${escapeHtml(formatCurrency(row.net_commission))} after ${escapeHtml(formatCurrency(row.deductions))} deductions</span>
      <div><span class="seller-pill">${escapeHtml(row.status || "draft")}</span></div>
      ${canManageSellers() && ["draft", "approved"].includes(String(row.status || ""))
        ? `<div class="seller-row-actions"><button type="button" data-action="mark-payout-paid" data-payout-id="${escapeHtml(row.id)}">Mark Paid</button></div>`
        : ""}
    </div>
  `).join("");

  list.innerHTML = `${ledgerHtml}${payoutHtml}`;
}

function renderNotifications() {
  const list = $("seller-notifications");
  if (!list) return;

  if (!state.notifications.length) {
    list.innerHTML = `<div class="seller-empty">No seller notifications.</div>`;
    return;
  }

  list.innerHTML = state.notifications.map((item) => `
    <div class="seller-list-row">
      <strong>${escapeHtml(item.title || "Notification")}</strong>
      <span>${escapeHtml(item.body || "")}</span>
      <div class="seller-row-actions">
        <span class="seller-pill">${escapeHtml(item.urgency || "normal")}</span>
        ${item.read_at ? "" : `<button type="button" data-action="read" data-notification-id="${escapeHtml(item.id)}">Mark read</button>`}
      </div>
    </div>
  `).join("");
}

function renderLiveSessions() {
  const list = $("seller-live-sessions");
  if (!list) return;

  if (!state.liveSessions.length) {
    list.innerHTML = `
      <div class="seller-empty">
        No active eBay live sale shows.
        <div class="seller-row-actions"><a class="seller-text-button" href="live-sales.html">Start Show</a></div>
      </div>
    `;
    return;
  }

  list.innerHTML = state.liveSessions.map((session) => `
    <div class="seller-list-row">
      <strong>${escapeHtml(session.title || "Live Sale")}</strong>
      <span>${escapeHtml(getSessionSellerLabel(session))}</span>
      <small>${escapeHtml(session.session_code || "")}${session.store_id ? ` - ${escapeHtml(getStoreName(session.store_id) || "Store")}` : ""} - ${escapeHtml(formatDateTime(session.started_at))}</small>
      <div class="seller-row-actions">
        <a class="seller-text-button" href="live-sales.html">Open Show</a>
      </div>
    </div>
  `).join("");
}

function renderSellerSelectOptions(row = {}) {
  const candidates = Array.isArray(row.candidate_sellers) ? row.candidate_sellers : [];
  const seen = new Set();
  const options = [];

  candidates.forEach((candidate) => {
    const id = candidate.seller_employee_id || candidate.id;
    if (!id || seen.has(String(id))) return;
    seen.add(String(id));
    options.push({
      id,
      label: `${getSellerLabel(candidate)} (suggested)`,
    });
  });

  state.sellers.forEach((seller) => {
    if (!seller.id || seen.has(String(seller.id))) return;
    seen.add(String(seller.id));
    options.push({
      id: seller.id,
      label: getSellerLabel(seller),
    });
  });

  return [
    `<option value="">Select seller</option>`,
    ...options.map((option, index) => (
      `<option value="${escapeHtml(option.id)}" ${index === 0 ? "selected" : ""}>${escapeHtml(option.label)}</option>`
    )),
  ].join("");
}

function formatInferenceSource(value) {
  const source = String(value || "unassigned").replace(/_/g, " ");
  return source.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function renderUnassignedSales() {
  const list = $("seller-unassigned-sales");
  if (!list) return;

  if (!state.unassignedSales.length) {
    list.innerHTML = `<div class="seller-empty">No unassigned seller sales.</div>`;
    return;
  }

  list.innerHTML = state.unassignedSales.map((row) => `
    <div class="seller-list-row" data-unassigned-row>
      <strong>${escapeHtml(row.item_title || "Untitled sale item")}</strong>
      <span>${escapeHtml(row.order_number || row.channel || "sale")} - ${escapeHtml(formatDateTime(row.sold_at))}</span>
      <small>${escapeHtml(formatInferenceSource(row.inference_source))} / ${Number(row.candidate_count || 0)} candidate(s) / Net ${escapeHtml(formatCurrency(row.net_store_proceeds))}</small>
      ${row.live_session_title ? `<small>Show: ${escapeHtml(row.live_session_title)}</small>` : ""}
      <div class="seller-assignment-row">
        <select data-unassigned-seller-select>
          ${renderSellerSelectOptions(row)}
        </select>
        <button type="button"
          data-action="assign-unassigned-seller"
          data-sale-item-id="${escapeHtml(row.sale_item_id)}"
          data-order-line-id="${escapeHtml(row.order_line_id || "")}">
          Assign
        </button>
      </div>
    </div>
  `).join("");
}

function renderSellerSmsHealth() {
  const list = $("seller-sms-health");
  if (!list) return;

  const health = state.smsHealth;
  if (!health) {
    list.innerHTML = `<div class="seller-empty">SMS health unavailable.</div>`;
    return;
  }

  const statusCounts = Object.entries(health.status_counts || {})
    .map(([status, count]) => `${status}: ${count}`)
    .join(" / ") || "No seller SMS in the last 24h";
  const hasIssue = Number(health.failed || 0) > 0 || Number(health.pending_over_10_min || 0) > 0;

  list.innerHTML = `
    <div class="seller-list-row ${hasIssue ? "is-deduction" : ""}">
      <strong>${hasIssue ? "Needs attention" : "Healthy"}</strong>
      <span>${escapeHtml(statusCounts)}</span>
      <small>Pending over 10 min: ${Number(health.pending_over_10_min || 0)} / Failed: ${Number(health.failed || 0)}</small>
      ${health.latest_created_at ? `<small>Latest: ${escapeHtml(formatDateTime(health.latest_created_at))}</small>` : ""}
      ${health.latest_error ? `<small>${escapeHtml(health.latest_error)}</small>` : ""}
    </div>
  `;
}

function renderManagement() {
  const panel = $("seller-management-panel");
  if (!panel) return;

  panel.classList.toggle("hidden", !canManageSellers());
  if (!canManageSellers()) return;

  const blockDate = $("block-date");
  if (blockDate) {
    blockDate.min = dateKey(state.currentMonth);
    blockDate.max = dateKey(endOfMonth(state.currentMonth));
    if (!blockDate.value) blockDate.value = dateKey(state.selectedDate);
  }

  const payoutEnd = $("payout-end");
  const payoutStart = $("payout-start");
  const payoutDate = $("payout-date");
  if (payoutEnd && !payoutEnd.value) payoutEnd.value = dateKey(new Date());
  if (payoutStart && !payoutStart.value) payoutStart.value = dateKey(addDays(dateFromKey(payoutEnd?.value || dateKey(new Date())), -6));
  if (payoutDate && !payoutDate.value) payoutDate.value = dateKey(nextFriday(dateFromKey(payoutEnd?.value || dateKey(new Date()))));

  renderUnassignedSales();
  renderSellerSmsHealth();

  const list = $("seller-requests-list");
  if (!list) return;

  if (!state.requests.length) {
    list.innerHTML = `<div class="seller-empty">No pending seller requests.</div>`;
    return;
  }

  list.innerHTML = state.requests.map((request) => {
    const shift = state.rows.find((row) => row.shift_id === request.shift_id) || {};
    const requestedWindow = request.request_type === "edit"
      ? `${formatDateTime(request.requested_start_at)} - ${formatTime(request.requested_end_at)}`
      : formatDateTime(shift.start_at);
    return `
      <div class="seller-list-row">
        <strong>${escapeHtml(shift.seller_name || "Seller")} - ${escapeHtml(request.request_type || "request")}</strong>
        <span>${escapeHtml(shift.channel || request.requested_channel || "")} ${escapeHtml(requestedWindow)}</span>
        ${request.reason ? `<small>${escapeHtml(request.reason)}</small>` : ""}
        <div class="seller-row-actions">
          <button type="button" data-action="approve-request" data-request-id="${escapeHtml(request.id)}">Approve</button>
          <button type="button" data-action="deny-request" data-request-id="${escapeHtml(request.id)}">Deny</button>
        </div>
      </div>
    `;
  }).join("");
}

function renderMetrics() {
  const now = new Date();
  const myRows = state.rows.filter((row) => row.is_mine && !row.is_blocked && isActiveShift(row));
  const next = myRows
    .filter((row) => new Date(row.start_at) >= now)
    .sort((a, b) => new Date(a.start_at) - new Date(b.start_at))[0];
  const minutes = myRows.reduce((sum, row) => sum + minutesBetween(row.start_at, row.end_at), 0);
  const commission = state.ledger
    .filter((row) => !["void"].includes(String(row.status || "")))
    .reduce((sum, row) => sum + Number(row.commission_amount || 0), 0);
  const pending = myRows.filter((row) => ["edit_pending", "cancel_pending"].includes(String(row.status || ""))).length;

  const nextEl = $("metric-next-shift");
  const hoursEl = $("metric-booked-hours");
  const commissionEl = $("metric-commission");
  const pendingEl = $("metric-pending");

  if (nextEl) nextEl.textContent = next ? formatDateTime(next.start_at) : "-";
  if (hoursEl) hoursEl.textContent = formatHours(minutes);
  if (commissionEl) commissionEl.textContent = formatCurrency(commission);
  if (pendingEl) pendingEl.textContent = String(pending);
}

function renderDateBounds() {
  const dateInput = $("booking-date");
  if (!dateInput) return;
  if (canManageSellers()) { dateInput.removeAttribute("min"); dateInput.removeAttribute("max"); }
  else {dateInput.min = dateKey(startOfMonth(new Date()));dateInput.max = dateKey(endOfMonth(new Date()));}
  if (!dateInput.value) dateInput.value = dateKey(state.selectedDate);
}

function renderAll() {
  renderDateBounds();
  renderCalendar();
  renderSelectedDay();
  renderMyShifts();
  renderCommission();
  renderLiveSessions();
  renderNotifications();
  renderManagement();
  renderMetrics();
  updateAvailabilityPreview();
  if (window.lucide) window.lucide.createIcons();
}

function buildDateTime(dateValue, timeValue) {
  if (!dateValue || !timeValue) return null;
  const [year, month, day] = dateValue.split("-").map(Number);
  const [hour, minute] = timeValue.split(":").map(Number);
  if (!year || !month || !day || !Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function getFormWindow() {
  const start = buildDateTime($("booking-date")?.value, $("booking-start")?.value);
  const end = buildDateTime($("booking-date")?.value, $("booking-end")?.value);
  if (end && $("booking-overnight")?.checked) end.setDate(end.getDate() + 1);
  return { start, end };
}

function validateFormWindow() {
  const {start, end} = getFormWindow();
  if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return {ok:false,message:"Choose a start and end time."};
  if (!canManageSellers() && dateKey(startOfMonth(start)) !== dateKey(startOfMonth(new Date()))) return {ok:false,message:"Sellers can book shows in the current month."};
  const minutes = (end - start) / 60000;
  if (minutes < 120) return {ok:false,message:"Shows need at least 2 hours. For an overnight show, select ‘Ends the following day’."};
  if (minutes > 1440) return {ok:false,message:"A show can be at most 24 hours."};
  if (start.getMinutes() % 30 || end.getMinutes() % 30) return {ok:false,message:"Use 30-minute intervals, such as 6:00 or 6:30."};
  if(showIsRepeating()){
    const days=showRepeatDays();
    if(!days.length)return {ok:false,message:"Choose at least one repeat day."};
    if(!days.includes(start.getDay()))return {ok:false,message:"Include the start date’s weekday in your repeat days, or choose a matching start date."};
    if(start<=new Date())return {ok:false,message:"Repeating shows must start in the future."};
    if($("booking-repeat-end").value==="date"&&(!$("booking-repeat-until").value||$("booking-repeat-until").value<$("booking-date").value))return {ok:false,message:"Choose a last show date on or after the start date."};
  }
  return {ok:true,start,end};
}

function updateAvailabilityPreview() {
  renderShowRepeat();
  renderShowSmsReadiness();
  const box = $("booking-availability"); if(!box) return;
  const validation = validateFormWindow();
  box.classList.remove("is-ok", "is-full");
  if(!validation.ok){box.textContent=validation.message;return;}
  const editingId=$("booking-shift-id").value, channel=getSelectedChannel();
  const sellerId=$("booking-seller").value || (!canManageSellers()?state.employee?.id:"");
  const rows=state.rows.filter(r=>r.shift_id!==editingId && overlaps(new Date(r.start_at),new Date(r.end_at),validation.start,validation.end));
  let conflict="";
  if(rows.some(r=>r.is_blocked&&(r.channel==="all"||r.channel===channel)))conflict="This time is blocked by management.";
  else if(rows.some(r=>!r.is_blocked&&isActiveShift(r)&&String(r.seller_employee_id)===sellerId))conflict="This seller already has a show during this time, including on another platform.";
  const channelRows=rows.filter(r=>!r.is_blocked&&isActiveShift(r)&&r.channel===channel);
  const points=[validation.start.getTime(),...channelRows.map(r=>Math.max(validation.start,new Date(r.start_at)))];
  const peak=Math.max(0,...points.map(t=>channelRows.filter(r=>new Date(r.start_at)<=t&&new Date(r.end_at)>t).length));
  if(!conflict&&peak>=2)conflict=showPlatforms[channel]+" already has two sellers at this time.";
  if(conflict){box.textContent=conflict;box.classList.add("is-full");return;}
  box.textContent=formatHours(minutesBetween(validation.start,validation.end))+" · "+(2-peak)+" seller "+(peak===1?"spot":"spots")+" available on "+showPlatforms[channel]+". Availability is checked again when saving.";
  box.classList.add("is-ok");
}

function setEditMode(row) {
  if (!row) return;
  const start = new Date(row.start_at);
  const end = new Date(row.end_at);
  if(showPlanner.view!=="month")state.selectedDate = startOfToday(start);

  $("booking-shift-id").value = row.shift_id || "";
  $("booking-date").value = dateKey(start);
  $("booking-start").value = `${String(start.getHours()).padStart(2, "0")}:${String(start.getMinutes()).padStart(2, "0")}`;
  $("booking-end").value = `${String(end.getHours()).padStart(2, "0")}:${String(end.getMinutes()).padStart(2, "0")}`;
  $("booking-note").value = row.notes || "";
  setSelectedChannel(row.channel);
  $("booking-submit").textContent = row.can_change_without_approval || canManageSellers() ? "Save changes" : "Request change";
  $("booking-cancel-shift")?.classList.remove("hidden");
  $("booking-repeat-info").classList.toggle("hidden", !row.metadata?.recurrence_id);
  $("booking-stop-repeat").classList.toggle("hidden", !row.metadata?.recurrence_id || !canManageSellers() || !showEditable(row));
  $("seller-clear-edit")?.classList.remove("hidden");
  $("booking-overnight").checked = dateKey(start) !== dateKey(end);
  renderAll();
  $("booking-seller").value = row.seller_employee_id || "";
  $("booking-seller").disabled = true;
  $("ss-editor-title").textContent = "Edit show";
  $("ss-editor-caption").textContent = `${row.seller_name || "Seller"} · ${showPlatforms[row.channel] || row.channel}`;
  updateAvailabilityPreview();
  if (!$("ss-editor").open) $("ss-editor").showModal();
}

function clearEditMode() {
  const todayKey = dateKey(state.selectedDate);
  $("booking-shift-id").value = "";
  $("booking-date").value = todayKey;
  $("booking-start").value = "";
  $("booking-end").value = "";
  $("booking-note").value = "";
  $("booking-repeat").value="none";$("booking-repeat-end").value="never";$("booking-repeat-until").value="";
  showPlanner.repeatRequest=null;
  $("booking-submit").textContent = "Schedule show";
  $("booking-overnight").checked = false;
  $("booking-seller").disabled = false;
  $("ss-editor-title").textContent = "Schedule a show";
  $("booking-cancel-shift")?.classList.add("hidden");
  $("booking-repeat-info").classList.add("hidden");
  $("booking-stop-repeat").classList.add("hidden");
  $("seller-clear-edit")?.classList.add("hidden");
  setStatus("");
  updateAvailabilityPreview();
}

async function submitBooking(event) {
  event.preventDefault(); if(state.busy)return;
  const validation=validateFormWindow();
  if(!validation.ok){setStatus(validation.message,"error");return;}
  if($("booking-availability").classList.contains("is-full")){setStatus($("booking-availability").textContent,"error");return;}
  const shiftId=$("booking-shift-id").value;
  const store=state.stores.find(item=>item.active!==false&&String(item.name||"").trim().toLowerCase()==="airport store");
  if(!store){setStatus("Airport Store is unavailable. Please contact management before scheduling.","error");return;}
  const params={_channel:getSelectedChannel(),_store_id:store.id,_start_at:validation.start.toISOString(),_end_at:validation.end.toISOString()};
  const note=$("booking-note").value||null;
  const sellerId=$("booking-seller").value;
  if(canManageSellers()&&!sellerId){setStatus("Choose the seller for this show.","error");return;}
  const repeatRequest=getShowRepeatRequest();
  state.busy=true;$("booking-submit").disabled=true;setStatus("Saving your show…");
  try{
    let result;
    if(shiftId) result=await window.supabase.rpc("request_seller_sale_shift_edit",{_shift_id:shiftId,...params,_reason:$("booking-note").value});
    else if(repeatRequest)result=await window.supabase.rpc("admin_create_seller_show_recurrence",repeatRequest);
    else if(canManageSellers())result=await window.supabase.rpc("admin_schedule_seller_show",{...params,_seller_employee_id:sellerId,_notes:note});
    else result=await window.supabase.rpc("book_seller_sale_shift",{...params,_notes:note});
    if(result.error)throw result.error;
    const message=repeatRequest?`Repeating schedule saved. ${result.data.created} upcoming shows scheduled.`:result.data?.status==="approval_requested"?"Change request sent to management.":shiftId?"Show updated.":"Show scheduled. Your stage is set.";
    state.selectedDate=startOfToday(validation.start);state.currentMonth=startOfMonth(validation.start);
    $("ss-editor").close();clearEditMode();
    if(await refreshAll({afterMutation:true}))showPageStatus(message);
  }catch(error){setStatus(error.message||"Could not save this show. Your details are still here; please try again.","error");}
  finally{state.busy=false;$("booking-submit").disabled=false;}
}

async function cancelShift(shiftId, stopRepeating = false) {
  if (!shiftId || state.busy) return;
  const row = state.rows.find(item => item.shift_id === shiftId);
  if (!row || !showEditable(row)) return;
  const dialog = $("ss-cancel-dialog");
  dialog.dataset.shiftId = shiftId;
  const recurrenceId = stopRepeating && canManageSellers() ? row.metadata?.recurrence_id : null;
  if (stopRepeating && !recurrenceId) return;
  dialog.dataset.recurrenceId = recurrenceId || "";
  $("ss-cancel-title").textContent = recurrenceId ? "Stop this repeating time slot?" : "Cancel this show?";
  $("ss-cancel-submit").textContent = recurrenceId ? "Stop repeating" : "Cancel show";
  $("ss-cancel-keep").textContent = recurrenceId ? "Keep schedule" : "Keep show";
  $("ss-cancel-reason").value = "";
  $("ss-cancel-status").textContent = "";
  $("ss-cancel-caption").textContent = `${row.seller_name} · ${showPlatforms[row.channel]} · ${formatDateTime(row.start_at)}. ${row.can_change_without_approval || canManageSellers() ? "This will free the slot on your schedule." : "Management will review your cancellation request."}`;
  if (recurrenceId) $("ss-cancel-caption").textContent = `${row.seller_name} · ${showPlatforms[row.channel]}. All future shows in this recurring series will be cancelled, and their reminders will stop. Other recurring time slots stay scheduled.`;
  dialog.showModal();
}

async function confirmCancelShow(event) {
  event.preventDefault();
  if (state.busy) return;
  const shiftId = $("ss-cancel-dialog").dataset.shiftId;
  const recurrenceId = $("ss-cancel-dialog").dataset.recurrenceId;
  if (!shiftId) return;
  state.busy = true;
  $("ss-cancel-submit").disabled = true;
  $("ss-cancel-status").textContent = "Updating the schedule…";

  try {
    const { data, error } = await window.supabase.rpc(recurrenceId ? "admin_stop_seller_show_recurrence" : "cancel_seller_sale_shift", {
      ...(recurrenceId ? { _recurrence_id: recurrenceId } : { _shift_id: shiftId }),
      _reason: $("ss-cancel-reason").value || null,
    });
    if (error) throw error;
    $("ss-cancel-dialog").close();
    $("ss-editor").close();
    clearEditMode();
    if (await refreshAll({ afterMutation: true })) showPageStatus(recurrenceId ? "Repeating time slot stopped. Future shows in this series have been cancelled." : data?.status === "approval_requested" ? "Cancellation sent to management." : "Show cancelled.");
  } catch (error) {
    console.error("Seller shift cancellation failed:", error);
    $("ss-cancel-status").textContent = error.message || "Could not cancel the show. Please try again.";
    $("ss-cancel-status").classList.add("is-error");
  } finally {
    state.busy = false;
    $("ss-cancel-submit").disabled = false;
  }
}

async function markNotificationRead(notificationId) {
  if (!notificationId) return;
  const { error } = await window.supabase
    .from("seller_notifications")
    .update({ read_at: new Date().toISOString() })
    .eq("id", notificationId);

  if (error) {
    setStatus(error.message || "Could not mark notification read.", "error");
    return;
  }

  await loadNotifications();
  renderNotifications();
}

async function reviewSellerRequest(requestId, decision) {
  if (!requestId || state.busy) return;
  const note = decision === "deny"
    ? window.prompt("Reason for denying this request") || ""
    : "";

  state.busy = true;
  const statusEl = $("seller-management-status");
  if (statusEl) statusEl.textContent = `${decision === "approve" ? "Approving" : "Denying"} request...`;

  try {
    const { error } = await window.supabase.rpc("admin_review_seller_shift_request", {
      _request_id: requestId,
      _decision: decision === "approve" ? "approve" : "deny",
      _review_note: note,
    });
    if (error) throw error;
    if (statusEl) statusEl.textContent = "Request updated.";
    await refreshAll({ afterMutation: true });
  } catch (error) {
    console.error("Seller request review failed:", error);
    if (statusEl) {
      statusEl.textContent = error.message || "Could not update request.";
      statusEl.classList.add("is-error");
    }
  } finally {
    state.busy = false;
  }
}

async function submitBlock(event) {
  event.preventDefault();
  if (!canManageSellers() || state.busy) return;

  const start = buildDateTime($("block-date")?.value, $("block-start")?.value);
  const end = buildDateTime($("block-date")?.value, $("block-end")?.value);
  const statusEl = $("seller-management-status");

  if (!start || !end || end <= start) {
    if (statusEl) {
      statusEl.textContent = "Choose a valid block window.";
      statusEl.classList.add("is-error");
    }
    return;
  }

  state.busy = true;
  if (statusEl) {
    statusEl.textContent = "Blocking time...";
    statusEl.classList.remove("is-error");
  }

  try {
    const { error } = await window.supabase.rpc("admin_save_seller_sale_block", {
      _block_id: null,
      _channel: $("block-channel")?.value || "all",
      _start_at: start.toISOString(),
      _end_at: end.toISOString(),
      _reason: $("block-reason")?.value || null,
      _active: true,
    });
    if (error) throw error;
    if (statusEl) statusEl.textContent = "Sale time blocked.";
    $("block-start").value = "";
    $("block-end").value = "";
    $("block-reason").value = "";
    await refreshAll({ afterMutation: true });
  } catch (error) {
    console.error("Seller block save failed:", error);
    if (statusEl) {
      statusEl.textContent = error.message || "Could not block sale time.";
      statusEl.classList.add("is-error");
    }
  } finally {
    state.busy = false;
  }
}

async function submitPayout(event) {
  event.preventDefault();
  if (!canManageSellers() || state.busy) return;

  const statusEl = $("seller-payout-status");
  const periodStart = $("payout-start")?.value;
  const periodEnd = $("payout-end")?.value;
  const payoutDate = $("payout-date")?.value;

  if (!periodStart || !periodEnd || !payoutDate) {
    if (statusEl) {
      statusEl.textContent = "Choose the payout dates.";
      statusEl.classList.add("is-error");
    }
    return;
  }

  state.busy = true;
  if (statusEl) {
    statusEl.textContent = "Preparing payouts...";
    statusEl.classList.remove("is-error");
  }

  try {
    const { data, error } = await window.supabase.rpc("create_seller_commission_payouts", {
      _period_start: periodStart,
      _period_end: periodEnd,
      _payout_date: payoutDate,
    });
    if (error) throw error;
    const count = Array.isArray(data) ? data.length : 0;
    if (statusEl) statusEl.textContent = count ? `Prepared ${count} payout${count === 1 ? "" : "s"}.` : "No unpaid commission entries for that period.";
    await refreshAll({ afterMutation: true });
  } catch (error) {
    console.error("Seller payout preparation failed:", error);
    if (statusEl) {
      statusEl.textContent = error.message || "Could not prepare payouts.";
      statusEl.classList.add("is-error");
    }
  } finally {
    state.busy = false;
  }
}

async function markPayoutPaid(payoutId) {
  if (!canManageSellers() || !payoutId || state.busy) return;
  if (!window.confirm("Mark this seller commission payout as paid?")) return;

  state.busy = true;
  setStatus("Marking payout paid...");

  try {
    const { error } = await window.supabase.rpc("mark_seller_commission_payout_paid", {
      _payout_id: payoutId,
      _notes: null,
    });
    if (error) throw error;
    setStatus("Payout marked paid.");
    await refreshAll({ afterMutation: true });
  } catch (error) {
    console.error("Seller payout paid failed:", error);
    setStatus(error.message || "Could not mark payout paid.", "error");
  } finally {
    state.busy = false;
  }
}

async function assignUnassignedSeller(button) {
  if (!canManageSellers() || state.busy) return;

  const row = button.closest("[data-unassigned-row]");
  const select = row?.querySelector("[data-unassigned-seller-select]");
  const sellerId = select?.value || "";
  const saleItemId = button.dataset.saleItemId || "";
  const orderLineId = button.dataset.orderLineId || "";

  if (!sellerId || !saleItemId) {
    setStatus("Select a seller for that sale first.", "error");
    select?.focus();
    return;
  }

  state.busy = true;
  setStatus("Assigning seller to sale...");

  try {
    const rpcName = orderLineId ? "assign_seller_to_ebay_order_line" : "assign_seller_to_sale_item";
    const payload = orderLineId
      ? {
        _order_line_id: orderLineId,
        _seller_employee_id: sellerId,
        _seller_sale_shift_id: null,
        _notes: "Seller assigned from unassigned seller review queue.",
      }
      : {
        _sale_item_id: saleItemId,
        _seller_employee_id: sellerId,
        _seller_sale_shift_id: null,
        _notes: "Seller assigned from unassigned seller review queue.",
      };
    const { error } = await window.supabase.rpc(rpcName, payload);
    if (error) throw error;
    setStatus("Seller assigned and commission ledger synced.");
    state.busy = false;
    await refreshAll({ afterMutation: true });
  } catch (error) {
    console.error("Unassigned seller assignment failed:", error);
    setStatus(error.message || "Could not assign seller to that sale.", "error");
  } finally {
    state.busy = false;
  }
}

function handleActionClick(event) {
  const button = event.target.closest("button[data-action]");
  if (!button) return;

  const action = button.dataset.action;
  if (action === "edit") {
    const row = state.rows.find((item) => item.shift_id === button.dataset.shiftId);
    setEditMode(row);
  } else if (action === "cancel") {
    cancelShift(button.dataset.shiftId);
  } else if (action === "read") {
    markNotificationRead(button.dataset.notificationId);
  } else if (action === "approve-request") {
    reviewSellerRequest(button.dataset.requestId, "approve");
  } else if (action === "deny-request") {
    reviewSellerRequest(button.dataset.requestId, "deny");
  } else if (action === "mark-payout-paid") {
    markPayoutPaid(button.dataset.payoutId);
  } else if (action === "assign-unassigned-seller") {
    assignUnassignedSeller(button);
  }
}

function setupListeners() {
  $("seller-menu-toggle")?.addEventListener("click", () => {
    const open = $("seller-mobile-menu")?.classList.toggle("show");
    $("seller-menu-toggle").setAttribute("aria-expanded", String(open));
  });

  const signOut = async (event) => {
    event.preventDefault();
    await window.supabase.auth.signOut();
    window.location.href = "index.html";
  };
  $("seller-logout")?.addEventListener("click", signOut);
  $("seller-logout-mobile")?.addEventListener("click", signOut);

  $("seller-refresh")?.addEventListener("click", refreshAll);
  $("seller-calendar")?.addEventListener("click", (event) => {
    const cell = event.target.closest("[data-date]");
    if (!cell) return;
    state.selectedDate = dateFromKey(cell.dataset.date);
    if (!$("booking-shift-id")?.value) $("booking-date").value = cell.dataset.date;
    renderAll();
  });

  document.querySelectorAll(".seller-segment button").forEach((button) => {
    button.addEventListener("click", () => setSelectedChannel(button.dataset.channel));
  });

  ["booking-date", "booking-start", "booking-end"].forEach((id) => {
    $(id)?.addEventListener("change", updateAvailabilityPreview);
    $(id)?.addEventListener("input", updateAvailabilityPreview);
  });

  $("payout-end")?.addEventListener("change", () => {
    const end = dateFromKey($("payout-end")?.value || dateKey(new Date()));
    if ($("payout-start")) $("payout-start").value = dateKey(addDays(end, -6));
    if ($("payout-date")) $("payout-date").value = dateKey(nextFriday(end));
  });

  $("seller-booking-form")?.addEventListener("submit", submitBooking);
  $("seller-block-form")?.addEventListener("submit", submitBlock);
  $("seller-payout-form")?.addEventListener("submit", submitPayout);
  $("booking-cancel-shift")?.addEventListener("click", () => {
    const shiftId = $("booking-shift-id")?.value;
    cancelShift(shiftId);
  });
  $("seller-clear-edit")?.addEventListener("click", clearEditMode);
  $("booking-stop-repeat")?.addEventListener("click", () => cancelShift($("booking-shift-id").value, true));

  ["selected-day-roster", "my-shifts-list", "seller-notifications", "seller-requests-list", "commission-list", "seller-unassigned-sales"].forEach((id) => {
    $(id)?.addEventListener("click", handleActionClick);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await waitForSupabaseReady();
    const ok = await loadCurrentUser();
    if (!ok) return;
    await markAcceptedIfNeeded();
    setupListeners();
    setupShowPlanner();
    setSelectedChannel("ebay");
    await loadStores();
    renderDateBounds();
    await refreshAll({ afterMutation: true });
  } catch (error) {
    console.error("Seller dashboard boot failed:", error);
    showPageStatus(error.message || "Could not load your schedule.", true);
  }
});
