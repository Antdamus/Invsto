"use strict";

const state = {
  user: null,
  employee: null,
  stores: [],
  sessions: [],
  lots: [],
  lotItems: [],
  events: [],
  selectedSessionId: "",
  currentAction: null,
  photoZoom: 1,
  photoPanX: 0,
  photoPanY: 0,
  photoDrag: null,
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

function formatDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatShortDateTime(value) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function toDateInputValue(date = new Date()) {
  const copy = new Date(date);
  copy.setMinutes(copy.getMinutes() - copy.getTimezoneOffset());
  return copy.toISOString().slice(0, 10);
}

function formatElapsed(seconds) {
  const safe = Math.max(0, Number(seconds || 0));
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${String(remaining).padStart(2, "0")}`;
}

function formatDuration(startedAt, endedAt) {
  if (!startedAt) return "-";
  const start = new Date(startedAt);
  const end = endedAt ? new Date(endedAt) : new Date();
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "-";
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function setStatus(message = "", type = "info") {
  const el = $("past-live-status");
  if (!el) return;
  el.textContent = message;
  el.classList.toggle("is-error", type === "error");
  el.classList.toggle("is-success", type === "success");
}

function setActionError(message = "") {
  const el = $("past-action-error");
  if (el) el.textContent = message;
}

function getStoreName(storeId) {
  return state.stores.find((store) => store.id === storeId)?.name || "Unassigned";
}

function getStatusClass(status = "") {
  const clean = String(status || "").toLowerCase();
  if (clean === "active") return "is-active";
  if (clean === "ended" || clean === "packed") return "is-ended";
  if (clean === "cancelled" || clean === "released") return "is-cancelled";
  if (clean === "archived") return "is-archived";
  return "";
}

function statusLabel(status = "") {
  const clean = String(status || "").trim();
  if (!clean) return "Unknown";
  return clean.charAt(0).toUpperCase() + clean.slice(1);
}

function getSelectedSession() {
  return state.sessions.find((session) => String(session.id) === String(state.selectedSessionId)) || null;
}

function getLotsForSession(sessionId) {
  return state.lots.filter((lot) => String(lot.session_id) === String(sessionId));
}

function getItemsForLot(lotId) {
  return state.lotItems.filter((entry) => String(entry.lot_id) === String(lotId));
}

function getEventsForSession(sessionId) {
  return state.events
    .filter((event) => String(event.session_id) === String(sessionId))
    .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
}

function firstItemPhoto(item) {
  const photos = Array.isArray(item?.photos) ? item.photos : [];
  return photos.find(Boolean) || item?.photo_url || "";
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
      location_code: category,
      location_role: "manual",
      type: "manual",
    },
  };
}

async function resolvePhotoUrl(path) {
  if (!path) return "";
  if (/^https?:\/\//i.test(path)) return path;
  const cleanPath = String(path).replace(/^photos\//, "");
  const { data, error } = await supabase.storage.from("photos").createSignedUrl(cleanPath, 3600);
  if (error) return "";
  return data?.signedUrl || "";
}

function groupLotItems(lotId) {
  const groups = new Map();
  getItemsForLot(lotId).forEach((entry) => {
    if (entry.is_manual) {
      const category = String(entry.item_category || entry.source_location?.location_code || "General").trim() || "General";
      const description = String(entry.item_description || entry.item?.description || entry.item?.title || "").trim();
      const status = entry.status || "reserved";
      const key = `manual::${category.toLowerCase()}::${description.toLowerCase()}::${status}`;
      if (!groups.has(key)) {
        groups.set(key, {
          key,
          isManual: true,
          manualCategory: category,
          manualDescription: description,
          item: entry.item || {},
          sourceLocation: entry.source_location || {},
          status,
          quantity: 0,
          showElapsedSeconds: entry.show_elapsed_seconds,
          scannedBy: entry.scanned_by_email,
          scannedAt: entry.scanned_at || entry.created_at,
        });
      }
      const group = groups.get(key);
      group.quantity += Number(entry.quantity || 0);
      if (entry.show_elapsed_seconds != null) {
        group.showElapsedSeconds = Math.min(
          Number(group.showElapsedSeconds ?? entry.show_elapsed_seconds),
          Number(entry.show_elapsed_seconds),
        );
      }
      return;
    }

    const itemId = entry.item_id || entry.item?.id || "";
    const sourceRowId = entry.source_stock_location_row_id || "";
    const status = entry.status || "reserved";
    const key = `${itemId}::${sourceRowId}::${status}`;
    if (!groups.has(key)) {
      groups.set(key, {
        key,
        item: entry.item || {},
        sourceLocation: entry.source_location || {},
        status,
        quantity: 0,
        showElapsedSeconds: entry.show_elapsed_seconds,
        scannedBy: entry.scanned_by_email,
        scannedAt: entry.scanned_at,
      });
    }
    const group = groups.get(key);
    group.quantity += Number(entry.quantity || 0);
    if (entry.show_elapsed_seconds != null) {
      group.showElapsedSeconds = Math.min(
        Number(group.showElapsedSeconds ?? entry.show_elapsed_seconds),
        Number(entry.show_elapsed_seconds),
      );
    }
  });
  return Array.from(groups.values());
}

function getLotTotals(lotId) {
  const groups = groupLotItems(lotId);
  return {
    types: groups.length,
    units: groups.reduce((sum, group) => sum + Number(group.quantity || 0), 0),
  };
}

function getSessionTotals(sessionId) {
  const lots = getLotsForSession(sessionId);
  const units = lots.reduce((sum, lot) => sum + getLotTotals(lot.id).units, 0);
  return {
    lots: lots.length,
    units,
    attention: lots.filter((lot) => ["open", "reserved"].includes(lot.status) || !lot.label_path).length,
  };
}

function getFilters() {
  return {
    from: $("filter-from")?.value || "",
    to: $("filter-to")?.value || "",
    storeId: $("filter-store")?.value || "",
    status: $("filter-status")?.value || "",
    search: String($("filter-search")?.value || "").trim().toLowerCase(),
  };
}

function sessionMatchesSearch(session, term) {
  if (!term) return true;
  const lots = getLotsForSession(session.id);
  const relatedItems = lots.flatMap((lot) => getItemsForLot(lot.id));
  const haystack = [
    session.title,
    session.session_code,
    session.status,
    session.started_by_email,
    session.notes,
    getStoreName(session.store_id),
    ...lots.flatMap((lot) => [lot.auction_number, lot.lot_code, lot.status, lot.notes, lot.label_path]),
    ...relatedItems.flatMap((entry) => [
      entry.item_category,
      entry.item_description,
      entry.item?.title,
      entry.item?.description,
      entry.item?.barcode,
      entry.source_location?.location_name,
      entry.source_location?.location_code,
      entry.scanned_by_email,
      entry.status,
    ]),
  ].filter(Boolean).join(" ").toLowerCase();
  return haystack.includes(term);
}

async function checkAdminAuth() {
  const { data: sessionData, error } = await supabase.auth.getSession();
  if (error || !sessionData?.session) {
    window.location.href = "index.html";
    return false;
  }

  state.user = sessionData.session.user;
  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("id, user_id, display_name, role, active")
    .eq("user_id", state.user.id)
    .maybeSingle();

  if (employeeError || !employee || employee.active === false || String(employee.role || "").toLowerCase() !== "admin") {
    window.location.href = "worker-dashboard.html";
    return false;
  }

  state.employee = employee;
  const greeting = $("past-live-greeting");
  if (greeting) greeting.textContent = `Past Live Sales, ${employee.display_name || "Admin"}`;
  return true;
}

function setupShell() {
  const datePill = $("past-live-date-pill");
  if (datePill) {
    datePill.innerHTML = `Date: <b>${new Date().toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" })}</b>`;
  }
}

function setDefaultDateFilters() {
  const today = new Date();
  const from = new Date();
  from.setDate(today.getDate() - 30);
  if ($("filter-from") && !$("filter-from").value) $("filter-from").value = toDateInputValue(from);
  if ($("filter-to") && !$("filter-to").value) $("filter-to").value = toDateInputValue(today);
}

async function loadStores() {
  const { data, error } = await supabase
    .from("store_locations")
    .select("id, name, active")
    .order("name", { ascending: true });

  if (error) {
    console.warn("Past live sale stores failed to load:", error);
    state.stores = [];
  } else {
    state.stores = data || [];
  }

  const select = $("filter-store");
  if (!select) return;
  const current = select.value;
  select.innerHTML = `<option value="">All stores</option>`;
  state.stores.forEach((store) => {
    const option = document.createElement("option");
    option.value = store.id;
    option.textContent = store.name || "Unnamed store";
    select.appendChild(option);
  });
  select.value = current;
}

async function loadPastLiveSales({ keepSelection = true } = {}) {
  if (state.busy) return;
  state.busy = true;
  setStatus("Loading past live sales...");
  renderLoading();

  try {
    const filters = getFilters();
    const fromIso = new Date(`${filters.from || toDateInputValue(new Date())}T00:00:00`).toISOString();
    const toIso = new Date(`${filters.to || filters.from || toDateInputValue(new Date())}T23:59:59.999`).toISOString();

    let query = supabase
      .from("live_sale_sessions")
      .select("*")
      .gte("started_at", fromIso)
      .lte("started_at", toIso)
      .order("started_at", { ascending: false })
      .limit(250);

    if (filters.status) query = query.eq("status", filters.status);
    if (filters.storeId) query = query.eq("store_id", filters.storeId);

    const { data: sessionRows, error: sessionError } = await query;
    if (sessionError) throw sessionError;

    const sessionIds = (sessionRows || []).map((session) => session.id);
    let lots = [];
    let items = [];
    let manualItems = [];
    let events = [];

    if (sessionIds.length) {
      const [lotsResult, itemsResult, manualItemsResult, eventsResult] = await Promise.all([
        supabase
          .from("live_sale_lots")
          .select("*")
          .in("session_id", sessionIds)
          .order("created_at", { ascending: false }),
        supabase
          .from("live_sale_lot_items")
          .select(`
            *,
            item:item_id(id,title,description,barcode,weight,sale_price,photos,photo_url),
            source_location:source_location_id(id,location_name,location_code,store_id,tray_current_store_id,is_tray,location_role,type,parent_location_id)
          `)
          .in("session_id", sessionIds)
          .order("scanned_at", { ascending: true }),
        supabase
          .from("live_sale_manual_lot_items")
          .select("*")
          .in("session_id", sessionIds)
          .order("created_at", { ascending: true }),
        supabase
          .from("live_sale_events")
          .select("*")
          .in("session_id", sessionIds)
          .order("created_at", { ascending: false }),
      ]);
      if (lotsResult.error) throw lotsResult.error;
      if (itemsResult.error) throw itemsResult.error;
      if (manualItemsResult.error) throw manualItemsResult.error;
      if (eventsResult.error) throw eventsResult.error;
      lots = lotsResult.data || [];
      items = itemsResult.data || [];
      manualItems = manualItemsResult.data || [];
      events = eventsResult.data || [];
    }

    state.lots = lots;
    state.lotItems = [
      ...items,
      ...manualItems.map(normalizeManualLiveSaleItem),
    ].sort((a, b) => new Date(a.scanned_at || a.created_at || 0) - new Date(b.scanned_at || b.created_at || 0));
    state.events = events;
    state.sessions = (sessionRows || []).filter((session) => sessionMatchesSearch(session, filters.search));

    if (!keepSelection || !state.sessions.some((session) => String(session.id) === String(state.selectedSessionId))) {
      state.selectedSessionId = state.sessions[0]?.id || "";
    }

    renderAll();
    setStatus(state.sessions.length ? `Loaded ${state.sessions.length.toLocaleString()} live sale session${state.sessions.length === 1 ? "" : "s"}.` : "No live sale sessions matched those filters.", state.sessions.length ? "success" : "info");
  } catch (error) {
    console.error("Load past live sales failed:", error);
    state.sessions = [];
    state.lots = [];
    state.lotItems = [];
    state.events = [];
    renderAll();
    setStatus(error?.message || "Could not load past live sales.", "error");
  } finally {
    state.busy = false;
  }
}

function renderLoading() {
  const list = $("session-list");
  if (list) list.innerHTML = `<div class="past-empty">Loading live sale sessions...</div>`;
}

function renderAll() {
  renderStats();
  renderSessions();
  renderSelectedSession();
  if (window.lucide) window.lucide.createIcons();
}

function renderStats() {
  const totals = state.sessions.reduce((acc, session) => {
    const sessionTotals = getSessionTotals(session.id);
    acc.bags += sessionTotals.lots;
    acc.units += sessionTotals.units;
    acc.attention += sessionTotals.attention;
    return acc;
  }, { bags: 0, units: 0, attention: 0 });

  $("stat-sessions").textContent = state.sessions.length.toLocaleString();
  $("stat-bags").textContent = totals.bags.toLocaleString();
  $("stat-units").textContent = totals.units.toLocaleString();
  $("stat-attention").textContent = totals.attention.toLocaleString();
  $("session-count-pill").textContent = state.sessions.length.toLocaleString();
}

function renderSessions() {
  const list = $("session-list");
  if (!list) return;
  list.replaceChildren();

  if (!state.sessions.length) {
    list.innerHTML = `<div class="past-empty">No sessions match the current filters.</div>`;
    return;
  }

  state.sessions.forEach((session) => {
    const totals = getSessionTotals(session.id);
    const button = document.createElement("button");
    button.type = "button";
    button.className = `session-card ${String(session.id) === String(state.selectedSessionId) ? "is-selected" : ""}`;
    button.innerHTML = `
      <div class="session-card-head">
        <div>
          <strong>${escapeHtml(session.title || "Live Sale")}</strong>
          <span>${escapeHtml(getStoreName(session.store_id))}</span>
        </div>
        <b class="status-badge ${getStatusClass(session.status)}">${escapeHtml(statusLabel(session.status))}</b>
      </div>
      <small>${escapeHtml(formatShortDateTime(session.started_at))} - ${escapeHtml(formatDuration(session.started_at, session.ended_at))}</small>
      <div class="bag-meta">
        <span>${totals.lots.toLocaleString()} bag${totals.lots === 1 ? "" : "s"}</span>
        <span>${totals.units.toLocaleString()} unit${totals.units === 1 ? "" : "s"}</span>
        <span>${escapeHtml(session.session_code || "-")}</span>
      </div>
    `;
    button.addEventListener("click", () => {
      state.selectedSessionId = session.id;
      renderAll();
    });
    list.appendChild(button);
  });
}

function renderSelectedSession() {
  const empty = $("session-detail-empty");
  const content = $("session-detail-content");
  const session = getSelectedSession();

  if (!empty || !content) return;
  if (!session) {
    empty.hidden = false;
    content.hidden = true;
    return;
  }

  empty.hidden = true;
  content.hidden = false;
  const totals = getSessionTotals(session.id);
  $("detail-status").textContent = statusLabel(session.status);
  $("detail-status").className = `status-badge ${getStatusClass(session.status)}`;
  $("detail-title").textContent = session.title || "Live Sale";
  $("detail-meta").textContent = `${session.session_code || "-"} - Started by ${session.started_by_email || "unknown"} - ${totals.lots} bag${totals.lots === 1 ? "" : "s"} / ${totals.units} unit${totals.units === 1 ? "" : "s"}`;
  $("detail-started").textContent = formatDateTime(session.started_at);
  $("detail-ended").textContent = session.ended_at ? formatDateTime(session.ended_at) : "Still active";
  $("detail-duration").textContent = formatDuration(session.started_at, session.ended_at);
  $("detail-store").textContent = getStoreName(session.store_id);
  const eventCount = getEventsForSession(session.id).length;
  $("audit-button-label").textContent = `Audit Trail (${eventCount.toLocaleString()})`;

  const cancelBtn = $("cancel-session-from-history");
  const archiveBtn = $("archive-session");
  if (cancelBtn) cancelBtn.hidden = session.status !== "active";
  if (archiveBtn) archiveBtn.hidden = session.status === "active" || session.status === "archived";

  renderBagList(session);
}

function renderBagList(session) {
  const list = $("bag-list");
  if (!list) return;
  const lots = getLotsForSession(session.id).sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
  list.replaceChildren();

  if (!lots.length) {
    list.innerHTML = `<div class="past-empty">No auction bags were created in this session.</div>`;
    return;
  }

  lots.forEach((lot) => {
    const totals = getLotTotals(lot.id);
    const groups = groupLotItems(lot.id);
    const card = document.createElement("article");
    card.className = "bag-card";
    card.innerHTML = `
      <div class="bag-card-head">
        <div>
          <span class="eyebrow">Auction ${escapeHtml(lot.auction_number || "-")}</span>
          <strong>${escapeHtml(lot.lot_code || "Auction Bag")}</strong>
          <div class="bag-meta">
            <span>${totals.types.toLocaleString()} type${totals.types === 1 ? "" : "s"}</span>
            <span>${totals.units.toLocaleString()} unit${totals.units === 1 ? "" : "s"}</span>
            <span>Created ${escapeHtml(formatShortDateTime(lot.created_at))}</span>
            <span>${lot.label_path ? "Label ready" : "No label recorded"}</span>
            ${lot.closed_at ? `<span>Closed ${escapeHtml(formatShortDateTime(lot.closed_at))}</span>` : ""}
          </div>
        </div>
        <div class="bag-actions">
          <b class="status-badge ${getStatusClass(lot.status)}">${escapeHtml(statusLabel(lot.status))}</b>
          <button type="button" class="tiny-btn" data-print-label="${escapeHtml(lot.id)}">Print Label</button>
          <button type="button" class="tiny-btn" data-edit-lot="${escapeHtml(lot.id)}">Edit</button>
          ${["open", "reserved"].includes(lot.status) ? `<button type="button" class="tiny-btn danger-btn" data-cancel-lot="${escapeHtml(lot.id)}">Cancel Bag</button>` : ""}
        </div>
      </div>
      <div class="bag-items"></div>
    `;
    list.appendChild(card);

    const itemWrap = card.querySelector(".bag-items");
    if (!groups.length) {
      itemWrap.innerHTML = `<div class="past-empty">This bag has no item records.</div>`;
    } else {
      groups.forEach((group) => renderBagItem(itemWrap, group));
    }
  });

  list.querySelectorAll("[data-print-label]").forEach((button) => {
    button.addEventListener("click", () => printLiveSaleBagLabel(button.getAttribute("data-print-label")));
  });
  list.querySelectorAll("[data-edit-lot]").forEach((button) => {
    button.addEventListener("click", () => openEditLotModal(button.getAttribute("data-edit-lot")));
  });
  list.querySelectorAll("[data-cancel-lot]").forEach((button) => {
    button.addEventListener("click", () => openCancelLotModal(button.getAttribute("data-cancel-lot")));
  });
}

function renderBagItem(container, group) {
  const item = group.item || {};
  const source = group.sourceLocation || {};
  const isManual = Boolean(group.isManual);
  const title = isManual
    ? group.manualDescription || group.manualCategory || item.title || "Manual item"
    : item.title || "Untitled item";
  const sourceLine = isManual
    ? `Manual entry - ${group.manualCategory || "General"}`
    : `${item.barcode || "-"} - ${source.location_name || "Unknown source"} ${source.location_code ? `(${source.location_code})` : ""}`;
  const row = document.createElement("article");
  row.className = `bag-item${isManual ? " is-manual" : ""}`;
  row.innerHTML = `
    <div class="item-thumb"><span>${isManual ? "Manual" : "No photo"}</span></div>
    <div class="item-copy">
      <strong title="${escapeHtml(title)}">${escapeHtml(title)}</strong>
      <span>${escapeHtml(sourceLine)}</span>
      <small>Live minute ${escapeHtml(formatElapsed(group.showElapsedSeconds))} - ${escapeHtml(statusLabel(group.status))} - ${escapeHtml(group.scannedBy || "unknown")}</small>
    </div>
    <div class="qty-pill">Qty ${Number(group.quantity || 0).toLocaleString()}</div>
  `;
  container.appendChild(row);

  if (isManual) return;

  resolvePhotoUrl(firstItemPhoto(item)).then((url) => {
    if (!url || !row.isConnected) return;
    const thumb = row.querySelector(".item-thumb");
    if (!thumb) return;
    thumb.innerHTML = `<button type="button" aria-label="Open ${escapeHtml(item.title || "item")} image"><img src="${escapeHtml(url)}" alt="${escapeHtml(item.title || "Item preview")}" /></button>`;
    thumb.querySelector("button")?.addEventListener("click", () => openPhotoModal(url, item.title || "Item preview"));
  });
}

function renderEventList(session) {
  const list = $("event-modal-list");
  if (!list) return;
  const events = getEventsForSession(session.id);
  list.replaceChildren();

  if (!events.length) {
    list.innerHTML = `<div class="past-empty">No audit events were recorded for this session.</div>`;
    return;
  }

  events.forEach((event) => {
    const card = document.createElement("article");
    card.className = "event-card";
    const lot = state.lots.find((entry) => String(entry.id) === String(event.lot_id));
    const item = state.lotItems.find((entry) => String(entry.id) === String(event.lot_item_id))?.item || null;
    card.innerHTML = `
      <div class="event-card-head">
        <div>
          <strong>${escapeHtml(formatEventType(event.event_type))}</strong>
          <span>${escapeHtml(event.actor_email || "system")} - ${escapeHtml(formatShortDateTime(event.created_at))}</span>
        </div>
        <span class="event-pill">${escapeHtml(lot?.auction_number ? `Auction ${lot.auction_number}` : event.event_type || "event")}</span>
      </div>
      ${item?.title ? `<p>${escapeHtml(item.title)}${item.barcode ? ` - ${escapeHtml(item.barcode)}` : ""}</p>` : ""}
      ${event.notes ? `<p>${escapeHtml(event.notes)}</p>` : ""}
    `;
    list.appendChild(card);
  });
}

function openEventModal() {
  const session = getSelectedSession();
  const modal = $("past-event-modal");
  if (!session || !modal) return;
  $("past-event-title").textContent = `${session.title || "Live Sale"} Audit Trail`;
  const events = getEventsForSession(session.id);
  $("past-event-summary").textContent = `${events.length.toLocaleString()} recorded event${events.length === 1 ? "" : "s"} for ${session.session_code || "this session"}.`;
  renderEventList(session);
  modal.hidden = false;
  document.body.classList.add("past-event-open");
  $("past-event-close")?.focus();
}

function closeEventModal() {
  const modal = $("past-event-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("past-event-open");
}

function formatEventType(value = "") {
  return String(value || "event")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
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

function getLiveSaleLabelBaseName(lot, session) {
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

async function printLiveSaleBagLabel(lotId) {
  const lot = state.lots.find((entry) => String(entry.id) === String(lotId));
  const session = lot ? state.sessions.find((entry) => String(entry.id) === String(lot.session_id)) : null;
  if (!lot || !session) {
    setStatus("Could not find that auction bag.", "error");
    return;
  }

  try {
    const xml = buildLiveAuctionDymoXml({
      auctionNumber: lot.auction_number,
      lotCode: lot.lot_code,
      freeText: lot.auction_number,
    });
    const filename = `${getLiveSaleLabelBaseName(lot, session)}_Reprint_Copies_1.dymo`;
    downloadTextFile(xml, filename);
    const { error } = await supabase.rpc("record_live_sale_label_reprint", {
      _lot_id: lot.id,
      _label_path: lot.label_path || null,
      _signed_by_email: state.user?.email || null,
    });
    if (error) console.warn("Could not record live sale label reprint:", error);
    setStatus(`DYMO label for auction ${lot.auction_number || lot.lot_code || "bag"} queued for automatic printing.`, "success");
    await loadPastLiveSales();
  } catch (error) {
    console.error("Past live sale label print failed:", error);
    setStatus(error?.message || "Could not print that label.", "error");
  }
}

function openActionModal(config) {
  state.currentAction = config;
  setActionError("");
  $("past-action-eyebrow").textContent = config.eyebrow || "Admin Correction";
  $("past-action-title").textContent = config.title || "Signed Action";
  $("past-action-subtitle").textContent = config.subtitle || "Review and sign this change.";
  $("past-action-reason").value = config.reason || "";
  $("past-action-password").value = "";
  $("past-action-confirm").textContent = config.confirmLabel || "Sign and Apply";

  const fields = $("past-action-fields");
  fields.replaceChildren();
  (config.fields || []).forEach((field) => {
    const label = document.createElement("label");
    label.innerHTML = `
      ${escapeHtml(field.label)}
      ${field.type === "textarea"
        ? `<textarea data-action-field="${escapeHtml(field.name)}" rows="${field.rows || 3}" placeholder="${escapeHtml(field.placeholder || "")}">${escapeHtml(field.value || "")}</textarea>`
        : `<input data-action-field="${escapeHtml(field.name)}" type="${escapeHtml(field.type || "text")}" value="${escapeHtml(field.value || "")}" placeholder="${escapeHtml(field.placeholder || "")}" />`}
    `;
    fields.appendChild(label);
  });

  $("past-live-action-modal").hidden = false;
  document.body.classList.add("past-action-open");
  setTimeout(() => fields.querySelector("input, textarea")?.focus() || $("past-action-reason")?.focus(), 80);
}

function closeActionModal() {
  const modal = $("past-live-action-modal");
  if (!modal) return;
  modal.hidden = true;
  document.body.classList.remove("past-action-open");
  state.currentAction = null;
}

function collectActionFields() {
  const values = {};
  document.querySelectorAll("[data-action-field]").forEach((input) => {
    values[input.getAttribute("data-action-field")] = input.value;
  });
  return values;
}

async function verifyAdminPassword(password) {
  if (!state.user?.email || !password) return false;
  const { error } = await supabase.auth.signInWithPassword({
    email: state.user.email,
    password,
  });
  return !error;
}

function openEditSessionModal() {
  const session = getSelectedSession();
  if (!session) return;
  openActionModal({
    type: "edit-session",
    title: "Edit Live Sale Session",
    subtitle: "Update the show title or notes. The old and new values will be saved in the audit trail.",
    confirmLabel: "Sign and Save",
    fields: [
      { name: "title", label: "Session Title", value: session.title || "" },
      { name: "notes", label: "Session Notes", type: "textarea", value: session.notes || "", rows: 4 },
    ],
  });
}

function openArchiveSessionModal() {
  const session = getSelectedSession();
  if (!session) return;
  openActionModal({
    type: "archive-session",
    title: "Archive Live Sale Session",
    subtitle: "This is a soft delete. The session leaves normal review flow, but its bags and audit trail remain recoverable.",
    confirmLabel: "Sign and Archive",
  });
}

function openCancelSessionModal() {
  const session = getSelectedSession();
  if (!session) return;
  openActionModal({
    type: "cancel-session",
    title: "Cancel Active Live Sale",
    subtitle: "Open reserved bags will be cancelled. Packed bags remain untouched, and this action is recorded.",
    confirmLabel: "Sign and Cancel",
  });
}

function openEditLotModal(lotId) {
  const lot = state.lots.find((entry) => String(entry.id) === String(lotId));
  if (!lot) return;
  openActionModal({
    type: "edit-lot",
    lotId: lot.id,
    title: `Edit Auction ${lot.auction_number || "-"}`,
    subtitle: "Correct the auction number or bag notes. Every field change will be recorded.",
    confirmLabel: "Sign and Save",
    fields: [
      { name: "auctionNumber", label: "Auction Number", value: lot.auction_number || "" },
      { name: "notes", label: "Bag Notes", type: "textarea", value: lot.notes || "", rows: 4 },
    ],
  });
}

function openCancelLotModal(lotId) {
  const lot = state.lots.find((entry) => String(entry.id) === String(lotId));
  if (!lot) return;
  openActionModal({
    type: "cancel-lot",
    lotId: lot.id,
    title: `Cancel Auction Bag ${lot.auction_number || "-"}`,
    subtitle: "Reserved items in this bag will be released from the live-sale reservation layer.",
    confirmLabel: "Sign and Cancel Bag",
  });
}

async function confirmPastAction() {
  const action = state.currentAction;
  if (!action || state.busy) return;
  const reason = String($("past-action-reason")?.value || "").trim();
  const password = String($("past-action-password")?.value || "").trim();
  const values = collectActionFields();

  if (reason.length < 3) {
    setActionError("A brief reason is required.");
    $("past-action-reason")?.focus();
    return;
  }

  if (!password) {
    setActionError("Admin password is required.");
    $("past-action-password")?.focus();
    return;
  }

  state.busy = true;
  $("past-action-confirm").disabled = true;
  setActionError("Verifying password...");

  try {
    const valid = await verifyAdminPassword(password);
    if (!valid) throw new Error("Incorrect password. Please try again.");
    setActionError("Applying signed action...");

    if (action.type === "edit-session") {
      const session = getSelectedSession();
      const { error } = await supabase.rpc("admin_update_live_sale_session", {
        _session_id: session.id,
        _title: values.title || "",
        _notes: values.notes || "",
        _reason: reason,
        _signed_by_email: state.user?.email || null,
      });
      if (error) throw error;
    } else if (action.type === "archive-session") {
      const session = getSelectedSession();
      const { error } = await supabase.rpc("admin_archive_live_sale_session", {
        _session_id: session.id,
        _reason: reason,
        _signed_by_email: state.user?.email || null,
      });
      if (error) throw error;
    } else if (action.type === "cancel-session") {
      const session = getSelectedSession();
      const { error } = await supabase.rpc("cancel_live_sale_session", {
        _session_id: session.id,
        _reason: reason,
        _signed_by_email: state.user?.email || null,
      });
      if (error) throw error;
    } else if (action.type === "edit-lot") {
      const { error } = await supabase.rpc("admin_update_live_sale_lot", {
        _lot_id: action.lotId,
        _auction_number: values.auctionNumber || "",
        _notes: values.notes || "",
        _reason: reason,
        _signed_by_email: state.user?.email || null,
      });
      if (error) throw error;
    } else if (action.type === "cancel-lot") {
      const { error } = await supabase.rpc("cancel_live_sale_lot", {
        _lot_id: action.lotId,
        _notes: reason,
        _signed_by_email: state.user?.email || null,
      });
      if (error) throw error;
    }

    closeActionModal();
    setStatus("Signed action saved to the live-sale audit trail.", "success");
    state.busy = false;
    $("past-action-confirm").disabled = false;
    await loadPastLiveSales();
  } catch (error) {
    console.error("Past live sale admin action failed:", error);
    setActionError(error?.message || "Could not complete that action.");
  } finally {
    state.busy = false;
    $("past-action-confirm").disabled = false;
  }
}

function openPhotoModal(url, title = "Item preview") {
  const modal = $("past-photo-modal");
  const image = $("past-photo-image");
  const label = $("past-photo-title");
  if (!modal || !image) return;

  image.src = url;
  image.alt = title;
  if (label) label.textContent = title;
  setPhotoZoom(1);
  modal.hidden = false;
  document.body.classList.add("past-photo-open");
  $("past-photo-close")?.focus();
}

function closePhotoModal() {
  const modal = $("past-photo-modal");
  const image = $("past-photo-image");
  if (!modal) return;
  modal.hidden = true;
  if (image) image.removeAttribute("src");
  state.photoPanX = 0;
  state.photoPanY = 0;
  state.photoDrag = null;
  setPhotoZoom(1);
  document.body.classList.remove("past-photo-open");
}

function setPhotoZoom(value) {
  state.photoZoom = Math.min(4, Math.max(1, Number(value) || 1));
  if (state.photoZoom <= 1) {
    state.photoPanX = 0;
    state.photoPanY = 0;
  }
  updatePhotoTransform();
}

function updatePhotoTransform() {
  const image = $("past-photo-image");
  const readout = $("past-photo-zoom-readout");
  if (image) {
    image.style.transform = `translate(${state.photoPanX}px, ${state.photoPanY}px) scale(${state.photoZoom})`;
    image.classList.toggle("is-zoomed", state.photoZoom > 1);
    image.classList.toggle("is-dragging", Boolean(state.photoDrag));
  }
  if (readout) readout.textContent = `${Math.round(state.photoZoom * 100)}%`;
}

function startPhotoDrag(event) {
  if (state.photoZoom <= 1) return;
  event.preventDefault();
  const image = $("past-photo-image");
  state.photoDrag = {
    pointerId: event.pointerId,
    startX: event.clientX,
    startY: event.clientY,
    originX: state.photoPanX,
    originY: state.photoPanY,
  };
  image?.setPointerCapture?.(event.pointerId);
  updatePhotoTransform();
}

function movePhotoDrag(event) {
  if (!state.photoDrag || state.photoDrag.pointerId !== event.pointerId) return;
  event.preventDefault();
  state.photoPanX = state.photoDrag.originX + event.clientX - state.photoDrag.startX;
  state.photoPanY = state.photoDrag.originY + event.clientY - state.photoDrag.startY;
  updatePhotoTransform();
}

function endPhotoDrag(event) {
  if (!state.photoDrag || state.photoDrag.pointerId !== event.pointerId) return;
  $("past-photo-image")?.releasePointerCapture?.(event.pointerId);
  state.photoDrag = null;
  updatePhotoTransform();
}

function setupListeners() {
  $("refresh-past-live")?.addEventListener("click", () => loadPastLiveSales());
  $("edit-session")?.addEventListener("click", openEditSessionModal);
  $("open-audit-trail")?.addEventListener("click", openEventModal);
  $("archive-session")?.addEventListener("click", openArchiveSessionModal);
  $("cancel-session-from-history")?.addEventListener("click", openCancelSessionModal);

  ["filter-from", "filter-to", "filter-store", "filter-status"].forEach((id) => {
    $(id)?.addEventListener("change", () => loadPastLiveSales({ keepSelection: false }));
  });
  $("filter-search")?.addEventListener("input", () => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => loadPastLiveSales({ keepSelection: false }), 180);
  });

  $("past-action-close")?.addEventListener("click", closeActionModal);
  $("past-action-cancel")?.addEventListener("click", closeActionModal);
  document.querySelectorAll("[data-close-past-action]").forEach((node) => node.addEventListener("click", closeActionModal));
  $("past-action-confirm")?.addEventListener("click", confirmPastAction);
  $("past-action-password")?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmPastAction();
    }
  });

  $("past-event-close")?.addEventListener("click", closeEventModal);
  document.querySelectorAll("[data-close-past-events]").forEach((node) => node.addEventListener("click", closeEventModal));

  $("past-photo-close")?.addEventListener("click", closePhotoModal);
  document.querySelectorAll("[data-close-past-photo]").forEach((node) => node.addEventListener("click", closePhotoModal));
  $("past-photo-zoom-in")?.addEventListener("click", () => setPhotoZoom(state.photoZoom + 0.25));
  $("past-photo-zoom-out")?.addEventListener("click", () => setPhotoZoom(state.photoZoom - 0.25));
  $("past-photo-image")?.addEventListener("click", () => setPhotoZoom(state.photoZoom > 1 ? 1 : 2));
  $("past-photo-image")?.addEventListener("pointerdown", startPhotoDrag);
  $("past-photo-image")?.addEventListener("pointermove", movePhotoDrag);
  $("past-photo-image")?.addEventListener("pointerup", endPhotoDrag);
  $("past-photo-image")?.addEventListener("pointercancel", endPhotoDrag);
  $("past-photo-modal")?.addEventListener("wheel", (event) => {
    if ($("past-photo-modal")?.hidden) return;
    event.preventDefault();
    setPhotoZoom(state.photoZoom + (event.deltaY < 0 ? 0.2 : -0.2));
  }, { passive: false });

  document.addEventListener("keydown", (event) => {
    if (!$("past-photo-modal")?.hidden) {
      if (event.key === "Escape" || event.key === "Enter") {
        event.preventDefault();
        closePhotoModal();
      }
      return;
    }

    if (!$("past-live-action-modal")?.hidden && event.key === "Escape") {
      event.preventDefault();
      closeActionModal();
      return;
    }

    if (!$("past-event-modal")?.hidden && event.key === "Escape") {
      event.preventDefault();
      closeEventModal();
    }
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseReady();
  const ok = await checkAdminAuth();
  if (!ok) return;
  setupShell();
  setupListeners();
  setDefaultDateFilters();
  await loadStores();
  await loadPastLiveSales({ keepSelection: false });
  if (window.lucide) window.lucide.createIcons();
});
