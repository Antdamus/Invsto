const state = {
  user: null,
  employee: null,
  assignees: [],
  tasks: [],
  eventsByTask: new Map(),
  activeTaskId: "",
  mode: "create",
  photos: [],
  signedUrls: new Map(),
  captureStations: [],
  selectedCaptureStationId: "",
  captureBusy: false,
  taskScope: "mine",
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
const ACTIVE_TASK_STATUSES = ["open", "assigned", "in_progress", "waiting_on_admin", "waiting_on_worker", "blocked", "deferred"];
const ACTIVE_RETURN_TASK_STATUSES = ["open", "assigned", "in_progress", "blocked", "deferred"];
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

function updateTaskScopeChrome() {
  if (!isAdminUser()) state.taskScope = "mine";

  const scopeControl = $("team-task-scope-control");
  const scopeSelect = $("team-task-scope");
  scopeControl?.classList.toggle("hidden", !isAdminUser());
  if (scopeSelect) {
    scopeSelect.value = isTeamWideTaskScope() ? "all" : "mine";
    scopeSelect.disabled = !isAdminUser();
  }

  const mode = $("team-task-mode");
  if (mode) mode.textContent = isTeamWideTaskScope() ? "Everyone's Tasks" : "My Tasks";
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

function sortUnifiedTasks(tasks = []) {
  return [...tasks].sort((a, b) => {
    const priorityDelta = priorityRank(a.priority) - priorityRank(b.priority);
    if (priorityDelta) return priorityDelta;
    const aDue = a.due_at ? new Date(a.due_at).getTime() : Number.POSITIVE_INFINITY;
    const bDue = b.due_at ? new Date(b.due_at).getTime() : Number.POSITIVE_INFINITY;
    if (aDue !== bDue) return aDue - bDue;
    return new Date(a.created_at || 0).getTime() - new Date(b.created_at || 0).getTime();
  });
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
  if (list) list.innerHTML = `<div class="empty-state">Loading tasks...</div>`;
  setStatus("");

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

  state.tasks = sortUnifiedTasks(tasks);
  await enrichTasksWithDetails(state.tasks);
  const requested = getRequestedTaskId();
  if (requested && !state.tasks.some((task) => task.id === requested)) {
    const { data: requestedTask, error: requestedError } = await supabase
      .from("team_tasks")
      .select("*")
      .eq("id", requested)
      .maybeSingle();
    if (!requestedError && requestedTask) state.tasks.unshift(normalizeTeamTask(requestedTask));
  }

  await loadEventsForTasks();
  await hydrateEventPhotoUrls();
  renderTasks();

  if (requested) {
    const card = document.querySelector(`[data-team-task-card="${CSS.escape(requested)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

async function loadTeamTaskRecords() {
  const rpcName = isTeamWideTaskScope() ? "list_admin_team_tasks" : "list_my_team_tasks";
  const { data, error } = await supabase.rpc(rpcName, { _limit: 80 });
  if (error) throw error;
  return (data || []).map(normalizeTeamTask);
}

async function loadOrderTaskRecords() {
  let query = supabase
    .from("ebay_order_tasks")
    .select("id, order_id, order_line_ids, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, due_at, created_at, latest_note, latest_photo_count, created_by_email, metadata, ebay_orders(order_number, buyer_username, sale_date, paid_on_date, ship_by_date, status, total_price, net_payout)")
    .in("status", ACTIVE_TASK_STATUSES)
    .order("created_at", { ascending: true })
    .limit(80);
  if (!isTeamWideTaskScope()) query = query.eq("assigned_to_user_id", state.user?.id);

  const { data, error } = await query;
  if (error) throw error;
  return (data || []).map(normalizeOrderTask);
}

async function loadReturnTaskRecords() {
  let query = supabase
    .from("ebay_return_tasks")
    .select("id, return_case_id, order_id, order_line_ids, task_type, title, question, status, priority, assigned_to_email, assigned_to_user_id, due_at, created_at, metadata, ebay_return_cases(id, order_id, order_number, ebay_return_id, buyer_username, return_reason, status, opened_at, notes, raw_payload)")
    .in("status", ACTIVE_RETURN_TASK_STATUSES)
    .order("created_at", { ascending: true })
    .limit(80);
  if (!isTeamWideTaskScope()) query = query.eq("assigned_to_user_id", state.user?.id);

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
  return {
    ...task,
    source: "order",
    sourceLabel: "Pending Order",
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

async function loadEventsForTasks() {
  state.eventsByTask = new Map();
  const sources = [
    { source: "team", table: "team_task_events" },
    { source: "order", table: "ebay_order_task_events" },
    { source: "return", table: "ebay_return_task_events" },
  ];

  await Promise.all(sources.map(async ({ source, table }) => {
    const ids = state.tasks.filter((task) => task.source === source).map((task) => task.id).filter(Boolean);
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

  if (title) title.textContent = isTeamWideTaskScope() ? "Everyone's Active Tasks" : "My Assigned Tasks";
  if (count) count.textContent = `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;

  if (!state.tasks.length) {
    list.innerHTML = `<div class="empty-state">No active tasks right now.</div>`;
    return;
  }

  list.innerHTML = state.tasks.map((task) => {
    const events = state.eventsByTask.get(getUnifiedTaskKey(task)) || [];
    const urgent = ["urgent", "high"].includes(String(task.priority || "").toLowerCase())
      || ["blocked", "deferred"].includes(String(task.status || "").toLowerCase());
    const resolved = ["resolved", "cancelled"].includes(String(task.status || "").toLowerCase());
    return `
      <article class="team-task-card ${urgent ? "is-urgent" : ""} ${resolved ? "is-resolved" : ""}" data-team-task-card="${escapeHtml(task.id)}">
        <div class="team-task-card-head">
          <div>
            <strong>${escapeHtml(task.title || "Team task")}</strong>
            <span>${escapeHtml(task.latest_note || task.description || "No note")}</span>
          </div>
          <span class="team-task-chip">${escapeHtml(getTaskStatusLabel(task.status))}</span>
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
        </div>
        ${renderTaskContext(task)}
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
}

function renderTaskActions(task = {}, resolved = false) {
  if (task.source !== "team") {
    const label = task.source === "order" ? "Open Pending Order Task" : "Open Return Task";
    return `
      <div class="team-task-actions">
        <a class="secondary-btn" href="${escapeHtml(task.actionHref || "#")}">${escapeHtml(label)}</a>
      </div>
    `;
  }

  return `
    <div class="team-task-actions">
      ${resolved ? "" : `<button type="button" class="secondary-btn" data-team-task-progress="${escapeHtml(task.id)}">Progress / Delay</button>`}
      <button type="button" class="secondary-btn" data-team-task-reply="${escapeHtml(task.id)}">Reply / Reassign</button>
      ${resolved ? "" : `<button type="button" class="primary-btn" data-team-task-resolve="${escapeHtml(task.id)}">Mark Completed</button>`}
    </div>
  `;
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
  resetPhotos();
  setModalError("");
  setPhotoStatus("");
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
    ? options.progress ? "Progress / delay update" : "Reply to team task"
    : "Create team task";
  $("team-task-modal-subtitle").textContent = task
    ? options.progress
      ? "Explain what happened, what is blocking completion, and when this should be checked again."
      : "Add the next note, reassign the work, or mark it completed."
    : "Assign independent work and keep the documentation in one place.";
  $("team-task-title-field")?.classList.toggle("hidden", Boolean(task));
  $("team-task-status-field")?.classList.toggle("hidden", !task);
  $("submit-team-task").textContent = task ? options.progress ? "Save Progress" : "Save Update" : "Save Task";

  $("team-task-title-input").value = "";
  $("team-task-note").value = "";
  $("team-task-note").placeholder = options.progress
    ? "Why could this not be completed today? What are we waiting for, and what should happen next?"
    : "Write the instructions, answer, or completion note.";
  $("team-task-type").value = task?.task_type || "general";
  $("team-task-priority").value = task?.priority || "normal";
  $("team-task-due-at").value = toDateTimeLocalValue(task?.due_at || "");
  $("team-task-status-input").value = options.resolve ? "resolved" : options.progress ? "deferred" : "";
  renderAssigneeSelect();
  $("team-task-assignee").value = task?.assigned_to_user_id || "";

  openModal();
  setTimeout(() => (task ? $("team-task-note") : $("team-task-title-input"))?.focus(), 80);
  loadCaptureStations({ silent: true }).catch((error) => {
    console.warn("Could not load team task capture stations:", error);
    setPhotoStatus(error?.message || "Could not load capture stations.", "error");
  });
}

async function submitTask() {
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
      const { error } = await supabase.rpc("respond_team_task", {
        _task_id: state.activeTaskId,
        _note: note,
        _assigned_to_user_id: $("team-task-assignee")?.value || null,
        _status: $("team-task-status-input")?.value || null,
        _priority: $("team-task-priority")?.value || null,
        _photo_attachments: photos,
        _signed_by_email: signedByEmail,
        _due_at: localDateTimeToIso($("team-task-due-at")?.value || ""),
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
  $("team-task-scope")?.addEventListener("change", async (event) => {
    state.taskScope = event.target.value === "all" && isAdminUser() ? "all" : "mine";
    updateTaskScopeChrome();
    await loadTasks();
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
