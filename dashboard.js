/** =================== Auth (Admin Only) =================== */
const dashboardState = {
  user: null,
  employee: null,
};

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
    .select("role, active, display_name, email, user_id")
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

  dashboardState.user = session.user;
  dashboardState.employee = employee;

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
const fmtMoneyFull = (n) => {
  const number = Number(n || 0);
  return number.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: number >= 1000 ? 0 : 2,
  });
};

const fmtPercent = (n) => {
  const number = Number(n);
  if (!Number.isFinite(number)) return "0%";
  return `${Math.round(number * 100)}%`;
};

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

  if (!dashboardState.user?.id) {
    container.innerHTML = `<div class="urgent-orders-empty">Sign in to see assigned store transfers.</div>`;
    return;
  }

  const { data, error } = await supabase
    .from("store_transfers")
    .select("id, transfer_number, source_store_id, destination_store_id, status, receiver_email, sender_email, created_at")
    .eq("receiver_user_id", dashboardState.user.id)
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

function getDashboardReturnCase(task = {}) {
  const entry = task.ebay_return_cases || task.return_case || {};
  return Array.isArray(entry) ? entry[0] || {} : entry;
}

function getDashboardReturnPayload(task = {}) {
  const returnCase = getDashboardReturnCase(task);
  return {
    ...(task.metadata || {}),
    ...(returnCase.raw_payload || {}),
  };
}

function firstReturnValue(...values) {
  return values.find((value) => String(value || "").trim()) || "";
}

function getDashboardReturnAmount(task = {}) {
  const payload = getDashboardReturnPayload(task);
  const detail = payload.returnDetails || {};
  return firstReturnValue(
    payload.requestAmount,
    detail.requestAmount,
    payload.refundText,
    detail.refundText,
    payload.onHoldAmount,
    detail.onHoldAmount
  );
}

function getDashboardReturnComment(task = {}) {
  const payload = getDashboardReturnPayload(task);
  const detail = payload.returnDetails || {};
  return firstReturnValue(
    payload.buyerComment,
    detail.buyerComment,
    payload.comment,
    payload.buyer_message,
    task.question,
    getDashboardReturnCase(task).notes
  );
}

function getDashboardReturnReason(task = {}) {
  const payload = getDashboardReturnPayload(task);
  const detail = payload.returnDetails || {};
  return firstReturnValue(
    getDashboardReturnCase(task).return_reason,
    payload.returnReason,
    detail.returnReason,
    payload.return_reason
  );
}

function getDashboardReturnItemLabel(task = {}) {
  const payload = getDashboardReturnPayload(task);
  const detail = payload.returnDetails || {};
  return firstReturnValue(
    payload.itemTitle,
    detail.itemTitle,
    payload.item_title,
    payload.itemNumber,
    detail.itemNumber,
    "No item title captured"
  );
}

function getDashboardReturnActionText(task = {}) {
  const payload = getDashboardReturnPayload(task);
  const detail = payload.returnDetails || {};
  return firstReturnValue(payload.returnAction, detail.returnAction, payload.return_action);
}

function getOrderTaskDashboardLabel(task = {}) {
  if (task.task_type === "admin_review") return "Admin";
  if (task.task_type === "worker_follow_up") return "Worker";
  if (task.task_type === "special_order") return "Special";
  return "Order";
}

async function loadAdminOrderTasks() {
  const container = document.getElementById("admin-order-tasks-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading order tasks...</div>`;

  const { data, error } = await supabase.rpc("list_my_ebay_order_tasks", { _limit: 6 });

  if (error) {
    console.warn("Failed to load assigned order coordination tasks:", error);
    container.innerHTML = `<div class="urgent-orders-empty">Could not load order tasks.</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No open order coordination tasks are assigned to you.</div>`;
    return;
  }

  container.innerHTML = data.map((task) => {
    const urgentClass = task.priority === "urgent" || task.priority === "high" || ["blocked", "deferred", "waiting_on_admin"].includes(task.status) ? "is-overdue" : "is-soon";
    return `
      <a class="urgent-order-card ${urgentClass}" href="pending-orders.html?orderTaskId=${encodeURIComponent(task.id)}#order-task-panel">
        <div class="urgent-order-top">
          <div>
            <strong>${escapeHtml(task.buyer_username || "eBay buyer")}</strong>
            <span>${escapeHtml(task.order_number || "Pending order")}</span>
          </div>
          <span class="urgent-order-badge">${escapeHtml(getOrderTaskDashboardLabel(task))}</span>
        </div>
        <small>${escapeHtml(task.latest_note || task.question || task.title || "Order needs attention")}</small>
        <div class="urgent-order-meta">
          <span>${escapeHtml(String(task.status || "open").replace(/_/g, " "))} / ${escapeHtml(task.priority || "normal")}</span>
          <span>Assigned: ${escapeHtml(task.assigned_to_email || "Unassigned")}</span>
          <span>Ship by ${escapeHtml(task.ship_by_date ? formatShipBy(task.ship_by_date) : "not set")}</span>
        </div>
      </a>
    `;
  }).join("");
}

function getTeamTaskDashboardLabel(task = {}) {
  if (task.task_type === "inventory") return "Inventory";
  if (task.task_type === "shipping") return "Shipping";
  if (task.task_type === "customer_service") return "Customer";
  if (task.task_type === "maintenance") return "Maintenance";
  if (task.task_type === "admin_review") return "Admin";
  return "Team";
}

async function loadAdminTeamTasks() {
  const container = document.getElementById("admin-team-tasks-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading team tasks...</div>`;

  const { data, error } = await supabase
    .from("team_tasks")
    .select("id, task_type, title, description, status, priority, assigned_to_email, assigned_to_user_id, due_at, created_at, latest_note, latest_photo_count, created_by_email")
    .eq("assigned_to_user_id", dashboardState.user?.id)
    .in("status", ["open", "assigned", "in_progress", "waiting_on_admin", "waiting_on_worker", "blocked", "deferred"])
    .order("created_at", { ascending: true })
    .limit(6);

  if (error) {
    console.warn("Failed to load assigned team tasks:", error);
    container.innerHTML = `<div class="urgent-orders-empty">Could not load team tasks.</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No independent team tasks are assigned to you.</div>`;
    return;
  }

  container.innerHTML = data.map((task) => {
    const urgentClass = task.priority === "urgent" || task.priority === "high" || ["blocked", "deferred", "waiting_on_admin"].includes(task.status) ? "is-overdue" : "is-soon";
    return `
      <a class="urgent-order-card ${urgentClass}" href="team-tasks.html?taskId=${encodeURIComponent(task.id)}">
        <div class="urgent-order-top">
          <div>
            <strong>${escapeHtml(task.title || "Team task")}</strong>
            <span>${escapeHtml(task.assigned_to_email || "Unassigned")}</span>
          </div>
          <span class="urgent-order-badge">${escapeHtml(getTeamTaskDashboardLabel(task))}</span>
        </div>
        <small>${escapeHtml(task.latest_note || task.description || "Task needs attention")}</small>
        <div class="urgent-order-meta">
          <span>${escapeHtml(String(task.status || "open").replace(/_/g, " "))} / ${escapeHtml(task.priority || "normal")}</span>
          <span>Due ${escapeHtml(task.due_at ? formatDateTime(task.due_at) : "not set")}</span>
          <span>Created: ${escapeHtml(task.created_by_email || "logged-in user")}</span>
        </div>
      </a>
    `;
  }).join("");
}

async function loadAdminReturnTasks() {
  const container = document.getElementById("admin-return-tasks-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading return tasks...</div>`;

  if (!dashboardState.user?.id) {
    container.innerHTML = `<div class="urgent-orders-empty">Sign in to see assigned return tasks.</div>`;
    return;
  }

  const { data, error } = await supabase
    .from("ebay_return_tasks")
    .select("id, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, due_at, created_at, metadata, ebay_return_cases(id, order_number, ebay_return_id, buyer_username, return_reason, return_tracking_number, status, opened_at, notes, raw_payload, case_type)")
    .eq("assigned_to_user_id", dashboardState.user.id)
    .in("status", ["open", "assigned", "in_progress", "blocked", "deferred"])
    .order("created_at", { ascending: true })
    .limit(6);

  if (error) {
    console.warn("Failed to load assigned return tasks:", error);
    container.innerHTML = `<div class="urgent-orders-empty">Could not load return tasks.</div>`;
    return;
  }

  if (!data?.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No open return tasks are assigned to you.</div>`;
    return;
  }

  container.innerHTML = data.map((task) => {
    const returnCase = getDashboardReturnCase(task);
    const returnId = returnCase.ebay_return_id || returnCase.id || "Return case";
    const orderLabel = returnCase.order_number || (returnCase.case_type === "unmatched_legacy" ? "No OG order match" : "No order captured");
    const amount = getDashboardReturnAmount(task) || "Not captured";
    const reason = getDashboardReturnReason(task) || "No reason captured";
    const comment = getDashboardReturnComment(task) || "No buyer comment captured";
    const itemLabel = getDashboardReturnItemLabel(task);
    const actionText = getDashboardReturnActionText(task);
    const urgentClass = task.priority === "urgent" || task.priority === "high" || ["blocked", "deferred"].includes(task.status) ? "is-overdue" : "is-soon";
    return `
      <a class="urgent-order-card ${urgentClass}" href="ebay-returns.html?returnTaskId=${encodeURIComponent(task.id)}#return-work-queue">
        <div class="urgent-order-top">
          <div>
            <strong>${escapeHtml(returnCase.buyer_username || "eBay return")}</strong>
            <span>${escapeHtml(orderLabel)} / Return ${escapeHtml(returnId)}</span>
          </div>
          <span class="urgent-order-badge">${escapeHtml(getReturnTaskDashboardLabel(task))}</span>
        </div>
        <div class="urgent-return-facts">
          <span><small>Value</small><b>${escapeHtml(amount)}</b></span>
          <span><small>Reason</small><b>${escapeHtml(reason)}</b></span>
          <span><small>Due</small><b>${escapeHtml(task.due_at ? formatDateTime(task.due_at) : "Not set")}</b></span>
        </div>
        <small class="urgent-return-comment"><b>Buyer:</b> ${escapeHtml(comment)}</small>
        <small>${escapeHtml(itemLabel)}</small>
        <div class="urgent-order-meta">
          <span>${escapeHtml(String(task.status || "open").replace(/_/g, " "))} / ${escapeHtml(task.priority || "normal")}</span>
          ${actionText ? `<span>${escapeHtml(actionText)}</span>` : ""}
        </div>
      </a>
    `;
  }).join("");
}

function renderBuyerProfitabilitySummary(rows = []) {
  const summary = document.getElementById("buyer-profitability-summary");
  if (!summary) return;

  if (!rows.length) {
    summary.innerHTML = `<span>No synced buyer history yet.</span>`;
    return;
  }

  const totals = rows.reduce((acc, row) => {
    acc.buyers += 1;
    acc.orders += Number(row.order_count || 0);
    acc.units += Number(row.unit_count || 0);
    acc.gross += Number(row.gross_sales || 0);
    acc.net += Number(row.net_payout || 0);
    acc.openReturns += Number(row.open_return_count || 0);
    return acc;
  }, { buyers: 0, orders: 0, units: 0, gross: 0, net: 0, openReturns: 0 });

  summary.innerHTML = `
    <span><b>${totals.buyers}</b> buyers shown</span>
    <span><b>${totals.orders}</b> orders</span>
    <span><b>${totals.units}</b> units</span>
    <span><b>${fmtMoneyFull(totals.gross)}</b> gross</span>
    <span><b>${fmtMoneyFull(totals.net)}</b> est. payout</span>
    <span><b>${totals.openReturns}</b> open returns</span>
  `;
}

function renderBuyerProfitabilityCard(row, index) {
  const buyer = row.buyer_username || "Unknown buyer";
  const buyerName = row.buyer_name && row.buyer_name !== row.buyer_username ? row.buyer_name : "";
  const orderCount = Number(row.order_count || 0);
  const unitCount = Number(row.unit_count || 0);
  const returnCount = Number(row.return_count || 0);
  const openReturns = Number(row.open_return_count || 0);
  const cancelledOrders = Number(row.cancelled_order_count || 0);
  const pendingOrders = Number(row.pending_order_count || 0);
  const lastPurchase = row.last_purchase_at ? formatDateTime(row.last_purchase_at) : "No date";
  const returnClass = openReturns > 0 ? "is-hot" : returnCount > 0 ? "is-warm" : "";

  return `
    <a class="buyer-profit-card ${index === 0 ? "is-top-buyer" : ""}" href="ebay-order-history.html?buyer=${encodeURIComponent(buyer)}">
      <div class="buyer-profit-card-top">
        <div class="buyer-profit-rank">#${index + 1}</div>
        <div class="buyer-profit-identity">
          <strong>${escapeHtml(buyer)}</strong>
          ${buyerName ? `<span>${escapeHtml(buyerName)}</span>` : ""}
        </div>
        <div class="buyer-profit-value">
          <small>Est. payout</small>
          <b>${fmtMoneyFull(row.net_payout)}</b>
        </div>
      </div>

      <div class="buyer-profit-metrics">
        <span><small>Gross</small><b>${fmtMoneyFull(row.gross_sales)}</b></span>
        <span><small>Orders</small><b>${orderCount}</b></span>
        <span><small>Units</small><b>${unitCount}</b></span>
        <span><small>Avg order</small><b>${fmtMoneyFull(row.avg_order_value)}</b></span>
      </div>

      <div class="buyer-profit-foot">
        <span>Last: ${escapeHtml(lastPurchase)}</span>
        ${row.last_order_number ? `<span>${escapeHtml(row.last_order_number)}</span>` : ""}
      </div>

      <div class="buyer-profit-flags">
        <span class="${returnClass}">${returnCount} returns (${fmtPercent(row.return_rate)})</span>
        ${openReturns ? `<span class="is-hot">${openReturns} open</span>` : ""}
        ${pendingOrders ? `<span>${pendingOrders} pending</span>` : ""}
        ${cancelledOrders ? `<span>${cancelledOrders} canceled</span>` : ""}
      </div>
    </a>
  `;
}

async function loadBuyerProfitability() {
  const container = document.getElementById("buyer-profitability-container");
  if (!container) return;
  container.innerHTML = `<div class="urgent-orders-empty">Loading buyer profitability...</div>`;

  const { data, error } = await supabase.rpc("list_ebay_buyer_profitability", {
    _limit: 12,
    _days_back: null,
  });

  if (error) {
    console.warn("Failed to load buyer profitability:", error);
    renderBuyerProfitabilitySummary([]);
    container.innerHTML = `<div class="urgent-orders-empty">Could not load buyer profitability. Push the latest migration if this is the first run.</div>`;
    return;
  }

  const rows = Array.isArray(data) ? data : [];
  renderBuyerProfitabilitySummary(rows);

  if (!rows.length) {
    container.innerHTML = `<div class="urgent-orders-empty">No synced eBay buyer history yet.</div>`;
    return;
  }

  container.innerHTML = rows.map(renderBuyerProfitabilityCard).join("");
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
  await loadAdminOrderTasks();
  await loadAdminTeamTasks();
  await loadAdminReturnTasks();
  await loadBuyerProfitability();

  const items = await loadInventoryData();
  const summary = computeSummaryByCategory(items);

  renderMetricCards(summary);
  await loadTrayAlerts();
  renderCategoryTable(summary);
  renderCategoryChart(summary);
});

