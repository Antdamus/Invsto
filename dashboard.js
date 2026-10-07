/* A read-only operational overview. Detailed workflows stay on their own pages. */
const dashboardState = {
  user: null, employee: null, orders: null, tasks: null,
  orderFilter: "overdue", taskFilter: "all", orderFilterChosen: false,
  refreshing: null, updatedAt: 0, reports: new Map(),
};
const DASH_PAGE_SIZE = 500;
const DASH_PREVIEW_SIZE = 4;
// Keep these states and the personal/admin scope aligned with team-tasks.js.
const DASH_ACTIVE_TASK_STATUSES = ["open", "assigned", "in_progress", "waiting_on_admin", "waiting_on_worker", "blocked", "deferred", "pending_admin_review", "needs_subtasks", "waiting_on_subtasks", "ready_for_admin_approval", "assigned_for_shipping", "completed_by_employee", "sent_back_for_rework"];
const DASH_RETURN_TASK_STATUSES = ["open", "assigned", "in_progress", "blocked", "deferred"];
const DASH_REVIEW_STATUSES = new Set(["waiting_on_admin", "pending_admin_review", "ready_for_admin_approval", "completed_by_employee"]);
const DASH_PARENT_TYPES = new Set(["coordination", "admin_review", "pending_admin_review", "worker_follow_up", "special_order"]);
const dashEl = id => document.getElementById(id);
const dashText = (id, value) => { const el = dashEl(id); if (el) el.textContent = value; };
const dashNumber = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const dashCount = value => dashNumber(value).toLocaleString();
const dashMoney = value => new Intl.NumberFormat(undefined, {style: "currency", currency: "USD", maximumFractionDigits: 0}).format(dashNumber(value));
const dashOne = value => Array.isArray(value) ? value[0] || {} : value || {};
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, char => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[char]);
}
function dashWords(count, single, plural = `${single}s`) { return `${dashCount(count)} ${count === 1 ? single : plural}`; }
function dashDate(value, includeTime = false) {
  if (!value || Number.isNaN(new Date(value).getTime())) return "No date set";
  return new Date(value).toLocaleString(undefined, {month: "short", day: "numeric", ...(includeTime ? {hour: "numeric", minute: "2-digit"} : {})});
}
function deadlineBucket(value, now = new Date()) {
  const date = value ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return "undated";
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const later = new Date(tomorrow); later.setDate(tomorrow.getDate() + 1);
  return date < today ? "overdue" : date < tomorrow ? "today" : date < later ? "tomorrow" : "later";
}
function dashError(hostId, retry, title) {
  const host = dashEl(hostId);
  if (!host) return;
  host.setAttribute("aria-busy", "false");
  host.innerHTML = `<div class="dash-empty"><strong>${escapeHtml(title)}</strong>Try refreshing to get the latest information.<br><button class="dash-button" data-retry="${retry}">Try again</button></div>`;
}
function setDashboardStatus(message = "") {
  dashText("dashboard-status", message);
  dashEl("dashboard-status").hidden = !message;
}

// Select only summary fields, and page all rows so totals never stop at the API's row cap.
// RLS and existing authorization remain in force for every read.
async function dashboardQuery(query) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const result = await query.abortSignal(controller.signal);
    if (result.error) throw result.error;
    return result;
  } finally { clearTimeout(timer); }
}
async function dashboardPages(buildQuery) {
  const rows = [];
  for (let offset = 0; ; offset += DASH_PAGE_SIZE) {
    const {data} = await dashboardQuery(buildQuery().order("id", {ascending: true}).range(offset, offset + DASH_PAGE_SIZE - 1));
    rows.push(...(data || []));
    if (!data || data.length < DASH_PAGE_SIZE) return rows;
  }
}

function summarizePendingOrders(lines, now = new Date()) {
  const byOrder = new Map();
  const seenLines = new Set();
  for (const line of lines) {
    if (seenLines.has(line.id) || !["pending", "partially_fulfilled"].includes(line.line_status)) continue;
    seenLines.add(line.id);
    const remaining = Math.max(0, dashNumber(line.quantity) - dashNumber(line.fulfilled_quantity));
    if (!remaining) continue;
    const order = dashOne(line.ebay_orders);
    const key = order.id || line.order_id;
    if (!key) continue;
    if (!byOrder.has(key)) byOrder.set(key, {
      id: key, number: order.order_number || "", buyer: order.buyer_username || "",
      shipBy: order.ship_by_date, bucket: deadlineBucket(order.ship_by_date, now),
      units: 0, lines: 0, titles: [], notes: [],
    });
    const group = byOrder.get(key);
    group.units += remaining; group.lines++;
    if (line.item_title) group.titles.push(line.item_title);
    if (typeof line.notes === "string" && line.notes.trim()) group.notes.push(line.notes.trim());
  }
  return [...byOrder.values()].sort((a, b) => {
    const aTime = a.shipBy && !Number.isNaN(Date.parse(a.shipBy)) ? Date.parse(a.shipBy) : Infinity;
    const bTime = b.shipBy && !Number.isNaN(Date.parse(b.shipBy)) ? Date.parse(b.shipBy) : Infinity;
    return (aTime - bTime || a.id.localeCompare(b.id));
  });
}
async function loadDashboardOrders() {
  const lines = await dashboardPages(() => supabase.from("ebay_order_lines")
    .select("id,order_id,item_title,quantity,fulfilled_quantity,line_status,notes,ebay_orders!inner(id,order_number,buyer_username,ship_by_date)")
    .in("line_status", ["pending", "partially_fulfilled"]));
  // An eBay shipping label/fulfillment flag does not finish physical work in Invsto.
  dashboardState.orders = summarizePendingOrders(lines);
  if (!dashboardState.orderFilterChosen) dashboardState.orderFilter = dashboardState.orders.some(order => order.bucket === "overdue") ? "overdue" : dashboardState.orders.some(order => order.bucket === "today") ? "today" : "all";
  renderDashboardOrders();
}
function renderDashboardOrders() {
  const orders = dashboardState.orders;
  if (!orders) return;
  const counts = Object.fromEntries(["overdue", "today", "tomorrow", "later", "undated"].map(bucket => [bucket, orders.filter(order => order.bucket === bucket).length]));
  const units = orders.reduce((sum, order) => sum + order.units, 0);
  const buyers = new Set(orders.map(order => order.buyer.trim().toLowerCase()).filter(Boolean)).size;
  const lines = orders.reduce((sum, order) => sum + order.lines, 0);
  dashText("stat-orders", dashCount(orders.length));
  dashText("stat-orders-detail", `${dashWords(buyers, "buyer")} · ${dashWords(units, "unit")}`);
  dashText("stat-overdue", dashCount(counts.overdue));
  dashText("stat-overdue-detail", `${dashCount(counts.today)} more due today`);
  dashText("orders-summary", `${dashWords(lines, "item line")} still to finish · ${dashCount(counts.later)} orders due later${counts.undated ? ` · ${dashCount(counts.undated)} without a ship date` : ""}`);
  for (const key of ["overdue", "today", "tomorrow", "all"]) dashText(`count-${key}`, dashCount(key === "all" ? orders.length : counts[key]));
  document.querySelectorAll("[data-order-filter]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.orderFilter === dashboardState.orderFilter)));
  const filtered = orders.filter(order => dashboardState.orderFilter === "all" || order.bucket === dashboardState.orderFilter);
  const preview = filtered.slice(0, DASH_PREVIEW_SIZE);
  dashText("orders-showing", filtered.length ? `${preview.length} of ${dashWords(filtered.length, "order")}` : "");
  const host = dashEl("dashboard-orders"); host.setAttribute("aria-busy", "false");
  const labels = {overdue: "Overdue", today: "Due today", tomorrow: "Due tomorrow", later: "Upcoming", undated: "No ship date"};
  host.innerHTML = preview.length ? preview.map(order => {
    const href = order.number ? `pending-orders.html?orderId=${encodeURIComponent(order.number)}` : order.buyer ? `pending-orders.html?buyer=${encodeURIComponent(order.buyer)}` : "pending-orders.html";
    const note = [...new Set(order.notes)].join(" · ");
    return `<a class="dash-row dash-order-row" href="${href}">
      <div class="dash-row-top"><strong class="dash-row-title">${escapeHtml(order.buyer || "Buyer not recorded")}</strong><span class="dash-tag is-${order.bucket}">${labels[order.bucket]}</span></div>
      <span class="dash-row-sub">${escapeHtml(order.number || "Pending order")} · ${dashWords(order.units, "unit")}</span>
      <p class="dash-row-note ${note ? "is-note" : ""}">${escapeHtml(note ? `Note: ${note}` : order.titles.slice(0, 2).join(" / ") || "Open this order to review the items.")}</p>
      <div class="dash-row-meta"><span>${order.shipBy ? `Ship by <b>${escapeHtml(dashDate(order.shipBy, true))}</b>` : "Ship-by date not recorded"}</span><span>Open order →</span></div>
    </a>`;
  }).join("") : `<div class="dash-empty"><strong>${orders.length ? "Nothing in this view" : "Your pending queue is clear"}</strong>${orders.length ? "Choose another deadline to see more orders." : "New pending orders will appear here."}</div>`;
}

function visibleDashboardTask(task) {
  const metadata = task.metadata || {};
  if (["true", "1", "yes"].includes(String(metadata.hidden_from_task_board || "").toLowerCase().trim())) return false;
  if (metadata.history_removed_at || metadata.assignment_cancelled_at || metadata.assignment_canceled_at) return false;
  if (!task.assigned_to_user_id && !task.assigned_to_email && /assignment\s+cancelled|assignment\s+canceled/i.test([task.latest_note, task.description, task.question, metadata.history_removed_note, metadata.assignment_cancelled_note, metadata.assignment_canceled_note].filter(Boolean).join(" "))) return false;
  return !(task.source === "order" && DASH_PARENT_TYPES.has(task.task_type) && ["approved_for_shipping", "assigned_for_shipping", "shipped_completed", "closed"].includes(task.status));
}
function normalizeDashboardTask(task, source) {
  const related = dashOne(source === "return" ? task.ebay_return_cases : task.ebay_orders);
  const metadata = task.metadata || {};
  return {...task, source,
    title: task.title || (source === "order" ? "Order follow-up" : source === "return" ? "Return follow-up" : "Team task"),
    note: task.latest_note || task.description || task.question || related.return_reason || "",
    buyer: related.buyer_username || metadata.buyer_username || metadata.buyerUsername || "",
    due: task.due_at || related.ship_by_date || null,
    sourceLabel: source === "return" ? "Return" : source === "order" ? (metadata.source === "order_history" ? "Order history" : "Order") : "Team",
  };
}
async function loadDashboardTasks() {
  const userId = dashboardState.user.id;
  const personal = `assigned_to_user_id.eq.${userId},status.eq.waiting_on_admin,and(assigned_by.eq.${userId},assigned_to_user_id.not.is.null)`;
  const orderScope = `${personal},status.eq.ready_for_admin_approval`;
  const common = "id,title,status,priority,assigned_to_email,assigned_to_user_id,due_at,created_at,metadata,task_type";
  const results = await Promise.allSettled([
    dashboardPages(() => supabase.from("team_tasks").select(`${common},description,latest_note`).in("status", DASH_ACTIVE_TASK_STATUSES).or(personal)),
    dashboardPages(() => supabase.from("ebay_order_tasks").select(`${common},question,latest_note,ebay_orders(order_number,buyer_username,ship_by_date)`).in("status", DASH_ACTIVE_TASK_STATUSES).or(orderScope)),
    dashboardPages(() => supabase.from("ebay_return_tasks").select(`${common},question,ebay_return_cases(order_number,buyer_username,return_reason)`).in("status", DASH_RETURN_TASK_STATUSES).eq("assigned_to_user_id", userId)),
  ]);
  // Never present a partial sum as the user's complete workload.
  const failed = results.find(result => result.status === "rejected");
  if (failed) throw failed.reason;
  dashboardState.tasks = results.flatMap((result, index) => result.value.map(task => normalizeDashboardTask(task, ["team", "order", "return"][index]))).filter(visibleDashboardTask);
  renderDashboardTasks();
}
function isDashboardReview(task) { return DASH_REVIEW_STATUSES.has(task.status); }
function sortDashboardTasks(tasks) {
  const priorities = {urgent: 0, high: 1, normal: 2, low: 3};
  return [...tasks].sort((a, b) => (priorities[a.priority] ?? 2) - (priorities[b.priority] ?? 2)
    || (Date.parse(a.due) || Infinity) - (Date.parse(b.due) || Infinity)
    || (Date.parse(a.created_at) || 0) - (Date.parse(b.created_at) || 0) || a.id.localeCompare(b.id));
}
function renderDashboardTasks() {
  const tasks = dashboardState.tasks;
  if (!tasks) return;
  const review = tasks.filter(isDashboardReview).length;
  const overdue = tasks.filter(task => deadlineBucket(task.due) === "overdue").length;
  const blocked = tasks.filter(task => ["blocked", "deferred", "sent_back_for_rework"].includes(task.status)).length;
  dashText("stat-tasks", dashCount(tasks.length));
  dashText("stat-tasks-detail", `${dashCount(overdue)} overdue · ${dashCount(blocked)} need help`);
  dashText("stat-review", dashCount(review));
  dashText("stat-review-detail", "Approvals & admin follow-ups");
  document.querySelectorAll("[data-task-filter]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.taskFilter === dashboardState.taskFilter)));
  const filtered = sortDashboardTasks(tasks.filter(task => dashboardState.taskFilter === "review" ? isDashboardReview(task) : dashboardState.taskFilter === "blocked" ? ["blocked", "deferred", "sent_back_for_rework"].includes(task.status) : true));
  const preview = filtered.slice(0, DASH_PREVIEW_SIZE);
  dashText("tasks-showing", filtered.length ? `${preview.length} of ${dashWords(filtered.length, "task")}` : "");
  const host = dashEl("dashboard-tasks"); host.setAttribute("aria-busy", "false");
  const statuses = {completed_by_employee: "Needs acceptance", ready_for_admin_approval: "Ready for approval", pending_admin_review: "Needs review", waiting_on_admin: "Admin follow-up", sent_back_for_rework: "Needs rework"};
  host.innerHTML = preview.length ? preview.map(task => {
    const mine = task.assigned_to_user_id === dashboardState.user.id;
    const owner = mine ? "You" : task.assigned_to_email || (task.assigned_to_user_id ? "Assigned teammate" : "Unassigned");
    const status = statuses[task.status] || String(task.status).replace(/_/g, " ");
    const overdueTask = deadlineBucket(task.due) === "overdue";
    return `<a class="dash-row dash-task-row" href="team-tasks.html?taskId=${encodeURIComponent(task.id)}">
      <div class="dash-row-top"><strong class="dash-row-title">${escapeHtml(task.title)}</strong><span class="dash-tag ${isDashboardReview(task) ? "is-review" : task.priority === "urgent" ? "is-urgent" : ""}">${escapeHtml(status)}</span></div>
      <span class="dash-row-sub">${escapeHtml(task.sourceLabel)}${task.buyer ? ` · ${escapeHtml(task.buyer)}` : ""}${["urgent", "high"].includes(task.priority) ? ` · ${escapeHtml(task.priority)} priority` : ""}</span>
      ${task.note ? `<p class="dash-row-note is-note">${escapeHtml(task.note)}</p>` : ""}
      <div class="dash-row-meta"><span>${escapeHtml(owner)}</span><span>${task.due ? `${overdueTask ? "Overdue" : "Due"} · ${escapeHtml(dashDate(task.due))}` : "No due date"} <span aria-hidden="true">↗</span></span></div>
    </a>`;
  }).join("") : `<div class="dash-empty"><strong>${tasks.length ? "Nothing in this view" : "You're caught up"}</strong>${tasks.length ? "Choose another view to see your other tasks." : "Work assigned to you and admin reviews will appear here."}</div>`;
}

async function loadDashboardTransfers() {
  const transfers = await dashboardPages(() => supabase.from("store_transfers").select("id,status").eq("receiver_user_id", dashboardState.user.id).in("status", ["pending_receipt", "partially_received", "exception"]));
  const exceptions = transfers.filter(transfer => transfer.status === "exception").length;
  dashText("transfers-summary", transfers.length ? `${dashWords(transfers.length, "handoff")} to receive` : "No handoffs waiting");
  dashText("transfers-detail", exceptions ? `${dashWords(exceptions, "exception")} need your attention` : "Assigned to you for receiving");
}
async function loadDashboardTrays() {
  const trays = await dashboardPages(() => supabase.from("locations").select("id,tray_status").eq("is_tray", true).in("tray_status", ["checked_out", "in_transfer", "weight_mismatch"]));
  const mismatches = trays.filter(tray => tray.tray_status === "weight_mismatch").length;
  dashText("trays-summary", mismatches ? `${dashWords(mismatches, "weight flag")}` : trays.length ? `${dashWords(trays.length, "tray")} out or in transfer` : "All trays checked in");
  dashText("trays-detail", mismatches ? `${dashWords(trays.length - mismatches, "other tray")} out or in transfer` : "No weight flags to review");
}
async function loadDashboardReturns() {
  const {count} = await dashboardQuery(supabase.from("ebay_return_cases").select("id", {count: "exact", head: true}).not("status", "in", "(closed,cancelled)"));
  if (count == null) throw new Error("Return count unavailable");
  dashText("returns-summary", count ? `${dashWords(count, "open case")}` : "No open cases");
}

function clearDashboardCounts(kind) {
  const ids = kind === "orders" ? ["stat-orders", "stat-overdue", "count-overdue", "count-today", "count-tomorrow", "count-all"] : ["stat-tasks", "stat-review"];
  ids.forEach(id => dashText(id, "—"));
  const details = kind === "orders" ? ["stat-orders-detail", "stat-overdue-detail"] : ["stat-tasks-detail", "stat-review-detail"];
  details.forEach(id => dashText(id, "Refreshing…"));
  dashText(`${kind}-showing`, "");
}
function refreshDashboard() {
  if (dashboardState.refreshing) return dashboardState.refreshing;
  dashEl("dashboard-refresh").disabled = true;
  dashText("dashboard-updated", "Updating…"); setDashboardStatus();
  dashboardState.orders = null; dashboardState.tasks = null;
  for (const kind of ["orders", "tasks"]) {
    clearDashboardCounts(kind);
    dashEl(`dashboard-${kind}`).setAttribute("aria-busy", "true");
    dashEl(`dashboard-${kind}`).innerHTML = `<div class="dash-loading">Loading ${kind}…</div>`;
  }
  dashboardState.reports.clear();
  for (const name of ["inventory", "buyers"]) if (dashEl(`${name}-report`).open) loadDashboardReport(name);
  const jobs = [
    ["orders", loadDashboardOrders], ["tasks", loadDashboardTasks],
    ["transfers", loadDashboardTransfers], ["trays", loadDashboardTrays], ["returns", loadDashboardReturns],
  ];
  dashboardState.refreshing = Promise.allSettled(jobs.map(async ([name, load]) => {
    try { await load(); }
    catch (error) {
      console.warn(`Dashboard ${name} unavailable:`, error?.message || error);
      if (["orders", "tasks"].includes(name)) {
        dashError(`dashboard-${name}`, "dashboard", `Couldn't load ${name}`);
        const ids = name === "orders" ? ["stat-orders-detail", "stat-overdue-detail"] : ["stat-tasks-detail", "stat-review-detail"];
        ids.forEach(id => dashText(id, "Unavailable · try again"));
        if (name === "orders") dashText("orders-summary", "The pending queue could not be refreshed.");
      } else dashText(`${name}-summary`, "Unavailable · refresh to retry");
      throw error;
    }
  })).then(results => {
    const failed = results.some(result => result.status === "rejected");
    dashboardState.updatedAt = Date.now();
    dashText("dashboard-updated", `${failed ? "Partial update" : "Updated"} ${new Date().toLocaleTimeString(undefined, {hour: "numeric", minute: "2-digit"})}`);
    if (failed) setDashboardStatus("Some sections couldn't refresh. Available information is shown; use Refresh to try again.");
  }).finally(() => { dashboardState.refreshing = null; dashEl("dashboard-refresh").disabled = false; });
  return dashboardState.refreshing;
}

function summarizeDashboardInventory(items, stock) {
  const quantities = new Map();
  for (const row of stock) quantities.set(row.item_id, (quantities.get(row.item_id) || 0) + dashNumber(row.quantity));
  const summary = {units: 0, cost: 0, value: 0, categories: new Map()};
  for (const item of items) {
    const categories = Array.isArray(item.categories) ? [...new Set(item.categories)] : [];
    const quantity = quantities.get(item.id) || 0;
    if (item.deleted_at || categories.some(value => String(value).toLowerCase() === "testcard") || quantity <= 0) continue;
    const value = dashNumber(item.sale_price) * quantity;
    summary.units += quantity; summary.cost += dashNumber(item.cost) * quantity; summary.value += value;
    for (const category of categories.length ? categories : ["Uncategorized"]) {
      const row = summary.categories.get(category) || {name: category, units: 0, value: 0};
      row.units += quantity; row.value += value; summary.categories.set(category, row);
    }
  }
  return summary;
}
async function buildInventoryReport() {
  const [items, stock] = await Promise.all([
    dashboardPages(() => supabase.from("item_types").select("id,categories,cost,sale_price,deleted_at").is("deleted_at", null)),
    dashboardPages(() => supabase.from("item_stock_locations").select("id,item_id,quantity").gt("quantity", 0)),
  ]);
  const summary = summarizeDashboardInventory(items, stock);
  const categories = [...summary.categories.values()].sort((a, b) => b.value - a.value);
  return `<div class="dash-report-metrics"><div><small>Units in stock</small><strong>${dashCount(summary.units)}</strong></div><div><small>Estimated retail value</small><strong>${dashMoney(summary.value)}</strong></div><div><small>Inventory cost</small><strong>${dashMoney(summary.cost)}</strong></div><div><small>Retail value / cost</small><strong>${summary.cost ? `${(summary.value / summary.cost).toFixed(2)}×` : "—"}</strong></div></div>
    ${categories.map(category => `<div class="dash-category"><div class="dash-category-label"><span>${escapeHtml(category.name)} · ${dashWords(category.units, "unit")}</span><b>${dashMoney(category.value)}</b></div><div class="dash-category-track" aria-hidden="true"><span style="width:${Math.min(100, Math.max(0, summary.value ? category.value / summary.value * 100 : 0))}%"></span></div></div>`).join("")}
    <p>On-hand stock, including reserved units. Categories may overlap. Retail value is an estimate, not realized revenue.</p><a href="stock.html">Open stock →</a>`;
}
async function buildBuyersReport() {
  const {data} = await dashboardQuery(supabase.rpc("get_dashboard_buyer_snapshot", {_limit: 6, _days_back: 90}));
  if (!data?.length) return `<div class="dash-empty"><strong>No buyer activity in this period</strong>Synced purchases from the last 90 days will appear here.</div>`;
  return `<p>Top ${data.length} buyers by synced order value over the last 90 days. Open cases include earlier purchases.</p>${data.map(buyer => `<a class="dash-buyer" href="ebay-order-history.html?historySearch=${encodeURIComponent(buyer.buyer_username || "")}&allDates=1"><div><strong>${escapeHtml(buyer.buyer_username || "Unknown buyer")}</strong><b>${dashMoney(buyer.gross_sales)}</b></div><small>${dashWords(dashNumber(buyer.order_count), "order")} · ${buyer.net_payout == null ? "Payout unavailable" : `${dashMoney(buyer.net_payout)} ${buyer.payout_missing_count ? "known" : "est."} payout`}${buyer.payout_missing_count ? ` (${dashWords(dashNumber(buyer.payout_missing_count), "order")} missing payout)` : ""} · ${dashWords(dashNumber(buyer.open_return_count), "open case")}</small></a>`).join("")}<a href="ebay-order-history.html">Open order history →</a>`;
}
function loadDashboardReport(name) {
  if (!dashboardState.user || !["inventory", "buyers"].includes(name)) return Promise.resolve();
  if (dashboardState.reports.has(name)) return dashboardState.reports.get(name).promise;
  const host = dashEl(`${name}-report-body`);
  host.innerHTML = `<p class="dash-loading">Loading ${name === "buyers" ? "buyers" : "inventory"}…</p>`;
  host.setAttribute("aria-busy", "true");
  const entry = {};
  dashboardState.reports.set(name, entry);
  entry.promise = (name === "inventory" ? buildInventoryReport() : buildBuyersReport()).then(html => {
    if (dashboardState.reports.get(name) === entry) host.innerHTML = html;
  }).catch(error => {
    console.warn(`Dashboard report ${name} unavailable:`, error?.message || error);
    if (dashboardState.reports.get(name) !== entry) return;
    dashboardState.reports.delete(name);
    dashError(`${name}-report-body`, name, "This report is unavailable");
  }).finally(() => { if (dashboardState.reports.get(name) === entry) host.setAttribute("aria-busy", "false"); });
  return entry.promise;
}

function setupDashboardListeners() {
  dashEl("dashboard-refresh").addEventListener("click", refreshDashboard);
  document.querySelectorAll("[data-order-filter],[data-jump-orders]").forEach(button => button.addEventListener("click", () => {
    dashboardState.orderFilter = button.dataset.orderFilter || button.dataset.jumpOrders;
    dashboardState.orderFilterChosen = true; renderDashboardOrders();
  }));
  document.querySelectorAll("[data-task-filter],[data-jump-tasks]").forEach(button => button.addEventListener("click", () => {
    dashboardState.taskFilter = button.dataset.taskFilter || button.dataset.jumpTasks; renderDashboardTasks();
  }));
  for (const name of ["inventory", "buyers"]) dashEl(`${name}-report`).addEventListener("toggle", event => { if (event.target.open) loadDashboardReport(name); });
  dashEl("dashboard-main").addEventListener("click", event => {
    const retry = event.target.closest("[data-retry]");
    if (retry) retry.dataset.retry === "dashboard" ? refreshDashboard() : loadDashboardReport(retry.dataset.retry);
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && dashboardState.user && Date.now() - dashboardState.updatedAt > 60000) refreshDashboard();
  });
}
function waitForDashboardClient() {
  if (window.supabase?.auth) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const ready = () => { clearTimeout(timer); document.removeEventListener("supabase-ready", ready); resolve(); };
    const timer = setTimeout(() => { document.removeEventListener("supabase-ready", ready); reject(new Error("Could not connect")); }, 8000);
    document.addEventListener("supabase-ready", ready);
  });
}
async function initializeDashboard() {
  try {
    await waitForDashboardClient();
    const {data: {session}, error: sessionError} = await supabase.auth.getSession();
    if (sessionError) throw sessionError;
    if (!session) { window.location.href = "index.html"; return; }
    const {data: employee} = await dashboardQuery(supabase.from("employees").select("role,active,display_name,email,user_id").eq("user_id", session.user.id).maybeSingle());
    if (!employee?.active) { window.location.href = "index.html"; return; }
    if (employee.role !== "admin") { window.location.href = "worker-dashboard.html"; return; }
    dashboardState.user = session.user; dashboardState.employee = employee;
    const name = (employee.display_name || "").trim().split(/\s+/)[0];
    const hour = new Date().getHours();
    const greeting = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
    dashText("admin-greeting", name ? `${greeting}, ${name}.` : "Your day, at a glance.");
    dashText("dashboard-date", new Date().toLocaleDateString(undefined, {weekday: "long", month: "long", day: "numeric"}));
    setupDashboardListeners();
    await refreshDashboard();
  } catch (error) {
    console.warn("Dashboard connection failed:", error?.message || error);
    setDashboardStatus("The dashboard couldn't connect. Reload this page to try again.");
    dashText("dashboard-updated", "Connection unavailable");
  }
}
document.addEventListener("DOMContentLoaded", initializeDashboard);
