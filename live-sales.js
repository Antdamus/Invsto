"use strict";

const state = {
  user: null,
  employee: null,
  stores: [],
  sessions: [],
  currentSession: null,
  currentLot: null,
  lotItems: [],
  selectedItem: null,
  sourceRows: [],
  selectedSourceRow: null,
  sourceReservations: new Map(),
  itemSearchTimer: null,
  flowStep: "session",
  photoZoom: 1,
  photoPanX: 0,
  photoPanY: 0,
  photoDrag: null,
  photoSuppressClick: false,
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
  return `og-live-sales-last-auction:${state.user?.id || "anonymous"}:${state.currentSession?.store_id || "no-store"}`;
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
  card.innerHTML = `
    <strong>Auction ${escapeHtml(state.currentLot.auction_number)}</strong>
    <span>Bag ID ${escapeHtml(state.currentLot.lot_code)} - ${escapeHtml(state.currentLot.status || "open")}</span>
    <small>${state.currentLot.label_path ? `DYMO label: ${escapeHtml(state.currentLot.label_path)}` : "DYMO label has not been generated yet."}</small>
  `;
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
  $("reserve-quantity")?.toggleAttribute("disabled", !enabled);
  $("reserve-item")?.toggleAttribute("disabled", !enabled || !state.selectedItem || !state.selectedSourceRow);
  $("generate-live-label")?.toggleAttribute("disabled", !state.currentLot || !state.lotItems.length);
  $("cancel-lot")?.toggleAttribute("disabled", !state.currentLot || state.currentLot.status === "packed");
}

function renderAll() {
  renderFlowState();
  renderSessions();
  renderSummary();
  renderCurrentLot();
  renderManifest();
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
    renderAll();
    return;
  }

  const { data, error } = await supabase
    .from("live_sale_lot_items")
    .select(`
      *,
      item:item_id(id,title,description,barcode,weight,sale_price,photos,photo_url),
      source_location:source_location_id(id,location_name,location_code,store_id,tray_current_store_id,is_tray,location_role)
    `)
    .eq("lot_id", state.currentLot.id)
    .order("scanned_at", { ascending: true });

  if (error) {
    console.warn("Live sale lot items failed to load:", error);
    state.lotItems = [];
  } else {
    state.lotItems = data || [];
  }

  renderAll();
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

  state.lotItems.forEach((entry) => {
    const item = entry.item || {};
    const loc = entry.source_location || {};
    const article = document.createElement("article");
    article.className = "manifest-item";
    article.innerHTML = `
      <div class="manifest-thumb"><span>No photo</span></div>
      <div class="manifest-copy">
        <strong>${escapeHtml(item.title || "Untitled item")}</strong>
        <span>${escapeHtml(item.barcode || "-")} - Qty ${Number(entry.quantity || 1).toLocaleString()} - ${escapeHtml(entry.status || "reserved")}</span>
        <small>${escapeHtml(loc.location_name || "Unknown source")} ${loc.location_code ? `(${escapeHtml(loc.location_code)})` : ""} - Live minute ${escapeHtml(formatElapsed(entry.show_elapsed_seconds))}</small>
      </div>
      <div class="manifest-actions">
        ${entry.status === "reserved" ? `<button type="button" class="tiny-btn" data-release-lot-item="${escapeHtml(entry.id)}">Release</button>` : ""}
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

  list.querySelectorAll("[data-release-lot-item]").forEach((button) => {
    button.addEventListener("click", () => releaseLotItem(button.getAttribute("data-release-lot-item")));
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

  if (!storeId) {
    setStatus("Select the store where the live sale is happening.", "error");
    $("session-store-select")?.focus();
    return;
  }

  try {
    saveStoreId(storeId);
    state.busy = true;
    setStatus("Starting live sale session...");
    const { data, error } = await supabase.rpc("start_live_sale_session", {
      _title: title,
      _store_id: storeId,
      _notes: notes,
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;
    state.currentSession = Array.isArray(data) ? data[0] : data;
    state.currentLot = null;
    await loadSessions({ keepSelection: true });
    state.busy = false;
    await prepareNextBag();
    setStatus("Show session started. Scan the first item into the current bag.", "success");
  } catch (error) {
    console.error("Start live sale session failed:", error);
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

async function createOrLoadLot(options = {}) {
  if (state.busy && !options.force) return;
  if (!state.currentSession) {
    setStatus("Start or select a live sale session first.", "error");
    return;
  }

  const auctionNumber = String(options.auctionNumber ?? $("auction-number")?.value ?? "").trim();
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
  } catch (error) {
    console.error("Create live sale lot failed:", error);
    setStatus(error.message || "Could not create the auction bag.", "error");
  } finally {
    state.busy = false;
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

  const nextAuctionNumber = await getNextAuctionNumber();
  if ($("auction-number")) $("auction-number").value = nextAuctionNumber;
  if ($("label-free-text")) $("label-free-text").value = nextAuctionNumber;
  await createOrLoadLot({ auctionNumber: nextAuctionNumber, silent: true, focusScan: true });
  setStatus(`Bag ${nextAuctionNumber} is ready. Scan items, press Space for the next scan, or press Enter on an empty scanner to print.`, "success");
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
      <small>${escapeHtml(state.selectedSourceRow?.locationLabel || "Choose source tray")}</small>
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
  setStatus("Loading source trays for the scanned item...");

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
    setStatus(rowError.message || "Could not load source trays.", "error");
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
  state.sourceRows = (rows || [])
    .map((row) => normalizeSourceRow(row))
    .filter((row) => {
      const inStore = !sessionStoreId || row.store_id === sessionStoreId;
      return row.isTray && inStore && row.tray_status !== "checked_out" && row.available_quantity > 0;
    });

  state.selectedSourceRow = state.sourceRows.length === 1 ? state.sourceRows[0] : null;
  renderSourceRows();
  renderSelectedItem();

  if (state.selectedSourceRow) {
    if (state.flowStep === "scan") {
      setStatus("Only one available tray source was found. Reserving it now...", "success");
      await reserveSelectedItem({ auto: true });
    } else {
      setStatus("Only one available tray source was found. Quantity is ready.", "success");
      $("reserve-quantity")?.focus();
      $("reserve-quantity")?.select();
    }
  } else if (state.sourceRows.length) {
    setStatus(`${state.sourceRows.length} source trays found. Choose the tray the item came from.`, "info");
  } else {
    setStatus("This item has no unreserved stock in a checked-in tray for this live sale store.", "error");
  }
}

function normalizeSourceRow(row) {
  const loc = row.location || {};
  const isTray = Boolean(loc.is_tray || loc.location_role === "tray");
  const storeId = isTray ? (loc.tray_current_store_id || loc.store_id || "") : (loc.store_id || "");
  const reserved = state.sourceReservations.get(row.id) || 0;
  const available = Math.max(0, Number(row.quantity || 0) - reserved);
  const storeName = getStoreName(storeId);
  return {
    ...row,
    isTray,
    store_id: storeId,
    tray_status: loc.tray_status || "",
    location_name: loc.location_name || "",
    location_code: loc.location_code || "",
    reserved_quantity: reserved,
    available_quantity: available,
    locationLabel: `${loc.location_name || "Unnamed tray"}${loc.location_code ? ` (${loc.location_code})` : ""}${storeName ? ` - ${storeName}` : ""}`,
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
    container.innerHTML = `<div class="empty-state">No available checked-in tray source found.</div>`;
    updateScanGate();
    return;
  }

  state.sourceRows.forEach((row) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `source-btn ${state.selectedSourceRow?.id === row.id ? "is-selected" : ""}`;
    button.innerHTML = `
      <span>
        <strong>${escapeHtml(row.locationLabel)}</strong>
        <small>${Number(row.available_quantity || 0).toLocaleString()} available after ${Number(row.reserved_quantity || 0).toLocaleString()} reserved</small>
      </span>
      <b>Select</b>
    `;
    button.addEventListener("click", () => {
      state.selectedSourceRow = row;
      renderSourceRows();
      renderSelectedItem();
      setStatus("Source tray selected. Confirm the quantity and reserve.", "success");
      $("reserve-quantity")?.focus();
      $("reserve-quantity")?.select();
    });
    container.appendChild(button);
  });

  updateScanGate();
}

async function reserveSelectedItem(options = {}) {
  if (!state.currentLot || !state.selectedItem || !state.selectedSourceRow || state.busy) {
    setStatus("Scan an item and choose its source tray first.", "error");
    return;
  }

  const qty = Math.max(1, parseInt($("reserve-quantity")?.value || "1", 10) || 1);
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
  if ($("reserve-quantity")) $("reserve-quantity").value = "1";
  renderSelectedItem();
  renderSourceRows();
  updateScanGate();
}

async function releaseLotItem(lotItemId) {
  if (!lotItemId) return;
  const ok = window.confirm("Release this item from the auction bag reservation?");
  if (!ok) return;

  try {
    const { data, error } = await supabase.rpc("release_live_sale_lot_item", {
      _lot_item_id: lotItemId,
      _notes: "Released from live-sale bag before packing",
      _signed_by_email: state.user?.email || null,
    });
    if (error) throw error;
    const changedItemId = Array.isArray(data) ? data[0]?.item_id : data?.item_id;
    await bumpInventoryVersion(changedItemId ? [changedItemId] : []);
    await reloadCurrentLot();
    await loadLotItems();
    setStatus("Reservation released.", "success");
  } catch (error) {
    console.error("Release live sale item failed:", error);
    setStatus(error.message || "Could not release that reservation.", "error");
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
        ${textObject("TextObject0", rightText, "1.4095135", "0.43833333", "4.8")}
        ${qrObject("QRCodeObject2", lotValue, "0.26554355", "0.47743064", "0.30536497", "0.30013865")}
        ${qrObject("QRCodeObject3", lotValue, "0.2628106", "0.09862068", "0.308098", "0.290851")}
        ${textObject("TextObject4", leftText, "0.13781057", "0.43833315", "4")}
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
    const safeLot = String(state.currentLot.lot_code || "live-bag").replace(/[^a-z0-9_-]+/gi, "_");
    const labelPath = `labels/live_sale_${safeLot}_${Date.now()}.dymo`;
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

    downloadTextFile(xml, `LiveSale_${state.currentLot.auction_number}_${state.currentLot.lot_code}.dymo`);
    const signed = await supabase.storage.from("dymo-labels").createSignedUrl(labelPath, 3600);
    const openLink = signed.data?.signedUrl
      ? ` <a href="${escapeHtml(signed.data.signedUrl)}" target="_blank" rel="noreferrer">Open uploaded label</a>`
      : "";
    setLabelStatus(`DYMO label generated and uploaded.${openLink}`, "success");
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
  if (!state.lotItems.length) {
    setStatus("Scan at least one item before printing the auction bag label.", "error");
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
  setStatus("Confirm the auction number. Press Enter to generate the DYMO label and start the next bag.", "success");
}

async function finalizeCurrentBag() {
  if (!state.currentLot || state.busy) return;
  if (!state.lotItems.length) {
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
  });
  $("session-title")?.addEventListener("input", (event) => {
    event.target.dataset.autoTitle = "false";
  });
  $("refresh-live-sales")?.addEventListener("click", async () => {
    await loadStores();
    await loadSessions();
    if (state.currentLot) await reloadCurrentLot();
    await loadLotItems();
    setStatus("Live sales refreshed.", "success");
  });
  $("start-session")?.addEventListener("click", startSession);
  $("end-session")?.addEventListener("click", endSession);
  $("create-lot")?.addEventListener("click", () => createOrLoadLot());
  $("generate-live-label")?.addEventListener("click", finalizeCurrentBag);
  $("scan-item")?.addEventListener("click", findItemForScan);
  $("reserve-item")?.addEventListener("click", reserveSelectedItem);
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

  $("auction-number")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      if (state.flowStep === "label") finalizeCurrentBag();
      else createOrLoadLot();
    }
  });

  $("label-free-text")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && state.flowStep === "label") {
      event.preventDefault();
      finalizeCurrentBag();
    }
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

  $("reserve-quantity")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      reserveSelectedItem();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (!$("live-photo-modal")?.hidden) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        closeLivePhotoModal();
      }
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
  await loadStores();
  await loadSessions({ keepSelection: false });
  if (state.currentSession) await prepareNextBag();
  renderAll();
  if (window.lucide) window.lucide.createIcons();
});
