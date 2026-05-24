const state = {
  user: null,
  employee: null,
  assignees: [],
  tasks: [],
  removedTasks: [],
  eventsByTask: new Map(),
  activeTaskId: "",
  activeTaskSource: "",
  mode: "create",
  photos: [],
  signedUrls: new Map(),
  captureStations: [],
  selectedCaptureStationId: "",
  captureBusy: false,
  taskScope: "mine",
  taskView: "active",
  taskHistorySort: "recent",
  childTasksByParent: new Map(),
  photoViewerReturnFocus: null,
};

const TEAM_TASK_BUCKET = "team-task-evidence";
const TEAM_TASK_SIGNED_URL_TTL_SECONDS = 60 * 60;
const CAPTURE_STATION_TABLE = "capture_stations";
const CAPTURE_JOB_TABLE = "capture_jobs";
const CAPTURE_PHOTO_TABLE = "capture_job_photos";
const CAPTURE_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const CAPTURE_POLL_INTERVAL_MS = 1_500;
const CAPTURE_PHOTO_SETTLE_MS = 3_000;
const CAPTURE_THUMBNAIL_TRANSFORM = { width: 240, height: 240, resize: "contain", quality: 55 };
const EBAY_RETURN_EVIDENCE_BUCKET = "ebay-return-evidence";
const ACTIVE_TASK_STATUSES = [
  "open",
  "assigned",
  "in_progress",
  "waiting_on_admin",
  "waiting_on_worker",
  "blocked",
  "deferred",
  "pending_admin_review",
  "needs_subtasks",
  "waiting_on_subtasks",
  "ready_for_admin_approval",
  "assigned_for_shipping",
  "completed_by_employee",
  "sent_back_for_rework",
];
const HISTORY_TASK_STATUSES = ["resolved", "cancelled", "approved_by_admin", "approved_for_shipping", "shipped_completed", "closed"];
const ACTIVE_RETURN_TASK_STATUSES = ["open", "assigned", "in_progress", "blocked", "deferred"];
const HISTORY_RETURN_TASK_STATUSES = ["resolved", "cancelled"];
const ORDER_PARENT_TASK_TYPES = new Set(["coordination", "admin_review", "pending_admin_review", "worker_follow_up", "special_order"]);
const ORDER_SUBTASK_TYPE = "pending_subtask";
const ORDER_SHIPPING_TYPE = "pending_shipping";
const ORDER_PACKAGING_TYPE = "pending_packaging";
const TASK_LINE_SELECT = `
  id,
  order_id,
  item_number,
  transaction_id,
  item_title,
  custom_label,
  quantity,
  sold_for,
  total_price,
  net_payout,
  line_status,
  notes,
  raw_payload
`;

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

function formatDate(value) {
  if (!value) return "not set";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not set";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDateTimeLocalValue(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function unique(values = []) {
  return [...new Set(values.filter((value) => value !== null && value !== undefined && value !== ""))];
}

function formatMoney(value) {
  const amount = Number(value || 0);
  if (!Number.isFinite(amount) || amount === 0) return "";
  return amount.toLocaleString(undefined, {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 2,
  });
}

function normalizeLookup(value) {
  return String(value || "").trim().toLowerCase();
}

function setStatus(message = "", type = "info") {
  const el = $("team-task-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function setModalError(message = "") {
  const el = $("team-task-modal-error");
  if (el) el.textContent = message;
}

function setPhotoStatus(message = "", type = "info") {
  const el = $("team-task-photo-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function isAdminUser() {
  return String(state.employee?.role || "").toLowerCase() === "admin";
}

function isTeamWideTaskScope() {
  return isAdminUser() && state.taskScope === "all";
}

function isCanceledTaskScope() {
  return isAdminUser() && state.taskScope === "canceled";
}

function isTaskHistoryView() {
  return state.taskView === "history";
}

function isHistoricalTaskView() {
  return isTaskHistoryView() || isCanceledTaskScope();
}

function updateTaskScopeChrome() {
  if (!isAdminUser()) state.taskScope = "mine";
  if (isCanceledTaskScope()) state.taskView = "history";

  const scopeControl = $("team-task-scope-control");
  const scopeSelect = $("team-task-scope");
  scopeControl?.classList.toggle("hidden", !isAdminUser());
  if (scopeSelect) {
    scopeSelect.value = isCanceledTaskScope() ? "canceled" : isTeamWideTaskScope() ? "all" : "mine";
    scopeSelect.disabled = !isAdminUser();
  }
  $("team-task-history-sort-control")?.classList.toggle("hidden", !isHistoricalTaskView());
  const historySort = $("team-task-history-sort");
  if (historySort) historySort.value = state.taskHistorySort || "recent";

  const mode = $("team-task-mode");
  if (mode) {
    mode.textContent = isCanceledTaskScope()
      ? "Canceled Tasks"
      : `${isTeamWideTaskScope() ? "Everyone's" : "My"} ${isTaskHistoryView() ? "History" : "Tasks"}`;
  }

  document.querySelectorAll("[data-task-view]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.taskView === state.taskView);
  });
}

function getRequestedTaskId() {
  const value = String(new URLSearchParams(window.location.search).get("taskId") || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "";
}

function getUnifiedTaskKey(task = {}) {
  return `${task.source || "team"}:${task.id || ""}`;
}

function getEmbeddedOne(value) {
  return Array.isArray(value) ? value[0] || {} : value || {};
}

function priorityRank(priority = "") {
  if (priority === "urgent") return 0;
  if (priority === "high") return 1;
  if (priority === "normal") return 2;
  return 3;
}

function getTaskActiveTime(task = {}) {
  return new Date(task.updated_at || task.created_at || task.due_at || 0).getTime() || 0;
}

function sortUnifiedTasks(tasks = []) {
  return [...tasks].sort((a, b) => {
    const activityDelta = getTaskActiveTime(b) - getTaskActiveTime(a);
    if (activityDelta) return activityDelta;
    const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDelta) return priorityDelta;
    return new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
  });
}

function getTaskHistoryTime(task = {}) {
  return new Date(task.completed_at || task.resolved_at || task.updated_at || task.created_at || 0).getTime() || 0;
}

function getTaskAlphaLabel(task = {}) {
  return [
    task.title,
    task.buyer_username,
    task.order_number,
    task.sourceLabel,
    task.task_type,
  ].filter(Boolean).join(" ");
}

function compareTaskText(a, b) {
  return String(a || "").localeCompare(String(b || ""), undefined, { sensitivity: "base", numeric: true });
}

function sortHistoryTasks(tasks = []) {
  const sort = state.taskHistorySort || "recent";
  return [...tasks].sort((a, b) => {
    if (sort === "oldest") return getTaskHistoryTime(a) - getTaskHistoryTime(b);
    if (sort === "user") {
      return compareTaskText(getTaskAssigneeLabel(a), getTaskAssigneeLabel(b))
        || getTaskHistoryTime(b) - getTaskHistoryTime(a);
    }
    if (sort === "az") {
      return compareTaskText(getTaskAlphaLabel(a), getTaskAlphaLabel(b))
        || getTaskHistoryTime(b) - getTaskHistoryTime(a);
    }
    return getTaskHistoryTime(b) - getTaskHistoryTime(a);
  });
}

function sortTasksForCurrentView(tasks = []) {
  return isTaskHistoryView() ? sortHistoryTasks(tasks) : sortUnifiedTasks(tasks);
}

async function loadCurrentUser() {
  const { data: sessionData, error: sessionError } = await supabase.auth.getSession();
  if (sessionError || !sessionData?.session) {
    window.location.href = "index.html";
    return false;
  }

  state.user = sessionData.session.user;
  const { data: employee, error } = await supabase
    .from("employees")
    .select("id, user_id, display_name, role, active, email")
    .eq("user_id", state.user.id)
    .maybeSingle();

  if (error || !employee || employee.active === false) {
    window.location.href = "index.html";
    return false;
  }

  state.employee = employee;
  state.taskScope = "mine";
  updateTaskScopeChrome();
  const greeting = $("team-task-greeting");
  if (greeting) greeting.textContent = `Tasks${employee.display_name ? ` - ${employee.display_name}` : ""}`;
  return true;
}

function renderAssigneeSelect() {
  const select = $("team-task-assignee");
  if (!select) return;
  const current = select.value || "";
  select.replaceChildren(new Option("Leave unassigned", ""));
  state.assignees.forEach((employee) => {
    const label = `${employee.display_name || employee.email || "Team member"} - ${employee.role || "employee"}`;
    select.appendChild(new Option(label, employee.user_id || ""));
  });
  select.value = state.assignees.some((employee) => employee.user_id === current) ? current : "";
}

function setModalFieldVisible(inputId, visible) {
  const input = $(inputId);
  input?.closest(".team-task-field")?.classList.toggle("hidden", !visible);
}

function configureModalAdminFields({
  assignee = true,
  category = true,
  priority = true,
  due = true,
  status = false,
} = {}) {
  setModalFieldVisible("team-task-assignee", assignee);
  setModalFieldVisible("team-task-type", category);
  setModalFieldVisible("team-task-priority", priority);
  setModalFieldVisible("team-task-due-at", due);
  $("team-task-status-field")?.classList.toggle("hidden", !status);
}

function getTaskAssigneeLabel(task = {}) {
  if (task.assigned_to_email) return task.assigned_to_email;
  const assignee = state.assignees.find((employee) => employee.user_id === task.assigned_to_user_id);
  if (assignee) return assignee.display_name || assignee.email || "Assigned team member";
  if (task.assigned_to_user_id && task.assigned_to_user_id === state.user?.id) {
    return state.employee?.display_name || state.user?.email || "You";
  }
  return "Unassigned";
}

async function loadAssignees() {
  const { data, error } = await supabase.rpc("list_team_task_assignees");
  if (error) throw error;
  state.assignees = Array.isArray(data) ? data : [];
  renderAssigneeSelect();
}

async function loadTasks() {
  const list = $("team-task-list");
  if (list) list.innerHTML = `<div class="empty-state">Loading ${isHistoricalTaskView() ? "task history" : "tasks"}...</div>`;
  setStatus("");
  state.childTasksByParent = new Map();

  const results = await Promise.allSettled([
    loadTeamTaskRecords(),
    loadOrderTaskRecords(),
    loadReturnTaskRecords(),
  ]);
  const tasks = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
  const failures = results.filter((result) => result.status === "rejected");

  failures.forEach((failure) => console.warn("Could not load one task source:", failure.reason));
  if (!tasks.length && failures.length === results.length) {
    if (list) list.innerHTML = `<div class="empty-state">Could not load tasks. Make sure the latest task migrations are pushed.</div>`;
    return;
  }

  const activeHistoryTasks = tasks.filter((task) => !task?.metadata?.history_removed_at);
  const removedHistoryTasks = tasks.filter((task) => task?.metadata?.history_removed_at);
  state.tasks = isCanceledTaskScope() ? removedHistoryTasks : activeHistoryTasks;
  state.removedTasks = [];
  const visibleTasks = state.tasks;
  await enrichTasksWithDetails(visibleTasks);
  await hydrateOrderWorkflowChildren(visibleTasks);
  const requested = getRequestedTaskId();
  if (requested && !state.tasks.some((task) => task.id === requested)) {
    const { data: requestedTask, error: requestedError } = await supabase
      .from("team_tasks")
      .select("*")
      .eq("id", requested)
      .maybeSingle();
    if (!requestedError && requestedTask) state.tasks.unshift(normalizeTeamTask(requestedTask));
  }

  state.tasks = sortTasksForCurrentView(state.tasks);
  await loadEventsForTasks();
  await hydrateEventPhotoUrls();
  renderTasks();

  if (requested) {
    const card = document.querySelector(`[data-team-task-card="${CSS.escape(requested)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

async function loadTeamTaskRecords() {
  if (isHistoricalTaskView()) {
    let query = supabase
      .from("team_tasks")
      .select("*")
      .in("status", HISTORY_TASK_STATUSES)
      .order("updated_at", { ascending: false })
      .limit(80);
    if (!isTeamWideTaskScope() && !isCanceledTaskScope()) query = query.eq("assigned_to_user_id", state.user?.id);
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(normalizeTeamTask);
  }
  if (isAdminUser() && !isTeamWideTaskScope()) {
    const { data, error } = await supabase
      .from("team_tasks")
      .select("*")
      .in("status", ACTIVE_TASK_STATUSES)
      .or(`assigned_to_user_id.eq.${state.user?.id},status.eq.waiting_on_admin,and(assigned_by.eq.${state.user?.id},assigned_to_user_id.not.is.null)`)
      .order("created_at", { ascending: true })
      .limit(80);
    if (error) throw error;
    return (data || []).map(normalizeTeamTask);
  }
  const rpcName = isTeamWideTaskScope() ? "list_admin_team_tasks" : "list_my_team_tasks";
  const { data, error } = await supabase.rpc(rpcName, { _limit: 80 });
  if (error) throw error;
  return (data || []).map(normalizeTeamTask);
}

async function loadOrderTaskRecords() {
  const statuses = isHistoricalTaskView()
    ? HISTORY_TASK_STATUSES
    : isAdminUser()
      ? ACTIVE_TASK_STATUSES
      : ACTIVE_TASK_STATUSES.filter((status) => status !== "completed_by_employee");
  let query = supabase
    .from("ebay_order_tasks")
    .select("id, order_id, order_line_ids, parent_task_id, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, due_at, created_at, updated_at, completed_at, resolved_at, latest_note, latest_photo_count, created_by_email, metadata, ebay_orders(order_number, buyer_username, sale_date, paid_on_date, ship_by_date, status, total_price, net_payout)")
    .in("status", statuses)
    .order(isHistoricalTaskView() ? "updated_at" : "created_at", { ascending: !isHistoricalTaskView() })
    .limit(80);
  if (!isTeamWideTaskScope() && !isCanceledTaskScope()) {
    query = isAdminUser() && !isHistoricalTaskView()
      ? query.or(`assigned_to_user_id.eq.${state.user?.id},status.eq.waiting_on_admin,and(assigned_by.eq.${state.user?.id},assigned_to_user_id.not.is.null)`)
      : query.eq("assigned_to_user_id", state.user?.id);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || [])
    .map(normalizeOrderTask)
    .filter((task) => (
      isHistoricalTaskView()
      || !isOrderParentTask(task)
      || !["approved_for_shipping", "assigned_for_shipping", "shipped_completed", "closed"].includes(String(task.status || ""))
    ));
}

async function loadReturnTaskRecords() {
  const statuses = isHistoricalTaskView() ? HISTORY_RETURN_TASK_STATUSES : ACTIVE_RETURN_TASK_STATUSES;
  let query = supabase
    .from("ebay_return_tasks")
    .select("id, return_case_id, order_id, order_line_ids, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, due_at, resolved_at, created_at, updated_at, metadata, ebay_return_cases(id, order_id, order_number, ebay_return_id, buyer_username, return_reason, status, opened_at, notes, raw_payload)")
    .in("status", statuses)
    .order("created_at", { ascending: !isHistoricalTaskView() })
    .limit(80);
  if (!isTeamWideTaskScope() && !isCanceledTaskScope()) query = query.eq("assigned_to_user_id", state.user?.id);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(normalizeReturnTask);
}

function normalizeTeamTask(task = {}) {
  return {
    ...task,
    source: "team",
    sourceLabel: "Independent",
    actionHref: `team-tasks.html?taskId=${encodeURIComponent(task.id || "")}`,
  };
}

function normalizeOrderTask(task = {}) {
  const order = getEmbeddedOne(task.ebay_orders);
  const orderNumber = task.order_number || order.order_number || "";
  const buyer = task.buyer_username || order.buyer_username || "";
  const sourceLabel = task.task_type === ORDER_SUBTASK_TYPE
    ? "Subtask"
    : task.task_type === ORDER_SHIPPING_TYPE
      ? "Shipping Task"
      : task.task_type === ORDER_PACKAGING_TYPE
        ? "Packaging Task"
      : "Pending Order";
  return {
    ...task,
    source: "order",
    sourceLabel,
    title: task.title || `Pending order ${orderNumber || ""}`.trim(),
    description: task.question || task.latest_note || "",
    latest_note: task.latest_note || task.question || "",
    order,
    order_number: orderNumber,
    buyer_username: buyer,
    ship_by_date: task.ship_by_date || order.ship_by_date || "",
    actionHref: `pending-orders.html?orderTaskId=${encodeURIComponent(task.id || "")}#order-task-panel`,
  };
}

function normalizeReturnTask(task = {}) {
  const returnCase = getEmbeddedOne(task.ebay_return_cases);
  const returnId = task.ebay_return_id || returnCase.ebay_return_id || "";
  const orderNumber = task.order_number || returnCase.order_number || "";
  const buyer = task.buyer_username || returnCase.buyer_username || "";
  const reason = task.return_reason || returnCase.return_reason || "";
  return {
    ...task,
    order_id: task.order_id || returnCase.order_id || "",
    source: "return",
    sourceLabel: "Return",
    title: task.title || `Return ${returnId || orderNumber || ""}`.trim(),
    description: task.question || reason || "",
    latest_note: task.question || reason || "",
    returnCase,
    ebay_return_id: returnId,
    order_number: orderNumber,
    buyer_username: buyer,
    return_reason: reason,
    actionHref: `ebay-returns.html?returnTaskId=${encodeURIComponent(task.id || "")}#return-work-queue`,
  };
}

function getTaskLineIds(task = {}) {
  return Array.isArray(task.order_line_ids) ? task.order_line_ids.filter(Boolean) : [];
}

function getReturnTaskPayload(task = {}) {
  return {
    ...(task.metadata && typeof task.metadata === "object" ? task.metadata : {}),
    ...(task.returnCase?.raw_payload && typeof task.returnCase.raw_payload === "object" ? task.returnCase.raw_payload : {}),
  };
}

function getReturnComplaintImageRecords(task = {}) {
  const metadata = getReturnTaskPayload(task);
  const detail = metadata.returnDetails || {};
  return [
    ...(Array.isArray(metadata.complaintImages) ? metadata.complaintImages : []),
    ...(Array.isArray(metadata.ebayComplaintImages) ? metadata.ebayComplaintImages : []),
    ...(Array.isArray(detail.complaintImages) ? detail.complaintImages : []),
  ].filter((image) => image && typeof image === "object");
}

async function createTaskSignedImageUrl(bucket, path) {
  if (!bucket || !path) return "";
  const key = `${bucket}/${path}`;
  const cached = state.signedUrls.get(key);
  if (cached) return cached;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, TEAM_TASK_SIGNED_URL_TTL_SECONDS);
  if (error || !data?.signedUrl) return "";
  state.signedUrls.set(key, data.signedUrl);
  return data.signedUrl;
}

async function hydrateTaskLines(tasks = []) {
  const lineIds = new Set();
  const orderIds = new Set();
  tasks.forEach((task) => {
    getTaskLineIds(task).forEach((id) => lineIds.add(id));
    if ((task.source === "order" || task.source === "return") && task.order_id) orderIds.add(task.order_id);
  });

  const rowsById = new Map();
  const addRows = (rows = []) => rows.forEach((row) => {
    if (row?.id) rowsById.set(row.id, row);
  });

  if (lineIds.size) {
    const { data, error } = await supabase
      .from("ebay_order_lines")
      .select(TASK_LINE_SELECT)
      .in("id", [...lineIds])
      .limit(1000);
    if (error) console.warn("Could not load task order lines by id:", error);
    else addRows(data || []);
  }

  if (orderIds.size) {
    const { data, error } = await supabase
      .from("ebay_order_lines")
      .select(TASK_LINE_SELECT)
      .in("order_id", [...orderIds])
      .limit(1000);
    if (error) console.warn("Could not load task order lines by order:", error);
    else addRows(data || []);
  }

  tasks.forEach((task) => {
    const ids = getTaskLineIds(task);
    const lines = ids.length
      ? ids.map((id) => rowsById.get(id)).filter(Boolean)
      : [...rowsById.values()].filter((line) => line.order_id === task.order_id);
    task.lineDetails = lines;
  });
}

async function hydrateReturnComplaintImages(tasks = []) {
  const returnTasks = tasks.filter((task) => task.source === "return");
  for (const task of returnTasks) {
    const metadata = getReturnTaskPayload(task);
    const detail = metadata.returnDetails || {};
    const directUrls = unique([
      metadata.complaintImageUrl,
      ...(Array.isArray(metadata.complaintImageUrls) ? metadata.complaintImageUrls : []),
      ...(Array.isArray(detail.complaintImageUrls) ? detail.complaintImageUrls : []),
    ]).filter((url) => !String(url).startsWith("blob:"));
    const signedUrls = await Promise.all(getReturnComplaintImageRecords(task).slice(0, 8).map((record) => {
      const bucket = record.bucket || record.storage_bucket || EBAY_RETURN_EVIDENCE_BUCKET;
      const path = record.path || record.storage_path;
      if (record.url && !String(record.url).startsWith("blob:")) return record.url;
      return createTaskSignedImageUrl(bucket, path);
    }));
    task.complaintImageUrls = unique([...directUrls, ...signedUrls.filter(Boolean)]);
  }
}

async function hydrateReturnMessages(tasks = []) {
  const returnTasks = tasks.filter((task) => task.source === "return");
  if (!returnTasks.length) return;
  try {
    const { data, error } = await supabase
      .from("ebay_return_messages")
      .select("id, return_case_id, order_number, ebay_return_id, buyer_username, direction, message_status, message_body, item_title, return_reason, request_amount, sent_at, logged_at, created_by_email")
      .order("logged_at", { ascending: false })
      .limit(1000);
    if (error) throw error;

    returnTasks.forEach((task) => {
      const returnCase = task.returnCase || {};
      const returnId = normalizeLookup(task.ebay_return_id || returnCase.ebay_return_id);
      const orderNumber = normalizeLookup(task.order_number || returnCase.order_number);
      task.returnMessages = (data || []).filter((message) => Boolean(
        message.return_case_id && returnCase.id && message.return_case_id === returnCase.id
        || returnId && normalizeLookup(message.ebay_return_id) === returnId
        || orderNumber && normalizeLookup(message.order_number) === orderNumber
      )).slice(0, 6);
    });
  } catch (error) {
    console.warn("Could not load return message context:", error);
  }
}

async function enrichTasksWithDetails(tasks = []) {
  await hydrateTaskLines(tasks);
  await Promise.all([
    hydrateReturnComplaintImages(tasks),
    hydrateReturnMessages(tasks),
  ]);
}

function isOrderParentTask(task = {}) {
  return task.source === "order" && !task.parent_task_id && ORDER_PARENT_TASK_TYPES.has(task.task_type || "coordination");
}

function getOrderWorkflowChildren(parentTask = {}) {
  return state.childTasksByParent.get(parentTask.id) || [];
}

function getAllWorkflowChildTasks() {
  return [...state.childTasksByParent.values()].flat();
}

async function hydrateOrderWorkflowChildren(tasks = []) {
  state.childTasksByParent = new Map();
  const parentIds = unique(tasks.filter(isOrderParentTask).map((task) => task.id));
  if (!parentIds.length) return;

  const childStatuses = unique([...ACTIVE_TASK_STATUSES, ...HISTORY_TASK_STATUSES]);
  const { data, error } = await supabase
    .from("ebay_order_tasks")
    .select("id, order_id, order_line_ids, parent_task_id, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, due_at, created_at, updated_at, completed_at, resolved_at, latest_note, latest_photo_count, created_by_email, metadata, ebay_orders(order_number, buyer_username, sale_date, paid_on_date, ship_by_date, status, total_price, net_payout)")
    .in("parent_task_id", parentIds)
    .in("status", childStatuses)
    .order("created_at", { ascending: true })
    .limit(500);

  if (error) {
    console.warn("Could not load pending order subtasks:", error);
    return;
  }

  const children = (data || []).map(normalizeOrderTask);
  await hydrateTaskLines(children);
  children.forEach((child) => {
    const parentId = child.parent_task_id || "";
    const list = state.childTasksByParent.get(parentId) || [];
    list.push(child);
    state.childTasksByParent.set(parentId, list);
  });
}

async function loadEventsForTasks() {
  state.eventsByTask = new Map();
  const sources = [
    { source: "team", table: "team_task_events" },
    { source: "order", table: "ebay_order_task_events" },
    { source: "return", table: "ebay_return_task_events" },
  ];

  await Promise.all(sources.map(async ({ source, table }) => {
    const baseTasks = [...state.tasks, ...state.removedTasks];
    const sourceTasks = source === "order" ? [...baseTasks, ...getAllWorkflowChildTasks()] : baseTasks;
    const ids = sourceTasks.filter((task) => task.source === source).map((task) => task.id).filter(Boolean);
    if (!ids.length) return;

    const { data, error } = await supabase
      .from(table)
      .select("*")
      .in("task_id", ids)
      .order("created_at", { ascending: true });

    if (error) {
      console.warn(`Could not load ${source} task events:`, error);
      return;
    }

    (data || []).forEach((event) => {
      const key = `${source}:${event.task_id}`;
      const list = state.eventsByTask.get(key) || [];
      list.push(event);
      state.eventsByTask.set(key, list);
    });
  }));
}

async function hydrateEventPhotoUrls() {
  const photos = [];
  state.eventsByTask.forEach((events) => {
    events.forEach((event) => {
      (Array.isArray(event.photo_attachments) ? event.photo_attachments : []).forEach((photo) => {
        if (photo?.path || photo?.storage_path) photos.push(photo);
      });
    });
  });

  await Promise.all(photos.map(async (photo) => {
    const bucket = photo.bucket || photo.storage_bucket || TEAM_TASK_BUCKET;
    const path = photo.path || photo.storage_path || "";
    if (!bucket || !path || photo.signedUrl) return;
    photo.signedUrl = await createTaskSignedImageUrl(bucket, path);
  }));
}

function getTaskStatusLabel(value) {
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
    pending_admin_review: "Pending admin review",
    needs_subtasks: "Needs subtasks",
    waiting_on_subtasks: "Waiting on subtasks",
    ready_for_admin_approval: "Ready for admin approval",
    approved_for_shipping: "Approved for shipping",
    assigned_for_shipping: "Assigned for shipping",
    shipping_ready_for_packaging: "Ready for packaging",
    shipped_completed: "Shipped",
    closed: "Closed",
    completed_by_employee: "Completed by employee",
    sent_back_for_rework: "Sent back for rework",
    approved_by_admin: "Approved by admin",
  };
  return labels[value] || String(value || "open").replace(/_/g, " ");
}

function renderTaskLines(task = {}) {
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  if (!lines.length) return "";
  return `
    <div class="team-task-lines">
      ${lines.slice(0, 6).map((line) => `
        <article class="team-task-line">
          <strong>${escapeHtml(line.item_number ? `${line.item_number} - ${line.item_title || "Untitled item"}` : line.item_title || "Untitled item")}</strong>
          <span>Qty ${escapeHtml(line.quantity || 1)}${line.line_status ? ` / ${escapeHtml(line.line_status)}` : ""}${formatMoney(line.total_price || line.sold_for) ? ` / ${escapeHtml(formatMoney(line.total_price || line.sold_for))}` : ""}</span>
          ${line.custom_label ? `<small>${escapeHtml(line.custom_label)}</small>` : ""}
          ${line.notes ? `<small>${escapeHtml(line.notes)}</small>` : ""}
        </article>
      `).join("")}
      ${lines.length > 6 ? `<small class="team-task-more">+${escapeHtml(lines.length - 6)} more line${lines.length - 6 === 1 ? "" : "s"}</small>` : ""}
    </div>
  `;
}

function canOrderTaskApproveForShipping(task = {}) {
  const subtasks = getOrderWorkflowChildren(task).filter((child) => child.task_type === ORDER_SUBTASK_TYPE);
  return subtasks.every((child) => ["completed_by_employee", "approved_by_admin"].includes(child.status));
}

function renderOrderWorkflowPanel(task = {}) {
  if (!isOrderParentTask(task)) return "";
  const children = getOrderWorkflowChildren(task);
  const subtasks = children.filter((child) => child.task_type === ORDER_SUBTASK_TYPE);
  const shippingTasks = children.filter((child) => child.task_type === ORDER_SHIPPING_TYPE);
  const rows = [...subtasks, ...shippingTasks];
  const canApprove = canOrderTaskApproveForShipping(task);
  return `
    <section class="team-task-context order-workflow-panel">
      <div class="team-task-context-head">
        <span class="eyebrow">Admin Workflow</span>
        <strong>${subtasks.length ? `${subtasks.filter((subtask) => ["completed_by_employee", "approved_by_admin"].includes(subtask.status)).length} of ${subtasks.length} subtasks complete` : "No subtasks required yet"}</strong>
      </div>
      ${rows.length ? `
        <div class="order-workflow-list">
          ${rows.map((child) => {
            const events = state.eventsByTask.get(getUnifiedTaskKey(child)) || [];
            return `
              <article class="order-workflow-item">
                <div class="order-workflow-item-head">
                  <div>
                    <strong>${escapeHtml(child.title || "Order workflow task")}</strong>
                    <p>${escapeHtml(child.latest_note || child.description || child.question || "No note yet.")}</p>
                  </div>
                  <span class="team-task-chip">${escapeHtml(getTaskStatusLabel(child.status))}</span>
                </div>
                <div class="team-task-meta">
                  <span class="team-task-source">${escapeHtml(child.sourceLabel)}</span>
                  <span>Assigned: ${escapeHtml(getTaskAssigneeLabel(child))}</span>
                  <span>Due ${escapeHtml(formatDate(child.due_at))}</span>
                </div>
                ${events.length ? `
                  <div class="order-workflow-mini-events">
                    ${events.slice(-3).map(renderTaskEvent).join("")}
                  </div>
                ` : ""}
                ${renderOrderTaskActions(child, HISTORY_TASK_STATUSES.includes(child.status), { compact: true })}
              </article>
            `;
          }).join("")}
        </div>
      ` : `<div class="empty-state">No subtasks have been created for this pending order.</div>`}
      ${!canApprove && subtasks.length ? `<p class="team-task-photo-note">Shipping approval unlocks after every required subtask is completed.</p>` : ""}
    </section>
  `;
}

function renderOrderTaskContext(task = {}) {
  const order = task.order || {};
  const orderValue = formatMoney(order.total_price || task.total_price);
  const payout = formatMoney(order.net_payout || task.net_payout);
  return `
    <section class="team-task-context">
      <div class="team-task-context-head">
        <span class="eyebrow">Order Context</span>
        <strong>${escapeHtml(task.order_number || "Pending order")}${task.buyer_username ? ` - ${escapeHtml(task.buyer_username)}` : ""}</strong>
      </div>
      <div class="team-task-facts">
        ${task.ship_by_date ? `<span><small>Ship by</small><b>${escapeHtml(formatDate(task.ship_by_date))}</b></span>` : ""}
        ${order.sale_date ? `<span><small>Sold</small><b>${escapeHtml(formatDate(order.sale_date))}</b></span>` : ""}
        ${orderValue ? `<span><small>Order value</small><b>${escapeHtml(orderValue)}</b></span>` : ""}
        ${payout ? `<span><small>Payout</small><b>${escapeHtml(payout)}</b></span>` : ""}
      </div>
      ${renderTaskLines(task)}
    </section>
    ${renderOrderWorkflowPanel(task)}
  `;
}

function getReturnComplaintDetails(task = {}) {
  const metadata = getReturnTaskPayload(task);
  const detail = metadata.returnDetails || {};
  const returnFileIds = unique([
    ...(Array.isArray(metadata.returnFileIds) ? metadata.returnFileIds : []),
    ...(Array.isArray(detail.returnFileIds) ? detail.returnFileIds : []),
  ]);
  const blobUrls = unique([
    ...(Array.isArray(metadata.complaintBlobUrls) ? metadata.complaintBlobUrls : []),
    ...(Array.isArray(detail.complaintBlobUrls) ? detail.complaintBlobUrls : []),
  ]);
  return {
    buyerComment: metadata.buyerComment || detail.buyerComment || "",
    requestAmount: metadata.requestAmount || detail.requestAmount || "",
    onHoldAmount: metadata.onHoldAmount || detail.onHoldAmount || "",
    refundAmount: metadata.refundAmount || detail.refundAmount || "",
    returnDueText: metadata.returnDueText || detail.returnDueText || "",
    orderDetailsUrl: metadata.orderDetailsUrl || detail.orderDetailsUrl || "",
    videoReceiptUrl: metadata.videoReceiptUrl || detail.videoReceiptUrl || "",
    detailsUrl: metadata.detailsUrl || detail.detailsUrl || metadata.pageUrl || "",
    itemImageUrl: metadata.itemImageUrl || detail.itemImageUrl || "",
    itemNumber: metadata.itemNumber || metadata.item_number || detail.itemNumber || "",
    itemTitle: metadata.itemTitle || metadata.item_title || detail.itemTitle || "",
    datePurchased: metadata.datePurchased || detail.datePurchased || "",
    returnFileIds,
    blobUrls,
    imageUrls: Array.isArray(task.complaintImageUrls) ? task.complaintImageUrls : [],
  };
}

function renderReturnMessages(task = {}) {
  const messages = Array.isArray(task.returnMessages) ? task.returnMessages : [];
  if (!messages.length) return "";
  return `
    <div class="team-task-message-log">
      <strong>Buyer / eBay message log</strong>
      ${messages.map((message) => `
        <article class="team-task-message is-${escapeHtml(message.direction || "outbound")}">
          <span>${escapeHtml(message.direction === "inbound" ? "Buyer" : "OG / eBay reply")} - ${escapeHtml(formatDate(message.sent_at || message.logged_at))}</span>
          <p>${escapeHtml(message.message_body || "")}</p>
        </article>
      `).join("")}
    </div>
  `;
}

function renderReturnTaskContext(task = {}) {
  const returnCase = task.returnCase || {};
  const detail = getReturnComplaintDetails(task);
  const fallbackItem = [detail.itemNumber, detail.itemTitle].filter(Boolean).join(" - ");
  const hasPhotoRefs = detail.imageUrls.length || detail.returnFileIds.length || detail.blobUrls.length;
  return `
    <section class="team-task-context return-task-context">
      <div class="team-task-context-head">
        <span class="eyebrow">Return Context</span>
        <strong>${escapeHtml(returnCase.ebay_return_id || task.ebay_return_id || "Return")}${task.buyer_username ? ` - ${escapeHtml(task.buyer_username)}` : ""}</strong>
      </div>
      <div class="team-task-facts">
        ${returnCase.return_reason || task.return_reason ? `<span><small>Reason</small><b>${escapeHtml(returnCase.return_reason || task.return_reason)}</b></span>` : ""}
        ${detail.requestAmount ? `<span><small>Request amount</small><b>${escapeHtml(detail.requestAmount)}</b></span>` : ""}
        ${detail.onHoldAmount ? `<span><small>On hold</small><b>${escapeHtml(detail.onHoldAmount)}</b></span>` : ""}
        ${detail.refundAmount ? `<span><small>Refund</small><b>${escapeHtml(detail.refundAmount)}</b></span>` : ""}
        ${task.due_at ? `<span><small>Due</small><b>${escapeHtml(formatDate(task.due_at))}</b></span>` : ""}
        ${detail.returnDueText ? `<span><small>eBay action</small><b>${escapeHtml(detail.returnDueText)}</b></span>` : ""}
        ${detail.datePurchased ? `<span><small>Purchased</small><b>${escapeHtml(detail.datePurchased)}</b></span>` : ""}
      </div>
      ${fallbackItem && !task.lineDetails?.length ? `<p class="team-task-important"><strong>Item</strong><span>${escapeHtml(fallbackItem)}</span></p>` : ""}
      ${renderTaskLines(task)}
      ${detail.buyerComment ? `<p class="team-task-important"><strong>Buyer comment</strong><span>${escapeHtml(detail.buyerComment)}</span></p>` : ""}
      <div class="team-task-context-links">
        ${detail.detailsUrl ? `<a href="${escapeHtml(detail.detailsUrl)}" target="_blank" rel="noopener">Open eBay return</a>` : ""}
        ${detail.orderDetailsUrl ? `<a href="${escapeHtml(detail.orderDetailsUrl)}" target="_blank" rel="noopener">Order details</a>` : ""}
        ${detail.videoReceiptUrl ? `<a href="${escapeHtml(detail.videoReceiptUrl)}" target="_blank" rel="noopener">Video receipt</a>` : ""}
      </div>
      ${detail.imageUrls.length ? `
        <div class="team-task-complaint-images">
          ${detail.imageUrls.slice(0, 6).map((url) => `
            <a href="${escapeHtml(url)}" target="_blank" rel="noopener">
              <img src="${escapeHtml(url)}" alt="eBay return complaint image" loading="lazy" />
            </a>
          `).join("")}
        </div>
      ` : ""}
      ${!detail.imageUrls.length && hasPhotoRefs ? `<p class="team-task-photo-note">Buyer photo references were captured. Open the return task if the thumbnails are not available here.</p>` : ""}
      ${renderReturnMessages(task)}
    </section>
  `;
}

function renderTaskContext(task = {}) {
  if (task.source === "order") return renderOrderTaskContext(task);
  if (task.source === "return") return renderReturnTaskContext(task);
  return "";
}

function renderTasks() {
  const list = $("team-task-list");
  const count = $("team-task-count");
  const title = $("team-task-list-title");
  if (!list) return;
  renderRemovedHistoryTasks();

  if (title) title.textContent = isTaskHistoryView()
    ? (isCanceledTaskScope() ? "Canceled Tasks" : isTeamWideTaskScope() ? "Everyone's Task History" : "My Task History")
    : (isTeamWideTaskScope() ? "Everyone's Active Tasks" : "My Assigned Tasks");
  if (count) count.textContent = `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;

  if (!state.tasks.length) {
    list.innerHTML = `<div class="empty-state">${
      isCanceledTaskScope()
        ? "No canceled tasks."
        : isTaskHistoryView()
          ? "No completed tasks in history yet."
          : "No active tasks right now."
    }</div>`;
    return;
  }

  list.innerHTML = state.tasks.map((task) => {
    const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
    const urgent = ["urgent", "high"].includes(String(task.priority || "").toLowerCase())
      || ["blocked", "deferred"].includes(String(task.status || "").toLowerCase());
    const resolved = HISTORY_TASK_STATUSES.includes(String(task.status || "").toLowerCase());
    return `
      <article class="team-task-card ${urgent ? "is-urgent" : ""} ${resolved ? "is-resolved" : ""}" data-team-task-card="${escapeHtml(task.id)}">
        <div class="team-task-card-head">
          <div>
            <strong>${escapeHtml(task.title || "Team task")}</strong>
            <span>${escapeHtml(isCanceledTaskScope() ? task.metadata?.history_removed_note || task.latest_note || "Canceled by admin." : task.latest_note || task.description || "No note")}</span>
          </div>
          <span class="team-task-chip">${escapeHtml(isCanceledTaskScope() ? "Canceled" : getTaskStatusLabel(task.status))}</span>
        </div>
        <div class="team-task-meta">
          <span class="team-task-source">${escapeHtml(task.sourceLabel || "Task")}</span>
          <span>${escapeHtml(task.task_type || "general")}</span>
          <span>${escapeHtml(task.priority || "normal")}</span>
          <span>Assigned: ${escapeHtml(getTaskAssigneeLabel(task))}</span>
          <span>Due ${escapeHtml(formatDate(task.due_at))}</span>
          ${task.order_number ? `<span>Order ${escapeHtml(task.order_number)}</span>` : ""}
          ${task.buyer_username ? `<span>${escapeHtml(task.buyer_username)}</span>` : ""}
          ${task.source === "team" ? `<span>Created by ${escapeHtml(task.created_by_email || "logged-in user")}</span>` : ""}
          ${isCanceledTaskScope() ? `<span>Removed ${escapeHtml(formatDate(task.metadata?.history_removed_at))}</span>` : ""}
        </div>
        ${renderTaskContext(task)}
        ${renderAdminReassignRequestNotice(task)}
        <div class="team-task-events">
          ${events.length ? events.map(renderTaskEvent).join("") : `<div class="empty-state">No task trail yet.</div>`}
        </div>
        ${renderTaskActions(task, resolved)}
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-team-task-reply]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskReply }));
  });
  list.querySelectorAll("[data-team-task-progress]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskProgress, progress: true }));
  });
  list.querySelectorAll("[data-team-task-resolve]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskResolve, resolve: true }));
  });
  list.querySelectorAll("[data-team-task-reassign-request]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskReassignRequest, reassignRequest: true }));
  });
  list.querySelectorAll("[data-team-task-photo]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.url) {
        openTaskPhotoViewer({
          url: button.dataset.url,
          label: button.dataset.label || "Task evidence photo",
          bucket: button.dataset.bucket || TEAM_TASK_BUCKET,
          path: button.dataset.path || "",
          trigger: button,
        });
        return;
      }
      openTaskPhoto(button.dataset.bucket, button.dataset.path);
    });
  });
  list.querySelectorAll("[data-order-workflow-action]").forEach((button) => {
    button.addEventListener("click", () => handleOrderWorkflowAction(button.dataset.orderWorkflowAction, button.dataset.taskId));
  });
  list.querySelectorAll("[data-task-assignment-action]").forEach((button) => {
    button.addEventListener("click", () => openAdminAssignmentModal({
      taskSource: button.dataset.taskSource,
      taskId: button.dataset.taskId,
      action: button.dataset.taskAssignmentAction,
    }));
  });
  list.querySelectorAll("[data-task-history-action]").forEach((button) => {
    button.addEventListener("click", () => handleAdminHistoryAction({
      taskSource: button.dataset.taskSource,
      taskId: button.dataset.taskId,
      action: button.dataset.taskHistoryAction,
    }));
  });
}

function renderRemovedHistoryTasks() {
  const section = $("team-task-canceled-section");
  const list = $("team-task-canceled-list");
  const count = $("team-task-canceled-count");
  if (!section || !list) return;

  const tasks = isAdminUser() && isTaskHistoryView() ? state.removedTasks : [];
  section.classList.toggle("hidden", !tasks.length);
  if (count) count.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  if (!tasks.length) {
    list.innerHTML = "";
    return;
  }

  list.innerHTML = tasks.map((task) => {
    const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
    const removedNote = task.metadata?.history_removed_note || "Removed from active history by admin.";
    return `
      <article class="team-task-card is-urgent is-resolved" data-team-task-card="${escapeHtml(task.id)}">
        <div class="team-task-card-head">
          <div>
            <strong>${escapeHtml(task.title || "Canceled task")}</strong>
            <span>${escapeHtml(removedNote)}</span>
          </div>
          <span class="team-task-chip">Canceled</span>
        </div>
        <div class="team-task-meta">
          <span class="team-task-source">${escapeHtml(task.sourceLabel || "Task")}</span>
          <span>Assigned: ${escapeHtml(getTaskAssigneeLabel(task))}</span>
          <span>Removed ${escapeHtml(formatDate(task.metadata?.history_removed_at))}</span>
          ${task.order_number ? `<span>Order ${escapeHtml(task.order_number)}</span>` : ""}
          ${task.buyer_username ? `<span>${escapeHtml(task.buyer_username)}</span>` : ""}
        </div>
        ${renderTaskContext(task)}
        <div class="team-task-events">
          ${events.length ? events.map(renderTaskEvent).join("") : `<div class="empty-state">No task trail yet.</div>`}
        </div>
        <div class="team-task-actions">
          <button type="button" class="secondary-btn" data-task-history-action="reopen" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Reopen Task</button>
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-team-task-photo]").forEach((button) => {
    button.addEventListener("click", () => {
      if (button.dataset.url) {
        openTaskPhotoViewer({
          url: button.dataset.url,
          label: button.dataset.label || "Task evidence photo",
          bucket: button.dataset.bucket || TEAM_TASK_BUCKET,
          path: button.dataset.path || "",
          trigger: button,
        });
        return;
      }
      openTaskPhoto(button.dataset.bucket, button.dataset.path);
    });
  });
  list.querySelectorAll("[data-task-history-action]").forEach((button) => {
    button.addEventListener("click", () => handleAdminHistoryAction({
      taskSource: button.dataset.taskSource,
      taskId: button.dataset.taskId,
      action: button.dataset.taskHistoryAction,
    }));
  });
}

function renderTaskActions(task = {}, resolved = false) {
  if (task.source !== "team") {
    if (task.source === "order") return renderOrderTaskActions(task, resolved);
    const label = "Open Return Task";
    return `
      <div class="team-task-actions">
        <a class="secondary-btn" href="${escapeHtml(task.actionHref || "#")}">${escapeHtml(label)}</a>
      </div>
      ${renderAdminHistoryActions(task)}
    `;
  }

  return `
    <div class="team-task-actions">
      ${resolved ? "" : `<button type="button" class="secondary-btn" data-team-task-progress="${escapeHtml(task.id)}">Progress / Delay</button>`}
      ${!resolved && !isAdminUser() && task.assigned_to_user_id === state.user?.id ? `<button type="button" class="secondary-btn" data-team-task-reassign-request="${escapeHtml(task.id)}">Request Reassign</button>` : ""}
      <button type="button" class="secondary-btn" data-team-task-reply="${escapeHtml(task.id)}">${escapeHtml(isAdminUser() ? "Reply / Reassign" : "Reply")}</button>
      ${resolved ? "" : `<button type="button" class="primary-btn" data-team-task-resolve="${escapeHtml(task.id)}">Mark Completed</button>`}
    </div>
    ${renderAdminAssignmentActions(task)}
    ${renderAdminHistoryActions(task)}
  `;
}

function renderAdminHistoryActions(task = {}) {
  if (!isAdminUser() || !isTaskHistoryView()) return "";
  if (isCanceledTaskScope()) {
    return `
      <div class="team-task-actions">
        <button type="button" class="secondary-btn" data-task-history-action="reopen" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Reopen Task</button>
      </div>
    `;
  }
  return `
    <div class="team-task-actions">
      <button type="button" class="secondary-btn" data-task-history-action="reopen" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Reopen Task</button>
      <button type="button" class="secondary-btn danger-btn" data-task-history-action="remove_history" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Remove from History</button>
    </div>
  `;
}

function renderOrderTaskActions(task = {}, resolved = false, options = {}) {
  const compact = Boolean(options.compact);
  const isParent = isOrderParentTask(task);
  const isSubtask = task.task_type === ORDER_SUBTASK_TYPE;
  const isShipping = task.task_type === ORDER_SHIPPING_TYPE;
  const isPackaging = task.task_type === ORDER_PACKAGING_TYPE;
  const assigneeCanUpdate = task.assigned_to_user_id === state.user?.id || isAdminUser();
  const workerOwnsTask = !isAdminUser() && task.assigned_to_user_id === state.user?.id;
  const canApproveShipping = isParent && isAdminUser() && canOrderTaskApproveForShipping(task)
    && !["assigned_for_shipping", "shipped_completed", "closed", "cancelled"].includes(task.status);

  if (resolved && !isParent) return renderAdminHistoryActions(task);

  const buttons = [];
  if (!compact && task.actionHref) {
    buttons.push(`<a class="secondary-btn" href="${escapeHtml(task.actionHref)}">Open Pending Order</a>`);
  }

  if (isParent && isAdminUser() && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="add-subtask" data-task-id="${escapeHtml(task.id)}">Add Subtask</button>`);
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="assign-shipping" data-task-id="${escapeHtml(task.id)}" ${canApproveShipping ? "" : "disabled"}>Approve / Assign Shipping</button>`);
  }

  if (isParent && workerOwnsTask && !["completed_by_employee", "approved_for_shipping", "assigned_for_shipping", "shipped_completed", "closed", "cancelled"].includes(task.status) && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="task-progress" data-task-id="${escapeHtml(task.id)}">Progress Update</button>`);
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="reassign-request" data-task-id="${escapeHtml(task.id)}">Request Reassign</button>`);
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="task-complete" data-task-id="${escapeHtml(task.id)}">Complete Task</button>`);
  }

  if (isSubtask && assigneeCanUpdate && !["completed_by_employee", "approved_by_admin"].includes(task.status) && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="subtask-progress" data-task-id="${escapeHtml(task.id)}">Progress Update</button>`);
    if (!isAdminUser() && task.assigned_to_user_id === state.user?.id) {
      buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="reassign-request" data-task-id="${escapeHtml(task.id)}">Request Reassign</button>`);
    }
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="subtask-complete" data-task-id="${escapeHtml(task.id)}">Mark Completed</button>`);
  }

  if (isSubtask && isAdminUser() && task.status === "completed_by_employee" && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="approve-subtask" data-task-id="${escapeHtml(task.id)}">Approve Subtask</button>`);
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="send-back-subtask" data-task-id="${escapeHtml(task.id)}">Send Back</button>`);
  }

  if ((isShipping || isPackaging) && assigneeCanUpdate && !["shipped_completed", "closed"].includes(task.status) && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="shipping-progress" data-task-id="${escapeHtml(task.id)}">Mark In Progress</button>`);
    if (isShipping && !isAdminUser() && task.assigned_to_user_id === state.user?.id) {
      buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="shipping-ready-packaging" data-task-id="${escapeHtml(task.id)}">Mark Ready for Packaging</button>`);
    }
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="shipping-complete" data-task-id="${escapeHtml(task.id)}">Mark Shipped</button>`);
  }

  if (!buttons.length) return `${renderAdminAssignmentActions(task)}${renderAdminHistoryActions(task)}`;
  return `<div class="team-task-actions">${buttons.join("")}</div>${renderAdminAssignmentActions(task)}${renderAdminHistoryActions(task)}`;
}

function renderTaskEvent(event = {}) {
  const photos = Array.isArray(event.photo_attachments) ? event.photo_attachments : [];
  const photoHtml = photos.length
    ? `<div class="team-task-event-photos">${photos.map((photo, index) => {
        const label = photo.label || `Photo ${index + 1}`;
        const url = photo.signedUrl || photo.url || "";
        const bucket = photo.bucket || photo.storage_bucket || TEAM_TASK_BUCKET;
        const path = photo.path || photo.storage_path || "";
        return `
        <button
          type="button"
          class="team-task-event-photo"
          data-team-task-photo="1"
          data-bucket="${escapeHtml(bucket)}"
          data-path="${escapeHtml(path)}"
          data-url="${escapeHtml(url)}"
          data-label="${escapeHtml(label)}"
          aria-label="Open ${escapeHtml(label)}"
        >
          ${url ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(label)}" loading="lazy" />` : `<span>${escapeHtml(label)}</span>`}
          <small>${escapeHtml(label)}</small>
        </button>
      `;
      }).join("")}</div>`
    : "";

  return `
    <article class="team-task-event">
      <div class="team-task-event-head">
        <strong>${escapeHtml(String(event.action || "commented").replace(/_/g, " "))}</strong>
        <span>${escapeHtml(formatDate(event.created_at))}</span>
      </div>
      ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
      <small>Signed by ${escapeHtml(event.signed_by_email || "logged-in user")} - ${escapeHtml(getTaskStatusLabel(event.new_status || event.old_status || ""))}</small>
      ${photoHtml}
    </article>
  `;
}

function openTaskPhotoViewer({ url = "", label = "", bucket = "", path = "", trigger = null } = {}) {
  const modal = $("team-task-photo-viewer-modal");
  const image = $("team-task-photo-viewer-image");
  const title = $("team-task-photo-viewer-title");
  const caption = $("team-task-photo-viewer-caption");
  if (!modal || !image) return false;

  state.photoViewerReturnFocus = trigger || document.activeElement;
  image.src = url;
  image.alt = label || "Task evidence photo";
  if (title) title.textContent = label || "Task evidence photo";
  if (caption) caption.textContent = [bucket, path].filter(Boolean).join(" / ");
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("close-team-task-photo-viewer")?.focus();
  return true;
}

function closeTaskPhotoViewer() {
  const modal = $("team-task-photo-viewer-modal");
  const image = $("team-task-photo-viewer-image");
  modal?.classList.add("hidden");
  if (image) image.removeAttribute("src");
  if ($("team-task-modal")?.classList.contains("hidden")) {
    document.body.classList.remove("modal-open");
  }
  const focusTarget = state.photoViewerReturnFocus;
  state.photoViewerReturnFocus = null;
  focusTarget?.focus?.();
}

function resetPhotos() {
  state.photos.forEach((photo) => {
    if (photo.previewUrl?.startsWith("blob:")) URL.revokeObjectURL(photo.previewUrl);
  });
  state.photos = [];
  renderPhotos();
}

function renderPhotos() {
  const grid = $("team-task-photo-grid");
  if (!grid) return;
  if (!state.photos.length) {
    grid.innerHTML = `<div class="empty-state">No task photos added.</div>`;
    return;
  }

  grid.innerHTML = state.photos.map((photo) => `
    <article class="team-task-photo-card">
      <img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl)}" alt="${escapeHtml(photo.label)}" />
      <span>${escapeHtml(photo.label)}</span>
    </article>
  `).join("");
}

function handlePhotoFiles(event) {
  const files = [...(event.target?.files || [])].filter((file) => /^image\//i.test(file.type || ""));
  if (!files.length) {
    setPhotoStatus("Choose image files to attach.", "error");
    return;
  }

  files.forEach((file, index) => {
    state.photos.push({
      file,
      previewUrl: URL.createObjectURL(file),
      label: file.name || `Task photo ${index + 1}`,
      mime_type: file.type || "image/jpeg",
    });
  });
  renderPhotos();
  setPhotoStatus(`${files.length} photo${files.length === 1 ? "" : "s"} added.`, "success");
  if (event.target) event.target.value = "";
}

function safePathSegment(value, fallback = "task") {
  const cleaned = String(value || "")
    .trim()
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[^a-z0-9._-]+/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 72);
  return cleaned || fallback;
}

function getPhotoExtension(file) {
  const source = `${file?.name || ""} ${file?.path || ""} ${file?.type || ""} ${file?.mime_type || ""}`.toLowerCase();
  if (source.includes("png")) return "png";
  if (source.includes("webp")) return "webp";
  if (source.includes("heic")) return "heic";
  if (source.includes("heif")) return "heif";
  return "jpg";
}

async function getTaskPhotoBlob(photo, index = 0) {
  if ((typeof File !== "undefined" && photo?.file instanceof File) || (typeof Blob !== "undefined" && photo?.file instanceof Blob)) return photo.file;
  const response = await fetch(photo.previewUrl);
  if (!response.ok) throw new Error(`Could not download task photo ${index + 1} before saving.`);
  return response.blob();
}

async function uploadPhotos(title) {
  if (!state.photos.length) return [];
  const dateFolder = new Date().toISOString().slice(0, 10);
  const taskFolder = safePathSegment(title, "team-task");
  const saved = [];

  for (let index = 0; index < state.photos.length; index += 1) {
    const photo = state.photos[index];
    const blob = await getTaskPhotoBlob(photo, index);
    const extension = getPhotoExtension(photo.file || photo);
    const originalName = safePathSegment(photo.label, `photo-${index + 1}`);
    const path = [
      "team-tasks",
      dateFolder,
      taskFolder,
      `${Date.now()}-${crypto.randomUUID()}-${originalName}.${extension}`,
    ].join("/");

    const { error } = await supabase.storage
      .from(TEAM_TASK_BUCKET)
      .upload(path, blob, {
        contentType: blob.type || photo.file?.type || photo.mime_type || "image/jpeg",
        upsert: false,
      });

    if (error) throw new Error(error.message || `Could not upload task photo ${index + 1}.`);

    saved.push({
      bucket: TEAM_TASK_BUCKET,
      path,
      label: photo.label || `Task photo ${index + 1}`,
      source_bucket: photo.bucket || null,
      source_path: photo.path || null,
      capture_job_id: photo.capture_job_id || null,
      mime_type: blob.type || photo.file?.type || photo.mime_type || null,
      size_bytes: blob.size || photo.file?.size || 0,
      created_at: new Date().toISOString(),
    });
  }

  return saved;
}

function delayCapture(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getPreferredCaptureStationHints() {
  try {
    return {
      stationId: String(window.OG_CAPTURE_STATION_ID || localStorage.getItem("og.captureStationId") || "").trim(),
      stationName: String(window.OG_CAPTURE_STATION_NAME || localStorage.getItem("og.captureStationName") || "").trim(),
    };
  } catch (_) {
    return { stationId: "", stationName: "" };
  }
}

function renderCaptureStations() {
  const select = $("team-task-capture-station");
  if (!select) return;
  if (!state.captureStations.length) {
    select.innerHTML = '<option value="">No active stations</option>';
    select.disabled = true;
    return;
  }

  select.replaceChildren(new Option("Choose station", ""));
  state.captureStations.forEach((station) => {
    select.appendChild(new Option(station.name || station.id, station.id));
  });
  select.value = state.captureStations.some((station) => station.id === state.selectedCaptureStationId)
    ? state.selectedCaptureStationId
    : "";
  select.disabled = false;
}

function setSelectedCaptureStation(stationId = "") {
  const station = state.captureStations.find((entry) => entry.id === stationId) || null;
  state.selectedCaptureStationId = station?.id || "";
  const select = $("team-task-capture-station");
  if (select && select.value !== state.selectedCaptureStationId) select.value = state.selectedCaptureStationId;

  try {
    if (station) {
      localStorage.setItem("og.captureStationId", station.id);
      localStorage.setItem("og.captureStationName", station.name || "");
    }
  } catch (_) {}

  return station;
}

async function loadCaptureStations({ silent = false } = {}) {
  const select = $("team-task-capture-station");
  if (select) {
    select.disabled = true;
    select.innerHTML = '<option value="">Loading stations...</option>';
  }

  const { data, error } = await supabase
    .from(CAPTURE_STATION_TABLE)
    .select("id, name, active")
    .eq("active", true)
    .order("name", { ascending: true });

  if (error) throw new Error(error.message || "Could not load capture stations.");

  state.captureStations = Array.isArray(data) ? data : [];
  const { stationId, stationName } = getPreferredCaptureStationHints();
  const nextStation = state.captureStations.find((station) => station.id === state.selectedCaptureStationId)
    || state.captureStations.find((station) => station.id === stationId)
    || state.captureStations.find((station) => String(station.name || "").trim().toLowerCase() === stationName.toLowerCase())
    || state.captureStations[0]
    || null;

  setSelectedCaptureStation(nextStation?.id || "");
  renderCaptureStations();
  if (!silent) {
    setPhotoStatus(nextStation ? `Ready to take task photos on ${nextStation.name || "selected station"}.` : "No active capture stations are available.", nextStation ? "info" : "error");
  }
  return state.captureStations;
}

async function createCaptureJob(stationId) {
  const { data, error } = await supabase
    .from(CAPTURE_JOB_TABLE)
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

function captureJobHasUpload(job) {
  return Boolean(job?.storage_bucket && job?.storage_path)
    || Boolean(job?.upload_completed_at)
    || Boolean(job?.capture_completed_at && job?.storage_path);
}

async function getCaptureJobPhotoCount(jobId) {
  const { count, error } = await supabase
    .from(CAPTURE_PHOTO_TABLE)
    .select("id", { count: "exact", head: true })
    .eq("capture_job_id", jobId);

  if (error) {
    console.warn("Could not check capture photo count:", error);
    return 0;
  }
  return count || 0;
}

async function pollCaptureJob(job, station = {}) {
  const jobId = job?.id || job;
  const stationName = station.name || "";
  const startedAt = Date.now();
  let lastPhotoCount = 0;
  let lastPhotoChangeAt = startedAt;

  while ((Date.now() - startedAt) < CAPTURE_POLL_TIMEOUT_MS) {
    const { data, error } = await supabase
      .from(CAPTURE_JOB_TABLE)
      .select("id, station_id, status, storage_bucket, storage_path, capture_completed_at, upload_completed_at, mime_type, file_size_bytes, failure_code, failure_message, requested_at")
      .eq("id", jobId)
      .single();

    if (error || !data) throw new Error(error?.message || "Failed to poll capture job.");
    if (data.status === "completed" || data.status === "failed") return data;

    const photoCount = await getCaptureJobPhotoCount(jobId);
    if (photoCount !== lastPhotoCount) {
      lastPhotoCount = photoCount;
      lastPhotoChangeAt = Date.now();
    }
    if (captureJobHasUpload(data)) return { ...data, status: "completed" };
    if (photoCount > 0 && (Date.now() - lastPhotoChangeAt) >= CAPTURE_PHOTO_SETTLE_MS) {
      return { ...data, status: "completed" };
    }

    const label = data.status === "queued"
      ? `Capture queued${stationName ? ` on ${stationName}` : ""}. Waiting for camera...`
      : data.status === "capturing"
        ? `Camera is capturing${stationName ? ` on ${stationName}` : ""}...`
        : data.status === "uploading"
          ? `Camera is uploading${stationName ? ` on ${stationName}` : ""}...`
          : `Capture status: ${data.status || "waiting"}`;
    setPhotoStatus(photoCount > 0 ? `${label} ${photoCount} photo${photoCount === 1 ? "" : "s"} received...` : label, "info");
    await delayCapture(CAPTURE_POLL_INTERVAL_MS);
  }

  throw new Error("Timed out waiting for camera capture.");
}

async function loadCaptureJobPhotos(jobId) {
  const { data, error } = await supabase
    .from(CAPTURE_PHOTO_TABLE)
    .select("id, capture_job_id, sort_order, is_primary, storage_bucket, storage_path, mime_type, label, created_at")
    .eq("capture_job_id", jobId)
    .order("sort_order", { ascending: true });

  if (error) throw new Error(error.message || "Failed to load capture photos.");
  return Array.isArray(data) ? data : [];
}

async function createSignedImageUrl(bucket, path, options = {}) {
  if (!bucket || !path) return "";
  try {
    const { data, error } = options.transform
      ? await supabase.storage.from(bucket).createSignedUrl(path, TEAM_TASK_SIGNED_URL_TTL_SECONDS, { transform: options.transform })
      : await supabase.storage.from(bucket).createSignedUrl(path, TEAM_TASK_SIGNED_URL_TTL_SECONDS);
    if (!error && data?.signedUrl) return data.signedUrl;
    if (!options.transform) return "";
  } catch (_) {
    if (!options.transform) return "";
  }
  return createSignedImageUrl(bucket, path);
}

async function captureRowsToTaskPhotos(rows) {
  const photos = [];
  for (let index = 0; index < (rows || []).length; index += 1) {
    const row = rows[index];
    const bucket = String(row?.storage_bucket || "").trim();
    const path = String(row?.storage_path || "").trim();
    if (!bucket || !path) continue;
    const [previewUrl, thumbnailUrl] = await Promise.all([
      createSignedImageUrl(bucket, path),
      createSignedImageUrl(bucket, path, { transform: CAPTURE_THUMBNAIL_TRANSFORM }),
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
      label: row.label || `Task photo ${index + 1}`,
      mime_type: row.mime_type || "image/jpeg",
      created_at: row.created_at || new Date().toISOString(),
    });
  }
  return photos;
}

async function requestTaskPhoto() {
  if (state.captureBusy) return;
  try {
    state.captureBusy = true;
    $("request-team-task-photo")?.toggleAttribute("disabled", true);

    if (!state.captureStations.length) {
      await loadCaptureStations({ silent: true });
    }

    const station = state.captureStations.find((entry) => entry.id === state.selectedCaptureStationId) || null;
    if (!station) {
      setPhotoStatus("Choose a camera station before taking task photos.", "error");
      $("team-task-capture-station")?.focus();
      return;
    }

    setPhotoStatus(`Sending camera request to ${station.name || "selected station"}...`, "info");
    const job = await createCaptureJob(station.id);

    window.dispatchEvent(new CustomEvent("assisted:iphone-capture-requested", {
      detail: {
        source: "team-task",
        stationId: station.id,
        stationName: station.name || "",
        jobId: job.id,
        taskId: state.mode === "reply" ? state.activeTaskId : "",
      },
    }));

    const completedJob = await pollCaptureJob(job, station);
    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || "Camera capture failed.");
    }

    let photoRows = await loadCaptureJobPhotos(completedJob.id);
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

    const photos = await captureRowsToTaskPhotos(photoRows);
    const existing = new Set(state.photos.map((photo) => `${photo.bucket || ""}:${photo.path || photo.label}`));
    photos.forEach((photo) => {
      if (!existing.has(`${photo.bucket}:${photo.path}`)) state.photos.push(photo);
    });
    renderPhotos();
    setPhotoStatus(`${photos.length} task photo${photos.length === 1 ? "" : "s"} added.`, "success");
  } catch (error) {
    console.error("Team task photo capture failed:", error);
    setPhotoStatus(error?.message || "Could not take task photo.", "error");
  } finally {
    state.captureBusy = false;
    $("request-team-task-photo")?.toggleAttribute("disabled", false);
  }
}

function localDateTimeToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function openModal() {
  $("team-task-modal")?.classList.remove("hidden");
  document.body.classList.add("modal-open");
}

function closeModal() {
  $("team-task-modal")?.classList.add("hidden");
  document.body.classList.remove("modal-open");
  state.mode = "create";
  state.activeTaskId = "";
  state.activeTaskSource = "";
  resetPhotos();
  setModalError("");
  setPhotoStatus("");
}

function findOrderTaskById(taskId = "") {
  return [...state.tasks, ...getAllWorkflowChildTasks()].find((task) => task.source === "order" && task.id === taskId) || null;
}

function findUnifiedTaskBySourceAndId(source = "", taskId = "") {
  const baseTasks = [...state.tasks, ...state.removedTasks];
  const tasks = source === "order" ? [...baseTasks, ...getAllWorkflowChildTasks()] : baseTasks;
  return tasks.find((task) => task.source === source && task.id === taskId) || null;
}

function hasReassignRequest(task = {}) {
  if (!isAdminUser() || !task.assigned_to_user_id || String(task.status || "") !== "waiting_on_admin") return false;
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  return events.some((event) => isReassignRequestEvent(task, event));
}

function isReassignRequestEvent(task = {}, event = {}) {
  return (
    String(event.new_status || "") === "waiting_on_admin"
    && String(event.old_status || "") !== "waiting_on_admin"
    && (event.signed_by === task.assigned_to_user_id || (
      event.signed_by_email
      && task.assigned_to_email
      && String(event.signed_by_email).toLowerCase() === String(task.assigned_to_email).toLowerCase()
    ))
  );
}

function getLatestReassignRequestEvent(task = {}) {
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  return [...events].reverse().find((event) => isReassignRequestEvent(task, event)) || null;
}

function renderAdminReassignRequestNotice(task = {}) {
  const event = getLatestReassignRequestEvent(task);
  if (!event) return "";
  const requester = event.signed_by_email || task.assigned_to_email || "assigned employee";
  return `
    <div class="team-task-admin-notice">
      <strong>Reassignment requested by ${escapeHtml(requester)}</strong>
      <span>${escapeHtml(event.notes || "No reason provided.")}</span>
      <small>Current assignee: ${escapeHtml(getTaskAssigneeLabel(task))}</small>
      <small>${escapeHtml(formatDate(event.created_at))}</small>
    </div>
  `;
}

function renderAdminAssignmentActions(task = {}) {
  if (!isAdminUser() || isTaskHistoryView()) return "";
  const canReassign = Boolean(task.assigned_to_user_id);
  const canDecline = hasReassignRequest(task);
  const canCancel = Boolean(task.assigned_to_user_id);
  if (!canReassign && !canDecline && !canCancel) return "";

  return `
    <div class="team-task-actions">
      ${canReassign ? `<button type="button" class="secondary-btn" data-task-assignment-action="reassign" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Reassign Task</button>` : ""}
      ${canDecline ? `<button type="button" class="secondary-btn" data-task-assignment-action="decline_reassign" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Decline Reassign</button>` : ""}
      ${canCancel ? `<button type="button" class="secondary-btn danger-btn" data-task-assignment-action="cancel_assignment" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Cancel Assignment</button>` : ""}
    </div>
  `;
}

function configureOrderWorkflowModal(task, options = {}) {
  state.mode = options.mode || "order-progress";
  state.activeTaskId = task?.id || "";
  resetPhotos();
  setModalError("");
  setPhotoStatus("");

  const mode = state.mode;
  const isSubtaskCreate = mode === "order-subtask-create";
  const isShippingAssign = mode === "order-shipping-assign";
  const isShippingReadyPackaging = mode === "order-shipping-ready-packaging";
  const isSendBack = mode === "order-subtask-sendback";
  const isComplete = mode === "order-subtask-complete" || mode === "order-shipping-complete" || mode === "order-task-complete";
  const isReassignRequest = mode === "order-reassign-request";
  const canManageFields = isAdminUser();

  const titles = {
    "order-subtask-create": "Create pending order subtask",
    "order-task-progress": "Task progress update",
    "order-task-complete": "Complete assigned task",
    "order-subtask-progress": "Subtask progress update",
    "order-subtask-complete": "Complete subtask",
    "order-subtask-approve": "Approve subtask",
    "order-subtask-sendback": "Send subtask back",
    "order-reassign-request": "Request reassignment",
    "order-shipping-assign": "Approve and assign shipping",
    "order-shipping-ready-packaging": "Mark ready for packaging",
    "order-shipping-complete": "Complete shipping task",
  };
  const subtitles = {
    "order-subtask-create": "Assign the required work before this pending order can be approved for shipment.",
    "order-task-progress": "Add a progress note, blocker, or evidence photo for the admin to review.",
    "order-task-complete": "Add the final sign-off note and any audit photos before sending this back to the admin.",
    "order-subtask-progress": "Add a progress note, blocker, or evidence photo for the admin to review.",
    "order-subtask-complete": "Add the final sign-off note and any proof before sending this back to the admin.",
    "order-subtask-approve": "Confirm this subtask is complete and acceptable for shipment approval.",
    "order-subtask-sendback": "Explain exactly what needs to be corrected before this can be approved.",
    "order-reassign-request": "Tell the admin why this task should be reassigned. The task owner will not change until an admin approves it.",
    "order-shipping-assign": "Confirm the pending order is ready and assign the shipping task to an employee.",
    "order-shipping-ready-packaging": "Add the ready-for-packaging audit photo, then choose who will package and ship this order.",
    "order-shipping-complete": "Confirm shipment completion with final notes or proof.",
  };

  $("team-task-modal-title").textContent = titles[mode] || "Pending order task update";
  $("team-task-modal-subtitle").textContent = subtitles[mode] || "Save the next workflow update in the audit trail.";
  $("team-task-title-field")?.classList.toggle("hidden", !isSubtaskCreate);
  $("team-task-status-field")?.classList.add("hidden");
  $("submit-team-task").textContent = isSubtaskCreate
    ? "Create Subtask"
    : isShippingAssign
      ? "Approve / Assign"
      : isShippingReadyPackaging
        ? "Mark Ready"
      : isComplete
        ? "Mark Completed"
        : isSendBack
          ? "Send Back"
          : isReassignRequest
            ? "Request Reassign"
            : "Save Update";

  $("team-task-title-input").value = "";
  $("team-task-note").value = "";
  $("team-task-note").placeholder = isSubtaskCreate
    ? "Write the instructions the employee must follow."
    : isShippingAssign
      ? "Add shipment notes for the employee."
      : isShippingReadyPackaging
        ? "What did you gather and verify before packaging?"
      : isSendBack
        ? "What needs to be fixed or redone?"
        : isReassignRequest
          ? "Why should this be reassigned? Add anything the admin should know."
        : isComplete
          ? "Final completion note."
          : "Progress update, blocker, or admin note.";
  $("team-task-type").value = isShippingAssign ? "shipping" : "admin_review";
  $("team-task-priority").value = task?.priority || "normal";
  $("team-task-due-at").value = toDateTimeLocalValue(task?.due_at || "");
  $("team-task-status-input").value = "";
  renderAssigneeSelect();
  $("team-task-assignee").value = isShippingReadyPackaging
    ? (state.user?.id || task?.assigned_to_user_id || "")
    : (isSubtaskCreate || isShippingAssign || isSendBack)
        ? (task?.assigned_to_user_id || "")
        : "";
  configureModalAdminFields({
    assignee: (canManageFields && (isSubtaskCreate || isShippingAssign || isSendBack)) || isShippingReadyPackaging,
    category: canManageFields && (isSubtaskCreate || isShippingAssign || isSendBack),
    priority: canManageFields || isShippingReadyPackaging,
    due: canManageFields || isShippingReadyPackaging,
    status: false,
  });

  openModal();
  setTimeout(() => (isSubtaskCreate ? $("team-task-title-input") : $("team-task-note"))?.focus(), 80);
  loadCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not load team task capture stations:", error);
    setPhotoStatus(error?.message || "Could not load capture stations.", "error");
  });
}

function handleOrderWorkflowAction(action = "", taskId = "") {
  const task = findOrderTaskById(taskId);
  if (!task) return setStatus("Could not find that pending order task. Refresh and try again.", "error");

  if (action === "add-subtask") return configureOrderWorkflowModal(task, { mode: "order-subtask-create" });
  if (action === "task-progress") return configureOrderWorkflowModal(task, { mode: "order-task-progress" });
  if (action === "task-complete") return configureOrderWorkflowModal(task, { mode: "order-task-complete" });
  if (action === "subtask-progress") return configureOrderWorkflowModal(task, { mode: "order-subtask-progress" });
  if (action === "subtask-complete") return configureOrderWorkflowModal(task, { mode: "order-subtask-complete" });
  if (action === "reassign-request") return configureOrderWorkflowModal(task, { mode: "order-reassign-request" });
  if (action === "approve-subtask") return configureOrderWorkflowModal(task, { mode: "order-subtask-approve" });
  if (action === "send-back-subtask") return configureOrderWorkflowModal(task, { mode: "order-subtask-sendback" });
  if (action === "assign-shipping") return configureOrderWorkflowModal(task, { mode: "order-shipping-assign" });
  if (action === "shipping-ready-packaging") return configureOrderWorkflowModal(task, { mode: "order-shipping-ready-packaging" });
  if (action === "shipping-complete") return configureOrderWorkflowModal(task, { mode: "order-shipping-complete" });
  if (action === "shipping-progress") {
    return saveOrderWorkflowUpdate({
      task,
      status: "in_progress",
      note: "Shipping task started.",
      successMessage: "Shipping task marked in progress.",
    }).catch((error) => {
      console.error("Could not mark shipping task in progress:", error);
      setStatus(error?.message || "Could not update shipping task.", "error");
    });
  }

  return setStatus("That pending order action is not available.", "error");
}

function openAdminAssignmentModal({ taskSource = "", taskId = "", action = "" } = {}) {
  const task = findUnifiedTaskBySourceAndId(taskSource, taskId);
  if (!task) return setStatus("Could not find that task. Refresh and try again.", "error");
  if (!isAdminUser()) return setStatus("Only admins can manage task assignments.", "error");

  if (action === "cancel_assignment") {
    return saveAdminAssignmentAction({
      task,
      action,
      confirmMessage: "Cancel this assignment and return the task to the unassigned queue?",
      successMessage: "Assignment cancelled.",
    });
  }

  state.mode = `assignment-${action}`;
  state.activeTaskId = task.id;
  state.activeTaskSource = task.source;
  resetPhotos();
  setModalError("");
  setPhotoStatus("");

  const isReassign = action === "reassign";
  const isDecline = action === "decline_reassign";
  const isCancel = action === "cancel_assignment";
  const title = isReassign ? "Reassign task" : isDecline ? "Decline reassignment" : "Cancel assignment";
  const subtitle = isReassign
    ? "Move this task to another employee and keep the action in the audit trail."
    : isDecline
      ? "Keep the task assigned to the current employee and send the decision back into the trail."
      : "Remove the current assignee and return this task to the unassigned work queue.";

  $("team-task-modal-title").textContent = title;
  $("team-task-modal-subtitle").textContent = subtitle;
  $("team-task-title-field")?.classList.add("hidden");
  $("submit-team-task").textContent = isReassign ? "Reassign Task" : isDecline ? "Decline Request" : "Cancel Assignment";
  $("team-task-title-input").value = "";
  $("team-task-note").value = "";
  $("team-task-note").placeholder = isReassign
    ? "Optional note for the new assignee and audit trail."
    : isDecline
      ? "Why is this reassignment request declined?"
      : "Why is this assignment being cancelled?";
  $("team-task-type").value = task?.task_type || "general";
  $("team-task-priority").value = task?.priority || "normal";
  $("team-task-due-at").value = toDateTimeLocalValue(task?.due_at || "");
  $("team-task-status-input").value = "";
  renderAssigneeSelect();
  $("team-task-assignee").value = isReassign ? "" : (task?.assigned_to_user_id || "");
  configureModalAdminFields({
    assignee: isReassign,
    category: false,
    priority: false,
    due: false,
    status: false,
  });

  openModal();
  setTimeout(() => (isReassign ? $("team-task-assignee") : $("team-task-note"))?.focus(), 80);
}

async function saveAdminAssignmentAction({
  task,
  action,
  assignedToUserId = null,
  note = "",
  confirmMessage = "",
  successMessage = "Assignment updated.",
} = {}) {
  if (!task?.id) return setStatus("Could not find that task. Refresh and try again.", "error");
  if (!isAdminUser()) return setStatus("Only admins can manage task assignments.", "error");
  if (confirmMessage && !window.confirm(confirmMessage)) return;

  const controls = document.querySelectorAll(`[data-task-assignment-action][data-task-id="${CSS.escape(task.id)}"]`);
  controls.forEach((button) => button.toggleAttribute("disabled", true));
  setStatus("Saving assignment decision...", "info");

  try {
    const signedByEmail = state.user?.email || state.employee?.email || state.employee?.display_name || "";
    const { error } = await supabase.rpc("admin_manage_task_assignment", {
      _task_source: task.source,
      _task_id: task.id,
      _action: action,
      _assigned_to_user_id: assignedToUserId || null,
      _note: note || null,
      _signed_by_email: signedByEmail,
    });
    if (error) throw error;
    setStatus(successMessage, "success");
    closeModal();
    await loadTasks();
  } catch (error) {
    console.error("Could not save assignment decision:", error);
    setStatus(error?.message || "Could not save this assignment decision.", "error");
    setModalError(error?.message || "Could not save this assignment decision.");
  } finally {
    controls.forEach((button) => button.toggleAttribute("disabled", false));
  }
}

async function handleAdminHistoryAction({ taskSource = "", taskId = "", action = "" } = {}) {
  if (!isAdminUser()) return setStatus("Only admins can manage task history.", "error");
  const task = findUnifiedTaskBySourceAndId(taskSource, taskId);
  if (!task) return setStatus("Could not find that history task. Refresh and try again.", "error");

  const isRemove = action === "remove_history";
  const promptText = isRemove
    ? "Why should this task be removed from task history?"
    : "Optional note for reopening this task:";
  const note = window.prompt(promptText, "");
  if (note === null) return;
  if (isRemove && !String(note || "").trim()) {
    return setStatus("Add a reason before removing a task from history.", "error");
  }

  const confirmText = isRemove
    ? "Move this task into the admin-only Canceled Tasks section? The audit record will be preserved."
    : "Reopen this task and move it back to active work?";
  if (!window.confirm(confirmText)) return;

  const controls = document.querySelectorAll(`[data-task-history-action][data-task-id="${CSS.escape(task.id)}"]`);
  controls.forEach((button) => button.toggleAttribute("disabled", true));
  setStatus(isRemove ? "Removing task from history..." : "Reopening task...", "info");

  try {
    const signedByEmail = state.user?.email || state.employee?.email || state.employee?.display_name || "";
    const { error } = await supabase.rpc("admin_manage_task_history", {
      _task_source: task.source,
      _task_id: task.id,
      _action: action,
      _note: String(note || "").trim() || null,
      _signed_by_email: signedByEmail,
    });
    if (error) throw error;
    setStatus(isRemove ? "Task moved to Canceled Tasks." : "Task reopened.", "success");
    await loadTasks();
  } catch (error) {
    console.error("Could not manage task history:", error);
    setStatus(error?.message || "Could not update task history.", "error");
  } finally {
    controls.forEach((button) => button.toggleAttribute("disabled", false));
  }
}

async function openTaskModal(options = {}) {
  const taskId = options.taskId || "";
  const task = taskId ? state.tasks.find((entry) => entry.source === "team" && entry.id === taskId) : null;
  state.mode = task ? "reply" : "create";
  state.activeTaskId = task?.id || "";
  resetPhotos();
  setModalError("");
  setPhotoStatus("");

  $("team-task-modal-title").textContent = task
    ? options.reassignRequest ? "Request reassignment" : options.resolve ? "Complete task" : options.progress ? "Progress / delay update" : "Reply to team task"
    : "Create team task";
  $("team-task-modal-subtitle").textContent = task
    ? options.reassignRequest
      ? "Send a note to the admin asking them to move this task. The assignment will stay unchanged until an admin reviews it."
      : options.resolve
        ? "Add the final completion note and any proof before closing this task."
        : options.progress
      ? "Explain what happened, what is blocking completion, and when this should be checked again."
      : "Add the next note, reassign the work, or mark it completed."
    : "Assign independent work and keep the documentation in one place.";
  $("team-task-title-field")?.classList.toggle("hidden", Boolean(task));
  $("submit-team-task").textContent = task
    ? options.resolve
      ? "Mark Completed"
      : options.reassignRequest
        ? "Request Reassign"
        : options.progress
          ? "Save Progress"
          : "Save Update"
    : "Save Task";

  $("team-task-title-input").value = "";
  $("team-task-note").value = "";
  $("team-task-note").placeholder = options.reassignRequest
    ? "Why should this be reassigned? Add anything the admin should know."
    : options.resolve
      ? "Final completion note."
      : options.progress
        ? "Why could this not be completed today? What are we waiting for, and what should happen next?"
        : "Write the instructions, answer, or completion note.";
  $("team-task-type").value = task?.task_type || "general";
  $("team-task-priority").value = task?.priority || "normal";
  $("team-task-due-at").value = toDateTimeLocalValue(task?.due_at || "");
  $("team-task-status-input").value = options.resolve ? "resolved" : options.reassignRequest ? "waiting_on_admin" : options.progress ? "deferred" : "";
  renderAssigneeSelect();
  $("team-task-assignee").value = task?.assigned_to_user_id || "";
  configureModalAdminFields({
    assignee: !task || isAdminUser(),
    category: !task || isAdminUser(),
    priority: !task || isAdminUser(),
    due: !task || isAdminUser(),
    status: Boolean(task) && isAdminUser(),
  });

  openModal();
  setTimeout(() => (task ? $("team-task-note") : $("team-task-title-input"))?.focus(), 80);
  loadCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not load team task capture stations:", error);
    setPhotoStatus(error?.message || "Could not load capture stations.", "error");
  });
}

async function saveOrderWorkflowUpdate({
  task,
  status = null,
  note = "",
  assignedToUserId = null,
  priority = null,
  dueAt = null,
  photos = [],
  successMessage = "Pending order task updated.",
} = {}) {
  if (!task?.id) throw new Error("Missing pending order task.");
  const signedByEmail = state.user?.email || state.employee?.email || state.employee?.display_name || "";
  const { error } = await supabase.rpc("respond_ebay_order_coordination_task", {
    _task_id: task.id,
    _note: note || null,
    _assigned_to_user_id: assignedToUserId || null,
    _status: status || null,
    _priority: priority || null,
    _photo_attachments: photos,
    _signed_by_email: signedByEmail,
    _due_at: dueAt || null,
  });
  if (error) throw error;
  setStatus(successMessage, "success");
  await loadTasks();
}

async function submitOrderWorkflowTask() {
  const task = findOrderTaskById(state.activeTaskId);
  if (!task) return setModalError("Could not find this pending order task. Refresh and try again.");

  const mode = state.mode;
  const title = String($("team-task-title-input")?.value || "").trim();
  const note = String($("team-task-note")?.value || "").trim();
  const canManageFields = isAdminUser();
  const isShippingReadyPackaging = mode === "order-shipping-ready-packaging";
  const assigneeId = (canManageFields || isShippingReadyPackaging) ? $("team-task-assignee")?.value || null : null;
  const priority = (canManageFields || isShippingReadyPackaging) ? $("team-task-priority")?.value || "normal" : null;
  const dueAt = (canManageFields || isShippingReadyPackaging) ? localDateTimeToIso($("team-task-due-at")?.value || "") : null;

  if (mode === "order-subtask-create" && !title) return setModalError("Write a subtask title first.");
  if (mode === "order-subtask-create" && !note) return setModalError("Write the subtask instructions first.");
  if (["order-subtask-create", "order-shipping-assign", "order-shipping-ready-packaging"].includes(mode) && !assigneeId) return setModalError("Choose the employee who should package this shipment.");
  if (["order-task-complete", "order-subtask-complete", "order-subtask-sendback", "order-shipping-ready-packaging", "order-shipping-complete", "order-reassign-request"].includes(mode) && !note) {
    return setModalError("Write the required note before saving.");
  }
  if (["order-shipping-ready-packaging", "order-shipping-complete"].includes(mode) && !state.photos.length) {
    return setModalError(mode === "order-shipping-complete"
      ? "Add photo proof of the packaged item and shipping label before marking shipped."
      : "Add an audit photo before marking this ready for packaging.");
  }

  if (mode === "order-shipping-assign" && !window.confirm("Approve this pending order for shipment and assign the shipping task?")) return;
  if (mode === "order-task-complete" && !window.confirm("Mark this task completed and send it back to admin review?")) return;
  if (mode === "order-subtask-sendback" && !window.confirm("Send this subtask back for rework?")) return;
  if (mode === "order-shipping-ready-packaging" && !window.confirm(
    assigneeId === state.user?.id
      ? "Mark this ready for packaging and keep it assigned to you?"
      : "Mark this ready for packaging and hand it off to the selected worker?"
  )) return;
  if (mode === "order-shipping-complete" && !window.confirm("Mark this shipment task completed?")) return;

  const submit = $("submit-team-task");
  submit?.toggleAttribute("disabled", true);
  setModalError("");
  setPhotoStatus("Saving pending order workflow update...", "info");

  try {
    const photos = await uploadPhotos(title || task.title || "pending-order-task");
    const signedByEmail = state.user?.email || state.employee?.email || state.employee?.display_name || "";

    if (mode === "order-subtask-create") {
      const { error } = await supabase.rpc("create_ebay_order_subtask", {
        _parent_task_id: task.id,
        _title: title,
        _description: note,
        _assigned_to_user_id: assigneeId,
        _priority: priority,
        _due_at: dueAt || null,
        _photo_attachments: photos,
        _signed_by_email: signedByEmail,
      });
      if (error) throw error;
      setStatus("Subtask created and assigned.", "success");
    } else if (mode === "order-task-progress") {
      await saveOrderWorkflowUpdate({
        task,
        status: "in_progress",
        note,
        priority,
        dueAt,
        photos,
        successMessage: "Task progress sent to admin.",
      });
    } else if (mode === "order-task-complete") {
      await saveOrderWorkflowUpdate({
        task,
        status: "completed_by_employee",
        note,
        priority,
        dueAt,
        photos,
        successMessage: "Task completed and sent to admin review.",
      });
    } else if (mode === "order-subtask-progress") {
      await saveOrderWorkflowUpdate({
        task,
        status: "in_progress",
        note,
        priority,
        dueAt,
        photos,
        successMessage: "Subtask progress saved.",
      });
    } else if (mode === "order-subtask-complete") {
      await saveOrderWorkflowUpdate({
        task,
        status: "completed_by_employee",
        note,
        priority,
        dueAt,
        photos,
        successMessage: "Subtask marked completed for admin review.",
      });
    } else if (mode === "order-reassign-request") {
      await saveOrderWorkflowUpdate({
        task,
        status: "waiting_on_admin",
        note,
        photos,
        successMessage: "Reassignment request sent to admin.",
      });
    } else if (mode === "order-subtask-approve") {
      const { error } = await supabase.rpc("approve_ebay_order_subtask", {
        _task_id: task.id,
        _note: note || null,
        _signed_by_email: signedByEmail,
      });
      if (error) throw error;
      setStatus("Subtask approved.", "success");
    } else if (mode === "order-subtask-sendback") {
      const { error } = await supabase.rpc("send_back_ebay_order_subtask", {
        _task_id: task.id,
        _note: note,
        _assigned_to_user_id: assigneeId || task.assigned_to_user_id || null,
        _due_at: dueAt || null,
        _signed_by_email: signedByEmail,
      });
      if (error) throw error;
      setStatus("Subtask sent back for rework.", "success");
    } else if (mode === "order-shipping-assign") {
      const { error } = await supabase.rpc("assign_ebay_order_shipping_task", {
        _parent_task_id: task.id,
        _assigned_to_user_id: assigneeId,
        _note: note || null,
        _due_at: dueAt || null,
        _signed_by_email: signedByEmail,
      });
      if (error) throw error;
      setStatus("Pending order approved and shipping task assigned.", "success");
    } else if (mode === "order-shipping-ready-packaging") {
      const { error } = await supabase.rpc("handoff_ebay_order_shipping_task", {
        _task_id: task.id,
        _assigned_to_user_id: assigneeId,
        _note: note,
        _photo_attachments: photos,
        _due_at: dueAt || null,
        _signed_by_email: signedByEmail,
      });
      if (error) throw error;
      setStatus(assigneeId === state.user?.id ? "Shipment ready for you to package." : "Shipment handed off for packaging.", "success");
    } else if (mode === "order-shipping-complete") {
      await saveOrderWorkflowUpdate({
        task,
        status: "shipped_completed",
        note,
        priority,
        dueAt,
        photos,
        successMessage: "Shipping task completed.",
      });
    }

    closeModal();
    await loadTasks();
  } catch (error) {
    console.error("Could not save pending order workflow task:", error);
    setModalError(error?.message || "Could not save this pending order workflow update.");
    setPhotoStatus("", "info");
  } finally {
    submit?.toggleAttribute("disabled", false);
  }
}

async function submitAdminAssignmentAction() {
  if (!isAdminUser()) return setModalError("Only admins can manage task assignments.");
  const action = String(state.mode || "").replace(/^assignment-/, "");
  const task = findUnifiedTaskBySourceAndId(state.activeTaskSource, state.activeTaskId);
  if (!task) return setModalError("Could not find this task. Refresh and try again.");

  const note = String($("team-task-note")?.value || "").trim();
  const assigneeId = $("team-task-assignee")?.value || null;
  if (action === "reassign" && !assigneeId) return setModalError("Choose the employee who should receive this task.");
  if (action === "decline_reassign" && !note) return setModalError("Write why this reassignment request is declined.");

  const submit = $("submit-team-task");
  submit?.toggleAttribute("disabled", true);
  setModalError("");
  setPhotoStatus("Saving assignment decision...", "info");

  try {
    await saveAdminAssignmentAction({
      task,
      action,
      assignedToUserId: action === "reassign" ? assigneeId : null,
      note,
      successMessage: action === "reassign"
        ? "Task reassigned."
        : action === "decline_reassign"
          ? "Reassignment request declined."
          : "Assignment cancelled.",
    });
  } catch (error) {
    console.error("Could not save assignment decision:", error);
    setModalError(error?.message || "Could not save this assignment decision.");
    setPhotoStatus("", "info");
  } finally {
    submit?.toggleAttribute("disabled", false);
  }
}

async function submitTask() {
  if (String(state.mode || "").startsWith("assignment-")) return submitAdminAssignmentAction();
  if (String(state.mode || "").startsWith("order-")) return submitOrderWorkflowTask();

  const title = String($("team-task-title-input")?.value || "").trim();
  const note = String($("team-task-note")?.value || "").trim();
  if (state.mode === "create" && !title) return setModalError("Write a task title first.");
  if (!note && state.mode === "reply") return setModalError("Write a note before saving the update.");

  const submit = $("submit-team-task");
  submit?.toggleAttribute("disabled", true);
  setModalError("");
  setPhotoStatus("Saving task...", "info");

  try {
    const task = state.activeTaskId ? state.tasks.find((entry) => entry.id === state.activeTaskId) : null;
    const photoContext = title || task?.title || "team-task";
    const photos = await uploadPhotos(photoContext);
    const signedByEmail = state.user?.email || state.employee?.email || state.employee?.display_name || "";

    if (state.mode === "reply" && state.activeTaskId) {
      const canManageFields = isAdminUser();
      const { error } = await supabase.rpc("respond_team_task", {
        _task_id: state.activeTaskId,
        _note: note,
        _assigned_to_user_id: canManageFields ? $("team-task-assignee")?.value || null : null,
        _status: $("team-task-status-input")?.value || null,
        _priority: canManageFields ? $("team-task-priority")?.value || null : null,
        _photo_attachments: photos,
        _signed_by_email: signedByEmail,
        _due_at: canManageFields ? localDateTimeToIso($("team-task-due-at")?.value || "") : null,
      });
      if (error) throw error;
      setStatus("Team task updated.", "success");
    } else {
      const { error } = await supabase.rpc("create_team_task", {
        _title: title,
        _description: note || null,
        _task_type: $("team-task-type")?.value || "general",
        _assigned_to_user_id: $("team-task-assignee")?.value || null,
        _priority: $("team-task-priority")?.value || "normal",
        _due_at: localDateTimeToIso($("team-task-due-at")?.value || ""),
        _photo_attachments: photos,
        _signed_by_email: signedByEmail,
      });
      if (error) throw error;
      setStatus("Team task created.", "success");
    }

    closeModal();
    await loadTasks();
  } catch (error) {
    console.error("Could not save team task:", error);
    setModalError(error?.message || "Could not save this team task.");
    setPhotoStatus("", "info");
  } finally {
    submit?.toggleAttribute("disabled", false);
  }
}

async function openTaskPhoto(bucket, path) {
  if (!path) return setStatus("That photo is missing a storage path.", "error");
  const storageBucket = bucket || TEAM_TASK_BUCKET;
  const key = `${storageBucket}/${path}`;
  let url = state.signedUrls.get(key);
  if (!url) {
    const { data, error } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(path, TEAM_TASK_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return setStatus("Could not open that task photo.", "error");
    url = data.signedUrl;
    state.signedUrls.set(key, url);
  }
  openTaskPhotoViewer({ url, label: path.split("/").pop() || "Task evidence photo", bucket: storageBucket, path });
}

function setupListeners() {
  $("new-team-task")?.addEventListener("click", () => openTaskModal());
  $("refresh-team-tasks")?.addEventListener("click", loadTasks);
  document.querySelectorAll("[data-task-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.taskView = button.dataset.taskView === "history" ? "history" : "active";
      if (state.taskView === "active" && isCanceledTaskScope()) state.taskScope = "mine";
      updateTaskScopeChrome();
      await loadTasks();
    });
  });
  $("team-task-scope")?.addEventListener("change", async (event) => {
    state.taskScope = ["all", "canceled"].includes(event.target.value) && isAdminUser() ? event.target.value : "mine";
    if (isCanceledTaskScope()) state.taskView = "history";
    updateTaskScopeChrome();
    await loadTasks();
  });
  $("team-task-history-sort")?.addEventListener("change", (event) => {
    state.taskHistorySort = event.target.value || "recent";
    state.tasks = sortTasksForCurrentView(state.tasks);
    renderTasks();
  });
  $("close-team-task-modal")?.addEventListener("click", closeModal);
  $("cancel-team-task-modal")?.addEventListener("click", closeModal);
  $("submit-team-task")?.addEventListener("click", submitTask);
  $("team-task-photo-file")?.addEventListener("change", handlePhotoFiles);
  $("team-task-capture-station")?.addEventListener("change", (event) => {
    setSelectedCaptureStation(event.target.value);
  });
  $("refresh-team-task-stations")?.addEventListener("click", () => {
    loadCaptureStations().catch((error) => setPhotoStatus(error?.message || "Could not refresh stations.", "error"));
  });
  $("request-team-task-photo")?.addEventListener("click", requestTaskPhoto);
  $("close-team-task-photo-viewer")?.addEventListener("click", closeTaskPhotoViewer);
  $("dismiss-team-task-photo-viewer")?.addEventListener("click", closeTaskPhotoViewer);
  $("team-task-photo-viewer-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "team-task-photo-viewer-modal") closeTaskPhotoViewer();
  });
  $("team-task-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "team-task-modal") closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (!$("team-task-photo-viewer-modal")?.classList.contains("hidden") && event.key === "Escape") {
      event.preventDefault();
      closeTaskPhotoViewer();
      return;
    }
    if ($("team-task-modal")?.classList.contains("hidden")) return;
    if (event.key === "Escape") {
      event.preventDefault();
      closeModal();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitTask();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseReady();
  const ok = await loadCurrentUser();
  if (!ok) return;
  setupListeners();
  await loadAssignees();
  await loadTasks();
  if (window.lucide) window.lucide.createIcons();
});
