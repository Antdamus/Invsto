const state = {
  user: null,
  employee: null,
  lines: [],
  adminEvents: [],
  revertEvents: [],
  labelEvents: [],
  relatedAdminEvents: [],
  relatedRevertEvents: [],
  relatedLabelEvents: [],
  filteredLines: [],
  adminCloseoutLineIds: new Set(),
  selectedRevertLineIds: [],
  awaitingLabelGroup: null,
  queuedHistoryLabelTransfers: [],
  pendingHistoryLabelReplacement: null,
  historyLoaded: false,
  labelPreviewUrls: new Map(),
  handledLabelTransferIds: new Set(),
  labelBusy: false,
  busy: false,
};

let evidencePhotoViewerReturnFocus = null;
const EBAY_LABEL_BUCKET = "ebay-labels";

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

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
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
  const today = toDateInputValue(todayDate);
  if ($("history-from") && !$("history-from").value) $("history-from").value = today;
  if ($("history-to") && !$("history-to").value) $("history-to").value = today;
  resetHistorySearchInput({ apply: false });
}

function resetHistorySearchInput(options = {}) {
  const search = $("history-search");
  if (!search) return;
  search.value = "";
  search.defaultValue = "";
  search.setAttribute("autocomplete", "new-password");
  search.setAttribute("autocorrect", "off");
  search.setAttribute("autocapitalize", "off");
  search.setAttribute("spellcheck", "false");
  search.setAttribute("data-form-type", "other");
  search.name = `og-history-search-disabled-${Date.now()}`;
  if (options.apply !== false && state.historyLoaded) applyFilters();
}

function preventHistorySearchAutofill() {
  resetHistorySearchInput({ apply: false });
  window.setTimeout(() => resetHistorySearchInput({ apply: true }), 100);
  window.setTimeout(() => resetHistorySearchInput({ apply: true }), 650);
}

async function loadOrderHistory() {
  state.historyLoaded = false;
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
        net_payout,
        ebay_shipment_id,
        label_status,
        label_storage_bucket,
        label_file_path,
        label_uploaded_at,
        label_metadata
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
  const labelEventsQuery = supabase
    .from("ebay_order_label_events")
    .select("*")
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(300);

  const [linesResult, adminEventsResult, revertEventsResult, labelEventsResult] = await Promise.all([
    linesQuery,
    adminEventsQuery,
    revertEventsQuery,
    labelEventsQuery,
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

  if (labelEventsResult.error) {
    console.warn("Failed to load eBay label audit events. Push the latest label audit migration if this is new:", labelEventsResult.error);
  }

  const closedLines = (linesResult.data || []).map(normalizeLine);
  const closedLineIds = closedLines.map((line) => line.id).filter(Boolean);
  let relatedAdminEvents = [];
  let relatedRevertEvents = [];
  let relatedLabelEvents = [];

  if (closedLineIds.length) {
    const [relatedAdminResult, relatedRevertResult, relatedLabelResult] = await Promise.all([
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
      supabase
        .from("ebay_order_label_events")
        .select("*")
        .overlaps("order_line_ids", closedLineIds)
        .limit(500),
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

    if (relatedLabelResult.error) {
      console.warn("Failed to load related label events for visible order lines:", relatedLabelResult.error);
    } else {
      relatedLabelEvents = relatedLabelResult.data || [];
    }
  }

  state.adminEvents = adminEventsResult.data || [];
  state.revertEvents = revertEventsResult.data || [];
  state.labelEvents = labelEventsResult.error ? [] : labelEventsResult.data || [];
  state.relatedAdminEvents = relatedAdminEvents;
  state.relatedRevertEvents = relatedRevertEvents;
  state.relatedLabelEvents = relatedLabelEvents;
  state.adminCloseoutLineIds = new Set(
    [...state.adminEvents, ...state.relatedAdminEvents]
      .filter((event) => event.action === "fulfilled_no_inventory")
      .flatMap((event) => Array.isArray(event.order_line_ids) ? event.order_line_ids : [])
  );
  state.lines = closedLines;
  state.historyLoaded = true;
  renderWorkerOptions();
  applyFilters();
  applyHistoryLabelLaunchSelection();
  drainQueuedHistoryLabelTransfers();
}

function renderWorkerOptions() {
  const select = $("history-worker");
  if (!select) return;
  const current = select.value;
  const workers = new Set();

  state.lines.forEach((line) => {
    if (line.fulfilled_by_email) workers.add(line.fulfilled_by_email);
  });

  select.innerHTML = `<option value="">All users</option>${[...workers].sort().map((email) => (
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
    ...state.relatedLabelEvents.map((event) => ({ ...event, category: "label" })),
    ...state.adminEvents.map((event) => ({ ...event, category: "admin" })),
    ...state.revertEvents.map((event) => ({ ...event, category: "revert", action: "reverted" })),
    ...state.labelEvents.map((event) => ({ ...event, category: "label" })),
  ]
    .filter((event) => getEventLineIds(event).some((lineId) => wanted.has(lineId)))
    .filter((event, index, array) => array.findIndex((entry) => entry.id === event.id && entry.category === event.category) === index)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getEventLabel(event) {
  if (event.category === "revert") return "Reverted";
  if (event.category === "label") return event.action === "replaced" ? "Shipping label replaced" : "Shipping label attached";
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
    .filter((event) =>
      event.category === "admin"
      && getEventLineIds(event).some((lineId) => lineById.has(lineId))
    );

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

function getUniqueOrdersFromLines(lines = []) {
  const orders = new Map();
  lines.forEach((line) => {
    const order = line.order || {};
    const key = order.id || order.order_number || line.order_id;
    if (!key || orders.has(key)) return;
    orders.set(key, order);
  });
  return [...orders.values()];
}

function getOrderNumbersFromOrders(orders = []) {
  return [...new Set(orders
    .map((order) => normalizeEbayOrderNumber(order?.order_number))
    .filter(Boolean))];
}

function getAttachedHistoryOrder(orders = []) {
  return orders.find((order) => order?.label_file_path) || null;
}

function historyGroupHasAttachedLabel(group) {
  return getUniqueOrdersFromLines(group?.lines || []).some((order) => order?.label_file_path);
}

function getHistoryGroupCompletedBy(group) {
  return [...new Set((group?.lines || []).map((line) => line.fulfilled_by_email).filter(Boolean))]
    .join(", ") || "Unknown";
}

function compareText(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
}

function getVisibleHistoryGroups() {
  const labelFilter = $("history-label-filter")?.value || "all";
  const sort = $("history-sort")?.value || "date_desc";
  const groups = buildHistoryGroups(state.filteredLines)
    .filter((group) => {
      const hasLabel = historyGroupHasAttachedLabel(group);
      if (labelFilter === "missing") return !hasLabel;
      if (labelFilter === "attached") return hasLabel;
      return true;
    });

  const dateValue = (group) => group.latestAt ? new Date(group.latestAt).getTime() || 0 : 0;
  const labelValue = (group) => historyGroupHasAttachedLabel(group) ? 1 : 0;

  groups.sort((a, b) => {
    if (sort === "date_asc") return dateValue(a) - dateValue(b);
    if (sort === "amount_desc") return Number(b.gross || 0) - Number(a.gross || 0);
    if (sort === "amount_asc") return Number(a.gross || 0) - Number(b.gross || 0);
    if (sort === "buyer_asc") return compareText(a.buyer, b.buyer);
    if (sort === "buyer_desc") return compareText(b.buyer, a.buyer);
    if (sort === "worker_asc") return compareText(getHistoryGroupCompletedBy(a), getHistoryGroupCompletedBy(b));
    if (sort === "label_missing") return labelValue(a) - labelValue(b) || dateValue(b) - dateValue(a);
    if (sort === "label_attached") return labelValue(b) - labelValue(a) || dateValue(b) - dateValue(a);
    return dateValue(b) - dateValue(a);
  });

  return groups;
}

function renderGroupLabelControl(group, orders = []) {
  if (!orders.length) return "";
  const orderNumbers = getOrderNumbersFromOrders(orders);
  const attachedOrder = getAttachedHistoryOrder(orders);
  const labelPath = attachedOrder?.label_file_path || "";
  const orderCount = orderNumbers.length || orders.length;
  const orderWord = orderCount === 1 ? "order" : "orders";
  const attachedCount = orders.filter((order) => order?.label_file_path).length;
  const labelSummary = labelPath
    ? `Attached ${formatDateTime(attachedOrder.label_uploaded_at)} - ${attachedCount >= orderCount ? `covers ${orderCount} ${orderWord}` : `${attachedCount} of ${orderCount} ${orderWord}`}`
    : `One label for this grouped completion - ${orderCount} ${orderWord}`;
  const encodedOrderNumbers = escapeHtml(orderNumbers.join(","));

  return `
    <div class="history-order-label-strip">
      <div class="history-order-label-control">
        <div>
          <span class="eyebrow">Shipping Label</span>
          <strong>${escapeHtml(group.buyer || "Grouped completion")}</strong>
          <small>${escapeHtml(labelSummary)}</small>
        </div>
        <div>
          ${labelPath ? `<button type="button" class="secondary-btn history-label-open-btn" data-history-label-open-group="${encodedOrderNumbers}">Open Label</button>` : ""}
          <button type="button" class="secondary-btn history-label-btn" data-history-label-group="${encodedOrderNumbers}">${labelPath ? "Replace Label" : "Add Label"}</button>
        </div>
      </div>
    </div>
  `;
}

function renderHistoryList() {
  const list = $("history-list");
  if (!list) return;

  const groups = getVisibleHistoryGroups();
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
    const groupOrders = getUniqueOrdersFromLines(group.lines);
    const hasAttachedLabel = groupOrders.some((order) => order.label_file_path);

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
          ${hasAttachedLabel ? `<span class="history-label-pill">Label attached</span>` : ""}
        </div>
        <div>
          <div class="history-money-row">
            <span>Gross ${escapeHtml(formatMoney(group.gross))}</span>
            <span>Payout ${escapeHtml(formatMoney(group.payout))}</span>
          </div>
          ${isAdminUser() ? `<button type="button" class="secondary-btn revert-order-btn" data-revert-lines="${escapeHtml(lineIds.join(","))}">Revert Order</button>` : ""}
        </div>
      </div>
      ${renderGroupLabelControl(group, groupOrders)}
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
    card.querySelectorAll("[data-history-label-group]").forEach((button) => {
      button.addEventListener("click", () => handleHistoryLabelButtonClick(button.dataset.historyLabelGroup));
    });
    card.querySelectorAll("[data-history-label-open-group]").forEach((button) => {
      button.addEventListener("click", () => handleOpenHistoryLabelButtonClick(button.dataset.historyLabelOpenGroup));
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
  const lineById = getLineByIdMap(state.lines);
  const events = [
    ...state.adminEvents.map((event) => ({ ...event, category: "admin" })),
    ...state.revertEvents.map((event) => ({ ...event, category: "revert", action: "reverted" })),
    ...state.labelEvents.map((event) => ({ ...event, category: "label" })),
  ];

  return events.filter((event) => {
    if (status === "fulfilled" && event.action !== "fulfilled_no_inventory") return false;
    if (status === "cancelled" && event.action !== "cancelled") return false;
    if (status === "admin_closeout" && event.category !== "admin") return false;
    if (status === "reverted" && event.category !== "revert") return false;

    const eventLines = getEventLineIds(event).map((lineId) => lineById.get(lineId)).filter(Boolean);
    if (worker) {
      const completedByWorker = eventLines.some((line) => line.fulfilled_by_email === worker);
      if (!completedByWorker && event.signed_by_email !== worker) return false;
    }

    if (term) {
      const snapshots = Array.isArray(event.payload?.line_snapshots) ? event.payload.line_snapshots : [];
      const haystack = [
        event.action,
        event.notes,
        event.signed_by_email,
        event.label_file_path,
        event.shipment_id,
        getEventBuyerLabel(event, eventLines),
        ...eventLines.flatMap((line) => [
          line.searchText,
          line.order?.buyer_username,
          line.order?.order_number,
          line.order?.sales_record_number,
          line.item_title,
          line.item_number,
          line.transaction_id,
          line.fulfilled_by_email,
        ]),
        ...snapshots.flatMap((snapshot) => [
          snapshot.buyer_username,
          snapshot.order_number,
          snapshot.item_title,
          snapshot.item_number,
          snapshot.transaction_id,
        ]),
        ...(event.order_numbers || []),
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
    list.innerHTML = `<div class="history-empty">No label, no-inventory, cancellation, or reversal events match this view.</div>`;
    return;
  }

  list.innerHTML = events.map((event, eventIndex) => {
    const label = event.category === "revert"
      ? "Order reverted"
      : event.category === "label"
        ? event.action === "replaced" ? "Shipping label replaced" : "Shipping label attached"
        : event.action === "fulfilled_no_inventory"
          ? "Packed without inventory removal"
          : isAdminUser() ? "Canceled by admin" : "Canceled";
    const units = event.payload?.restored_units ? ` - restored ${Number(event.payload.restored_units).toLocaleString()} unit(s)` : "";
    const gps = getEventGpsLabel(event);
    const store = event.payload?.checkout_store_name || "";
    const evidenceCount = getEventEvidencePhotos(event).length;
    const eventStatusClass = event.category === "revert" || event.category === "label"
      ? "is-admin"
      : event.action === "cancelled" ? "is-cancelled" : "";
    const eventDetail = event.notes || event.label_file_path || "No note recorded.";
    return `
      <article class="event-card">
        <span class="history-status ${eventStatusClass}">${escapeHtml(label)}</span>
        <h3>${escapeHtml(event.signed_by_email || "Unknown user")}</h3>
        <div class="event-meta">
          <span>${escapeHtml(formatDateTime(event.created_at))}</span>
          <span>${Number(event.order_line_ids?.length || event.payload?.reverted_lines || event.order_numbers?.length || 0).toLocaleString()} line(s)${escapeHtml(units)}</span>
          ${gps ? `<span>${escapeHtml(gps)}</span>` : ""}
          ${store ? `<span>${escapeHtml(store)}</span>` : ""}
          ${evidenceCount ? `<span>${evidenceCount} evidence photo${evidenceCount === 1 ? "" : "s"}</span>` : ""}
        </div>
        <p>${escapeHtml(eventDetail)}</p>
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

function normalizeEbayOrderNumber(value) {
  const match = String(value || "").match(/\b\d{2}-\d{5}-\d{5}\b/);
  return match ? match[0] : "";
}

function base64ToBlob(base64, mimeType = "application/pdf") {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType || "application/pdf" });
}

function safeStorageSegment(value, fallback = "value") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return cleaned || fallback;
}

function parseHistoryOrderNumbers(value) {
  const values = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(values
    .map((entry) => normalizeEbayOrderNumber(entry))
    .filter(Boolean))];
}

function getHistoryOrdersByNumbers(orderNumbers) {
  const wanted = new Set(parseHistoryOrderNumbers(orderNumbers));
  const orders = new Map();
  state.lines.forEach((line) => {
    const order = line.order || {};
    const orderNumber = normalizeEbayOrderNumber(order.order_number);
    if (!wanted.has(orderNumber)) return;
    const key = order.id || orderNumber;
    if (!orders.has(key)) orders.set(key, order);
  });
  return [...orders.values()];
}

function getHistoryLinesByOrderNumbers(orderNumbers) {
  const wanted = new Set(parseHistoryOrderNumbers(orderNumbers));
  return state.lines.filter((line) => wanted.has(normalizeEbayOrderNumber(line.order?.order_number)));
}

function getHistoryLabelTarget(orderNumbers) {
  const normalized = parseHistoryOrderNumbers(orderNumbers);
  const orders = getHistoryOrdersByNumbers(normalized);
  if (!orders.length) return null;
  const targetOrderNumbers = normalized.length ? normalized : getOrderNumbersFromOrders(orders);
  return {
    orderNumbers: targetOrderNumbers,
    orders,
    primaryOrder: getAttachedHistoryOrder(orders) || orders[0],
  };
}

function getAwaitingHistoryLabelOrder(target = state.awaitingLabelGroup) {
  if (!target) return null;
  return getAttachedHistoryOrder(target.orders || []) || target.primaryOrder || target.orders?.[0] || null;
}

function setHistoryLabelStatus(message = "", type = "info") {
  const status = $("history-label-status");
  if (!status) return;
  status.textContent = message || "Waiting for an eBay label transfer...";
  status.classList.toggle("is-error", type === "error");
  status.classList.toggle("is-success", type === "success");
}

function setHistoryReplaceButtonVisible(visible) {
  const button = $("replace-history-label");
  if (!button) return;
  button.classList.toggle("hidden", !visible);
  button.toggleAttribute("disabled", !visible);
}

function renderHistoryLabelDetails(target = state.awaitingLabelGroup) {
  const details = $("history-label-details");
  const preview = $("preview-history-label");
  if (!details) return;
  const order = getAwaitingHistoryLabelOrder(target);
  const metadata = order?.label_metadata || {};
  const size = formatFileSize(metadata.size);
  const labelPath = order?.label_file_path || "";
  const orderNumbers = target?.orderNumbers?.length ? target.orderNumbers : parseHistoryOrderNumbers(order?.order_number);
  const orderCount = orderNumbers.length || 1;
  const orderWord = orderCount === 1 ? "order" : "orders";
  preview?.classList.toggle("hidden", !labelPath);
  preview?.toggleAttribute("disabled", !labelPath);
  details.innerHTML = labelPath
    ? `
      <span><strong>Orders:</strong> ${escapeHtml(orderNumbers.join(", ") || order?.order_number || "-")}</span>
      <span><strong>Label:</strong> Attached ${escapeHtml(formatDateTime(order.label_uploaded_at))} - covers ${orderCount} ${orderWord}${size ? ` - ${escapeHtml(size)}` : ""}</span>
      <span><strong>Shipment:</strong> ${escapeHtml(metadata.shipmentId || order.ebay_shipment_id || "-")}</span>
      <span><strong>Carrier:</strong> ${escapeHtml(metadata.carrier || "-")}</span>
      <span><strong>Service:</strong> ${escapeHtml(metadata.service || "-")}</span>
    `
    : `
      <span><strong>Orders:</strong> ${escapeHtml(orderNumbers.join(", ") || "-")}</span>
      <span>Waiting for one eBay label PDF for this grouped completion.</span>
    `;
}

function openHistoryLabelModal(orderNumbers) {
  const target = getHistoryLabelTarget(orderNumbers);
  if (!target?.orders?.length) {
    window.alert("Could not find those orders in the current history view.");
    return;
  }

  state.awaitingLabelGroup = target;
  state.pendingHistoryLabelReplacement = null;
  setHistoryReplaceButtonVisible(false);
  if ($("done-history-label")) $("done-history-label").textContent = "Done";
  const attachedOrder = getAttachedHistoryOrder(target.orders);
  const orderCount = target.orderNumbers.length || target.orders.length;
  const orderWord = orderCount === 1 ? "order" : "orders";
  $("history-label-title").textContent = attachedOrder?.label_file_path ? "Shipping label" : "Add shipping label";
  $("history-label-subtitle").textContent = `Receiver armed for this grouped completion (${orderCount} ${orderWord}). Open the matching eBay label-ready page and click Send Label to OG.`;
  setHistoryLabelStatus(attachedOrder?.label_file_path ? "A shipping label is already attached to this group. You can replace it by sending a new label from eBay." : "Waiting for an eBay label transfer...");
  renderHistoryLabelDetails(target);
  openModal("history-label-modal");
  setTimeout(() => $("close-history-label-modal")?.focus(), 80);
}

function getRequestedHistoryLabelOrderNumbers() {
  const params = new URLSearchParams(window.location.search);
  return parseHistoryOrderNumbers([
    params.get("orderId"),
    params.get("order"),
    params.get("ebayOrder"),
    ...(params.get("orderIds") || "").split(","),
  ]);
}

function getLabelTransferOrderNumbers(payload = {}) {
  const metadata = payload.metadata || {};
  return parseHistoryOrderNumbers([
    metadata.orderId,
    ...(Array.isArray(metadata.orderIds) ? metadata.orderIds : []),
    ...(Array.isArray(metadata.orderNumbers) ? metadata.orderNumbers : []),
  ]);
}

function getHistoryGroupOrderNumbersForOrder(orderNumber) {
  const normalized = normalizeEbayOrderNumber(orderNumber);
  if (!normalized) return [];
  const groups = buildHistoryGroups(state.lines);
  const group = groups.find((entry) =>
    entry.lines.some((line) => normalizeEbayOrderNumber(line.order?.order_number) === normalized)
  );
  if (!group) return [];
  return getOrderNumbersFromOrders(getUniqueOrdersFromLines(group.lines));
}

function openHistoryLabelReceiverForOrders(orderNumbers) {
  const normalized = parseHistoryOrderNumbers(orderNumbers);
  if (!normalized.length) return false;
  const groupOrderNumbers = normalized.flatMap(getHistoryGroupOrderNumbersForOrder);
  const targetNumbers = groupOrderNumbers.length ? [...new Set(groupOrderNumbers)] : normalized;
  const target = getHistoryLabelTarget(targetNumbers);
  if (!target?.orders?.length) return false;
  openHistoryLabelModal(target.orderNumbers);
  return true;
}

function applyHistoryLabelLaunchSelection() {
  const params = new URLSearchParams(window.location.search);
  if (!params.get("labelTransferId")) return;
  const orderNumbers = getRequestedHistoryLabelOrderNumbers();
  if (!orderNumbers.length) return;
  openHistoryLabelReceiverForOrders(orderNumbers);
}

async function getHistoryLabelSignedUrl(order) {
  const bucket = order?.label_storage_bucket || EBAY_LABEL_BUCKET;
  const path = order?.label_file_path || "";
  if (!path) throw new Error("No shipping label is attached yet.");
  const key = `${bucket}/${path}`;
  if (state.labelPreviewUrls.has(key)) return state.labelPreviewUrls.get(key);

  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (error) throw new Error(error.message || "Could not create a label preview link.");
  const url = data?.signedUrl || "";
  if (!url) throw new Error("Could not create a label preview link.");
  state.labelPreviewUrls.set(key, url);
  return url;
}

async function getHistoryLabelPdfObjectUrl(order) {
  const signedUrl = await getHistoryLabelSignedUrl(order);
  const response = await fetch(signedUrl, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not read the label PDF (${response.status}).`);
  const blob = await response.blob();
  const pdfBlob = blob.type === "application/pdf"
    ? blob
    : new Blob([await blob.arrayBuffer()], { type: "application/pdf" });
  return URL.createObjectURL(pdfBlob);
}

function writeHistoryLabelPreviewWindow(previewWindow, objectUrl, title = "Shipping label") {
  if (!previewWindow || previewWindow.closed) {
    window.open(objectUrl, "_blank", "noopener,noreferrer");
    return;
  }

  const safeTitle = escapeHtml(title || "Shipping label");
  previewWindow.document.open();
  previewWindow.document.write(`<!doctype html>
    <html>
      <head>
        <title>${safeTitle}</title>
        <style>
          html, body { margin: 0; height: 100%; background: #111; }
          iframe { border: 0; width: 100%; height: 100%; display: block; }
        </style>
      </head>
      <body>
        <iframe src="${objectUrl}" title="${safeTitle}"></iframe>
      </body>
    </html>`);
  previewWindow.document.close();
}

async function openHistoryLabelWindow(order, targetWindow = null) {
  let previewWindow = targetWindow;
  try {
    if (!previewWindow || previewWindow.closed) {
      previewWindow = window.open("about:blank", "_blank");
    }
    if (previewWindow) previewWindow.opener = null;
    if (previewWindow && !previewWindow.closed) {
      previewWindow.document.body.innerHTML = "<p style=\"font: 16px sans-serif; padding: 24px;\">Loading shipping label...</p>";
    }
    const objectUrl = await getHistoryLabelPdfObjectUrl(order);
    writeHistoryLabelPreviewWindow(previewWindow, objectUrl, `Shipping label ${order?.order_number || ""}`.trim());
  } catch (error) {
    if (previewWindow && !previewWindow.closed) previewWindow.close();
    throw error;
  }
}

function handleHistoryLabelButtonClick(orderNumber) {
  openHistoryLabelModal(orderNumber);
}

function handleOpenHistoryLabelButtonClick(orderNumber) {
  const target = getHistoryLabelTarget(orderNumber);
  const order = getAttachedHistoryOrder(target?.orders || []);
  if (!order?.id) {
    window.alert("No shipping label is attached to this grouped completion yet.");
    return;
  }
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow) previewWindow.opener = null;
  openHistoryLabelWindow(order, previewWindow).catch((error) => {
    window.alert(error.message || "Could not open the shipping label.");
  });
}

function closeHistoryLabelModal() {
  cancelPendingHistoryLabelReplacement();
  state.awaitingLabelGroup = null;
  setHistoryReplaceButtonVisible(false);
  if ($("done-history-label")) $("done-history-label").textContent = "Done";
  closeModal("history-label-modal");
}

function postHistoryLabelTransferStatus(payload = {}) {
  window.postMessage({
    type: "OG_EBAY_LABEL_TRANSFER_STATUS",
    payload,
  }, window.location.origin);
}

function clearExtensionPendingHistoryLabel(transferId) {
  if (!transferId || !window.chrome?.runtime?.sendMessage) return;
  chrome.runtime.sendMessage({
    type: "OG_EBAY_CLEAR_PENDING_LABEL",
    transferId,
  }).catch(() => null);
}

function cancelPendingHistoryLabelReplacement() {
  const pending = state.pendingHistoryLabelReplacement;
  if (!pending) return;
  const transferId = pending.transferId || "";
  postHistoryLabelTransferStatus({
    transferId,
    ok: false,
    error: "The existing shipping label was kept. Replacement was canceled in OG.",
  });
  clearExtensionPendingHistoryLabel(transferId);
  state.pendingHistoryLabelReplacement = null;
}

function promptHistoryLabelReplacement(transferPayload) {
  state.pendingHistoryLabelReplacement = transferPayload;
  const transferId = transferPayload?.transferId || "";
  const attachedOrder = getAttachedHistoryOrder(state.awaitingLabelGroup?.orders || []);
  $("history-label-title").textContent = "Shipping label already attached";
  $("history-label-subtitle").textContent = "This completed order group already has a shipping label. Preview the existing label, replace it with the new eBay label, or exit without changing it.";
  setHistoryLabelStatus("Existing label found. Click Replace Label to overwrite it with the new captured label.", "error");
  setHistoryReplaceButtonVisible(true);
  if ($("done-history-label")) $("done-history-label").textContent = "Exit";
  renderHistoryLabelDetails(state.awaitingLabelGroup);
  openModal("history-label-modal");
  postHistoryLabelTransferStatus({
    transferId,
    phase: "started",
    message: `Order ${attachedOrder?.order_number || "group"} already has a label. Waiting for replace confirmation in OG.`,
  });
}

async function attachHistoryLabelToOrder(transferPayload) {
  const awaiting = state.awaitingLabelGroup;
  if (!awaiting?.orders?.length) {
    throw new Error("Open a history group's Add Label modal before sending the eBay label.");
  }

  const metadata = transferPayload?.metadata || {};
  const label = transferPayload?.label || {};
  const labelOrderNumbers = getLabelTransferOrderNumbers(transferPayload);
  if (!labelOrderNumbers.length) throw new Error("The label transfer did not include a usable eBay order number.");
  const unexpectedOrderNumbers = labelOrderNumbers.filter((orderNumber) => !awaiting.orderNumbers.includes(orderNumber));
  if (unexpectedOrderNumbers.length) {
    throw new Error(`This eBay label is for ${labelOrderNumbers.join(", ")}, but this grouped history receiver is waiting for: ${awaiting.orderNumbers.join(", ")}.`);
  }
  if (!label.base64) throw new Error("The extension did not send a readable PDF payload.");

  const blob = base64ToBlob(label.base64, label.mimeType || "application/pdf");
  const shipmentSegment = safeStorageSegment(metadata.shipmentId || transferPayload.transferId || crypto.randomUUID(), "shipment");
  const destinationPath = awaiting.orderNumbers.length > 1
    ? [
      "bulk-labels",
      `${safeStorageSegment(metadata.labelId || metadata.shipmentId || transferPayload.transferId || crypto.randomUUID(), "bulk-label")}.pdf`,
    ].join("/")
    : [
      safeStorageSegment(awaiting.orderNumbers[0], "order"),
      `${shipmentSegment}.pdf`,
    ].join("/");

  const { error: uploadError } = await supabase.storage
    .from(EBAY_LABEL_BUCKET)
    .upload(destinationPath, blob, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) throw new Error(uploadError.message || "Could not upload the eBay label PDF.");

  const now = new Date().toISOString();
  const labelMetadata = {
    ...metadata,
    coveredOrderNumbers: awaiting.orderNumbers,
    transferId: transferPayload.transferId || null,
    captureSource: label.source || null,
    labelUrl: label.url || null,
    mimeType: label.mimeType || "application/pdf",
    size: label.size || blob.size,
    capturedAt: label.capturedAt || metadata.capturedAt || new Date().toISOString(),
  };
  const orderIds = [...new Set(awaiting.orders.map((order) => order.id).filter(Boolean))];
  const historyLabelLines = getHistoryLinesByOrderNumbers(awaiting.orderNumbers);

  const { error: orderError } = await supabase.rpc("attach_ebay_shipping_label", {
    _order_ids: orderIds,
    _order_line_ids: historyLabelLines.map((line) => line.id).filter(Boolean),
    _order_numbers: awaiting.orderNumbers,
    _shipment_id: metadata.shipmentId || null,
    _label_storage_bucket: EBAY_LABEL_BUCKET,
    _label_file_path: destinationPath,
    _label_metadata: labelMetadata,
    _signed_by_email: state.user?.email || null,
  });
  if (orderError) throw new Error(orderError.message || "Could not update and audit the eBay order label status.");

  const updatedOrderFields = {
    ebay_shipment_id: metadata.shipmentId || null,
    label_status: "label_uploaded",
    label_storage_bucket: EBAY_LABEL_BUCKET,
    label_file_path: destinationPath,
    label_uploaded_at: now,
    label_uploaded_by: state.user?.id || null,
    label_metadata: labelMetadata,
  };

  state.awaitingLabelGroup.orders = awaiting.orders.map((order) => ({
    ...order,
    ...updatedOrderFields,
  }));
  state.awaitingLabelGroup.primaryOrder = getAttachedHistoryOrder(state.awaitingLabelGroup.orders) || state.awaitingLabelGroup.orders[0];

  historyLabelLines.forEach((line) => {
    line.order = { ...line.order, ...updatedOrderFields };
    if (line.ebay_orders && !Array.isArray(line.ebay_orders)) line.ebay_orders = line.order;
  });

  if (transferPayload.transferId && window.chrome?.runtime?.sendMessage) {
    clearExtensionPendingHistoryLabel(transferPayload.transferId);
  }

  const orderCount = awaiting.orderNumbers.length;
  state.pendingHistoryLabelReplacement = null;
  setHistoryReplaceButtonVisible(false);
  if ($("done-history-label")) $("done-history-label").textContent = "Done";
  setHistoryLabelStatus(`Shipping label attached to this grouped completion (${orderCount} order${orderCount === 1 ? "" : "s"}).`, "success");
  renderHistoryLabelDetails(state.awaitingLabelGroup);
  renderHistoryList();
  return {
    orderNumber: awaiting.orderNumbers[0] || "",
    orderNumbers: awaiting.orderNumbers,
    storagePath: destinationPath,
    uploadedAt: now,
  };
}

function queueHistoryLabelTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (transferId && state.queuedHistoryLabelTransfers.some((entry) => entry?.transferId === transferId)) return;
  state.queuedHistoryLabelTransfers.push(payload);
}

function drainQueuedHistoryLabelTransfers() {
  if (!state.historyLoaded || !state.queuedHistoryLabelTransfers.length) return;
  const queued = [...state.queuedHistoryLabelTransfers];
  state.queuedHistoryLabelTransfers = [];
  queued.forEach((payload) => handleHistoryLabelTransfer(payload));
}

async function completeHistoryLabelTransfer(payload) {
  const transferId = payload?.transferId || "";
  state.labelBusy = true;
  setHistoryLabelStatus("Uploading eBay shipping label to OG...");
  postHistoryLabelTransferStatus({
    transferId,
    phase: "started",
    message: "History label modal accepted the eBay label transfer.",
  });
  try {
    const attached = await attachHistoryLabelToOrder(payload);
    postHistoryLabelTransferStatus({
      transferId,
      ok: true,
      message: `Shipping label attached to history group for ${attached.orderNumbers.join(", ")}.`,
      ...attached,
    });
  } catch (error) {
    console.error("Past order label transfer failed:", error);
    const message = error.message || "Could not attach the eBay label.";
    setHistoryLabelStatus(message, "error");
    postHistoryLabelTransferStatus({
      transferId,
      ok: false,
      error: message,
    });
  } finally {
    state.labelBusy = false;
  }
}

async function handleHistoryLabelTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (transferId && state.handledLabelTransferIds.has(transferId)) return;
  if (state.labelBusy) return;
  if (!state.awaitingLabelGroup) {
    const orderNumbers = getLabelTransferOrderNumbers(payload);
    if (!state.historyLoaded) {
      queueHistoryLabelTransfer(payload);
      return;
    }
    if (!openHistoryLabelReceiverForOrders(orderNumbers)) {
      postHistoryLabelTransferStatus({
        transferId,
        ok: false,
        error: `Order ${orderNumbers.join(", ") || "from the label"} was not found in the current order history range. Adjust the history date filter or open the matching completed order group, then send the label again.`,
      });
      return;
    }
  }

  if (getAttachedHistoryOrder(state.awaitingLabelGroup?.orders || [])) {
    if (transferId) state.handledLabelTransferIds.add(transferId);
    promptHistoryLabelReplacement(payload);
    return;
  }

  if (transferId) state.handledLabelTransferIds.add(transferId);
  await completeHistoryLabelTransfer(payload);
}

async function confirmHistoryLabelReplacement() {
  const payload = state.pendingHistoryLabelReplacement;
  if (!payload || state.labelBusy) return;
  state.pendingHistoryLabelReplacement = null;
  setHistoryReplaceButtonVisible(false);
  if ($("done-history-label")) $("done-history-label").textContent = "Done";
  await completeHistoryLabelTransfer(payload);
}

function setupHistoryLabelReceiver() {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "OG_EBAY_LABEL_RECEIVER_STATE_REQUEST") {
      window.postMessage({
        type: "OG_EBAY_LABEL_RECEIVER_STATE_RESPONSE",
        requestId: event.data.requestId,
        payload: {
          pageType: "order-history",
          labelModalOpen: !$("history-label-modal")?.classList.contains("hidden"),
          awaitingOrderNumbers: state.awaitingLabelGroup?.orderNumbers || [],
          canAutoRoute: false,
        },
      }, window.location.origin);
      return;
    }
    if (event.data?.type !== "OG_EBAY_LABEL_TRANSFER") return;
    handleHistoryLabelTransfer(event.data.payload);
  });
}

async function previewHistoryLabel() {
  const order = getAwaitingHistoryLabelOrder();
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow) previewWindow.opener = null;
  try {
    await openHistoryLabelWindow(order, previewWindow);
  } catch (error) {
    setHistoryLabelStatus(error.message || "Could not create a label preview link.", "error");
  }
}

function setupListeners() {
  window.addEventListener("pageshow", preventHistorySearchAutofill);
  $("refresh-history")?.addEventListener("click", loadOrderHistory);
  $("open-proof-trail")?.addEventListener("click", openProofTrailModal);
  $("close-proof-trail-modal")?.addEventListener("click", closeProofTrailModal);
  $("proof-trail-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "proof-trail-modal") closeProofTrailModal();
  });
  ["history-from", "history-to"].forEach((id) => {
    $(id)?.addEventListener("change", loadOrderHistory);
  });
  ["history-worker", "history-status", "history-label-filter", "history-sort", "history-search"].forEach((id) => {
    $(id)?.addEventListener("input", applyFilters);
    $(id)?.addEventListener("change", applyFilters);
  });

  $("close-revert-modal")?.addEventListener("click", closeRevertModal);
  $("cancel-revert")?.addEventListener("click", closeRevertModal);
  $("confirm-revert")?.addEventListener("click", confirmRevert);
  $("revert-order-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "revert-order-modal") closeRevertModal();
  });
  $("close-history-label-modal")?.addEventListener("click", closeHistoryLabelModal);
  $("done-history-label")?.addEventListener("click", closeHistoryLabelModal);
  $("replace-history-label")?.addEventListener("click", confirmHistoryLabelReplacement);
  $("preview-history-label")?.addEventListener("click", previewHistoryLabel);
  $("history-label-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "history-label-modal") closeHistoryLabelModal();
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
    if (!$("history-label-modal")?.classList.contains("hidden")) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHistoryLabelModal();
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
  setupHistoryLabelReceiver();
  setupListeners();
  await loadOrderHistory();
  if (window.lucide) window.lucide.createIcons();
});
