function waitForSupabaseReady(timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    if (window.supabase) return resolve(window.supabase);

    let done = false;
    const timeout = setTimeout(() => {
      if (done) return;
      done = true;
      reject(new Error("Supabase not ready (timeout)."));
    }, timeoutMs);

    document.addEventListener("supabase-ready", () => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(window.supabase);
    }, { once: true });
  });
}

async function checkAuth() {
  const { data: { session }, error: sessionError } = await supabase.auth.getSession();

  if (sessionError) console.error("Session error:", sessionError);
  if (!session) {
    window.location.href = "index.html";
    return false;
  }

  const userId = session.user.id;
  const { data: employee, error: employeeError } = await supabase
    .from("employees")
    .select("role, active, display_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (employeeError || !employee || employee.active === false) {
    console.error("Failed employee auth lookup:", employeeError);
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
  const path = (location.pathname || "").split("/").pop() || "locations.html";
  document.querySelectorAll(".nav-link").forEach((link) => {
    const href = (link.getAttribute("href") || "").split("/").pop();
    if (href && href === path) link.classList.add("active");
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

const state = {
  locations: [],
  stores: [],
  selectedLocationId: null,
  filters: {
    search: "",
    store: "",
    type: "",
    active: "",
    sort: "recent",
  },
  locationPhotoUrls: new Map(),
  itemPhotoUrls: new Map(),
  dymoUrls: new Map(),
};

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function asTrimmedString(value) {
  return String(value || "").trim();
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
  });
}

function formatDateTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "numeric",
    minute: "2-digit",
  });
}

function getLocationDisplayDate(location) {
  return location.updated_at || location.recentActivityAt || location.created_at || "";
}

function compareRecent(a, b) {
  return new Date(getLocationDisplayDate(b) || 0).getTime() - new Date(getLocationDisplayDate(a) || 0).getTime();
}

function getStoreLabel(location) {
  return asTrimmedString(location?.store_name) || "Unassigned";
}

function buildStoreOptionsMarkup(selectedValue = "", emptyLabel = "All stores") {
  return [`<option value="">${escapeHtml(emptyLabel)}</option>`]
    .concat(
      state.stores.map((store) => {
        const selected = store.id === selectedValue ? ' selected' : "";
        return `<option value="${escapeHtml(store.id)}"${selected}>${escapeHtml(store.name)}</option>`;
      })
    )
    .join("");
}

function setListStatus(message, tone = "") {
  const statusEl = document.getElementById("locations-list-status");
  if (!statusEl) return;

  statusEl.textContent = message;
  statusEl.style.color = tone === "error"
    ? "#ffb4a7"
    : tone === "success"
      ? "#cfeecf"
      : "";
}

async function createSignedStorageUrl(bucket, path, cache, expiresIn = 3600) {
  const normalizedPath = asTrimmedString(path);
  if (!normalizedPath) return "";
  if (/^https?:\/\//i.test(normalizedPath)) return normalizedPath;
  if (cache.has(normalizedPath)) return cache.get(normalizedPath);

  const { data, error } = await supabase.storage
    .from(bucket)
    .createSignedUrl(normalizedPath, expiresIn);

  if (error) {
    console.warn(`Failed to sign ${bucket} asset:`, normalizedPath, error);
    return "";
  }

  const signedUrl = data?.signedUrl || "";
  cache.set(normalizedPath, signedUrl);
  return signedUrl;
}

async function resolveLocationPhotoUrl(location) {
  return createSignedStorageUrl("location-assets", location.photo_url, state.locationPhotoUrls);
}

async function resolveItemPhotoUrl(itemPhotoPath) {
  return createSignedStorageUrl("photos", itemPhotoPath, state.itemPhotoUrls);
}

async function resolveDymoUrl(location) {
  return createSignedStorageUrl("dymo-labels", location.dymo_label_url, state.dymoUrls, 60 * 60 * 24);
}

function normalizeLocationsData(locations, stockRows, itemTypes, stores) {
  const itemMap = new Map((itemTypes || []).map((item) => [item.id, item]));
  const stockByLocation = new Map();
  const storeMap = new Map((stores || []).map((store) => [store.id, store]));

  for (const row of stockRows || []) {
    const locationId = row.location_id;
    if (!stockByLocation.has(locationId)) {
      stockByLocation.set(locationId, []);
    }
    stockByLocation.get(locationId).push(row);
  }

  return (locations || []).map((location) => {
    const rows = stockByLocation.get(location.id) || [];
    const groupedByItem = new Map();

    for (const row of rows) {
      const current = groupedByItem.get(row.item_id) || {
        item_id: row.item_id,
        quantity: 0,
        recentAt: "",
      };

      current.quantity += Number(row.quantity || 0);
      current.recentAt = [current.recentAt, row.confirmed_at, row.created_at]
        .filter(Boolean)
        .sort()
        .pop() || current.recentAt;

      groupedByItem.set(row.item_id, current);
    }

    const itemRows = Array.from(groupedByItem.values())
      .map((entry) => {
        const item = itemMap.get(entry.item_id);
        const photos = Array.isArray(item?.photos) ? item.photos : [];
        return {
          itemId: entry.item_id,
          title: item?.title || "Untitled Item",
          barcode: item?.barcode || "—",
          quantity: entry.quantity,
          photoPath: photos[0] || "",
          recentAt: entry.recentAt,
        };
      })
      .sort((a, b) => Number(b.quantity || 0) - Number(a.quantity || 0));

    const totalQuantity = itemRows.reduce((sum, item) => sum + Number(item.quantity || 0), 0);
    const recentActivityAt = [location.updated_at, location.created_at]
      .concat(itemRows.map((item) => item.recentAt))
      .filter(Boolean)
      .sort()
      .pop() || "";

    return {
      ...location,
      store_name: storeMap.get(location.store_id)?.name || "",
      itemRows,
      distinctItemTypes: itemRows.length,
      totalQuantity,
      recentActivityAt,
      notesPreview: asTrimmedString(location.notes).slice(0, 120),
    };
  });
}

async function loadLocationsData() {
  setListStatus("Loading locations...");

  const [
    { data: locations, error: locationsError },
    { data: stores, error: storesError },
    { data: stockRows, error: stockError },
    { data: itemTypes, error: itemTypesError },
  ] = await Promise.all([
    supabase.from("locations").select("*"),
    supabase.from("store_locations").select("id, name, active").order("name", { ascending: true }),
    supabase.from("item_stock_locations").select("*"),
    supabase.from("item_types").select("id, title, barcode, photos"),
  ]);

  if (locationsError || storesError || stockError || itemTypesError) {
    console.error("Failed to load locations data:", locationsError || storesError || stockError || itemTypesError);
    setListStatus("Could not load locations data.", "error");
    return;
  }

  state.stores = Array.isArray(stores) ? stores : [];
  state.locations = normalizeLocationsData(locations, stockRows, itemTypes, state.stores);
  populateStoreFilter();
  populateTypeFilter();
  renderSummaryCards();
  renderLocationsTable();

  const selectedStillExists = state.locations.some((location) => location.id === state.selectedLocationId);
  if (selectedStillExists) {
    await renderLocationDetail(state.selectedLocationId);
  } else {
    closeLocationDetail();
  }
}

function populateStoreFilter() {
  const storeFilter = document.getElementById("locations-store-filter");
  if (!storeFilter) return;

  storeFilter.innerHTML = buildStoreOptionsMarkup(state.filters.store, "All stores");
  storeFilter.value = state.filters.store;
}

function populateTypeFilter() {
  const typeFilter = document.getElementById("locations-type-filter");
  if (!typeFilter) return;

  const currentValue = state.filters.type;
  const types = [...new Set(state.locations.map((location) => asTrimmedString(location.type)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b));

  typeFilter.innerHTML = ['<option value="">All types</option>']
    .concat(types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`))
    .join("");

  typeFilter.value = currentValue;
}

function getFilteredLocations() {
  const searchTerm = state.filters.search.toLowerCase();

  const filtered = state.locations.filter((location) => {
    const matchesSearch = !searchTerm || [
      location.location_name,
      location.location_code,
      location.notes,
      location.type,
      location.store_name,
    ].some((value) => asTrimmedString(value).toLowerCase().includes(searchTerm));

    const matchesStore = !state.filters.store || asTrimmedString(location.store_id) === state.filters.store;
    const matchesType = !state.filters.type || asTrimmedString(location.type) === state.filters.type;
    const isActive = location.active !== false;
    const matchesActive = !state.filters.active
      || (state.filters.active === "active" && isActive)
      || (state.filters.active === "inactive" && !isActive);

    return matchesSearch && matchesStore && matchesType && matchesActive;
  });

  filtered.sort((a, b) => {
    if (state.filters.sort === "name") {
      return asTrimmedString(a.location_name).localeCompare(asTrimmedString(b.location_name));
    }
    if (state.filters.sort === "quantity") {
      return Number(b.totalQuantity || 0) - Number(a.totalQuantity || 0);
    }
    if (state.filters.sort === "items") {
      return Number(b.distinctItemTypes || 0) - Number(a.distinctItemTypes || 0);
    }
    return compareRecent(a, b);
  });

  return filtered;
}

function renderSummaryCards() {
  const container = document.getElementById("locations-metric-cards");
  if (!container) return;

  const totalLocations = state.locations.length;
  const activeLocations = state.locations.filter((location) => location.active !== false).length;
  const totalStockUnits = state.locations.reduce((sum, location) => sum + Number(location.totalQuantity || 0), 0);
  const representedStores = new Set(state.locations.map((location) => asTrimmedString(location.store_id)).filter(Boolean)).size;
  const recentThreshold = Date.now() - (1000 * 60 * 60 * 24 * 14);
  const recentUpdates = state.locations.filter((location) => {
    const timestamp = new Date(getLocationDisplayDate(location) || 0).getTime();
    return Number.isFinite(timestamp) && timestamp >= recentThreshold;
  }).length;

  container.innerHTML = `
    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Active Locations</div>
        <div class="metric-icon">📍</div>
      </div>
      <div class="metric-value">${activeLocations.toLocaleString()}</div>
      <div class="metric-foot">Locations currently marked active</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Distinct Locations</div>
        <div class="metric-icon">🗂️</div>
      </div>
      <div class="metric-value">${totalLocations.toLocaleString()}</div>
      <div class="metric-foot">Total registered storage destinations</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Total Stock Units</div>
        <div class="metric-icon">📦</div>
      </div>
      <div class="metric-value">${totalStockUnits.toLocaleString()}</div>
      <div class="metric-foot">Units distributed across all locations</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Stores Covered</div>
        <div class="metric-icon">🕰️</div>
      </div>
      <div class="metric-value">${representedStores.toLocaleString()}</div>
      <div class="metric-foot">${recentUpdates.toLocaleString()} locations updated or created in the last 14 days</div>
    </div>
  `;
}

function renderLocationsTable() {
  const tbody = document.getElementById("locations-table-body");
  if (!tbody) return;

  const filtered = getFilteredLocations();

  if (!filtered.length) {
    tbody.innerHTML = `
      <tr>
        <td colspan="9">
          <div class="location-detail-empty">No locations match the current filters.</div>
        </td>
      </tr>
    `;
    setListStatus("No locations match the current filters.");
    return;
  }

  setListStatus(`${filtered.length} location(s) shown.`);

  tbody.innerHTML = filtered.map((location) => `
    <tr>
      <td>
        <button type="button" class="location-row-action" data-open-location="${escapeHtml(location.id)}">
          <span class="location-row-title">${escapeHtml(location.location_name || "Unnamed Location")}</span>
          <span class="location-row-sub">${escapeHtml(location.location_code || "No barcode")} • ${escapeHtml(location.notesPreview || "No notes recorded.")}</span>
        </button>
      </td>
      <td>
        <span class="locations-pill is-store">${escapeHtml(getStoreLabel(location))}</span>
      </td>
      <td>
        <span class="locations-pill is-type">${escapeHtml(location.type || "Uncategorized")}</span>
      </td>
      <td>
        <span class="locations-pill ${location.active === false ? "is-inactive" : "is-active"}">
          ${location.active === false ? "Inactive" : "Active"}
        </span>
      </td>
      <td>
        <div class="locations-assets">
          <span class="locations-pill is-asset">${location.location_code ? "Barcode Ready" : "No Barcode"}</span>
          <span class="locations-pill is-asset">${location.dymo_label_url ? "DYMO Ready" : "No DYMO"}</span>
        </div>
      </td>
      <td>${Number(location.distinctItemTypes || 0).toLocaleString()}</td>
      <td>${Number(location.totalQuantity || 0).toLocaleString()}</td>
      <td>${escapeHtml(formatDateTime(getLocationDisplayDate(location)))}</td>
      <td>
        <button type="button" class="locations-action-button" data-open-location="${escapeHtml(location.id)}">
          View / Edit
        </button>
      </td>
    </tr>
  `).join("");
}

function closeLocationDetail() {
  state.selectedLocationId = null;
  const drawer = document.getElementById("location-detail-drawer");
  drawer.classList.add("hidden");
  drawer.setAttribute("aria-hidden", "true");
}

async function renderLocationDetail(locationId) {
  const location = state.locations.find((entry) => entry.id === locationId);
  if (!location) {
    closeLocationDetail();
    return;
  }

  state.selectedLocationId = locationId;

  const drawer = document.getElementById("location-detail-drawer");
  const body = document.getElementById("location-detail-body");
  const title = document.getElementById("location-detail-title");
  const subtitle = document.getElementById("location-detail-subtitle");

  drawer.classList.remove("hidden");
  drawer.setAttribute("aria-hidden", "false");
  title.textContent = location.location_name || "Unnamed Location";
  subtitle.textContent = `${location.location_code || "No barcode"} • ${Number(location.totalQuantity || 0).toLocaleString()} total units • ${Number(location.distinctItemTypes || 0).toLocaleString()} item types`;
  body.innerHTML = `<div class="location-detail-empty">Loading location detail…</div>`;

  const [photoUrl, dymoUrl, itemPhotoUrls] = await Promise.all([
    resolveLocationPhotoUrl(location),
    resolveDymoUrl(location),
    Promise.all(location.itemRows.map((item) => resolveItemPhotoUrl(item.photoPath))),
  ]);

  const itemsMarkup = location.itemRows.length
    ? location.itemRows.map((item, index) => `
        <div class="location-item-card">
          <div class="location-item-thumb">
            ${itemPhotoUrls[index]
              ? `<img src="${escapeHtml(itemPhotoUrls[index])}" alt="${escapeHtml(item.title)}" />`
              : "No Img"}
          </div>
          <div>
            <div class="location-item-title">${escapeHtml(item.title)}</div>
            <div class="location-item-meta">Barcode: ${escapeHtml(item.barcode || "—")}</div>
          </div>
          <div class="location-item-qty">
            <strong>${Number(item.quantity || 0).toLocaleString()}</strong>
            <span class="location-item-meta">units</span>
          </div>
        </div>
      `).join("")
    : `<div class="location-detail-empty">No items are currently stocked in this location.</div>`;

  body.innerHTML = `
    <section class="location-detail-card">
      <div class="location-detail-card-head">
        <h4 class="location-detail-card-title">Overview</h4>
        <span class="locations-pill ${location.active === false ? "is-inactive" : "is-active"}">
          ${location.active === false ? "Inactive" : "Active"}
        </span>
      </div>

      <div class="location-detail-meta-grid">
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Location Name</div>
          <div class="location-detail-stat-value">${escapeHtml(location.location_name || "—")}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Location Code</div>
          <div class="location-detail-stat-value">${escapeHtml(location.location_code || "—")}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Type</div>
          <div class="location-detail-stat-value">${escapeHtml(location.type || "—")}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Max Capacity</div>
          <div class="location-detail-stat-value">${location.max_capacity ?? "—"}</div>
        </div>
        <div class="location-detail-stat full">
          <div class="location-detail-stat-label">Notes</div>
          <div class="location-detail-stat-value">${escapeHtml(location.notes || "No notes recorded.")}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Distinct Item Types</div>
          <div class="location-detail-stat-value">${Number(location.distinctItemTypes || 0).toLocaleString()}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Total Units</div>
          <div class="location-detail-stat-value">${Number(location.totalQuantity || 0).toLocaleString()}</div>
        </div>
      </div>
      <div class="location-status-line">Updated: ${escapeHtml(formatDateTime(getLocationDisplayDate(location)))}</div>
    </section>

    <section class="location-detail-card">
      <div class="location-detail-card-head">
        <h4 class="location-detail-card-title">Barcode and Label Assets</h4>
      </div>
      <div class="location-asset-grid">
        <div class="location-barcode-panel">
          ${location.location_code
            ? `<canvas id="location-detail-barcode" class="location-barcode-canvas"></canvas>`
            : `<div class="location-detail-empty">No location barcode is stored yet.</div>`}
          <div class="location-asset-actions">
            <button type="button" class="locations-action-button" data-copy-location-code="${escapeHtml(location.location_code || "")}" ${location.location_code ? "" : "disabled"}>
              Copy Barcode
            </button>
            ${dymoUrl
              ? `<a class="locations-link-button" href="${escapeHtml(dymoUrl)}" target="_blank" rel="noreferrer">Open DYMO Label</a>`
              : `<span class="locations-pill is-asset">DYMO label unavailable</span>`}
          </div>
        </div>

        <div class="location-photo-panel">
          ${photoUrl
            ? `<img class="location-photo-image" src="${escapeHtml(photoUrl)}" alt="${escapeHtml(location.location_name || "Location photo")}" />`
            : `<div class="location-detail-empty">No location photo available.</div>`}
        </div>
      </div>
    </section>

    <section class="location-detail-card">
      <div class="location-detail-card-head">
        <div>
          <h4 class="location-detail-card-title">Edit Location Details</h4>
          <div class="location-status-line">Admins can rename locations, change store/type/capacity, update notes, and replace the photo here.</div>
        </div>
      </div>
      <form id="location-edit-form" data-location-id="${escapeHtml(location.id)}">
        <div class="location-edit-grid">
          <label class="location-edit-label">
            <span>Location Name</span>
            <input type="text" id="location-edit-name" class="location-edit-input" value="${escapeHtml(location.location_name || "")}" />
          </label>

          <label class="location-edit-label">
            <span>Store</span>
            <select id="location-edit-store" class="location-edit-select">
              ${buildStoreOptionsMarkup(asTrimmedString(location.store_id), "Unassigned")}
            </select>
          </label>

          <label class="location-edit-label">
            <span>Type</span>
            <input type="text" id="location-edit-type" class="location-edit-input" value="${escapeHtml(location.type || "")}" placeholder="Shelf, safe, tray, bin" />
          </label>

          <label class="location-edit-label">
            <span>Max Capacity</span>
            <input type="number" id="location-edit-capacity" class="location-edit-input" value="${location.max_capacity ?? ""}" min="0" />
          </label>

          <label class="location-edit-label full">
            <span>Notes</span>
            <textarea id="location-edit-notes" class="location-edit-textarea">${escapeHtml(location.notes || "")}</textarea>
          </label>

          <label class="location-edit-label full">
            <span>Replace Photo</span>
            <input type="file" id="location-edit-photo" class="location-edit-input" accept="image/*" />
          </label>

          <label class="location-edit-toggle full">
            <input type="checkbox" id="location-edit-active" ${location.active === false ? "" : "checked"} />
            <span>Location is active</span>
          </label>
        </div>

        <div class="location-edit-actions">
          <button type="submit" class="locations-action-button">Save Location Changes</button>
        </div>
        <div id="location-edit-status" class="location-status-line"></div>
      </form>
    </section>

    <section class="location-detail-card">
      <div class="location-detail-card-head">
        <h4 class="location-detail-card-title">Items in This Location</h4>
      </div>
      <div class="location-items-list">${itemsMarkup}</div>
    </section>
  `;

  const barcodeCanvas = document.getElementById("location-detail-barcode");
  if (barcodeCanvas && location.location_code) {
    JsBarcode(barcodeCanvas, location.location_code, {
      format: "CODE128",
      lineColor: "#111111",
      background: "#ffffff",
      displayValue: true,
      fontOptions: "bold",
      fontSize: 16,
      height: 62,
      margin: 10,
    });
  }
}

async function saveLocationEdits(locationId) {
  const location = state.locations.find((entry) => entry.id === locationId);
  if (!location) return;

  const statusEl = document.getElementById("location-edit-status");
  const name = asTrimmedString(document.getElementById("location-edit-name")?.value);
  const storeId = asTrimmedString(document.getElementById("location-edit-store")?.value);
  const type = asTrimmedString(document.getElementById("location-edit-type")?.value);
  const capacityValue = asTrimmedString(document.getElementById("location-edit-capacity")?.value);
  const notes = asTrimmedString(document.getElementById("location-edit-notes")?.value);
  const active = Boolean(document.getElementById("location-edit-active")?.checked);
  const photoFile = document.getElementById("location-edit-photo")?.files?.[0] || null;

  if (!name) {
    if (statusEl) statusEl.textContent = "Location name is required.";
    return;
  }

  if (statusEl) statusEl.textContent = "Saving location changes...";

  let photoPath = location.photo_url || null;
  if (photoFile) {
    const safeName = photoFile.name.replace(/[^\w.\-]+/g, "_");
    const storagePath = `photos/${Date.now()}_${safeName}`;
    const { error: uploadError } = await supabase.storage
      .from("location-assets")
      .upload(storagePath, photoFile, { upsert: true });

    if (uploadError) {
      console.error("Location photo upload failed:", uploadError);
      if (statusEl) statusEl.textContent = `Photo upload failed: ${uploadError.message}`;
      return;
    }

    photoPath = storagePath;
    state.locationPhotoUrls.delete(location.photo_url || "");
    state.locationPhotoUrls.delete(photoPath);
  }

  const updatePayload = {
    location_name: name,
    store_id: storeId || null,
    type: type || null,
    notes: notes || null,
    active,
    photo_url: photoPath,
    max_capacity: capacityValue ? Number(capacityValue) : null,
  };

  const { data, error } = await supabase
    .from("locations")
    .update(updatePayload)
    .eq("id", locationId)
    .select("*")
    .single();

  if (error || !data) {
    console.error("Location update failed:", error);
    if (statusEl) statusEl.textContent = `Could not save changes: ${error?.message || "Unknown error"}`;
    return;
  }

  if (statusEl) statusEl.textContent = "Location updated.";
  await loadLocationsData();
  await renderLocationDetail(locationId);
}

function bindEvents() {
  document.getElementById("locations-search")?.addEventListener("input", (event) => {
    state.filters.search = event.target.value.trim();
    renderLocationsTable();
  });

  document.getElementById("locations-type-filter")?.addEventListener("change", (event) => {
    state.filters.type = event.target.value;
    renderLocationsTable();
  });

  document.getElementById("locations-store-filter")?.addEventListener("change", (event) => {
    state.filters.store = event.target.value;
    renderLocationsTable();
  });

  document.getElementById("locations-active-filter")?.addEventListener("change", (event) => {
    state.filters.active = event.target.value;
    renderLocationsTable();
  });

  document.getElementById("locations-sort")?.addEventListener("change", (event) => {
    state.filters.sort = event.target.value;
    renderLocationsTable();
  });

  document.getElementById("locations-refresh")?.addEventListener("click", async () => {
    await loadLocationsData();
  });

  document.getElementById("locations-table-body")?.addEventListener("click", async (event) => {
    const trigger = event.target.closest("[data-open-location]");
    if (!trigger) return;
    await renderLocationDetail(trigger.getAttribute("data-open-location"));
  });

  document.getElementById("location-detail-close")?.addEventListener("click", () => {
    closeLocationDetail();
  });

  document.getElementById("location-detail-body")?.addEventListener("click", async (event) => {
    const copyButton = event.target.closest("[data-copy-location-code]");
    if (copyButton) {
      const code = copyButton.getAttribute("data-copy-location-code");
      if (code) {
        await navigator.clipboard?.writeText(code).catch(() => {});
      }
    }
  });

  document.getElementById("location-detail-body")?.addEventListener("submit", async (event) => {
    const form = event.target.closest("#location-edit-form");
    if (!form) return;
    event.preventDefault();
    await saveLocationEdits(form.dataset.locationId);
  });
}

document.addEventListener("DOMContentLoaded", async () => {
  try {
    await waitForSupabaseReady();
  } catch (error) {
    console.error("Supabase failed to initialize:", error);
    setListStatus("Supabase failed to initialize.", "error");
    return;
  }

  const allowed = await checkAuth();
  if (!allowed) return;

  setActiveNavLink();
  setupNavigation();
  bindEvents();

  const pill = document.getElementById("pill-date");
  if (pill) {
    const niceDate = new Date().toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "2-digit",
    });
    pill.innerHTML = `Date: <b>${niceDate}</b>`;
  }

  await loadLocationsData();
});
