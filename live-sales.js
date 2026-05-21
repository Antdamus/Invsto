"use strict";

const state = {
  user: null,
  employee: null,
  employees: [],
  stores: [],
  sessions: [],
  currentSession: null,
  currentLot: null,
  lotItems: [],
  selectedItem: null,
  sourceRows: [],
  selectedSourceRow: null,
  sourceReservations: new Map(),
  lotSourceAvailability: new Map(),
  bagHistoryLots: [],
  bagHistoryItems: [],
  bagHistorySelectedLotId: "",
  bagHistorySearch: "",
  bagHistoryLoading: false,
  itemSearchTimer: null,
  scannerRefocusTimer: null,
  flowStep: "session",
  photoZoom: 1,
  photoPanX: 0,
  photoPanY: 0,
  photoDrag: null,
  photoSuppressClick: false,
  editGroup: null,
  editLot: null,
  editReplacementItem: null,
  editSourceRows: [],
  editSelectedSourceRow: null,
  pendingStartAuctionNumber: "",
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

function escapeXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatDate(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function formatElapsed(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function setStatus(message = "", type = "info") {
  const el = $("live-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function setLabelStatus(message = "", type = "info") {
  const el = $("label-status");
  if (!el) return;
  el.innerHTML = message;
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function getStoreName(storeId) {
  return state.stores.find((store) => store.id === storeId)?.name || "";
}

function getSessionStoreName(session = state.currentSession) {
  return session?.store_id ? getStoreName(session.store_id) : "No store";
}

function getEmployeeLabel(employee = {}) {
  return employee.display_name || employee.email || "Unnamed seller";
}

function getEmployeeById(id) {
  const needle = String(id || "");
  if (!needle) return null;
  return state.employees.find((employee) => String(employee.id) === needle) || null;
}

function getEmployeeSnapshotLabel(snapshot = {}) {
  return snapshot.display_name || snapshot.email || "";
}

function getEmployeeReferenceLabel(employeeId, snapshot = {}) {
  const fromDirectory = getEmployeeById(employeeId);
  if (fromDirectory) return getEmployeeLabel(fromDirectory);
  return getEmployeeSnapshotLabel(snapshot);
}

function getLotOwnerLabel(lot = state.currentLot) {
  if (!lot) return "";
  return getEmployeeReferenceLabel(lot.owner_employee_id, lot.owner_snapshot || {});
}

function getSessionSellerSummary(session = state.currentSession) {
  if (!session) return "";
  const primary = getEmployeeReferenceLabel(
    session.primary_seller_employee_id,
    session.seller_snapshot?.primary || {}
  );
  const coSellerIds = Array.isArray(session.co_seller_employee_ids) ? session.co_seller_employee_ids : [];
  const coSellerCount = coSellerIds.length;
  if (!primary && !coSellerCount) return "";
  return `${primary || "Main seller"}${coSellerCount ? ` + ${coSellerCount} more` : ""}`;
}

function getSelectedCoSellerIds() {
  const primaryId = $("session-primary-seller")?.value || "";
  return [...($("session-co-sellers")?.selectedOptions || [])]
    .map((option) => option.value)
    .filter(Boolean)
    .filter((id) => id !== primaryId);
}

function getSelectedBagOwnerId() {
  return $("bag-owner-select")?.value
    || $("label-bag-owner-select")?.value
    || state.currentLot?.owner_employee_id
    || state.currentSession?.primary_seller_employee_id
    || state.employee?.id
    || null;
}

function getSourceRole(source = {}) {
  if (source.is_tray || source.location_role === "tray") return "tray";
  if (source.location_role === "container") return "container";
  return "storage_location";
}

function getSourceKindLabel(source = {}) {
  if (source?.location_role === "manual" || source?.type === "manual") return "Manual";
  const role = getSourceRole(source);
  if (role === "tray") return "Tray";
  if (role === "container") return "Storage Container";
  return "Storage";
}

function getSourceKindClass(source = {}) {
  if (source?.location_role === "manual" || source?.type === "manual") return "is-manual";
  const role = getSourceRole(source);
  if (role === "tray") return "is-tray";
  if (role === "container") return "is-container";
  return "is-storage";
}

function normalizeManualLiveSaleItem(row = {}) {
  const category = String(row.item_category || "General").trim() || "General";
  const description = String(row.item_description || "").trim();
  return {
    ...row,
    is_manual: true,
    item_id: null,
    source_stock_location_row_id: null,
    source_location_id: null,
    scanned_at: row.created_at,
    scanned_by: row.created_by,
    scanned_by_email: row.created_by_email,
    item: {
      id: "",
      title: description || category,
      description,
      barcode: "Manual",
      photos: [],
      photo_url: "",
    },
    source_location: {
      id: "",
      location_name: "Manual entry",
      location_code: "",
      location_role: "manual",
      type: "manual",
    },
  };
}

function formatSessionTitleDate(value = new Date()) {
  const weekday = value.toLocaleDateString([], { weekday: "long" });
  const date = value.toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
  const time = value.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return `${weekday} ${date} ${time} eBay`;
}

function getLiveSalesStoreStorageKey() {
  return `og-live-sales-store:${state.user?.id || "anonymous"}`;
}

function getAuctionNumberStorageKey() {
  const selectedStoreId = $("session-store-select")?.value || "";
  const storeId = state.currentSession?.store_id || selectedStoreId || readSavedStoreId() || "no-store";
  return `og-live-sales-last-auction:${state.user?.id || "anonymous"}:${storeId}`;
}

function readSavedStoreId() {
  try {
    return localStorage.getItem(getLiveSalesStoreStorageKey()) || "";
  } catch (error) {
    console.warn("Could not read live sale store preference:", error);
    return "";
  }
}

function saveStoreId(storeId) {
  try {
    if (storeId) localStorage.setItem(getLiveSalesStoreStorageKey(), storeId);
  } catch (error) {
    console.warn("Could not save live sale store preference:", error);
  }
}

function readLastAuctionNumber() {
  try {
    return localStorage.getItem(getAuctionNumberStorageKey()) || "";
  } catch (error) {
    console.warn("Could not read live sale auction preference:", error);
    return "";
  }
}

function saveLastAuctionNumber(value) {
  try {
    const clean = String(value || "").trim();
    if (clean) localStorage.setItem(getAuctionNumberStorageKey(), clean);
  } catch (error) {
    console.warn("Could not save live sale auction preference:", error);
  }
}

function incrementAuctionNumber(value) {
  const clean = String(value || "").trim();
  if (!clean) return "1";
  const match = clean.match(/^(.*?)(\d+)$/);
  if (!match) return clean;
  const [, prefix, digits] = match;
  const nextNumber = String(Number(digits) + 1).padStart(digits.length, "0");
  return `${prefix}${nextNumber}`;
}

function getSuggestedStartingAuctionNumber() {
  return incrementAuctionNumber(readLastAuctionNumber());
}

function syncStartingAuctionSuggestion({ force = false } = {}) {
  const input = $("session-start-auction-number");
  if (!input || state.currentSession) return;

  const shouldUpdate = force || input.dataset.autoAuctionStart !== "false" || !input.value.trim();
  if (!shouldUpdate) return;

  input.value = getSuggestedStartingAuctionNumber();
  input.dataset.autoAuctionStart = "true";
}

function setFlowStep(step) {
  state.flowStep = step;
  renderFlowState();
}

function renderFlowState() {
  const hasSession = Boolean(state.currentSession);
  document.body.classList.toggle("live-session-active", hasSession);
  document.body.classList.toggle("live-label-step", hasSession && state.flowStep === "label");
  document.body.classList.toggle("live-scan-step", hasSession && state.flowStep !== "label");
}

function canManageLiveSales() {
  return Boolean(state.employee);
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
    .select("id, display_name, email, role, active")
    .eq("user_id", state.user.id)
    .maybeSingle();

  if (error || !employee || employee.active === false) {
    window.location.href = "index.html";
    return false;
  }

  state.employee = employee;
  return true;
}

async function loadSellerDirectory() {
  let data = [];
  let error = null;

  const rpcResult = await supabase.rpc("get_live_sale_seller_directory");
  if (rpcResult.error) {
    const fallback = await supabase
      .from("employees")
      .select("id, display_name, email, role, active")
      .eq("active", true)
      .order("display_name", { ascending: true });
    data = fallback.data || [];
    error = fallback.error;
  } else {
    data = rpcResult.data || [];
  }

  if (error) {
    console.warn("Live sale seller directory unavailable:", error);
    data = [];
  }

  const byId = new Map();
  [...data, state.employee].filter(Boolean).forEach((employee) => {
    if (!employee.id) return;
    byId.set(String(employee.id), {
      id: employee.id,
      display_name: employee.display_name || employee.email || "Unnamed seller",
      email: employee.email || "",
      role: employee.role || "",
      active: employee.active !== false,
    });
  });

  state.employees = [...byId.values()]
    .filter((employee) => employee.active !== false)
    .sort((a, b) => getEmployeeLabel(a).localeCompare(getEmployeeLabel(b)));
}

function setupShell() {
  const name = state.employee?.display_name ? `, ${state.employee.display_name}` : "";
  const greeting = $("live-sales-greeting");
  if (greeting) greeting.textContent = `Live Sales${name}`;

  document.querySelectorAll(".nav-link").forEach((link) => {
    const href = (link.getAttribute("href") || "").split("/").pop();
    link.classList.toggle("active", href === "live-sales.html");
  });

  document.querySelectorAll(".mobile-nav-links a").forEach((link) => {
    const href = (link.getAttribute("href") || "").split("/").pop();
    link.classList.toggle("active", href === "live-sales.html");
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

async function loadStores() {
  const select = $("session-store-select");
  if (select) select.disabled = true;

  let { data, error } = await supabase
    .from("store_locations")
    .select("id, name, active")
    .eq("active", true)
    .order("name", { ascending: true });

  if (!error && !data?.length) {
    const retry = await supabase
      .from("store_locations")
      .select("id, name, active")
      .order("name", { ascending: true });
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error("Live sale store load failed:", error);
    state.stores = [];
    setStatus("Could not load stores. Refresh or confirm this account can see store locations.", "error");
    renderStoreSelect();
    return;
  }

  state.stores = data || [];
  const saved = readSavedStoreId();
  if (!state.currentSession?.store_id && saved && state.stores.some((store) => store.id === saved)) {
    const storeSelect = $("session-store-select");
    if (storeSelect) storeSelect.value = saved;
  }
  renderStoreSelect();
}

function renderStoreSelect() {
  const select = $("session-store-select");
  if (!select) return;
  select.replaceChildren();

  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = state.stores.length ? "Select store" : "No stores found";
  select.appendChild(placeholder);

  state.stores.forEach((store) => {
    const option = document.createElement("option");
    option.value = store.id;
    option.textContent = store.name || "Unnamed store";
    select.appendChild(option);
  });

  const saved = readSavedStoreId();
  if (state.currentSession?.store_id) select.value = state.currentSession.store_id;
  else if (saved && state.stores.some((store) => store.id === saved)) select.value = saved;
  else if (state.stores.length === 1) select.value = state.stores[0].id;
  select.disabled = false;
  syncStartingAuctionSuggestion();
}

async function loadSessions({ keepSelection = true } = {}) {
  const { data, error } = await supabase
    .from("live_sale_sessions")
    .select("*")
    .eq("status", "active")
    .order("started_at", { ascending: false })
    .limit(20);

  if (error) {
    console.warn("Live sale session load failed:", error);
    state.sessions = [];
  } else {
    state.sessions = data || [];
  }

  if (keepSelection && state.currentSession) {
    const stillActive = state.sessions.find((session) => session.id === state.currentSession.id);
    state.currentSession = stillActive || state.sessions[0] || null;
  } else {
    state.currentSession = state.sessions[0] || null;
  }

  if (!state.currentSession) state.currentLot = null;
  setFlowStep(state.currentSession ? "scan" : "session");
  renderSessions();
  renderStoreSelect();
  await loadLotItems();
}

function renderSessions() {
  const list = $("active-session-list");
  if (list) {
    list.replaceChildren();
    if (!state.sessions.length) {
      list.innerHTML = `<div class="empty-state">No active live session yet.</div>`;
    } else {
      state.sessions.forEach((session) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `session-btn ${state.currentSession?.id === session.id ? "is-selected" : ""}`;
        button.innerHTML = `
          <span>
            <strong>${escapeHtml(session.title || "Live Sale")}</strong>
            <small>${escapeHtml(session.session_code || "")} - ${escapeHtml(getStoreName(session.store_id) || "No store")} - ${escapeHtml(formatDate(session.started_at))}</small>
            ${getSessionSellerSummary(session) ? `<small>Sellers: ${escapeHtml(getSessionSellerSummary(session))}</small>` : ""}
          </span>
          <b>Use</b>
        `;
        button.addEventListener("click", async () => {
          state.currentSession = session;
          state.currentLot = null;
          clearScan();
          setFlowStep("scan");
          renderAll();
          await loadLotItems();
          await prepareNextBag();
        });
        list.appendChild(button);
      });
    }
  }

  const pill = $("session-status-pill");
  if (pill) {
    pill.textContent = state.currentSession
      ? `${state.currentSession.session_code} - ${getSessionStoreName()}`
      : "No active show";
    pill.classList.toggle("is-active", Boolean(state.currentSession));
  }
}

function renderSummary() {
  $("summary-session").textContent = state.currentSession?.session_code || "None";
  $("summary-lot").textContent = state.currentLot?.auction_number || "None";
  $("summary-reserved").textContent = String(state.lotItems.reduce((sum, item) => (
    item.status === "reserved" ? sum + Number(item.quantity || 0) : sum
  ), 0));
}

function renderCurrentLot() {
  const card = $("current-lot-card");
  const pill = $("lot-status-pill");
  if (!card || !pill) return;

  if (!state.currentLot) {
    card.className = "current-lot-card empty";
    card.textContent = "Create a bag to begin scanning items.";
    pill.textContent = "No bag selected";
    pill.className = "status-pill";
    return;
  }

  card.className = "current-lot-card";
  const ownerLabel = getLotOwnerLabel() || "No owner selected";
  card.innerHTML = `
    <strong>Auction ${escapeHtml(state.currentLot.auction_number)}</strong>
    <span>Bag ID ${escapeHtml(state.currentLot.lot_code)} - ${escapeHtml(state.currentLot.status || "open")}</span>
    <span>Owner ${escapeHtml(ownerLabel)}</span>
    <small>
      ${state.currentLot.label_path
        ? `<button type="button" class="current-lot-label-btn" data-print-current-lot-label>Print DYMO label again</button>`
        : "DYMO label has not been generated yet."}
    </small>
  `;
  card.querySelector("[data-print-current-lot-label]")?.addEventListener("click", () => {
    printLiveSaleBagLabel(state.currentLot.id);
  });
  pill.textContent = state.currentLot.status === "packed" ? "Packed" : "Ready to scan";
  pill.className = `status-pill ${state.currentLot.status === "packed" ? "" : "is-ready"}`;
}

function updateScanGate() {
  const enabled = Boolean(
    state.currentSession
      && state.currentLot
      && state.currentLot.status !== "packed"
      && state.flowStep !== "label"
  );
  $("item-scan")?.toggleAttribute("disabled", !enabled);
  $("scan-item")?.toggleAttribute("disabled", !enabled);
  $("manual-live-item-category")?.toggleAttribute("disabled", !enabled);
  $("manual-live-item-quantity")?.toggleAttribute("disabled", !enabled);
  $("manual-live-item-description")?.toggleAttribute("disabled", !enabled);
  $("add-manual-live-item")?.toggleAttribute("disabled", !enabled || state.busy);
  $("generate-live-label")?.toggleAttribute("disabled", !state.currentLot || !getManifestGroups().length);
  $("cancel-lot")?.toggleAttribute("disabled", !state.currentLot || state.currentLot.status === "packed");
  $("open-bag-history")?.toggleAttribute("disabled", !state.currentSession || state.busy);
  $("cancel-session")?.toggleAttribute("disabled", !state.currentSession || state.busy);
  const ownerEnabled = Boolean(state.currentLot && state.currentLot.status !== "packed" && !state.busy);
  $("bag-owner-select")?.toggleAttribute("disabled", !ownerEnabled);
  $("label-bag-owner-select")?.toggleAttribute("disabled", !ownerEnabled);
}

function renderAll() {
  renderFlowState();
  renderSessions();
  renderSellerControls();
  renderSummary();
  renderCurrentLot();
  renderManifest();
  renderLabelReview();
  renderSelectedItem();
  renderSourceRows();
  updateScanGate();
  if (window.lucide) window.lucide.createIcons();
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
  if (error) return "";
  return data?.signedUrl || "";
}

function openLivePhotoModal(url, title = "Item preview") {
  const modal = $("live-photo-modal");
  const image = $("live-photo-modal-image");
  const label = $("live-photo-modal-title");
  if (!modal || !image) return;

  image.src = url;
  image.alt = title;
  if (label) label.textContent = title;
  setLivePhotoZoom(1);
  modal.hidden = false;
  document.body.classList.add("live-photo-open");
  $("live-photo-close")?.focus();
}

function setLivePhotoZoom(value) {
  state.photoZoom = Math.min(3, Math.max(1, Number(value) || 1));
  if (state.photoZoom <= 1) {
    state.photoPanX = 0;
    state.photoPanY = 0;
  }
  updateLivePhotoTransform();
}

function updateLivePhotoTransform() {
  const image = $("live-photo-modal-image");
  const zoomReadout = $("live-photo-zoom-readout");
  if (image) {
    image.style.transform = `translate(${state.photoPanX}px, ${state.photoPanY}px) scale(${state.photoZoom})`;
    image.classList.toggle("is-zoomed", state.photoZoom > 1);
    image.classList.toggle("is-dragging", Boolean(state.photoDrag));
  }
  if (zoomReadout) zoomReadout.textContent = `${Math.round(state.photoZoom * 100)}%`;
}

function closeLivePhotoModal() {
  const modal = $("live-photo-modal");
  const image = $("live-photo-modal-image");
  if (!modal) return;
  modal.hidden = true;
  if (image) image.removeAttribute("src");
  state.photoPanX = 0;
  state.photoPanY = 0;
  state.photoDrag = null;
  setLivePhotoZoom(1);
  document.body.classList.remove("live-photo-open");
}

function startLivePhotoDrag(event) {
  if (state.photoZoom <= 1) return;
  event.preventDefault();
  const image = $("live-photo-modal-image");
  state.photoDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: state.photoPanX,
    originY: state.photoPanY,
    didMove: false,
  };
  image?.setPointerCapture?.(event.pointerId);
  updateLivePhotoTransform();
}

function moveLivePhotoDrag(event) {
  if (!state.photoDrag || state.photoDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  const deltaX = event.clientX - state.photoDrag.startX;
  const deltaY = event.clientY - state.photoDrag.startY;
  if (Math.abs(deltaX) > 3 || Math.abs(deltaY) > 3) state.photoDrag.didMove = true;
  state.photoPanX = state.photoDrag.originX + deltaX;
  state.photoPanY = state.photoDrag.originY + deltaY;
  updateLivePhotoTransform();
}

function endLivePhotoDrag(event) {
  if (!state.photoDrag || state.photoDrag.pointerId !== event.pointerId) return;
  $("live-photo-modal-image")?.releasePointerCapture?.(event.pointerId);
  state.photoSuppressClick = Boolean(state.photoDrag.didMove);
  state.photoDrag = null;
  updateLivePhotoTransform();
  if (state.photoSuppressClick) {
    setTimeout(() => {
      state.photoSuppressClick = false;
    }, 0);
  }
}

async function loadLotItems() {
  if (!state.currentLot) {
    state.lotItems = [];
    state.lotSourceAvailability = new Map();
    renderAll();
    return;
  }

  const [inventoryResult, manualResult] = await Promise.all([
    supabase
      .from("live_sale_lot_items")
      .select(`
        *,
        item:item_id(id,title,description,barcode,weight,sale_price,photos,photo_url),
        source_location:source_location_id(id,location_name,location_code,store_id,tray_current_store_id,is_tray,location_role,type,parent_location_id)
      `)
      .eq("lot_id", state.currentLot.id)
      .order("scanned_at", { ascending: true }),
    supabase
      .from("live_sale_manual_lot_items")
      .select("*")
      .eq("lot_id", state.currentLot.id)
      .order("created_at", { ascending: true }),
  ]);

  if (inventoryResult.error || manualResult.error) {
    console.warn("Live sale lot items failed to load:", inventoryResult.error || manualResult.error);
    state.lotItems = [];
    state.lotSourceAvailability = new Map();
  } else {
    state.lotItems = [
      ...(inventoryResult.data || []),
      ...(manualResult.data || []).map(normalizeManualLiveSaleItem),
    ].sort((a, b) => new Date(a.scanned_at || a.created_at || 0) - new Date(b.scanned_at || b.created_at || 0));
    await loadLotSourceAvailability();
  }

  renderAll();
}

async function loadLotSourceAvailability() {
  const reservedItems = state.lotItems.filter((entry) =>
    entry.status === "reserved" && entry.source_stock_location_row_id
  );
  const currentBySource = new Map();
  reservedItems.forEach((entry) => {
    const sourceId = entry.source_stock_location_row_id;
    const current = currentBySource.get(sourceId) || {
      itemId: entry.item_id,
      quantity: 0,
    };
    current.quantity += Number(entry.quantity || 0);
    currentBySource.set(sourceId, current);
  });

  state.lotSourceAvailability = new Map();
  const sourceIds = [...currentBySource.keys()];
  if (!sourceIds.length) return;

  try {
    const [{ data: rows, error: rowError }, { data: reservations, error: reservationError }] = await Promise.all([
      supabase
        .from("item_stock_locations")
        .select("id,item_id,quantity")
        .in("id", sourceIds),
      supabase
        .from("active_stock_reservations")
        .select("stock_location_row_id,reserved_quantity")
        .in("stock_location_row_id", sourceIds),
    ]);

    if (rowError) throw rowError;
    const hasReservationOverlay = !reservationError;
    if (reservationError) console.warn("Live-sale availability overlay failed:", reservationError);

    const reservationMap = new Map((reservations || []).map((entry) => [
      entry.stock_location_row_id,
      Number(entry.reserved_quantity || 0),
    ]));

    (rows || []).forEach((row) => {
      const current = currentBySource.get(row.id)?.quantity || 0;
      const reserved = reservationMap.get(row.id) || 0;
      const physical = Number(row.quantity || 0);
      const maxQuantity = hasReservationOverlay
        ? Math.max(current, physical - reserved + current)
        : current;
      state.lotSourceAvailability.set(row.id, {
        currentQuantity: current,
        physicalQuantity: physical,
        reservedQuantity: reserved,
        maxQuantity,
        availableExtra: Math.max(0, maxQuantity - current),
      });
    });

    currentBySource.forEach((current, sourceId) => {
      if (!state.lotSourceAvailability.has(sourceId)) {
        state.lotSourceAvailability.set(sourceId, {
          currentQuantity: current.quantity,
          physicalQuantity: current.quantity,
          reservedQuantity: current.quantity,
          maxQuantity: current.quantity,
          availableExtra: 0,
        });
      }
    });
  } catch (error) {
    console.warn("Live-sale source capacity could not be checked:", error);
    currentBySource.forEach((current, sourceId) => {
      state.lotSourceAvailability.set(sourceId, {
        currentQuantity: current.quantity,
        physicalQuantity: current.quantity,
        reservedQuantity: current.quantity,
        maxQuantity: current.quantity,
        availableExtra: 0,
      });
    });
  }
}

function renderManifest() {
  const list = $("lot-manifest");
  if (!list) return;
  list.replaceChildren();

  if (!state.currentLot) {
    list.innerHTML = `<div class="empty-state">No bag selected.</div>`;
    return;
  }

  if (!state.lotItems.length) {
    list.innerHTML = `<div class="empty-state">This bag has no reserved items yet.</div>`;
    return;
  }

  const activeGroups = getManifestGroups();
  if (!activeGroups.length) {
    list.innerHTML = `<div class="empty-state">This bag has no reserved items yet.</div>`;
    return;
  }

  activeGroups.forEach((group) => {
    const item = group.item || {};
    const maxQuantity = Math.max(Number(group.maxQuantity || 0), Number(group.quantity || 0));
    const canIncrease = Number(group.quantity || 0) < maxQuantity;
    const article = document.createElement("article");
    article.className = `manifest-item${group.isManual ? " is-manual" : ""}`;
    article.innerHTML = `
      <div class="manifest-thumb"><span>${group.isManual ? "Manual" : "No photo"}</span></div>
      <div class="manifest-copy">
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <span>${renderManifestSourceSummary(group)}</span>
        ${renderManifestTimeNote(group)}
        ${renderManifestSourceBreakdown(group)}
      </div>
      <div class="manifest-actions">
        <div class="manifest-qty-control" aria-label="Quantity for ${escapeHtml(item.title || "item")}">
          <button type="button" class="tiny-btn" data-qty-action="decrease" data-group-key="${escapeHtml(group.key)}">-</button>
          <input class="manifest-qty-input" data-manifest-qty-input data-group-key="${escapeHtml(group.key)}" type="number" min="0" max="${maxQuantity}" step="1" value="${Number(group.quantity || 0)}" title="Maximum available for the selected source(s): ${maxQuantity}" />
          <button type="button" class="tiny-btn" data-qty-action="increase" data-group-key="${escapeHtml(group.key)}" ${canIncrease ? "" : "disabled"}>+</button>
        </div>
        <small class="manifest-max-note">${group.isManual ? "Counts only" : `Max ${maxQuantity.toLocaleString()}`}</small>
        ${group.isManual ? "" : `<button type="button" class="tiny-btn" data-edit-group="${escapeHtml(group.key)}">Edit</button>`}
        <button type="button" class="tiny-btn" data-release-group="${escapeHtml(group.key)}">Release</button>
      </div>
    `;
    list.appendChild(article);
    resolvePhotoUrl(firstItemPhoto(item)).then((url) => {
      if (!url || !article.isConnected) return;
      const thumb = article.querySelector(".manifest-thumb");
      if (thumb) {
        thumb.innerHTML = `<button type="button" class="manifest-thumb-btn" aria-label="Open ${escapeHtml(item.title || "reserved item")} image"><img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Reserved item")}" /></button>`;
        thumb.querySelector("button")?.addEventListener("click", () => {
          openLivePhotoModal(url, item.title || "Reserved item");
        });
      }
    });
  });

  list.querySelectorAll("[data-qty-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = getManifestGroupByKey(button.getAttribute("data-group-key"));
      if (!group) return;
      const direction = button.getAttribute("data-qty-action") === "increase" ? 1 : -1;
      const nextQuantity = Math.max(0, group.quantity + direction);
      if (direction > 0 && nextQuantity > Number(group.maxQuantity || group.quantity || 0)) {
        setStatus(`Only ${Number(group.maxQuantity || group.quantity || 0).toLocaleString()} unit(s) are available for this item in the selected source(s).`, "error");
        return;
      }
      setManifestGroupQuantity(group, nextQuantity);
    });
  });

  list.querySelectorAll("[data-manifest-qty-input]").forEach((input) => {
    const commit = () => {
      const group = getManifestGroupByKey(input.getAttribute("data-group-key"));
      if (!group) return;
      const value = Math.max(0, parseInt(input.value || "0", 10) || 0);
      const maxQuantity = Number(group.maxQuantity || group.quantity || 0);
      if (value > maxQuantity) {
        input.value = String(group.quantity || 0);
        setStatus(`Only ${maxQuantity.toLocaleString()} unit(s) are available for this item in the selected source(s).`, "error");
        return;
      }
      if (value !== group.quantity) setManifestGroupQuantity(group, value);
    };
    input.addEventListener("change", commit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        commit();
        focusItemScanner();
      }
    });
  });

  list.querySelectorAll("[data-release-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = getManifestGroupByKey(button.getAttribute("data-release-group"));
      if (group) releaseManifestGroup(group);
    });
  });

  list.querySelectorAll("[data-edit-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = getManifestGroupByKey(button.getAttribute("data-edit-group"));
      if (group) openEditBagItemModal(group);
    });
  });
}

function getManifestGroups() {
  const groups = new Map();
  state.lotItems
    .filter((entry) => entry.status === "reserved")
    .forEach((entry) => {
      if (entry.is_manual) {
        const category = String(entry.item_category || "General").trim() || "General";
        const description = String(entry.item_description || "").trim();
        const key = `manual:${category.toLowerCase()}::${description.toLowerCase()}`;
        const quantity = Number(entry.quantity || 0);
        const elapsed = Number(entry.show_elapsed_seconds ?? 0);
        if (!groups.has(key)) {
          groups.set(key, {
            key,
            itemId: "",
            isManual: true,
            manualCategory: category,
            manualDescription: description,
            item: entry.item || { title: description || category, barcode: "Manual" },
            quantity: 0,
            showElapsedSeconds: elapsed,
            lastShowElapsedSeconds: elapsed,
            sourcesByKey: new Map(),
          });
        }
        const group = groups.get(key);
        group.quantity += quantity;
        group.showElapsedSeconds = Math.min(Number(group.showElapsedSeconds ?? elapsed), elapsed);
        group.lastShowElapsedSeconds = Math.max(Number(group.lastShowElapsedSeconds ?? elapsed), elapsed);
        if (!group.sourcesByKey.has("manual")) {
          group.sourcesByKey.set("manual", {
            key: "manual",
            sourceStockLocationRowId: "",
            sourceLocation: entry.source_location || {},
            quantity: 0,
            showElapsedSeconds: elapsed,
            lastShowElapsedSeconds: elapsed,
            maxQuantity: 9999,
            availableExtra: 9999,
          });
        }
        const source = group.sourcesByKey.get("manual");
        source.quantity += quantity;
        return;
      }
      const itemId = entry.item_id || entry.item?.id || "";
      const sourceRowId = entry.source_stock_location_row_id || "";
      const sourceKey = sourceRowId || entry.source_location_id || "unknown";
      const key = itemId || entry.item?.barcode || entry.item?.title || sourceKey;
      const quantity = Number(entry.quantity || 0);
      const elapsed = Number(entry.show_elapsed_seconds ?? 0);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          itemId,
          item: entry.item || {},
          quantity: 0,
          showElapsedSeconds: elapsed,
          lastShowElapsedSeconds: elapsed,
          sourcesByKey: new Map(),
        });
      }
      const group = groups.get(key);
      group.quantity += quantity;
      group.showElapsedSeconds = Math.min(
        Number(group.showElapsedSeconds ?? elapsed),
        elapsed,
      );
      group.lastShowElapsedSeconds = Math.max(
        Number(group.lastShowElapsedSeconds ?? elapsed),
        elapsed,
      );

      if (!group.sourcesByKey.has(sourceKey)) {
        const capacity = sourceRowId ? state.lotSourceAvailability.get(sourceRowId) : null;
        group.sourcesByKey.set(sourceKey, {
          key: sourceKey,
          sourceStockLocationRowId: sourceRowId,
          sourceLocation: entry.source_location || {},
          quantity: 0,
          showElapsedSeconds: elapsed,
          lastShowElapsedSeconds: elapsed,
          maxQuantity: capacity?.maxQuantity ?? 0,
          availableExtra: capacity?.availableExtra ?? 0,
        });
      }
      const source = group.sourcesByKey.get(sourceKey);
      source.quantity += quantity;
      source.showElapsedSeconds = Math.min(Number(source.showElapsedSeconds ?? elapsed), elapsed);
      source.lastShowElapsedSeconds = Math.max(Number(source.lastShowElapsedSeconds ?? elapsed), elapsed);
      if (!source.maxQuantity || source.maxQuantity < source.quantity) {
        source.maxQuantity = source.quantity;
      }
    });
  return Array.from(groups.values()).map((group) => {
    const sources = [...group.sourcesByKey.values()].map((source) => ({
      ...source,
      maxQuantity: Math.max(Number(source.maxQuantity || 0), Number(source.quantity || 0)),
    }));
    const maxQuantity = sources.reduce((sum, source) => sum + Number(source.maxQuantity || source.quantity || 0), 0);
    return {
      ...group,
      sources,
      sourceLocation: sources[0]?.sourceLocation || {},
      sourceStockLocationRowId: sources[0]?.sourceStockLocationRowId || "",
      maxQuantity: Math.max(maxQuantity, Number(group.quantity || 0)),
      scanSpanSeconds: Math.max(0, Number(group.lastShowElapsedSeconds || 0) - Number(group.showElapsedSeconds || 0)),
      sourcesByKey: undefined,
    };
  });
}

function getManifestGroupByKey(key) {
  return getManifestGroups().find((group) => group.key === key) || null;
}

function getSourceLocationLabel(source = {}) {
  const loc = source.sourceLocation || source;
  const sourceKind = getSourceKindLabel(loc);
  const name = loc.location_name || "Unknown source";
  const code = loc.location_code ? ` (${loc.location_code})` : "";
  return `${sourceKind}: ${name}${code}`;
}

function renderManifestSourceSummary(group) {
  if (group?.isManual) {
    const description = group.manualDescription ? ` - ${group.manualDescription}` : "";
    return `<b class="source-kind-badge is-manual">Manual</b> ${escapeHtml(group.manualCategory || "General")}${escapeHtml(description)}`;
  }
  const sources = group.sources || [];
  const item = group.item || {};
  if (sources.length <= 1) {
    const source = sources[0] || {};
    const loc = source.sourceLocation || {};
    const sourceKind = getSourceKindLabel(loc);
    return `<b class="source-kind-badge ${getSourceKindClass(loc)}">${escapeHtml(sourceKind)}</b> ${escapeHtml(item.barcode || "-")} - ${escapeHtml(loc.location_name || "Unknown source")} ${loc.location_code ? `(${escapeHtml(loc.location_code)})` : ""}`;
  }

  return `${escapeHtml(item.barcode || "-")} - ${sources.length} sources combined`;
}

function renderManifestSourceBreakdown(group, { showMax = true } = {}) {
  if (group?.isManual) return "";
  const sources = group.sources || [];
  if (sources.length <= 1) return "";
  return `
    <div class="manifest-source-breakdown">
      ${sources.map((source) => {
        const loc = source.sourceLocation || {};
        const sourceKind = getSourceKindLabel(loc);
        return `
          <span>
            <b class="source-kind-badge ${getSourceKindClass(loc)}">${escapeHtml(sourceKind)}</b>
            ${escapeHtml(loc.location_name || "Unknown source")} ${loc.location_code ? `(${escapeHtml(loc.location_code)})` : ""}
            <strong>Qty ${Number(source.quantity || 0).toLocaleString()}${showMax ? ` / max ${Number(source.maxQuantity || source.quantity || 0).toLocaleString()}` : ""}</strong>
          </span>
        `;
      }).join("")}
    </div>
  `;
}

function renderManifestTimeNote(group) {
  const first = Number(group.showElapsedSeconds || 0);
  const last = Number(group.lastShowElapsedSeconds || first);
  const span = Math.max(0, last - first);
  if (span > 600) {
    const minutes = Math.round(span / 60);
    return `<small class="manifest-time-note is-alert">Live minutes ${escapeHtml(formatElapsed(first))}-${escapeHtml(formatElapsed(last))} - scans ${minutes} min apart; verify this belongs in the same auction bag.</small>`;
  }
  return `<small class="manifest-time-note">Live minute ${escapeHtml(formatElapsed(first))}</small>`;
}

function planManifestGroupQuantities(group, targetQuantity) {
  const sources = (group.sources || [])
    .filter((source) => source.sourceStockLocationRowId)
    .map((source) => ({
      ...source,
      quantity: Number(source.quantity || 0),
      maxQuantity: Math.max(Number(source.maxQuantity || 0), Number(source.quantity || 0)),
      nextQuantity: 0,
    }))
    .sort((a, b) => Number(a.showElapsedSeconds || 0) - Number(b.showElapsedSeconds || 0));

  if (!sources.length) return null;

  let remaining = Math.max(0, Number(targetQuantity || 0));
  sources.forEach((source) => {
    const keep = Math.min(source.quantity, remaining);
    source.nextQuantity = keep;
    remaining -= keep;
  });

  if (remaining > 0) {
    sources.forEach((source) => {
      if (remaining <= 0) return;
      const extraCapacity = Math.max(0, source.maxQuantity - source.nextQuantity);
      const added = Math.min(extraCapacity, remaining);
      source.nextQuantity += added;
      remaining -= added;
    });
  }

  if (remaining > 0) return null;
  return sources.filter((source) => source.nextQuantity !== source.quantity);
}

function setEditBagError(message = "") {
  const el = $("edit-bag-error");
  if (el) el.textContent = message;
}

function closeEditBagItemModal() {
  const modal = $("edit-bag-item-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  state.editGroup = null;
  state.editLot = null;
  state.editReplacementItem = null;
  state.editSourceRows = [];
  state.editSelectedSourceRow = null;
  setEditBagError("");
  setTimeout(() => focusItemScanner(), 80);
}

function openEditBagItemModal(group, lot = state.currentLot) {
  if (!group || !lot) return;
  state.editGroup = group;
  state.editLot = lot;
  state.editReplacementItem = null;
  state.editSourceRows = [];
  state.editSelectedSourceRow = null;
  setEditBagError("");

  const modal = $("edit-bag-item-modal");
  if (!modal) return;
  $("edit-bag-reason").value = "";
  $("edit-bag-quantity").value = String(Number(group.quantity || 0));
  $("edit-bag-quantity").max = String(Math.max(Number(group.maxQuantity || 0), Number(group.quantity || 0)));
  $("edit-bag-replacement-scan").value = "";
  renderEditBagCurrent();
  renderEditReplacementResults([]);
  renderEditSourceRows();
  modal.hidden = false;
  setTimeout(() => $("edit-bag-reason")?.focus(), 80);
}

function renderEditBagCurrent() {
  const card = $("edit-bag-current");
  const group = state.editGroup;
  if (!card || !group) return;
  const item = group.item || {};
  card.innerHTML = `
    <span class="eyebrow">Current Bag Item</span>
    <strong>${escapeHtml(item.title || "Untitled item")}</strong>
    <span>${renderManifestSourceSummary(group)}</span>
    ${renderManifestTimeNote(group)}
    ${renderManifestSourceBreakdown(group)}
    <small>Current quantity ${Number(group.quantity || 0).toLocaleString()} / max ${Number(group.maxQuantity || group.quantity || 0).toLocaleString()}</small>
  `;
}

async function searchLiveSaleItems(term) {
  const clean = sanitizeSearchTerm(term);
  if (!clean) return [];

  let exact = await supabase
    .from("item_types")
    .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
    .eq("barcode", clean)
    .is("deleted_at", null)
    .limit(1);

  if (exact.error && /deleted_at/i.test(exact.error.message || "")) {
    exact = await supabase
      .from("item_types")
      .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
      .eq("barcode", clean)
      .limit(1);
  }

  if (!exact.error && exact.data?.length === 1) return exact.data;

  const pattern = `%${clean}%`;
  let { data, error } = await supabase
    .from("item_types")
    .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
    .or(`barcode.ilike.${pattern},title.ilike.${pattern},description.ilike.${pattern}`)
    .is("deleted_at", null)
    .limit(10);

  if (error && /deleted_at/i.test(error.message || "")) {
    const retry = await supabase
      .from("item_types")
      .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
      .or(`barcode.ilike.${pattern},title.ilike.${pattern},description.ilike.${pattern}`)
      .limit(10);
    data = retry.data;
    error = retry.error;
  }

  if (error) throw error;
  return data || [];
}

function renderEditReplacementResults(items = []) {
  const container = $("edit-bag-replacement-results");
  if (!container) return;
  container.replaceChildren();

  if (state.editReplacementItem) {
    const item = state.editReplacementItem;
    const selected = document.createElement("article");
    selected.className = "edit-result-btn is-selected";
    selected.innerHTML = `
      <div class="edit-result-thumb"><span>No photo</span></div>
      <div class="edit-result-copy">
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <small>${escapeHtml(item.barcode || "-")} - ${Number(item.weight || 0).toFixed(2)} g</small>
      </div>
      <span class="edit-result-meta">Replacement selected</span>
    `;
    container.appendChild(selected);
    hydrateEditResultPhoto(selected, item);
    return;
  }

  if (!items.length) return;
  items.forEach((item) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "edit-result-btn";
    button.innerHTML = `
      <div class="edit-result-thumb"><span>No photo</span></div>
      <div class="edit-result-copy">
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <small>${escapeHtml(item.barcode || "-")} - ${Number(item.weight || 0).toFixed(2)} g</small>
      </div>
      <span class="edit-result-meta">Use</span>
    `;
    button.addEventListener("click", () => selectEditReplacementItem(item));
    container.appendChild(button);
    hydrateEditResultPhoto(button, item);
  });
}

function hydrateEditResultPhoto(container, item) {
  const thumb = container.querySelector(".edit-result-thumb");
  if (!thumb) return;
  resolvePhotoUrl(firstItemPhoto(item)).then((url) => {
    if (!url || !thumb.isConnected) return;
    thumb.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Item preview")}" />`;
  });
}

async function findEditReplacementItem() {
  const term = $("edit-bag-replacement-scan")?.value || "";
  const clean = sanitizeSearchTerm(term);
  if (!clean) {
    setEditBagError("Scan or type the replacement item barcode first.");
    return;
  }

  try {
    setEditBagError("");
    const results = await searchLiveSaleItems(clean);
    if (!results.length) {
      renderEditReplacementResults([]);
      setEditBagError("No inventory item matched that replacement scan.");
      return;
    }
    if (results.length === 1) {
      await selectEditReplacementItem(results[0]);
      return;
    }
    renderEditReplacementResults(results);
    setEditBagError(`${results.length} items matched. Choose the correct replacement.`);
  } catch (error) {
    console.error("Replacement item search failed:", error);
    setEditBagError(error.message || "Could not search replacement item.");
  }
}

async function selectEditReplacementItem(item) {
  state.editReplacementItem = item;
  state.editSourceRows = [];
  state.editSelectedSourceRow = null;
  renderEditReplacementResults([]);
  await loadEditSourceRowsForItem(item);
}

function normalizeSourceRowWithReservations(row, reservationMap) {
  const previous = state.sourceReservations;
  state.sourceReservations = reservationMap;
  const normalized = normalizeSourceRow(row);
  state.sourceReservations = previous;
  return normalized;
}

async function loadEditSourceRowsForItem(item) {
  if (!item?.id) return;
  const sourceContainer = $("edit-bag-source-results");
  if (sourceContainer) sourceContainer.innerHTML = `<div class="empty-state">Loading replacement sources...</div>`;

  try {
    const [{ data: rows, error: rowError }, { data: reservations, error: reservationError }] = await Promise.all([
      supabase
        .from("item_stock_locations")
        .select("id,item_id,location_id,quantity,location:location_id(*)")
        .eq("item_id", item.id)
        .gt("quantity", 0),
      supabase
        .from("active_stock_reservations")
        .select("stock_location_row_id,reserved_quantity")
        .eq("item_id", item.id),
    ]);

    if (rowError) throw rowError;
    if (reservationError) console.warn("Replacement reservation overlay not available:", reservationError);

    const reservationMap = new Map((reservations || []).map((entry) => [
      entry.stock_location_row_id,
      Number(entry.reserved_quantity || 0),
    ]));
    const sessionStoreId = state.currentSession?.store_id || "";
    const eligibleRows = (rows || [])
      .map((row) => normalizeSourceRowWithReservations(row, reservationMap))
      .filter((row) => {
        const inStore = !sessionStoreId || row.store_id === sessionStoreId;
        const validTray = row.isTray && row.tray_status !== "checked_out";
        const validStorage = !row.isTray && ["storage_location", "container"].includes(row.source_role);
        return inStore && (validTray || validStorage) && row.available_quantity > 0;
      });

    const trayRows = eligibleRows.filter((row) => row.isTray);
    const storageRows = eligibleRows.filter((row) => !row.isTray);
    state.editSourceRows = trayRows.length ? trayRows : storageRows;
    state.editSelectedSourceRow = state.editSourceRows.length === 1 ? state.editSourceRows[0] : null;
    if (state.editSelectedSourceRow) {
      const quantity = $("edit-bag-quantity");
      if (quantity) {
        const available = Number(state.editSelectedSourceRow.available_quantity || 0);
        quantity.max = String(available);
        if (Number(quantity.value || 0) > available) quantity.value = String(available);
      }
    }
    renderEditSourceRows();
  } catch (error) {
    console.error("Replacement source load failed:", error);
    state.editSourceRows = [];
    state.editSelectedSourceRow = null;
    renderEditSourceRows();
    setEditBagError(error.message || "Could not load replacement sources.");
  }
}

function renderEditSourceRows() {
  const container = $("edit-bag-source-results");
  if (!container) return;
  container.replaceChildren();

  if (!state.editReplacementItem) return;

  if (!state.editSourceRows.length) {
    container.innerHTML = `<div class="empty-state">No available source found for the replacement item in this live-sale store.</div>`;
    return;
  }

  state.editSourceRows.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `edit-result-btn ${state.editSelectedSourceRow?.id === row.id ? "is-selected" : ""}`;
    button.innerHTML = `
      <div class="edit-result-thumb"><span>${escapeHtml(row.source_kind_label || "Source")}</span></div>
      <div class="edit-result-copy">
        <strong>${escapeHtml(row.locationLabel || "Unknown source")}</strong>
        <small>${Number(row.available_quantity || 0).toLocaleString()} available after ${Number(row.reserved_quantity || 0).toLocaleString()} reserved</small>
      </div>
      <span class="edit-result-meta">${state.editSelectedSourceRow?.id === row.id ? "Selected" : "Select"}</span>
    `;
    button.addEventListener("click", () => {
      state.editSelectedSourceRow = row;
      const quantity = $("edit-bag-quantity");
      if (quantity) {
        const available = Number(row.available_quantity || 0);
        quantity.max = String(available);
        if (Number(quantity.value || 0) > available) quantity.value = String(available);
      }
      renderEditSourceRows();
    });
    container.appendChild(button);
  });
}

function clearEditReplacement() {
  state.editReplacementItem = null;
  state.editSourceRows = [];
  state.editSelectedSourceRow = null;
  if ($("edit-bag-replacement-scan")) $("edit-bag-replacement-scan").value = "";
  if (state.editGroup && $("edit-bag-quantity")) {
    $("edit-bag-quantity").max = String(Math.max(Number(state.editGroup.maxQuantity || 0), Number(state.editGroup.quantity || 0)));
  }
  renderEditReplacementResults([]);
  renderEditSourceRows();
  setEditBagError("");
}

async function recordLiveBagCorrectionEvent(payload) {
  const lot = state.editLot || state.currentLot;
  try {
    const { error } = await supabase
      .from("live_sale_events")
      .insert({
        session_id: state.currentSession?.id || lot?.session_id || null,
        lot_id: lot?.id || null,
        item_id: payload?.old_item_id || payload?.new_item_id || null,
        event_type: "bag_item_corrected",
        actor_email: state.user?.email || null,
        notes: payload?.reason || null,
        payload,
      });
    if (error) throw error;
  } catch (error) {
    console.warn("Could not write live bag correction event:", error);
  }
}

async function applyEditBagCorrection() {
  const group = state.editGroup;
  const lot = state.editLot || state.currentLot;
  if (!group || !lot || state.busy) return;

  const reason = String($("edit-bag-reason")?.value || "").trim();
  const quantity = Math.max(0, parseInt(String($("edit-bag-quantity")?.value || "0"), 10) || 0);
  if (reason.length < 3) {
    setEditBagError("A brief correction explanation is required.");
    $("edit-bag-reason")?.focus();
    return;
  }

  if (state.editReplacementItem) {
    if (!state.editSelectedSourceRow) {
      setEditBagError("Choose the source tray or storage for the replacement item.");
      return;
    }
    if (quantity <= 0) {
      setEditBagError("Replacement quantity must be at least 1.");
      return;
    }
    if (quantity > Number(state.editSelectedSourceRow.available_quantity || 0)) {
      setEditBagError(`Only ${state.editSelectedSourceRow.available_quantity} replacement unit(s) are available at that source.`);
      return;
    }
  } else {
    const maxQuantity = Math.max(Number(group.maxQuantity || 0), Number(group.quantity || 0));
    if (quantity > maxQuantity) {
      setEditBagError(`Only ${maxQuantity.toLocaleString()} unit(s) are available for this item in the selected source(s).`);
      return;
    }
  }

  try {
    state.busy = true;
    const confirmButton = $("edit-bag-confirm");
    if (confirmButton) confirmButton.disabled = true;
    setEditBagError("");

    const oldItem = group.item || {};
    if (state.editReplacementItem) {
      const { error } = await supabase.rpc("correct_live_sale_lot_item_group", {
        _lot_id: lot.id,
        _old_item_id: group.itemId,
        _new_item_barcode: state.editReplacementItem.barcode,
        _new_stock_location_row_id: state.editSelectedSourceRow.id,
        _quantity: quantity,
        _notes: reason,
        _signed_by_email: state.user?.email || null,
      });
      if (error) throw error;
      await bumpInventoryVersion([group.itemId, state.editReplacementItem.id].filter(Boolean));
    } else {
      const changed = await saveManifestGroupQuantity(group, quantity, `Live bag correction: ${reason}`, lot);
      if (changed) {
        if (group.itemId) await bumpInventoryVersion([group.itemId]);
        await recordLiveBagCorrectionEvent({
          action: "quantity_correction",
          reason,
          old_item_id: group.itemId,
          old_item_title: oldItem.title || null,
          old_barcode: oldItem.barcode || null,
          previous_quantity: Number(group.quantity || 0),
          new_quantity: quantity,
          sources: (group.sources || []).map((source) => ({
            source_stock_location_row_id: source.sourceStockLocationRowId,
            source_location_id: source.sourceLocation?.id || null,
            source_label: getSourceLocationLabel(source),
            quantity: source.quantity,
          })),
        });
      }
    }

    closeEditBagItemModal();
    if (String(state.currentLot?.id || "") === String(lot.id)) {
      await reloadCurrentLot();
      await loadLotItems();
    }
    if (!$("bag-history-modal")?.hidden || String(state.bagHistorySelectedLotId || "") === String(lot.id)) {
      await loadBagHistory();
    }
    setStatus("Bag correction saved and documented.", "success");
  } catch (error) {
    console.error("Live bag correction failed:", error);
    setEditBagError(error.message || "Could not apply that bag correction.");
  } finally {
    state.busy = false;
    const confirmButton = $("edit-bag-confirm");
    if (confirmButton) confirmButton.disabled = false;
  }
}

function getBagStatusClass(status = "") {
  const clean = String(status || "").toLowerCase();
  if (clean === "packed") return "is-packed";
  if (clean === "cancelled" || clean === "released") return "is-cancelled";
  return "";
}

function getBagHistoryItemsForLot(lotId) {
  return state.bagHistoryItems.filter((entry) => String(entry.lot_id) === String(lotId));
}

function getBagHistoryGroups(lotId) {
  const groups = new Map();
  getBagHistoryItemsForLot(lotId).forEach((entry) => {
    if (entry.is_manual) {
      const category = String(entry.item_category || "General").trim() || "General";
      const description = String(entry.item_description || "").trim();
      const status = entry.status || "reserved";
      const key = `manual:${category.toLowerCase()}::${description.toLowerCase()}::${status}`;
      const quantity = Number(entry.quantity || 0);
      const elapsed = Number(entry.show_elapsed_seconds ?? 0);
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          itemId: "",
          isManual: true,
          manualCategory: category,
          manualDescription: description,
          item: entry.item || { title: description || category, barcode: "Manual" },
          status,
          quantity: 0,
          showElapsedSeconds: elapsed,
          lastShowElapsedSeconds: elapsed,
          scannedAt: entry.scanned_at,
          sourcesByKey: new Map(),
        });
      }
      const group = groups.get(key);
      group.quantity += quantity;
      group.showElapsedSeconds = Math.min(Number(group.showElapsedSeconds ?? elapsed), elapsed);
      group.lastShowElapsedSeconds = Math.max(Number(group.lastShowElapsedSeconds ?? elapsed), elapsed);
      if (!group.sourcesByKey.has("manual")) {
        group.sourcesByKey.set("manual", {
          key: "manual",
          sourceStockLocationRowId: "",
          sourceLocation: entry.source_location || {},
          quantity: 0,
          showElapsedSeconds: elapsed,
          lastShowElapsedSeconds: elapsed,
          maxQuantity: 0,
        });
      }
      const source = group.sourcesByKey.get("manual");
      source.quantity += quantity;
      source.maxQuantity = source.quantity;
      return;
    }
    const itemId = entry.item_id || entry.item?.id || "";
    const sourceRowId = entry.source_stock_location_row_id || "";
    const sourceKey = sourceRowId || entry.source_location_id || "unknown";
    const status = entry.status || "reserved";
    const key = `${itemId || entry.item?.barcode || entry.item?.title || sourceKey}::${status}`;
    const quantity = Number(entry.quantity || 0);
    const elapsed = Number(entry.show_elapsed_seconds ?? 0);
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        itemId,
        item: entry.item || {},
        status,
        quantity: 0,
        showElapsedSeconds: elapsed,
        lastShowElapsedSeconds: elapsed,
        scannedAt: entry.scanned_at,
        sourcesByKey: new Map(),
      });
    }
    const group = groups.get(key);
    group.quantity += quantity;
    group.showElapsedSeconds = Math.min(
      Number(group.showElapsedSeconds ?? elapsed),
      elapsed,
    );
    group.lastShowElapsedSeconds = Math.max(
      Number(group.lastShowElapsedSeconds ?? elapsed),
      elapsed,
    );

    if (!group.sourcesByKey.has(sourceKey)) {
      group.sourcesByKey.set(sourceKey, {
        key: sourceKey,
        sourceStockLocationRowId: sourceRowId,
        sourceLocation: entry.source_location || {},
        quantity: 0,
        showElapsedSeconds: elapsed,
        lastShowElapsedSeconds: elapsed,
        maxQuantity: 0,
      });
    }
    const source = group.sourcesByKey.get(sourceKey);
    source.quantity += quantity;
    source.maxQuantity = source.quantity;
    source.showElapsedSeconds = Math.min(Number(source.showElapsedSeconds ?? elapsed), elapsed);
    source.lastShowElapsedSeconds = Math.max(Number(source.lastShowElapsedSeconds ?? elapsed), elapsed);
  });
  return Array.from(groups.values()).map((group) => {
    const sources = [...group.sourcesByKey.values()];
    return {
      ...group,
      sources,
      sourceLocation: sources[0]?.sourceLocation || {},
      maxQuantity: Number(group.quantity || 0),
      scanSpanSeconds: Math.max(0, Number(group.lastShowElapsedSeconds || 0) - Number(group.showElapsedSeconds || 0)),
      sourcesByKey: undefined,
    };
  });
}

function getBagHistoryTotals(lotId) {
  const groups = getBagHistoryGroups(lotId);
  return {
    types: groups.length,
    units: groups.reduce((sum, group) => sum + Number(group.quantity || 0), 0),
  };
}

function lotMatchesBagHistorySearch(lot, term) {
  if (!term) return true;
  const haystack = [
    lot.auction_number,
    lot.lot_code,
    lot.status,
    lot.notes,
    lot.label_path,
    getEmployeeReferenceLabel(lot.owner_employee_id, lot.owner_snapshot || {}),
    ...getBagHistoryItemsForLot(lot.id).flatMap((entry) => [
      entry.item?.title,
      entry.item?.barcode,
      entry.item_category,
      entry.item_description,
      entry.source_location?.location_name,
      entry.source_location?.location_code,
      entry.status,
    ]),
  ].join(" ").toLowerCase();
  return haystack.includes(term);
}

function renderBagHistory() {
  const list = $("bag-history-list");
  const detail = $("bag-history-detail");
  const summary = $("bag-history-summary");
  if (!list || !detail) return;

  const sessionTitle = state.currentSession?.title || state.currentSession?.session_code || "selected show";
  const term = String(state.bagHistorySearch || "").trim().toLowerCase();
  const lots = state.bagHistoryLots.filter((lot) => lotMatchesBagHistorySearch(lot, term));

  if (summary) {
    const lotCount = state.bagHistoryLots.length;
    summary.textContent = state.currentSession
      ? `${sessionTitle} at ${getSessionStoreName()} has ${lotCount.toLocaleString()} bag${lotCount === 1 ? "" : "s"}. Select one to inspect its contents.`
      : "Select a live session to review its bags.";
  }

  list.replaceChildren();
  if (state.bagHistoryLoading) {
    list.innerHTML = `<div class="empty-state">Loading session bags...</div>`;
    detail.innerHTML = `<div class="empty-state">Loading bag details...</div>`;
    return;
  }

  if (!state.bagHistoryLots.length) {
    list.innerHTML = `<div class="empty-state">No bags have been created for this session yet.</div>`;
    detail.innerHTML = `<div class="empty-state">Scan the first item to create the first bag.</div>`;
    return;
  }

  if (!lots.length) {
    list.innerHTML = `<div class="empty-state">No bags match that search.</div>`;
    detail.innerHTML = `<div class="empty-state">Try auction number, item title, barcode, or source location.</div>`;
    return;
  }

  if (!lots.some((lot) => String(lot.id) === String(state.bagHistorySelectedLotId))) {
    state.bagHistorySelectedLotId = lots[0]?.id || "";
  }

  lots.forEach((lot) => {
    const totals = getBagHistoryTotals(lot.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `bag-history-card ${String(lot.id) === String(state.bagHistorySelectedLotId) ? "is-selected" : ""}`;
    button.innerHTML = `
      <div class="bag-status-row">
        <strong>Auction ${escapeHtml(lot.auction_number || "-")}</strong>
        <b class="bag-status-badge ${getBagStatusClass(lot.status)}">${escapeHtml(lot.status || "open")}</b>
      </div>
      <span>${escapeHtml(lot.lot_code || "Bag")} - ${totals.types.toLocaleString()} type${totals.types === 1 ? "" : "s"} / ${totals.units.toLocaleString()} unit${totals.units === 1 ? "" : "s"}</span>
      <small>Owner: ${escapeHtml(getEmployeeReferenceLabel(lot.owner_employee_id, lot.owner_snapshot || {}) || "Unassigned")}</small>
      <small>${escapeHtml(formatDate(lot.created_at))}${lot.label_path ? " - label ready" : ""}</small>
    `;
    button.addEventListener("click", () => {
      state.bagHistorySelectedLotId = lot.id;
      renderBagHistory();
    });
    list.appendChild(button);
  });

  renderBagHistoryDetail();
}

function renderBagHistoryDetail() {
  const detail = $("bag-history-detail");
  if (!detail) return;

  const lot = state.bagHistoryLots.find((entry) => String(entry.id) === String(state.bagHistorySelectedLotId));
  if (!lot) {
    detail.innerHTML = `<div class="empty-state">Select a bag to inspect its contents.</div>`;
    return;
  }

  const groups = getBagHistoryGroups(lot.id);
  const totals = getBagHistoryTotals(lot.id);
  detail.replaceChildren();

  const header = document.createElement("div");
  header.className = "bag-detail-head";
  header.innerHTML = `
    <div class="bag-status-row">
      <h3>Auction ${escapeHtml(lot.auction_number || "-")}</h3>
      <b class="bag-status-badge ${getBagStatusClass(lot.status)}">${escapeHtml(lot.status || "open")}</b>
    </div>
    <div class="bag-detail-meta">
      <span>Bag ${escapeHtml(lot.lot_code || "-")}</span>
      <span>${totals.types.toLocaleString()} item type${totals.types === 1 ? "" : "s"}</span>
      <span>${totals.units.toLocaleString()} total unit${totals.units === 1 ? "" : "s"}</span>
      <span>Owner ${escapeHtml(getEmployeeReferenceLabel(lot.owner_employee_id, lot.owner_snapshot || {}) || "Unassigned")}</span>
      <span>Created ${escapeHtml(formatDate(lot.created_at))}</span>
      ${lot.closed_at ? `<span>Closed ${escapeHtml(formatDate(lot.closed_at))}</span>` : ""}
      ${lot.label_path ? `<button type="button" class="bag-detail-label-btn" data-print-live-label="${escapeHtml(lot.id)}">Print DYMO Label</button>` : "<span>No DYMO label yet</span>"}
    </div>
    ${lot.notes ? `<p class="subtle-text">${escapeHtml(lot.notes)}</p>` : ""}
  `;
  detail.appendChild(header);
  header.querySelector("[data-print-live-label]")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    const originalText = button.textContent;
    button.textContent = "Queueing label...";
    try {
      await printLiveSaleBagLabel(lot.id);
    } finally {
      if (button.isConnected) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
  });

  const itemsWrap = document.createElement("div");
  itemsWrap.className = "bag-detail-items";
  detail.appendChild(itemsWrap);

  if (!groups.length) {
    itemsWrap.innerHTML = `<div class="empty-state">This bag has no item records yet.</div>`;
    return;
  }

  groups.forEach((group) => {
    const item = group.item || {};
    const canEditGroup = !group.isManual && group.status === "reserved" && ["open", "reserved", "released"].includes(String(lot.status || ""));
    const row = document.createElement("article");
    row.className = `bag-detail-item${group.isManual ? " is-manual" : ""}`;
    row.innerHTML = `
      <div class="bag-detail-thumb"><span>${group.isManual ? "Manual" : "No photo"}</span></div>
      <div class="bag-detail-copy">
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <span>${renderManifestSourceSummary(group)}</span>
        ${renderManifestTimeNote(group)}
        ${renderManifestSourceBreakdown(group, { showMax: false })}
        <small>${escapeHtml(group.status || "reserved")}</small>
      </div>
      <div class="bag-detail-actions">
        <div class="bag-detail-qty">Qty ${Number(group.quantity || 0).toLocaleString()}</div>
        ${canEditGroup ? `<button type="button" class="tiny-btn" data-edit-history-group="${escapeHtml(group.key)}">Edit</button>` : ""}
      </div>
    `;
    itemsWrap.appendChild(row);

    resolvePhotoUrl(firstItemPhoto(item)).then((url) => {
      if (!url || !row.isConnected) return;
      const thumb = row.querySelector(".bag-detail-thumb");
      if (!thumb) return;
      thumb.innerHTML = `<button type="button" aria-label="Open ${escapeHtml(item.title || "item")} image"><img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Item preview")}" /></button>`;
      thumb.querySelector("button")?.addEventListener("click", () => openLivePhotoModal(url, item.title || "Item preview"));
    });
  });

  itemsWrap.querySelectorAll("[data-edit-history-group]").forEach((button) => {
    button.addEventListener("click", () => {
      const group = getBagHistoryGroups(lot.id).find((entry) => entry.key === button.getAttribute("data-edit-history-group"));
      if (group) openEditBagItemModal(group, lot);
    });
  });
}

async function loadBagHistory() {
  if (!state.currentSession) return;
  state.bagHistoryLoading = true;
  renderBagHistory();

  try {
    const [lotsResult, itemsResult, manualItemsResult] = await Promise.all([
      supabase
        .from("live_sale_lots")
        .select("*")
        .eq("session_id", state.currentSession.id)
        .order("created_at", { ascending: false }),
      supabase
        .from("live_sale_lot_items")
        .select(`
          *,
          item:item_id(id,title,description,barcode,weight,sale_price,photos,photo_url),
          source_location:source_location_id(id,location_name,location_code,store_id,tray_current_store_id,is_tray,location_role,type,parent_location_id)
        `)
        .eq("session_id", state.currentSession.id)
        .order("scanned_at", { ascending: true }),
      supabase
        .from("live_sale_manual_lot_items")
        .select("*")
        .eq("session_id", state.currentSession.id)
        .order("created_at", { ascending: true }),
    ]);

    if (lotsResult.error) throw lotsResult.error;
    if (itemsResult.error) throw itemsResult.error;
    if (manualItemsResult.error) throw manualItemsResult.error;

    state.bagHistoryLots = lotsResult.data || [];
    state.bagHistoryItems = [
      ...(itemsResult.data || []),
      ...(manualItemsResult.data || []).map(normalizeManualLiveSaleItem),
    ].sort((a, b) => new Date(a.scanned_at || a.created_at || 0) - new Date(b.scanned_at || b.created_at || 0));
    if (
      state.currentLot?.id
      && state.bagHistoryLots.some((lot) => String(lot.id) === String(state.currentLot.id))
    ) {
      state.bagHistorySelectedLotId = state.currentLot.id;
    } else if (!state.bagHistoryLots.some((lot) => String(lot.id) === String(state.bagHistorySelectedLotId))) {
      state.bagHistorySelectedLotId = state.bagHistoryLots[0]?.id || "";
    }
  } catch (error) {
    console.error("Load live sale bag history failed:", error);
    state.bagHistoryLots = [];
    state.bagHistoryItems = [];
    setStatus(error?.message || "Could not load bag history.", "error");
  } finally {
    state.bagHistoryLoading = false;
    renderBagHistory();
  }
}

async function openBagHistoryModal() {
  if (!state.currentSession) {
    setStatus("Start or select a live sale session first.", "error");
    return;
  }

  const modal = $("bag-history-modal");
  if (!modal) return;
  modal.hidden = false;
  document.body.classList.add("live-bag-open");
  if (state.bagHistoryLots.some((lot) => String(lot.session_id) !== String(state.currentSession.id))) {
    state.bagHistoryLots = [];
    state.bagHistoryItems = [];
    state.bagHistorySelectedLotId = state.currentLot?.id || "";
  }
  state.bagHistorySearch = $("bag-history-search")?.value?.trim() || "";
  renderBagHistory();
  await loadBagHistory();
  setTimeout(() => $("bag-history-search")?.focus(), 80);
}

function closeBagHistoryModal() {
  const modal = $("bag-history-modal");
  if (!modal || modal.hidden) return;
  modal.hidden = true;
  document.body.classList.remove("live-bag-open");
  setTimeout(() => focusItemScanner(), 80);
}

async function printLiveSaleBagLabel(lotId) {
  const lot = state.bagHistoryLots.find((entry) => String(entry.id) === String(lotId))
    || (String(state.currentLot?.id || "") === String(lotId) ? state.currentLot : null);
  if (!lot) {
    setStatus("Could not find that auction bag.", "error");
    return;
  }

  const xml = buildLiveAuctionDymoXml({
    auctionNumber: lot.auction_number,
    lotCode: lot.lot_code,
    freeText: lot.auction_number,
  });
  const filename = `${getLiveSaleLabelBaseName(lot)}_Reprint_Copies_1.dymo`;
  downloadTextFile(xml, filename);
  setStatus(`DYMO label for auction ${lot.auction_number || lot.lot_code || "bag"} queued for automatic printing.`, "success");
}

function renderLabelReview() {
  const numberEl = $("confirm-auction-number");
  const list = $("label-review-manifest");
  const countEl = $("label-review-count");
  const auctionNumber = $("auction-number")?.value?.trim() || state.currentLot?.auction_number || "-";
  if (numberEl) numberEl.textContent = auctionNumber || "-";
  if (!list) return;

  list.replaceChildren();
  if (!state.currentLot) {
    if (countEl) countEl.textContent = "0 items";
    list.innerHTML = `<div class="empty-state">No bag selected.</div>`;
    return;
  }

  const groups = getManifestGroups();
  if (!groups.length) {
    if (countEl) countEl.textContent = "0 items";
    list.innerHTML = `<div class="empty-state">No bag items yet.</div>`;
    return;
  }

  const totalUnits = groups.reduce((sum, group) => sum + Number(group.quantity || 0), 0);
  if (countEl) {
    countEl.textContent = `${groups.length.toLocaleString()} item type${groups.length === 1 ? "" : "s"} / ${totalUnits.toLocaleString()} total unit${totalUnits === 1 ? "" : "s"}`;
  }

  groups.forEach((group) => {
    const item = group.item || {};
    const row = document.createElement("article");
    row.className = "label-review-item";
    row.innerHTML = `
      <div class="label-review-thumb"><span>No photo</span></div>
      <div class="label-review-copy">
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <span>${renderManifestSourceSummary(group)}</span>
        ${renderManifestTimeNote(group)}
        ${renderManifestSourceBreakdown(group)}
      </div>
      <div class="label-review-qty">Qty ${Number(group.quantity || 0).toLocaleString()}</div>
    `;
    list.appendChild(row);

    resolvePhotoUrl(firstItemPhoto(item)).then((url) => {
      if (!url || !row.isConnected) return;
      const thumb = row.querySelector(".label-review-thumb");
      if (!thumb) return;
      thumb.innerHTML = `<button type="button" aria-label="Open ${escapeHtml(item.title || "item")} image"><img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Item preview")}" /></button>`;
      thumb.querySelector("button")?.addEventListener("click", () => openLivePhotoModal(url, item.title || "Item preview"));
    });
  });
}

async function startSession() {
  if (state.busy) return;
  const storeId = $("session-store-select")?.value || "";
  const titleInput = $("session-title");
  let title = titleInput?.value?.trim() || "";
  if (!title || titleInput?.dataset.autoTitle === "true") {
    title = formatSessionTitleDate();
    if (titleInput) titleInput.value = title;
  }
  const notes = $("session-notes")?.value?.trim() || null;
  const startAuctionInput = $("session-start-auction-number");
  const startAuctionNumber = startAuctionInput?.value?.trim() || "";
  const primarySellerId = $("session-primary-seller")?.value || state.employee?.id || null;
  const coSellerIds = getSelectedCoSellerIds();

  if (!storeId) {
    setStatus("Select the store where the live sale is happening.", "error");
    $("session-store-select")?.focus();
    return;
  }

  if (!startAuctionNumber) {
    setStatus("Enter the auction number where this live session should start.", "error");
    startAuctionInput?.focus();
    return;
  }

  if (!primarySellerId) {
    setStatus("Select the main seller for this live show.", "error");
    $("session-primary-seller")?.focus();
    return;
  }

  try {
    saveStoreId(storeId);
    state.pendingStartAuctionNumber = startAuctionNumber;
    state.busy = true;
    setStatus("Starting live sale session...");
    const { data, error } = await supabase.rpc("start_live_sale_session", {
      _title: title,
      _store_id: storeId,
      _notes: notes,
      _signed_by_email: state.user?.email || null,
      _primary_seller_employee_id: primarySellerId,
      _co_seller_employee_ids: coSellerIds,
    });
    if (error) throw error;
    state.currentSession = Array.isArray(data) ? data[0] : data;
    state.currentLot = null;
    await loadSessions({ keepSelection: true });
    state.busy = false;
    await prepareNextBag();
    setStatus(`Show session started at auction ${startAuctionNumber}. Scan the first item into the current bag.`, "success");
  } catch (error) {
    console.error("Start live sale session failed:", error);
    state.pendingStartAuctionNumber = "";
    setStatus(error.message || "Could not start the live sale session.", "error");
  } finally {
    state.busy = false;
  }
}

async function endSession() {
  if (!state.currentSession || state.busy) return;
  const ok = window.confirm("End the active live sale session? Existing reserved bags will remain reserved.");
  if (!ok) return;

  try {
    state.busy = true;
    const { error } = await supabase.rpc("end_live_sale_session", {
      _session_id: state.currentSession.id,
      _notes: $("session-notes")?.value?.trim() || null,
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;
    state.currentSession = null;
    state.currentLot = null;
    clearScan();
    await loadSessions({ keepSelection: false });
    setStatus("Live sale session ended.", "success");
  } catch (error) {
    console.error("End live sale session failed:", error);
    setStatus(error.message || "Could not end the live sale session.", "error");
  } finally {
    state.busy = false;
  }
}

function setCancelSessionError(message = "") {
  const errorEl = $("cancel-session-error");
  if (errorEl) errorEl.textContent = message;
}

function setCancelSessionBusy(isBusy) {
  $("cancel-session-confirm")?.toggleAttribute("disabled", isBusy);
  $("cancel-session-dismiss")?.toggleAttribute("disabled", isBusy);
  $("cancel-session-close")?.toggleAttribute("disabled", isBusy);
}

function openCancelSessionModal() {
  if (!state.currentSession) {
    setStatus("Select an active live sale session first.", "error");
    return;
  }

  const modal = $("cancel-session-modal");
  if (!modal) return;

  const title = state.currentSession.title || state.currentSession.session_code || "Live Sale";
  const store = getSessionStoreName();
  const started = formatDate(state.currentSession.started_at);
  const reservedUnits = state.lotItems.reduce((sum, item) => (
    item.status === "reserved" ? sum + Number(item.quantity || 0) : sum
  ), 0);

  const summary = $("cancel-session-summary");
  if (summary) {
    summary.textContent = `This will cancel "${title}" at ${store}, started ${started}. Open reserved bags in this session will be released from reservation. Current visible bag has ${reservedUnits} reserved unit${reservedUnits === 1 ? "" : "s"}.`;
  }

  if ($("cancel-session-reason")) $("cancel-session-reason").value = "";
  if ($("cancel-session-password")) $("cancel-session-password").value = "";
  setCancelSessionError("");
  setCancelSessionBusy(false);

  modal.hidden = false;
  document.body.classList.add("live-sign-open");
  setTimeout(() => $("cancel-session-reason")?.focus(), 80);
}

function closeCancelSessionModal(options = {}) {
  const modal = $("cancel-session-modal");
  if (!modal || modal.hidden) return;
  if (state.busy && options.force !== true) return;
  modal.hidden = true;
  document.body.classList.remove("live-sign-open");
  setCancelSessionError("");
  setCancelSessionBusy(false);
}

async function validateLiveSalePassword(password) {
  if (!state.user?.email || !password) return false;
  const { error } = await supabase.auth.signInWithPassword({
    email: state.user.email,
    password,
  });
  return !error;
}

async function submitCancelSession() {
  if (!state.currentSession || state.busy) return;

  const reason = $("cancel-session-reason")?.value?.trim() || "";
  const password = $("cancel-session-password")?.value?.trim() || "";

  if (reason.length < 3) {
    setCancelSessionError("Enter a brief explanation for cancelling this live session.");
    $("cancel-session-reason")?.focus();
    return;
  }

  if (!password) {
    setCancelSessionError("Enter your password to sign this cancellation.");
    $("cancel-session-password")?.focus();
    return;
  }

  try {
    state.busy = true;
    setCancelSessionBusy(true);
    setCancelSessionError("Verifying password...");

    const valid = await validateLiveSalePassword(password);
    if (!valid) {
      throw new Error("Incorrect password. Please try again.");
    }

    setCancelSessionError("Cancelling session and writing audit trail...");
    const { error } = await supabase.rpc("cancel_live_sale_session", {
      _session_id: state.currentSession.id,
      _reason: reason,
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;

    await bumpInventoryVersion();
    state.currentSession = null;
    state.currentLot = null;
    state.lotItems = [];
    state.selectedItem = null;
    state.selectedSourceRow = null;
    state.sourceRows = [];
    closeCancelSessionModal({ force: true });
    clearScan();
    await loadSessions({ keepSelection: false });
    renderAll();
    setStatus("Live sale session cancelled. Reservations were released and the audit trail was recorded.", "success");
  } catch (error) {
    console.error("Cancel live sale session failed:", error);
    setCancelSessionError(error?.message || "Could not cancel this live sale session.");
  } finally {
    state.busy = false;
    setCancelSessionBusy(false);
    updateScanGate();
  }
}

async function createOrLoadLot(options = {}) {
  if (state.busy && !options.force) return;
  if (!state.currentSession) {
    setStatus("Start or select a live sale session first.", "error");
    return;
  }

  const auctionNumber = String(options.auctionNumber ?? $("auction-number")?.value ?? "").trim();
  const ownerEmployeeId = options.ownerEmployeeId || getSelectedBagOwnerId();
  if (!auctionNumber) {
    setStatus("Enter the auction number first.", "error");
    $("auction-number")?.focus();
    return;
  }

  try {
    state.busy = true;
    if (!options.silent) setStatus("Creating or loading auction bag...");
    const { data, error } = await supabase.rpc("create_live_sale_lot", {
      _session_id: state.currentSession.id,
      _auction_number: auctionNumber,
      _notes: null,
      _signed_by_email: state.user?.email || null,
      _owner_employee_id: ownerEmployeeId,
    });
    if (error) throw error;
    state.currentLot = Array.isArray(data) ? data[0] : data;
    clearScan();
    await loadLotItems();
    if ($("auction-number")) $("auction-number").value = state.currentLot.auction_number || auctionNumber;
    if ($("label-free-text")) $("label-free-text").value = state.currentLot.auction_number || auctionNumber;
    setFlowStep("scan");
    if (!options.silent) setStatus("Bag is ready. Scan the first item barcode.", "success");
    if (options.focusScan !== false) setTimeout(() => focusItemScanner(), 80);
    return state.currentLot;
  } catch (error) {
    console.error("Create live sale lot failed:", error);
    setStatus(error.message || "Could not create the auction bag.", "error");
    return null;
  } finally {
    state.busy = false;
  }
}

async function updateCurrentLotOwner(ownerEmployeeId, options = {}) {
  if (!state.currentLot?.id || !ownerEmployeeId || state.busy) return;
  if (String(state.currentLot.owner_employee_id || "") === String(ownerEmployeeId)) {
    renderSellerControls();
    updateScanGate();
    return;
  }

  try {
    state.busy = true;
    updateScanGate();
    if (!options.silent) setStatus("Updating this bag owner...");
    const { data, error } = await supabase.rpc("update_live_sale_lot_owner", {
      _lot_id: state.currentLot.id,
      _owner_employee_id: ownerEmployeeId,
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;
    state.currentLot = Array.isArray(data) ? data[0] : data;
    if (!options.silent) {
      setStatus(`Bag owner updated to ${getLotOwnerLabel() || "selected seller"}.`, "success");
    }
    renderAll();
  } catch (error) {
    console.error("Update live sale bag owner failed:", error);
    setStatus(error.message || "Could not update this bag owner.", "error");
    renderSellerControls();
  } finally {
    state.busy = false;
    updateScanGate();
  }
}

async function getNextAuctionNumber() {
  if (!state.currentSession?.id) return incrementAuctionNumber(readLastAuctionNumber());

  const { data, error } = await supabase
    .from("live_sale_lots")
    .select("auction_number, created_at")
    .eq("session_id", state.currentSession.id)
    .order("created_at", { ascending: false })
    .limit(30);

  if (error) {
    console.warn("Could not derive next live-sale auction number:", error);
    return incrementAuctionNumber(readLastAuctionNumber());
  }

  const numbers = (data || []).map((lot) => String(lot.auction_number || "").trim()).filter(Boolean);
  const numericLots = numbers
    .map((value) => ({ value, match: value.match(/^(.*?)(\d+)$/) }))
    .filter((entry) => entry.match)
    .map((entry) => ({
      value: entry.value,
      prefix: entry.match[1],
      number: Number(entry.match[2]),
      width: entry.match[2].length,
    }))
    .sort((a, b) => b.number - a.number);

  if (numericLots.length) {
    const top = numericLots[0];
    return `${top.prefix}${String(top.number + 1).padStart(top.width, "0")}`;
  }

  return incrementAuctionNumber(readLastAuctionNumber());
}

async function prepareNextBag() {
  if (!state.currentSession || state.currentLot?.status === "open" || state.currentLot?.status === "reserved") {
    if (state.currentLot && state.flowStep !== "label") {
      setFlowStep("scan");
      setTimeout(() => focusItemScanner(), 80);
    }
    return;
  }

  const recoverableLot = await findRecoverableCurrentLot();
  if (recoverableLot) {
    state.currentLot = recoverableLot;
    if ($("auction-number")) $("auction-number").value = recoverableLot.auction_number || "";
    if ($("label-free-text")) $("label-free-text").value = recoverableLot.auction_number || "";
    setFlowStep("scan");
    await loadLotItems();
    setStatus(`Recovered bag ${recoverableLot.auction_number}. Continue scanning or press Enter on an empty scanner to print.`, "success");
    setTimeout(() => focusItemScanner(), 80);
    return;
  }

  const usePendingStart = Boolean(state.pendingStartAuctionNumber);
  const nextAuctionNumber = usePendingStart
    ? state.pendingStartAuctionNumber
    : await getNextAuctionNumber();
  if ($("auction-number")) $("auction-number").value = nextAuctionNumber;
  if ($("label-free-text")) $("label-free-text").value = nextAuctionNumber;
  const createdLot = await createOrLoadLot({ auctionNumber: nextAuctionNumber, silent: true, focusScan: true });
  if (createdLot && usePendingStart) {
    state.pendingStartAuctionNumber = "";
  }
  if (createdLot) {
    setStatus(`Bag ${nextAuctionNumber} is ready. Scan items, press Space for the next scan, or press Enter on an empty scanner to print.`, "success");
  }
}

async function findRecoverableCurrentLot() {
  if (!state.currentSession?.id) return null;
  const { data, error } = await supabase
    .from("live_sale_lots")
    .select("*")
    .eq("session_id", state.currentSession.id)
    .in("status", ["open", "reserved"])
    .is("label_path", null)
    .order("created_at", { ascending: false })
    .limit(1);

  if (error) {
    console.warn("Could not load recoverable live-sale bag:", error);
    return null;
  }

  return data?.[0] || null;
}

function focusItemScanner() {
  const scanner = $("item-scan");
  if (!scanner || scanner.disabled) return;
  scanner.focus();
  scanner.select();
}

function shouldReturnFocusToScanner() {
  const scanner = $("item-scan");
  if (!scanner || scanner.disabled) return false;
  if (!state.currentSession || !state.currentLot || state.flowStep !== "scan") return false;
  if (!$("live-photo-modal")?.hidden) return false;
  if (!$("bag-history-modal")?.hidden) return false;
  if (!$("edit-bag-item-modal")?.hidden) return false;
  if (state.busy) return false;
  if (document.activeElement?.matches?.("[data-manifest-qty-input]")) return false;
  if (state.selectedItem && state.sourceRows.length !== 1) return false;
  return true;
}

function scheduleScannerRefocus(delay = 2000) {
  if (state.scannerRefocusTimer) clearTimeout(state.scannerRefocusTimer);
  state.scannerRefocusTimer = setTimeout(() => {
    state.scannerRefocusTimer = null;
    if (shouldReturnFocusToScanner()) focusItemScanner();
  }, delay);
}

function sanitizeSearchTerm(value) {
  return String(value || "").trim().replace(/[%,]/g, " ");
}

async function findItemForScan() {
  if (state.busy) return;
  if (!state.currentLot) {
    setStatus("Create or load an auction bag first.", "error");
    return;
  }

  const term = sanitizeSearchTerm($("item-scan")?.value || "");
  if (!term) {
    setStatus("Scan an item barcode.", "error");
    return;
  }

  setStatus("Finding scanned item...");
  state.selectedItem = null;
  state.selectedSourceRow = null;
  state.sourceRows = [];
  renderSelectedItem();
  renderSourceRows();

  let exact = await supabase
    .from("item_types")
    .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
    .eq("barcode", term)
    .is("deleted_at", null)
    .limit(1);

  if (exact.error && /deleted_at/i.test(exact.error.message || "")) {
    exact = await supabase
      .from("item_types")
      .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
      .eq("barcode", term)
      .limit(1);
  }

  if (!exact.error && exact.data?.length === 1) {
    state.selectedItem = exact.data[0];
    renderSelectedItem();
    await loadSourceRowsForItem(state.selectedItem);
    return;
  }

  const pattern = `%${term}%`;
  let { data, error } = await supabase
    .from("item_types")
    .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
    .or(`barcode.ilike.${pattern},title.ilike.${pattern},description.ilike.${pattern}`)
    .is("deleted_at", null)
    .limit(10);

  if (error && /deleted_at/i.test(error.message || "")) {
    const retry = await supabase
      .from("item_types")
      .select("id,title,description,barcode,sale_price,weight,photos,photo_url")
      .or(`barcode.ilike.${pattern},title.ilike.${pattern},description.ilike.${pattern}`)
      .limit(10);
    data = retry.data;
    error = retry.error;
  }

  if (error) {
    console.error("Live sale item search failed:", error);
    setStatus(error.message || "Could not search inventory.", "error");
    return;
  }

  const items = data || [];
  if (items.length === 1) {
    state.selectedItem = items[0];
    renderSelectedItem();
    await loadSourceRowsForItem(state.selectedItem);
    return;
  }

  if (!items.length) {
    setStatus("No item matched that scan.", "error");
    return;
  }

  renderItemChoices(items);
  setStatus(`${items.length} items matched. Choose the exact item.`, "info");
}

function renderItemChoices(items) {
  const card = $("item-match-card");
  if (!card) return;
  card.className = "match-card choice-match-card";
  card.innerHTML = items.map((item) => `
    <article class="choice-card">
      <button type="button" class="match-photo choice-photo" data-choice-photo="${escapeHtml(item.id)}" disabled>
        <span>No photo</span>
      </button>
      <button type="button" class="choice-copy" data-pick-item="${escapeHtml(item.id)}">
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <small>${escapeHtml(item.barcode || "-")} - ${Number(item.weight || 0).toFixed(2)} g</small>
        <b>Use this item</b>
      </button>
    </article>
  `).join("");

  items.forEach((item) => hydrateItemPhoto({
    item,
    button: card.querySelector(`[data-choice-photo="${CSS.escape(item.id)}"]`),
  }));

  card.querySelectorAll("[data-pick-item]").forEach((button) => {
    button.addEventListener("click", async () => {
      const item = items.find((entry) => entry.id === button.getAttribute("data-pick-item"));
      if (!item) return;
      state.selectedItem = item;
      renderSelectedItem();
      await loadSourceRowsForItem(item);
    });
  });
}

function hydrateItemPhoto({ item, button }) {
  if (!item || !button) return;
  const itemId = item.id;
  const photoPath = firstItemPhoto(item);
  if (!photoPath) return;

  resolvePhotoUrl(photoPath).then((url) => {
    if (!url || !button.isConnected) return;
    if (button.matches("[data-selected-item-photo]") && state.selectedItem?.id !== itemId) return;
    button.disabled = false;
    button.innerHTML = `<img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Item preview")}" />`;
    button.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openLivePhotoModal(url, item.title || "Item preview");
    };
  });
}

function renderSelectedItem() {
  const card = $("item-match-card");
  if (!card) return;

  if (!state.selectedItem) {
    card.className = "match-card empty";
    card.textContent = state.currentLot ? "Scan an item barcode." : "Scan an item after a bag is selected.";
    updateScanGate();
    return;
  }

  card.className = "match-card selected-match-card";
  card.innerHTML = `
    <button type="button" class="match-photo" data-selected-item-photo disabled>
      <span>No photo</span>
    </button>
    <div class="match-copy">
      <strong>${escapeHtml(state.selectedItem.title || "Untitled item")}</strong>
      <span>${escapeHtml(state.selectedItem.barcode || "-")} - ${Number(state.selectedItem.weight || 0).toFixed(2)} g</span>
      <small>${escapeHtml(state.selectedSourceRow?.locationLabel || "Choose source")}</small>
    </div>
  `;
  hydrateItemPhoto({
    item: state.selectedItem,
    button: card.querySelector("[data-selected-item-photo]"),
  });
  updateScanGate();
}

async function loadSourceRowsForItem(item) {
  if (!item?.id) return;
  setStatus("Loading source stock for the scanned item...");

  const [{ data: rows, error: rowError }, { data: reservations, error: reservationError }] = await Promise.all([
    supabase
      .from("item_stock_locations")
      .select("id,item_id,location_id,quantity,location:location_id(*)")
      .eq("item_id", item.id)
      .gt("quantity", 0),
    supabase
      .from("active_stock_reservations")
      .select("stock_location_row_id,reserved_quantity")
      .eq("item_id", item.id),
  ]);

  if (rowError) {
    console.error("Live sale source row load failed:", rowError);
    setStatus(rowError.message || "Could not load source stock.", "error");
    return;
  }

  if (reservationError) {
    console.warn("Reservation overlay not available yet:", reservationError);
  }

  state.sourceReservations = new Map((reservations || []).map((entry) => [
    entry.stock_location_row_id,
    Number(entry.reserved_quantity || 0),
  ]));

  const sessionStoreId = state.currentSession?.store_id || "";
  const eligibleRows = (rows || [])
    .map((row) => normalizeSourceRow(row))
    .filter((row) => {
      const inStore = !sessionStoreId || row.store_id === sessionStoreId;
      const validTray = row.isTray && row.tray_status !== "checked_out";
      const validStorage = !row.isTray && ["storage_location", "container"].includes(row.source_role);
      return inStore && (validTray || validStorage) && row.available_quantity > 0;
    });

  const trayRows = eligibleRows.filter((row) => row.isTray);
  const storageRows = eligibleRows.filter((row) => !row.isTray);
  state.sourceRows = trayRows.length ? trayRows : storageRows;
  state.selectedSourceRow = state.sourceRows.length === 1 ? state.sourceRows[0] : null;
  renderSourceRows();
  renderSelectedItem();

  if (state.selectedSourceRow) {
    const sourceKind = state.selectedSourceRow.isTray ? "tray source" : `${state.selectedSourceRow.source_kind_label.toLowerCase()} source`;
    if (state.flowStep === "scan") {
      setStatus(`Only one available ${sourceKind} was found. Reserving it now...`, "success");
      await reserveSelectedItem({ auto: true });
    } else {
      setStatus(`Only one available ${sourceKind} was found.`, "success");
    }
  } else if (state.sourceRows.length) {
    const hasStorageFallback = state.sourceRows.some((row) => !row.isTray);
    setStatus(`${state.sourceRows.length} ${hasStorageFallback ? "storage/container source(s)" : "source tray(s)"} found. Choose the exact source; one unit will be added.`, "info");
  } else {
    setStatus("This item has no unreserved stock in a checked-in tray or storage/container for this live sale store.", "error");
  }
}

function normalizeSourceRow(row) {
  const loc = row.location || {};
  const sourceRole = getSourceRole(loc);
  const isTray = sourceRole === "tray";
  const storeId = isTray ? (loc.tray_current_store_id || loc.store_id || "") : (loc.store_id || "");
  const reserved = state.sourceReservations.get(row.id) || 0;
  const available = Math.max(0, Number(row.quantity || 0) - reserved);
  const storeName = getStoreName(storeId);
  const sourceKindLabel = getSourceKindLabel(loc);
  const defaultName = isTray ? "Unnamed tray" : sourceRole === "container" ? "Unnamed container" : "Unnamed storage";
  return {
    ...row,
    isTray,
    source_role: sourceRole,
    source_kind_label: sourceKindLabel,
    store_id: storeId,
    tray_status: loc.tray_status || "",
    location_name: loc.location_name || "",
    location_code: loc.location_code || "",
    reserved_quantity: reserved,
    available_quantity: available,
    locationLabel: `${loc.location_name || defaultName}${loc.location_code ? ` (${loc.location_code})` : ""} - ${sourceKindLabel}${storeName ? ` - ${storeName}` : ""}`,
  };
}

function renderSourceRows() {
  const container = $("source-results");
  if (!container) return;
  container.replaceChildren();

  if (!state.selectedItem) {
    updateScanGate();
    return;
  }

  if (!state.sourceRows.length) {
    container.innerHTML = `<div class="empty-state">No available checked-in tray or storage/container source found.</div>`;
    updateScanGate();
    return;
  }

  state.sourceRows.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `source-btn ${row.isTray ? "" : "is-storage-source"} ${state.selectedSourceRow?.id === row.id ? "is-selected" : ""}`;
    button.innerHTML = `
      <span>
        <strong><b class="source-kind-badge ${getSourceKindClass(row.location || {})}">${escapeHtml(row.source_kind_label)}</b> ${escapeHtml(row.locationLabel)}</strong>
        <small>${Number(row.available_quantity || 0).toLocaleString()} available after ${Number(row.reserved_quantity || 0).toLocaleString()} reserved</small>
      </span>
      <b>Select</b>
    `;
    button.addEventListener("click", () => {
      state.selectedSourceRow = row;
      renderSourceRows();
      renderSelectedItem();
      setStatus(`${row.source_kind_label} selected. Adding one unit to the bag...`, "success");
      reserveSelectedItem({ auto: true });
    });
    container.appendChild(button);
  });

  updateScanGate();
}

async function reserveSelectedItem(options = {}) {
  if (!state.currentLot || !state.selectedItem || !state.selectedSourceRow || state.busy) {
    setStatus("Scan an item and choose its source first.", "error");
    return;
  }

  const qty = Math.max(1, parseInt(String(options.quantity || "1"), 10) || 1);
  if (qty > Number(state.selectedSourceRow.available_quantity || 0)) {
    setStatus(`Only ${state.selectedSourceRow.available_quantity} unreserved unit(s) are available at that source.`, "error");
    return;
  }

  try {
    state.busy = true;
    setStatus(options.auto ? "Adding scanned item to this bag..." : "Reserving item into live-sale bag...");
    const { error } = await supabase.rpc("reserve_live_sale_item", {
      _lot_id: state.currentLot.id,
      _item_barcode: state.selectedItem.barcode,
      _stock_location_row_id: state.selectedSourceRow.id,
      _quantity: qty,
      _signed_by_email: state.user?.email || null,
      _notes: null,
    });
    if (error) throw error;

    await bumpInventoryVersion([state.selectedItem.id]);
    clearScan();
    await reloadCurrentLot();
    await loadLotItems();
    setFlowStep("scan");
    setStatus("Item added. Scan the same barcode again for +1 quantity, scan another item, or press Enter on the empty scanner to print.", "success");
    setTimeout(() => focusItemScanner(), 80);
  } catch (error) {
    console.error("Live sale item reservation failed:", error);
    setStatus(error.message || "Could not reserve the item.", "error");
  } finally {
    state.busy = false;
  }
}

async function reloadCurrentLot() {
  if (!state.currentLot?.id) return;
  const { data, error } = await supabase
    .from("live_sale_lots")
    .select("*")
    .eq("id", state.currentLot.id)
    .maybeSingle();
  if (!error && data) state.currentLot = data;
}

function clearScan() {
  if (state.itemSearchTimer) {
    clearTimeout(state.itemSearchTimer);
    state.itemSearchTimer = null;
  }
  state.selectedItem = null;
  state.sourceRows = [];
  state.selectedSourceRow = null;
  if ($("item-scan")) $("item-scan").value = "";
  renderSelectedItem();
  renderSourceRows();
  updateScanGate();
}

async function addManualLiveSaleItem() {
  if (state.busy) return;
  if (!state.currentLot) {
    setStatus("Create or load an auction bag before adding a general item.", "error");
    return;
  }

  const category = String($("manual-live-item-category")?.value || "Other").trim() || "Other";
  const description = String($("manual-live-item-description")?.value || "").trim();
  const quantity = Math.max(1, parseInt(String($("manual-live-item-quantity")?.value || "1"), 10) || 1);

  try {
    state.busy = true;
    updateScanGate();
    setStatus("Adding general item to this auction bag...");
    const { error } = await supabase.rpc("add_live_sale_manual_lot_item", {
      _lot_id: state.currentLot.id,
      _category: category,
      _description: description || null,
      _quantity: quantity,
      _signed_by_email: state.user?.email || null,
      _notes: "Added from live sale manual item control",
    });
    if (error) throw error;

    if ($("manual-live-item-description")) $("manual-live-item-description").value = "";
    if ($("manual-live-item-quantity")) $("manual-live-item-quantity").value = "1";
    await reloadCurrentLot();
    await loadLotItems();
    setFlowStep("scan");
    setStatus(`Added ${quantity.toLocaleString()} ${category.toLowerCase()}${quantity === 1 ? "" : "s"} to this bag.`, "success");
    setTimeout(() => focusItemScanner(), 80);
  } catch (error) {
    console.error("Add manual live sale item failed:", error);
    setStatus(error.message || "Could not add that general item.", "error");
  } finally {
    state.busy = false;
    updateScanGate();
  }
}

function populateEmployeeSelect(select, {
  selectedValue = "",
  excludeIds = [],
  placeholder = "Select seller",
  allowEmpty = true,
  multipleValues = [],
} = {}) {
  if (!select) return;

  const excluded = new Set(excludeIds.filter(Boolean).map(String));
  const selectedSet = new Set(multipleValues.filter(Boolean).map(String));
  const currentValue = selectedValue || select.value || "";

  select.replaceChildren();

  if (allowEmpty && !select.multiple) {
    const placeholderOption = document.createElement("option");
    placeholderOption.value = "";
    placeholderOption.textContent = placeholder;
    select.appendChild(placeholderOption);
  }

  state.employees
    .filter((employee) => !excluded.has(String(employee.id)))
    .forEach((employee) => {
      const option = document.createElement("option");
      option.value = employee.id;
      option.textContent = getEmployeeLabel(employee);
      if (employee.email && employee.email !== employee.display_name) {
        option.title = employee.email;
      }
      if (select.multiple) {
        option.selected = selectedSet.has(String(employee.id));
      }
      select.appendChild(option);
    });

  if (!select.multiple) {
    select.value = currentValue && state.employees.some((employee) => String(employee.id) === String(currentValue))
      ? currentValue
      : "";
  }
}

function renderSellerControls() {
  const activeSession = Boolean(state.currentSession);
  const primarySelect = $("session-primary-seller");
  const coSellerSelect = $("session-co-sellers");
  const bagOwnerSelect = $("bag-owner-select");
  const labelBagOwnerSelect = $("label-bag-owner-select");
  const primaryId = state.currentSession?.primary_seller_employee_id || primarySelect?.value || state.employee?.id || "";
  const coSellerIds = Array.isArray(state.currentSession?.co_seller_employee_ids)
    ? state.currentSession.co_seller_employee_ids
    : [...(coSellerSelect?.selectedOptions || [])].map((option) => option.value).filter(Boolean);
  const ownerId = state.currentLot?.owner_employee_id || primaryId || state.employee?.id || "";

  populateEmployeeSelect(primarySelect, {
    selectedValue: primaryId,
    placeholder: state.employees.length ? "Select main seller" : "No sellers found",
  });
  if (primarySelect) primarySelect.disabled = activeSession || state.busy;

  populateEmployeeSelect(coSellerSelect, {
    excludeIds: [primarySelect?.value || primaryId],
    allowEmpty: false,
    multipleValues: coSellerIds,
  });
  if (coSellerSelect) coSellerSelect.disabled = activeSession || state.busy;

  [bagOwnerSelect, labelBagOwnerSelect].forEach((select) => {
    populateEmployeeSelect(select, {
      selectedValue: ownerId,
      placeholder: state.employees.length ? "Select bag owner" : "No sellers found",
    });
  });
}

async function releaseManifestGroup(group) {
  if (!group) return;
  const ok = window.confirm("Release this item from the auction bag reservation?");
  if (!ok) return;
  await setManifestGroupQuantity(group, 0, "Released from current bag contents");
}

async function saveManifestGroupQuantity(group, quantity, note = "Updated quantity from current bag contents", lot = state.currentLot) {
  if (!group) return false;
  if (!lot?.id) throw new Error("Auction bag was not found.");
  const nextQuantity = Math.max(0, parseInt(String(quantity), 10) || 0);
  if (group.isManual) {
    if (nextQuantity === Number(group.quantity || 0)) return false;
    const { error } = await supabase.rpc("set_live_sale_manual_lot_item_group_quantity", {
      _lot_id: lot.id,
      _category: group.manualCategory || "General",
      _description: group.manualDescription || null,
      _quantity: nextQuantity,
      _signed_by_email: state.user?.email || null,
      _notes: note,
    });
    if (error) throw error;
    return true;
  }
  const maxQuantity = Math.max(Number(group.maxQuantity || 0), Number(group.quantity || 0));
  if (nextQuantity > maxQuantity) {
    throw new Error(`Only ${maxQuantity.toLocaleString()} unit(s) are available for this item in the selected source(s).`);
  }

  const quantityPlan = planManifestGroupQuantities(group, nextQuantity);
  if (!quantityPlan) {
    throw new Error("This item cannot be adjusted because the source stock is no longer available.");
  }

  if (!quantityPlan.length) {
    return false;
  }

  for (const source of quantityPlan) {
    const { error } = await supabase.rpc("set_live_sale_lot_group_quantity", {
      _lot_id: lot.id,
      _item_id: group.itemId,
      _stock_location_row_id: source.sourceStockLocationRowId,
      _quantity: source.nextQuantity,
      _signed_by_email: state.user?.email || null,
      _notes: `${note} (${getSourceLocationLabel(source)} -> ${source.nextQuantity})`,
    });
    if (error) throw error;
  }
  return true;
}

async function setManifestGroupQuantity(group, quantity, note = "Updated quantity from current bag contents") {
  if (!group || state.busy) return;
  const nextQuantity = Math.max(0, parseInt(String(quantity), 10) || 0);

  try {
    state.busy = true;
    setStatus(nextQuantity > 0 ? "Updating item quantity..." : "Releasing item from this bag...");
    const changed = await saveManifestGroupQuantity(group, nextQuantity, note);
    if (!changed) {
      setStatus("Quantity already matches the current bag contents.", "success");
      setTimeout(() => focusItemScanner(), 80);
      return;
    }
    if (group.itemId) await bumpInventoryVersion([group.itemId]);
    await reloadCurrentLot();
    await loadLotItems();
    setStatus(nextQuantity > 0 ? "Quantity updated. Scanner is ready." : "Item released from this bag.", "success");
    setTimeout(() => focusItemScanner(), 80);
  } catch (error) {
    console.error("Set live sale group quantity failed:", error);
    setStatus(error.message || "Could not update that item quantity.", "error");
  } finally {
    state.busy = false;
  }
}

async function cancelCurrentLot() {
  if (!state.currentLot) return;
  const note = window.prompt("Why is this auction bag being canceled?");
  if (!note || note.trim().length < 3) {
    setStatus("A short cancellation note is required.", "error");
    return;
  }

  try {
    const changedIds = state.lotItems.map((entry) => entry.item_id).filter(Boolean);
    const { error } = await supabase.rpc("cancel_live_sale_lot", {
      _lot_id: state.currentLot.id,
      _notes: note.trim(),
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;
    await bumpInventoryVersion(changedIds);
    state.currentLot = null;
    state.lotItems = [];
    clearScan();
    renderAll();
    setStatus("Auction bag canceled and reservations released.", "success");
  } catch (error) {
    console.error("Cancel live sale lot failed:", error);
    setStatus(error.message || "Could not cancel this auction bag.", "error");
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

function qrObject(name, value, x, y, width, height) {
  const safe = escapeXml(value);
  return `
    <QRCodeObject>
      <Name>${name}</Name>
      <Brushes>
        <BackgroundBrush><SolidColorBrush><Color A="1" R="1" G="1" B="1"></Color></SolidColorBrush></BackgroundBrush>
        <BorderBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderBrush>
        <StrokeBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></StrokeBrush>
        <FillBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></FillBrush>
      </Brushes>
      <Rotation>Rotation0</Rotation>
      <OutlineThickness>1</OutlineThickness>
      <IsOutlined>False</IsOutlined>
      <BorderStyle>SolidLine</BorderStyle>
      <Margin><DYMOThickness Left="0" Top="0" Right="0" Bottom="0" /></Margin>
      <BarcodeFormat>QRCode</BarcodeFormat>
      <Data><DataString>${safe}</DataString></Data>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Middle</VerticalAlignment>
      <Size>AutoFit</Size>
      <EQRCodeType>QRCodeText</EQRCodeType>
      <TextDataHolder><Value>${safe}</Value></TextDataHolder>
      <ObjectLayout>
        <DYMOPoint><X>${x}</X><Y>${y}</Y></DYMOPoint>
        <Size><Width>${width}</Width><Height>${height}</Height></Size>
      </ObjectLayout>
    </QRCodeObject>
  `;
}

function textObject(name, value, x, y, fontSize = "4") {
  const safe = escapeXml(value);
  return `
    <TextObject>
      <Name>${name}</Name>
      <Brushes>
        <BackgroundBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"></Color></SolidColorBrush></BackgroundBrush>
        <BorderBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderBrush>
        <StrokeBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></StrokeBrush>
        <FillBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"></Color></SolidColorBrush></FillBrush>
      </Brushes>
      <Rotation>Rotation90</Rotation>
      <OutlineThickness>1</OutlineThickness>
      <IsOutlined>False</IsOutlined>
      <BorderStyle>SolidLine</BorderStyle>
      <Margin><DYMOThickness Left="0" Top="0" Right="0" Bottom="0" /></Margin>
      <HorizontalAlignment>Center</HorizontalAlignment>
      <VerticalAlignment>Bottom</VerticalAlignment>
      <FitMode>None</FitMode>
      <IsVertical>False</IsVertical>
      <FormattedText>
        <FitMode>None</FitMode>
        <HorizontalAlignment>Center</HorizontalAlignment>
        <VerticalAlignment>Bottom</VerticalAlignment>
        <IsVertical>False</IsVertical>
        <LineTextSpan>
          <TextSpan>
            <Text>${safe}</Text>
            <FontInfo>
              <FontName>Segoe UI</FontName>
              <FontSize>${fontSize}</FontSize>
              <IsBold>True</IsBold>
              <IsItalic>False</IsItalic>
              <IsUnderline>False</IsUnderline>
              <FontBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></FontBrush>
            </FontInfo>
          </TextSpan>
        </LineTextSpan>
      </FormattedText>
      <ObjectLayout>
        <DYMOPoint><X>${x}</X><Y>${y}</Y></DYMOPoint>
        <Size><Width>0.12500001</Width><Height>0.378334</Height></Size>
      </ObjectLayout>
    </TextObject>
  `;
}

function buildLiveAuctionDymoXml({ auctionNumber, lotCode, freeText }) {
  const auctionValue = String(auctionNumber || "").trim();
  const lotValue = String(lotCode || "").trim();
  const rightText = String(freeText || auctionValue || "AUCTION").trim().toUpperCase().slice(0, 18);
  const leftText = lotValue.toUpperCase().slice(0, 18);

  return `<?xml version="1.0" encoding="utf-8"?>
<DesktopLabel Version="1">
  <DYMOLabel Version="4">
    <Description>DYMO Label</Description>
    <Orientation>Portrait</Orientation>
    <LabelName>Jewelry30299</LabelName>
    <InitialLength>0</InitialLength>
    <BorderStyle>SolidLine</BorderStyle>
    <DYMORect>
      <DYMOPoint><X>0.040000137</X><Y>0.060000002</Y></DYMOPoint>
      <Size><Width>2.0433333</Width><Height>0.75666666</Height></Size>
    </DYMORect>
    <BorderColor><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderColor>
    <BorderThickness>1</BorderThickness>
    <Show_Border>False</Show_Border>
    <HasFixedLength>False</HasFixedLength>
    <FixedLengthValue>0</FixedLengthValue>
    <DynamicLayoutManager>
      <RotationBehavior>ClearObjects</RotationBehavior>
      <LabelObjects>
        ${qrObject("QRCodeObject0", auctionValue, "1.5044161", "0.06538457", "0.28525865", "0.32408708")}
        ${qrObject("QRCodeObject1", auctionValue, "1.5044161", "0.47906214", "0.3110023", "0.29687557")}
        ${textObject("TextObject0", rightText, "1.4095135", "0.059999704", "4.8")}
        ${textObject("TextObject1", rightText, "1.4095135", "0.43833333", "4.8")}
        ${qrObject("QRCodeObject2", lotValue, "0.26554355", "0.47743064", "0.30536497", "0.30013865")}
        ${qrObject("QRCodeObject3", lotValue, "0.2628106", "0.09862068", "0.308098", "0.290851")}
        ${textObject("TextObject4", leftText, "0.13781057", "0.059999704", "4")}
        ${textObject("TextObject5", leftText, "0.13781057", "0.43833315", "4")}
      </LabelObjects>
    </DynamicLayoutManager>
  </DYMOLabel>
  <LabelApplication>Blank</LabelApplication>
  <DataTable><Columns></Columns><Rows></Rows></DataTable>
</DesktopLabel>`;
}

function downloadTextFile(text, filename) {
  const blob = new Blob([text], { type: "application/octet-stream" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function safeDymoFilename(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-z0-9_-]+/gi, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80) || "label";
}

function getLiveSaleLabelBaseName(lot = state.currentLot, session = state.currentSession) {
  const showTitle = session?.title || session?.session_code || "Live_Show";
  const auctionNumber = lot?.auction_number || "Auction";
  const lotCode = lot?.lot_code || "Bag";
  return [
    "OGJewelers",
    "LiveSale",
    safeDymoFilename(showTitle),
    `Auction_${safeDymoFilename(auctionNumber)}`,
    safeDymoFilename(lotCode),
  ].join("_");
}

async function generateLiveLabel(options = {}) {
  if (!state.currentLot) {
    setLabelStatus("Create or load an auction bag first.", "error");
    return false;
  }

  try {
    setLabelStatus("Generating DYMO label...");
    const freeText = $("label-free-text")?.value?.trim() || state.currentLot.auction_number;
    const xml = buildLiveAuctionDymoXml({
      auctionNumber: state.currentLot.auction_number,
      lotCode: state.currentLot.lot_code,
      freeText,
    });
    const labelBaseName = getLiveSaleLabelBaseName();
    const labelPath = `labels/${labelBaseName}_${Date.now()}.dymo`;
    const blob = new Blob([xml], { type: "application/octet-stream" });

    const { error: uploadError } = await supabase.storage
      .from("dymo-labels")
      .upload(labelPath, blob, { upsert: true, contentType: "application/octet-stream" });
    if (uploadError) throw uploadError;

    const { data, error } = await supabase.rpc("set_live_sale_lot_label", {
      _lot_id: state.currentLot.id,
      _label_path: labelPath,
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;
    state.currentLot = Array.isArray(data) ? data[0] : data;
    renderAll();

    const downloadName = `${labelBaseName}_Copies_1.dymo`;
    downloadTextFile(xml, downloadName);
    const signed = await supabase.storage.from("dymo-labels").createSignedUrl(labelPath, 3600);
    const openLink = signed.data?.signedUrl
      ? ` <a href="${escapeHtml(signed.data.signedUrl)}" target="_blank" rel="noreferrer">Open uploaded label</a>`
      : "";
    setLabelStatus(`DYMO label generated and queued as ${escapeHtml(downloadName)} for automatic local printing.${openLink}`, "success");
    return true;
  } catch (error) {
    console.error("Generate live sale label failed:", error);
    setLabelStatus(error.message || "Could not generate the DYMO label.", "error");
    if (!options.suppressStatus) setStatus(error.message || "Could not generate the DYMO label.", "error");
    return false;
  }
}

async function updateCurrentLotAuctionNumber(auctionNumber) {
  if (!state.currentLot?.id) return;
  const nextAuction = String(auctionNumber || "").trim();
  if (!nextAuction) throw new Error("Auction number is required.");
  if (nextAuction === String(state.currentLot.auction_number || "").trim()) return;

  const { data, error } = await supabase.rpc("update_live_sale_lot_auction_number", {
    _lot_id: state.currentLot.id,
    _auction_number: nextAuction,
    _notes: "Auction number confirmed before live-sale label print",
    _signed_by_email: state.user?.email || null,
  });
  if (error) throw error;
  state.currentLot = Array.isArray(data) ? data[0] : data;
}

function finishBagScanning() {
  if (!state.currentLot) {
    setStatus("Start a bag before confirming an auction number.", "error");
    return;
  }
  if (!getManifestGroups().length) {
    setStatus("Scan at least one item or add one general item before printing the auction bag label.", "error");
    focusItemScanner();
    return;
  }

  setFlowStep("label");
  const auctionInput = $("auction-number");
  if (auctionInput) {
    auctionInput.value = state.currentLot.auction_number || auctionInput.value || "";
    setTimeout(() => {
      auctionInput.focus();
      auctionInput.select();
    }, 80);
  }
  renderLabelReview();
  setStatus("Confirm the auction number. Press Enter to generate the DYMO label and start the next bag.", "success");
}

async function finalizeCurrentBag() {
  if (!state.currentLot || state.busy) return;
  if (!getManifestGroups().length) {
    setStatus("This bag has no items yet.", "error");
    setFlowStep("scan");
    setTimeout(() => focusItemScanner(), 80);
    return;
  }

  const auctionNumber = $("auction-number")?.value?.trim();
  if (!auctionNumber) {
    setStatus("Auction number is required before printing.", "error");
    $("auction-number")?.focus();
    return;
  }

  try {
    state.busy = true;
    setStatus("Printing label and preparing the next bag...");
    const selectedOwnerId = getSelectedBagOwnerId();
    if (selectedOwnerId && String(selectedOwnerId) !== String(state.currentLot?.owner_employee_id || "")) {
      state.busy = false;
      await updateCurrentLotOwner(selectedOwnerId, { silent: true });
      state.busy = true;
    }
    await updateCurrentLotAuctionNumber(auctionNumber);
    if ($("label-free-text")) $("label-free-text").value = auctionNumber;
    const printed = await generateLiveLabel({ suppressStatus: true });
    if (!printed) return;

    saveLastAuctionNumber(state.currentLot.auction_number);
    state.currentLot = null;
    state.lotItems = [];
    clearScan();
    renderAll();
    state.busy = false;
    await prepareNextBag();
    setStatus(`Label for auction ${auctionNumber} was generated. Next bag is ready.`, "success");
  } catch (error) {
    console.error("Finalize live-sale bag failed:", error);
    setStatus(error.message || "Could not finish this auction bag.", "error");
  } finally {
    state.busy = false;
  }
}

function scheduleItemSearch() {
  if (state.itemSearchTimer) clearTimeout(state.itemSearchTimer);
  const term = sanitizeSearchTerm($("item-scan")?.value || "");
  if (!term) return;
  state.itemSearchTimer = setTimeout(() => {
    state.itemSearchTimer = null;
    if (sanitizeSearchTerm($("item-scan")?.value || "")) findItemForScan();
  }, 750);
}

function setupListeners() {
  $("session-store-select")?.addEventListener("change", (event) => {
    saveStoreId(event.target.value || "");
    syncStartingAuctionSuggestion();
  });
  $("session-title")?.addEventListener("input", (event) => {
    event.target.dataset.autoTitle = "false";
  });
  $("session-start-auction-number")?.addEventListener("input", (event) => {
    event.target.dataset.autoAuctionStart = event.target.value.trim() ? "false" : "true";
  });
  $("session-primary-seller")?.addEventListener("change", () => {
    if (!state.currentSession) {
      renderSellerControls();
    }
  });
  $("session-co-sellers")?.addEventListener("change", () => {
    if (!state.currentSession) {
      renderSellerControls();
    }
  });
  const handleBagOwnerChange = (event) => {
    const ownerId = event.target.value || "";
    if ($("bag-owner-select") && $("bag-owner-select") !== event.target) $("bag-owner-select").value = ownerId;
    if ($("label-bag-owner-select") && $("label-bag-owner-select") !== event.target) $("label-bag-owner-select").value = ownerId;
    if (ownerId) updateCurrentLotOwner(ownerId);
  };
  $("bag-owner-select")?.addEventListener("change", handleBagOwnerChange);
  $("label-bag-owner-select")?.addEventListener("change", handleBagOwnerChange);
  $("refresh-live-sales")?.addEventListener("click", async () => {
    await loadStores();
    await loadSellerDirectory();
    await loadSessions();
    if (state.currentLot) await reloadCurrentLot();
    await loadLotItems();
    setStatus("Live sales refreshed.", "success");
  });
  $("start-session")?.addEventListener("click", startSession);
  $("end-session")?.addEventListener("click", endSession);
  $("open-bag-history")?.addEventListener("click", openBagHistoryModal);
  $("bag-history-refresh")?.addEventListener("click", loadBagHistory);
  $("bag-history-close")?.addEventListener("click", closeBagHistoryModal);
  $("bag-history-search")?.addEventListener("input", (event) => {
    state.bagHistorySearch = event.target.value || "";
    renderBagHistory();
  });
  document.querySelectorAll("[data-close-bag-history]").forEach((node) => {
    node.addEventListener("click", closeBagHistoryModal);
  });
  $("cancel-session")?.addEventListener("click", openCancelSessionModal);
  $("cancel-session-confirm")?.addEventListener("click", submitCancelSession);
  $("cancel-session-dismiss")?.addEventListener("click", closeCancelSessionModal);
  $("cancel-session-close")?.addEventListener("click", closeCancelSessionModal);
  document.querySelectorAll("[data-close-cancel-session]").forEach((node) => {
    node.addEventListener("click", closeCancelSessionModal);
  });
  $("cancel-session-password")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitCancelSession();
    }
  });
  $("cancel-session-reason")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitCancelSession();
    }
  });
  $("create-lot")?.addEventListener("click", () => createOrLoadLot());
  $("generate-live-label")?.addEventListener("click", finalizeCurrentBag);
  $("scan-item")?.addEventListener("click", findItemForScan);
  $("add-manual-live-item")?.addEventListener("click", addManualLiveSaleItem);
  ["manual-live-item-category", "manual-live-item-quantity", "manual-live-item-description"].forEach((id) => {
    $(id)?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        addManualLiveSaleItem();
      }
    });
  });
  $("clear-scan")?.addEventListener("click", () => {
    clearScan();
    setStatus("");
  });
  $("cancel-lot")?.addEventListener("click", cancelCurrentLot);
  $("live-photo-close")?.addEventListener("click", closeLivePhotoModal);
  $("live-photo-zoom-in")?.addEventListener("click", () => setLivePhotoZoom(state.photoZoom + 0.25));
  $("live-photo-zoom-out")?.addEventListener("click", () => setLivePhotoZoom(state.photoZoom - 0.25));
  $("live-photo-modal-image")?.addEventListener("click", (event) => {
    if (state.photoSuppressClick) {
      event.preventDefault();
      return;
    }
    setLivePhotoZoom(state.photoZoom > 1 ? 1 : 2);
  });
  $("live-photo-modal-image")?.addEventListener("pointerdown", startLivePhotoDrag);
  $("live-photo-modal-image")?.addEventListener("pointermove", moveLivePhotoDrag);
  $("live-photo-modal-image")?.addEventListener("pointerup", endLivePhotoDrag);
  $("live-photo-modal-image")?.addEventListener("pointercancel", endLivePhotoDrag);
  $("live-photo-modal-image")?.addEventListener("wheel", (event) => {
    event.preventDefault();
    setLivePhotoZoom(state.photoZoom + (event.deltaY < 0 ? 0.2 : -0.2));
  }, { passive: false });
  document.querySelectorAll("[data-close-live-photo]").forEach((node) => {
    node.addEventListener("click", closeLivePhotoModal);
  });
  $("edit-bag-find-replacement")?.addEventListener("click", findEditReplacementItem);
  $("edit-bag-clear-replacement")?.addEventListener("click", clearEditReplacement);
  $("edit-bag-confirm")?.addEventListener("click", applyEditBagCorrection);
  $("edit-bag-cancel")?.addEventListener("click", closeEditBagItemModal);
  $("edit-bag-item-close")?.addEventListener("click", closeEditBagItemModal);
  document.querySelectorAll("[data-close-edit-bag-item]").forEach((node) => {
    node.addEventListener("click", closeEditBagItemModal);
  });
  $("edit-bag-replacement-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      findEditReplacementItem();
    }
  });
  $("edit-bag-quantity")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      applyEditBagCorrection();
    }
  });

  $("item-scan")?.addEventListener("focus", () => {
    if (state.scannerRefocusTimer) {
      clearTimeout(state.scannerRefocusTimer);
      state.scannerRefocusTimer = null;
    }
  });

  $("auction-number")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (state.flowStep === "label") finalizeCurrentBag();
      else createOrLoadLot();
    }
  });
  $("auction-number")?.addEventListener("input", renderLabelReview);

  $("label-free-text")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && state.flowStep === "label") {
      event.preventDefault();
      finalizeCurrentBag();
    }
  });
  $("back-to-scan")?.addEventListener("click", () => {
    setFlowStep("scan");
    setStatus("Back in scan mode. Add the missing item, then press Enter on an empty scanner to confirm again.", "success");
    setTimeout(() => focusItemScanner(), 80);
  });

  $("item-scan")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (state.itemSearchTimer) clearTimeout(state.itemSearchTimer);
      const term = sanitizeSearchTerm($("item-scan")?.value || "");
      if (term) findItemForScan();
      else finishBagScanning();
      return;
    }

    if (event.key === " " && !sanitizeSearchTerm($("item-scan")?.value || "")) {
      event.preventDefault();
      clearScan();
      setStatus("Scanner is ready for the next item. Press Enter on an empty scanner when this bag is complete.", "success");
      focusItemScanner();
    }
  });
  $("item-scan")?.addEventListener("input", scheduleItemSearch);

  document.addEventListener("keydown", (event) => {
    if (!$("live-photo-modal")?.hidden) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        closeLivePhotoModal();
      }
      return;
    }

    if (!$("edit-bag-item-modal")?.hidden && event.key === "Escape") {
      event.preventDefault();
      closeEditBagItemModal();
      return;
    }

    if (!$("bag-history-modal")?.hidden && event.key === "Escape") {
      event.preventDefault();
      closeBagHistoryModal();
      return;
    }

    const active = document.activeElement;
    const tag = active?.tagName?.toLowerCase();
    const isTypingAwayFromScanner = tag === "input" || tag === "textarea" || tag === "select";
    if (event.key === " " && state.flowStep === "scan" && !isTypingAwayFromScanner) {
      event.preventDefault();
      focusItemScanner();
      setStatus("Scanner is ready for the next item. Press Enter on an empty scanner to print.", "success");
    }
  });

  ["click", "input", "pointerup", "touchend"].forEach((eventName) => {
    document.addEventListener(eventName, () => scheduleScannerRefocus(), true);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseReady();
  const ok = await loadCurrentWorker();
  if (!ok || !canManageLiveSales()) return;
  setupShell();
  setupListeners();
  const titleInput = $("session-title");
  if (titleInput && !titleInput.value.trim()) {
    titleInput.value = formatSessionTitleDate();
    titleInput.dataset.autoTitle = "true";
  }
  await loadSellerDirectory();
  await loadStores();
  await loadSessions({ keepSelection: false });
  if (state.currentSession) await prepareNextBag();
  renderAll();
  if (window.lucide) window.lucide.createIcons();
});
