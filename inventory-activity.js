function waitForSupabaseReady(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve(window.supabase);

    let done = false;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("Supabase not ready."));
    }, timeoutMs);

    document.addEventListener("supabase-ready", () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(window.supabase);
    }, { once: true });
  });
}

const state = {
  rows: [],
  filteredRows: [],
  selectedDateFrom: "",
  selectedDateTo: "",
  adminEmail: "",
  pendingStockAdjustment: null,
};

const fmtMoney = (n) => `$${Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}`;

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function localDateValue(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function dayWindowIso(dateValue) {
  const [year, month, day] = dateValue.split("-").map(Number);
  const start = new Date(year, month - 1, day, 0, 0, 0, 0);
  const end = new Date(year, month - 1, day + 1, 0, 0, 0, 0);
  return { startIso: start.toISOString(), endIso: end.toISOString(), start };
}

function dateRangeWindowIso(fromValue, toValue) {
  const from = fromValue || localDateValue();
  const to = toValue || from;
  const normalizedFrom = from <= to ? from : to;
  const normalizedTo = from <= to ? to : from;
  const startWindow = dayWindowIso(normalizedFrom);
  const endWindow = dayWindowIso(normalizedTo);
  return {
    from: normalizedFrom,
    to: normalizedTo,
    startIso: startWindow.startIso,
    endIso: endWindow.endIso,
    start: startWindow.start,
    end: endWindow.start,
  };
}

function formatDateRangeLabel(start, end) {
  const sameDay = start.toDateString() === end.toDateString();
  if (sameDay) return start.toLocaleDateString();
  return `${start.toLocaleDateString()} to ${end.toLocaleDateString()}`;
}

function formatDateTime(iso) {
  if (!iso) return "--";
  return new Date(iso).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function isSameLocalDate(value, reference) {
  if (!value || !reference) return false;
  const date = new Date(value);
  const refDate = new Date(reference);
  if (Number.isNaN(date.getTime()) || Number.isNaN(refDate.getTime())) return false;
  return date.getFullYear() === refDate.getFullYear()
    && date.getMonth() === refDate.getMonth()
    && date.getDate() === refDate.getDate();
}

function isVoidedSameDayAdd(item, eventTime) {
  return Boolean(item?.deleted_at && isSameLocalDate(item.deleted_at, eventTime));
}

function setError(message) {
  const el = document.getElementById("activity-error");
  if (!el) return;
  el.hidden = !message;
  el.textContent = message || "";
}

async function checkAdminAuth() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();
  if (sessionError) console.error("Session error:", sessionError);

  if (!session) {
    window.location.href = "index.html";
    return false;
  }

  state.adminEmail = session.user?.email || "";

  const { data: employee, error } = await supabase
    .from("employees")
    .select("role, active, display_name")
    .eq("user_id", session.user.id)
    .maybeSingle();

  if (error || !employee || employee.active === false) {
    window.location.href = "index.html";
    return false;
  }

  if (String(employee.role || "").toLowerCase() !== "admin") {
    window.location.href = "worker-dashboard.html";
    return false;
  }

  const greeting = document.getElementById("admin-greeting");
  if (greeting) {
    const name = employee.display_name ? `, ${employee.display_name}` : "";
    greeting.textContent = `Welcome, Admin${name}`;
  }

  return true;
}

function isMissingDailyAdjustmentStorage(error) {
  const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""} ${error?.code || ""}`;
  return /daily_stock_checkin_adjustments|admin_adjust_daily_stock_checkin|schema cache|could not find|does not exist/i.test(text);
}

async function bumpInventoryVersion(changedIds = null) {
  const payload = {
    inventory_version: crypto.randomUUID(),
    changed_item_ids: Array.isArray(changedIds) && changedIds.length > 0 ? changedIds : null,
  };

  const { error } = await supabase
    .from("metadata")
    .update(payload)
    .eq("id", "inventory");

  if (error) {
    console.warn("Daily Adds correction saved, but the stock refresh signal failed:", error);
  }
}

function setActiveNavLink() {
  const path = (location.pathname || "").split("/").pop() || "inventory-activity.html";
  document.querySelectorAll(".nav-link").forEach((link) => {
    const href = (link.getAttribute("href") || "").split("/").pop();
    if (href === path) link.classList.add("active");
  });
}

function setupNavigation() {
  document.getElementById("logout")?.addEventListener("click", async (event) => {
    event.preventDefault();
    await supabase.auth.signOut();
    window.location.href = "index.html";
  });

  document.getElementById("logout-mobile")?.addEventListener("click", async (event) => {
    event.preventDefault();
    await supabase.auth.signOut();
    window.location.href = "index.html";
  });

  document.getElementById("menu-toggle")?.addEventListener("click", () => {
    document.getElementById("mobile-menu")?.classList.toggle("show");
  });

  if (typeof lucide !== "undefined") {
    lucide.createIcons();
  }
}

async function loadNewItems(startIso, endIso) {
  const { data, error } = await supabase
    .from("item_types")
    .select("id, title, barcode, created_at, cost, sale_price, weight, categories, added_by, added_by_email, deleted_at, deleted_by_email, deletion_reason, deletion_status")
    .gte("created_at", startIso)
    .lt("created_at", endIso)
    .order("created_at", { ascending: false });

  if (error) throw error;

  return (data || []).map((item) => {
    const deletedSameDay = isVoidedSameDayAdd(item, item.created_at);
    const categoryNotes = Array.isArray(item.categories) ? item.categories.join(", ") : "";
    return {
      id: `item-${item.id}`,
      kind: deletedSameDay ? "deleted" : "new",
      kindLabel: deletedSameDay ? "Deleted Same Day" : "New Item",
      time: item.created_at,
      itemId: item.id,
      title: item.title || "Untitled item",
      barcode: item.barcode || "",
      quantity: null,
      location: "",
      worker: item.added_by_email || item.added_by || "Unknown",
      cost: Number(item.cost || 0),
      value: Number(item.sale_price || 0),
      metricCost: deletedSameDay ? 0 : Number(item.cost || 0),
      metricValue: deletedSameDay ? 0 : Number(item.sale_price || 0),
      metricQuantity: 0,
      isVoided: deletedSameDay,
      deletedAt: item.deleted_at || "",
      deletedBy: item.deleted_by_email || "",
      notes: deletedSameDay
        ? `Deleted ${formatDateTime(item.deleted_at)}${item.deleted_by_email ? ` by ${item.deleted_by_email}` : ""}${item.deletion_reason ? ` - ${item.deletion_reason}` : ""}`
        : categoryNotes,
    };
  });
}

async function loadStockAdds(startIso, endIso) {
  const { data, error } = await supabase
    .from("stock_transactions")
    .select(`
      id,
      item_id,
      location_id,
      quantity,
      action_type,
      confirmed_at,
      timestamp,
      user_id,
      email,
      method,
      notes,
      item_types(id, title, barcode, cost, sale_price, deleted_at, deleted_by_email, deletion_reason, deletion_status),
      locations(id, location_name, location_code)
    `)
    .eq("action_type", "checkin")
    .gt("quantity", 0)
    .gte("confirmed_at", startIso)
    .lt("confirmed_at", endIso)
    .order("confirmed_at", { ascending: false });

  if (error) throw error;

  const transactionIds = (data || []).map((tx) => tx.id).filter(Boolean);
  const adjustmentsBySource = await loadStockAdjustments(transactionIds);

  return (data || []).map((tx) => {
    const item = tx.item_types || {};
    const loc = tx.locations || {};
    const originalQty = Number(tx.quantity || 0);
    const unitCost = Number(item.cost || 0);
    const unitValue = Number(item.sale_price || 0);
    const deletedSameDay = isVoidedSameDayAdd(item, tx.confirmed_at || tx.timestamp);
    const adjustments = adjustmentsBySource.get(tx.id) || [];
    const latestAdjustment = adjustments[0] || null;
    const effectiveQty = latestAdjustment ? Number(latestAdjustment.new_quantity || 0) : originalQty;
    const adjusted = Boolean(latestAdjustment);
    const reverted = adjusted && effectiveQty === 0;
    const adjustmentNotes = adjustments.map((entry) => {
      const nextQty = Number(entry.new_quantity || 0).toLocaleString();
      const previousQty = Number(entry.previous_quantity || 0).toLocaleString();
      const actor = entry.performed_by_email ? ` by ${entry.performed_by_email}` : "";
      return `${formatDateTime(entry.created_at)}${actor}: ${previousQty} to ${nextQty}${entry.reason ? ` - ${entry.reason}` : ""}`;
    }).join(" | ");
    const baseNotes = deletedSameDay
      ? `Voided from totals. Deleted ${formatDateTime(item.deleted_at)}${item.deleted_by_email ? ` by ${item.deleted_by_email}` : ""}${item.deletion_reason ? ` - ${item.deletion_reason}` : ""}`
      : tx.notes || tx.method || "";
    const notes = [
      adjusted ? `Original add: ${originalQty.toLocaleString()} unit${originalQty === 1 ? "" : "s"}` : "",
      adjustmentNotes,
      baseNotes,
    ].filter(Boolean).join(" | ");

    return {
      id: `stock-${tx.id}`,
      kind: deletedSameDay ? "deleted" : reverted ? "stock-reverted" : adjusted ? "stock-adjusted" : "stock",
      kindLabel: deletedSameDay ? "Deleted Same Day" : reverted ? "Inventory Reverted" : adjusted ? "Inventory Adjusted" : "Inventory Added",
      time: tx.confirmed_at || tx.timestamp,
      transactionId: tx.id,
      itemId: tx.item_id,
      title: item.title || "Unknown item",
      barcode: item.barcode || "",
      quantity: effectiveQty,
      originalQuantity: originalQty,
      adjusted,
      reverted,
      adjustments,
      latestAdjustment,
      location: [loc.location_name, loc.location_code].filter(Boolean).join(" / "),
      worker: tx.email || tx.user_id || "Unknown",
      cost: unitCost * effectiveQty,
      value: unitValue * effectiveQty,
      metricCost: deletedSameDay ? 0 : unitCost * effectiveQty,
      metricValue: deletedSameDay ? 0 : unitValue * effectiveQty,
      metricQuantity: deletedSameDay ? 0 : effectiveQty,
      isVoided: deletedSameDay,
      canAdjustStock: !deletedSameDay,
      deletedAt: item.deleted_at || "",
      deletedBy: item.deleted_by_email || "",
      notes,
    };
  });
}

async function loadStockAdjustments(transactionIds = []) {
  const ids = [...new Set(transactionIds.filter(Boolean))];
  const map = new Map();
  if (!ids.length) return map;

  const { data, error } = await supabase
    .from("daily_stock_checkin_adjustments")
    .select(`
      id,
      source_transaction_id,
      correction_transaction_id,
      item_id,
      location_id,
      previous_quantity,
      new_quantity,
      quantity_delta,
      reason,
      performed_by,
      performed_by_email,
      created_at
    `)
    .in("source_transaction_id", ids)
    .order("created_at", { ascending: false });

  if (error) {
    if (isMissingDailyAdjustmentStorage(error)) {
      console.warn("Daily Adds adjustment migration has not been pushed yet:", error);
      return map;
    }
    throw error;
  }

  (data || []).forEach((row) => {
    const key = row.source_transaction_id;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });

  return map;
}

function renderMetrics(rows) {
  const container = document.getElementById("activity-metrics");
  if (!container) return;

  const activeRows = rows.filter((row) => !row.isVoided);
  const voidedRows = rows.filter((row) => row.isVoided);
  const newItems = activeRows.filter((row) => row.kind === "new").length;
  const stockEvents = activeRows.filter((row) => row.kind === "stock" || row.kind === "stock-adjusted").length;
  const revertedStockEvents = rows.filter((row) => row.kind === "stock-reverted").length;
  const quantityAdded = rows.reduce((sum, row) => sum + Number(row.metricQuantity || 0), 0);
  const addedValue = rows.reduce((sum, row) => sum + Number(row.metricValue || 0), 0);

  container.innerHTML = `
    <div class="metric-card">
      <div class="metric-top"><div class="metric-label">New Item Types</div><div class="metric-icon">+</div></div>
      <div class="metric-value">${newItems.toLocaleString()}</div>
      <div class="metric-foot">Created on selected day</div>
    </div>
    <div class="metric-card">
      <div class="metric-top"><div class="metric-label">Inventory Check-ins</div><div class="metric-icon">IN</div></div>
      <div class="metric-value">${stockEvents.toLocaleString()}</div>
      <div class="metric-foot">Stock add transactions</div>
    </div>
    <div class="metric-card">
      <div class="metric-top"><div class="metric-label">Units Added</div><div class="metric-icon">#</div></div>
      <div class="metric-value">${quantityAdded.toLocaleString()}</div>
      <div class="metric-foot">Total checked-in quantity</div>
    </div>
    <div class="metric-card">
      <div class="metric-top"><div class="metric-label">Added Retail Value</div><div class="metric-icon">$</div></div>
      <div class="metric-value">${fmtMoney(addedValue)}</div>
      <div class="metric-foot">${voidedRows.length ? `${voidedRows.length.toLocaleString()} same-day deletion${voidedRows.length === 1 ? "" : "s"} excluded` : "Sale price times checked-in units"}</div>
    </div>
    <div class="metric-card">
      <div class="metric-top"><div class="metric-label">Same-day Deleted</div><div class="metric-icon">VOID</div></div>
      <div class="metric-value">${voidedRows.length.toLocaleString()}</div>
      <div class="metric-foot">${revertedStockEvents.toLocaleString()} reverted inventory add${revertedStockEvents === 1 ? "" : "s"} also excluded</div>
    </div>
  `;
}

function renderStockActionCell(row) {
  if (!row.canAdjustStock || !row.transactionId) return `<span class="activity-muted">--</span>`;

  if (row.reverted) {
    return `
      <div class="activity-actions">
        <button class="activity-action-btn" type="button" data-adjust-stock-id="${escapeHtml(row.id)}">Restore / Change</button>
      </div>
    `;
  }

  return `
    <div class="activity-actions">
      <button class="activity-action-btn" type="button" data-adjust-stock-id="${escapeHtml(row.id)}">Change Qty</button>
      <button class="activity-action-btn danger" type="button" data-revert-stock-id="${escapeHtml(row.id)}">Revert Add</button>
    </div>
  `;
}

function renderTable(rows) {
  const container = document.getElementById("activity-table-container");
  if (!container) return;

  if (!rows.length) {
    container.innerHTML = `<div class="activity-empty">No inventory activity found for this day.</div>`;
    return;
  }

  const tableRows = rows.map((row) => `
    <tr class="${row.isVoided ? "activity-row-voided" : ""}">
      <td>${escapeHtml(formatDateTime(row.time))}</td>
      <td><span class="activity-type ${row.kind}">${escapeHtml(row.kindLabel)}</span></td>
      <td>
        <div class="activity-item">
          <strong>${escapeHtml(row.title)}</strong>
          <span>${escapeHtml(row.barcode || "--")}</span>
        </div>
      </td>
      <td>${row.quantity == null ? '<span class="activity-muted">--</span>' : Number(row.quantity).toLocaleString()}</td>
      <td>${escapeHtml(row.location || "--")}</td>
      <td>${escapeHtml(row.worker)}</td>
      <td>${fmtMoney(row.cost)}</td>
      <td>
        ${row.isVoided
          ? `<span class="activity-void-value">${fmtMoney(row.value)} excluded</span>`
          : fmtMoney(row.value)}
      </td>
      <td>${escapeHtml(row.notes || "--")}</td>
      <td>${renderStockActionCell(row)}</td>
    </tr>
  `).join("");

  container.innerHTML = `
    <div class="table-wrapper">
      <table class="summary-table">
        <thead>
          <tr>
            <th>Time</th>
            <th>Type</th>
            <th>Item</th>
            <th>Qty</th>
            <th>Location</th>
            <th>Worker</th>
            <th>Cost</th>
            <th>Value</th>
            <th>Notes</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  `;
}

function applySearch() {
  const query = (document.getElementById("activity-search")?.value || "").trim().toLowerCase();
  const rows = !query
    ? state.rows
    : state.rows.filter((row) => {
      const haystack = [
        row.kindLabel,
        row.title,
        row.barcode,
        row.location,
        row.worker,
        row.notes,
        row.adjusted ? "adjusted corrected correction changed quantity" : "",
        row.reverted ? "reverted fake test removed take out" : "",
        row.isVoided ? "deleted voided excluded" : "",
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });

  state.filteredRows = rows;
  renderMetrics(rows);
  renderTable(rows);
}

function getStockAdjustmentElements() {
  return {
    modal: document.getElementById("stock-adjustment-modal"),
    title: document.getElementById("stock-adjustment-title"),
    summary: document.getElementById("stock-adjustment-summary"),
    stats: document.getElementById("stock-adjustment-stats"),
    quantity: document.getElementById("stock-adjustment-quantity"),
    reason: document.getElementById("stock-adjustment-reason"),
    password: document.getElementById("stock-adjustment-password"),
    error: document.getElementById("stock-adjustment-error"),
    confirm: document.getElementById("stock-adjustment-confirm"),
    cancel: document.getElementById("stock-adjustment-cancel"),
    close: document.getElementById("stock-adjustment-close"),
  };
}

function findActivityRow(rowId) {
  return state.rows.find((row) => row.id === rowId) || null;
}

function setStockAdjustmentError(message = "") {
  const { error } = getStockAdjustmentElements();
  if (!error) return;
  error.hidden = !message;
  error.textContent = message || "";
}

function closeStockAdjustmentModal() {
  const elements = getStockAdjustmentElements();
  elements.modal?.classList.add("hidden");
  elements.modal?.setAttribute("aria-hidden", "true");
  state.pendingStockAdjustment = null;
  if (elements.quantity) elements.quantity.value = "";
  if (elements.reason) elements.reason.value = "";
  if (elements.password) elements.password.value = "";
  setStockAdjustmentError("");
}

function openStockAdjustmentModal(row, mode = "adjust") {
  const elements = getStockAdjustmentElements();
  if (!elements.modal || !row) return;

  const currentQty = Math.max(0, Number(row.quantity || 0));
  const nextQty = mode === "revert" ? 0 : currentQty;
  state.pendingStockAdjustment = { rowId: row.id, mode };

  if (elements.title) {
    elements.title.textContent = mode === "revert" ? "Revert Inventory Add" : "Change Added Quantity";
  }
  if (elements.summary) {
    elements.summary.innerHTML = `
      <strong>${escapeHtml(row.title)}</strong>
      <span>${escapeHtml(row.barcode || "No barcode")} - ${escapeHtml(row.location || "No location")}</span>
    `;
  }
  if (elements.stats) {
    elements.stats.innerHTML = `
      <div><span>Original add</span><strong>${Number(row.originalQuantity ?? row.quantity ?? 0).toLocaleString()}</strong></div>
      <div><span>Current counted add</span><strong>${currentQty.toLocaleString()}</strong></div>
      <div><span>New counted add</span><strong id="stock-adjustment-preview">${nextQty.toLocaleString()}</strong></div>
    `;
  }
  if (elements.quantity) {
    elements.quantity.value = String(nextQty);
    elements.quantity.readOnly = mode === "revert";
  }
  if (elements.reason) {
    elements.reason.value = mode === "revert" ? "Reverting mistaken or test inventory add." : "";
  }
  if (elements.password) elements.password.value = "";
  if (elements.confirm) {
    elements.confirm.textContent = mode === "revert" ? "Sign and Revert Add" : "Sign and Save Quantity";
  }
  setStockAdjustmentError("");
  elements.modal.classList.remove("hidden");
  elements.modal.setAttribute("aria-hidden", "false");
  setTimeout(() => (mode === "revert" ? elements.reason : elements.quantity)?.focus(), 60);
}

function updateStockAdjustmentPreview() {
  const input = document.getElementById("stock-adjustment-quantity");
  const preview = document.getElementById("stock-adjustment-preview");
  if (!input || !preview) return;
  const value = Math.max(0, Math.floor(Number(input.value || 0)));
  preview.textContent = Number.isFinite(value) ? value.toLocaleString() : "0";
}

async function confirmStockAdjustment() {
  const pending = state.pendingStockAdjustment;
  if (!pending) return;

  const row = findActivityRow(pending.rowId);
  const elements = getStockAdjustmentElements();
  if (!row) {
    setStockAdjustmentError("This activity row is no longer available. Refresh and try again.");
    return;
  }

  const newQuantity = Math.floor(Number(elements.quantity?.value || 0));
  const reason = (elements.reason?.value || "").trim();
  const password = elements.password?.value || "";

  if (!Number.isFinite(newQuantity) || newQuantity < 0) {
    setStockAdjustmentError("Enter a quantity of zero or higher.");
    elements.quantity?.focus();
    return;
  }
  if (newQuantity === Number(row.quantity || 0)) {
    setStockAdjustmentError("That add is already at this quantity.");
    elements.quantity?.focus();
    return;
  }
  if (reason.length < 3) {
    setStockAdjustmentError("Add a brief reason so the audit trail is useful.");
    elements.reason?.focus();
    return;
  }
  if (!password) {
    setStockAdjustmentError("Enter your password to sign this correction.");
    elements.password?.focus();
    return;
  }

  if (!state.adminEmail) {
    setStockAdjustmentError("Could not identify your admin email. Refresh and log in again.");
    return;
  }

  if (elements.confirm) elements.confirm.disabled = true;
  if (elements.cancel) elements.cancel.disabled = true;
  if (elements.close) elements.close.disabled = true;
  setStockAdjustmentError("");

  try {
    const { error: authError } = await supabase.auth.signInWithPassword({
      email: state.adminEmail,
      password,
    });
    if (authError) throw authError;

    const { error } = await supabase.rpc("admin_adjust_daily_stock_checkin", {
      _source_transaction_id: row.transactionId,
      _new_quantity: newQuantity,
      _reason: reason,
      _admin_email: state.adminEmail,
    });

    if (error) throw error;

    await bumpInventoryVersion([row.itemId]);
    closeStockAdjustmentModal();
    await refreshActivity();
  } catch (error) {
    console.error("Daily Adds stock adjustment failed:", error);
    const message = isMissingDailyAdjustmentStorage(error)
      ? "The Daily Adds adjustment migration needs to be pushed before this can be used."
      : error.message || "Could not save this correction.";
    setStockAdjustmentError(message);
  } finally {
    if (elements.confirm) elements.confirm.disabled = false;
    if (elements.cancel) elements.cancel.disabled = false;
    if (elements.close) elements.close.disabled = false;
  }
}

function setupStockAdjustmentModal() {
  const elements = getStockAdjustmentElements();

  document.getElementById("activity-table-container")?.addEventListener("click", (event) => {
    const adjustBtn = event.target.closest("[data-adjust-stock-id]");
    const revertBtn = event.target.closest("[data-revert-stock-id]");
    const rowId = adjustBtn?.dataset.adjustStockId || revertBtn?.dataset.revertStockId || "";
    if (!rowId) return;

    const row = findActivityRow(rowId);
    if (!row) return;
    openStockAdjustmentModal(row, revertBtn ? "revert" : "adjust");
  });

  elements.close?.addEventListener("click", closeStockAdjustmentModal);
  elements.cancel?.addEventListener("click", closeStockAdjustmentModal);
  elements.modal?.addEventListener("click", (event) => {
    if (event.target === elements.modal) closeStockAdjustmentModal();
  });
  elements.quantity?.addEventListener("input", updateStockAdjustmentPreview);
  elements.confirm?.addEventListener("click", confirmStockAdjustment);
  elements.password?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      confirmStockAdjustment();
    }
  });
}

async function refreshActivity() {
  const button = document.getElementById("refresh-activity");
  const fromInput = document.getElementById("activity-date-from");
  const toInput = document.getElementById("activity-date-to");
  const subtitle = document.getElementById("activity-subtitle");

  const range = dateRangeWindowIso(fromInput?.value, toInput?.value);
  state.selectedDateFrom = range.from;
  state.selectedDateTo = range.to;
  if (fromInput) fromInput.value = range.from;
  if (toInput) toInput.value = range.to;
  const rangeLabel = formatDateRangeLabel(range.start, range.end);

  setError("");
  if (button) button.disabled = true;
  if (subtitle) subtitle.textContent = `Loading activity for ${rangeLabel}...`;

  try {
    const [newItems, stockAdds] = await Promise.all([
      loadNewItems(range.startIso, range.endIso),
      loadStockAdds(range.startIso, range.endIso),
    ]);

    state.rows = [...newItems, ...stockAdds]
      .sort((a, b) => new Date(b.time || 0) - new Date(a.time || 0));

    if (subtitle) {
      subtitle.textContent = `${state.rows.length.toLocaleString()} event(s) for ${rangeLabel}`;
    }
    applySearch();
  } catch (error) {
    console.error("Daily inventory activity failed:", error);
    setError(error.message || "Could not load daily inventory activity.");
    state.rows = [];
    applySearch();
  } finally {
    if (button) button.disabled = false;
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await waitForSupabaseReady();
  } catch (error) {
    console.error(error);
    setError("Supabase did not initialize. Please refresh and try again.");
    return;
  }

  const allowed = await checkAdminAuth();
  if (!allowed) return;

  setActiveNavLink();
  setupNavigation();
  setupStockAdjustmentModal();

  const today = localDateValue();
  const fromInput = document.getElementById("activity-date-from");
  const toInput = document.getElementById("activity-date-to");
  if (fromInput) fromInput.value = today;
  if (toInput) toInput.value = today;

  document.getElementById("refresh-activity")?.addEventListener("click", refreshActivity);
  document.getElementById("activity-date-from")?.addEventListener("change", refreshActivity);
  document.getElementById("activity-date-to")?.addEventListener("change", refreshActivity);
  document.getElementById("activity-search")?.addEventListener("input", applySearch);

  await refreshActivity();
});
