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

  return (data || []).map((tx) => {
    const item = tx.item_types || {};
    const loc = tx.locations || {};
    const qty = Number(tx.quantity || 0);
    const unitCost = Number(item.cost || 0);
    const unitValue = Number(item.sale_price || 0);
    const deletedSameDay = isVoidedSameDayAdd(item, tx.confirmed_at || tx.timestamp);

    return {
      id: `stock-${tx.id}`,
      kind: deletedSameDay ? "deleted" : "stock",
      kindLabel: deletedSameDay ? "Deleted Same Day" : "Inventory Added",
      time: tx.confirmed_at || tx.timestamp,
      itemId: tx.item_id,
      title: item.title || "Unknown item",
      barcode: item.barcode || "",
      quantity: qty,
      location: [loc.location_name, loc.location_code].filter(Boolean).join(" / "),
      worker: tx.email || tx.user_id || "Unknown",
      cost: unitCost * qty,
      value: unitValue * qty,
      metricCost: deletedSameDay ? 0 : unitCost * qty,
      metricValue: deletedSameDay ? 0 : unitValue * qty,
      metricQuantity: deletedSameDay ? 0 : qty,
      isVoided: deletedSameDay,
      deletedAt: item.deleted_at || "",
      deletedBy: item.deleted_by_email || "",
      notes: deletedSameDay
        ? `Voided from totals. Deleted ${formatDateTime(item.deleted_at)}${item.deleted_by_email ? ` by ${item.deleted_by_email}` : ""}${item.deletion_reason ? ` - ${item.deletion_reason}` : ""}`
        : tx.notes || tx.method || "",
    };
  });
}

function renderMetrics(rows) {
  const container = document.getElementById("activity-metrics");
  if (!container) return;

  const activeRows = rows.filter((row) => !row.isVoided);
  const voidedRows = rows.filter((row) => row.isVoided);
  const newItems = activeRows.filter((row) => row.kind === "new").length;
  const stockEvents = activeRows.filter((row) => row.kind === "stock").length;
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
      <div class="metric-foot">Shown below, excluded from totals</div>
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
        row.isVoided ? "deleted voided excluded" : "",
      ].join(" ").toLowerCase();
      return haystack.includes(query);
    });

  state.filteredRows = rows;
  renderMetrics(rows);
  renderTable(rows);
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
