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

function getRequestedTaskId() {
  const value = String(new URLSearchParams(window.location.search).get("taskId") || "").trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) ? value : "";
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
  const mode = $("team-task-mode");
  if (mode) mode.textContent = isAdminUser() ? "Admin Tasks" : "My Tasks";
  const greeting = $("team-task-greeting");
  if (greeting) greeting.textContent = `Team Tasks${employee.display_name ? ` - ${employee.display_name}` : ""}`;
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

async function loadAssignees() {
  const { data, error } = await supabase.rpc("list_team_task_assignees");
  if (error) throw error;
  state.assignees = Array.isArray(data) ? data : [];
  renderAssigneeSelect();
}

async function loadTasks() {
  const list = $("team-task-list");
  if (list) list.innerHTML = `<div class="empty-state">Loading team tasks...</div>`;
  setStatus("");

  const rpcName = isAdminUser() ? "list_admin_team_tasks" : "list_my_team_tasks";
  const { data, error } = await supabase.rpc(rpcName, { _limit: 50 });
  if (error) {
    console.warn("Could not load team tasks:", error);
    if (list) list.innerHTML = `<div class="empty-state">Could not load team tasks. Make sure the latest migration is pushed.</div>`;
    return;
  }

  state.tasks = data || [];
  const requested = getRequestedTaskId();
  if (requested && !state.tasks.some((task) => task.id === requested)) {
    const { data: requestedTask, error: requestedError } = await supabase
      .from("team_tasks")
      .select("*")
      .eq("id", requested)
      .maybeSingle();
    if (!requestedError && requestedTask) state.tasks.unshift(requestedTask);
  }

  await loadEventsForTasks();
  renderTasks();

  if (requested) {
    const card = document.querySelector(`[data-team-task-card="${CSS.escape(requested)}"]`);
    card?.scrollIntoView({ behavior: "smooth", block: "center" });
  }
}

async function loadEventsForTasks() {
  state.eventsByTask = new Map();
  const ids = state.tasks.map((task) => task.id).filter(Boolean);
  if (!ids.length) return;

  const { data, error } = await supabase
    .from("team_task_events")
    .select("*")
    .in("task_id", ids)
    .order("created_at", { ascending: true });

  if (error) {
    console.warn("Could not load team task events:", error);
    return;
  }

  (data || []).forEach((event) => {
    const list = state.eventsByTask.get(event.task_id) || [];
    list.push(event);
    state.eventsByTask.set(event.task_id, list);
  });
}

function getTaskStatusLabel(value) {
  return String(value || "open").replace(/_/g, " ");
}

function renderTasks() {
  const list = $("team-task-list");
  const count = $("team-task-count");
  const title = $("team-task-list-title");
  if (!list) return;

  if (title) title.textContent = isAdminUser() ? "All Open Team Tasks" : "Assigned and Created Tasks";
  if (count) count.textContent = `${state.tasks.length} task${state.tasks.length === 1 ? "" : "s"}`;

  if (!state.tasks.length) {
    list.innerHTML = `<div class="empty-state">No active team tasks right now.</div>`;
    return;
  }

  list.innerHTML = state.tasks.map((task) => {
    const events = state.eventsByTask.get(task.id) || [];
    const urgent = ["urgent", "high"].includes(String(task.priority || "").toLowerCase());
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
          <span>${escapeHtml(task.task_type || "general")}</span>
          <span>${escapeHtml(task.priority || "normal")}</span>
          <span>Assigned: ${escapeHtml(task.assigned_to_email || "Unassigned")}</span>
          <span>Due ${escapeHtml(formatDate(task.due_at))}</span>
          <span>Created by ${escapeHtml(task.created_by_email || "logged-in user")}</span>
        </div>
        <div class="team-task-events">
          ${events.length ? events.map(renderTaskEvent).join("") : `<div class="empty-state">No task trail yet.</div>`}
        </div>
        <div class="team-task-actions">
          <button type="button" class="secondary-btn" data-team-task-reply="${escapeHtml(task.id)}">Reply / Reassign</button>
          ${resolved ? "" : `<button type="button" class="primary-btn" data-team-task-resolve="${escapeHtml(task.id)}">Mark Completed</button>`}
        </div>
      </article>
    `;
  }).join("");

  list.querySelectorAll("[data-team-task-reply]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskReply }));
  });
  list.querySelectorAll("[data-team-task-resolve]").forEach((button) => {
    button.addEventListener("click", () => openTaskModal({ taskId: button.dataset.teamTaskResolve, resolve: true }));
  });
  list.querySelectorAll("[data-team-task-photo]").forEach((button) => {
    button.addEventListener("click", () => openTaskPhoto(button.dataset.bucket, button.dataset.path));
  });
}

function renderTaskEvent(event = {}) {
  const photos = Array.isArray(event.photo_attachments) ? event.photo_attachments : [];
  const photoHtml = photos.length
    ? `<div class="team-task-photo-links">${photos.map((photo, index) => `
        <button
          type="button"
          data-team-task-photo="1"
          data-bucket="${escapeHtml(photo.bucket || TEAM_TASK_BUCKET)}"
          data-path="${escapeHtml(photo.path || "")}"
        >${escapeHtml(photo.label || `Photo ${index + 1}`)}</button>
      `).join("")}</div>`
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
  const task = taskId ? state.tasks.find((entry) => entry.id === taskId) : null;
  state.mode = task ? "reply" : "create";
  state.activeTaskId = task?.id || "";
  resetPhotos();
  setModalError("");
  setPhotoStatus("");

  $("team-task-modal-title").textContent = task ? "Reply to team task" : "Create team task";
  $("team-task-modal-subtitle").textContent = task
    ? "Add the next note, reassign the work, or mark it completed."
    : "Assign independent work and keep the documentation in one place.";
  $("team-task-title-field")?.classList.toggle("hidden", Boolean(task));
  $("team-task-status-field")?.classList.toggle("hidden", !task);
  $("submit-team-task").textContent = task ? "Save Update" : "Save Task";

  $("team-task-title-input").value = "";
  $("team-task-note").value = "";
  $("team-task-type").value = task?.task_type || "general";
  $("team-task-priority").value = task?.priority || "normal";
  $("team-task-due-at").value = "";
  $("team-task-status-input").value = options.resolve ? "resolved" : "";
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
  window.open(url, "_blank", "noopener,noreferrer");
}

function setupListeners() {
  $("new-team-task")?.addEventListener("click", () => openTaskModal());
  $("refresh-team-tasks")?.addEventListener("click", loadTasks);
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
  $("team-task-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "team-task-modal") closeModal();
  });

  document.addEventListener("keydown", (event) => {
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
