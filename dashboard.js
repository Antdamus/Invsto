/** =================== Auth (Admin Only) =================== */
/** =================== Supabase Ready Guard =================== */
function waitForSupabaseReady(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve(window.supabase);

    let done = false;
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("Supabase not ready (timeout). Did initSupabase.js load and finish?"));
    }, timeoutMs);

    document.addEventListener("supabase-ready", () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      resolve(window.supabase);
    }, { once: true });
  });
}


async function checkAuth() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();

  // Not logged in -> go to login
  if (sessionError) console.error("❌ Session error:", sessionError);
  if (!session) {
    window.location.href = "index.html";
    return false;
  }

  const userId = session.user.id;

  // Fetch the employee record for the current user (RLS allows self-select)
  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active, display_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (employeeError) {
    console.error("❌ Failed to fetch employee record:", employeeError);
    window.location.href = "index.html";
    return false;
  }

  // If no employee record exists, treat as unauthorized
  if (!employee) {
    console.warn("⚠️ No employee record found for user:", userId);
    window.location.href = "index.html";
    return false;
  }

  // Optional: if employee is inactive, block access
  if (employee.active === false) {
    console.warn("⚠️ Employee is inactive:", userId);
    window.location.href = "index.html";
    return false;
  }

  const role = String(employee.role || "").toLowerCase();

  // Not admin -> redirect to worker dashboard (future page)
  if (role !== "admin") {
    window.location.href = "worker-dashboard.html";
    return false;
  }

  // Admin -> allowed
  const greeting = document.getElementById("admin-greeting");
  if (greeting) {
    const name = employee.display_name ? `, ${employee.display_name}` : "";
    greeting.textContent = `Welcome, Admin${name}`;
  }

  return true;
}

/** =================== Active Nav =================== */
function setActiveNavLink() {
  const path = (location.pathname || "").split("/").pop() || "dashboard.html";
  document.querySelectorAll(".nav-link").forEach(a => {
    const href = (a.getAttribute("href") || "").split("/").pop();
    if (href && href === path) a.classList.add("active");
  });
}

/** =================== Formatters =================== */
const fmtMoney = (n) => `$${Number(n || 0).toLocaleString()}`;

const TRAY_STATUS_LABELS = {
  checked_in: "Checked In",
  checked_out: "Checked Out",
  in_transfer: "In Transfer",
  weight_mismatch: "Weight Mismatch",
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })} g`;
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "--";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function sameLocalDay(a, b = new Date()) {
  if (!a) return false;
  const date = new Date(a);
  if (Number.isNaN(date.getTime())) return false;
  return date.getFullYear() === b.getFullYear()
    && date.getMonth() === b.getMonth()
    && date.getDate() === b.getDate();
}

function startOfLocalDay(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function getOrderFromLine(line) {
  const order = line?.ebay_orders || line?.order || {};
  return Array.isArray(order) ? order[0] || {} : order;
}

function getRemainingLineQuantity(line) {
  return Math.max(0, Number(line?.quantity || 0) - Number(line?.fulfilled_quantity || 0));
}

function getUrgentOrderState(shipByDate) {
  if (!shipByDate) {
    return { label: "No ship date", className: "is-normal", rank: 4, dueDate: null };
  }

  const dueDate = new Date(shipByDate);
  if (Number.isNaN(dueDate.getTime())) {
    return { label: "No ship date", className: "is-normal", rank: 4, dueDate: null };
  }

  const dueDay = startOfLocalDay(dueDate);
  const today = startOfLocalDay();
  const tomorrow = startOfLocalDay();
  tomorrow.setDate(tomorrow.getDate() + 1);

  if (dueDay < today) return { label: "Overdue", bucket: "overdue", className: "is-overdue", rank: 0, dueDate };
  if (sameLocalDay(dueDate, today)) return { label: "Due today", bucket: "today", className: "is-today", rank: 1, dueDate };
  if (dueDay.getTime() === tomorrow.getTime()) return { label: "Due tomorrow", bucket: "tomorrow", className: "is-tomorrow", rank: 2, dueDate };
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
        order,
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

function getUrgentDeadlineStats(groups = []) {
  const stats = {
    overdue: { label: "Overdue", buyers: new Set(), orders: 0, lines: 0, value: 0 },
    today: { label: "Due Today", buyers: new Set(), orders: 0, lines: 0, value: 0 },
    tomorrow: { label: "Due Tomorrow", buyers: new Set(), orders: 0, lines: 0, value: 0 },
    later: { label: "Later", buyers: new Set(), orders: 0, lines: 0, value: 0 },
  };

  groups.forEach((group) => {
    const bucket = group.urgency?.bucket || "later";
    if (!stats[bucket]) return;
    stats[bucket].orders += 1;
    stats[bucket].lines += Number(group.pendingLines || 0);
    stats[bucket].value += Number(group.order?.total_price || 0);
    if (group.buyer) stats[bucket].buyers.add(group.buyer);
  });

  return stats;
}

function renderUrgentDeadlineStats(stats = null, state = "ready") {
  const host = document.getElementById("urgent-due-breakdown");
  if (!host) return;

  if (state === "loading") {
    host.innerHTML = `<span class="urgent-due-chip is-loading">Loading deadlines...</span>`;
    return;
  }

  if (state === "error") {
    host.innerHTML = `<span class="urgent-due-chip is-error">Could not load deadline counts</span>`;
    return;
  }

  const orderWord = (count) => count === 1 ? "order" : "orders";
  const itemWord = (count) => count === 1 ? "item" : "items";
  host.innerHTML = ["overdue", "today", "tomorrow", "later"].map((key) => {
    const bucket = stats[key];
    const buyers = bucket.buyers.size;
    return `
      <span class="urgent-due-chip is-${key}">
        <b>${escapeHtml(bucket.label)}</b>
        <strong>${bucket.orders.toLocaleString()} ${orderWord(bucket.orders)}</strong>
        <small>${buyers.toLocaleString()} buyer${buyers === 1 ? "" : "s"} / ${bucket.lines.toLocaleString()} ${itemWord(bucket.lines)}</small>
        <em>${fmtMoney(bucket.value)} value</em>
      </span>
    `;
  }).join("");
}

async function loadUrgentOrders() {
  const container = document.getElementById("urgent-orders-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading urgent orders...</div>`;
  renderUrgentDeadlineStats(null, "loading");

  const { data, error } = await supabase
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
        total_price,
        status
      )
    `)
    .in("line_status", ["pending", "partially_fulfilled"])
    .limit(1000);

  if (error) {
    console.error("Failed to load urgent eBay orders:", error);
    container.innerHTML = `<div class="urgent-orders-empty">Could not load urgent eBay orders.</div>`;
    renderUrgentDeadlineStats(null, "error");
    return;
  }

  const groups = groupUrgentOrderLines(data || []);
  renderUrgentDeadlineStats(getUrgentDeadlineStats(groups));
  const urgentGroups = groups.filter((group) => group.urgency.rank <= 2).slice(0, 6);

  if (!urgentGroups.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No eBay orders are overdue, due today, or due tomorrow.</div>`;
    return;
  }

  container.innerHTML = urgentGroups.map((group) => {
    const titlePreview = group.titles.slice(0, 2).join(" / ") || "Pending item";
    const extra = group.titles.length > 2 ? ` +${group.titles.length - 2} more` : "";
    const orderValue = Number(group.order?.total_price || 0);
    return `
      <a class="urgent-order-card ${group.urgency.className}" href="pending-orders.html">
        <div class="urgent-order-top">
          <div>
            <strong>${escapeHtml(group.buyer)}</strong>
            <span>${escapeHtml(group.orderNumber)}</span>
            <span class="urgent-order-value">${fmtMoney(orderValue)}</span>
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

async function loadStoreTransferAlerts() {
  const container = document.getElementById("store-transfer-alerts-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading store transfers...</div>`;

  const { data, error } = await supabase
    .from("store_transfers")
    .select("id, transfer_number, source_store_id, destination_store_id, status, receiver_email, sender_email, created_at")
    .in("status", ["pending_receipt", "partially_received", "exception"])
    .order("created_at", { ascending: true })
    .limit(6);

  if (error) {
    container.innerHTML = `<div class="urgent-orders-empty">Could not load store transfers.</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No open store transfers need attention.</div>`;
    return;
  }

  const storeIds = [...new Set(data.flatMap((row) => [row.source_store_id, row.destination_store_id]).filter(Boolean))];
  const { data: stores } = await supabase
    .from("store_locations")
    .select("id, name")
    .in("id", storeIds);
  const storeMap = Object.fromEntries((stores || []).map((store) => [store.id, store.name]));

  container.innerHTML = data.map((transfer) => {
    const isException = transfer.status === "exception";
    return `
      <a class="urgent-order-card ${isException ? "is-overdue" : "is-soon"}" href="store-transfers.html">
        <div class="urgent-order-top">
          <strong>${escapeHtml(transfer.transfer_number || "Store transfer")}</strong>
          <span class="urgent-order-badge">${escapeHtml(transfer.status.replace(/_/g, " "))}</span>
        </div>
        <div class="urgent-order-meta">
          <span>${escapeHtml(storeMap[transfer.source_store_id] || "Source")} to ${escapeHtml(storeMap[transfer.destination_store_id] || "Destination")}</span>
          <span>Receiver: ${escapeHtml(transfer.receiver_email || "-")}</span>
          <span>Created ${escapeHtml(formatDateTime(transfer.created_at))}</span>
        </div>
      </a>
    `;
  }).join("");
}

function getReturnTaskDashboardLabel(task = {}) {
  if (task.task_type === "return_intake") return "Intake";
  if (task.task_type === "return_review") return "Review";
  if (task.task_type === "question") return "Question";
  return "Return";
}

async function loadAdminReturnTasks() {
  const container = document.getElementById("admin-return-tasks-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading return tasks...</div>`;

  const { data, error } = await supabase
    .from("ebay_return_tasks")
    .select("id, task_type, title, question, status, priority, assigned_to_email, due_at, created_at, ebay_return_cases(order_number, ebay_return_id, buyer_username, return_reason)")
    .in("status", ["open", "assigned", "in_progress", "blocked"])
    .order("created_at", { ascending: true })
    .limit(6);

  if (error) {
    console.warn("Failed to load return tasks:", error);
    container.innerHTML = `<div class="urgent-orders-empty">Could not load return tasks.</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No open return tasks need attention.</div>`;
    return;
  }

  container.innerHTML = data.map((task) => {
    const returnCase = Array.isArray(task.ebay_return_cases) ? task.ebay_return_cases[0] || {} : task.ebay_return_cases || {};
    const urgentClass = task.priority === "urgent" || task.priority === "high" || task.status === "blocked" ? "is-overdue" : "is-soon";
    return `
      <a class="urgent-order-card ${urgentClass}" href="ebay-order-history.html?returnTaskId=${encodeURIComponent(task.id)}#return-work-queue">
        <div class="urgent-order-top">
          <div>
            <strong>${escapeHtml(returnCase.buyer_username || "eBay return")}</strong>
            <span>${escapeHtml(returnCase.order_number || returnCase.ebay_return_id || "Return case")}</span>
          </div>
          <span class="urgent-order-badge">${escapeHtml(getReturnTaskDashboardLabel(task))}</span>
        </div>
        <small>${escapeHtml(task.question || task.title || returnCase.return_reason || "Return needs attention")}</small>
        <div class="urgent-order-meta">
          <span>${escapeHtml(task.status.replace(/_/g, " "))} / ${escapeHtml(task.priority)}</span>
          <span>Assigned: ${escapeHtml(task.assigned_to_email || "Unassigned")}</span>
          <span>Due ${escapeHtml(task.due_at ? formatDateTime(task.due_at) : "not set")}</span>
        </div>
      </a>
    `;
  }).join("");
}

/** =================== Data Loading =================== */
async function loadInventoryData() {
  const { data: itemTypes, error: itemTypeError } = await supabase
    .from("item_types")
    .select("*");

  const { data: stockData, error: stockError } = await supabase
    .from("item_stock_locations")
    .select("item_id, quantity");

  if (itemTypeError || stockError) {
    console.error("❌ Failed to fetch data", itemTypeError || stockError);
    return [];
  }

  const quantityMap = {};
  for (const stock of (stockData || [])) {
    if (!quantityMap[stock.item_id]) quantityMap[stock.item_id] = 0;
    quantityMap[stock.item_id] += stock.quantity;
  }

  const allItems = [];
  for (const item of (itemTypes || [])) {
    const quantity = quantityMap[item.id] || 0;
    const categoryList = Array.isArray(item.categories) ? item.categories : [];
    if (quantity > 0 && !categoryList.includes("testcard")) {
      allItems.push({
        ...item,
        quantity,
        totalCost: Number(item.cost || 0) * quantity,
        totalValue: Number(item.sale_price || 0) * quantity,
      });
    }
  }

  return allItems;
}

/** =================== Data Summary =================== */
function computeSummaryByCategory(items) {
  const summary = {
    totalItems: 0,
    totalCost: 0,
    totalValue: 0,
    categories: {},
  };

  for (const item of (items || [])) {
    const categoryList = Array.isArray(item.categories) ? item.categories : [];
    if (categoryList.includes("testcard")) continue;

    const quantity = Number(item.quantity || 0);
    const totalCost = Number(item.totalCost || 0);
    const totalValue = Number(item.totalValue || 0);

    summary.totalItems += quantity;
    summary.totalCost += totalCost;
    summary.totalValue += totalValue;

    for (const category of categoryList) {
      if (!summary.categories[category]) {
        summary.categories[category] = {
          category,
          quantity: 0,
          totalCost: 0,
          totalValue: 0,
        };
      }

      summary.categories[category].quantity += quantity;
      summary.categories[category].totalCost += totalCost;
      summary.categories[category].totalValue += totalValue;
    }
  }

  return summary;
}

/** =================== UI Rendering =================== */
function renderMetricCards(summary) {
  const container = document.getElementById("metric-cards");
  if (!container) return;

  const markup = summary.totalCost ? (summary.totalValue / summary.totalCost) : null;

  container.innerHTML = `
    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Total Value</div>
        <div class="metric-icon">💎</div>
      </div>
      <div class="metric-value">${fmtMoney(summary.totalValue)}</div>
      <div class="metric-foot">Estimated retail value</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Total Items</div>
        <div class="metric-icon">📦</div>
      </div>
      <div class="metric-value">${Number(summary.totalItems || 0).toLocaleString()}</div>
      <div class="metric-foot">Units currently in stock</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Total Cost</div>
        <div class="metric-icon">🧾</div>
      </div>
      <div class="metric-value">${fmtMoney(summary.totalCost)}</div>
      <div class="metric-foot">Total inventory cost basis</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Avg Markup</div>
        <div class="metric-icon">📈</div>
      </div>
      <div class="metric-value">${markup ? `${markup.toFixed(2)}x` : "—"}</div>
      <div class="metric-foot">Value / cost multiplier</div>
    </div>
  `;
}

async function loadTrayAlerts() {
  const container = document.getElementById("tray-alerts-container");
  if (!container) return;

  container.innerHTML = `<div class="tray-watch-empty">Loading tray status...</div>`;

  const [{ data: trays, error: trayError }, { data: stores, error: storeError }] = await Promise.all([
    supabase
      .from("locations")
      .select("id, location_name, location_code, store_id, is_tray, tray_status, tray_current_store_id, tray_last_checkout_weight, tray_last_checkin_weight, tray_last_weight_delta, tray_weight_tolerance_grams, tray_checked_out_at, tray_checked_in_at")
      .eq("is_tray", true)
      .in("tray_status", ["checked_out", "in_transfer", "weight_mismatch"])
      .order("updated_at", { ascending: false }),
    supabase.from("store_locations").select("id, name"),
  ]);

  if (trayError || storeError) {
    console.error("Failed to load tray alerts:", trayError || storeError);
    container.innerHTML = `<div class="tray-watch-empty is-error">Could not load tray watch.</div>`;
    return;
  }

  const storeMap = new Map((stores || []).map((store) => [store.id, store.name]));
  const activeTrays = trays || [];

  if (!activeTrays.length) {
    container.innerHTML = `<div class="tray-watch-empty">All mobile trays are checked in with no weight flags.</div>`;
    return;
  }

  container.innerHTML = activeTrays.map((tray) => {
    const storeName = storeMap.get(tray.tray_current_store_id) || storeMap.get(tray.store_id) || "Unassigned";
    const statusLabel = TRAY_STATUS_LABELS[tray.tray_status] || tray.tray_status || "Tray Alert";
    const isMismatch = tray.tray_status === "weight_mismatch";
    return `
      <a class="tray-alert-card ${isMismatch ? "is-mismatch" : ""}" href="locations.html">
        <div>
          <span class="tray-alert-kicker">${escapeHtml(statusLabel)}</span>
          <strong>${escapeHtml(tray.location_name || "Unnamed Tray")}</strong>
          <span>${escapeHtml(tray.location_code || "No barcode")} - ${escapeHtml(storeName)}</span>
        </div>
        <div class="tray-alert-metrics">
          <span>Checkout: <b>${formatWeight(tray.tray_last_checkout_weight)}</b></span>
          <span>Check-in: <b>${formatWeight(tray.tray_last_checkin_weight)}</b></span>
          <span>Delta: <b>${formatWeight(tray.tray_last_weight_delta)}</b></span>
        </div>
        <div class="tray-alert-foot">
          <span>Tolerance ${formatWeight(tray.tray_weight_tolerance_grams || 10)}</span>
          <span>${formatDateTime(tray.tray_checked_in_at || tray.tray_checked_out_at)}</span>
        </div>
      </a>
    `;
  }).join("");
}

function getSortedCategories(summary) {
  return Object.values(summary.categories || {})
    .filter(c => c && c.category)
    .sort((a, b) => (Number(b.totalValue || 0) - Number(a.totalValue || 0)));
}

function renderCategoryTable(summary) {
  const tableContainer = document.getElementById("inventory-table-container");
  if (!tableContainer) return;

  const categories = getSortedCategories(summary);

  if (!categories.length) {
    tableContainer.innerHTML = `
      <div class="table-wrapper">
        <div style="padding:16px; color: rgba(242,243,245,.72);">
          No inventory data to display yet.
        </div>
      </div>
    `;
    return;
  }

  const rows = categories.map(cat => `
    <tr>
      <td>${cat.category}</td>
      <td>${Number(cat.quantity || 0).toLocaleString()}</td>
      <td>${fmtMoney(cat.totalCost)}</td>
      <td>${fmtMoney(cat.totalValue)}</td>
      <td>${cat.totalCost ? (cat.totalValue / cat.totalCost).toFixed(2) : '—'}x</td>
    </tr>
  `).join("");

  tableContainer.innerHTML = `
    <div class="table-wrapper">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Category</th>
            <th># Items</th>
            <th>Total Cost</th>
            <th>Total Value</th>
            <th>Avg Markup</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

/** =================== Chart =================== */
let _categoryChart = null;

function renderCategoryChart(summary) {
  const canvas = document.getElementById("category-chart");
  if (!canvas) return;

  const categories = getSortedCategories(summary);
  const ctx = canvas.getContext("2d");

  // If no categories, clear chart area gracefully
  if (!categories.length) {
    if (_categoryChart) {
      _categoryChart.destroy();
      _categoryChart = null;
    }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Prevent duplicate instances
  if (_categoryChart) {
    _categoryChart.destroy();
    _categoryChart = null;
  }

  _categoryChart = new Chart(ctx, {
    type: "doughnut",
    data: {
      labels: categories.map(c => c.category),
      datasets: [{
        data: categories.map(c => Number(c.totalValue || 0)),
        backgroundColor: generateColors(categories.length),
        borderWidth: 1,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: { position: "bottom" },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.label}: ${fmtMoney(ctx.parsed)}`
          },
        },
      },
    },
  });
}

function generateColors(count) {
  const base = [
    "#74b9ff", "#55efc4", "#ffeaa7", "#fab1a0", "#a29bfe",
    "#fd79a8", "#81ecec", "#e17055", "#00cec9", "#fdcb6e"
  ];
  const colors = [];
  for (let i = 0; i < count; i++) colors.push(base[i % base.length]);
  return colors;
}

/** =================== Navigation =================== */
function setupNavigation() {
  document.getElementById("logout")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await supabase.auth.signOut();
    window.location.href = "index.html";
  });

  document.getElementById("logout-mobile")?.addEventListener("click", async (e) => {
    e.preventDefault();
    await supabase.auth.signOut();
    window.location.href = "index.html";
  });

  document.getElementById("menu-toggle")?.addEventListener("click", () => {
    document.getElementById("mobile-menu")?.classList.toggle("show");
  });

  if (typeof lucide !== "undefined") {
    lucide.createIcons();
  }
}

/** =================== Init =================== */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    await waitForSupabaseReady(); // ✅ ensures window.supabase exists + init finished
  } catch (e) {
    console.error("❌ Supabase failed to initialize:", e);
    // Optional: redirect to login or show an error banner
    return;
  }

  const allowed = await checkAuth();
  if (!allowed) return;

  setActiveNavLink();

  const pill = document.getElementById("pill-date");
  if (pill) {
    const d = new Date();
    const nice = d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "2-digit" });
    pill.innerHTML = `Date: <b>${nice}</b>`;
  }

  setupNavigation();
  await loadUrgentOrders();
  await loadStoreTransferAlerts();
  await loadAdminReturnTasks();

  const items = await loadInventoryData();
  const summary = computeSummaryByCategory(items);

  renderMetricCards(summary);
  await loadTrayAlerts();
  renderCategoryTable(summary);
  renderCategoryChart(summary);
});

