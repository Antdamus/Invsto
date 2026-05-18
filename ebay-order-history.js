const state = {
  user: null,
  employee: null,
  lines: [],
  adminEvents: [],
  revertEvents: [],
  relatedAdminEvents: [],
  relatedRevertEvents: [],
  filteredLines: [],
  adminCloseoutLineIds: new Set(),
  selectedRevertLineIds: [],
  busy: false,
};

let evidencePhotoViewerReturnFocus = null;

function $(id) {
  return document.getElementById(id);
}

function waitForSupabaseReady() {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(window.supabase);
    document.addEventListener("supabase-ready", () => resolve(window.supabase), { once: true });
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

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0.00";
  return number.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDateInputValue(date = new Date()) {
  const copy = new Date(date);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 10);
}

function getDateRange() {
  const fromValue = $("history-from")?.value || toDateInputValue();
  const toValue = $("history-to")?.value || fromValue;
  const from = new Date(`${fromValue}T00:00:00`);
  const to = new Date(`${toValue}T23:59:59.999`);
  return {
    fromIso: from.toISOString(),
    toIso: to.toISOString(),
  };
}

function getOrderFromLine(line) {
  const order = line?.ebay_orders || line?.order || {};
  return Array.isArray(order) ? order[0] || {} : order;
}

function normalizeLine(row) {
  return {
    ...row,
    order: getOrderFromLine(row),
    searchText: [
      row.item_title,
      row.item_number,
      row.transaction_id,
      row.custom_label,
      row.quantity,
      row.fulfilled_quantity,
      row.sold_for,
      row.total_price,
      row.line_status,
      getLineStatusLabel(row),
      row.fulfilled_by_email,
      row.fulfilled_at,
      row.notes,
      getOrderFromLine(row).order_number,
      getOrderFromLine(row).buyer_username,
      getOrderFromLine(row).sales_record_number,
      getOrderFromLine(row).sale_date,
      getOrderFromLine(row).paid_on_date,
      getOrderFromLine(row).ship_by_date,
      getOrderFromLine(row).status,
    ].filter(Boolean).join(" ").toLowerCase(),
  };
}

function getLineGross(line) {
  const total = Number(line.total_price || 0);
  if (total > 0) return total;
  return Number(line.sold_for || 0) * Math.max(Number(line.fulfilled_quantity || line.quantity || 1), 1);
}

function getLinePayout(line) {
  const payout = Number(line.net_payout || 0);
  return Number.isFinite(payout) ? payout : 0;
}

function getLineStatusLabel(line) {
  if (line.line_status === "cancelled") return "Canceled";
  if (isAdminCloseoutLine(line)) return "No-inventory completion";
  if (line.line_status === "fulfilled") return "Shipped";
  return line.line_status || "Closed";
}

function getLineStatusClass(line) {
  if (line.line_status === "cancelled") return "is-cancelled";
  if (isAdminCloseoutLine(line)) return "is-admin";
  return "";
}

function isAdminCloseoutLine(line) {
  return state.adminCloseoutLineIds.has(line.id)
    || (line.line_status === "fulfilled" && !line.stock_transaction_id);
}

function isAdminUser() {
  return String(state.employee?.role || "").toLowerCase() === "admin";
}

function getEventGpsLabel(event) {
  const status = String(event?.gps_status || event?.payload?.gps?.status || "").trim();
  if (!status) return "";
  if (status === "captured" && event?.gps_latitude != null && event?.gps_longitude != null) {
    const lat = Number(event.gps_latitude).toFixed(5);
    const lng = Number(event.gps_longitude).toFixed(5);
    const accuracy = event.gps_accuracy_meters != null ? `, ${Number(event.gps_accuracy_meters).toFixed(0)} m` : "";
    return `GPS ${lat}, ${lng}${accuracy}`;
  }
  return `GPS ${status.replace(/_/g, " ")}`;
}

function getEventEvidencePhotos(event) {
  const photos = event?.payload?.evidence_photos;
  return Array.isArray(photos)
    ? photos.filter((photo) => photo?.bucket && photo?.path)
    : [];
}

async function signEventEvidencePhoto(photo, options = {}) {
  const thumbnail = options.thumbnail !== false;
  try {
    const storage = supabase.storage.from(photo.bucket);
    const { data, error } = thumbnail
      ? await storage.createSignedUrl(photo.path, 600, {
        transform: { width: 260, height: 260, resize: "contain", quality: 60 },
      })
      : await storage.createSignedUrl(photo.path, 600);
    if (!error && data?.signedUrl) return data.signedUrl;
  } catch (_) {}

  try {
    const { data, error } = await supabase.storage.from(photo.bucket).createSignedUrl(photo.path, 600);
    if (!error && data?.signedUrl) return data.signedUrl;
  } catch (_) {}

  return "";
}

function openEvidencePhotoViewer(url, label = "Evidence photo", meta = "") {
  if (!url) return;
  evidencePhotoViewerReturnFocus = document.activeElement;
  const image = $("evidence-photo-viewer-image");
  const title = $("evidence-photo-viewer-title");
  const caption = $("evidence-photo-viewer-caption");
  if (image) {
    image.src = url;
    image.alt = label;
  }
  if (title) title.textContent = label;
  if (caption) caption.textContent = meta;
  openModal("evidence-photo-viewer-modal");
  setTimeout(() => $("close-evidence-photo-viewer")?.focus(), 80);
}

function closeEvidencePhotoViewer() {
  const image = $("evidence-photo-viewer-image");
  if (image) image.src = "";
  closeModal("evidence-photo-viewer-modal");
  evidencePhotoViewerReturnFocus?.focus?.();
  evidencePhotoViewerReturnFocus = null;
}

function openProofTrailModal() {
  openModal("proof-trail-modal");
  setTimeout(() => $("close-proof-trail-modal")?.focus(), 80);
}

function closeProofTrailModal() {
  closeModal("proof-trail-modal");
}

async function hydrateEventEvidencePhotos(events) {
  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex];
    const photos = getEventEvidencePhotos(event);
    const container = document.querySelector(`[data-event-evidence-index="${eventIndex}"]`);
    if (!container || !photos.length) continue;

    const signed = await Promise.all(photos.map(async (photo, index) => ({
      ...photo,
      thumbUrl: await signEventEvidencePhoto(photo),
      fullUrl: await signEventEvidencePhoto(photo, { thumbnail: false }),
      label: photo.label || `Evidence photo ${index + 1}`,
    })));
    const visible = signed.filter((photo) => photo.thumbUrl || photo.fullUrl);
    if (!visible.length) continue;

    container.innerHTML = visible.map((photo) => `
      <button class="event-photo-thumb" type="button" data-evidence-photo-url="${escapeHtml(photo.fullUrl || photo.thumbUrl)}" data-evidence-photo-label="${escapeHtml(photo.label)}" data-evidence-photo-meta="${escapeHtml(photo.bucket + "/" + photo.path)}">
        <img src="${escapeHtml(photo.thumbUrl || photo.fullUrl)}" alt="${escapeHtml(photo.label)}" />
        <span>${escapeHtml(photo.label)}</span>
      </button>
    `).join("");

    container.querySelectorAll("[data-evidence-photo-url]").forEach((button) => {
      button.addEventListener("click", () => {
        openEvidencePhotoViewer(
          button.dataset.evidencePhotoUrl,
          button.dataset.evidencePhotoLabel,
          button.dataset.evidencePhotoMeta
        );
      });
    });
  }
}

async function checkHistoryAuth() {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session) {
    window.location.href = "index.html";
    return false;
  }

  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active, display_name")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (employeeError || !employee || employee.active === false) {
    window.location.href = "worker-dashboard.html";
    return false;
  }

  state.user = session.user;
  state.employee = employee;
  const greeting = $("history-greeting");
  if (greeting) greeting.textContent = `eBay Order History${employee.display_name ? ` - ${employee.display_name}` : ""}`;
  const subtitle = $("history-subtitle");
  if (subtitle) {
    subtitle.textContent = isAdminUser()
      ? "Admin shipping monitor - completed, canceled, and reverted orders"
      : "Search completed orders and open packing proof photos.";
  }
  const mode = $("history-mode-label");
  if (mode) mode.textContent = isAdminUser() ? "Admin" : "Proof";
  if (!isAdminUser()) {
    document.body.classList.add("history-worker-proof-mode");
    $("history-status")?.querySelector('option[value="reverted"]')?.remove();
  }
  if (window.OGRoleNavigation?.render) {
    window.OGRoleNavigation.render(isAdminUser() ? "admin" : "worker");
  }
  return true;
}

function setupDashboardShell() {
  const menuToggle = $("menu-toggle");
  const mobileMenu = $("mobile-menu");
  menuToggle?.addEventListener("click", () => mobileMenu?.classList.toggle("open"));
  $("logout")?.addEventListener("click", logout);
  $("logout-mobile")?.addEventListener("click", logout);

  const datePill = $("history-date-pill");
  if (datePill) {
    datePill.innerHTML = `Date: <b>${new Date().toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    })}</b>`;
  }
}

async function logout(event) {
  event?.preventDefault();
  await supabase.auth.signOut();
  window.location.href = "index.html";
}

function setupDefaultDates() {
  const todayDate = new Date();
  const fromDate = new Date(todayDate);
  fromDate.setDate(fromDate.getDate() - 14);
  const today = toDateInputValue(todayDate);
  if ($("history-from") && !$("history-from").value) $("history-from").value = toDateInputValue(fromDate);
  if ($("history-to") && !$("history-to").value) $("history-to").value = today;
  const search = $("history-search");
  if (search) {
    search.value = "";
    search.setAttribute("autocomplete", "off");
    search.setAttribute("autocorrect", "off");
    search.setAttribute("autocapitalize", "off");
    search.setAttribute("spellcheck", "false");
  }
}

async function loadOrderHistory() {
  const list = $("history-list");
  const eventList = $("event-list");
  if (list) list.innerHTML = `<div class="history-empty">Loading order history...</div>`;
  if (eventList) eventList.innerHTML = `<div class="history-empty">Loading proof events...</div>`;

  const { fromIso, toIso } = getDateRange();

  const linesQuery = supabase
    .from("ebay_order_lines")
    .select(`
      id,
      order_id,
      item_number,
      transaction_id,
      item_title,
      custom_label,
      quantity,
      sold_for,
      shipping_and_handling,
      total_price,
      net_payout,
      line_status,
      internal_item_id,
      stock_location_row_id,
      location_id,
      fulfilled_quantity,
      fulfilled_by,
      fulfilled_by_email,
      fulfilled_at,
      sale_id,
      sale_item_id,
      stock_transaction_id,
      notes,
      ebay_orders!inner(
        id,
        order_number,
        sales_record_number,
        buyer_username,
        sale_date,
        paid_on_date,
        ship_by_date,
        status,
        total_price,
        net_payout
      )
    `)
    .in("line_status", ["fulfilled", "cancelled", "skipped"])
    .gte("fulfilled_at", fromIso)
    .lte("fulfilled_at", toIso)
    .order("fulfilled_at", { ascending: false })
    .limit(600);

  const adminEventsQuery = supabase
    .from("ebay_order_admin_events")
    .select("*")
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(300);

  const revertEventsQuery = isAdminUser()
    ? supabase
      .from("ebay_order_revert_events")
      .select("*")
      .gte("created_at", fromIso)
      .lte("created_at", toIso)
      .order("created_at", { ascending: false })
      .limit(300)
    : Promise.resolve({ data: [], error: null });

  const [linesResult, adminEventsResult, revertEventsResult] = await Promise.all([
    linesQuery,
    adminEventsQuery,
    revertEventsQuery,
  ]);

  if (linesResult.error) {
    console.error("Failed to load eBay order history:", linesResult.error);
    if (list) list.innerHTML = `<div class="history-empty">Could not load order history.</div>`;
    return;
  }

  if (adminEventsResult.error) {
    console.warn("Failed to load admin closeout events:", adminEventsResult.error);
  }

  if (revertEventsResult.error) {
    console.warn("Failed to load eBay revert events. Push the latest migration if this is new:", revertEventsResult.error);
  }

  const closedLines = (linesResult.data || []).map(normalizeLine);
  const closedLineIds = closedLines.map((line) => line.id).filter(Boolean);
  let relatedAdminEvents = [];
  let relatedRevertEvents = [];

  if (closedLineIds.length) {
    const [relatedAdminResult, relatedRevertResult] = await Promise.all([
      supabase
        .from("ebay_order_admin_events")
        .select("*")
        .overlaps("order_line_ids", closedLineIds)
        .limit(500),
      isAdminUser()
        ? supabase
          .from("ebay_order_revert_events")
          .select("*")
          .overlaps("order_line_ids", closedLineIds)
          .limit(500)
        : Promise.resolve({ data: [], error: null }),
    ]);

    if (relatedAdminResult.error) {
      console.warn("Failed to load related admin events for visible order lines:", relatedAdminResult.error);
    } else {
      relatedAdminEvents = relatedAdminResult.data || [];
    }

    if (relatedRevertResult.error) {
      console.warn("Failed to load related revert events for visible order lines:", relatedRevertResult.error);
    } else {
      relatedRevertEvents = relatedRevertResult.data || [];
    }
  }

  state.adminEvents = adminEventsResult.data || [];
  state.revertEvents = revertEventsResult.data || [];
  state.relatedAdminEvents = relatedAdminEvents;
  state.relatedRevertEvents = relatedRevertEvents;
  state.adminCloseoutLineIds = new Set(
    [...state.adminEvents, ...state.relatedAdminEvents]
      .filter((event) => event.action === "fulfilled_no_inventory")
      .flatMap((event) => Array.isArray(event.order_line_ids) ? event.order_line_ids : [])
  );
  state.lines = closedLines;
  renderWorkerOptions();
  applyFilters();
}

function renderWorkerOptions() {
  const select = $("history-worker");
  if (!select) return;
  const current = select.value;
  const workers = new Set();

  state.lines.forEach((line) => {
    if (line.fulfilled_by_email) workers.add(line.fulfilled_by_email);
  });
  [...state.adminEvents, ...state.revertEvents].forEach((event) => {
    if (event.signed_by_email) workers.add(event.signed_by_email);
  });

  select.innerHTML = `<option value="">All workers</option>${[...workers].sort().map((email) => (
    `<option value="${escapeHtml(email)}">${escapeHtml(email)}</option>`
  )).join("")}`;
  if ([...workers].includes(current)) select.value = current;
}

function applyFilters() {
  const term = String($("history-search")?.value || "").trim().toLowerCase();
  const worker = $("history-worker")?.value || "";
  const status = $("history-status")?.value || "all";

  state.filteredLines = state.lines.filter((line) => {
    if (status === "reverted") return false;
    if (status === "fulfilled" && line.line_status !== "fulfilled") return false;
    if (status === "cancelled" && line.line_status !== "cancelled") return false;
    if (status === "admin_closeout" && !isAdminCloseoutLine(line)) return false;
    if (worker && line.fulfilled_by_email !== worker) return false;
    if (term && !line.searchText.includes(term)) return false;
    return true;
  });

  renderSummary();
  renderHistoryList();
  renderEventList();
}

function renderSummary() {
  const shippedLines = state.filteredLines.filter((line) => line.line_status === "fulfilled");
  const shippedOrderIds = new Set(shippedLines.map((line) => line.order_id));
  const gross = shippedLines.reduce((sum, line) => sum + getLineGross(line), 0);
  const payout = shippedLines.reduce((sum, line) => sum + getLinePayout(line), 0);
  const filteredEvents = getFilteredEvents();
  const closeouts = filteredEvents.filter((event) => event.action === "fulfilled_no_inventory").length;
  const cancelled = state.filteredLines.filter((line) => line.line_status === "cancelled").length;
  const reverted = filteredEvents
    .filter((event) => event.category === "revert")
    .reduce((sum, event) => sum + Number(event.payload?.reverted_lines || event.order_line_ids?.length || 1), 0);

  $("summary-shipped-orders").textContent = String(shippedOrderIds.size);
  $("summary-shipped-lines").textContent = String(shippedLines.length);
  $("summary-gross").textContent = formatMoney(gross);
  $("summary-payout").textContent = formatMoney(payout);
  $("summary-admin-closeouts").textContent = String(closeouts);
  $("summary-cancelled").textContent = String(cancelled);
  $("summary-reversals").textContent = String(reverted);
}

function getEventLineIds(event) {
  return Array.isArray(event?.order_line_ids) ? event.order_line_ids.filter(Boolean) : [];
}

function getLineByIdMap(lines = state.lines) {
  return new Map(lines.map((line) => [line.id, line]));
}

function getBuyerKeyFromLine(line) {
  return String(line?.order?.buyer_username || line?.order?.order_number || line?.order_id || line?.id || "unknown")
    .trim()
    .toLowerCase();
}

function getBuyerLabelFromLine(line) {
  return String(line?.order?.buyer_username || "").trim() || "No buyer username";
}

function getEventBuyerLabel(event, lines = []) {
  const snapshots = Array.isArray(event?.payload?.line_snapshots) ? event.payload.line_snapshots : [];
  return snapshots.find((snapshot) => snapshot?.buyer_username)?.buyer_username
    || lines.find((line) => line?.order?.buyer_username)?.order?.buyer_username
    || "No buyer username";
}

function getEventOrderNumbers(event, lines = []) {
  const values = new Set();
  const snapshots = Array.isArray(event?.payload?.line_snapshots) ? event.payload.line_snapshots : [];
  snapshots.forEach((snapshot) => {
    if (snapshot?.order_number) values.add(snapshot.order_number);
  });
  lines.forEach((line) => {
    if (line?.order?.order_number) values.add(line.order.order_number);
  });
  return [...values];
}

function getRelatedEventsForLineIds(lineIds = []) {
  const wanted = new Set(lineIds);
  return [
    ...state.relatedAdminEvents.map((event) => ({ ...event, category: "admin" })),
    ...state.relatedRevertEvents.map((event) => ({ ...event, category: "revert", action: "reverted" })),
    ...state.adminEvents.map((event) => ({ ...event, category: "admin" })),
    ...state.revertEvents.map((event) => ({ ...event, category: "revert", action: "reverted" })),
  ]
    .filter((event) => getEventLineIds(event).some((lineId) => wanted.has(lineId)))
    .filter((event, index, array) => array.findIndex((entry) => entry.id === event.id && entry.category === event.category) === index)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getEventLabel(event) {
  if (event.category === "revert") return "Reverted";
  if (event.action === "fulfilled_no_inventory") return "No-inventory completion";
  if (event.action === "cancelled") return "Canceled";
  return event.action || "Event";
}

function getHistoryGroupStatus(group) {
  if (group.events.some((event) => event.category === "revert")) return "Has reversal";
  if (group.lines.some((line) => line.line_status === "cancelled")) return "Canceled";
  if (group.events.some((event) => event.action === "fulfilled_no_inventory") || group.lines.some(isAdminCloseoutLine)) {
    return "No-inventory completion";
  }
  return "Shipped";
}

function getHistoryGroupStatusClass(group) {
  const label = getHistoryGroupStatus(group);
  if (label === "Canceled") return "is-cancelled";
  if (label === "No-inventory completion" || label === "Has reversal") return "is-admin";
  return "";
}

function getHistoryGroupEvidencePhotos(group) {
  const seen = new Set();
  return group.events.flatMap(getEventEvidencePhotos).filter((photo) => {
    const key = `${photo.bucket}:${photo.path}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function groupLinesByOrder(lines) {
  const groups = new Map();
  lines.forEach((line) => {
    const order = line.order || {};
    const key = order.id || line.order_id || line.id;
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        order,
        lines: [],
        gross: 0,
        payout: 0,
        latestAt: null,
      });
    }

    const group = groups.get(key);
    group.lines.push(line);
    group.gross += getLineGross(line);
    group.payout += getLinePayout(line);
    const fulfilledAt = line.fulfilled_at ? new Date(line.fulfilled_at) : null;
    if (fulfilledAt && !Number.isNaN(fulfilledAt.getTime())) {
      const current = group.latestAt ? new Date(group.latestAt) : null;
      if (!current || fulfilledAt > current) group.latestAt = line.fulfilled_at;
    }
  });

  return [...groups.values()].sort((a, b) => {
    const aTime = a.latestAt ? new Date(a.latestAt).getTime() : 0;
    const bTime = b.latestAt ? new Date(b.latestAt).getTime() : 0;
    return bTime - aTime;
  });
}

function buildHistoryGroups(lines) {
  const lineById = getLineByIdMap(lines);
  const coveredLineIds = new Set();
  const groups = [];
  const completionEvents = getFilteredEvents()
    .filter((event) => event.category !== "revert" && getEventLineIds(event).some((lineId) => lineById.has(lineId)));

  completionEvents.forEach((event) => {
    const eventLineIds = getEventLineIds(event).filter((lineId) => lineById.has(lineId));
    const eventLines = eventLineIds.map((lineId) => lineById.get(lineId)).filter(Boolean);
    if (!eventLines.length) return;

    eventLineIds.forEach((lineId) => coveredLineIds.add(lineId));
    const relatedEvents = getRelatedEventsForLineIds(eventLineIds);
    const orderNumbers = getEventOrderNumbers(event, eventLines);
    const latestAt = event.created_at || eventLines[0]?.fulfilled_at || null;
    groups.push({
      id: `event-${event.id}`,
      kind: "event",
      buyer: getEventBuyerLabel(event, eventLines),
      subtitle: orderNumbers.length ? `${orderNumbers.length} order(s): ${orderNumbers.join(", ")}` : "Grouped completion",
      lines: eventLines,
      events: relatedEvents,
      gross: eventLines.reduce((sum, line) => sum + getLineGross(line), 0),
      payout: eventLines.reduce((sum, line) => sum + getLinePayout(line), 0),
      latestAt,
    });
  });

  const remainingGroups = new Map();
  lines.filter((line) => !coveredLineIds.has(line.id)).forEach((line) => {
    const key = getBuyerKeyFromLine(line);
    if (!remainingGroups.has(key)) {
      remainingGroups.set(key, {
        id: `buyer-${key}`,
        kind: "buyer",
        buyer: getBuyerLabelFromLine(line),
        subtitle: "Closed order lines",
        lines: [],
        events: [],
        gross: 0,
        payout: 0,
        latestAt: null,
      });
    }
    const group = remainingGroups.get(key);
    group.lines.push(line);
    group.gross += getLineGross(line);
    group.payout += getLinePayout(line);
    const fulfilledAt = line.fulfilled_at ? new Date(line.fulfilled_at) : null;
    if (fulfilledAt && !Number.isNaN(fulfilledAt.getTime())) {
      const current = group.latestAt ? new Date(group.latestAt) : null;
      if (!current || fulfilledAt > current) group.latestAt = line.fulfilled_at;
    }
  });

  remainingGroups.forEach((group) => {
    const lineIds = group.lines.map((line) => line.id);
    group.events = getRelatedEventsForLineIds(lineIds);
    const orderNumbers = [...new Set(group.lines.map((line) => line.order?.order_number).filter(Boolean))];
    group.subtitle = orderNumbers.length ? `${orderNumbers.length} order(s): ${orderNumbers.join(", ")}` : group.subtitle;
    groups.push(group);
  });

  return groups.sort((a, b) => {
    const aTime = a.latestAt ? new Date(a.latestAt).getTime() : 0;
    const bTime = b.latestAt ? new Date(b.latestAt).getTime() : 0;
    return bTime - aTime;
  });
}

function renderHistoryList() {
  const list = $("history-list");
  if (!list) return;

  const groups = buildHistoryGroups(state.filteredLines);
  $("history-count").textContent = `${groups.length} group${groups.length === 1 ? "" : "s"}`;

  if (!groups.length) {
    list.innerHTML = `<div class="history-empty">No closed orders match this view.</div>`;
    return;
  }

  list.innerHTML = "";
  groups.forEach((group, groupIndex) => {
    const workers = [...new Set(group.lines.map((line) => line.fulfilled_by_email).filter(Boolean))];
    const primaryStatus = getHistoryGroupStatus(group);
    const statusClass = getHistoryGroupStatusClass(group);
    const lineIds = group.lines.map((line) => line.id);
    const groupPhotos = getHistoryGroupEvidencePhotos(group);
    const auditEvents = group.events.slice(0, 6);

    const card = document.createElement("article");
    card.className = "history-order-card";
    card.innerHTML = `
      <div class="history-order-top">
        <div>
          <span class="eyebrow">${group.kind === "event" ? "Grouped Completion" : "Buyer Group"}</span>
          <h3>${escapeHtml(group.buyer)}</h3>
          <div class="history-card-meta">
            <span>${group.lines.length} line(s)</span>
            <span>Closed ${escapeHtml(formatDateTime(group.latestAt))}</span>
            <span class="history-status ${statusClass}">${escapeHtml(primaryStatus)}</span>
          </div>
          <div class="history-worker-row">
            <span>${escapeHtml(group.subtitle || "No order details")}</span>
          </div>
          <div class="history-worker-row">
            <span>Completed by: ${escapeHtml(workers.join(", ") || "Unknown")}</span>
          </div>
        </div>
        <div>
          <div class="history-money-row">
            <span>Gross ${escapeHtml(formatMoney(group.gross))}</span>
            <span>Payout ${escapeHtml(formatMoney(group.payout))}</span>
          </div>
          ${isAdminUser() ? `<button type="button" class="secondary-btn revert-order-btn" data-revert-lines="${escapeHtml(lineIds.join(","))}">Revert Order</button>` : ""}
        </div>
      </div>
      ${groupPhotos.length ? `
        <div class="history-evidence-strip">
          <div>
            <span class="eyebrow">Evidence</span>
            <strong>${groupPhotos.length} photo${groupPhotos.length === 1 ? "" : "s"} attached</strong>
          </div>
          <div class="event-photo-grid compact" data-group-evidence-index="${groupIndex}"></div>
        </div>
      ` : ""}
      <div class="history-lines">
        ${group.lines.map((line) => `
          <div class="history-line-row">
            <div>
              <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
              <small>${escapeHtml(line.item_number || "No item #")} - Qty ${Number(line.fulfilled_quantity || line.quantity || 1).toLocaleString()} - ${escapeHtml(line.notes || "No notes")}</small>
              <div class="history-worker-row">
                <span>${escapeHtml(getLineStatusLabel(line))}</span>
                <span>${escapeHtml(line.fulfilled_by_email || "Unknown worker")}</span>
                <span>${escapeHtml(formatDateTime(line.fulfilled_at))}</span>
              </div>
            </div>
            <div class="history-line-actions">
              <span class="history-status ${getLineStatusClass(line)}">${escapeHtml(getLineStatusLabel(line))}</span>
              ${isAdminUser() ? `<button type="button" class="secondary-btn revert-line-btn" data-revert-line="${escapeHtml(line.id)}">Revert Line</button>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
      ${auditEvents.length ? `
        <details class="history-audit-details">
          <summary>${isAdminUser() ? "Audit trail" : "Packing proof"} for this group</summary>
          <div class="history-audit-timeline">
            ${auditEvents.map((event) => `
              <article>
                <strong>${escapeHtml(getEventLabel(event))}</strong>
                <span>${escapeHtml(formatDateTime(event.created_at))} - ${escapeHtml(event.signed_by_email || "Unknown user")}</span>
                <p>${escapeHtml(event.notes || "No note recorded.")}</p>
              </article>
            `).join("")}
          </div>
        </details>
      ` : ""}
    `;

    card.querySelector("[data-revert-lines]")?.addEventListener("click", (event) => {
      const ids = event.currentTarget.dataset.revertLines.split(",").filter(Boolean);
      openRevertModal(ids);
    });
    card.querySelectorAll("[data-revert-line]").forEach((button) => {
      button.addEventListener("click", () => openRevertModal([button.dataset.revertLine].filter(Boolean)));
    });
    list.appendChild(card);
  });
  hydrateHistoryGroupEvidencePhotos(groups).catch((error) => {
    console.warn("Could not load grouped evidence photos:", error);
  });
}

async function hydrateHistoryGroupEvidencePhotos(groups) {
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const photos = getHistoryGroupEvidencePhotos(groups[groupIndex]);
    const container = document.querySelector(`[data-group-evidence-index="${groupIndex}"]`);
    if (!container || !photos.length) continue;

    const signed = await Promise.all(photos.map(async (photo, index) => ({
      ...photo,
      thumbUrl: await signEventEvidencePhoto(photo),
      fullUrl: await signEventEvidencePhoto(photo, { thumbnail: false }),
      label: photo.label || `Evidence photo ${index + 1}`,
    })));
    const visible = signed.filter((photo) => photo.thumbUrl || photo.fullUrl);
    if (!visible.length) continue;

    container.innerHTML = visible.map((photo) => `
      <button class="event-photo-thumb" type="button" data-evidence-photo-url="${escapeHtml(photo.fullUrl || photo.thumbUrl)}" data-evidence-photo-label="${escapeHtml(photo.label)}" data-evidence-photo-meta="${escapeHtml(photo.bucket + "/" + photo.path)}">
        <img src="${escapeHtml(photo.thumbUrl || photo.fullUrl)}" alt="${escapeHtml(photo.label)}" />
        <span>${escapeHtml(photo.label)}</span>
      </button>
    `).join("");

    container.querySelectorAll("[data-evidence-photo-url]").forEach((button) => {
      button.addEventListener("click", () => {
        openEvidencePhotoViewer(
          button.dataset.evidencePhotoUrl,
          button.dataset.evidencePhotoLabel,
          button.dataset.evidencePhotoMeta
        );
      });
    });
  }
}

function getFilteredEvents() {
  const term = String($("history-search")?.value || "").trim().toLowerCase();
  const worker = $("history-worker")?.value || "";
  const status = $("history-status")?.value || "all";
  const events = [
    ...state.adminEvents.map((event) => ({ ...event, category: "admin" })),
    ...state.revertEvents.map((event) => ({ ...event, category: "revert", action: "reverted" })),
  ];

  return events.filter((event) => {
    if (status === "fulfilled" && event.action !== "fulfilled_no_inventory") return false;
    if (status === "cancelled" && event.action !== "cancelled") return false;
    if (status === "admin_closeout" && event.category !== "admin") return false;
    if (status === "reverted" && event.category !== "revert") return false;
    if (worker && event.signed_by_email !== worker) return false;
    if (term) {
      const haystack = [
        event.action,
        event.notes,
        event.signed_by_email,
        ...(event.order_ids || []),
        ...(event.order_line_ids || []),
      ].filter(Boolean).join(" ").toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    return true;
  });
}

function renderEventList() {
  const list = $("event-list");
  if (!list) return;

  const events = getFilteredEvents().sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  if (!events.length) {
    list.innerHTML = `<div class="history-empty">No no-inventory completions, cancellations, or reversal events match this view.</div>`;
    return;
  }

  list.innerHTML = events.map((event, eventIndex) => {
    const label = event.category === "revert"
      ? "Order reverted"
      : event.action === "fulfilled_no_inventory"
        ? "Packed without inventory removal"
        : isAdminUser() ? "Canceled by admin" : "Canceled";
    const units = event.payload?.restored_units ? ` - restored ${Number(event.payload.restored_units).toLocaleString()} unit(s)` : "";
    const gps = getEventGpsLabel(event);
    const store = event.payload?.checkout_store_name || "";
    const evidenceCount = getEventEvidencePhotos(event).length;
    return `
      <article class="event-card">
        <span class="history-status ${event.category === "revert" ? "is-admin" : event.action === "cancelled" ? "is-cancelled" : ""}">${escapeHtml(label)}</span>
        <h3>${escapeHtml(event.signed_by_email || "Unknown user")}</h3>
        <div class="event-meta">
          <span>${escapeHtml(formatDateTime(event.created_at))}</span>
          <span>${Number(event.order_line_ids?.length || event.payload?.reverted_lines || 0).toLocaleString()} line(s)${escapeHtml(units)}</span>
          ${gps ? `<span>${escapeHtml(gps)}</span>` : ""}
          ${store ? `<span>${escapeHtml(store)}</span>` : ""}
          ${evidenceCount ? `<span>${evidenceCount} evidence photo${evidenceCount === 1 ? "" : "s"}</span>` : ""}
        </div>
        <p>${escapeHtml(event.notes || "No note recorded.")}</p>
        ${evidenceCount ? `<div class="event-photo-grid" data-event-evidence-index="${eventIndex}"></div>` : ""}
      </article>
    `;
  }).join("");
  hydrateEventEvidencePhotos(events).catch((error) => {
    console.warn("Could not load event evidence photos:", error);
  });
}

function openModal(id) {
  $(id)?.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  $(id)?.classList.add("hidden");
  document.body.classList.remove("modal-open");
}

function openRevertModal(lineIds) {
  if (!isAdminUser()) return;
  state.selectedRevertLineIds = lineIds;
  const lines = state.lines.filter((line) => lineIds.includes(line.id));
  const list = $("revert-order-list");
  if (list) {
    list.innerHTML = lines.map((line) => `
      <article>
        <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
        <span>${escapeHtml(line.order?.order_number || "No order")} - ${escapeHtml(getLineStatusLabel(line))} - Qty ${Number(line.fulfilled_quantity || line.quantity || 1).toLocaleString()}</span>
      </article>
    `).join("");
  }
  $("revert-note").value = "";
  $("revert-password").value = "";
  $("revert-error").textContent = "";
  openModal("revert-order-modal");
  setTimeout(() => $("revert-note")?.focus(), 80);
}

function closeRevertModal() {
  state.selectedRevertLineIds = [];
  closeModal("revert-order-modal");
}

async function verifyAdminPassword(password) {
  if (!state.user?.email || !password) return false;
  const { error } = await supabase.auth.signInWithPassword({
    email: state.user.email,
    password,
  });
  return !error;
}

async function confirmRevert() {
  if (state.busy || !isAdminUser()) return;
  const note = String($("revert-note")?.value || "").trim();
  const password = String($("revert-password")?.value || "").trim();
  const errorEl = $("revert-error");

  if (!state.selectedRevertLineIds.length) {
    if (errorEl) errorEl.textContent = "No order lines were selected.";
    return;
  }
  if (!note) {
    if (errorEl) errorEl.textContent = "A reversal note is required.";
    $("revert-note")?.focus();
    return;
  }
  if (!password) {
    if (errorEl) errorEl.textContent = "Admin password is required.";
    $("revert-password")?.focus();
    return;
  }

  try {
    state.busy = true;
    $("confirm-revert").disabled = true;
    if (errorEl) errorEl.textContent = "";

    const valid = await verifyAdminPassword(password);
    if (!valid) throw new Error("Incorrect password. Please try again.");

    const { error } = await supabase.rpc("admin_revert_ebay_order_lines", {
      _order_line_ids: state.selectedRevertLineIds,
      _notes: note,
      _signed_by_email: state.user.email,
    });
    if (error) throw error;

    closeRevertModal();
    await loadOrderHistory();
  } catch (error) {
    console.error("Could not revert eBay order:", error);
    if (errorEl) errorEl.textContent = error.message || "Could not revert this order.";
  } finally {
    state.busy = false;
    $("confirm-revert").disabled = false;
  }
}

function setupListeners() {
  $("refresh-history")?.addEventListener("click", loadOrderHistory);
  $("open-proof-trail")?.addEventListener("click", openProofTrailModal);
  $("close-proof-trail-modal")?.addEventListener("click", closeProofTrailModal);
  $("proof-trail-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "proof-trail-modal") closeProofTrailModal();
  });
  ["history-from", "history-to"].forEach((id) => {
    $(id)?.addEventListener("change", loadOrderHistory);
  });
  ["history-worker", "history-status", "history-search"].forEach((id) => {
    $(id)?.addEventListener("input", applyFilters);
    $(id)?.addEventListener("change", applyFilters);
  });

  $("close-revert-modal")?.addEventListener("click", closeRevertModal);
  $("cancel-revert")?.addEventListener("click", closeRevertModal);
  $("confirm-revert")?.addEventListener("click", confirmRevert);
  $("revert-order-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "revert-order-modal") closeRevertModal();
  });
  $("evidence-photo-viewer-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "evidence-photo-viewer-modal") closeEvidencePhotoViewer();
  });
  $("close-evidence-photo-viewer")?.addEventListener("click", closeEvidencePhotoViewer);
  $("dismiss-evidence-photo-viewer")?.addEventListener("click", closeEvidencePhotoViewer);
  $("revert-password")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmRevert();
    }
  });
  document.addEventListener("keydown", (event) => {
    if (!$("evidence-photo-viewer-modal")?.classList.contains("hidden")) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        closeEvidencePhotoViewer();
      }
      return;
    }
    if (!$("proof-trail-modal")?.classList.contains("hidden")) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeProofTrailModal();
      }
      return;
    }
    if (!$("revert-order-modal")?.classList.contains("hidden")) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeRevertModal();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        confirmRevert();
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseReady();
  const ok = await checkHistoryAuth();
  if (!ok) return;
  setupDashboardShell();
  setupDefaultDates();
  setupListeners();
  await loadOrderHistory();
  if (window.lucide) window.lucide.createIcons();
});
