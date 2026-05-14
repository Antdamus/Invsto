(function () {
  const state = {
    initialized: false,
    employees: [],
    stores: [],
    events: [],
  };

  const qs = (id) => document.getElementById(id);
  const sb = () => window.supabaseClient || window.supabase;

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function localDateInput(date = new Date()) {
    const copy = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return copy.toISOString().slice(0, 10);
  }

  function dayStartIso(value) {
    const d = value ? new Date(`${value}T00:00:00`) : new Date();
    d.setHours(0, 0, 0, 0);
    return d.toISOString();
  }

  function dayEndIso(value) {
    const d = value ? new Date(`${value}T00:00:00`) : new Date();
    d.setHours(23, 59, 59, 999);
    return d.toISOString();
  }

  function formatDateTime(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }

  function formatFieldName(field) {
    const names = {
      title: "Title",
      description: "Description",
      weight: "Weight",
      cost: "Cost",
      sale_price: "Sale price",
      barcode: "Barcode",
      qr_type: "QR type",
      categories: "Categories",
      stock: "Stock",
      quantity: "Quantity",
      location_id: "Location",
      location_name: "Location name",
      location_code: "Location barcode",
      store_id: "Store",
      is_tray: "Tray",
      tray_status: "Tray status",
      tray_current_store_id: "Tray current store",
      tray_weight_tolerance_grams: "Tray tolerance",
      max_capacity: "Max capacity",
      notes: "Notes",
      record: "Record",
    };
    return names[field] || String(field || "").replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function compactValue(value) {
    if (value === null || value === undefined || value === "") return "-";
    if (Array.isArray(value)) return value.length ? value.join(", ") : "-";
    if (typeof value === "boolean") return value ? "Yes" : "No";
    if (typeof value === "object") {
      if (value.location_name) return value.location_name;
      if (value.title) return value.title;
      if (value.name) return value.name;
      if (value.id) return value.id;
      return "Snapshot";
    }
    return String(value);
  }

  function normalizeEmployee(row) {
    return {
      id: row?.id || "",
      userId: row?.user_id || "",
      name: row?.display_name || row?.email || "Unknown worker",
      email: row?.email || "",
    };
  }

  function workerLabel(userId, email) {
    const worker = state.employees.find((e) => e.userId === userId || e.email === email || e.id === userId);
    return worker?.name || email || "Unknown worker";
  }

  function storeLabel(storeId, fallback) {
    const store = state.stores.find((s) => s.id === storeId);
    return store?.name || fallback || "Unassigned";
  }

  function changedFieldEntries(changedFields) {
    if (!changedFields || typeof changedFields !== "object") return [];
    return Object.entries(changedFields).map(([field, change]) => ({
      field,
      from: change?.from,
      to: change?.to,
    }));
  }

  function mapInventoryChange(row) {
    const fields = changedFieldEntries(row.changed_fields);
    return {
      id: `inventory-${row.id}`,
      source: "inventory_change_log",
      category: "inventory_edit",
      label: row.action === "insert" ? "Created" : row.action === "delete" ? "Deleted" : "Edited",
      title: row.summary || "Inventory edit",
      at: row.changed_at,
      workerId: row.worker_id || "",
      workerEmail: row.worker_email || "",
      workerName: workerLabel(row.worker_id, row.worker_email),
      storeId: row.store_id || "",
      storeName: storeLabel(row.store_id, row.store_name),
      itemId: row.item_id || "",
      itemTitle: row.item_title || "",
      barcode: row.item_barcode || "",
      locationId: row.location_id || "",
      locationName: row.location_name || "",
      fields,
      needsReview: row.action === "delete",
      searchText: "",
    };
  }

  function mapStockEvent(row) {
    const item = row.item_types || {};
    const loc = row.locations || {};
    const qty = Number(row.quantity || 0);
    const action = row.action_type || "stock";
    const isReview = action === "correction" || qty < 0 || /manual|override/i.test(row.notes || "");
    return {
      id: `stock-${row.id}`,
      source: "stock_transactions",
      category: "stock_event",
      label: action.replaceAll("_", " "),
      title: `${action.replaceAll("_", " ")} ${Math.abs(qty)} unit${Math.abs(qty) === 1 ? "" : "s"}`,
      at: row.confirmed_at || row.timestamp,
      workerId: row.user_id || "",
      workerEmail: row.email || "",
      workerName: workerLabel(row.user_id, row.email),
      storeId: loc.store_id || "",
      storeName: storeLabel(loc.store_id),
      itemId: row.item_id || "",
      itemTitle: item.title || "",
      barcode: item.barcode || "",
      locationId: row.location_id || "",
      locationName: loc.location_name || "",
      fields: [
        { field: "quantity", from: "-", to: qty },
        { field: "location_id", from: "-", to: loc.location_name || row.location_id },
        { field: "notes", from: "-", to: row.notes || "-" },
      ],
      needsReview: isReview,
      searchText: "",
    };
  }

  function mapPhotoEvent(row) {
    const needsReview = row.status !== "completed" || row.storage_error || row.storage_removed === false;
    return {
      id: `photo-${row.id}`,
      source: "photo_deletion_log",
      category: "photo_event",
      label: "Photo",
      title: "Removed item photo",
      at: row.deleted_at,
      workerId: row.deleted_by || "",
      workerEmail: row.deleted_by_email || "",
      workerName: workerLabel(row.deleted_by, row.deleted_by_email),
      storeId: "",
      storeName: "No store on photo event",
      itemId: row.item_id || "",
      itemTitle: row.item_title || "",
      barcode: row.item_barcode || "",
      locationId: "",
      locationName: "",
      fields: [
        { field: "photo_path", from: row.photo_path || "-", to: "Removed" },
        { field: "status", from: "-", to: row.status || "-" },
        { field: "reason", from: "-", to: row.reason || "-" },
      ],
      needsReview: !!needsReview,
      searchText: "",
    };
  }

  function mapTrayEvent(row) {
    const tray = row.locations || {};
    const storeId = row.to_store_id || row.from_store_id || tray.tray_current_store_id || tray.store_id || "";
    return {
      id: `tray-${row.id}`,
      source: "tray_movements",
      category: "tray_event",
      label: "Tray",
      title: String(row.action || "tray event").replaceAll("_", " "),
      at: row.created_at,
      workerId: row.performed_by || "",
      workerEmail: row.performed_by_email || "",
      workerName: workerLabel(row.performed_by, row.performed_by_email),
      storeId,
      storeName: storeLabel(storeId),
      itemId: "",
      itemTitle: tray.location_name || "Tray",
      barcode: tray.location_code || "",
      locationId: row.tray_location_id || "",
      locationName: tray.location_name || "",
      fields: [
        { field: "expected_weight_grams", from: "-", to: row.expected_weight_grams ?? "-" },
        { field: "actual_weight_grams", from: "-", to: row.actual_weight_grams ?? "-" },
        { field: "weight_delta_grams", from: "-", to: row.weight_delta_grams ?? "-" },
        { field: "result", from: "-", to: row.result || "-" },
      ],
      needsReview: row.result && row.result !== "ok",
      searchText: "",
    };
  }

  async function selectOrEmpty(queryPromise, label) {
    const { data, error } = await queryPromise;
    if (error) {
      console.warn(`Changes: ${label} unavailable`, error);
      return [];
    }
    return data || [];
  }

  async function loadFilters() {
    const client = sb();
    const [employees, stores] = await Promise.all([
      selectOrEmpty(
        client.from("employees").select("id,user_id,display_name,email,active").order("display_name", { ascending: true }),
        "employees"
      ),
      selectOrEmpty(
        client.from("store_locations").select("id,name,active").order("name", { ascending: true }),
        "stores"
      ),
    ]);

    state.employees = employees.map(normalizeEmployee);
    state.stores = stores || [];

    const workerSelect = qs("changesWorkerFilter");
    if (workerSelect) {
      const current = workerSelect.value;
      workerSelect.innerHTML = `<option value="">All workers</option>${state.employees.map((e) => (
        `<option value="${escapeHtml(e.userId || e.id)}">${escapeHtml(e.name)}${e.email ? ` (${escapeHtml(e.email)})` : ""}</option>`
      )).join("")}`;
      workerSelect.value = current;
    }

    const storeSelect = qs("changesStoreFilter");
    if (storeSelect) {
      const current = storeSelect.value;
      storeSelect.innerHTML = `<option value="">All stores</option>${state.stores.map((s) => (
        `<option value="${escapeHtml(s.id)}">${escapeHtml(s.name)}${s.active === false ? " (inactive)" : ""}</option>`
      )).join("")}`;
      storeSelect.value = current;
    }
  }

  async function loadEvents() {
    const client = sb();
    const fromIso = dayStartIso(qs("changesDateFrom")?.value);
    const toIso = dayEndIso(qs("changesDateTo")?.value);
    const status = qs("changesStatus");

    if (status) status.textContent = "Loading change history...";

    const [inventoryChanges, stockEvents, photoEvents, trayEvents] = await Promise.all([
      selectOrEmpty(
        client.from("inventory_change_log")
          .select("*")
          .gte("changed_at", fromIso)
          .lte("changed_at", toIso)
          .order("changed_at", { ascending: false })
          .limit(600),
        "inventory change log"
      ),
      selectOrEmpty(
        client.from("stock_transactions")
          .select("id,item_id,location_id,quantity,action_type,confirmed_at,user_id,email,notes,method,timestamp,item_types(title,barcode),locations(location_name,location_code,store_id)")
          .gte("confirmed_at", fromIso)
          .lte("confirmed_at", toIso)
          .order("confirmed_at", { ascending: false })
          .limit(400),
        "stock transactions"
      ),
      selectOrEmpty(
        client.from("photo_deletion_log")
          .select("*")
          .gte("deleted_at", fromIso)
          .lte("deleted_at", toIso)
          .order("deleted_at", { ascending: false })
          .limit(200),
        "photo deletion log"
      ),
      selectOrEmpty(
        client.from("tray_movements")
          .select("*,locations(location_name,location_code,store_id,tray_current_store_id)")
          .gte("created_at", fromIso)
          .lte("created_at", toIso)
          .order("created_at", { ascending: false })
          .limit(250),
        "tray movements"
      ),
    ]);

    state.events = [
      ...inventoryChanges.map(mapInventoryChange),
      ...stockEvents.map(mapStockEvent),
      ...photoEvents.map(mapPhotoEvent),
      ...trayEvents.map(mapTrayEvent),
    ].map((event) => {
      const parts = [
        event.title,
        event.label,
        event.workerName,
        event.workerEmail,
        event.storeName,
        event.itemTitle,
        event.barcode,
        event.locationName,
        ...event.fields.flatMap((f) => [f.field, compactValue(f.from), compactValue(f.to)]),
      ];
      event.searchText = parts.join(" ").toLowerCase();
      return event;
    }).sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

    renderChanges();
  }

  function filteredEvents() {
    const worker = qs("changesWorkerFilter")?.value || "";
    const store = qs("changesStoreFilter")?.value || "";
    const type = qs("changesTypeFilter")?.value || "";
    const term = (qs("changesSearchInput")?.value || "").trim().toLowerCase();

    return state.events.filter((event) => {
      if (worker && event.workerId !== worker) return false;
      if (store && event.storeId !== store) return false;
      if (type === "review" && !event.needsReview) return false;
      if (type && type !== "review" && event.category !== type) return false;
      if (term && !event.searchText.includes(term)) return false;
      return true;
    });
  }

  function renderKpis(events) {
    const set = (id, value) => {
      const el = qs(id);
      if (el) el.textContent = String(value);
    };
    set("changesKpiTotal", events.length);
    set("changesKpiEdits", events.filter((e) => e.category === "inventory_edit").length);
    set("changesKpiStock", events.filter((e) => e.category === "stock_event" || e.category === "tray_event").length);
    set("changesKpiReview", events.filter((e) => e.needsReview).length);
  }

  function renderFieldRows(fields) {
    if (!fields.length) return `<div class="change-field muted">No field details available.</div>`;

    return fields.slice(0, 10).map((field) => {
      const from = compactValue(field.from);
      const to = compactValue(field.to);
      return `
        <div class="change-field">
          <span class="change-field-name">${escapeHtml(formatFieldName(field.field))}</span>
          <span class="change-field-value old">${escapeHtml(from)}</span>
          <span class="change-arrow" aria-hidden="true">to</span>
          <span class="change-field-value new">${escapeHtml(to)}</span>
        </div>
      `;
    }).join("");
  }

  function renderChangeCard(event) {
    const itemLine = [
      event.itemTitle,
      event.barcode ? `Barcode ${event.barcode}` : "",
      event.locationName ? `Location ${event.locationName}` : "",
    ].filter(Boolean).join(" · ");

    return `
      <article class="change-card${event.needsReview ? " needs-review" : ""}">
        <div class="change-card-top">
          <div>
            <div class="change-badges">
              <span class="change-badge ${escapeHtml(event.category)}">${escapeHtml(event.label)}</span>
              ${event.needsReview ? `<span class="change-badge review">Needs review</span>` : ""}
            </div>
            <h3>${escapeHtml(event.title)}</h3>
            <p>${escapeHtml(itemLine || "No item attached")}</p>
          </div>
          <time datetime="${escapeHtml(event.at || "")}">${escapeHtml(formatDateTime(event.at))}</time>
        </div>
        <div class="change-meta-grid">
          <div><span>Worker</span><strong>${escapeHtml(event.workerName)}</strong></div>
          <div><span>Store</span><strong>${escapeHtml(event.storeName)}</strong></div>
          <div><span>Source</span><strong>${escapeHtml(event.source.replaceAll("_", " "))}</strong></div>
          <div><span>Record</span><strong>${escapeHtml(event.itemTitle || event.locationName || event.itemId || event.locationId || "-")}</strong></div>
        </div>
        <div class="change-fields">
          ${renderFieldRows(event.fields)}
        </div>
      </article>
    `;
  }

  function renderChanges() {
    const timeline = qs("changesTimeline");
    const status = qs("changesStatus");
    const events = filteredEvents();

    renderKpis(events);

    if (status) {
      const from = qs("changesDateFrom")?.value || "today";
      const to = qs("changesDateTo")?.value || from;
      status.textContent = `${events.length} change${events.length === 1 ? "" : "s"} shown for ${from}${from === to ? "" : ` through ${to}`}.`;
    }

    if (!timeline) return;

    if (!events.length) {
      timeline.innerHTML = `
        <div class="changes-empty">
          <strong>No changes found</strong>
          <p>Try widening the date range or clearing a worker, store, type, or search filter.</p>
        </div>
      `;
      return;
    }

    timeline.innerHTML = events.map(renderChangeCard).join("");
  }

  function bindEvents() {
    qs("changesRefreshBtn")?.addEventListener("click", async () => {
      await loadFilters();
      await loadEvents();
    });

    ["changesWorkerFilter", "changesStoreFilter", "changesTypeFilter", "changesSearchInput"].forEach((id) => {
      qs(id)?.addEventListener("input", renderChanges);
      qs(id)?.addEventListener("change", renderChanges);
    });

    ["changesDateFrom", "changesDateTo"].forEach((id) => {
      qs(id)?.addEventListener("change", loadEvents);
    });
  }

  async function initChangesTab() {
    if (!sb()) {
      document.addEventListener("supabase-ready", initChangesTab, { once: true });
      return;
    }

    if (!qs("changesDateFrom")?.value) qs("changesDateFrom").value = localDateInput();
    if (!qs("changesDateTo")?.value) qs("changesDateTo").value = localDateInput();

    if (!state.initialized) {
      state.initialized = true;
      bindEvents();
    }

    await loadFilters();
    await loadEvents();
  }

  window.initChangesTab = initChangesTab;
})();
