const state = {
  user: null,
  employee: null,
  assignees: [],
  tasks: [],
  removedTasks: [],
  eventsByTask: new Map(),
  taskReadStates: new Map(),
  taskReadStateSyncAvailable: true,
  taskReadFilter: "all",
  taskOwnerFilter: "all",
  taskSourceFilter: "all",
  taskSort: "recent",
  activeTaskId: "",
  activeTaskSource: "",
  mode: "create",
  photos: [],
  signedUrls: new Map(),
  captureStations: [],
  selectedCaptureStationId: "",
  captureBusy: false,
  taskScope: "mine",
  viewedWorkerUserId: "",
  taskView: "active",
  taskHistorySort: "recent",
  childTasksByParent: new Map(),
  orderVideoReceiptPhotosByLineId: new Map(),
  lineReviewDecisions: new Map(),
  notifications: [],
  notificationChannel: null,
  notificationsOpen: false,
  expandedTaskKeys: new Set(),
  photoViewerReturnFocus: null,
  photoViewerZoom: 1,
  photoViewerOffsetX: 0,
  photoViewerOffsetY: 0,
  photoViewerDragging: false,
  photoViewerDragMoved: false,
  photoViewerDragStart: null,
};

const TEAM_TASK_BUCKET = "team-task-evidence";
const TEAM_TASK_SIGNED_URL_TTL_SECONDS = 60 * 60;
const ORDER_EVIDENCE_BUCKET = "order-evidence-photos";
const CAPTURE_STATION_TABLE = "capture_stations";
const CAPTURE_JOB_TABLE = "capture_jobs";
const CAPTURE_PHOTO_TABLE = "capture_job_photos";
const CAPTURE_POLL_TIMEOUT_MS = 60 * 60 * 1000;
const CAPTURE_POLL_INTERVAL_MS = 1_500;
const CAPTURE_PHOTO_SETTLE_MS = 3_000;
const CAPTURE_THUMBNAIL_TRANSFORM = { width: 240, height: 240, resize: "contain", quality: 55 };
const EBAY_RETURN_EVIDENCE_BUCKET = "ebay-return-evidence";
const TASK_IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "heic", "heif", "gif"]);
const TASK_VIDEO_EXTENSIONS = new Set(["mp4", "mov", "m4v", "webm", "ogg"]);
const TASK_READ_STATE_STORAGE_KEY = "og.teamTaskReadStates.v1";
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
const ACCEPTANCE_PENDING_TASK_STATUSES = new Set(["completed_by_employee", "pending_admin_review", "ready_for_admin_approval"]);
const ORDER_PARENT_TASK_TYPES = new Set(["coordination", "admin_review", "pending_admin_review", "worker_follow_up", "special_order"]);
const ORDER_SUBTASK_TYPE = "pending_subtask";
const ORDER_SHIPPING_TYPE = "pending_shipping";
const ORDER_PACKAGING_TYPE = "pending_packaging";
const TASK_ASSIGNMENT_EVENT_ACTIONS = new Set([
  "assigned",
  "task_assigned",
  "subtask_assigned",
  "shipment_assigned",
  "packaging_assigned",
  "return_task_assigned",
  "assigned_for_shipping",
]);
const TASK_LINE_SELECT = `
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
  fulfilled_quantity,
  fulfilled_at,
  notes,
  raw_payload
`;
const ORDER_TASK_ORDER_SELECT = `
  order_number,
  buyer_username,
  buyer_name,
  sale_date,
  paid_on_date,
  ship_by_date,
  status,
  total_price,
  net_payout,
  shipping_and_handling,
  ebay_collected_tax,
  label_status,
  label_uploaded_at,
  label_metadata,
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

function getTaskDueValue(task = {}) {
  if (task.due_at) return task.due_at;
  return task.source === "order" ? task.ship_by_date || "" : "";
}

function getTaskDueLabel(task = {}) {
  return formatDate(getTaskDueValue(task));
}

function getTaskLateAgeLabel(task = {}) {
  const dueValue = getTaskDueValue(task);
  if (!dueValue) return "";
  const dueTime = new Date(dueValue).getTime();
  if (!Number.isFinite(dueTime)) return "";
  const lateMs = Date.now() - dueTime;
  if (lateMs <= 0) return "";
  const minutes = Math.floor(lateMs / 60000);
  if (minutes < 60) return `${Math.max(1, minutes)}m late`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h late`;
  return `${Math.floor(hours / 24)}d late`;
}

function isTaskLate(task = {}, options = {}) {
  if (options.canceled) return false;
  const status = String(task.status || "").toLowerCase();
  if (HISTORY_TASK_STATUSES.includes(status) || HISTORY_RETURN_TASK_STATUSES.includes(status)) return false;
  const dueValue = getTaskDueValue(task);
  if (!dueValue) return false;
  const dueTime = new Date(dueValue).getTime();
  return Number.isFinite(dueTime) && dueTime < Date.now();
}

function startOfLocalDayTimestamp(value = new Date()) {
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) return Number.NaN;
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function getTaskUrgencyRank(task = {}) {
  const dueValue = getTaskDueValue(task);
  if (!dueValue) return 4;
  const dueDay = startOfLocalDayTimestamp(dueValue);
  if (!Number.isFinite(dueDay)) return 4;
  const today = startOfLocalDayTimestamp();
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrow = startOfLocalDayTimestamp(tomorrowDate);
  if (dueDay < today) return 0;
  if (dueDay === today) return 1;
  if (dueDay === tomorrow) return 2;
  return 3;
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

function formatTaskTag(value = "") {
  const label = String(value || "").trim().replace(/[_-]+/g, " ");
  if (!label) return "";
  return label.replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function normalizeLookup(value) {
  return String(value || "").trim().toLowerCase();
}

function buildEbayOrderDetailsUrl(orderNumber = "") {
  const clean = String(orderNumber || "").trim();
  if (!clean) return "";
  const url = new URL("https://www.ebay.com/mesh/ord/details");
  url.searchParams.set("orderid", clean);
  return url.toString();
}

function normalizeEbayOrderNumber(orderNumber = "") {
  return String(orderNumber || "").trim();
}

function removeTaskOrderNumberActionMenu() {
  document.querySelectorAll(".task-order-number-action-menu").forEach((menu) => menu.remove());
}

function openEbayOrderDetailsPage(orderNumber = "") {
  const cleanNumber = normalizeEbayOrderNumber(orderNumber);
  const url = buildEbayOrderDetailsUrl(cleanNumber);
  if (!url) {
    setStatus("No eBay order number available to open.", "error");
    return false;
  }
  window.open(url, "_blank", "noopener");
  setStatus(`Opening eBay order ${cleanNumber}.`, "success");
  return true;
}

function positionTaskOrderNumberActionMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const margin = 10;
  const menuRect = menu.getBoundingClientRect();
  let left = rect.left;
  let top = rect.bottom + 8;

  if (left + menuRect.width > window.innerWidth - margin) {
    left = window.innerWidth - menuRect.width - margin;
  }
  if (left < margin) left = margin;
  if (top + menuRect.height > window.innerHeight - margin) {
    top = rect.top - menuRect.height - 8;
  }
  if (top < margin) top = margin;

  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

function showTaskOrderNumberActionMenu(anchor, orderNumber = "") {
  const cleanNumber = normalizeEbayOrderNumber(orderNumber);
  if (!anchor || !cleanNumber) return;

  const existing = document.querySelector(".task-order-number-action-menu");
  if (existing?.dataset.orderNumber === cleanNumber && existing.dataset.anchorId === anchor.dataset.taskOrderActionAnchorId) {
    removeTaskOrderNumberActionMenu();
    return;
  }

  removeTaskOrderNumberActionMenu();
  if (!anchor.dataset.taskOrderActionAnchorId) {
    anchor.dataset.taskOrderActionAnchorId = `task-order-action-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  const menu = document.createElement("div");
  menu.className = "task-order-number-action-menu";
  menu.dataset.orderNumber = cleanNumber;
  menu.dataset.anchorId = anchor.dataset.taskOrderActionAnchorId;
  menu.innerHTML = `
    <div class="task-order-number-action-menu-title">
      <span>eBay Order</span>
      <strong>${escapeHtml(cleanNumber)}</strong>
    </div>
    <button type="button" data-task-order-action-copy>
      <i data-lucide="copy"></i>
      Copy number
    </button>
    <button type="button" data-task-order-action-open>
      <i data-lucide="external-link"></i>
      Open in eBay
    </button>
  `;

  document.body.appendChild(menu);
  window.lucide?.createIcons?.();
  positionTaskOrderNumberActionMenu(menu, anchor);

  const closeSoon = () => window.setTimeout(removeTaskOrderNumberActionMenu, 80);
  menu.querySelector("[data-task-order-action-copy]")?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copyTextToClipboard(cleanNumber, "Order number");
    closeSoon();
  });
  menu.querySelector("[data-task-order-action-open]")?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openEbayOrderDetailsPage(cleanNumber);
    closeSoon();
  });
}

function handleTaskOrderNumberActionClick(event) {
  const button = event.currentTarget;
  event.preventDefault();
  event.stopPropagation();
  showTaskOrderNumberActionMenu(button, button.dataset.taskOrderNumber || "");
}

document.addEventListener("click", (event) => {
  if (event.target.closest(".task-order-number-action-menu,[data-task-order-number-action]")) return;
  removeTaskOrderNumberActionMenu();
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") removeTaskOrderNumberActionMenu();
});

window.addEventListener("resize", removeTaskOrderNumberActionMenu);

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

async function copyTextToClipboard(value, label = "Value") {
  const text = String(value || "").trim();
  if (!text) {
    setStatus(`No ${label.toLowerCase()} available to copy.`, "error");
    return false;
  }

  try {
    if (navigator.clipboard?.writeText && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.setAttribute("readonly", "");
      textarea.style.position = "fixed";
      textarea.style.top = "-1000px";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      if (!copied) throw new Error("Browser clipboard fallback failed.");
    }

    setStatus(`${label} ${text} copied to clipboard.`, "success");
    return true;
  } catch (error) {
    console.error("Clipboard copy failed:", error);
    setStatus(`Could not copy ${label.toLowerCase()}.`, "error");
    return false;
  }
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

function getViewedWorkerUserId() {
  return isAdminUser() ? String(state.viewedWorkerUserId || "").trim() : "";
}

function isViewingWorkerTasks() {
  return Boolean(getViewedWorkerUserId());
}

function isTaskViewAsWorkerMode() {
  return isViewingWorkerTasks();
}

function canUseAdminTaskControls() {
  return isAdminUser() && !isTaskViewAsWorkerMode();
}

function getWorkerTaskVisibilityOrFilter(userId = "") {
  const workerUserId = String(userId || "").trim();
  if (!workerUserId) return "";
  return `assigned_to_user_id.eq.${workerUserId},created_by.eq.${workerUserId},assigned_by.eq.${workerUserId}`;
}

function getViewAsActionAttrs() {
  return isTaskViewAsWorkerMode()
    ? ` disabled aria-disabled="true" title="Worker display is read-only. Switch back to your admin view to make changes."`
    : "";
}

function getViewedWorker() {
  const viewedWorkerUserId = getViewedWorkerUserId();
  if (!viewedWorkerUserId) return null;
  return state.assignees.find((employee) => employee.user_id === viewedWorkerUserId) || null;
}

function getAssigneeOptionLabel(employee = {}) {
  return `${employee.display_name || employee.email || "Team member"} - ${employee.role || "employee"}`;
}

function getViewedWorkerLabel() {
  const worker = getViewedWorker();
  if (!worker) return "Selected worker";
  return worker.display_name || worker.email || "Selected worker";
}

function getTaskViewerUserId() {
  return getViewedWorkerUserId() || state.user?.id || "";
}

function getTaskViewerEmails() {
  const worker = getViewedWorker();
  if (worker?.email) return [worker.email];
  return [state.user?.email, state.employee?.email].filter(Boolean);
}

function getTaskViewerShortLabel() {
  const worker = getViewedWorker();
  if (!worker) return "me";
  const name = worker.display_name || worker.email || "worker";
  return name.split(/\s+/)[0] || "worker";
}

function isTaskHistoryView() {
  return state.taskView === "history";
}

function isHistoricalTaskView() {
  return isTaskHistoryView() || isCanceledTaskScope();
}

function updateTaskScopeChrome() {
  if (!isAdminUser()) {
    state.taskScope = "mine";
    state.viewedWorkerUserId = "";
  }
  if (isTaskViewAsWorkerMode() && state.taskOwnerFilter === "order_approval") {
    state.taskOwnerFilter = "all";
  }
  if (isCanceledTaskScope()) {
    state.taskView = "history";
    state.viewedWorkerUserId = "";
  }

  const scopeControl = $("team-task-scope-control");
  const scopeSelect = $("team-task-scope");
  const workerControl = $("team-task-worker-view-control");
  const workerSelect = $("team-task-worker-view");
  scopeControl?.classList.toggle("hidden", !isAdminUser());
  if (scopeSelect) {
    scopeSelect.value = isCanceledTaskScope() ? "canceled" : isTeamWideTaskScope() ? "all" : "mine";
    scopeSelect.disabled = !isAdminUser();
  }
  const showWorkerControl = isAdminUser() && !isCanceledTaskScope();
  workerControl?.classList.toggle("hidden", !showWorkerControl);
  workerControl?.classList.toggle("is-active", isViewingWorkerTasks());
  if (workerSelect) {
    workerSelect.disabled = !showWorkerControl;
    workerSelect.value = getViewedWorkerUserId();
  }
  const newTaskButton = $("new-team-task");
  if (newTaskButton) {
    newTaskButton.disabled = isTaskViewAsWorkerMode();
    newTaskButton.title = isTaskViewAsWorkerMode()
      ? "Worker display is read-only. Switch back to your admin view to create a task."
      : "";
  }
  $("team-task-active-sort-control")?.classList.toggle("hidden", isHistoricalTaskView());
  $("team-task-history-sort-control")?.classList.toggle("hidden", !isHistoricalTaskView());
  const activeSort = $("team-task-active-sort");
  if (activeSort) activeSort.value = state.taskSort || "recent";
  const historySort = $("team-task-history-sort");
  if (historySort) historySort.value = state.taskHistorySort || "recent";

  const mode = $("team-task-mode");
  if (mode) {
    mode.textContent = isViewingWorkerTasks()
      ? `View as ${getViewedWorkerLabel()} (${isTaskHistoryView() ? "History" : "Read-only"})`
      : isCanceledTaskScope()
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

function getTaskReadStateKey(source = "", taskId = "") {
  return `${source || "team"}:${taskId || ""}`;
}

function getSafeDomId(value = "") {
  return String(value || "")
    .replace(/[^a-z0-9_-]+/gi, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "task";
}

function getTaskByUnifiedKey(key = "") {
  const allTasks = [...state.tasks, ...state.removedTasks, ...getAllWorkflowChildTasks()];
  return allTasks.find((task) => getUnifiedTaskKey(task) === key) || null;
}

function parseTimestamp(value) {
  const time = value ? new Date(value).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
}

function getIsoOrNull(value) {
  return value ? new Date(value).toISOString() : null;
}

function getLatestTaskEventTime(task = {}) {
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  return events.reduce((latest, event) => Math.max(latest, parseTimestamp(event.created_at)), 0);
}

function getTaskActivityInfo(task = {}) {
  const taskUpdated = Math.max(parseTimestamp(task.updated_at), parseTimestamp(task.created_at));
  const eventUpdated = getLatestTaskEventTime(task);
  return {
    taskUpdatedAt: taskUpdated,
    eventUpdatedAt: eventUpdated,
    latestAt: Math.max(taskUpdated, eventUpdated),
  };
}

function getTaskUnreadNotifications(task = {}) {
  if (isTaskViewAsWorkerMode()) return [];
  return state.notifications.filter((entry) => (
    !entry.read_at
    && entry.source === task.source
    && entry.task_id === task.id
  ));
}

function loadLocalTaskReadStates() {
  try {
    const parsed = JSON.parse(localStorage.getItem(TASK_READ_STATE_STORAGE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveLocalTaskReadState(row = {}) {
  if (isTaskViewAsWorkerMode() || !state.user?.id || !row.source || !row.task_id) return;
  const all = loadLocalTaskReadStates();
  const userMap = all[state.user.id] && typeof all[state.user.id] === "object" ? all[state.user.id] : {};
  userMap[getTaskReadStateKey(row.source, row.task_id)] = row;
  all[state.user.id] = userMap;
  try {
    localStorage.setItem(TASK_READ_STATE_STORAGE_KEY, JSON.stringify(all));
  } catch (error) {
    console.warn("Could not save local task read state:", error);
  }
}

function removeLocalTaskReadState(source = "", taskId = "") {
  if (isTaskViewAsWorkerMode() || !state.user?.id || !source || !taskId) return;
  const all = loadLocalTaskReadStates();
  const userMap = all[state.user.id] && typeof all[state.user.id] === "object" ? all[state.user.id] : {};
  delete userMap[getTaskReadStateKey(source, taskId)];
  all[state.user.id] = userMap;
  try {
    localStorage.setItem(TASK_READ_STATE_STORAGE_KEY, JSON.stringify(all));
  } catch (error) {
    console.warn("Could not remove local task read state:", error);
  }
}

function loadLocalTaskReadStatesForTasks(tasks = []) {
  if (isTaskViewAsWorkerMode()) return;
  const all = loadLocalTaskReadStates();
  const userMap = state.user?.id && all[state.user.id] && typeof all[state.user.id] === "object" ? all[state.user.id] : {};
  tasks.forEach((task) => {
    const key = getUnifiedTaskKey(task);
    if (userMap[key]) state.taskReadStates.set(key, userMap[key]);
  });
}

async function loadTaskReadStates() {
  state.taskReadStates = new Map();
  const allTasks = [...state.tasks, ...state.removedTasks, ...getAllWorkflowChildTasks()].filter((task) => task?.id && task?.source);
  const readStateUserId = getTaskViewerUserId();
  if (!readStateUserId || !allTasks.length) return;

  loadLocalTaskReadStatesForTasks(allTasks);
  if (!state.taskReadStateSyncAvailable) return;

  const ids = unique(allTasks.map((task) => task.id));
  if (!ids.length) return;

  try {
    const { data, error } = await supabase
      .from("task_read_states")
      .select("user_id, source, task_id, last_seen_at, last_seen_task_updated_at, last_seen_event_at, updated_at")
      .eq("user_id", readStateUserId)
      .in("task_id", ids)
      .limit(1000);
    if (error) throw error;
    (data || []).forEach((row) => {
      state.taskReadStates.set(getTaskReadStateKey(row.source, row.task_id), row);
    });
  } catch (error) {
    if (!isTaskViewAsWorkerMode()) state.taskReadStateSyncAvailable = false;
    console.warn("Task read-state sync is unavailable; using this browser as fallback.", error);
  }
}

function getTaskReadInfo(task = {}) {
  const key = getUnifiedTaskKey(task);
  const readState = state.taskReadStates.get(key);
  const unreadNotifications = getTaskUnreadNotifications(task);
  const activity = getTaskActivityInfo(task);
  const lastSeen = parseTimestamp(readState?.last_seen_at);

  if (unreadNotifications.length) {
    return { status: "updated", label: "New update", className: "has-unseen-updates" };
  }
  if (!readState) {
    return { status: "unread", label: "Unread", className: "is-unread" };
  }
  if (activity.latestAt && lastSeen && activity.latestAt > lastSeen + 1000) {
    return { status: "updated", label: "Updated", className: "has-unseen-updates" };
  }
  return { status: "read", label: "Read", className: "is-read" };
}

function getTaskReadCounts(tasks = []) {
  return tasks.reduce((counts, task) => {
    const status = getTaskReadInfo(task).status;
    counts.all += 1;
    if (status === "read") counts.read += 1;
    else counts.unread += 1;
    if (status === "updated") counts.updated += 1;
    return counts;
  }, { all: 0, unread: 0, updated: 0, read: 0 });
}

function getTasksForReadFilter(tasks = []) {
  if (state.taskReadFilter === "read") return tasks.filter((task) => getTaskReadInfo(task).status === "read");
  if (state.taskReadFilter === "unread") return tasks.filter((task) => getTaskReadInfo(task).status !== "read");
  return tasks;
}

function renderTaskReadFilterChrome(tasks = []) {
  const counts = getTaskReadCounts(tasks);
  document.querySelectorAll("[data-task-read-filter]").forEach((button) => {
    const filter = button.dataset.taskReadFilter || "all";
    const label = filter === "read" ? `Read ${counts.read}` : filter === "unread" ? `New ${counts.unread}` : `All ${counts.all}`;
    button.textContent = label;
    button.classList.toggle("is-active", state.taskReadFilter === filter);
  });
}

function userEmailMatches(value = "") {
  const target = normalizeLookup(value);
  if (!target) return false;
  return [
    state.user?.email,
    state.employee?.email,
  ].some((email) => normalizeLookup(email) === target);
}

function userEmailMatchesTaskViewer(value = "") {
  const target = normalizeLookup(value);
  if (!target) return false;
  return getTaskViewerEmails().some((email) => normalizeLookup(email) === target);
}

function isTaskAssignedToCurrentUser(task = {}) {
  const viewerUserId = getTaskViewerUserId();
  return Boolean(
    (task.assigned_to_user_id && viewerUserId && task.assigned_to_user_id === viewerUserId)
    || userEmailMatchesTaskViewer(task.assigned_to_email)
  );
}

function isTaskCreatedByCurrentUser(task = {}) {
  const viewerUserId = getTaskViewerUserId();
  return Boolean(
    (task.created_by && viewerUserId && task.created_by === viewerUserId)
    || (task.assigned_by && viewerUserId && task.assigned_by === viewerUserId)
    || userEmailMatchesTaskViewer(task.created_by_email)
    || userEmailMatchesTaskViewer(task.assigned_by_email)
  );
}

function isTaskPendingAcceptance(task = {}) {
  if (isTaskHistoryView()) return false;
  if (isOrderPendingApprovalTask(task)) return false;
  return ACCEPTANCE_PENDING_TASK_STATUSES.has(String(task.status || "").toLowerCase());
}

function isTaskAcceptanceVisibleToViewer(task = {}) {
  if (!isTaskPendingAcceptance(task)) return false;
  return Boolean(
    canUseAdminTaskControls()
    || isTaskAssignedToCurrentUser(task)
    || isTaskCreatedByCurrentUser(task)
  );
}

function canReviewTaskAcceptance(task = {}) {
  if (!isTaskPendingAcceptance(task)) return false;
  return Boolean(
    canUseAdminTaskControls()
    || isTaskCreatedByCurrentUser(task)
  );
}

function eventSignedByTaskAssignee(task = {}, event = {}) {
  const assigneeUserId = task.assigned_to_user_id || "";
  const assigneeEmail = normalizeLookup(task.assigned_to_email || "");
  const eventUserId = event.signed_by || "";
  const eventEmail = normalizeLookup(event.signed_by_email || "");
  return Boolean(
    (assigneeUserId && eventUserId && assigneeUserId === eventUserId)
    || (assigneeEmail && eventEmail && assigneeEmail === eventEmail)
  );
}

function getLatestTaskReplyEvent(task = {}) {
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  return [...events].reverse().find((event) => (
    String(event.action || "").toLowerCase() !== "created"
    && (event.notes || event.new_status || event.photo_attachments?.length)
  )) || null;
}

function isTaskRespondedAwaitingReply(task = {}) {
  if (isTaskHistoryView()) return false;
  if (isTaskPendingAcceptance(task) || isOrderPendingApprovalTask(task)) return false;
  const status = String(task.status || "").toLowerCase();
  if (HISTORY_TASK_STATUSES.includes(status) || HISTORY_RETURN_TASK_STATUSES.includes(status)) return false;
  if (!task.assigned_to_user_id && !task.assigned_to_email) return false;
  const latestEvent = getLatestTaskReplyEvent(task);
  if (!latestEvent) return false;
  return eventSignedByTaskAssignee(task, latestEvent);
}

function getDefaultActiveTasks(tasks = []) {
  return tasks.filter((task) => (
    !isTaskPendingAcceptance(task)
    && !isOrderPendingApprovalTask(task)
    && !isTaskRespondedAwaitingReply(task)
  ));
}

function getTaskSourceFilterValue(task = {}) {
  if (task.source === "order" && task.metadata?.source === "order_history") return "order_history";
  if (task.source === "order") return "order";
  if (task.source === "return") return "return";
  if (task.source === "team" && task.metadata?.source === "ebay_conversation_message") return "ebay_triage";
  if (task.source === "team") return "independent";
  return "other";
}

function getTaskOwnerCounts(tasks = []) {
  return tasks.reduce((counts, task) => {
    if (isOrderPendingApprovalTask(task) && canUseAdminTaskControls()) {
      counts.orderApproval += 1;
      return counts;
    }
    if (isTaskPendingAcceptance(task)) {
      if (isTaskAcceptanceVisibleToViewer(task)) counts.acceptance += 1;
      return counts;
    }
    if (isTaskRespondedAwaitingReply(task)) {
      counts.responded += 1;
      return counts;
    }
    counts.all += 1;
    if (isTaskAssignedToCurrentUser(task)) counts.assigned += 1;
    if (isTaskCreatedByCurrentUser(task)) counts.created += 1;
    return counts;
  }, { all: 0, assigned: 0, created: 0, responded: 0, acceptance: 0, orderApproval: 0 });
}

function getTaskSourceCounts(tasks = []) {
  return tasks.reduce((counts, task) => {
    counts.all += 1;
    const source = getTaskSourceFilterValue(task);
    counts[source] = (counts[source] || 0) + 1;
    return counts;
  }, { all: 0, independent: 0, order: 0, order_history: 0, ebay_triage: 0, return: 0, other: 0 });
}

function getTasksForOwnerFilter(tasks = []) {
  if (state.taskOwnerFilter === "order_approval") return tasks.filter((task) => isOrderPendingApprovalTask(task) && canUseAdminTaskControls());
  if (state.taskOwnerFilter === "acceptance") return tasks.filter(isTaskAcceptanceVisibleToViewer);
  if (state.taskOwnerFilter === "responded") return tasks.filter(isTaskRespondedAwaitingReply);
  const activeTasks = getDefaultActiveTasks(tasks);
  if (state.taskOwnerFilter === "assigned") return activeTasks.filter(isTaskAssignedToCurrentUser);
  if (state.taskOwnerFilter === "created") return activeTasks.filter(isTaskCreatedByCurrentUser);
  return activeTasks;
}

function getTasksForSourceFilter(tasks = []) {
  if (!state.taskSourceFilter || state.taskSourceFilter === "all") return tasks;
  return tasks.filter((task) => getTaskSourceFilterValue(task) === state.taskSourceFilter);
}

function getVisibleTasksForCurrentFilters(tasks = []) {
  const filtered = getTasksForSourceFilter(getTasksForOwnerFilter(getTasksForReadFilter(tasks)));
  return isTaskHistoryView() ? sortHistoryTasks(filtered) : sortUnifiedTasks(filtered);
}

function renderTaskOwnerFilterChrome(tasks = []) {
  const counts = getTaskOwnerCounts(tasks);
  const viewerLabel = getTaskViewerShortLabel();
  document.querySelectorAll("[data-task-owner-filter]").forEach((button) => {
    const filter = button.dataset.taskOwnerFilter || "all";
    if (filter === "order_approval") {
      button.hidden = !canUseAdminTaskControls();
      if (!canUseAdminTaskControls() && state.taskOwnerFilter === "order_approval") state.taskOwnerFilter = "all";
    }
    const labels = {
      all: `Active work ${counts.all}`,
      assigned: `${isViewingWorkerTasks() ? `Assigned to ${viewerLabel}` : "Assigned to me"} ${counts.assigned}`,
      created: `${isViewingWorkerTasks() ? `Created by ${viewerLabel}` : "Created by me"} ${counts.created}`,
      responded: `Responded / awaiting reply ${counts.responded}`,
      order_approval: `Orders pending approval ${counts.orderApproval}`,
      acceptance: `Needs acceptance ${counts.acceptance}`,
    };
    button.textContent = labels[filter] || formatTaskTag(filter);
    button.classList.toggle("is-active", state.taskOwnerFilter === filter);
  });
}

function renderTaskSourceFilterChrome(tasks = []) {
  const counts = getTaskSourceCounts(tasks);
  document.querySelectorAll("[data-task-source-filter]").forEach((button) => {
    const filter = button.dataset.taskSourceFilter || "all";
    const labels = {
      all: `All sources ${counts.all}`,
      independent: `Independent ${counts.independent}`,
      order: `Pending orders ${counts.order}`,
      order_history: `Order history ${counts.order_history}`,
      ebay_triage: `eBay triage ${counts.ebay_triage}`,
      return: `Returns ${counts.return}`,
    };
    button.textContent = labels[filter] || formatTaskTag(filter);
    button.classList.toggle("is-active", state.taskSourceFilter === filter);
  });
}

function renderTaskFilterChrome(tasks = []) {
  renderTaskReadFilterChrome(tasks);
  renderTaskOwnerFilterChrome(tasks);
  renderTaskSourceFilterChrome(getTasksForOwnerFilter(getTasksForReadFilter(tasks)));
}

async function markTaskSeen(task = {}) {
  if (isTaskViewAsWorkerMode()) return;
  if (!task?.id || !task?.source || !state.user?.id) return;
  const activity = getTaskActivityInfo(task);
  const row = {
    user_id: state.user.id,
    source: task.source,
    task_id: task.id,
    last_seen_at: new Date().toISOString(),
    last_seen_task_updated_at: getIsoOrNull(activity.taskUpdatedAt),
    last_seen_event_at: getIsoOrNull(activity.eventUpdatedAt),
    updated_at: new Date().toISOString(),
  };
  state.taskReadStates.set(getUnifiedTaskKey(task), row);
  saveLocalTaskReadState(row);

  const unreadIds = getTaskUnreadNotifications(task).map((entry) => entry.id);
  if (unreadIds.length) await markTaskNotificationsRead(unreadIds);

  if (!state.taskReadStateSyncAvailable) return;
  try {
    const { error } = await supabase.rpc("mark_task_seen", {
      _source: task.source,
      _task_id: task.id,
      _last_seen_task_updated_at: row.last_seen_task_updated_at,
      _last_seen_event_at: row.last_seen_event_at,
    });
    if (error) throw error;
  } catch (error) {
    state.taskReadStateSyncAvailable = false;
    console.warn("Could not persist task read state; using this browser as fallback.", error);
  }
}

async function markTaskUnread(task = {}) {
  if (isTaskViewAsWorkerMode()) return;
  if (!task?.id || !task?.source || !state.user?.id) return;

  state.taskReadStates.delete(getUnifiedTaskKey(task));
  removeLocalTaskReadState(task.source, task.id);

  if (!state.taskReadStateSyncAvailable) return;
  try {
    const { error } = await supabase
      .from("task_read_states")
      .delete()
      .eq("user_id", state.user.id)
      .eq("source", task.source)
      .eq("task_id", task.id);
    if (error) throw error;
  } catch (error) {
    state.taskReadStateSyncAvailable = false;
    console.warn("Could not persist task unread state; using this browser as fallback.", error);
  }
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

function getObjectTimestamp(...values) {
  for (const value of values) {
    const time = parseTimestamp(value);
    if (time) return time;
  }
  return 0;
}

function getTaskMetadataAssignedTime(task = {}) {
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  return getObjectTimestamp(
    task.assigned_at,
    task.assignedAt,
    task.assignment_created_at,
    task.assignmentCreatedAt,
    task.packaging_assigned_at,
    metadata.assigned_at,
    metadata.assignedAt,
    metadata.assignment_created_at,
    metadata.assignmentCreatedAt,
    metadata.packaging_assigned_at,
  );
}

function isAssignmentEvent(event = {}) {
  const action = String(event.action || "").toLowerCase();
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const assignmentAction = String(payload.assignment_action || "").toLowerCase();
  const newAssignee = event.new_assigned_to_user_id || payload.new_assigned_to_user_id || payload.assigned_to_user_id;

  if (assignmentAction === "cancel_assignment") return false;
  if (action === "created") return Boolean(newAssignee);
  if (TASK_ASSIGNMENT_EVENT_ACTIONS.has(action) || assignmentAction === "reassign") return Boolean(newAssignee);
  return Boolean(newAssignee && event.old_assigned_to_user_id && event.old_assigned_to_user_id !== newAssignee);
}

function getTaskAssignedSortTime(task = {}) {
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  const latestEventTime = events.reduce((latest, event) => {
    if (!isAssignmentEvent(event)) return latest;
    return Math.max(latest, parseTimestamp(event.created_at));
  }, 0);
  if (latestEventTime) return latestEventTime;

  const metadataTime = getTaskMetadataAssignedTime(task);
  if (metadataTime) return metadataTime;

  if (task.assigned_to_user_id || task.assigned_to_email) {
    return parseTimestamp(task.created_at) || Number.NaN;
  }
  return Number.NaN;
}

function compareFiniteNumber(aValue, bValue, direction = "asc") {
  const aHasValue = Number.isFinite(aValue);
  const bHasValue = Number.isFinite(bValue);
  if (aHasValue && !bHasValue) return -1;
  if (!aHasValue && bHasValue) return 1;
  if (!aHasValue && !bHasValue) return 0;
  return direction === "desc" ? bValue - aValue : aValue - bValue;
}

function getTaskDueSortTime(task = {}) {
  const dueValue = getTaskDueValue(task);
  if (!dueValue) return Number.NaN;
  const time = new Date(dueValue).getTime();
  return Number.isFinite(time) ? time : Number.NaN;
}

function sortUnifiedTasks(tasks = [], requestedSort = state.taskSort || "recent") {
  return [...tasks].sort((a, b) => {
    const byRecent = () => getTaskActiveTime(b) - getTaskActiveTime(a);
    const byDueAsc = () => compareFiniteNumber(getTaskDueSortTime(a), getTaskDueSortTime(b), "asc");
    const byDueDesc = () => compareFiniteNumber(getTaskDueSortTime(a), getTaskDueSortTime(b), "desc");
    const byMoneyDesc = () => compareFiniteNumber(getTaskMoneyValue(a), getTaskMoneyValue(b), "desc");
    const byMoneyAsc = () => compareFiniteNumber(getTaskMoneyValue(a), getTaskMoneyValue(b), "asc");
    const byUrgency = () => getTaskUrgencyRank(a) - getTaskUrgencyRank(b);
    const byPriority = () => priorityRank(a.priority) - priorityRank(b.priority);
    const byCreatedDesc = () => new Date(b.created_at || 0).getTime() - new Date(a.created_at || 0).getTime();
    const byAssignedDesc = () => compareFiniteNumber(getTaskAssignedSortTime(a), getTaskAssignedSortTime(b), "desc");
    const byAssignedAsc = () => compareFiniteNumber(getTaskAssignedSortTime(a), getTaskAssignedSortTime(b), "asc");

    if (requestedSort === "assigned_desc") return byAssignedDesc() || byRecent() || byDueAsc() || byPriority() || byCreatedDesc();
    if (requestedSort === "assigned_asc") return byAssignedAsc() || byDueAsc() || byPriority() || byRecent() || byCreatedDesc();
    if (requestedSort === "order_urgency") return byUrgency() || byDueAsc() || byMoneyDesc() || byPriority() || byRecent() || byCreatedDesc();
    if (requestedSort === "due_asc") return byDueAsc() || byUrgency() || byPriority() || byRecent() || byCreatedDesc();
    if (requestedSort === "due_desc") return byDueDesc() || byPriority() || byRecent() || byCreatedDesc();
    if (requestedSort === "amount_desc") return byMoneyDesc() || byUrgency() || byDueAsc() || byRecent() || byCreatedDesc();
    if (requestedSort === "amount_asc") return byMoneyAsc() || byUrgency() || byDueAsc() || byRecent() || byCreatedDesc();

    return byRecent() || byDueAsc() || byPriority() || byCreatedDesc();
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
    if (sort === "assigned_desc") {
      return compareFiniteNumber(getTaskAssignedSortTime(a), getTaskAssignedSortTime(b), "desc")
        || getTaskHistoryTime(b) - getTaskHistoryTime(a);
    }
    if (sort === "assigned_asc") {
      return compareFiniteNumber(getTaskAssignedSortTime(a), getTaskAssignedSortTime(b), "asc")
        || getTaskHistoryTime(b) - getTaskHistoryTime(a);
    }
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
  state.viewedWorkerUserId = "";
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
    select.appendChild(new Option(getAssigneeOptionLabel(employee), employee.user_id || ""));
  });
  select.value = state.assignees.some((employee) => employee.user_id === current) ? current : "";
}

function renderWorkerViewSelect() {
  const select = $("team-task-worker-view");
  if (!select) return;
  const current = state.viewedWorkerUserId || select.value || "";
  select.replaceChildren(new Option("Use View scope", ""));
  state.assignees.forEach((employee) => {
    select.appendChild(new Option(getAssigneeOptionLabel(employee), employee.user_id || ""));
  });
  const validCurrent = state.assignees.some((employee) => employee.user_id === current);
  state.viewedWorkerUserId = isAdminUser() && validCurrent ? current : "";
  select.value = state.viewedWorkerUserId;
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

function configureStatusOptionsForProgress(selectId, progressMode = false) {
  const select = $(selectId);
  if (!select) return;
  ["resolved", "cancelled", "completed_by_employee", "sent_back_for_rework"].forEach((value) => {
    const option = [...select.options].find((entry) => entry.value === value);
    if (!option) return;
    option.hidden = progressMode;
    option.disabled = progressMode;
  });
  if (progressMode && ["resolved", "cancelled", "completed_by_employee", "sent_back_for_rework"].includes(select.value)) {
    select.value = "deferred";
  }
}

function getTaskAssigneeLabel(task = {}) {
  if (task.assigned_to_email) return task.assigned_to_email;
  const assignee = state.assignees.find((employee) => employee.user_id === task.assigned_to_user_id);
  if (assignee) return assignee.display_name || assignee.email || "Assigned team member";
  const viewerUserId = getTaskViewerUserId();
  if (task.assigned_to_user_id && task.assigned_to_user_id === viewerUserId) {
    return isTaskViewAsWorkerMode()
      ? getViewedWorkerLabel()
      : state.employee?.display_name || state.user?.email || "You";
  }
  return "Unassigned";
}

function getTaskAssignerLabel(task = {}) {
  const assigner = state.assignees.find((employee) => employee.user_id === task.assigned_by);
  if (assigner) return assigner.display_name || assigner.email || "Team member";
  return task.assigned_by_email || task.created_by_email || task.metadata?.submitted_by_email || "Not recorded";
}

async function loadAssignees() {
  const { data, error } = await supabase.rpc("list_team_task_assignees");
  if (error) throw error;
  state.assignees = Array.isArray(data) ? data : [];
  renderAssigneeSelect();
  renderWorkerViewSelect();
  updateTaskScopeChrome();
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
  if (requested) {
    const requestedVisibleTask = state.tasks.find((task) => task.id === requested);
    if (requestedVisibleTask) state.expandedTaskKeys.add(getUnifiedTaskKey(requestedVisibleTask));
  }
  await loadEventsForTasks();
  await hydrateEventPhotoUrls();
  await loadTaskReadStates();
  renderTasks();

  if (requested) {
    const card = document.querySelector(`[data-team-task-card="${CSS.escape(requested)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

function getTaskNotificationHref(notification = {}) {
  if (notification.source === "order") {
    return `pending-orders.html?orderTaskId=${encodeURIComponent(notification.task_id || "")}#order-task-panel`;
  }
  if (notification.source === "return") {
    return `ebay-returns.html?returnTaskId=${encodeURIComponent(notification.task_id || "")}#return-work-queue`;
  }
  return `team-tasks.html?taskId=${encodeURIComponent(notification.task_id || "")}`;
}

function getTaskNotificationTypeLabel(type = "") {
  const labels = {
    task_assigned: "Task assigned",
    subtask_assigned: "Subtask assigned",
    shipment_assigned: "Shipment assigned",
    packaging_assigned: "Packaging assigned",
    return_task_assigned: "Return task assigned",
    subtask_completed: "Subtask completed",
  };
  return labels[type] || "Task notification";
}

async function loadTaskNotifications({ silent = false } = {}) {
  if (!state.user?.id) return;
  try {
    const { data, error } = await supabase
      .from("task_notifications")
      .select("*")
      .eq("recipient_user_id", state.user.id)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) throw error;
    state.notifications = Array.isArray(data) ? data : [];
    renderTaskNotifications();
  } catch (error) {
    if (!silent) console.warn("Could not load task notifications:", error);
    state.notifications = [];
    renderTaskNotifications();
  }
}

function renderTaskNotifications() {
  const count = $("team-task-notification-count");
  const list = $("team-task-notification-list");
  const unreadCount = state.notifications.filter((entry) => !entry.read_at).length;
  if (count) {
    count.textContent = String(unreadCount);
    count.classList.toggle("hidden", unreadCount === 0);
  }
  if (!list) return;

  if (!state.notifications.length) {
    list.innerHTML = `<div class="empty-state">No notifications yet.</div>`;
    return;
  }

  list.innerHTML = state.notifications.map((entry) => `
    <button
      type="button"
      class="team-task-notification-item ${entry.read_at ? "" : "is-unread"}"
      data-task-notification-id="${escapeHtml(entry.id)}"
      data-task-notification-href="${escapeHtml(getTaskNotificationHref(entry))}"
    >
      <strong>${escapeHtml(entry.title || getTaskNotificationTypeLabel(entry.notification_type))}</strong>
      <span>${escapeHtml(entry.body || "")}</span>
      <small>${escapeHtml(getTaskNotificationTypeLabel(entry.notification_type))} - ${escapeHtml(formatDate(entry.created_at))}</small>
    </button>
  `).join("");

  list.querySelectorAll("[data-task-notification-id]").forEach((button) => {
    button.addEventListener("click", async () => {
      await markTaskNotificationsRead([button.dataset.taskNotificationId]);
      window.location.href = button.dataset.taskNotificationHref || "team-tasks.html";
    });
  });
}

async function markTaskNotificationsRead(ids = null) {
  const selectedIds = Array.isArray(ids)
    ? ids.filter(Boolean)
    : state.notifications.filter((entry) => !entry.read_at).map((entry) => entry.id);
  if (!selectedIds.length) return;

  const readAt = new Date().toISOString();
  const { error } = await supabase
    .from("task_notifications")
    .update({ read_at: readAt })
    .in("id", selectedIds);
  if (error) {
    console.warn("Could not mark task notifications read:", error);
    return;
  }
  state.notifications = state.notifications.map((entry) => (
    selectedIds.includes(entry.id) ? { ...entry, read_at: entry.read_at || readAt } : entry
  ));
  renderTaskNotifications();
  if ($("team-task-list") && state.tasks.length) renderTasks();
}

function setTaskNotificationPanelOpen(open) {
  state.notificationsOpen = Boolean(open);
  $("team-task-notification-panel")?.classList.toggle("hidden", !state.notificationsOpen);
  $("team-task-notification-toggle")?.setAttribute("aria-expanded", state.notificationsOpen ? "true" : "false");
}

function setupTaskNotificationRealtime() {
  if (!state.user?.id || typeof supabase.channel !== "function") return;
  if (state.notificationChannel) supabase.removeChannel(state.notificationChannel);
  state.notificationChannel = supabase
    .channel(`task-notifications-${state.user.id}`)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "task_notifications",
      filter: `recipient_user_id=eq.${state.user.id}`,
    }, (payload) => {
      const notification = payload.new || {};
      state.notifications = [notification, ...state.notifications.filter((entry) => entry.id !== notification.id)].slice(0, 30);
      renderTaskNotifications();
      if ($("team-task-list") && state.tasks.length) renderTasks();
      if (!state.notificationsOpen && notification.title) setStatus(notification.title, "success");
    })
    .subscribe();
}

async function loadTeamTaskRecords() {
  const viewedWorkerUserId = getViewedWorkerUserId();
  const viewedWorkerFilter = getWorkerTaskVisibilityOrFilter(viewedWorkerUserId);
  if (isHistoricalTaskView()) {
    let query = supabase
      .from("team_tasks")
      .select("*")
      .in("status", HISTORY_TASK_STATUSES)
      .order("updated_at", { ascending: false })
      .limit(80);
    if (viewedWorkerFilter) {
      query = query.or(viewedWorkerFilter);
    } else if (!isTeamWideTaskScope() && !isCanceledTaskScope()) {
      query = query.eq("assigned_to_user_id", state.user?.id);
    }
    const { data, error } = await query;
    if (error) throw error;
    return (data || []).map(normalizeTeamTask);
  }
  if (viewedWorkerFilter) {
    const { data, error } = await supabase
      .from("team_tasks")
      .select("*")
      .in("status", ACTIVE_TASK_STATUSES)
      .or(viewedWorkerFilter)
      .order("created_at", { ascending: true })
      .limit(80);
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
  const viewedWorkerUserId = getViewedWorkerUserId();
  const viewedWorkerFilter = getWorkerTaskVisibilityOrFilter(viewedWorkerUserId);
  const statuses = isHistoricalTaskView() ? HISTORY_TASK_STATUSES : ACTIVE_TASK_STATUSES;
  let query = supabase
    .from("ebay_order_tasks")
    .select(`id, order_id, order_line_ids, parent_task_id, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, assigned_by, assigned_by_email, due_at, created_at, updated_at, completed_at, resolved_at, latest_note, latest_photo_count, created_by, created_by_email, metadata, ebay_orders(${ORDER_TASK_ORDER_SELECT})`)
    .in("status", statuses)
    .order(isHistoricalTaskView() ? "updated_at" : "created_at", { ascending: !isHistoricalTaskView() })
    .limit(80);
  if (viewedWorkerFilter) {
    query = query.or(viewedWorkerFilter);
  } else if (!isTeamWideTaskScope() && !isCanceledTaskScope()) {
    query = isAdminUser() && !isHistoricalTaskView()
      ? query.or(`assigned_to_user_id.eq.${state.user?.id},status.eq.waiting_on_admin,status.eq.ready_for_admin_approval,and(assigned_by.eq.${state.user?.id},assigned_to_user_id.not.is.null)`)
      : query.or(`assigned_to_user_id.eq.${state.user?.id},created_by.eq.${state.user?.id},assigned_by.eq.${state.user?.id}`);
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
  const viewedWorkerUserId = getViewedWorkerUserId();
  const viewedWorkerFilter = getWorkerTaskVisibilityOrFilter(viewedWorkerUserId);
  const statuses = isHistoricalTaskView() ? HISTORY_RETURN_TASK_STATUSES : ACTIVE_RETURN_TASK_STATUSES;
  let query = supabase
    .from("ebay_return_tasks")
    .select("id, return_case_id, order_id, order_line_ids, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, assigned_by, assigned_by_email, due_at, resolved_at, created_at, updated_at, created_by, created_by_email, metadata, ebay_return_cases(id, order_id, order_number, ebay_return_id, buyer_username, return_reason, status, opened_at, notes, raw_payload)")
    .in("status", statuses)
    .order("created_at", { ascending: !isHistoricalTaskView() })
    .limit(80);
  if (viewedWorkerFilter) {
    query = query.or(viewedWorkerFilter);
  } else if (!isTeamWideTaskScope() && !isCanceledTaskScope()) {
    query = query.eq("assigned_to_user_id", state.user?.id);
  }

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(normalizeReturnTask);
}

function normalizeTeamTask(task = {}) {
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  const isEbayMessageTask = metadata.source === "ebay_conversation_message";
  const taskTag = String(metadata.task_tag || "").trim().toLowerCase();
  return {
    ...task,
    source: "team",
    metadata,
    sourceLabel: isEbayMessageTask ? (taskTag === "refunds" ? "Refund" : "eBay Message") : "",
    actionHref: `team-tasks.html?taskId=${encodeURIComponent(task.id || "")}`,
  };
}

function normalizeOrderTask(task = {}) {
  const order = getEmbeddedOne(task.ebay_orders);
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  const orderNumber = task.order_number || order.order_number || "";
  const buyer = task.buyer_username || order.buyer_username || "";
  const isOrderHistoryTask = metadata.source === "order_history";
  let sourceLabel = "Pending Order";
  if (task.task_type === ORDER_SUBTASK_TYPE) {
    sourceLabel = "Subtask";
  } else if (task.task_type === ORDER_SHIPPING_TYPE) {
    sourceLabel = "Shipping Task";
  } else if (task.task_type === ORDER_PACKAGING_TYPE) {
    sourceLabel = "Packaging Task";
  } else if (task.task_type === "pending_admin_review" && metadata.workflow_type === "pending_order_approval") {
    sourceLabel = "Approval Queue";
  } else if (isOrderHistoryTask) {
    sourceLabel = "Order History";
  }
  return {
    ...task,
    source: "order",
    metadata,
    sourceLabel,
    title: task.title || `${isOrderHistoryTask ? "Closed order" : "Pending order"} ${orderNumber || ""}`.trim(),
    description: task.question || task.latest_note || "",
    latest_note: task.latest_note || task.question || "",
    order,
    order_number: orderNumber,
    buyer_username: buyer,
    buyer_name: task.buyer_name || order.buyer_name || "",
    order_status: task.order_status || order.status || "",
    ship_by_date: task.ship_by_date || order.ship_by_date || "",
    actionHref: isOrderHistoryTask
      ? `ebay-order-history.html?historySearch=${encodeURIComponent(orderNumber || buyer || "")}&allDates=1`
      : `pending-orders.html?orderTaskId=${encodeURIComponent(task.id || "")}#order-task-panel`,
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

async function createTaskSignedImageThumbnailUrl(bucket, path) {
  if (!bucket || !path) return "";
  const key = `${bucket}/${path}:thumb`;
  const cached = state.signedUrls.get(key);
  if (cached) return cached;
  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(path, TEAM_TASK_SIGNED_URL_TTL_SECONDS, { transform: CAPTURE_THUMBNAIL_TRANSFORM });
  if (error || !data?.signedUrl) return createTaskSignedImageUrl(bucket, path);
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
    hydrateOrderVideoReceiptEvidence(tasks),
  ]);
}

function getTaskEventLineIds(event = {}) {
  return Array.isArray(event.order_line_ids) ? event.order_line_ids.filter(Boolean) : [];
}

function getTaskEvidencePhotoBucket(photo = {}) {
  return photo.bucket || photo.storage_bucket || ORDER_EVIDENCE_BUCKET;
}

function getTaskEvidencePhotoPath(photo = {}) {
  return photo.path || photo.storage_path || "";
}

function getTaskAttachmentMediaType(attachment = {}) {
  const explicitType = String(attachment.media_type || attachment.mediaType || "").trim().toLowerCase();
  if (explicitType === "video" || explicitType === "image") return explicitType;
  const mimeType = String(attachment.mime_type || attachment.mimeType || attachment.type || attachment.file?.type || "").trim().toLowerCase();
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  const source = [
    attachment.label,
    attachment.name,
    attachment.path,
    attachment.storage_path,
    attachment.previewPath,
    attachment.source_path,
  ].filter(Boolean).join(" ").toLowerCase();
  const extension = (source.match(/\.([a-z0-9]{2,5})(?:$|[?#\s])/i)?.[1] || "").toLowerCase();
  return TASK_VIDEO_EXTENSIONS.has(extension) ? "video" : "image";
}

function isAcceptedTaskEvidenceFile(file = {}) {
  const mimeType = String(file.type || file.mime_type || "").toLowerCase();
  if (/^(image|video)\//.test(mimeType)) return true;
  const extension = String(file.name || file.path || "").toLowerCase().match(/\.([a-z0-9]{2,5})(?:$|[?#\s])/i)?.[1] || "";
  return TASK_IMAGE_EXTENSIONS.has(extension) || TASK_VIDEO_EXTENSIONS.has(extension);
}

function isTaskVideoAttachment(attachment = {}) {
  return getTaskAttachmentMediaType(attachment) === "video";
}

function getTaskAttachmentKindLabel(attachment = {}) {
  return isTaskVideoAttachment(attachment) ? "Task video" : "Task photo";
}

function renderTaskEvidencePreview(attachment = {}, url = "", label = "") {
  const safeLabel = escapeHtml(label || attachment.label || "Task evidence");
  if (isTaskVideoAttachment(attachment)) {
    return url
      ? `<video src="${escapeHtml(url)}" aria-label="${safeLabel}" muted playsinline preload="metadata"></video>`
      : `<span class="team-task-video-placeholder">Video</span>`;
  }
  return url
    ? `<img src="${escapeHtml(url)}" alt="${safeLabel}" loading="lazy" />`
    : `<span>${safeLabel}</span>`;
}

function getTaskEvidencePhotoVariantRef(photo = {}, variant = "preview") {
  const normalizedVariant = variant === "thumb" ? "thumbnail" : variant;
  const variants = photo.variants || photo.derivatives || {};
  const variantObject = variants?.[variant] || variants?.[normalizedVariant] || (normalizedVariant === "thumbnail" ? variants?.thumb : null);
  const directPath = variantObject?.path || variantObject?.storage_path || "";
  if (directPath) {
    return {
      bucket: variantObject.bucket || variantObject.storage_bucket || photo.bucket || photo.storage_bucket || ORDER_EVIDENCE_BUCKET,
      path: directPath,
    };
  }

  const pathKeys = normalizedVariant === "preview"
    ? ["preview_path", "previewPath"]
    : ["thumbnail_path", "thumbnailPath", "thumb_path", "thumbPath"];
  const bucketKeys = normalizedVariant === "preview"
    ? ["preview_bucket", "previewBucket"]
    : ["thumbnail_bucket", "thumbnailBucket", "thumb_bucket", "thumbBucket"];
  const path = pathKeys.map((key) => photo[key]).find(Boolean);
  if (!path) return null;
  const bucket = bucketKeys.map((key) => photo[key]).find(Boolean);
  return {
    bucket: bucket || photo.bucket || photo.storage_bucket || ORDER_EVIDENCE_BUCKET,
    path,
  };
}

function getTaskEventEvidencePhotos(event = {}) {
  return [
    ...(Array.isArray(event.evidence_photos) ? event.evidence_photos : []),
    ...(Array.isArray(event.payload?.evidence_photos) ? event.payload.evidence_photos : []),
    ...(Array.isArray(event.label_metadata?.evidence_photos) ? event.label_metadata.evidence_photos : []),
    ...(Array.isArray(event.photo_attachments) ? event.photo_attachments : []),
  ].map((photo) => ({
    ...photo,
    bucket: getTaskEvidencePhotoBucket(photo),
    path: getTaskEvidencePhotoPath(photo),
    signed_by_email: photo?.signed_by_email || event.signed_by_email || event.created_by_email || "",
    created_at: photo?.created_at || event.created_at || "",
  })).filter((photo) => photo.bucket && photo.path);
}

function isTaskVideoReceiptEvidencePhoto(photo = {}) {
  const text = [
    photo.label,
    photo.path,
    photo.source_path,
    photo.metadata?.videoReceiptUrl,
    photo.metadata?.pageUrl,
    photo.metadata?.source,
  ].filter(Boolean).join(" ");
  return /video[-_\s]?receipt|ebaylive\/events/i.test(text);
}

function normalizeTaskVideoReceiptItemNumber(value = "") {
  return String(value || "").replace(/\D/g, "");
}

function getTaskVideoReceiptPhotoItemNumbers(photo = {}) {
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
  return [...new Set(values.map(normalizeTaskVideoReceiptItemNumber).filter(Boolean))];
}

function taskVideoReceiptPhotoMatchesLine(photo = {}, event = {}, line = {}) {
  const itemNumber = normalizeTaskVideoReceiptItemNumber(line.item_number);
  const explicitItemNumbers = getTaskVideoReceiptPhotoItemNumbers(photo);
  if (explicitItemNumbers.length) return Boolean(itemNumber && explicitItemNumbers.includes(itemNumber));

  const eventLineIds = getTaskEventLineIds(event);
  return Boolean(eventLineIds.length === 1 && line.id && eventLineIds.includes(line.id));
}

function extractFirstEbayLiveUrlFromText(value = "") {
  const match = String(value || "").replace(/&amp;/g, "&").match(/https:\/\/www\.ebay\.com\/ebaylive\/events\/[^\s<>"')]+/i);
  return match?.[0] || "";
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

function normalizeVideoReceiptUrlForTaskLine(url = "", line = {}) {
  const cleanUrl = String(url || "").trim().replace(/&amp;/g, "&");
  if (!cleanUrl) return "";
  let parsed;
  try {
    parsed = new URL(cleanUrl);
  } catch (_) {
    return "";
  }
  if (!/(^|\.)ebay\.com$/i.test(parsed.hostname) || !/\/ebaylive\/events\//i.test(parsed.pathname)) return "";

  const itemNumber = String(line.item_number || "").trim();
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

function getTaskLineVideoReceiptUrl(line = {}, task = {}) {
  const photos = state.orderVideoReceiptPhotosByLineId.get(line.id) || [];
  const order = task.order || {};
  return [
    ...getMetadataVideoReceiptUrls(line.raw_payload),
    ...getMetadataVideoReceiptUrls(order.label_metadata),
    ...getMetadataVideoReceiptUrls(task.metadata),
    ...photos.flatMap((photo) => [
      photo.source_path,
      photo.metadata?.videoReceiptUrl,
      photo.metadata?.pageUrl,
      extractFirstEbayLiveUrlFromText(photo.event?.notes),
    ]),
  ].map((url) => normalizeVideoReceiptUrlForTaskLine(url, line)).find(Boolean) || "";
}

async function hydrateOrderVideoReceiptEvidence(tasks = []) {
  state.orderVideoReceiptPhotosByLineId = new Map();
  const lines = tasks.flatMap((task) => Array.isArray(task.lineDetails) ? task.lineDetails : []);
  const lineIds = unique(lines.map((line) => line.id));
  const orderIds = unique(lines.map((line) => line.order_id));
  if (!lineIds.length) return;

  const taskById = new Map();
  for (let index = 0; index < lineIds.length; index += 100) {
    const chunk = lineIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_tasks")
      .select("id, order_id, order_line_ids, title, question, status, priority, created_by_email, created_at")
      .overlaps("order_line_ids", chunk)
      .limit(500);
    if (error) {
      console.warn("Could not load order video receipt capture tasks:", error);
      return;
    }
    (data || []).forEach((task) => taskById.set(task.id, task));
  }
  for (let index = 0; index < orderIds.length; index += 100) {
    const chunk = orderIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_tasks")
      .select("id, order_id, order_line_ids, title, question, status, priority, created_by_email, created_at")
      .in("order_id", chunk)
      .limit(500);
    if (error) {
      console.warn("Could not load order video receipt capture tasks by order:", error);
      return;
    }
    (data || []).forEach((task) => taskById.set(task.id, task));
  }

  const taskIds = [...taskById.keys()];
  if (!taskIds.length) return;
  const events = [];
  for (let index = 0; index < taskIds.length; index += 100) {
    const chunk = taskIds.slice(index, index + 100);
    const { data, error } = await supabase
      .from("ebay_order_task_events")
      .select("*")
      .in("task_id", chunk)
      .order("created_at", { ascending: false })
      .limit(1000);
    if (error) {
      console.warn("Could not load order video receipt capture events:", error);
      return;
    }
    events.push(...(data || []));
  }

  const photosByLineId = new Map();
  await Promise.all(events.map(async (event) => {
    const sourceTask = taskById.get(event.task_id) || {};
    const enrichedEvent = {
      ...event,
      order_line_ids: Array.isArray(sourceTask.order_line_ids) ? sourceTask.order_line_ids : [],
      task_title: sourceTask.title || "",
      task_question: sourceTask.question || "",
      task_status: sourceTask.status || "",
      task_created_by_email: sourceTask.created_by_email || "",
    };

    const photos = getTaskEventEvidencePhotos(enrichedEvent).filter(isTaskVideoReceiptEvidencePhoto);
    if (!photos.length) return;

    await Promise.all(photos.map(async (photo) => {
      const previewRef = getTaskEvidencePhotoVariantRef(photo, "preview") || { bucket: photo.bucket, path: photo.path };
      const thumbnailRef = getTaskEvidencePhotoVariantRef(photo, "thumbnail");
      photo.previewUrl = photo.signedUrl || await createTaskSignedImageUrl(previewRef.bucket, previewRef.path);
      photo.thumbnailUrl = thumbnailRef
        ? await createTaskSignedImageUrl(thumbnailRef.bucket, thumbnailRef.path)
        : await createTaskSignedImageThumbnailUrl(photo.bucket, photo.path);
      photo.previewBucket = previewRef.bucket;
      photo.previewPath = previewRef.path;
      if (thumbnailRef) {
        photo.thumbnailBucket = thumbnailRef.bucket;
        photo.thumbnailPath = thumbnailRef.path;
      }
    }));

    lines.forEach((line) => {
      const matching = photos.filter((photo) => taskVideoReceiptPhotoMatchesLine(photo, enrichedEvent, line));
      if (!matching.length) return;
      const existing = photosByLineId.get(line.id) || [];
      matching.forEach((photo) => existing.push({ ...photo, event: enrichedEvent }));
      photosByLineId.set(line.id, existing);
    });
  }));

  photosByLineId.forEach((photos, lineId) => {
    const seen = new Set();
    const deduped = photos.filter((photo) => {
      const key = `${photo.bucket}:${photo.path}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return Boolean(photo.previewUrl || photo.thumbnailUrl);
    }).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    if (deduped.length) state.orderVideoReceiptPhotosByLineId.set(lineId, deduped);
  });
}

function isOrderParentTask(task = {}) {
  return task.source === "order" && !task.parent_task_id && ORDER_PARENT_TASK_TYPES.has(task.task_type || "coordination");
}

function isOrderPendingApprovalTask(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const workflowType = String(task.metadata?.workflow_type || "").toLowerCase();
  return isOrderParentTask(task)
    && status === "ready_for_admin_approval"
    && (task.task_type === "pending_admin_review" || workflowType === "pending_order_approval");
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
    .select(`id, order_id, order_line_ids, parent_task_id, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, assigned_by, assigned_by_email, due_at, created_at, updated_at, completed_at, resolved_at, latest_note, latest_photo_count, created_by, created_by_email, metadata, ebay_orders(${ORDER_TASK_ORDER_SELECT})`)
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
    if (!bucket || !path) return;
    const isVideo = isTaskVideoAttachment(photo);
    const previewRef = getTaskEvidencePhotoVariantRef(photo, "preview") || { bucket, path };
    const thumbnailRef = isVideo ? null : getTaskEvidencePhotoVariantRef(photo, "thumbnail");
    if (!photo.previewUrl) {
      photo.previewUrl = photo.url || photo.signedUrl || await createTaskSignedImageUrl(previewRef.bucket, previewRef.path);
    }
    if (!photo.thumbnailUrl) {
      photo.thumbnailUrl = isVideo
        ? photo.previewUrl
        : thumbnailRef
        ? await createTaskSignedImageUrl(thumbnailRef.bucket, thumbnailRef.path)
        : await createTaskSignedImageThumbnailUrl(bucket, path);
    }
    photo.media_type = getTaskAttachmentMediaType(photo);
    photo.previewBucket = previewRef.bucket;
    photo.previewPath = previewRef.path;
    if (thumbnailRef) {
      photo.thumbnailBucket = thumbnailRef.bucket;
      photo.thumbnailPath = thumbnailRef.path;
    }
    photo.signedUrl = photo.previewUrl;
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

function getTaskLineMoneyTotals(lines = [], order = {}) {
  const sold = lines.reduce((sum, line) => sum + Number(line.sold_for || 0), 0);
  const lineTotal = lines.reduce((sum, line) => sum + Number(line.total_price || 0), 0);
  const orderTotal = Number(order.total_price || 0);
  const total = orderTotal || lineTotal || sold;
  const shipping = total && sold && total > sold ? total - sold : 0;
  const payout = Number(order.net_payout || lines.reduce((sum, line) => sum + Number(line.net_payout || 0), 0) || 0);
  return { sold, shipping, total, payout };
}

function getTaskVideoReceiptAuditText(photo = {}) {
  const actor = photo.signed_by_email || "logged-in user";
  const capturedAt = photo.created_at || photo.metadata?.capturedAt || "";
  return `Captured by ${actor}${capturedAt ? ` on ${formatDate(capturedAt)}` : ""}`;
}

function getPendingOrderCustomerName(task = {}) {
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  const labelMetadata = task.order?.label_metadata && typeof task.order.label_metadata === "object"
    ? task.order.label_metadata
    : {};
  const candidates = [
    task.customer_name,
    task.buyer_name,
    metadata.customer_name,
    metadata.customerName,
    metadata.buyer_full_name,
    metadata.buyerFullName,
    metadata.recipient_name,
    metadata.recipientName,
    labelMetadata.customer_name,
    labelMetadata.customerName,
    labelMetadata.buyer_full_name,
    labelMetadata.buyerFullName,
    labelMetadata.ship_to?.name,
    labelMetadata.ship_to?.fullName,
    labelMetadata.shipTo?.name,
    labelMetadata.shipTo?.fullName,
    labelMetadata.shipping_address?.name,
    labelMetadata.shippingAddress?.name,
    labelMetadata.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.fullName,
    labelMetadata.fulfillmentStartInstructions?.[0]?.shippingStep?.shipTo?.contactAddress?.name,
  ];
  return String(candidates.find((value) => String(value || "").trim()) || "").trim();
}

function getPendingOrderLineSummary(task = {}) {
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const quantity = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0);
  if (!lines.length) return "";
  return `${lines.length} line${lines.length === 1 ? "" : "s"} / Qty ${quantity || lines.length}`;
}

function normalizeEbayApiStatusText(value) {
  return String(value || "").trim().toUpperCase();
}

function getPendingOrderTaskSyncMismatch(task = {}) {
  const order = task.order || {};
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const candidates = [
    order?.raw_payload?.pending_order_sync_mismatch,
    task?.metadata?.pending_order_sync_mismatch,
    ...lines.map((line) => line?.raw_payload?.pending_order_sync_mismatch),
  ];
  const mismatch = candidates.find((value) => value && typeof value === "object");
  return mismatch || null;
}

function getFirstTrimmedValue(values = []) {
  return String(values.find((value) => String(value || "").trim()) || "").trim();
}

function getPendingOrderTaskApiStatus(task = {}) {
  const order = task.order || {};
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const firstLine = lines.find(Boolean) || {};
  const mismatch = getPendingOrderTaskSyncMismatch(task);
  const orderApiStatus = order.ebay_api_status || task.metadata?.ebay_api_status || {};
  const lineApiStatus = firstLine.ebay_api_status || {};
  const orderRaw = order.raw_payload || {};
  const lineRaw = firstLine.raw_payload || {};
  return {
    paymentStatus: normalizeEbayApiStatusText(getFirstTrimmedValue([
      mismatch?.ebayPaymentStatus,
      orderApiStatus.payment_status,
      lineApiStatus.payment_status,
      orderRaw.orderPaymentStatus,
      lineRaw.orderPaymentStatus,
      orderRaw.order?.orderPaymentStatus,
      orderRaw.order?.paymentSummary?.payments?.[0]?.paymentStatus,
    ])),
    fulfillmentStatus: normalizeEbayApiStatusText(getFirstTrimmedValue([
      mismatch?.ebayFulfillmentStatus,
      orderApiStatus.fulfillment_status,
      lineApiStatus.fulfillment_status,
      orderRaw.orderFulfillmentStatus,
      lineRaw.orderFulfillmentStatus,
      orderRaw.order?.orderFulfillmentStatus,
      orderRaw.order?.orderFulfillmentState,
    ])),
    cancelStatus: normalizeEbayApiStatusText(getFirstTrimmedValue([
      mismatch?.ebayCancelStatus,
      orderApiStatus.cancel_status,
      lineApiStatus.cancel_status,
      orderRaw.orderCancelStatus,
      lineRaw.orderCancelStatus,
      orderRaw.order?.cancelStatus?.cancelState,
      orderRaw.order?.cancelStatus?.cancelStatus,
    ])),
    reviewReason: getFirstTrimmedValue([
      mismatch?.reason,
      orderApiStatus.review_reason,
      lineApiStatus.review_reason,
    ]),
    reviewMessage: getFirstTrimmedValue([
      mismatch?.message,
      orderApiStatus.review_message,
      lineApiStatus.review_message,
    ]),
    checkedAt: getFirstTrimmedValue([
      orderApiStatus.checked_at,
      lineApiStatus.checked_at,
      mismatch?.detectedAt,
      orderRaw.last_ebay_order_sync_seen_at,
      orderRaw.buyer_history_synced_at,
      orderRaw.account_history_synced_at,
    ]),
  };
}

function isNormalEbayCancelStatus(status) {
  return !status || ["NONE_REQUESTED", "NOT_REQUESTED", "NO_CANCEL", "NOT_CANCELLED"].includes(status);
}

function isNormalEbayPaymentStatus(status) {
  return !status || ["PAID", "FULLY_PAID"].includes(status);
}

function formatCompactStatus(value = "") {
  const label = formatTaskTag(String(value || "").toLowerCase());
  return label || "";
}

function getPendingOrderStatusTone(status = "") {
  const normalized = String(status || "").toLowerCase();
  if (!normalized) return "is-muted";
  if (/cancel|refund|issue|problem|failed|void/.test(normalized)) return "is-danger";
  if (/fulfilled|completed|paid|uploaded|ready|closed|approved/.test(normalized)) return "is-good";
  if (/pending|review|hold|manual|awaiting/.test(normalized)) return "is-warning";
  return "is-muted";
}

function getTaskFinancePayload(source = {}) {
  const order = source?.order || {};
  const candidates = [
    source?.raw_payload?.ebayFinance,
    source?.ebay_finance,
    source?.finance,
    order?.raw_payload?.ebayFinance,
    order?.ebay_finance,
    order?.finance,
  ].filter((entry) => entry && typeof entry === "object");
  return candidates
    .sort((left, right) => getTaskFinancePayloadRank(right) - getTaskFinancePayloadRank(left))[0] || null;
}

function normalizeTaskFinanceStatus(value = "") {
  const text = String(value || "").trim().toLowerCase();
  if (!text) return "";
  if (text.includes("hold")) return "on_hold";
  if (text.includes("process")) return "processing";
  if (text.includes("available")) return "available";
  if (text.includes("payout") || text.includes("paid")) return "paid_out";
  return text;
}

function getTaskFinanceStatusRank(status = "") {
  if (status === "on_hold") return 50;
  if (status === "processing") return 40;
  if (status === "available") return 30;
  if (status === "paid_out") return 20;
  return 10;
}

function getTaskFinanceActivityKind(payload = {}) {
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const text = [
    payload?.memo,
    ...transactions.flatMap((transaction) => [
      transaction?.transactionType,
      transaction?.transactionId,
      transaction?.memo,
      transaction?.bookingEntry,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
  if (/(dispute|claim|chargeback|case)/i.test(text)) return "dispute";
  if (/(refund|return)/i.test(text)) return "refund";
  if (/\bdebit\b/i.test(text) && !/\bsale\b/i.test(text)) return "adjustment";
  return "";
}

function getTaskFinancePayloadRank(payload = {}) {
  const status = normalizeTaskFinanceStatus(payload?.status || payload?.transactionStatus || payload?.transaction_status);
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const activityKind = getTaskFinanceActivityKind(payload);
  if (activityKind) return 100 + getTaskFinanceStatusRank(status);
  if (payload?.source === "ebay_finances_api" && status === "unknown" && transactions.length === 0) return 1;
  return getTaskFinanceStatusRank(status);
}

function getTaskFinanceStatusLabel(status = "") {
  if (status === "on_hold") return "On hold";
  if (status === "paid_out") return "Paid out";
  if (status === "available") return "Available";
  if (status === "processing") return "Processing";
  return "Payout unknown";
}

function getTaskFinanceStatusTone(status = "", activityKind = "") {
  if (activityKind === "dispute") return "is-danger";
  if (activityKind === "refund" || activityKind === "adjustment") return "is-warning";
  if (status === "on_hold") return "is-danger";
  if (status === "paid_out") return "is-good";
  if (status === "available" || status === "processing") return "is-warning";
  return "is-muted";
}

function getTaskFinanceBadgeFromPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return null;
  const status = normalizeTaskFinanceStatus(payload?.status || payload?.transactionStatus || payload?.transaction_status);
  const transactions = Array.isArray(payload?.transactions) ? payload.transactions : [];
  const activityKind = getTaskFinanceActivityKind(payload);
  const statusLabel = payload?.statusLabel || payload?.status_label || getTaskFinanceStatusLabel(status);
  const checkedWithNoTransactions = payload?.source === "ebay_finances_api"
    && status === "unknown"
    && transactions.length === 0;
  const activityLabel = activityKind === "dispute" ? "Dispute" : activityKind === "refund" ? "Refund" : activityKind === "adjustment" ? "Adjustment" : "";
  return {
    label: checkedWithNoTransactions
      ? "No payout data"
      : activityLabel
        ? `${activityLabel} / ${statusLabel}`
        : statusLabel,
    tone: getTaskFinanceStatusTone(status, activityKind),
    title: [
      checkedWithNoTransactions ? "eBay Finances checked this order but returned no transaction data." : "",
      activityLabel ? `${activityLabel} finance activity is attached to this order.` : "",
      statusLabel ? `Finance status: ${statusLabel}` : "",
      payload.memo,
      payload.syncedAt ? `Checked ${formatDate(payload.syncedAt)}` : "",
    ].filter(Boolean).join(" "),
    rank: activityKind ? 100 + getTaskFinanceStatusRank(status) : getTaskFinanceStatusRank(status),
  };
}

function getPendingOrderTaskFinanceBadge(task = {}) {
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const candidates = [
    getTaskFinancePayload({ order: task.order || {} }),
    ...lines.map((line) => getTaskFinancePayload({ ...line, order: task.order || {} })),
  ].filter(Boolean);
  const payload = candidates
    .sort((left, right) => getTaskFinancePayloadRank(right) - getTaskFinancePayloadRank(left))[0] || null;
  return getTaskFinanceBadgeFromPayload(payload);
}

function getPendingOrderStatusPills(task = {}) {
  const order = task.order || {};
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const api = getPendingOrderTaskApiStatus(task);
  const lineStatuses = unique(lines.map((line) => line.line_status)).map(formatCompactStatus).filter(Boolean);
  const financeBadge = getPendingOrderTaskFinanceBadge(task);
  const pills = [
    order.status ? { label: `Order ${formatCompactStatus(order.status)}`, tone: getPendingOrderStatusTone(order.status) } : null,
    order.label_status ? { label: `Label ${formatCompactStatus(order.label_status)}`, tone: getPendingOrderStatusTone(order.label_status) } : null,
    api.paymentStatus ? { label: `Payment ${formatCompactStatus(api.paymentStatus)}`, tone: isNormalEbayPaymentStatus(api.paymentStatus) ? "is-good" : "is-danger" } : null,
    api.fulfillmentStatus ? { label: `eBay ${formatCompactStatus(api.fulfillmentStatus)}`, tone: api.fulfillmentStatus === "FULFILLED" ? "is-warning" : "is-muted" } : null,
    api.cancelStatus && !isNormalEbayCancelStatus(api.cancelStatus) ? { label: `Cancel ${formatCompactStatus(api.cancelStatus)}`, tone: "is-danger" } : null,
    financeBadge ? { label: financeBadge.label, tone: financeBadge.tone, title: financeBadge.title, rank: financeBadge.rank } : null,
    api.reviewReason || api.reviewMessage ? { label: "Needs eBay review", tone: "is-warning" } : null,
    lineStatuses.length ? { label: `Lines ${lineStatuses.join(", ")}`, tone: getPendingOrderStatusTone(lineStatuses.join(" ")) } : null,
  ].filter(Boolean);
  return { pills, api };
}

function getPendingOrderStatusMessage(task = {}) {
  const { api } = getPendingOrderStatusPills(task);
  if (api.reviewMessage) return api.reviewMessage;
  if (api.reviewReason) return formatCompactStatus(api.reviewReason);
  if (api.paymentStatus?.includes("REFUND")) return "eBay shows a refund signal. Confirm the order in eBay before shipping.";
  if (!isNormalEbayCancelStatus(api.cancelStatus)) return "eBay shows a cancellation signal. Confirm the order in eBay before shipping.";
  if (api.fulfillmentStatus === "FULFILLED") return "eBay already shows this order as fulfilled. Check before doing duplicate work.";
  return "";
}

function getPendingOrderEbayCondition(task = {}) {
  const order = task.order || {};
  const { api } = getPendingOrderStatusPills(task);
  const cancelLabel = formatCompactStatus(api.cancelStatus);
  const fulfillmentLabel = formatCompactStatus(api.fulfillmentStatus);
  const paymentLabel = formatCompactStatus(api.paymentStatus);
  const orderLabel = formatCompactStatus(order.status);

  if (!isNormalEbayCancelStatus(api.cancelStatus)) {
    return {
      label: `eBay cancel ${cancelLabel || "flagged"}`,
      shortLabel: `Cancel ${cancelLabel || "flagged"}`,
      tone: "is-danger",
      message: getPendingOrderStatusMessage(task),
    };
  }
  if (api.paymentStatus?.includes("REFUND")) {
    return {
      label: `eBay ${paymentLabel || "refund signal"}`,
      shortLabel: paymentLabel || "Refund signal",
      tone: "is-danger",
      message: getPendingOrderStatusMessage(task),
    };
  }
  if (api.reviewReason || api.reviewMessage) {
    return {
      label: "Needs eBay review",
      shortLabel: "eBay review",
      tone: "is-warning",
      message: getPendingOrderStatusMessage(task),
    };
  }
  if (api.fulfillmentStatus === "FULFILLED") {
    return {
      label: "eBay already fulfilled",
      shortLabel: "eBay fulfilled",
      tone: "is-warning",
      message: getPendingOrderStatusMessage(task),
    };
  }
  if (api.paymentStatus && isNormalEbayPaymentStatus(api.paymentStatus)) {
    return {
      label: `eBay payment ${paymentLabel || "paid"}`,
      shortLabel: paymentLabel || "Paid",
      tone: "is-good",
      message: "",
    };
  }
  if (api.fulfillmentStatus) {
    return {
      label: `eBay ${fulfillmentLabel}`,
      shortLabel: fulfillmentLabel,
      tone: getPendingOrderStatusTone(api.fulfillmentStatus),
      message: "",
    };
  }
  if (order.status) {
    return {
      label: `Local order ${orderLabel}`,
      shortLabel: orderLabel,
      tone: getPendingOrderStatusTone(order.status),
      message: "",
    };
  }
  return {
    label: "eBay status not loaded",
    shortLabel: "eBay unknown",
    tone: "is-muted",
    message: "Open eBay before working this task if the order status is unclear.",
  };
}

function getPendingOrderSummaryStatusChips(task = {}) {
  if (task.source !== "order") return [];
  const { api } = getPendingOrderStatusPills(task);
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const financeBadge = getPendingOrderTaskFinanceBadge(task);
  const condition = getPendingOrderEbayCondition(task);
  const lineStatuses = unique(lines.map((line) => String(line.line_status || "").trim()).filter(Boolean));
  const lineStatusText = lineStatuses.map(formatCompactStatus).filter(Boolean).join(", ");
  const chips = [
    lineStatusText ? { label: `Lines ${lineStatusText}`, tone: getPendingOrderStatusTone(lineStatusText), title: "Local OG line status for the order lines linked to this task." } : null,
    !isNormalEbayCancelStatus(api.cancelStatus) ? { label: `Cancel ${formatCompactStatus(api.cancelStatus) || "flagged"}`, tone: "is-danger", title: "eBay cancellation status for this order." } : null,
    api.paymentStatus ? { label: `Payment ${formatCompactStatus(api.paymentStatus)}`, tone: isNormalEbayPaymentStatus(api.paymentStatus) ? "is-good" : "is-danger", title: "eBay payment status for this order." } : null,
    api.fulfillmentStatus ? { label: `eBay ${formatCompactStatus(api.fulfillmentStatus)}`, tone: api.fulfillmentStatus === "FULFILLED" ? "is-warning" : getPendingOrderStatusTone(api.fulfillmentStatus), title: "eBay fulfillment status for this order." } : null,
    financeBadge ? { label: financeBadge.label, tone: financeBadge.tone, title: financeBadge.title, rank: financeBadge.rank } : null,
    api.reviewReason || api.reviewMessage ? { label: "eBay review", tone: "is-warning", title: api.reviewMessage || api.reviewReason } : null,
  ].filter(Boolean);

  if (!chips.length && condition.label) {
    chips.push({ label: condition.shortLabel || condition.label, tone: condition.tone, title: condition.message || condition.label });
  }

  const seen = new Set();
  return chips.filter((chip) => {
    const key = `${chip.label}:${chip.tone}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderTaskOrderSummaryStatusChip(task = {}) {
  const chips = getPendingOrderSummaryStatusChips(task);
  if (!chips.length) return "";
  return chips.map((chip) => (
    `<span class="team-task-summary-ebay-status ${escapeHtml(chip.tone)}" title="${escapeHtml(chip.title || chip.label)}">${escapeHtml(chip.label)}</span>`
  )).join("");
}

function renderTaskOrderNumberAction(orderNumber = "", label = "Order") {
  const cleanNumber = normalizeEbayOrderNumber(orderNumber);
  if (!cleanNumber) return "";
  return `
    <button type="button" class="team-task-order-number-action" data-task-order-number-action data-task-order-number="${escapeHtml(cleanNumber)}" title="Copy or open this eBay order">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(cleanNumber)}</strong>
    </button>
  `;
}

function getTaskOrderMiniStatus(task = {}) {
  if (task.source !== "order") return "";
  const condition = getPendingOrderEbayCondition(task);
  const chipLabels = getPendingOrderSummaryStatusChips(task).map((chip) => chip.label).slice(0, 3);
  const customerName = getPendingOrderCustomerName(task);
  return [
    chipLabels.length ? chipLabels.join(" / ") : condition.shortLabel || condition.label,
    task.order_number ? `Order ${task.order_number}` : "",
    task.buyer_username ? `Buyer ${task.buyer_username}` : "",
    customerName ? `Customer ${customerName}` : "",
  ].filter(Boolean).join(" - ");
}

function renderPendingOrderStatusSnapshot(task = {}) {
  const order = task.order || {};
  const lineSummary = getPendingOrderLineSummary(task);
  const customerName = getPendingOrderCustomerName(task);
  const orderNumber = task.order_number || order.order_number || "";
  const orderHref = buildEbayOrderDetailsUrl(orderNumber);
  const { pills } = getPendingOrderStatusPills(task);
  const condition = getPendingOrderEbayCondition(task);
  const statusMessage = condition.message || getPendingOrderStatusMessage(task);
  const moneyLabel = getTaskMoneyLabel(task);
  const quickFacts = [
    order.sale_date ? ["Placed", formatDate(order.sale_date)] : null,
    task.ship_by_date || order.ship_by_date ? ["Ship by", formatDate(task.ship_by_date || order.ship_by_date)] : null,
    moneyLabel ? ["Order value", moneyLabel] : null,
    lineSummary ? ["Items", lineSummary] : null,
  ].filter(Boolean);
  const facts = [
    order.paid_on_date ? ["Paid", formatDate(order.paid_on_date)] : null,
    order.label_uploaded_at ? ["Label saved", formatDate(order.label_uploaded_at)] : null,
    customerName ? ["Customer", customerName] : null,
    condition.label ? ["eBay condition", condition.label] : null,
  ].filter(Boolean);

  return `
    <section class="team-task-order-snapshot">
      <div class="team-task-order-snapshot-head">
        <div class="team-task-order-title">
          <span class="eyebrow">eBay Order Check</span>
          <div class="team-task-order-title-row">
            ${renderTaskOrderNumberAction(orderNumber)}
            ${!orderNumber ? `<strong>Pending order</strong>` : ""}
            ${task.buyer_username ? `<span class="team-task-order-buyer">${escapeHtml(task.buyer_username)}</span>` : ""}
          </div>
        </div>
        <div class="team-task-order-actions">
          ${orderHref ? `<a class="secondary-btn team-task-context-open-link" href="${escapeHtml(orderHref)}" target="_blank" rel="noopener">Open eBay</a>` : ""}
        </div>
      </div>
      <div class="team-task-order-check-row">
        <span class="team-task-order-primary-status ${escapeHtml(condition.tone)}">${escapeHtml(condition.label)}</span>
        ${quickFacts.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join("")}
      </div>
      ${statusMessage ? `<p class="team-task-order-status-message ${condition.tone === "is-danger" ? "is-danger" : ""}">${escapeHtml(statusMessage)}</p>` : ""}
      ${(pills.length || facts.length) ? `
        <details class="team-task-context-details team-task-order-status-details">
          <summary>Order details and eBay fields</summary>
          ${pills.length ? `
            <div class="team-task-order-status-pills">
              ${pills.map((pill) => `<span class="team-task-order-status-pill ${escapeHtml(pill.tone)}" title="${escapeHtml(pill.title || pill.label)}">${escapeHtml(pill.label)}</span>`).join("")}
            </div>
          ` : `<p class="team-task-order-status-empty">No eBay status warning loaded for this task.</p>`}
          ${facts.length ? `
            <div class="team-task-order-status-facts">
              ${facts.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join("")}
            </div>
          ` : ""}
        </details>
      ` : `<p class="team-task-order-status-empty">No eBay status warning loaded for this task.</p>`}
    </section>
  `;
}

function getTaskEventEvidencePhotosForBrief(events = []) {
  const photos = [];
  events.forEach((event) => {
    (Array.isArray(event.photo_attachments) ? event.photo_attachments : []).forEach((photo, index) => {
      const mediaType = getTaskAttachmentMediaType(photo);
      const bucket = photo.previewBucket || photo.bucket || photo.storage_bucket || TEAM_TASK_BUCKET;
      const path = photo.previewPath || photo.path || photo.storage_path || "";
      const url = photo.signedUrl || photo.url || "";
      const label = photo.label || `${mediaType === "video" ? "Task video" : "Task photo"} ${index + 1}`;
      if (!bucket && !url) return;
      photos.push({
        bucket,
        path,
        url: photo.previewUrl || url,
        thumbnailUrl: photo.thumbnailUrl || url,
        label,
        kind: getTaskAttachmentKindLabel(photo),
        caption: event.created_at ? `Added ${formatDate(event.created_at)}` : "Task evidence",
        media_type: mediaType,
      });
    });
  });
  return photos;
}

function getTaskVideoReceiptPhotosForBrief(task = {}) {
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const photos = [];
  lines.forEach((line) => {
    const linePhotos = state.orderVideoReceiptPhotosByLineId.get(line.id) || [];
    linePhotos.forEach((photo, index) => {
      const label = photo.label || `Video receipt - ${line.item_number || index + 1}`;
      photos.push({
        bucket: photo.previewBucket || photo.bucket || ORDER_EVIDENCE_BUCKET,
        path: photo.previewPath || photo.path || "",
        url: photo.previewUrl || photo.thumbnailUrl || "",
        thumbnailUrl: photo.thumbnailUrl || photo.previewUrl || "",
        label,
        kind: "Video receipt",
        caption: getTaskVideoReceiptAuditText(photo),
        media_type: getTaskAttachmentMediaType(photo),
      });
    });
  });
  return photos;
}

function renderPendingOrderEvidencePanel(task = {}, events = []) {
  const photos = getPendingOrderBriefEvidencePhotos(task, events);
  const shown = photos.slice(0, 8);
  const extraCount = Math.max(0, photos.length - shown.length);
  return `
    <section class="team-task-evidence-panel">
      <div class="team-task-evidence-head">
        <div>
          <span class="eyebrow">Evidence</span>
          <strong>${photos.length ? `${photos.length} evidence file${photos.length === 1 ? "" : "s"} attached` : "No evidence attached yet"}</strong>
        </div>
        ${extraCount ? `<span class="team-task-chip">+${escapeHtml(extraCount)} more</span>` : ""}
      </div>
      ${shown.length ? `
        <div class="team-task-evidence-grid">
          ${shown.map((photo) => renderPendingOrderEvidencePhotoButton(photo, "team-task-evidence-thumb")).join("")}
        </div>
      ` : `<p class="team-task-evidence-empty">No task evidence or video receipt screenshots are attached yet.</p>`}
    </section>
  `;
}

function getPendingOrderBriefEvidencePhotos(task = {}, events = []) {
  const allPhotos = [
    ...getTaskVideoReceiptPhotosForBrief(task),
    ...getTaskEventEvidencePhotosForBrief(events),
  ];
  const seen = new Set();
  return allPhotos.filter((photo) => {
    const key = `${photo.bucket || ""}:${photo.path || ""}:${photo.url || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return Boolean(photo.bucket || photo.url);
  });
}

function renderPendingOrderEvidencePhotoButton(photo = {}, className = "team-task-evidence-thumb") {
  const label = photo.label || "Task evidence photo";
  const imageUrl = photo.thumbnailUrl || photo.url || "";
  const mediaType = getTaskAttachmentMediaType(photo);
  return `
    <button
      type="button"
      class="${escapeHtml(className)}"
      data-team-task-photo="1"
      data-bucket="${escapeHtml(photo.bucket || TEAM_TASK_BUCKET)}"
      data-path="${escapeHtml(photo.path || "")}"
      data-url="${escapeHtml(photo.url || "")}"
      data-label="${escapeHtml(label)}"
      data-media-type="${escapeHtml(mediaType)}"
      aria-label="Open ${escapeHtml(label)}"
    >
      ${renderTaskEvidencePreview(photo, imageUrl, label)}
      <span><b>${escapeHtml(photo.kind || "Evidence")}</b><small>${escapeHtml(photo.caption || label)}</small></span>
    </button>
  `;
}

function renderPendingOrderEvidenceStrip(task = {}, events = []) {
  const photos = getPendingOrderBriefEvidencePhotos(task, events);
  const shown = photos.slice(0, 3);
  const extraCount = Math.max(0, photos.length - shown.length);
  return `
    <aside class="team-task-evidence-strip">
      <div class="team-task-evidence-strip-head">
        <span class="eyebrow">Evidence</span>
        <strong>${photos.length ? `${photos.length} attached` : "None yet"}</strong>
      </div>
      ${shown.length ? `
        <div class="team-task-evidence-strip-thumbs">
          ${shown.map((photo) => renderPendingOrderEvidencePhotoButton(photo, "team-task-evidence-strip-thumb")).join("")}
          ${extraCount ? `<span class="team-task-evidence-extra">+${escapeHtml(extraCount)}</span>` : ""}
        </div>
      ` : `<p class="team-task-evidence-empty">No photo or receipt attached.</p>`}
    </aside>
  `;
}

function renderPendingOrderCompactStatus(task = {}) {
  const condition = getPendingOrderEbayCondition(task);
  const statusMessage = condition.message || getPendingOrderStatusMessage(task);
  const chips = getPendingOrderSummaryStatusChips(task);
  return `
    <div class="team-task-order-compact-status">
      <div class="team-task-order-compact-chip-row">
        ${chips.length
          ? chips.map((chip) => `<span class="team-task-order-primary-status ${escapeHtml(chip.tone)}" title="${escapeHtml(chip.title || chip.label)}">${escapeHtml(chip.label)}</span>`).join("")
          : `<span class="team-task-order-primary-status ${escapeHtml(condition.tone)}">${escapeHtml(condition.shortLabel || condition.label)}</span>`}
      </div>
      ${statusMessage ? `<em class="${condition.tone === "is-danger" ? "is-danger" : ""}">${escapeHtml(statusMessage)}</em>` : ""}
    </div>
  `;
}

function getTaskLineReceiptPhotos(line = {}) {
  return state.orderVideoReceiptPhotosByLineId.get(line.id) || [];
}

function normalizeLineReviewDecision(value = "") {
  const normalized = String(value || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["approved", "approve", "ok", "accepted", "pass", "passed"].includes(normalized)) return "approved";
  if (["needs_work", "needs_rework", "rework", "fix", "needs_fix", "rejected", "send_back"].includes(normalized)) return "needs_work";
  return "";
}

function getLineReviewArrayFromPayload(payload = {}) {
  if (!payload || typeof payload !== "object") return [];
  const candidates = [
    payload.line_reviews,
    payload.lineReviews,
    payload.item_reviews,
    payload.itemReviews,
    payload.approval_line_reviews,
    payload.approvalLineReviews,
    payload.latest_line_reviews,
    payload.latestLineReviews,
  ];
  return candidates.find((value) => Array.isArray(value)) || [];
}

function getLineReviewKey(review = {}) {
  return String(review.line_id || review.order_line_id || review.id || review.lineId || review.orderLineId || "").trim();
}

function buildLineReviewMapFromReviews(reviews = []) {
  const map = new Map();
  reviews.forEach((review) => {
    const key = getLineReviewKey(review);
    const decision = normalizeLineReviewDecision(review.decision || review.status || review.result);
    if (!key || !decision) return;
    map.set(key, {
      ...review,
      decision,
      note: String(review.note || review.notes || review.reason || "").trim(),
      reviewed_by_email: review.reviewed_by_email || review.reviewedByEmail || review.signed_by_email || "",
      reviewed_at: review.reviewed_at || review.reviewedAt || "",
    });
  });
  return map;
}

function getLatestPendingOrderLineReviewMap(task = {}, events = []) {
  const payloads = [
    ...(Array.isArray(events) ? [...events].reverse().map((event) => event.payload) : []),
    task.metadata,
  ].filter((payload) => payload && typeof payload === "object");

  for (const payload of payloads) {
    const reviews = getLineReviewArrayFromPayload(payload);
    if (!reviews.length) continue;
    const map = buildLineReviewMapFromReviews(reviews);
    if (map.size) return map;
  }
  return new Map();
}

function getLineReviewForLine(line = {}, reviewMap = new Map()) {
  const keys = [line.id, line.order_line_id, line.line_id]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return keys.map((key) => reviewMap.get(key)).find(Boolean) || null;
}

function getLineReviewIdentity(line = {}, index = 0) {
  return String(line.id || line.order_line_id || line.line_id || `line-${index}`).trim();
}

function getLineReviewStateKey(task = {}, line = {}, index = 0) {
  return `${task.id || task.order_id || "task"}:${getLineReviewIdentity(line, index)}`;
}

function getLineReviewDraft(task = {}, line = {}, index = 0, review = null, fallbackDecision = "") {
  const draft = state.lineReviewDecisions.get(getLineReviewStateKey(task, line, index)) || {};
  const decision = normalizeLineReviewDecision(draft.decision)
    || normalizeLineReviewDecision(review?.decision)
    || normalizeLineReviewDecision(fallbackDecision);
  const note = Object.prototype.hasOwnProperty.call(draft, "note")
    ? String(draft.note || "").trim()
    : String(review?.note || "").trim();
  return { decision, note };
}

function rememberLineReviewDraft(row) {
  if (!row?.dataset?.lineReviewStateKey) return;
  const decision = normalizeLineReviewDecision(row.dataset.lineReviewDecision || "");
  const note = String(row.querySelector("[data-line-review-inline-note]")?.value || "").trim();
  state.lineReviewDecisions.set(row.dataset.lineReviewStateKey, { decision, note });
}

function renderLineReviewBadge(review = null) {
  if (!review?.decision) return "";
  const approved = review.decision === "approved";
  const actor = review.reviewed_by_email ? ` by ${review.reviewed_by_email}` : "";
  return `
    <span class="team-task-line-review-badge ${approved ? "is-approved" : "needs-work"}">
      ${escapeHtml(approved ? `Approved${actor}` : `Needs work${actor}`)}
    </span>
  `;
}

function renderPendingOrderApprovalLinePhoto(line = {}, task = {}, index = 0) {
  const photos = getTaskLineReceiptPhotos(line);
  const photo = photos[0];
  const extraCount = Math.max(0, photos.length - 1);
  const videoReceiptUrl = getTaskLineVideoReceiptUrl(line, task);
  const label = photo?.label || `Video receipt - ${line.item_number || index + 1}`;
  const previewUrl = photo?.previewUrl || photo?.url || photo?.signedUrl || "";
  const thumbnailUrl = photo?.thumbnailUrl || previewUrl;
  const previewBucket = photo?.previewBucket || photo?.bucket || ORDER_EVIDENCE_BUCKET;
  const previewPath = photo?.previewPath || photo?.path || "";
  if (photo) {
    return `
      <button
        type="button"
        class="team-task-approval-line-photo"
        data-team-task-photo="1"
        data-bucket="${escapeHtml(previewBucket)}"
        data-path="${escapeHtml(previewPath)}"
        data-url="${escapeHtml(previewUrl)}"
        data-label="${escapeHtml(label)}"
        aria-label="Open ${escapeHtml(label)}"
      >
        ${thumbnailUrl ? `<img src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(label)}" loading="lazy" />` : `<span class="team-task-approval-line-photo-fallback">Receipt</span>`}
        ${extraCount ? `<em>+${escapeHtml(extraCount)}</em>` : ""}
      </button>
    `;
  }
  return `
    <div class="team-task-approval-line-photo is-missing" aria-label="No saved video receipt screenshot">
      <span>No photo</span>
      ${videoReceiptUrl ? `<a href="${escapeHtml(videoReceiptUrl)}" target="_blank" rel="noopener">Open receipt</a>` : ""}
    </div>
  `;
}

function shouldShowInlineOrderLineReviewControls(task = {}) {
  return isOrderPendingApprovalTask(task) && canUseAdminTaskControls() && !isTaskHistoryView();
}

function renderInlineOrderLineReviewControls(task = {}, line = {}, index = 0, review = null) {
  if (!shouldShowInlineOrderLineReviewControls(task)) return "";
  const { decision, note } = getLineReviewDraft(task, line, index, review, "");
  const lineId = getLineReviewIdentity(line, index);
  const stateKey = getLineReviewStateKey(task, line, index);
  const noteVisible = decision === "needs_work" || Boolean(note);
  return `
    <div
      class="team-task-line-review-inline ${decision === "needs_work" ? "needs-work" : decision === "approved" ? "is-approved" : ""}"
      data-inline-line-review-row="1"
      data-line-review-state-key="${escapeHtml(stateKey)}"
      data-line-id="${escapeHtml(lineId)}"
      data-line-review-decision="${escapeHtml(decision)}"
    >
      <div class="team-task-line-review-inline-buttons" role="radiogroup" aria-label="Item approval decision">
        <button
          type="button"
          class="team-task-line-review-inline-btn is-approved ${decision === "approved" ? "is-selected" : ""}"
          data-line-review-inline-decision="approved"
          aria-pressed="${decision === "approved" ? "true" : "false"}"
        >Approve</button>
        <button
          type="button"
          class="team-task-line-review-inline-btn needs-work ${decision === "needs_work" ? "is-selected" : ""}"
          data-line-review-inline-decision="needs_work"
          aria-pressed="${decision === "needs_work" ? "true" : "false"}"
        >Needs work</button>
      </div>
      <textarea
        class="team-task-line-review-inline-note ${noteVisible ? "is-visible" : ""}"
        data-line-review-inline-note="1"
        rows="1"
        placeholder="What does this specific item still need?"
      >${escapeHtml(note)}</textarea>
    </div>
  `;
}

function renderPendingOrderApprovalLines(task = {}, events = []) {
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  if (!lines.length) {
    return `
      <section class="team-task-approval-lines">
        <div class="team-task-approval-lines-head">
          <span class="eyebrow">Items to approve</span>
          <strong>No item lines loaded</strong>
        </div>
      </section>
    `;
  }
  const shown = lines.slice(0, 10);
  const hiddenCount = Math.max(0, lines.length - shown.length);
  const reviewMap = getLatestPendingOrderLineReviewMap(task, events);
  return `
    <section class="team-task-approval-lines">
      <div class="team-task-approval-lines-head">
        <span class="eyebrow">Items to approve</span>
        <strong>${escapeHtml(getPendingOrderLineSummary(task) || `${lines.length} line${lines.length === 1 ? "" : "s"}`)}</strong>
      </div>
      <div class="team-task-approval-line-list">
        ${shown.map((line, index) => {
          const photos = getTaskLineReceiptPhotos(line);
          const amount = formatMoney(line.total_price || line.sold_for || "");
          const title = line.item_number ? `${line.item_number} - ${line.item_title || "Untitled item"}` : line.item_title || "Untitled item";
          const lineReview = getLineReviewForLine(line, reviewMap);
          const chips = [
            line.quantity ? `Qty ${line.quantity}` : "Qty 1",
            amount || "",
            line.line_status ? formatTaskTag(line.line_status) : "",
            photos.length ? `Receipt photo ${photos.length}` : "Missing receipt photo",
          ].filter(Boolean);
          return `
            <article class="team-task-approval-line ${photos.length ? "has-photo" : "is-missing-photo"}">
              ${renderPendingOrderApprovalLinePhoto(line, task, index)}
              <div class="team-task-approval-line-main">
                <strong>${escapeHtml(title)}</strong>
                <div class="team-task-approval-line-meta">
                  ${chips.map((chip) => `<span>${escapeHtml(chip)}</span>`).join("")}
                  ${renderLineReviewBadge(lineReview)}
                </div>
                ${lineReview?.note ? `<p class="team-task-line-review-note">${escapeHtml(lineReview.note)}</p>` : ""}
                ${renderInlineOrderLineReviewControls(task, line, index, lineReview)}
              </div>
            </article>
          `;
        }).join("")}
      </div>
      ${hiddenCount ? `<small class="team-task-more">+${escapeHtml(hiddenCount)} more line${hiddenCount === 1 ? "" : "s"} in the order detail drawer</small>` : ""}
    </section>
  `;
}

function shouldShowOrderLineReviewPanel(task = {}, mode = "") {
  return isOrderPendingApprovalTask(task) && ["order-task-sendback", "order-shipping-assign"].includes(mode);
}

function getDefaultLineReviewDecision(mode = "") {
  return mode === "order-task-sendback" ? "needs_work" : "approved";
}

function renderOrderLineReviewChoice(line = {}, task = {}, mode = "", index = 0, review = null) {
  const lineId = getLineReviewIdentity(line, index);
  const { decision: currentDecision, note } = getLineReviewDraft(task, line, index, review, getDefaultLineReviewDecision(mode));
  const photos = getTaskLineReceiptPhotos(line);
  const amount = formatMoney(line.total_price || line.sold_for || "");
  const title = line.item_number ? `${line.item_number} - ${line.item_title || "Untitled item"}` : line.item_title || "Untitled item";
  const inputName = `team-task-line-review-${lineId || index}`;
  return `
    <article class="team-task-line-review-row ${currentDecision === "needs_work" ? "needs-work" : "is-approved"}" data-line-review-row="1" data-line-id="${escapeHtml(lineId)}">
      ${renderPendingOrderApprovalLinePhoto(line, task, index)}
      <div class="team-task-line-review-body">
        <div class="team-task-line-review-title">
          <strong>${escapeHtml(title)}</strong>
          <span>${escapeHtml([line.quantity ? `Qty ${line.quantity}` : "Qty 1", amount].filter(Boolean).join(" / "))}</span>
        </div>
        <div class="team-task-line-review-controls" role="radiogroup" aria-label="Review ${escapeHtml(title)}">
          <label class="team-task-line-review-pill is-approved">
            <input type="radio" name="${escapeHtml(inputName)}" value="approved" ${currentDecision === "approved" ? "checked" : ""} />
            Approved
          </label>
          <label class="team-task-line-review-pill needs-work">
            <input type="radio" name="${escapeHtml(inputName)}" value="needs_work" ${currentDecision === "needs_work" ? "checked" : ""} />
            Needs work
          </label>
          <span>${escapeHtml(photos.length ? `${photos.length} receipt photo${photos.length === 1 ? "" : "s"}` : "No receipt photo")}</span>
        </div>
        <textarea data-line-review-note="1" rows="2" placeholder="Required when this item needs work. Example: missing video receipt, wrong item, needs extra photo.">${escapeHtml(note)}</textarea>
      </div>
    </article>
  `;
}

function refreshLineReviewRowState(row) {
  const decision = normalizeLineReviewDecision(row?.querySelector("input[type='radio']:checked")?.value || "");
  row?.classList.toggle("needs-work", decision === "needs_work");
  row?.classList.toggle("is-approved", decision === "approved");
}

function setupLineReviewPanelListeners(panel) {
  panel.querySelectorAll("[data-line-review-row]").forEach((row) => {
    refreshLineReviewRowState(row);
    row.querySelectorAll("input[type='radio']").forEach((input) => {
      input.addEventListener("change", () => refreshLineReviewRowState(row));
    });
  });
}

function refreshInlineLineReviewRowState(row) {
  const decision = normalizeLineReviewDecision(row?.dataset?.lineReviewDecision || "");
  row?.classList.toggle("needs-work", decision === "needs_work");
  row?.classList.toggle("is-approved", decision === "approved");
  row?.querySelectorAll("[data-line-review-inline-decision]").forEach((button) => {
    const selected = normalizeLineReviewDecision(button.dataset.lineReviewInlineDecision || "") === decision;
    button.classList.toggle("is-selected", selected);
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  });
  const note = row?.querySelector("[data-line-review-inline-note]");
  if (note) note.classList.toggle("is-visible", decision === "needs_work" || Boolean(note.value.trim()));
}

function setupInlineLineReviewControls(root) {
  root.querySelectorAll("[data-inline-line-review-row]").forEach((row) => {
    refreshInlineLineReviewRowState(row);
  });
  root.querySelectorAll("[data-line-review-inline-decision]").forEach((button) => {
    button.addEventListener("click", () => {
      const row = button.closest("[data-inline-line-review-row]");
      if (!row) return;
      row.dataset.lineReviewDecision = normalizeLineReviewDecision(button.dataset.lineReviewInlineDecision || "");
      refreshInlineLineReviewRowState(row);
      rememberLineReviewDraft(row);
      if (row.dataset.lineReviewDecision === "needs_work") {
        row.querySelector("[data-line-review-inline-note]")?.focus();
      }
    });
  });
  root.querySelectorAll("[data-line-review-inline-note]").forEach((input) => {
    input.addEventListener("input", () => {
      const row = input.closest("[data-inline-line-review-row]");
      if (!row) return;
      refreshInlineLineReviewRowState(row);
      rememberLineReviewDraft(row);
    });
  });
}

function resetLineReviewPanel() {
  const panel = $("team-task-line-review-panel");
  if (!panel) return;
  panel.classList.add("hidden");
  panel.innerHTML = "";
  delete panel.dataset.mode;
}

function configureOrderLineReviewPanel(task = {}, mode = "") {
  const panel = $("team-task-line-review-panel");
  resetLineReviewPanel();
  if (!panel || !shouldShowOrderLineReviewPanel(task, mode)) return;

  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  const reviewMap = getLatestPendingOrderLineReviewMap(task, events);
  const summary = getPendingOrderLineSummary(task) || `${lines.length} line${lines.length === 1 ? "" : "s"}`;
  panel.dataset.mode = mode;
  panel.classList.remove("hidden");
  panel.innerHTML = `
    <div class="team-task-line-review-head">
      <div>
        <span class="eyebrow">Item Decisions</span>
        <h3>${escapeHtml(mode === "order-task-sendback" ? "Choose what needs more work" : "Confirm every item is approved")}</h3>
      </div>
      <strong>${escapeHtml(summary)}</strong>
    </div>
    <p>${escapeHtml(mode === "order-task-sendback"
      ? "Mark only the item lines that need correction. Approved lines stay documented so the worker can focus on the problem items."
      : "Every item must be approved before shipping can be assigned. Use Send Back if any line still needs work."
    )}</p>
    <div class="team-task-line-review-list">
      ${lines.length
        ? lines.map((line, index) => renderOrderLineReviewChoice(line, task, mode, index, getLineReviewForLine(line, reviewMap))).join("")
        : `<div class="empty-state">No order lines loaded for this approval.</div>`}
    </div>
  `;
  setupLineReviewPanelListeners(panel);
}

function collectOrderLineReviewDecisions(task = {}, mode = "") {
  const panel = $("team-task-line-review-panel");
  if (!panel || panel.classList.contains("hidden")) return { reviews: [], summary: null, error: "" };
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const rows = [...panel.querySelectorAll("[data-line-review-row]")];
  if (!rows.length) {
    return { reviews: [], summary: null, error: "No item lines are loaded for this approval. Refresh the task and try again." };
  }
  const reviews = rows.map((row, index) => {
    const lineId = String(row.dataset.lineId || "").trim();
    const line = lines.find((entry) => String(entry.id || "") === lineId) || lines[index] || {};
    const decision = normalizeLineReviewDecision(row.querySelector("input[type='radio']:checked")?.value || "");
    const note = String(row.querySelector("[data-line-review-note]")?.value || "").trim();
    return {
      line_id: lineId || line.id || null,
      order_line_id: lineId || line.id || null,
      order_number: task.order_number || task.order?.order_number || "",
      item_number: line.item_number || "",
      transaction_id: line.transaction_id || "",
      item_title: line.item_title || "",
      quantity: Number(line.quantity || 1),
      line_total: line.total_price || line.sold_for || "",
      decision,
      note,
    };
  }).filter((review) => review.line_id || review.item_number || review.item_title);

  const missingDecision = reviews.find((review) => !review.decision);
  if (missingDecision) return { reviews, summary: null, error: "Choose Approved or Needs work for every item line." };

  const needsWorkWithoutNote = reviews.find((review) => review.decision === "needs_work" && !review.note);
  if (needsWorkWithoutNote) {
    return { reviews, summary: null, error: "Add a specific note for every item marked Needs work." };
  }

  const needsWorkCount = reviews.filter((review) => review.decision === "needs_work").length;
  if (mode === "order-task-sendback" && !needsWorkCount) {
    return { reviews, summary: null, error: "Mark at least one item as Needs work before sending the order back." };
  }
  if (mode === "order-shipping-assign" && needsWorkCount) {
    return { reviews, summary: null, error: "Use Send Back when any item still needs work." };
  }

  const summary = {
    total_count: reviews.length,
    approved_count: reviews.filter((review) => review.decision === "approved").length,
    needs_work_count: needsWorkCount,
  };
  return { reviews, summary, error: "" };
}

function buildOrderLineReviewPayload(task = {}, mode = "", lineReview = {}, signedByEmail = "") {
  if (!lineReview?.reviews?.length) return {};
  const reviewedAt = new Date().toISOString();
  const reviews = lineReview.reviews.map((review) => ({
    ...review,
    reviewed_at: reviewedAt,
    reviewed_by_email: signedByEmail,
  }));
  return {
    source: "pending_order_line_review",
    workflow_type: "pending_order_approval",
    review_action: mode === "order-task-sendback" ? "send_back_for_rework" : "approve_for_shipping",
    order_number: task.order_number || task.order?.order_number || "",
    buyer_username: task.buyer_username || task.order?.buyer_username || "",
    line_reviews: reviews,
    line_review_summary: lineReview.summary,
    reviewed_at: reviewedAt,
    reviewed_by_email: signedByEmail,
  };
}

function renderTaskLineVideoReceiptPhotos(line = {}) {
  const photos = state.orderVideoReceiptPhotosByLineId.get(line.id) || [];
  if (!photos.length) return "";
  return `
    <div class="team-task-video-receipt-photos" aria-label="Video receipt screenshots">
      ${photos.map((photo, index) => {
        const label = photo.label || `Video receipt - ${line.item_number || index + 1}`;
        const previewUrl = photo.previewUrl || photo.thumbnailUrl || "";
        const thumbnailUrl = photo.thumbnailUrl || previewUrl;
        const previewBucket = photo.previewBucket || photo.bucket || ORDER_EVIDENCE_BUCKET;
        const previewPath = photo.previewPath || photo.path || "";
        return `
          <button
            type="button"
            class="team-task-video-receipt-thumb"
            data-team-task-photo="1"
            data-bucket="${escapeHtml(previewBucket)}"
            data-path="${escapeHtml(previewPath)}"
            data-url="${escapeHtml(previewUrl)}"
            data-label="${escapeHtml(label)}"
            aria-label="Open ${escapeHtml(label)}"
          >
            ${thumbnailUrl ? `<img src="${escapeHtml(thumbnailUrl)}" alt="${escapeHtml(label)}" loading="lazy" />` : ""}
            <span>${escapeHtml(getTaskVideoReceiptAuditText(photo))}</span>
          </button>
        `;
      }).join("")}
    </div>
  `;
}

function renderTaskLines(task = {}) {
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  if (!lines.length) return "";
  return `
    <div class="team-task-lines">
      ${lines.slice(0, 6).map((line) => {
        const videoReceiptUrl = getTaskLineVideoReceiptUrl(line, task);
        const hasVideoReceiptPhotos = Boolean((state.orderVideoReceiptPhotosByLineId.get(line.id) || []).length);
        return `
          <article class="team-task-line">
            <div class="team-task-line-head">
              <strong>${escapeHtml(line.item_number ? `${line.item_number} - ${line.item_title || "Untitled item"}` : line.item_title || "Untitled item")}</strong>
              ${line.line_status ? `<em>${escapeHtml(line.line_status)}</em>` : ""}
            </div>
            <small>${escapeHtml([task.order_number, line.transaction_id].filter(Boolean).join(" - "))}${line.quantity ? ` - Qty ${escapeHtml(line.quantity)}` : ""}</small>
            ${videoReceiptUrl || hasVideoReceiptPhotos ? `
              <div class="team-task-line-receipt">
                ${videoReceiptUrl
                  ? `<a href="${escapeHtml(videoReceiptUrl)}" target="_blank" rel="noopener">Video receipt</a>`
                  : `<span>Video receipt</span>`}
              </div>
            ` : ""}
            ${renderTaskLineVideoReceiptPhotos(line)}
            <div class="team-task-line-facts">
              <span><small>Qty</small><b>${escapeHtml(line.quantity || 1)}</b></span>
              ${line.sold_for ? `<span><small>Sold for</small><b>${escapeHtml(formatMoney(line.sold_for))}</b></span>` : ""}
              ${line.shipping_and_handling ? `<span><small>Shipping</small><b>${escapeHtml(formatMoney(line.shipping_and_handling))}</b></span>` : ""}
              ${line.total_price ? `<span><small>Line total</small><b>${escapeHtml(formatMoney(line.total_price))}</b></span>` : ""}
              ${line.net_payout ? `<span><small>Payout</small><b>${escapeHtml(formatMoney(line.net_payout))}</b></span>` : ""}
              ${line.fulfilled_quantity ? `<span><small>Fulfilled</small><b>${escapeHtml(`${line.fulfilled_quantity}${line.fulfilled_at ? ` on ${formatDate(line.fulfilled_at)}` : ""}`)}</b></span>` : ""}
              ${line.transaction_id ? `<span><small>Transaction</small><b>${escapeHtml(line.transaction_id)}</b></span>` : ""}
              ${line.custom_label ? `<span><small>Custom label</small><b>${escapeHtml(line.custom_label)}</b></span>` : ""}
            </div>
            ${line.notes ? `<small>${escapeHtml(line.notes)}</small>` : ""}
          </article>
        `;
      }).join("")}
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
  if (!rows.length) {
    return `
      <section class="team-task-context order-workflow-panel is-compact">
        <div class="team-task-context-head">
          <span class="eyebrow">Workflow</span>
          <strong>No subtasks required yet</strong>
        </div>
      </section>
    `;
  }
  return `
    <section class="team-task-context order-workflow-panel">
      <div class="team-task-context-head">
        <span class="eyebrow">Admin Workflow</span>
        <strong>${subtasks.length ? `${subtasks.filter((subtask) => ["completed_by_employee", "approved_by_admin"].includes(subtask.status)).length} of ${subtasks.length} subtasks complete` : "No subtasks required yet"}</strong>
      </div>
      <div class="order-workflow-list">
        ${rows.map((child) => {
          const events = state.eventsByTask.get(getUnifiedTaskKey(child)) || [];
          const childLate = isTaskLate(child);
          const childLateAge = getTaskLateAgeLabel(child);
          return `
            <article class="order-workflow-item ${childLate ? "is-overdue" : ""}">
              <div class="order-workflow-item-head">
                <div>
                  <strong>${escapeHtml(child.title || "Order workflow task")}</strong>
                  <p>${escapeHtml(child.latest_note || child.description || child.question || "No note yet.")}</p>
                </div>
                <span class="team-task-chip ${childLate ? "team-task-overdue-status-chip" : ""}">${escapeHtml(childLate ? "Overdue" : getTaskStatusLabel(child.status))}</span>
              </div>
              <div class="team-task-meta">
                <span class="team-task-source">${escapeHtml(child.sourceLabel)}</span>
                <span>Assigned: ${escapeHtml(getTaskAssigneeLabel(child))}</span>
                <span class="${childLate ? "team-task-overdue-inline" : ""}">${escapeHtml(childLate ? `Late ${childLateAge || ""}`.trim() : `Due ${getTaskDueLabel(child)}`)}${childLate ? ` - Due ${escapeHtml(getTaskDueLabel(child))}` : ""}</span>
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
      ${!canApprove && subtasks.length ? `<p class="team-task-photo-note">Shipping approval unlocks after every required subtask is completed.</p>` : ""}
    </section>
  `;
}

function renderOrderTaskContext(task = {}) {
  const lines = Array.isArray(task.lineDetails) ? task.lineDetails : [];
  const lineSummary = getPendingOrderLineSummary(task);
  return `
    ${lines.length ? `
      <details class="team-task-context order-task-context-details">
        <summary>
          <span>
            <span class="eyebrow">Inspect order lines</span>
            <strong>${escapeHtml(lineSummary || "Order line details")}</strong>
          </span>
          <span>Labels, video receipts, prices, and transactions</span>
        </summary>
        ${renderTaskLines(task)}
      </details>
    ` : ""}
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

function getEbayConversationTaskContext(task = {}) {
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  if (metadata.source !== "ebay_conversation_message") return null;
  const params = new URLSearchParams();
  if (metadata.conversation_id) params.set("ebayConversationDbId", metadata.conversation_id);
  if (metadata.message_id) params.set("ebayMessageDbId", metadata.message_id);
  if (metadata.ebay_conversation_id) params.set("ebayConversationId", metadata.ebay_conversation_id);
  if (metadata.buyer_username) params.set("ebayBuyer", metadata.buyer_username);
  return {
    conversationId: metadata.conversation_id || "",
    messageId: metadata.message_id || "",
    ebayConversationId: metadata.ebay_conversation_id || "",
    ebayMessageId: metadata.ebay_message_id || "",
    buyer: metadata.buyer_username || "",
    sender: metadata.sender_username || "",
    recipient: metadata.recipient_username || "",
    direction: metadata.message_direction || "",
    createdAt: metadata.message_created_at || "",
    subject: metadata.message_subject || "",
    preview: metadata.message_preview || "",
    title: metadata.conversation_title || "",
    taskTag: metadata.task_tag || "",
    refundAmount: metadata.refund_amount || "",
    href: params.toString() ? `email-triage.html?${params.toString()}` : metadata.conversation_link || "email-triage.html",
  };
}

function renderEbayConversationTeamTaskContext(task = {}) {
  const context = getEbayConversationTaskContext(task);
  if (!context) return "";
  const details = [
    context.direction ? ["Message", formatTaskTag(context.direction)] : null,
    context.sender ? ["From", context.sender] : null,
    context.recipient ? ["To", context.recipient] : null,
    context.createdAt ? ["Sent", formatDate(context.createdAt)] : null,
    context.ebayConversationId ? ["Conversation", context.ebayConversationId] : null,
  ].filter(Boolean);
  return `
    <section class="team-task-context ebay-message-task-context">
      <div class="team-task-context-head">
        <div>
          <span class="eyebrow">Customer Context</span>
          <strong>${escapeHtml(context.buyer || context.title || "Customer message")}</strong>
        </div>
        <a class="team-task-context-open-link" href="${escapeHtml(context.href)}">Open eBay Conversation</a>
      </div>
      <div class="team-task-ebay-snapshot">
        ${context.buyer ? `<span><small>Buyer</small><b>${escapeHtml(context.buyer)}</b></span>` : ""}
        ${context.taskTag ? `<span class="team-task-refund-fact"><small>Tag</small><b>${escapeHtml(formatTaskTag(context.taskTag))}</b></span>` : ""}
        ${context.refundAmount ? `<span class="team-task-refund-fact"><small>Refund amount</small><b>${escapeHtml(formatMoney(context.refundAmount) || context.refundAmount)}</b></span>` : ""}
        ${context.createdAt ? `<span><small>Customer wrote</small><b>${escapeHtml(formatDate(context.createdAt))}</b></span>` : ""}
      </div>
      ${context.subject ? `<p class="team-task-message-focus"><small>Subject</small><span>${escapeHtml(context.subject)}</span></p>` : ""}
      ${context.preview ? `<p class="team-task-message-focus is-source-message"><small>Source message</small><span>${escapeHtml(context.preview)}</span></p>` : ""}
      ${details.length ? `
        <details class="team-task-context-details">
          <summary>Conversation details</summary>
          <div class="team-task-facts">
            ${details.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join("")}
          </div>
        </details>
      ` : ""}
    </section>
  `;
}

function renderTaskContext(task = {}) {
  if (task.source === "order") return renderOrderTaskContext(task);
  if (task.source === "return") return renderReturnTaskContext(task);
  if (task.source === "team") return renderEbayConversationTeamTaskContext(task);
  return "";
}

function getTaskSourceLabel(task = {}) {
  if (task.sourceLabel) return task.sourceLabel;
  if (task.source === "order") return "Pending order";
  if (task.source === "return") return "Return";
  return "Team";
}

function getTaskCardPreview(task = {}, canceled = false) {
  return canceled
    ? task.metadata?.history_removed_note || task.latest_note || "Canceled by admin."
    : task.latest_note || task.description || task.question || "No note yet.";
}

function getTaskMoneyLabel(task = {}) {
  if (task.source === "team" && task.metadata?.refund_amount) {
    return formatMoney(task.metadata.refund_amount) || task.metadata.refund_amount;
  }
  if (task.source === "order") {
    const totals = getTaskLineMoneyTotals(Array.isArray(task.lineDetails) ? task.lineDetails : [], task.order || {});
    return formatMoney(totals.total);
  }
  return "";
}

function getTaskMoneyValue(task = {}) {
  if (task.source === "order") {
    const totals = getTaskLineMoneyTotals(Array.isArray(task.lineDetails) ? task.lineDetails : [], task.order || {});
    return Number.isFinite(totals.total) && totals.total > 0 ? totals.total : Number.NaN;
  }
  const metadata = task.metadata && typeof task.metadata === "object" ? task.metadata : {};
  const value = Number(metadata.refund_amount || metadata.order_value || metadata.orderValue || 0);
  return Number.isFinite(value) && value > 0 ? value : Number.NaN;
}

function getTaskOriginalInstruction(task = {}) {
  return task.description || task.question || task.metadata?.task_description || task.metadata?.task_note || "";
}

function getLatestTaskEvent(events = []) {
  return [...events].reverse().find((event) => event?.notes || event?.new_status || event?.action) || null;
}

function getCurrentTaskInstruction(task = {}, events = []) {
  const latest = getLatestTaskEvent(events);
  return latest?.notes || task.latest_note || getTaskOriginalInstruction(task) || task.title || "No instruction entered yet.";
}

function getTaskNextStepLabel(task = {}) {
  const status = String(task.status || "").toLowerCase();
  const labels = {
    open: "Review the assignment and post the next update.",
    assigned: "Work the assignment, then update or complete it.",
    in_progress: "Continue the work and add progress when something changes.",
    deferred: "Wait for the requested condition, then update before closing.",
    blocked: "Needs help before this can move forward.",
    waiting_on_admin: "Admin decision or approval is needed.",
    waiting_on_worker: "Assigned worker needs to respond or complete the next step.",
    resolved: "Completed. Keep the trail for reference.",
    cancelled: "Canceled. No active work needed.",
  };
  return labels[status] || "Use the current instruction, then save an update or mark completed.";
}

function renderPendingOrderTaskBrief(task = {}, events = [], canceled = false) {
  const originalInstruction = getTaskOriginalInstruction(task);
  const latestEvent = getLatestTaskEvent(events);
  const latestUpdate = String(latestEvent?.notes || "").trim();
  const currentInstruction = originalInstruction || task.latest_note || "No assignment note entered.";
  const hasLatestUpdate = latestUpdate && latestUpdate !== currentInstruction;
  const hasDifferentOriginal = originalInstruction && originalInstruction !== currentInstruction;
  const customerName = getPendingOrderCustomerName(task);
  const moneyLabel = getTaskMoneyLabel(task);
  const order = task.order || {};
  const lineSummary = getPendingOrderLineSummary(task);
  const late = isTaskLate(task, { canceled });
  const lateAge = getTaskLateAgeLabel(task);
  const dueLabel = getTaskDueLabel(task);
  const orderNumber = task.order_number || order.order_number || "";
  const placedLabel = order.sale_date ? formatDate(order.sale_date) : "Not loaded";
  const shipByValue = task.ship_by_date || order.ship_by_date || task.due_at;
  const shipByLabel = shipByValue ? formatDate(shipByValue) : "Not set";
  const assignedByLabel = getTaskAssignerLabel(task);
  const advancedFacts = [
    ["Source", getTaskSourceLabel(task)],
    ["Status", canceled ? "Canceled" : getTaskStatusLabel(task.status)],
    ["Priority", formatTaskTag(task.priority || "normal")],
    ["Category", formatTaskTag(task.task_type || "general")],
    lineSummary ? ["Lines / Qty", lineSummary] : null,
    task.due_at ? ["Task due", formatDate(task.due_at)] : null,
    task.ship_by_date || order.ship_by_date ? ["Ship by", formatDate(task.ship_by_date || order.ship_by_date)] : null,
    order.sale_date ? ["Placed", formatDate(order.sale_date)] : null,
    task.assigned_to_email ? ["Assigned to", task.assigned_to_email] : null,
    task.created_by_email ? ["Created by", task.created_by_email] : null,
    latestEvent ? ["Last update", `${formatTaskTag(latestEvent.action || "update")} - ${formatDate(latestEvent.created_at)}`] : null,
  ].filter(Boolean);

  return `
    <section class="team-task-brief team-task-order-brief is-pending-order-task ${late ? "is-overdue" : ""}">
      ${late ? `
        <p class="team-task-overdue-alert">
          <strong>Order deadline is late</strong>
          <span>${escapeHtml(`Due ${dueLabel}${lateAge ? ` - ${lateAge}` : ""}`)}</span>
        </p>
      ` : ""}
      <div class="team-task-order-work-card">
        <div class="team-task-order-work-main">
          <div class="team-task-order-work-toolbar">
            <div class="team-task-order-inline-meta">
              ${renderTaskOrderNumberAction(orderNumber)}
              ${customerName ? `<span><small>Customer</small><b>${escapeHtml(customerName)}</b></span>` : ""}
              ${task.buyer_username ? `<span><small>Buyer</small><b>${escapeHtml(task.buyer_username)}</b></span>` : ""}
              <span><small>Placed</small><b>${escapeHtml(placedLabel)}</b></span>
              <span class="${late ? "is-overdue-fact" : ""}"><small>${escapeHtml(late ? "Late due" : "Due")}</small><b>${escapeHtml(shipByLabel)}</b></span>
              <span><small>Assigned by</small><b>${escapeHtml(assignedByLabel)}</b></span>
              ${moneyLabel ? `<span><small>Amount</small><b>${escapeHtml(moneyLabel)}</b></span>` : ""}
            </div>
            ${renderPendingOrderCompactStatus(task)}
          </div>
          <article class="team-task-instruction is-current team-task-order-instruction">
            <small>What needs to be done</small>
            <p>${escapeHtml(currentInstruction)}</p>
          </article>
          ${renderPendingOrderApprovalLines(task, events)}
          ${hasLatestUpdate ? `
            <p class="team-task-latest-update"><strong>Latest update</strong><span>${escapeHtml(latestUpdate)}</span></p>
          ` : ""}
        </div>
      </div>
      <details class="team-task-context-details team-task-brief-details team-task-order-audit-details">
        <summary>Extra eBay status, photos, and audit details</summary>
        ${renderPendingOrderStatusSnapshot(task)}
        ${renderPendingOrderEvidencePanel(task, events)}
        <p class="team-task-next-step"><strong>Next step</strong><span>${escapeHtml(getTaskNextStepLabel(task))}</span></p>
        ${hasDifferentOriginal ? `
          <article class="team-task-instruction">
            <small>Original assignment</small>
            <p>${escapeHtml(originalInstruction)}</p>
          </article>
        ` : ""}
        ${advancedFacts.length ? `
          <div class="team-task-facts">
            ${advancedFacts.map(([label, value]) => `<span><small>${escapeHtml(label)}</small><b>${escapeHtml(value)}</b></span>`).join("")}
          </div>
        ` : ""}
      </details>
    </section>
  `;
}

function renderTeamTaskBrief(task = {}, events = [], canceled = false) {
  if (task.source === "order") return renderPendingOrderTaskBrief(task, events, canceled);

  const originalInstruction = getTaskOriginalInstruction(task);
  const currentInstruction = getCurrentTaskInstruction(task, events);
  const latestEvent = getLatestTaskEvent(events);
  const hasDifferentOriginal = originalInstruction && originalInstruction !== currentInstruction;
  const sourceLabel = getTaskSourceLabel(task);
  const moneyLabel = getTaskMoneyLabel(task);
  return `
    <section class="team-task-brief ${task.source === "team" ? "is-ebay-message-task" : ""} ${task.source === "order" ? "is-pending-order-task" : ""}">
      <div class="team-task-brief-head">
        <div>
          <span class="eyebrow">Task Brief</span>
          <strong>${escapeHtml(task.title || "Team task")}</strong>
        </div>
        <span class="team-task-chip team-task-status-chip">${escapeHtml(canceled ? "Canceled" : getTaskStatusLabel(task.status))}</span>
      </div>
      <div class="team-task-instruction-grid">
        <article class="team-task-instruction is-current">
          <small>Current instruction</small>
          <p>${escapeHtml(currentInstruction)}</p>
        </article>
        ${hasDifferentOriginal ? `
          <article class="team-task-instruction">
            <small>Original assignment</small>
            <p>${escapeHtml(originalInstruction)}</p>
          </article>
        ` : ""}
      </div>
      <div class="team-task-brief-facts">
        <span><small>Source</small><b>${escapeHtml(sourceLabel)}</b></span>
        <span><small>Assigned to</small><b>${escapeHtml(getTaskAssigneeLabel(task))}</b></span>
        <span><small>Due</small><b>${escapeHtml(formatDate(task.due_at))}</b></span>
        <span><small>Priority</small><b>${escapeHtml(formatTaskTag(task.priority || "normal"))}</b></span>
        <span><small>Category</small><b>${escapeHtml(formatTaskTag(task.task_type || "general"))}</b></span>
        ${task.order_number ? `<span><small>Order</small><b>${escapeHtml(task.order_number)}</b></span>` : ""}
        ${task.buyer_username ? `<span><small>Buyer</small><b>${escapeHtml(task.buyer_username)}</b></span>` : ""}
        ${moneyLabel ? `<span><small>Value</small><b>${escapeHtml(moneyLabel)}</b></span>` : ""}
        ${task.created_by_email ? `<span><small>Created by</small><b>${escapeHtml(task.created_by_email)}</b></span>` : ""}
        ${latestEvent ? `<span><small>Last update</small><b>${escapeHtml(`${formatTaskTag(latestEvent.action || "update")} - ${formatDate(latestEvent.created_at)}`)}</b></span>` : ""}
      </div>
      <p class="team-task-next-step"><strong>Next step</strong><span>${escapeHtml(getTaskNextStepLabel(task))}</span></p>
    </section>
  `;
}

function renderTaskUpdateTrail(task = {}, events = [], options = {}) {
  const orderedEvents = [...events].reverse();
  const latest = orderedEvents[0];
  const trailBody = `
    <div class="team-task-events">
      ${orderedEvents.length ? orderedEvents.map(renderTaskEvent).join("") : `<div class="empty-state">No task trail yet.</div>`}
    </div>
  `;
  if (options.collapsed) {
    return `
      <details class="team-task-update-trail is-collapsible">
        <summary>
          <span>
            <span class="eyebrow">Updates & Audit Trail</span>
            <strong>${events.length ? `${events.length} saved update${events.length === 1 ? "" : "s"}` : "No updates yet"}</strong>
          </span>
          <em>${escapeHtml(latest ? `${formatTaskTag(latest.action || "update")} - ${formatDate(latest.created_at)}` : getTaskStatusLabel(task.status))}</em>
        </summary>
        ${trailBody}
      </details>
    `;
  }
  return `
    <section class="team-task-update-trail">
      <div class="team-task-update-trail-head">
        <div>
          <span class="eyebrow">Updates & Audit Trail</span>
          <strong>${events.length ? `${events.length} saved update${events.length === 1 ? "" : "s"}` : "No updates yet"}</strong>
        </div>
        <span>${escapeHtml(getTaskStatusLabel(task.status))}</span>
      </div>
      ${trailBody}
    </section>
  `;
}

function renderTaskCard(task = {}, options = {}) {
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  const canceled = Boolean(options.canceled);
  const late = isTaskLate(task, { canceled });
  const urgent = late
    || ["urgent", "high"].includes(String(task.priority || "").toLowerCase())
    || ["blocked", "deferred"].includes(String(task.status || "").toLowerCase());
  const resolved = HISTORY_TASK_STATUSES.includes(String(task.status || "").toLowerCase());
  const taskKey = getUnifiedTaskKey(task);
  const expanded = state.expandedTaskKeys.has(taskKey);
  const readInfo = getTaskReadInfo(task);
  const detailsId = `task-details-${getSafeDomId(taskKey)}`;
  const statusLabel = canceled ? "Canceled" : getTaskStatusLabel(task.status);
  const sourceLabel = getTaskSourceLabel(task);
  const assigneeLabel = getTaskAssigneeLabel(task);
  const moneyLabel = getTaskMoneyLabel(task);
  const eventCountLabel = `${events.length} update${events.length === 1 ? "" : "s"}`;
  const lateAge = getTaskLateAgeLabel(task);
  const dueLabel = getTaskDueLabel(task);
  const preview = getTaskCardPreview(task, canceled);
  const contextLine = [
    task.buyer_username ? `Buyer ${task.buyer_username}` : "",
    task.order_number ? `Order ${task.order_number}` : "",
    task.source === "team" && task.metadata?.task_tag ? formatTaskTag(task.metadata.task_tag) : "",
  ].filter(Boolean).join(" - ");
  const orderMiniStatus = getTaskOrderMiniStatus(task);
  const readActionHtml = readInfo.status === "read" ? `
              <span
                role="button"
                tabindex="0"
                class="team-task-mark-read-chip is-unread-action"
                data-team-task-mark-unread="${escapeHtml(taskKey)}"
                title="Mark this task unread"
              >Mark unread</span>
            ` : `
              <span
                role="button"
                tabindex="0"
                class="team-task-mark-read-chip"
                data-team-task-mark-read="${escapeHtml(taskKey)}"
                title="Mark this task read"
              >Mark read</span>
            `;
  const actionHtml = canceled ? `
    <div class="team-task-actions">
      <button type="button" class="secondary-btn" data-task-history-action="reopen" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Reopen Task</button>
    </div>
  ` : renderTaskActions(task, resolved);
  const detailsHtml = task.source === "order"
    ? `
        ${renderTeamTaskBrief(task, events, canceled)}
        ${renderAdminReassignRequestNotice(task)}
        ${actionHtml}
        ${renderTaskContext(task)}
        ${renderTaskUpdateTrail(task, events, { collapsed: true })}
      `
    : `
        ${renderTeamTaskBrief(task, events, canceled)}
        ${renderTaskContext(task)}
        ${renderAdminReassignRequestNotice(task)}
        ${actionHtml}
        ${renderTaskUpdateTrail(task, events)}
      `;

  return `
    <article class="team-task-card ${urgent ? "is-urgent" : ""} ${late ? "is-overdue" : ""} ${resolved ? "is-resolved" : ""} ${expanded ? "is-expanded" : "is-collapsed"} ${escapeHtml(readInfo.className)}" data-team-task-card="${escapeHtml(task.id)}" data-team-task-card-key="${escapeHtml(taskKey)}">
      <button type="button" class="team-task-card-summary" data-team-task-toggle="${escapeHtml(taskKey)}" aria-expanded="${expanded ? "true" : "false"}" aria-controls="${escapeHtml(detailsId)}">
        <span class="team-task-source-dot">${escapeHtml(sourceLabel.slice(0, 2).toUpperCase())}</span>
        <span class="team-task-summary-main">
          <span class="team-task-summary-title-row">
            <strong>${escapeHtml(task.title || "Team task")}</strong>
            <span class="team-task-chip team-task-status-chip">${escapeHtml(statusLabel)}</span>
            <span class="team-task-read-chip">${escapeHtml(readInfo.label)}</span>
            ${readActionHtml}
          </span>
          <span class="team-task-summary-preview">${escapeHtml(preview)}</span>
          ${orderMiniStatus || contextLine ? `<span class="team-task-summary-context">${escapeHtml(orderMiniStatus || contextLine)}</span>` : ""}
        </span>
        <span class="team-task-summary-facts">
          <span>${escapeHtml(sourceLabel)}</span>
          ${renderTaskOrderSummaryStatusChip(task)}
          <span>${escapeHtml(formatTaskTag(task.task_type || "general"))}</span>
          <span class="team-task-priority-chip">${escapeHtml(formatTaskTag(task.priority || "normal"))}</span>
          ${moneyLabel ? `<span>${escapeHtml(moneyLabel)}</span>` : ""}
          <span class="${late ? "team-task-overdue-pill" : ""}">${escapeHtml(late ? `Overdue ${lateAge || ""}`.trim() : `Due ${dueLabel}`)}${late ? ` - Due ${escapeHtml(dueLabel)}` : ""}</span>
          <span>${escapeHtml(assigneeLabel)}</span>
          <span>${escapeHtml(eventCountLabel)}</span>
          ${canceled ? `<span>Removed ${escapeHtml(formatDate(task.metadata?.history_removed_at))}</span>` : ""}
        </span>
        <span class="team-task-expand-pill">
          ${expanded ? "Close" : "Open"}
        </span>
      </button>
      <div id="${escapeHtml(detailsId)}" class="team-task-card-details ${expanded ? "" : "hidden"}">
        ${detailsHtml}
      </div>
    </article>
  `;
}

function attachTaskCardInteractions(root = document) {
  root.querySelectorAll("[data-team-task-toggle]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.teamTaskToggle || "";
      if (!key) return;
      const opening = !state.expandedTaskKeys.has(key);
      if (!opening) {
        state.expandedTaskKeys.delete(key);
      } else {
        state.expandedTaskKeys.add(key);
      }
      renderTasks();
      requestAnimationFrame(() => {
        document.querySelector(`[data-team-task-card-key="${CSS.escape(key)}"]`)?.scrollIntoView({ block: "nearest" });
      });
    });
  });
  root.querySelectorAll("[data-team-task-mark-read]").forEach((button) => {
    const handleMarkRead = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = button.dataset.teamTaskMarkRead || "";
      const task = getTaskByUnifiedKey(key);
      if (!task) return;
      button.textContent = "Saving...";
      button.setAttribute("aria-disabled", "true");
      try {
        await markTaskSeen(task);
      } finally {
        renderTasks();
      }
    };
    button.addEventListener("click", handleMarkRead);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      handleMarkRead(event);
    });
  });
  root.querySelectorAll("[data-team-task-mark-unread]").forEach((button) => {
    const handleMarkUnread = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      const key = button.dataset.teamTaskMarkUnread || "";
      const task = getTaskByUnifiedKey(key);
      if (!task) return;
      button.textContent = "Saving...";
      button.setAttribute("aria-disabled", "true");
      try {
        await markTaskUnread(task);
      } finally {
        renderTasks();
      }
    };
    button.addEventListener("click", handleMarkUnread);
    button.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      handleMarkUnread(event);
    });
  });
}

function openTaskEvidenceFromButton(button) {
  if (!button) return;
  const mediaType = button.dataset.mediaType || getTaskAttachmentMediaType({
    mime_type: button.dataset.mimeType,
    path: button.dataset.path,
    label: button.dataset.label,
  });
  const label = button.dataset.label || (mediaType === "video" ? "Task evidence video" : "Task evidence photo");
  if (button.dataset.url) {
    openTaskPhotoViewer({
      url: button.dataset.url,
      label,
      bucket: button.dataset.bucket || TEAM_TASK_BUCKET,
      path: button.dataset.path || "",
      mediaType,
      trigger: button,
    });
    return;
  }
  openTaskPhoto(button.dataset.bucket, button.dataset.path, { mediaType, label, trigger: button });
}

function renderTasks() {
  const list = $("team-task-list");
  const count = $("team-task-count");
  const title = $("team-task-list-title");
  if (!list) return;
  renderRemovedHistoryTasks();

  if (title) {
    title.textContent = isViewingWorkerTasks()
      ? `Viewing ${getViewedWorkerLabel()} - ${isTaskHistoryView() ? "Task History" : state.taskOwnerFilter === "acceptance" ? "Needs Acceptance" : state.taskOwnerFilter === "responded" ? "Responded / Awaiting Reply" : "Active Tasks"}`
      : isTaskHistoryView()
        ? (isCanceledTaskScope() ? "Canceled Tasks" : isTeamWideTaskScope() ? "Everyone's Task History" : "My Task History")
        : state.taskOwnerFilter === "acceptance"
          ? "Tasks Needing Acceptance"
          : state.taskOwnerFilter === "responded"
            ? "Responded / Awaiting Reply"
          : (isTeamWideTaskScope() ? "Everyone's Active Tasks" : "My Assigned Tasks");
  }
  if (count) count.textContent = `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;

  if (!state.tasks.length) {
    renderTaskFilterChrome([]);
    list.innerHTML = `<div class="empty-state">${
      isCanceledTaskScope()
        ? "No canceled tasks."
        : isTaskHistoryView()
          ? "No completed tasks in history yet."
          : "No active tasks right now."
    }</div>`;
    return;
  }

  const visibleTasks = getVisibleTasksForCurrentFilters(state.tasks);
  renderTaskFilterChrome(state.tasks);
  if (count) {
    count.textContent = (
      state.taskReadFilter === "all"
      && state.taskOwnerFilter === "all"
      && state.taskSourceFilter === "all"
    )
      ? `${visibleTasks.length} active task${visibleTasks.length === 1 ? "" : "s"}`
      : `${visibleTasks.length} of ${state.tasks.length} tasks`;
  }

  if (!visibleTasks.length) {
    list.innerHTML = `<div class="empty-state">No tasks match the selected filters.</div>`;
    return;
  }

  list.innerHTML = visibleTasks.map((task) => renderTaskCard(task, { canceled: isCanceledTaskScope() })).join("");

  attachTaskCardInteractions(list);
  setupInlineLineReviewControls(list);
  list.querySelectorAll("[data-team-task-progress]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskProgress, progress: true }));
  });
  list.querySelectorAll("[data-team-task-resolve]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskResolve, resolve: true }));
  });
  list.querySelectorAll("[data-team-task-accept]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskAccept, accept: true }));
  });
  list.querySelectorAll("[data-team-task-sendback]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskSendback, sendBack: true }));
  });
  list.querySelectorAll("[data-team-task-reassign-request]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskReassignRequest, reassignRequest: true }));
  });
  list.querySelectorAll("[data-team-task-photo]").forEach((button) => {
    button.addEventListener("click", () => openTaskEvidenceFromButton(button));
  });
  list.querySelectorAll("[data-task-copy-order-number]").forEach((button) => {
    button.addEventListener("click", () => copyTextToClipboard(button.dataset.taskCopyOrderNumber, "Order number"));
  });
  list.querySelectorAll("[data-task-order-number-action]").forEach((button) => {
    button.addEventListener("click", handleTaskOrderNumberActionClick);
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

  const tasks = canUseAdminTaskControls() && isTaskHistoryView() ? state.removedTasks : [];
  section.classList.toggle("hidden", !tasks.length);
  if (count) count.textContent = `${tasks.length} task${tasks.length === 1 ? "" : "s"}`;
  if (!tasks.length) {
    list.innerHTML = "";
    return;
  }

  list.innerHTML = tasks.map((task) => renderTaskCard(task, { canceled: true })).join("");

  attachTaskCardInteractions(list);
  setupInlineLineReviewControls(list);
  list.querySelectorAll("[data-team-task-photo]").forEach((button) => {
    button.addEventListener("click", () => openTaskEvidenceFromButton(button));
  });
  list.querySelectorAll("[data-task-copy-order-number]").forEach((button) => {
    button.addEventListener("click", () => copyTextToClipboard(button.dataset.taskCopyOrderNumber, "Order number"));
  });
  list.querySelectorAll("[data-task-order-number-action]").forEach((button) => {
    button.addEventListener("click", handleTaskOrderNumberActionClick);
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
  const actionAttrs = getViewAsActionAttrs();
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

  if (isTaskPendingAcceptance(task)) {
    const reviewer = canReviewTaskAcceptance(task);
    return `
      <div class="team-task-actions">
        ${reviewer ? `<button type="button" class="secondary-btn" data-team-task-sendback="${escapeHtml(task.id)}"${actionAttrs}>Send Back</button>` : `<span class="team-task-waiting-pill">Waiting for acceptance</span>`}
        ${reviewer ? `<button type="button" class="primary-btn" data-team-task-accept="${escapeHtml(task.id)}"${actionAttrs}>Accept / Close</button>` : ""}
      </div>
      ${renderAdminAssignmentActions(task)}
      ${renderAdminHistoryActions(task)}
    `;
  }
  const workerOwnsTask = isTaskAssignedToCurrentUser(task);
  const workerCanUpdateTask = workerOwnsTask || isTaskCreatedByCurrentUser(task);
  const canUpdateTask = workerCanUpdateTask || canUseAdminTaskControls();

  return `
    <div class="team-task-actions">
      ${!resolved && canUpdateTask ? `<button type="button" class="secondary-btn" data-team-task-progress="${escapeHtml(task.id)}"${actionAttrs}>Progress / Delay</button>` : ""}
      ${!resolved && workerOwnsTask ? `<button type="button" class="secondary-btn" data-team-task-reassign-request="${escapeHtml(task.id)}"${actionAttrs}>Request Reassign</button>` : ""}
      ${!resolved && canUpdateTask ? `<button type="button" class="primary-btn" data-team-task-resolve="${escapeHtml(task.id)}"${actionAttrs}>Mark Completed</button>` : ""}
    </div>
    ${renderAdminAssignmentActions(task)}
    ${renderAdminHistoryActions(task)}
  `;
}

function renderAdminHistoryActions(task = {}) {
  if (!canUseAdminTaskControls() || !isTaskHistoryView()) return "";
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

function isShippingFulfillmentTask(task = {}) {
  return task.task_type === ORDER_SHIPPING_TYPE || task.task_type === ORDER_PACKAGING_TYPE;
}

function isShippingTaskReadyForFulfillment(task = {}) {
  return isShippingFulfillmentTask(task)
    && !["shipped_completed", "closed", "cancelled"].includes(String(task.status || ""))
    && Boolean(task.metadata?.packaging_ready_at || task.task_type === ORDER_PACKAGING_TYPE);
}

function renderOrderTaskActions(task = {}, resolved = false, options = {}) {
  const compact = Boolean(options.compact);
  const isParent = isOrderParentTask(task);
  const isSubtask = task.task_type === ORDER_SUBTASK_TYPE;
  const isShipping = task.task_type === ORDER_SHIPPING_TYPE;
  const isPackaging = task.task_type === ORDER_PACKAGING_TYPE;
  const isApprovalParent = isOrderPendingApprovalTask(task);
  const actionAttrs = getViewAsActionAttrs();
  const assigneeCanUpdate = isTaskAssignedToCurrentUser(task) || canUseAdminTaskControls();
  const workerOwnsTask = isTaskAssignedToCurrentUser(task);
  const canApproveShipping = isParent && canUseAdminTaskControls() && canOrderTaskApproveForShipping(task)
    && !["assigned_for_shipping", "shipped_completed", "closed", "cancelled"].includes(task.status);

  if (resolved && !isParent) return renderAdminHistoryActions(task);

  if (isApprovalParent && !compact && !isTaskHistoryView()) {
    const primaryButtons = [];
    const moreButtons = [];
    const parentCanReceiveWorkerUpdate = workerOwnsTask
      && !["completed_by_employee", "approved_for_shipping", "assigned_for_shipping", "shipped_completed", "closed", "cancelled"].includes(task.status);

    if (task.actionHref) {
      primaryButtons.push(`<a class="secondary-btn" href="${escapeHtml(task.actionHref)}">Review order</a>`);
    }

    if (parentCanReceiveWorkerUpdate) {
      primaryButtons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="task-progress" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Add Update</button>`);
      moreButtons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="reassign-request" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Request Reassign</button>`);
    }

    if (canUseAdminTaskControls()) {
      primaryButtons.push(`<button type="button" class="secondary-btn danger-btn" data-order-workflow-action="send-back-order" data-task-id="${escapeHtml(task.id)}">Send Back</button>`);
      primaryButtons.push(`<button type="button" class="primary-btn" data-order-workflow-action="assign-shipping" data-task-id="${escapeHtml(task.id)}" ${canApproveShipping ? "" : "disabled"}>Approve / Assign Shipping</button>`);
      moreButtons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="add-subtask" data-task-id="${escapeHtml(task.id)}">Add Subtask</button>`);
      moreButtons.push(`<button type="button" class="secondary-btn danger-btn" data-order-workflow-action="cancel-approval" data-task-id="${escapeHtml(task.id)}">Cancel Approval</button>`);
      moreButtons.push(...getAdminAssignmentActionButtons(task));
    }

    const actionHtml = renderTaskActionGroup(primaryButtons, moreButtons, {
      className: "team-task-approval-actions",
      moreLabel: "More",
    });
    return `${actionHtml}${renderAdminHistoryActions(task)}`;
  }

  const buttons = [];
  if (!compact && task.actionHref) {
    const orderLinkLabel = isShippingTaskReadyForFulfillment(task) ? "Fulfill Shipment" : "Open Pending Order";
    buttons.push(`<a class="secondary-btn" href="${escapeHtml(task.actionHref)}">${escapeHtml(orderLinkLabel)}</a>`);
  }

  if (isParent && canUseAdminTaskControls() && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="add-subtask" data-task-id="${escapeHtml(task.id)}">Add Subtask</button>`);
    if (isApprovalParent) {
      buttons.push(`<button type="button" class="secondary-btn danger-btn" data-order-workflow-action="send-back-order" data-task-id="${escapeHtml(task.id)}">Send Back</button>`);
      buttons.push(`<button type="button" class="secondary-btn danger-btn" data-order-workflow-action="cancel-approval" data-task-id="${escapeHtml(task.id)}">Cancel Approval</button>`);
    }
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="assign-shipping" data-task-id="${escapeHtml(task.id)}" ${canApproveShipping ? "" : "disabled"}>Approve / Assign Shipping</button>`);
  }

  if (isParent && workerOwnsTask && !["completed_by_employee", "approved_for_shipping", "assigned_for_shipping", "shipped_completed", "closed", "cancelled"].includes(task.status) && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="task-progress" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Progress Update</button>`);
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="reassign-request" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Request Reassign</button>`);
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="task-complete" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Complete Task</button>`);
  }

  if (isSubtask && assigneeCanUpdate && !["completed_by_employee", "approved_by_admin"].includes(task.status) && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="subtask-progress" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Progress Update</button>`);
    if (workerOwnsTask) {
      buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="reassign-request" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Request Reassign</button>`);
    }
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="subtask-complete" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Mark Completed</button>`);
  }

  if (isSubtask && canUseAdminTaskControls() && task.status === "completed_by_employee" && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="approve-subtask" data-task-id="${escapeHtml(task.id)}">Approve Subtask</button>`);
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="send-back-subtask" data-task-id="${escapeHtml(task.id)}">Send Back</button>`);
  }

  if ((isShipping || isPackaging) && assigneeCanUpdate && !["shipped_completed", "closed"].includes(task.status) && !isTaskHistoryView()) {
    buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="shipping-progress" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Mark In Progress</button>`);
    if (isShipping && workerOwnsTask) {
      buttons.push(`<button type="button" class="secondary-btn" data-order-workflow-action="shipping-ready-packaging" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Mark Ready for Packaging</button>`);
    }
    buttons.push(`<button type="button" class="primary-btn" data-order-workflow-action="shipping-complete" data-task-id="${escapeHtml(task.id)}"${actionAttrs}>Mark Shipped</button>`);
  }

  if (!buttons.length) return `${renderAdminAssignmentActions(task)}${renderAdminHistoryActions(task)}`;
  return `<div class="team-task-actions">${buttons.join("")}</div>${renderAdminAssignmentActions(task)}${renderAdminHistoryActions(task)}`;
}

function renderTaskActionGroup(primaryButtons = [], overflowButtons = [], options = {}) {
  const primary = primaryButtons.filter(Boolean);
  const overflow = overflowButtons.filter(Boolean);
  if (!primary.length && !overflow.length) return "";
  const className = options.className ? ` ${options.className}` : "";
  const moreLabel = options.moreLabel || "More";
  return `
    <div class="team-task-actions${className}">
      ${primary.join("")}
      ${overflow.length ? `
        <details class="team-task-action-menu">
          <summary>${escapeHtml(moreLabel)}</summary>
          <div class="team-task-action-menu-body">
            ${overflow.join("")}
          </div>
        </details>
      ` : ""}
    </div>
  `;
}

function renderTaskEventLineReviews(event = {}) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const reviews = getLineReviewArrayFromPayload(payload);
  if (!reviews.length) return "";
  const summary = payload.line_review_summary || payload.lineReviewSummary || {};
  const approvedCount = Number(summary.approved_count ?? summary.approvedCount ?? 0);
  const needsWorkCount = Number(summary.needs_work_count ?? summary.needsWorkCount ?? 0);
  const totalCount = Number(summary.total_count ?? summary.totalCount ?? reviews.length);
  return `
    <div class="team-task-event-line-reviews">
      <div class="team-task-event-line-reviews-head">
        <strong>Item decisions</strong>
        <span>${escapeHtml(`${approvedCount} approved / ${needsWorkCount} needs work / ${totalCount} total`)}</span>
      </div>
      <div class="team-task-event-line-review-list">
        ${reviews.map((review) => {
          const decision = normalizeLineReviewDecision(review.decision || review.status || review.result);
          const title = review.item_number
            ? `${review.item_number} - ${review.item_title || "Untitled item"}`
            : review.item_title || "Untitled item";
          const meta = [
            review.quantity ? `Qty ${review.quantity}` : "",
            review.line_total ? formatMoney(review.line_total) : "",
          ].filter(Boolean).join(" / ");
          return `
            <article class="team-task-event-line-review ${decision === "approved" ? "is-approved" : "needs-work"}">
              <div>
                <strong>${escapeHtml(title)}</strong>
                ${meta ? `<span>${escapeHtml(meta)}</span>` : ""}
              </div>
              <b>${escapeHtml(decision === "approved" ? "Approved" : "Needs work")}</b>
              ${review.note ? `<p>${escapeHtml(review.note)}</p>` : ""}
            </article>
          `;
        }).join("")}
      </div>
    </div>
  `;
}

function renderTaskEvent(event = {}) {
  const photos = Array.isArray(event.photo_attachments) ? event.photo_attachments : [];
  const actionLabel = formatTaskTag(event.action || "commented") || "Commented";
  const statusLabel = getTaskStatusLabel(event.new_status || event.old_status || "");
  const actorLabel = event.signed_by_email || "logged-in user";
  const lineReviewHtml = renderTaskEventLineReviews(event);
  const photoHtml = photos.length
    ? `<div class="team-task-event-photos">${photos.map((photo, index) => {
        const mediaType = getTaskAttachmentMediaType(photo);
        const label = photo.label || `${mediaType === "video" ? "Video" : "Photo"} ${index + 1}`;
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
          data-media-type="${escapeHtml(mediaType)}"
          aria-label="Open ${escapeHtml(label)}"
        >
          ${renderTaskEvidencePreview(photo, url, label)}
          <small>${escapeHtml(label)}</small>
        </button>
      `;
      }).join("")}</div>`
    : "";

  return `
    <article class="team-task-event">
      <div class="team-task-event-head">
        <div>
          <small>${escapeHtml(actionLabel)}</small>
          <strong>${escapeHtml(statusLabel || "Task update")}</strong>
        </div>
        <span>${escapeHtml(formatDate(event.created_at))}</span>
      </div>
      ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
      ${lineReviewHtml}
      <div class="team-task-event-signature">
        <span>Signed by ${escapeHtml(actorLabel)}</span>
        ${event.old_status && event.new_status && event.old_status !== event.new_status ? `<span>${escapeHtml(getTaskStatusLabel(event.old_status))} to ${escapeHtml(getTaskStatusLabel(event.new_status))}</span>` : ""}
      </div>
      ${photoHtml}
    </article>
  `;
}

function applyTaskPhotoViewerTransform() {
  const image = $("team-task-photo-viewer-image");
  if (!image || image.classList.contains("hidden")) return;
  image.style.transform = `translate(${state.photoViewerOffsetX}px, ${state.photoViewerOffsetY}px) scale(${state.photoViewerZoom})`;
  image.style.cursor = state.photoViewerZoom > 1 ? state.photoViewerDragging ? "grabbing" : "grab" : "zoom-in";
}

function resetTaskPhotoViewerTransform() {
  state.photoViewerZoom = 1;
  state.photoViewerOffsetX = 0;
  state.photoViewerOffsetY = 0;
  state.photoViewerDragging = false;
  state.photoViewerDragMoved = false;
  state.photoViewerDragStart = null;
  applyTaskPhotoViewerTransform();
}

function zoomTaskPhotoViewer(delta = 0) {
  state.photoViewerZoom = Math.min(4, Math.max(0.5, Number((state.photoViewerZoom + delta).toFixed(2))));
  if (state.photoViewerZoom <= 1) {
    state.photoViewerOffsetX = 0;
    state.photoViewerOffsetY = 0;
  }
  applyTaskPhotoViewerTransform();
}

function openTaskPhotoViewer({ url = "", label = "", bucket = "", path = "", trigger = null, mediaType = "image" } = {}) {
  const modal = $("team-task-photo-viewer-modal");
  const image = $("team-task-photo-viewer-image");
  const video = $("team-task-photo-viewer-video");
  const title = $("team-task-photo-viewer-title");
  const caption = $("team-task-photo-viewer-caption");
  if (!modal || !image) return false;

  state.photoViewerReturnFocus = trigger || document.activeElement;
  const isVideo = mediaType === "video" || isTaskVideoAttachment({ media_type: mediaType, path, label });
  if (isVideo && video) {
    image.classList.add("hidden");
    image.removeAttribute("src");
    video.classList.remove("hidden");
    video.src = url;
    video.setAttribute("aria-label", label || "Task evidence video");
  } else {
    video?.classList.add("hidden");
    if (video) {
      video.pause?.();
      video.removeAttribute("src");
      video.load?.();
    }
    image.classList.remove("hidden");
    image.src = url;
    image.alt = label || "Task evidence photo";
  }
  resetTaskPhotoViewerTransform();
  $("team-task-photo-viewer-tools")?.classList.toggle("hidden", isVideo);
  if (title) title.textContent = label || (isVideo ? "Task evidence video" : "Task evidence photo");
  if (caption) caption.textContent = [bucket, path].filter(Boolean).join(" / ");
  modal.classList.remove("hidden");
  document.body.classList.add("modal-open");
  $("close-team-task-photo-viewer")?.focus();
  return true;
}

function closeTaskPhotoViewer() {
  const modal = $("team-task-photo-viewer-modal");
  const image = $("team-task-photo-viewer-image");
  const video = $("team-task-photo-viewer-video");
  modal?.classList.add("hidden");
  if (image) {
    image.removeAttribute("src");
    image.style.transform = "";
    image.style.cursor = "";
    image.classList.remove("hidden");
  }
  if (video) {
    video.pause?.();
    video.removeAttribute("src");
    video.load?.();
    video.classList.add("hidden");
  }
  $("team-task-photo-viewer-tools")?.classList.remove("hidden");
  resetTaskPhotoViewerTransform();
  if ($("team-task-modal")?.classList.contains("hidden")) {
    document.body.classList.remove("modal-open");
  }
  const focusTarget = state.photoViewerReturnFocus;
  state.photoViewerReturnFocus = null;
  focusTarget?.focus?.();
}

function setupTaskPhotoViewerGestures() {
  const frame = $("team-task-photo-viewer-modal");
  const image = $("team-task-photo-viewer-image");
  if (!frame || !image) return;
  $("team-task-photo-zoom-in")?.addEventListener("click", () => zoomTaskPhotoViewer(0.25));
  $("team-task-photo-zoom-out")?.addEventListener("click", () => zoomTaskPhotoViewer(-0.25));
  $("team-task-photo-reset")?.addEventListener("click", resetTaskPhotoViewerTransform);
  image.addEventListener("click", () => {
    if (state.photoViewerDragMoved) {
      state.photoViewerDragMoved = false;
      return;
    }
    zoomTaskPhotoViewer(state.photoViewerZoom > 1 ? -0.25 : 0.5);
  });
  image.addEventListener("pointerdown", (event) => {
    if (state.photoViewerZoom <= 1) return;
    state.photoViewerDragging = true;
    state.photoViewerDragMoved = false;
    state.photoViewerDragStart = {
      x: event.clientX,
      y: event.clientY,
      offsetX: state.photoViewerOffsetX,
      offsetY: state.photoViewerOffsetY,
    };
    image.setPointerCapture?.(event.pointerId);
    applyTaskPhotoViewerTransform();
  });
  image.addEventListener("pointermove", (event) => {
    if (!state.photoViewerDragging || !state.photoViewerDragStart) return;
    event.preventDefault();
    if (Math.abs(event.clientX - state.photoViewerDragStart.x) > 3 || Math.abs(event.clientY - state.photoViewerDragStart.y) > 3) {
      state.photoViewerDragMoved = true;
    }
    state.photoViewerOffsetX = state.photoViewerDragStart.offsetX + event.clientX - state.photoViewerDragStart.x;
    state.photoViewerOffsetY = state.photoViewerDragStart.offsetY + event.clientY - state.photoViewerDragStart.y;
    applyTaskPhotoViewerTransform();
  });
  image.addEventListener("pointerup", () => {
    state.photoViewerDragging = false;
    state.photoViewerDragStart = null;
    applyTaskPhotoViewerTransform();
  });
  image.addEventListener("pointercancel", () => {
    state.photoViewerDragging = false;
    state.photoViewerDragStart = null;
    applyTaskPhotoViewerTransform();
  });
  frame.addEventListener("wheel", (event) => {
    if ($("team-task-photo-viewer-modal")?.classList.contains("hidden")) return;
    if (image.classList.contains("hidden")) return;
    event.preventDefault();
    zoomTaskPhotoViewer(event.deltaY < 0 ? 0.15 : -0.15);
  }, { passive: false });
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
    grid.innerHTML = `<div class="empty-state">No task evidence added.</div>`;
    return;
  }

  grid.innerHTML = state.photos.map((photo) => `
    <article class="team-task-photo-card">
      ${isTaskVideoAttachment(photo)
        ? `<video src="${escapeHtml(photo.previewUrl)}" controls playsinline preload="metadata"></video>`
        : `<img src="${escapeHtml(photo.thumbnailUrl || photo.previewUrl)}" alt="${escapeHtml(photo.label)}" />`}
      <span>${escapeHtml(photo.label)}</span>
    </article>
  `).join("");
}

function handlePhotoFiles(event) {
  const files = [...(event.target?.files || [])].filter(isAcceptedTaskEvidenceFile);
  if (!files.length) {
    setPhotoStatus("Choose image or video files to attach.", "error");
    return;
  }

  files.forEach((file, index) => {
    const mediaType = getTaskAttachmentMediaType(file);
    state.photos.push({
      file,
      previewUrl: URL.createObjectURL(file),
      label: file.name || `Task ${mediaType === "video" ? "video" : "photo"} ${index + 1}`,
      mime_type: file.type || (mediaType === "video" ? "video/mp4" : "image/jpeg"),
      media_type: mediaType,
    });
  });
  renderPhotos();
  setPhotoStatus(`${files.length} evidence file${files.length === 1 ? "" : "s"} added.`, "success");
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
  const explicitExtension = (source.match(/\.([a-z0-9]{2,5})(?:$|[?#\s])/i)?.[1] || "").toLowerCase();
  if (TASK_VIDEO_EXTENSIONS.has(explicitExtension)) return explicitExtension;
  if (source.includes("quicktime") || source.includes("mov")) return "mov";
  if (source.includes("webm")) return "webm";
  if (source.includes("mp4") || source.includes("mpeg-4")) return "mp4";
  if (source.includes("ogg")) return "ogg";
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
    const mediaType = getTaskAttachmentMediaType({ ...photo, mime_type: blob.type || photo.file?.type || photo.mime_type });
    const extension = getPhotoExtension(photo.file || photo);
    const originalName = safePathSegment(photo.label, `${mediaType}-${index + 1}`);
    const path = [
      "team-tasks",
      dateFolder,
      taskFolder,
      `${Date.now()}-${crypto.randomUUID()}-${originalName}.${extension}`,
    ].join("/");

    const { error } = await supabase.storage
      .from(TEAM_TASK_BUCKET)
      .upload(path, blob, {
        contentType: blob.type || photo.file?.type || photo.mime_type || (mediaType === "video" ? "video/mp4" : "image/jpeg"),
        upsert: false,
      });

    if (error) throw new Error(error.message || `Could not upload task evidence ${index + 1}.`);

    saved.push({
      bucket: TEAM_TASK_BUCKET,
      path,
      label: photo.label || `Task ${mediaType === "video" ? "video" : "photo"} ${index + 1}`,
      source_bucket: photo.bucket || null,
      source_path: photo.path || null,
      capture_job_id: photo.capture_job_id || null,
      mime_type: blob.type || photo.file?.type || photo.mime_type || null,
      media_type: mediaType,
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
      media_type: "image",
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
  resetLineReviewPanel();
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
  if (!canUseAdminTaskControls() || !task.assigned_to_user_id || String(task.status || "") !== "waiting_on_admin") return false;
  const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
  return events.some((event) => isReassignRequestEvent(task, event));
}

function getReassignRequestProposedAssigneeId(event = {}) {
  return event.payload?.requested_assigned_to_user_id
    || event.payload?.requestedAssignedToUserId
    || event.payload?.requested_assignee_user_id
    || "";
}

function getAssigneeLabelByUserId(userId = "") {
  const assignee = state.assignees.find((employee) => employee.user_id === userId);
  return assignee?.display_name || assignee?.email || userId || "";
}

function isReassignRequestEvent(task = {}, event = {}) {
  if (!getReassignRequestProposedAssigneeId(event)) return false;
  return (
    (String(event.action || "") === "reassign_requested"
      || (
        String(event.new_status || "") === "waiting_on_admin"
        && String(event.old_status || "") !== "waiting_on_admin"
      ))
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
  if (!canUseAdminTaskControls()) return "";
  const event = getLatestReassignRequestEvent(task);
  if (!event) return "";
  const requester = event.signed_by_email || task.assigned_to_email || "assigned employee";
  const requestedAssignee = getAssigneeLabelByUserId(getReassignRequestProposedAssigneeId(event));
  return `
    <div class="team-task-admin-notice">
      <strong>Reassignment requested by ${escapeHtml(requester)}</strong>
      <span>${escapeHtml(event.notes || "No reason provided.")}</span>
      ${requestedAssignee ? `<small>Requested to: ${escapeHtml(requestedAssignee)}</small>` : ""}
      <small>Current assignee: ${escapeHtml(getTaskAssigneeLabel(task))}</small>
      <small>${escapeHtml(formatDate(event.created_at))}</small>
    </div>
  `;
}

function getAdminAssignmentActionButtons(task = {}) {
  if (!canUseAdminTaskControls() || isTaskHistoryView()) return [];
  const canReassign = Boolean(task.assigned_to_user_id);
  const canDecline = hasReassignRequest(task);
  const canCancel = Boolean(task.assigned_to_user_id);
  if (!canReassign && !canDecline && !canCancel) return [];

  return [
    canReassign ? `<button type="button" class="secondary-btn" data-task-assignment-action="reassign" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Reassign Task</button>` : "",
    canDecline ? `<button type="button" class="secondary-btn" data-task-assignment-action="decline_reassign" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Decline Reassign</button>` : "",
    canCancel ? `<button type="button" class="secondary-btn danger-btn" data-task-assignment-action="cancel_assignment" data-task-source="${escapeHtml(task.source)}" data-task-id="${escapeHtml(task.id)}">Cancel Assignment</button>` : "",
  ].filter(Boolean);
}

function renderAdminAssignmentActions(task = {}) {
  const buttons = getAdminAssignmentActionButtons(task);
  if (!buttons.length) return "";

  return `
    <div class="team-task-actions">
      ${buttons.join("")}
    </div>
  `;
}

function configureOrderWorkflowModal(task, options = {}) {
  if (isTaskViewAsWorkerMode()) {
    return setStatus("Worker display is read-only. Switch back to your admin view to make changes.", "info");
  }
  state.mode = options.mode || "order-progress";
  state.activeTaskId = task?.id || "";
  resetPhotos();
  setModalError("");
  setPhotoStatus("");

  const mode = state.mode;
  const isSubtaskCreate = mode === "order-subtask-create";
  const isShippingAssign = mode === "order-shipping-assign";
  const isShippingReadyPackaging = mode === "order-shipping-ready-packaging";
  const isSendBack = mode === "order-subtask-sendback" || mode === "order-task-sendback";
  const isCancelApproval = mode === "order-task-cancel-approval";
  const isComplete = mode === "order-subtask-complete" || mode === "order-shipping-complete" || mode === "order-task-complete";
  const isReassignRequest = mode === "order-reassign-request";
  const canManageFields = canUseAdminTaskControls();

  const titles = {
    "order-subtask-create": "Create pending order subtask",
    "order-task-progress": "Task progress update",
    "order-task-complete": "Complete assigned task",
    "order-subtask-progress": "Subtask progress update",
    "order-subtask-complete": "Complete subtask",
    "order-subtask-approve": "Approve subtask",
    "order-subtask-sendback": "Send subtask back",
    "order-task-sendback": "Send order back",
    "order-task-cancel-approval": "Cancel approval request",
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
    "order-task-sendback": "Explain exactly what is missing before this order can leave the facility.",
    "order-task-cancel-approval": "Cancel this admin approval request because it was submitted by mistake or no longer applies.",
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
          : isCancelApproval
            ? "Cancel Approval"
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
        : isCancelApproval
          ? "Why should this approval request be cancelled? This stays in the audit trail."
        : isReassignRequest
          ? "Why should this be reassigned? Add anything the admin should know."
        : isComplete
          ? "Final completion note."
          : "Progress update, blocker, or admin note.";
  $("team-task-type").value = isShippingAssign ? "shipping" : "admin_review";
  $("team-task-priority").value = task?.priority || "normal";
  $("team-task-due-at").value = toDateTimeLocalValue(task?.due_at || "");
  $("team-task-status-input").value = "";
  configureStatusOptionsForProgress("team-task-status-input", false);
  renderAssigneeSelect();
  $("team-task-assignee").value = isShippingReadyPackaging
    ? (state.user?.id || task?.assigned_to_user_id || "")
    : isReassignRequest
      ? ""
      : (isSubtaskCreate || isShippingAssign || isSendBack)
        ? (task?.assigned_to_user_id || "")
        : "";
  configureModalAdminFields({
    assignee: (canManageFields && (isSubtaskCreate || isShippingAssign || isSendBack)) || isShippingReadyPackaging || isReassignRequest,
    category: canManageFields && (isSubtaskCreate || isShippingAssign || isSendBack),
    priority: (canManageFields && !isCancelApproval) || isShippingReadyPackaging,
    due: (canManageFields && !isCancelApproval) || isShippingReadyPackaging,
    status: false,
  });
  configureOrderLineReviewPanel(task, mode);

  openModal();
  setTimeout(() => (isSubtaskCreate ? $("team-task-title-input") : $("team-task-note"))?.focus(), 80);
  loadCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not load team task capture stations:", error);
    setPhotoStatus(error?.message || "Could not load capture stations.", "error");
  });
}

function handleOrderWorkflowAction(action = "", taskId = "") {
  if (isTaskViewAsWorkerMode()) {
    return setStatus("Worker display is read-only. Switch back to your admin view to make changes.", "info");
  }
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
  if (action === "send-back-order") return configureOrderWorkflowModal(task, { mode: "order-task-sendback" });
  if (action === "cancel-approval") return configureOrderWorkflowModal(task, { mode: "order-task-cancel-approval" });
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
  if (!canUseAdminTaskControls()) return setStatus("Switch back to your admin view to manage task assignments.", "error");

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
  configureStatusOptionsForProgress("team-task-status-input", false);
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
  if (!canUseAdminTaskControls()) return setStatus("Switch back to your admin view to manage task assignments.", "error");
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
    state.lineReviewDecisions = new Map();
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
  if (!canUseAdminTaskControls()) return setStatus("Switch back to your admin view to manage task history.", "error");
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
  if (isTaskViewAsWorkerMode()) {
    return setStatus("Worker display is read-only. Switch back to your admin view to make changes.", "info");
  }
  const taskId = options.taskId || "";
  const task = taskId ? state.tasks.find((entry) => entry.source === "team" && entry.id === taskId) : null;
  state.mode = task
    ? options.reassignRequest
      ? "reassign_request"
      : options.accept
        ? "accept"
        : options.sendBack
          ? "send_back"
      : options.resolve
        ? "resolve"
        : options.progress
          ? "progress"
          : "reply"
    : "create";
  state.activeTaskId = task?.id || "";
  resetPhotos();
  setModalError("");
  setPhotoStatus("");

  $("team-task-modal-title").textContent = task
    ? options.reassignRequest ? "Request reassignment" : options.accept ? "Accept completed task" : options.sendBack ? "Send task back" : options.resolve ? "Complete task" : options.progress ? "Progress / delay update" : "Reply to team task"
    : "Create independent task";
  $("team-task-modal-subtitle").textContent = task
    ? options.reassignRequest
      ? "Send a note to the admin asking them to move this task. The assignment will stay unchanged until an admin reviews it."
      : options.accept
        ? "Confirm the worker's completion note and close this task in the audit trail."
      : options.sendBack
        ? "Explain what still needs to be fixed so the assigned worker can continue."
      : options.resolve
        ? "Add the final completion note and any proof before sending this task for acceptance."
        : options.progress
      ? "Explain what happened, what is blocking completion, and when this should be checked again."
      : "Add the next note, reassign the work, or mark it completed."
    : "Assign independent work and keep the documentation in one place.";
  $("team-task-title-field")?.classList.toggle("hidden", Boolean(task));
  $("submit-team-task").textContent = task
    ? options.resolve
      ? "Send for Acceptance"
      : options.accept
        ? "Accept / Close"
      : options.sendBack
        ? "Send Back"
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
    : options.accept
      ? "Acceptance note for the audit trail."
    : options.sendBack
      ? "What needs to be fixed before this can be accepted?"
    : options.resolve
      ? "Final completion note."
      : options.progress
        ? "Why could this not be completed today? What are we waiting for, and what should happen next?"
        : "Write the instructions, answer, or completion note.";
  $("team-task-type").value = task?.task_type || "general";
  $("team-task-priority").value = task?.priority || "normal";
  $("team-task-due-at").value = toDateTimeLocalValue(task?.due_at || "");
  $("team-task-status-input").value = options.accept
    ? "resolved"
    : options.sendBack
      ? "sent_back_for_rework"
    : options.resolve
      ? "completed_by_employee"
    : options.reassignRequest
      ? "waiting_on_admin"
    : options.progress
      ? "deferred"
      : "";
  configureStatusOptionsForProgress("team-task-status-input", Boolean(options.progress));
  renderAssigneeSelect();
  $("team-task-assignee").value = task?.assigned_to_user_id || "";
  configureModalAdminFields({
    assignee: !task || (canUseAdminTaskControls() && !options.progress && !options.resolve && !options.accept && !options.sendBack),
    category: !task || (canUseAdminTaskControls() && !options.progress && !options.resolve && !options.reassignRequest && !options.accept && !options.sendBack),
    priority: !task || (canUseAdminTaskControls() && !options.progress && !options.resolve && !options.reassignRequest && !options.accept && !options.sendBack),
    due: !task || options.progress || options.sendBack || (canUseAdminTaskControls() && !options.resolve && !options.reassignRequest && !options.accept),
    status: Boolean(task) && (options.progress || canUseAdminTaskControls()) && !options.resolve && !options.reassignRequest && !options.accept && !options.sendBack,
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
  payload = null,
  successMessage = "Pending order task updated.",
  reload = true,
} = {}) {
  if (!task?.id) throw new Error("Missing pending order task.");
  const signedByEmail = state.user?.email || state.employee?.email || state.employee?.display_name || "";
  const hasPayload = payload && typeof payload === "object" && Object.keys(payload).length > 0;
  const rpcArgs = {
    _task_id: task.id,
    _note: note || null,
    _assigned_to_user_id: assignedToUserId || null,
    _status: status || null,
    _priority: priority || null,
    _photo_attachments: photos,
    _signed_by_email: signedByEmail,
    _due_at: dueAt || null,
  };
  if (hasPayload) rpcArgs._payload = payload;

  const { error } = await supabase.rpc(
    hasPayload ? "respond_ebay_order_coordination_task_with_payload" : "respond_ebay_order_coordination_task",
    rpcArgs
  );
  if (error) throw error;
  setStatus(successMessage, "success");
  if (reload) await loadTasks();
}

async function createOrderReassignProposalEvent(task = {}, requestedAssigneeId = "", note = "") {
  if (!task?.id || !requestedAssigneeId) return;
  const signedByEmail = state.user?.email || state.employee?.email || state.employee?.display_name || "";
  const { error } = await supabase
    .from("ebay_order_task_events")
    .insert({
      task_id: task.id,
      order_id: task.order_id || null,
      action: "reassign_requested",
      old_status: task.status || null,
      new_status: "waiting_on_admin",
      old_assigned_to_user_id: task.assigned_to_user_id || null,
      new_assigned_to_user_id: task.assigned_to_user_id || null,
      notes: note || null,
      photo_attachments: [],
      signed_by: state.user?.id || null,
      signed_by_email: signedByEmail,
      payload: {
        requested_assigned_to_user_id: requestedAssigneeId,
        current_assigned_to_user_id: task.assigned_to_user_id || null,
      },
    });
  if (error) throw error;
}

async function submitOrderWorkflowTask() {
  if (isTaskViewAsWorkerMode()) return setModalError("Worker display is read-only. Switch back to your admin view to make changes.");
  const task = findOrderTaskById(state.activeTaskId);
  if (!task) return setModalError("Could not find this pending order task. Refresh and try again.");

  const mode = state.mode;
  const title = String($("team-task-title-input")?.value || "").trim();
  const note = String($("team-task-note")?.value || "").trim();
  const canManageFields = canUseAdminTaskControls();
  const isShippingReadyPackaging = mode === "order-shipping-ready-packaging";
  const isReassignRequest = mode === "order-reassign-request";
  const assigneeId = (canManageFields || isShippingReadyPackaging || isReassignRequest) ? $("team-task-assignee")?.value || null : null;
  const priority = (canManageFields || isShippingReadyPackaging) ? $("team-task-priority")?.value || "normal" : null;
  const dueAt = (canManageFields || isShippingReadyPackaging) ? localDateTimeToIso($("team-task-due-at")?.value || "") : null;

  if (mode === "order-subtask-create" && !title) return setModalError("Write a subtask title first.");
  if (mode === "order-subtask-create" && !note) return setModalError("Write the subtask instructions first.");
  if (["order-subtask-create", "order-shipping-assign", "order-shipping-ready-packaging"].includes(mode) && !assigneeId) return setModalError("Choose the employee who should package this shipment.");
  if (mode === "order-task-sendback" && !assigneeId) return setModalError("Choose who should correct this order.");
  if (mode === "order-reassign-request" && !assigneeId) return setModalError("Choose who you want this task reassigned to.");
  if (mode === "order-reassign-request" && assigneeId === task.assigned_to_user_id) return setModalError("Choose a different employee for the reassignment request.");
  if (["order-task-complete", "order-subtask-complete", "order-subtask-sendback", "order-task-sendback", "order-task-cancel-approval", "order-shipping-ready-packaging", "order-shipping-complete", "order-reassign-request"].includes(mode) && !note) {
    return setModalError("Write the required note before saving.");
  }
  if (["order-shipping-ready-packaging", "order-shipping-complete"].includes(mode) && !state.photos.length) {
    return setModalError(mode === "order-shipping-complete"
      ? "Add photo or video proof of the packaged item and shipping label before marking shipped."
      : "Add an audit photo or video before marking this ready for packaging.");
  }
  const needsLineReview = shouldShowOrderLineReviewPanel(task, mode);
  const lineReview = needsLineReview ? collectOrderLineReviewDecisions(task, mode) : { reviews: [], summary: null, error: "" };
  if (lineReview.error) return setModalError(lineReview.error);

  if (mode === "order-shipping-assign" && !window.confirm("Approve this pending order for shipment and assign the shipping task?")) return;
  if (mode === "order-task-complete" && !window.confirm("Mark this task completed and send it back to admin review?")) return;
  if (mode === "order-subtask-sendback" && !window.confirm("Send this subtask back for rework?")) return;
  if (mode === "order-task-sendback" && !window.confirm("Send this order back for correction?")) return;
  if (mode === "order-task-cancel-approval" && !window.confirm("Cancel this admin approval request? The order will return to the normal pending queue.")) return;
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
    const lineReviewPayload = needsLineReview ? buildOrderLineReviewPayload(task, mode, lineReview, signedByEmail) : null;

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
        reload: false,
        successMessage: "Reassignment request sent to admin.",
      });
      await createOrderReassignProposalEvent(task, assigneeId, note);
      await loadTasks();
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
    } else if (mode === "order-task-sendback") {
      await saveOrderWorkflowUpdate({
        task,
        status: "sent_back_for_rework",
        note,
        assignedToUserId: assigneeId,
        priority,
        dueAt,
        photos,
        payload: lineReviewPayload,
        successMessage: "Order sent back for correction.",
      });
    } else if (mode === "order-task-cancel-approval") {
      await saveOrderWorkflowUpdate({
        task,
        status: "cancelled",
        note,
        photos,
        successMessage: "Approval request cancelled.",
      });
    } else if (mode === "order-shipping-assign") {
      if (lineReviewPayload) {
        await saveOrderWorkflowUpdate({
          task,
          note: note || "All submitted item lines approved for shipment.",
          photos,
          payload: lineReviewPayload,
          reload: false,
          successMessage: "Line review saved.",
        });
      }
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

    state.lineReviewDecisions = new Map();
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
  if (!canUseAdminTaskControls()) return setModalError("Switch back to your admin view to manage task assignments.");
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
  if (isTaskViewAsWorkerMode()) return setModalError("Worker display is read-only. Switch back to your admin view to make changes.");

  const title = String($("team-task-title-input")?.value || "").trim();
  const note = String($("team-task-note")?.value || "").trim();
  if (state.mode === "create" && !title) return setModalError("Write a task title first.");
  if (!note && ["reply", "progress", "resolve", "accept", "send_back", "reassign_request"].includes(state.mode)) return setModalError("Write a note before saving the update.");

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
      const canManageFields = canUseAdminTaskControls();
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
    } else if (["progress", "resolve", "accept", "send_back", "reassign_request"].includes(state.mode) && state.activeTaskId) {
      const { error } = await supabase.rpc("respond_team_task", {
        _task_id: state.activeTaskId,
        _note: note,
        _assigned_to_user_id: null,
        _status: $("team-task-status-input")?.value || null,
        _priority: null,
        _photo_attachments: photos,
        _signed_by_email: signedByEmail,
        _due_at: ["progress", "send_back"].includes(state.mode) ? localDateTimeToIso($("team-task-due-at")?.value || "") : null,
      });
      if (error) throw error;
      setStatus(
        state.mode === "progress"
          ? "Task progress saved."
          : state.mode === "resolve"
            ? "Task sent for acceptance."
          : state.mode === "accept"
            ? "Task accepted and closed."
          : state.mode === "send_back"
            ? "Task sent back for rework."
            : "Reassignment request sent.",
        "success"
      );
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

async function openTaskPhoto(bucket, path, options = {}) {
  if (!path) return setStatus("That evidence file is missing a storage path.", "error");
  const storageBucket = bucket || TEAM_TASK_BUCKET;
  const key = `${storageBucket}/${path}`;
  let url = state.signedUrls.get(key);
  if (!url) {
    const { data, error } = await supabase.storage
      .from(storageBucket)
      .createSignedUrl(path, TEAM_TASK_SIGNED_URL_TTL_SECONDS);
    if (error || !data?.signedUrl) return setStatus("Could not open that task evidence.", "error");
    url = data.signedUrl;
    state.signedUrls.set(key, url);
  }
  openTaskPhotoViewer({
    url,
    label: options.label || path.split("/").pop() || "Task evidence",
    bucket: storageBucket,
    path,
    mediaType: options.mediaType || getTaskAttachmentMediaType({ path }),
    trigger: options.trigger || null,
  });
}

function setupListeners() {
  $("new-team-task")?.addEventListener("click", () => openTaskModal());
  $("refresh-team-tasks")?.addEventListener("click", loadTasks);
  $("team-task-notification-toggle")?.addEventListener("click", () => {
    setTaskNotificationPanelOpen(!state.notificationsOpen);
  });
  $("team-task-mark-notifications-read")?.addEventListener("click", () => {
    markTaskNotificationsRead();
  });
  document.querySelectorAll("[data-task-view]").forEach((button) => {
    button.addEventListener("click", async () => {
      state.taskView = button.dataset.taskView === "history" ? "history" : "active";
      if (state.taskView === "active" && isCanceledTaskScope()) state.taskScope = "mine";
      if (state.taskView === "history" && ["acceptance", "order_approval", "responded"].includes(state.taskOwnerFilter)) state.taskOwnerFilter = "all";
      updateTaskScopeChrome();
      await loadTasks();
    });
  });
  document.querySelectorAll("[data-task-read-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.taskReadFilter = ["all", "unread", "read"].includes(button.dataset.taskReadFilter)
        ? button.dataset.taskReadFilter
        : "all";
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-owner-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.taskOwnerFilter = ["all", "assigned", "created", "responded", "acceptance", "order_approval"].includes(button.dataset.taskOwnerFilter)
        ? button.dataset.taskOwnerFilter
        : "all";
      renderTasks();
    });
  });
  document.querySelectorAll("[data-task-source-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      state.taskSourceFilter = ["all", "independent", "order", "order_history", "ebay_triage", "return"].includes(button.dataset.taskSourceFilter)
        ? button.dataset.taskSourceFilter
        : "all";
      renderTasks();
    });
  });
  $("team-task-scope")?.addEventListener("change", async (event) => {
    state.taskScope = ["all", "canceled"].includes(event.target.value) && isAdminUser() ? event.target.value : "mine";
    state.viewedWorkerUserId = "";
    if (isCanceledTaskScope()) state.taskView = "history";
    updateTaskScopeChrome();
    await loadTasks();
  });
  $("team-task-worker-view")?.addEventListener("change", async (event) => {
    state.viewedWorkerUserId = isAdminUser() ? event.target.value || "" : "";
    const viewingWorker = Boolean(state.viewedWorkerUserId);
    if (state.viewedWorkerUserId) {
      state.taskScope = "all";
      state.taskOwnerFilter = "all";
      state.taskReadFilter = "all";
      state.taskSourceFilter = "all";
    }
    updateTaskScopeChrome();
    await loadTasks();
    if (viewingWorker) setStatus("Viewing that worker's task page in read-only mode.", "info");
  });
  $("team-task-active-sort")?.addEventListener("change", (event) => {
    state.taskSort = event.target.value || "recent";
    renderTasks();
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
  setupTaskPhotoViewerGestures();
  $("close-team-task-photo-viewer")?.addEventListener("click", closeTaskPhotoViewer);
  $("dismiss-team-task-photo-viewer")?.addEventListener("click", closeTaskPhotoViewer);
  $("team-task-photo-viewer-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "team-task-photo-viewer-modal") closeTaskPhotoViewer();
  });
  $("team-task-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "team-task-modal") closeModal();
  });
  document.addEventListener("click", (event) => {
    if (!state.notificationsOpen) return;
    if ($("team-task-notifications")?.contains(event.target)) return;
    setTaskNotificationPanelOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (state.notificationsOpen && event.key === "Escape") {
      event.preventDefault();
      setTaskNotificationPanelOpen(false);
      return;
    }
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
  await loadTaskNotifications({ silent: true });
  setupTaskNotificationRealtime();
  await loadTasks();
  if (window.lucide) window.lucide.createIcons();
});
