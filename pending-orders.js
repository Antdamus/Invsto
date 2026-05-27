const state = {
  user: null,
  employee: null,
  orders: [],
  filteredOrders: [],
  stores: [],
  checkoutStoreId: "",
  selectedLine: null,
  selectedItem: null,
  stockRows: [],
  selectedStockRow: null,
  activeBuyerKey: "",
  stagedFulfillments: new Map(),
  adminSelectedLineIds: new Set(),
  adminCloseoutAction: "",
  orderSort: "created_asc",
  pendingItemCandidate: null,
  itemSearchTimer: null,
  locationSearchTimer: null,
  quantityAutoTimer: null,
  liveLotSearchTimer: null,
  selectedLiveLot: null,
  selectedLiveLotItems: [],
  liveLotMatchedLineIds: new Set(),
  liveLotOrderMatches: [],
  ebayLaunchOrderNumbers: new Set(),
  ebayLaunchBuyerKeys: new Set(),
  ebayLaunchAllOrderNumbers: new Set(),
  ebayLaunchSelectedCount: 0,
  ebayLaunchTotalCount: 0,
  ebayLaunchSnapshot: null,
  workerNoInventoryGps: null,
  workerNoInventoryCandidates: [],
  workerNoInventoryLineIds: new Set(),
  noInventoryCaptureStations: [],
  selectedNoInventoryCaptureStationId: "",
  noInventoryEvidencePhotos: [],
  noInventoryEvidencePhotoUploadKeys: new Set(),
  noInventoryCaptureBusy: false,
  workerCancelCandidates: [],
  workerCancelLineIds: new Set(),
  workerCancelEvidencePhotos: [],
  workerCancelEvidencePhotoUploadKeys: new Set(),
  workerCancelCaptureBusy: false,
  ebayLabelPreviewUrls: new Map(),
  handledEbayLabelTransferIds: new Set(),
  handledEbayReportTransferIds: new Set(),
  handledVideoReceiptPhotoTransferIds: new Set(),
  handledEbayCancelProofTransferIds: new Set(),
  queuedEbayLabelTransfers: [],
  queuedEbayReportTransfers: [],
  queuedVideoReceiptPhotoTransfers: [],
  queuedEbayCancelProofTransfers: [],
  ebayTransferReceiverReady: false,
  ebayTransferReceiverSetup: false,
  ebayLabelReturnContext: null,
  ebayLabelBusy: false,
  ebayReportBusy: false,
  ebayOrderSyncBusy: false,
  orderTaskAssignees: [],
  selectedOrderTasks: [],
  selectedOrderTaskEvents: new Map(),
  activeOrderTaskId: "",
  orderTaskMode: "create",
  orderTaskPhotos: [],
  orderTaskPhotoUploadKeys: new Set(),
  orderTaskCaptureBusy: false,
  orderTaskSignedUrls: new Map(),
  orderTaskAssignmentsByLineId: new Map(),
  orderVideoReceipts: new Map(),
  videoReceiptEvidenceByLineId: new Map(),
  queueVideoReceiptTasks: [],
  queueVideoReceiptTaskEvents: new Map(),
  queueVideoReceiptLoadedOrderIds: new Set(),
  evidencePhotoViewerZoom: 1,
  evidencePhotoViewerPanX: 0,
  evidencePhotoViewerPanY: 0,
  evidencePhotoViewerPanning: false,
  evidencePhotoViewerPanStart: null,
  launchOrderTaskId: "",
  busy: false,
};

const NO_INVENTORY_CAPTURE_STATION_TABLE = "capture_stations";
const NO_INVENTORY_CAPTURE_JOB_TABLE = "capture_jobs";
const NO_INVENTORY_CAPTURE_PHOTO_TABLE = "capture_job_photos";
const NO_INVENTORY_CAPTURE_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const NO_INVENTORY_CAPTURE_POLL_INTERVAL_MS = 1_500;
const NO_INVENTORY_CAPTURE_PHOTO_SETTLE_MS = 3_000;
const NO_INVENTORY_EVIDENCE_SIGNED_URL_TTL_SECONDS = 60 * 60;
const NO_INVENTORY_THUMBNAIL_TRANSFORM = { width: 240, height: 240, resize: "contain", quality: 55 };
const NO_INVENTORY_EVIDENCE_BUCKET = "order-evidence-photos";
const EBAY_LABEL_BUCKET = "ebay-labels";
const EBAY_SINGLE_LABEL_BASE_URL = "https://www.ebay.com/ship/single/";
const EBAY_BULK_LABEL_BASE_URL = "https://www.ebay.com/ship/bulk";
const ORDER_QUEUE_PAGE_SIZE = 1000;
const EBAY_ORDER_NUMBER_PATTERN = /^\d{2}-\d{5}-\d{5}$/;
const CLOSED_EBAY_IMPORT_STATUSES = new Set(["fulfilled", "cancelled", "archived"]);
const PENDING_ORDERS_FULL_ACCESS_FOR_ACTIVE_STAFF = true;

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

function parseMoney(value) {
  const number = Number(String(value || "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(number) ? number : 0;
}

function formatMoney(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "$0.00";
  return number.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function toLocalDateInputValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 10);
}

function toDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function localDateTimeToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function formatFileSize(bytes) {
  const size = Number(bytes || 0);
  if (!Number.isFinite(size) || size <= 0) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(2)} MB`;
}

function firstItemPhoto(item) {
  const photos = Array.isArray(item?.photos) ? item.photos : [];
  return photos.find(Boolean) || item?.photo_url || "";
}

async function resolvePhotoUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = String(path).replace(/^photos\//, "");
  const { data, error } = await supabase.storage.from("photos").createSignedUrl(cleanPath, 3600);
  if (error) {
    console.warn("Could not sign item photo:", error);
    return "";
  }
  return data?.signedUrl || "";
}

function formatElapsed(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function getSourceRole(source = {}) {
  if (source.is_tray || source.location_role === "tray") return "tray";
  if (source.location_role === "container") return "container";
  return "storage_location";
}

function getSourceKindLabel(source = {}) {
  const role = getSourceRole(source);
  if (role === "tray") return "Tray";
  if (role === "container") return "Storage Container";
  return "Storage";
}

function getSourceKindClass(source = {}) {
  const role = getSourceRole(source);
  if (role === "tray") return "is-tray";
  if (role === "container") return "is-container";
  return "is-storage";
}

function sameLocalDay(value, reference = new Date()) {
  if (!value) return false;
  const date = new Date(value);
  return date.getFullYear() === reference.getFullYear()
    && date.getMonth() === reference.getMonth()
    && date.getDate() === reference.getDate();
}

function startOfLocalDay(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getShipTimestamp(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

function getOrderCreatedAt(line) {
  const order = line?.order || getOrderFromLine(line);
  return order?.sale_date || order?.paid_on_date || order?.imported_at || line?.created_at || "";
}

function getOrderCreatedLabel(line) {
  const order = line?.order || getOrderFromLine(line);
  if (order?.sale_date) return "Sale date";
  if (order?.paid_on_date) return "Paid date";
  if (order?.imported_at || line?.created_at) return "Pending created";
  return "Order date";
}

function getOrderCreatedTimestamp(value) {
  if (!value) return Number.MAX_SAFE_INTEGER;
  const date = new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? Number.MAX_SAFE_INTEGER : time;
}

function getOrderUrgency(value) {
  if (!value) return null;
  const shipBy = new Date(value);
  if (Number.isNaN(shipBy.getTime())) return null;

  const shipDay = startOfLocalDay(shipBy);
  const today = startOfLocalDay();
  const tomorrow = startOfLocalDay();
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (shipDay < today) {
    return {
      level: "overdue",
      label: "Overdue",
      icon: "alert-triangle",
    };
  }

  if (sameLocalDay(shipBy)) {
    return {
      level: "today",
      label: "Due today",
      icon: "clock",
    };
  }

  if (shipDay.getTime() === tomorrow.getTime()) {
    return {
      level: "tomorrow",
      label: "Due tomorrow",
      icon: "calendar-days",
    };
  }

  return null;
}

function setStatus(message = "", type = "info") {
  const el = $("fulfill-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
}

function setImportStatus(message = "", type = "info") {
  const el = $("import-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function openModal(id) {
  $(id)?.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeModal(id) {
  $(id)?.classList.add("hidden");
  if (
    !$("item-confirm-modal")?.classList.contains("hidden")
    || !$("bundle-review-modal")?.classList.contains("hidden")
    || !$("worker-no-inventory-modal")?.classList.contains("hidden")
    || !$("worker-cancel-order-modal")?.classList.contains("hidden")
    || !$("no-inventory-photo-viewer-modal")?.classList.contains("hidden")
    || !$("ebay-completed-conflicts-modal")?.classList.contains("hidden")
    || !$("order-task-modal")?.classList.contains("hidden")
    || !$("admin-order-closeout-modal")?.classList.contains("hidden")
  ) return;
  document.body.classList.remove("modal-open");
}

function getOrderFromLine(line) {
  const order = line?.ebay_orders || line?.order || {};
  return Array.isArray(order) ? order[0] || {} : order;
}

function getOrderSyncMismatch(line) {
  const order = getOrderFromLine(line);
  const mismatch = order?.raw_payload?.pending_order_sync_mismatch || line?.raw_payload?.pending_order_sync_mismatch || null;
  return mismatch && typeof mismatch === "object" ? mismatch : null;
}

function getRemainingLineQuantity(line) {
  return Math.max(0, Number(line?.quantity || 0) - Number(line?.fulfilled_quantity || 0));
}

function getBuyerKey(line) {
  const username = String(line?.order?.buyer_username || "").trim().toLowerCase();
  return username || `order:${line?.order?.order_number || line?.order_id || "unknown"}`;
}

function getBuyerLabel(line) {
  return String(line?.order?.buyer_username || "").trim() || "No buyer username";
}

function getCheckoutStoreStorageKey() {
  return `og-pending-orders-checkout-store:${state.user?.id || "anonymous"}`;
}

function readSavedCheckoutStoreId() {
  try {
    return localStorage.getItem(getCheckoutStoreStorageKey()) || "";
  } catch (error) {
    console.warn("Could not read saved checkout store:", error);
    return "";
  }
}

function saveCheckoutStoreId(storeId) {
  try {
    if (storeId) localStorage.setItem(getCheckoutStoreStorageKey(), storeId);
    else localStorage.removeItem(getCheckoutStoreStorageKey());
  } catch (error) {
    console.warn("Could not save checkout store:", error);
  }
}

function getCheckoutStore() {
  return state.stores.find((store) => store.id === state.checkoutStoreId) || null;
}

function getCheckoutStoreName(storeId = state.checkoutStoreId) {
  return state.stores.find((store) => store.id === storeId)?.name || "";
}

function requireCheckoutStore() {
  if (state.checkoutStoreId) return true;
  setStatus("Select the checkout store before scanning items.", "error");
  $("checkout-store-select")?.focus();
  return false;
}

async function loadCurrentWorker() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData?.session) {
    window.location.href = "index.html";
    return false;
  }

  state.user = sessionData.session.user;
  const { data: employee, error } = await supabase
    .from("employees")
    .select("id, display_name, role, active")
    .eq("user_id", state.user.id)
    .maybeSingle();

  if (error || !employee || employee.active === false) {
    window.location.href = "index.html";
    return false;
  }

  state.employee = employee;
  return true;
}

function canImportOrders() {
  return Boolean(state.employee && state.employee.active !== false);
}

function isRealAdminUser() {
  return String(state.employee?.role || "").toLowerCase() === "admin";
}

function isAdminUser() {
  return isRealAdminUser() || (PENDING_ORDERS_FULL_ACCESS_FOR_ACTIVE_STAFF && canImportOrders());
}

function setupImportVisibility() {
  const panel = $("order-import-panel");
  if (panel) panel.classList.toggle("hidden", !canImportOrders());
  $("admin-order-actions-panel")?.classList.toggle("hidden", !isAdminUser());
  document.querySelectorAll(".admin-money-field").forEach((field) => {
    field.classList.toggle("hidden", !isAdminUser());
  });
  setupOrderSortOptions();
  renderAdminOrderActions();
}

function setupOrderSortOptions() {
  const select = $("order-sort");
  if (!select) return;

  const current = select.value || state.orderSort || "created_asc";
  const options = [
    ["created_asc", "Sale date oldest first"],
    ["created_desc", "Sale date newest first"],
    ["due_asc", "Due date soonest"],
    ["buyer_asc", "Username A to Z"],
    ["buyer_desc", "Username Z to A"],
  ];

  if (isAdminUser()) {
    options.push(["total_desc", "Order total high to low"]);
    options.push(["total_asc", "Order total low to high"]);
  }

  select.innerHTML = options
    .map(([value, label]) => `<option value="${value}">${label}</option>`)
    .join("");

  state.orderSort = options.some(([value]) => value === current) ? current : "created_asc";
  select.value = state.orderSort;
}

async function loadCheckoutStores() {
  const select = $("checkout-store-select");
  if (select) select.disabled = true;

  const { data, error } = await supabase
    .from("store_locations")
    .select("id, name, active")
    .eq("active", true)
    .order("name", { ascending: true });

  if (error) {
    console.error("Failed to load checkout stores:", error);
    state.stores = [];
    setStatus("Could not load checkout stores.", "error");
    if (select) select.disabled = false;
    return;
  }

  state.stores = data || [];
  const savedStoreId = readSavedCheckoutStoreId();
  const savedStore = state.stores.find((store) => store.id === savedStoreId);
  state.checkoutStoreId = savedStore?.id || (state.stores.length === 1 ? state.stores[0].id : "");
  if (state.checkoutStoreId) saveCheckoutStoreId(state.checkoutStoreId);
  renderCheckoutStoreSelect();
}

function renderCheckoutStoreSelect() {
  const select = $("checkout-store-select");
  if (!select) return;

  select.replaceChildren();
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Select checkout store";
  select.appendChild(placeholder);

  state.stores.forEach((store) => {
    const option = document.createElement("option");
    option.value = store.id;
    option.textContent = store.name || "Unnamed store";
    select.appendChild(option);
  });

  select.value = state.checkoutStoreId || "";
  select.disabled = false;
  updateCheckoutStoreGate();
}

function updateCheckoutStoreGate() {
  const hasStore = Boolean(state.checkoutStoreId);
  $("item-scan")?.toggleAttribute("disabled", !hasStore);
  $("find-item")?.toggleAttribute("disabled", !hasStore);
  $("global-live-lot-scan")?.toggleAttribute("disabled", !hasStore);
  $("global-find-live-lot")?.toggleAttribute("disabled", !hasStore);
  $("location-scan")?.toggleAttribute("disabled", !hasStore);
  $("find-location")?.toggleAttribute("disabled", !hasStore);
  $("stage-current-line")?.toggleAttribute("disabled", !hasStore);
  $("fulfill-order")?.toggleAttribute("disabled", !hasStore);
  $("complete-no-inventory")?.toggleAttribute("disabled", !hasStore);
}

async function handleCheckoutStoreChange() {
  const nextStoreId = $("checkout-store-select")?.value || "";
  state.checkoutStoreId = nextStoreId;
  saveCheckoutStoreId(nextStoreId);
  clearQuantityAutoStage();
  clearItemSearchTimer();
  clearLocationSearchTimer();
  state.selectedItem = null;
  state.selectedStockRow = null;
  state.stockRows = [];
  clearLiveLotSelection({ render: true });
  if (state.stagedFulfillments.size) state.stagedFulfillments.clear();
  renderBuyerBundlePanel();
  renderSelectionSummary();
  renderItemResults([]);
  renderLocationResults([]);
  if ($("item-scan")) $("item-scan").value = "";
  if ($("location-scan")) $("location-scan").value = "";
  updateCheckoutStoreGate();

  if (!nextStoreId) {
    setStatus("Select the checkout store before scanning items.", "error");
    return;
  }

  setStatus(`Checkout store set to ${getCheckoutStoreName(nextStoreId)}. Scan an auction bag or select an order to begin.`, "info");
  setTimeout(() => $("global-live-lot-scan")?.focus(), 80);
}

function setupDashboardShell() {
  const greeting = $("pending-greeting");
  if (greeting) {
    const name = state.employee?.display_name ? `, ${state.employee.display_name}` : "";
    greeting.textContent = `Pending eBay Orders${name}`;
  }

  document.querySelectorAll(".nav-link").forEach((link) => {
    const href = (link.getAttribute("href") || "").split("/").pop();
    link.classList.toggle("active", href === "pending-orders.html");
  });

  document.querySelectorAll(".mobile-nav-links a").forEach((link) => {
    const href = (link.getAttribute("href") || "").split("/").pop();
    link.classList.toggle("active", href === "pending-orders.html");
  });

  $("menu-toggle")?.addEventListener("click", () => {
    $("mobile-menu")?.classList.toggle("show");
  });

  const signOut = async (event) => {
    event.preventDefault();
    await supabase.auth.signOut();
    window.location.href = "index.html";
  };

  $("logout")?.addEventListener("click", signOut);
  $("logout-mobile")?.addEventListener("click", signOut);
}

function normalizeLine(line) {
  const order = getOrderFromLine(line);
  const labelSearchText = getLabelMetadataSearchText(line.label_metadata, order.label_metadata);
  const videoReceiptUrl = getOrderVideoReceiptUrl({ ...line, order });
  const orderCreatedAt = getOrderCreatedAt({ ...line, order });
  return {
    ...line,
    order,
    orderCreatedAt,
    videoReceiptUrl,
    searchText: [
      order.order_number,
      order.sales_record_number,
      order.buyer_username,
      formatDate(orderCreatedAt),
      line.item_number,
      line.transaction_id,
      line.item_title,
      line.custom_label,
      videoReceiptUrl,
      labelSearchText,
    ].filter(Boolean).join(" ").toLowerCase(),
  };
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
    "videoReceiptUrl",
    "videoReceiptUrls",
    "lookupKeys",
    "labelRows",
  ];
  return metadataObjects.flatMap((metadata) => {
    if (!metadata || typeof metadata !== "object") return [];
    return keys.flatMap((key) => flattenLabelMetadataValues(metadata[key]));
  }).filter(Boolean).join(" ");
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
  return [...new Set([
    metadata.trackingNumber,
    metadata.shippingBarcodeNumber,
    ...(Array.isArray(metadata.trackingNumbers) ? metadata.trackingNumbers : []),
    ...(Array.isArray(metadata.shippingBarcodeNumbers) ? metadata.shippingBarcodeNumbers : []),
    ...(Array.isArray(metadata.labelRows) ? metadata.labelRows.flatMap((row) => row?.trackingNumbers || row?.shippingBarcodeNumbers || []) : []),
  ].filter(Boolean).map(String))].join(", ");
}

function getMetadataVideoReceiptUrl(metadata = {}) {
  return getMetadataVideoReceiptUrls(metadata)[0] || "";
}

function getMetadataVideoReceiptUrls(metadata = {}) {
  if (!metadata || typeof metadata !== "object") return [];
  const detail = metadata.returnDetails && typeof metadata.returnDetails === "object" ? metadata.returnDetails : {};
  return [
    metadata.videoReceiptUrl,
    metadata.videoReceiptURL,
    ...(Array.isArray(metadata.videoReceiptUrls) ? metadata.videoReceiptUrls : []),
    detail.videoReceiptUrl,
    detail.videoReceiptURL,
    ...(Array.isArray(detail.videoReceiptUrls) ? detail.videoReceiptUrls : []),
  ].filter(Boolean).map((url) => String(url || "").trim()).filter(Boolean);
}

function normalizeVideoReceiptUrlForLine(url = "", line = {}) {
  const cleanUrl = String(url || "").trim().replace(/&amp;/g, "&");
  if (!cleanUrl) return "";
  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch (_) {
    return "";
  }
  if (!/(^|\.)ebay\.com$/i.test(parsed.hostname) || !/\/ebaylive\/events\//i.test(parsed.pathname)) return "";

  const itemNumber = String(line.item_number || line.itemNumber || "").trim();
  if (!itemNumber) return parsed.toString();

  const selectedItemId = String(parsed.searchParams.get("selectedItemId") || "").trim();
  const itemIds = String(parsed.searchParams.get("itemIds") || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (selectedItemId === itemNumber) return parsed.toString();
  if (itemIds.includes(itemNumber)) {
    parsed.searchParams.set("selectedItemId", itemNumber);
    if (!parsed.searchParams.get("playback")) parsed.searchParams.set("playback", "true");
    return parsed.toString();
  }
  return "";
}

function getOrderVideoReceiptUrl(line = {}) {
  const order = line.order || {};
  return [
    ...getMetadataVideoReceiptUrls(line.label_metadata),
    ...getMetadataVideoReceiptUrls(order.label_metadata),
    state.orderVideoReceipts.get(line.order_id),
    state.orderVideoReceipts.get(order.id),
    state.orderVideoReceipts.get(order.order_number),
    line.videoReceiptUrl,
  ].map((url) => normalizeVideoReceiptUrlForLine(url, line)).find(Boolean) || "";
}

function rememberOrderVideoReceipt(order = {}, url = "") {
  const cleanUrl = String(url || "").trim();
  if (!cleanUrl) return;
  if (order.id) state.orderVideoReceipts.set(order.id, cleanUrl);
  if (order.order_id) state.orderVideoReceipts.set(order.order_id, cleanUrl);
  if (order.order_number) state.orderVideoReceipts.set(order.order_number, cleanUrl);
}

function buildEbayOrderDetailsUrl(orderNumber = "") {
  const cleanNumber = String(orderNumber || "").trim();
  if (!cleanNumber) return "";
  const url = new URL("https://www.ebay.com/mesh/ord/details");
  url.searchParams.set("orderid", cleanNumber);
  return url.toString();
}

function getOrderVideoReceiptLink(line = {}) {
  const order = line.order || {};
  const directUrl = getOrderVideoReceiptUrl(line);
  return {
    url: directUrl,
    orderNumber: order.order_number || "",
    orderDetailsUrl: buildEbayOrderDetailsUrl(order.order_number),
    itemNumber: line.item_number || "",
    transactionId: line.transaction_id || "",
    itemTitle: line.item_title || "",
    itemUrl: line.item_number ? `https://www.ebay.com/itm/${encodeURIComponent(line.item_number)}` : "",
    direct: Boolean(directUrl),
    title: directUrl
      ? "Open the captured eBay Live video receipt"
      : "Resolve and open the eBay Live video receipt",
  };
}

function requestExtensionVideoReceiptOpen(payload = {}) {
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      window.removeEventListener("message", onMessage);
      resolve(result || null);
    };
    const timer = window.setTimeout(() => finish({ ok: false, error: "The eBay extension did not answer." }), 4000);
    const onMessage = (event) => {
      if (event.source !== window || event.origin !== window.location.origin) return;
      if (event.data?.type !== "OG_EBAY_VIDEO_RECEIPT_OPEN_RESPONSE") return;
      if (event.data?.requestId !== requestId) return;
      finish(event.data.payload || null);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({
      type: "OG_EBAY_VIDEO_RECEIPT_OPEN_REQUEST",
      requestId,
      payload,
    }, window.location.origin);
  });
}

async function openVideoReceiptLink(event, receiptLink = {}) {
  if (receiptLink.direct || !receiptLink.orderNumber) return;
  event.preventDefault();
  event.stopPropagation();
  const result = await requestExtensionVideoReceiptOpen({
    orderNumber: receiptLink.orderNumber,
    orderDetailsUrl: receiptLink.orderDetailsUrl,
    itemNumber: receiptLink.itemNumber,
    transactionId: receiptLink.transactionId,
    itemTitle: receiptLink.itemTitle,
    itemUrl: receiptLink.itemUrl,
  });
  if (!result?.ok) {
    setStatus(result?.error || "Could not open the eBay video receipt. Make sure the OG eBay extension is enabled and you are signed in to eBay.", "error");
  }
}

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];

    if (quoted) {
      if (char === '"' && next === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        value += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(value);
      value = "";
    } else if (char === "\n") {
      row.push(value);
      rows.push(row);
      row = [];
      value = "";
    } else if (char !== "\r") {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  return rows;
}

function rowsFromEbayCsv(text) {
  const parsed = parseCsv(String(text || "").replace(/^\uFEFF/, ""));
  const headerIndex = parsed.findIndex((row) =>
    row.some((cell) => normalizeCsvHeader(cell) === "ordernumber")
    && row.some((cell) => normalizeCsvHeader(cell) === "itemtitle")
  );

  if (headerIndex < 0) {
    throw new Error("Could not find the eBay orders header row. Make sure this is the Orders Report CSV.");
  }

  const headers = parsed[headerIndex].map((cell) => String(cell || "").trim());
  return parsed.slice(headerIndex + 1).map((row) => {
    const record = {};
    headers.forEach((header, index) => {
      if (header) record[header] = row[index] ?? "";
    });
    return record;
  });
}

function normalizeCsvHeader(value) {
  return String(value || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function csvCell(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") {
      return String(row[name]).trim();
    }
  }
  const entries = Object.entries(row || {});
  for (const name of names) {
    const normalizedName = normalizeCsvHeader(name);
    const match = entries.find(([header, value]) =>
      normalizeCsvHeader(header) === normalizedName
      && value !== undefined
      && value !== null
      && String(value).trim() !== ""
    );
    if (match) return String(match[1]).trim();
  }
  return "";
}

function parseEbayDate(value) {
  const text = String(value || "").trim();
  if (!text) return null;

  const match = text.match(/^([A-Za-z]{3})-(\d{1,2})-(\d{2,4})$/);
  if (match) {
    const months = {
      jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
      jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
    };
    const month = months[match[1].toLowerCase()];
    const day = Number(match[2]);
    const rawYear = Number(match[3]);
    const year = rawYear < 100 ? 2000 + rawYear : rawYear;
    if (month !== undefined && day > 0) {
      return new Date(Date.UTC(year, month, day, 12, 0, 0)).toISOString();
    }
  }

  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function toNumber(value) {
  return Number(parseMoney(value).toFixed(2));
}

function estimateEbayPayoutFromRow(row) {
  const explicit = toNumber(csvCell(row, "Payout Amount", "Net Amount"));
  if (explicit > 0) return explicit;

  const total = toNumber(csvCell(row, "Total Price"));
  const ebayTax = toNumber(csvCell(row, "eBay Collected Tax"));
  const sellerTax = toNumber(csvCell(row, "Seller Collected Tax"));
  const ebayCharges = toNumber(csvCell(row, "eBay Collected Charges"));
  const estimate = total - ebayTax - sellerTax - ebayCharges;
  return Number(Math.max(0, estimate).toFixed(2));
}

function buildOrderImportPayload(rows) {
  const grouped = new Map();

  rows.forEach((row) => {
    const orderNumber = csvCell(row, "Order Number");
    const itemTitle = csvCell(row, "Item Title");
    if (!orderNumber || !itemTitle) return;

    if (!grouped.has(orderNumber)) {
      grouped.set(orderNumber, {
        source: row,
        lines: [],
        orderNumber,
      });
    }
    grouped.get(orderNumber).lines.push(row);
  });

  const orders = [...grouped.values()].map((group) => {
    const first = group.source;
    const orderTotals = group.lines.reduce((totals, line) => {
      totals.shipping += toNumber(csvCell(line, "Shipping And Handling"));
      totals.sellerTax += toNumber(csvCell(line, "Seller Collected Tax"));
      totals.ebayTax += toNumber(csvCell(line, "eBay Collected Tax"));
      totals.ebayCharges += toNumber(csvCell(line, "eBay Collected Charges"));
      totals.total += toNumber(csvCell(line, "Total Price"));
      totals.payout += estimateEbayPayoutFromRow(line);
      return totals;
    }, { shipping: 0, sellerTax: 0, ebayTax: 0, ebayCharges: 0, total: 0, payout: 0 });

    return {
      order: {
        order_number: group.orderNumber,
        sales_record_number: csvCell(first, "Sales Record Number"),
        buyer_username: csvCell(first, "Buyer Username"),
        buyer_name: csvCell(first, "Buyer Name"),
        buyer_email: csvCell(first, "Buyer Email"),
        item_location: csvCell(first, "Item Location"),
        item_zip_code: csvCell(first, "Item Zip Code"),
        item_country: csvCell(first, "Item Country"),
        payment_method: csvCell(first, "Payment Method"),
        sale_date: parseEbayDate(csvCell(first, "Sale Date")),
        paid_on_date: parseEbayDate(csvCell(first, "Paid On Date")),
        ship_by_date: parseEbayDate(csvCell(first, "Ship By Date")),
        shipped_on_date: parseEbayDate(csvCell(first, "Shipped On Date")),
        tracking_number: csvCell(first, "Tracking Number"),
        shipping_service: csvCell(first, "Shipping Service"),
        shipping_and_handling: orderTotals.shipping,
        seller_collected_tax: orderTotals.sellerTax,
        ebay_collected_tax: orderTotals.ebayTax,
        ebay_collected_charges: orderTotals.ebayCharges,
        total_price: orderTotals.total,
        net_payout: orderTotals.payout || null,
        status: "pending",
        imported_by: state.user?.id || null,
        raw_payload: { source: "ebay_orders_report_csv", first_row: first },
      },
      lines: group.lines.map((line) => ({
        item_number: csvCell(line, "Item Number"),
        transaction_id: csvCell(line, "Transaction ID"),
        item_title: csvCell(line, "Item Title"),
        custom_label: csvCell(line, "Custom Label", "My Item Note"),
        quantity: Math.max(1, parseInt(csvCell(line, "Quantity") || "1", 10) || 1),
        sold_for: toNumber(csvCell(line, "Sold For")),
        shipping_and_handling: toNumber(csvCell(line, "Shipping And Handling")),
        total_price: toNumber(csvCell(line, "Total Price")),
        net_payout: estimateEbayPayoutFromRow(line) || null,
        line_status: "pending",
        raw_payload: line,
      })),
    };
  });

  return orders;
}

async function loadExistingOrdersByNumber(orderNumbers) {
  const existing = new Map();
  for (let index = 0; index < orderNumbers.length; index += 100) {
    const chunk = orderNumbers.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_orders")
      .select("id, order_number, status, buyer_username, buyer_name, total_price, net_payout, imported_at, updated_at")
      .in("order_number", chunk);

    if (error) throw error;
    (data || []).forEach((row) => existing.set(row.order_number, row));
  }
  return existing;
}

function isClosedEbayImportStatus(status) {
  return CLOSED_EBAY_IMPORT_STATUSES.has(String(status || "").toLowerCase());
}

function buildCompletedHistoryConflict(entry, existingOrder) {
  return {
    orderNumber: entry.order.order_number,
    buyerUsername: existingOrder?.buyer_username || entry.order.buyer_username || "",
    buyerName: existingOrder?.buyer_name || entry.order.buyer_name || "",
    status: existingOrder?.status || "",
    reportLineCount: entry.lines.length,
    totalPrice: Number(existingOrder?.total_price ?? entry.order.total_price ?? 0),
    shipByDate: entry.order.ship_by_date || "",
    appUpdatedAt: existingOrder?.updated_at || existingOrder?.imported_at || "",
  };
}

function normalizeEbayOrderNumber(value) {
  const text = String(value || "").trim();
  const match = text.match(/\b\d{2}-\d{5}-\d{5}\b/);
  return match ? match[0] : "";
}

function getRequestedEbayOrderNumbers() {
  const params = new URLSearchParams(window.location.search);
  const values = [
    params.get("orderId"),
    params.get("order"),
    params.get("ebayOrder"),
    ...(params.get("orderIds") || "").split(","),
  ];
  return [...new Set(values
    .map(normalizeEbayOrderNumber)
    .filter((value) => EBAY_ORDER_NUMBER_PATTERN.test(value)))];
}

function getRequestedEbayAllOrderNumbers() {
  const params = new URLSearchParams(window.location.search);
  return [...new Set(String(params.get("ebayAllOrderIds") || "")
    .split(",")
    .map(normalizeEbayOrderNumber)
    .filter((value) => EBAY_ORDER_NUMBER_PATTERN.test(value)))];
}

function getRequestedPositiveIntegerParam(name) {
  const value = Number(new URLSearchParams(window.location.search).get(name) || 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function decodeBase64UrlJson(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    console.warn("Could not decode eBay order snapshot:", error);
    return null;
  }
}

function getRequestedEbayOrderSnapshot() {
  const params = new URLSearchParams(window.location.search);
  const snapshot = decodeBase64UrlJson(params.get("ebayOrderSnapshot"));
  if (!snapshot || typeof snapshot !== "object") return null;

  const orderNumber = normalizeEbayOrderNumber(snapshot.orderNumber || params.get("orderId"));
  return {
    ...snapshot,
    orderNumber,
  };
}

function getRequestedOrderTaskId() {
  const value = String(new URLSearchParams(window.location.search).get("orderTaskId") || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "";
}

function formatEbaySnapshotSummary(snapshot) {
  if (!snapshot) return "";
  const parts = [
    snapshot.buyerUsername ? `buyer ${snapshot.buyerUsername}` : "",
    snapshot.shipToName ? `ship to ${snapshot.shipToName}` : "",
    snapshot.orderValue ? `order value ${snapshot.orderValue}` : "",
    snapshot.selectedService?.name ? `label service ${snapshot.selectedService.name}` : "",
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : "";
}

function parseAwaitingSummaryTotal(value) {
  const match = String(value || "").match(/\bof\s+([\d,]+)/i);
  if (!match) return 0;
  const total = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(total) ? total : 0;
}

async function importEbayPendingOrdersReport(text, metadata = {}) {
  const rows = rowsFromEbayCsv(text);
  const payload = buildOrderImportPayload(rows).map((entry) => ({
    ...entry,
    order: {
      ...entry.order,
      raw_payload: {
        ...(entry.order.raw_payload || {}),
        import_metadata: {
          originalFilename: metadata.filename || metadata.originalFilename || "",
          reportGeneratedAt: metadata.reportGeneratedAt || metadata.capturedAt || "",
          importTimestamp: metadata.importTimestamp || new Date().toISOString(),
          sourcePageUrl: metadata.pageUrl || "",
          awaitingShipmentSummaryText: metadata.visibleSummaryText || "",
          source: metadata.source || "manual-ebay-orders-report",
        },
      },
    },
  }));
  if (!payload.length) throw new Error("No usable eBay order rows were found in that CSV.");
  const reportLineCount = payload.reduce((count, entry) => count + entry.lines.length, 0);
  const expectedAwaitingTotal = parseAwaitingSummaryTotal(metadata.visibleSummaryText);
  const warnings = [];
  if (expectedAwaitingTotal && payload.length < expectedAwaitingTotal) {
    warnings.push(`The eBay page summary said ${metadata.visibleSummaryText}, but the report contained ${payload.length} order(s).`);
  }

  const incomingNumbers = [...new Set(payload.map((entry) => entry.order.order_number))];
  const existingOrders = await loadExistingOrdersByNumber(incomingNumbers);
  const completedHistoryConflicts = payload
    .filter((entry) => isClosedEbayImportStatus(existingOrders.get(entry.order.order_number)?.status))
    .map((entry) => buildCompletedHistoryConflict(entry, existingOrders.get(entry.order.order_number)));
  const blockedHistoryOrderNumbers = new Set(completedHistoryConflicts.map((entry) => entry.orderNumber));
  if (completedHistoryConflicts.length) {
    warnings.push(`${completedHistoryConflicts.length} order(s) from the eBay report are already completed/canceled/archived in OG order history and were not re-imported.`);
  }

  const importablePayload = payload.filter((entry) => !blockedHistoryOrderNumbers.has(entry.order.order_number));
  const fresh = importablePayload.filter((entry) => !existingOrders.has(entry.order.order_number));
  const skipped = importablePayload.length - fresh.length;

  let insertedOrders = [];
  let insertedOrderIds = [];
  if (fresh.length) {
    const { data, error: orderError } = await supabase
      .from("ebay_orders")
      .insert(fresh.map((entry) => entry.order))
      .select("id, order_number");

    if (orderError) throw orderError;
    insertedOrders = data || [];
    insertedOrderIds = insertedOrders.map((order) => order.id).filter(Boolean);
  }

  const orderIdByNumber = new Map([
    ...[...existingOrders.entries()]
      .filter(([, order]) => !isClosedEbayImportStatus(order?.status))
      .map(([orderNumber, order]) => [orderNumber, order.id]),
    ...(insertedOrders || []).map((order) => [order.order_number, order.id]),
  ]);
  const lineRows = importablePayload.flatMap((entry) => {
    const orderId = orderIdByNumber.get(entry.order.order_number);
    return entry.lines.map((line) => ({ ...line, order_id: orderId }));
  }).filter((line) => line.order_id);

  let insertedLineCount = 0;
  if (lineRows.length) {
    const { data: insertedLines, error: lineError } = await supabase
      .from("ebay_order_lines")
      .upsert(lineRows, {
        onConflict: "order_id,item_number,transaction_id",
        ignoreDuplicates: true,
      })
      .select("id, order_id");

    if (lineError) {
      if (insertedOrderIds.length) {
        await supabase.from("ebay_orders").delete().in("id", insertedOrderIds);
      }
      throw lineError;
    }

    insertedLineCount = (insertedLines || []).length;
  }

  const statusUpdatedOrderCount = 0;

  return {
    originalFilename: metadata.filename || metadata.originalFilename || "",
    source: metadata.source || "manual-ebay-orders-report",
    capturedAt: metadata.capturedAt || "",
    importedAt: metadata.importTimestamp || new Date().toISOString(),
    sourcePageUrl: metadata.pageUrl || "",
    visibleSummaryText: metadata.visibleSummaryText || "",
    expectedAwaitingTotal,
    reportRowsRead: rows.length,
    ordersInReport: payload.length,
    linesInReport: reportLineCount,
    linesCheckedForImport: lineRows.length,
    completedHistoryConflicts,
    completedHistoryConflictCount: completedHistoryConflicts.length,
    newOrdersAdded: insertedOrders.length,
    existingOrdersChecked: skipped,
    newLinesAdded: insertedLineCount,
    ordersReopenedOrUpdated: statusUpdatedOrderCount,
    warnings,
  };
}

function closeCompletedHistoryConflictsModal() {
  closeModal("ebay-completed-conflicts-modal");
}

function showCompletedHistoryConflictsModal(conflicts = []) {
  const cleanConflicts = Array.isArray(conflicts) ? conflicts.filter(Boolean) : [];
  if (!cleanConflicts.length) return;

  const summary = $("ebay-completed-conflicts-summary");
  const list = $("ebay-completed-conflicts-list");
  if (summary) {
    summary.textContent =
      `${cleanConflicts.length} order${cleanConflicts.length === 1 ? "" : "s"} still appear in the eBay awaiting-shipment report, but OG already has them closed in order history. They were skipped and not re-imported.`;
  }

  if (list) {
    list.replaceChildren();
    cleanConflicts.forEach((conflict) => {
      const card = document.createElement("article");
      card.className = "completed-conflict-card";
      card.innerHTML = `
        <div>
          <strong>${escapeHtml(conflict.orderNumber || "Unknown order")}</strong>
          <span>${escapeHtml(conflict.buyerUsername || conflict.buyerName || "Unknown buyer")}</span>
        </div>
        <div>
          <span class="status-badge">${escapeHtml(conflict.status || "closed")}</span>
          <small>${Number(conflict.reportLineCount || 0).toLocaleString()} line${Number(conflict.reportLineCount || 0) === 1 ? "" : "s"} in eBay report</small>
        </div>
        <div>
          <small>Ship by ${escapeHtml(formatDate(conflict.shipByDate))}</small>
          <small>${formatMoney(conflict.totalPrice || 0)}</small>
        </div>
      `;
      list.appendChild(card);
    });
  }

  openModal("ebay-completed-conflicts-modal");
}

async function importEbayOrdersFromCsv() {
  if (!canImportOrders()) {
    setImportStatus("Your OG user is not allowed to import eBay order reports.", "error");
    return;
  }

  const file = $("ebay-orders-file")?.files?.[0];
  if (!file) {
    setImportStatus("Choose the eBay Orders Report CSV first.", "error");
    return;
  }

  const button = $("import-ebay-orders");
  if (button) button.disabled = true;
  setImportStatus("Reading eBay orders report...");

  try {
    const text = await file.text();
    const result = await importEbayPendingOrdersReport(text, {
      source: "manual-ebay-orders-report",
      filename: file.name,
      capturedAt: new Date(file.lastModified || Date.now()).toISOString(),
    });

    const historyConflictText = result.completedHistoryConflictCount
      ? ` Skipped ${result.completedHistoryConflictCount} order(s) already closed in OG order history.`
      : "";
    setImportStatus(`Imported ${result.newOrdersAdded} new order(s) and ${result.newLinesAdded} new line item(s). Checked ${result.existingOrdersChecked} existing order(s) for missing lines.${historyConflictText}`, "success");
    $("ebay-orders-file").value = "";
    await loadOrders();
    showCompletedHistoryConflictsModal(result.completedHistoryConflicts);
  } catch (error) {
    console.error("eBay order import failed:", error);
    setImportStatus(error.message || "Could not import eBay orders.", "error");
  } finally {
    if (button) button.disabled = false;
  }
}

function getEbayOrderSyncUrl() {
  const projectRef = String(window.SUPABASE_URL || "")
    .match(/^https:\/\/([^.]+)\.supabase\.co/i)?.[1] || "byhytmarmigalvawkedi";
  return `https://${projectRef}.functions.supabase.co/ebay-order-sync`;
}

async function postEbayOrderSyncPayload(payload) {
  const response = await fetch(getEbayOrderSyncUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { ok: false, error: text || `HTTP ${response.status}` };
  }
  if (!response.ok && !data.error) data.error = `HTTP ${response.status}`;
  return data;
}

function getEbayOrderSyncDaysBack() {
  const value = Number($("ebay-order-sync-days-back")?.value || 14);
  if (!Number.isFinite(value)) return 14;
  return Math.min(180, Math.max(1, Math.round(value)));
}

function setEbayOrderSyncBusy(busy) {
  state.ebayOrderSyncBusy = busy;
  $("ebay-order-sync-check")?.toggleAttribute("disabled", busy);
  $("ebay-order-sync-run")?.toggleAttribute("disabled", busy);
  $("import-ebay-orders")?.toggleAttribute("disabled", busy);
}

function summarizeEbayOrderSyncResult(result, dryRun) {
  if (!result?.ok) {
    return formatEbayOrderSyncError(result?.error || result) || "Could not sync eBay orders.";
  }

  if (dryRun) {
    const warnings = Array.isArray(result.warnings) && result.warnings.length
      ? ` ${result.warnings.length} warning(s).`
      : "";
    const mismatches = Number(result.localPendingMismatches?.length || 0);
    const mismatchText = mismatches
      ? ` ${mismatches.toLocaleString()} local pending order(s) need eBay review.`
      : "";
    const skippedMismatchCheck = result.localPendingMismatchCheckSkipped
      ? " Local missing-order check was skipped because the eBay fetch reached its limit."
      : "";
    return `Found ${Number(result.ordersSeen || 0).toLocaleString()} eBay order(s); ${Number(result.ordersImportable || 0).toLocaleString()} can be imported or updated.${mismatchText}${skippedMismatchCheck}${warnings}`;
  }

  const warnings = Array.isArray(result.warnings) && result.warnings.length
    ? ` ${result.warnings.length} warning(s).`
    : "";
  const mismatches = Number(result.localPendingMismatches?.length || 0);
  const mismatchText = mismatches
    ? ` ${mismatches.toLocaleString()} local pending order(s) were flagged for eBay review.`
    : "";
  const skippedMismatchCheck = result.localPendingMismatchCheckSkipped
    ? " Local missing-order check was skipped because the eBay fetch reached its limit."
    : "";
  return `Synced ${Number(result.ordersImported || 0).toLocaleString()} order(s), ${Number(result.linesImported || 0).toLocaleString()} line(s), and reserved ${Number(result.linesReserved || 0).toLocaleString()} line(s).${mismatchText}${skippedMismatchCheck}${warnings}`;
}

function formatEbayOrderSyncError(error) {
  if (!error) return "";
  if (typeof error === "string") return error;
  if (error instanceof Error) return error.message;
  if (typeof error === "object") {
    const parts = [
      error.message,
      error.details,
      error.hint,
      error.code ? `code: ${error.code}` : "",
    ].map((value) => String(value || "").trim()).filter(Boolean);
    if (parts.length) return parts.join(" | ");
    try {
      return JSON.stringify(error);
    } catch {
      return "Unknown eBay order sync error.";
    }
  }
  return String(error);
}

async function runEbayOrderApiSync(dryRun = true) {
  if (!canImportOrders()) {
    setImportStatus("Your OG user is not allowed to sync eBay orders.", "error");
    return;
  }
  if (state.ebayOrderSyncBusy) return;

  const payload = {
    dryRun,
    reserve: !dryRun,
    limit: 100,
    daysBack: getEbayOrderSyncDaysBack(),
  };

  setEbayOrderSyncBusy(true);
  setImportStatus(dryRun ? "Checking eBay awaiting shipments..." : "Syncing eBay orders and reserving stock...");

  try {
    const result = await postEbayOrderSyncPayload(payload);
    setImportStatus(summarizeEbayOrderSyncResult(result, dryRun), result?.ok ? "success" : "error");
    if (Array.isArray(result?.warnings) && result.warnings.length) {
      console.warn("eBay order sync warnings:", result.warnings);
    }
    if (!dryRun && result?.ok) {
      clearEbayLaunchFilter({ apply: false });
      clearOrderSearch({ apply: false });
      await loadOrders();
    }
  } catch (error) {
    console.error("eBay API order sync failed:", error);
    setImportStatus(formatEbayOrderSyncError(error) || "Could not sync eBay orders.", "error");
  } finally {
    setEbayOrderSyncBusy(false);
  }
}

function buildOrderLineQueueQuery(status, admin) {
  const moneyLineFields = admin ? `
      sold_for,
      shipping_and_handling,
      total_price,
      net_payout,` : "";
  const moneyOrderFields = admin ? `
        payment_method,
        shipping_and_handling,
        ebay_collected_tax,
        total_price,
        net_payout,` : "";

  let query = supabase
    .from("ebay_order_lines")
    .select(`
      id,
      order_id,
      item_number,
      transaction_id,
      item_title,
      custom_label,
      quantity,
      ${moneyLineFields}
      line_status,
      created_at,
      internal_item_id,
      fulfilled_quantity,
      fulfilled_at,
      notes,
      raw_payload,
      ebay_orders!inner(
        id,
        order_number,
        sales_record_number,
        buyer_username,
        sale_date,
        paid_on_date,
        imported_at,
        ship_by_date,
        ${moneyOrderFields}
        status,
        raw_payload,
        label_status,
        label_storage_bucket,
        label_file_path,
        label_uploaded_at,
        label_metadata
      )
    `)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  if (status === "pending") {
    query = query.in("line_status", ["pending", "partially_fulfilled"]);
  } else if (status === "fulfilled") {
    query = query.eq("line_status", "fulfilled");
  } else {
    query = query.in("line_status", ["pending", "partially_fulfilled", "fulfilled"]);
  }

  return query;
}

async function fetchOrderLineQueue(status, admin) {
  const rows = [];
  for (let from = 0; ; from += ORDER_QUEUE_PAGE_SIZE) {
    const to = from + ORDER_QUEUE_PAGE_SIZE - 1;
    const { data, error } = await buildOrderLineQueueQuery(status, admin).range(from, to);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < ORDER_QUEUE_PAGE_SIZE) break;
  }
  return rows;
}

async function hydrateOrderVideoReceipts(lines = []) {
  state.orderVideoReceipts.clear();
  lines.forEach((line) => {
    const order = getOrderFromLine(line);
    rememberOrderVideoReceipt(order, getMetadataVideoReceiptUrl(line.label_metadata) || getMetadataVideoReceiptUrl(order.label_metadata));
  });

  const orderIds = [...new Set(lines.map((line) => line.order_id || getOrderFromLine(line).id).filter(Boolean))];
  const orderNumbers = [...new Set(lines.map((line) => getOrderFromLine(line).order_number).filter(Boolean))];
  if (!orderIds.length && !orderNumbers.length) return;

  try {
    const returnRows = [];
    for (let index = 0; index < orderIds.length; index += 100) {
      const chunk = orderIds.slice(index, index + 100);
      const { data, error } = await supabase
        .from("ebay_return_cases")
        .select("order_id, order_number, raw_payload, opened_at")
        .in("order_id", chunk)
        .order("opened_at", { ascending: false });
      if (error) throw error;
      returnRows.push(...(data || []));
    }

    const idsCovered = new Set(returnRows.map((row) => row.order_id).filter(Boolean));
    const missingOrderNumbers = orderNumbers.filter((orderNumber) => {
      const matchingLine = lines.find((line) => getOrderFromLine(line).order_number === orderNumber);
      const orderId = matchingLine?.order_id || getOrderFromLine(matchingLine).id;
      return !orderId || !idsCovered.has(orderId);
    });
    for (let index = 0; index < missingOrderNumbers.length; index += 100) {
      const chunk = missingOrderNumbers.slice(index, index + 100);
      const { data, error } = await supabase
        .from("ebay_return_cases")
        .select("order_id, order_number, raw_payload, opened_at")
        .in("order_number", chunk)
        .order("opened_at", { ascending: false });
      if (error) throw error;
      returnRows.push(...(data || []));
    }

    returnRows.forEach((returnCase) => {
      rememberOrderVideoReceipt(returnCase, getMetadataVideoReceiptUrl(returnCase.raw_payload));
    });
  } catch (error) {
    console.warn("Could not load return video receipts for pending orders:", error);
  }
}

async function loadOrders() {
  const status = $("order-status-filter")?.value || "pending";
  const list = $("orders-list");
  if (list) list.innerHTML = `<div class="empty-state">Loading pending orders...</div>`;
  const admin = isAdminUser();

  let data;
  try {
    data = await fetchOrderLineQueue(status, admin);
  } catch (error) {
    console.error("Failed to load pending eBay orders:", error);
    if (list) list.innerHTML = `<div class="empty-state">Could not load eBay orders. Make sure the pending-order migration has been pushed.</div>`;
    return;
  }

  await hydrateOrderVideoReceipts(data);
  state.queueVideoReceiptTasks = [];
  state.queueVideoReceiptTaskEvents = new Map();
  state.queueVideoReceiptLoadedOrderIds.clear();
  state.orders = data.map(normalizeLine);
  await hydrateOrderTaskAssignments(state.orders);
  if (state.selectedLiveLot) {
    setLiveLotOrderMatches(calculateLiveLotOrderMatches(state.selectedLiveLot, state.selectedLiveLotItems));
  }
  applyOrderFilters();
}

function clearOrderSearch({ apply = true } = {}) {
  const input = $("order-search");
  if (!input || !input.value) return;
  input.value = "";
  if (apply) applyOrderFilters();
}

function clearOrderCreatedDateFilter({ apply = true } = {}) {
  const input = $("order-created-date-filter");
  if (!input || !input.value) return;
  input.value = "";
  if (apply) applyOrderFilters();
}

function expandSearchMatchesToBuyerBundles(lines = [], term = "") {
  if (!term) return lines;
  const matchingBuyerKeys = new Set(
    lines
      .filter((line) => (line.searchText || "").includes(term))
      .map(getBuyerKey)
      .filter(Boolean)
  );
  if (!matchingBuyerKeys.size) return [];
  return lines.filter((line) => matchingBuyerKeys.has(getBuyerKey(line)));
}

function applyOrderFilters() {
  const term = String($("order-search")?.value || "").trim().toLowerCase();
  const createdDate = $("order-created-date-filter")?.value || "";
  let filtered = [...state.orders];

  if (createdDate) {
    filtered = filtered.filter((line) => toLocalDateInputValue(line.orderCreatedAt || getOrderCreatedAt(line)) === createdDate);
  }

  if (state.selectedLiveLot) {
    filtered = filtered.filter((line) => state.liveLotMatchedLineIds.has(line.id));
  }

  if (state.ebayLaunchBuyerKeys.size) {
    filtered = filtered.filter((line) => state.ebayLaunchBuyerKeys.has(getBuyerKey(line)));
  } else if (state.ebayLaunchOrderNumbers.size) {
    filtered = filtered.filter((line) => state.ebayLaunchOrderNumbers.has(String(line.order?.order_number || "")));
  }

  filtered = expandSearchMatchesToBuyerBundles(filtered, term);

  state.filteredOrders = filtered;
  renderOrders();
  renderSummaryStrip();
  renderAdminOrderActions();
  renderLiveLotOrderMatches();
}

function clearEbayLaunchFilter({ apply = true } = {}) {
  if (!state.ebayLaunchOrderNumbers.size && !state.ebayLaunchBuyerKeys.size && !state.ebayLaunchSnapshot && !state.ebayLaunchAllOrderNumbers.size && !state.ebayLaunchTotalCount) return;
  state.ebayLaunchOrderNumbers.clear();
  state.ebayLaunchBuyerKeys.clear();
  state.ebayLaunchAllOrderNumbers.clear();
  state.ebayLaunchSelectedCount = 0;
  state.ebayLaunchTotalCount = 0;
  state.ebayLaunchSnapshot = null;
  if (apply) applyOrderFilters();
}

function applyEbayLaunchOrderSelection() {
  const orderNumbers = getRequestedEbayOrderNumbers();
  if (!orderNumbers.length) return;

  state.ebayLaunchSnapshot = getRequestedEbayOrderSnapshot();
  state.ebayLaunchOrderNumbers = new Set(orderNumbers);
  state.ebayLaunchAllOrderNumbers = new Set(getRequestedEbayAllOrderNumbers());
  state.ebayLaunchSelectedCount = getRequestedPositiveIntegerParam("ebaySelectedCount") || orderNumbers.length;
  state.ebayLaunchTotalCount = getRequestedPositiveIntegerParam("ebayTotalCount") || state.ebayLaunchAllOrderNumbers.size || orderNumbers.length;
  state.ebayLaunchBuyerKeys.clear();
  clearLiveLotSelection({ render: false });
  const matches = state.orders.filter((line) => state.ebayLaunchOrderNumbers.has(String(line.order?.order_number || "")));

  if (!matches.length) {
    applyOrderFilters();
    const joined = orderNumbers.join(", ");
    const snapshotSummary = formatEbaySnapshotSummary(state.ebayLaunchSnapshot);
    const pageDetails = snapshotSummary ? ` Page data: ${snapshotSummary}.` : "";
    setStatus(`No pending order line matched eBay order ${joined}.${pageDetails} Make sure the latest eBay report was imported.`, "error");
    return;
  }

  state.ebayLaunchBuyerKeys.clear();
  applyOrderFilters();
  const openMatch = matches.find(isOpenOrderLine) || matches[0];
  if (openMatch) {
    selectOrderLine(openMatch.id);
  }
  const foundNumbers = new Set(matches.map((line) => line.order?.order_number).filter(Boolean));
  const missing = orderNumbers.filter((orderNumber) => !foundNumbers.has(orderNumber));
  const visibleBuyerLines = state.filteredOrders.length;
  let message = missing.length
    ? `Opened ${matches.length.toLocaleString()} matching line(s). Missing from pending orders: ${missing.join(", ")}.`
    : `Opened ${matches.length.toLocaleString()} matching eBay label line(s). Showing ${visibleBuyerLines.toLocaleString()} pending line(s) for that buyer.`;
  const snapshotSummary = formatEbaySnapshotSummary(state.ebayLaunchSnapshot);
  if (snapshotSummary) message += ` eBay page data: ${snapshotSummary}.`;
  message += state.checkoutStoreId ? " Refresh returns to the full queue." : " Select the checkout store before packing.";
  setStatus(message, missing.length ? "error" : "info");
  if (state.checkoutStoreId && openMatch && isOpenOrderLine(openMatch)) {
    setTimeout(() => openWorkerNoInventoryModal({ autoRequestPhoto: true }), 250);
  }
}

function renderSummaryStrip() {
  const openLines = state.orders.filter(isOpenOrderLine);
  const openGroups = groupLinesByBuyer(openLines);
  const urgencyCounts = {
    overdue: { groups: 0, lines: 0 },
    today: { groups: 0, lines: 0 },
    tomorrow: { groups: 0, lines: 0 },
  };

  openGroups.forEach((group) => {
    const bucket = getOrderUrgency(group.nextShipBy)?.level;
    if (!urgencyCounts[bucket]) return;
    urgencyCounts[bucket].groups += 1;
    urgencyCounts[bucket].lines += group.lines.filter(isOpenOrderLine).length;
  });

  $("summary-pending").textContent = `${openGroups.length.toLocaleString()} group${openGroups.length === 1 ? "" : "s"}`;
  $("summary-pending-lines").textContent = `${openLines.length.toLocaleString()} item line${openLines.length === 1 ? "" : "s"}`;
  $("summary-overdue-orders").textContent = `${urgencyCounts.overdue.groups.toLocaleString()} group${urgencyCounts.overdue.groups === 1 ? "" : "s"}`;
  $("summary-overdue-lines").textContent = `${urgencyCounts.overdue.lines.toLocaleString()} item line${urgencyCounts.overdue.lines === 1 ? "" : "s"}`;
  $("summary-today-orders").textContent = `${urgencyCounts.today.groups.toLocaleString()} group${urgencyCounts.today.groups === 1 ? "" : "s"}`;
  $("summary-today-lines").textContent = `${urgencyCounts.today.lines.toLocaleString()} item line${urgencyCounts.today.lines === 1 ? "" : "s"}`;
  $("summary-tomorrow-orders").textContent = `${urgencyCounts.tomorrow.groups.toLocaleString()} group${urgencyCounts.tomorrow.groups === 1 ? "" : "s"}`;
  $("summary-tomorrow-lines").textContent = `${urgencyCounts.tomorrow.lines.toLocaleString()} item line${urgencyCounts.tomorrow.lines === 1 ? "" : "s"}`;
  const buyerGroupCount = groupLinesByBuyer(state.filteredOrders).length;
  const visibleLineCount = state.filteredOrders.length;
  $("order-count-pill").textContent = `${visibleLineCount.toLocaleString()} line${visibleLineCount === 1 ? "" : "s"} / ${buyerGroupCount.toLocaleString()} buyer${buyerGroupCount === 1 ? "" : "s"}`;
}

function groupLinesByBuyer(lines) {
  const groups = new Map();
  lines.forEach((line) => {
    const key = getBuyerKey(line);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        buyer: getBuyerLabel(line),
        lines: [],
        orderNumbers: new Set(),
        pendingCount: 0,
        totalQuantity: 0,
        totalValue: 0,
        nextShipBy: null,
        earliestPendingOrderCreatedAt: null,
      });
    }

    const group = groups.get(key);
    group.lines.push(line);
    if (line.order?.order_number) group.orderNumbers.add(line.order.order_number);
    if (isOpenOrderLine(line)) group.pendingCount += 1;
    group.totalQuantity += Number(line.quantity || 0);
    group.totalValue += Number(line.total_price || line.sold_for || 0);

    const shipBy = line.order?.ship_by_date ? new Date(line.order.ship_by_date) : null;
    if (shipBy && !Number.isNaN(shipBy.getTime())) {
      const current = group.nextShipBy ? new Date(group.nextShipBy) : null;
      if (!current || shipBy < current) group.nextShipBy = line.order.ship_by_date;
    }

    if (isOpenOrderLine(line)) {
      const createdAt = line.orderCreatedAt || getOrderCreatedAt(line);
      const createdTime = getOrderCreatedTimestamp(createdAt);
      const currentTime = getOrderCreatedTimestamp(group.earliestPendingOrderCreatedAt);
      if (createdTime < currentTime) group.earliestPendingOrderCreatedAt = createdAt;
    }
  });

  groups.forEach((group) => {
    if (!group.earliestPendingOrderCreatedAt && group.lines.length) {
      group.earliestPendingOrderCreatedAt = group.lines
        .map((line) => line.orderCreatedAt || getOrderCreatedAt(line))
        .filter(Boolean)
        .sort((a, b) => getOrderCreatedTimestamp(a) - getOrderCreatedTimestamp(b))[0] || null;
    }
    group.lines.sort((a, b) =>
      getOrderCreatedTimestamp(a.orderCreatedAt || getOrderCreatedAt(a))
      - getOrderCreatedTimestamp(b.orderCreatedAt || getOrderCreatedAt(b))
      || getShipTimestamp(a.order?.ship_by_date) - getShipTimestamp(b.order?.ship_by_date)
      || String(a.item_title || "").localeCompare(String(b.item_title || ""), undefined, { sensitivity: "base" })
    );
  });

  return sortBuyerGroups([...groups.values()]);
}

function buildBuyerInsightCurrentItems(lines = []) {
  return (lines || []).map((line) => ({
    title: line.item_title || "Untitled eBay item",
    itemNumber: line.item_number || "",
    orderNumber: line.order?.order_number || "",
    quantity: Number(line.quantity || 0),
    grossSales: Number(line.total_price || line.sold_for || 0),
    status: line.line_status || "",
    shipByDate: line.order?.ship_by_date || null,
  }));
}

function buyerInsightCurrentItemsAttribute(lines = []) {
  return escapeHtml(JSON.stringify(buildBuyerInsightCurrentItems(lines)));
}

function sortBuyerGroups(groups) {
  const sort = $("order-sort")?.value || state.orderSort || "created_asc";
  state.orderSort = sort;

  const byBuyer = (a, b) => a.buyer.localeCompare(b.buyer, undefined, { sensitivity: "base" });
  const byDue = (a, b) => getShipTimestamp(a.nextShipBy) - getShipTimestamp(b.nextShipBy);
  const byCreated = (a, b) => getOrderCreatedTimestamp(a.earliestPendingOrderCreatedAt) - getOrderCreatedTimestamp(b.earliestPendingOrderCreatedAt);
  const byTotal = (a, b) => Number(a.totalValue || 0) - Number(b.totalValue || 0);

  return groups.sort((a, b) => {
    if (sort === "created_asc") return byCreated(a, b) || byDue(a, b) || byBuyer(a, b);
    if (sort === "created_desc") return byCreated(b, a) || byDue(a, b) || byBuyer(a, b);
    if (sort === "buyer_asc") return byBuyer(a, b) || byDue(a, b);
    if (sort === "buyer_desc") return byBuyer(b, a) || byDue(a, b);
    if (sort === "total_desc" && isAdminUser()) return byTotal(b, a) || byDue(a, b) || byBuyer(a, b);
    if (sort === "total_asc" && isAdminUser()) return byTotal(a, b) || byDue(a, b) || byBuyer(a, b);
    return byDue(a, b) || byBuyer(a, b);
  });
}

function getBuyerLines(key = state.activeBuyerKey) {
  if (!key) return [];
  return state.orders.filter((line) => getBuyerKey(line) === key);
}

function getNextPackableLine(key = state.activeBuyerKey, excludeId = "") {
  return getBuyerLines(key).find((line) =>
    line.id !== excludeId
    && isOpenOrderLine(line)
    && !state.stagedFulfillments.has(line.id)
  );
}

function isOpenOrderLine(line) {
  return line && !["fulfilled", "cancelled", "skipped"].includes(String(line.line_status || "").toLowerCase());
}

function isNoInventoryCompletionLine(line) {
  return isOpenOrderLine(line)
    && String(line.line_status || "pending").toLowerCase() === "pending"
    && Number(line.fulfilled_quantity || 0) === 0;
}

function getNoInventoryCandidateLines(line = state.selectedLine) {
  if (!line) return [];
  const selectedLines = getSelectedAdminLines().filter(isNoInventoryCompletionLine);
  if (selectedLines.length) return selectedLines;
  return getBuyerLines(getBuyerKey(line)).filter(isNoInventoryCompletionLine);
}

function getCancelableOrderLines(line = state.selectedLine) {
  if (!line?.order_id) return [];
  return state.orders.filter((entry) => entry.order_id === line.order_id && isOpenOrderLine(entry));
}

function isAdminCloseoutSelectable(line) {
  return isAdminUser()
    && isOpenOrderLine(line);
}

function getSelectedAdminLines() {
  return state.orders.filter((line) => state.adminSelectedLineIds.has(line.id) && isAdminCloseoutSelectable(line));
}

function getUniqueOrderNumbersForLines(lines = []) {
  return [...new Set((lines || [])
    .map((line) => normalizeEbayOrderNumber(line?.order?.order_number))
    .filter(Boolean))];
}

function buildEbaySingleLabelUrl(orderNumber) {
  const normalized = normalizeEbayOrderNumber(orderNumber);
  return normalized ? `${EBAY_SINGLE_LABEL_BASE_URL}${encodeURIComponent(normalized)}` : "";
}

function buildEbayBulkLabelUrl(orderNumbers = []) {
  const unique = [...new Set((orderNumbers || []).map(normalizeEbayOrderNumber).filter(Boolean))];
  if (!unique.length) return "";
  return `${EBAY_BULK_LABEL_BASE_URL}?t=${unique.map(encodeURIComponent).join(",")}`;
}

function openEbayLabelPagesForOrderNumbers(orderNumbers = []) {
  const unique = [...new Set((orderNumbers || []).map(normalizeEbayOrderNumber).filter(Boolean))];
  if (!unique.length) {
    setStatus("Select at least one eBay order with an order number before opening labels.", "error");
    return;
  }

  const url = unique.length === 1 ? buildEbaySingleLabelUrl(unique[0]) : buildEbayBulkLabelUrl(unique);
  if (url) window.open(url, "_blank", "noopener,noreferrer");

  const orderWord = unique.length === 1 ? "order" : "orders";
  setStatus(`Opened ${unique.length === 1 ? "the eBay shipping label page" : "eBay bulk labels"} for ${unique.length} ${orderWord}: ${unique.join(", ")}.`, "info");
}

function openSelectedEbayLabelPage() {
  const orderNumber = normalizeEbayOrderNumber(state.selectedLine?.order?.order_number);
  openEbayLabelPagesForOrderNumbers(orderNumber ? [orderNumber] : []);
}

function openAdminSelectedEbayLabelPages() {
  openEbayLabelPagesForOrderNumbers(getUniqueOrderNumbersForLines(getSelectedAdminLines()));
}

function openBuyerGroupSelectedEbayLabelPages(group) {
  const selectedLines = group.lines.filter((line) => state.adminSelectedLineIds.has(line.id));
  openEbayLabelPagesForOrderNumbers(getUniqueOrderNumbersForLines(selectedLines));
}

function getNoInventoryLineIdsForGroupAction(group) {
  const noInventoryLines = group.lines.filter(isNoInventoryCompletionLine);
  const selectedNoInventoryLines = noInventoryLines.filter((line) => state.adminSelectedLineIds.has(line.id));
  return (selectedNoInventoryLines.length ? selectedNoInventoryLines : noInventoryLines).map((line) => line.id);
}

function openBuyerGroupNoInventoryModal(group) {
  const lineIds = getNoInventoryLineIdsForGroupAction(group);
  if (!lineIds.length) {
    setStatus("No pending untouched lines in this card can be completed without inventory.", "error");
    return;
  }

  const firstLine = group.lines.find((line) => line.id === lineIds[0]) || group.lines.find(isNoInventoryCompletionLine);
  if (!firstLine) {
    setStatus("No pending untouched lines in this card can be completed without inventory.", "error");
    return;
  }

  selectOrderLine(firstLine.id, { openDetail: false });
  setTimeout(() => openWorkerNoInventoryModal({ lineIds }), 80);
}

function openBuyerGroupInventoryCompletion(group) {
  const selectedLines = group.lines.filter((line) => state.adminSelectedLineIds.has(line.id) && isOpenOrderLine(line));
  const nextLine = selectedLines[0]
    || group.lines.find((line) => isOpenOrderLine(line) && !state.stagedFulfillments.has(line.id))
    || group.lines.find(isOpenOrderLine);
  if (!nextLine) {
    setStatus("No open pending line in this card can be completed from inventory.", "error");
    return;
  }
  selectOrderLine(nextLine.id, { openDetail: true });
}

function pruneAdminSelection() {
  const validIds = new Set(state.orders.filter(isAdminCloseoutSelectable).map((line) => line.id));
  [...state.adminSelectedLineIds].forEach((lineId) => {
    if (!validIds.has(lineId)) state.adminSelectedLineIds.delete(lineId);
  });
}

function renderAdminOrderActions() {
  const panel = $("admin-order-actions-panel");
  if (!panel || !isAdminUser()) return;

  pruneAdminSelection();
  const count = state.adminSelectedLineIds.size;
  const countEl = $("admin-order-selected-count");
  if (countEl) countEl.textContent = `${count} selected`;

  $("admin-clear-order-selection")?.toggleAttribute("disabled", count === 0);
  $("admin-open-ebay-labels")?.toggleAttribute("disabled", count === 0);
  $("admin-mark-packed-no-stock")?.toggleAttribute("disabled", count === 0);
  $("admin-mark-cancelled")?.toggleAttribute("disabled", count === 0);
}

function setAdminLineSelection(lineId, checked) {
  if (checked) state.adminSelectedLineIds.add(lineId);
  else state.adminSelectedLineIds.delete(lineId);
  renderOrders();
  renderAdminOrderActions();
}

function setAdminGroupSelection(group, checked) {
  group.lines.filter(isAdminCloseoutSelectable).forEach((line) => {
    if (checked) state.adminSelectedLineIds.add(line.id);
    else state.adminSelectedLineIds.delete(line.id);
  });
  renderOrders();
  renderAdminOrderActions();
}

function clearAdminOrderSelection() {
  state.adminSelectedLineIds.clear();
  renderOrders();
  renderAdminOrderActions();
}

function renderBuyerBundlePanel() {
  const panel = $("buyer-bundle-panel");
  if (!panel || !state.selectedLine) return;
  const lines = getBuyerLines(getBuyerKey(state.selectedLine));
  const stagedCount = lines.filter((line) => state.stagedFulfillments.has(line.id)).length;
  const pendingCount = lines.filter((line) => line.line_status !== "fulfilled").length;

  panel.innerHTML = `
    <div class="bundle-head">
      <div>
        <span class="eyebrow">Packing Bundle</span>
        <strong>${escapeHtml(getBuyerLabel(state.selectedLine))}</strong>
      </div>
      <span>${stagedCount} staged / ${pendingCount} pending</span>
    </div>
    <div class="bundle-lines">
      ${lines.map((line) => {
        const staged = state.stagedFulfillments.get(line.id);
        const selected = state.selectedLine?.id === line.id;
        const status = line.line_status === "fulfilled" ? "Fulfilled" : staged ? "Staged" : selected ? "Scanning now" : "Waiting";
        return `
          <button type="button" class="bundle-line ${selected ? "is-selected" : ""} ${staged ? "is-staged" : ""}" data-line-id="${escapeHtml(line.id)}">
            <span>
              <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
              <small>${escapeHtml(line.order?.order_number || "No order")} - Qty ${Number(line.quantity || 1)}${staged ? ` - ${escapeHtml(staged.row.locationLabel)}` : ""}</small>
            </span>
            <b>${escapeHtml(status)}</b>
          </button>
        `;
      }).join("")}
    </div>
  `;

  panel.querySelectorAll(".bundle-line").forEach((button) => {
    button.addEventListener("click", () => selectOrderLine(button.dataset.lineId));
  });
}

function renderOrders() {
  const list = $("orders-list");
  if (!list) return;

  const groups = groupLinesByBuyer(state.filteredOrders);
  if (!groups.length) {
    list.innerHTML = `<div class="empty-state">No orders match this view.</div>`;
    return;
  }

  list.innerHTML = "";
  groups.forEach((group, groupIndex) => {
    const urgency = group.pendingCount ? getOrderUrgency(group.nextShipBy) : null;
    const urgencyClass = urgency?.level === "today" ? "is-due-today" : urgency ? `is-${urgency.level}` : "";
    const assignedTask = getAssignedOrderTaskForGroup(group);
    const assignmentLabel = getGroupAssignmentLabel(group);
    const urgencyMarkup = urgency ? `
      <span class="urgency-pill urgency-${urgency.level}">
        <i data-lucide="${urgency.icon}"></i>
        ${escapeHtml(urgency.label)}
      </span>
    ` : "";
    const taskControlMarkup = assignedTask
      ? `<div class="buyer-card-task-btn task-action-btn is-assigned buyer-card-assigned-pill" title="Task assigned to ${escapeHtml(assignmentLabel)}"><span>Assigned:</span><strong>${escapeHtml(assignmentLabel)}</strong></div>`
      : `<button type="button" class="buyer-card-task-btn task-action-btn" data-buyer-task-key="${escapeHtml(group.key)}">Assign Task</button>`;
    const card = document.createElement("article");
    const hasSelectedAdminLines = group.lines.some((line) => state.adminSelectedLineIds.has(line.id));
    const syncMismatch = group.lines.map(getOrderSyncMismatch).find(Boolean);
    card.className = `buyer-order-card ${urgencyClass} ${groupIndex % 2 ? "is-alt-group" : ""} ${hasSelectedAdminLines ? "has-admin-selected-lines" : ""} ${syncMismatch ? "has-sync-mismatch" : ""} ${state.selectedLine && getBuyerKey(state.selectedLine) === group.key ? "is-selected" : ""}`;
    card.innerHTML = `
      <div class="buyer-card-head">
        <div>
          <span class="buyer-kicker">Buyer username</span>
          <button
            type="button"
            class="buyer-insight-link buyer-card-buyer-name"
            data-buyer-insights="${escapeHtml(group.buyer)}"
            data-buyer-context="pending-orders"
            data-current-order-total="${escapeHtml(group.totalValue)}"
            data-current-order-count="${escapeHtml(group.orderNumbers.size)}"
            data-current-line-count="${escapeHtml(group.lines.length)}"
            data-current-order-numbers="${escapeHtml([...group.orderNumbers].join(","))}"
            data-current-items="${buyerInsightCurrentItemsAttribute(group.lines)}"
          >${escapeHtml(group.buyer)}</button>
          <small>${group.orderNumbers.size} order(s) - ${group.lines.length} line(s) - Qty ${group.totalQuantity}</small>
        </div>
        <div class="buyer-card-alerts">
          ${urgencyMarkup}
          ${syncMismatch ? `
            <span class="sync-mismatch-pill" title="${escapeHtml(syncMismatch.message || "Verify this order in eBay before acting.")}">
              <i data-lucide="shield-alert"></i>
              eBay review
            </span>
          ` : ""}
          ${isAdminUser() ? `<span class="buyer-card-value">${formatMoney(group.totalValue)}</span>` : ""}
          <button type="button" class="buyer-card-complete-btn primary-btn" data-buyer-complete-key="${escapeHtml(group.key)}" ${group.lines.some(isOpenOrderLine) ? "" : "disabled"}>Complete From Inventory</button>
          <button type="button" class="buyer-card-task-btn task-action-btn" data-buyer-task-key="${escapeHtml(group.key)}">Assign Task</button>
          <button type="button" class="buyer-card-no-inventory-btn secondary-btn caution-btn" data-buyer-no-inventory-key="${escapeHtml(group.key)}" ${getNoInventoryLineIdsForGroupAction(group).length ? "" : "disabled"}>Complete Without Inventory</button>
          <span class="status-badge">${group.pendingCount} pending</span>
        </div>
      </div>
      <div class="buyer-card-meta">
        <span>Earliest sale ${escapeHtml(formatDate(group.earliestPendingOrderCreatedAt))}</span>
        <span>Ship by ${escapeHtml(formatDate(group.nextShipBy))}</span>
        ${isAdminUser() ? `<span>Order value ${formatMoney(group.totalValue)}</span>` : `<span>Ready to pack</span>`}
      </div>
      ${isAdminUser() ? `
        <div class="buyer-card-admin-row">
          <button type="button" class="secondary-btn buyer-card-label-btn" data-buyer-label-key="${escapeHtml(group.key)}">Get Labels</button>
          <label class="admin-group-select">
            <input type="checkbox" data-admin-group-select="${escapeHtml(group.key)}" />
            Select pending lines
          </label>
        </div>
      ` : ""}
      <div class="buyer-line-list"></div>
    `;

    const lineList = card.querySelector(".buyer-line-list");
    const buyerLabelButton = card.querySelector("[data-buyer-label-key]");
    const groupCheckbox = card.querySelector("[data-admin-group-select]");
    const completeButton = card.querySelector("[data-buyer-complete-key]");
    const taskButton = card.querySelector("[data-buyer-task-key]");
    const noInventoryButton = card.querySelector("[data-buyer-no-inventory-key]");
    if (groupCheckbox) {
      const selectable = group.lines.filter(isAdminCloseoutSelectable);
      const selected = selectable.filter((line) => state.adminSelectedLineIds.has(line.id));
      const selectedOrderNumbers = getUniqueOrderNumbersForLines(selected);
      groupCheckbox.checked = selectable.length > 0 && selected.length === selectable.length;
      groupCheckbox.indeterminate = selected.length > 0 && selected.length < selectable.length;
      groupCheckbox.disabled = selectable.length === 0;
      groupCheckbox.addEventListener("click", (event) => event.stopPropagation());
      groupCheckbox.addEventListener("change", (event) => setAdminGroupSelection(group, event.target.checked));
      if (buyerLabelButton) {
        buyerLabelButton.disabled = selectedOrderNumbers.length === 0;
        buyerLabelButton.textContent = selectedOrderNumbers.length > 1 ? `Get ${selectedOrderNumbers.length} Labels` : "Get Label";
        buyerLabelButton.addEventListener("click", (event) => {
          event.stopPropagation();
          openBuyerGroupSelectedEbayLabelPages(group);
        });
      }
    }
    completeButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      openBuyerGroupInventoryCompletion(group);
    });
    taskButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      const nextLine = group.lines.find((line) => isOpenOrderLine(line) && !state.stagedFulfillments.has(line.id)) || group.lines[0];
      if (!nextLine) return;
      selectOrderLine(nextLine.id, { openDetail: false });
      setTimeout(() => openOrderTaskModal(), 80);
    });
    noInventoryButton?.addEventListener("click", (event) => {
      event.stopPropagation();
      openBuyerGroupNoInventoryModal(group);
    });

    const orderLineTotals = new Map();
    group.lines.forEach((line) => {
      const order = line.order || {};
      const key = normalizeEbayOrderNumber(order.order_number) || order.order_number || order.id || line.order_id || line.id;
      orderLineTotals.set(key, (orderLineTotals.get(key) || 0) + 1);
    });
    const orderLinePositions = new Map();

    group.lines.forEach((line) => {
      const order = line.order || {};
      const receiptLink = getOrderVideoReceiptLink(line);
      const canActOnLine = isOpenOrderLine(line);
      const lineSyncMismatch = getOrderSyncMismatch(line);
      const lineUrgency = canActOnLine ? getOrderUrgency(order.ship_by_date) : null;
      const lineDueTone = lineUrgency?.level || "neutral";
      const orderLineKey = normalizeEbayOrderNumber(order.order_number) || order.order_number || order.id || line.order_id || line.id;
      const orderLineTotal = orderLineTotals.get(orderLineKey) || 1;
      const orderLinePosition = (orderLinePositions.get(orderLineKey) || 0) + 1;
      orderLinePositions.set(orderLineKey, orderLinePosition);
      const orderLineSequence = orderLineTotal > 1 ? `Order ${orderLinePosition} of ${orderLineTotal}` : "";
      const lineDueLabel = lineUrgency
        ? `${lineUrgency.label} · ${formatDate(order.ship_by_date)}`
        : order.ship_by_date
          ? `Due ${formatDate(order.ship_by_date)}`
          : "No ship-by date";
      const lineCreatedLabel = `${getOrderCreatedLabel(line)} ${formatDate(line.orderCreatedAt || getOrderCreatedAt(line))}`;
      const isAdminSelected = state.adminSelectedLineIds.has(line.id);
      const visibleLineDueLabel = lineUrgency
        ? `${lineUrgency.label} - ${formatDate(order.ship_by_date)}`
        : lineDueLabel;
      const button = document.createElement("div");
      button.className = `buyer-line-btn ${isAdminUser() ? "has-admin-select" : ""} ${isAdminSelected ? "is-admin-selected" : ""} ${state.selectedLine?.id === line.id ? "is-selected" : ""}`;
      const adminSelect = isAdminUser() ? `
        <label class="admin-order-select" title="Select pending line">
          <input type="checkbox" data-admin-line-select="${escapeHtml(line.id)}" ${state.adminSelectedLineIds.has(line.id) ? "checked" : ""} ${isAdminCloseoutSelectable(line) ? "" : "disabled"} />
        </label>
      ` : "";
      button.innerHTML = `
        ${adminSelect}
        <span class="buyer-line-main">
          <span class="buyer-line-copy">
            <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
            <small>${escapeHtml(order.order_number || "No order number")} - ${escapeHtml(line.item_number || "No item #")} - Qty ${Number(line.quantity || 1)}</small>
            <span class="buyer-line-meta-row">
              <span class="buyer-line-created">${escapeHtml(lineCreatedLabel)}</span>
              <span class="buyer-line-due is-${escapeHtml(lineDueTone)}">
                ${lineUrgency ? `<i data-lucide="${lineUrgency.icon}"></i>` : ""}
                ${escapeHtml(visibleLineDueLabel)}
              </span>
              ${orderLineSequence ? `<span class="buyer-line-sequence">${escapeHtml(orderLineSequence)}</span>` : ""}
              ${lineSyncMismatch ? `<span class="buyer-line-sync-warning" title="${escapeHtml(lineSyncMismatch.message || "Verify this order in eBay before acting.")}">Verify in eBay</span>` : ""}
            </span>
            ${isAdminUser() ? `<small class="buyer-line-price">Line total ${formatMoney(line.total_price || line.sold_for || 0)}</small>` : ""}
          </span>
          <span class="buyer-line-actions">
            <button type="button" class="secondary-btn buyer-line-action-btn" data-line-open-label="${escapeHtml(line.id)}" ${normalizeEbayOrderNumber(order.order_number) ? "" : "disabled"}>Get Label</button>
            <button type="button" class="secondary-btn buyer-line-action-btn task-action-btn" data-line-assign-task="${escapeHtml(line.id)}" ${line.order_id ? "" : "disabled"}>Assign Task</button>
            <button type="button" class="secondary-btn buyer-line-action-btn danger-btn" data-line-cancel="${escapeHtml(line.id)}" ${canActOnLine ? "" : "disabled"}>Cancel</button>
          </span>
          ${receiptLink.url || receiptLink.orderNumber ? `<a class="buyer-line-receipt" href="${escapeHtml(receiptLink.url || "#")}" target="_blank" rel="noopener" title="${escapeHtml(receiptLink.title)}">Open video receipt</a>` : ""}
          <span class="queue-video-receipt-evidence" data-queue-video-evidence="${escapeHtml(line.id)}">
            <span class="queue-video-receipt-empty">Loading saved video receipt screenshot...</span>
          </span>
        </span>
        <b>${escapeHtml(line.line_status || "pending")}</b>
      `;
      const lineCheckbox = button.querySelector("[data-admin-line-select]");
      lineCheckbox?.addEventListener("click", (event) => event.stopPropagation());
      lineCheckbox?.addEventListener("change", (event) => setAdminLineSelection(line.id, event.target.checked));
      button.querySelectorAll("a").forEach((link) => link.addEventListener("click", (event) => openVideoReceiptLink(event, receiptLink)));
      button.querySelectorAll(".buyer-line-action-btn").forEach((actionButton) => {
        actionButton.addEventListener("click", (event) => event.stopPropagation());
      });
      button.querySelector("[data-line-open-label]")?.addEventListener("click", () => {
        openEbayLabelPagesForOrderNumbers([order.order_number]);
      });
      button.querySelector("[data-line-assign-task]")?.addEventListener("click", () => {
        selectOrderLine(line.id, { openDetail: false });
        setTimeout(() => openOrderTaskModal(), 80);
      });
      button.querySelector("[data-line-cancel]")?.addEventListener("click", () => {
        selectOrderLine(line.id, { openDetail: false });
        openWorkerCancelOrderModal({ lineIds: [line.id], openEbayCancel: true });
      });
      lineList.appendChild(button);
    });

    list.appendChild(card);
  });

  if (window.lucide) window.lucide.createIcons();
  hydrateQueueVideoReceiptEvidenceThumbnails(groups.flatMap((group) => group.lines));
}

function selectOrderLine(lineId, options = {}) {
  const shouldOpenDetail = options.openDetail !== false;
  const line = state.orders.find((entry) => entry.id === lineId);
  if (!line) return;
  clearItemSearchTimer();
  clearLocationSearchTimer();
  clearQuantityAutoStage();

  const nextBuyerKey = getBuyerKey(line);
  if (state.activeBuyerKey && state.activeBuyerKey !== nextBuyerKey && state.stagedFulfillments.size) {
    state.stagedFulfillments.clear();
  }

  state.selectedLine = line;
  state.activeBuyerKey = nextBuyerKey;
  state.selectedItem = null;
  state.stockRows = [];
  state.selectedStockRow = null;

  if (shouldOpenDetail) {
    $("selected-order-empty")?.classList.add("hidden");
    $("fulfillment-workflow")?.classList.remove("hidden");
    openMobileOrderDetail();
  }
  renderOrders();
  renderLiveLotOrderMatches();
  renderSelectedOrder();
  renderBuyerBundlePanel();
  renderOrderTaskPanel();
  loadSelectedOrderTasks();
  resetFulfillmentInputs();
  renderSelectionSummary();
  renderItemResults([]);
  renderLocationResults([]);
  renderSummaryStrip();

  $("item-scan").value = "";
  updateCheckoutStoreGate();
  if (!shouldOpenDetail) return;
  if (!state.checkoutStoreId) {
    setStatus("Select the checkout store before scanning this order.", "error");
    setTimeout(() => $("checkout-store-select")?.focus(), 80);
    return;
  }
  setTimeout(() => (state.selectedLiveLot ? $("fulfill-order") : $("item-scan"))?.focus(), 80);
}

function isMobilePendingOrderLayout() {
  return window.matchMedia?.("(max-width: 640px)")?.matches || false;
}

function openMobileOrderDetail() {
  document.body.classList.add("pending-order-detail-open");
  if (isMobilePendingOrderLayout()) {
    document.body.classList.add("pending-mobile-sheet-open");
  }
}

function closeMobileOrderDetail() {
  clearSelection();
}

function syncMobileOrderDetailMode() {
  if (isMobilePendingOrderLayout() && state.selectedLine && !$("fulfillment-workflow")?.classList.contains("hidden")) {
    document.body.classList.add("pending-order-detail-open");
    document.body.classList.add("pending-mobile-sheet-open");
  } else {
    const shouldKeepDesktopDetail = state.selectedLine && !$("fulfillment-workflow")?.classList.contains("hidden");
    document.body.classList.toggle("pending-order-detail-open", Boolean(shouldKeepDesktopDetail));
    document.body.classList.remove("pending-mobile-sheet-open");
  }
}

function returnToOrdersAfterMobileModalClose(options = {}) {
  if (!isMobilePendingOrderLayout() || options.suppressMobileReturn) return;
  window.setTimeout(() => {
    const modalIds = [
      "item-confirm-modal",
      "bundle-review-modal",
      "worker-no-inventory-modal",
      "worker-cancel-order-modal",
      "order-task-modal",
      "admin-order-closeout-modal",
      "no-inventory-photo-viewer-modal",
    ];
    const anyModalOpen = modalIds.some((id) => !$(`${id}`)?.classList.contains("hidden"));
    if (!anyModalOpen) clearSelection();
  }, 0);
}

function resetFulfillmentInputs() {
  const line = state.selectedLine;
  const remaining = getRemainingLineQuantity(line) || Number(line?.quantity || 1) || 1;
  clearQuantityAutoStage();
  $("location-scan").value = "";
  $("fulfill-quantity").value = "1";
  $("fulfill-quantity").max = String(Math.max(1, remaining));
  $("fulfill-sold-price").value = Number(line?.sold_for || 0).toFixed(2);
  $("fulfill-notes").value = "";
  setStatus("");
}

function renderSelectedOrder() {
  const line = state.selectedLine;
  if (!line) return;
  const order = line.order || {};
  $("selected-order-title").textContent = order.order_number || "eBay order";
  $("selected-order-subtitle").textContent = `${line.item_title || "Untitled item"} - Buyer: ${order.buyer_username || "unknown"} - ${getOrderCreatedLabel(line)} ${formatDate(line.orderCreatedAt || getOrderCreatedAt(line))} - Remaining: ${getRemainingLineQuantity(line)} of ${Number(line.quantity || 0)} - Ship by ${formatDate(order.ship_by_date)}`;
  $("selected-order-status").textContent = line.line_status || "pending";
  renderSelectedOrderTaskAssignment();
  $("cancel-pending-order")?.toggleAttribute("disabled", !isOpenOrderLine(line));
  $("complete-no-inventory")?.toggleAttribute("disabled", !isNoInventoryCompletionLine(line));
  $("money-grid")?.classList.toggle("hidden", !isAdminUser());
  $("detail-sold-for").textContent = formatMoney(line.sold_for);
  $("detail-shipping").textContent = formatMoney(line.shipping_and_handling || order.shipping_and_handling);
  $("detail-total").textContent = formatMoney(line.total_price || order.total_price || line.sold_for);
  $("detail-payout").textContent = line.net_payout || order.net_payout ? formatMoney(line.net_payout || order.net_payout) : "Not imported";
  renderSelectedVideoReceipt(line);
  renderEbayLabelPanel();
}

function renderSelectedVideoReceipt(line = state.selectedLine) {
  const panel = $("selected-video-receipt");
  if (!panel) return;
  const receiptLink = getOrderVideoReceiptLink(line);
  panel.classList.toggle("hidden", !(receiptLink.url || receiptLink.orderNumber));
  panel.innerHTML = receiptLink.url || receiptLink.orderNumber
    ? `
      <a href="${escapeHtml(receiptLink.url || "#")}" target="_blank" rel="noopener" title="${escapeHtml(receiptLink.title)}">Video receipt</a>
    `
    : "";
  panel.querySelector("a")?.addEventListener("click", (event) => openVideoReceiptLink(event, receiptLink));
}

function isVideoReceiptEvidencePhoto(photo = {}) {
  const text = [
    photo.label,
    photo.path,
    photo.source_path,
    photo.metadata?.videoReceiptUrl,
    photo.metadata?.source,
  ].filter(Boolean).join(" ").toLowerCase();
  return /video[-_\s]?receipt|ebaylive\/events/.test(text);
}

function normalizeVideoReceiptItemNumber(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function getVideoReceiptPhotoItemNumbers(photo = {}) {
  const values = [
    photo.itemNumber,
    photo.item_number,
    photo.selectedItemId,
    photo.metadata?.itemNumber,
    photo.metadata?.item_number,
    photo.metadata?.selectedItemId,
  ];
  const labelMatch = String(photo.label || "").match(/video[-_\s]?receipt\s*[-:]?\s*(\d{6,})/i);
  if (labelMatch?.[1]) values.push(labelMatch[1]);
  const pathMatch = String(photo.path || "").match(/(?:^|[-_/])(\d{6,})(?:\.png|[-_/]|$)/i);
  if (pathMatch?.[1]) values.push(pathMatch[1]);
  return [...new Set(values.map(normalizeVideoReceiptItemNumber).filter(Boolean))];
}

function videoReceiptPhotoMatchesLine(photo = {}, task = {}, line = {}) {
  const lineItemNumber = normalizeVideoReceiptItemNumber(line.item_number);
  const explicitItemNumbers = getVideoReceiptPhotoItemNumbers(photo);
  if (explicitItemNumbers.length) return Boolean(lineItemNumber && explicitItemNumbers.includes(lineItemNumber));

  const taskLineIds = Array.isArray(task.order_line_ids) ? task.order_line_ids : [];
  if (taskLineIds.length) return taskLineIds.includes(line.id);
  return false;
}

function getSelectedVideoReceiptEvidencePhotos() {
  const line = state.selectedLine;
  if (!line?.id) return [];
  return getVideoReceiptEvidencePhotosForLine(line);
}

function getVideoReceiptEvidencePhotosForLine(line = {}) {
  if (!line?.id) return [];
  const photos = [];
  const livePhoto = state.videoReceiptEvidenceByLineId.get(line.id);
  if (livePhoto) photos.push(livePhoto);

  const taskSources = [
    ...state.selectedOrderTasks.map((task) => ({ task, events: state.selectedOrderTaskEvents.get(task.id) || [] })),
    ...state.queueVideoReceiptTasks.map((task) => ({ task, events: state.queueVideoReceiptTaskEvents.get(task.id) || [] })),
  ];
  const seenTaskIds = new Set();
  taskSources.forEach(({ task, events }) => {
    if (!task?.id || seenTaskIds.has(task.id)) return;
    seenTaskIds.add(task.id);
    const taskLineIds = Array.isArray(task.order_line_ids) ? task.order_line_ids : [];
    const taskMatchesLine = taskLineIds.length ? taskLineIds.includes(line.id) : task.order_id === line.order_id;
    if (!taskMatchesLine) return;
    events.forEach((event) => {
      (Array.isArray(event.photo_attachments) ? event.photo_attachments : [])
        .filter(isVideoReceiptEvidencePhoto)
        .filter((photo) => videoReceiptPhotoMatchesLine(photo, task, line))
        .forEach((photo) => photos.push({
          ...photo,
          signed_by_email: photo.signed_by_email || event.signed_by_email || task.created_by_email || "",
          created_at: photo.created_at || event.created_at || task.created_at || "",
        }));
    });
  });

  const seen = new Set();
  return photos.filter((photo) => {
    const key = getNoInventoryEvidencePhotoKey(photo);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return Boolean(photo.path || photo.previewUrl);
  });
}

async function ensureEvidencePhotoPreviewUrls(photo = {}) {
  if (photo.previewUrl) return photo;
  const bucket = photo.bucket || NO_INVENTORY_EVIDENCE_BUCKET;
  const path = photo.path || "";
  if (!path) return photo;
  const [previewUrl, thumbnailUrl] = await Promise.all([
    createNoInventorySignedImageUrl(bucket, path),
    createNoInventorySignedImageUrl(bucket, path, { transform: NO_INVENTORY_THUMBNAIL_TRANSFORM }),
  ]);
  return {
    ...photo,
    bucket,
    previewUrl,
    thumbnailUrl: thumbnailUrl || previewUrl,
  };
}

async function renderSelectedVideoReceiptEvidence() {
  const container = $("selected-video-receipt-evidence");
  if (!container) return;
  const photos = getSelectedVideoReceiptEvidencePhotos();
  if (!photos.length) {
    container.innerHTML = "";
    return;
  }

  container.innerHTML = photos.map((photo, index) => `
    <button type="button" class="video-receipt-evidence-thumb is-loading" data-selected-video-receipt-photo="${index}">
      <span>Loading video receipt screenshot...</span>
    </button>
  `).join("");

  const hydrated = await Promise.all(photos.map((photo) => ensureEvidencePhotoPreviewUrls(photo).catch(() => photo)));
  if (!$("selected-video-receipt-evidence")) return;

  container.innerHTML = hydrated.map((photo, index) => {
    const actor = photo.signed_by_email || getVideoReceiptAuditActor();
    const capturedAt = photo.created_at || photo.metadata?.capturedAt || "";
    const auditText = photo.auditText || `Captured by ${actor}${capturedAt ? ` on ${formatDate(capturedAt)}` : ""}`;
    return `
      <button type="button" class="video-receipt-evidence-thumb" data-selected-video-receipt-photo="${index}" title="Open video receipt screenshot">
        ${photo.thumbnailUrl || photo.previewUrl ? `<img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl)}" alt="${escapeHtml(photo.label || "Video receipt screenshot")}" />` : ""}
        <span>${escapeHtml(auditText)}</span>
      </button>
    `;
  }).join("");

  container.querySelectorAll("[data-selected-video-receipt-photo]").forEach((button) => {
    button.addEventListener("click", () => {
      const photo = hydrated[Number(button.dataset.selectedVideoReceiptPhoto || 0)];
      if (photo?.previewUrl) openEvidencePhotoObjectViewer({
        ...photo,
        auditText: photo.auditText || `Captured by ${photo.signed_by_email || getVideoReceiptAuditActor()}${photo.created_at ? ` on ${formatDate(photo.created_at)}` : ""}`,
      }, "assign-order-task");
    });
  });
}

function getSelectedOrderLabelData() {
  const line = state.selectedLine || {};
  const order = line.order || {};
  return {
    status: line.label_status || order.label_status || "",
    bucket: line.label_storage_bucket || order.label_storage_bucket || EBAY_LABEL_BUCKET,
    path: line.label_file_path || order.label_file_path || "",
    uploadedAt: line.label_uploaded_at || order.label_uploaded_at || "",
    metadata: line.label_metadata || order.label_metadata || {},
  };
}

async function getEbayLabelPreviewUrl(bucket, path) {
  if (!bucket || !path) return "";
  const key = `${bucket}/${path}`;
  if (state.ebayLabelPreviewUrls.has(key)) return state.ebayLabelPreviewUrls.get(key);
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (error) {
    console.warn("Could not sign eBay label PDF:", error);
    return "";
  }
  const url = data?.signedUrl || "";
  if (url) state.ebayLabelPreviewUrls.set(key, url);
  return url;
}

function renderEbayLabelPanel() {
  const panel = $("ebay-label-panel");
  if (!state.selectedLine) return;
  const label = getSelectedOrderLabelData();
  const metadata = label.metadata || {};
  const sizeText = formatFileSize(metadata.size);
  const trackingText = getLabelTrackingDisplay(metadata);
  const summaryText = label.path
    ? `Label attached${label.uploadedAt ? ` ${formatDate(label.uploadedAt)}` : ""}${sizeText ? ` - ${sizeText}` : ""}${trackingText ? ` - tracker ${trackingText}` : ""}. Preview before final confirmation.`
    : "Waiting for a label from the eBay extension.";
  const detailsHtml = label.path
    ? `
      <div class="label-tracking-confirmation">
        <small>Extracted barcode / tracking number</small>
        <strong>${escapeHtml(trackingText || "Not captured yet")}</strong>
      </div>
      <div class="selection-grid">
        <span><small>Shipment</small><b>${escapeHtml(metadata.shipmentId || "-")}</b></span>
        <span><small>Carrier</small><b>${escapeHtml(metadata.carrier || "-")}</b></span>
        <span><small>Service</small><b>${escapeHtml(metadata.service || "-")}</b></span>
        <span><small>Cost</small><b>${escapeHtml(metadata.labelCost ? formatMoney(metadata.labelCost) : "-")}</b></span>
      </div>
    `
    : `<div class="empty-state">Click Send Label to OG on the eBay label-ready page after this order is packed.</div>`;

  if (panel) {
    const summary = $("ebay-label-summary");
    const details = $("ebay-label-details");
    const previewButton = $("preview-ebay-label");
    const openLabelButton = $("open-ebay-label-page");
    summary.textContent = summaryText;
    details.innerHTML = detailsHtml;
    openLabelButton?.toggleAttribute("disabled", !normalizeEbayOrderNumber(state.selectedLine?.order?.order_number));
    previewButton?.classList.toggle("hidden", !label.path);
    previewButton?.toggleAttribute("disabled", !label.path);
  }

  const modalSummary = $("worker-no-inventory-label-summary");
  const modalDetails = $("worker-no-inventory-label-details");
  const modalPreviewButton = $("preview-worker-ebay-label");
  if (modalSummary && modalDetails) {
    modalSummary.textContent = summaryText;
    modalDetails.innerHTML = detailsHtml;
    modalPreviewButton?.classList.toggle("hidden", !label.path);
    modalPreviewButton?.toggleAttribute("disabled", !label.path);
  }
}

function getOrderTaskStatusLabel(status = "") {
  const labels = {
    open: "Open",
    assigned: "Assigned",
    in_progress: "In progress",
    deferred: "Deferred",
    blocked: "Blocked",
    waiting_on_admin: "Waiting on admin",
    waiting_on_worker: "Waiting on worker",
    resolved: "Resolved",
    cancelled: "Cancelled",
  };
  return labels[status] || String(status || "open").replace(/_/g, " ");
}

function getOrderTaskLineIdsForSelectedOrder() {
  const line = state.selectedLine;
  if (!line?.order_id) return [];
  const ids = state.orders
    .filter((entry) => entry.order_id === line.order_id)
    .map((entry) => entry.id)
    .filter(Boolean);
  return ids.length ? [...new Set(ids)] : [line.id].filter(Boolean);
}

function isActiveOrderTask(task = {}) {
  if (task?.metadata?.history_removed_at) return false;
  return ![
    "resolved",
    "cancelled",
    "closed",
    "approved_by_admin",
    "approved_for_shipping",
    "shipped_completed",
  ].includes(String(task.status || "").toLowerCase());
}

function isHiddenOrderCoordinationTask(task = {}, events = []) {
  const status = String(task.status || "").toLowerCase();
  if (task?.metadata?.history_removed_at) return true;
  if (["cancelled", "canceled"].includes(status)) return true;
  return isClearedVideoReceiptCaptureTask(task, events);
}

function isVisibleActiveAssignedOrderCoordinationTask(task = {}, events = []) {
  if (isHiddenOrderCoordinationTask(task, events)) return false;
  if (isVideoReceiptCaptureOrderTask(task)) return true;
  if (!isActiveOrderTask(task)) return false;
  return Boolean(task.assigned_to_user_id || task.assigned_to_email);
}

function rememberOrderTaskAssignment(task = {}) {
  if (!isActiveOrderTask(task) || isVideoReceiptCaptureOrderTask(task) || !(task.assigned_to_user_id || task.assigned_to_email)) return;
  const lineIds = Array.isArray(task.order_line_ids) ? task.order_line_ids.filter(Boolean) : [];
  lineIds.forEach((lineId) => {
    const current = state.orderTaskAssignmentsByLineId.get(lineId);
    const currentTime = new Date(current?.updated_at || current?.created_at || 0).getTime();
    const nextTime = new Date(task.updated_at || task.created_at || 0).getTime();
    if (!current || nextTime >= currentTime) state.orderTaskAssignmentsByLineId.set(lineId, task);
  });
}

async function hydrateOrderTaskAssignments(lines = []) {
  state.orderTaskAssignmentsByLineId.clear();
  const orderIds = [...new Set(lines.map((line) => line.order_id).filter(Boolean))];
  if (!orderIds.length) return;
  const lineIdsByOrderId = new Map();
  lines.forEach((line) => {
    if (!line.order_id || !line.id) return;
    const ids = lineIdsByOrderId.get(line.order_id) || [];
    ids.push(line.id);
    lineIdsByOrderId.set(line.order_id, ids);
  });

  try {
    const { data, error } = await supabase
      .from("ebay_order_tasks")
      .select("id, order_id, order_line_ids, title, question, status, assigned_to_email, assigned_to_user_id, updated_at, created_at, metadata")
      .in("order_id", orderIds)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    (data || []).forEach((task) => {
      const taskLineIds = Array.isArray(task.order_line_ids) ? task.order_line_ids.filter(Boolean) : [];
      rememberOrderTaskAssignment(taskLineIds.length ? task : {
        ...task,
        order_line_ids: lineIdsByOrderId.get(task.order_id) || [],
      });
    });
  } catch (error) {
    console.warn("Could not load pending order assignment state:", error);
  }
}

function getAssignedOrderTaskForGroup(group = {}) {
  const tasks = (group.lines || [])
    .map((line) => state.orderTaskAssignmentsByLineId.get(line.id))
    .filter(Boolean);
  if (!tasks.length) return null;
  return tasks.sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))[0] || null;
}

function getGroupAssignmentLabel(group = {}) {
  const tasks = (group.lines || [])
    .map((line) => state.orderTaskAssignmentsByLineId.get(line.id))
    .filter(Boolean);
  if (!tasks.length) return "";
  const names = [...new Set(tasks.map(getOrderTaskAssigneeName).filter(Boolean))];
  if (names.length === 1) return names[0];
  return `${names.length} people`;
}

function isClearedVideoReceiptCaptureTask(task = {}, events = []) {
  const taskText = [
    task.title,
    task.question,
    task.latest_note,
    task.resolution_notes,
  ].filter(Boolean).join(" ");
  if (!/video receipt screenshot captured/i.test(taskText)) return false;
  const remainingPhotos = events.flatMap((event) => (
    Array.isArray(event.photo_attachments) ? event.photo_attachments : []
  ));
  return !remainingPhotos.length && !isActiveOrderTask(task);
}

function getOrderTaskAssigneeLabel(task = {}) {
  return task.assigned_to_email || "Unassigned";
}

function getOrderTaskAssigneeName(task = {}) {
  const assignee = state.orderTaskAssignees.find((employee) => (
    employee.user_id && employee.user_id === task.assigned_to_user_id
  ));
  return assignee?.display_name || assignee?.email || task.assigned_to_email || "Unassigned";
}

function isVideoReceiptCaptureOrderTask(task = {}) {
  const taskText = [
    task.title,
    task.question,
    task.latest_note,
    task.resolution_notes,
  ].filter(Boolean).join(" ");
  return /video receipt screenshot captured/i.test(taskText);
}

function orderTaskMatchesLine(task = {}, line = {}) {
  if (!line?.id && !line?.order_id) return false;
  const taskLineIds = Array.isArray(task.order_line_ids) ? task.order_line_ids : [];
  if (taskLineIds.length) return taskLineIds.includes(line.id);
  return Boolean(line.order_id && task.order_id === line.order_id);
}

function getAssignedOrderTaskForLine(line = state.selectedLine) {
  if (!line?.order_id) return null;
  return state.selectedOrderTasks
    .filter((task) => isActiveOrderTask(task))
    .filter((task) => !isVideoReceiptCaptureOrderTask(task))
    .filter((task) => orderTaskMatchesLine(task, line))
    .filter((task) => task.assigned_to_user_id || task.assigned_to_email)
    .sort((a, b) => new Date(b.updated_at || b.created_at || 0) - new Date(a.updated_at || a.created_at || 0))[0] || null;
}

function renderSelectedOrderTaskAssignment() {
  const button = $("assign-order-task");
  if (!button) return;
  const line = state.selectedLine;
  const assignedTask = getAssignedOrderTaskForLine(line);
  const isAssigned = Boolean(assignedTask);
  button.classList.toggle("is-assigned", isAssigned);
  button.toggleAttribute("disabled", !line?.order_id || isAssigned);
  button.innerHTML = isAssigned
    ? `<span>Assigned:</span><strong>${escapeHtml(getOrderTaskAssigneeName(assignedTask))}</strong>`
    : "Assign Task";
  button.title = isAssigned
    ? `Task assigned to ${getOrderTaskAssigneeName(assignedTask)}`
    : "Assign task";
}

function getOrderTaskPhotoKey(photo) {
  return getNoInventoryEvidencePhotoKey(photo);
}

function getSelectedOrderTaskPhotos() {
  return state.orderTaskPhotos.filter((photo) => (
    state.orderTaskPhotoUploadKeys.has(getOrderTaskPhotoKey(photo))
  ));
}

function setOrderTaskPhotoStatus(message = "", type = "info") {
  const el = $("order-task-photo-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
}

function setOrderTaskError(message = "") {
  const el = $("order-task-error");
  if (el) el.textContent = message || "";
}

function renderOrderTaskAssigneeSelect() {
  const select = $("order-task-assignee");
  if (!select) return;
  const currentValue = select.value || "";
  select.replaceChildren(new Option("Leave unassigned", ""));
  state.orderTaskAssignees.forEach((employee) => {
    const label = `${employee.display_name || employee.email || "Team member"} - ${employee.role || "employee"}`;
    select.appendChild(new Option(label, employee.user_id || ""));
  });
  select.value = state.orderTaskAssignees.some((employee) => employee.user_id === currentValue)
    ? currentValue
    : "";
}

async function loadOrderTaskAssignees() {
  if (state.orderTaskAssignees.length) {
    renderOrderTaskAssigneeSelect();
    return state.orderTaskAssignees;
  }

  try {
    const { data, error } = await supabase.rpc("list_ebay_order_task_assignees");
    if (error) throw error;
    state.orderTaskAssignees = Array.isArray(data) ? data : [];
  } catch (rpcError) {
    console.warn("Could not load order task assignees through RPC:", rpcError);
    try {
      const { data, error } = await supabase
        .from("employees")
        .select("id, user_id, display_name, email, role")
        .eq("active", true)
        .order("display_name", { ascending: true });
      if (error) throw error;
      state.orderTaskAssignees = Array.isArray(data) ? data : [];
    } catch (fallbackError) {
      console.warn("Could not load employee assignee list:", fallbackError);
      state.orderTaskAssignees = state.employee
        ? [{
          id: state.employee.id,
          user_id: state.user?.id || "",
          display_name: state.employee.display_name || state.user?.email || "Current user",
          email: state.user?.email || "",
          role: state.employee.role || "employee",
        }]
        : [];
    }
  }

  renderOrderTaskAssigneeSelect();
  return state.orderTaskAssignees;
}

async function loadSelectedOrderTasks() {
  const line = state.selectedLine;
  if (!line?.order_id) {
    state.selectedOrderTasks = [];
    state.selectedOrderTaskEvents = new Map();
    renderOrderTaskPanel();
    return;
  }

  try {
    const { data: tasks, error } = await supabase
      .from("ebay_order_tasks")
      .select("*")
      .eq("order_id", line.order_id)
      .order("created_at", { ascending: false });

    if (error) throw error;
    state.selectedOrderTasks = tasks || [];

    const taskIds = state.selectedOrderTasks.map((task) => task.id).filter(Boolean);
    if (!taskIds.length) {
      state.selectedOrderTaskEvents = new Map();
      renderOrderTaskPanel();
      renderSelectedOrderTaskAssignment();
      return;
    }

    const { data: events, error: eventError } = await supabase
      .from("ebay_order_task_events")
      .select("*")
      .in("task_id", taskIds)
      .order("created_at", { ascending: true });

    if (eventError) throw eventError;
    const byTask = new Map();
    (events || []).forEach((event) => {
      const list = byTask.get(event.task_id) || [];
      list.push(event);
      byTask.set(event.task_id, list);
    });
    state.selectedOrderTaskEvents = byTask;
    renderOrderTaskPanel();
    renderSelectedOrderTaskAssignment();
  } catch (error) {
    console.warn("Could not load order coordination tasks:", error);
    state.selectedOrderTasks = [];
    state.selectedOrderTaskEvents = new Map();
    renderOrderTaskPanel({ error: error?.message || "Could not load coordination tasks." });
    renderSelectedOrderTaskAssignment();
  }
}

async function ensureNoInventoryVideoReceiptTasksLoaded() {
  const orderIds = [...new Set(state.workerNoInventoryCandidates.map((line) => line.order_id).filter(Boolean))];
  if (!orderIds.length) return;

  const loadedOrderIds = new Set(state.selectedOrderTasks.map((task) => task.order_id).filter(Boolean));
  const missingOrderIds = orderIds.filter((orderId) => !loadedOrderIds.has(orderId));
  if (!missingOrderIds.length) return;

  const { data: tasks, error } = await supabase
    .from("ebay_order_tasks")
    .select("*")
    .in("order_id", missingOrderIds)
    .order("created_at", { ascending: false });
  if (error) throw error;

  const incomingTasks = tasks || [];
  if (!incomingTasks.length) return;
  const existingTaskIds = new Set(state.selectedOrderTasks.map((task) => task.id));
  incomingTasks.forEach((task) => {
    if (!existingTaskIds.has(task.id)) {
      state.selectedOrderTasks.push(task);
      existingTaskIds.add(task.id);
    }
  });

  const taskIds = incomingTasks.map((task) => task.id).filter(Boolean);
  if (!taskIds.length) return;

  const { data: events, error: eventError } = await supabase
    .from("ebay_order_task_events")
    .select("*")
    .in("task_id", taskIds)
    .order("created_at", { ascending: true });
  if (eventError) throw eventError;

  (events || []).forEach((event) => {
    const list = state.selectedOrderTaskEvents.get(event.task_id) || [];
    if (!list.some((entry) => entry.id === event.id)) {
      list.push(event);
      list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    }
    state.selectedOrderTaskEvents.set(event.task_id, list);
  });
}

async function ensureQueueVideoReceiptTasksLoaded(lines = []) {
  const orderIds = [...new Set((lines || []).map((line) => line?.order_id).filter(Boolean))];
  const missingOrderIds = orderIds.filter((orderId) => !state.queueVideoReceiptLoadedOrderIds.has(orderId));
  if (!missingOrderIds.length) return;

  missingOrderIds.forEach((orderId) => state.queueVideoReceiptLoadedOrderIds.add(orderId));

  const incomingTasks = [];
  for (let index = 0; index < missingOrderIds.length; index += 100) {
    const chunk = missingOrderIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_tasks")
      .select("*")
      .in("order_id", chunk)
      .order("created_at", { ascending: false });
    if (error) throw error;
    incomingTasks.push(...(data || []));
  }

  if (!incomingTasks.length) return;

  const existingTaskIds = new Set(state.queueVideoReceiptTasks.map((task) => task.id));
  incomingTasks.forEach((task) => {
    if (!existingTaskIds.has(task.id)) {
      state.queueVideoReceiptTasks.push(task);
      existingTaskIds.add(task.id);
    }
  });

  const taskIds = incomingTasks.map((task) => task.id).filter(Boolean);
  if (!taskIds.length) return;

  for (let index = 0; index < taskIds.length; index += 100) {
    const chunk = taskIds.slice(index, index + 100);
    const { data: events, error } = await supabase
      .from("ebay_order_task_events")
      .select("*")
      .in("task_id", chunk)
      .order("created_at", { ascending: true });
    if (error) throw error;

    (events || []).forEach((event) => {
      const list = state.queueVideoReceiptTaskEvents.get(event.task_id) || [];
      if (!list.some((entry) => entry.id === event.id)) {
        list.push(event);
        list.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      }
      state.queueVideoReceiptTaskEvents.set(event.task_id, list);
    });
  }
}

async function hydrateQueueVideoReceiptEvidenceThumbnails(lines = []) {
  const containers = [...document.querySelectorAll("[data-queue-video-evidence]")];
  if (!containers.length) return;

  try {
    await ensureQueueVideoReceiptTasksLoaded(lines);
  } catch (error) {
    console.warn("Could not load video receipt screenshots for the queue:", error);
    return;
  }

  await Promise.all(containers.map(async (container) => {
    const line = (lines || []).find((entry) => entry.id === container.dataset.queueVideoEvidence);
    if (!line?.id) return;
    const photos = getVideoReceiptEvidencePhotosForLine(line);
    if (!photos.length) {
      container.innerHTML = `<span class="queue-video-receipt-empty">No saved video receipt screenshot yet.</span>`;
      return;
    }
    const hydrated = await Promise.all(photos.map((photo) => ensureEvidencePhotoPreviewUrls(photo).catch(() => photo)));
    container.innerHTML = hydrated.map((photo, index) => {
      const actor = photo.signed_by_email || getVideoReceiptAuditActor();
      const capturedAt = photo.created_at || photo.metadata?.capturedAt || "";
      const auditText = photo.auditText || `Captured by ${actor}${capturedAt ? ` on ${formatDate(capturedAt)}` : ""}`;
      return `
        <button type="button" class="video-receipt-evidence-thumb queue-video-receipt-thumb" data-queue-video-photo="${index}" title="Open video receipt screenshot">
          ${photo.thumbnailUrl || photo.previewUrl ? `<img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl)}" alt="${escapeHtml(photo.label || "Video receipt screenshot")}" />` : ""}
          <span>${escapeHtml(auditText)}</span>
        </button>
      `;
    }).join("");
    container.querySelectorAll("[data-queue-video-photo]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const photo = hydrated[Number(button.dataset.queueVideoPhoto || 0)];
        if (!photo?.previewUrl) return;
        openEvidencePhotoObjectViewer({
          ...photo,
          auditText: photo.auditText || `Captured by ${photo.signed_by_email || getVideoReceiptAuditActor()}${photo.created_at ? ` on ${formatDate(photo.created_at)}` : ""}`,
        }, "orders-list");
      });
    });
  }));
}

function renderOrderTaskPanel(options = {}) {
  const list = $("order-task-list");
  const summary = $("order-task-summary");
  const button = $("open-order-task-modal");
  if (!list) return;

  button?.toggleAttribute("disabled", !state.selectedLine);

  if (!state.selectedLine) {
    list.innerHTML = `<div class="empty-state">Select an order to see coordination tasks.</div>`;
    if (summary) summary.textContent = "Assign questions or special handling notes to admins or workers.";
    return;
  }

  if (options.error) {
    list.innerHTML = `<div class="empty-state">${escapeHtml(options.error)}</div>`;
    if (summary) summary.textContent = "Coordination tasks could not be loaded.";
    return;
  }

  const visibleOrderTasks = state.selectedOrderTasks.filter((task) => {
    const events = state.selectedOrderTaskEvents.get(task.id) || [];
    return isVisibleActiveAssignedOrderCoordinationTask(task, events);
  });
  const activeCount = visibleOrderTasks.filter(isActiveOrderTask).length;
  if (summary) {
    summary.textContent = activeCount
      ? `${activeCount} active coordination task${activeCount === 1 ? "" : "s"} for this order.`
      : "No active coordination task is waiting on this order.";
  }

  if (!visibleOrderTasks.length) {
    list.innerHTML = `<div class="empty-state">No coordination tasks for this order.</div>`;
    return;
  }

  list.innerHTML = visibleOrderTasks.map((task) => {
    const events = state.selectedOrderTaskEvents.get(task.id) || [];
    const isUrgent = ["urgent", "high"].includes(String(task.priority || "").toLowerCase());
    const isResolved = !isActiveOrderTask(task);
    const eventHtml = events.length
      ? `<div class="order-task-events">${events.map((event) => renderOrderTaskEvent(event)).join("")}</div>`
      : `<div class="empty-state">No task trail yet.</div>`;
    return `
      <article class="order-task-card ${isUrgent ? "is-urgent" : ""} ${isResolved ? "is-resolved" : ""}">
        <div class="order-task-card-head">
          <div>
            <strong>${escapeHtml(task.title || "Order task")}</strong>
            <span>${escapeHtml(task.question || task.latest_note || "No note")}</span>
          </div>
          <span class="order-task-chip">${escapeHtml(getOrderTaskStatusLabel(task.status))}</span>
        </div>
        <div class="order-task-meta">
          <span>${escapeHtml(task.priority || "normal")}</span>
          <span>Assigned: ${escapeHtml(getOrderTaskAssigneeLabel(task))}</span>
          <span>Next: ${escapeHtml(formatDate(task.due_at))}</span>
          <span>Created ${escapeHtml(formatDate(task.created_at))}</span>
        </div>
        ${eventHtml}
        <div class="fulfill-actions">
          ${isResolved ? "" : `<button type="button" class="secondary-btn" data-order-task-progress="${escapeHtml(task.id)}">Progress / Delay</button>`}
          <button type="button" class="secondary-btn" data-order-task-reply="${escapeHtml(task.id)}">${isResolved ? "Add Note" : "Reply / Reassign"}</button>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-order-task-reply]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => openOrderTaskModal({ taskId: buttonEl.dataset.orderTaskReply }));
  });
  list.querySelectorAll("[data-order-task-progress]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => openOrderTaskModal({ taskId: buttonEl.dataset.orderTaskProgress, progress: true }));
  });
  list.querySelectorAll("[data-order-task-photo]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      openOrderTaskPhoto(
        buttonEl.dataset.bucket,
        buttonEl.dataset.path,
        {
          label: buttonEl.dataset.label || "",
          signedBy: buttonEl.dataset.signedBy || "",
          createdAt: buttonEl.dataset.createdAt || "",
          returnFocusId: "open-order-task-modal",
        }
      );
    });
  });
  list.querySelectorAll("[data-delete-video-receipt-capture]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      deleteVideoReceiptCapture(buttonEl);
    });
  });
  hydrateOrderTaskVideoReceiptThumbnails();
}

function renderOrderTaskEvent(event = {}) {
  const photos = Array.isArray(event.photo_attachments) ? event.photo_attachments : [];
  const photoHtml = photos.length
    ? `<div class="order-task-photo-strip">${photos.map((photo, index) => `
        <span class="order-task-photo-entry">
          <button
            type="button"
            class="${isVideoReceiptEvidencePhoto(photo) ? "order-task-video-receipt-thumb" : ""}"
            data-order-task-photo="1"
            data-bucket="${escapeHtml(photo.bucket || NO_INVENTORY_EVIDENCE_BUCKET)}"
            data-path="${escapeHtml(photo.path || "")}"
            data-label="${escapeHtml(photo.label || `Photo ${index + 1}`)}"
            data-signed-by="${escapeHtml(photo.signed_by_email || event.signed_by_email || "")}"
            data-created-at="${escapeHtml(photo.created_at || event.created_at || "")}"
          >
            ${isVideoReceiptEvidencePhoto(photo)
              ? `<span class="order-task-video-receipt-thumb-image" data-order-task-thumb-image="${escapeHtml(photo.bucket || NO_INVENTORY_EVIDENCE_BUCKET)}:${escapeHtml(photo.path || "")}"></span>
                 <span>${escapeHtml(photo.label || `Video receipt ${index + 1}`)}</span>
                 <small>${escapeHtml(`Captured by ${photo.signed_by_email || event.signed_by_email || "logged-in user"}${photo.created_at || event.created_at ? ` on ${formatDate(photo.created_at || event.created_at)}` : ""}`)}</small>`
              : escapeHtml(photo.label || `Photo ${index + 1}`)}
          </button>
          ${isVideoReceiptEvidencePhoto(photo) ? `
            <button
              type="button"
              class="order-task-photo-delete"
              data-delete-video-receipt-capture="1"
              data-event-id="${escapeHtml(event.id || "")}"
              data-bucket="${escapeHtml(photo.bucket || NO_INVENTORY_EVIDENCE_BUCKET)}"
              data-path="${escapeHtml(photo.path || "")}"
              data-label="${escapeHtml(photo.label || `Video receipt ${index + 1}`)}"
            >Delete</button>
          ` : ""}
        </span>
      `).join("")}</div>`
    : "";

  return `
    <article class="order-task-event">
      <div class="order-task-event-head">
        <strong>${escapeHtml(String(event.action || "commented").replace(/_/g, " "))}</strong>
        <span>${escapeHtml(formatDate(event.created_at))}</span>
      </div>
      ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
      <small>Signed by ${escapeHtml(event.signed_by_email || "logged-in user")} - ${escapeHtml(getOrderTaskStatusLabel(event.new_status || event.old_status || ""))}</small>
      ${photoHtml}
    </article>
  `;
}

async function deleteVideoReceiptCapture(buttonEl) {
  const eventId = buttonEl?.dataset?.eventId || "";
  const bucket = buttonEl?.dataset?.bucket || NO_INVENTORY_EVIDENCE_BUCKET;
  const path = buttonEl?.dataset?.path || "";
  const label = buttonEl?.dataset?.label || "this video receipt capture";
  if (!eventId || !path) {
    setStatus("This video receipt capture is missing delete details.", "error");
    return;
  }
  const confirmed = window.confirm(`Delete ${label}? This removes the mistaken screenshot from OG and the video receipt audit thumbnails.`);
  if (!confirmed) return;

  const originalText = buttonEl.textContent;
  buttonEl.disabled = true;
  buttonEl.textContent = "Deleting...";
  setStatus("Deleting video receipt capture...", "info");

  try {
    const { data, error } = await supabase.rpc("delete_ebay_video_receipt_capture", {
      _event_id: eventId,
      _bucket: bucket,
      _path: path,
      _signed_by_email: state.user?.email || state.employee?.display_name || "",
    });
    if (error) throw error;
    if (!Number(data?.removed_count || 0)) {
      throw new Error("Supabase did not remove that capture. The stored path may not match the task photo.");
    }

    const { error: storageError } = await supabase.storage.from(bucket).remove([path]);
    if (storageError) {
      console.warn("Video receipt capture was removed from coordination, but storage cleanup failed:", storageError);
    }
    state.orderTaskSignedUrls.delete(`${bucket}/${path}`);
    await loadSelectedOrderTasks();
    if (state.selectedLine?.id) await renderSelectedVideoReceiptEvidence();
    if (state.workerNoInventoryLineIds.size) renderWorkerNoInventoryList();
    setStatus(
      storageError
        ? `Video receipt capture removed from coordination. Storage cleanup needs admin review: ${storageError.message || "Storage API rejected deletion."}`
        : `Video receipt capture deleted (${Number(data.removed_count).toLocaleString()} attachment${Number(data.removed_count) === 1 ? "" : "s"} removed).`,
      storageError ? "error" : "success"
    );
  } catch (error) {
    console.error("Could not delete video receipt capture:", error);
    buttonEl.disabled = false;
    buttonEl.textContent = originalText;
    const message = error.message || "Could not delete that video receipt capture.";
    setStatus(message, "error");
    alert(message);
  }
}

async function openOrderTaskPhoto(bucket, path, options = {}) {
  if (!path) return setStatus("That task photo is missing a storage path.", "error");
  const storageBucket = bucket || NO_INVENTORY_EVIDENCE_BUCKET;
  const key = `${storageBucket}/${path}`;
  let url = state.orderTaskSignedUrls.get(key);
  if (!url) {
    const { data, error } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(path, NO_INVENTORY_EVIDENCE_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) {
      console.warn("Could not sign order task photo:", error);
      return setStatus("Could not open that task photo.", "error");
    }
    url = data.signedUrl;
    state.orderTaskSignedUrls.set(key, url);
  }
  openEvidencePhotoObjectViewer({
    bucket: storageBucket,
    path,
    previewUrl: url,
    thumbnailUrl: url,
    label: options.label || "Order task photo",
    signed_by_email: options.signedBy || "",
    created_at: options.createdAt || "",
    auditText: options.signedBy || options.createdAt
      ? `Captured by ${options.signedBy || "logged-in user"}${options.createdAt ? ` on ${formatDate(options.createdAt)}` : ""}`
      : "",
  }, options.returnFocusId || "open-order-task-modal");
}

async function hydrateOrderTaskVideoReceiptThumbnails() {
  const placeholders = [...document.querySelectorAll("[data-order-task-thumb-image]")];
  await Promise.all(placeholders.map(async (placeholder) => {
    const [bucket, ...pathParts] = String(placeholder.dataset.orderTaskThumbImage || "").split(":");
    const path = pathParts.join(":");
    if (!bucket || !path || placeholder.dataset.loaded === "true") return;
    const url = await createNoInventorySignedImageUrl(bucket, path, { transform: NO_INVENTORY_THUMBNAIL_TRANSFORM });
    if (!url) return;
    placeholder.innerHTML = `<img src="${escapeHtml(url)}" alt="Video receipt screenshot" />`;
    placeholder.dataset.loaded = "true";
  }));
}

function resetOrderTaskPhotos() {
  state.orderTaskPhotos.forEach((photo) => {
    if (photo.previewUrl && String(photo.previewUrl).startsWith("blob:")) {
      URL.revokeObjectURL(photo.previewUrl);
    }
  });
  state.orderTaskPhotos = [];
  state.orderTaskPhotoUploadKeys.clear();
  renderOrderTaskPhotos();
}

function renderOrderTaskPhotos() {
  const grid = $("order-task-photo-grid");
  if (!grid) return;
  const toolbar = document.querySelector(".order-task-photo-toolbar");
  toolbar?.classList.toggle("hidden", !state.orderTaskPhotos.length);

  if (!state.orderTaskPhotos.length) {
    grid.innerHTML = `<div class="empty-state">No task photos added.</div>`;
    updateOrderTaskPhotoSelectionSummary();
    return;
  }

  grid.innerHTML = state.orderTaskPhotos.map((photo, index) => {
    const key = getOrderTaskPhotoKey(photo);
    const selected = state.orderTaskPhotoUploadKeys.has(key);
    return `
      <article class="no-inventory-photo-card ${selected ? "is-selected" : ""}">
        <label class="no-inventory-photo-select">
          <input
            type="checkbox"
            data-order-task-photo-select="${escapeHtml(key)}"
            ${selected ? "checked" : ""}
          />
          <span>Upload</span>
        </label>
        <button type="button" data-order-task-photo-index="${index}" title="Open task photo">
          <img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl || "")}" alt="${escapeHtml(photo.label || `Task photo ${index + 1}`)}" />
          <span>${escapeHtml(photo.label || `Task photo ${index + 1}`)}</span>
        </button>
      </article>
    `;
  }).join("");

  grid.querySelectorAll("[data-order-task-photo-index]").forEach((buttonEl) => {
    buttonEl.addEventListener("click", () => {
      openOrderTaskLocalPhotoViewer(Number(buttonEl.dataset.orderTaskPhotoIndex || 0));
    });
  });
  grid.querySelectorAll("[data-order-task-photo-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.orderTaskPhotoUploadKeys.add(checkbox.dataset.orderTaskPhotoSelect);
      else state.orderTaskPhotoUploadKeys.delete(checkbox.dataset.orderTaskPhotoSelect);
      renderOrderTaskPhotos();
    });
  });
  updateOrderTaskPhotoSelectionSummary();
}

function updateOrderTaskPhotoSelectionSummary() {
  const summary = $("order-task-photo-selection-summary");
  if (!summary) return;
  const total = state.orderTaskPhotos.length;
  const selected = getSelectedOrderTaskPhotos().length;
  summary.textContent = total
    ? `${selected} of ${total} photo${total === 1 ? "" : "s"} selected for upload.`
    : "";
}

function setAllOrderTaskPhotosSelected(selected) {
  state.orderTaskPhotoUploadKeys.clear();
  if (selected) {
    state.orderTaskPhotos.forEach((photo) => {
      state.orderTaskPhotoUploadKeys.add(getOrderTaskPhotoKey(photo));
    });
  }
  renderOrderTaskPhotos();
}

function openOrderTaskLocalPhotoViewer(index) {
  const photo = state.orderTaskPhotos[index];
  if (!photo?.previewUrl) return;
  const image = $("no-inventory-photo-viewer-image");
  const caption = $("no-inventory-photo-viewer-caption");
  if (image) {
    image.src = photo.previewUrl;
    image.alt = photo.label || `Task photo ${index + 1}`;
  }
  if (caption) {
    caption.textContent = `${photo.label || `Task photo ${index + 1}`} - ${photo.bucket ? `${photo.bucket}/${photo.path}` : photo.path || "local file"}`;
  }
  openModal("no-inventory-photo-viewer-modal");
  setTimeout(() => $("dismiss-no-inventory-photo-viewer")?.focus(), 80);
}

function handleOrderTaskPhotoFiles(event) {
  const files = [...(event.target?.files || [])].filter((file) => /^image\//i.test(file.type || ""));
  if (!files.length) {
    setOrderTaskPhotoStatus("Choose image files to attach.", "error");
    return;
  }
  files.forEach((file, index) => {
    const localId = `local:${crypto.randomUUID()}`;
    const photo = {
      localId,
      file,
      bucket: "",
      path: file.name || `task-photo-${index + 1}`,
      previewUrl: URL.createObjectURL(file),
      thumbnailUrl: "",
      label: file.name || `Task photo ${index + 1}`,
      mime_type: file.type || "image/jpeg",
      created_at: new Date().toISOString(),
    };
    photo.thumbnailUrl = photo.previewUrl;
    state.orderTaskPhotos.push(photo);
    state.orderTaskPhotoUploadKeys.add(localId);
  });
  renderOrderTaskPhotos();
  setOrderTaskPhotoStatus(`${files.length} task photo${files.length === 1 ? "" : "s"} added and selected.`, "info");
  if (event.target) event.target.value = "";
}

async function persistOrderTaskPhotos(lineIds = []) {
  const selectedPhotos = getSelectedOrderTaskPhotos();
  if (!selectedPhotos.length) return [];

  const dateFolder = new Date().toISOString().slice(0, 10);
  const orderLabel = getNoInventoryEvidenceSourceLabel();
  const selectedSuffix = lineIds.length === 1
    ? safeNoInventoryEvidenceSegment(lineIds[0], "line")
    : `${lineIds.length || 1}-lines`;
  const savedPhotos = [];

  for (let index = 0; index < selectedPhotos.length; index += 1) {
    const photo = selectedPhotos[index];
    const blob = await getEvidencePhotoBlob(photo, index);
    const extension = getNoInventoryEvidenceFileExtension(photo, blob);
    const originalName = safeNoInventoryEvidenceSegment(String(photo.path || photo.label || "").split("/").pop(), `task-photo-${index + 1}`);
    const destinationPath = [
      "pending-order-tasks",
      dateFolder,
      orderLabel,
      `${Date.now()}-${crypto.randomUUID()}-${selectedSuffix}-${originalName}.${extension}`,
    ].join("/");

    const { error } = await supabase.storage
      .from(NO_INVENTORY_EVIDENCE_BUCKET)
      .upload(destinationPath, blob, {
        contentType: blob.type || photo.mime_type || "image/jpeg",
        upsert: false,
      });

    if (error) throw new Error(error.message || `Could not save task photo ${index + 1}.`);

    savedPhotos.push({
      bucket: NO_INVENTORY_EVIDENCE_BUCKET,
      path: destinationPath,
      source_bucket: photo.bucket || null,
      source_path: photo.path || null,
      capture_job_id: photo.capture_job_id || null,
      sort_order: index,
      label: photo.label || `Task photo ${index + 1}`,
      mime_type: blob.type || photo.mime_type || null,
      size_bytes: blob.size || photo.size_bytes || 0,
      created_at: new Date().toISOString(),
    });
  }

  return savedPhotos;
}

async function requestOrderTaskPhoto() {
  if (state.orderTaskCaptureBusy) return;
  try {
    state.orderTaskCaptureBusy = true;
    $("request-order-task-photo")?.toggleAttribute("disabled", true);

    if (!state.noInventoryCaptureStations.length) {
      await loadNoInventoryCaptureStations({ silent: true });
    }

    const station = getSelectedNoInventoryCaptureStation();
    if (!station) {
      setOrderTaskPhotoStatus("Choose a camera station before taking task photos.", "error");
      $("order-task-capture-station")?.focus();
      return;
    }

    setOrderTaskPhotoStatus(`Sending camera request to ${station.name || "selected station"}...`, "info");
    const job = await createNoInventoryCaptureJob(station.id);

    window.dispatchEvent(new CustomEvent("assisted:iphone-capture-requested", {
      detail: {
        source: "pending-order-task",
        stationId: station.id,
        stationName: station.name || "",
        jobId: job.id,
        orderLineIds: getOrderTaskLineIdsForSelectedOrder(),
        taskId: state.orderTaskMode === "reply" ? state.activeOrderTaskId : "",
      },
    }));

    const completedJob = await pollNoInventoryCaptureJob(job, station, { statusSetter: setOrderTaskPhotoStatus });
    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || "Camera capture failed.");
    }

    let photoRows = await loadNoInventoryCaptureJobPhotos(completedJob.id);
    if (!photoRows.length && completedJob.storage_bucket && completedJob.storage_path) {
      photoRows = [{
        id: completedJob.id,
        capture_job_id: completedJob.id,
        storage_bucket: completedJob.storage_bucket,
        storage_path: completedJob.storage_path,
        mime_type: completedJob.mime_type || "image/jpeg",
        label: "Task photo",
        created_at: completedJob.capture_completed_at || completedJob.upload_completed_at || new Date().toISOString(),
      }];
    }
    if (!photoRows.length) throw new Error("Camera finished but no photos were attached.");

    const photos = await noInventoryCaptureRowsToEvidencePhotos(photoRows);
    const existing = new Set(state.orderTaskPhotos.map((photo) => `${photo.bucket}:${photo.path}`));
    photos.forEach((photo) => {
      const key = getOrderTaskPhotoKey(photo);
      if (!existing.has(`${photo.bucket}:${photo.path}`)) {
        state.orderTaskPhotos.push(photo);
        state.orderTaskPhotoUploadKeys.add(key);
      }
    });
    renderOrderTaskPhotos();
    setOrderTaskPhotoStatus(`${photos.length} task photo${photos.length === 1 ? "" : "s"} added and selected.`, "info");
  } catch (error) {
    console.error("Order task photo capture failed:", error);
    setOrderTaskPhotoStatus(error?.message || "Could not take task photo.", "error");
  } finally {
    state.orderTaskCaptureBusy = false;
    $("request-order-task-photo")?.toggleAttribute("disabled", false);
  }
}

function closeOrderTaskModal(options = {}) {
  resetOrderTaskPhotos();
  setOrderTaskError("");
  setOrderTaskPhotoStatus("");
  state.activeOrderTaskId = "";
  state.orderTaskMode = "create";
  closeModal("order-task-modal");
  returnToOrdersAfterMobileModalClose(options);
  setTimeout(() => $("open-order-task-modal")?.focus(), 80);
}

async function openOrderTaskModal(options = {}) {
  const line = state.selectedLine;
  if (!line) {
    setStatus("Select an eBay order first.", "error");
    return;
  }

  const taskId = options.taskId || "";
  const task = taskId ? state.selectedOrderTasks.find((entry) => entry.id === taskId) : null;
  state.activeOrderTaskId = task?.id || "";
  state.orderTaskMode = task ? "reply" : "create";
  resetOrderTaskPhotos();
  setOrderTaskError("");
  setOrderTaskPhotoStatus("");

  $("order-task-modal-title").textContent = task
    ? options.progress ? "Progress / delay update" : "Reply to order task"
    : "Create order task";
  $("order-task-modal-subtitle").textContent = task
    ? options.progress
      ? "Explain what happened, what is blocking completion, and when this should be checked again."
      : "Add the next instruction, assign it to the next person, or resolve it."
    : "Send a question, instruction, or special handling request to an admin or worker.";
  $("submit-order-task").textContent = task ? options.progress ? "Save Progress" : "Send Update" : "Send Task";
  $("order-task-status-field")?.classList.toggle("hidden", !task);
  $("order-task-note").value = "";
  $("order-task-note").placeholder = options.progress
    ? "Why could this not be completed today? What are we waiting for, and what should happen next?"
    : "Write exactly what needs review, a decision, or special coordination.";
  $("order-task-priority").value = task?.priority || "normal";
  $("order-task-status").value = task ? options.progress ? "deferred" : "" : "";
  $("order-task-due-at").value = toDateTimeLocalValue(task?.due_at || (!task ? line.order?.ship_by_date : ""));
  $("order-task-context").innerHTML = `
    <strong>${escapeHtml(line.order?.order_number || "eBay order")} - ${escapeHtml(line.order?.buyer_username || "unknown buyer")}</strong>
    <span>${escapeHtml(line.item_title || "Untitled item")}</span>
    ${task ? `<span>Current: ${escapeHtml(getOrderTaskStatusLabel(task.status))} / assigned to ${escapeHtml(getOrderTaskAssigneeLabel(task))}</span>` : ""}
  `;

  await loadOrderTaskAssignees();
  const assignee = $("order-task-assignee");
  if (assignee) {
    const defaultAdmin = state.orderTaskAssignees.find((employee) => String(employee.role || "").toLowerCase() === "admin");
    assignee.value = task?.assigned_to_user_id || (!task && !isAdminUser() ? defaultAdmin?.user_id || "" : "");
  }

  openModal("order-task-modal");
  setTimeout(() => $("order-task-note")?.focus(), 80);
  loadNoInventoryCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not load order task camera stations:", error);
    setOrderTaskPhotoStatus(error?.message || "Could not load capture stations.", "error");
  });
}

async function submitOrderTask() {
  const line = state.selectedLine;
  if (!line?.order_id) return setOrderTaskError("Select an eBay order first.");
  const note = String($("order-task-note")?.value || "").trim();
  if (!note) return setOrderTaskError("Write a note or question before sending this task.");

  const button = $("submit-order-task");
  button?.toggleAttribute("disabled", true);
  setOrderTaskError("");
  setOrderTaskPhotoStatus("Saving task...", "info");

  try {
    const lineIds = getOrderTaskLineIdsForSelectedOrder();
    const photos = await persistOrderTaskPhotos(lineIds);
    const assigneeUserId = $("order-task-assignee")?.value || null;
    const priority = $("order-task-priority")?.value || "normal";
    const signedByEmail = state.user?.email || state.employee?.display_name || "";

    if (state.orderTaskMode === "reply" && state.activeOrderTaskId) {
      const { error } = await supabase.rpc("respond_ebay_order_coordination_task", {
        _task_id: state.activeOrderTaskId,
        _note: note,
        _assigned_to_user_id: assigneeUserId,
        _status: $("order-task-status")?.value || null,
        _priority: priority,
        _photo_attachments: photos,
        _signed_by_email: signedByEmail,
        _due_at: localDateTimeToIso($("order-task-due-at")?.value || ""),
      });
      if (error) throw error;
      setStatus("Order task update saved.", "success");
    } else {
      const { error } = await supabase.rpc("create_ebay_order_coordination_task", {
        _order_id: line.order_id,
        _order_line_ids: lineIds,
        _assigned_to_user_id: assigneeUserId,
        _priority: priority,
        _question: note,
        _due_at: localDateTimeToIso($("order-task-due-at")?.value || "") || line.order?.ship_by_date || null,
        _photo_attachments: photos,
        _signed_by_email: signedByEmail,
      });
      if (error) throw error;
      setStatus("Order task created and assigned.", "success");
    }

    closeOrderTaskModal();
    await loadSelectedOrderTasks();
    await hydrateOrderTaskAssignments(state.orders);
    renderOrders();
    renderSelectedOrderTaskAssignment();
  } catch (error) {
    console.error("Could not save order task:", error);
    setOrderTaskError(error?.message || "Could not save this order task.");
    setOrderTaskPhotoStatus("", "info");
  } finally {
    button?.toggleAttribute("disabled", false);
  }
}

async function openRequestedOrderTask() {
  if (!state.launchOrderTaskId) return false;

  try {
    const { data: task, error } = await supabase
      .from("ebay_order_tasks")
      .select("id, order_id, order_line_ids")
      .eq("id", state.launchOrderTaskId)
      .maybeSingle();

    if (error) throw error;
    if (!task) {
      setStatus("That order coordination task could not be found.", "error");
      return false;
    }

    const matchesTask = (line) => (
      line.order_id === task.order_id
      || (Array.isArray(task.order_line_ids) && task.order_line_ids.includes(line.id))
    );
    let line = state.orders.find(matchesTask);

    if (!line) {
      const filter = $("order-status-filter");
      if (filter && filter.value !== "all") {
        filter.value = "all";
        await loadOrders();
        line = state.orders.find(matchesTask);
      }
    }

    if (!line) {
      setStatus("The task loaded, but its order line is not visible in the current queue.", "error");
      return false;
    }

    selectOrderLine(line.id);
    state.activeOrderTaskId = task.id;
    await loadSelectedOrderTasks();
    $("order-task-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    setStatus("Opened the coordination task for this order.", "info");
    return true;
  } catch (error) {
    console.warn("Could not open requested order task:", error);
    setStatus(error?.message || "Could not open that order task.", "error");
    return false;
  }
}

function renderSelectionSummary() {
  const summary = $("selection-summary");
  if (!summary) return;

  if (!state.selectedItem) {
    summary.textContent = "No item selected yet.";
    return;
  }

  const item = state.selectedItem;
  const row = state.selectedStockRow;
  const sourceLabel = row?.locationLabel || (state.checkoutStoreId ? `Choose tray in ${getCheckoutStoreName()}` : "Select checkout store");
  summary.innerHTML = `
    <strong>${escapeHtml(item.title || "Untitled inventory item")}</strong>
    <div class="selection-grid">
      <span><small>Barcode</small><b>${escapeHtml(item.barcode || "-")}</b></span>
      <span><small>Retail</small><b>${formatMoney(item.sale_price)}</b></span>
      <span><small>Source</small><b>${escapeHtml(sourceLabel)}</b></span>
      <span><small>Available</small><b>${row ? Number(row.quantity || 0).toLocaleString() : "-"}</b></span>
    </div>
  `;
}

function renderItemResults(items, message = "No matching inventory items.") {
  const container = $("item-results");
  if (!container) return;
  container.replaceChildren();

  if (!items.length) {
    if (message) container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    return;
  }

  items.slice(0, 12).forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `result-btn ${state.selectedItem?.id === item.id ? "is-selected" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(item.title || "Untitled item")}</strong>
      <span>${escapeHtml(item.barcode || "No barcode")} - ${formatMoney(item.sale_price)} - ${Number(item.weight || 0).toFixed(2)} g</span>
    `;
    button.addEventListener("click", () => openItemConfirmModal(item));
    container.appendChild(button);
  });
}

function renderLocationResults(rows, message = "No source locations loaded yet.") {
  const container = $("location-results");
  if (!container) return;
  container.replaceChildren();

  if (!rows.length) {
    if (message) container.innerHTML = `<div class="empty-state">${escapeHtml(message)}</div>`;
    return;
  }

  rows.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `result-btn ${state.selectedStockRow?.id === row.id ? "is-selected" : ""}`;
    button.innerHTML = `
      <strong>${escapeHtml(row.locationLabel)}</strong>
      <span>${Number(row.quantity || 0).toLocaleString()} available${Number(row.reserved_quantity || 0) > 0 ? ` - ${Number(row.reserved_quantity || 0).toLocaleString()} reserved live` : ""}${row.location_code ? ` - ${escapeHtml(row.location_code)}` : ""}</span>
    `;
    button.addEventListener("click", () => selectStockRow(row));
    container.appendChild(button);
  });
}

async function openItemConfirmModal(item) {
  state.pendingItemCandidate = item;
  $("item-confirm-name").textContent = item.title || "Untitled item";
  $("item-confirm-barcode").textContent = item.barcode ? `Barcode ${item.barcode}` : "No barcode recorded";
  $("item-confirm-description").textContent = item.description || "No description recorded.";
  const image = $("item-confirm-image");
  if (image) {
    image.removeAttribute("src");
    image.alt = item.title || "Inventory item";
  }
  openModal("item-confirm-modal");
  setTimeout(() => $("confirm-item-choice")?.focus(), 80);

  const url = await resolvePhotoUrl(firstItemPhoto(item));
  if (state.pendingItemCandidate?.id === item.id && image) {
    if (url) image.src = url;
    else image.removeAttribute("src");
  }
}

function closeItemConfirmModal(options = {}) {
  state.pendingItemCandidate = null;
  closeModal("item-confirm-modal");
  returnToOrdersAfterMobileModalClose(options);
  setTimeout(() => $("item-scan")?.focus(), 80);
}

async function confirmItemCandidate() {
  const item = state.pendingItemCandidate;
  if (!item) return;
  state.pendingItemCandidate = null;
  closeModal("item-confirm-modal");
  await selectInventoryItem(item);
}

function sanitizeSearchTerm(term) {
  return String(term || "").trim().replace(/[%,]/g, " ");
}

async function searchInventoryItems() {
  if (!requireCheckoutStore()) return;

  const term = sanitizeSearchTerm($("item-scan")?.value || "");
  if (!term) {
    setStatus("Scan a barcode or search by item name / description.", "error");
    return;
  }

  setStatus("Searching inventory...");

  let exact = await supabase
    .from("item_types")
    .select("id,title,description,barcode,sale_price,photo_url,photos,categories,weight")
    .eq("barcode", term)
    .is("deleted_at", null)
    .limit(1);

  if (exact.error && /deleted_at/i.test(exact.error.message || "")) {
    exact = await supabase
      .from("item_types")
      .select("id,title,description,barcode,sale_price,photo_url,photos,categories,weight")
      .eq("barcode", term)
      .limit(1);
  }

  if (!exact.error && exact.data?.length === 1) {
    await openItemConfirmModal(exact.data[0]);
    return;
  }

  const pattern = `%${term}%`;
  let { data, error } = await supabase
    .from("item_types")
    .select("id,title,description,barcode,sale_price,photo_url,photos,categories,weight")
    .or(`barcode.ilike.${pattern},title.ilike.${pattern},description.ilike.${pattern}`)
    .is("deleted_at", null)
    .limit(25);

  if (error && /deleted_at/i.test(error.message || "")) {
    const retry = await supabase
      .from("item_types")
      .select("id,title,description,barcode,sale_price,photo_url,photos,categories,weight")
      .or(`barcode.ilike.${pattern},title.ilike.${pattern},description.ilike.${pattern}`)
      .limit(25);
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error("Inventory search failed:", error);
    setStatus(error.message || "Could not search inventory.", "error");
    return;
  }

  const items = data || [];
  if (items.length === 1) await openItemConfirmModal(items[0]);
  else {
    renderItemResults(items, "No item found. Try scanning the internal barcode.");
    setStatus(items.length ? `${items.length} item matches. Choose the exact item being shipped.` : "No item found.", items.length ? "info" : "error");
  }
}

async function selectInventoryItem(item) {
  if (!requireCheckoutStore()) return;
  state.selectedItem = item;
  state.selectedStockRow = null;
  renderItemResults([item]);
  renderSelectionSummary();
  await loadStockRowsForItem(item.id);
}

function normalizeStockRow(row) {
  const loc = row.location || {};
  const isTray = loc.is_tray || loc.location_role === "tray";
  const storeId = isTray ? (loc.tray_current_store_id || loc.store_id || "") : (loc.store_id || "");
  const storeName = getCheckoutStoreName(storeId);
  const trayLabel = isTray
    ? (loc.tray_status === "checked_out" ? "Checked out tray" : "Tray")
    : loc.parent_location_id ? "Container" : "Location";
  return {
    ...row,
    isTray,
    store_id: storeId,
    tray_status: loc.tray_status || "",
    location_id: row.location_id || loc.id,
    location_name: loc.location_name || "",
    location_code: loc.location_code || "",
    locationLabel: `${loc.location_name || "Unnamed location"}${loc.location_code ? ` (${loc.location_code})` : ""} - ${trayLabel}${storeName ? ` - ${storeName}` : ""}`,
  };
}

async function loadStockRowsForItem(itemId) {
  if (!requireCheckoutStore()) {
    state.stockRows = [];
    renderLocationResults([], "Select a checkout store before loading source trays.");
    return;
  }

  const storeName = getCheckoutStore()?.name || "the selected store";
  setStatus(`Loading source trays in ${storeName}...`);
  const [{ data, error }, { data: reservations, error: reservationError }] = await Promise.all([
    supabase
      .from("item_stock_locations")
      .select("id,item_id,location_id,quantity,location:location_id(*)")
      .eq("item_id", itemId)
      .gt("quantity", 0),
    supabase
      .from("active_stock_reservations")
      .select("stock_location_row_id,reserved_quantity")
      .eq("item_id", itemId),
  ]);

  if (error) {
    console.error("Source location load failed:", error);
    state.stockRows = [];
    renderLocationResults([], "Could not load source locations.");
    setStatus(error.message || "Could not load source locations.", "error");
    return;
  }

  if (reservationError) {
    console.warn("Could not load active reservations for pending checkout:", reservationError);
  }

  const reservationMap = new Map((reservations || []).map((entry) => [
    entry.stock_location_row_id,
    Number(entry.reserved_quantity || 0),
  ]));

  state.stockRows = (data || [])
    .map((row) => {
      const reserved = reservationMap.get(row.id) || 0;
      return {
        ...row,
        physical_quantity: Number(row.quantity || 0),
        reserved_quantity: reserved,
        quantity: Math.max(0, Number(row.quantity || 0) - reserved),
      };
    })
    .map(normalizeStockRow)
    .filter((row) => {
      return row.isTray
        && row.store_id === state.checkoutStoreId
        && row.tray_status !== "checked_out"
        && Number(row.quantity || 0) > 0;
    });

  renderLocationResults(state.stockRows, `This item is not available in any checked-in tray at ${storeName}.`);

  if (!state.stockRows.length) {
    setStatus(`No checked-in tray at ${storeName} currently holds this item.`, "error");
    return;
  }

  if (state.stockRows.length === 1) {
    selectStockRow(state.stockRows[0], { automatic: true });
    return;
  }

  setStatus(`${state.stockRows.length} source trays in ${storeName}. Scan the tray label or choose one.`, "info");
  setTimeout(() => $("location-scan")?.focus(), 80);
}

function selectStockRow(row, { automatic = false } = {}) {
  state.selectedStockRow = row;
  $("location-scan").value = row.location_code || row.location_name || "";
  const qtyInput = $("fulfill-quantity");
  if (qtyInput) {
    qtyInput.value = "1";
    qtyInput.max = String(Math.max(1, Number(row.quantity || 1)));
  }
  renderLocationResults(state.stockRows);
  renderSelectionSummary();
  setStatus(automatic
    ? "Only one valid tray was found in this store. It was selected automatically; staging in 1 second unless quantity changes."
    : "Source selected. Quantity is ready; staging automatically in 1 second.");
  setTimeout(() => {
    qtyInput?.focus();
    qtyInput?.select();
  }, 60);
  scheduleQuantityAutoStage();
}

function clearQuantityAutoStage() {
  if (state.quantityAutoTimer) {
    clearTimeout(state.quantityAutoTimer);
    state.quantityAutoTimer = null;
  }
}

function scheduleQuantityAutoStage() {
  clearQuantityAutoStage();
  state.quantityAutoTimer = setTimeout(() => {
    state.quantityAutoTimer = null;
    stageCurrentLine({ autoAdvance: true, autoReview: true });
  }, 1000);
}

function clearItemSearchTimer() {
  if (state.itemSearchTimer) {
    clearTimeout(state.itemSearchTimer);
    state.itemSearchTimer = null;
  }
}

function clearLocationSearchTimer() {
  if (state.locationSearchTimer) {
    clearTimeout(state.locationSearchTimer);
    state.locationSearchTimer = null;
  }
}

function clearLiveLotSearchTimer() {
  if (state.liveLotSearchTimer) {
    clearTimeout(state.liveLotSearchTimer);
    state.liveLotSearchTimer = null;
  }
}

function scheduleItemSearch() {
  clearItemSearchTimer();
  const term = sanitizeSearchTerm($("item-scan")?.value || "");
  if (!term || !$("item-confirm-modal")?.classList.contains("hidden")) return;

  state.itemSearchTimer = setTimeout(() => {
    state.itemSearchTimer = null;
    if (!$("item-confirm-modal")?.classList.contains("hidden")) return;
    const currentTerm = sanitizeSearchTerm($("item-scan")?.value || "");
    if (currentTerm) searchInventoryItems();
  }, 1500);
}

function scheduleSourceLocationSearch() {
  clearLocationSearchTimer();
  const term = String($("location-scan")?.value || "").trim();
  if (!term) return;

  state.locationSearchTimer = setTimeout(() => {
    state.locationSearchTimer = null;
    const currentTerm = String($("location-scan")?.value || "").trim();
    if (currentTerm) searchSourceLocation();
  }, 1000);
}

function syncLiveLotScanInputs(value = "") {
  const normalized = String(value || "").trim();
  if ($("live-lot-scan")) $("live-lot-scan").value = normalized;
  if ($("global-live-lot-scan")) $("global-live-lot-scan").value = normalized;
}

function scheduleLiveLotSearch(inputId = "live-lot-scan") {
  clearLiveLotSearchTimer();
  const term = String($(inputId)?.value || "").trim();
  if (!term) return;

  state.liveLotSearchTimer = setTimeout(() => {
    state.liveLotSearchTimer = null;
    const currentTerm = String($(inputId)?.value || "").trim();
    if (currentTerm) loadLiveLotByScan(currentTerm);
  }, 700);
}

function searchSourceLocation() {
  clearLocationSearchTimer();
  if (!requireCheckoutStore()) return;

  const term = String($("location-scan")?.value || "").trim().toLowerCase();
  if (!term) {
    if (state.stockRows.length === 1) {
      selectStockRow(state.stockRows[0], { automatic: true });
      return;
    }
    setStatus("Scan or type a tray barcode.", "error");
    return;
  }

  const matches = state.stockRows.filter((row) =>
    String(row.id || "").toLowerCase() === term ||
    String(row.location_id || "").toLowerCase() === term ||
    String(row.location_code || "").toLowerCase() === term ||
    String(row.location_name || "").toLowerCase().includes(term) ||
    String(row.locationLabel || "").toLowerCase().includes(term)
  );

  if (matches.length === 1) selectStockRow(matches[0]);
  else {
    renderLocationResults(matches, "That tray does not currently hold this item in the selected store.");
    setStatus(matches.length ? `${matches.length} source tray matches. Choose one.` : "No matching source tray for this item in the selected store.", matches.length ? "info" : "error");
  }
}

function clearLiveLotSelection({ render = true } = {}) {
  clearLiveLotSearchTimer();
  state.selectedLiveLot = null;
  state.selectedLiveLotItems = [];
  state.liveLotMatchedLineIds = new Set();
  state.liveLotOrderMatches = [];
  syncLiveLotScanInputs("");
  if (render) {
    renderLiveLotPanel();
    renderLiveLotOrderMatches();
    applyOrderFilters();
  }
}

async function loadLiveLotItems(lotId) {
  const { data, error } = await supabase
    .from("live_sale_lot_items")
    .select(`
      *,
      item:item_id(id,title,description,barcode,weight,sale_price,photos,photo_url),
      source_location:source_location_id(id,location_name,location_code,store_id,tray_current_store_id,is_tray,location_role,type,parent_location_id)
    `)
    .eq("lot_id", lotId)
    .order("scanned_at", { ascending: true });

  if (error) throw error;
  return data || [];
}

function normalizeMatchText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, "");
}

function normalizeAuctionToken(value) {
  return String(value || "")
    .trim()
    .replace(/^#+/, "")
    .replace(/[^a-z0-9]+/gi, "")
    .toLowerCase();
}

function extractAuctionTokens(value) {
  const text = String(value || "");
  const tokens = new Set();
  if (!text.trim()) return tokens;

  const exact = normalizeAuctionToken(text);
  if (exact && /^#?[a-z0-9-]+$/i.test(text.trim())) tokens.add(exact);

  const hashPattern = /#\s*([a-z0-9][a-z0-9-]*)/gi;
  let match = hashPattern.exec(text);
  while (match) {
    const token = normalizeAuctionToken(match[1]);
    if (token) tokens.add(token);
    match = hashPattern.exec(text);
  }

  const contextPattern = /\b(?:auction|auc|lot|bag)\s*(?:number|num|no\.?|#)?\s*[:.-]?\s*#?\s*([a-z0-9][a-z0-9-]*)/gi;
  match = contextPattern.exec(text);
  while (match) {
    const token = normalizeAuctionToken(match[1]);
    if (token) tokens.add(token);
    match = contextPattern.exec(text);
  }

  return tokens;
}

function lineHasAuctionNumber(line, lot) {
  const expected = normalizeAuctionToken(lot?.auction_number);
  if (!expected) return false;
  const fields = [
    line.item_title,
    line.custom_label,
  ];
  return fields.some((field) => extractAuctionTokens(field).has(expected));
}

function getLiveLotReferenceDate(lot) {
  return lot?.created_at || lot?.session?.started_at || lot?.live_sale_sessions?.started_at || null;
}

function getOrderReferenceDate(order) {
  return order?.sale_date || order?.paid_on_date || null;
}

function getLocalDayDistance(a, b) {
  if (!a || !b) return Number.POSITIVE_INFINITY;
  const first = startOfLocalDay(a);
  const second = startOfLocalDay(b);
  const firstTime = first.getTime();
  const secondTime = second.getTime();
  if (Number.isNaN(firstTime) || Number.isNaN(secondTime)) return Number.POSITIVE_INFINITY;
  return Math.round(Math.abs(firstTime - secondTime) / 86400000);
}

function lineDateFitsLiveLot(line, lot) {
  return getLocalDayDistance(getLiveLotReferenceDate(lot), getOrderReferenceDate(line.order)) <= 1;
}

function getLiveLotOrderHardMatch(line, lot) {
  return {
    auctionMatches: lineHasAuctionNumber(line, lot),
    dateMatches: lineDateFitsLiveLot(line, lot),
  };
}

function getLiveLotItemGroups(items = state.selectedLiveLotItems) {
  const groups = new Map();
  getPackableLiveLotItems(items).forEach((entry) => {
    const item = entry.item || {};
    const barcode = String(item.barcode || "").trim();
    const key = item.id || barcode || item.title || entry.id;
    if (!groups.has(key)) {
      groups.set(key, {
        item,
        quantity: 0,
        statuses: new Set(),
      });
    }
    const group = groups.get(key);
    group.quantity += Number(entry.quantity || 0);
    if (entry.status) group.statuses.add(entry.status);
  });
  return Array.from(groups.values());
}

function getPackableLiveLotItems(items = state.selectedLiveLotItems) {
  return (items || []).filter((entry) => entry.status === "reserved");
}

function scoreOrderLineForLiveLot(line, lot = state.selectedLiveLot, items = state.selectedLiveLotItems) {
  const reasons = [];
  let score = 0;
  const hardMatch = getLiveLotOrderHardMatch(line, lot);
  if (!hardMatch.auctionMatches || !hardMatch.dateMatches) {
    return {
      line,
      score: 0,
      reasons,
    };
  }

  const searchText = line.searchText || "";
  const lineNeedle = normalizeMatchText([
    line.item_title,
    line.item_number,
    line.custom_label,
    line.order?.order_number,
    line.order?.sales_record_number,
    line.order?.buyer_username,
  ].filter(Boolean).join(" "));
  score += 120;
  reasons.push("auction number");
  score += 18;
  reasons.push("sale date");

  const groups = getLiveLotItemGroups(items);
  const totalQty = groups.reduce((sum, group) => sum + Number(group.quantity || 0), 0);
  const remainingQty = getRemainingLineQuantity(line) || Number(line.quantity || 0);

  groups.forEach((group) => {
    const item = group.item || {};
    const barcode = normalizeMatchText(item.barcode);
    const title = normalizeMatchText(item.title);
    if (barcode && lineNeedle.includes(barcode)) {
      score += 70;
      reasons.push("item barcode");
    }
    if (title && title.length > 8 && lineNeedle.includes(title.slice(0, Math.min(title.length, 30)))) {
      score += 28;
      reasons.push("item title");
    }
    const titleTokens = String(item.title || "").toLowerCase().split(/\W+/).filter((token) => token.length > 3);
    const sharedTokens = titleTokens.filter((token) => searchText.includes(token)).slice(0, 5);
    if (sharedTokens.length) {
      score += Math.min(22, sharedTokens.length * 5);
      reasons.push("description words");
    }
  });

  if (totalQty && remainingQty && totalQty === remainingQty) {
    score += 18;
    reasons.push("quantity match");
  }

  const urgency = getOrderUrgency(line.order?.ship_by_date);
  if (urgency?.level === "overdue") score += 4;
  if (urgency?.level === "today") score += 3;
  if (urgency?.level === "tomorrow") score += 1;

  return {
    line,
    score,
    reasons: [...new Set(reasons)].slice(0, 4),
  };
}

function calculateLiveLotOrderMatches(lot = state.selectedLiveLot, items = state.selectedLiveLotItems) {
  if (!lot) return [];
  const packableItems = getPackableLiveLotItems(items);
  if (!packableItems.length) return [];
  return state.orders
    .filter(isOpenOrderLine)
    .map((line) => scoreOrderLineForLiveLot(line, lot, packableItems))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || getShipTimestamp(a.line.order?.ship_by_date) - getShipTimestamp(b.line.order?.ship_by_date))
    .slice(0, 12);
}

function setLiveLotOrderMatches(matches = []) {
  state.liveLotOrderMatches = matches;
  state.liveLotMatchedLineIds = new Set(matches.map((match) => match.line.id));
}

function renderLiveLotOrderMatches() {
  const list = $("live-lot-order-matches");
  const count = $("bag-match-count");
  if (!list) return;

  if (!state.selectedLiveLot) {
    if (count) count.textContent = "0";
    list.innerHTML = `<div class="empty-state">Scan a bag to see likely eBay orders.</div>`;
    return;
  }

  const matches = state.liveLotOrderMatches || [];
  if (count) count.textContent = String(matches.length);

  if (!matches.length) {
    list.innerHTML = `
      <div class="empty-state">
        No pending order has the same auction number and a sale date within one day of this bag. Clear the bag lookup or search the queue manually if this needs review.
      </div>
    `;
    return;
  }

  list.replaceChildren();
  matches.forEach((match, index) => {
    const line = match.line;
    const order = line.order || {};
    const urgency = getOrderUrgency(order.ship_by_date);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bag-match-card ${state.selectedLine?.id === line.id ? "is-selected" : ""}`;
    button.innerHTML = `
      <span class="match-rank">${index + 1}</span>
      <span class="match-copy">
        <strong>${escapeHtml(order.buyer_username || "No buyer username")}</strong>
        <small>${escapeHtml(order.order_number || "No order")} - ${escapeHtml(line.item_title || "Untitled eBay item")}</small>
        <em>${escapeHtml((match.reasons || []).join(" + ") || "possible text match")}</em>
      </span>
      <span class="match-meta">
        ${urgency ? `<b class="urgency-pill urgency-${urgency.level}"><i data-lucide="${urgency.icon}"></i>${escapeHtml(urgency.label)}</b>` : ""}
        <b>Qty ${Number(getRemainingLineQuantity(line) || line.quantity || 1).toLocaleString()}</b>
        ${isAdminUser() ? `<b>${formatMoney(line.total_price || line.sold_for || 0)}</b>` : ""}
      </span>
    `;
    button.addEventListener("click", () => {
      selectOrderLine(line.id);
      setStatus("Suggested eBay order selected. Review the bag contents, then confirm the packed bundle.", "info");
      setTimeout(() => $("fulfill-order")?.focus(), 80);
    });
    list.appendChild(button);
  });

  if (window.lucide) window.lucide.createIcons();
}

function clearOrderLineSelectionForBagLookup() {
  clearItemSearchTimer();
  clearLocationSearchTimer();
  clearQuantityAutoStage();
  state.selectedLine = null;
  state.selectedItem = null;
  state.selectedStockRow = null;
  state.stockRows = [];
  state.activeBuyerKey = "";
  state.stagedFulfillments.clear();
  document.body.classList.remove("pending-mobile-sheet-open");
  $("selected-order-empty")?.classList.remove("hidden");
  $("fulfillment-workflow")?.classList.add("hidden");
  if ($("item-scan")) $("item-scan").value = "";
  if ($("location-scan")) $("location-scan").value = "";
  renderBuyerBundlePanel();
  renderSelectionSummary();
  renderItemResults([]);
  renderLocationResults([]);
}

function selectLikelyLineForLiveLot(lot) {
  if (!lot || state.selectedLine) return;
  const strongMatches = state.liveLotOrderMatches.filter((match) => match.score >= 85);
  if (strongMatches.length === 1) selectOrderLine(strongMatches[0].line.id);
}

async function loadLiveLotByScan(rawTerm = "") {
  if (!requireCheckoutStore()) return;
  const term = String(rawTerm || $("global-live-lot-scan")?.value || $("live-lot-scan")?.value || "").trim();
  if (!term) {
    setStatus("Scan the auction number or live bag ID first.", "error");
    return;
  }

  try {
    clearEbayLaunchFilter({ apply: false });
    setStatus("Loading live-sale bag...");
    let result = await supabase
      .from("live_sale_lots")
      .select("*, live_sale_sessions(id,session_code,title,store_id,started_at,status)")
      .eq("lot_code", term)
      .maybeSingle();

    if (result.error) throw result.error;

    let lot = result.data;
    if (!lot) {
      result = await supabase
        .from("live_sale_lots")
        .select("*, live_sale_sessions(id,session_code,title,store_id,started_at,status)")
        .eq("auction_number", term)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (result.error) throw result.error;
      lot = result.data;
    }

    if (!lot) {
      clearLiveLotSelection({ render: true });
      setStatus("No live-sale bag matched that scan.", "error");
      return;
    }

    const session = Array.isArray(lot.live_sale_sessions) ? lot.live_sale_sessions[0] : lot.live_sale_sessions;
    if (session?.store_id && session.store_id !== state.checkoutStoreId) {
      throw new Error("This bag belongs to a different live-sale store than the selected checkout store.");
    }

    state.selectedLiveLot = { ...lot, session };
    state.selectedLiveLotItems = await loadLiveLotItems(lot.id);
    syncLiveLotScanInputs(term);
    setLiveLotOrderMatches(calculateLiveLotOrderMatches(state.selectedLiveLot, state.selectedLiveLotItems));
    if (
      state.selectedLine
      && state.liveLotOrderMatches.length
      && !state.liveLotMatchedLineIds.has(state.selectedLine.id)
    ) {
      clearOrderLineSelectionForBagLookup();
    }
    renderLiveLotPanel();
    applyOrderFilters();
    selectLikelyLineForLiveLot(state.selectedLiveLot);
    setStatus(state.liveLotOrderMatches.length
      ? "Live-sale bag loaded. Suggested eBay order matches are shown first."
      : "Live-sale bag loaded. No pending order matched both auction number and sale date.", "info");
  } catch (error) {
    console.error("Live-sale bag load failed:", error);
    setStatus(error.message || "Could not load that live-sale bag.", "error");
  }
}

function renderLiveLotPanelInto(panel, { global = false } = {}) {
  if (!panel) return;

  if (!state.selectedLiveLot) {
    panel.className = `live-lot-panel${global ? " is-global" : ""}`;
    panel.textContent = "No live auction bag loaded.";
    if (global && $("bag-lookup-status")) $("bag-lookup-status").textContent = "No bag loaded";
    return;
  }

  const lot = state.selectedLiveLot;
  const packableItems = getPackableLiveLotItems();
  const totalQty = packableItems.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
  const sessionStatus = lot.session?.status ? ` - ${lot.session.status}` : "";
  const sourceCount = new Set(packableItems.map((entry) => entry.source_location_id).filter(Boolean)).size;
  panel.className = `live-lot-panel is-loaded${global ? " is-global" : ""}`;
  if (global && $("bag-lookup-status")) {
    $("bag-lookup-status").textContent = `Auction ${lot.auction_number || "-"}`;
  }
  panel.innerHTML = `
    <div class="live-lot-head">
      <div>
        <strong>Auction ${escapeHtml(lot.auction_number || "-")}</strong>
        <small>Bag ${escapeHtml(lot.lot_code || "-")} - ${escapeHtml(lot.session?.session_code || "No session")}${escapeHtml(sessionStatus)} - Started ${escapeHtml(formatDate(lot.session?.started_at))}</small>
      </div>
      <span class="live-lot-badge">${packableItems.length} type(s) / ${totalQty} unit(s)${sourceCount ? ` / ${sourceCount} source(s)` : ""}</span>
    </div>
    <div class="live-lot-items">
      ${packableItems.length ? packableItems.map((entry) => {
        const item = entry.item || {};
        const loc = entry.source_location || {};
        const sourceKind = getSourceKindLabel(loc);
        return `
          <article class="live-lot-item" data-live-lot-item="${escapeHtml(entry.id)}">
            <div class="live-lot-thumb"><span>No photo</span></div>
            <div>
              <strong>${escapeHtml(item.title || "Untitled item")}</strong>
              <small><b class="source-kind-badge ${getSourceKindClass(loc)}">${escapeHtml(sourceKind)}</b> ${escapeHtml(item.barcode || "-")} - Qty ${Number(entry.quantity || 1).toLocaleString()} - ${escapeHtml(loc.location_name || "Unknown source")} - minute ${escapeHtml(formatElapsed(entry.show_elapsed_seconds))}</small>
            </div>
            <b>Ready</b>
          </article>
        `;
      }).join("") : `<div class="empty-state">This bag has no currently reserved items to pack. Released corrections are kept only in the audit trail.</div>`}
    </div>
  `;

  packableItems.forEach((entry) => {
    const card = panel.querySelector(`[data-live-lot-item="${CSS.escape(entry.id)}"]`);
    const item = entry.item || {};
    resolvePhotoUrl(firstItemPhoto(item)).then((url) => {
      if (!url || !card?.isConnected) return;
      const thumb = card.querySelector(".live-lot-thumb");
      if (thumb) thumb.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Live-sale item")}" />`;
    });
  });
}

function renderLiveLotPanel() {
  renderLiveLotPanelInto($("live-lot-panel"));
  renderLiveLotPanelInto($("bag-lookup-live-lot-panel"), { global: true });
}

async function bumpInventoryVersion(changedIds = []) {
  const payload = {
    inventory_version: crypto.randomUUID(),
    changed_item_ids: Array.isArray(changedIds) && changedIds.length ? changedIds : null,
  };
  const { error } = await supabase.from("metadata").update(payload).eq("id", "inventory");
  if (error) console.warn("Failed to bump inventory version:", error);
}

function stageCurrentLine({ autoAdvance = false, autoReview = false } = {}) {
  clearQuantityAutoStage();
  const line = state.selectedLine;
  const item = state.selectedItem;
  const row = state.selectedStockRow;
  const qty = Math.max(1, parseInt($("fulfill-quantity")?.value || "1", 10) || 1);
  const remainingLineQty = getRemainingLineQuantity(line);

  if (!line) return setStatus("Select an eBay order first.", "error");
  if (!state.checkoutStoreId) return setStatus("Select the checkout store first.", "error");
  if (!item) return setStatus("Scan or select the inventory item first.", "error");
  if (!row) return setStatus("Scan or select the source tray.", "error");
  if (!row.isTray || row.store_id !== state.checkoutStoreId || row.tray_status === "checked_out") {
    return setStatus("The selected source must be a checked-in tray in the checkout store.", "error");
  }
  if (remainingLineQty <= 0) return setStatus("This eBay line is already fulfilled.", "error");
  if (qty > remainingLineQty) return setStatus(`Only ${remainingLineQty} unit(s) remain on that eBay line.`, "error");
  if (qty > Number(row.quantity || 0)) return setStatus(`Only ${row.quantity} available at that source.`, "error");

  state.stagedFulfillments.set(line.id, {
    line,
    item,
    row,
    qty,
    soldPrice: isAdminUser() ? parseMoney($("fulfill-sold-price")?.value) || null : null,
    payout: null,
  });

  renderOrders();
  renderBuyerBundlePanel();
  renderSelectionSummary();

  const nextLine = getNextPackableLine(getBuyerKey(line), line.id);
  if (autoAdvance && nextLine) {
    selectOrderLine(nextLine.id);
    setStatus("Item staged. Scan the next item for this buyer.");
    return;
  }

  setStatus(nextLine ? "Item staged. Choose the next line or confirm the packed bundle." : "All available lines for this buyer are staged. Confirm the packed bundle.");
  if (autoReview && !nextLine) {
    setTimeout(() => openBundleReviewModal(), 120);
    return;
  }
  setTimeout(() => (nextLine ? $("item-scan") : $("fulfill-order"))?.focus(), 80);
}

function getActiveStagedFulfillments() {
  return [...state.stagedFulfillments.values()].filter((entry) =>
    !state.activeBuyerKey || getBuyerKey(entry.line) === state.activeBuyerKey
  );
}

function closeBundleReviewModal(options = {}) {
  closeModal("bundle-review-modal");
  returnToOrdersAfterMobileModalClose(options);
  setTimeout(() => $("fulfill-order")?.focus(), 80);
}

function closeAdminOrderCloseoutModal(options = {}) {
  state.adminCloseoutAction = "";
  closeModal("admin-order-closeout-modal");
  returnToOrdersAfterMobileModalClose(options);
}

function describeGeolocationError(error) {
  if (!error) return "GPS failed";
  if (error.code === 1) return "GPS permission denied";
  if (error.code === 2) return "GPS unavailable";
  if (error.code === 3) return "GPS timed out";
  return error.message || "GPS failed";
}

function captureAuditLocation() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) {
      resolve({ status: "unavailable", message: "GPS is not available in this browser." });
      return;
    }

    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          status: "captured",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy_meters: position.coords.accuracy,
          captured_at: new Date(position.timestamp || Date.now()).toISOString(),
        });
      },
      (error) => {
        resolve({
          status: error?.code === 1 ? "denied" : error?.code === 3 ? "timeout" : "failed",
          message: describeGeolocationError(error),
        });
      },
      {
        enableHighAccuracy: true,
        timeout: 8000,
        maximumAge: 0,
      }
    );
  });
}

function delayNoInventoryCapture(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPreferredNoInventoryCaptureStationHints() {
  try {
    return {
      stationId: String(window.OG_CAPTURE_STATION_ID || localStorage.getItem("og.captureStationId") || "").trim(),
      stationName: String(window.OG_CAPTURE_STATION_NAME || localStorage.getItem("og.captureStationName") || "").trim(),
    };
  } catch (_) {
    return { stationId: "", stationName: "" };
  }
}

function renderNoInventoryCaptureStations() {
  const selects = [
    $("no-inventory-capture-station"),
    $("worker-cancel-capture-station"),
    $("order-task-capture-station"),
  ].filter(Boolean);
  if (!selects.length) return;
  const stations = state.noInventoryCaptureStations;

  if (!stations.length) {
    selects.forEach((select) => {
      select.innerHTML = '<option value="">No active stations</option>';
      select.disabled = true;
    });
    return;
  }

  selects.forEach((select) => {
    select.replaceChildren(new Option("Choose station", ""));
    stations.forEach((station) => {
      select.appendChild(new Option(station.name || station.id, station.id));
    });
    select.value = stations.some((station) => station.id === state.selectedNoInventoryCaptureStationId)
      ? state.selectedNoInventoryCaptureStationId
      : "";
    select.disabled = false;
  });
}

function setSelectedNoInventoryCaptureStation(stationId = "") {
  const station = state.noInventoryCaptureStations.find((entry) => entry.id === stationId) || null;
  state.selectedNoInventoryCaptureStationId = station?.id || "";

  const select = $("no-inventory-capture-station");
  if (select && select.value !== state.selectedNoInventoryCaptureStationId) {
    select.value = state.selectedNoInventoryCaptureStationId;
  }
  const cancelSelect = $("worker-cancel-capture-station");
  if (cancelSelect && cancelSelect.value !== state.selectedNoInventoryCaptureStationId) {
    cancelSelect.value = state.selectedNoInventoryCaptureStationId;
  }
  const taskSelect = $("order-task-capture-station");
  if (taskSelect && taskSelect.value !== state.selectedNoInventoryCaptureStationId) {
    taskSelect.value = state.selectedNoInventoryCaptureStationId;
  }

  try {
    if (station) {
      localStorage.setItem("og.captureStationId", station.id);
      localStorage.setItem("og.captureStationName", station.name || "");
    }
  } catch (_) {}

  return station;
}

async function loadNoInventoryCaptureStations({ silent = false } = {}) {
  const select = $("no-inventory-capture-station");
  if (select) {
    select.disabled = true;
    select.innerHTML = '<option value="">Loading stations...</option>';
  }

  const { data, error } = await supabase
    .from(NO_INVENTORY_CAPTURE_STATION_TABLE)
    .select("id, name, active")
    .eq("active", true)
    .order("name", { ascending: true });

  if (error) throw new Error(error.message || "Could not load capture stations.");

  state.noInventoryCaptureStations = Array.isArray(data) ? data : [];
  const { stationId, stationName } = getPreferredNoInventoryCaptureStationHints();
  const nextStation = state.noInventoryCaptureStations.find((station) => station.id === state.selectedNoInventoryCaptureStationId)
    || state.noInventoryCaptureStations.find((station) => station.id === stationId)
    || state.noInventoryCaptureStations.find((station) => String(station.name || "").trim().toLowerCase() === stationName.toLowerCase())
    || state.noInventoryCaptureStations[0]
    || null;

  setSelectedNoInventoryCaptureStation(nextStation?.id || "");
  renderNoInventoryCaptureStations();

  if (!silent) {
    setNoInventoryPhotoStatus(nextStation ? `Ready to take evidence photos on ${nextStation.name || "selected station"}.` : "No active capture stations are available.", nextStation ? "info" : "error");
  }

  return state.noInventoryCaptureStations;
}

function getSelectedNoInventoryCaptureStation() {
  return state.noInventoryCaptureStations.find((station) => station.id === state.selectedNoInventoryCaptureStationId) || null;
}

async function createNoInventoryCaptureJob(stationId) {
  const { data, error } = await supabase
    .from(NO_INVENTORY_CAPTURE_JOB_TABLE)
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

function noInventoryCaptureJobHasUpload(job) {
  return Boolean(job?.storage_bucket && job?.storage_path)
    || Boolean(job?.upload_completed_at)
    || Boolean(job?.capture_completed_at && job?.storage_path);
}

async function getNoInventoryCaptureJobPhotoCount(jobId) {
  const { count, error } = await supabase
    .from(NO_INVENTORY_CAPTURE_PHOTO_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("capture_job_id", jobId);

  if (error) {
    console.warn("Could not check capture photo count:", error);
    return 0;
  }
  return count || 0;
}

async function pollNoInventoryCaptureJob(job, station = {}, options = {}) {
  const jobId = job?.id || job;
  const stationName = station.name || "";
  const statusSetter = options.statusSetter || setNoInventoryPhotoStatus;
  const startedAt = Date.now();
  let lastPhotoCount = 0;
  let lastPhotoChangeAt = startedAt;

  while ((Date.now() - startedAt) < NO_INVENTORY_CAPTURE_POLL_TIMEOUT_MS) {
    const { data, error } = await supabase
      .from(NO_INVENTORY_CAPTURE_JOB_TABLE)
      .select("id, station_id, status, storage_bucket, storage_path, capture_completed_at, upload_completed_at, mime_type, file_size_bytes, failure_code, failure_message, requested_at")
      .eq("id", jobId)
      .single();

    if (error || !data) throw new Error(error?.message || "Failed to poll capture job.");
    if (data.status === "completed" || data.status === "failed") return data;

    const photoCount = await getNoInventoryCaptureJobPhotoCount(jobId);
    if (photoCount !== lastPhotoCount) {
      lastPhotoCount = photoCount;
      lastPhotoChangeAt = Date.now();
    }
    if (noInventoryCaptureJobHasUpload(data)) return { ...data, status: "completed" };
    if (photoCount > 0 && (Date.now() - lastPhotoChangeAt) >= NO_INVENTORY_CAPTURE_PHOTO_SETTLE_MS) {
      return { ...data, status: "completed" };
    }

    const label = data.status === "queued"
      ? `Capture queued${stationName ? ` on ${stationName}` : ""}. Waiting for camera...`
      : data.status === "capturing"
        ? `Camera is capturing${stationName ? ` on ${stationName}` : ""}...`
        : data.status === "uploading"
          ? `Camera is uploading${stationName ? ` on ${stationName}` : ""}...`
          : `Capture status: ${data.status || "waiting"}`;
    statusSetter(photoCount > 0 ? `${label} ${photoCount} photo${photoCount === 1 ? "" : "s"} received...` : label, "info");
    await delayNoInventoryCapture(NO_INVENTORY_CAPTURE_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for camera capture.");
}

async function loadNoInventoryCaptureJobPhotos(jobId) {
  const { data, error } = await supabase
    .from(NO_INVENTORY_CAPTURE_PHOTO_TABLE)
    .select("id, capture_job_id, sort_order, is_primary, storage_bucket, storage_path, mime_type, label, created_at")
    .eq("capture_job_id", jobId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(error.message || "Failed to load capture photos.");
  return Array.isArray(data) ? data : [];
}

async function createNoInventorySignedImageUrl(bucket, path, options = {}) {
  if (!bucket || !path) return "";
  try {
    const { data, error } = options.transform
      ? await supabase.storage.from(bucket).createSignedUrl(path, NO_INVENTORY_EVIDENCE_SIGNED_URL_TTL_SECONDS, { transform: options.transform })
      : await supabase.storage.from(bucket).createSignedUrl(path, NO_INVENTORY_EVIDENCE_SIGNED_URL_TTL_SECONDS);
    if (!error && data?.signedUrl) return data.signedUrl;
    if (!options.transform) return "";
  } catch (_) {
    if (!options.transform) return "";
  }
  return createNoInventorySignedImageUrl(bucket, path);
}

async function noInventoryCaptureRowsToEvidencePhotos(rows) {
  const photos = [];
  for (let index = 0; index < (rows || []).length; index += 1) {
    const row = rows[index];
    const bucket = String(row?.storage_bucket || "").trim();
    const path = String(row?.storage_path || "").trim();
    if (!bucket || !path) continue;
    const [previewUrl, thumbnailUrl] = await Promise.all([
      createNoInventorySignedImageUrl(bucket, path),
      createNoInventorySignedImageUrl(bucket, path, { transform: NO_INVENTORY_THUMBNAIL_TRANSFORM }),
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
      label: row.label || `Evidence photo ${index + 1}`,
      mime_type: row.mime_type || "image/jpeg",
      created_at: row.created_at || new Date().toISOString(),
    });
  }
  return photos;
}

function getNoInventoryEvidencePhotoKey(photo) {
  return photo?.localId || `${photo?.bucket || ""}:${photo?.path || ""}`;
}

function getSelectedNoInventoryEvidencePhotos() {
  return state.noInventoryEvidencePhotos.filter((photo) => (
    state.noInventoryEvidencePhotoUploadKeys.has(getNoInventoryEvidencePhotoKey(photo))
  ));
}

function setNoInventoryEvidencePhotoSelected(photoKey, selected) {
  if (!photoKey) return;
  if (selected) state.noInventoryEvidencePhotoUploadKeys.add(photoKey);
  else state.noInventoryEvidencePhotoUploadKeys.delete(photoKey);
  renderNoInventoryEvidencePhotos();
}

function setAllNoInventoryEvidencePhotosSelected(selected) {
  state.noInventoryEvidencePhotoUploadKeys.clear();
  if (selected) {
    state.noInventoryEvidencePhotos.forEach((photo) => {
      state.noInventoryEvidencePhotoUploadKeys.add(getNoInventoryEvidencePhotoKey(photo));
    });
  }
  renderNoInventoryEvidencePhotos();
}

function setNoInventoryPhotoStatus(message = "", type = "info") {
  const el = $("no-inventory-photo-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
}

function setWorkerCancelPhotoStatus(message = "", type = "info") {
  const el = $("worker-cancel-photo-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
}

function safeNoInventoryEvidenceSegment(value, fallback = "evidence") {
  const cleaned = String(value || "")
    .trim()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return cleaned || fallback;
}

function getNoInventoryEvidenceFileExtension(photo, blob) {
  const source = `${photo?.path || ""} ${photo?.mime_type || ""} ${blob?.type || ""}`.toLowerCase();
  if (source.includes("png")) return "png";
  if (source.includes("webp")) return "webp";
  if (source.includes("heic")) return "heic";
  if (source.includes("heif")) return "heif";
  return "jpg";
}

function getNoInventoryEvidenceSourceLabel() {
  const line = state.selectedLine || {};
  const order = line.order || {};
  return safeNoInventoryEvidenceSegment(
    order.order_number || order.buyer_username || getBuyerLabel(line) || line.id,
    "pending-order"
  );
}

async function getEvidencePhotoBlob(photo, index = 0) {
  if ((typeof File !== "undefined" && photo?.file instanceof File) || (typeof Blob !== "undefined" && photo?.file instanceof Blob)) return photo.file;
  const response = await fetch(photo.previewUrl);
  if (!response.ok) {
    throw new Error(`Could not download evidence photo ${index + 1} before saving.`);
  }
  return response.blob();
}

async function persistNoInventoryEvidencePhotos(selectedLineIds = []) {
  const selectedPhotos = getSelectedNoInventoryEvidencePhotos();
  if (!selectedPhotos.length) return [];

  const dateFolder = new Date().toISOString().slice(0, 10);
  const orderLabel = getNoInventoryEvidenceSourceLabel();
  const selectedSuffix = selectedLineIds.length === 1
    ? safeNoInventoryEvidenceSegment(selectedLineIds[0], "line")
    : `${selectedLineIds.length}-lines`;
  const savedPhotos = [];

  for (let index = 0; index < selectedPhotos.length; index += 1) {
    const photo = selectedPhotos[index];
    const blob = await getEvidencePhotoBlob(photo, index);
    const extension = getNoInventoryEvidenceFileExtension(photo, blob);
    const originalName = safeNoInventoryEvidenceSegment(photo.path.split("/").pop(), `photo-${index + 1}`);
    const destinationPath = [
      "pending-orders",
      dateFolder,
      orderLabel,
      `${Date.now()}-${crypto.randomUUID()}-${selectedSuffix}-${originalName}.${extension}`,
    ].join("/");

    const { error } = await supabase.storage
      .from(NO_INVENTORY_EVIDENCE_BUCKET)
      .upload(destinationPath, blob, {
        contentType: blob.type || photo.mime_type || "image/jpeg",
        upsert: false,
      });

    if (error) {
      throw new Error(error.message || `Could not save evidence photo ${index + 1}.`);
    }

    savedPhotos.push({
      bucket: NO_INVENTORY_EVIDENCE_BUCKET,
      path: destinationPath,
      source_bucket: photo.bucket,
      source_path: photo.path,
      capture_job_id: photo.capture_job_id || null,
      sort_order: index,
      label: photo.label || `Evidence photo ${index + 1}`,
      mime_type: blob.type || photo.mime_type || null,
      created_at: new Date().toISOString(),
    });
  }

  return savedPhotos;
}

function renderNoInventoryEvidencePhotos() {
  const grid = $("no-inventory-photo-grid");
  if (!grid) return;
  const toolbar = document.querySelector(".no-inventory-photo-toolbar");
  toolbar?.classList.toggle("hidden", !state.noInventoryEvidencePhotos.length);
  if (!state.noInventoryEvidencePhotos.length) {
    grid.innerHTML = `<div class="empty-state">No evidence photos added.</div>`;
    updateNoInventoryEvidencePhotoSelectionSummary();
    return;
  }

  grid.innerHTML = state.noInventoryEvidencePhotos.map((photo, index) => `
    <article class="no-inventory-photo-card ${state.noInventoryEvidencePhotoUploadKeys.has(getNoInventoryEvidencePhotoKey(photo)) ? "is-selected" : ""}">
      <label class="no-inventory-photo-select">
        <input
          type="checkbox"
          data-no-inventory-photo-select="${escapeHtml(getNoInventoryEvidencePhotoKey(photo))}"
          ${state.noInventoryEvidencePhotoUploadKeys.has(getNoInventoryEvidencePhotoKey(photo)) ? "checked" : ""}
        />
        <span>Upload</span>
      </label>
      <button type="button" data-no-inventory-photo-index="${index}" title="Open evidence photo">
        <img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl || "")}" alt="${escapeHtml(photo.label || `Evidence photo ${index + 1}`)}" />
        <span>${escapeHtml(photo.label || `Evidence photo ${index + 1}`)}</span>
        ${photo.auditText ? `<small>${escapeHtml(photo.auditText)}</small>` : ""}
      </button>
    </article>
  `).join("");

  grid.querySelectorAll("[data-no-inventory-photo-index]").forEach((button) => {
    button.addEventListener("click", () => {
      openNoInventoryEvidencePhotoViewer(Number(button.dataset.noInventoryPhotoIndex || 0));
    });
  });
  grid.querySelectorAll("[data-no-inventory-photo-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      setNoInventoryEvidencePhotoSelected(checkbox.dataset.noInventoryPhotoSelect, checkbox.checked);
    });
  });
  updateNoInventoryEvidencePhotoSelectionSummary();
}

function updateNoInventoryEvidencePhotoSelectionSummary() {
  const summary = $("no-inventory-photo-selection-summary");
  if (!summary) return;
  const total = state.noInventoryEvidencePhotos.length;
  const selected = getSelectedNoInventoryEvidencePhotos().length;
  summary.textContent = total
    ? `${selected} of ${total} photo${total === 1 ? "" : "s"} selected for upload.`
    : "";
}

function scrollNoInventoryConfirmIntoView() {
  const modal = $("worker-no-inventory-modal");
  const actions = $("worker-no-inventory-actions");
  if (!modal || !actions || modal.classList.contains("hidden")) return;
  actions.scrollIntoView({ behavior: "smooth", block: "end" });
  setTimeout(() => $("confirm-worker-no-inventory")?.focus(), 350);
}

function openNoInventoryEvidencePhotoViewer(index) {
  const photo = state.noInventoryEvidencePhotos[index];
  openEvidencePhotoObjectViewer(photo, "request-no-inventory-photo");
}

function openEvidencePhotoObjectViewer(photo, returnFocusId = "request-no-inventory-photo") {
  if (!photo?.previewUrl) return;

  const image = $("no-inventory-photo-viewer-image");
  const caption = $("no-inventory-photo-viewer-caption");
  state.evidencePhotoViewerZoom = 1;
  state.evidencePhotoViewerPanX = 0;
  state.evidencePhotoViewerPanY = 0;
  state.evidencePhotoViewerPanning = false;
  state.evidencePhotoViewerPanStart = null;
  if (image) {
    image.src = photo.previewUrl;
    image.alt = photo.label || "Evidence photo";
    applyEvidencePhotoViewerTransform();
  }
  if (caption) {
    caption.textContent = [
      photo.label || `Evidence photo ${index + 1}`,
      photo.auditText || "",
      photo.bucket && photo.path ? `${photo.bucket}/${photo.path}` : "",
    ].filter(Boolean).join(" - ");
  }
  openModal("no-inventory-photo-viewer-modal");
  $("no-inventory-photo-viewer-modal")?.setAttribute("data-return-focus-id", returnFocusId || "");
  setTimeout(() => $("dismiss-no-inventory-photo-viewer")?.focus(), 80);
}

function closeNoInventoryEvidencePhotoViewer() {
  const image = $("no-inventory-photo-viewer-image");
  if (image) {
    image.removeAttribute("src");
    image.style.transform = "";
  }
  state.evidencePhotoViewerZoom = 1;
  state.evidencePhotoViewerPanX = 0;
  state.evidencePhotoViewerPanY = 0;
  state.evidencePhotoViewerPanning = false;
  state.evidencePhotoViewerPanStart = null;
  const returnFocusId = $("no-inventory-photo-viewer-modal")?.getAttribute("data-return-focus-id") || "request-no-inventory-photo";
  $("no-inventory-photo-viewer-modal")?.removeAttribute("data-return-focus-id");
  closeModal("no-inventory-photo-viewer-modal");
  setTimeout(() => $(returnFocusId)?.focus(), 80);
}

function setEvidencePhotoViewerZoom(nextZoom) {
  state.evidencePhotoViewerZoom = Math.min(4, Math.max(0.5, Number(nextZoom) || 1));
  if (state.evidencePhotoViewerZoom <= 1) {
    state.evidencePhotoViewerPanX = 0;
    state.evidencePhotoViewerPanY = 0;
  }
  applyEvidencePhotoViewerTransform();
}

function adjustEvidencePhotoViewerZoom(delta) {
  setEvidencePhotoViewerZoom((state.evidencePhotoViewerZoom || 1) + delta);
}

function applyEvidencePhotoViewerTransform() {
  const image = $("no-inventory-photo-viewer-image");
  if (!image) return;
  image.style.transform = `translate(${state.evidencePhotoViewerPanX || 0}px, ${state.evidencePhotoViewerPanY || 0}px) scale(${state.evidencePhotoViewerZoom || 1})`;
}

function resetEvidencePhotoViewerTransform() {
  state.evidencePhotoViewerZoom = 1;
  state.evidencePhotoViewerPanX = 0;
  state.evidencePhotoViewerPanY = 0;
  state.evidencePhotoViewerPanning = false;
  state.evidencePhotoViewerPanStart = null;
  applyEvidencePhotoViewerTransform();
}

function startEvidencePhotoPan(event) {
  if ((state.evidencePhotoViewerZoom || 1) <= 1) return;
  const image = $("no-inventory-photo-viewer-image");
  if (!image?.src) return;
  state.evidencePhotoViewerPanning = true;
  state.evidencePhotoViewerPanStart = {
    pointerId: event.pointerId,
    x: event.clientX,
    y: event.clientY,
    panX: state.evidencePhotoViewerPanX || 0,
    panY: state.evidencePhotoViewerPanY || 0,
  };
  image.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function moveEvidencePhotoPan(event) {
  if (!state.evidencePhotoViewerPanning || !state.evidencePhotoViewerPanStart) return;
  state.evidencePhotoViewerPanX = state.evidencePhotoViewerPanStart.panX + (event.clientX - state.evidencePhotoViewerPanStart.x);
  state.evidencePhotoViewerPanY = state.evidencePhotoViewerPanStart.panY + (event.clientY - state.evidencePhotoViewerPanStart.y);
  applyEvidencePhotoViewerTransform();
  event.preventDefault();
}

function endEvidencePhotoPan(event) {
  if (!state.evidencePhotoViewerPanning) return;
  const image = $("no-inventory-photo-viewer-image");
  image?.releasePointerCapture?.(event.pointerId);
  state.evidencePhotoViewerPanning = false;
  state.evidencePhotoViewerPanStart = null;
}

function getSelectedWorkerCancelEvidencePhotos() {
  return state.workerCancelEvidencePhotos.filter((photo) => (
    state.workerCancelEvidencePhotoUploadKeys.has(getNoInventoryEvidencePhotoKey(photo))
  ));
}

function updateWorkerCancelEvidencePhotoSelectionSummary() {
  const summary = $("worker-cancel-photo-selection-summary");
  if (!summary) return;
  const total = state.workerCancelEvidencePhotos.length;
  const selected = getSelectedWorkerCancelEvidencePhotos().length;
  summary.textContent = total
    ? `${selected} of ${total} photo${total === 1 ? "" : "s"} selected for upload.`
    : "";
}

function renderWorkerCancelEvidencePhotos() {
  const grid = $("worker-cancel-photo-grid");
  if (!grid) return;
  const toolbar = document.querySelector(".worker-cancel-photo-toolbar");
  toolbar?.classList.toggle("hidden", !state.workerCancelEvidencePhotos.length);
  if (!state.workerCancelEvidencePhotos.length) {
    grid.innerHTML = `<div class="empty-state">No cancellation photos added.</div>`;
    updateWorkerCancelEvidencePhotoSelectionSummary();
    return;
  }

  grid.innerHTML = state.workerCancelEvidencePhotos.map((photo, index) => {
    const key = getNoInventoryEvidencePhotoKey(photo);
    const selected = state.workerCancelEvidencePhotoUploadKeys.has(key);
    return `
      <article class="no-inventory-photo-card ${selected ? "is-selected" : ""}">
        <label class="no-inventory-photo-select">
          <input
            type="checkbox"
            data-worker-cancel-photo-select="${escapeHtml(key)}"
            ${selected ? "checked" : ""}
          />
          <span>Upload</span>
        </label>
        <button type="button" data-worker-cancel-photo-index="${index}" title="Open cancellation photo">
          <img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl || "")}" alt="${escapeHtml(photo.label || `Cancellation photo ${index + 1}`)}" />
          <span>${escapeHtml(photo.label || `Cancellation photo ${index + 1}`)}</span>
        </button>
      </article>
    `;
  }).join("");

  grid.querySelectorAll("[data-worker-cancel-photo-index]").forEach((button) => {
    button.addEventListener("click", () => {
      openWorkerCancelEvidencePhotoViewer(Number(button.dataset.workerCancelPhotoIndex || 0));
    });
  });
  grid.querySelectorAll("[data-worker-cancel-photo-select]").forEach((checkbox) => {
    checkbox.addEventListener("change", () => {
      if (checkbox.checked) state.workerCancelEvidencePhotoUploadKeys.add(checkbox.dataset.workerCancelPhotoSelect);
      else state.workerCancelEvidencePhotoUploadKeys.delete(checkbox.dataset.workerCancelPhotoSelect);
      renderWorkerCancelEvidencePhotos();
    });
  });
  updateWorkerCancelEvidencePhotoSelectionSummary();
}

function setAllWorkerCancelEvidencePhotosSelected(selected) {
  state.workerCancelEvidencePhotoUploadKeys.clear();
  if (selected) {
    state.workerCancelEvidencePhotos.forEach((photo) => {
      state.workerCancelEvidencePhotoUploadKeys.add(getNoInventoryEvidencePhotoKey(photo));
    });
  }
  renderWorkerCancelEvidencePhotos();
}

function openWorkerCancelEvidencePhotoViewer(index) {
  const photo = state.workerCancelEvidencePhotos[index];
  if (!photo?.previewUrl) return;
  const image = $("no-inventory-photo-viewer-image");
  const caption = $("no-inventory-photo-viewer-caption");
  state.evidencePhotoViewerZoom = 1;
  if (image) {
    image.src = photo.previewUrl;
    image.alt = photo.label || `Cancellation photo ${index + 1}`;
    image.style.transform = "scale(1)";
  }
  if (caption) {
    caption.textContent = `${photo.label || `Cancellation photo ${index + 1}`} - ${photo.bucket ? `${photo.bucket}/${photo.path}` : photo.path || "local file"}`;
  }
  openModal("no-inventory-photo-viewer-modal");
  setTimeout(() => $("dismiss-no-inventory-photo-viewer")?.focus(), 80);
}

function handleWorkerCancelEvidenceFiles(event) {
  const files = [...(event.target?.files || [])].filter((file) => /^image\//i.test(file.type || ""));
  if (!files.length) {
    setWorkerCancelPhotoStatus("Choose image files to attach.", "error");
    return;
  }
  files.forEach((file, index) => {
    const localId = `local:${crypto.randomUUID()}`;
    const photo = {
      localId,
      file,
      bucket: "",
      path: file.name || `folder-photo-${index + 1}`,
      previewUrl: URL.createObjectURL(file),
      thumbnailUrl: "",
      label: file.name || `Folder photo ${index + 1}`,
      mime_type: file.type || "image/jpeg",
      created_at: new Date().toISOString(),
    };
    photo.thumbnailUrl = photo.previewUrl;
    state.workerCancelEvidencePhotos.push(photo);
    state.workerCancelEvidencePhotoUploadKeys.add(localId);
  });
  renderWorkerCancelEvidencePhotos();
  setWorkerCancelPhotoStatus(`${files.length} folder photo${files.length === 1 ? "" : "s"} added and selected.`, "info");
  if (event.target) event.target.value = "";
}

async function persistWorkerCancelEvidencePhotos(selectedLineIds = []) {
  const selectedPhotos = getSelectedWorkerCancelEvidencePhotos();
  if (!selectedPhotos.length) return [];

  const dateFolder = new Date().toISOString().slice(0, 10);
  const orderLabel = getNoInventoryEvidenceSourceLabel();
  const selectedSuffix = selectedLineIds.length === 1
    ? safeNoInventoryEvidenceSegment(selectedLineIds[0], "line")
    : `${selectedLineIds.length}-lines`;
  const savedPhotos = [];

  for (let index = 0; index < selectedPhotos.length; index += 1) {
    const photo = selectedPhotos[index];
    const blob = await getEvidencePhotoBlob(photo, index);
    const extension = getNoInventoryEvidenceFileExtension(photo, blob);
    const originalName = safeNoInventoryEvidenceSegment(String(photo.path || photo.label || "").split("/").pop(), `cancel-photo-${index + 1}`);
    const destinationPath = [
      "pending-order-cancellations",
      dateFolder,
      orderLabel,
      `${Date.now()}-${crypto.randomUUID()}-${selectedSuffix}-${originalName}.${extension}`,
    ].join("/");

    const { error } = await supabase.storage
      .from(NO_INVENTORY_EVIDENCE_BUCKET)
      .upload(destinationPath, blob, {
        contentType: blob.type || photo.mime_type || "image/jpeg",
        upsert: false,
      });

    if (error) throw new Error(error.message || `Could not save cancellation photo ${index + 1}.`);

    savedPhotos.push({
      bucket: NO_INVENTORY_EVIDENCE_BUCKET,
      path: destinationPath,
      source_bucket: photo.bucket || null,
      source_path: photo.path || null,
      capture_job_id: photo.capture_job_id || null,
      sort_order: index,
      label: photo.label || `Cancellation photo ${index + 1}`,
      mime_type: blob.type || photo.mime_type || null,
      size_bytes: blob.size || photo.size_bytes || 0,
      created_at: new Date().toISOString(),
    });
  }

  return savedPhotos;
}

async function requestWorkerCancelEvidencePhoto() {
  if (state.workerCancelCaptureBusy) return;
  try {
    state.workerCancelCaptureBusy = true;
    $("request-worker-cancel-photo")?.toggleAttribute("disabled", true);

    if (!state.noInventoryCaptureStations.length) {
      await loadNoInventoryCaptureStations({ silent: true });
    }

    const station = getSelectedNoInventoryCaptureStation();
    if (!station) {
      setWorkerCancelPhotoStatus("Choose a camera station before taking cancellation photos.", "error");
      $("worker-cancel-capture-station")?.focus();
      return;
    }

    setWorkerCancelPhotoStatus(`Sending camera request to ${station.name || "selected station"}...`, "info");
    const job = await createNoInventoryCaptureJob(station.id);

    window.dispatchEvent(new CustomEvent("assisted:iphone-capture-requested", {
      detail: {
        source: "pending-order-cancelled",
        stationId: station.id,
        stationName: station.name || "",
        jobId: job.id,
        orderLineIds: [...state.workerCancelLineIds],
      },
    }));

    const completedJob = await pollNoInventoryCaptureJob(job, station, { statusSetter: setWorkerCancelPhotoStatus });
    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || "Camera capture failed.");
    }

    let photoRows = await loadNoInventoryCaptureJobPhotos(completedJob.id);
    if (!photoRows.length && completedJob.storage_bucket && completedJob.storage_path) {
      photoRows = [{
        id: completedJob.id,
        capture_job_id: completedJob.id,
        storage_bucket: completedJob.storage_bucket,
        storage_path: completedJob.storage_path,
        mime_type: completedJob.mime_type || "image/jpeg",
        label: "Cancellation photo",
        created_at: completedJob.capture_completed_at || completedJob.upload_completed_at || new Date().toISOString(),
      }];
    }
    if (!photoRows.length) throw new Error("Camera finished but no photos were attached.");

    const photos = await noInventoryCaptureRowsToEvidencePhotos(photoRows);
    const existing = new Set(state.workerCancelEvidencePhotos.map((photo) => `${photo.bucket}:${photo.path}`));
    photos.forEach((photo) => {
      const key = getNoInventoryEvidencePhotoKey(photo);
      if (!existing.has(`${photo.bucket}:${photo.path}`)) {
        state.workerCancelEvidencePhotos.push(photo);
        state.workerCancelEvidencePhotoUploadKeys.add(key);
      }
    });
    renderWorkerCancelEvidencePhotos();
    setWorkerCancelPhotoStatus(`${photos.length} cancellation photo${photos.length === 1 ? "" : "s"} added and selected.`, "info");
  } catch (error) {
    console.error("Cancellation evidence photo capture failed:", error);
    setWorkerCancelPhotoStatus(error?.message || "Could not take cancellation photo.", "error");
  } finally {
    state.workerCancelCaptureBusy = false;
    $("request-worker-cancel-photo")?.toggleAttribute("disabled", false);
  }
}

async function requestNoInventoryEvidencePhoto() {
  if (state.noInventoryCaptureBusy) return;
  try {
    state.noInventoryCaptureBusy = true;
    $("request-no-inventory-photo")?.toggleAttribute("disabled", true);

    if (!state.noInventoryCaptureStations.length) {
      await loadNoInventoryCaptureStations({ silent: true });
    }

    const station = getSelectedNoInventoryCaptureStation();
    if (!station) {
      setNoInventoryPhotoStatus("Choose a camera station before taking evidence photos.", "error");
      $("no-inventory-capture-station")?.focus();
      return;
    }

    setNoInventoryPhotoStatus(`Sending camera request to ${station.name || "selected station"}...`, "info");
    const job = await createNoInventoryCaptureJob(station.id);

    window.dispatchEvent(new CustomEvent("assisted:iphone-capture-requested", {
      detail: {
        source: "pending-order-no-inventory",
        stationId: station.id,
        stationName: station.name || "",
        jobId: job.id,
        orderLineIds: [...state.workerNoInventoryLineIds],
      },
    }));

    const completedJob = await pollNoInventoryCaptureJob(job, station);
    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || completedJob.failure_code || "Capture failed.");
    }

    let photoRows = await loadNoInventoryCaptureJobPhotos(completedJob.id);
    if (!photoRows.length && completedJob.storage_bucket && completedJob.storage_path) {
      photoRows = [{
        capture_job_id: completedJob.id,
        storage_bucket: completedJob.storage_bucket,
        storage_path: completedJob.storage_path,
        label: "Evidence photo",
      }];
    }
    if (!photoRows.length) throw new Error("Camera completed, but no uploaded photos were returned.");

    const photos = await noInventoryCaptureRowsToEvidencePhotos(photoRows);
    const existing = new Set(state.noInventoryEvidencePhotos.map((photo) => `${photo.bucket}:${photo.path}`));
    photos.forEach((photo) => {
      const key = getNoInventoryEvidencePhotoKey(photo);
      if (!existing.has(key)) {
        state.noInventoryEvidencePhotos.push(photo);
        state.noInventoryEvidencePhotoUploadKeys.add(key);
      }
    });
    renderNoInventoryEvidencePhotos();
    setNoInventoryPhotoStatus(`${photos.length} evidence photo${photos.length === 1 ? "" : "s"} added and selected for upload.`, "info");
    scrollNoInventoryConfirmIntoView();
  } catch (error) {
    console.error("No-inventory evidence capture failed:", error);
    setNoInventoryPhotoStatus(error?.message || "Could not take evidence photo.", "error");
  } finally {
    state.noInventoryCaptureBusy = false;
    $("request-no-inventory-photo")?.toggleAttribute("disabled", false);
  }
}

function setWorkerNoInventoryGpsStatus(message, tone = "warn") {
  const el = $("worker-no-inventory-gps");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-good", tone === "good");
  el.classList.toggle("is-warn", tone !== "good");
}

function closeWorkerNoInventoryModal(options = {}) {
  if (!options.suppressEbayReturn) {
    postEbayLabelExitReturnToQueue();
  }
  state.workerNoInventoryGps = null;
  state.workerNoInventoryCandidates = [];
  state.workerNoInventoryLineIds.clear();
  state.noInventoryEvidencePhotos = [];
  state.noInventoryEvidencePhotoUploadKeys.clear();
  closeModal("worker-no-inventory-modal");
  returnToOrdersAfterMobileModalClose(options);
  setTimeout(() => $("complete-no-inventory")?.focus(), 80);
}

function updateWorkerNoInventorySelectionSummary() {
  const selected = state.workerNoInventoryLineIds.size;
  const selectedQueueTotal = getBuyerLines(getBuyerKey(state.selectedLine)).filter(isNoInventoryCompletionLine).length;
  const total = Math.max(state.workerNoInventoryCandidates.length, selectedQueueTotal, state.ebayLaunchTotalCount || 0);
  const count = $("worker-no-inventory-count");
  if (count) count.textContent = `${selected} of ${total} selected`;
  $("confirm-worker-no-inventory")?.toggleAttribute("disabled", selected === 0);
}

function setWorkerNoInventoryLineSelection(lineId, checked) {
  if (checked) state.workerNoInventoryLineIds.add(lineId);
  else state.workerNoInventoryLineIds.delete(lineId);
  renderWorkerNoInventoryList();
}

function setAllWorkerNoInventoryLines(checked) {
  state.workerNoInventoryLineIds.clear();
  if (checked) {
    state.workerNoInventoryCandidates.forEach((line) => state.workerNoInventoryLineIds.add(line.id));
  }
  renderWorkerNoInventoryList();
}

function renderWorkerNoInventoryList() {
  const list = $("worker-no-inventory-list");
  if (!list) return;
  const storeName = getCheckoutStoreName() || "No checkout store selected";
  if (!state.workerNoInventoryCandidates.length) {
    list.innerHTML = `<div class="empty-state">No untouched pending lines are available for this buyer.</div>`;
    updateWorkerNoInventorySelectionSummary();
    return;
  }

  list.innerHTML = state.workerNoInventoryCandidates.map((line) => {
    const order = line?.order || {};
    const selected = state.workerNoInventoryLineIds.has(line.id);
    const receiptLink = getOrderVideoReceiptLink(line);
    const receiptEvidence = state.videoReceiptEvidenceByLineId.get(line.id);
    return `
      <article class="bundle-review-item no-inventory-line ${selected ? "is-selected" : ""}" data-no-inventory-card="${escapeHtml(line.id)}">
        <label class="no-inventory-check" aria-label="Select this order line">
          <input type="checkbox" data-no-inventory-line="${escapeHtml(line.id)}" ${selected ? "checked" : ""} />
        </label>
        <div class="bundle-review-copy">
          <div class="no-inventory-line-head">
            <strong>${escapeHtml(line?.item_title || "Untitled eBay item")}</strong>
            <span>${escapeHtml(order.order_number || "No order")} - ${escapeHtml(order.buyer_username || "No buyer")}</span>
          </div>
          <small>Qty ${Number(getRemainingLineQuantity(line) || line?.quantity || 1).toLocaleString()} - ${escapeHtml(storeName)} - no stock row will be removed</small>
          ${receiptLink.url || receiptLink.orderNumber ? `<a class="buyer-line-receipt no-inventory-video-receipt" href="${escapeHtml(receiptLink.url || "#")}" target="_blank" rel="noopener" title="${escapeHtml(receiptLink.title)}">Video receipt</a>` : ""}
          <div class="no-inventory-video-receipt-evidence" data-no-inventory-video-evidence="${escapeHtml(line.id)}">
          ${receiptEvidence?.thumbnailUrl || receiptEvidence?.previewUrl ? `
            <button type="button" class="video-receipt-evidence-thumb" data-video-receipt-evidence-line="${escapeHtml(line.id)}" title="Open video receipt screenshot">
              <img src="${escapeHtml(receiptEvidence.thumbnailUrl || receiptEvidence.previewUrl)}" alt="${escapeHtml(receiptEvidence.label || "Video receipt screenshot")}" />
              <span>${escapeHtml(receiptEvidence.auditText || "Video receipt screenshot")}</span>
            </button>
          ` : ""}
          </div>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-no-inventory-line]").forEach((checkbox) => {
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", (event) => {
      setWorkerNoInventoryLineSelection(event.currentTarget.dataset.noInventoryLine, event.currentTarget.checked);
    });
  });
  list.querySelectorAll("[data-no-inventory-card]").forEach((card) => {
    card.addEventListener("click", () => {
      const lineId = card.dataset.noInventoryCard;
      setWorkerNoInventoryLineSelection(lineId, !state.workerNoInventoryLineIds.has(lineId));
    });
  });
  list.querySelectorAll(".no-inventory-video-receipt").forEach((link) => {
    link.addEventListener("click", (event) => {
      event.stopPropagation();
      const card = event.currentTarget.closest("[data-no-inventory-card]");
      const line = state.workerNoInventoryCandidates.find((entry) => entry.id === card?.dataset.noInventoryCard);
      openVideoReceiptLink(event, getOrderVideoReceiptLink(line || {}));
    });
  });
  list.querySelectorAll("[data-video-receipt-evidence-line]").forEach((button) => {
    button.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const photo = state.videoReceiptEvidenceByLineId.get(button.dataset.videoReceiptEvidenceLine);
      if (photo) openEvidencePhotoObjectViewer(photo, "confirm-worker-no-inventory");
    });
  });
  hydrateNoInventoryVideoReceiptEvidenceThumbnails();
  updateWorkerNoInventorySelectionSummary();
}

async function hydrateNoInventoryVideoReceiptEvidenceThumbnails() {
  const containers = [...document.querySelectorAll("[data-no-inventory-video-evidence]")];
  await ensureNoInventoryVideoReceiptTasksLoaded().catch((error) => {
    console.warn("Could not load all no-inventory video receipt task photos:", error);
  });
  await Promise.all(containers.map(async (container) => {
    const line = state.workerNoInventoryCandidates.find((entry) => entry.id === container.dataset.noInventoryVideoEvidence);
    if (!line?.id) return;
    const photos = getVideoReceiptEvidencePhotosForLine(line);
    if (!photos.length) {
      container.innerHTML = "";
      return;
    }
    const hydrated = await Promise.all(photos.map((photo) => ensureEvidencePhotoPreviewUrls(photo).catch(() => photo)));
    container.innerHTML = hydrated.map((photo, index) => {
      const actor = photo.signed_by_email || getVideoReceiptAuditActor();
      const capturedAt = photo.created_at || photo.metadata?.capturedAt || "";
      const auditText = photo.auditText || `Captured by ${actor}${capturedAt ? ` on ${formatDate(capturedAt)}` : ""}`;
      return `
        <button type="button" class="video-receipt-evidence-thumb" data-no-inventory-video-photo="${index}" title="Open video receipt screenshot">
          ${photo.thumbnailUrl || photo.previewUrl ? `<img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl)}" alt="${escapeHtml(photo.label || "Video receipt screenshot")}" />` : ""}
          <span>${escapeHtml(auditText)}</span>
        </button>
      `;
    }).join("");
    container.querySelectorAll("[data-no-inventory-video-photo]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const photo = hydrated[Number(button.dataset.noInventoryVideoPhoto || 0)];
        if (!photo?.previewUrl) return;
        openEvidencePhotoObjectViewer({
          ...photo,
          auditText: photo.auditText || `Captured by ${photo.signed_by_email || getVideoReceiptAuditActor()}${photo.created_at ? ` on ${formatDate(photo.created_at)}` : ""}`,
        }, "confirm-worker-no-inventory");
      });
    });
  }));
}

async function openWorkerNoInventoryModal(options = {}) {
  const autoRequestPhoto = Boolean(options.autoRequestPhoto);
  const line = state.selectedLine;
  if (!line) {
    setStatus("Select an eBay order first.", "error");
    return;
  }
  if (!requireCheckoutStore()) return;
  if (getRemainingLineQuantity(line) <= 0 || !isOpenOrderLine(line)) {
    setStatus("This eBay line is already closed.", "error");
    return;
  }
  const requestedLineIds = Array.isArray(options.lineIds)
    ? options.lineIds.filter(Boolean)
    : [];
  const candidates = requestedLineIds.length
    ? getBuyerLines(getBuyerKey(line)).filter(isNoInventoryCompletionLine)
    : getNoInventoryCandidateLines(line);
  if (!candidates.length) {
    setStatus("No untouched pending lines for this buyer can be completed without inventory removal.", "error");
    return;
  }

  state.workerNoInventoryGps = null;
  state.workerNoInventoryCandidates = candidates;
  const validRequestedLineIds = requestedLineIds.filter((lineId) => candidates.some((entry) => entry.id === lineId));
  state.workerNoInventoryLineIds = validRequestedLineIds.length
    ? new Set(validRequestedLineIds)
    : state.ebayLaunchOrderNumbers.size
    ? new Set(candidates
      .filter((entry) => state.ebayLaunchOrderNumbers.has(String(entry.order?.order_number || "")))
      .map((entry) => entry.id))
    : new Set(candidates.map((entry) => entry.id));
  state.noInventoryEvidencePhotos = [];
  state.noInventoryEvidencePhotoUploadKeys.clear();
  $("worker-no-inventory-note").value = "";
  $("worker-no-inventory-error").textContent = "";
  setNoInventoryPhotoStatus("");
  $("worker-no-inventory-subtitle").textContent =
    `This closes the selected pending line(s) for ${getBuyerLabel(line)} without removing stock from inventory. Uncheck anything that should stay in the packing queue. It will be signed by your logged-in account at ${getCheckoutStoreName() || "the selected store"}.`;
  renderWorkerNoInventoryList();
  renderEbayLabelPanel();
  renderNoInventoryEvidencePhotos();
  setWorkerNoInventoryGpsStatus("Requesting GPS for the audit trail...", "warn");
  openModal("worker-no-inventory-modal");
  setTimeout(() => (autoRequestPhoto ? $("request-no-inventory-photo") : $("confirm-worker-no-inventory"))?.focus(), 80);

  const stationPromise = loadNoInventoryCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not load no-inventory capture stations:", error);
    setNoInventoryPhotoStatus(error?.message || "Could not load capture stations.", "error");
  });

  if (autoRequestPhoto) {
    stationPromise.then(() => {
      if (!$("worker-no-inventory-modal")?.classList.contains("hidden")) {
        requestNoInventoryEvidencePhoto();
      }
    });
  }

  const gps = await captureAuditLocation();
  state.workerNoInventoryGps = gps;
  if ($("worker-no-inventory-modal")?.classList.contains("hidden")) return;

  if (gps.status === "captured") {
    setWorkerNoInventoryGpsStatus(
      `GPS captured for audit (${Number(gps.accuracy_meters || 0).toFixed(0)} m accuracy).`,
      "good"
    );
  } else {
    setWorkerNoInventoryGpsStatus(
      `${gps.message || "GPS was not captured."} The completion will still be audited with this GPS status.`,
      "warn"
    );
  }
}

async function confirmWorkerNoInventoryCompletion() {
  if (state.busy) return;
  const line = state.selectedLine;
  const errorEl = $("worker-no-inventory-error");
  const confirmButton = $("confirm-worker-no-inventory");
  const note = String($("worker-no-inventory-note")?.value || "").trim();
  const gps = state.workerNoInventoryGps || { status: "not_finished" };
  const validCandidateIds = new Set(state.workerNoInventoryCandidates.map((entry) => entry.id));
  const selectedLineIds = [...state.workerNoInventoryLineIds].filter((lineId) => validCandidateIds.has(lineId));

  if (!line) {
    if (errorEl) errorEl.textContent = "Select an eBay order line first.";
    return;
  }
  if (!requireCheckoutStore()) return;
  if (!selectedLineIds.length) {
    if (errorEl) errorEl.textContent = "Select at least one pending line to complete.";
    return;
  }

  try {
    state.busy = true;
    if (errorEl) errorEl.textContent = "";
    if (confirmButton) confirmButton.disabled = true;
    const currentBuyerKey = state.activeBuyerKey;
    const completedOrderNumbers = [...new Set(selectedLineIds
      .map((lineId) => state.orders.find((entry) => entry.id === lineId)?.order?.order_number)
      .map(normalizeEbayOrderNumber)
      .filter(Boolean))];
    const selectedPhotoCount = getSelectedNoInventoryEvidencePhotos().length;
    setNoInventoryPhotoStatus(
      selectedPhotoCount
        ? "Saving selected evidence photos into the order evidence repository..."
        : state.noInventoryEvidencePhotos.length
          ? "No evidence photos selected for upload; completing without photo proof."
        : "",
      "info"
    );
    const savedEvidencePhotos = await persistNoInventoryEvidencePhotos(selectedLineIds);

    const { data, error } = await supabase.rpc("complete_ebay_order_lines_without_inventory_evidence", {
      _order_line_ids: selectedLineIds,
      _notes: note || null,
      _signed_by_email: state.user.email,
      _checkout_store_id: state.checkoutStoreId || null,
      _gps_latitude: gps.latitude ?? null,
      _gps_longitude: gps.longitude ?? null,
      _gps_accuracy_meters: gps.accuracy_meters ?? null,
      _gps_captured_at: gps.captured_at ?? null,
      _gps_status: gps.status || "not_finished",
      _evidence_photos: savedEvidencePhotos,
    });
    if (error) throw error;

    selectedLineIds.forEach((lineId) => state.stagedFulfillments.delete(lineId));
    state.ebayLabelReturnContext = null;
    closeWorkerNoInventoryModal({ suppressEbayReturn: true, suppressMobileReturn: true });
    setStatus(`${data?.[0]?.updated_lines || selectedLineIds.length} line(s) completed without inventory removal. The audit trail was recorded.`, "info");
    await loadOrders();
    postEbayPendingQueueChanged({
      action: "no_inventory_completion",
      orderNumbers: completedOrderNumbers,
      lineCount: selectedLineIds.length,
      updatedLines: data?.[0]?.updated_lines || selectedLineIds.length,
    });

    const nextBuyerLine = getNextPackableLine(currentBuyerKey);
    if (nextBuyerLine) {
      selectOrderLine(nextBuyerLine.id);
      return;
    }
    clearSelection();
  } catch (error) {
    console.error("Worker no-inventory completion failed:", error);
    if (errorEl) errorEl.textContent = error.message || "Could not complete this order without inventory.";
  } finally {
    state.busy = false;
    if (confirmButton) confirmButton.disabled = false;
  }
}

function updateWorkerCancelOrderSelectionSummary() {
  const count = [...state.workerCancelLineIds].filter((lineId) =>
    state.workerCancelCandidates.some((line) => line.id === lineId)
  ).length;
  const countEl = $("worker-cancel-order-count");
  if (countEl) countEl.textContent = `${count} selected`;
  $("confirm-worker-cancel-order")?.toggleAttribute("disabled", count === 0);
}

function setWorkerCancelOrderLineSelection(lineId, checked) {
  if (checked) state.workerCancelLineIds.add(lineId);
  else state.workerCancelLineIds.delete(lineId);
  renderWorkerCancelOrderList();
}

function setAllWorkerCancelOrderLines(checked) {
  state.workerCancelLineIds = new Set(checked ? state.workerCancelCandidates.map((line) => line.id) : []);
  renderWorkerCancelOrderList();
}

function renderWorkerCancelOrderList() {
  const list = $("worker-cancel-order-list");
  if (!list) return;
  if (!state.workerCancelCandidates.length) {
    list.innerHTML = `<div class="empty-state">No open lines are available to cancel for this order.</div>`;
    updateWorkerCancelOrderSelectionSummary();
    return;
  }

  list.innerHTML = state.workerCancelCandidates.map((line) => {
    const order = line.order || {};
    const selected = state.workerCancelLineIds.has(line.id);
    return `
      <article class="bundle-review-item no-inventory-line ${selected ? "is-selected" : ""}" data-worker-cancel-card="${escapeHtml(line.id)}">
        <label class="no-inventory-check" aria-label="Select canceled line">
          <input type="checkbox" data-worker-cancel-line="${escapeHtml(line.id)}" ${selected ? "checked" : ""} />
        </label>
        <div class="bundle-review-copy">
          <div class="no-inventory-line-head">
            <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
            <span>${escapeHtml(order.order_number || "No order")}</span>
          </div>
          <span>${escapeHtml(order.buyer_username || "No buyer")} - ${escapeHtml(line.item_number || "No item #")}</span>
          <small>Qty ${Number(getRemainingLineQuantity(line) || line.quantity || 1).toLocaleString()} - ${escapeHtml(line.line_status || "pending")}</small>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-worker-cancel-line]").forEach((checkbox) => {
    checkbox.addEventListener("click", (event) => event.stopPropagation());
    checkbox.addEventListener("change", (event) => {
      setWorkerCancelOrderLineSelection(event.currentTarget.dataset.workerCancelLine, event.currentTarget.checked);
    });
  });
  list.querySelectorAll("[data-worker-cancel-card]").forEach((card) => {
    card.addEventListener("click", () => {
      const lineId = card.dataset.workerCancelCard;
      setWorkerCancelOrderLineSelection(lineId, !state.workerCancelLineIds.has(lineId));
    });
  });
  updateWorkerCancelOrderSelectionSummary();
}

function getWorkerCancelSelectedLines() {
  const validCandidateIds = new Set(state.workerCancelCandidates.map((line) => line.id));
  return [...state.workerCancelLineIds]
    .filter((lineId) => validCandidateIds.has(lineId))
    .map((lineId) => state.workerCancelCandidates.find((line) => line.id === lineId))
    .filter(Boolean);
}

function getWorkerCancelPrimaryOrderNumber() {
  const selectedLines = getWorkerCancelSelectedLines();
  const candidateLines = selectedLines.length ? selectedLines : state.workerCancelCandidates;
  return normalizeEbayOrderNumber(candidateLines[0]?.order?.order_number || state.selectedLine?.order?.order_number || "");
}

function buildEbayCancelStartUrl(orderNumber = "") {
  const cleanOrderNumber = normalizeEbayOrderNumber(orderNumber);
  if (!cleanOrderNumber) return "";
  const url = new URL("https://www.ebay.com/cmr/Start");
  url.searchParams.set("omsOrderId", cleanOrderNumber);
  url.searchParams.set("userIntent", "Cancel");
  return url.toString();
}

function openEbayCancelFlowForWorkerModal(options = {}) {
  const orderNumber = getWorkerCancelPrimaryOrderNumber();
  const url = buildEbayCancelStartUrl(orderNumber);
  if (!url) {
    setWorkerCancelPhotoStatus("Could not find a valid eBay order number for this cancellation.", "error");
    return false;
  }
  window.open(url, "_blank", "noopener,noreferrer");
  if (!options.silent) {
    setWorkerCancelPhotoStatus("eBay cancellation opened. Finish eBay's cancel flow, then capture the confirmation proof back into OG.", "info");
  }
  return true;
}

function closeWorkerCancelOrderModal(options = {}) {
  state.workerCancelEvidencePhotos.forEach((photo) => {
    if (photo?.localId && photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
  });
  state.workerCancelCandidates = [];
  state.workerCancelLineIds = new Set();
  state.workerCancelEvidencePhotos = [];
  state.workerCancelEvidencePhotoUploadKeys.clear();
  $("worker-cancel-order-note").value = "";
  $("worker-cancel-order-password").value = "";
  $("worker-cancel-order-error").textContent = "";
  setWorkerCancelPhotoStatus("");
  renderWorkerCancelEvidencePhotos();
  $("worker-cancel-order-modal")?.classList.remove("is-proof-attached");
  closeModal("worker-cancel-order-modal");
  returnToOrdersAfterMobileModalClose(options);
}

function openWorkerCancelOrderModal(options = {}) {
  const line = state.selectedLine;
  if (!line) {
    setStatus("Select an eBay order first.", "error");
    return;
  }
  if (!isOpenOrderLine(line)) {
    setStatus("This eBay line is already closed.", "error");
    return;
  }

  const candidates = getCancelableOrderLines(line);
  if (!candidates.length) {
    setStatus("No open lines are available to cancel for this order.", "error");
    return;
  }

  const order = line.order || {};
  const requestedLineIds = Array.isArray(options.lineIds)
    ? options.lineIds.filter((lineId) => candidates.some((candidate) => candidate.id === lineId))
    : [];
  const initialLineIds = requestedLineIds.length ? requestedLineIds : candidates.map((entry) => entry.id);
  state.workerCancelCandidates = candidates;
  state.workerCancelLineIds = new Set(initialLineIds);
  state.workerCancelEvidencePhotos.forEach((photo) => {
    if (photo?.localId && photo.previewUrl) URL.revokeObjectURL(photo.previewUrl);
  });
  state.workerCancelEvidencePhotos = [];
  state.workerCancelEvidencePhotoUploadKeys.clear();
  $("worker-cancel-order-title").textContent = `Mark ${order.order_number || "this order"} canceled?`;
  $("worker-cancel-order-subtitle").textContent =
    `This closes ${initialLineIds.length} selected open line(s) for ${order.buyer_username || "this buyer"} as canceled. It will be signed by your logged-in account and recorded in Order History.`;
  $("worker-cancel-order-note").value = "";
  $("worker-cancel-order-password").value = "";
  $("worker-cancel-order-error").textContent = "";
  setWorkerCancelPhotoStatus("");
  renderWorkerCancelOrderList();
  renderWorkerCancelEvidencePhotos();
  openModal("worker-cancel-order-modal");
  setTimeout(() => $("worker-cancel-order-note")?.focus(), 80);
  if (options.openEbayCancel) {
    openEbayCancelFlowForWorkerModal({ silent: true });
    setWorkerCancelPhotoStatus("eBay cancellation opened. After eBay confirms it, use the OG proof button on the eBay confirmation page.", "info");
  }

  loadNoInventoryCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not load cancellation capture stations:", error);
    setWorkerCancelPhotoStatus(error?.message || "Could not load capture stations.", "error");
  });
}

function isRpcSchemaCacheMiss(error, functionName) {
  const text = [
    error?.message,
    error?.details,
    error?.hint,
    error?.code,
  ].filter(Boolean).join(" ");
  return Boolean(error)
    && new RegExp(functionName, "i").test(text)
    && /schema cache|could not find|not found|PGRST202/i.test(text);
}

function buildCancellationEvidenceFallbackNote(note, savedEvidencePhotos = []) {
  if (!savedEvidencePhotos.length) return note;
  const evidenceLines = savedEvidencePhotos
    .map((photo, index) => {
      const bucket = photo.bucket || NO_INVENTORY_EVIDENCE_BUCKET;
      const path = photo.path || "";
      return path ? `${index + 1}. ${bucket}/${path}` : "";
    })
    .filter(Boolean);
  if (!evidenceLines.length) return note;
  return [
    note,
    "",
    "Cancellation proof saved in OG evidence storage:",
    ...evidenceLines,
  ].join("\n");
}

async function confirmWorkerCancelOrder() {
  if (state.busy) return;
  const errorEl = $("worker-cancel-order-error");
  const confirmButton = $("confirm-worker-cancel-order");
  const note = String($("worker-cancel-order-note")?.value || "").trim();
  const password = String($("worker-cancel-order-password")?.value || "").trim();
  const validCandidateIds = new Set(state.workerCancelCandidates.map((line) => line.id));
  const selectedLineIds = [...state.workerCancelLineIds].filter((lineId) => validCandidateIds.has(lineId));

  if (!selectedLineIds.length) {
    if (errorEl) errorEl.textContent = "Select at least one pending order line to cancel.";
    return;
  }
  if (!note) {
    if (errorEl) errorEl.textContent = "A note is required.";
    $("worker-cancel-order-note")?.focus();
    return;
  }
  if (!password) {
    if (errorEl) errorEl.textContent = "Password signature is required.";
    $("worker-cancel-order-password")?.focus();
    return;
  }

  try {
    state.busy = true;
    if (errorEl) errorEl.textContent = "";
    if (confirmButton) confirmButton.disabled = true;
    const currentBuyerKey = state.activeBuyerKey;
    const cancelledOrderNumbers = [...new Set(selectedLineIds
      .map((lineId) => state.orders.find((entry) => entry.id === lineId)?.order?.order_number)
      .map(normalizeEbayOrderNumber)
      .filter(Boolean))];

    const valid = await verifyCurrentUserPassword(password);
    if (!valid) throw new Error("Incorrect password. Please try again.");

    const selectedPhotoCount = getSelectedWorkerCancelEvidencePhotos().length;
    setWorkerCancelPhotoStatus(
      selectedPhotoCount
        ? "Saving selected cancellation photos into the order evidence repository..."
        : state.workerCancelEvidencePhotos.length
          ? "No cancellation photos selected for upload; signing cancellation without photo proof."
          : "",
      "info"
    );
    const savedEvidencePhotos = await persistWorkerCancelEvidencePhotos(selectedLineIds);

    const cancellationPayload = {
      _order_line_ids: selectedLineIds,
      _notes: note,
      _signed_by_email: state.user.email,
      _checkout_store_id: state.checkoutStoreId || null,
      _evidence_photos: savedEvidencePhotos,
    };
    let { data, error } = await supabase.rpc("cancel_ebay_order_lines", cancellationPayload);
    const canRetryLegacyCancel =
      isRpcSchemaCacheMiss(error, "cancel_ebay_order_lines");

    if (canRetryLegacyCancel) {
      const legacyPayload = { ...cancellationPayload };
      delete legacyPayload._evidence_photos;
      if (savedEvidencePhotos.length) {
        legacyPayload._notes = buildCancellationEvidenceFallbackNote(note, savedEvidencePhotos);
        setWorkerCancelPhotoStatus(
          "The live database is using the older cancellation RPC. Saving the proof links in the signed note and completing the cancellation.",
          "info"
        );
      }
      ({ data, error } = await supabase.rpc("cancel_ebay_order_lines", legacyPayload));
      if (isRpcSchemaCacheMiss(error, "cancel_ebay_order_lines")) {
        const minimalLegacyPayload = { ...legacyPayload };
        delete minimalLegacyPayload._checkout_store_id;
        ({ data, error } = await supabase.rpc("cancel_ebay_order_lines", minimalLegacyPayload));
      }
    }
    if (error) throw error;

    selectedLineIds.forEach((lineId) => state.stagedFulfillments.delete(lineId));
    closeWorkerCancelOrderModal({ suppressMobileReturn: true });
    setStatus(`${data?.[0]?.updated_lines || selectedLineIds.length} line(s) marked canceled. The signed audit trail was recorded.`, "info");
    await loadOrders();
    postEbayPendingQueueChanged({
      action: "worker_cancelled_order",
      orderNumbers: cancelledOrderNumbers,
      lineCount: selectedLineIds.length,
      updatedLines: data?.[0]?.updated_lines || selectedLineIds.length,
    });

    const nextBuyerLine = getNextPackableLine(currentBuyerKey);
    if (nextBuyerLine) {
      selectOrderLine(nextBuyerLine.id);
      return;
    }
    clearSelection();
  } catch (error) {
    console.error("Worker order cancellation failed:", error);
    if (errorEl) errorEl.textContent = error.message || "Could not mark this order canceled.";
  } finally {
    state.busy = false;
    if (confirmButton) confirmButton.disabled = false;
  }
}

function getAdminCloseoutActionCopy(action) {
  if (action === "cancelled") {
    return {
      title: "Mark selected orders canceled",
      subtitle: "These lines will be removed from the pending queue as canceled. No stock will be removed.",
      notePlaceholder: "Example: Buyer canceled on eBay / order refunded.",
      button: "Sign and Mark Canceled",
    };
  }

  return {
    title: "Confirm packed without stock removal",
    subtitle: "Use this only when the order was shipped but the sold item was not represented in inventory.",
    notePlaceholder: "Example: Item sold and shipped outside inventory records.",
    button: "Sign and Confirm Packed",
  };
}

function renderAdminCloseoutList(lines) {
  const list = $("admin-order-closeout-list");
  if (!list) return;
  list.replaceChildren();

  lines.forEach((line) => {
    const order = line.order || {};
    const card = document.createElement("article");
    card.className = "bundle-review-item";
    card.innerHTML = `
      <div class="bundle-review-thumb"><span>eBay</span></div>
      <div class="bundle-review-copy">
        <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
        <span>${escapeHtml(order.order_number || "No order number")} - ${escapeHtml(order.buyer_username || "No buyer")}</span>
        <small>Qty ${Number(getRemainingLineQuantity(line) || line.quantity || 1).toLocaleString()} - ${escapeHtml(line.line_status || "pending")}</small>
      </div>
    `;
    list.appendChild(card);
  });
}

function openAdminOrderCloseoutModal(action) {
  if (!isAdminUser()) return;
  const lines = getSelectedAdminLines();
  if (!lines.length) {
    setImportStatus("Select at least one pending order line first.", "error");
    return;
  }

  state.adminCloseoutAction = action;
  const copy = getAdminCloseoutActionCopy(action);
  $("admin-order-closeout-title").textContent = copy.title;
  $("admin-order-closeout-subtitle").textContent = `${copy.subtitle} ${lines.length} line(s) selected.`;
  $("admin-order-closeout-note").value = "";
  $("admin-order-closeout-note").placeholder = copy.notePlaceholder;
  $("admin-order-closeout-password").value = "";
  $("admin-order-closeout-error").textContent = "";
  $("confirm-admin-order-closeout").textContent = copy.button;
  renderAdminCloseoutList(lines);
  openModal("admin-order-closeout-modal");
  setTimeout(() => $("admin-order-closeout-note")?.focus(), 80);
}

async function verifyCurrentUserPassword(password) {
  if (!state.user?.email || !password) return false;
  const { error } = await supabase.auth.signInWithPassword({
    email: state.user.email,
    password,
  });
  return !error;
}

async function confirmAdminOrderCloseout() {
  if (!isAdminUser() || state.busy) return;
  const lines = getSelectedAdminLines();
  const note = String($("admin-order-closeout-note")?.value || "").trim();
  const password = String($("admin-order-closeout-password")?.value || "").trim();
  const errorEl = $("admin-order-closeout-error");

  if (!lines.length) {
    if (errorEl) errorEl.textContent = "Select at least one pending order line.";
    return;
  }
  if (!note) {
    if (errorEl) errorEl.textContent = "A note is required.";
    $("admin-order-closeout-note")?.focus();
    return;
  }
  if (!password) {
    if (errorEl) errorEl.textContent = "Password is required.";
    $("admin-order-closeout-password")?.focus();
    return;
  }

  try {
    state.busy = true;
    if (errorEl) errorEl.textContent = "";
    $("confirm-admin-order-closeout").disabled = true;
    const closedOrderNumbers = [...new Set(lines
      .map((line) => line.order?.order_number)
      .map(normalizeEbayOrderNumber)
      .filter(Boolean))];

    const valid = await verifyCurrentUserPassword(password);
    if (!valid) throw new Error("Incorrect password. Please try again.");

    const { data, error } = await supabase.rpc("admin_close_ebay_order_lines", {
      _order_line_ids: lines.map((line) => line.id),
      _action: state.adminCloseoutAction,
      _notes: note,
      _signed_by_email: state.user.email,
    });
    if (error) throw error;

    closeAdminOrderCloseoutModal({ suppressMobileReturn: true });
    clearAdminOrderSelection();
    setImportStatus(`Closed ${data?.[0]?.updated_lines || lines.length} order line(s).`, "success");
    await loadOrders();
    postEbayPendingQueueChanged({
      action: `admin_${state.adminCloseoutAction || "closeout"}`,
      orderNumbers: closedOrderNumbers,
      lineCount: lines.length,
      updatedLines: data?.[0]?.updated_lines || lines.length,
    });
  } catch (error) {
    console.error("Admin order closeout failed:", error);
    if (errorEl) errorEl.textContent = error.message || "Could not close selected orders.";
  } finally {
    state.busy = false;
    $("confirm-admin-order-closeout").disabled = false;
  }
}

async function renderBundleReviewList(staged) {
  const list = $("bundle-review-list");
  if (!list) return;

  list.replaceChildren();
  staged.forEach((entry) => {
    const card = document.createElement("article");
    card.className = "bundle-review-item";
    card.innerHTML = `
      <div class="bundle-review-thumb"><span>No photo</span></div>
      <div class="bundle-review-copy">
        <strong>${escapeHtml(entry.item.title || entry.line.item_title || "Untitled item")}</strong>
        <span>${escapeHtml(entry.item.barcode || entry.line.custom_label || entry.line.item_number || "No barcode")}</span>
        <small>${escapeHtml(entry.row.locationLabel)} - Qty ${Number(entry.qty || 1).toLocaleString()}</small>
      </div>
    `;
    list.appendChild(card);

    resolvePhotoUrl(firstItemPhoto(entry.item)).then((url) => {
      if (!url || !card.isConnected) return;
      const thumb = card.querySelector(".bundle-review-thumb");
      if (thumb) {
        thumb.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(entry.item.title || "Packed item")}" />`;
      }
    });
  });
}

function getActiveLiveLotReservedItems() {
  if (!state.selectedLiveLot) return [];
  return getPackableLiveLotItems();
}

async function renderLiveLotBundleReviewList(items) {
  const list = $("bundle-review-list");
  if (!list) return;
  list.replaceChildren();

  items.forEach((entry) => {
    const item = entry.item || {};
    const loc = entry.source_location || {};
    const sourceKind = getSourceKindLabel(loc);
    const card = document.createElement("article");
    card.className = "bundle-review-item";
    card.innerHTML = `
      <div class="bundle-review-thumb"><span>No photo</span></div>
      <div class="bundle-review-copy">
        <strong>${escapeHtml(item.title || "Untitled live-sale item")}</strong>
        <span>${escapeHtml(item.barcode || "-")} - Qty ${Number(entry.quantity || 1).toLocaleString()}</span>
        <small><b class="source-kind-badge ${getSourceKindClass(loc)}">${escapeHtml(sourceKind)}</b> ${escapeHtml(loc.location_name || "Unknown source")} ${loc.location_code ? `- ${escapeHtml(loc.location_code)}` : ""} - live minute ${escapeHtml(formatElapsed(entry.show_elapsed_seconds))}</small>
      </div>
    `;
    list.appendChild(card);

    resolvePhotoUrl(firstItemPhoto(item)).then((url) => {
      if (!url || !card.isConnected) return;
      const thumb = card.querySelector(".bundle-review-thumb");
      if (thumb) {
        thumb.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Packed live-sale item")}" />`;
      }
    });
  });
}

function openBundleReviewModal() {
  const staged = getActiveStagedFulfillments();
  const liveItems = getActiveLiveLotReservedItems();
  if (!staged.length && !liveItems.length) {
    setStatus("Stage at least one packed item first.", "error");
    return;
  }

  const buyer = state.selectedLine ? getBuyerLabel(state.selectedLine) : "selected buyer";
  if (liveItems.length && !staged.length) {
    const totalQty = liveItems.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
    $("bundle-review-subtitle").textContent = `${buyer} - live-sale bag ${state.selectedLiveLot.lot_code}, auction ${state.selectedLiveLot.auction_number}. ${liveItems.length} item type(s), ${totalQty} unit(s).`;
    renderLiveLotBundleReviewList(liveItems);
  } else {
    const totalQty = staged.reduce((sum, entry) => sum + Number(entry.qty || 0), 0);
    $("bundle-review-subtitle").textContent = `${buyer} - ${staged.length} line(s), ${totalQty} total unit(s). Press Enter to confirm after review.`;
    renderBundleReviewList(staged);
  }
  openModal("bundle-review-modal");
  setTimeout(() => $("confirm-bundle-review")?.focus(), 80);
}

async function fulfillSelectedOrder({ skipReview = false } = {}) {
  if (state.busy) return;
  const notes = String($("fulfill-notes")?.value || "").trim();
  const staged = getActiveStagedFulfillments();
  const liveItems = getActiveLiveLotReservedItems();

  if (!staged.length && !liveItems.length) return setStatus("Stage at least one packed item first.", "error");
  if (!skipReview) {
    openBundleReviewModal();
    return;
  }

  state.busy = true;
  closeModal("bundle-review-modal");
  $("fulfill-order").disabled = true;
  $("stage-current-line").disabled = true;
  setStatus(liveItems.length && !staged.length
    ? `Confirming live-sale bag and removing ${liveItems.length} reserved item type(s)...`
    : `Confirming and removing ${staged.length} packed item(s)...`);

  try {
    const completedLineIds = [...new Set((liveItems.length && !staged.length
      ? [state.selectedLine?.id]
      : staged.map((entry) => entry.line?.id))
      .filter(Boolean))];
    const completedOrderIds = [...new Set((liveItems.length && !staged.length
      ? [state.selectedLine?.order_id]
      : staged.map((entry) => entry.line?.order_id))
      .filter(Boolean))];
    const completedOrderNumbers = [...new Set((liveItems.length && !staged.length
      ? [state.selectedLine?.order?.order_number]
      : staged.map((entry) => entry.line?.order?.order_number))
      .map(normalizeEbayOrderNumber)
      .filter(Boolean))];
    const completedLineCount = liveItems.length && !staged.length ? 1 : staged.length;
    const changedItemIds = [];
    if (liveItems.length && !staged.length) {
      if (!state.selectedLine) throw new Error("Select the eBay order line before confirming the live-sale bag.");
      const { error } = await supabase.rpc("fulfill_ebay_order_line_with_live_lot_for_store", {
        _order_line_id: state.selectedLine.id,
        _lot_id: state.selectedLiveLot.id,
        _notes: notes || null,
        _signed_by_email: state.user.email,
        _checkout_store_id: state.checkoutStoreId,
      });
      if (error) throw error;
      liveItems.forEach((entry) => {
        if (entry.item_id) changedItemIds.push(entry.item_id);
      });
      clearLiveLotSelection({ render: true });
    } else {
      for (const entry of staged) {
        const { error } = await supabase.rpc("fulfill_ebay_order_line_for_store", {
          _order_line_id: entry.line.id,
          _item_id: entry.item.id,
          _stock_location_row_id: entry.row.id,
          _quantity: entry.qty,
          _sold_price: entry.soldPrice,
          _net_payout: entry.payout,
          _notes: notes || null,
          _signed_by_email: state.user.email,
          _checkout_store_id: state.checkoutStoreId,
        });

        if (error) throw error;
        changedItemIds.push(entry.item.id);
      }
    }

    await bumpInventoryVersion([...new Set(changedItemIds)]);
    const completedTaskCount = await completeFulfilledShippingTasksForLines({
      lineIds: completedLineIds,
      orderIds: completedOrderIds,
    });
    state.stagedFulfillments.clear();
    setStatus(completedTaskCount
      ? "Packed bundle confirmed. Shipment task moved to history."
      : "Packed bundle confirmed. Stock was removed and signed.", "info");
    await loadOrders();
    postEbayPendingQueueChanged({
      action: liveItems.length && !staged.length ? "live_lot_fulfillment" : "inventory_fulfillment",
      orderNumbers: completedOrderNumbers,
      lineCount: completedLineCount,
      changedItemCount: [...new Set(changedItemIds)].length,
    });

    const nextBuyerLine = getNextPackableLine(state.activeBuyerKey);
    if (nextBuyerLine) {
      selectOrderLine(nextBuyerLine.id);
      setStatus("Bundle partially done. Next pending item for this buyer is ready.");
      return;
    }

    clearSelection();
  } catch (error) {
    console.error("Pending order fulfillment failed:", error);
    setStatus(error.message || "Could not fulfill this order.", "error");
  } finally {
    state.busy = false;
    $("fulfill-order").disabled = false;
    $("stage-current-line").disabled = false;
  }
}

async function completeFulfilledShippingTasksForLines({ lineIds = [], orderIds = [] } = {}) {
  const fulfilledLineIds = new Set((lineIds || []).filter(Boolean));
  const fulfilledOrderIds = new Set((orderIds || []).filter(Boolean));
  if (!fulfilledLineIds.size && !fulfilledOrderIds.size) return 0;

  const taskMap = new Map();
  const selectFields = "id, order_id, order_line_ids, task_type, status, assigned_to_user_id, assigned_to_email, title";
  const activeStatuses = ["assigned_for_shipping", "in_progress", "waiting_on_worker"];
  const taskTypes = ["pending_shipping", "pending_packaging"];

  const addTasks = (tasks = []) => {
    tasks.forEach((task) => {
      if (task?.id) taskMap.set(task.id, task);
    });
  };

  try {
    if (fulfilledLineIds.size) {
      const { data, error } = await supabase
        .from("ebay_order_tasks")
        .select(selectFields)
        .in("task_type", taskTypes)
        .in("status", activeStatuses)
        .overlaps("order_line_ids", [...fulfilledLineIds]);
      if (error) throw error;
      addTasks(data);
    }

    if (fulfilledOrderIds.size) {
      const { data, error } = await supabase
        .from("ebay_order_tasks")
        .select(selectFields)
        .in("task_type", taskTypes)
        .in("status", activeStatuses)
        .in("order_id", [...fulfilledOrderIds]);
      if (error) throw error;
      addTasks(data);
    }

    const matchingTasks = [...taskMap.values()].filter((task) => {
      if (!isAdminUser() && task.assigned_to_user_id && task.assigned_to_user_id !== state.user?.id) return false;
      const taskLineIds = Array.isArray(task.order_line_ids) ? task.order_line_ids.filter(Boolean) : [];
      if (taskLineIds.length) return taskLineIds.every((lineId) => fulfilledLineIds.has(lineId));
      return Boolean(task.order_id && fulfilledOrderIds.has(task.order_id));
    });

    let completedCount = 0;
    for (const task of matchingTasks) {
      const { error } = await supabase.rpc("respond_ebay_order_coordination_task", {
        _task_id: task.id,
        _note: "Shipment fulfilled from Pending Orders.",
        _assigned_to_user_id: null,
        _status: "shipped_completed",
        _priority: null,
        _photo_attachments: [],
        _signed_by_email: state.user?.email || state.employee?.display_name || "",
        _due_at: null,
      });
      if (error) throw error;
      completedCount += 1;
    }
    return completedCount;
  } catch (error) {
    console.warn("Could not close matching shipment task after fulfillment:", error);
    return 0;
  }
}

function clearSelection() {
  clearItemSearchTimer();
  clearLocationSearchTimer();
  clearQuantityAutoStage();
  state.selectedLine = null;
  state.selectedItem = null;
  state.selectedStockRow = null;
  state.stockRows = [];
  state.activeBuyerKey = "";
  state.stagedFulfillments.clear();
  state.workerNoInventoryGps = null;
  state.workerNoInventoryCandidates = [];
  state.workerNoInventoryLineIds.clear();
  state.noInventoryEvidencePhotos = [];
  state.noInventoryEvidencePhotoUploadKeys.clear();
  renderEbayLabelPanel();
  clearLiveLotSelection({ render: true });
  closeModal("item-confirm-modal");
  closeModal("bundle-review-modal");
  closeModal("worker-no-inventory-modal");
  closeModal("worker-cancel-order-modal");
  closeModal("order-task-modal");
  closeModal("admin-order-closeout-modal");
  document.body.classList.remove("pending-order-detail-open");
  document.body.classList.remove("pending-mobile-sheet-open");
  $("selected-order-empty")?.classList.remove("hidden");
  $("fulfillment-workflow")?.classList.add("hidden");
  renderOrders();
  renderSummaryStrip();
}

function base64ToBlob(base64, mimeType = "application/pdf") {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new Blob([bytes], { type: mimeType || "application/pdf" });
}

function base64ToText(base64) {
  const binary = atob(String(base64 || ""));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return new TextDecoder("utf-8").decode(bytes);
}

function safeStorageSegment(value, fallback = "value") {
  const cleaned = String(value || "")
    .trim()
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 90);
  return cleaned || fallback;
}

function setEbayLabelTransferStatus(message = "", type = "info") {
  const text = message || "Waiting for a label from the eBay extension.";
  const modalSummary = $("worker-no-inventory-label-summary");
  const pageSummary = $("ebay-label-summary");
  const modalError = $("worker-no-inventory-error");
  if (modalSummary) modalSummary.textContent = text;
  if (pageSummary) pageSummary.textContent = text;
  modalError?.classList.toggle("is-error", type === "error");
  if (modalError) {
    modalError.textContent = type === "error" ? text : "";
  }
  setStatus(text, type);
}

function postEbayLabelTransferStatus(payload = {}) {
  window.postMessage({
    type: "OG_EBAY_LABEL_TRANSFER_STATUS",
    payload,
  }, window.location.origin);
}

function setEbayReportTransferStatus(message = "", type = "info") {
  const text = message || "Waiting for an eBay orders report.";
  setImportStatus(text, type);
  setStatus(text, type);
}

function postEbayReportTransferStatus(payload = {}) {
  window.postMessage({
    type: "OG_EBAY_AWAITING_REPORT_TRANSFER_STATUS",
    payload,
  }, window.location.origin);
}

function setVideoReceiptPhotoTransferStatus(message = "", type = "info") {
  const text = message || "Waiting for a video receipt photo.";
  setStatus(text, type);
}

function postVideoReceiptPhotoTransferStatus(payload = {}) {
  window.postMessage({
    type: "OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER_STATUS",
    payload,
  }, window.location.origin);
}

function setEbayCancelProofTransferStatus(message = "", type = "info") {
  const text = message || "Waiting for eBay cancellation proof.";
  setWorkerCancelPhotoStatus(text, type);
  setStatus(text, type);
}

function postEbayCancelProofTransferStatus(payload = {}) {
  window.postMessage({
    type: "OG_EBAY_CANCEL_PROOF_TRANSFER_STATUS",
    payload,
  }, window.location.origin);
}

function postEbayPendingQueueChanged(payload = {}) {
  const orderNumbers = [...new Set((payload.orderNumbers || [])
    .map(normalizeEbayOrderNumber)
    .filter(Boolean))];
  window.postMessage({
    type: "OG_EBAY_PENDING_QUEUE_CHANGED",
    payload: {
      source: "og-pending-orders",
      pageUrl: window.location.href,
      changedAt: new Date().toISOString(),
      ...payload,
      orderNumbers,
    },
  }, window.location.origin);
}

function queueEbayTransfer(queueName, payload) {
  const queue = state[queueName];
  if (!Array.isArray(queue)) return;
  const transferId = payload?.transferId || "";
  if (transferId && queue.some((entry) => entry?.transferId === transferId)) return;
  queue.push(payload);
}

function drainQueuedEbayTransfers(queueName, handler) {
  const queue = state[queueName];
  if (!Array.isArray(queue) || !queue.length) return;
  const queued = [...queue];
  state[queueName] = [];
  queued.forEach((payload) => handler(payload));
}

function markEbayTransferReceiverReady() {
  state.ebayTransferReceiverReady = true;
  drainQueuedEbayTransfers("queuedEbayLabelTransfers", handleEbayLabelTransfer);
  drainQueuedEbayTransfers("queuedEbayReportTransfers", handleEbayAwaitingReportTransfer);
  drainQueuedEbayTransfers("queuedVideoReceiptPhotoTransfers", handleVideoReceiptPhotoTransfer);
  drainQueuedEbayTransfers("queuedEbayCancelProofTransfers", handleEbayCancelProofTransfer);
}

function postEbayLabelExitReturnToQueue(reason = "pending-label-session-exit") {
  const context = state.ebayLabelReturnContext;
  if (!context) return false;
  const orderNumbers = [...new Set([
    context.orderNumber,
    ...(Array.isArray(context.orderNumbers) ? context.orderNumbers : []),
  ].map(normalizeEbayOrderNumber).filter(Boolean))];
  if (context.transferId) {
    postEbayLabelTransferStatus({
      transferId: context.transferId,
      ok: true,
      canceled: true,
      returnToAwaiting: true,
      reason,
      orderNumber: orderNumbers[0] || "",
      orderNumbers,
      message: "OG label session was closed. Returning to eBay awaiting shipments.",
    });
  } else {
    postEbayPendingQueueChanged({
      action: reason,
      orderNumbers,
    });
  }
  state.ebayLabelReturnContext = null;
  return true;
}

function createLabelRouteError(route, message) {
  const error = new Error(message);
  error.route = route;
  return error;
}

function isWorkerNoInventoryModalOpen() {
  return !$("worker-no-inventory-modal")?.classList.contains("hidden");
}

function getMatchingOrderLines(orderNumber) {
  return state.orders.filter((line) => String(line.order?.order_number || "") === orderNumber);
}

async function openPendingNoInventorySessionForLabel(orderNumber) {
  let matchingLines = getMatchingOrderLines(orderNumber);
  if (!matchingLines.length) {
    await loadOrders();
    matchingLines = getMatchingOrderLines(orderNumber);
  }

  const openMatch = matchingLines.find(isOpenOrderLine);
  if (!openMatch) return false;

  state.ebayLaunchOrderNumbers = new Set([orderNumber]);
  state.ebayLaunchBuyerKeys = new Set(matchingLines.map(getBuyerKey).filter(Boolean));
  clearLiveLotSelection({ render: false });
  applyOrderFilters();

  if (state.selectedLine?.id !== openMatch.id) {
    selectOrderLine(openMatch.id);
  } else {
    renderSelectedOrder();
  }

  if (!isWorkerNoInventoryModalOpen()) {
    setTimeout(() => openWorkerNoInventoryModal({ autoRequestPhoto: true }), 250);
  } else {
    renderEbayLabelPanel();
  }
  return true;
}

async function loadEbayOrderForLabel(orderNumber) {
  const { data, error } = await supabase
    .from("ebay_orders")
    .select(`
      id,
      order_number,
      buyer_username,
      status,
      label_status,
      label_storage_bucket,
      label_file_path,
      label_uploaded_at,
      label_metadata
    `)
    .eq("order_number", orderNumber)
    .maybeSingle();

  if (error) throw new Error(error.message || `Could not look up eBay order ${orderNumber}.`);
  return data || null;
}

async function loadEbayOrdersForLabels(orderNumbers = []) {
  const unique = [...new Set(orderNumbers.map(normalizeEbayOrderNumber).filter(Boolean))];
  if (!unique.length) return [];

  const { data, error } = await supabase
    .from("ebay_orders")
    .select(`
      id,
      order_number,
      buyer_username,
      status,
      label_status,
      label_storage_bucket,
      label_file_path,
      label_uploaded_at,
      label_metadata
    `)
    .in("order_number", unique);

  if (error) throw new Error(error.message || "Could not look up the eBay orders for this label.");
  return data || [];
}

async function attachEbayLabelToOrder(transferPayload) {
  const metadata = transferPayload?.metadata || {};
  const label = transferPayload?.label || {};
  const metadataOrderNumbers = [...new Set([
    ...(Array.isArray(metadata.orderIds) ? metadata.orderIds : []),
    ...(Array.isArray(metadata.orderNumbers) ? metadata.orderNumbers : []),
  ].map(normalizeEbayOrderNumber).filter(Boolean))];
  const selectedOrderNumber = normalizeEbayOrderNumber(state.selectedLine?.order?.order_number);
  const metadataOrderNumber = normalizeEbayOrderNumber(metadata.orderId);
  let targetOrderNumbers = metadataOrderNumber ? [metadataOrderNumber] : [];
  if (metadata.source === "ebay-bulk-label-confirmation") {
    if (selectedOrderNumber && (!metadataOrderNumbers.length || metadataOrderNumbers.includes(selectedOrderNumber) || metadataOrderNumber === selectedOrderNumber)) {
      targetOrderNumbers = [selectedOrderNumber];
    } else if (metadataOrderNumbers.length) {
      targetOrderNumbers = metadataOrderNumbers;
    }
  }
  targetOrderNumbers = [...new Set(targetOrderNumbers.map(normalizeEbayOrderNumber).filter(Boolean))];
  if (!targetOrderNumbers.length) throw new Error("The label transfer did not include a usable eBay order number.");
  if (!label.base64) throw new Error("The extension did not send a readable PDF payload.");

  if (selectedOrderNumber && !targetOrderNumbers.includes(selectedOrderNumber)) {
    throw new Error(`This eBay label is for ${targetOrderNumbers.join(", ")}, but the open OG session is ${selectedOrderNumber}. Open the matching OG order/session before sending this label.`);
  }

  let matchingLines = targetOrderNumbers.flatMap(getMatchingOrderLines);
  if (!matchingLines.length) {
    await loadOrders();
    matchingLines = targetOrderNumbers.flatMap(getMatchingOrderLines);
  }

  const directOrders = await loadEbayOrdersForLabels(targetOrderNumbers);
  const directOrderByNumber = new Map(directOrders.map((order) => [order.order_number, order]));
  matchingLines.forEach((line) => {
    if (line.order?.order_number && !directOrderByNumber.has(line.order.order_number)) {
      directOrderByNumber.set(line.order.order_number, line.order);
    }
  });

  const missingOrderNumbers = targetOrderNumbers.filter((orderNumber) => !directOrderByNumber.get(orderNumber)?.id);
  if (missingOrderNumbers.length) {
    throw new Error(`Order ${missingOrderNumbers.join(", ")} ${missingOrderNumbers.length === 1 ? "is" : "are"} not in OG yet. Import the latest eBay order report first, then open the matching order/session and send the label again.`);
  }
  if (!matchingLines.length) {
    throw createLabelRouteError("history", `Order ${targetOrderNumbers.join(", ")} ${targetOrderNumbers.length === 1 ? "is not" : "are not"} in the pending queue. Opening order history to attach the label.`);
  }

  const closedOrderNumbers = targetOrderNumbers.filter((orderNumber) => {
    const lines = matchingLines.filter((line) => line.order?.order_number === orderNumber);
    return lines.length && !lines.some(isOpenOrderLine);
  });
  if (closedOrderNumbers.length) {
    throw createLabelRouteError("history", `Order ${closedOrderNumbers.join(", ")} ${closedOrderNumbers.length === 1 ? "is" : "are"} already closed in the pending queue. Opening order history to attach the label.`);
  }

  const blob = base64ToBlob(label.base64, label.mimeType || "application/pdf");
  const shipmentSegment = safeStorageSegment(metadata.shipmentId || transferPayload.transferId || crypto.randomUUID(), "shipment");
  const destinationPath = targetOrderNumbers.length > 1
    ? [
      "bulk-labels",
      `${safeStorageSegment(metadata.labelId || metadata.shipmentId || transferPayload.transferId || crypto.randomUUID(), "bulk-label")}.pdf`,
    ].join("/")
    : [
      safeStorageSegment(targetOrderNumbers[0], "order"),
      `${shipmentSegment}.pdf`,
    ].join("/");

  const { error: uploadError } = await supabase.storage
    .from(EBAY_LABEL_BUCKET)
    .upload(destinationPath, blob, {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) throw new Error(uploadError.message || "Could not upload the eBay label PDF.");

  const orderIds = [...new Set([
    ...matchingLines.map((line) => line.order_id).filter(Boolean),
    ...targetOrderNumbers.map((orderNumber) => directOrderByNumber.get(orderNumber)?.id).filter(Boolean),
  ].filter(Boolean))];
  const labelMetadata = {
    ...normalizeLabelMetadata(metadata, { orderNumbers: targetOrderNumbers }),
    transferId: transferPayload.transferId || null,
    captureSource: label.source || null,
    labelUrl: label.url || null,
    mimeType: label.mimeType || "application/pdf",
    size: label.size || blob.size,
    capturedAt: label.capturedAt || metadata.capturedAt || new Date().toISOString(),
  };
  const now = new Date().toISOString();

  const { error: orderError } = await supabase.rpc("attach_ebay_shipping_label", {
    _order_ids: orderIds,
    _order_line_ids: matchingLines.map((line) => line.id).filter(Boolean),
    _order_numbers: targetOrderNumbers,
    _shipment_id: metadata.shipmentId || null,
    _label_storage_bucket: EBAY_LABEL_BUCKET,
    _label_file_path: destinationPath,
    _label_metadata: labelMetadata,
    _signed_by_email: state.user?.email || null,
  });
  if (orderError) throw new Error(orderError.message || "Could not update and audit the eBay order label status.");

  matchingLines.forEach((line) => {
    line.label_status = "label_uploaded";
    line.label_storage_bucket = EBAY_LABEL_BUCKET;
    line.label_file_path = destinationPath;
    line.label_uploaded_at = now;
    line.label_metadata = labelMetadata;
    if (line.order) {
      line.order.ebay_shipment_id = metadata.shipmentId || null;
      line.order.label_status = "label_uploaded";
      line.order.label_storage_bucket = EBAY_LABEL_BUCKET;
      line.order.label_file_path = destinationPath;
      line.order.label_uploaded_at = now;
      line.order.label_metadata = labelMetadata;
    }
    line.searchText = normalizeLine(line).searchText;
  });

  if (transferPayload.transferId && window.chrome?.runtime?.sendMessage) {
    chrome.runtime.sendMessage({
      type: "OG_EBAY_CLEAR_PENDING_LABEL",
      transferId: transferPayload.transferId,
    }).catch(() => null);
  }

  const primaryOrderNumber = selectedOrderNumber && targetOrderNumbers.includes(selectedOrderNumber)
    ? selectedOrderNumber
    : targetOrderNumbers[0];
  state.ebayLabelReturnContext = {
    transferId: transferPayload.transferId || "",
    orderNumber: primaryOrderNumber,
    orderNumbers: targetOrderNumbers,
  };
  await openPendingNoInventorySessionForLabel(primaryOrderNumber);
  const trackingText = getLabelTrackingDisplay(labelMetadata);
  const trackingClause = trackingText ? ` Tracker: ${trackingText}.` : " Tracker was not captured.";
  const attachedMessage = matchingLines.length
    ? `Shipping label attached to eBay order${targetOrderNumbers.length === 1 ? "" : "s"} ${targetOrderNumbers.join(", ")}.${trackingClause} Preview it before final confirmation.`
    : `Shipping label attached to eBay order${targetOrderNumbers.length === 1 ? "" : "s"} ${targetOrderNumbers.join(", ")}.${trackingClause} Refresh or open that order to preview it.`;
  setStatus(attachedMessage, "info");
  return {
    orderNumber: primaryOrderNumber,
    orderNumbers: targetOrderNumbers,
    storagePath: destinationPath,
    uploadedAt: now,
    visibleInCurrentQueue: Boolean(matchingLines.length),
  };
}

async function handleEbayLabelTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (!state.ebayTransferReceiverReady) {
    queueEbayTransfer("queuedEbayLabelTransfers", payload);
    return;
  }
  if (transferId && state.handledEbayLabelTransferIds.has(transferId)) return;
  if (state.ebayLabelBusy) return;
  if (transferId) state.handledEbayLabelTransferIds.add(transferId);
  state.ebayLabelBusy = true;
  setEbayLabelTransferStatus("Uploading eBay shipping label to OG...");
  postEbayLabelTransferStatus({
    transferId,
    phase: "started",
    message: "Pending order label receiver accepted the eBay label transfer.",
  });
  try {
    const attached = await attachEbayLabelToOrder(payload);
    const attachedOrders = attached.orderNumbers?.length
      ? attached.orderNumbers.join(", ")
      : attached.orderNumber;
    postEbayLabelTransferStatus({
      transferId,
      ok: true,
      message: `Shipping label attached to eBay order${attached.orderNumbers?.length > 1 ? "s" : ""} ${attachedOrders}.`,
      ...attached,
    });
  } catch (error) {
    console.error("eBay label transfer failed:", error);
    const message = error.message || "Could not attach the eBay label.";
    setEbayLabelTransferStatus(message, "error");
    postEbayLabelTransferStatus(error.route ? {
      transferId,
      ok: false,
      route: error.route,
      message,
    } : {
      transferId,
      ok: false,
      error: message,
    });
  } finally {
    state.ebayLabelBusy = false;
  }
}

async function importAwaitingReportTransfer(payload) {
  const metadata = payload?.metadata || {};
  const report = payload?.report || {};
  if (!report.base64) throw new Error("The extension did not send a readable eBay report file.");

  const text = base64ToText(report.base64);
  return importEbayPendingOrdersReport(text, {
    source: metadata.source || "ebay-awaiting-shipment-report",
    filename: report.filename || metadata.filename || "eBay-OrdersReport.csv",
    capturedAt: report.capturedAt || metadata.capturedAt || new Date().toISOString(),
    reportGeneratedAt: report.capturedAt || metadata.capturedAt || "",
    importTimestamp: new Date().toISOString(),
    pageUrl: metadata.pageUrl || report.url || "",
    visibleSummaryText: metadata.visibleSummaryText || "",
  });
}

async function handleEbayAwaitingReportTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (!state.ebayTransferReceiverReady) {
    queueEbayTransfer("queuedEbayReportTransfers", payload);
    return;
  }
  if (transferId && state.handledEbayReportTransferIds.has(transferId)) return;
  if (state.ebayReportBusy) return;
  if (transferId) state.handledEbayReportTransferIds.add(transferId);
  state.ebayReportBusy = true;
  setEbayReportTransferStatus("Report received. Importing orders...");
  postEbayReportTransferStatus({
    transferId,
    phase: "started",
    message: "Pending Orders accepted the eBay awaiting-shipment report transfer.",
  });

  try {
    if (!canImportOrders()) throw new Error("Your OG user is not allowed to import eBay order reports.");
    const result = await importAwaitingReportTransfer(payload);
    await loadOrders();
    const warningText = result.warnings?.length ? ` Warning: ${result.warnings.join(" ")}` : "";
    const message = `Pending orders updated: ${result.ordersInReport} order(s) in report, ${result.newOrdersAdded} new order(s), ${result.newLinesAdded} new line item(s), ${result.existingOrdersChecked} existing order(s) checked.${warningText}`;
    setEbayReportTransferStatus(message, result.warnings?.length ? "error" : "success");
    showCompletedHistoryConflictsModal(result.completedHistoryConflicts);
    if (transferId && window.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: "OG_EBAY_CLEAR_PENDING_REPORT",
        transferId,
      }).catch(() => null);
    }
    postEbayReportTransferStatus({
      transferId,
      ok: true,
      message,
      ...result,
    });
  } catch (error) {
    console.error("eBay awaiting report transfer failed:", error);
    const message = error.message || "Could not import the eBay awaiting-shipment report.";
    setEbayReportTransferStatus(message, "error");
    postEbayReportTransferStatus({
      transferId,
      ok: false,
      error: message,
    });
  } finally {
    state.ebayReportBusy = false;
  }
}

function getVideoReceiptPhotoLineMatches(metadata = {}) {
  const itemNumber = String(metadata.itemNumber || metadata.selectedItemId || "").trim();
  const transactionId = String(metadata.transactionId || "").trim();
  const orderNumber = normalizeEbayOrderNumber(metadata.orderNumber || metadata.orderId || "");
  if (!itemNumber) return [];

  return state.orders.filter((line) => {
    const order = getOrderFromLine(line);
    if (String(line.item_number || "").trim() !== itemNumber) return false;
    if (transactionId && String(line.transaction_id || "").trim() !== transactionId) return false;
    if (orderNumber && normalizeEbayOrderNumber(order.order_number) !== orderNumber) return false;
    return true;
  });
}

async function findVideoReceiptPhotoLine(metadata = {}) {
  let matches = getVideoReceiptPhotoLineMatches(metadata);
  if (!matches.length) {
    await loadOrders();
    matches = getVideoReceiptPhotoLineMatches(metadata);
  }
  if (!matches.length) return null;
  const openMatch = matches.find(isOpenOrderLine);
  return openMatch || matches[0];
}

function getVideoReceiptScreenshotBlob(screenshot = {}) {
  if (screenshot.base64) return base64ToBlob(screenshot.base64, screenshot.mimeType || "image/png");
  const dataUrl = String(screenshot.dataUrl || "");
  const match = dataUrl.match(/^data:([^;,]+)?;base64,(.+)$/);
  if (!match) throw new Error("The extension did not send a readable video receipt screenshot.");
  return base64ToBlob(match[2], match[1] || screenshot.mimeType || "image/png");
}

function getVideoReceiptAuditActor() {
  return state.user?.email || state.employee?.display_name || "logged-in account";
}

async function addVideoReceiptPhotoToNoInventoryEvidence(line = {}, savedPhoto = {}, metadata = {}, screenshot = {}) {
  if (!savedPhoto.bucket || !savedPhoto.path) return null;
  const capturedAt = screenshot.capturedAt || metadata.capturedAt || savedPhoto.created_at || new Date().toISOString();
  const actor = savedPhoto.signed_by_email || getVideoReceiptAuditActor();
  const [previewUrl, thumbnailUrl] = await Promise.all([
    createNoInventorySignedImageUrl(savedPhoto.bucket, savedPhoto.path),
    createNoInventorySignedImageUrl(savedPhoto.bucket, savedPhoto.path, { transform: NO_INVENTORY_THUMBNAIL_TRANSFORM }),
  ]);
  if (!previewUrl) return null;

  const photo = {
    ...savedPhoto,
    id: savedPhoto.id || `${savedPhoto.bucket}:${savedPhoto.path}`,
    previewUrl,
    thumbnailUrl: thumbnailUrl || previewUrl,
    label: savedPhoto.label || `Video receipt - ${line.item_number || metadata.itemNumber || "item"}`,
    signed_by_email: actor,
    auditText: `Captured by ${actor} on ${formatDate(capturedAt)}`,
    videoReceiptUrl: metadata.videoReceiptUrl || metadata.pageUrl || "",
    created_at: capturedAt,
  };
  if (line.id) state.videoReceiptEvidenceByLineId.set(line.id, photo);
  const key = getNoInventoryEvidencePhotoKey(photo);
  const existingIndex = state.noInventoryEvidencePhotos.findIndex((entry) => getNoInventoryEvidencePhotoKey(entry) === key);
  if (existingIndex >= 0) state.noInventoryEvidencePhotos[existingIndex] = photo;
  else state.noInventoryEvidencePhotos.unshift(photo);
  state.noInventoryEvidencePhotoUploadKeys.add(key);
  renderWorkerNoInventoryList();
  renderNoInventoryEvidencePhotos();
  setNoInventoryPhotoStatus(`Video receipt screenshot added for item ${line.item_number || metadata.itemNumber || "item"}.`, "success");
  return photo;
}

async function rememberVideoReceiptPhotoForQueue(line = {}, savedPhoto = {}, metadata = {}, screenshot = {}) {
  if (!savedPhoto.bucket || !savedPhoto.path || !line?.id) return null;
  const capturedAt = screenshot.capturedAt || metadata.capturedAt || savedPhoto.created_at || new Date().toISOString();
  const actor = savedPhoto.signed_by_email || getVideoReceiptAuditActor();
  const photo = await ensureEvidencePhotoPreviewUrls({
    ...savedPhoto,
    id: savedPhoto.id || `${savedPhoto.bucket}:${savedPhoto.path}`,
    label: savedPhoto.label || `Video receipt - ${line.item_number || metadata.itemNumber || "item"}`,
    signed_by_email: actor,
    auditText: `Captured by ${actor} on ${formatDate(capturedAt)}`,
    videoReceiptUrl: metadata.videoReceiptUrl || metadata.pageUrl || "",
    created_at: capturedAt,
  }).catch(() => ({
    ...savedPhoto,
    id: savedPhoto.id || `${savedPhoto.bucket}:${savedPhoto.path}`,
    signed_by_email: actor,
    auditText: `Captured by ${actor} on ${formatDate(capturedAt)}`,
    created_at: capturedAt,
  }));
  state.videoReceiptEvidenceByLineId.set(line.id, photo);
  return photo;
}

async function showVideoReceiptPhotoInNoInventoryModal(line = {}, savedPhoto = {}, metadata = {}, screenshot = {}) {
  const modalHasLine = () => state.workerNoInventoryCandidates.some((entry) => entry.id === line.id);
  if (!isWorkerNoInventoryModalOpen() || !modalHasLine()) {
    if (state.selectedLine?.id !== line.id) selectOrderLine(line.id);
    await openWorkerNoInventoryModal();
  }

  if (!isWorkerNoInventoryModalOpen() || !modalHasLine()) return;
  state.workerNoInventoryLineIds.add(line.id);
  renderWorkerNoInventoryList();
  await addVideoReceiptPhotoToNoInventoryEvidence(line, savedPhoto, metadata, screenshot);
}

function returnToPendingQueueAfterVideoReceiptCapture(line = {}) {
  if (!$("worker-no-inventory-modal")?.classList.contains("hidden")) {
    closeWorkerNoInventoryModal({ suppressEbayReturn: true, suppressMobileReturn: true });
  }
  if (!$("fulfillment-workflow")?.classList.contains("hidden")) {
    $("fulfillment-workflow")?.classList.add("hidden");
  }
  document.body.classList.remove("pending-order-detail-open");
  document.body.classList.remove("pending-mobile-sheet-open");
  $("selected-order-empty")?.classList.remove("hidden");
  state.selectedLine = null;
  state.activeBuyerKey = "";
  renderOrders();
  window.setTimeout(() => {
    const card = line?.id
      ? [...document.querySelectorAll("[data-line-id]")].find((entry) => entry.dataset.lineId === line.id)
      : null;
    card?.scrollIntoView({ block: "center", behavior: "smooth" });
  }, 80);
}

async function attachVideoReceiptPhotoToPendingLine(payload = {}) {
  const metadata = payload.metadata || {};
  const screenshot = payload.screenshot || {};
  const line = await findVideoReceiptPhotoLine(metadata);
  if (!line?.id || !line.order_id) {
    const itemNumber = metadata.itemNumber || metadata.selectedItemId || "that item";
    throw new Error(`Could not find pending eBay item ${itemNumber} in OG. Import the latest pending orders report, then try the capture again.`);
  }

  const order = getOrderFromLine(line);
  const blob = getVideoReceiptScreenshotBlob(screenshot);
  const dateFolder = new Date().toISOString().slice(0, 10);
  const orderSegment = safeStorageSegment(order.order_number || line.order_id, "order");
  const itemSegment = safeStorageSegment(metadata.itemNumber || line.item_number || line.id, "item");
  const destinationPath = [
    "video-receipts",
    dateFolder,
    orderSegment,
    `${Date.now()}-${crypto.randomUUID()}-${itemSegment}.png`,
  ].join("/");

  const { error: uploadError } = await supabase.storage
    .from(NO_INVENTORY_EVIDENCE_BUCKET)
    .upload(destinationPath, blob, {
      contentType: blob.type || screenshot.mimeType || "image/png",
      upsert: false,
    });
  if (uploadError) throw new Error(uploadError.message || "Could not save the video receipt screenshot.");

  const savedPhoto = {
    bucket: NO_INVENTORY_EVIDENCE_BUCKET,
    path: destinationPath,
    source_bucket: null,
    source_path: metadata.videoReceiptUrl || metadata.pageUrl || null,
    capture_job_id: null,
    sort_order: 0,
    label: `Video receipt - ${line.item_number || "item"}`,
    mime_type: blob.type || screenshot.mimeType || "image/png",
    size_bytes: blob.size || 0,
    created_at: new Date().toISOString(),
    signed_by_email: getVideoReceiptAuditActor(),
    metadata: {
      videoReceiptUrl: metadata.videoReceiptUrl || metadata.pageUrl || "",
      eventId: metadata.eventId || "",
      selectedItemId: metadata.selectedItemId || metadata.itemNumber || "",
      capturedAt: screenshot.capturedAt || metadata.capturedAt || new Date().toISOString(),
      videoRect: screenshot.videoRect || null,
    },
  };

  const question = [
    `Video receipt screenshot captured for eBay item ${line.item_number || metadata.itemNumber || "item"}.`,
    metadata.videoReceiptUrl || metadata.pageUrl ? `Receipt: ${metadata.videoReceiptUrl || metadata.pageUrl}` : "",
  ].filter(Boolean).join("\n");

  const { error: taskError } = await supabase.rpc("create_ebay_order_coordination_task", {
    _order_id: line.order_id,
    _order_line_ids: [line.id],
    _assigned_to_user_id: null,
    _priority: "normal",
    _question: question,
    _due_at: order.ship_by_date || null,
    _photo_attachments: [savedPhoto],
    _signed_by_email: state.user?.email || state.employee?.display_name || "",
  });
  if (taskError) throw new Error(taskError.message || "Could not attach the video receipt photo to the order task.");

  await rememberVideoReceiptPhotoForQueue(line, savedPhoto, metadata, screenshot);

  if (state.selectedLine?.id === line.id || state.selectedLine?.order_id === line.order_id) {
    await loadSelectedOrderTasks();
  }
  returnToPendingQueueAfterVideoReceiptCapture(line);

  return {
    lineId: line.id,
    orderId: line.order_id,
    orderNumber: order.order_number || "",
    itemNumber: line.item_number || metadata.itemNumber || "",
    storagePath: destinationPath,
    photo: savedPhoto,
  };
}

async function handleVideoReceiptPhotoTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (!state.ebayTransferReceiverReady) {
    queueEbayTransfer("queuedVideoReceiptPhotoTransfers", payload);
    return;
  }
  if (transferId && state.handledVideoReceiptPhotoTransferIds.has(transferId)) return;
  if (transferId) state.handledVideoReceiptPhotoTransferIds.add(transferId);
  setVideoReceiptPhotoTransferStatus("Saving video receipt photo to OG...");
  postVideoReceiptPhotoTransferStatus({
    transferId,
    phase: "started",
    message: "Pending Orders accepted the video receipt photo.",
  });

  try {
    const attached = await attachVideoReceiptPhotoToPendingLine(payload);
    const message = `Video receipt photo saved for item ${attached.itemNumber || "item"}.`;
    setVideoReceiptPhotoTransferStatus(message, "success");
    postVideoReceiptPhotoTransferStatus({
      transferId,
      ok: true,
      message,
      ...attached,
    });
  } catch (error) {
    console.error("Video receipt photo transfer failed:", error);
    const message = error.message || "Could not save the video receipt photo.";
    setVideoReceiptPhotoTransferStatus(message, "error");
    postVideoReceiptPhotoTransferStatus({
      transferId,
      ok: false,
      error: message,
    });
  }
}

function getEbayCancelProofLineMatches(metadata = {}) {
  const orderNumber = normalizeEbayOrderNumber(metadata.orderNumber || metadata.orderId || metadata.omsOrderId || "");
  const itemNumber = String(metadata.itemNumber || metadata.itemId || "").trim();
  if (!orderNumber && !itemNumber) return [];

  return state.orders.filter((line) => {
    const order = getOrderFromLine(line);
    if (orderNumber && normalizeEbayOrderNumber(order.order_number) !== orderNumber) return false;
    if (itemNumber && String(line.item_number || "").trim() !== itemNumber) return false;
    return true;
  });
}

async function findEbayCancelProofLine(metadata = {}) {
  let matches = getEbayCancelProofLineMatches(metadata);
  if (!matches.length) {
    await loadOrders();
    matches = getEbayCancelProofLineMatches(metadata);
  }
  if (!matches.length) return null;
  const openMatch = matches.find(isOpenOrderLine);
  return openMatch || matches[0];
}

function createLocalCancelProofPhoto(blob, metadata = {}, screenshot = {}) {
  const capturedAt = screenshot.capturedAt || metadata.capturedAt || new Date().toISOString();
  const orderNumber = normalizeEbayOrderNumber(metadata.orderNumber || metadata.orderId || metadata.omsOrderId || "");
  const cancelId = String(metadata.cancelId || "").trim();
  const localId = `local:${crypto.randomUUID()}`;
  const previewUrl = URL.createObjectURL(blob);
  return {
    localId,
    file: blob,
    bucket: "",
    path: `ebay-cancel-proof-${safeNoInventoryEvidenceSegment(orderNumber || cancelId, "order")}.png`,
    previewUrl,
    thumbnailUrl: previewUrl,
    label: `eBay cancel proof${orderNumber ? ` - ${orderNumber}` : ""}`,
    mime_type: blob.type || screenshot.mimeType || "image/png",
    created_at: capturedAt,
    metadata: {
      source: "ebay-cancel-confirmation",
      orderNumber,
      cancelId,
      cancellationReason: metadata.cancellationReason || "",
      pageUrl: metadata.pageUrl || "",
      pageTitle: metadata.pageTitle || "",
      capturedAt,
    },
  };
}

function applyEbayCancelProofNote(metadata = {}) {
  const noteEl = $("worker-cancel-order-note");
  if (!noteEl || String(noteEl.value || "").trim()) return;
  const orderNumber = normalizeEbayOrderNumber(metadata.orderNumber || metadata.orderId || metadata.omsOrderId || "");
  const parts = [
    "Canceled on eBay.",
    metadata.cancellationReason ? `Reason: ${metadata.cancellationReason}.` : "",
    metadata.cancelId ? `Cancel ID: ${metadata.cancelId}.` : "",
    orderNumber ? `Order: ${orderNumber}.` : "",
  ].filter(Boolean);
  noteEl.value = parts.join(" ");
}

async function attachEbayCancelProofToWorkerModal(payload = {}) {
  const metadata = payload.metadata || {};
  const screenshot = payload.screenshot || {};
  const line = await findEbayCancelProofLine(metadata);
  const orderNumber = normalizeEbayOrderNumber(metadata.orderNumber || metadata.orderId || metadata.omsOrderId || "");
  if (!line?.id) {
    throw new Error(`Could not find eBay order ${orderNumber || "from the cancellation page"} in the pending queue. Import/sync pending orders, then try again.`);
  }

  if (state.selectedLine?.id !== line.id) {
    selectOrderLine(line.id, { openDetail: false });
  }
  openWorkerCancelOrderModal({ lineIds: [line.id], openEbayCancel: false });

  const blob = getVideoReceiptScreenshotBlob(screenshot);
  const photo = createLocalCancelProofPhoto(blob, metadata, screenshot);
  state.workerCancelEvidencePhotos.unshift(photo);
  state.workerCancelEvidencePhotoUploadKeys.add(photo.localId);
  renderWorkerCancelEvidencePhotos();
  applyEbayCancelProofNote(metadata);
  setEbayCancelProofTransferStatus("eBay cancellation proof attached. Add a short note, sign, and mark the order canceled in OG.", "success");
  $("worker-cancel-order-modal")?.classList.add("is-proof-attached");
  window.setTimeout(() => $("worker-cancel-order-note")?.focus(), 120);

  return {
    lineId: line.id,
    orderId: line.order_id || "",
    orderNumber: getOrderFromLine(line).order_number || orderNumber,
    cancelId: metadata.cancelId || "",
  };
}

async function handleEbayCancelProofTransfer(payload) {
  const transferId = payload?.transferId || "";
  if (!state.ebayTransferReceiverReady) {
    queueEbayTransfer("queuedEbayCancelProofTransfers", payload);
    return;
  }
  if (transferId && state.handledEbayCancelProofTransferIds.has(transferId)) return;
  if (transferId) state.handledEbayCancelProofTransferIds.add(transferId);
  setEbayCancelProofTransferStatus("Attaching eBay cancellation proof...");
  postEbayCancelProofTransferStatus({
    transferId,
    phase: "started",
    message: "Pending Orders accepted the eBay cancellation proof transfer.",
  });

  try {
    const attached = await attachEbayCancelProofToWorkerModal(payload);
    postEbayCancelProofTransferStatus({
      transferId,
      ok: true,
      message: `Cancellation proof attached for eBay order ${attached.orderNumber || "order"}.`,
      ...attached,
    });
  } catch (error) {
    console.error("eBay cancellation proof transfer failed:", error);
    const message = error.message || "Could not attach eBay cancellation proof.";
    setEbayCancelProofTransferStatus(message, "error");
    postEbayCancelProofTransferStatus({
      transferId,
      ok: false,
      error: message,
    });
  }
}

function getPendingLabelReceiverState() {
  const selectedOrderNumber = normalizeEbayOrderNumber(state.selectedLine?.order?.order_number);
  return {
    pageType: "pending-orders",
    selectedOrderNumber,
    hasOpenSession: Boolean(selectedOrderNumber),
    noInventoryModalOpen: isWorkerNoInventoryModalOpen(),
    receiverReady: state.ebayTransferReceiverReady,
    canAutoRoute: !selectedOrderNumber,
  };
}

function normalizeEbayPriorityBuyerKey(value) {
  return String(value || "").trim().toLowerCase();
}

function getEbayPriorityRank(shipByDate) {
  const urgency = getOrderUrgency(shipByDate);
  if (urgency?.level === "overdue") return 0;
  if (urgency?.level === "today") return 1;
  if (urgency?.level === "tomorrow") return 2;
  if (shipByDate) return 3;
  return 4;
}

function buildEbayPendingPriorityPayload() {
  const groups = new Map();
  state.orders.filter(isOpenOrderLine).forEach((line) => {
    const buyerUsername = String(line.order?.buyer_username || "").trim();
    const buyerKey = normalizeEbayPriorityBuyerKey(buyerUsername || getBuyerLabel(line));
    if (!buyerKey) return;

    if (!groups.has(buyerKey)) {
      groups.set(buyerKey, {
        buyerKey,
        buyerUsername: buyerUsername || getBuyerLabel(line),
        orderNumbers: new Set(),
        lines: [],
        pendingLines: 0,
        pendingUnits: 0,
        nextShipBy: "",
        priorityRank: 4,
        priorityLabel: "Pending",
      });
    }

    const group = groups.get(buyerKey);
    const orderNumber = normalizeEbayOrderNumber(line.order?.order_number);
    if (orderNumber) group.orderNumbers.add(orderNumber);
    const remainingQuantity = getRemainingLineQuantity(line) || 0;
    group.pendingLines += 1;
    group.pendingUnits += remainingQuantity;

    const shipBy = line.order?.ship_by_date || "";
    const rank = getEbayPriorityRank(shipBy);
    const urgency = getOrderUrgency(shipBy);
    group.lines.push({
      orderNumber,
      itemNumber: line.item_number || "",
      transactionId: line.transaction_id || "",
      itemTitle: line.item_title || "",
      remainingQuantity,
      shipByDate: shipBy,
      priorityRank: rank,
      priorityLabel: urgency?.label || (shipBy ? "Upcoming" : "Pending"),
    });
    if (
      rank < group.priorityRank
      || (rank === group.priorityRank && getShipTimestamp(shipBy) < getShipTimestamp(group.nextShipBy))
    ) {
      group.nextShipBy = shipBy;
      group.priorityRank = rank;
      group.priorityLabel = urgency?.label || (shipBy ? "Upcoming" : "Pending");
    }
  });

  const priorities = [...groups.values()]
    .map((group) => ({
      ...group,
      orderNumbers: [...group.orderNumbers],
    }))
    .sort((a, b) =>
      a.priorityRank - b.priorityRank
      || getShipTimestamp(a.nextShipBy) - getShipTimestamp(b.nextShipBy)
      || a.buyerUsername.localeCompare(b.buyerUsername, undefined, { sensitivity: "base" })
    );

  const urgent = priorities.filter((entry) => entry.priorityRank <= 1);
  return {
    source: "og-pending-orders",
    pageUrl: window.location.href,
    generatedAt: new Date().toISOString(),
    priorities,
    urgentBuyerCount: urgent.length,
    overdueBuyerCount: priorities.filter((entry) => entry.priorityRank === 0).length,
    dueTodayBuyerCount: priorities.filter((entry) => entry.priorityRank === 1).length,
    urgentLineCount: urgent.reduce((sum, entry) => sum + Number(entry.pendingLines || 0), 0),
    urgentUnitCount: urgent.reduce((sum, entry) => sum + Number(entry.pendingUnits || 0), 0),
  };
}

function setupEbayLabelReceiver() {
  if (state.ebayTransferReceiverSetup) return;
  state.ebayTransferReceiverSetup = true;
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    if (event.data?.type === "OG_EBAY_LABEL_RECEIVER_STATE_REQUEST") {
      window.postMessage({
        type: "OG_EBAY_LABEL_RECEIVER_STATE_RESPONSE",
        requestId: event.data.requestId,
        payload: getPendingLabelReceiverState(),
      }, window.location.origin);
      return;
    }
    if (event.data?.type === "OG_EBAY_PENDING_PRIORITIES_REQUEST") {
      window.postMessage({
        type: "OG_EBAY_PENDING_PRIORITIES_RESPONSE",
        requestId: event.data.requestId,
        payload: buildEbayPendingPriorityPayload(),
      }, window.location.origin);
      return;
    }
    if (event.data?.type === "OG_EBAY_LABEL_TRANSFER") {
      handleEbayLabelTransfer(event.data.payload);
      return;
    }
    if (event.data?.type === "OG_EBAY_AWAITING_REPORT_TRANSFER") {
      handleEbayAwaitingReportTransfer(event.data.payload);
      return;
    }
    if (event.data?.type === "OG_EBAY_VIDEO_RECEIPT_PHOTO_TRANSFER") {
      handleVideoReceiptPhotoTransfer(event.data.payload);
      return;
    }
    if (event.data?.type === "OG_EBAY_CANCEL_PROOF_TRANSFER") {
      handleEbayCancelProofTransfer(event.data.payload);
    }
  });
}

async function previewSelectedEbayLabel() {
  const label = getSelectedOrderLabelData();
  if (!label.path) return setStatus("No eBay label is attached yet.", "error");
  const url = await getEbayLabelPreviewUrl(label.bucket, label.path);
  if (!url) return setStatus("Could not create a preview link for that label.", "error");
  window.open(url, "_blank", "noopener,noreferrer");
}

function setupListeners() {
  $("refresh-orders")?.addEventListener("click", async () => {
    clearEbayLaunchFilter({ apply: false });
    clearOrderSearch({ apply: false });
    clearOrderCreatedDateFilter({ apply: false });
    await loadOrders();
  });
  $("close-mobile-order-detail")?.addEventListener("click", closeMobileOrderDetail);
  window.addEventListener("resize", syncMobileOrderDetailMode);
  $("ebay-order-sync-check")?.addEventListener("click", () => runEbayOrderApiSync(true));
  $("ebay-order-sync-run")?.addEventListener("click", () => runEbayOrderApiSync(false));
  $("import-ebay-orders")?.addEventListener("click", importEbayOrdersFromCsv);
  $("ebay-orders-file")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    setImportStatus(file ? `Ready to import ${file.name}. Existing pending orders will be checked for missing lines; closed history orders will be skipped.` : "");
  });
  $("order-search")?.addEventListener("input", () => {
    clearEbayLaunchFilter({ apply: false });
    applyOrderFilters();
  });
  $("order-status-filter")?.addEventListener("change", loadOrders);
  $("order-created-date-filter")?.addEventListener("change", () => {
    clearEbayLaunchFilter({ apply: false });
    applyOrderFilters();
  });
  $("order-sort")?.addEventListener("change", (event) => {
    state.orderSort = event.target.value;
    applyOrderFilters();
  });
  $("checkout-store-select")?.addEventListener("change", handleCheckoutStoreChange);
  $("admin-clear-order-selection")?.addEventListener("click", clearAdminOrderSelection);
  $("admin-open-ebay-labels")?.addEventListener("click", openAdminSelectedEbayLabelPages);
  $("admin-mark-packed-no-stock")?.addEventListener("click", () => openAdminOrderCloseoutModal("fulfilled_no_inventory"));
  $("admin-mark-cancelled")?.addEventListener("click", () => openAdminOrderCloseoutModal("cancelled"));
  $("close-admin-order-closeout")?.addEventListener("click", closeAdminOrderCloseoutModal);
  $("cancel-admin-order-closeout")?.addEventListener("click", closeAdminOrderCloseoutModal);
  $("confirm-admin-order-closeout")?.addEventListener("click", confirmAdminOrderCloseout);
  $("close-ebay-completed-conflicts")?.addEventListener("click", closeCompletedHistoryConflictsModal);
  $("dismiss-ebay-completed-conflicts")?.addEventListener("click", closeCompletedHistoryConflictsModal);
  $("find-item")?.addEventListener("click", () => {
    clearItemSearchTimer();
    searchInventoryItems();
  });
  $("find-live-lot")?.addEventListener("click", () => {
    clearLiveLotSearchTimer();
    loadLiveLotByScan();
  });
  $("global-find-live-lot")?.addEventListener("click", () => {
    clearLiveLotSearchTimer();
    loadLiveLotByScan($("global-live-lot-scan")?.value);
  });
  $("global-clear-live-lot")?.addEventListener("click", () => {
    clearLiveLotSelection({ render: true });
    setStatus("Auction bag lookup cleared. Scan the next bag when ready.", "info");
    setTimeout(() => $("global-live-lot-scan")?.focus(), 80);
  });
  $("find-location")?.addEventListener("click", searchSourceLocation);
  $("stage-current-line")?.addEventListener("click", () => stageCurrentLine({ autoAdvance: true }));
  $("cancel-pending-order")?.addEventListener("click", () => openWorkerCancelOrderModal({ openEbayCancel: true }));
  $("complete-no-inventory")?.addEventListener("click", openWorkerNoInventoryModal);
  $("fulfill-order")?.addEventListener("click", fulfillSelectedOrder);
  $("clear-selection")?.addEventListener("click", clearSelection);
  $("preview-ebay-label")?.addEventListener("click", previewSelectedEbayLabel);
  $("preview-worker-ebay-label")?.addEventListener("click", previewSelectedEbayLabel);
  $("open-ebay-label-page")?.addEventListener("click", openSelectedEbayLabelPage);
  $("assign-order-task")?.addEventListener("click", () => openOrderTaskModal());
  $("open-order-task-modal")?.addEventListener("click", () => openOrderTaskModal());
  $("submit-order-task")?.addEventListener("click", submitOrderTask);
  $("cancel-order-task")?.addEventListener("click", closeOrderTaskModal);
  $("close-order-task-modal")?.addEventListener("click", closeOrderTaskModal);
  $("order-task-capture-station")?.addEventListener("change", (event) => {
    setSelectedNoInventoryCaptureStation(event.target.value);
  });
  $("refresh-order-task-stations")?.addEventListener("click", () => {
    loadNoInventoryCaptureStations().then(() => {
      setOrderTaskPhotoStatus("Camera stations refreshed.", "info");
    }).catch((error) => setOrderTaskPhotoStatus(error?.message || "Could not refresh stations.", "error"));
  });
  $("request-order-task-photo")?.addEventListener("click", requestOrderTaskPhoto);
  $("order-task-photo-file")?.addEventListener("change", handleOrderTaskPhotoFiles);
  $("select-all-order-task-photos")?.addEventListener("click", () => setAllOrderTaskPhotosSelected(true));
  $("deselect-all-order-task-photos")?.addEventListener("click", () => setAllOrderTaskPhotosSelected(false));
  $("confirm-item-choice")?.addEventListener("click", confirmItemCandidate);
  $("cancel-item-confirm")?.addEventListener("click", closeItemConfirmModal);
  $("close-item-confirm")?.addEventListener("click", closeItemConfirmModal);
  $("confirm-bundle-review")?.addEventListener("click", () => fulfillSelectedOrder({ skipReview: true }));
  $("cancel-bundle-review")?.addEventListener("click", closeBundleReviewModal);
  $("close-bundle-review")?.addEventListener("click", closeBundleReviewModal);
  $("confirm-worker-no-inventory")?.addEventListener("click", confirmWorkerNoInventoryCompletion);
  $("cancel-worker-no-inventory")?.addEventListener("click", closeWorkerNoInventoryModal);
  $("close-worker-no-inventory")?.addEventListener("click", closeWorkerNoInventoryModal);
  $("confirm-worker-cancel-order")?.addEventListener("click", confirmWorkerCancelOrder);
  $("open-ebay-cancel-flow")?.addEventListener("click", () => openEbayCancelFlowForWorkerModal());
  $("cancel-worker-cancel-order")?.addEventListener("click", closeWorkerCancelOrderModal);
  $("close-worker-cancel-order")?.addEventListener("click", closeWorkerCancelOrderModal);
  $("select-all-worker-cancel-order")?.addEventListener("click", () => setAllWorkerCancelOrderLines(true));
  $("deselect-all-worker-cancel-order")?.addEventListener("click", () => setAllWorkerCancelOrderLines(false));
  $("worker-cancel-capture-station")?.addEventListener("change", (event) => {
    setSelectedNoInventoryCaptureStation(event.target.value);
  });
  $("refresh-worker-cancel-stations")?.addEventListener("click", () => {
    loadNoInventoryCaptureStations().then(() => {
      setWorkerCancelPhotoStatus("Camera stations refreshed.", "info");
    }).catch((error) => setWorkerCancelPhotoStatus(error?.message || "Could not refresh stations.", "error"));
  });
  $("request-worker-cancel-photo")?.addEventListener("click", requestWorkerCancelEvidencePhoto);
  $("worker-cancel-evidence-file")?.addEventListener("change", handleWorkerCancelEvidenceFiles);
  $("select-all-worker-cancel-photos")?.addEventListener("click", () => setAllWorkerCancelEvidencePhotosSelected(true));
  $("deselect-all-worker-cancel-photos")?.addEventListener("click", () => setAllWorkerCancelEvidencePhotosSelected(false));
  $("select-all-worker-no-inventory")?.addEventListener("click", () => setAllWorkerNoInventoryLines(true));
  $("deselect-all-worker-no-inventory")?.addEventListener("click", () => setAllWorkerNoInventoryLines(false));
  $("no-inventory-capture-station")?.addEventListener("change", (event) => {
    setSelectedNoInventoryCaptureStation(event.target.value);
  });
  $("refresh-no-inventory-stations")?.addEventListener("click", () => loadNoInventoryCaptureStations());
  $("request-no-inventory-photo")?.addEventListener("click", requestNoInventoryEvidencePhoto);
  $("select-all-no-inventory-photos")?.addEventListener("click", () => setAllNoInventoryEvidencePhotosSelected(true));
  $("deselect-all-no-inventory-photos")?.addEventListener("click", () => setAllNoInventoryEvidencePhotosSelected(false));

  $("item-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearItemSearchTimer();
      searchInventoryItems();
    }
  });

  $("item-scan")?.addEventListener("input", scheduleItemSearch);

  $("live-lot-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearLiveLotSearchTimer();
      loadLiveLotByScan();
    }
  });
  $("live-lot-scan")?.addEventListener("input", () => scheduleLiveLotSearch("live-lot-scan"));

  $("global-live-lot-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearLiveLotSearchTimer();
      loadLiveLotByScan($("global-live-lot-scan")?.value);
    }
  });
  $("global-live-lot-scan")?.addEventListener("input", () => scheduleLiveLotSearch("global-live-lot-scan"));

  $("location-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchSourceLocation();
    }
  });
  $("location-scan")?.addEventListener("input", scheduleSourceLocationSearch);

  $("fulfill-quantity")?.addEventListener("input", () => {
    if (state.selectedStockRow) scheduleQuantityAutoStage();
  });

  $("fulfill-quantity")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      stageCurrentLine({ autoAdvance: true, autoReview: true });
    }
  });

  $("fulfill-notes")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      fulfillSelectedOrder();
    }
  });

  $("item-confirm-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "item-confirm-modal") closeItemConfirmModal();
  });

  $("bundle-review-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "bundle-review-modal") closeBundleReviewModal();
  });

  $("worker-no-inventory-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "worker-no-inventory-modal") closeWorkerNoInventoryModal();
  });

  $("worker-cancel-order-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "worker-cancel-order-modal") closeWorkerCancelOrderModal();
  });

  $("order-task-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "order-task-modal") closeOrderTaskModal();
  });

  $("no-inventory-photo-viewer-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "no-inventory-photo-viewer-modal") closeNoInventoryEvidencePhotoViewer();
  });
  $("close-no-inventory-photo-viewer")?.addEventListener("click", closeNoInventoryEvidencePhotoViewer);
  $("dismiss-no-inventory-photo-viewer")?.addEventListener("click", closeNoInventoryEvidencePhotoViewer);
  $("zoom-in-no-inventory-photo")?.addEventListener("click", () => adjustEvidencePhotoViewerZoom(0.25));
  $("zoom-out-no-inventory-photo")?.addEventListener("click", () => adjustEvidencePhotoViewerZoom(-0.25));
  $("reset-zoom-no-inventory-photo")?.addEventListener("click", resetEvidencePhotoViewerTransform);
  $("no-inventory-photo-viewer-image")?.addEventListener("pointerdown", startEvidencePhotoPan);
  $("no-inventory-photo-viewer-image")?.addEventListener("pointermove", moveEvidencePhotoPan);
  $("no-inventory-photo-viewer-image")?.addEventListener("pointerup", endEvidencePhotoPan);
  $("no-inventory-photo-viewer-image")?.addEventListener("pointercancel", endEvidencePhotoPan);

  $("admin-order-closeout-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "admin-order-closeout-modal") closeAdminOrderCloseoutModal();
  });

  $("ebay-completed-conflicts-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "ebay-completed-conflicts-modal") closeCompletedHistoryConflictsModal();
  });

  $("admin-order-closeout-password")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmAdminOrderCloseout();
    }
  });

  $("worker-cancel-order-password")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmWorkerCancelOrder();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!$("no-inventory-photo-viewer-modal")?.classList.contains("hidden")) {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        closeNoInventoryEvidencePhotoViewer();
      }
      return;
    }

    if (!$("admin-order-closeout-modal")?.classList.contains("hidden")) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        confirmAdminOrderCloseout();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeAdminOrderCloseoutModal();
      }
      return;
    }

    if (!$("ebay-completed-conflicts-modal")?.classList.contains("hidden")) {
      if (event.key === "Enter" || event.key === "Escape") {
        event.preventDefault();
        closeCompletedHistoryConflictsModal();
      }
      return;
    }

    if (!$("order-task-modal")?.classList.contains("hidden")) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        submitOrderTask();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeOrderTaskModal();
      }
      return;
    }

    if (!$("worker-no-inventory-modal")?.classList.contains("hidden")) {
      const target = event.target;
      const targetTag = target?.tagName?.toLowerCase();
      const skipEnter = targetTag === "textarea"
        || targetTag === "input"
        || (targetTag === "button" && target?.id !== "confirm-worker-no-inventory");
      if (event.key === "Enter" && !skipEnter) {
        event.preventDefault();
        confirmWorkerNoInventoryCompletion();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeWorkerNoInventoryModal();
      }
      return;
    }

    if (!$("worker-cancel-order-modal")?.classList.contains("hidden")) {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        confirmWorkerCancelOrder();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeWorkerCancelOrderModal();
      }
      return;
    }

    if (!$("item-confirm-modal")?.classList.contains("hidden")) {
      if (event.key === "Enter") {
        event.preventDefault();
        confirmItemCandidate();
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeItemConfirmModal();
      }
      return;
    }

    if (!$("bundle-review-modal")?.classList.contains("hidden")) {
      if (event.key === "Enter") {
        event.preventDefault();
        fulfillSelectedOrder({ skipReview: true });
      } else if (event.key === "Escape") {
        event.preventDefault();
        closeBundleReviewModal();
      }
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  setupEbayLabelReceiver();
  await waitForSupabaseReady();
  const ok = await loadCurrentWorker();
  if (!ok) return;
  setupDashboardShell();
  setupImportVisibility();
  setupListeners();
  await loadCheckoutStores();
  state.launchOrderTaskId = getRequestedOrderTaskId();
  loadOrderTaskAssignees().catch((error) => console.warn("Could not preload order task assignees:", error));
  clearOrderSearch({ apply: false });
  clearOrderCreatedDateFilter({ apply: false });
  await loadOrders();
  const openedTask = await openRequestedOrderTask();
  if (!openedTask) applyEbayLaunchOrderSelection();
  markEbayTransferReceiverReady();
  if (window.lucide) window.lucide.createIcons();
});
