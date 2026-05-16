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

let locationsAccess = { role: "", isAdmin: false, canUseLocations: false };

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

  const role = String(employee.role || "").toLowerCase();
  const canUseLocations = ["admin", "manager", "employee"].includes(role);
  locationsAccess = {
    role,
    isAdmin: role === "admin",
    canUseLocations,
  };
  window.locationsAccess = locationsAccess;
  if (!canUseLocations) {
    window.location.href = "worker-dashboard.html";
    return false;
  }

  document.body.classList.toggle("locations-worker-view", role !== "admin");

  const greeting = document.getElementById("admin-greeting");
  if (greeting) {
    const name = employee.display_name ? `, ${employee.display_name}` : "";
    greeting.textContent = role === "admin" ? `Welcome, Admin${name}` : `Welcome${name}`;
  }

  const subtitle = document.getElementById("header-subtitle");
  if (subtitle && role !== "admin") {
    subtitle.textContent = "Location, container, and tray creation tools";
  }

  document.querySelectorAll(".header-pills .pill").forEach((pill) => {
    if (pill.textContent.includes("Mode:")) {
      pill.innerHTML = `Mode: <b>${role === "admin" ? "Admin" : "Inventory"}</b>`;
    }
  });

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
  browser: {
    storeId: "",
    mode: "",
    parentId: "",
  },
  locationPhotoUrls: new Map(),
  itemPhotoUrls: new Map(),
  dymoUrls: new Map(),
};

const DEFAULT_LOCATION_TYPES = [
  "Table",
  "Vault",
  "Safe",
  "Shelf",
  "Case",
  "Bag",
  "Container",
  "Tray",
  "Bin",
];

const UNASSIGNED_STORE_BROWSER_ID = "__unassigned_store__";

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

function escapeLocationDymoXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatLocationDymoName(locationName, fallback = "LOCATION") {
  const text = asTrimmedString(locationName) || asTrimmedString(fallback) || "LOCATION";
  return text.toLocaleUpperCase("en-US");
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

function isTrayToleranceNotNullError(error) {
  return error?.code === "23502"
    && /tray_weight_tolerance_grams/i.test(error?.message || error?.details || "");
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

const TRAY_STATUS_LABELS = {
  checked_in: "Checked In",
  checked_out: "Checked Out",
  in_transfer: "In Transfer",
  weight_mismatch: "Weight Mismatch",
};

function getTrayStatusLabel(location) {
  return TRAY_STATUS_LABELS[location?.tray_status] || "Checked In";
}

function getStoreNameById(storeId) {
  const store = state.stores.find((entry) => entry.id === storeId);
  return store?.name || "";
}

function getTrayCurrentStoreLabel(location) {
  return asTrimmedString(location?.tray_current_store_name)
    || getStoreNameById(location?.tray_current_store_id)
    || getStoreLabel(location);
}

function getLocationRole(location) {
  if (location?.is_tray) return "tray";
  const role = asTrimmedString(location?.location_role);
  if (role) return role;
  return location?.parent_location_id ? "container" : "storage_location";
}

function getLocationRoleLabel(location) {
  const role = getLocationRole(location);
  if (role === "tray") return "Mobile Tray";
  if (role === "container") return "Bag / Container";
  return "Fixed Location";
}

function isContainerLocation(location) {
  return getLocationRole(location) === "container";
}

function getLocationPathLabel(location) {
  if (!location) return "Unassigned";
  const store = getStoreLabel(location);
  if (location.is_tray) {
    return `${getTrayCurrentStoreLabel(location)} > ${location.location_name || "Unnamed tray"}`;
  }
  if (isContainerLocation(location)) {
    const parent = asTrimmedString(location.parent_location_name) || "Unassigned parent";
    return `${store} > ${parent} > ${location.location_name || "Unnamed container"}`;
  }
  return `${store} > ${location.location_name || "Unnamed location"}`;
}

function getLocationBrowserStoreId(location) {
  if (!location) return "";
  if (location.is_tray) {
    return asTrimmedString(location.tray_current_store_id || location.store_id);
  }
  return asTrimmedString(location.store_id);
}

function toBrowserStoreKey(storeId) {
  return asTrimmedString(storeId) || UNASSIGNED_STORE_BROWSER_ID;
}

function fromBrowserStoreKey(storeKey) {
  return storeKey === UNASSIGNED_STORE_BROWSER_ID ? "" : asTrimmedString(storeKey);
}

function getLocationBrowserStoreName(storeId) {
  const resolvedStoreId = fromBrowserStoreKey(storeId);
  return resolvedStoreId ? (getStoreNameById(resolvedStoreId) || "Unknown Store") : "Unassigned";
}

function isTopLevelStorageLocation(location) {
  return !location?.is_tray && !isContainerLocation(location);
}

function locationMatchesSearch(location, searchTerm = state.filters.search.toLowerCase()) {
  if (!searchTerm) return true;

  return [
    location.location_name,
    location.location_code,
    location.notes,
    location.type,
    location.store_name,
    getTrayCurrentStoreLabel(location),
    location.parent_location_name,
    location.storage_path,
    getLocationRoleLabel(location),
  ].some((value) => asTrimmedString(value).toLowerCase().includes(searchTerm));
}

function locationMatchesTypeFilter(location) {
  const selectedType = asTrimmedString(state.filters.type).toLowerCase();
  if (!selectedType) return true;

  return asTrimmedString(location.type).toLowerCase() === selectedType
    || getLocationRoleLabel(location).toLowerCase() === selectedType;
}

function locationMatchesActiveFilter(location) {
  const isActive = location.active !== false;
  return !state.filters.active
    || (state.filters.active === "active" && isActive)
    || (state.filters.active === "inactive" && !isActive);
}

function locationMatchesBrowserFilters(location, { ignoreStore = false } = {}) {
  const matchesStore = ignoreStore
    || !state.filters.store
    || getLocationBrowserStoreId(location) === state.filters.store;

  return matchesStore
    && locationMatchesSearch(location)
    && locationMatchesTypeFilter(location)
    && locationMatchesActiveFilter(location);
}

function sortLocationsForBrowser(locations) {
  return [...locations].sort((a, b) => {
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
}

function getBrowserLocationsForStore(storeId) {
  const resolvedStoreId = fromBrowserStoreKey(storeId);
  return sortLocationsForBrowser(state.locations.filter((location) => {
    return getLocationBrowserStoreId(location) === resolvedStoreId
      && locationMatchesBrowserFilters(location, { ignoreStore: true });
  }));
}

function summarizeLocationGroup(locations) {
  return {
    total: locations.length,
    trays: locations.filter((location) => location.is_tray).length,
    topLocations: locations.filter((location) => isTopLevelStorageLocation(location)).length,
    containers: locations.filter((location) => isContainerLocation(location)).length,
    itemTypes: locations.reduce((sum, location) => sum + Number(location.distinctItemTypes || 0), 0),
    units: locations.reduce((sum, location) => sum + Number(location.totalQuantity || 0), 0),
  };
}

function getLocationBrowserStoreSummaries() {
  const searchTerm = state.filters.search.toLowerCase();
  const hasLocationFilters = Boolean(state.filters.type || state.filters.active);
  const storeNames = new Map();

  state.stores.forEach((store) => {
    storeNames.set(store.id, store.name || "Unknown Store");
  });

  state.locations.forEach((location) => {
    const storeId = toBrowserStoreKey(getLocationBrowserStoreId(location));
    if (!storeNames.has(storeId)) {
      storeNames.set(storeId, getLocationBrowserStoreName(storeId));
    }
  });

  return [...storeNames.entries()]
    .filter(([storeId, storeName]) => {
      if (state.filters.store && storeId !== state.filters.store) return false;
      const locations = getBrowserLocationsForStore(storeId);
      const storeMatchesSearch = searchTerm && asTrimmedString(storeName).toLowerCase().includes(searchTerm);
      return locations.length || storeMatchesSearch || (!searchTerm && !hasLocationFilters);
    })
    .map(([storeId, storeName]) => {
      const locations = getBrowserLocationsForStore(storeId);
      return {
        storeId,
        storeName,
        locations,
        summary: summarizeLocationGroup(locations),
      };
    })
    .sort((a, b) => a.storeName.localeCompare(b.storeName));
}

function getBrowserBreadcrumbMarkup(parts) {
  return `
    <div class="locations-browser-breadcrumb">
      ${parts.map((part, index) => {
        const isLast = index === parts.length - 1;
        if (!part.action || isLast) {
          return `<span class="${isLast ? "is-current" : ""}">${escapeHtml(part.label)}</span>`;
        }
        return `<button type="button" data-browser-back="${escapeHtml(part.action)}">${escapeHtml(part.label)}</button>`;
      }).join('<span class="locations-browser-separator">/</span>')}
    </div>
  `;
}

function getBrowserStatMarkup(label, value) {
  return `
    <div class="locations-browser-stat">
      <span>${escapeHtml(label)}</span>
      <strong>${escapeHtml(value)}</strong>
    </div>
  `;
}

function getParentLocationCandidates(currentLocationId = "") {
  return state.locations
    .filter((location) => {
      if (String(location.id) === String(currentLocationId)) return false;
      if (location.active === false) return false;
      return !location.is_tray && getLocationRole(location) !== "container";
    })
    .sort((a, b) => getLocationPathLabel(a).localeCompare(getLocationPathLabel(b)));
}

function buildParentLocationOptionsMarkup(selectedValue = "", currentLocationId = "") {
  return [`<option value="">No parent location</option>`]
    .concat(
      getParentLocationCandidates(currentLocationId).map((location) => {
        const selected = String(location.id) === String(selectedValue) ? ' selected' : "";
        return `<option value="${escapeHtml(location.id)}"${selected}>${escapeHtml(getLocationPathLabel(location))}</option>`;
      })
    )
    .join("");
}

function getLocationNameTemplates(currentLocationId = "", storeId = "") {
  const templates = new Map();
  const selectedStoreId = asTrimmedString(storeId);

  state.locations.forEach((location) => {
    if (String(location.id) === String(currentLocationId)) return;
    if (selectedStoreId && asTrimmedString(location.store_id) !== selectedStoreId) return;
    const name = asTrimmedString(location.location_name);
    const match = name.match(/^(.*?)(\d+)(.*)$/);
    if (!match) return;

    const prefix = match[1] || "";
    const suffix = match[3] || "";
    const number = Number(match[2]);
    if (!Number.isFinite(number)) return;

    const key = `${prefix}#${suffix}`.replace(/\s+/g, " ").trim().toLowerCase();
    const existing = templates.get(key) || {
      template: `${prefix}#${suffix}`.replace(/\s+/g, " ").trim(),
      prefix,
      suffix,
      maxNumber: 0,
    };
    existing.maxNumber = Math.max(existing.maxNumber, number);
    templates.set(key, existing);
  });

  return [...templates.values()]
    .map((entry) => ({
      template: entry.template,
      nextName: `${entry.prefix}${entry.maxNumber + 1}${entry.suffix}`.replace(/\s+/g, " ").trim(),
    }))
    .sort((a, b) => a.template.localeCompare(b.template));
}

function hideLocationNameSuggestions(container) {
  if (!container) return;
  container.classList.add("hidden");
  container.replaceChildren();
}

function renderLocationNameSuggestions(input, container, currentLocationId = "", storeId = "") {
  if (!input || !container) return;

  const term = asTrimmedString(input.value).toLowerCase();
  const termTemplate = term.replace(/\d+/g, "#");
  const suggestions = getLocationNameTemplates(currentLocationId, storeId)
    .filter((entry) => {
      if (!term) return true;
      return entry.template.toLowerCase().includes(term)
        || entry.template.toLowerCase().includes(termTemplate)
        || entry.nextName.toLowerCase().includes(term);
    })
    .slice(0, 8);

  if (!suggestions.length) {
    hideLocationNameSuggestions(container);
    return;
  }

  container.innerHTML = suggestions.map((entry) => `
    <button type="button" data-location-name-suggestion="${escapeHtml(entry.nextName)}">
      <strong>${escapeHtml(entry.template)}</strong>
      <span>${escapeHtml(entry.nextName)}</span>
    </button>
  `).join("");
  container.classList.remove("hidden");
}

function setupLocationNameSuggestions(input, container, currentLocationId = "", getStoreId = () => "") {
  if (!input || !container || input.dataset.nameSuggestionsBound === "true") return;
  input.dataset.nameSuggestionsBound = "true";

  input.addEventListener("focus", () => renderLocationNameSuggestions(input, container, currentLocationId, getStoreId()));
  input.addEventListener("input", () => renderLocationNameSuggestions(input, container, currentLocationId, getStoreId()));
  input.addEventListener("blur", () => {
    setTimeout(() => hideLocationNameSuggestions(container), 140);
  });

  container.addEventListener("mousedown", (event) => {
    const button = event.target.closest("[data-location-name-suggestion]");
    if (!button) return;
    event.preventDefault();
    input.value = button.getAttribute("data-location-name-suggestion") || "";
    hideLocationNameSuggestions(container);
    input.focus();
  });
}

function formatWeight(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number.toLocaleString(undefined, { maximumFractionDigits: 2 })} g`;
}

function calculateTrayEstimatedWeight(location) {
  return (location?.itemRows || []).reduce((sum, item) => {
    const unitWeight = Number(item.weight || 0);
    const quantity = Number(item.quantity || 0);
    return sum + (Number.isFinite(unitWeight) ? unitWeight * quantity : 0);
  }, 0);
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

async function bumpInventoryVersionForLocationChange() {
  const { error } = await supabase
    .from("metadata")
    .update({
      inventory_version: crypto.randomUUID(),
      changed_item_ids: null,
    })
    .eq("id", "inventory");

  if (error) {
    console.warn("Inventory cache version update failed:", error);
  }
}

function getCreateModalElements() {
  return {
    modal: document.getElementById("location-create-modal"),
    title: document.getElementById("location-create-title"),
    subtitle: document.getElementById("location-create-subtitle"),
    form: document.getElementById("location-create-form"),
    nameInput: document.getElementById("location-create-name"),
    storeSelect: document.getElementById("location-create-store"),
    typeInput: document.getElementById("location-create-type"),
    parentSelect: document.getElementById("location-create-parent"),
    capacityInput: document.getElementById("location-create-capacity"),
    capacityNoLimitInput: document.getElementById("location-create-capacity-no-limit"),
    barcodeInput: document.getElementById("location-create-barcode"),
    isTrayInput: document.getElementById("location-create-is-tray"),
    toleranceInput: document.getElementById("location-create-tray-tolerance"),
    toleranceNoLimitInput: document.getElementById("location-create-tray-tolerance-no-limit"),
    notesInput: document.getElementById("location-create-notes"),
    photoInput: document.getElementById("location-create-photo"),
    photoPreview: document.getElementById("location-create-photo-preview"),
    canvas: document.getElementById("location-create-barcode-canvas"),
    status: document.getElementById("location-create-status"),
    dymoStatus: document.getElementById("location-create-dymo-status"),
  };
}

function syncLimitInput(input, checkbox, fallbackValue = "") {
  if (!input || !checkbox) return;
  const unlimited = Boolean(checkbox.checked);
  input.disabled = unlimited;
  input.placeholder = unlimited ? "No limit" : "";
  if (unlimited) {
    input.value = "";
  } else if (!asTrimmedString(input.value) && fallbackValue !== "") {
    input.value = fallbackValue;
  }
}

function syncCreateLocationLimitControls() {
  const elements = getCreateModalElements();
  syncLimitInput(elements.capacityInput, elements.capacityNoLimitInput);
  syncLimitInput(elements.toleranceInput, elements.toleranceNoLimitInput, "10");
}

function syncEditLocationLimitControls() {
  syncLimitInput(
    document.getElementById("location-edit-capacity"),
    document.getElementById("location-edit-capacity-no-limit")
  );
  syncLimitInput(
    document.getElementById("location-edit-tray-tolerance"),
    document.getElementById("location-edit-tray-tolerance-no-limit"),
    "10"
  );
}

function buildLocationDymoXml(locationCode, locationName = "") {
  const safeLocationCode = escapeLocationDymoXml(locationCode);
  const safeLocationName = escapeLocationDymoXml(formatLocationDymoName(locationName, locationCode));

  return `<?xml version="1.0" encoding="utf-8"?>
<DesktopLabel Version="1">
  <DYMOLabel Version="4">
    <Description>DYMO Label</Description>
    <Orientation>Landscape</Orientation>
    <LabelName>Address</LabelName>
    <InitialLength>0</InitialLength>
    <BorderStyle>SolidLine</BorderStyle>
    <DYMORect>
      <DYMOPoint>
        <X>0.23</X>
        <Y>0.060000002</Y>
      </DYMOPoint>
      <Size>
        <Width>3.21</Width>
        <Height>0.9966666</Height>
      </Size>
    </DYMORect>
    <BorderColor>
      <SolidColorBrush>
        <Color A="1" R="0" G="0" B="0"></Color>
      </SolidColorBrush>
    </BorderColor>
    <BorderThickness>1</BorderThickness>
    <Show_Border>False</Show_Border>
    <HasFixedLength>False</HasFixedLength>
    <FixedLengthValue>0</FixedLengthValue>
    <DynamicLayoutManager>
      <RotationBehavior>ClearObjects</RotationBehavior>
      <LabelObjects>
        <BarcodeObject>
          <Name>BarcodeObject0</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="1" R="1" G="1" B="1"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <BarcodeFormat>Code128Auto</BarcodeFormat>
          <Data>
            <DataString>${safeLocationCode}</DataString>
          </Data>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <Size>AutoFit</Size>
          <TextPosition>Bottom</TextPosition>
          <FontInfo>
            <FontName>Arial</FontName>
            <FontSize>16</FontSize>
            <IsBold>False</IsBold>
            <IsItalic>False</IsItalic>
            <IsUnderline>False</IsUnderline>
            <FontBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FontBrush>
          </FontInfo>
          <ObjectLayout>
            <DYMOPoint>
              <X>0.34072876</X>
              <Y>0.1641666</Y>
            </DYMOPoint>
            <Size>
              <Width>2.8185425</Width>
              <Height>0.68583345</Height>
            </Size>
          </ObjectLayout>
        </BarcodeObject>
        <TextObject>
          <Name>TextObject0</Name>
          <Brushes>
            <BackgroundBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BackgroundBrush>
            <BorderBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </BorderBrush>
            <StrokeBrush>
              <SolidColorBrush>
                <Color A="1" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </StrokeBrush>
            <FillBrush>
              <SolidColorBrush>
                <Color A="0" R="0" G="0" B="0"></Color>
              </SolidColorBrush>
            </FillBrush>
          </Brushes>
          <Rotation>Rotation0</Rotation>
          <OutlineThickness>1</OutlineThickness>
          <IsOutlined>False</IsOutlined>
          <BorderStyle>SolidLine</BorderStyle>
          <Margin>
            <DYMOThickness Left="0" Top="0" Right="0" Bottom="0" />
          </Margin>
          <HorizontalAlignment>Center</HorizontalAlignment>
          <VerticalAlignment>Middle</VerticalAlignment>
          <FitMode>AlwaysFit</FitMode>
          <IsVertical>False</IsVertical>
          <FormattedText>
            <FitMode>AlwaysFit</FitMode>
            <HorizontalAlignment>Center</HorizontalAlignment>
            <VerticalAlignment>Middle</VerticalAlignment>
            <IsVertical>False</IsVertical>
            <LineTextSpan>
              <TextSpan>
                <Text>${safeLocationName}</Text>
                <FontInfo>
                  <FontName>Segoe UI</FontName>
                  <FontSize>14.5</FontSize>
                  <IsBold>False</IsBold>
                  <IsItalic>False</IsItalic>
                  <IsUnderline>False</IsUnderline>
                  <FontBrush>
                    <SolidColorBrush>
                      <Color A="1" R="0" G="0" B="0"></Color>
                    </SolidColorBrush>
                  </FontBrush>
                </FontInfo>
              </TextSpan>
            </LineTextSpan>
          </FormattedText>
          <ObjectLayout>
            <DYMOPoint>
              <X>0.9475001</X>
              <Y>0.7875004</Y>
            </DYMOPoint>
            <Size>
              <Width>1.6050003</Width>
              <Height>0.2691668</Height>
            </Size>
          </ObjectLayout>
        </TextObject>
      </LabelObjects>
    </DynamicLayoutManager>
  </DYMOLabel>
  <LabelApplication>Blank</LabelApplication>
  <DataTable>
    <Columns></Columns>
    <Rows></Rows>
  </DataTable>
</DesktopLabel>`;
}

function generateCreateLocationBarcode() {
  const elements = getCreateModalElements();
  if (!elements.barcodeInput || !elements.canvas) return "";

  const code = `LOC-${Date.now().toString().slice(-8)}`;
  elements.barcodeInput.value = code;

  if (typeof JsBarcode !== "undefined") {
    JsBarcode(elements.canvas, code, {
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

  if (elements.dymoStatus) {
    elements.dymoStatus.textContent = "DYMO label ready to save";
  }

  return code;
}

function populateCreateLocationStoreSelect(selectedStoreId = "") {
  const { storeSelect } = getCreateModalElements();
  if (!storeSelect) return;

  storeSelect.innerHTML = buildStoreOptionsMarkup(selectedStoreId, "Select store");
  storeSelect.value = selectedStoreId || "";
}

function populateCreateParentLocationSelect(selectedParentId = "") {
  const { parentSelect } = getCreateModalElements();
  if (!parentSelect) return;

  parentSelect.innerHTML = buildParentLocationOptionsMarkup(selectedParentId);
  parentSelect.value = selectedParentId || "";
}

function syncCreateContainerStoreFromParent() {
  const elements = getCreateModalElements();
  const parentId = asTrimmedString(elements.parentSelect?.value);
  const parentLocation = state.locations.find((location) => String(location.id) === String(parentId));
  if (parentLocation?.store_id && elements.storeSelect) {
    elements.storeSelect.value = parentLocation.store_id;
  }
}

function getNextTrayName() {
  const highestTrayNumber = (Array.isArray(state.locations) ? state.locations : []).reduce((highest, location) => {
    const name = asTrimmedString(location.location_name);
    const match = name.match(/^tray\s*#?\s*0*(\d+)$/i);
    if (!match) return highest;

    const trayNumber = Number(match[1]);
    return Number.isFinite(trayNumber) ? Math.max(highest, trayNumber) : highest;
  }, 0);

  return `Tray ${highestTrayNumber + 1}`;
}

function closeCreateLocationModal() {
  const elements = getCreateModalElements();
  elements.modal?.classList.add("hidden");
  elements.modal?.setAttribute("aria-hidden", "true");
  elements.form?.reset();
  if (elements.parentSelect) elements.parentSelect.innerHTML = "";
  hideLocationNameSuggestions(document.getElementById("location-create-name-suggestions"));
  if (elements.capacityNoLimitInput) elements.capacityNoLimitInput.checked = true;
  if (elements.toleranceNoLimitInput) elements.toleranceNoLimitInput.checked = true;
  syncCreateLocationLimitControls();
  if (elements.photoPreview) elements.photoPreview.textContent = "No photo selected.";
  if (elements.status) elements.status.textContent = "";
  if (elements.dymoStatus) elements.dymoStatus.textContent = "DYMO label will be created on save";
}

function openCreateLocationModal({ tray = false, container = false } = {}) {
  const elements = getCreateModalElements();
  if (!elements.modal) return;
  const createTray = Boolean(tray);
  const createContainer = !createTray && Boolean(container);

  elements.form?.reset();
  populateCreateLocationStoreSelect();
  populateCreateParentLocationSelect();
  elements.modal.classList.remove("hidden");
  elements.modal.setAttribute("aria-hidden", "false");
  if (elements.title) {
    elements.title.textContent = createTray ? "Create Tray" : createContainer ? "Create Container" : "Create Location";
  }
  if (elements.subtitle) {
    elements.subtitle.textContent = createTray
      ? "Create a barcode-ready mobile tray that can be checked in and out."
      : createContainer
        ? "Create a barcode-ready bag or container nested inside a table, vault, shelf, or safe."
        : "Create a barcode-ready fixed table, vault, shelf, case, or safe.";
  }
  if (elements.typeInput) elements.typeInput.value = createTray ? "tray" : createContainer ? "container" : "";
  if (createTray && elements.nameInput) {
    elements.nameInput.value = getNextTrayName();
  }
  if (createContainer && elements.parentSelect) {
    elements.parentSelect.required = true;
  } else if (elements.parentSelect) {
    elements.parentSelect.required = false;
  }
  if (elements.isTrayInput) {
    elements.isTrayInput.checked = createTray;
    elements.isTrayInput.disabled = false;
  }
  if (elements.capacityNoLimitInput) elements.capacityNoLimitInput.checked = true;
  if (elements.toleranceNoLimitInput) elements.toleranceNoLimitInput.checked = true;
  syncCreateLocationLimitControls();
  if (elements.photoPreview) elements.photoPreview.textContent = "No photo selected.";
  if (elements.status) elements.status.textContent = "";
  generateCreateLocationBarcode();
  setupLocationNameSuggestions(
    elements.nameInput,
    document.getElementById("location-create-name-suggestions"),
    "",
    () => elements.storeSelect?.value || ""
  );
  renderLocationNameSuggestions(
    elements.nameInput,
    document.getElementById("location-create-name-suggestions"),
    "",
    elements.storeSelect?.value || ""
  );
  if (createContainer && elements.parentSelect) {
    elements.parentSelect.focus();
  } else {
    elements.nameInput?.focus();
  }
}

async function uploadCreateLocationDymo(locationCode, locationName = "") {
  const xml = buildLocationDymoXml(locationCode, locationName);
  const labelPath = `labels/location_${Date.now()}.dymo`;
  const blob = new Blob([xml], { type: "application/octet-stream" });
  const { error } = await supabase.storage
    .from("dymo-labels")
    .upload(labelPath, blob, { upsert: true });

  if (error) throw error;
  return labelPath;
}

function setLocationDymoStatus(message) {
  const status = document.getElementById("location-dymo-status");
  if (status) status.textContent = message;
}

async function regenerateLocationDymoLabel(locationId) {
  const location = state.locations.find((entry) => String(entry.id) === String(locationId));
  if (!location) throw new Error("Location not found.");

  const locationCode = asTrimmedString(location.location_code);
  if (!locationCode) throw new Error("This location does not have a barcode yet.");

  setLocationDymoStatus("Generating a fresh LocationLabelSystem DYMO label...");

  const previousPath = location.dymo_label_url || "";
  const labelPath = await uploadCreateLocationDymo(locationCode, location.location_name);

  const { error } = await supabase
    .from("locations")
    .update({ dymo_label_url: labelPath })
    .eq("id", location.id);

  if (error) throw error;

  if (previousPath) state.dymoUrls.delete(previousPath);
  state.dymoUrls.delete(labelPath);
  location.dymo_label_url = labelPath;

  const signedUrl = await resolveDymoUrl(location);
  if (!signedUrl) throw new Error("The new label was saved, but could not be opened.");

  setLocationDymoStatus("New DYMO label generated and saved to this location.");
  renderLocationsTable();
  return signedUrl;
}

async function uploadCreateLocationPhoto(file) {
  if (!file) return null;
  const safeName = file.name.replace(/[^\w.\-]+/g, "_");
  const path = `photos/${Date.now()}_${safeName}`;
  const { data, error } = await supabase.storage
    .from("location-assets")
    .upload(path, file, { upsert: true });

  if (error) throw error;
  return data?.path || path;
}

async function saveCreatedLocation() {
  const elements = getCreateModalElements();
  const locationName = asTrimmedString(elements.nameInput?.value);
  const storeId = asTrimmedString(elements.storeSelect?.value);
  const type = asTrimmedString(elements.typeInput?.value);
  const parentLocationId = asTrimmedString(elements.parentSelect?.value);
  const capacityValue = asTrimmedString(elements.capacityInput?.value);
  const capacityHasNoLimit = Boolean(elements.capacityNoLimitInput?.checked);
  const locationCode = asTrimmedString(elements.barcodeInput?.value);
  const isTray = Boolean(elements.isTrayInput?.checked);
  const isContainer = !isTray && Boolean(parentLocationId);
  const parentLocation = parentLocationId
    ? state.locations.find((location) => String(location.id) === String(parentLocationId))
    : null;
  const toleranceValue = asTrimmedString(elements.toleranceInput?.value);
  const toleranceHasNoLimit = Boolean(elements.toleranceNoLimitInput?.checked);
  const notes = asTrimmedString(elements.notesInput?.value);
  const photoFile = elements.photoInput?.files?.[0] || null;

  if (!locationName || !locationCode) {
    if (elements.status) elements.status.textContent = "Name and barcode are required.";
    return;
  }

  if (isContainer && !parentLocation) {
    if (elements.status) elements.status.textContent = "Choose the table, vault, shelf, or safe that holds this container.";
    return;
  }

  if (state.stores.length > 0 && !storeId && !parentLocation?.store_id) {
    if (elements.status) elements.status.textContent = "Choose the store for this location.";
    return;
  }

  if (elements.status) elements.status.textContent = "Creating location and label...";

  try {
    const [dymoPath, photoPath] = await Promise.all([
      uploadCreateLocationDymo(locationCode, locationName),
      uploadCreateLocationPhoto(photoFile),
    ]);

    const payload = {
      location_name: locationName,
      location_code: locationCode,
      dymo_label_url: dymoPath,
      photo_url: photoPath,
      type: type || (isTray ? "tray" : isContainer ? "container" : null),
      location_role: isTray ? "tray" : isContainer ? "container" : "storage_location",
      parent_location_id: isContainer ? parentLocationId : null,
      container_kind: isContainer ? (type || "container") : null,
      max_capacity: capacityHasNoLimit || !capacityValue ? null : Number(capacityValue),
      active: true,
      notes: notes || null,
      store_id: storeId || parentLocation?.store_id || null,
      is_tray: isTray,
      tray_weight_tolerance_grams: toleranceHasNoLimit || !toleranceValue ? null : Number(toleranceValue),
      tray_current_store_id: isTray ? (storeId || null) : null,
    };

    let { data, error } = await supabase
      .from("locations")
      .insert(payload)
      .select("id")
      .single();

    if (error && !isTray && isTrayToleranceNotNullError(error)) {
      ({ data, error } = await supabase
        .from("locations")
        .insert({ ...payload, tray_weight_tolerance_grams: 10 })
        .select("id")
        .single());
    }

    if (error || !data) throw error || new Error("Location was not returned after saving.");

    if (elements.status) elements.status.textContent = "Location created.";
    closeCreateLocationModal();
    await loadLocationsData();
    await renderLocationDetail(data.id);
  } catch (error) {
    console.error("Create location failed:", error);
    if (elements.status) {
      elements.status.textContent = `Could not create location: ${error?.message || "Unknown error"}`;
    }
  }
}

function normalizeLocationsData(locations, stockRows, itemTypes, stores) {
  const itemMap = new Map((itemTypes || []).map((item) => [item.id, item]));
  const stockByLocation = new Map();
  const storeMap = new Map((stores || []).map((store) => [store.id, store]));
  const rawLocationMap = new Map((locations || []).map((location) => [location.id, location]));

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
          weight: Number(item?.weight || 0),
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

    const parentLocation = rawLocationMap.get(location.parent_location_id) || null;
    const effectiveStoreId = location.store_id || parentLocation?.store_id || "";
    const effectiveStoreName = storeMap.get(effectiveStoreId)?.name || "";
    const normalized = {
      ...location,
      location_role: getLocationRole(location),
      store_id: effectiveStoreId || location.store_id || "",
      store_name: effectiveStoreName || storeMap.get(location.store_id)?.name || "",
      tray_current_store_name: storeMap.get(location.tray_current_store_id)?.name || "",
      parent_location_name: parentLocation?.location_name || "",
      parent_location_code: parentLocation?.location_code || "",
      parent_location_type: parentLocation?.type || "",
      parent_store_id: parentLocation?.store_id || "",
      parent_store_name: parentLocation?.store_id ? storeMap.get(parentLocation.store_id)?.name || "" : "",
      itemRows,
      distinctItemTypes: itemRows.length,
      totalQuantity,
      recentActivityAt,
      notesPreview: asTrimmedString(location.notes).slice(0, 120),
    };
    normalized.storage_path = getLocationPathLabel(normalized);
    return normalized;
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
    supabase.from("item_types").select("id, title, barcode, photos, weight"),
  ]);

  if (locationsError || storesError || stockError || itemTypesError) {
    console.error("Failed to load locations data:", locationsError || storesError || stockError || itemTypesError);
    setListStatus("Could not load locations data.", "error");
    return;
  }

  state.stores = Array.isArray(stores) ? stores : [];
  state.locations = normalizeLocationsData(locations, stockRows, itemTypes, state.stores);
  populateStoreFilter();
  populateLocationTypeDatalist();
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

function getLocationTypeOptions() {
  const options = new Map();
  DEFAULT_LOCATION_TYPES.forEach((type) => options.set(type.toLowerCase(), type));
  state.locations.forEach((location) => {
    const type = asTrimmedString(location.type);
    if (type) options.set(type.toLowerCase(), type);
  });
  return [...options.values()].sort((a, b) => a.localeCompare(b));
}

function populateLocationTypeDatalist() {
  const list = document.getElementById("location-type-options");
  if (!list) return;

  list.innerHTML = getLocationTypeOptions()
    .map((type) => `<option value="${escapeHtml(type)}"></option>`)
    .join("");
}

function populateTypeFilter() {
  const typeFilter = document.getElementById("locations-type-filter");
  if (!typeFilter) return;

  const currentValue = state.filters.type;
  const types = getLocationTypeOptions();

  typeFilter.innerHTML = ['<option value="">All types</option>']
    .concat(types.map((type) => `<option value="${escapeHtml(type)}">${escapeHtml(type)}</option>`))
    .join("");

  typeFilter.value = currentValue;
}

function getFilteredLocations() {
  return sortLocationsForBrowser(state.locations.filter((location) => locationMatchesBrowserFilters(location)));
}

function renderSummaryCards() {
  const container = document.getElementById("locations-metric-cards");
  if (!container) return;

  const totalLocations = state.locations.length;
  const activeLocations = state.locations.filter((location) => location.active !== false).length;
  const totalStockUnits = state.locations.reduce((sum, location) => sum + Number(location.totalQuantity || 0), 0);
  const trayLocations = state.locations.filter((location) => location.is_tray);
  const containerLocations = state.locations.filter((location) => isContainerLocation(location));
  const trayAlerts = trayLocations.filter((location) => ["checked_out", "in_transfer", "weight_mismatch"].includes(location.tray_status)).length;
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

    <div class="metric-card ${trayAlerts ? "is-tray-alert" : ""}">
      <div class="metric-top">
        <div class="metric-label">Mobile Trays</div>
        <div class="metric-icon">Tray</div>
      </div>
      <div class="metric-value">${trayLocations.length.toLocaleString()}</div>
      <div class="metric-foot">${trayAlerts.toLocaleString()} tray(s) checked out, in transfer, or weight flagged</div>
    </div>

    <div class="metric-card">
      <div class="metric-top">
        <div class="metric-label">Bags / Containers</div>
        <div class="metric-icon">Box</div>
      </div>
      <div class="metric-value">${containerLocations.length.toLocaleString()}</div>
      <div class="metric-foot">Nested storage units inside tables, vaults, shelves, or safes</div>
    </div>
  `;
}

function renderBrowserHeader({ title, subtitle, breadcrumb, actions = "" }) {
  return `
    <div class="locations-browser-head">
      <div>
        ${breadcrumb || ""}
        <h4>${escapeHtml(title)}</h4>
        <p>${escapeHtml(subtitle)}</p>
      </div>
      ${actions ? `<div class="locations-browser-actions">${actions}</div>` : ""}
    </div>
  `;
}

function renderBrowserEmpty(message) {
  return `<div class="locations-browser-empty">${escapeHtml(message)}</div>`;
}

function renderLocationContentsPreview(location) {
  const rows = Array.isArray(location.itemRows) ? location.itemRows.slice(0, 3) : [];
  if (!rows.length) {
    return `<div class="locations-browser-contents-empty">No stock recorded here yet.</div>`;
  }

  return `
    <div class="locations-browser-contents">
      ${rows.map((item) => `
        <div class="locations-browser-content-row">
          <div>
            <strong>${escapeHtml(item.title || "Untitled Item")}</strong>
            <span>${escapeHtml(item.barcode || "No barcode")}</span>
          </div>
          <b>Qty ${Number(item.quantity || 0).toLocaleString()}</b>
        </div>
      `).join("")}
      ${location.itemRows.length > rows.length ? `
        <div class="locations-browser-more">${Number(location.itemRows.length - rows.length).toLocaleString()} more item type(s)</div>
      ` : ""}
    </div>
  `;
}

function renderLocationBrowserCard(location, { showContainersAction = false, containerCount = 0 } = {}) {
  const roleClass = location.is_tray
    ? "is-tray"
    : isContainerLocation(location)
      ? "is-container"
      : "is-location";
  const estimatedWeight = location.is_tray ? calculateTrayEstimatedWeight(location) : null;

  return `
    <article class="locations-browser-card ${roleClass}">
      <div class="locations-browser-card-top">
        <div>
          <div class="locations-browser-kicker">${escapeHtml(getLocationRoleLabel(location))}</div>
          <h5>${escapeHtml(location.location_name || "Unnamed Location")}</h5>
          <p>${escapeHtml(location.storage_path || getLocationPathLabel(location))}</p>
        </div>
        <span class="locations-browser-code">${escapeHtml(location.location_code || "No barcode")}</span>
      </div>

      <div class="locations-browser-pill-row">
        <span class="locations-pill ${location.active === false ? "is-inactive" : "is-active"}">
          ${location.active === false ? "Inactive" : "Active"}
        </span>
        ${location.type ? `<span class="locations-pill is-type">${escapeHtml(location.type)}</span>` : ""}
        ${location.is_tray ? `
          <span class="locations-pill is-tray-status ${location.tray_status === "weight_mismatch" ? "is-tray-alert" : ""}">
            ${escapeHtml(getTrayStatusLabel(location))}
          </span>
        ` : ""}
      </div>

      <div class="locations-browser-stats">
        ${getBrowserStatMarkup("Items", Number(location.distinctItemTypes || 0).toLocaleString())}
        ${getBrowserStatMarkup("Qty", Number(location.totalQuantity || 0).toLocaleString())}
        ${showContainersAction ? getBrowserStatMarkup("Containers", Number(containerCount || 0).toLocaleString()) : ""}
        ${location.is_tray ? getBrowserStatMarkup("Est. Weight", formatWeight(estimatedWeight)) : ""}
        ${getBrowserStatMarkup("Updated", formatDateTime(getLocationDisplayDate(location)))}
      </div>

      ${renderLocationContentsPreview(location)}

      <div class="locations-browser-card-actions">
        ${showContainersAction ? `
          <button type="button" class="locations-action-button is-primary" data-browser-parent-id="${escapeHtml(location.id)}">
            View Containers
          </button>
        ` : ""}
        <button type="button" class="locations-action-button" data-open-location="${escapeHtml(location.id)}">
          View / Edit
        </button>
      </div>
    </article>
  `;
}

function renderStoresBrowser(container, summaries) {
  if (!summaries.length) {
    setListStatus("No stores match the current filters.");
    container.innerHTML = renderBrowserEmpty("No stores match the current filters.");
    return;
  }

  setListStatus(`${summaries.length} store(s) shown. Choose a store to browse trays or storage locations.`);

  container.innerHTML = `
    ${renderBrowserHeader({
      title: "Browse by Store",
      subtitle: "Start with a store, then choose mobile trays or fixed storage locations.",
      breadcrumb: getBrowserBreadcrumbMarkup([{ label: "Stores" }]),
    })}
    <div class="locations-browser-grid is-stores">
      ${summaries.map(({ storeId, storeName, summary }) => `
        <article class="locations-browser-card is-store">
          <div class="locations-browser-card-top">
            <div>
              <div class="locations-browser-kicker">Store</div>
              <h5>${escapeHtml(storeName)}</h5>
              <p>${Number(summary.total || 0).toLocaleString()} storage destination(s)</p>
            </div>
          </div>
          <div class="locations-browser-stats">
            ${getBrowserStatMarkup("Locations", Number(summary.topLocations || 0).toLocaleString())}
            ${getBrowserStatMarkup("Trays", Number(summary.trays || 0).toLocaleString())}
            ${getBrowserStatMarkup("Containers", Number(summary.containers || 0).toLocaleString())}
            ${getBrowserStatMarkup("Units", Number(summary.units || 0).toLocaleString())}
          </div>
          <div class="locations-browser-card-actions">
            <button type="button" class="locations-action-button is-primary" data-browser-store-id="${escapeHtml(storeId)}">
              Open Store
            </button>
          </div>
        </article>
      `).join("")}
    </div>
  `;
}

function renderStoreChoiceBrowser(container, storeId) {
  const storeName = getLocationBrowserStoreName(storeId);
  const locations = getBrowserLocationsForStore(storeId);
  const summary = summarizeLocationGroup(locations);

  setListStatus(`${storeName}: choose trays or parent locations.`);

  container.innerHTML = `
    ${renderBrowserHeader({
      title: storeName,
      subtitle: "Choose whether you want working trays or the fixed storage hierarchy.",
      breadcrumb: getBrowserBreadcrumbMarkup([
        { label: "Stores", action: "stores" },
        { label: storeName },
      ]),
      actions: `<button type="button" class="locations-action-button" data-browser-back="stores">All Stores</button>`,
    })}
    <div class="locations-browser-grid is-modes">
      <article class="locations-browser-card is-mode">
        <div class="locations-browser-card-top">
          <div>
            <div class="locations-browser-kicker">Working inventory</div>
            <h5>Trays</h5>
            <p>Mobile trays currently assigned to this store.</p>
          </div>
        </div>
        <div class="locations-browser-stats">
          ${getBrowserStatMarkup("Trays", Number(summary.trays || 0).toLocaleString())}
          ${getBrowserStatMarkup("Units", Number(locations.filter((location) => location.is_tray).reduce((sum, location) => sum + Number(location.totalQuantity || 0), 0)).toLocaleString())}
        </div>
        <div class="locations-browser-card-actions">
          <button type="button" class="locations-action-button is-primary" data-browser-mode="trays">View Trays</button>
        </div>
      </article>

      <article class="locations-browser-card is-mode">
        <div class="locations-browser-card-top">
          <div>
            <div class="locations-browser-kicker">Storage hierarchy</div>
            <h5>Locations</h5>
            <p>Tables, vaults, safes, shelves, and their nested containers.</p>
          </div>
        </div>
        <div class="locations-browser-stats">
          ${getBrowserStatMarkup("Parent Locations", Number(summary.topLocations || 0).toLocaleString())}
          ${getBrowserStatMarkup("Containers", Number(summary.containers || 0).toLocaleString())}
          ${getBrowserStatMarkup("Units", Number(locations.filter((location) => !location.is_tray).reduce((sum, location) => sum + Number(location.totalQuantity || 0), 0)).toLocaleString())}
        </div>
        <div class="locations-browser-card-actions">
          <button type="button" class="locations-action-button is-primary" data-browser-mode="locations">View Locations</button>
        </div>
      </article>
    </div>
  `;
}

function renderTrayBrowser(container, storeId) {
  const storeName = getLocationBrowserStoreName(storeId);
  const trays = getBrowserLocationsForStore(storeId).filter((location) => location.is_tray);

  setListStatus(`${trays.length} tray(s) shown for ${storeName}.`);

  container.innerHTML = `
    ${renderBrowserHeader({
      title: `${storeName} Trays`,
      subtitle: "Mobile trays currently checked in or assigned to this store.",
      breadcrumb: getBrowserBreadcrumbMarkup([
        { label: "Stores", action: "stores" },
        { label: storeName, action: "store" },
        { label: "Trays" },
      ]),
      actions: `<button type="button" class="locations-action-button" data-browser-back="store">Back</button>`,
    })}
    ${trays.length ? `
      <div class="locations-browser-grid is-locations">
        ${trays.map((location) => renderLocationBrowserCard(location)).join("")}
      </div>
    ` : renderBrowserEmpty("No trays match the current filters in this store.")}
  `;
}

function renderParentLocationsBrowser(container, storeId) {
  const storeName = getLocationBrowserStoreName(storeId);
  const resolvedStoreId = fromBrowserStoreKey(storeId);
  const storeLocations = getBrowserLocationsForStore(storeId);
  const allContainers = storeLocations.filter((location) => isContainerLocation(location));
  const parents = sortLocationsForBrowser(state.locations.filter((location) => {
    if (getLocationBrowserStoreId(location) !== resolvedStoreId || !isTopLevelStorageLocation(location)) return false;
    const matchingContainers = allContainers.filter((containerLocation) => {
      return String(containerLocation.parent_location_id || "") === String(location.id);
    });
    return locationMatchesBrowserFilters(location, { ignoreStore: true }) || matchingContainers.length;
  }));

  setListStatus(`${parents.length} parent location(s) shown for ${storeName}.`);

  container.innerHTML = `
    ${renderBrowserHeader({
      title: `${storeName} Locations`,
      subtitle: "Open a parent location to see the bags and containers inside it.",
      breadcrumb: getBrowserBreadcrumbMarkup([
        { label: "Stores", action: "stores" },
        { label: storeName, action: "store" },
        { label: "Locations" },
      ]),
      actions: `<button type="button" class="locations-action-button" data-browser-back="store">Back</button>`,
    })}
    ${parents.length ? `
      <div class="locations-browser-grid is-locations">
        ${parents.map((location) => {
          const containerCount = allContainers.filter((containerLocation) => String(containerLocation.parent_location_id || "") === String(location.id)).length;
          return renderLocationBrowserCard(location, { showContainersAction: true, containerCount });
        }).join("")}
      </div>
    ` : renderBrowserEmpty("No parent locations match the current filters in this store.")}
  `;
}

function renderContainersBrowser(container, storeId, parentId) {
  const storeName = getLocationBrowserStoreName(storeId);
  const parent = state.locations.find((location) => String(location.id) === String(parentId));

  if (!parent) {
    state.browser.parentId = "";
    renderParentLocationsBrowser(container, storeId);
    return;
  }

  const containers = getBrowserLocationsForStore(storeId).filter((location) => {
    return isContainerLocation(location) && String(location.parent_location_id || "") === String(parentId);
  });

  setListStatus(`${containers.length} container(s) shown inside ${parent.location_name || "this location"}.`);

  container.innerHTML = `
    ${renderBrowserHeader({
      title: parent.location_name || "Parent Location",
      subtitle: "Containers nested inside this storage location.",
      breadcrumb: getBrowserBreadcrumbMarkup([
        { label: "Stores", action: "stores" },
        { label: storeName, action: "store" },
        { label: "Locations", action: "locations" },
        { label: parent.location_name || "Parent Location" },
      ]),
      actions: `
        <button type="button" class="locations-action-button" data-open-location="${escapeHtml(parent.id)}">View Parent</button>
        <button type="button" class="locations-action-button" data-browser-back="locations">Back</button>
      `,
    })}
    <article class="locations-browser-parent-summary">
      ${renderLocationBrowserCard(parent)}
    </article>
    ${containers.length ? `
      <div class="locations-browser-grid is-locations">
        ${containers.map((location) => renderLocationBrowserCard(location)).join("")}
      </div>
    ` : renderBrowserEmpty("No containers match the current filters inside this location.")}
  `;
}

function renderLocationsTable() {
  const browser = document.getElementById("locations-browser");
  if (!browser) return;

  if (state.filters.store && state.browser.storeId !== state.filters.store) {
    state.browser.storeId = state.filters.store;
    state.browser.mode = "";
    state.browser.parentId = "";
  }

  const storeSummaries = getLocationBrowserStoreSummaries();
  const resolvedSelectedStoreId = fromBrowserStoreKey(state.browser.storeId);
  const selectedStoreExists = !state.browser.storeId
    || storeSummaries.some((summary) => summary.storeId === state.browser.storeId)
    || state.locations.some((location) => getLocationBrowserStoreId(location) === resolvedSelectedStoreId);

  if (!selectedStoreExists) {
    state.browser.storeId = "";
    state.browser.mode = "";
    state.browser.parentId = "";
  }

  if (!state.browser.storeId) {
    renderStoresBrowser(browser, storeSummaries);
    return;
  }

  if (!state.browser.mode) {
    renderStoreChoiceBrowser(browser, state.browser.storeId);
    return;
  }

  if (state.browser.mode === "trays") {
    renderTrayBrowser(browser, state.browser.storeId);
    return;
  }

  if (state.browser.parentId) {
    renderContainersBrowser(browser, state.browser.storeId, state.browser.parentId);
    return;
  }

  renderParentLocationsBrowser(browser, state.browser.storeId);
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

  if (location.is_tray) {
    subtitle.textContent = `${subtitle.textContent} - ${getTrayStatusLabel(location)}`;
  }

  const [photoUrl, itemPhotoUrls] = await Promise.all([
    resolveLocationPhotoUrl(location),
    Promise.all(location.itemRows.map((item) => resolveItemPhotoUrl(item.photoPath))),
  ]);

  let trayMovements = [];
  if (location.is_tray) {
    const { data: movements, error: movementError } = await supabase
      .from("tray_movements")
      .select("*")
      .eq("tray_location_id", location.id)
      .order("created_at", { ascending: false })
      .limit(8);

    if (movementError) {
      console.warn("Tray movement history unavailable:", movementError);
    } else {
      trayMovements = movements || [];
    }
  }

  const estimatedTrayWeight = calculateTrayEstimatedWeight(location);
  const trayStoreOptions = buildStoreOptionsMarkup(asTrimmedString(location.tray_current_store_id || location.store_id), "Select store");
  const movementHistoryMarkup = trayMovements.length
    ? trayMovements.map((movement) => `
      <div class="tray-movement-row">
        <div>
          <strong>${movement.action === "check_in" ? "Checked in" : "Checked out"}</strong>
          <span>${escapeHtml(formatDateTime(movement.created_at))} by ${escapeHtml(movement.performed_by_email || "staff")}</span>
        </div>
        <div>
          <strong>${formatWeight(movement.actual_weight_grams)}</strong>
          <span>${movement.weight_delta_grams === null || movement.weight_delta_grams === undefined ? "Baseline" : `Delta ${formatWeight(movement.weight_delta_grams)}`}</span>
        </div>
        <span class="locations-pill ${movement.result === "mismatch" ? "is-tray-alert" : "is-active"}">${movement.result === "mismatch" ? "Mismatch" : "OK"}</span>
      </div>
    `).join("")
    : `<div class="location-detail-empty">No tray movements have been recorded yet.</div>`;
  const trayMarkup = location.is_tray ? `
    <section class="location-detail-card tray-control-card ${location.tray_status === "weight_mismatch" ? "has-tray-alert" : ""}">
      <div class="location-detail-card-head">
        <div>
          <h4 class="location-detail-card-title">Mobile Tray Control</h4>
          <div class="location-status-line">Record checkout and check-in weights against this tray barcode.</div>
        </div>
        <span class="locations-pill is-tray-status ${location.tray_status === "weight_mismatch" ? "is-tray-alert" : ""}">
          ${escapeHtml(getTrayStatusLabel(location))}
        </span>
      </div>

      <div class="location-detail-meta-grid tray-meta-grid">
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Home Store</div>
          <div class="location-detail-stat-value">${escapeHtml(getStoreLabel(location))}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Current Store</div>
          <div class="location-detail-stat-value">${escapeHtml(getTrayCurrentStoreLabel(location))}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Tolerance</div>
          <div class="location-detail-stat-value">${location.tray_weight_tolerance_grams === null || location.tray_weight_tolerance_grams === undefined ? "No limit" : formatWeight(location.tray_weight_tolerance_grams)}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Estimated Contents</div>
          <div class="location-detail-stat-value">${formatWeight(estimatedTrayWeight)}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Checkout Weight</div>
          <div class="location-detail-stat-value">${formatWeight(location.tray_last_checkout_weight)}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Last Delta</div>
          <div class="location-detail-stat-value">${formatWeight(location.tray_last_weight_delta)}</div>
        </div>
      </div>

      <form id="tray-movement-form" data-location-id="${escapeHtml(location.id)}" class="tray-movement-form">
        <label class="location-edit-label">
          <span>Movement</span>
          <select id="tray-movement-action" class="location-edit-select">
            <option value="check_out">Check Out Tray</option>
            <option value="check_in">Check In Tray</option>
          </select>
        </label>

        <label class="location-edit-label">
          <span>Store</span>
          <select id="tray-movement-store" class="location-edit-select">
            ${trayStoreOptions}
          </select>
        </label>

        <label class="location-edit-label">
          <span>Actual Weight (g)</span>
          <input type="number" id="tray-movement-weight" class="location-edit-input" step="0.01" min="0" placeholder="Tray weight on scale" />
        </label>

        <label class="location-edit-label full">
          <span>Notes</span>
          <textarea id="tray-movement-notes" class="location-edit-textarea" placeholder="Optional note for the movement log"></textarea>
        </label>

        <div class="tray-movement-actions">
          <button type="submit" class="locations-action-button">Record Tray Movement</button>
          <div id="tray-movement-status" class="location-status-line"></div>
        </div>
      </form>

      <div class="tray-movement-history">
        <div class="location-detail-card-title">Recent Tray Movements</div>
        ${movementHistoryMarkup}
      </div>
    </section>
  ` : "";

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
          <div class="location-detail-stat-label">Storage Role</div>
          <div class="location-detail-stat-value">${escapeHtml(getLocationRoleLabel(location))}</div>
        </div>
        <div class="location-detail-stat full">
          <div class="location-detail-stat-label">Storage Path</div>
          <div class="location-detail-stat-value">${escapeHtml(location.storage_path || getLocationPathLabel(location))}</div>
        </div>
        <div class="location-detail-stat">
          <div class="location-detail-stat-label">Max Capacity</div>
          <div class="location-detail-stat-value">${location.max_capacity === null || location.max_capacity === undefined ? "No limit" : location.max_capacity}</div>
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

    ${trayMarkup}

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
            <button type="button" class="locations-link-button" data-open-location-dymo="${escapeHtml(location.id)}" ${location.location_code ? "" : "disabled"}>
              ${location.dymo_label_url ? "Generate New DYMO Label" : "Generate DYMO Label"}
            </button>
            <div id="location-dymo-status" class="location-status-line">Opens a fresh label using the LocationLabelSystem template.</div>
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
            <div id="location-edit-name-suggestions" class="location-name-suggestions hidden"></div>
          </label>

          <label class="location-edit-label">
            <span>Store</span>
            <select id="location-edit-store" class="location-edit-select">
              ${buildStoreOptionsMarkup(asTrimmedString(location.store_id), "Unassigned")}
            </select>
          </label>

          <label class="location-edit-label">
            <span>Type</span>
            <input type="text" id="location-edit-type" class="location-edit-input" list="location-type-options" value="${escapeHtml(location.type || "")}" placeholder="Choose or type a new type" />
          </label>

          <label class="location-edit-label full">
            <span>Parent Table / Vault / Location</span>
            <select id="location-edit-parent" class="location-edit-select">
              ${buildParentLocationOptionsMarkup(asTrimmedString(location.parent_location_id), location.id)}
            </select>
          </label>

          <label class="location-edit-label">
            <span>Max Capacity</span>
            <input type="number" id="location-edit-capacity" class="location-edit-input" value="${location.max_capacity ?? ""}" min="0" />
          </label>

          <label class="location-edit-toggle location-limit-toggle">
            <input type="checkbox" id="location-edit-capacity-no-limit" ${location.max_capacity === null || location.max_capacity === undefined ? "checked" : ""} />
            <span>No capacity limit</span>
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

          <label class="location-edit-toggle full">
            <input type="checkbox" id="location-edit-is-tray" ${location.is_tray ? "checked" : ""} />
            <span>This location is a mobile tray</span>
          </label>

          <label class="location-edit-label">
            <span>Tray Tolerance (g)</span>
            <input type="number" id="location-edit-tray-tolerance" class="location-edit-input" value="${location.tray_weight_tolerance_grams ?? ""}" min="0" step="0.01" />
          </label>

          <label class="location-edit-toggle location-limit-toggle">
            <input type="checkbox" id="location-edit-tray-tolerance-no-limit" ${location.tray_weight_tolerance_grams === null || location.tray_weight_tolerance_grams === undefined ? "checked" : ""} />
            <span>No tray weight limit</span>
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
  setupLocationNameSuggestions(
    document.getElementById("location-edit-name"),
    document.getElementById("location-edit-name-suggestions"),
    location.id,
    () => document.getElementById("location-edit-store")?.value || ""
  );
  syncEditLocationLimitControls();
}

async function saveLocationEdits(locationId) {
  const location = state.locations.find((entry) => entry.id === locationId);
  if (!location) return;

  const statusEl = document.getElementById("location-edit-status");
  const name = asTrimmedString(document.getElementById("location-edit-name")?.value);
  const storeId = asTrimmedString(document.getElementById("location-edit-store")?.value);
  const type = asTrimmedString(document.getElementById("location-edit-type")?.value);
  const parentLocationId = asTrimmedString(document.getElementById("location-edit-parent")?.value);
  const parentLocation = parentLocationId
    ? state.locations.find((entry) => String(entry.id) === String(parentLocationId))
    : null;
  const capacityValue = asTrimmedString(document.getElementById("location-edit-capacity")?.value);
  const capacityHasNoLimit = Boolean(document.getElementById("location-edit-capacity-no-limit")?.checked);
  const notes = asTrimmedString(document.getElementById("location-edit-notes")?.value);
  const active = Boolean(document.getElementById("location-edit-active")?.checked);
  const isTray = Boolean(document.getElementById("location-edit-is-tray")?.checked);
  const trayToleranceValue = asTrimmedString(document.getElementById("location-edit-tray-tolerance")?.value);
  const trayToleranceHasNoLimit = Boolean(document.getElementById("location-edit-tray-tolerance-no-limit")?.checked);
  const photoFile = document.getElementById("location-edit-photo")?.files?.[0] || null;

  if (!name) {
    if (statusEl) statusEl.textContent = "Location name is required.";
    return;
  }

  if (parentLocationId && !parentLocation) {
    if (statusEl) statusEl.textContent = "Choose a valid parent table, vault, shelf, or safe.";
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
    store_id: storeId || parentLocation?.store_id || null,
    type: type || null,
    location_role: isTray ? "tray" : parentLocationId ? "container" : "storage_location",
    parent_location_id: isTray ? null : parentLocationId || null,
    container_kind: !isTray && parentLocationId ? (type || "container") : null,
    notes: notes || null,
    active,
    photo_url: photoPath,
    max_capacity: capacityHasNoLimit || !capacityValue ? null : Number(capacityValue),
    is_tray: isTray,
    tray_weight_tolerance_grams: trayToleranceHasNoLimit || !trayToleranceValue ? null : Number(trayToleranceValue),
    tray_current_store_id: isTray ? (location.tray_current_store_id || storeId || null) : null,
  };

  let { data, error } = await supabase
    .from("locations")
    .update(updatePayload)
    .eq("id", locationId)
    .select("*")
    .single();

  if (error && !isTray && isTrayToleranceNotNullError(error)) {
    ({ data, error } = await supabase
      .from("locations")
      .update({ ...updatePayload, tray_weight_tolerance_grams: 10 })
      .eq("id", locationId)
      .select("*")
      .single());
  }

  if (error || !data) {
    console.error("Location update failed:", error);
    if (statusEl) statusEl.textContent = `Could not save changes: ${error?.message || "Unknown error"}`;
    return;
  }

  if (statusEl) statusEl.textContent = "Location updated.";
  await bumpInventoryVersionForLocationChange();
  await loadLocationsData();
  await renderLocationDetail(locationId);
}

async function saveTrayMovement(locationId) {
  const location = state.locations.find((entry) => entry.id === locationId);
  if (!location || !location.is_tray) return;

  const statusEl = document.getElementById("tray-movement-status");
  const action = asTrimmedString(document.getElementById("tray-movement-action")?.value);
  const storeId = asTrimmedString(document.getElementById("tray-movement-store")?.value);
  const weightValue = asTrimmedString(document.getElementById("tray-movement-weight")?.value);
  const notes = asTrimmedString(document.getElementById("tray-movement-notes")?.value);
  const actualWeight = Number(weightValue);
  const tolerance = location.tray_weight_tolerance_grams === null || location.tray_weight_tolerance_grams === undefined
    ? null
    : Number(location.tray_weight_tolerance_grams);

  if (!storeId) {
    if (statusEl) statusEl.textContent = "Choose the store for this tray movement.";
    return;
  }

  if (!Number.isFinite(actualWeight) || actualWeight < 0) {
    if (statusEl) statusEl.textContent = "Enter the actual tray weight in grams.";
    return;
  }

  if (action === "check_out" && location.tray_status === "checked_out") {
    if (statusEl) statusEl.textContent = "This tray is already checked out. Check it in before checking it out again.";
    return;
  }

  if (statusEl) statusEl.textContent = "Recording tray movement...";

  const { data: { user } } = await supabase.auth.getUser();
  const nowIso = new Date().toISOString();
  const expectedWeight = action === "check_in" && Number.isFinite(Number(location.tray_last_checkout_weight))
    ? Number(location.tray_last_checkout_weight)
    : null;
  const delta = expectedWeight === null ? null : Number((actualWeight - expectedWeight).toFixed(2));
  const result = delta !== null && Number.isFinite(tolerance) && Math.abs(delta) > tolerance ? "mismatch" : "ok";
  const trayStatus = action === "check_in"
    ? (result === "mismatch" ? "weight_mismatch" : "checked_in")
    : "checked_out";

  const movementPayload = {
    tray_location_id: locationId,
    action,
    from_store_id: action === "check_out" ? storeId : (location.tray_current_store_id || location.store_id || null),
    to_store_id: action === "check_in" ? storeId : null,
    expected_weight_grams: expectedWeight,
    actual_weight_grams: actualWeight,
    weight_delta_grams: delta,
    tolerance_grams: Number.isFinite(tolerance) ? tolerance : null,
    result,
    notes: notes || null,
    performed_by: user?.id || null,
    performed_by_email: user?.email || null,
  };

  const updatePayload = {
    tray_status: trayStatus,
    tray_current_store_id: storeId,
    tray_last_weight_delta: delta,
  };

  if (action === "check_out") {
    updatePayload.tray_last_checkout_weight = actualWeight;
    updatePayload.tray_checked_out_at = nowIso;
    updatePayload.tray_checked_out_by = user?.id || null;
    updatePayload.tray_last_weight_delta = null;
  } else {
    updatePayload.tray_last_checkin_weight = actualWeight;
    updatePayload.tray_checked_in_at = nowIso;
    updatePayload.tray_checked_in_by = user?.id || null;
  }

  const { error: movementError } = await supabase
    .from("tray_movements")
    .insert(movementPayload);

  if (movementError) {
    console.error("Tray movement insert failed:", movementError);
    if (statusEl) statusEl.textContent = `Could not record movement: ${movementError.message}`;
    return;
  }

  const { error: updateError } = await supabase
    .from("locations")
    .update(updatePayload)
    .eq("id", locationId);

  if (updateError) {
    console.error("Tray location update failed:", updateError);
    if (statusEl) statusEl.textContent = `Movement logged, but tray status was not updated: ${updateError.message}`;
    return;
  }

  if (statusEl) {
    statusEl.textContent = result === "mismatch"
      ? `Weight mismatch flagged: ${formatWeight(delta)} from checkout baseline.`
      : "Tray movement recorded.";
  }

  await bumpInventoryVersionForLocationChange();
  await loadLocationsData();
  await renderLocationDetail(locationId);
}

function bindEvents() {
  document.getElementById("locations-search")?.addEventListener("input", (event) => {
    state.filters.search = event.target.value.trim();
    renderLocationsTable();
  });

  document.getElementById("locations-search")?.addEventListener("keydown", async (event) => {
    if (event.key !== "Enter") return;
    const query = asTrimmedString(event.target.value).toLowerCase();
    if (!query) return;

    const exactMatch = state.locations.find((location) => {
      return [location.location_code, location.location_name]
        .some((value) => asTrimmedString(value).toLowerCase() === query);
    });

    if (exactMatch) {
      event.preventDefault();
      await renderLocationDetail(exactMatch.id);
    }
  });

  document.getElementById("locations-type-filter")?.addEventListener("change", (event) => {
    state.filters.type = event.target.value;
    renderLocationsTable();
  });

  document.getElementById("locations-store-filter")?.addEventListener("change", (event) => {
    state.filters.store = event.target.value;
    state.browser.storeId = event.target.value || "";
    state.browser.mode = "";
    state.browser.parentId = "";
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

  document.getElementById("locations-create-location")?.addEventListener("click", () => {
    openCreateLocationModal({ tray: false });
  });

  document.getElementById("locations-create-container")?.addEventListener("click", () => {
    openCreateLocationModal({ container: true });
  });

  document.getElementById("locations-create-tray")?.addEventListener("click", () => {
    openCreateLocationModal({ tray: true });
  });

  document.getElementById("location-create-close")?.addEventListener("click", () => {
    closeCreateLocationModal();
  });

  document.getElementById("location-create-regenerate")?.addEventListener("click", () => {
    generateCreateLocationBarcode();
  });

  document.getElementById("location-create-capacity-no-limit")?.addEventListener("change", () => {
    syncCreateLocationLimitControls();
  });

  document.getElementById("location-create-tray-tolerance-no-limit")?.addEventListener("change", () => {
    syncCreateLocationLimitControls();
  });

  document.getElementById("location-create-parent")?.addEventListener("change", () => {
    syncCreateContainerStoreFromParent();
    renderLocationNameSuggestions(
      document.getElementById("location-create-name"),
      document.getElementById("location-create-name-suggestions"),
      "",
      document.getElementById("location-create-store")?.value || ""
    );
  });

  document.getElementById("location-create-store")?.addEventListener("change", () => {
    renderLocationNameSuggestions(
      document.getElementById("location-create-name"),
      document.getElementById("location-create-name-suggestions"),
      "",
      document.getElementById("location-create-store")?.value || ""
    );
  });

  document.getElementById("location-create-photo")?.addEventListener("change", (event) => {
    const file = event.target.files?.[0] || null;
    const preview = document.getElementById("location-create-photo-preview");
    if (!preview) return;

    if (!file) {
      preview.textContent = "No photo selected.";
      return;
    }

    const reader = new FileReader();
    reader.onload = (loadEvent) => {
      preview.innerHTML = `<img src="${escapeHtml(loadEvent.target?.result || "")}" alt="Location preview" />`;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById("location-create-modal")?.addEventListener("click", (event) => {
    if (event.target.id === "location-create-modal") {
      closeCreateLocationModal();
    }
  });

  document.getElementById("location-create-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    await saveCreatedLocation();
  });

  document.getElementById("locations-browser")?.addEventListener("click", async (event) => {
    const backTrigger = event.target.closest("[data-browser-back]");
    if (backTrigger) {
      const target = backTrigger.getAttribute("data-browser-back");
      if (target === "stores") {
        state.browser.storeId = "";
        state.browser.mode = "";
        state.browser.parentId = "";
        if (state.filters.store) {
          state.filters.store = "";
          const storeFilter = document.getElementById("locations-store-filter");
          if (storeFilter) storeFilter.value = "";
        }
      } else if (target === "store") {
        state.browser.mode = "";
        state.browser.parentId = "";
      } else if (target === "locations") {
        state.browser.mode = "locations";
        state.browser.parentId = "";
      }
      renderLocationsTable();
      return;
    }

    const storeTrigger = event.target.closest("[data-browser-store-id]");
    if (storeTrigger) {
      state.browser.storeId = storeTrigger.getAttribute("data-browser-store-id") || "";
      state.browser.mode = "";
      state.browser.parentId = "";
      renderLocationsTable();
      return;
    }

    const modeTrigger = event.target.closest("[data-browser-mode]");
    if (modeTrigger) {
      state.browser.mode = modeTrigger.getAttribute("data-browser-mode") || "";
      state.browser.parentId = "";
      renderLocationsTable();
      return;
    }

    const parentTrigger = event.target.closest("[data-browser-parent-id]");
    if (parentTrigger) {
      state.browser.mode = "locations";
      state.browser.parentId = parentTrigger.getAttribute("data-browser-parent-id") || "";
      renderLocationsTable();
      return;
    }

    const trigger = event.target.closest("[data-open-location]");
    if (!trigger) return;
    await renderLocationDetail(trigger.getAttribute("data-open-location"));
  });

  document.getElementById("location-detail-close")?.addEventListener("click", () => {
    closeLocationDetail();
  });

  document.getElementById("location-detail-body")?.addEventListener("click", async (event) => {
    const dymoButton = event.target.closest("[data-open-location-dymo]");
    if (dymoButton) {
      event.preventDefault();
      const locationId = dymoButton.getAttribute("data-open-location-dymo");
      const labelWindow = window.open("about:blank", "_blank");
      dymoButton.disabled = true;
      dymoButton.textContent = "Generating...";

      try {
        const signedUrl = await regenerateLocationDymoLabel(locationId);
        if (labelWindow) {
          labelWindow.location.href = signedUrl;
        } else {
          window.open(signedUrl, "_blank");
        }
        await renderLocationDetail(locationId);
      } catch (error) {
        console.error("Location DYMO regeneration failed:", error);
        if (labelWindow && !labelWindow.closed) labelWindow.close();
        setLocationDymoStatus(`Could not generate label: ${error?.message || "Unknown error"}`);
        dymoButton.disabled = false;
        dymoButton.textContent = "Generate New DYMO Label";
      }
      return;
    }

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

  document.getElementById("location-detail-body")?.addEventListener("change", (event) => {
    if (
      event.target?.id === "location-edit-capacity-no-limit"
      || event.target?.id === "location-edit-tray-tolerance-no-limit"
    ) {
      syncEditLocationLimitControls();
    }

    if (event.target?.id === "location-edit-store") {
      renderLocationNameSuggestions(
        document.getElementById("location-edit-name"),
        document.getElementById("location-edit-name-suggestions"),
        document.getElementById("location-edit-form")?.dataset.locationId || "",
        event.target.value || ""
      );
    }
  });

  document.getElementById("location-detail-body")?.addEventListener("submit", async (event) => {
    const form = event.target.closest("#tray-movement-form");
    if (!form) return;
    event.preventDefault();
    await saveTrayMovement(form.dataset.locationId);
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
