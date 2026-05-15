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
  busy: false,
};

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
  return String(state.employee?.role || "").toLowerCase() === "admin";
}

function isAdminUser() {
  return canImportOrders();
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
  $("location-scan")?.toggleAttribute("disabled", !hasStore);
  $("find-location")?.toggleAttribute("disabled", !hasStore);
  $("stage-current-line")?.toggleAttribute("disabled", !hasStore);
  $("fulfill-order")?.toggleAttribute("disabled", !hasStore);
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

  setStatus(`Checkout store set to ${getCheckoutStoreName(nextStoreId)}.`, "info");
  setTimeout(() => $("item-scan")?.focus(), 80);
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
  const parsed = parseCsv(text);
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

async function loadExistingOrderNumbers(orderNumbers) {
  const existing = new Set();
  for (let index = 0; index < orderNumbers.length; index += 100) {
    const chunk = orderNumbers.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_orders")
      .select("order_number")
      .in("order_number", chunk);

    if (error) throw error;
    (data || []).forEach((row) => existing.add(row.order_number));
  }
  return existing;
}

async function importEbayOrdersFromCsv() {
  if (!canImportOrders()) {
    setImportStatus("Only admins can import eBay order reports.", "error");
    return;
  }

  const file = $("ebay-orders-file")?.files?.[0];
  if (!file) {
    setImportStatus("Choose the eBay Orders Report CSV first.", "error");
    return;
  }

  const button = $("import-ebay-orders");
  button.disabled = true;
  setImportStatus("Reading eBay orders report...");
  let insertedOrderIds = [];

  try {
    const text = await file.text();
    const rows = rowsFromEbayCsv(text);
    const payload = buildOrderImportPayload(rows);
    if (!payload.length) throw new Error("No usable eBay order rows were found in that CSV.");

    const incomingNumbers = [...new Set(payload.map((entry) => entry.order.order_number))];
    const existing = await loadExistingOrderNumbers(incomingNumbers);
    const fresh = payload.filter((entry) => !existing.has(entry.order.order_number));
    const skipped = payload.length - fresh.length;

    if (!fresh.length) {
      setImportStatus(`No new orders imported. ${skipped} duplicate order(s) were already in the system.`, "success");
      await loadOrders();
      return;
    }

    const { data: insertedOrders, error: orderError } = await supabase
      .from("ebay_orders")
      .insert(fresh.map((entry) => entry.order))
      .select("id, order_number");

    if (orderError) throw orderError;
    insertedOrderIds = (insertedOrders || []).map((order) => order.id).filter(Boolean);

    const orderIdByNumber = new Map((insertedOrders || []).map((order) => [order.order_number, order.id]));
    const lineRows = fresh.flatMap((entry) => {
      const orderId = orderIdByNumber.get(entry.order.order_number);
      return entry.lines.map((line) => ({ ...line, order_id: orderId }));
    }).filter((line) => line.order_id);

    const { error: lineError } = await supabase
      .from("ebay_order_lines")
      .insert(lineRows);

    if (lineError) {
      if (insertedOrderIds.length) {
        await supabase.from("ebay_orders").delete().in("id", insertedOrderIds);
      }
      throw lineError;
    }

    setImportStatus(`Imported ${insertedOrders.length} new order(s) and ${lineRows.length} line item(s). Skipped ${skipped} duplicate order(s).`, "success");
    $("ebay-orders-file").value = "";
    await loadOrders();
  } catch (error) {
    console.error("eBay order import failed:", error);
    setImportStatus(error.message || "Could not import eBay orders.", "error");
  } finally {
    button.disabled = false;
  }
}

async function loadOrders() {
  const status = $("order-status-filter")?.value || "pending";
  const list = $("orders-list");
  if (list) list.innerHTML = `<div class="empty-state">Loading pending orders...</div>`;
  const admin = isAdminUser();
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
        status
      )
    `)
    .order("created_at", { ascending: false });

  if (status === "pending") {
    query = query.in("line_status", ["pending", "partially_fulfilled"]);
  } else if (status === "fulfilled") {
    query = query.eq("line_status", "fulfilled");
  } else {
    query = query.in("line_status", ["pending", "partially_fulfilled", "fulfilled"]);
  }

  const { data, error } = await query.limit(300);

  if (error) {
    console.error("Failed to load pending eBay orders:", error);
    if (list) list.innerHTML = `<div class="empty-state">Could not load eBay orders. Make sure the pending-order migration has been pushed.</div>`;
    return;
  }

  state.orders = (data || []).map(normalizeLine);
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
  state.filteredOrders = term
    ? state.orders.filter((line) => line.searchText.includes(term))
    : [...state.orders];

  renderOrders();
  renderSummaryStrip();
  renderAdminOrderActions();
}

function renderSummaryStrip() {
  const openLines = state.orders.filter(isOpenOrderLine);
  const pending = openLines.length;
  const shipToday = openLines.filter((line) => sameLocalDay(line.order?.ship_by_date)).length;
  $("summary-pending").textContent = String(pending);
  $("summary-ship-today").textContent = String(shipToday);
  $("summary-selected").textContent = state.selectedLine ? getBuyerLabel(state.selectedLine) : "None";
  $("order-count-pill").textContent = String(groupLinesByBuyer(state.filteredOrders).length);
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
  setTimeout(() => $("item-scan")?.focus(), 80);
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
      <span>${Number(row.quantity || 0).toLocaleString()} available${row.location_code ? ` - ${escapeHtml(row.location_code)}` : ""}</span>
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
  const { data, error } = await supabase
    .from("item_stock_locations")
    .select("id,item_id,location_id,quantity,location:location_id(*)")
    .eq("item_id", itemId)
    .gt("quantity", 0);

  if (error) {
    console.error("Source location load failed:", error);
    state.stockRows = [];
    renderLocationResults([], "Could not load source locations.");
    setStatus(error.message || "Could not load source locations.", "error");
    return;
  }

  state.stockRows = (data || [])
    .map(normalizeStockRow)
    .filter((row) => {
      return row.isTray
        && row.store_id === state.checkoutStoreId
        && row.tray_status !== "checked_out";
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

function openBundleReviewModal() {
  const staged = getActiveStagedFulfillments();
  if (!staged.length) {
    setStatus("Stage at least one packed item first.", "error");
    return;
  }

  const buyer = state.selectedLine ? getBuyerLabel(state.selectedLine) : "selected buyer";
  const totalQty = staged.reduce((sum, entry) => sum + Number(entry.qty || 0), 0);
  $("bundle-review-subtitle").textContent = `${buyer} - ${staged.length} line(s), ${totalQty} total unit(s). Press Enter to confirm after review.`;
  renderBundleReviewList(staged);
  openModal("bundle-review-modal");
  setTimeout(() => $("confirm-bundle-review")?.focus(), 80);
}

async function fulfillSelectedOrder({ skipReview = false } = {}) {
  if (state.busy) return;
  const notes = String($("fulfill-notes")?.value || "").trim();
  const staged = getActiveStagedFulfillments();

  if (!staged.length) return setStatus("Stage at least one packed item first.", "error");
  if (!skipReview) {
    openBundleReviewModal();
    return;
  }

  state.busy = true;
  closeModal("bundle-review-modal");
  $("fulfill-order").disabled = true;
  $("stage-current-line").disabled = true;
  setStatus(`Confirming and removing ${staged.length} packed item(s)...`);

  try {
    const changedItemIds = [];
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
  closeModal("item-confirm-modal");
  closeModal("bundle-review-modal");
  $("selected-order-empty")?.classList.remove("hidden");
  $("fulfillment-workflow")?.classList.add("hidden");
  renderOrders();
  renderSummaryStrip();
}

function setupListeners() {
  $("refresh-orders")?.addEventListener("click", async () => {
    clearOrderSearch({ apply: false });
    await loadOrders();
  });
  $("import-ebay-orders")?.addEventListener("click", importEbayOrdersFromCsv);
  $("ebay-orders-file")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0];
    setImportStatus(file ? `Ready to import ${file.name}. Duplicate eBay order numbers will be skipped.` : "");
  });
  $("order-search")?.addEventListener("input", applyOrderFilters);
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
  $("find-location")?.addEventListener("click", searchSourceLocation);
  $("stage-current-line")?.addEventListener("click", () => stageCurrentLine({ autoAdvance: true }));
  $("fulfill-order")?.addEventListener("click", fulfillSelectedOrder);
  $("clear-selection")?.addEventListener("click", clearSelection);
  $("confirm-item-choice")?.addEventListener("click", confirmItemCandidate);
  $("cancel-item-confirm")?.addEventListener("click", closeItemConfirmModal);
  $("close-item-confirm")?.addEventListener("click", closeItemConfirmModal);
  $("confirm-bundle-review")?.addEventListener("click", () => fulfillSelectedOrder({ skipReview: true }));
  $("cancel-bundle-review")?.addEventListener("click", closeBundleReviewModal);
  $("close-bundle-review")?.addEventListener("click", closeBundleReviewModal);

  $("item-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      clearItemSearchTimer();
      searchInventoryItems();
    }
  });

  $("item-scan")?.addEventListener("input", scheduleItemSearch);

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
  setupDashboardShell();
  setupImportVisibility();
  setupListeners();
  await loadCheckoutStores();
  clearOrderSearch({ apply: false });
  await loadOrders();
  if (window.lucide) window.lucide.createIcons();
});
