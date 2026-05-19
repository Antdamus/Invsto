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
  orderSort: "due_asc",
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
  ebayLaunchSnapshot: null,
  workerNoInventoryGps: null,
  workerNoInventoryCandidates: [],
  workerNoInventoryLineIds: new Set(),
  noInventoryCaptureStations: [],
  selectedNoInventoryCaptureStationId: "",
  noInventoryEvidencePhotos: [],
  noInventoryEvidencePhotoUploadKeys: new Set(),
  noInventoryCaptureBusy: false,
  ebayLabelPreviewUrls: new Map(),
  handledEbayLabelTransferIds: new Set(),
  handledEbayReportTransferIds: new Set(),
  ebayLabelBusy: false,
  ebayReportBusy: false,
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
const ORDER_QUEUE_PAGE_SIZE = 1000;
const EBAY_ORDER_NUMBER_PATTERN = /^\d{2}-\d{5}-\d{5}$/;

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

function getOrderUrgency(value) {
  if (!value) return null;
  const shipBy = new Date(value);
  if (Number.isNaN(shipBy.getTime())) return null;

  const shipDay = startOfLocalDay(shipBy);
  const today = startOfLocalDay();
  if (shipDay < today) {
    return {
      level: "overdue",
      label: "Past due",
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
    || !$("no-inventory-photo-viewer-modal")?.classList.contains("hidden")
    || !$("admin-order-closeout-modal")?.classList.contains("hidden")
  ) return;
  document.body.classList.remove("modal-open");
}

function getOrderFromLine(line) {
  const order = line?.ebay_orders || line?.order || {};
  return Array.isArray(order) ? order[0] || {} : order;
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

function isAdminUser() {
  return String(state.employee?.role || "").toLowerCase() === "admin";
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

  const current = select.value || state.orderSort || "due_asc";
  const options = [
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

  state.orderSort = options.some(([value]) => value === current) ? current : "due_asc";
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
  return {
    ...line,
    order,
    searchText: [
      order.order_number,
      order.sales_record_number,
      order.buyer_username,
      line.item_number,
      line.transaction_id,
      line.item_title,
      line.custom_label,
    ].filter(Boolean).join(" ").toLowerCase(),
  };
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
    row.some((cell) => String(cell).trim() === "Order Number")
    && row.some((cell) => String(cell).trim() === "Item Title")
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

function csvCell(row, ...names) {
  for (const name of names) {
    if (row[name] !== undefined && row[name] !== null && String(row[name]).trim() !== "") {
      return String(row[name]).trim();
    }
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
      .select("id, order_number")
      .in("order_number", chunk);

    if (error) throw error;
    (data || []).forEach((row) => existing.set(row.order_number, row.id));
  }
  return existing;
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
  const expectedAwaitingTotal = parseAwaitingSummaryTotal(metadata.visibleSummaryText);
  const warnings = [];
  if (expectedAwaitingTotal && payload.length < expectedAwaitingTotal) {
    warnings.push(`The eBay page summary said ${metadata.visibleSummaryText}, but the report contained ${payload.length} order(s).`);
  }

  const incomingNumbers = [...new Set(payload.map((entry) => entry.order.order_number))];
  const existingOrders = await loadExistingOrdersByNumber(incomingNumbers);
  const fresh = payload.filter((entry) => !existingOrders.has(entry.order.order_number));
  const skipped = payload.length - fresh.length;

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
    ...existingOrders.entries(),
    ...(insertedOrders || []).map((order) => [order.order_number, order.id]),
  ]);
  const lineRows = payload.flatMap((entry) => {
    const orderId = orderIdByNumber.get(entry.order.order_number);
    return entry.lines.map((line) => ({ ...line, order_id: orderId }));
  }).filter((line) => line.order_id);

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

  const insertedLineCount = (insertedLines || []).length;
  let statusUpdatedOrderCount = 0;
  if (insertedLineCount) {
    const orderIdsWithNewLines = [...new Set((insertedLines || []).map((line) => line.order_id).filter(Boolean))];
    statusUpdatedOrderCount = orderIdsWithNewLines.length;
    await supabase
      .from("ebay_orders")
      .update({ status: "pending" })
      .in("id", orderIdsWithNewLines)
      .in("status", ["fulfilled", "cancelled", "archived"]);
  }

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
    linesInReport: lineRows.length,
    newOrdersAdded: insertedOrders.length,
    existingOrdersChecked: skipped,
    newLinesAdded: insertedLineCount,
    ordersReopenedOrUpdated: statusUpdatedOrderCount,
    warnings,
  };
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

    setImportStatus(`Imported ${result.newOrdersAdded} new order(s) and ${result.newLinesAdded} new line item(s). Checked ${result.existingOrdersChecked} existing order(s) for missing lines.`, "success");
    $("ebay-orders-file").value = "";
    await loadOrders();
  } catch (error) {
    console.error("eBay order import failed:", error);
    setImportStatus(error.message || "Could not import eBay orders.", "error");
  } finally {
    if (button) button.disabled = false;
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
      internal_item_id,
      fulfilled_quantity,
      fulfilled_at,
      notes,
      ebay_orders!inner(
        id,
        order_number,
        sales_record_number,
        buyer_username,
        sale_date,
        paid_on_date,
        ship_by_date,
        ${moneyOrderFields}
        status,
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

  state.orders = data.map(normalizeLine);
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

function applyOrderFilters() {
  const term = String($("order-search")?.value || "").trim().toLowerCase();
  let filtered = term
    ? state.orders.filter((line) => line.searchText.includes(term))
    : [...state.orders];

  if (state.selectedLiveLot) {
    filtered = filtered.filter((line) => state.liveLotMatchedLineIds.has(line.id));
  }

  if (state.ebayLaunchBuyerKeys.size) {
    filtered = filtered.filter((line) => state.ebayLaunchBuyerKeys.has(getBuyerKey(line)));
  } else if (state.ebayLaunchOrderNumbers.size) {
    filtered = filtered.filter((line) => state.ebayLaunchOrderNumbers.has(String(line.order?.order_number || "")));
  }

  state.filteredOrders = filtered;
  renderOrders();
  renderSummaryStrip();
  renderAdminOrderActions();
  renderLiveLotOrderMatches();
}

function clearEbayLaunchFilter({ apply = true } = {}) {
  if (!state.ebayLaunchOrderNumbers.size && !state.ebayLaunchBuyerKeys.size && !state.ebayLaunchSnapshot) return;
  state.ebayLaunchOrderNumbers.clear();
  state.ebayLaunchBuyerKeys.clear();
  state.ebayLaunchSnapshot = null;
  if (apply) applyOrderFilters();
}

function applyEbayLaunchOrderSelection() {
  const orderNumbers = getRequestedEbayOrderNumbers();
  if (!orderNumbers.length) return;

  state.ebayLaunchSnapshot = getRequestedEbayOrderSnapshot();
  state.ebayLaunchOrderNumbers = new Set(orderNumbers);
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

  state.ebayLaunchBuyerKeys = new Set(matches.map(getBuyerKey).filter(Boolean));
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
  const pending = openLines.length;
  const shipToday = openLines.filter((line) => sameLocalDay(line.order?.ship_by_date)).length;
  $("summary-pending").textContent = String(pending);
  $("summary-ship-today").textContent = String(shipToday);
  $("summary-selected").textContent = state.selectedLine ? getBuyerLabel(state.selectedLine) : "None";
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
  });

  return sortBuyerGroups([...groups.values()]);
}

function sortBuyerGroups(groups) {
  const sort = $("order-sort")?.value || state.orderSort || "due_asc";
  state.orderSort = sort;

  const byBuyer = (a, b) => a.buyer.localeCompare(b.buyer, undefined, { sensitivity: "base" });
  const byDue = (a, b) => getShipTimestamp(a.nextShipBy) - getShipTimestamp(b.nextShipBy);
  const byTotal = (a, b) => Number(a.totalValue || 0) - Number(b.totalValue || 0);

  return groups.sort((a, b) => {
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
  return getBuyerLines(getBuyerKey(line)).filter(isNoInventoryCompletionLine);
}

function isAdminCloseoutSelectable(line) {
  return isAdminUser()
    && isOpenOrderLine(line);
}

function getSelectedAdminLines() {
  return state.orders.filter((line) => state.adminSelectedLineIds.has(line.id) && isAdminCloseoutSelectable(line));
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
  groups.forEach((group) => {
    const urgency = group.pendingCount ? getOrderUrgency(group.nextShipBy) : null;
    const urgencyClass = urgency?.level === "today" ? "is-due-today" : urgency ? `is-${urgency.level}` : "";
    const urgencyMarkup = urgency ? `
      <span class="urgency-pill urgency-${urgency.level}">
        <i data-lucide="${urgency.icon}"></i>
        ${escapeHtml(urgency.label)}
      </span>
    ` : "";
    const card = document.createElement("article");
    card.className = `buyer-order-card ${urgencyClass} ${state.selectedLine && getBuyerKey(state.selectedLine) === group.key ? "is-selected" : ""}`;
    card.innerHTML = `
      <div class="buyer-card-head">
        <div>
          <span class="buyer-kicker">Buyer username</span>
          <strong>${escapeHtml(group.buyer)}</strong>
          <small>${group.orderNumbers.size} order(s) - ${group.lines.length} line(s) - Qty ${group.totalQuantity}</small>
        </div>
        <div class="buyer-card-alerts">
          ${urgencyMarkup}
          <span class="status-badge">${group.pendingCount} pending</span>
        </div>
      </div>
      <div class="buyer-card-meta">
        <span>Ship by ${escapeHtml(formatDate(group.nextShipBy))}</span>
        ${isAdminUser() ? `<span>${formatMoney(group.totalValue)}</span>` : `<span>Ready to pack</span>`}
      </div>
      ${isAdminUser() ? `
        <div class="buyer-card-admin-row">
          <label class="admin-group-select">
            <input type="checkbox" data-admin-group-select="${escapeHtml(group.key)}" />
            Select pending lines
          </label>
        </div>
      ` : ""}
      <div class="buyer-line-list"></div>
    `;

    const lineList = card.querySelector(".buyer-line-list");
    const groupCheckbox = card.querySelector("[data-admin-group-select]");
    if (groupCheckbox) {
      const selectable = group.lines.filter(isAdminCloseoutSelectable);
      const selected = selectable.filter((line) => state.adminSelectedLineIds.has(line.id));
      groupCheckbox.checked = selectable.length > 0 && selected.length === selectable.length;
      groupCheckbox.indeterminate = selected.length > 0 && selected.length < selectable.length;
      groupCheckbox.disabled = selectable.length === 0;
      groupCheckbox.addEventListener("click", (event) => event.stopPropagation());
      groupCheckbox.addEventListener("change", (event) => setAdminGroupSelection(group, event.target.checked));
    }

    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      if (event.target.closest("input")) return;
      if (event.target.closest(".buyer-line-btn")) return;
      const nextLine = group.lines.find((line) => isOpenOrderLine(line) && !state.stagedFulfillments.has(line.id)) || group.lines[0];
      if (nextLine) selectOrderLine(nextLine.id);
    });

    group.lines.forEach((line) => {
      const order = line.order || {};
      const button = document.createElement(isAdminUser() ? "div" : "button");
      if (button.tagName === "BUTTON") button.type = "button";
      else {
        button.setAttribute("role", "button");
        button.tabIndex = 0;
      }
      button.className = `buyer-line-btn ${isAdminUser() ? "has-admin-select" : ""} ${state.selectedLine?.id === line.id ? "is-selected" : ""}`;
      const adminSelect = isAdminUser() ? `
        <label class="admin-order-select" title="Select for admin closeout">
          <input type="checkbox" data-admin-line-select="${escapeHtml(line.id)}" ${state.adminSelectedLineIds.has(line.id) ? "checked" : ""} ${isAdminCloseoutSelectable(line) ? "" : "disabled"} />
        </label>
      ` : "";
      button.innerHTML = `
        ${adminSelect}
        <span>
          <strong>${escapeHtml(line.item_title || "Untitled eBay item")}</strong>
          <small>${escapeHtml(order.order_number || "No order number")} - ${escapeHtml(line.item_number || "No item #")} - Qty ${Number(line.quantity || 1)}</small>
        </span>
        <b>${escapeHtml(line.line_status || "pending")}</b>
      `;
      const lineCheckbox = button.querySelector("[data-admin-line-select]");
      lineCheckbox?.addEventListener("click", (event) => event.stopPropagation());
      lineCheckbox?.addEventListener("change", (event) => setAdminLineSelection(line.id, event.target.checked));
      button.addEventListener("click", () => selectOrderLine(line.id));
      button.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        selectOrderLine(line.id);
      });
      lineList.appendChild(button);
    });

    list.appendChild(card);
  });

  if (window.lucide) window.lucide.createIcons();
}

function selectOrderLine(lineId) {
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

  $("selected-order-empty")?.classList.add("hidden");
  $("fulfillment-workflow")?.classList.remove("hidden");
  renderOrders();
  renderLiveLotOrderMatches();
  renderSelectedOrder();
  renderBuyerBundlePanel();
  resetFulfillmentInputs();
  renderSelectionSummary();
  renderItemResults([]);
  renderLocationResults([]);
  renderSummaryStrip();

  $("item-scan").value = "";
  updateCheckoutStoreGate();
  if (!state.checkoutStoreId) {
    setStatus("Select the checkout store before scanning this order.", "error");
    setTimeout(() => $("checkout-store-select")?.focus(), 80);
    return;
  }
  setTimeout(() => (state.selectedLiveLot ? $("fulfill-order") : $("item-scan"))?.focus(), 80);
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
  $("selected-order-subtitle").textContent = `${line.item_title || "Untitled item"} - Buyer: ${order.buyer_username || "unknown"} - Remaining: ${getRemainingLineQuantity(line)} of ${Number(line.quantity || 0)} - Ship by ${formatDate(order.ship_by_date)}`;
  $("selected-order-status").textContent = line.line_status || "pending";
  $("money-grid")?.classList.toggle("hidden", !isAdminUser());
  $("detail-sold-for").textContent = formatMoney(line.sold_for);
  $("detail-shipping").textContent = formatMoney(line.shipping_and_handling || order.shipping_and_handling);
  $("detail-total").textContent = formatMoney(line.total_price || order.total_price || line.sold_for);
  $("detail-payout").textContent = line.net_payout || order.net_payout ? formatMoney(line.net_payout || order.net_payout) : "Not imported";
  renderEbayLabelPanel();
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
  const summaryText = label.path
    ? `Label attached${label.uploadedAt ? ` ${formatDate(label.uploadedAt)}` : ""}${sizeText ? ` - ${sizeText}` : ""}. Preview before final confirmation.`
    : "Waiting for a label from the eBay extension.";
  const detailsHtml = label.path
    ? `
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
    summary.textContent = summaryText;
    details.innerHTML = detailsHtml;
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

function closeItemConfirmModal() {
  state.pendingItemCandidate = null;
  closeModal("item-confirm-modal");
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

function closeBundleReviewModal() {
  closeModal("bundle-review-modal");
  setTimeout(() => $("fulfill-order")?.focus(), 80);
}

function closeAdminOrderCloseoutModal() {
  state.adminCloseoutAction = "";
  closeModal("admin-order-closeout-modal");
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
  const select = $("no-inventory-capture-station");
  if (!select) return;
  const stations = state.noInventoryCaptureStations;

  if (!stations.length) {
    select.innerHTML = '<option value="">No active stations</option>';
    select.disabled = true;
    return;
  }

  select.replaceChildren(new Option("Choose station", ""));
  stations.forEach((station) => {
    select.appendChild(new Option(station.name || station.id, station.id));
  });
  select.value = stations.some((station) => station.id === state.selectedNoInventoryCaptureStationId)
    ? state.selectedNoInventoryCaptureStationId
    : "";
  select.disabled = false;
}

function setSelectedNoInventoryCaptureStation(stationId = "") {
  const station = state.noInventoryCaptureStations.find((entry) => entry.id === stationId) || null;
  state.selectedNoInventoryCaptureStationId = station?.id || "";

  const select = $("no-inventory-capture-station");
  if (select && select.value !== state.selectedNoInventoryCaptureStationId) {
    select.value = state.selectedNoInventoryCaptureStationId;
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

async function pollNoInventoryCaptureJob(job, station = {}) {
  const jobId = job?.id || job;
  const stationName = station.name || "";
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
    setNoInventoryPhotoStatus(photoCount > 0 ? `${label} ${photoCount} photo${photoCount === 1 ? "" : "s"} received...` : label, "info");
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
  return `${photo?.bucket || ""}:${photo?.path || ""}`;
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
    const response = await fetch(photo.previewUrl);
    if (!response.ok) {
      throw new Error(`Could not download evidence photo ${index + 1} before saving.`);
    }

    const blob = await response.blob();
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
  if (!photo?.previewUrl) return;

  const image = $("no-inventory-photo-viewer-image");
  const caption = $("no-inventory-photo-viewer-caption");
  if (image) {
    image.src = photo.previewUrl;
    image.alt = photo.label || `Evidence photo ${index + 1}`;
  }
  if (caption) {
    caption.textContent = `${photo.label || `Evidence photo ${index + 1}`} - ${photo.bucket}/${photo.path}`;
  }
  openModal("no-inventory-photo-viewer-modal");
  setTimeout(() => $("dismiss-no-inventory-photo-viewer")?.focus(), 80);
}

function closeNoInventoryEvidencePhotoViewer() {
  const image = $("no-inventory-photo-viewer-image");
  if (image) image.removeAttribute("src");
  closeModal("no-inventory-photo-viewer-modal");
  setTimeout(() => $("request-no-inventory-photo")?.focus(), 80);
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

function closeWorkerNoInventoryModal() {
  state.workerNoInventoryGps = null;
  state.workerNoInventoryCandidates = [];
  state.workerNoInventoryLineIds.clear();
  state.noInventoryEvidencePhotos = [];
  state.noInventoryEvidencePhotoUploadKeys.clear();
  closeModal("worker-no-inventory-modal");
  setTimeout(() => $("complete-no-inventory")?.focus(), 80);
}

function updateWorkerNoInventorySelectionSummary() {
  const selected = state.workerNoInventoryLineIds.size;
  const total = state.workerNoInventoryCandidates.length;
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
  updateWorkerNoInventorySelectionSummary();
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
  const candidates = getNoInventoryCandidateLines(line);
  if (!candidates.length) {
    setStatus("No untouched pending lines for this buyer can be completed without inventory removal.", "error");
    return;
  }

  state.workerNoInventoryGps = null;
  state.workerNoInventoryCandidates = candidates;
  state.workerNoInventoryLineIds = new Set(candidates.map((entry) => entry.id));
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
    closeWorkerNoInventoryModal();
    setStatus(`${data?.[0]?.updated_lines || selectedLineIds.length} line(s) completed without inventory removal. The audit trail was recorded.`, "info");
    await loadOrders();

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

async function verifyAdminPassword(password) {
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

    const valid = await verifyAdminPassword(password);
    if (!valid) throw new Error("Incorrect password. Please try again.");

    const { data, error } = await supabase.rpc("admin_close_ebay_order_lines", {
      _order_line_ids: lines.map((line) => line.id),
      _action: state.adminCloseoutAction,
      _notes: note,
      _signed_by_email: state.user.email,
    });
    if (error) throw error;

    closeAdminOrderCloseoutModal();
    clearAdminOrderSelection();
    setImportStatus(`Closed ${data?.[0]?.updated_lines || lines.length} order line(s).`, "success");
    await loadOrders();
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
    state.stagedFulfillments.clear();
    setStatus("Packed bundle confirmed. Stock was removed and signed.", "info");
    await loadOrders();

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
    ...metadata,
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
  await openPendingNoInventorySessionForLabel(primaryOrderNumber);
  const attachedMessage = matchingLines.length
    ? `Shipping label attached to eBay order${targetOrderNumbers.length === 1 ? "" : "s"} ${targetOrderNumbers.join(", ")}. Preview it before final confirmation.`
    : `Shipping label attached to eBay order${targetOrderNumbers.length === 1 ? "" : "s"} ${targetOrderNumbers.join(", ")}. Refresh or open that order to preview it.`;
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

function getPendingLabelReceiverState() {
  const selectedOrderNumber = normalizeEbayOrderNumber(state.selectedLine?.order?.order_number);
  return {
    pageType: "pending-orders",
    selectedOrderNumber,
    hasOpenSession: Boolean(selectedOrderNumber),
    noInventoryModalOpen: isWorkerNoInventoryModalOpen(),
    canAutoRoute: !selectedOrderNumber,
  };
}

function setupEbayLabelReceiver() {
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
    if (event.data?.type === "OG_EBAY_LABEL_TRANSFER") {
      handleEbayLabelTransfer(event.data.payload);
      return;
    }
    if (event.data?.type === "OG_EBAY_AWAITING_REPORT_TRANSFER") {
      handleEbayAwaitingReportTransfer(event.data.payload);
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
    await loadOrders();
  });
  $("import-ebay-orders")?.addEventListener("click", importEbayOrdersFromCsv);
  $("ebay-orders-file")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    setImportStatus(file ? `Ready to import ${file.name}. Existing orders will be checked for missing lines.` : "");
  });
  $("order-search")?.addEventListener("input", () => {
    clearEbayLaunchFilter({ apply: false });
    applyOrderFilters();
  });
  $("order-status-filter")?.addEventListener("change", loadOrders);
  $("order-sort")?.addEventListener("change", (event) => {
    state.orderSort = event.target.value;
    applyOrderFilters();
  });
  $("checkout-store-select")?.addEventListener("change", handleCheckoutStoreChange);
  $("admin-clear-order-selection")?.addEventListener("click", clearAdminOrderSelection);
  $("admin-mark-packed-no-stock")?.addEventListener("click", () => openAdminOrderCloseoutModal("fulfilled_no_inventory"));
  $("admin-mark-cancelled")?.addEventListener("click", () => openAdminOrderCloseoutModal("cancelled"));
  $("close-admin-order-closeout")?.addEventListener("click", closeAdminOrderCloseoutModal);
  $("cancel-admin-order-closeout")?.addEventListener("click", closeAdminOrderCloseoutModal);
  $("confirm-admin-order-closeout")?.addEventListener("click", confirmAdminOrderCloseout);
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
  $("complete-no-inventory")?.addEventListener("click", openWorkerNoInventoryModal);
  $("fulfill-order")?.addEventListener("click", fulfillSelectedOrder);
  $("clear-selection")?.addEventListener("click", clearSelection);
  $("preview-ebay-label")?.addEventListener("click", previewSelectedEbayLabel);
  $("preview-worker-ebay-label")?.addEventListener("click", previewSelectedEbayLabel);
  $("confirm-item-choice")?.addEventListener("click", confirmItemCandidate);
  $("cancel-item-confirm")?.addEventListener("click", closeItemConfirmModal);
  $("close-item-confirm")?.addEventListener("click", closeItemConfirmModal);
  $("confirm-bundle-review")?.addEventListener("click", () => fulfillSelectedOrder({ skipReview: true }));
  $("cancel-bundle-review")?.addEventListener("click", closeBundleReviewModal);
  $("close-bundle-review")?.addEventListener("click", closeBundleReviewModal);
  $("confirm-worker-no-inventory")?.addEventListener("click", confirmWorkerNoInventoryCompletion);
  $("cancel-worker-no-inventory")?.addEventListener("click", closeWorkerNoInventoryModal);
  $("close-worker-no-inventory")?.addEventListener("click", closeWorkerNoInventoryModal);
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

  $("no-inventory-photo-viewer-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "no-inventory-photo-viewer-modal") closeNoInventoryEvidencePhotoViewer();
  });
  $("close-no-inventory-photo-viewer")?.addEventListener("click", closeNoInventoryEvidencePhotoViewer);
  $("dismiss-no-inventory-photo-viewer")?.addEventListener("click", closeNoInventoryEvidencePhotoViewer);

  $("admin-order-closeout-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "admin-order-closeout-modal") closeAdminOrderCloseoutModal();
  });

  $("admin-order-closeout-password")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmAdminOrderCloseout();
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
  await waitForSupabaseReady();
  const ok = await loadCurrentWorker();
  if (!ok) return;
  setupEbayLabelReceiver();
  setupDashboardShell();
  setupImportVisibility();
  setupListeners();
  await loadCheckoutStores();
  clearOrderSearch({ apply: false });
  await loadOrders();
  applyEbayLaunchOrderSelection();
  if (window.lucide) window.lucide.createIcons();
});
