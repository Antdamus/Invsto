const state = {
  user: null,
  employee: null,
  lines: [],
  adminEvents: [],
  revertEvents: [],
  labelEvents: [],
  returnCases: [],
  returnEvents: [],
  returnTasks: [],
  returnMessages: [],
  returnTaskLines: new Map(),
  returnAssignees: [],
  returnTaskLaunchApplied: false,
  relatedAdminEvents: [],
  relatedRevertEvents: [],
  relatedLabelEvents: [],
  relatedReturnEvents: [],
  filteredLines: [],
  adminCloseoutLineIds: new Set(),
  selectedRevertLineIds: [],
  returnModalLineIds: [],
  returnSelectedLineIds: new Set(),
  returnDestinationLocation: null,
  returnLocations: [],
  returnCaptureStations: [],
  selectedReturnCaptureStationId: "",
  returnEvidencePhotos: [],
  returnEvidencePhotoUploadKeys: new Set(),
  returnCaptureBusy: false,
  activeReturnTransfer: null,
  queuedHistoryReturnTransfers: [],
  queuedHistoryReturnMessageTransfers: [],
  handledReturnTransferIds: new Set(),
  handledReturnMessageTransferIds: new Set(),
  processingReturnTransferIds: new Set(),
  lastReturnImportSummary: null,
  awaitingLabelGroup: null,
  queuedHistoryLabelTransfers: [],
  pendingHistoryLabelReplacement: null,
  pendingHistoryExtraLabelTransfer: null,
  historyLoaded: false,
  labelPreviewUrls: new Map(),
  handledLabelTransferIds: new Set(),
  labelBusy: false,
  labelBackfillBusy: false,
  historySearchUserEdited: false,
  busy: false,
};

let evidencePhotoViewerReturnFocus = null;
const EBAY_LABEL_BUCKET = "ebay-labels";
const EXTRA_LABEL_EVIDENCE_BUCKET = "order-evidence-photos";
const EBAY_RETURN_EVIDENCE_BUCKET = "ebay-return-evidence";
const RETURN_CAPTURE_STATION_TABLE = "capture_stations";
const RETURN_CAPTURE_JOB_TABLE = "capture_jobs";
const RETURN_CAPTURE_PHOTO_TABLE = "capture_job_photos";
const RETURN_CAPTURE_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const RETURN_CAPTURE_POLL_INTERVAL_MS = 1500;
const RETURN_CAPTURE_PHOTO_SETTLE_MS = 3000;
const RETURN_EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;
const RETURN_THUMBNAIL_TRANSFORM = { width: 260, height: 260, resize: "contain", quality: 60 };
const TRACKING_NUMBER_PATTERN = /\b\d{20,30}\b/g;
const FORMATTED_TRACKING_NUMBER_PATTERN = /\b\d{2,4}(?:[\s-]+\d{2,4}){4,8}\b/g;
const ORDER_HISTORY_LINE_SELECT = `
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
`;

function $(id) {
  return document.getElementById(id);
}

function isReturnsWorkbenchPage() {
  return document.body?.dataset?.page === "ebay-returns"
    || /\/ebay-returns\.html$/i.test(window.location.pathname || "");
}

function isModalOpen(id) {
  const element = $(id);
  return Boolean(element && !element.classList.contains("hidden"));
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

function parseMoney(value) {
  const number = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
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

function formatDateOnly(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
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
  const order = getOrderFromLine(row);
  const labelSearchText = getLabelMetadataSearchText(row.label_metadata, order.label_metadata);
  return {
    ...row,
    order,
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
      order.order_number,
      order.buyer_username,
      order.sales_record_number,
      order.sale_date,
      order.paid_on_date,
      order.ship_by_date,
      order.status,
      labelSearchText,
    ].filter(Boolean).join(" ").toLowerCase(),
  };
}

function unique(values) {
  return [...new Set((values || []).filter(Boolean).map(String))];
}

function normalizeTrackingNumber(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return /^\d{20,30}$/.test(digits) ? digits : "";
}

function getTrackingNumbersFromText(text) {
  const body = String(text || "");
  return unique([
    ...(body.match(TRACKING_NUMBER_PATTERN) || []),
    ...(body.match(FORMATTED_TRACKING_NUMBER_PATTERN) || []),
  ].map(normalizeTrackingNumber));
}

function flattenLabelMetadataValues(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.flatMap(flattenLabelMetadataValues);
  if (typeof value === "object") return Object.values(value).flatMap(flattenLabelMetadataValues);
  return [String(value)];
}

function getLabelMetadataSearchText(...metadataObjects) {
  const keys = [
    "trackingNumber",
    "trackingNumbers",
    "shippingBarcodeNumber",
    "shippingBarcodeNumbers",
    "shipmentId",
    "shipmentIds",
    "labelId",
    "labelIds",
    "lookupKeys",
    "labelRows",
  ];
  return metadataObjects.flatMap((metadata) => {
    if (!metadata || typeof metadata !== "object") return [];
    return keys.flatMap((key) => flattenLabelMetadataValues(metadata[key]));
  }).filter(Boolean).join(" ");
}

function getLabelEventSearchTextForLine(line) {
  const lineId = line?.id || "";
  const orderNumber = normalizeEbayOrderNumber(line?.order?.order_number);
  const events = new Map();
  [...state.labelEvents, ...state.relatedLabelEvents].forEach((event) => {
    const key = event.id || `${event.label_file_path}:${event.created_at}`;
    if (!events.has(key)) events.set(key, event);
  });
  return [...events.values()]
    .filter((event) =>
      (lineId && (event.order_line_ids || []).includes(lineId))
      || (orderNumber && (event.order_numbers || []).map(normalizeEbayOrderNumber).includes(orderNumber))
    )
    .flatMap((event) => [
      event.action,
      event.shipment_id,
      event.label_file_path,
      event.signed_by_email,
      getLabelMetadataSearchText(event.label_metadata),
      ...(event.order_numbers || []),
    ])
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function normalizeLabelMetadata(metadata = {}, additions = {}) {
  const trackingNumbers = [...new Set([
    metadata.trackingNumber,
    metadata.shippingBarcodeNumber,
    ...(Array.isArray(metadata.trackingNumbers) ? metadata.trackingNumbers : []),
    ...(Array.isArray(metadata.shippingBarcodeNumbers) ? metadata.shippingBarcodeNumbers : []),
    ...(Array.isArray(metadata.labelRows) ? metadata.labelRows.flatMap((row) => row?.trackingNumbers || row?.shippingBarcodeNumbers || []) : []),
  ].filter(Boolean).map(String))];
  const shipmentIds = [...new Set([
    metadata.shipmentId,
    ...(Array.isArray(metadata.shipmentIds) ? metadata.shipmentIds : []),
  ].filter(Boolean).map(String))];
  const orderIds = [...new Set([
    ...(Array.isArray(metadata.orderIds) ? metadata.orderIds : []),
    ...(Array.isArray(metadata.orderNumbers) ? metadata.orderNumbers : []),
    ...(Array.isArray(additions.orderNumbers) ? additions.orderNumbers : []),
  ].map(normalizeEbayOrderNumber).filter(Boolean))];

  return {
    ...metadata,
    trackingNumber: trackingNumbers[0] || "",
    trackingNumbers,
    shippingBarcodeNumber: trackingNumbers[0] || "",
    shippingBarcodeNumbers: trackingNumbers,
    shipmentId: shipmentIds[0] || metadata.shipmentId || "",
    shipmentIds,
    lookupKeys: [...new Set([
      metadata.orderId,
      metadata.orderNumber,
      ...orderIds,
      metadata.labelId,
      ...shipmentIds,
      ...trackingNumbers,
      ...(Array.isArray(metadata.lookupKeys) ? metadata.lookupKeys : []),
    ].filter(Boolean).map(String))],
  };
}

function getLabelTrackingDisplay(metadata = {}) {
  return unique([
    metadata.trackingNumber,
    metadata.shippingBarcodeNumber,
    ...(Array.isArray(metadata.trackingNumbers) ? metadata.trackingNumbers : []),
    ...(Array.isArray(metadata.shippingBarcodeNumbers) ? metadata.shippingBarcodeNumbers : []),
    ...(Array.isArray(metadata.labelRows) ? metadata.labelRows.flatMap((row) => row?.trackingNumbers || row?.shippingBarcodeNumbers || []) : []),
  ]).join(", ");
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
  const photos = event?.evidence_photos || event?.payload?.evidence_photos || event?.label_metadata?.evidence_photos;
  return Array.isArray(photos)
    ? photos.filter((photo) => photo?.bucket && photo?.path)
    : [];
}

function getReturnItemsForLine(lineId) {
  if (!lineId) return [];
  return state.returnCases
    .flatMap((entry) => Array.isArray(entry.ebay_return_items) ? entry.ebay_return_items : [])
    .filter((item) => item.order_line_id === lineId);
}

function getReturnCasesForLineIds(lineIds = []) {
  const wanted = new Set(lineIds.filter(Boolean));
  if (!wanted.size) return [];
  return state.returnCases.filter((entry) =>
    (Array.isArray(entry.ebay_return_items) ? entry.ebay_return_items : [])
      .some((item) => wanted.has(item.order_line_id))
  );
}

function getReturnEventsForLineIds(lineIds = []) {
  const wanted = new Set(lineIds.filter(Boolean));
  if (!wanted.size) return [];
  return [...state.returnEvents, ...state.relatedReturnEvents]
    .filter((event) => (event.order_line_ids || []).some((lineId) => wanted.has(lineId)))
    .filter((event, index, array) => array.findIndex((entry) => entry.id === event.id) === index)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getReturnStatusLabel(status = "") {
  const key = String(status || "").toLowerCase();
  if (key === "needs_review") return "Needs review";
  if (key === "partially_received") return "Partially received";
  if (key === "received") return "Received";
  if (key === "closed") return "Return closed";
  if (key === "cancelled") return "Return canceled";
  if (key === "open") return "Return open";
  return key ? key.replace(/_/g, " ") : "Return";
}

function getReturnDispositionLabel(value = "") {
  const labels = {
    restock: "Restocked",
    quarantine: "Quarantined",
    damaged: "Damaged",
    wrong_item: "Wrong item",
    refund_only: "Refund only",
    missing: "Missing",
    admin_review: "Needs review",
  };
  return labels[value] || String(value || "Return").replace(/_/g, " ");
}

function getReturnSearchTextForLine(line) {
  const lineId = line?.id || "";
  const items = getReturnItemsForLine(lineId);
  const events = getReturnEventsForLineIds([lineId]);
  const cases = getReturnCasesForLineIds([lineId]);
  return [
    ...items.flatMap((item) => [
      item.condition_received,
      item.disposition,
      item.notes,
      item.item_title,
      item.item_number,
    ]),
    ...cases.flatMap((entry) => [
      entry.status,
      entry.return_reason,
      entry.return_tracking_number,
      entry.ebay_return_id,
      entry.created_by_email,
      entry.notes,
    ]),
    ...events.flatMap((event) => [
      event.action,
      event.notes,
      event.signed_by_email,
      ...(event.evidence_photos || []).map((photo) => `${photo.bucket}/${photo.path}`),
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
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
    .select("id, user_id, email, role, active, display_name")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (employeeError || !employee || employee.active === false) {
    window.location.href = "worker-dashboard.html";
    return false;
  }

  state.user = session.user;
  state.employee = employee;
  const greeting = $("history-greeting");
  if (greeting) {
    const pageTitle = isReturnsWorkbenchPage() ? "eBay Returns" : "eBay Order History";
    greeting.textContent = `${pageTitle}${employee.display_name ? ` - ${employee.display_name}` : ""}`;
  }
  const subtitle = $("history-subtitle");
  if (subtitle) {
    subtitle.textContent = isReturnsWorkbenchPage()
      ? "Return queue, assignments, unmatched refunds, and intake photos."
      : isAdminUser()
        ? "Admin shipping monitor - completed, canceled, and reverted orders"
        : "Search completed orders and open packing proof photos.";
  }
  const mode = $("history-mode-label");
  if (mode) mode.textContent = isReturnsWorkbenchPage() ? "Returns" : isAdminUser() ? "Admin" : "Proof";
  if (!isAdminUser()) {
    document.body.classList.add("history-worker-proof-mode");
    $("history-status")?.querySelector('option[value="reverted"]')?.remove();
    if ($("return-task-status-filter")) $("return-task-status-filter").value = "mine";
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
  state.historySearchUserEdited = false;
  search.setAttribute("autocomplete", "new-password");
  search.setAttribute("autocorrect", "off");
  search.setAttribute("autocapitalize", "off");
  search.setAttribute("spellcheck", "false");
  search.setAttribute("data-form-type", "other");
  search.setAttribute("data-lpignore", "true");
  search.setAttribute("data-1p-ignore", "true");
  search.name = `og-history-search-disabled-${Date.now()}`;
  if (options.apply !== false && state.historyLoaded) applyFilters();
}

function preventHistorySearchAutofill(options = {}) {
  const force = options.force === true;
  const search = $("history-search");
  if (!search) return;
  if (force || !state.historySearchUserEdited) {
    resetHistorySearchInput({ apply: options.apply });
  }
  window.setTimeout(() => {
    if (force || !state.historySearchUserEdited) resetHistorySearchInput({ apply: true });
  }, 100);
  window.setTimeout(() => {
    if (force || !state.historySearchUserEdited) resetHistorySearchInput({ apply: true });
  }, 650);
}

function setupHistorySearchAutofillGuard() {
  const search = $("history-search");
  if (!search) return;

  const markUserEdited = () => {
    state.historySearchUserEdited = true;
  };
  search.addEventListener("input", markUserEdited);
  search.addEventListener("search", markUserEdited);
  search.addEventListener("focus", () => {
    window.setTimeout(() => {
      if (!state.historySearchUserEdited) resetHistorySearchInput({ apply: true });
    }, 80);
  });
  window.addEventListener("pageshow", () => preventHistorySearchAutofill({ force: true }));
  window.addEventListener("focus", () => preventHistorySearchAutofill({ force: true }));
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) preventHistorySearchAutofill({ force: true });
  });
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
    .select(ORDER_HISTORY_LINE_SELECT)
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
  const returnEventsQuery = supabase
    .from("ebay_return_events")
    .select("*")
    .gte("created_at", fromIso)
    .lte("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(300);

  const [linesResult, adminEventsResult, revertEventsResult, labelEventsResult, returnEventsResult] = await Promise.all([
    linesQuery,
    adminEventsQuery,
    revertEventsQuery,
    labelEventsQuery,
    returnEventsQuery,
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

  if (returnEventsResult.error) {
    console.warn("Failed to load eBay return events. Push the latest returns migration if this is new:", returnEventsResult.error);
  }

  const closedLines = (linesResult.data || []).map(normalizeLine);
  const closedLineIds = closedLines.map((line) => line.id).filter(Boolean);
  const closedOrderIds = [...new Set(closedLines.map((line) => line.order_id).filter(Boolean))];
  let relatedAdminEvents = [];
  let relatedRevertEvents = [];
  let relatedLabelEvents = [];
  let relatedReturnEvents = [];
  let returnCases = [];

  if (closedLineIds.length) {
    const [relatedAdminResult, relatedRevertResult, relatedLabelResult, returnCasesResult, relatedReturnResult] = await Promise.all([
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
      closedOrderIds.length
        ? supabase
          .from("ebay_return_cases")
          .select("*, ebay_return_items(*)")
          .in("order_id", closedOrderIds)
          .order("opened_at", { ascending: false })
          .limit(500)
        : Promise.resolve({ data: [], error: null }),
      supabase
        .from("ebay_return_events")
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

    if (returnCasesResult.error) {
      console.warn("Failed to load eBay return cases for visible order lines:", returnCasesResult.error);
    } else {
      returnCases = returnCasesResult.data || [];
    }

    if (relatedReturnResult.error) {
      console.warn("Failed to load related eBay return events for visible order lines:", relatedReturnResult.error);
    } else {
      relatedReturnEvents = relatedReturnResult.data || [];
    }
  }

  state.adminEvents = adminEventsResult.data || [];
  state.revertEvents = revertEventsResult.data || [];
  state.labelEvents = labelEventsResult.error ? [] : labelEventsResult.data || [];
  state.returnEvents = returnEventsResult.error ? [] : returnEventsResult.data || [];
  state.relatedAdminEvents = relatedAdminEvents;
  state.relatedRevertEvents = relatedRevertEvents;
  state.relatedLabelEvents = relatedLabelEvents;
  state.relatedReturnEvents = relatedReturnEvents;
  state.returnCases = returnCases;
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
  drainQueuedHistoryReturnTransfers();
  drainQueuedHistoryReturnMessageTransfers();
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
    if (status === "returns" && !getReturnItemsForLine(line.id).length) return false;
    if (worker && line.fulfilled_by_email !== worker) return false;
    if (
      term
      && !line.searchText.includes(term)
      && !getLabelEventSearchTextForLine(line).includes(term)
      && !getReturnSearchTextForLine(line).includes(term)
    ) return false;
    return true;
  });

  const visibleGroups = getVisibleHistoryGroups();
  renderSummary(visibleGroups);
  renderHistoryList(visibleGroups);
  renderEventList();
}

function getReturnTaskStatusLabel(status = "") {
  const labels = {
    open: "Open",
    assigned: "Assigned",
    in_progress: "In progress",
    blocked: "Blocked",
    resolved: "Resolved",
    cancelled: "Cancelled",
  };
  return labels[status] || String(status || "Task").replace(/_/g, " ");
}

function getReturnTaskTypeLabel(type = "") {
  const labels = {
    return_intake: "Intake",
    return_review: "Review",
    question: "Question",
    follow_up: "Follow-up",
  };
  return labels[type] || String(type || "Task").replace(/_/g, " ");
}

function getReturnTaskPriorityLabel(priority = "") {
  const labels = {
    low: "Low",
    normal: "Normal",
    high: "High",
    urgent: "Urgent",
  };
  return labels[priority] || "Normal";
}

function getReturnTaskCase(task = {}) {
  const entry = task.ebay_return_cases || task.return_case || {};
  return Array.isArray(entry) ? entry[0] || {} : entry;
}

function getReturnTaskLineIds(task = {}) {
  return Array.isArray(task.order_line_ids) ? task.order_line_ids.filter(Boolean) : [];
}

function getReturnTaskLines(task = {}) {
  const ids = new Set(getReturnTaskLineIds(task));
  return [...ids].map((id) => state.returnTaskLines.get(id)).filter(Boolean);
}

function getReturnTaskSearchText(task = {}) {
  const returnCase = getReturnTaskCase(task);
  const lines = getReturnTaskLines(task);
  const metadata = returnCase.raw_payload || task.metadata || {};
  return [
    task.title,
    task.question,
    task.status,
    task.priority,
    task.assigned_to_email,
    task.task_type,
    returnCase.case_type,
    returnCase.order_number,
    returnCase.ebay_return_id,
    returnCase.buyer_username,
    returnCase.return_reason,
    returnCase.return_tracking_number,
    metadata.itemNumber,
    metadata.itemTitle,
    metadata.transactionId,
    metadata.returnStatus,
    metadata.returnAction,
    metadata.refundText,
    metadata.unmatchedReason,
    metadata.buyerComment,
    metadata.videoReceiptUrl,
    metadata.orderDetailsUrl,
    metadata.requestAmount,
    metadata.onHoldAmount,
    metadata.returnDetails?.buyerComment,
    metadata.returnDetails?.videoReceiptUrl,
    metadata.returnDetails?.orderDetailsUrl,
    metadata.returnDetails?.requestAmount,
    metadata.returnDetails?.onHoldAmount,
    ...(Array.isArray(metadata.returnFileIds) ? metadata.returnFileIds : []),
    ...(Array.isArray(metadata.returnDetails?.returnFileIds) ? metadata.returnDetails.returnFileIds : []),
    ...(lines || []).flatMap((line) => [
      line.item_title,
      line.item_number,
      line.transaction_id,
      line.order?.order_number,
      line.order?.buyer_username,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
}

function getFilteredReturnTasks() {
  const statusFilter = $("return-task-status-filter")?.value || "pending";
  const assigneeFilter = $("return-task-assignee-filter")?.value || "";
  const term = String($("return-task-search")?.value || "").trim().toLowerCase();
  const pendingStatuses = new Set(["open", "assigned", "in_progress", "blocked"]);
  return state.returnTasks.filter((task) => {
    if (statusFilter === "pending" && !pendingStatuses.has(task.status)) return false;
    if (statusFilter === "mine" && task.assigned_to_user_id !== state.user?.id) return false;
    if (!["pending", "mine", "all"].includes(statusFilter) && task.status !== statusFilter) return false;
    if (assigneeFilter === "unassigned" && task.assigned_to_user_id) return false;
    if (assigneeFilter && assigneeFilter !== "unassigned" && task.assigned_to_user_id !== assigneeFilter) return false;
    if (term && !getReturnTaskSearchText(task).includes(term)) return false;
    return true;
  });
}

function renderReturnAssigneeOptions(selectedUserId = "") {
  return [
    `<option value="">Unassigned</option>`,
    ...state.returnAssignees.map((employee) => (
      `<option value="${escapeHtml(employee.user_id || "")}" ${employee.user_id === selectedUserId ? "selected" : ""}>${escapeHtml(employee.display_name || employee.email || "Worker")}</option>`
    )),
  ].join("");
}

function renderReturnAssigneeFilter() {
  const select = $("return-task-assignee-filter");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `
    <option value="">All assignees</option>
    <option value="unassigned">Unassigned</option>
    ${state.returnAssignees.map((employee) => (
      `<option value="${escapeHtml(employee.user_id || "")}">${escapeHtml(employee.display_name || employee.email || "Worker")}</option>`
    )).join("")}
  `;
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function loadReturnAssignees() {
  const { data, error } = await supabase
    .from("employees")
    .select("id, user_id, display_name, email, role, active")
    .eq("active", true)
    .order("display_name", { ascending: true });
  if (error) throw error;
  state.returnAssignees = (data || []).filter((employee) => employee.user_id);
  renderReturnAssigneeFilter();
}

async function loadReturnTaskLines(tasks = []) {
  const ids = [...new Set(tasks.flatMap(getReturnTaskLineIds))];
  state.returnTaskLines = new Map();
  if (!ids.length) return;
  const { data, error } = await supabase
    .from("ebay_order_lines")
    .select(ORDER_HISTORY_LINE_SELECT)
    .in("id", ids)
    .limit(1000);
  if (error) {
    console.warn("Failed to load return task line details:", error);
    return;
  }
  (data || []).map(normalizeLine).forEach((line) => {
    state.returnTaskLines.set(line.id, line);
  });
}

async function loadReturnQueue() {
  const list = $("return-task-list");
  if (list) list.innerHTML = `<div class="history-empty">Loading return tasks...</div>`;

  try {
    if (!state.returnAssignees.length) await loadReturnAssignees();
    const { data, error } = await supabase
      .from("ebay_return_tasks")
      .select("*, ebay_return_cases(*)")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) throw error;
    state.returnTasks = data || [];
    await hydrateReturnComplaintImageUrls(state.returnTasks);
    await loadReturnTaskLines(state.returnTasks);
    await loadReturnMessagesForTasks(state.returnTasks);
    renderReturnQueue();
    applyReturnTaskLaunchSelection();
  } catch (error) {
    console.error("Failed to load eBay return queue:", error);
    if (list) {
      list.innerHTML = `<div class="history-empty">Could not load return tasks. Push the latest return task migration if this is new.</div>`;
    }
  }
}

function getReturnTaskLineSummary(task = {}) {
  const lines = getReturnTaskLines(task);
  const returnCase = getReturnTaskCase(task);
  if (!lines.length) {
    const metadata = returnCase.raw_payload || task.metadata || {};
    if (returnCase.case_type === "unmatched_legacy" || metadata.caseType === "unmatched_legacy") {
      const item = [metadata.itemNumber || metadata.item_number, metadata.itemTitle || metadata.item_title]
        .filter(Boolean)
        .join(" - ");
      const reason = returnCase.return_reason || metadata.returnReason || metadata.return_reason || "";
      return `No matched OG order history${item ? ` - ${item}` : ""}${reason ? ` (${reason})` : ""}`;
    }
    return "No line details loaded";
  }
  const first = lines[0];
  const extra = lines.length > 1 ? ` +${lines.length - 1} more` : "";
  return `${first.item_number || "No item #"} - ${first.item_title || "Returned item"}${extra}`;
}

function getReturnComplaintDetails(task = {}) {
  const metadata = getReturnTaskPayload(task);
  const detail = metadata.returnDetails || {};
  const imageUrls = unique([
    ...(Array.isArray(task.complaintImageUrls) ? task.complaintImageUrls : []),
    metadata.complaintImageUrl,
    ...(Array.isArray(metadata.complaintImageUrls) ? metadata.complaintImageUrls : []),
    ...(Array.isArray(detail.complaintImageUrls) ? detail.complaintImageUrls : []),
  ]).filter((url) => !String(url).startsWith("blob:"));
  const blobUrls = unique([
    ...(Array.isArray(metadata.complaintBlobUrls) ? metadata.complaintBlobUrls : []),
    ...(Array.isArray(detail.complaintBlobUrls) ? detail.complaintBlobUrls : []),
  ]);
  const returnFileIds = unique([
    ...(Array.isArray(metadata.returnFileIds) ? metadata.returnFileIds : []),
    ...(Array.isArray(detail.returnFileIds) ? detail.returnFileIds : []),
  ]);
  return {
    buyerComment: metadata.buyerComment || detail.buyerComment || "",
    requestAmount: metadata.requestAmount || detail.requestAmount || "",
    onHoldAmount: metadata.onHoldAmount || detail.onHoldAmount || "",
    orderDetailsUrl: metadata.orderDetailsUrl || detail.orderDetailsUrl || "",
    videoReceiptUrl: metadata.videoReceiptUrl || detail.videoReceiptUrl || "",
    detailsUrl: metadata.detailsUrl || detail.detailsUrl || getReturnTaskPayload(task).pageUrl || "",
    itemImageUrl: metadata.itemImageUrl || detail.itemImageUrl || "",
    datePurchased: metadata.datePurchased || detail.datePurchased || "",
    returnFileIds,
    imageUrls,
    blobUrls,
  };
}

function getReturnComplaintImageRecordsFromPayload(metadata = {}) {
  const detail = metadata.returnDetails || {};
  return [
    ...(Array.isArray(metadata.complaintImages) ? metadata.complaintImages : []),
    ...(Array.isArray(metadata.ebayComplaintImages) ? metadata.ebayComplaintImages : []),
    ...(Array.isArray(detail.complaintImages) ? detail.complaintImages : []),
  ].filter((image) => image && typeof image === "object");
}

async function hydrateReturnComplaintImageUrls(tasks = []) {
  for (const task of tasks || []) {
    const records = getReturnComplaintImageRecordsFromPayload(getReturnTaskPayload(task));
    const urls = await Promise.all(records.map(async (record) => {
      if (record.url && !String(record.url).startsWith("blob:")) {
        return record.url;
      }
      const bucket = record.bucket || record.storage_bucket;
      const path = record.path || record.storage_path;
      if (!bucket || !path) return "";
      return createReturnSignedImageUrl(bucket, path);
    }));
    task.complaintImageUrls = unique(urls.filter(Boolean));
  }
}

async function loadReturnMessagesForTasks(tasks = []) {
  const cases = tasks.map(getReturnTaskCase).filter((entry) => entry?.id || entry?.ebay_return_id || entry?.order_number);
  if (!cases.length) {
    state.returnMessages = [];
    return;
  }
  try {
    const { data, error } = await supabase
      .from("ebay_return_messages")
      .select("*")
      .order("logged_at", { ascending: false })
      .limit(1000);
    if (error) throw error;

    const caseIds = new Set(cases.map((entry) => entry.id).filter(Boolean));
    const returnIds = new Set(cases.map((entry) => normalizeReturnLookup(entry.ebay_return_id)).filter(Boolean));
    const orderNumbers = new Set(cases.map((entry) => normalizeReturnLookup(entry.order_number)).filter(Boolean));
    state.returnMessages = (data || []).filter((message) => {
      return Boolean(
        message.return_case_id && caseIds.has(message.return_case_id)
        || message.ebay_return_id && returnIds.has(normalizeReturnLookup(message.ebay_return_id))
        || message.order_number && orderNumbers.has(normalizeReturnLookup(message.order_number))
      );
    });
  } catch (error) {
    state.returnMessages = [];
    console.warn("Could not load eBay return message logs:", error);
  }
}

function getReturnMessagesForTask(task = {}) {
  const returnCase = getReturnTaskCase(task);
  const metadata = getReturnTaskPayload(task);
  const returnId = normalizeReturnLookup(returnCase.ebay_return_id || metadata.returnId || metadata.ebayReturnId);
  const orderNumber = normalizeReturnLookup(returnCase.order_number || metadata.orderNumber || metadata.order_number);
  return (state.returnMessages || [])
    .filter((message) => Boolean(
      message.return_case_id && returnCase.id && message.return_case_id === returnCase.id
      || returnId && normalizeReturnLookup(message.ebay_return_id) === returnId
      || orderNumber && normalizeReturnLookup(message.order_number) === orderNumber
    ))
    .sort((a, b) => new Date(a.logged_at || a.created_at || 0) - new Date(b.logged_at || b.created_at || 0));
}

function renderReturnMessageLog(task = {}) {
  const messages = getReturnMessagesForTask(task);
  if (!messages.length) return "";
  return `
    <div class="return-message-log">
      <div class="return-complaint-header">
        <span class="eyebrow">Buyer Message Log</span>
      </div>
      ${messages.slice(-6).map((message) => `
        <article class="return-message-entry is-${escapeHtml(message.direction || "outbound")}">
          <div>
            <strong>${escapeHtml(message.direction === "inbound" ? "Buyer" : "OG / eBay reply")}</strong>
            <time>${escapeHtml(formatDateTime(message.sent_at || message.logged_at))}</time>
          </div>
          <p>${escapeHtml(message.message_body || "")}</p>
          <small>${escapeHtml(message.message_status === "sent_from_ebay_page_unverified" ? "Logged from eBay send-message page" : message.message_status || "Logged")}</small>
        </article>
      `).join("")}
    </div>
  `;
}

function renderReturnComplaintDetails(task = {}) {
  const detail = getReturnComplaintDetails(task);
  const hasDetails = Boolean(
    detail.buyerComment
    || detail.requestAmount
    || detail.onHoldAmount
    || detail.orderDetailsUrl
    || detail.videoReceiptUrl
    || detail.returnFileIds.length
    || detail.imageUrls.length
    || detail.blobUrls.length
  );
  if (!hasDetails) return "";

  const photoCount = detail.imageUrls.length || detail.returnFileIds.length || detail.blobUrls.length;
  return `
    <div class="return-complaint-details">
      <div class="return-complaint-header">
        <span class="eyebrow">eBay Complaint Detail</span>
        <div>
          ${detail.detailsUrl ? `<a href="${escapeHtml(detail.detailsUrl)}" target="_blank" rel="noopener">Open eBay return</a>` : ""}
          ${detail.orderDetailsUrl ? `<a href="${escapeHtml(detail.orderDetailsUrl)}" target="_blank" rel="noopener">Order details</a>` : ""}
          ${detail.videoReceiptUrl ? `<a href="${escapeHtml(detail.videoReceiptUrl)}" target="_blank" rel="noopener">Video receipt</a>` : ""}
        </div>
      </div>
      ${detail.buyerComment ? `
        <p class="return-complaint-comment">
          <strong>Buyer comment</strong>
          <span>${escapeHtml(detail.buyerComment)}</span>
        </p>
      ` : ""}
      <div class="return-complaint-grid">
        ${detail.requestAmount ? `<span><small>Request amount</small><b>${escapeHtml(detail.requestAmount)}</b></span>` : ""}
        ${detail.onHoldAmount ? `<span><small>On hold</small><b>${escapeHtml(detail.onHoldAmount)}</b></span>` : ""}
        ${detail.datePurchased ? `<span><small>Date purchased</small><b>${escapeHtml(detail.datePurchased)}</b></span>` : ""}
        ${photoCount ? `<span><small>Buyer photos</small><b>${escapeHtml(`${photoCount} captured reference${photoCount === 1 ? "" : "s"}`)}</b></span>` : ""}
      </div>
      ${detail.imageUrls.length ? `
        <div class="return-complaint-images">
          ${detail.imageUrls.slice(0, 8).map((url) => `
            <a href="${escapeHtml(url)}" target="_blank" rel="noopener">
              <img src="${escapeHtml(url)}" alt="eBay return complaint image" loading="lazy" />
            </a>
          `).join("")}
        </div>
      ` : ""}
      ${!detail.imageUrls.length && (detail.returnFileIds.length || detail.blobUrls.length) ? `
        <p class="return-complaint-photo-note">
          eBay exposed ${escapeHtml(String(photoCount))} buyer photo reference${photoCount === 1 ? "" : "s"}. Open the eBay return detail page to view the actual images.
        </p>
      ` : ""}
    </div>
  `;
}

function renderReturnQueue() {
  const list = $("return-task-list");
  const count = $("return-task-count");
  if (!list) return;
  const tasks = getFilteredReturnTasks();
  if (count) count.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;

  if (!tasks.length) {
    list.innerHTML = `<div class="history-empty">No return tasks match this view.</div>`;
    return;
  }

  list.innerHTML = tasks.map((task) => {
    const returnCase = getReturnTaskCase(task);
    const pending = !["resolved", "cancelled"].includes(task.status);
    const canWorkTask = isAdminUser() || task.assigned_to_user_id === state.user?.id || task.created_by === state.user?.id;
    const lineIds = getReturnTaskLineIds(task);
    const dueInfo = getReturnTaskDueInfo(task);
    const requestedLabel = getReturnTaskRequestedLabel(task);
    const orderLabel = returnCase.order_number || (
      returnCase.case_type === "unmatched_legacy" ? "Legacy / no OG match" : "-"
    );
    return `
      <article class="return-task-card is-${escapeHtml(task.status || "open")} priority-${escapeHtml(task.priority || "normal")}" data-return-task-id="${escapeHtml(task.id)}">
        <div class="return-task-main">
          <div>
            <span class="eyebrow">${escapeHtml(getReturnTaskTypeLabel(task.task_type))}</span>
            <h3>${escapeHtml(task.title || "Return task")}</h3>
            <p>${escapeHtml(task.question || "No question recorded.")}</p>
            <div class="return-task-meta">
              <span>${escapeHtml(getReturnTaskStatusLabel(task.status))}</span>
              <span>${escapeHtml(getReturnTaskPriorityLabel(task.priority))}</span>
              <span>Assigned: ${escapeHtml(task.assigned_to_email || "Unassigned")}</span>
            </div>
            <div class="return-task-meta">
              <span>Return ${escapeHtml(returnCase.ebay_return_id || returnCase.id || "-")}</span>
              <span>Order ${escapeHtml(orderLabel)}</span>
              <span>${escapeHtml(returnCase.buyer_username || "No buyer")}</span>
            </div>
            <div class="return-task-facts">
              <span>
                <small>eBay deadline</small>
                <b>${escapeHtml(dueInfo.label)}</b>
                <em>${escapeHtml(dueInfo.sourceText || "No eBay action text captured")}</em>
              </span>
              <span>
                <small>Requested</small>
                <b>${escapeHtml(requestedLabel || "-")}</b>
                <em>${escapeHtml(returnCase.return_reason || getReturnTaskPayload(task).returnReason || "No reason captured")}</em>
              </span>
            </div>
            <small>${escapeHtml(getReturnTaskLineSummary(task))}</small>
            ${renderReturnComplaintDetails(task)}
            ${renderReturnMessageLog(task)}
          </div>
          <div class="return-task-buttons">
            ${lineIds.length ? `<button type="button" class="secondary-btn" data-return-task-open="${escapeHtml(task.id)}">Open Intake</button>` : ""}
            ${pending && canWorkTask ? `<button type="button" class="secondary-btn" data-return-task-start="${escapeHtml(task.id)}">Start</button>` : ""}
            ${pending && canWorkTask ? `<button type="button" class="primary-btn" data-return-task-resolve="${escapeHtml(task.id)}">Resolve</button>` : ""}
          </div>
        </div>
        ${isAdminUser() ? `
          <div class="return-task-admin">
            <label>
              Assign to
              <select data-return-task-assignee="${escapeHtml(task.id)}">
                ${renderReturnAssigneeOptions(task.assigned_to_user_id || "")}
              </select>
            </label>
            <label>
              Priority
              <select data-return-task-priority="${escapeHtml(task.id)}">
                ${["low", "normal", "high", "urgent"].map((value) => `<option value="${value}" ${task.priority === value ? "selected" : ""}>${escapeHtml(getReturnTaskPriorityLabel(value))}</option>`).join("")}
              </select>
            </label>
            <label>
              Due
              <input type="datetime-local" data-return-task-due="${escapeHtml(task.id)}" value="${escapeHtml(task.due_at ? toDateTimeLocalValue(task.due_at) : "")}" />
            </label>
            <label class="wide">
              Assignment note
              <input type="text" data-return-task-note="${escapeHtml(task.id)}" placeholder="Optional note for assignment changes" />
            </label>
            <button type="button" class="secondary-btn" data-return-task-assign="${escapeHtml(task.id)}">Save Assignment</button>
            <label class="wide question">
              New question / instruction
              <textarea rows="2" data-return-task-question="${escapeHtml(task.id)}" placeholder="Question or instruction for this return"></textarea>
            </label>
            <button type="button" class="secondary-btn" data-return-task-create-question="${escapeHtml(task.id)}">Assign Question</button>
          </div>
        ` : ""}
      </article>
    `;
  }).join("");

  bindReturnQueueActions();
}

function toDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function getReturnTaskById(taskId) {
  return state.returnTasks.find((task) => task.id === taskId) || null;
}

function openReturnTaskIntake(taskId) {
  const task = getReturnTaskById(taskId);
  if (!task) return;
  const lineIds = getReturnTaskLineIds(task);
  if (!lineIds.length) return;
  const fetchedLines = getReturnTaskLines(task);
  if (fetchedLines.length) mergeHistoryLines(fetchedLines);
  openReturnIntakeModal(lineIds);
  const returnCase = getReturnTaskCase(task);
  $("return-ebay-id").value = returnCase.ebay_return_id || "";
  $("return-reason").value = mapEbayReturnReasonToValue(returnCase.return_reason);
  $("return-note").value = [
    returnCase.notes || "",
    task.question ? `Task: ${task.question}` : "",
  ].filter(Boolean).join("\n\n");
  setReturnIntakeStatus(`Opened return task for ${returnCase.order_number || "this order"}. Attach photos, inspect the item, then save.`, "success");
}

async function assignReturnTask(taskId) {
  const assignee = document.querySelector(`[data-return-task-assignee="${CSS.escape(taskId)}"]`)?.value || null;
  const priority = document.querySelector(`[data-return-task-priority="${CSS.escape(taskId)}"]`)?.value || "normal";
  const dueValue = document.querySelector(`[data-return-task-due="${CSS.escape(taskId)}"]`)?.value || "";
  const note = document.querySelector(`[data-return-task-note="${CSS.escape(taskId)}"]`)?.value || "";
  const { error } = await supabase.rpc("assign_ebay_return_task", {
    _task_id: taskId,
    _assigned_to_user_id: assignee || null,
    _priority: priority,
    _due_at: dueValue ? new Date(dueValue).toISOString() : null,
    _notes: note || null,
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  await loadReturnQueue();
}

async function createReturnQuestionTask(taskId) {
  const task = getReturnTaskById(taskId);
  if (!task) return;
  const question = document.querySelector(`[data-return-task-question="${CSS.escape(taskId)}"]`)?.value || "";
  const assignee = document.querySelector(`[data-return-task-assignee="${CSS.escape(taskId)}"]`)?.value || null;
  const priority = document.querySelector(`[data-return-task-priority="${CSS.escape(taskId)}"]`)?.value || "normal";
  const dueValue = document.querySelector(`[data-return-task-due="${CSS.escape(taskId)}"]`)?.value || "";
  const { error } = await supabase.rpc("create_ebay_return_question_task", {
    _return_case_id: task.return_case_id,
    _question: question,
    _assigned_to_user_id: assignee || null,
    _priority: priority,
    _due_at: dueValue ? new Date(dueValue).toISOString() : null,
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  await loadReturnQueue();
}

async function updateReturnTaskStatus(taskId, status) {
  const resolution = status === "resolved"
    ? window.prompt("Resolution note for this return task?", "Handled in return workflow.")
    : null;
  if (status === "resolved" && resolution === null) return;
  const { error } = await supabase.rpc("update_ebay_return_task_status", {
    _task_id: taskId,
    _status: status,
    _resolution_notes: resolution || null,
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  await loadReturnQueue();
}

function bindReturnQueueActions() {
  document.querySelectorAll("[data-return-task-open]").forEach((button) => {
    button.addEventListener("click", () => openReturnTaskIntake(button.dataset.returnTaskOpen));
  });
  document.querySelectorAll("[data-return-task-start]").forEach((button) => {
    button.addEventListener("click", () => updateReturnTaskStatus(button.dataset.returnTaskStart, "in_progress").catch((error) => alert(error.message || "Could not start task.")));
  });
  document.querySelectorAll("[data-return-task-resolve]").forEach((button) => {
    button.addEventListener("click", () => updateReturnTaskStatus(button.dataset.returnTaskResolve, "resolved").catch((error) => alert(error.message || "Could not resolve task.")));
  });
  document.querySelectorAll("[data-return-task-assign]").forEach((button) => {
    button.addEventListener("click", () => assignReturnTask(button.dataset.returnTaskAssign).catch((error) => alert(error.message || "Could not assign task.")));
  });
  document.querySelectorAll("[data-return-task-create-question]").forEach((button) => {
    button.addEventListener("click", () => createReturnQuestionTask(button.dataset.returnTaskCreateQuestion).catch((error) => alert(error.message || "Could not create question task.")));
  });
}

function applyReturnTaskLaunchSelection() {
  if (state.returnTaskLaunchApplied) return;
  const params = new URLSearchParams(window.location.search);
  const taskId = params.get("returnTaskId");
  if (!taskId) return;
  const task = getReturnTaskById(taskId);
  if (!task) return;
  state.returnTaskLaunchApplied = true;
  const returnCase = getReturnTaskCase(task);
  $("return-task-status-filter").value = "all";
  $("return-task-search").value = returnCase.ebay_return_id || returnCase.order_number || task.title || "";
  renderReturnQueue();
  window.setTimeout(() => {
    document.querySelector(`[data-return-task-id="${CSS.escape(taskId)}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    if (getReturnTaskLineIds(task).length) openReturnTaskIntake(taskId);
  }, 120);
}

async function refreshHistoryAndReturns() {
  if (!isReturnsWorkbenchPage()) await loadOrderHistory();
  await loadReturnQueue();
}

function getUniqueLinesFromGroups(groups = []) {
  const lines = new Map();
  groups.forEach((group) => {
    (group.lines || []).forEach((line) => {
      const key = line.id || `${line.order_id || ""}:${line.item_number || ""}:${line.transaction_id || ""}`;
      if (key && !lines.has(key)) lines.set(key, line);
    });
  });
  return [...lines.values()];
}

function getUniqueEventsFromGroups(groups = []) {
  const events = new Map();
  groups.forEach((group) => {
    (group.events || []).forEach((event) => {
      const key = `${event.category || "event"}:${event.id || event.created_at || JSON.stringify(event.order_line_ids || [])}`;
      if (!events.has(key)) events.set(key, event);
    });
  });
  return [...events.values()];
}

function renderSummary(groups = getVisibleHistoryGroups()) {
  const visibleLines = getUniqueLinesFromGroups(groups);
  const visibleEvents = getUniqueEventsFromGroups(groups);
  const shippedLines = visibleLines.filter((line) => line.line_status === "fulfilled");
  const shippedGroups = groups.filter((group) =>
    (group.lines || []).some((line) => line.line_status === "fulfilled")
  );
  const gross = shippedLines.reduce((sum, line) => sum + getLineGross(line), 0);
  const payout = shippedLines.reduce((sum, line) => sum + getLinePayout(line), 0);
  const closeoutEvents = visibleEvents.filter((event) => event.action === "fulfilled_no_inventory");
  const closeouts = closeoutEvents.length || visibleLines.filter(isAdminCloseoutLine).length;
  const cancelled = visibleLines.filter((line) => line.line_status === "cancelled").length;
  const returnCount = new Set(getReturnCasesForLineIds(visibleLines.map((line) => line.id)).map((entry) => entry.id)).size;
  const reverted = visibleEvents
    .filter((event) => event.category === "revert")
    .reduce((sum, event) => sum + Number(event.payload?.reverted_lines || event.order_line_ids?.length || 1), 0);

  $("summary-shipped-orders").textContent = String(shippedGroups.length);
  $("summary-shipped-lines").textContent = String(shippedLines.length);
  $("summary-gross").textContent = formatMoney(gross);
  $("summary-payout").textContent = formatMoney(payout);
  $("summary-admin-closeouts").textContent = String(closeouts);
  $("summary-cancelled").textContent = String(cancelled);
  $("summary-returns").textContent = String(returnCount);
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
    ...state.relatedReturnEvents.map((event) => ({ ...event, category: "return" })),
    ...state.adminEvents.map((event) => ({ ...event, category: "admin" })),
    ...state.revertEvents.map((event) => ({ ...event, category: "revert", action: "reverted" })),
    ...state.labelEvents.map((event) => ({ ...event, category: "label" })),
    ...state.returnEvents.map((event) => ({ ...event, category: "return" })),
  ]
    .filter((event) => getEventLineIds(event).some((lineId) => wanted.has(lineId)))
    .filter((event, index, array) => array.findIndex((entry) => entry.id === event.id && entry.category === event.category) === index)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function getEventLabel(event) {
  if (event.category === "revert") return "Reverted";
  if (event.category === "label") return event.action === "replaced" ? "Shipping label replaced" : "Shipping label attached";
  if (event.category === "return") {
    if (event.action === "restocked") return "Return restocked";
    if (event.action === "item_inspected") return "Return inspected";
    if (event.action === "return_created") return "Return started";
    if (event.action === "closed") return "Return closed";
    return "Return received";
  }
  if (event.action === "fulfilled_no_inventory") return "No-inventory completion";
  if (event.action === "cancelled") return "Canceled";
  return event.action || "Event";
}

function getHistoryGroupStatus(group) {
  if (getReturnCasesForLineIds((group.lines || []).map((line) => line.id)).length) return "Returned";
  if (group.events.some((event) => event.category === "revert")) return "Has reversal";
  if (group.lines.some((line) => line.line_status === "cancelled")) return "Canceled";
  if (group.events.some((event) => event.action === "fulfilled_no_inventory") || group.lines.some(isAdminCloseoutLine)) {
    return "No-inventory completion";
  }
  return "Shipped";
}

function getHistoryGroupStatusClass(group) {
  const label = getHistoryGroupStatus(group);
  if (label === "Returned") return "is-returned";
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

function getExtraLabelEventsForOrderNumbers(orderNumbers = []) {
  const wanted = new Set(parseHistoryOrderNumbers(orderNumbers));
  if (!wanted.size) return [];
  const events = new Map();
  [...state.labelEvents, ...state.relatedLabelEvents].forEach((event) => {
    const key = event.id || `${event.label_file_path}:${event.created_at}`;
    if (!events.has(key)) events.set(key, event);
  });
  return [...events.values()]
    .filter((event) => event.action === "extra_label")
    .filter((event) => (event.order_numbers || []).some((orderNumber) => wanted.has(normalizeEbayOrderNumber(orderNumber))))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function renderExtraLabelEvents(orderNumbers = []) {
  const events = getExtraLabelEventsForOrderNumbers(orderNumbers);
  if (!events.length) return "";

  return `
    <div class="history-extra-label-list" aria-label="Extra shipping labels">
      ${events.map((event, index) => {
        const trackingText = getLabelTrackingDisplay(event.label_metadata || {});
        const evidenceCount = getEventEvidencePhotos(event).length;
        return `
          <article>
            <div>
              <strong>Extra label ${events.length - index}</strong>
              <span>${escapeHtml(formatDateTime(event.created_at))} - ${escapeHtml(event.signed_by_email || "Unknown user")}</span>
              <span>Tracker: ${escapeHtml(trackingText || "Not captured yet")}</span>
              <span>${evidenceCount} forgotten-item photo${evidenceCount === 1 ? "" : "s"}</span>
            </div>
            <button type="button" class="secondary-btn history-label-open-btn" data-history-extra-label-open="${escapeHtml(event.id)}">Open Extra Label</button>
          </article>
        `;
      }).join("")}
    </div>
  `;
}

function bindHistoryExtraLabelOpenButtons(root = document) {
  root.querySelectorAll("[data-history-extra-label-open]").forEach((button) => {
    if (button.dataset.extraLabelBound === "true") return;
    button.dataset.extraLabelBound = "true";
    button.addEventListener("click", () => handleOpenHistoryExtraLabelButtonClick(button.dataset.historyExtraLabelOpen));
  });
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
  const trackingText = getLabelTrackingDisplay(attachedOrder?.label_metadata || {});
  const orderCount = orderNumbers.length || orders.length;
  const orderWord = orderCount === 1 ? "order" : "orders";
  const attachedCount = orders.filter((order) => order?.label_file_path).length;
  const labelSummary = labelPath
    ? `Attached ${formatDateTime(attachedOrder.label_uploaded_at)} - ${attachedCount >= orderCount ? `covers ${orderCount} ${orderWord}` : `${attachedCount} of ${orderCount} ${orderWord}`}`
    : `One label for this grouped completion - ${orderCount} ${orderWord}`;
  const extraLabelEvents = getExtraLabelEventsForOrderNumbers(orderNumbers);
  const encodedOrderNumbers = escapeHtml(orderNumbers.join(","));

  return `
    <div class="history-order-label-strip">
      <div class="history-order-label-control">
        <div>
          <span class="eyebrow">Shipping Label</span>
          <strong>${escapeHtml(group.buyer || "Grouped completion")}</strong>
          <small>${escapeHtml(labelSummary)}</small>
          ${labelPath ? `<small class="history-label-tracker-inline">Tracker: <b>${escapeHtml(trackingText || "Not captured yet")}</b></small>` : ""}
        </div>
        <div>
          ${labelPath ? `<button type="button" class="secondary-btn history-label-open-btn" data-history-label-open-group="${encodedOrderNumbers}">Open Label</button>` : ""}
          <button type="button" class="secondary-btn history-label-btn" data-history-label-group="${encodedOrderNumbers}">${labelPath ? "Replace Label" : "Add Label"}</button>
          ${labelPath ? `<button type="button" class="secondary-btn history-label-btn" data-history-label-extra-group="${encodedOrderNumbers}">Add Extra Label</button>` : ""}
        </div>
      </div>
      ${extraLabelEvents.length ? renderExtraLabelEvents(orderNumbers) : ""}
    </div>
  `;
}

function renderGroupReturnControl(group) {
  const lineIds = (group?.lines || []).map((line) => line.id).filter(Boolean);
  if (!lineIds.length) return "";
  const returnCases = getReturnCasesForLineIds(lineIds);
  const latestCase = returnCases
    .slice()
    .sort((a, b) => new Date(b.opened_at || b.received_at || 0) - new Date(a.opened_at || a.received_at || 0))[0];
  const returnItems = returnCases.flatMap((entry) => Array.isArray(entry.ebay_return_items) ? entry.ebay_return_items : []);
  const restockedUnits = returnItems
    .filter((item) => item.disposition === "restock")
    .reduce((sum, item) => sum + Number(item.received_quantity || 0), 0);
  const problemCount = returnItems.filter((item) => ["admin_review", "wrong_item", "damaged", "missing"].includes(item.disposition)).length;
  const encodedLineIds = escapeHtml(lineIds.join(","));
  const summary = latestCase
    ? `${returnCases.length} return case${returnCases.length === 1 ? "" : "s"} - ${getReturnStatusLabel(latestCase.status)}${restockedUnits ? ` - ${restockedUnits} unit${restockedUnits === 1 ? "" : "s"} restocked` : ""}${problemCount ? ` - ${problemCount} flagged` : ""}`
    : "No return recorded for this grouped completion.";

  return `
    <div class="history-order-return-strip">
      <div class="history-order-return-control">
        <div>
          <span class="eyebrow">Returns</span>
          <strong>${escapeHtml(latestCase ? getReturnStatusLabel(latestCase.status) : "Return intake")}</strong>
          <small>${escapeHtml(summary)}</small>
        </div>
        <div>
          <button type="button" class="secondary-btn history-return-btn" data-return-lines="${encodedLineIds}">${latestCase ? "Add Return Update" : "Start Return"}</button>
        </div>
      </div>
      ${returnItems.length ? `
        <div class="history-return-item-list">
          ${returnItems.slice(0, 4).map((item) => `
            <article>
              <strong>${escapeHtml(item.item_title || "Returned item")}</strong>
              <span>${escapeHtml(getReturnDispositionLabel(item.disposition))} - Qty ${Number(item.received_quantity || 0).toLocaleString()} - ${escapeHtml(formatDateTime(item.processed_at))}</span>
            </article>
          `).join("")}
        </div>
      ` : ""}
    </div>
  `;
}

function renderHistoryList(groups = getVisibleHistoryGroups()) {
  const list = $("history-list");
  if (!list) return;

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
    const hasReturns = getReturnCasesForLineIds(lineIds).length > 0;

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
          ${hasReturns ? `<span class="history-return-pill">Return recorded</span>` : ""}
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
      ${renderGroupReturnControl(group)}
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
    card.querySelectorAll("[data-history-label-extra-group]").forEach((button) => {
      button.addEventListener("click", () => handleHistoryExtraLabelButtonClick(button.dataset.historyLabelExtraGroup));
    });
    card.querySelectorAll("[data-history-label-open-group]").forEach((button) => {
      button.addEventListener("click", () => handleOpenHistoryLabelButtonClick(button.dataset.historyLabelOpenGroup));
    });
    card.querySelectorAll("[data-history-extra-label-open]").forEach((button) => {
      button.addEventListener("click", () => handleOpenHistoryExtraLabelButtonClick(button.dataset.historyExtraLabelOpen));
    });
    card.querySelectorAll("[data-return-lines]").forEach((button) => {
      button.addEventListener("click", () => openReturnIntakeModal(button.dataset.returnLines.split(",").filter(Boolean)));
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
    ...state.returnEvents.map((event) => ({ ...event, category: "return" })),
  ];

  return events.filter((event) => {
    if (status === "fulfilled" && event.action !== "fulfilled_no_inventory") return false;
    if (status === "cancelled" && event.action !== "cancelled") return false;
    if (status === "admin_closeout" && event.category !== "admin") return false;
    if (status === "reverted" && event.category !== "revert") return false;
    if (status === "returns" && event.category !== "return") return false;

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
        event.return_case_id,
        getLabelMetadataSearchText(event.label_metadata),
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
        ...(event.return_item_ids || []),
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
        ? event.action === "extra_label" ? "Extra shipping label added" : event.action === "replaced" ? "Shipping label replaced" : "Shipping label attached"
        : event.category === "return"
          ? getEventLabel(event)
          : event.action === "fulfilled_no_inventory"
          ? "Packed without inventory removal"
          : isAdminUser() ? "Canceled by admin" : "Canceled";
    const units = event.payload?.restored_units ? ` - restored ${Number(event.payload.restored_units).toLocaleString()} unit(s)` : "";
    const gps = getEventGpsLabel(event);
    const store = event.payload?.checkout_store_name || "";
    const evidenceCount = getEventEvidencePhotos(event).length;
    const eventStatusClass = event.category === "return"
      ? "is-returned"
      : event.category === "revert" || event.category === "label"
      ? "is-admin"
      : event.action === "cancelled" ? "is-cancelled" : "";
    const eventDetail = event.notes || event.label_metadata?.notes || event.label_file_path || event.payload?.disposition || "No note recorded.";
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

function setReturnIntakeStatus(message = "", type = "info") {
  const el = $("return-intake-status");
  if (!el) return;
  el.textContent = message || "Select returned lines, attach evidence photos, and choose the disposition.";
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function getReturnModalLines() {
  const wanted = new Set(state.returnModalLineIds);
  return state.lines.filter((line) => wanted.has(line.id));
}

function getLocationLabel(location) {
  if (!location) return "";
  const role = location.is_tray || location.location_role === "tray"
    ? "Tray"
    : location.parent_location_id ? "Container" : "Location";
  return `${location.location_name || "Unnamed location"}${location.location_code ? ` (${location.location_code})` : ""} - ${role}`;
}

async function loadReturnLocations() {
  if (state.returnLocations.length) return state.returnLocations;
  const { data, error } = await supabase
    .from("locations")
    .select("id,location_name,location_code,type,active,is_tray,location_role,parent_location_id,store_id,tray_current_store_id")
    .eq("active", true)
    .order("location_name", { ascending: true })
    .limit(1200);
  if (error) throw new Error(error.message || "Could not load return locations.");
  state.returnLocations = data || [];
  return state.returnLocations;
}

function renderReturnDestinationSummary() {
  const summary = $("return-destination-summary");
  if (!summary) return;
  summary.textContent = state.returnDestinationLocation
    ? `Restock destination: ${getLocationLabel(state.returnDestinationLocation)}`
    : "No restock destination selected.";
  summary.classList.toggle("is-selected", Boolean(state.returnDestinationLocation));
}

function selectReturnDestinationLocation(location) {
  state.returnDestinationLocation = location || null;
  if ($("return-destination-scan") && location) {
    $("return-destination-scan").value = location.location_code || location.location_name || "";
  }
  $("return-location-results").innerHTML = "";
  renderReturnDestinationSummary();
}

async function searchReturnDestinationLocation() {
  const term = String($("return-destination-scan")?.value || "").trim().toLowerCase();
  const results = $("return-location-results");
  if (!term) {
    setReturnIntakeStatus("Scan or type a return destination location.", "error");
    return;
  }

  try {
    const locations = await loadReturnLocations();
    const matches = locations.filter((location) =>
      String(location.id || "").toLowerCase() === term
      || String(location.location_code || "").toLowerCase() === term
      || String(location.location_name || "").toLowerCase().includes(term)
      || getLocationLabel(location).toLowerCase().includes(term)
    ).slice(0, 12);

    if (matches.length === 1) {
      selectReturnDestinationLocation(matches[0]);
      setReturnIntakeStatus("Restock destination selected.", "success");
      return;
    }

    if (!matches.length) {
      if (results) results.innerHTML = "";
      setReturnIntakeStatus("No active location matched that scan.", "error");
      return;
    }

    if (results) {
      results.innerHTML = matches.map((location, index) => `
        <button type="button" class="return-location-result" data-return-location-index="${index}">
          <strong>${escapeHtml(location.location_name || "Unnamed location")}</strong>
          <span>${escapeHtml(location.location_code || location.id)} - ${escapeHtml(getLocationLabel(location))}</span>
        </button>
      `).join("");
      results.querySelectorAll("[data-return-location-index]").forEach((button) => {
        button.addEventListener("click", () => {
          selectReturnDestinationLocation(matches[Number(button.dataset.returnLocationIndex)]);
          setReturnIntakeStatus("Restock destination selected.", "success");
        });
      });
    }
    setReturnIntakeStatus(`${matches.length} locations match. Choose the restock destination.`, "info");
  } catch (error) {
    console.error("Return destination search failed:", error);
    setReturnIntakeStatus(error.message || "Could not search locations.", "error");
  }
}

function renderReturnEvidencePhotoList() {
  const files = [...($("return-evidence-photo")?.files || [])];
  const list = $("return-evidence-photo-list");
  if (!list) return;
  list.innerHTML = files.length
    ? files.map((file) => `<span>${escapeHtml(file.name)}${file.size ? ` - ${escapeHtml(formatFileSize(file.size))}` : ""}</span>`).join("")
    : `<span>Fallback files optional when phone photos are attached</span>`;
}

function delayReturnCapture(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPreferredReturnCaptureStationHints() {
  try {
    return {
      stationId: String(window.OG_CAPTURE_STATION_ID || localStorage.getItem("og.captureStationId") || "").trim(),
      stationName: String(window.OG_CAPTURE_STATION_NAME || localStorage.getItem("og.captureStationName") || "").trim(),
    };
  } catch (_) {
    return { stationId: "", stationName: "" };
  }
}

function setReturnPhotoStatus(message = "", type = "info") {
  const el = $("return-photo-status");
  if (!el) return;
  el.textContent = message || "";
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function renderReturnCaptureStations() {
  const select = $("return-capture-station");
  if (!select) return;
  const stations = state.returnCaptureStations;

  if (!stations.length) {
    select.innerHTML = '<option value="">No active stations</option>';
    select.disabled = true;
    return;
  }

  select.replaceChildren(new Option("Choose station", ""));
  stations.forEach((station) => {
    select.appendChild(new Option(station.name || station.id, station.id));
  });
  select.value = stations.some((station) => station.id === state.selectedReturnCaptureStationId)
    ? state.selectedReturnCaptureStationId
    : "";
  select.disabled = false;
}

function setSelectedReturnCaptureStation(stationId = "") {
  const station = state.returnCaptureStations.find((entry) => entry.id === stationId) || null;
  state.selectedReturnCaptureStationId = station?.id || "";

  const select = $("return-capture-station");
  if (select && select.value !== state.selectedReturnCaptureStationId) {
    select.value = state.selectedReturnCaptureStationId;
  }

  try {
    if (station) {
      localStorage.setItem("og.captureStationId", station.id);
      localStorage.setItem("og.captureStationName", station.name || "");
    }
  } catch (_) {}

  return station;
}

async function loadReturnCaptureStations({ silent = false } = {}) {
  const select = $("return-capture-station");
  if (select) {
    select.disabled = true;
    select.innerHTML = '<option value="">Loading stations...</option>';
  }

  const { data, error } = await supabase
    .from(RETURN_CAPTURE_STATION_TABLE)
    .select("id, name, active")
    .eq("active", true)
    .order("name", { ascending: true });

  if (error) throw new Error(error.message || "Could not load capture stations.");

  state.returnCaptureStations = Array.isArray(data) ? data : [];
  const { stationId, stationName } = getPreferredReturnCaptureStationHints();
  const nextStation = state.returnCaptureStations.find((station) => station.id === state.selectedReturnCaptureStationId)
    || state.returnCaptureStations.find((station) => station.id === stationId)
    || state.returnCaptureStations.find((station) => String(station.name || "").trim().toLowerCase() === stationName.toLowerCase())
    || state.returnCaptureStations[0]
    || null;

  setSelectedReturnCaptureStation(nextStation?.id || "");
  renderReturnCaptureStations();

  if (!silent) {
    setReturnPhotoStatus(nextStation ? `Ready to take return photos on ${nextStation.name || "selected station"}.` : "No active capture stations are available.", nextStation ? "info" : "error");
  }

  return state.returnCaptureStations;
}

function getSelectedReturnCaptureStation() {
  return state.returnCaptureStations.find((station) => station.id === state.selectedReturnCaptureStationId) || null;
}

async function createReturnCaptureJob(stationId) {
  const { data, error } = await supabase
    .from(RETURN_CAPTURE_JOB_TABLE)
    .insert({
      station_id: stationId,
      status: "queued",
      requested_at: new Date().toISOString(),
      requested_by_email: state.user?.email || null,
    })
    .select("id, station_id, status, requested_at")
    .single();

  if (error || !data) throw new Error(error?.message || "Failed to create capture job.");
  return data;
}

function returnCaptureJobHasUpload(job) {
  return Boolean(job?.storage_bucket && job?.storage_path)
    || Boolean(job?.upload_completed_at)
    || Boolean(job?.capture_completed_at && job?.storage_path);
}

async function getReturnCaptureJobPhotoCount(jobId) {
  const { count, error } = await supabase
    .from(RETURN_CAPTURE_PHOTO_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("capture_job_id", jobId);

  if (error) {
    console.warn("Could not check return capture photo count:", error);
    return 0;
  }
  return count || 0;
}

async function pollReturnCaptureJob(job, station = {}) {
  const jobId = job?.id || job;
  const stationName = station.name || "";
  const startedAt = Date.now();
  let lastPhotoCount = 0;
  let lastPhotoChangeAt = startedAt;

  while ((Date.now() - startedAt) < RETURN_CAPTURE_POLL_TIMEOUT_MS) {
    const { data, error } = await supabase
      .from(RETURN_CAPTURE_JOB_TABLE)
      .select("id, station_id, status, storage_bucket, storage_path, capture_completed_at, upload_completed_at, mime_type, file_size_bytes, failure_code, failure_message, requested_at")
      .eq("id", jobId)
      .single();

    if (error || !data) throw new Error(error?.message || "Failed to poll capture job.");
    if (data.status === "completed" || data.status === "failed") return data;

    const photoCount = await getReturnCaptureJobPhotoCount(jobId);
    if (photoCount !== lastPhotoCount) {
      lastPhotoCount = photoCount;
      lastPhotoChangeAt = Date.now();
    }
    if (returnCaptureJobHasUpload(data)) return { ...data, status: "completed" };
    if (photoCount > 0 && (Date.now() - lastPhotoChangeAt) >= RETURN_CAPTURE_PHOTO_SETTLE_MS) {
      return { ...data, status: "completed" };
    }

    const label = data.status === "queued"
      ? `Capture queued${stationName ? ` on ${stationName}` : ""}. Waiting for camera...`
      : data.status === "capturing"
        ? `Camera is capturing${stationName ? ` on ${stationName}` : ""}...`
        : data.status === "uploading"
          ? `Camera is uploading${stationName ? ` on ${stationName}` : ""}...`
          : `Capture status: ${data.status || "waiting"}`;
    setReturnPhotoStatus(photoCount > 0 ? `${label} ${photoCount} photo${photoCount === 1 ? "" : "s"} received...` : label, "info");
    await delayReturnCapture(RETURN_CAPTURE_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for camera capture.");
}

async function loadReturnCaptureJobPhotos(jobId) {
  const { data, error } = await supabase
    .from(RETURN_CAPTURE_PHOTO_TABLE)
    .select("id, capture_job_id, sort_order, is_primary, storage_bucket, storage_path, mime_type, file_size_bytes, label, created_at")
    .eq("capture_job_id", jobId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(error.message || "Failed to load capture photos.");
  return Array.isArray(data) ? data : [];
}

async function createReturnSignedImageUrl(bucket, path, options = {}) {
  if (!bucket || !path) return "";
  try {
    const { data, error } = options.transform
      ? await supabase.storage.from(bucket).createSignedUrl(path, RETURN_EVIDENCE_SIGNED_URL_TTL_SECONDS, { transform: options.transform })
      : await supabase.storage.from(bucket).createSignedUrl(path, RETURN_EVIDENCE_SIGNED_URL_TTL_SECONDS);
    if (!error && data?.signedUrl) return data.signedUrl;
    if (!options.transform) return "";
  } catch (_) {
    if (!options.transform) return "";
  }
  return createReturnSignedImageUrl(bucket, path);
}

async function returnCaptureRowsToEvidencePhotos(rows) {
  const photos = [];
  for (let index = 0; index < (rows || []).length; index += 1) {
    const row = rows[index];
    const bucket = String(row?.storage_bucket || "").trim();
    const path = String(row?.storage_path || "").trim();
    if (!bucket || !path) continue;
    const [previewUrl, thumbnailUrl] = await Promise.all([
      createReturnSignedImageUrl(bucket, path),
      createReturnSignedImageUrl(bucket, path, { transform: RETURN_THUMBNAIL_TRANSFORM }),
    ]);
    if (!previewUrl) continue;
    photos.push({
      id: row.id || `${bucket}:${path}`,
      bucket,
      path,
      previewUrl,
      thumbnailUrl: thumbnailUrl || previewUrl,
      capture_job_id: row.capture_job_id || "",
      sort_order: row.sort_order ?? index,
      label: row.label || `Return photo ${index + 1}`,
      mime_type: row.mime_type || "image/jpeg",
      size_bytes: row.file_size_bytes || 0,
      created_at: row.created_at || new Date().toISOString(),
    });
  }
  return photos;
}

function getReturnEvidencePhotoKey(photo) {
  return `${photo?.bucket || ""}:${photo?.path || ""}`;
}

function getSelectedReturnEvidencePhotos() {
  return state.returnEvidencePhotos.filter((photo) => (
    state.returnEvidencePhotoUploadKeys.has(getReturnEvidencePhotoKey(photo))
  ));
}

function setReturnEvidencePhotoSelected(photoKey, selected) {
  if (!photoKey) return;
  if (selected) state.returnEvidencePhotoUploadKeys.add(photoKey);
  else state.returnEvidencePhotoUploadKeys.delete(photoKey);
  renderReturnEvidencePhotos();
}

function setAllReturnEvidencePhotosSelected(selected) {
  state.returnEvidencePhotoUploadKeys.clear();
  if (selected) {
    state.returnEvidencePhotos.forEach((photo) => {
      state.returnEvidencePhotoUploadKeys.add(getReturnEvidencePhotoKey(photo));
    });
  }
  renderReturnEvidencePhotos();
}

function getReturnEvidenceFileExtension(source, blob) {
  const value = `${source?.path || source?.name || ""} ${source?.mime_type || source?.type || ""} ${blob?.type || ""}`.toLowerCase();
  if (value.includes("png")) return "png";
  if (value.includes("webp")) return "webp";
  if (value.includes("heic")) return "heic";
  if (value.includes("heif")) return "heif";
  return "jpg";
}

function getReturnEvidenceSourceLabel(orderNumbers = []) {
  return safeStorageSegment(orderNumbers.join("-") || "return", "return");
}

async function copyCapturedReturnEvidencePhotos(orderNumbers = []) {
  const selectedPhotos = getSelectedReturnEvidencePhotos();
  if (!selectedPhotos.length) return [];

  const dateFolder = new Date().toISOString().slice(0, 10);
  const orderSegment = getReturnEvidenceSourceLabel(orderNumbers);
  const copied = [];

  for (let index = 0; index < selectedPhotos.length; index += 1) {
    const photo = selectedPhotos[index];
    const response = await fetch(photo.previewUrl);
    if (!response.ok) throw new Error(`Could not download return photo ${index + 1} before saving.`);
    const blob = await response.blob();
    const extension = getReturnEvidenceFileExtension(photo, blob);
    const originalName = safeStorageSegment(String(photo.path || "").split("/").pop(), `phone-photo-${index + 1}`);
    const destinationPath = [
      "returns",
      dateFolder,
      orderSegment,
      `${Date.now()}-${crypto.randomUUID()}-${originalName}.${extension}`,
    ].join("/");

    const { error } = await supabase.storage
      .from(EBAY_RETURN_EVIDENCE_BUCKET)
      .upload(destinationPath, blob, {
        contentType: blob.type || photo.mime_type || "image/jpeg",
        upsert: false,
      });

    if (error) throw new Error(error.message || `Could not save return photo ${index + 1}.`);
    copied.push({
      bucket: EBAY_RETURN_EVIDENCE_BUCKET,
      path: destinationPath,
      source_bucket: photo.bucket,
      source_path: photo.path,
      capture_job_id: photo.capture_job_id || null,
      sort_order: index,
      label: photo.label || `Return photo ${index + 1}`,
      mime_type: blob.type || photo.mime_type || null,
      size_bytes: blob.size || photo.size_bytes || 0,
      created_at: new Date().toISOString(),
    });
  }

  return copied;
}

async function uploadReturnEvidenceFiles(files, orderNumbers = [], offset = 0) {
  const orderSegment = getReturnEvidenceSourceLabel(orderNumbers);
  const batchSegment = `${Date.now()}-${crypto.randomUUID()}`;
  const uploaded = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const extension = getReturnEvidenceFileExtension(file, file);
    const path = [
      "returns",
      orderSegment,
      `${batchSegment}-${index + 1}.${extension}`,
    ].join("/");
    const { error } = await supabase.storage
      .from(EBAY_RETURN_EVIDENCE_BUCKET)
      .upload(path, file, {
        contentType: file.type || "image/jpeg",
        upsert: false,
      });
    if (error) throw new Error(error.message || `Could not upload return evidence photo ${index + 1}.`);
    uploaded.push({
      bucket: EBAY_RETURN_EVIDENCE_BUCKET,
      path,
      label: `Return evidence ${offset + index + 1}`,
      original_name: file.name || "",
      mime_type: file.type || "image/jpeg",
      size_bytes: file.size || 0,
      uploaded_at: new Date().toISOString(),
    });
  }

  return uploaded;
}

async function persistReturnEvidencePhotos(files, orderNumbers = []) {
  const captured = await copyCapturedReturnEvidencePhotos(orderNumbers);
  const uploaded = await uploadReturnEvidenceFiles(files, orderNumbers, captured.length);
  return [...captured, ...uploaded];
}

function renderReturnEvidencePhotos() {
  const grid = $("return-photo-grid");
  if (!grid) return;
  const toolbar = document.querySelector(".return-photo-toolbar");
  toolbar?.classList.toggle("hidden", !state.returnEvidencePhotos.length);
  if (!state.returnEvidencePhotos.length) {
    grid.innerHTML = `<div class="history-empty">No return photos added.</div>`;
    updateReturnEvidencePhotoSelectionSummary();
    return;
  }

  grid.innerHTML = state.returnEvidencePhotos.map((photo, index) => {
    const key = getReturnEvidencePhotoKey(photo);
    const selected = state.returnEvidencePhotoUploadKeys.has(key);
    return `
      <article class="return-photo-card ${selected ? "is-selected" : ""}">
        <label class="return-photo-select">
          <input
            type="checkbox"
            data-return-photo-select="${escapeHtml(key)}"
            ${selected ? "checked" : ""}
          />
          <span>Upload</span>
        </label>
        <button type="button" data-return-photo-index="${index}" title="Open return photo">
          <img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl || "")}" alt="${escapeHtml(photo.label || `Return photo ${index + 1}`)}" />
          <span>${escapeHtml(photo.label || `Return photo ${index + 1}`)}</span>
        </button>
      </article>
    `;
  }).join("");

  grid.querySelectorAll("[data-return-photo-index]").forEach((button) => {
    button.addEventListener("click", () => {
      openReturnEvidencePhotoViewer(Number(button.dataset.returnPhotoIndex || 0));
    });
  });
  grid.querySelectorAll("[data-return-photo-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      setReturnEvidencePhotoSelected(checkbox.dataset.returnPhotoSelect, checkbox.checked);
    });
  });
  updateReturnEvidencePhotoSelectionSummary();
}

function updateReturnEvidencePhotoSelectionSummary() {
  const summary = $("return-photo-selection-summary");
  if (!summary) return;
  const total = state.returnEvidencePhotos.length;
  const selected = getSelectedReturnEvidencePhotos().length;
  summary.textContent = total
    ? `${selected} of ${total} photo${total === 1 ? "" : "s"} selected for this return.`
    : "";
}

function openReturnEvidencePhotoViewer(index) {
  const photo = state.returnEvidencePhotos[index];
  if (!photo?.previewUrl) return;
  openEvidencePhotoViewer(
    photo.previewUrl,
    photo.label || `Return photo ${index + 1}`,
    `${photo.bucket}/${photo.path}`
  );
}

function scrollReturnConfirmIntoView() {
  const actions = $("confirm-return-intake")?.closest(".history-modal-actions");
  if (!actions || $("return-intake-modal")?.classList.contains("hidden")) return;
  actions.scrollIntoView({ behavior: "smooth", block: "end" });
  setTimeout(() => $("confirm-return-intake")?.focus(), 350);
}

async function requestReturnEvidencePhoto() {
  if (state.returnCaptureBusy) return;
  try {
    state.returnCaptureBusy = true;
    $("request-return-photo")?.toggleAttribute("disabled", true);

    if (!state.returnCaptureStations.length) {
      await loadReturnCaptureStations({ silent: true });
    }

    const station = getSelectedReturnCaptureStation();
    if (!station) {
      setReturnPhotoStatus("Choose a camera station before taking return photos.", "error");
      $("return-capture-station")?.focus();
      return;
    }

    const lines = getReturnModalLines();
    const orderNumbers = [...new Set(lines.map((line) => line.order?.order_number).filter(Boolean))];
    setReturnPhotoStatus(`Sending camera request to ${station.name || "selected station"}...`, "info");
    const job = await createReturnCaptureJob(station.id);

    window.dispatchEvent(new CustomEvent("assisted:iphone-capture-requested", {
      detail: {
        source: "ebay-return-intake",
        stationId: station.id,
        stationName: station.name || "",
        jobId: job.id,
        orderLineIds: [...state.returnSelectedLineIds],
        orderNumbers,
      },
    }));

    const completedJob = await pollReturnCaptureJob(job, station);
    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || completedJob.failure_code || "Capture failed.");
    }

    let photoRows = await loadReturnCaptureJobPhotos(completedJob.id);
    if (!photoRows.length && completedJob.storage_bucket && completedJob.storage_path) {
      photoRows = [{
        capture_job_id: completedJob.id,
        storage_bucket: completedJob.storage_bucket,
        storage_path: completedJob.storage_path,
        mime_type: completedJob.mime_type || "image/jpeg",
        file_size_bytes: completedJob.file_size_bytes || 0,
        label: "Return photo",
      }];
    }
    if (!photoRows.length) throw new Error("Camera completed, but no uploaded photos were returned.");

    const photos = await returnCaptureRowsToEvidencePhotos(photoRows);
    const existing = new Set(state.returnEvidencePhotos.map(getReturnEvidencePhotoKey));
    photos.forEach((photo) => {
      const key = getReturnEvidencePhotoKey(photo);
      if (!existing.has(key)) {
        state.returnEvidencePhotos.push(photo);
        state.returnEvidencePhotoUploadKeys.add(key);
      }
    });
    renderReturnEvidencePhotos();
    setReturnPhotoStatus(`${photos.length} return photo${photos.length === 1 ? "" : "s"} added and selected for saving.`, "success");
    scrollReturnConfirmIntoView();
  } catch (error) {
    console.error("Return evidence capture failed:", error);
    setReturnPhotoStatus(error?.message || "Could not take return photo.", "error");
  } finally {
    state.returnCaptureBusy = false;
    $("request-return-photo")?.toggleAttribute("disabled", false);
  }
}

function renderReturnLineList() {
  const list = $("return-line-list");
  if (!list) return;
  const lines = getReturnModalLines();
  if (!lines.length) {
    list.innerHTML = `<div class="history-empty">No shipped lines are available for return intake.</div>`;
    return;
  }

  list.innerHTML = lines.map((line) => {
    const checked = state.returnSelectedLineIds.has(line.id);
    const hasInventoryItem = Boolean(line.internal_item_id);
    const priorReturns = getReturnItemsForLine(line.id);
    const orderNumber = line.order?.order_number || "No order";
    return `
      <article class="return-line-card ${checked ? "is-selected" : ""}" data-return-line-card="${escapeHtml(line.id)}">
        <label class="return-line-check">
          <input type="checkbox" data-return-line-select="${escapeHtml(line.id)}" ${checked ? "checked" : ""} />
          <span>
            <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
            <small>${escapeHtml(orderNumber)} - Qty shipped ${Number(line.fulfilled_quantity || line.quantity || 1).toLocaleString()}${priorReturns.length ? ` - ${priorReturns.length} prior return record${priorReturns.length === 1 ? "" : "s"}` : ""}</small>
          </span>
        </label>
        <div class="return-line-fields">
          <label>
            Qty received
            <input type="number" min="0" max="${Number(line.fulfilled_quantity || line.quantity || 1)}" step="1" value="${Number(line.fulfilled_quantity || line.quantity || 1)}" data-return-qty="${escapeHtml(line.id)}" />
          </label>
          <label>
            Condition
            <select data-return-condition="${escapeHtml(line.id)}">
              <option value="used_good">Good / sellable</option>
              <option value="new">New / unopened</option>
              <option value="damaged">Damaged</option>
              <option value="missing_parts">Missing parts</option>
              <option value="wrong_item">Wrong item</option>
              <option value="unknown">Unknown</option>
            </select>
          </label>
          <label>
            Disposition
            <select data-return-disposition="${escapeHtml(line.id)}">
              <option value="quarantine">Quarantine / hold</option>
              ${hasInventoryItem ? `<option value="restock">Restock to selected location</option>` : ""}
              <option value="damaged">Damaged / do not restock</option>
              <option value="wrong_item">Wrong item</option>
              <option value="refund_only">Refund only / no item</option>
              <option value="missing">Missing from return package</option>
              <option value="admin_review">Needs admin review</option>
            </select>
          </label>
        </div>
        <label class="return-line-note">
          Item note
          <input type="text" data-return-line-note="${escapeHtml(line.id)}" placeholder="Optional note for this returned item" />
        </label>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-return-line-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.returnSelectedLineIds.add(checkbox.dataset.returnLineSelect);
      else state.returnSelectedLineIds.delete(checkbox.dataset.returnLineSelect);
      renderReturnLineList();
    });
  });
}

function openReturnIntakeModal(lineIds = []) {
  const uniqueIds = [...new Set(lineIds.filter(Boolean))];
  if (!uniqueIds.length) return;
  state.returnModalLineIds = uniqueIds;
  state.returnSelectedLineIds = new Set(uniqueIds);
  state.returnDestinationLocation = null;
  state.returnEvidencePhotos = [];
  state.returnEvidencePhotoUploadKeys.clear();

  const lines = getReturnModalLines();
  const orderNumbers = [...new Set(lines.map((line) => line.order?.order_number).filter(Boolean))];
  $("return-intake-title").textContent = orderNumbers.length === 1 ? `Return ${orderNumbers[0]}` : "Start grouped return";
  $("return-intake-subtitle").textContent = `${lines.length} shipped line${lines.length === 1 ? "" : "s"} available. Restock only after photo proof and inspection.`;
  $("return-reason").value = "";
  $("return-tracking").value = "";
  $("return-ebay-id").value = "";
  $("return-destination-scan").value = "";
  $("return-note").value = "";
  $("return-evidence-photo").value = "";
  $("return-error").textContent = "";
  $("return-location-results").innerHTML = "";
  setReturnIntakeStatus("Select returned lines, attach evidence photos, and choose the disposition.");
  setReturnPhotoStatus("Choose a station, then take photos with the OG app.");
  renderReturnDestinationSummary();
  renderReturnCaptureStations();
  renderReturnEvidencePhotos();
  renderReturnEvidencePhotoList();
  renderReturnLineList();
  openModal("return-intake-modal");
  loadReturnCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not preload return capture stations:", error);
    setReturnPhotoStatus(error.message || "Could not load capture stations.", "error");
  });
  setTimeout(() => $("return-tracking")?.focus(), 80);
}

function closeReturnIntakeModal() {
  state.returnModalLineIds = [];
  state.returnSelectedLineIds = new Set();
  state.returnDestinationLocation = null;
  state.returnEvidencePhotos = [];
  state.returnEvidencePhotoUploadKeys.clear();
  state.activeReturnTransfer = null;
  renderReturnEvidencePhotos();
  closeModal("return-intake-modal");
}

function getReturnTransferInfo(payload = {}) {
  return payload.return || payload.metadata || payload || {};
}

function normalizeReturnLookup(value) {
  return String(value || "").trim().toLowerCase();
}

function mapEbayReturnReasonToValue(reason = "") {
  const text = normalizeReturnLookup(reason);
  if (!text) return "";
  if (/description|photo|not as described|doesn.?t match/.test(text)) return "not_as_described";
  if (/changed|mind|no longer|don.?t want/.test(text)) return "buyer_changed_mind";
  if (/damaged|broken/.test(text)) return "damaged";
  if (/wrong item|incorrect item/.test(text)) return "wrong_item";
  if (/missing|parts|piece/.test(text)) return "missing_parts";
  return "other";
}

function buildReturnTransferNote(info = {}) {
  return [
    info.returnStatus ? `eBay status: ${info.returnStatus}` : "",
    info.returnAction ? `eBay action: ${info.returnAction}` : "",
    info.returnInitiated ? `Requested: ${info.returnInitiated}` : "",
    info.refundText ? `Refund: ${info.refundText}` : "",
    info.requestAmount ? `Request amount: ${info.requestAmount}` : "",
    info.onHoldAmount ? `On hold: ${info.onHoldAmount}` : "",
    info.buyerComment ? `Buyer comment: ${info.buyerComment}` : "",
    info.videoReceiptUrl ? `Video receipt: ${info.videoReceiptUrl}` : "",
    info.detailsUrl ? `Details: ${info.detailsUrl}` : "",
    info.orderDetailsUrl ? `Order details: ${info.orderDetailsUrl}` : "",
    info.pageUrl ? `Captured from: ${info.pageUrl}` : "",
  ].filter(Boolean).join("\n");
}

function buildUnmatchedReturnTransferNote(info = {}) {
  return [
    "No matching OG fulfilled order history was found for this eBay return/refund. Treat this as a legacy/unmatched review task.",
    buildReturnTransferNote(info),
  ].filter(Boolean).join("\n");
}

function returnTransferMatchesLine(info = {}, line = {}) {
  const itemNumber = normalizeReturnLookup(info.itemNumber);
  const transactionId = normalizeReturnLookup(info.transactionId);
  const buyer = normalizeReturnLookup(info.buyerUsername);
  const title = normalizeReturnLookup(info.itemTitle);
  if (transactionId && normalizeReturnLookup(line.transaction_id) === transactionId) return true;
  if (itemNumber && normalizeReturnLookup(line.item_number) !== itemNumber) return false;
  if (buyer && normalizeReturnLookup(line.order?.buyer_username) !== buyer) return false;
  if (!itemNumber && title && normalizeReturnLookup(line.item_title) !== title) return false;
  return Boolean(itemNumber || title);
}

function mergeHistoryLines(rows = []) {
  const byId = new Map(state.lines.map((line) => [line.id, line]));
  rows.map(normalizeLine).forEach((line) => {
    if (line.id) byId.set(line.id, line);
  });
  state.lines = [...byId.values()];
}

async function fetchReturnTransferLines(info = {}) {
  const transactionId = String(info.transactionId || "").trim();
  const itemNumber = String(info.itemNumber || "").trim();
  if (!transactionId && !itemNumber) return [];

  let query = supabase
    .from("ebay_order_lines")
    .select(ORDER_HISTORY_LINE_SELECT)
    .eq("line_status", "fulfilled")
    .order("fulfilled_at", { ascending: false })
    .limit(50);

  query = transactionId ? query.eq("transaction_id", transactionId) : query.eq("item_number", itemNumber);
  const { data, error } = await query;
  if (error) throw error;
  const normalized = (data || []).map(normalizeLine);
  return normalized.filter((line) => returnTransferMatchesLine(info, line));
}

async function findReturnTransferLines(payload = {}) {
  const info = getReturnTransferInfo(payload);
  let matches = state.lines.filter((line) => returnTransferMatchesLine(info, line));
  if (!matches.length) {
    const fetched = await fetchReturnTransferLines(info);
    if (fetched.length) {
      mergeHistoryLines(fetched);
      matches = fetched;
    }
  }
  if (!matches.length) return [];

  if (info.transactionId) return matches.slice(0, 1);
  const buyer = normalizeReturnLookup(info.buyerUsername);
  const itemNumber = normalizeReturnLookup(info.itemNumber);
  return matches
    .filter((line) => !buyer || normalizeReturnLookup(line.order?.buyer_username) === buyer)
    .filter((line) => !itemNumber || normalizeReturnLookup(line.item_number) === itemNumber)
    .sort((a, b) => new Date(b.fulfilled_at || 0) - new Date(a.fulfilled_at || 0))
    .slice(0, 5);
}

function isReturnBatchTransfer(payload = {}) {
  return Array.isArray(payload.returns) && payload.returns.length > 0;
}

function buildReturnBatchItemPayload(payload = {}, returnInfo = {}, index = 0) {
  const metadata = payload.metadata || {};
  const returnId = returnInfo.returnId || "";
  const itemNumber = returnInfo.itemNumber || "";
  return {
    return: {
      ...returnInfo,
      batchTransferId: payload.transferId || "",
      batchIndex: index + 1,
      batchReturnCount: Array.isArray(payload.returns) ? payload.returns.length : 0,
      pageUrl: returnInfo.pageUrl || metadata.pageUrl || "",
      pageTitle: returnInfo.pageTitle || metadata.pageTitle || "",
      capturedAt: returnInfo.capturedAt || metadata.capturedAt || new Date().toISOString(),
    },
    metadata: {
      ...metadata,
      source: "ebay-returns-page-batch-item",
      batchTransferId: payload.transferId || "",
      batchIndex: index + 1,
      returnId,
      itemNumber,
      buyerUsername: returnInfo.buyerUsername || "",
      transactionId: returnInfo.transactionId || "",
      pageUrl: returnInfo.pageUrl || metadata.pageUrl || "",
      capturedAt: returnInfo.capturedAt || metadata.capturedAt || new Date().toISOString(),
    },
    transferId: payload.transferId
      ? `${payload.transferId}:${returnId || itemNumber || index + 1}`
      : "",
  };
}

function applyReturnTransferPrefill(payload = {}, lines = []) {
  const info = getReturnTransferInfo(payload);
  state.activeReturnTransfer = payload;
  $("return-ebay-id").value = info.returnId || "";
  $("return-reason").value = mapEbayReturnReasonToValue(info.returnReason);
  const note = buildReturnTransferNote(info);
  $("return-note").value = note;
  const buyer = info.buyerUsername || lines[0]?.order?.buyer_username || "buyer";
  const item = info.itemNumber || lines[0]?.item_number || "item";
  setReturnIntakeStatus(`Matched eBay return ${info.returnId || ""} for ${buyer} / ${item}. Add return photos, inspect the item, then save.`, "success");
  const search = $("history-search");
  if (search) {
    search.value = info.itemNumber || info.buyerUsername || info.returnId || "";
    state.historySearchUserEdited = true;
  }
  if ($("history-status")) $("history-status").value = "all";
  if ($("history-label-filter")) $("history-label-filter").value = "all";
  if (!isReturnsWorkbenchPage() && $("history-list")) applyFilters();
}

function isClosedReturnTask(task = null) {
  return Boolean(task && ["resolved", "cancelled"].includes(task.status));
}

function getReturnTaskPayload(task = {}) {
  const returnCase = getReturnTaskCase(task);
  return {
    ...(task.metadata || {}),
    ...(returnCase.raw_payload || {}),
  };
}

function parseReturnDateText(value = "", referenceValue = "") {
  const text = String(value || "").trim();
  if (!text) return null;
  const match = text.match(/\b([A-Za-z]{3,9})\s+(\d{1,2})(?:,\s*(\d{4}))?\b/);
  if (!match) return null;

  const monthNames = {
    jan: 0, january: 0,
    feb: 1, february: 1,
    mar: 2, march: 2,
    apr: 3, april: 3,
    may: 4,
    jun: 5, june: 5,
    jul: 6, july: 6,
    aug: 7, august: 7,
    sep: 8, sept: 8, september: 8,
    oct: 9, october: 9,
    nov: 10, november: 10,
    dec: 11, december: 11,
  };
  const month = monthNames[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (month === undefined || !day) return null;

  const reference = referenceValue ? parseReturnDateText(referenceValue) : null;
  let year = match[3] ? Number(match[3]) : reference?.getFullYear?.() || new Date().getFullYear();
  let date = new Date(year, month, day, 23, 59, 59, 999);
  if (!match[3] && reference && date < reference) {
    year += 1;
    date = new Date(year, month, day, 23, 59, 59, 999);
  }
  return Number.isNaN(date.getTime()) ? null : date;
}

function getReturnTaskDueInfo(task = {}) {
  const metadata = getReturnTaskPayload(task);
  const rawDue = task.due_at || metadata.returnDueAt || metadata.return_due_at || "";
  const parsedDue = rawDue ? new Date(rawDue) : parseReturnDateText(metadata.returnAction || metadata.return_action, metadata.returnInitiated || metadata.return_initiated);
  const hasDue = parsedDue && !Number.isNaN(parsedDue.getTime());
  const actionText = metadata.returnAction || metadata.return_action || "";
  return {
    date: hasDue ? parsedDue : null,
    iso: hasDue ? parsedDue.toISOString() : "",
    label: hasDue ? formatDateOnly(parsedDue) : "No response deadline captured",
    sourceText: actionText || (task.due_at ? "OG task due date" : ""),
  };
}

function getReturnTaskRequestedLabel(task = {}) {
  const metadata = getReturnTaskPayload(task);
  const requested = metadata.returnInitiated || metadata.return_initiated || "";
  const requestedDate = parseReturnDateText(requested);
  if (requestedDate) return formatDateOnly(requestedDate);
  return requested || formatDateOnly(getReturnTaskCase(task).opened_at);
}

function sanitizeReturnComplaintImageRecord(image = {}) {
  const copy = { ...(image || {}) };
  delete copy.base64;
  delete copy.dataUrl;
  delete copy.blobUrl;
  delete copy.url;
  return copy;
}

function sanitizeReturnTransferForStorage(value) {
  if (Array.isArray(value)) return value.map(sanitizeReturnTransferForStorage);
  if (!value || typeof value !== "object") return value;
  const output = {};
  Object.entries(value).forEach(([key, entry]) => {
    if (key === "base64" || key === "dataUrl") return;
    if (key === "complaintImages" || key === "ebayComplaintImages") {
      output[key] = Array.isArray(entry) ? entry.map(sanitizeReturnComplaintImageRecord) : [];
      return;
    }
    output[key] = sanitizeReturnTransferForStorage(entry);
  });
  return output;
}

function getReturnTransferComplaintImages(payload = {}) {
  const info = getReturnTransferInfo(payload);
  const detail = info.returnDetails || {};
  const images = [
    ...(Array.isArray(info.complaintImages) ? info.complaintImages : []),
    ...(Array.isArray(detail.complaintImages) ? detail.complaintImages : []),
  ].filter((image) => image?.base64);
  const byKey = new Map();
  images.forEach((image, index) => {
    const key = image.returnFileId || image.fileId || `${image.mimeType || ""}:${image.size || ""}:${index}`;
    if (!byKey.has(key)) byKey.set(key, image);
  });
  return [...byKey.values()];
}

function getReturnComplaintImageExtension(image = {}, blob = null) {
  const value = `${image.filename || ""} ${image.mimeType || image.mime_type || ""} ${blob?.type || ""}`.toLowerCase();
  if (value.includes("png")) return "png";
  if (value.includes("webp")) return "webp";
  if (value.includes("gif")) return "gif";
  if (value.includes("heic")) return "heic";
  if (value.includes("heif")) return "heif";
  return "jpg";
}

async function uploadEbayComplaintImagesFromTransfer(payload = {}) {
  const images = getReturnTransferComplaintImages(payload);
  if (!images.length) return [];
  const info = getReturnTransferInfo(payload);
  const returnSegment = safeStorageSegment(info.returnId || info.itemNumber || info.buyerUsername || "return", "return");
  const uploaded = [];

  for (let index = 0; index < images.length; index += 1) {
    const image = images[index];
    const blob = base64ToBlob(image.base64, image.mimeType || image.mime_type || "image/jpeg");
    const extension = getReturnComplaintImageExtension(image, blob);
    const imageSegment = safeStorageSegment(image.returnFileId || image.fileId || `photo-${index + 1}`, `photo-${index + 1}`);
    const path = [
      "returns",
      "ebay-complaints",
      returnSegment,
      `${imageSegment}.${extension}`,
    ].join("/");

    const { error } = await supabase.storage
      .from(EBAY_RETURN_EVIDENCE_BUCKET)
      .upload(path, blob, {
        contentType: blob.type || image.mimeType || "image/jpeg",
        upsert: false,
      });
    if (error && !/already exists|duplicate|exists/i.test(error.message || "")) {
      throw new Error(error.message || `Could not save eBay complaint photo ${index + 1}.`);
    }
    uploaded.push({
      bucket: EBAY_RETURN_EVIDENCE_BUCKET,
      path,
      source: "ebay_buyer_complaint",
      returnFileId: image.returnFileId || null,
      fileId: image.fileId || null,
      sortOrder: index,
      label: `Buyer complaint photo ${index + 1}`,
      mime_type: blob.type || image.mimeType || "image/jpeg",
      size_bytes: blob.size || image.size || 0,
      uploaded_at: new Date().toISOString(),
    });
  }

  return uploaded;
}

function buildReturnExportMetadataPatch(payload = {}, options = {}) {
  const info = getReturnTransferInfo(payload);
  const detail = sanitizeReturnTransferForStorage(info.returnDetails || {});
  const uploadedComplaintImages = Array.isArray(options.complaintImages) ? options.complaintImages : [];
  const capturedComplaintImages = getReturnTransferComplaintImages(payload).map(sanitizeReturnComplaintImageRecord);
  const complaintImages = uploadedComplaintImages.length ? uploadedComplaintImages : capturedComplaintImages;
  const dueInfo = {
    date: parseReturnDateText(info.returnAction, info.returnInitiated),
  };
  const dueAt = dueInfo.date && !Number.isNaN(dueInfo.date.getTime()) ? dueInfo.date.toISOString() : "";
  const refundAmount = parseMoney(info.refundText);
  return {
    returnDueAt: dueAt || null,
    returnDueText: info.returnAction || null,
    refundAmount: refundAmount || null,
    buyerComment: info.buyerComment || detail.buyerComment || null,
    requestAmount: info.requestAmount || detail.requestAmount || null,
    onHoldAmount: info.onHoldAmount || detail.onHoldAmount || null,
    orderDetailsUrl: info.orderDetailsUrl || detail.orderDetailsUrl || null,
    videoReceiptUrl: info.videoReceiptUrl || detail.videoReceiptUrl || null,
    itemImageUrl: info.itemImageUrl || detail.itemImageUrl || null,
    datePurchased: info.datePurchased || detail.datePurchased || null,
    returnFileIds: info.returnFileIds || detail.returnFileIds || [],
    complaintBlobUrls: info.complaintBlobUrls || detail.complaintBlobUrls || [],
    complaintImages,
    complaintImageCount: complaintImages.length || Number(detail.complaintImageCount || 0) || null,
    returnDetails: {
      ...(detail || {}),
      complaintImages,
      complaintImageCount: complaintImages.length || Number(detail.complaintImageCount || 0) || null,
    },
    exportMetadataUpdatedAt: new Date().toISOString(),
  };
}

async function enrichReturnTaskFromTransfer(taskId, payload = {}) {
  if (!taskId) return null;
  let complaintImages = [];
  try {
    complaintImages = await uploadEbayComplaintImagesFromTransfer(payload);
  } catch (error) {
    console.warn("Could not upload eBay complaint photos:", error);
  }
  const patch = buildReturnExportMetadataPatch(payload, { complaintImages });
  const dueAt = patch.returnDueAt || null;
  const hasPatch = Object.values(patch).some((value) => value !== null && value !== "");
  if (!hasPatch && !dueAt) return null;

  const { data, error } = await supabase.rpc("update_ebay_return_task_export_metadata", {
    _task_id: taskId,
    _due_at: dueAt,
    _metadata_patch: patch,
    _notes: "Return metadata updated from eBay return export.",
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  return data || null;
}

function findExistingReturnTaskForTransfer(payload = {}, lines = [], taskType = "") {
  const info = getReturnTransferInfo(payload);
  const returnId = normalizeReturnLookup(info.returnId || payload.metadata?.returnId);
  const buyer = normalizeReturnLookup(info.buyerUsername || payload.metadata?.buyerUsername);
  const itemNumber = normalizeReturnLookup(info.itemNumber || payload.metadata?.itemNumber);
  const orderIds = new Set(lines.map((line) => line.order?.id || line.order_id).filter(Boolean));

  return state.returnTasks.find((task) => {
    if (taskType && task.task_type !== taskType) return false;
    const returnCase = getReturnTaskCase(task);
    const metadata = getReturnTaskPayload(task);
    const taskReturnId = normalizeReturnLookup(returnCase.ebay_return_id || metadata.returnId || metadata.ebayReturnId);
    if (returnId && taskReturnId && taskReturnId !== returnId) return false;

    if (taskType === "return_intake") {
      return Boolean(
        returnId && taskReturnId === returnId
        || orderIds.has(task.order_id)
        || orderIds.has(returnCase.order_id)
      );
    }

    if (taskType === "return_review") {
      if (returnCase.case_type !== "unmatched_legacy" && metadata.caseType !== "unmatched_legacy") return false;
      if (returnId && taskReturnId === returnId) return true;
      const taskBuyer = normalizeReturnLookup(returnCase.buyer_username || metadata.buyerUsername);
      const taskItem = normalizeReturnLookup(metadata.itemNumber || metadata.item_number);
      return Boolean(itemNumber && buyer && taskItem === itemNumber && taskBuyer === buyer);
    }

    return Boolean(returnId && taskReturnId === returnId);
  }) || null;
}

async function ensureReturnTaskForTransfer(payload = {}, lines = [], options = {}) {
  const info = getReturnTransferInfo(payload);
  const storedInfo = sanitizeReturnTransferForStorage(info);
  const firstLine = lines[0];
  const order = firstLine?.order || {};
  if (!order.id) return null;
  const lineIds = lines.map((line) => line.id).filter(Boolean);
  const existingTask = findExistingReturnTaskForTransfer(payload, lines, "return_intake");
  if (isClosedReturnTask(existingTask)) {
    return {
      return_case_id: existingTask.return_case_id || getReturnTaskCase(existingTask).id || null,
      task_id: existingTask.id,
      duplicateResolved: true,
      taskStatus: existingTask.status,
    };
  }
  const { data, error } = await supabase.rpc("open_ebay_return_case", {
    _order_id: order.id,
    _order_line_ids: lineIds,
    _order_number: order.order_number || null,
    _ebay_return_id: info.returnId || null,
    _buyer_username: info.buyerUsername || order.buyer_username || null,
    _return_reason: info.returnReason || null,
    _notes: buildReturnTransferNote(info) || null,
    _raw_payload: {
      ...(storedInfo || {}),
      transferId: payload.transferId || null,
      matchedLineIds: lineIds,
      matchedOrderNumber: order.order_number || null,
    },
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] || {} : data || {};
  if (result.task_id) {
    await enrichReturnTaskFromTransfer(result.task_id, payload).catch((metadataError) => {
      console.warn("Could not save parsed eBay return deadline/value metadata:", metadataError);
    });
  }
  if (options.refreshQueue !== false) {
    await loadReturnQueue().catch((queueError) => {
      console.warn("Could not refresh return task queue after opening eBay return:", queueError);
    });
  }
  return result;
}

async function ensureUnmatchedReturnTaskForTransfer(payload = {}, options = {}) {
  const info = getReturnTransferInfo(payload);
  const metadata = payload.metadata || {};
  const existingTask = findExistingReturnTaskForTransfer(payload, [], "return_review");
  if (isClosedReturnTask(existingTask)) {
    return {
      return_case_id: existingTask.return_case_id || getReturnTaskCase(existingTask).id || null,
      task_id: existingTask.id,
      duplicateResolved: true,
      taskStatus: existingTask.status,
    };
  }
  const storedInfo = sanitizeReturnTransferForStorage(info);
  const storedMetadata = sanitizeReturnTransferForStorage(metadata);
  const rawPayload = {
    ...storedMetadata,
    ...storedInfo,
    transferId: payload.transferId || null,
    matchedLineIds: [],
    unmatchedReason: "No matching fulfilled OG order line was found.",
  };
  const { data, error } = await supabase.rpc("open_unmatched_ebay_return_case", {
    _ebay_return_id: info.returnId || metadata.returnId || null,
    _buyer_username: info.buyerUsername || metadata.buyerUsername || null,
    _item_number: info.itemNumber || metadata.itemNumber || null,
    _item_title: info.itemTitle || metadata.itemTitle || null,
    _transaction_id: info.transactionId || metadata.transactionId || null,
    _return_reason: info.returnReason || metadata.returnReason || null,
    _return_status: info.returnStatus || metadata.returnStatus || null,
    _return_action: info.returnAction || metadata.returnAction || null,
    _return_initiated: info.returnInitiated || metadata.returnInitiated || null,
    _refund_text: info.refundText || metadata.refundText || null,
    _details_url: info.detailsUrl || metadata.detailsUrl || null,
    _page_url: info.pageUrl || metadata.pageUrl || null,
    _notes: buildUnmatchedReturnTransferNote(info) || null,
    _raw_payload: rawPayload,
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  const result = Array.isArray(data) ? data[0] || {} : data || {};
  if (result.task_id) {
    await enrichReturnTaskFromTransfer(result.task_id, payload).catch((metadataError) => {
      console.warn("Could not save parsed unmatched eBay return deadline/value metadata:", metadataError);
    });
  }
  if (options.refreshQueue !== false) {
    await loadReturnQueue().catch((queueError) => {
      console.warn("Could not refresh return task queue after opening unmatched eBay return:", queueError);
    });
  }
  return result;
}

function getReturnLineField(attribute, lineId) {
  return [...document.querySelectorAll(`[${attribute}]`)]
    .find((element) => element.getAttribute(attribute) === lineId) || null;
}

async function confirmReturnIntake() {
  if (state.busy) return;
  const selectedLines = getReturnModalLines().filter((line) => state.returnSelectedLineIds.has(line.id));
  const errorEl = $("return-error");
  const files = [...($("return-evidence-photo")?.files || [])];
  const selectedPhotos = getSelectedReturnEvidencePhotos();

  if (!selectedLines.length) {
    if (errorEl) errorEl.textContent = "Select at least one returned line.";
    return;
  }
  if (!files.length && !selectedPhotos.length) {
    if (errorEl) errorEl.textContent = "Attach at least one return evidence photo.";
    return;
  }

  const returnItems = selectedLines.map((line) => {
    const disposition = getReturnLineField("data-return-disposition", line.id)?.value || "admin_review";
    return {
      order_line_id: line.id,
      received_quantity: Number(getReturnLineField("data-return-qty", line.id)?.value || 0),
      condition_received: getReturnLineField("data-return-condition", line.id)?.value || "unknown",
      disposition,
      destination_location_id: disposition === "restock" ? state.returnDestinationLocation?.id || null : null,
      notes: getReturnLineField("data-return-line-note", line.id)?.value || "",
    };
  });

  const needsRestockDestination = returnItems.some((item) => item.disposition === "restock");
  if (needsRestockDestination && !state.returnDestinationLocation?.id) {
    if (errorEl) errorEl.textContent = "Choose a restock destination before saving restocked items.";
    $("return-destination-scan")?.focus();
    return;
  }

  try {
    state.busy = true;
    $("confirm-return-intake").disabled = true;
    if (errorEl) errorEl.textContent = "";
    setReturnIntakeStatus("Uploading return evidence photos...");

    const orderNumbers = [...new Set(selectedLines.map((line) => line.order?.order_number).filter(Boolean))];
    const evidencePhotos = await persistReturnEvidencePhotos(files, orderNumbers);

    setReturnIntakeStatus("Saving return and inventory audit...");
    const { data, error } = await supabase.rpc("receive_ebay_return", {
      _return_items: returnItems,
      _return_reason: $("return-reason")?.value || null,
      _return_tracking_number: $("return-tracking")?.value || null,
      _ebay_return_id: $("return-ebay-id")?.value || null,
      _notes: $("return-note")?.value || null,
      _evidence_photos: evidencePhotos,
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;

    const result = Array.isArray(data) ? data[0] || {} : data || {};
    const returnCaseIds = Array.isArray(result.return_case_ids) ? result.return_case_ids : [];
    if (returnCaseIds.length) {
      await supabase.rpc("sync_ebay_return_tasks_after_intake", {
        _return_case_ids: returnCaseIds,
        _notes: "Return intake saved from OG.",
        _signed_by_email: state.user?.email || null,
      }).catch((syncError) => {
        console.warn("Could not sync return task queue after intake:", syncError);
      });
    }
    setReturnIntakeStatus(`Return saved. ${Number(result.restocked_units || 0).toLocaleString()} unit${Number(result.restocked_units || 0) === 1 ? "" : "s"} restocked.`, "success");
    closeReturnIntakeModal();
    if (!isReturnsWorkbenchPage()) await loadOrderHistory();
    await loadReturnQueue();
  } catch (error) {
    console.error("Return intake failed:", error);
    if (errorEl) errorEl.textContent = error.message || "Could not save this return.";
    setReturnIntakeStatus(error.message || "Could not save this return.", "error");
  } finally {
    state.busy = false;
    $("confirm-return-intake").disabled = false;
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

function getHistoryLabelOrderDetails(orderNumbers = []) {
  const wanted = parseHistoryOrderNumbers(orderNumbers);
  const lineGroups = new Map();
  getHistoryLinesByOrderNumbers(wanted).forEach((line) => {
    const orderNumber = normalizeEbayOrderNumber(line.order?.order_number);
    if (!orderNumber) return;
    if (!lineGroups.has(orderNumber)) {
      lineGroups.set(orderNumber, {
        orderNumber,
        buyerUsername: line.order?.buyer_username || "",
        salesRecordNumber: line.order?.sales_record_number || "",
        itemNumbers: new Set(),
        transactionIds: new Set(),
      });
    }
    const group = lineGroups.get(orderNumber);
    if (!group.buyerUsername && line.order?.buyer_username) group.buyerUsername = line.order.buyer_username;
    if (!group.salesRecordNumber && line.order?.sales_record_number) group.salesRecordNumber = line.order.sales_record_number;
    if (line.item_number) group.itemNumbers.add(line.item_number);
    if (line.transaction_id) group.transactionIds.add(line.transaction_id);
  });

  return wanted.map((orderNumber) => lineGroups.get(orderNumber) || {
    orderNumber,
    buyerUsername: "",
    salesRecordNumber: "",
    itemNumbers: new Set(),
    transactionIds: new Set(),
  });
}

function renderHistoryLabelOrderList(orderNumbers = []) {
  const details = getHistoryLabelOrderDetails(orderNumbers);
  if (!details.length) return "";

  return `
    <div class="history-label-order-list" aria-label="Orders covered by this shipping label">
      ${details.map((entry) => {
        const itemNumbers = [...entry.itemNumbers].filter(Boolean);
        const transactionIds = [...entry.transactionIds].filter(Boolean);
        return `
          <article>
            <strong>${escapeHtml(entry.buyerUsername || "No buyer username")}</strong>
            <span>Order: ${escapeHtml(entry.orderNumber || "-")}</span>
            <span>Action #: ${escapeHtml(itemNumbers.join(", ") || transactionIds.join(", ") || "-")}</span>
            ${entry.salesRecordNumber ? `<span>Sales record: ${escapeHtml(entry.salesRecordNumber)}</span>` : ""}
          </article>
        `;
      }).join("")}
    </div>
  `;
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

function setHistoryExtraLabelButtonVisible(visible) {
  const button = $("add-extra-history-label");
  if (!button) return;
  button.classList.toggle("hidden", !visible);
  button.toggleAttribute("disabled", !visible || !getHistoryExtraLabelPhotoFiles().length);
}

function getHistoryExtraLabelPhotoFiles() {
  return [...($("history-extra-label-photo")?.files || [])].filter((file) => file?.type?.startsWith("image/"));
}

function resetHistoryExtraLabelPhotoPanel() {
  const input = $("history-extra-label-photo");
  if (input) input.value = "";
  const list = $("history-extra-label-photo-list");
  if (list) list.innerHTML = "";
  $("history-extra-label-photo-panel")?.classList.add("hidden");
  setHistoryExtraLabelButtonVisible(false);
}

function showHistoryExtraLabelPhotoPanel() {
  $("history-extra-label-photo-panel")?.classList.remove("hidden");
  renderHistoryExtraLabelPhotoList();
}

function renderHistoryExtraLabelPhotoList() {
  const files = getHistoryExtraLabelPhotoFiles();
  const list = $("history-extra-label-photo-list");
  if (list) {
    list.innerHTML = files.length
      ? files.map((file) => `<span>${escapeHtml(file.name || "Missing item photo")}</span>`).join("")
      : `<span>Photo required before saving extra label</span>`;
  }
  setHistoryExtraLabelButtonVisible(Boolean(state.pendingHistoryExtraLabelTransfer));
}

function renderHistoryLabelDetails(target = state.awaitingLabelGroup) {
  const details = $("history-label-details");
  const preview = $("preview-history-label");
  if (!details) return;
  const order = getAwaitingHistoryLabelOrder(target);
  const metadata = order?.label_metadata || {};
  const size = formatFileSize(metadata.size);
  const trackingText = getLabelTrackingDisplay(metadata);
  const labelPath = order?.label_file_path || "";
  const orderNumbers = target?.orderNumbers?.length ? target.orderNumbers : parseHistoryOrderNumbers(order?.order_number);
  const orderCount = orderNumbers.length || 1;
  const orderWord = orderCount === 1 ? "order" : "orders";
  preview?.classList.toggle("hidden", !labelPath);
  preview?.toggleAttribute("disabled", !labelPath);
  details.innerHTML = labelPath
    ? `
      <span><strong>Orders:</strong> ${escapeHtml(orderNumbers.join(", ") || order?.order_number || "-")}</span>
      ${renderHistoryLabelOrderList(orderNumbers)}
      ${renderExtraLabelEvents(orderNumbers)}
      <span><strong>Label:</strong> Attached ${escapeHtml(formatDateTime(order.label_uploaded_at))} - covers ${orderCount} ${orderWord}${size ? ` - ${escapeHtml(size)}` : ""}</span>
      <div class="label-tracking-confirmation">
        <small>Extracted barcode / tracking number</small>
        <strong>${escapeHtml(trackingText || "Not captured yet")}</strong>
      </div>
      <span><strong>Shipment:</strong> ${escapeHtml(metadata.shipmentId || order.ebay_shipment_id || "-")}</span>
      <span><strong>Carrier:</strong> ${escapeHtml(metadata.carrier || "-")}</span>
      <span><strong>Service:</strong> ${escapeHtml(metadata.service || "-")}</span>
    `
    : `
      <span><strong>Orders:</strong> ${escapeHtml(orderNumbers.join(", ") || "-")}</span>
      ${renderHistoryLabelOrderList(orderNumbers)}
      ${renderExtraLabelEvents(orderNumbers)}
      <span>Waiting for one eBay label PDF for this grouped completion.</span>
    `;
  bindHistoryExtraLabelOpenButtons(details);
}

function openHistoryLabelModal(orderNumbers) {
  const target = getHistoryLabelTarget(orderNumbers);
  if (!target?.orders?.length) {
    window.alert("Could not find those orders in the current history view.");
    return;
  }

  state.awaitingLabelGroup = target;
  state.pendingHistoryLabelReplacement = null;
  state.pendingHistoryExtraLabelTransfer = null;
  setHistoryReplaceButtonVisible(false);
  resetHistoryExtraLabelPhotoPanel();
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

async function getHistoryLabelPdfObjectUrlFromPath(bucket, path) {
  if (!path) throw new Error("No shipping label file path is available.");
  const { data, error } = await supabase.storage.from(bucket || EBAY_LABEL_BUCKET).createSignedUrl(path, 60 * 60);
  if (error) throw new Error(error.message || "Could not create a label preview link.");
  const signedUrl = data?.signedUrl || "";
  if (!signedUrl) throw new Error("Could not create a label preview link.");
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

function handleHistoryExtraLabelButtonClick(orderNumber) {
  openHistoryLabelModal(orderNumber);
  $("history-label-title").textContent = "Add extra shipping label";
  $("history-label-subtitle").textContent = "Use this when a closed order needs a second label because articles were forgotten. Send the new eBay label, then attach a proof photo of the missing items.";
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
  cancelPendingHistoryExtraLabel();
  cancelPendingHistoryLabelReplacement();
  state.awaitingLabelGroup = null;
  setHistoryReplaceButtonVisible(false);
  resetHistoryExtraLabelPhotoPanel();
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

function postHistoryLabelExitStatus(pending, reason = "history-label-exit") {
  const transferId = pending?.transferId || "";
  if (!transferId) return false;
  const orderNumbers = state.awaitingLabelGroup?.orderNumbers || getLabelTransferOrderNumbers(pending);
  postHistoryLabelTransferStatus({
    transferId,
    ok: true,
    canceled: true,
    returnToAwaiting: true,
    reason,
    orderNumber: orderNumbers[0] || "",
    orderNumbers,
    message: "Existing OG label was kept. Returning to eBay awaiting shipments.",
  });
  clearExtensionPendingHistoryLabel(transferId);
  return true;
}

function cancelPendingHistoryLabelReplacement() {
  const pending = state.pendingHistoryLabelReplacement;
  if (!pending) return;
  const transferId = pending.transferId || "";
  postHistoryLabelExitStatus(pending, "history-label-replacement-exit");
  state.pendingHistoryLabelReplacement = null;
}

function cancelPendingHistoryExtraLabel() {
  const pending = state.pendingHistoryExtraLabelTransfer;
  if (!pending) return;
  const transferId = pending.transferId || "";
  postHistoryLabelExitStatus(pending, "history-extra-label-exit");
  state.pendingHistoryExtraLabelTransfer = null;
  if (state.pendingHistoryLabelReplacement?.transferId === transferId) {
    state.pendingHistoryLabelReplacement = null;
  }
}

function promptHistoryLabelReplacement(transferPayload) {
  state.pendingHistoryLabelReplacement = transferPayload;
  state.pendingHistoryExtraLabelTransfer = transferPayload;
  const transferId = transferPayload?.transferId || "";
  const attachedOrder = getAttachedHistoryOrder(state.awaitingLabelGroup?.orders || []);
  $("history-label-title").textContent = "Shipping label already attached";
  $("history-label-subtitle").textContent = "This completed order group already has a shipping label. Replace the existing label, or add this as an extra label when items were forgotten.";
  setHistoryLabelStatus("Existing label found. To save this as an extra label, take a photo of the forgotten items first.", "error");
  setHistoryReplaceButtonVisible(true);
  showHistoryExtraLabelPhotoPanel();
  setHistoryExtraLabelButtonVisible(true);
  if ($("done-history-label")) $("done-history-label").textContent = "Exit";
  renderHistoryLabelDetails(state.awaitingLabelGroup);
  openModal("history-label-modal");
  postHistoryLabelTransferStatus({
    transferId,
    phase: "started",
    message: `Order ${attachedOrder?.order_number || "group"} already has a label. Waiting for replace confirmation in OG.`,
  });
}

async function uploadHistoryExtraLabelEvidencePhotos(files, orderNumbers = [], transferId = "") {
  const cleanOrder = safeStorageSegment(orderNumbers.join("-") || "extra-label", "extra-label");
  const cleanTransfer = safeStorageSegment(transferId || crypto.randomUUID(), "transfer");
  const uploaded = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const extension = String(file.name || "").split(".").pop()?.toLowerCase()?.replace(/[^a-z0-9]/g, "") || "jpg";
    const path = [
      "extra-labels",
      cleanOrder,
      `${Date.now()}-${cleanTransfer}-${index + 1}.${extension}`,
    ].join("/");
    const { error } = await supabase.storage
      .from(EXTRA_LABEL_EVIDENCE_BUCKET)
      .upload(path, file, {
        contentType: file.type || "image/jpeg",
        upsert: false,
      });
    if (error) throw new Error(error.message || "Could not upload the forgotten-items photo.");
    uploaded.push({
      bucket: EXTRA_LABEL_EVIDENCE_BUCKET,
      path,
      label: `Forgotten items photo ${index + 1}`,
      original_name: file.name || "",
      mime_type: file.type || "image/jpeg",
      size_bytes: file.size || 0,
      uploaded_at: new Date().toISOString(),
    });
  }

  return uploaded;
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
    ...normalizeLabelMetadata(metadata, { orderNumbers: awaiting.orderNumbers }),
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
    line.searchText = normalizeLine(line).searchText;
  });

  if (transferPayload.transferId && window.chrome?.runtime?.sendMessage) {
    clearExtensionPendingHistoryLabel(transferPayload.transferId);
  }

  const orderCount = awaiting.orderNumbers.length;
  const trackingText = getLabelTrackingDisplay(labelMetadata);
  const trackingClause = trackingText ? ` Tracker: ${trackingText}.` : " Tracker was not captured.";
  state.pendingHistoryLabelReplacement = null;
  setHistoryReplaceButtonVisible(false);
  if ($("done-history-label")) $("done-history-label").textContent = "Done";
  setHistoryLabelStatus(`Shipping label attached to this grouped completion (${orderCount} order${orderCount === 1 ? "" : "s"}).${trackingClause}`, "success");
  renderHistoryLabelDetails(state.awaitingLabelGroup);
  const visibleGroups = getVisibleHistoryGroups();
  renderSummary(visibleGroups);
  renderHistoryList(visibleGroups);
  return {
    orderNumber: awaiting.orderNumbers[0] || "",
    orderNumbers: awaiting.orderNumbers,
    storagePath: destinationPath,
    uploadedAt: now,
  };
}

async function attachHistoryExtraLabelToOrder(transferPayload) {
  const awaiting = state.awaitingLabelGroup;
  if (!awaiting?.orders?.length) {
    throw new Error("Open a history group's label modal before adding an extra label.");
  }

  const files = getHistoryExtraLabelPhotoFiles();
  if (!files.length) {
    throw new Error("Take or choose a photo of the forgotten items before saving the extra label.");
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

  const evidencePhotos = await uploadHistoryExtraLabelEvidencePhotos(files, awaiting.orderNumbers, transferPayload.transferId || "");
  const blob = base64ToBlob(label.base64, label.mimeType || "application/pdf");
  const destinationPath = [
    "extra-labels",
    `${safeStorageSegment(metadata.labelId || metadata.shipmentId || transferPayload.transferId || crypto.randomUUID(), "extra-label")}.pdf`,
  ].join("/");

  const { error: uploadError } = await supabase.storage
    .from(EBAY_LABEL_BUCKET)
    .upload(destinationPath, blob, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) throw new Error(uploadError.message || "Could not upload the extra eBay label PDF.");

  const labelMetadata = {
    ...normalizeLabelMetadata(metadata, { orderNumbers: awaiting.orderNumbers }),
    coveredOrderNumbers: awaiting.orderNumbers,
    extraLabelReason: "forgotten_items_after_closeout",
    requiresMissingItemsPhoto: true,
    evidence_photos: evidencePhotos,
    transferId: transferPayload.transferId || null,
    captureSource: label.source || null,
    labelUrl: label.url || null,
    mimeType: label.mimeType || "application/pdf",
    size: label.size || blob.size,
    capturedAt: label.capturedAt || metadata.capturedAt || new Date().toISOString(),
  };
  const orderIds = [...new Set(awaiting.orders.map((order) => order.id).filter(Boolean))];
  const historyLabelLines = getHistoryLinesByOrderNumbers(awaiting.orderNumbers);

  const { data, error: orderError } = await supabase.rpc("attach_ebay_extra_shipping_label", {
    _order_ids: orderIds,
    _order_line_ids: historyLabelLines.map((line) => line.id).filter(Boolean),
    _order_numbers: awaiting.orderNumbers,
    _shipment_id: metadata.shipmentId || null,
    _label_storage_bucket: EBAY_LABEL_BUCKET,
    _label_file_path: destinationPath,
    _label_metadata: labelMetadata,
    _evidence_photos: evidencePhotos,
    _notes: "Extra shipping label added because items were forgotten after the order was closed.",
    _signed_by_email: state.user?.email || null,
  });
  if (orderError) throw new Error(orderError.message || "Could not audit the extra eBay label.");

  const eventId = data?.[0]?.audit_event_id || crypto.randomUUID();
  const now = new Date().toISOString();
  state.labelEvents.unshift({
    id: eventId,
    action: "extra_label",
    order_ids: orderIds,
    order_line_ids: historyLabelLines.map((line) => line.id).filter(Boolean),
    order_numbers: awaiting.orderNumbers,
    shipment_id: metadata.shipmentId || null,
    label_storage_bucket: EBAY_LABEL_BUCKET,
    label_file_path: destinationPath,
    previous_label_file_paths: awaiting.orders.map((order) => order.label_file_path).filter(Boolean),
    label_metadata: labelMetadata,
    signed_by_email: state.user?.email || null,
    source: "extension",
    created_at: now,
  });

  clearExtensionPendingHistoryLabel(transferPayload.transferId);
  state.pendingHistoryExtraLabelTransfer = null;
  state.pendingHistoryLabelReplacement = null;
  setHistoryReplaceButtonVisible(false);
  resetHistoryExtraLabelPhotoPanel();
  if ($("done-history-label")) $("done-history-label").textContent = "Done";
  const trackingText = getLabelTrackingDisplay(labelMetadata);
  const trackingClause = trackingText ? ` Tracker: ${trackingText}.` : " Tracker was not captured.";
  setHistoryLabelStatus(`Extra label saved for forgotten items, and the proof photo was attached.${trackingClause}`, "success");
  renderHistoryLabelDetails(state.awaitingLabelGroup);
  const visibleGroups = getVisibleHistoryGroups();
  renderSummary(visibleGroups);
  renderHistoryList(visibleGroups);
  return {
    orderNumber: awaiting.orderNumbers[0] || "",
    orderNumbers: awaiting.orderNumbers,
    storagePath: destinationPath,
    uploadedAt: now,
    extraLabel: true,
    evidencePhotoCount: evidencePhotos.length,
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
  state.pendingHistoryExtraLabelTransfer = null;
  resetHistoryExtraLabelPhotoPanel();
  setHistoryReplaceButtonVisible(false);
  if ($("done-history-label")) $("done-history-label").textContent = "Done";
  await completeHistoryLabelTransfer(payload);
}

async function confirmHistoryExtraLabel() {
  const payload = state.pendingHistoryExtraLabelTransfer;
  const transferId = payload?.transferId || "";
  if (!payload || state.labelBusy) return;

  state.labelBusy = true;
  setHistoryLabelStatus("Uploading extra label and forgotten-items photo...");
  postHistoryLabelTransferStatus({
    transferId,
    phase: "started",
    message: "History label modal accepted the extra eBay label transfer.",
  });
  try {
    const attached = await attachHistoryExtraLabelToOrder(payload);
    postHistoryLabelTransferStatus({
      transferId,
      ok: true,
      message: `Extra shipping label attached to history group for ${attached.orderNumbers.join(", ")}.`,
      ...attached,
    });
  } catch (error) {
    console.error("Extra past order label transfer failed:", error);
    const message = error.message || "Could not attach the extra eBay label.";
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

function postHistoryReturnTransferStatus(payload = {}) {
  window.postMessage({
    type: "OG_EBAY_RETURN_TRANSFER_STATUS",
    payload: {
      ...payload,
      tabId: null,
    },
  }, window.location.origin);
}

function postHistoryReturnMessageTransferStatus(payload = {}) {
  window.postMessage({
    type: "OG_EBAY_RETURN_MESSAGE_LOG_STATUS",
    payload: {
      ...payload,
      tabId: null,
    },
  }, window.location.origin);
}

function queueHistoryReturnMessageTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (transferId && state.queuedHistoryReturnMessageTransfers.some((entry) => entry?.transferId === transferId)) return;
  state.queuedHistoryReturnMessageTransfers.push(payload);
}

function drainQueuedHistoryReturnMessageTransfers() {
  if (!state.historyLoaded || !state.queuedHistoryReturnMessageTransfers.length) return;
  const queued = state.queuedHistoryReturnMessageTransfers.splice(0);
  queued.forEach((payload) => handleHistoryReturnMessageTransfer(payload));
}

async function recordEbayReturnMessageLog(payload = {}) {
  const message = payload.message || payload.metadata || {};
  const transferId = payload.transferId || "";
  const messageBody = String(message.messageBody || message.message || "").trim();
  if (!messageBody) throw new Error("The eBay buyer message was empty.");

  const rpcPayload = {
    ...message,
    messageBody,
    transferId,
    source: payload.source || message.source || "ebay_return_message_page",
    pageUrl: message.pageUrl || payload.pageUrl || "",
  };
  const { data, error } = await supabase.rpc("record_ebay_return_message_log", {
    _payload: rpcPayload,
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  return data || null;
}

async function handleHistoryReturnMessageTransfer(payload = {}) {
  const transferId = payload?.transferId || "";
  if (transferId && state.handledReturnMessageTransferIds.has(transferId)) {
    postHistoryReturnMessageTransferStatus({
      transferId,
      ok: true,
      message: "Return message was already logged in OG.",
    });
    return;
  }

  if (!state.historyLoaded) {
    queueHistoryReturnMessageTransfer(payload);
    return;
  }

  postHistoryReturnMessageTransferStatus({
    transferId,
    phase: "started",
    message: "OG Returns is logging the eBay buyer message.",
  });

  try {
    const recorded = await recordEbayReturnMessageLog(payload);
    if (transferId) state.handledReturnMessageTransferIds.add(transferId);
    await loadReturnQueue().catch((queueError) => {
      console.warn("Could not refresh return queue after message log:", queueError);
    });
    const message = payload.message || {};
    if ($("return-task-search") && (message.returnId || message.orderNumber || message.buyerUsername)) {
      $("return-task-search").value = message.returnId || message.orderNumber || message.buyerUsername || "";
      renderReturnQueue();
    }
    window.setTimeout(() => {
      $("return-work-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    postHistoryReturnMessageTransferStatus({
      transferId,
      ok: true,
      opened: true,
      returnMessageId: recorded?.id || null,
      returnCaseId: recorded?.return_case_id || null,
      orderNumber: recorded?.order_number || message.orderNumber || "",
      ebayReturnId: recorded?.ebay_return_id || message.returnId || "",
      message: "Logged eBay buyer message in OG.",
    });
  } catch (error) {
    const message = error.message || "Could not log the eBay buyer message in OG.";
    console.error("eBay return message log failed:", error);
    postHistoryReturnMessageTransferStatus({
      transferId,
      ok: false,
      error: message,
    });
    alert(message);
  }
}

function getCleanupStoragePaths(result = {}) {
  return [...new Set(
    (Array.isArray(result.complaint_storage_paths) ? result.complaint_storage_paths : [])
      .map((path) => String(path || "").trim())
      .filter((path) => path && path.startsWith("returns/ebay-complaints/"))
  )];
}

async function removeReturnImportStorageObjects(paths = []) {
  if (!paths.length) return 0;
  let removed = 0;
  const storage = supabase.storage.from(EBAY_RETURN_EVIDENCE_BUCKET);
  for (let index = 0; index < paths.length; index += 100) {
    const batch = paths.slice(index, index + 100);
    const { error } = await storage.remove(batch);
    if (error) throw error;
    removed += batch.length;
  }
  return removed;
}

async function clearReturnImportTestData() {
  if (!isAdminUser()) {
    alert("Only admins can clear return import test data.");
    return;
  }

  const button = $("clear-return-test-imports");
  if (button?.disabled) return;
  if (button) button.disabled = true;

  try {
    const { data: previewData, error: previewError } = await supabase.rpc("admin_clear_ebay_return_import_test_data", {
      _dry_run: true,
    });
    if (previewError) throw previewError;
    const preview = Array.isArray(previewData) ? previewData[0] || {} : previewData || {};
    const caseCount = Number(preview.return_cases || 0);
    const taskCount = Number(preview.return_tasks || 0);
    const storageCount = Number(preview.complaint_storage_objects || 0);
    const storagePaths = getCleanupStoragePaths(preview);
    if (!caseCount && !taskCount && !storageCount) {
      alert("No eBay return import test data was found to clear.");
      return;
    }
    if (storageCount && !storagePaths.length) {
      throw new Error("Push the latest return cleanup migration first, then try clearing return imports again.");
    }

    const confirmed = window.confirm(
      [
        "Clear current eBay return import test data?",
        "",
        `Return cases: ${caseCount.toLocaleString()}`,
        `Return tasks: ${taskCount.toLocaleString()}`,
        `Imported complaint photos: ${storageCount.toLocaleString()}`,
        "",
        "This will not delete eBay order history, shipping labels, inventory, or saved return intake records.",
      ].join("\n")
    );
    if (!confirmed) return;

    const removedStorageCount = await removeReturnImportStorageObjects(storagePaths);
    const { data, error } = await supabase.rpc("admin_clear_ebay_return_import_test_data", {
      _dry_run: false,
    });
    if (error) throw error;
    const result = Array.isArray(data) ? data[0] || {} : data || {};
    setLastReturnImportSummary({
      ok: true,
      requestedCount: 0,
      processedCount: 0,
      importedCount: 0,
      importedCreatedCount: 0,
      unmatchedCount: 0,
      unmatchedCreated: 0,
      failedCount: 0,
      duplicateResolvedCount: 0,
      importedReturns: [],
      unmatchedReturns: [],
      failedReturns: [],
      message: `Cleared ${Number(result.return_cases || caseCount || 0).toLocaleString()} return import case${Number(result.return_cases || caseCount || 0) === 1 ? "" : "s"}, ${Number(result.return_tasks || taskCount || 0).toLocaleString()} task${Number(result.return_tasks || taskCount || 0) === 1 ? "" : "s"}, and ${removedStorageCount.toLocaleString()} imported complaint photo${removedStorageCount === 1 ? "" : "s"}.`,
    });
    await loadReturnQueue();
  } catch (error) {
    console.error("Could not clear eBay return import test data:", error);
    alert(error?.message || "Could not clear return import test data. Push the latest return cleanup migration first.");
  } finally {
    if (button) button.disabled = false;
  }
}

function renderReturnImportSummary(summary = state.lastReturnImportSummary) {
  const panel = $("return-import-summary");
  const count = $("return-import-count");
  const details = $("return-import-details");
  if (!panel || !details) return;

  if (!summary) {
    panel.classList.add("hidden");
    details.innerHTML = "";
    if (count) count.textContent = "0 imported";
    return;
  }

  const requested = Number(summary.requestedCount || 0);
  const matched = Number(summary.importedCreatedCount ?? summary.importedCount ?? 0);
  const unmatched = Number(summary.unmatchedCreated ?? summary.unmatchedCount ?? 0);
  const failed = Number(summary.failedCount || 0);
  const duplicate = Number(summary.duplicateResolvedCount || 0);
  const processed = Number(summary.processedCount || matched + unmatched + duplicate);
  const missing = Math.max(0, requested - processed - failed);
  const failedReturns = Array.isArray(summary.failedReturns) ? summary.failedReturns : [];
  const unmatchedReturns = Array.isArray(summary.unmatchedReturns) ? summary.unmatchedReturns : [];

  panel.classList.remove("hidden");
  panel.classList.toggle("is-error", Boolean(failed || missing));
  if (count) {
    count.textContent = failed || missing
      ? `${failed + missing} issue${failed + missing === 1 ? "" : "s"}`
      : `${processed} imported`;
  }

  details.innerHTML = `
    <div class="return-import-grid">
      <span><small>Visible on eBay</small><b>${requested.toLocaleString()}</b></span>
      <span><small>Matched to OG</small><b>${matched.toLocaleString()}</b></span>
      <span><small>Missing OG match</small><b>${unmatched.toLocaleString()}</b></span>
      <span><small>Rejected / failed</small><b>${failed.toLocaleString()}</b></span>
      <span><small>Already resolved</small><b>${duplicate.toLocaleString()}</b></span>
      <span><small>Not accounted for</small><b>${missing.toLocaleString()}</b></span>
    </div>
    ${summary.message ? `<p class="return-import-message">${escapeHtml(summary.message)}</p>` : ""}
    ${unmatchedReturns.length ? `
      <div class="return-import-list">
        <strong>Missing OG matches</strong>
        ${unmatchedReturns.slice(0, 8).map((entry) => `
          <p>${escapeHtml(entry.returnId || "No return ID")} - ${escapeHtml(entry.buyerUsername || "No buyer")} - ${escapeHtml(entry.itemNumber || "No item #")} - ${escapeHtml(entry.reason || "Review task opened")}</p>
        `).join("")}
      </div>
    ` : ""}
    ${failedReturns.length ? `
      <div class="return-import-list is-error">
        <strong>Rejected by OG</strong>
        ${failedReturns.slice(0, 8).map((entry) => `
          <p>${escapeHtml(entry.returnId || "No return ID")} - ${escapeHtml(entry.buyerUsername || "No buyer")} - ${escapeHtml(entry.itemNumber || "No item #")} - ${escapeHtml(entry.error || "Import failed")}</p>
        `).join("")}
      </div>
    ` : ""}
  `;
}

function setLastReturnImportSummary(summary) {
  state.lastReturnImportSummary = summary || null;
  renderReturnImportSummary(state.lastReturnImportSummary);
}

function queueHistoryReturnTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (transferId && state.queuedHistoryReturnTransfers.some((entry) => entry?.transferId === transferId)) return;
  state.queuedHistoryReturnTransfers.push(payload);
}

function drainQueuedHistoryReturnTransfers() {
  if (!state.historyLoaded || !state.queuedHistoryReturnTransfers.length) return;
  const queued = state.queuedHistoryReturnTransfers.splice(0);
  queued.forEach((payload) => handleHistoryReturnTransfer(payload));
}

async function openReturnIntakeForTransfer(payload = {}) {
  const transferId = payload?.transferId || "";
  const info = getReturnTransferInfo(payload);
  const lines = await findReturnTransferLines(payload);
  if (!lines.length) {
    const opened = await ensureUnmatchedReturnTaskForTransfer(payload);
    if ($("return-task-status-filter")) $("return-task-status-filter").value = opened?.duplicateResolved ? "all" : "pending";
    if ($("return-task-assignee-filter")) $("return-task-assignee-filter").value = "";
    if ($("return-task-search")) $("return-task-search").value = info.returnId || info.itemNumber || info.buyerUsername || "";
    renderReturnQueue();
    window.setTimeout(() => {
      $("return-work-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    setLastReturnImportSummary({
      transferId,
      ok: true,
      requestedCount: 1,
      processedCount: 1,
      importedCount: 0,
      importedCreatedCount: 0,
      unmatchedCount: 1,
      unmatchedCreated: opened?.duplicateResolved ? 0 : 1,
      failedCount: 0,
      duplicateResolvedCount: opened?.duplicateResolved ? 1 : 0,
      importedReturns: [],
      unmatchedReturns: [{
        returnId: info.returnId || "",
        itemNumber: info.itemNumber || "",
        buyerUsername: info.buyerUsername || "",
        returnCaseId: opened?.return_case_id || null,
        taskId: opened?.task_id || null,
        duplicateResolved: Boolean(opened?.duplicateResolved),
        reason: opened?.duplicateResolved
          ? "Already resolved in OG; no duplicate review task was opened."
          : "No matching fulfilled OG order line was found.",
      }],
      failedReturns: [],
      message: opened?.duplicateResolved
        ? "This unmatched eBay return was already resolved in OG, so no duplicate task was opened."
        : "Created an unmatched eBay return review task because no fulfilled OG order history match was found.",
    });
    postHistoryReturnTransferStatus({
      transferId,
      ok: true,
      opened: true,
      unmatched: true,
      routedTo: "return_queue",
      returnCaseId: opened?.return_case_id || null,
      taskId: opened?.task_id || null,
      duplicateResolved: Boolean(opened?.duplicateResolved),
      message: opened?.duplicateResolved
        ? "This unmatched eBay return was already resolved in OG, so no duplicate task was opened."
        : "Created an unmatched eBay return review task because no fulfilled OG order history match was found.",
    });
    return;
  }

  const lineIds = lines.map((line) => line.id).filter(Boolean);
  const opened = await ensureReturnTaskForTransfer(payload, lines);
  if (opened?.duplicateResolved) {
    if ($("return-task-status-filter")) $("return-task-status-filter").value = "all";
    if ($("return-task-assignee-filter")) $("return-task-assignee-filter").value = "";
    if ($("return-task-search")) $("return-task-search").value = info.returnId || info.itemNumber || info.buyerUsername || "";
    renderReturnQueue();
    window.setTimeout(() => {
      $("return-work-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
    setLastReturnImportSummary({
      transferId,
      ok: true,
      requestedCount: 1,
      processedCount: 1,
      importedCount: 1,
      importedCreatedCount: 0,
      unmatchedCount: 0,
      unmatchedCreated: 0,
      failedCount: 0,
      duplicateResolvedCount: 1,
      importedReturns: [{
        returnId: info.returnId || "",
        itemNumber: info.itemNumber || "",
        buyerUsername: info.buyerUsername || "",
        returnCaseId: opened.return_case_id || null,
        taskId: opened.task_id || null,
        duplicateResolved: true,
        matchedLineIds: lineIds,
        orderNumbers: [...new Set(lines.map((line) => line.order?.order_number).filter(Boolean))],
      }],
      unmatchedReturns: [],
      failedReturns: [],
      message: "This eBay return was already resolved in OG, so no duplicate task was opened.",
    });
    postHistoryReturnTransferStatus({
      transferId,
      ok: true,
      opened: true,
      duplicateResolved: true,
      returnCaseId: opened.return_case_id || null,
      taskId: opened.task_id || null,
      matchedLineIds: lineIds,
      orderNumbers: [...new Set(lines.map((line) => line.order?.order_number).filter(Boolean))],
      message: "This eBay return was already resolved in OG, so no duplicate task was opened.",
    });
    return;
  }
  openReturnIntakeModal(lineIds);
  applyReturnTransferPrefill(payload, lines);
  setLastReturnImportSummary({
    transferId,
    ok: true,
    requestedCount: 1,
    processedCount: 1,
    importedCount: 1,
    importedCreatedCount: 1,
    unmatchedCount: 0,
    unmatchedCreated: 0,
    failedCount: 0,
    duplicateResolvedCount: 0,
    importedReturns: [{
      returnId: info.returnId || "",
      itemNumber: info.itemNumber || "",
      buyerUsername: info.buyerUsername || "",
      returnCaseId: opened?.return_case_id || null,
      taskId: opened?.task_id || null,
      duplicateResolved: false,
      matchedLineIds: lineIds,
      orderNumbers: [...new Set(lines.map((line) => line.order?.order_number).filter(Boolean))],
    }],
    unmatchedReturns: [],
    failedReturns: [],
    message: "OG return intake modal opened for the eBay return.",
  });
  postHistoryReturnTransferStatus({
    transferId,
    ok: true,
    opened: true,
    returnCaseId: opened?.return_case_id || null,
    taskId: opened?.task_id || null,
    matchedLineIds: lineIds,
    orderNumbers: [...new Set(lines.map((line) => line.order?.order_number).filter(Boolean))],
    message: "OG return intake modal opened for the eBay return.",
  });
}

async function importReturnBatchTransfer(payload = {}) {
  const transferId = payload?.transferId || "";
  const returns = Array.isArray(payload.returns) ? payload.returns.filter(Boolean) : [];
  const importedReturns = [];
  const unmatchedReturns = [];
  const failedReturns = [];

  for (const [index, returnInfo] of returns.entries()) {
    const itemPayload = buildReturnBatchItemPayload(payload, returnInfo, index);
    const info = getReturnTransferInfo(itemPayload);
    try {
      const lines = await findReturnTransferLines(itemPayload);
      if (!lines.length) {
        const opened = await ensureUnmatchedReturnTaskForTransfer(itemPayload, { refreshQueue: false });
        unmatchedReturns.push({
          returnId: info.returnId || "",
          itemNumber: info.itemNumber || "",
          buyerUsername: info.buyerUsername || "",
          returnCaseId: opened?.return_case_id || null,
          taskId: opened?.task_id || null,
          duplicateResolved: Boolean(opened?.duplicateResolved),
          reason: opened?.duplicateResolved
            ? "Already resolved in OG; no duplicate review task was opened."
            : "Created a legacy/unmatched return review task because no matching fulfilled OG order line was found.",
        });
        continue;
      }

      const opened = await ensureReturnTaskForTransfer(itemPayload, lines, { refreshQueue: false });
      importedReturns.push({
        returnId: info.returnId || "",
        itemNumber: info.itemNumber || "",
        buyerUsername: info.buyerUsername || "",
        returnCaseId: opened?.return_case_id || null,
        taskId: opened?.task_id || null,
        duplicateResolved: Boolean(opened?.duplicateResolved),
        matchedLineIds: lines.map((line) => line.id).filter(Boolean),
        orderNumbers: [...new Set(lines.map((line) => line.order?.order_number).filter(Boolean))],
      });
    } catch (error) {
      failedReturns.push({
        returnId: info.returnId || "",
        itemNumber: info.itemNumber || "",
        buyerUsername: info.buyerUsername || "",
        error: error.message || "Could not import this return.",
      });
    }
  }

  await loadReturnQueue().catch((queueError) => {
    console.warn("Could not refresh return task queue after importing eBay returns:", queueError);
  });

  const processedReturnEntries = [...importedReturns, ...unmatchedReturns];
  const onlyResolvedDuplicates = Boolean(
    processedReturnEntries.length && processedReturnEntries.every((entry) => entry.duplicateResolved)
  );
  if ($("return-task-status-filter")) $("return-task-status-filter").value = onlyResolvedDuplicates ? "all" : "pending";
  if ($("return-task-assignee-filter")) $("return-task-assignee-filter").value = "";
  if ($("return-task-search")) $("return-task-search").value = "";
  renderReturnQueue();
  window.setTimeout(() => {
    $("return-work-queue")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, 80);

  const importedCount = importedReturns.length;
  const unmatchedCount = unmatchedReturns.length;
  const failedCount = failedReturns.length;
  const duplicateResolvedCount = processedReturnEntries
    .filter((entry) => entry.duplicateResolved).length;
  const importedCreatedCount = importedReturns.filter((entry) => !entry.duplicateResolved).length;
  const unmatchedCreatedCount = unmatchedReturns.filter((entry) => !entry.duplicateResolved).length;
  const processedCount = importedCount + unmatchedCount;
  const ok = processedCount > 0;
  const error = ok
    ? ""
    : failedReturns[0]?.error || "None of the eBay returns could be imported into the OG return queue.";
  const createdMessage = [
    importedCreatedCount ? `${importedCreatedCount} matched return${importedCreatedCount === 1 ? "" : "s"}` : "",
    unmatchedCreatedCount ? `${unmatchedCreatedCount} legacy/unmatched review task${unmatchedCreatedCount === 1 ? "" : "s"}` : "",
  ].filter(Boolean).join(" and ");
  const duplicateMessage = duplicateResolvedCount
    ? `${duplicateResolvedCount} already resolved duplicate${duplicateResolvedCount === 1 ? "" : "s"} ignored`
    : "";
  const message = ok
    ? [
      createdMessage ? `${createdMessage} imported into the OG return queue` : "",
      duplicateMessage,
    ].filter(Boolean).join("; ") + "."
    : error;

  const summary = {
    transferId,
    ok,
    requestedCount: returns.length,
    opened: true,
    imported: processedCount,
    importedCount,
    importedCreatedCount,
    unmatched: unmatchedCount,
    unmatchedCount,
    unmatchedCreated: unmatchedCreatedCount,
    failed: failedCount,
    failedCount,
    duplicateResolvedCount,
    importedReturns,
    unmatchedReturns,
    failedReturns,
    error,
    message,
  };

  setLastReturnImportSummary(summary);
  postHistoryReturnTransferStatus(summary);
  return summary;
}

async function handleHistoryReturnTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (transferId && state.handledReturnTransferIds.has(transferId)) {
    postHistoryReturnTransferStatus({
      transferId,
      ok: true,
      opened: true,
      message: "Return transfer is already open in OG.",
    });
    return;
  }
  if (transferId && state.processingReturnTransferIds.has(transferId)) return;

  if (!state.historyLoaded) {
    queueHistoryReturnTransfer(payload);
    return;
  }

  postHistoryReturnTransferStatus({
    transferId,
    phase: "started",
    message: isReturnBatchTransfer(payload)
      ? "OG Returns is importing the eBay returns."
      : "OG Returns is matching the eBay return.",
  });

  try {
    if (transferId) state.processingReturnTransferIds.add(transferId);
    if (isReturnBatchTransfer(payload)) {
      const summary = await importReturnBatchTransfer(payload);
      if (!summary.ok && summary.error) alert(summary.error);
    } else {
      await openReturnIntakeForTransfer(payload);
    }
    if (transferId) state.handledReturnTransferIds.add(transferId);
  } catch (error) {
    const message = error.message || "Could not open the OG return workflow.";
    console.error("eBay return transfer failed:", error);
    if (transferId) state.handledReturnTransferIds.add(transferId);
    const failedReturnInfos = isReturnBatchTransfer(payload)
      ? payload.returns.map((info) => ({
        returnId: info.returnId || "",
        itemNumber: info.itemNumber || "",
        buyerUsername: info.buyerUsername || "",
        error: message,
      }))
      : [{
        returnId: getReturnTransferInfo(payload).returnId || "",
        itemNumber: getReturnTransferInfo(payload).itemNumber || "",
        buyerUsername: getReturnTransferInfo(payload).buyerUsername || "",
        error: message,
      }];
    setLastReturnImportSummary({
      transferId,
      ok: false,
      requestedCount: failedReturnInfos.length,
      processedCount: 0,
      importedCount: 0,
      importedCreatedCount: 0,
      unmatchedCount: 0,
      unmatchedCreated: 0,
      failedCount: failedReturnInfos.length,
      duplicateResolvedCount: 0,
      importedReturns: [],
      unmatchedReturns: [],
      failedReturns: failedReturnInfos,
      error: message,
      message,
    });
    postHistoryReturnTransferStatus({
      transferId,
      ok: false,
      error: message,
    });
    alert(message);
  } finally {
    if (transferId) state.processingReturnTransferIds.delete(transferId);
  }
}

function setupHistoryLabelReceiver() {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "OG_EBAY_LABEL_RECEIVER_STATE_REQUEST") {
      window.postMessage({
        type: "OG_EBAY_LABEL_RECEIVER_STATE_RESPONSE",
        requestId: event.data.requestId,
        payload: {
          pageType: isReturnsWorkbenchPage() ? "returns" : "order-history",
          labelModalOpen: Boolean($("history-label-modal") && !$("history-label-modal").classList.contains("hidden")),
          awaitingOrderNumbers: state.awaitingLabelGroup?.orderNumbers || [],
          canAutoRoute: false,
        },
      }, window.location.origin);
      return;
    }
    if (event.data?.type === "OG_EBAY_LABEL_TRANSFER") {
      handleHistoryLabelTransfer(event.data.payload);
      return;
    }
    if (event.data?.type === "OG_EBAY_RETURN_TRANSFER") {
      handleHistoryReturnTransfer(event.data.payload);
      return;
    }
    if (event.data?.type === "OG_EBAY_RETURN_MESSAGE_LOG") {
      handleHistoryReturnMessageTransfer(event.data.payload);
    }
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

function getExplicitTrackingFromMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return [];
  return getTrackingNumbersFromText([
    metadata.trackingNumber,
    metadata.shippingBarcodeNumber,
    ...(Array.isArray(metadata.trackingNumbers) ? metadata.trackingNumbers : []),
    ...(Array.isArray(metadata.shippingBarcodeNumbers) ? metadata.shippingBarcodeNumbers : []),
    ...(Array.isArray(metadata.labelRows)
      ? metadata.labelRows.flatMap((row) => [
        row?.trackingNumber,
        row?.shippingBarcodeNumber,
        ...(Array.isArray(row?.trackingNumbers) ? row.trackingNumbers : []),
        ...(Array.isArray(row?.shippingBarcodeNumbers) ? row.shippingBarcodeNumbers : []),
      ])
      : []),
  ].filter(Boolean).join(" "));
}

function configurePdfTrackingReader() {
  if (!window.pdfjsLib?.getDocument) {
    throw new Error("PDF reader is not available on this page.");
  }
  if (window.pdfjsLib.GlobalWorkerOptions && !window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
  }
}

async function extractTrackingNumbersFromPdfBlob(blob) {
  configurePdfTrackingReader();
  const data = await blob.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data }).promise;
  const chunks = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const content = await page.getTextContent();
    chunks.push(content.items.map((item) => item.str || "").join(" "));
  }
  return getTrackingNumbersFromText(chunks.join("\n"));
}

function setLabelBackfillStatus(message, tone = "") {
  const status = $("label-backfill-status");
  if (!status) return;
  status.textContent = message;
  status.classList.toggle("is-success", tone === "success");
  status.classList.toggle("is-error", tone === "error");
}

function appendLabelBackfillResult(title, detail, tone = "") {
  const results = $("label-backfill-results");
  if (!results) return;
  results.insertAdjacentHTML("beforeend", `
    <article class="${tone ? `is-${escapeHtml(tone)}` : ""}">
      <strong>${escapeHtml(title)}</strong>
      <span>${escapeHtml(detail)}</span>
    </article>
  `);
}

function openLabelBackfillModal() {
  if (!isAdminUser()) {
    alert("Only admins can backfill shipping label tracking numbers.");
    return;
  }
  $("label-backfill-results").innerHTML = "";
  setLabelBackfillStatus("Ready to scan stored shipping labels.");
  $("start-label-backfill").disabled = false;
  openModal("label-backfill-modal");
}

function closeLabelBackfillModal() {
  if (state.labelBackfillBusy) return;
  closeModal("label-backfill-modal");
}

async function fetchLabelBackfillCandidates() {
  const pageSize = 1000;
  const maxRows = 5000;
  const orders = [];

  for (let offset = 0; offset < maxRows; offset += pageSize) {
    const { data, error } = await supabase
      .from("ebay_orders")
      .select("id, order_number, ebay_shipment_id, label_storage_bucket, label_file_path, label_uploaded_at, label_metadata")
      .not("label_file_path", "is", null)
      .order("label_uploaded_at", { ascending: false })
      .range(offset, offset + pageSize - 1);

    if (error) throw error;
    orders.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }

  const missingTracking = orders.filter((order) =>
    order?.id
    && order?.label_file_path
    && !getExplicitTrackingFromMetadata(order.label_metadata).length
  );

  const groups = new Map();
  missingTracking.forEach((order) => {
    const bucket = order.label_storage_bucket || EBAY_LABEL_BUCKET;
    const key = `${bucket}::${order.label_file_path}`;
    if (!groups.has(key)) groups.set(key, { bucket, path: order.label_file_path, orders: [] });
    groups.get(key).orders.push(order);
  });

  return [...groups.values()];
}

function buildTrackingBackfillPatch(group, trackingNumbers) {
  const metadataObjects = group.orders.map((order) => order.label_metadata || {});
  const orderNumbers = unique(group.orders.map((order) => order.order_number));
  const shipmentIds = unique([
    ...group.orders.map((order) => order.ebay_shipment_id),
    ...metadataObjects.flatMap((metadata) => [
      metadata.shipmentId,
      ...(Array.isArray(metadata.shipmentIds) ? metadata.shipmentIds : []),
    ]),
  ]);
  const labelIds = unique(metadataObjects.flatMap((metadata) => [
    metadata.labelId,
    ...(Array.isArray(metadata.labelIds) ? metadata.labelIds : []),
  ]));
  const lookupKeys = unique([
    ...metadataObjects.flatMap((metadata) => Array.isArray(metadata.lookupKeys) ? metadata.lookupKeys : []),
    ...orderNumbers,
    ...shipmentIds,
    ...labelIds,
    ...trackingNumbers,
  ]);

  return {
    trackingNumber: trackingNumbers[0] || "",
    trackingNumbers,
    shippingBarcodeNumber: trackingNumbers[0] || "",
    shippingBarcodeNumbers: trackingNumbers,
    shipmentId: shipmentIds[0] || "",
    shipmentIds,
    labelIds,
    lookupKeys,
    trackingBackfilledAt: new Date().toISOString(),
    trackingBackfillSource: "stored-label-pdf",
  };
}

function mergeBackfilledTrackingIntoLoadedState(group, patch) {
  const orderIds = new Set(group.orders.map((order) => order.id).filter(Boolean));
  state.lines.forEach((line) => {
    const order = getOrderFromLine(line);
    if (!orderIds.has(order?.id)) return;
    const updatedOrder = {
      ...order,
      label_metadata: {
        ...(order.label_metadata || {}),
        ...patch,
      },
    };
    line.order = updatedOrder;
    if (line.ebay_orders && !Array.isArray(line.ebay_orders)) line.ebay_orders = updatedOrder;
    line.searchText = normalizeLine(line).searchText;
  });
}

function handleOpenHistoryExtraLabelButtonClick(eventId) {
  const event = state.labelEvents.find((entry) => entry.id === eventId);
  if (!event?.label_file_path) {
    window.alert("Could not find that extra label file.");
    return;
  }
  const previewWindow = window.open("about:blank", "_blank");
  if (previewWindow) previewWindow.opener = null;
  getHistoryLabelPdfObjectUrlFromPath(event.label_storage_bucket || EBAY_LABEL_BUCKET, event.label_file_path)
    .then((objectUrl) => writeHistoryLabelPreviewWindow(previewWindow, objectUrl, "Extra shipping label"))
    .catch((error) => {
      if (previewWindow && !previewWindow.closed) previewWindow.close();
      window.alert(error.message || "Could not open the extra shipping label.");
    });
}

async function backfillOneLabelTrackingGroup(group) {
  const { data: blob, error: downloadError } = await supabase.storage
    .from(group.bucket || EBAY_LABEL_BUCKET)
    .download(group.path);
  if (downloadError) throw new Error(downloadError.message || "Could not download stored label PDF.");

  const trackingNumbers = await extractTrackingNumbersFromPdfBlob(blob);
  if (!trackingNumbers.length) {
    throw new Error("No tracking number was readable in this label PDF.");
  }

  const patch = buildTrackingBackfillPatch(group, trackingNumbers);
  const orderIds = unique(group.orders.map((order) => order.id));
  const { error: rpcError } = await supabase.rpc("backfill_ebay_label_tracking_metadata", {
    _order_ids: orderIds,
    _label_file_path: group.path,
    _label_metadata_patch: patch,
    _signed_by_email: state.user?.email || null,
  });
  if (rpcError) throw new Error(rpcError.message || "Could not save tracking metadata.");

  mergeBackfilledTrackingIntoLoadedState(group, patch);
  return trackingNumbers;
}

async function startLabelTrackingBackfill() {
  if (state.labelBackfillBusy) return;
  state.labelBackfillBusy = true;
  $("start-label-backfill").disabled = true;
  $("done-label-backfill").disabled = true;
  $("label-backfill-results").innerHTML = "";
  setLabelBackfillStatus("Finding uploaded labels that are missing tracking numbers...");

  let updated = 0;
  let failed = 0;
  try {
    const groups = await fetchLabelBackfillCandidates();
    if (!groups.length) {
      setLabelBackfillStatus("All uploaded labels already have tracking metadata.", "success");
      appendLabelBackfillResult("Nothing to backfill", "Every stored label already has a tracker number saved.", "success");
      return;
    }

    setLabelBackfillStatus(`Scanning ${groups.length.toLocaleString()} stored label file${groups.length === 1 ? "" : "s"}...`);
    for (const [index, group] of groups.entries()) {
      const orderNumbers = unique(group.orders.map((order) => order.order_number)).join(", ");
      setLabelBackfillStatus(`Scanning ${index + 1} of ${groups.length}: ${orderNumbers || group.path}`);
      try {
        const trackingNumbers = await backfillOneLabelTrackingGroup(group);
        updated += group.orders.length;
        appendLabelBackfillResult(
          `Saved ${trackingNumbers.join(", ")}`,
          `${orderNumbers || group.path} - ${group.orders.length} order${group.orders.length === 1 ? "" : "s"}`,
          "success"
        );
      } catch (error) {
        failed += 1;
        appendLabelBackfillResult(
          `Could not read ${orderNumbers || group.path}`,
          error.message || "Tracking number extraction failed.",
          "error"
        );
      }
    }

    applyFilters();
    setLabelBackfillStatus(
      failed
        ? `Backfill finished: ${updated.toLocaleString()} order${updated === 1 ? "" : "s"} updated, ${failed.toLocaleString()} label file${failed === 1 ? "" : "s"} need review.`
        : `Backfill finished: ${updated.toLocaleString()} order${updated === 1 ? "" : "s"} updated.`,
      failed ? "error" : "success"
    );
  } catch (error) {
    console.error("Label tracking backfill failed:", error);
    setLabelBackfillStatus(error.message || "Could not backfill label tracking numbers.", "error");
  } finally {
    state.labelBackfillBusy = false;
    $("start-label-backfill").disabled = false;
    $("done-label-backfill").disabled = false;
  }
}

function setupListeners() {
  setupHistorySearchAutofillGuard();
  $("refresh-history")?.addEventListener("click", refreshHistoryAndReturns);
  $("refresh-return-queue")?.addEventListener("click", loadReturnQueue);
  $("open-proof-trail")?.addEventListener("click", openProofTrailModal);
  $("backfill-label-tracking")?.addEventListener("click", openLabelBackfillModal);
  $("clear-return-test-imports")?.addEventListener("click", clearReturnImportTestData);
  $("start-label-backfill")?.addEventListener("click", startLabelTrackingBackfill);
  $("done-label-backfill")?.addEventListener("click", closeLabelBackfillModal);
  $("close-label-backfill-modal")?.addEventListener("click", closeLabelBackfillModal);
  $("label-backfill-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "label-backfill-modal") closeLabelBackfillModal();
  });
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
  ["return-task-status-filter", "return-task-assignee-filter", "return-task-search"].forEach((id) => {
    $(id)?.addEventListener("input", renderReturnQueue);
    $(id)?.addEventListener("change", renderReturnQueue);
  });

  $("close-revert-modal")?.addEventListener("click", closeRevertModal);
  $("cancel-revert")?.addEventListener("click", closeRevertModal);
  $("confirm-revert")?.addEventListener("click", confirmRevert);
  $("revert-order-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "revert-order-modal") closeRevertModal();
  });
  $("close-return-intake-modal")?.addEventListener("click", closeReturnIntakeModal);
  $("cancel-return-intake")?.addEventListener("click", closeReturnIntakeModal);
  $("confirm-return-intake")?.addEventListener("click", confirmReturnIntake);
  $("find-return-destination")?.addEventListener("click", searchReturnDestinationLocation);
  $("return-evidence-photo")?.addEventListener("change", renderReturnEvidencePhotoList);
  $("return-capture-station")?.addEventListener("change", (event) => {
    setSelectedReturnCaptureStation(event.target.value);
  });
  $("refresh-return-stations")?.addEventListener("click", () => loadReturnCaptureStations());
  $("request-return-photo")?.addEventListener("click", requestReturnEvidencePhoto);
  $("select-all-return-photos")?.addEventListener("click", () => setAllReturnEvidencePhotosSelected(true));
  $("deselect-all-return-photos")?.addEventListener("click", () => setAllReturnEvidencePhotosSelected(false));
  $("return-destination-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchReturnDestinationLocation();
    }
  });
  $("return-intake-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "return-intake-modal") closeReturnIntakeModal();
  });
  $("close-history-label-modal")?.addEventListener("click", closeHistoryLabelModal);
  $("done-history-label")?.addEventListener("click", closeHistoryLabelModal);
  $("replace-history-label")?.addEventListener("click", confirmHistoryLabelReplacement);
  $("add-extra-history-label")?.addEventListener("click", confirmHistoryExtraLabel);
  $("history-extra-label-photo")?.addEventListener("change", renderHistoryExtraLabelPhotoList);
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
    if (isModalOpen("evidence-photo-viewer-modal")) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        closeEvidencePhotoViewer();
      }
      return;
    }
    if (isModalOpen("proof-trail-modal")) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeProofTrailModal();
      }
      return;
    }
    if (isModalOpen("label-backfill-modal")) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeLabelBackfillModal();
      }
      return;
    }
    if (isModalOpen("history-label-modal")) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeHistoryLabelModal();
      }
      return;
    }
    if (isModalOpen("return-intake-modal")) {
      if (event.key === "Escape") {
        event.preventDefault();
        closeReturnIntakeModal();
      } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        confirmReturnIntake();
      }
      return;
    }
    if (isModalOpen("revert-order-modal")) {
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
  if (isReturnsWorkbenchPage()) {
    state.historyLoaded = true;
    await loadReturnQueue();
    drainQueuedHistoryReturnTransfers();
    drainQueuedHistoryReturnMessageTransfers();
  } else {
    await loadOrderHistory();
    if ($("return-task-list")) await loadReturnQueue();
  }
  if (window.lucide) window.lucide.createIcons();
});
