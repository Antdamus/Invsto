(function () {
  const state = {
    initialized: false,
    employees: [],
    stores: [],
    events: [],
    photoUrlCache: new Map(),
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
      stone_type: "Stone type",
      item_length: "Length",
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
      reason: "Reason",
      photo_path: "Photo",
      quarantine_path: "Quarantine copy",
      restored_at: "Restored",
      deleted_by_email: "Deleted by",
      restored_by_email: "Restored by",
      deleted_at: "Deleted at",
      deleted_by: "Deleted by",
      deletion_reason: "Deletion reason",
      deletion_status: "Deletion status",
      deletion_stock_snapshot: "Removed stock placements",
      restored_by: "Restored by",
      restore_reason: "Restore reason",
      record: "Record",
    };
    return names[field] || String(field || "").replaceAll("_", " ").replace(/\b\w/g, (m) => m.toUpperCase());
  }

  function compactValue(value) {
    if (value === null || value === undefined || value === "") return "-";
    if (Array.isArray(value)) {
      if (value.length && value.every(isPhotoPath)) {
        return `${value.length} photo${value.length === 1 ? "" : "s"}`;
      }
      if (value.length && value.every((entry) => entry && typeof entry === "object" && "location_id" in entry)) {
        const units = value.reduce((sum, entry) => sum + Number(entry.quantity || 0), 0);
        return `${value.length} placement${value.length === 1 ? "" : "s"} / ${units} unit${units === 1 ? "" : "s"}`;
      }
      return value.length ? value.join(", ") : "-";
    }
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

  function isPhotoPath(value) {
    return typeof value === "string"
      && /(^item_photos\/|^photos\/|^deleted-item-photos\/|\/PHOTO-|\.jpe?g$|\.png$|\.webp$)/i.test(value);
  }

  function toPhotoList(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value.filter(isPhotoPath);
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) return [];
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) return parsed.filter(isPhotoPath);
      } catch (_) {}
      return isPhotoPath(trimmed) ? [trimmed] : [];
    }
    return [];
  }

  function diffPhotoLists(fromValue, toValue) {
    const from = toPhotoList(fromValue);
    const to = toPhotoList(toValue);
    const fromSet = new Set(from);
    const toSet = new Set(to);
    return {
      from,
      to,
      added: to.filter((path) => !fromSet.has(path)),
      removed: from.filter((path) => !toSet.has(path)),
    };
  }

  function photoGroupsFromFields(fields, fallbackLabel = "Photos") {
    const groups = [];
    (fields || []).forEach((field) => {
      if (field.field !== "photos" && field.field !== "photo_path") return;
      const diff = diffPhotoLists(field.from, field.to);
      if (diff.added.length) {
        groups.push({
          label: field.field === "photo_path" ? fallbackLabel : "Added photos",
          bucket: "photos",
          paths: diff.added,
        });
      }
      if (diff.removed.length) {
        groups.push({
          label: field.field === "photo_path" ? fallbackLabel : "Removed photos",
          bucket: "photos",
          paths: diff.removed,
        });
      }
    });
    return groups;
  }

  function photoPathsFromSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== "object") return [];

    const paths = [
      ...toPhotoList(snapshot.photos),
      ...toPhotoList(snapshot.photo_url),
    ].filter((path) => path && !/^https?:\/\//i.test(path));

    return [...new Set(paths)];
  }

  function itemDeletionPhotoVisuals(row, isDeletionEvent, isRestoreEvent) {
    if (!isDeletionEvent) return [];

    const snapshot = isRestoreEvent
      ? (row.new_data || row.old_data)
      : (row.old_data || row.new_data);
    const paths = photoPathsFromSnapshot(snapshot);

    if (!paths.length) return [];

    return [{
      label: isRestoreEvent ? "Restored item photos" : "Deleted item photos",
      bucket: "photos",
      paths,
    }];
  }

  function itemDeletionReversionPhotoVisuals(row, fields = [], direction = "revert") {
    const isDeletionReversion = row.table_name === "item_types"
      && fields.some((field) => field.field === "deleted_at");
    if (!isDeletionReversion) return [];

    const snapshot = direction === "reapply"
      ? (row.after_data || row.before_data)
      : (row.before_data || row.after_data);
    const paths = photoPathsFromSnapshot(snapshot);

    if (!paths.length) return [];

    return [{
      label: direction === "reapply" ? "Reapplied deleted item photos" : "Recovered item photos",
      bucket: "photos",
      paths,
    }];
  }

  function fileNameFromPath(path) {
    return String(path || "").split("/").pop() || "Photo";
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

  function isInventoryDeletionFields(fields = []) {
    return fields.some((field) => field.field === "deleted_at");
  }

  function isInventoryRestoreFields(fields = []) {
    const deletedAt = fields.find((field) => field.field === "deleted_at");
    return Boolean(deletedAt && deletedAt.from && !deletedAt.to);
  }

  function mapInventoryChange(row) {
    const fields = changedFieldEntries(row.changed_fields);
    if (row.reason) {
      fields.push({ field: "reason", from: "-", to: row.reason });
    }
    const isDeletionEvent = row.table_name === "item_types" && row.action === "update" && isInventoryDeletionFields(fields);
    const isRestoreEvent = isDeletionEvent && isInventoryRestoreFields(fields);
    const isCurrentlyReverted = row.revert_direction === "revert";
    return {
      id: `inventory-${row.id}`,
      changeLogId: row.id,
      source: "inventory_change_log",
      category: "inventory_edit",
      label: isDeletionEvent ? (isRestoreEvent ? "Restored" : "Deleted") : row.action === "insert" ? "Created" : row.action === "delete" ? "Deleted" : "Edited",
      title: isDeletionEvent ? (isRestoreEvent ? "Restored item card" : "Deleted item card") : row.summary || "Inventory edit",
      at: row.changed_at,
      action: row.action || "",
      tableName: row.table_name || "",
      recordId: row.record_id || "",
      workerId: row.worker_id || row.signed_by || "",
      workerEmail: row.worker_email || "",
      workerName: workerLabel(row.worker_id || row.signed_by, row.worker_email || row.signed_by_email),
      storeId: row.store_id || "",
      storeName: storeLabel(row.store_id, row.store_name),
      itemId: row.item_id || "",
      itemTitle: row.item_title || "",
      barcode: row.item_barcode || "",
      locationId: row.location_id || "",
      locationName: row.location_name || "",
      fields,
      photoVisuals: [
        ...itemDeletionPhotoVisuals(row, isDeletionEvent, isRestoreEvent),
        ...photoGroupsFromFields(fields),
      ],
      reason: row.reason || "",
      signedByEmail: row.signed_by_email || "",
      revertDirection: row.revert_direction || "",
      revertedAt: row.reverted_at || "",
      revertedByEmail: row.reverted_by_email || "",
      revertCount: Number(row.revert_count || 0),
      isCurrentlyReverted,
      isDeletionEvent,
      reversible: row.action === "update",
      needsReview: row.action === "delete" || (isDeletionEvent && !isRestoreEvent),
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
    const restored = row.revert_direction === "revert" || row.status === "restored";
    const needsReview = !restored && (row.status !== "completed" || row.storage_error || row.storage_removed === false);
    const deletedAt = formatDateTime(row.deleted_at);
    const restoredAt = formatDateTime(row.restored_at);
    const visualPath = row.quarantine_path || row.photo_path || "";
    const visualBucket = row.quarantine_path ? (row.quarantine_bucket || "photo-quarantine") : "photos";
    return {
      id: `photo-${row.id}`,
      logId: row.id,
      source: "photo_deletion_log",
      category: "photo_event",
      label: restored ? "Restored" : "Photo",
      title: restored ? "Restored item photo" : "Removed item photo",
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
        { field: "photo_path", from: row.photo_path || "-", to: restored ? row.photo_path || "-" : "-" },
        { field: "status", from: "-", to: row.status || "-" },
        { field: "quarantine_path", from: "-", to: row.quarantine_path || "Not quarantined" },
        ...(row.restored_at ? [{ field: "restored_at", from: deletedAt, to: restoredAt }] : []),
        ...(row.restored_at ? [{ field: "deleted_by_email", from: "-", to: row.deleted_by_email || "-" }] : []),
        ...(row.restored_at ? [{ field: "restored_by_email", from: "-", to: row.restored_by_email || "-" }] : []),
        { field: "reason", from: "-", to: row.reason || "-" },
      ],
      photoPath: row.photo_path || "",
      quarantineBucket: row.quarantine_bucket || "",
      quarantinePath: row.quarantine_path || "",
      photoVisuals: visualPath ? [{
        label: restored ? "Recoverable photo" : "Deleted photo",
        bucket: visualBucket,
        paths: [visualPath],
        originalPath: row.photo_path || "",
      }] : [],
      restoredAt: row.restored_at || "",
      status: row.status || "",
      revertDirection: row.revert_direction || "",
      revertedAt: row.reverted_at || "",
      revertedByEmail: row.reverted_by_email || "",
      revertCount: Number(row.revert_count || 0),
      isCurrentlyReverted: restored,
      reversible: Boolean(row.photo_path && (row.quarantine_path || restored)),
      needsReview: !!needsReview,
      searchText: "",
    };
  }

  function canRevertChangeEvent(event) {
    if (event.category === "inventory_edit") {
      return event.reversible && event.changeLogId && event.action === "update";
    }
    if (event.category === "photo_event") {
      if (!event.reversible || !event.logId || !event.photoPath) return false;
      if (event.isCurrentlyReverted) return true;
      return Boolean(event.quarantinePath);
    }
    return false;
  }

  function renderChangeActions(event) {
    const notes = [];
    if (event.revertCount) {
      notes.push(`
        <span class="change-restore-note">
          ${event.isCurrentlyReverted ? "Currently reverted" : "Reapplied"}${event.revertedByEmail ? ` by ${escapeHtml(event.revertedByEmail)}` : ""}${event.revertedAt ? ` - ${escapeHtml(formatDateTime(event.revertedAt))}` : ""}
        </span>
      `);
    }

    if (canRevertChangeEvent(event)) {
      const label = event.isCurrentlyReverted ? "Reapply Change" : "Revert Change";
      notes.push(`
        <button type="button" class="change-action-btn revert-change-btn" data-revert-event-id="${escapeHtml(event.id)}">
          ${escapeHtml(label)}
        </button>
      `);
    } else if (event.category === "photo_event" && !event.quarantinePath && !event.isCurrentlyReverted) {
      notes.push(`<span class="change-restore-note muted">No recovery copy available</span>`);
    }

    if (notes.length) {
      return `<div class="change-actions">${notes.join("")}</div>`;
    }

    return "";
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

  function mapReversionEvent(row) {
    const fields = changedFieldEntries(row.changed_fields);
    const direction = row.direction || "revert";
    return {
      id: `reversion-${row.id}`,
      reversionId: row.id,
      source: "change_reversion_log",
      category: "revert_event",
      label: direction === "reapply" ? "Reapplied" : "Reverted",
      title: direction === "reapply" ? "Reapplied audited change" : "Reverted audited change",
      at: row.performed_at,
      workerId: row.performed_by || "",
      workerEmail: row.performed_by_email || "",
      workerName: workerLabel(row.performed_by, row.performed_by_email),
      storeId: row.store_id || "",
      storeName: storeLabel(row.store_id, row.store_name),
      itemId: row.item_id || "",
      itemTitle: row.item_title || "",
      barcode: row.item_barcode || "",
      locationId: row.location_id || "",
      locationName: row.location_name || "",
      fields: row.reason ? [...fields, { field: "reason", from: "-", to: row.reason }] : fields,
      photoVisuals: [
        ...itemDeletionReversionPhotoVisuals(row, fields, direction),
        ...photoGroupsFromFields(fields, direction === "reapply" ? "Reapplied photo" : "Restored photo"),
      ],
      reason: row.reason || "",
      needsReview: false,
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

    const [inventoryChanges, stockEvents, photoEvents, trayEvents, reversionEvents] = await Promise.all([
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
          .or(`and(deleted_at.gte.${fromIso},deleted_at.lte.${toIso}),and(restored_at.gte.${fromIso},restored_at.lte.${toIso})`)
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
      selectOrEmpty(
        client.from("change_reversion_log")
          .select("*")
          .gte("performed_at", fromIso)
          .lte("performed_at", toIso)
          .order("performed_at", { ascending: false })
          .limit(250),
        "change reversions"
      ),
    ]);

    const modificationChanges = inventoryChanges.filter((row) => {
      if (row.verified_method === "admin_revert") return false;
      return row.action !== "insert";
    });
    const modificationStockEvents = stockEvents.filter((row) => {
      const action = String(row.action_type || "").toLowerCase();
      const qty = Number(row.quantity || 0);
      return !(action === "checkin" && qty > 0);
    });

    state.events = [
      ...modificationChanges.map(mapInventoryChange),
      ...modificationStockEvents.map(mapStockEvent),
      ...photoEvents.map(mapPhotoEvent),
      ...trayEvents.map(mapTrayEvent),
      ...reversionEvents.map(mapReversionEvent),
    ].map((event) => {
      const parts = [
        event.title,
        event.label,
        event.workerName,
        event.workerEmail,
        event.reason,
        event.signedByEmail,
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
      const photoDiff = field.field === "photos" || field.field === "photo_path"
        ? diffPhotoLists(field.from, field.to)
        : null;
      const from = photoDiff ? `${photoDiff.from.length} photo${photoDiff.from.length === 1 ? "" : "s"}` : compactValue(field.from);
      const to = photoDiff ? `${photoDiff.to.length} photo${photoDiff.to.length === 1 ? "" : "s"}` : compactValue(field.to);
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

  function renderPhotoVisuals(groups = []) {
    const visibleGroups = groups
      .map((group) => ({
        ...group,
        paths: (group.paths || []).filter(Boolean),
      }))
      .filter((group) => group.paths.length);

    if (!visibleGroups.length) return "";

    return `
      <div class="change-photo-panel">
        ${visibleGroups.map((group) => `
          <div class="change-photo-group">
            <span>${escapeHtml(group.label || "Photos")}</span>
            <div class="change-photo-strip">
              ${group.paths.slice(0, 8).map((path) => `
                <figure class="change-photo-thumb" title="Open full photo">
                  <img alt="${escapeHtml(fileNameFromPath(group.originalPath || path))}"
                    data-change-photo-bucket="${escapeHtml(group.bucket || "photos")}"
                    data-change-photo-path="${escapeHtml(path)}"
                    data-change-photo-name="${escapeHtml(fileNameFromPath(group.originalPath || path))}">
                  <figcaption>${escapeHtml(fileNameFromPath(group.originalPath || path))}</figcaption>
                </figure>
              `).join("")}
              ${group.paths.length > 8 ? `<span class="change-photo-more">+${group.paths.length - 8}</span>` : ""}
            </div>
          </div>
        `).join("")}
      </div>
    `;
  }

  async function signedPhotoUrl(bucket, path) {
    const key = `${bucket}:${path}`;
    if (state.photoUrlCache.has(key)) return state.photoUrlCache.get(key);

    const { data, error } = await sb().storage.from(bucket).createSignedUrl(path, 300);
    if (error || !data?.signedUrl) {
      throw error || new Error("Signed photo URL was not returned.");
    }

    state.photoUrlCache.set(key, data.signedUrl);
    return data.signedUrl;
  }

  function ensureChangePhotoViewer() {
    let viewer = qs("changePhotoViewer");
    if (viewer) return viewer;

    document.body.insertAdjacentHTML("beforeend", `
      <div id="changePhotoViewer" class="change-photo-viewer hidden" role="dialog" aria-modal="true" aria-label="Photo preview">
        <button type="button" class="change-photo-viewer-backdrop" data-close-change-photo-viewer aria-label="Close photo preview"></button>
        <div class="change-photo-viewer-card">
          <div class="change-photo-viewer-head">
            <div>
              <span>Photo Preview</span>
              <strong id="changePhotoViewerTitle">Selected photo</strong>
            </div>
            <button type="button" class="change-photo-viewer-close" data-close-change-photo-viewer aria-label="Close photo preview">Close</button>
          </div>
          <div class="change-photo-viewer-stage">
            <img id="changePhotoViewerImg" alt="Selected audit photo">
          </div>
        </div>
      </div>
    `);

    viewer = qs("changePhotoViewer");
    viewer?.addEventListener("click", (event) => {
      if (event.target.closest("[data-close-change-photo-viewer]")) {
        closeChangePhotoViewer();
      }
    });
    return viewer;
  }

  function closeChangePhotoViewer() {
    const viewer = qs("changePhotoViewer");
    if (!viewer) return;
    viewer.classList.add("hidden");
    viewer.classList.remove("show");
    document.body.classList.remove("change-photo-viewer-open");
  }

  async function openChangePhotoViewer(img) {
    const path = img?.dataset?.changePhotoPath || "";
    if (!path) return;

    const viewer = ensureChangePhotoViewer();
    const title = qs("changePhotoViewerTitle");
    const preview = qs("changePhotoViewerImg");
    const bucket = img.dataset.changePhotoBucket || "photos";
    const name = img.dataset.changePhotoName || fileNameFromPath(path);

    if (title) title.textContent = name;
    if (preview) {
      preview.removeAttribute("src");
      preview.alt = name;
    }

    viewer?.classList.remove("hidden");
    viewer?.classList.add("show");
    document.body.classList.add("change-photo-viewer-open");

    try {
      const url = img.dataset.loaded === "true" && img.src ? img.src : await signedPhotoUrl(bucket, path);
      if (preview) preview.src = url;
    } catch (error) {
      console.warn("Could not open change photo preview", error);
      window.alert("Could not open this photo preview.");
      closeChangePhotoViewer();
    }
  }

  async function hydrateChangePhotos() {
    const images = Array.from(document.querySelectorAll("img[data-change-photo-path]"));
    await Promise.all(images.map(async (img) => {
      const bucket = img.dataset.changePhotoBucket || "photos";
      const path = img.dataset.changePhotoPath || "";
      if (!path || img.dataset.loaded === "true") return;

      try {
        img.src = await signedPhotoUrl(bucket, path);
        img.dataset.loaded = "true";
      } catch (error) {
        console.warn("Could not load change photo preview", error);
        img.closest(".change-photo-thumb")?.classList.add("is-missing");
      }
    }));
  }

  function renderChangeCard(event) {
    const itemLine = [
      event.itemTitle,
      event.barcode ? `Barcode ${event.barcode}` : "",
      event.locationName ? `Location ${event.locationName}` : "",
    ].filter(Boolean).join(" - ");

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
        ${renderPhotoVisuals(event.photoVisuals)}
        <div class="change-fields">
          ${renderFieldRows(event.fields)}
        </div>
        ${renderChangeActions(event)}
      </article>
    `;
  }

  async function currentAdminEmail(client) {
    const { data } = await client.auth.getUser();
    return data?.user?.email || "";
  }

  async function copyQuarantinedPhotoToVisibleBucket(event) {
    if (!event.quarantinePath) {
      throw new Error("This deletion does not have a quarantined recovery copy.");
    }

    const client = sb();
    const quarantineBucket = event.quarantineBucket || "photo-quarantine";
    const { data: signed, error: signedError } = await client.storage
      .from(quarantineBucket)
      .createSignedUrl(event.quarantinePath, 300);
    if (signedError) throw signedError;

    const response = await fetch(signed?.signedUrl);
    if (!response?.ok) {
      throw new Error(`Could not read quarantined image (${response?.status || "network error"}).`);
    }

    const blob = await response.blob();
    const { error: uploadError } = await client.storage
      .from("photos")
      .upload(event.photoPath, blob, {
        upsert: false,
        contentType: blob.type || "application/octet-stream",
      });
    const alreadyRestored = uploadError && (
      String(uploadError.statusCode || "") === "409"
      || /exists|duplicate/i.test(uploadError.message || "")
    );
    if (uploadError && !alreadyRestored) throw uploadError;
  }

  async function removeVisiblePhotoStorage(path) {
    if (!path) return;
    const { error } = await sb().storage.from("photos").remove([path]);
    if (error && !/not found|does not exist/i.test(error.message || "")) {
      console.warn("Visible photo storage cleanup failed", error);
    }
  }

  async function performRevertChange(eventId, button) {
    const event = state.events.find((entry) => entry.id === eventId);
    if (!event || !canRevertChangeEvent(event)) return;

    const direction = event.isCurrentlyReverted ? "reapply" : "revert";
    const verb = direction === "reapply" ? "reapply" : "revert";
    const itemName = event.itemTitle || event.locationName || "this record";
    if (!window.confirm(`Are you sure you want to ${verb} this change for ${itemName}?`)) return;

    const client = sb();
    const originalText = button?.textContent || (direction === "reapply" ? "Reapply Change" : "Revert Change");
    if (button) {
      button.disabled = true;
      button.textContent = direction === "reapply" ? "Reapplying..." : "Reverting...";
    }

    try {
      const adminEmail = await currentAdminEmail(client);

      if (event.category === "photo_event" && direction === "revert") {
        await copyQuarantinedPhotoToVisibleBucket(event);
      }

      if (event.category === "inventory_edit") {
        const rpcName = event.isDeletionEvent ? "revert_inventory_deletion" : "revert_inventory_change";
        const { error } = await client.rpc(rpcName, {
          _change_id: event.changeLogId,
          _direction: direction,
          _admin_email: adminEmail || null,
        });
        if (error) throw error;
      } else if (event.category === "photo_event") {
        const { error } = await client.rpc("revert_photo_deletion_change", {
          _log_id: event.logId,
          _direction: direction,
          _admin_email: adminEmail || null,
        });
        if (error) throw error;

        if (direction === "reapply") {
          await removeVisiblePhotoStorage(event.photoPath);
        }
      }

      await loadEvents();
    } catch (error) {
      console.error("Change revert failed", error);
      window.alert(`Could not ${verb} this change: ${error?.message || "Unknown error"}`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = originalText;
      }
    }
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
    hydrateChangePhotos();
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

    qs("changesTimeline")?.addEventListener("click", async (event) => {
      const photo = event.target.closest("img[data-change-photo-path]");
      if (photo) {
        await openChangePhotoViewer(photo);
        return;
      }

      const button = event.target.closest("[data-revert-event-id]");
      if (!button) return;
      await performRevertChange(button.dataset.revertEventId, button);
    });

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeChangePhotoViewer();
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
