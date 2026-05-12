

async function waitForSupabaseInit() {
  return new Promise((resolve) => {
    if (window.supabase) return resolve(); // already available
    document.addEventListener("supabase-ready", resolve); // wait if not yet ready
  });
}

async function loadActiveInventoryWorker(userId) {
  const { data: employee, error } = await supabase
    .from("employees")
    .select("role, active, display_name")
    .eq("user_id", userId)
    .maybeSingle();

  if (error) throw error;
  if (!employee || employee.active === false) return null;

  const role = String(employee.role || "").toLowerCase();
  if (!["admin", "manager", "employee"].includes(role)) return null;

  return employee;
}

console.log("Loaded JS")
// === GLOBALS ===
let latestDymoXml = "";
let typeqr = "";
let latestLocationDymoXml = null;
let latestLocationDymoUrl = null;
let activeStoreOptions = [];
let activeAdminLocationOptions = [];
let selectedAdminLocation = null;


// === DOM ELEMENTS ===
const qrInput = document.getElementById('qr-code');
const qrCanvas = document.getElementById('qr-canvas');
const barcodeCanvas = document.getElementById('barcode-canvas');
const barcodeInput = document.getElementById('scanned-barcode');
const qrTypeSelect = document.getElementById("qr-type");
const previewContainer = document.getElementById("carousel-preview");
const photoInput = document.getElementById("item-photo");
const pricePerWeightInput = document.getElementById("price-per-weight");
const autoCostCheckbox = document.getElementById("auto-cost-checkbox");
const pendingStockAssignments = {}; // { barcode: { location_name, quantity, location_id } }
let uploadedImages = [];

//#region general utilities needed to run theh program
  // === utility to show toast ===
  function showToast(message) {
    const container = document.getElementById("toast-container");
    if (!container) return;

    const toast = document.createElement("div");
    toast.className = "toast";
    toast.textContent = message;

    container.appendChild(toast);

    setTimeout(() => {
      toast.remove();
    }, 4000);
  }

  window.showToast = showToast;

  //obtain unique categories to display in the tab
  async function fetchUniqueCategories() {
    const { data, error } = await supabase
      .from("item_types")
      .select("categories");

    if (error) {
      console.error("❌ Failed to fetch categories:", error);
      return [];
    }

    const flat = data.flatMap((row) => {
      if (Array.isArray(row.categories)) return row.categories;
      if (typeof row.categories === "string") return row.categories.split(",").map((category) => category.trim());
      return [];
    });
    const unique = [...new Set(flat.map((category) => String(category || "").trim()).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b));
  }

  //function to bump the cache after items are added
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
      console.warn("⚠️ Failed to update inventory version:", error.message);
    } else {
      console.log("🔁 Inventory version updated", payload);
    }
  }


  // === MULTI-IMAGE PREVIEW & UPLOAD ===
  function setupPhotoUploadPreview() {
    photoInput.addEventListener('change', () => {
      previewContainer.innerHTML = "";
      uploadedImages = [];

      [...photoInput.files].forEach(file => {
        const reader = new FileReader();
        reader.onload = (e) => {
          const img = document.createElement("img");
          img.src = e.target.result;
          previewContainer.appendChild(img);
        };
        reader.readAsDataURL(file);
      });
    });
  }

  function sanitizeStorageFileName(fileName) {
    return String(fileName || "image.jpg")
      .replace(/[^\w.\-]+/g, "_")
      .replace(/_+/g, "_");
  }

  async function copyAssistedImageToPhotosBucket(image, index) {
    const sourceBucket = String(image?.storageBucket || "").trim();
    const sourcePath = String(image?.path || "").trim();

    if (!sourceBucket || !sourcePath) {
      throw new Error("Assisted image is missing storage metadata.");
    }

    if (sourceBucket === "photos") {
      return sourcePath;
    }

    const sourceFileName = sanitizeStorageFileName(
      sourcePath.split("/").pop() || `assisted_${index + 1}.jpg`
    );
    const destinationPath = `item_photos/${Date.now()}_assisted_${index + 1}_${sourceFileName}`;

    const { data: downloadedBlob, error: downloadError } = await supabase
      .storage
      .from(sourceBucket)
      .download(sourcePath);

    if (downloadError || !downloadedBlob) {
      throw new Error(downloadError?.message || "Failed to download assisted image.");
    }

    const { error: uploadError } = await supabase
      .storage
      .from("photos")
      .upload(destinationPath, downloadedBlob, {
        upsert: true,
        contentType: downloadedBlob.type || image?.mimeType || "image/jpeg",
      });

    if (uploadError) {
      throw new Error(uploadError.message || "Failed to copy assisted image into item photos.");
    }

    return destinationPath;
  }

//#endregion

//#region dropdown creation 
  /** Function that will create the html block for the drop down, insert search bar, attach listener
   * Renders a searchable dropdown and lets the caller define behavior
   * for selecting existing options or creating new ones.
   * @param {Object} config
   * @param {string} config.menuId - ID of the DOM container
   * @param {Array<string>} config.options - Array of string values to display
   * @param {string} [config.searchId="category-search"] - Search input ID
   * @param {string} [config.placeholder="Search..."] - Input placeholder text
   * @param {string} [config.optionClass="dropdown-option"] - Class for each option div
   * @param {string} [config.dataAttribute="cat"] - The data-* attribute key (e.g. "cat", "qr")
   * @param {string} [config.optionsContainerClass="dropdown-options-container"]
   * @param {Function} config.onClick - What to do when any option is clicked (new or existing)
   */
  function renderDropdownOptionsCustom({
    menuId,
    toggleButtonId,
    hiddenInputId,
    options = [],
    placeholder = "Search...",
    dataAttribute = "value",
    optionClass = "dropdown-option",
    optionsContainerClass = "dropdown-options-container",
    searchId = `${menuId}-search`,
    onClick = () => {},
    showHTMLInjected = false
  }) {
    const menu = document.getElementById(menuId);
    const toggleBtn = document.getElementById(toggleButtonId);
    const hiddenInput = document.getElementById(hiddenInputId);
    if (!menu || !toggleBtn || !hiddenInput) return;

    const searchHTML = `
      <div class="dropdown-search-container">
        <input type="text" id="${searchId}" class="dropdown-search" placeholder="${placeholder}">
      </div>
    `;

    const buildOptionsHTML = (filteredOpts, searchTerm) => {
      let html = filteredOpts.map(opt => `
        <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">
          ${opt}
        </div>
      `).join("");

      const exactMatch = options.some(opt => opt.toLowerCase() === searchTerm.toLowerCase());
      if (searchTerm && !exactMatch) {
        html += `
          <div class="${optionClass} new-entry" data-${dataAttribute}="${searchTerm}" data-value="${searchTerm}" data-new="true">
            ➕ Create "${searchTerm}"
          </div>
        `;
      }
      return html;
    };

    const fullHTML = `
      ${searchHTML}
      <div class="${optionsContainerClass}">
        ${buildOptionsHTML(options, "")}
      </div>
    `;

    if (showHTMLInjected) {
      console.log("💡 Injected dropdown HTML for", menuId);
      console.log(fullHTML);
    }

    menu.innerHTML = fullHTML;

    const input = menu.querySelector(`#${searchId}`);
    const container = menu.querySelector(`.${optionsContainerClass}`);

    const attachClickHandlers = () => {
      container.querySelectorAll(`.${optionClass}[data-${dataAttribute}]`).forEach(optionEl => {
        optionEl.addEventListener("click", () => {
          const value = optionEl.dataset.value;
          const isNew = optionEl.dataset.new === "true";

          hiddenInput.value = value;
          toggleBtn.innerText = value;

          onClick(value, isNew, optionEl);

          menu.classList.remove("show");
        });
      });
    };

    attachClickHandlers();

    input?.addEventListener("input", (e) => {
      const searchTerm = e.target.value.toLowerCase();
      container.innerHTML = buildOptionsHTML(options, searchTerm);
      requestAnimationFrame(() => attachClickHandlers());
    });
  }

  // === dropdownoption=== //
  function setupCategoryDropdownToggle() {
    document.addEventListener("click", async (e) => {
      if (e.target.id !== "category-dropdown-toggle") return;

      const menu = document.getElementById("category-dropdown-menu");

      if (!menu.dataset.populated) {
        const categories = await fetchUniqueCategories();

        renderDropdownOptionsCustom({
          menuId: "category-dropdown-menu",
          toggleButtonId: "category-dropdown-toggle",
          hiddenInputId: "category",
          options: categories,
          placeholder: "Search or create category...",
          dataAttribute: "cat",
          optionClass: "dropdown-option",
          optionsContainerClass: "category-options-container",
          searchId: "category-dropdown-search",
          onClick: (value, isNew) => {
            if (isNew) {
              showToast(`➕ Created new category: ${value}`);
            } else {
              showToast(`🏷️ Selected category: ${value}`);
            }
          }
        });

        menu.dataset.populated = "true";
      }

      menu.classList.toggle("show");
    });
  }

//#endregion

//#region functions needed to set the final sale cost of items
  //Cost & Sale Price Auto-Calculation
  function updateCostFromWeight() {
    if (!autoCostCheckbox?.checked) return;
    const weight = parseFloat(document.getElementById("weight")?.value || "0");
    const pricePerWeight = parseFloat(pricePerWeightInput?.value || "0");
    if (weight > 0 && pricePerWeight > 0) {
      const newCost = weight * pricePerWeight;
      document.getElementById('cost').value = newCost.toFixed(2);

      // New: round sale price up to nearest 10
      const salePrice = Math.ceil((newCost * 7.5) / 10) * 10;
      document.getElementById('sale-price').value = salePrice.toLocaleString("en-US");
    }
  }

  //listeners for the calculation and calculation of the final prince
  function setupCostAndPriceListeners() {
    document.getElementById("weight")?.addEventListener('input', updateCostFromWeight);
    pricePerWeightInput?.addEventListener('input', updateCostFromWeight);
    document.getElementById('cost')?.addEventListener('input', () => {
      const cost = parseFloat(document.getElementById('cost').value.replace(/,/g, ''));
      if (cost > 0) {
        const salePrice = Math.ceil((cost * 7.5) / 10) * 10;
        document.getElementById('sale-price').value = salePrice.toLocaleString("en-US");
      } else {
        document.getElementById('sale-price').value = '';
      }
    });
  }

//#endregion

//#region function needed for the QR code and barcode generation 
  // === QR Code Rendering
  function renderQR(url) {
    QRCode.toCanvas(qrCanvas, url, {
      errorCorrectionLevel: 'H',
      color: { dark: "#ffffff", light: "#2c2c2e" },
      width: 180
    }, err => { if (err) console.error("QR error:", err); });
  }

  // === QR TYPE SELECTION
  qrTypeSelect?.addEventListener("change", () => {
    typeqr = qrTypeSelect.value;
    if (typeqr === "website") {
      document.getElementById("qr-code").value = "https://ogjeweler.com/";
      renderQR("https://ogjeweler.com/");
    }
  });

  qrInput?.addEventListener('input', () => {
    const url = qrInput.value.trim();
    if (url) renderQR(url);
  });

  // === Barcode Rendering
  function renderBarcode(code) {
    const ctx = barcodeCanvas.getContext('2d');
    ctx.clearRect(0, 0, barcodeCanvas.width, barcodeCanvas.height);
    JsBarcode(barcodeCanvas, code, {
      format: "CODE128",
      lineColor: "#ffffff",
      background: "#2c2c2e",
      displayValue: true,
      fontOptions: "bold",
      fontSize: 16,
      height: 60,
      margin: 10
    });
  }

  //respective event listener
  function setupBarcodeGeneration() {
    document.getElementById('generate-barcode')?.addEventListener('click', () => {
      const code = 'OG' + Date.now();
      barcodeInput.value = code;
      renderBarcode(code);
    });
  }

//#endregion

//#region functions needed for the add stock modal
  // === modal to add stock and location ===
  function showAdminLocationStockModal(itemId, defaultQty = null) {
    const modal = document.getElementById("modal-admin-assign-location");

    const qtyEl = document.getElementById("admin-stock-quantity");
    // Only set/clear when explicitly given a default; otherwise keep whatever is there
    if (defaultQty !== null && Number.isFinite(defaultQty)) {
      qtyEl.value = String(defaultQty);
    } else if (!qtyEl.value) {
      qtyEl.value = ""; // keep empty if nothing set yet
    }

    setSelectedAdminLocation("");
    modal.dataset.itemId = itemId;
    modal.classList.remove("hidden");

    populateAdminLocationDropdown();
  }


  // === utility to get the unique location ===
  async function fetchUniqueLocationNames() {
    const { data, error } = await supabase
      .from("locations")
      .select("location_name")
      .neq("location_name", null);

    if (error) {
      console.error("❌ Error fetching locations:", error.message);
      return [];
    }

    const unique = [...new Set(data.map(loc => loc.location_name).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b));
  }

  async function fetchAdminLocationOptions() {
    const { data, error } = await supabase
      .from("locations")
      .select("id, location_name, location_code, type, store_id, max_capacity, active")
      .eq("active", true)
      .order("location_name", { ascending: true });

    if (error) {
      console.error("Error fetching assignable locations:", error.message);
      return [];
    }

    const stores = activeStoreOptions.length ? activeStoreOptions : await fetchActiveStores();
    const storeNameById = new Map(stores.map((store) => [String(store.id), store.name]));

    return (Array.isArray(data) ? data : [])
      .map((location) => ({
        id: String(location.id || ""),
        name: String(location.location_name || "").trim(),
        code: String(location.location_code || "").trim(),
        type: String(location.type || "").trim(),
        storeId: String(location.store_id || "").trim(),
        storeName: storeNameById.get(String(location.store_id || "")) || "No store assigned",
        maxCapacity: Number(location.max_capacity) || null,
      }))
      .filter((location) => location.id && location.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async function fetchUniqueLocationTypes() {
    const { data, error } = await supabase
      .from("locations")
      .select("type")
      .neq("type", null);

    if (error) {
      console.error("Error fetching location types:", error.message);
      return [];
    }

    const unique = [...new Set(data.map((loc) => loc.type).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b));
  }

  async function fetchActiveStores() {
    const { data, error } = await supabase
      .from("store_locations")
      .select("id, name, active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      console.error("Error fetching stores:", error.message);
      return [];
    }

    return Array.isArray(data) ? data : [];
  }

  async function populateLocationStoreSelect() {
    const select = document.getElementById("location-store");
    if (!select) return [];

    activeStoreOptions = await fetchActiveStores();
    select.innerHTML = ['<option value="">Select Store</option>']
      .concat(
        activeStoreOptions.map((store) => {
          return `<option value="${store.id}">${store.name}</option>`;
        })
      )
      .join("");

    return activeStoreOptions;
  }

  function getAdminLocationLabel(location) {
    if (!location) return "Select Location";
    return location.code ? `${location.name} (${location.code})` : location.name;
  }

  function setSelectedAdminLocation(location = null) {
    const locationObject = typeof location === "string"
      ? activeAdminLocationOptions.find((entry) => entry.name === location || entry.id === location || entry.code === location) || null
      : location;
    const locationName = locationObject?.name || "";
    const locationId = locationObject?.id || "";
    const locationCode = locationObject?.code || "";
    const storeName = locationObject?.storeName || "";
    const typeName = locationObject?.type || "";
    const summary = document.getElementById("admin-location-selection-summary");

    selectedAdminLocation = locationObject || null;
    document.getElementById("admin-location-name").value = locationName;
    document.getElementById("admin-location-id").value = locationId;
    document.getElementById("admin-location-dropdown-toggle").innerText = locationObject
      ? getAdminLocationLabel(locationObject)
      : "Select Location";

    if (summary) {
      summary.textContent = locationObject
        ? [
            locationCode ? `Barcode: ${locationCode}` : "",
            storeName ? `Store: ${storeName}` : "",
            typeName ? `Type: ${typeName}` : "",
          ].filter(Boolean).join(" | ")
        : "Search by location name, barcode, type, or store.";
    }

    const referenceWeight = Number(document.getElementById("weight")?.value);
    if (locationId) {
      renderLocationIntelligence("admin-location-intelligence", locationId, {
        referenceWeight: Number.isFinite(referenceWeight) ? referenceWeight : null,
        referenceLabel: "this item",
      });
    } else {
      renderLocationIntelligenceEmpty("admin-location-intelligence");
    }
  }

  function populateAdminLocationStoreFilter(locations) {
    const select = document.getElementById("admin-location-store-filter");
    if (!select) return;

    const currentValue = select.value;
    const storeOptions = activeStoreOptions
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    select.innerHTML = ['<option value="">All Stores</option>']
      .concat(storeOptions.map((store) => `<option value="${store.id}">${store.name}</option>`))
      .join("");

    if (currentValue && storeOptions.some((store) => String(store.id) === currentValue)) {
      select.value = currentValue;
    }
  }

  function escapeDropdownHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatLocationWeight(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? `${numeric.toFixed(2)} g` : "--";
  }

  function renderLocationIntelligenceEmpty(containerId, message = "Select a location to see current contents and similar-weight items.") {
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = `<div class="location-intelligence-empty">${escapeDropdownHtml(message)}</div>`;
  }

  async function fetchLocationIntelligence(locationId, referenceWeight = null) {
    const { data: location, error: locationError } = await supabase
      .from("locations")
      .select("id, location_name, location_code, max_capacity")
      .eq("id", locationId)
      .maybeSingle();

    if (locationError) throw locationError;

    const { data: rows, error: rowsError } = await supabase
      .from("item_stock_locations")
      .select("quantity, item_types(id, title, weight, barcode)")
      .eq("location_id", locationId)
      .gt("quantity", 0);

    if (rowsError) throw rowsError;

    const itemMap = new Map();
    (Array.isArray(rows) ? rows : []).forEach((row) => {
      const item = row.item_types || {};
      const weight = Number(item.weight);
      const quantity = Number(row.quantity) || 0;
      const key = String(item.id || item.barcode || item.title || Math.random());
      const existing = itemMap.get(key);
      if (existing) {
        existing.quantity += quantity;
        return;
      }
      itemMap.set(key, {
        id: item.id,
        title: String(item.title || item.barcode || "Untitled item"),
        barcode: String(item.barcode || ""),
        quantity,
        weight: Number.isFinite(weight) ? weight : null,
      });
    });

    const items = [...itemMap.values()]
      .filter((item) => item.quantity > 0)
      .sort((a, b) => a.title.localeCompare(b.title));

    const totalQuantity = items.reduce((sum, item) => sum + item.quantity, 0);
    const approximateWeight = items.reduce((sum, item) => {
      return sum + (Number.isFinite(item.weight) ? item.weight * item.quantity : 0);
    }, 0);
    const hasReferenceWeight = Number.isFinite(Number(referenceWeight));
    const numericReferenceWeight = Number(referenceWeight);
    const similarItems = hasReferenceWeight
      ? items
          .map((item) => ({
            ...item,
            delta: Number.isFinite(item.weight) ? Math.abs(item.weight - numericReferenceWeight) : null,
          }))
          .filter((item) => Number.isFinite(item.delta) && item.delta <= 2)
          .sort((a, b) => a.delta - b.delta || a.title.localeCompare(b.title))
      : [];

    return {
      location: location || null,
      items,
      totalQuantity,
      approximateWeight,
      similarItems,
    };
  }

  async function renderLocationIntelligence(containerId, locationId, { referenceWeight = null, referenceLabel = "this item" } = {}) {
    const container = document.getElementById(containerId);
    if (!container) return;

    if (!locationId) {
      renderLocationIntelligenceEmpty(containerId);
      return;
    }

    container.innerHTML = '<div class="location-intelligence-empty">Checking location contents...</div>';

    try {
      const data = await fetchLocationIntelligence(locationId, referenceWeight);
      const capacity = Number(data.location?.max_capacity) || null;
      const capacityText = capacity ? `${data.totalQuantity}/${capacity}` : `${data.totalQuantity}`;
      const similarHtml = data.similarItems.length
        ? data.similarItems.slice(0, 6).map((item) => `
            <div class="location-intelligence-row is-similar">
              <div>
                <strong>${escapeDropdownHtml(item.title)}</strong>
                <span>${escapeDropdownHtml(item.barcode || "No barcode")} | Qty ${item.quantity}</span>
              </div>
              <div class="location-intelligence-weight">
                ${escapeDropdownHtml(formatLocationWeight(item.weight))}
                <small>${escapeDropdownHtml(item.delta.toFixed(2))} g off</small>
              </div>
            </div>
          `).join("")
        : `<div class="location-intelligence-muted">No items within 2 g of ${escapeDropdownHtml(referenceLabel)}.</div>`;
      const contentsHtml = data.items.length
        ? data.items.slice(0, 8).map((item) => `
            <div class="location-intelligence-row">
              <div>
                <strong>${escapeDropdownHtml(item.title)}</strong>
                <span>${escapeDropdownHtml(item.barcode || "No barcode")}</span>
              </div>
              <div class="location-intelligence-weight">
                Qty ${item.quantity}
                <small>${escapeDropdownHtml(formatLocationWeight(item.weight))}</small>
              </div>
            </div>
          `).join("")
        : '<div class="location-intelligence-muted">This location is currently empty.</div>';

      container.innerHTML = `
        <div class="location-intelligence-header">
          <div>
            <span>Storage Snapshot</span>
            <strong>${escapeDropdownHtml(data.location?.location_name || "Selected location")}</strong>
          </div>
          ${data.location?.location_code ? `<span class="location-intelligence-badge">${escapeDropdownHtml(data.location.location_code)}</span>` : ""}
        </div>
        <div class="location-intelligence-stats">
          <div><span>Unique Items</span><strong>${data.items.length}</strong></div>
          <div><span>Total Qty</span><strong>${data.totalQuantity}</strong></div>
          <div><span>Capacity</span><strong>${escapeDropdownHtml(capacityText)}</strong></div>
          <div><span>Est. Weight</span><strong>${escapeDropdownHtml(formatLocationWeight(data.approximateWeight))}</strong></div>
        </div>
        <div class="location-intelligence-section">
          <div class="location-intelligence-section-title">Similar Weight (±2 g)</div>
          <div class="location-intelligence-list">${similarHtml}</div>
        </div>
        <div class="location-intelligence-section">
          <div class="location-intelligence-section-title">Current Contents</div>
          <div class="location-intelligence-list">${contentsHtml}</div>
        </div>
      `;
    } catch (error) {
      console.error("Failed to load location intelligence:", error);
      renderLocationIntelligenceEmpty(containerId, "Could not load location contents.");
    }
  }

  function renderAdminLocationDropdownOptions(searchTerm = "") {
    const menu = document.getElementById("admin-location-dropdown-menu");
    if (!menu) return;

    const container = menu.querySelector(".dropdown-options-container");
    if (!container) return;

    const normalizedSearch = String(searchTerm || "").trim().toLowerCase();
    const selectedStoreId = String(document.getElementById("admin-location-store-filter")?.value || "").trim();
    const filteredLocations = activeAdminLocationOptions.filter((location) => {
      if (selectedStoreId && location.storeId !== selectedStoreId) return false;

      const haystack = [
        location.name,
        location.code,
        location.type,
        location.storeName,
      ].join(" ").toLowerCase();

      return !normalizedSearch || haystack.includes(normalizedSearch);
    });

    const exactMatch = activeAdminLocationOptions.some((location) => {
      return location.name.toLowerCase() === normalizedSearch || location.code.toLowerCase() === normalizedSearch;
    });

    let html = filteredLocations.map((location) => {
      const meta = [
        location.storeName,
        location.type,
      ].filter(Boolean).join(" | ");
      const selectedClass = selectedAdminLocation?.id === location.id ? " is-selected" : "";

      return `
        <div class="dropdown-option${selectedClass}" data-location-id="${escapeDropdownHtml(location.id)}">
          <div class="location-option-main">
            <span>${escapeDropdownHtml(location.name)}</span>
            ${location.code ? `<span class="location-option-code">${escapeDropdownHtml(location.code)}</span>` : ""}
          </div>
          ${meta ? `<div class="location-option-meta">${escapeDropdownHtml(meta)}</div>` : ""}
        </div>
      `;
    }).join("");

    if (!filteredLocations.length) {
      html = '<div class="location-option-meta">No matching locations found.</div>';
    }

    if (normalizedSearch && !exactMatch) {
      html += `
        <div class="dropdown-option new-entry" data-new-location="${escapeDropdownHtml(searchTerm)}">
          Create "${escapeDropdownHtml(searchTerm)}"
        </div>
      `;
    }

    container.innerHTML = html;
  }

  function bindAdminLocationDropdownEvents() {
    const menu = document.getElementById("admin-location-dropdown-menu");
    const input = document.getElementById("admin-location-dropdown-search");
    const container = menu?.querySelector(".dropdown-options-container");
    if (!menu || !container || menu.dataset.bound === "true") return;

    menu.dataset.bound = "true";

    input?.addEventListener("input", (event) => {
      renderAdminLocationDropdownOptions(event.target.value);
    });

    container.addEventListener("click", (event) => {
      const newLocationEl = event.target.closest("[data-new-location]");
      if (newLocationEl) {
        const previousSelection = selectedAdminLocation;
        setSelectedAdminLocation(previousSelection);
        toggleAddLocationModal(true, newLocationEl.dataset.newLocation || "");
        menu.classList.remove("show");
        return;
      }

      const optionEl = event.target.closest("[data-location-id]");
      if (!optionEl) return;

      const location = activeAdminLocationOptions.find((entry) => entry.id === optionEl.dataset.locationId);
      if (!location) return;

      setSelectedAdminLocation(location);
      showToast(`Selected location: ${location.name}${location.code ? ` (${location.code})` : ""}`);
      menu.classList.remove("show");
      renderAdminLocationDropdownOptions(input?.value || "");
    });
  }

  function buildAdminLocationDropdownShell() {
    const menu = document.getElementById("admin-location-dropdown-menu");
    if (!menu) return;

    if (!menu.dataset.rendered) {
      menu.innerHTML = `
        <div class="dropdown-search-container">
          <input
            type="text"
            id="admin-location-dropdown-search"
            class="dropdown-search"
            placeholder="Search location, barcode, store, or type..."
          >
        </div>
        <div class="dropdown-options-container"></div>
      `;
      menu.dataset.rendered = "true";
    }

    bindAdminLocationDropdownEvents();
  }

  function clearAddLocationForm() {
    const nameInput = document.getElementById("location-name");
    const barcodeInput = document.getElementById("location-barcode");
    const capacityInput = document.getElementById("location-capacity");
    const photoInput = document.getElementById("location-photo");
    const previewWrapper = document.getElementById("photo-preview-wrapper");
    const previewImage = document.getElementById("photo-preview-image");
    const notesInput = document.getElementById("location-notes");
    const storeSelect = document.getElementById("location-store");
    const typeButton = document.getElementById("location-type-dropdown-toggle");
    const typeMenu = document.getElementById("location-type-dropdown-menu");
    const dymoPreview = document.getElementById("dymo-link-preview");
    const barcodeCanvas = document.getElementById("barcode-canvas-location");

    if (nameInput) nameInput.value = "";
    if (barcodeInput) barcodeInput.value = "";
    if (capacityInput) capacityInput.value = "";
    if (photoInput) photoInput.value = "";
    if (notesInput) notesInput.value = "";
    if (storeSelect) storeSelect.value = "";
    if (previewWrapper) previewWrapper.classList.add("hidden");
    if (previewImage) previewImage.src = "";
    if (dymoPreview) dymoPreview.innerHTML = "";
    if (typeButton) typeButton.innerText = "Select Location Type";
    if (typeMenu) {
      typeMenu.dataset.populated = "";
      typeMenu.innerHTML = "";
      typeMenu.classList.remove("show");
    }
    document.getElementById("location-type").value = "";
    latestLocationDymoXml = null;
    latestLocationDymoUrl = null;

    if (barcodeCanvas) {
      const ctx = barcodeCanvas.getContext("2d");
      ctx.clearRect(0, 0, barcodeCanvas.width, barcodeCanvas.height);
    }
  }

  function toggleAddLocationModal(show = true, prefilledName = "") {
    const modal = document.getElementById("modal-add-location");
    const nameInput = document.getElementById("location-name");

    if (!modal) return;

    if (show) {
      clearAddLocationForm();
      modal.classList.remove("hidden");
      populateLocationStoreSelect();
      if (prefilledName) {
        nameInput.value = prefilledName;
      }
      generateAndRenderLocationBarcode();
      nameInput.focus();
      return;
    }

    modal.classList.add("hidden");
    clearAddLocationForm();
  }

  function generateAndRenderLocationBarcode() {
    const barcodeInput = document.getElementById("location-barcode");
    if (!barcodeInput) return;

    const generatedCode = `LOC-${Date.now().toString().slice(-6)}`;
    JsBarcode("#barcode-canvas-location", generatedCode, {
      format: "CODE128",
      displayValue: true,
      fontSize: 16,
      height: 60
    });

    barcodeInput.value = generatedCode;

    latestLocationDymoXml = `<?xml version="1.0" encoding="utf-8"?>
    <DesktopLabel Version="1">
      <DYMOLabel Version="4">
        <Description>DYMO Label</Description>
        <Orientation>Landscape</Orientation>
        <LabelName>Small30346</LabelName>
        <InitialLength>0</InitialLength>
        <BorderStyle>SolidLine</BorderStyle>
        <DYMORect>
          <DYMOPoint>
            <X>0.22666666</X>
            <Y>0.056666665</Y>
          </DYMOPoint>
          <Size>
            <Width>1.59</Width>
            <Height>0.4033333</Height>
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
                <DataString>${generatedCode}</DataString>
              </Data>
              <HorizontalAlignment>Center</HorizontalAlignment>
              <VerticalAlignment>Middle</VerticalAlignment>
              <Size>AutoFit</Size>
              <TextPosition>Bottom</TextPosition>
              <FontInfo>
                <FontName>Arial</FontName>
                <FontSize>8</FontSize>
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
                  <X>0.22666667</X>
                  <Y>0.06666668</Y>
                </DYMOPoint>
                <Size>
                  <Width>1.3885133</Width>
                  <Height>0.39078796</Height>
                </Size>
              </ObjectLayout>
            </BarcodeObject>
          </LabelObjects>
        </DynamicLayoutManager>
      </DYMOLabel>
      <LabelApplication>Blank</LabelApplication>
      <DataTable>
        <Columns></Columns>
        <Rows></Rows>
      </DataTable>
    </DesktopLabel>`;

    (async () => {
      const labelPath = `labels/location_${Date.now()}.dymo`;
      const blob = new Blob([latestLocationDymoXml], { type: "application/octet-stream" });

      const { error: uploadError } = await supabase.storage
        .from("dymo-labels")
        .upload(labelPath, blob, { upsert: true });

      if (uploadError) {
        console.error("Failed to upload location DYMO file early:", uploadError);
        return;
      }

      const { data: signedData, error: urlError } = await supabase.storage
        .from("dymo-labels")
        .createSignedUrl(labelPath, 60 * 60 * 24 * 365 * 10);

      if (urlError) {
        console.error("Failed to get signed URL for location DYMO file:", urlError);
        return;
      }

      latestLocationDymoUrl = signedData.signedUrl;

      const linkContainer = document.getElementById("dymo-link-preview");
      if (linkContainer) {
        linkContainer.innerHTML = `<a href="${latestLocationDymoUrl}" target="_blank">View DYMO Label</a>`;
      }
    })();
  }

  function setupAddLocationModalListeners() {
    const modal = document.getElementById("modal-add-location");
    const form = document.getElementById("form-add-location");
    const cancelBtn = document.getElementById("btn-cancel-location");
    const nameInput = document.getElementById("location-name");
    const barcodeInput = document.getElementById("location-barcode");
    const capacityInput = document.getElementById("location-capacity");
    const photoInput = document.getElementById("location-photo");
    const previewWrapper = document.getElementById("photo-preview-wrapper");
    const previewImage = document.getElementById("photo-preview-image");
    const notesInput = document.getElementById("location-notes");
    const storeSelect = document.getElementById("location-store");
    const generateBtn = document.getElementById("btn-generate-location-barcode");

    if (!modal || !form || form.dataset.bound === "true") return;
    form.dataset.bound = "true";
    populateLocationStoreSelect();

    photoInput?.addEventListener("change", () => {
      const file = photoInput.files?.[0];
      if (!file) {
        previewWrapper.classList.add("hidden");
        previewImage.src = "";
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        previewImage.src = event.target.result;
        previewWrapper.classList.remove("hidden");
      };
      reader.readAsDataURL(file);
    });

    let activeTypeDropdown = null;
    document.addEventListener("click", async (event) => {
      if (event.target.id !== "location-type-dropdown-toggle") return;

      const button = event.target;
      const menu = document.getElementById("location-type-dropdown-menu");

      if (activeTypeDropdown && activeTypeDropdown !== menu) {
        activeTypeDropdown.classList.remove("show");
      }

      if (!menu.dataset.populated) {
        const types = await fetchUniqueLocationTypes();
        renderDropdownOptionsCustom({
          menuId: "location-type-dropdown-menu",
          toggleButtonId: "location-type-dropdown-toggle",
          hiddenInputId: "location-type",
          options: types,
          searchId: "location-type-search",
          placeholder: "Search or create location type...",
          optionClass: "dropdown-option",
          dataAttribute: "type",
          optionsContainerClass: "location-type-dropdown-container",
          onClick: (value, isNew) => {
            document.getElementById("location-type").value = value;
            button.innerText = value;
            showToast(isNew ? `Created new type: ${value}` : `Selected type: ${value}`);
            menu.classList.remove("show");
            activeTypeDropdown = null;
          }
        });
        menu.dataset.populated = "true";
      }

      menu.classList.toggle("show");
      activeTypeDropdown = menu.classList.contains("show") ? menu : null;
    });

    generateBtn?.addEventListener("click", generateAndRenderLocationBarcode);
    cancelBtn?.addEventListener("click", () => toggleAddLocationModal(false));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const location_name = nameInput.value.trim();
      const location_code = barcodeInput.value.trim();
      const max_capacity = capacityInput.value.trim();
      const notes = notesInput.value.trim();
      const photoFile = photoInput.files?.[0] || null;
      const store_id = storeSelect?.value?.trim() || null;

      if (!location_name || !location_code) {
        showToast("Name and barcode are required.");
        return;
      }

      if (activeStoreOptions.length > 0 && !store_id) {
        showToast("Select a store for this location.");
        return;
      }

      showToast("Uploading...");

      let photo_url = null;
      let dymo_label_url = null;

      if (latestLocationDymoXml) {
        const labelPath = `labels/location_${Date.now()}.dymo`;
        const blob = new Blob([latestLocationDymoXml], { type: "application/octet-stream" });

        const { error: uploadError } = await supabase.storage
          .from("dymo-labels")
          .upload(labelPath, blob, { upsert: true });

        if (!uploadError) {
          const { data: signedData, error: urlError } = await supabase.storage
            .from("dymo-labels")
            .createSignedUrl(labelPath, 60 * 60 * 24 * 365 * 10);

          if (!urlError) {
            dymo_label_url = signedData.signedUrl;
          }
        }
      }

      if (photoFile) {
        const { data, error } = await supabase.storage
          .from("location-assets")
          .upload(`photos/${Date.now()}_${photoFile.name}`, photoFile);

        if (error) {
          showToast("Failed to upload photo.");
          return;
        }

        photo_url = data.path;
      }

      const { data: insertedLocation, error: insertError } = await supabase
        .from("locations")
        .insert({
          location_name,
          location_code,
          max_capacity: max_capacity ? parseInt(max_capacity, 10) : null,
          notes,
          active: true,
          photo_url,
          dymo_label_url,
          store_id,
          type: document.getElementById("location-type").value || null,
          created_at: new Date().toISOString()
        })
        .select("id, location_name")
        .single();

      if (insertError || !insertedLocation) {
        console.error("Error inserting location:", insertError);
        showToast("Failed to save location.");
        return;
      }

      showToast("Location saved!");
      toggleAddLocationModal(false);
      await populateAdminLocationDropdown(insertedLocation.location_name);
      setSelectedAdminLocation(insertedLocation.location_name);

      const quantityInput = document.getElementById("admin-stock-quantity");
      quantityInput?.focus();
      quantityInput?.select?.();
    });
  }

  //event listeners for the modal and other logic
  function setupAdminLocationModalListeners() {
    const confirmBtn = document.getElementById("btn-confirm-admin-stock");
    const cancelBtn = document.getElementById("btn-cancel-admin-stock");

    cancelBtn.onclick = () => {
      document.getElementById("modal-admin-assign-location").classList.add("hidden");
    };

    confirmBtn.onclick = async () => {
      const barcode = document.getElementById("scanned-barcode")?.value || "temp-barcode";
      const locationName = document.getElementById("admin-location-name").value.trim();
      const quantity = parseInt(document.getElementById("admin-stock-quantity").value.trim(), 10);

      if (!locationName || isNaN(quantity)) {
        showToast("❌ Please select a location and enter quantity.");
        return;
      }

      const { data: loc, error } = await supabase
        .from("locations")
        .select("id")
        .eq("location_name", locationName)
        .single();

      if (error || !loc) {
        showToast("❌ Location not found.");
        return;
      }

      // Save for later use
      pendingStockAssignments[barcode] = {
        location_name: locationName,
        quantity,
        location_id: loc.id
      };

      // ⬇️ Show assignment preview in the main form
      const previewBox = document.getElementById("assignment-preview-box");
      document.getElementById("assignment-location").textContent = `📍 Location: ${locationName}`;
      document.getElementById("assignment-quantity").textContent = `📦 Quantity: ${quantity}`;
      previewBox.classList.remove("hidden");


      showToast(`📦 Will assign ${quantity} to ${locationName} after item is saved`);
      document.getElementById("modal-admin-assign-location").classList.add("hidden");
    };

  }

  //location dropdown only opening for admins
  async function populateAdminLocationDropdown(selectedValue = "") {
    activeStoreOptions = activeStoreOptions.length ? activeStoreOptions : await fetchActiveStores();
    activeAdminLocationOptions = await fetchAdminLocationOptions();
    buildAdminLocationDropdownShell();
    populateAdminLocationStoreFilter(activeAdminLocationOptions);
    renderAdminLocationDropdownOptions(document.getElementById("admin-location-dropdown-search")?.value || "");

    if (selectedValue) {
      setSelectedAdminLocation(selectedValue);
    }
  }

  //allow the thing to be opened
  function setupAdminStockOpenButton() {
    document.getElementById("btn-open-admin-stock")?.addEventListener("click", () => {
      showAdminLocationStockModal("-1");
    });
  }

  //event listener for the dropdown in the moddal
  function setupAdminLocationDropdownToggle() {
    document.addEventListener("click", (e) => {
      if (e.target.id === "admin-location-dropdown-toggle") {
        const menu = document.getElementById("admin-location-dropdown-menu");
        menu.classList.toggle("show");
      }
    });
  }

  function setupAdminLocationModalListeners() {
    const confirmBtn = document.getElementById("btn-confirm-admin-stock");
    const cancelBtn = document.getElementById("btn-cancel-admin-stock");
    const storeFilter = document.getElementById("admin-location-store-filter");

    cancelBtn.onclick = () => {
      document.getElementById("modal-admin-assign-location").classList.add("hidden");
    };

    storeFilter?.addEventListener("change", () => {
      const searchInput = document.getElementById("admin-location-dropdown-search");
      renderAdminLocationDropdownOptions(searchInput?.value || "");
    });

    confirmBtn.onclick = async () => {
      const barcode = document.getElementById("scanned-barcode")?.value || "temp-barcode";
      const locationId = document.getElementById("admin-location-id").value.trim();
      const locationName = document.getElementById("admin-location-name").value.trim();
      const quantity = parseInt(document.getElementById("admin-stock-quantity").value.trim(), 10);

      if (!locationId || !locationName || isNaN(quantity)) {
        showToast("Please select a location and enter quantity.");
        return;
      }

      const location = selectedAdminLocation || activeAdminLocationOptions.find((entry) => entry.id === locationId);
      if (!location) {
        showToast("Location not found.");
        return;
      }

      pendingStockAssignments[barcode] = {
        location_name: location.name,
        quantity,
        location_id: location.id
      };

      const previewBox = document.getElementById("assignment-preview-box");
      document.getElementById("assignment-location").textContent = `Location: ${getAdminLocationLabel(location)}`;
      document.getElementById("assignment-quantity").textContent = `Quantity: ${quantity}`;
      previewBox.classList.remove("hidden");

      showToast(`Will assign ${quantity} to ${location.name} after item is saved`);
      document.getElementById("modal-admin-assign-location").classList.add("hidden");
    };
  }

  //== run the add location modal only if the user is an admin
  if (window.currentUser && window.currentUser.user_metadata?.role === "admin") {
    setupAdminLocationModalListeners();
  }

//#endregion

// === FORM SUBMIT ===
document.getElementById("add-item-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  // Check category selection
  const categoryValue = document.getElementById("category").value.trim();
  if (!categoryValue) {
    showToast("❌ Please select or create a category.");
    return;
  }

  // Check DYMO label generation
  if (!window.latestDymoUrl || typeof window.latestDymoUrl !== "string" || !window.latestDymoUrl.includes("labels/")) {
    showToast("❌ Please generate the DYMO label before submitting.");
    return;
  }

  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const weight = parseFloat(document.getElementById("weight").value);
  const price_per_weight = parseFloat(pricePerWeightInput?.value || "0");
  // force sync dropdown selection into hidden input if user typed or skipped selection
  const categoryButton = document.getElementById("category-dropdown-toggle");
  const categoryHiddenInput = document.getElementById("category");
  if (!categoryHiddenInput.value && categoryButton.innerText !== "Select or Create Category") {
    categoryHiddenInput.value = categoryButton.innerText.trim();
  }
  const categoryInput = document.getElementById("category").value.trim();
  const categories = categoryInput ? [categoryInput] : [];
  const cost = parseFloat(document.getElementById("cost").value.replace(/,/g, ''));
  const sale_price = parseFloat(document.getElementById("sale-price").value.replace(/,/g, ''));
  const distributor_name = document.getElementById("distributor-name").value.trim();
  const distributor_phone = document.getElementById("distributor-phone").value.trim();
  const distributor_notes = document.getElementById("distributor-notes").value.trim();
  const qr_code = document.getElementById("qr-code").value.trim();
  const barcode = barcodeInput.value;

  const photoFiles = photoInput.files;
  const photoUrls = [];
  const assistedSelectedImages = window.addItemAssistedModule?.getSelectedUploadedImagesForSave?.() || [];
  const photoStatus = document.getElementById("photo-status");
  photoStatus.innerHTML = "";

  for (const file of photoFiles) {
    const path = `item_photos/${Date.now()}_${file.name}`;

    const { error: uploadError } = await supabase
      .storage
      .from('photos')
      .upload(path, file, { upsert: true });

    if (uploadError) {
      console.error(`Upload photo failed for ${file.name}:`, uploadError.message);
      photoStatus.innerHTML += `❌ Failed to upload <strong>${file.name}</strong>: ${uploadError.message}<br>`;
      continue;
    }

    // ✅ Store only the path, not signed URL
    photoUrls.push(path);
    photoStatus.innerHTML += `✅ Uploaded <strong>${file.name}</strong><br>`;
  }

  const seenAssistedSources = new Set();
  for (let index = 0; index < assistedSelectedImages.length; index += 1) {
    const assistedImage = assistedSelectedImages[index];
    const dedupeKey = `${assistedImage?.storageBucket || ""}:${assistedImage?.path || ""}`;

    if (!assistedImage?.path || seenAssistedSources.has(dedupeKey)) {
      continue;
    }

    seenAssistedSources.add(dedupeKey);

    try {
      const copiedPath = await copyAssistedImageToPhotosBucket(assistedImage, index);
      photoUrls.push(copiedPath);
      photoStatus.innerHTML += `? Included assisted image <strong>${assistedImage.name || copiedPath}</strong><br>`;
    } catch (assistedError) {
      console.error(`Assisted image copy failed for ${assistedImage?.path}:`, assistedError);
      photoStatus.innerHTML += `? Failed to include assisted image <strong>${assistedImage?.name || assistedImage?.path || `#${index + 1}`}</strong>: ${assistedError.message || assistedError}<br>`;
    }
  }

  const finalPhotoPaths = [...new Set(photoUrls.filter(Boolean))];

  let finalDymoPath;
  try {
    finalDymoPath = await dymoModule.uploadFinalDymoLabel();
  } catch (err) {
    alert(`❌ Failed to upload DYMO label: ${err.message || err}`);
    return;
  }


  const { data: insertedItems, error } = await supabase
    .from("item_types")
    .insert({
      title,
      description,
      weight,
      price_per_weight,
      categories,
      cost,
      sale_price,
      distributor_name,
      distributor_phone,
      distributor_notes,
      qr_type: typeqr,
      qr_code,
      barcode,
      photos: finalPhotoPaths,
      dymo_label_url: window.latestDymoUrl || "",
      added_by: currentUser.id,              // ✅ NEW: track user ID
      added_by_email: currentUser.email      // ✅ NEW: track user email
    })
    .select()
    .limit(1);

  if (error || !insertedItems || insertedItems.length === 0) {
    alert("Failed to save item: " + (error?.message || "Unknown error"));
    return;
  }

  const newItem = insertedItems[0];

// Hoisted so we can check it later (outside the try)
let bulkRes = null;

// Save a bulk registry row if the modal captured data
try {
  // Create a bag-specific barcode (ephemeral; retired when bag is empty)
  const bagBarcode =
    window.addItemBulkModule?.generateBagBarcode?.() ||
    `BAG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

  const locationId = pendingStockAssignments[newItem.barcode]?.location_id || null;

  // ⬅️ assign into the hoisted variable
  bulkRes = await window.addItemBulkModule.saveRegistryForItem(newItem.id, bagBarcode, locationId);

  if (bulkRes?.error) {
    showToast("⚠️ Item saved, but bulk registry failed.");
    console.warn(bulkRes.error);
  } else if (!bulkRes?.skipped) {
    showToast(`✅ Bulk registry saved. Bag barcode: ${bagBarcode}`);
  }
} catch (err) {
  console.warn("Bulk registry insert error:", err);
}

const stockInfo = pendingStockAssignments[newItem.barcode];

// Only do the generic stock write if we did NOT do a per-bag save
if (stockInfo && (bulkRes?.skipped === true))  {
  const stockInsert = await supabase.from("item_stock_locations").insert({
    item_id: newItem.id,
    location_id: stockInfo.location_id,
    quantity: stockInfo.quantity,
    added_by: currentUser.id,
    confirmation_email: currentUser.email,
    confirmed_at: new Date().toISOString()
  });

  const stockLog = await supabase.from("stock_transactions").insert({
    item_id: newItem.id,
    location_id: stockInfo.location_id,
    quantity: stockInfo.quantity,
    action_type: "checkin",
    method: "unverified",  // ✅ new: set the method
    email: window.currentUser?.email,  // ✅ new: log who did it
    user_id: currentUser.id,
    timestamp: new Date().toISOString()
  });

  if (stockInsert.error || stockLog.error) {
    console.warn("⚠️ Stock added but not logged properly:", stockInsert.error, stockLog.error);
    showToast("⚠️ Stock saved, but transaction log might be missing.");
  } else {
    showToast(`✅ Saved ${stockInfo.quantity} units to ${stockInfo.location_name}`);
  }

  // Clean up
  delete pendingStockAssignments[newItem.barcode];
}

  alert("✅ Item successfully added!");

  document.getElementById("add-item-form").reset();
  document.dispatchEvent(new Event("add-item-form:reset"));
  previewContainer.innerHTML = "";
  uploadedImages = [];
  latestDymoXml = "";
  pricePerWeightInput.value = "";
  autoCostCheckbox.checked = true;
  await bumpInventoryVersion();
});

// === DOM Loader ===
document.addEventListener("DOMContentLoaded", async () => {
  await waitForSupabaseInit(); // ✅ Supabase is initialized

  try {
    const { data, error } = await supabase.auth.getUser();
    const user = data?.user;

    if (error || !user) {
      alert("Please log in to access this page.");
      window.location.href = "index.html";
      return;
    }

    const employee = await loadActiveInventoryWorker(user.id);
    if (!employee) {
      alert("You must be an active worker to access this page.");
      window.location.href = "worker-dashboard.html";
      return;
    }

    window.currentUser = user;
    document.getElementById("btn-open-admin-stock")?.classList.remove("hidden");
    setupAdminLocationModalListeners();
    setupAddLocationModalListeners();
  } catch (err) {
    alert("Authentication error. Please try logging in again.");
    console.error("❌ Auth error:", err);
    window.location.href = "index.html";
  }

  //addition of important event listeners
  window.addItemBulkModule.setupBulkModalOpeners();
  setupCostAndPriceListeners();
  setupPhotoUploadPreview();
  setupBarcodeGeneration();
  setupAdminStockOpenButton();
  setupAdminLocationDropdownToggle();
  setupCategoryDropdownToggle();
  dymoModule.setupGenerateDymoButtonListener();
});
