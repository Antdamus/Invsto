
let pendingItem = null; // Store the scanned item awaiting confirmation
let currentBatch = {}; 
let latestLocationDymoXml = null;
let latestLocationDymoUrl = null;
let pendingBulkItem = null; // item selected for a bulk bag
let activeStoreOptions = [];
let activeAssignLocationOptions = [];
let selectedAssignLocation = null;
let selectedAssignParentLocation = null;
let assignPlacementMode = "tray";
const assignPlacementScanTimers = {};
let pendingAssignLocationDraft = null;
let pendingInventoryLabelPrintState = null;

function escapeLocationDymoXml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatLocationDymoName(locationName, fallback = "LOCATION") {
  const text = String(locationName || "").trim() || String(fallback || "").trim() || "LOCATION";
  return text.toLocaleUpperCase("en-US");
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
                  <BarcodeFormat>Code128Auto</BarcodeFormat>
                  <Data><DataString>${safeLocationCode}</DataString></Data>
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
                    <FontBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></FontBrush>
                  </FontInfo>
                  <ObjectLayout>
                    <DYMOPoint><X>0.34072876</X><Y>0.1641666</Y></DYMOPoint>
                    <Size><Width>2.8185425</Width><Height>0.68583345</Height></Size>
                  </ObjectLayout>
                </BarcodeObject>
                <TextObject>
                  <Name>TextObject0</Name>
                  <Brushes>
                    <BackgroundBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"></Color></SolidColorBrush></BackgroundBrush>
                    <BorderBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></BorderBrush>
                    <StrokeBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></StrokeBrush>
                    <FillBrush><SolidColorBrush><Color A="0" R="0" G="0" B="0"></Color></SolidColorBrush></FillBrush>
                  </Brushes>
                  <Rotation>Rotation0</Rotation>
                  <OutlineThickness>1</OutlineThickness>
                  <IsOutlined>False</IsOutlined>
                  <BorderStyle>SolidLine</BorderStyle>
                  <Margin><DYMOThickness Left="0" Top="0" Right="0" Bottom="0" /></Margin>
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
                          <FontBrush><SolidColorBrush><Color A="1" R="0" G="0" B="0"></Color></SolidColorBrush></FontBrush>
                        </FontInfo>
                      </TextSpan>
                    </LineTextSpan>
                  </FormattedText>
                  <ObjectLayout>
                    <DYMOPoint><X>0.9475001</X><Y>0.7875004</Y></DYMOPoint>
                    <Size><Width>1.6050003</Width><Height>0.2691668</Height></Size>
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

//update the inventory after adding items
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

//#region full logic to what will be done once the item reaches its limit
  //function to turn on and off the autofocus and the input of adding items by barcode
  function updateBarcodeInputStateBasedOnModals() {
    const barcodeInput = document.getElementById("input-to-search-inventory-item");
    const anyModalOpen = Array.from(document.querySelectorAll(".modal"))
      .some(modal => !modal.classList.contains("hidden"));
  
    // Prevent background scroll
    if (anyModalOpen) {
      document.body.classList.add("modal-open");
    } else {
      document.body.classList.remove("modal-open");
    }
  
    barcodeInput.disabled = anyModalOpen;
    if (!anyModalOpen) {
      barcodeInput.focus();
    }
  }

  //fetch unique location barcode
  async function fetchUniqueLocationBarcodes() {
    const { data, error } = await supabase
      .from("locations")
      .select("location_code")
      .neq("location_code", null);
  
    if (error) {
      console.error("❌ Failed to fetch location barcodes:", error);
      return [];
    }
  
    const uniqueCodes = [...new Set(data.map(row => row.location_code).filter(Boolean))];
    return uniqueCodes.sort((a, b) => a.localeCompare(b));
  }  
  
  //function to fetch the unique location types from the lcoation tables 
  async function fetchUniqueLocationTypes() {
    const { data, error } = await supabase
      .from("locations")
      .select("type")
      .neq("type", null);
  
    if (error) {
      console.error("❌ Failed to fetch location types:", error);
      return [];
    }
  
    const uniqueTypes = [...new Set(data.map(row => row.type).filter(Boolean))];
    return uniqueTypes.sort((a, b) => a.localeCompare(b));
  }
  
  // ✅ Updated to pull from the `locations` table
  async function fetchUniqueLocationNames() {
    const { data, error } = await supabase
      .from("locations")
      .select("location_name")
      .eq("active", true); // optional: only include active locations

    if (error || !data) {
      console.error("❌ Failed to fetch location names from `locations`:", error);
      return [];
    }

    const unique = [...new Set(data.map(row => row.location_name).filter(Boolean))];
    return unique.sort((a, b) => a.localeCompare(b)); // alphabetical
  }

  async function fetchActiveStores() {
    const { data, error } = await supabase
      .from("store_locations")
      .select("id, name, active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      console.error("Failed to fetch stores:", error);
      return [];
    }

    return Array.isArray(data) ? data : [];
  }

  async function populateLocationStoreSelect() {
    const select = document.getElementById("location-store");
    if (!select) return [];

    activeStoreOptions = await fetchActiveStores();
    select.innerHTML = ['<option value="">Select Store</option>']
      .concat(activeStoreOptions.map((store) => `<option value="${store.id}">${store.name}</option>`))
      .join("");

    return activeStoreOptions;
  }

  function resetAssignLocationDropdownState() {
    const ids = [
      "assign-location-name-dropdown-menu",
      "assign-location-barcode-dropdown-menu",
    ];

    ids.forEach((id) => {
      const menu = document.getElementById(id);
      if (!menu) return;
      menu.dataset.populated = "";
      menu.classList.remove("show");
      menu.innerHTML = "";
    });
  }

  function resetAssignLocationSelection() {
    selectedAssignLocation = null;
    selectedAssignParentLocation = null;
    const idInput = document.getElementById("assign-location-id");
    const nameInput = document.getElementById("assign-location-name");
    const barcodeInput = document.getElementById("assign-location-barcode");
    const nameToggle = document.getElementById("assign-location-name-dropdown-toggle");
    const barcodeToggle = document.getElementById("assign-location-barcode-dropdown-toggle");
    const summary = document.getElementById("assign-location-selection-summary");

    if (idInput) idInput.value = "";
    if (nameInput) nameInput.value = "";
    if (barcodeInput) barcodeInput.value = "";
    if (nameToggle) nameToggle.innerText = "Select Location Name";
    if (barcodeToggle) barcodeToggle.innerText = "Select Barcode";
    if (summary) summary.textContent = "Scan a destination barcode to see the storage snapshot.";
    renderLocationIntelligenceEmpty("assign-location-intelligence");
  }

  function getAssignLocationLabel(location) {
    if (!location) return "selected location";
    const name = location.name || location.location_name || "";
    const code = location.code || location.location_code || "";
    return code ? `${name} (${code})` : name || code || "selected location";
  }

  function getAssignLocationStoreLabel(location) {
    if (!location) return "";
    return isTrayAssignLocation(location) ? location.currentStoreName : location.storeName;
  }

  function setAssignLocationSelection(location = null) {
    const legacyLocation = location && !location.id && (location.locationName || location.locationCode)
      ? {
          id: "",
          name: location.locationName || "",
          code: location.locationCode || "",
          type: "",
          storeName: "",
          currentStoreName: "",
        }
      : null;
    const locationObject = legacyLocation || (typeof location === "string"
      ? activeAssignLocationOptions.find((entry) => entry.id === location || entry.name === location || entry.code === location) || null
      : location);
    selectedAssignLocation = locationObject || null;
    const idInput = document.getElementById("assign-location-id");
    const nameInput = document.getElementById("assign-location-name");
    const barcodeInput = document.getElementById("assign-location-barcode");
    const nameToggle = document.getElementById("assign-location-name-dropdown-toggle");
    const barcodeToggle = document.getElementById("assign-location-barcode-dropdown-toggle");
    const summary = document.getElementById("assign-location-selection-summary");
    const locationName = locationObject?.name || locationObject?.location_name || "";
    const locationCode = locationObject?.code || locationObject?.location_code || "";
    const storeName = getAssignLocationStoreLabel(locationObject);
    const typeName = locationObject?.type || "";

    if (idInput) idInput.value = locationObject?.id || "";
    if (nameInput) nameInput.value = locationName || "";
    if (barcodeInput) barcodeInput.value = locationCode || "";
    if (nameToggle) nameToggle.innerText = locationName || "Select Location Name";
    if (barcodeToggle) barcodeToggle.innerText = locationCode || "Select Barcode";
    if (summary) {
      summary.textContent = locationObject
        ? [
            locationCode ? `Barcode: ${locationCode}` : "",
            storeName ? `Store: ${storeName}` : "",
            typeName ? `Type: ${typeName}` : "",
          ].filter(Boolean).join(" | ")
        : "Scan a destination barcode to see the storage snapshot.";
    }

    if (locationObject?.id) {
      const barcode = document.getElementById("modal-assign-location")?.dataset?.barcode || "";
      const batchItem = currentBatch[barcode];
      renderLocationIntelligence("assign-location-intelligence", locationObject.id, {
        referenceWeight: Number(batchItem?.item?.weight),
        referenceLabel: batchItem?.item?.title || "this item",
      });
    } else {
      renderLocationIntelligenceEmpty("assign-location-intelligence");
    }
  }

  async function populateAssignLocationStoreFilter(selectedStoreId = "") {
    const select = document.getElementById("assign-location-store");
    if (!select) return [];

    const stores = activeStoreOptions.length > 0 ? activeStoreOptions : await fetchActiveStores();
    activeStoreOptions = stores;

    select.innerHTML = ['<option value="">All Stores</option>']
      .concat(stores.map((store) => `<option value="${store.id}">${store.name}</option>`))
      .join("");

    if (selectedStoreId && stores.some((store) => store.id === selectedStoreId)) {
      select.value = selectedStoreId;
    } else {
      select.value = "";
    }

    return stores;
  }

  async function getCurrentInventoryUserIdentity() {
    const existingUser = window.currentUser || null;
    if (existingUser?.id || existingUser?.email) {
      return {
        id: existingUser.id || "",
        email: existingUser.email || "",
      };
    }

    try {
      const { data, error } = await supabase.auth.getUser();
      if (error) throw error;
      const user = data?.user || null;
      return {
        id: user?.id || "",
        email: user?.email || "",
      };
    } catch (error) {
      console.warn("Could not resolve current user for store default:", error);
      return { id: "", email: "" };
    }
  }

  async function fetchStoreIdForLocationId(locationId) {
    if (!locationId) return "";

    const { data, error } = await supabase
      .from("locations")
      .select("store_id")
      .eq("id", locationId)
      .maybeSingle();

    if (error) {
      console.warn("Could not resolve store for last stock location:", error);
      return "";
    }

    return data?.store_id ? String(data.store_id) : "";
  }

  async function fetchLastStockPlacementStoreIdForCurrentUser() {
    const identity = await getCurrentInventoryUserIdentity();
    if (!identity.id && !identity.email) return "";

    const applyUserFilter = (query) => {
      if (identity.id) return query.eq("user_id", identity.id);
      return query.eq("email", identity.email);
    };

    let query = supabase
      .from("stock_transactions")
      .select("location_id, timestamp, confirmed_at, locations(store_id)")
      .eq("action_type", "checkin")
      .gt("quantity", 0)
      .not("location_id", "is", null)
      .order("timestamp", { ascending: false })
      .limit(25);

    let { data, error } = await applyUserFilter(query);

    if (error) {
      console.warn("Could not fetch last user stock placement with store relation:", error);
      query = supabase
        .from("stock_transactions")
        .select("location_id, timestamp, confirmed_at")
        .eq("action_type", "checkin")
        .gt("quantity", 0)
        .not("location_id", "is", null)
        .order("timestamp", { ascending: false })
        .limit(25);

      const fallback = await applyUserFilter(query);
      data = fallback.data;
      error = fallback.error;
    }

    if (error) {
      console.warn("Could not fetch last user stock placement:", error);
      return "";
    }

    for (const row of Array.isArray(data) ? data : []) {
      const relatedLocation = Array.isArray(row.locations) ? row.locations[0] : row.locations;
      const storeId = relatedLocation?.store_id || await fetchStoreIdForLocationId(row.location_id);
      if (storeId) return String(storeId);
    }

    return "";
  }

  async function fetchAssignableLocations(storeId = "") {
    let query = supabase
      .from("locations")
      .select("id, location_name, location_code, store_id, type, max_capacity, parent_location_id, location_role, is_tray, tray_current_store_id")
      .eq("active", true)
      .order("location_name", { ascending: true });

    if (storeId) {
      query = query.eq("store_id", storeId);
    }

    const { data, error } = await query;
    if (error) {
      console.error("Failed to fetch assignable locations:", error);
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
        parentId: String(location.parent_location_id || "").trim(),
        role: String(location.location_role || "").trim(),
        isTray: Boolean(location.is_tray),
        trayCurrentStoreId: String(location.tray_current_store_id || "").trim(),
        storeName: storeNameById.get(String(location.store_id || "")) || "No store assigned",
        currentStoreName: storeNameById.get(String(location.tray_current_store_id || "")) || storeNameById.get(String(location.store_id || "")) || "No store assigned",
        maxCapacity: Number(location.max_capacity) || null,
      }))
      .filter((location) => location.id && location.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  function isTrayAssignLocation(location) {
    return Boolean(location?.isTray) || String(location?.role || "").toLowerCase() === "tray";
  }

  function isContainerAssignLocation(location) {
    return !isTrayAssignLocation(location) && (
      String(location?.role || "").toLowerCase() === "container" || Boolean(location?.parentId)
    );
  }

  function isParentStorageAssignLocation(location) {
    return Boolean(location) && !isTrayAssignLocation(location) && !isContainerAssignLocation(location);
  }

  function findAssignLocationByBarcode(barcode, predicate = null) {
    const normalized = String(barcode || "").trim().toLowerCase();
    if (!normalized) return null;

    const matches = activeAssignLocationOptions.filter((location) => {
      const isCodeMatch = String(location.code || "").trim().toLowerCase() === normalized;
      return isCodeMatch && (!predicate || predicate(location));
    });

    return matches.length === 1 ? matches[0] : null;
  }

  function setAssignPlacementStepStatus(id, message, type = "info") {
    const element = document.getElementById(id);
    if (!element) return;

    element.textContent = message || "";
    element.classList.toggle("is-success", type === "success");
    element.classList.toggle("is-error", type === "error");
  }

  function setAssignPlacementStepState(stepId, state = "") {
    const step = document.getElementById(stepId);
    if (!step) return;
    step.classList.toggle("is-active", state === "active");
    step.classList.toggle("is-complete", state === "complete");
  }

  function focusAssignPlacementInput(id, options = {}) {
    const input = document.getElementById(id);
    if (!input) return;

    setTimeout(() => {
      if (options.scroll !== false) {
        input.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      input.focus({ preventScroll: true });
      input.select?.();
    }, options.delayMs ?? 80);
  }

  function focusAssignQuantityInput() {
    focusAssignPlacementInput("assign-location-quantity", { delayMs: 70 });
  }

  function resetAssignPlacementScanInputs() {
    Object.keys(assignPlacementScanTimers).forEach((key) => {
      clearTimeout(assignPlacementScanTimers[key]);
      delete assignPlacementScanTimers[key];
    });

    ["assign-placement-tray-barcode", "assign-placement-parent-barcode", "assign-placement-container-barcode"].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "";
    });

    selectedAssignParentLocation = null;
    setAssignPlacementStepStatus("assign-placement-tray-status", "Waiting for tray scan.");
    setAssignPlacementStepStatus("assign-placement-parent-status", "Scan the parent storage label first.");
    setAssignPlacementStepStatus("assign-placement-container-status", "Container must belong to the scanned parent.");
  }

  function syncAssignPlacementModeUI() {
    const flow = document.getElementById("assign-placement-scan-flow");
    const trayStep = document.getElementById("assign-placement-tray-step");
    const parentStep = document.getElementById("assign-placement-parent-step");
    const containerStep = document.getElementById("assign-placement-container-step");
    const isContainerMode = assignPlacementMode === "container";

    flow?.setAttribute("data-mode", assignPlacementMode);
    document.querySelectorAll("[data-assign-placement-mode]").forEach((button) => {
      const isActive = button.dataset.assignPlacementMode === assignPlacementMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-checked", isActive ? "true" : "false");
    });

    trayStep?.classList.toggle("hidden", isContainerMode);
    parentStep?.classList.toggle("hidden", !isContainerMode);
    containerStep?.classList.toggle("hidden", !isContainerMode);

    if (isContainerMode) {
      setAssignPlacementStepState("assign-placement-parent-step", "active");
      setAssignPlacementStepState("assign-placement-container-step", "");
      setAssignPlacementStepState("assign-placement-tray-step", "");
    } else {
      setAssignPlacementStepState("assign-placement-tray-step", "active");
      setAssignPlacementStepState("assign-placement-parent-step", "");
      setAssignPlacementStepState("assign-placement-container-step", "");
    }
  }

  function setAssignPlacementMode(mode = "tray", { clear = true, focus = true } = {}) {
    assignPlacementMode = mode === "container" ? "container" : "tray";
    try {
      window.localStorage?.setItem("og.addInventory.stockPlacementMode", assignPlacementMode);
    } catch (_) {}

    if (clear) {
      resetAssignLocationSelection();
      resetAssignPlacementScanInputs();
    }

    syncAssignPlacementModeUI();
    if (focus) {
      focusAssignPlacementInput(assignPlacementMode === "container" ? "assign-placement-parent-barcode" : "assign-placement-tray-barcode");
    }
  }

  function restoreAssignPlacementModePreference() {
    try {
      const saved = window.localStorage?.getItem("og.addInventory.stockPlacementMode");
      assignPlacementMode = saved === "container" ? "container" : "tray";
    } catch (_) {
      assignPlacementMode = "tray";
    }
  }

  function completeAssignTrayScan(location) {
    setAssignLocationSelection(location);
    setAssignPlacementStepState("assign-placement-tray-step", "complete");
    setAssignPlacementStepStatus(
      "assign-placement-tray-status",
      `Selected ${getAssignLocationLabel(location)}.`,
      "success"
    );
    focusAssignQuantityInput();
  }

  function completeAssignParentScan(location) {
    selectedAssignParentLocation = location;
    setAssignLocationSelection(null);
    setAssignPlacementStepState("assign-placement-parent-step", "complete");
    setAssignPlacementStepState("assign-placement-container-step", "active");
    setAssignPlacementStepStatus(
      "assign-placement-parent-status",
      `Parent confirmed: ${getAssignLocationLabel(location)}.`,
      "success"
    );
    setAssignPlacementStepStatus("assign-placement-container-status", "Now scan the container or bag inside that parent.");
    const containerInput = document.getElementById("assign-placement-container-barcode");
    if (containerInput) containerInput.value = "";
    focusAssignPlacementInput("assign-placement-container-barcode");
  }

  function completeAssignContainerScan(location) {
    setAssignLocationSelection(location);
    setAssignPlacementStepState("assign-placement-container-step", "complete");
    setAssignPlacementStepStatus(
      "assign-placement-container-status",
      `Container selected: ${getAssignLocationLabel(location)}.`,
      "success"
    );
    focusAssignQuantityInput();
  }

  function handleAssignTrayBarcodeScan(value) {
    const location = findAssignLocationByBarcode(value, isTrayAssignLocation);
    if (!location) {
      setAssignPlacementStepStatus("assign-placement-tray-status", "No active tray matched that barcode.", "error");
      setAssignLocationSelection(null);
      return false;
    }

    completeAssignTrayScan(location);
    return true;
  }

  function handleAssignParentBarcodeScan(value) {
    const location = findAssignLocationByBarcode(value, isParentStorageAssignLocation);
    if (!location) {
      setAssignPlacementStepStatus("assign-placement-parent-status", "No active parent storage matched that barcode.", "error");
      selectedAssignParentLocation = null;
      setAssignLocationSelection(null);
      setAssignPlacementStepState("assign-placement-parent-step", "active");
      setAssignPlacementStepState("assign-placement-container-step", "");
      return false;
    }

    completeAssignParentScan(location);
    return true;
  }

  function handleAssignContainerBarcodeScan(value) {
    if (!selectedAssignParentLocation?.id) {
      setAssignPlacementStepStatus("assign-placement-container-status", "Scan the parent storage barcode first.", "error");
      focusAssignPlacementInput("assign-placement-parent-barcode");
      return false;
    }

    const location = findAssignLocationByBarcode(value, (entry) => {
      return isContainerAssignLocation(entry) && String(entry.parentId || "") === String(selectedAssignParentLocation.id);
    });

    if (!location) {
      setAssignPlacementStepStatus("assign-placement-container-status", "No container matched that barcode under the scanned parent.", "error");
      setAssignLocationSelection(null);
      return false;
    }

    completeAssignContainerScan(location);
    return true;
  }

  function scheduleAssignBarcodeScan(input, handler) {
    if (!input || !handler) return;
    const value = input.value.trim();
    clearTimeout(assignPlacementScanTimers[input.id]);
    if (!value) return;
    assignPlacementScanTimers[input.id] = window.setTimeout(() => {
      handler(input.value.trim());
      delete assignPlacementScanTimers[input.id];
    }, 650);
  }

  function flushAssignBarcodeScan(input, handler) {
    if (!input || !handler) return;
    clearTimeout(assignPlacementScanTimers[input.id]);
    delete assignPlacementScanTimers[input.id];
    handler(input.value.trim());
  }

  function resetAssignPlacementFlow() {
    restoreAssignPlacementModePreference();
    resetAssignLocationSelection();
    resetAssignPlacementScanInputs();
    syncAssignPlacementModeUI();
  }

  function escapeHtml(value) {
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
    container.innerHTML = `<div class="location-intelligence-empty">${escapeHtml(message)}</div>`;
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
    const numericReferenceWeight = Number(referenceWeight);
    const similarItems = Number.isFinite(numericReferenceWeight)
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
      const similarTypeCount = data.similarItems.length;
      const similarItemCount = data.similarItems.reduce((sum, item) => sum + item.quantity, 0);
      const similarLabel = `${similarTypeCount} ${similarTypeCount === 1 ? "type" : "types"} / ${similarItemCount} total ${similarItemCount === 1 ? "item" : "items"} within 2 g`;
      const similarHtml = similarTypeCount
        ? data.similarItems.slice(0, 6).map((item) => `
            <div class="location-intelligence-row is-similar">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.barcode || "No barcode")} | Qty ${item.quantity}</span>
              </div>
              <div class="location-intelligence-weight">
                ${escapeHtml(formatLocationWeight(item.weight))}
                <small>${escapeHtml(item.delta.toFixed(2))} g off</small>
              </div>
            </div>
          `).join("")
        : `<div class="location-intelligence-muted">No items within 2 g of ${escapeHtml(referenceLabel)}.</div>`;
      const contentsHtml = data.items.length
        ? data.items.slice(0, 8).map((item) => `
            <div class="location-intelligence-row">
              <div>
                <strong>${escapeHtml(item.title)}</strong>
                <span>${escapeHtml(item.barcode || "No barcode")}</span>
              </div>
              <div class="location-intelligence-weight">
                Qty ${item.quantity}
                <small>${escapeHtml(formatLocationWeight(item.weight))}</small>
              </div>
            </div>
          `).join("")
        : '<div class="location-intelligence-muted">This location is currently empty.</div>';

      container.innerHTML = `
        <div class="location-intelligence-header">
          <div>
            <span>Storage Snapshot</span>
            <strong>${escapeHtml(data.location?.location_name || "Selected location")}</strong>
          </div>
          ${data.location?.location_code ? `<span class="location-intelligence-badge">${escapeHtml(data.location.location_code)}</span>` : ""}
        </div>
        <div class="location-intelligence-stats">
          <div><span>Unique Items</span><strong>${data.items.length}</strong></div>
          <div><span>Total Qty</span><strong>${data.totalQuantity}</strong></div>
          <div><span>Capacity</span><strong>${escapeHtml(capacityText)}</strong></div>
          <div><span>Est. Weight</span><strong>${escapeHtml(formatLocationWeight(data.approximateWeight))}</strong></div>
        </div>
        <div class="location-intelligence-section">
          <div class="location-intelligence-section-title">Similar Weight (±2 g) - ${escapeHtml(similarLabel)}</div>
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

  //function to transform the inputs into selected in case it is needed
  function syncHiddenInputsWithDropdowns() {
    const form = document.getElementById("filter-form");
    if (!form) return; // 🛑 Prevent crashing if filter-form is not present
    //const telecooll = new FormData(form);
    //console.log("🧾 Form Values from inside synchhindder:", telecooll.getAll("categories"))

    // 🔍 Log current state before clearing
    //console.log("🧹 Before clearing: categories =", [...form.querySelectorAll('input[name="categories"]')].map(i => i.value));
  
    // 🔁 Clear previous category inputs
    form.querySelectorAll('input[name="categories"]').forEach(el => el.remove());
    form.querySelectorAll('input[name="qr_type"]').forEach(el => el.remove());

    //let catInputCounter = 0;
  
    // ✅ Add back categories from selected dropdowns
    document.querySelectorAll(".dropdown-option.selected[data-cat]").forEach(el => {
      //catInputCounter++;
      //console.log(`📌 Hidden category input #${catInputCounter}: ${el.dataset.cat}`);
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "categories";
      input.value = el.dataset.cat;
      form.appendChild(input);
    });
    //catInputCounter = 0;
    // ✅ Add back QR types from selected dropdowns
    document.querySelectorAll(".dropdown-option.selected[data-qr]").forEach(el => {
      const input = document.createElement("input");
      input.type = "hidden";
      input.name = "qr_type";
      input.value = el.dataset.qr;
      form.appendChild(input);
    });
  
    // ✅ Log final result
    //console.log("✅ After sync: categories =", [...form.querySelectorAll('input[name="categories"]')].map(i => i.value));
  }
    
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
    options = [],
    searchId = "category-search",
    placeholder = "Search...",
    optionClass = "dropdown-option",
    dataAttribute = "cat",
    optionsContainerClass = "dropdown-options-container",
    onClick,  // 🔥 REQUIRED: handler for both new and existing options
    showHTMLInjected = true // 🆕 Optional debug flag
  }) {
    const menu = document.getElementById(menuId);
    if (!menu) return;
  
    const searchHTML = `
      <div class="dropdown-search-container">
        <input type="text" id="${searchId}" class="dropdown-search" placeholder="${placeholder}">
      </div>
    `;
  
    const optionsHTML = `
      <div class="${optionsContainerClass}">
        ${options.map(opt => `
          <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
        `).join("")}
      </div>
    `;
  
    const fullHTML = searchHTML + optionsHTML;
  
    if (showHTMLInjected) {
      console.log("🧪 [renderDropdownOptionsCustom] Injected HTML for", menuId);
      console.log(fullHTML);
      debugger;
    }
  
    menu.innerHTML = fullHTML;
  
    const input = menu.querySelector(`#${searchId}`);
    const container = menu.querySelector(`.${optionsContainerClass}`);
  
    const attachClickHandlers = () => {
      container.querySelectorAll(`.${optionClass}[data-${dataAttribute}]`).forEach(optionEl => {
        optionEl.addEventListener("click", () => {
          const value = optionEl.dataset.value;
          const isNew = optionEl.dataset.new === "true";
          syncHiddenInputsWithDropdowns();
          if (typeof onClick === "function") {
            onClick(value, isNew, optionEl);
          }
        });
      });
    };
  
    attachClickHandlers();
  
    input.addEventListener("input", (e) => {
      const search = e.target.value.toLowerCase();
      const filtered = options.filter(opt =>
        opt.toLowerCase().includes(search)
      );
  
      let html = filtered.map(opt => `
        <div class="${optionClass}" data-${dataAttribute}="${opt}" data-value="${opt}">${opt}</div>
      `).join("");
  
      const exactMatch = options.some(opt => opt.toLowerCase() === search);
  
      if (search && !exactMatch) {
        html += `
          <div class="${optionClass} new-entry" data-${dataAttribute}="${search}" data-value="${search}" data-new="true">
            ➕ Create "${search}"
          </div>
        `;
      }
  
      container.innerHTML = html;
      attachClickHandlers();
    });
  }
  
  //function to populate the dropdown 
  async function populateLocationDropdown() {
    const options = await fetchUniqueLocationNames();
    renderDropdownOptionsCustom({
      menuId: "location-dropdown-list",
      options,
      searchId: "location-dropdown-search", // ✅ you'll add this ID to the search input
      placeholder: "Search or select location...",
      optionClass: "location-option",         // CSS class for styling
      dataAttribute: "location",              // Used for dataset.location
      optionsContainerClass: "location-options-container", // for styling
      onClick: (value, isNew, el) => {
        if (isNew) {
          document.getElementById("location-name").value = value;
          toggleModal(true); // 🔁 Use this instead of manual classList.remove
          return;
        }
      
        document.getElementById("location-dropdown-search").value = value;
        showToast(`📦 Location selected: ${value}`);
      }
    });
  }

  //function to show the modal for add location 
  // 🪄 Open/close modal with optional barcode generation
  async function toggleModal(show = true, preset = {}) {
    const modal = document.getElementById("modal-add-location");
    const nameInput = document.getElementById("location-name");
    const storeSelect = document.getElementById("location-store");
    const capacityInput = document.getElementById("location-capacity");
    const capacityNoLimitInput = document.getElementById("location-capacity-no-limit");
  
    if (show) {
      const effectivePreset = (preset && (preset.locationName || preset.storeId))
        ? preset
        : (pendingAssignLocationDraft || {});

      modal.classList.remove("hidden");
      updateBarcodeInputStateBasedOnModals();
      await populateLocationStoreSelect();
      if (capacityNoLimitInput) capacityNoLimitInput.checked = true;
      if (capacityInput) {
        capacityInput.value = "";
        capacityInput.disabled = true;
        capacityInput.placeholder = "No limit";
      }
      nameInput.value = effectivePreset.locationName || nameInput.value || "";
      if (storeSelect) {
        storeSelect.value = effectivePreset.storeId || storeSelect.value || "";
      }
      nameInput.focus();
      generateAndRenderLocationBarcode();
    } else {
      modal.classList.add("hidden");
      updateBarcodeInputStateBasedOnModals();
      clearForm();
    }
  }
  
  
  //function to coordinate the display of the assign location modal 
  async function showAssignLocationModal(batchItem) {
    const modal = document.getElementById("modal-assign-location");
    const lastUsedLabel = document.getElementById("last-used-location-name");
    const itemTitle = document.getElementById("assign-location-item-title");
    const scannedCount = document.getElementById("assign-location-scanned-count");
    const quantityInput = document.getElementById("assign-location-quantity");
  
    const { data: lastUsed, error } = await supabase
      .from("item_stock_locations")
      .select("quantity, confirmed_at, locations(location_name, location_code, store_id)")
      .eq("item_id", batchItem.item.id)
      .order("confirmed_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    resetAssignLocationSelection();
    resetAssignLocationDropdownState();
    resetAssignPlacementFlow();
    activeStoreOptions = await fetchActiveStores();
    activeAssignLocationOptions = await fetchAssignableLocations();

    if (itemTitle) itemTitle.textContent = batchItem.item.title || "Current Batch Item";
    if (scannedCount) scannedCount.textContent = String(batchItem.count || 0);
    if (quantityInput) quantityInput.value = String(Math.max(1, Number(batchItem.count) || 1));

    if (error) {
      console.error("❌ Error fetching last used location:", error);
      lastUsedLabel.textContent = "—";
    } else if (lastUsed && lastUsed.locations) {
      const { location_name, location_code } = lastUsed.locations;
      lastUsedLabel.textContent = `${location_name || "—"} (${location_code || "—"})`;
    } else {
      lastUsedLabel.textContent = "—";
    }

    modal.dataset.barcode = batchItem.item.barcode;
    modal.classList.remove("hidden");
  
    updateBarcodeInputStateBasedOnModals();
  
    setTimeout(() => {
      focusAssignPlacementInput(assignPlacementMode === "container" ? "assign-placement-parent-barcode" : "assign-placement-tray-barcode", { scroll: false });
    }, 80);
  }
  
  //function to coordinate the display of the limit modal
  function showBatchThresholdModal(batchItem) {
    const modal = document.getElementById("modal-batch-threshold-reached");
    const scannedCountDisplay = document.getElementById("scanned-count-display");
    const inputField = document.getElementById("input-manual-count");
    const errorMsg = document.getElementById("manual-count-error-msg");
    const input = document.getElementById("input-to-search-inventory-item");
  
    // 🧠 NEW: populate photo and title in the modal
    const item = batchItem.item;
    const itemPhotoEl = document.getElementById("batch-item-photo");
    const itemTitleEl = document.getElementById("batch-item-title");
  
    itemPhotoEl.src = item.photos?.[0] || "";
    itemPhotoEl.alt = item.title || "Item Photo";
    itemTitleEl.textContent = item.title || "Unnamed Item";
  
    modal.dataset.barcode = item.barcode;
    scannedCountDisplay.textContent = batchItem.count;
    inputField.value = "";
    errorMsg.classList.add("hidden");
    updateBarcodeInputStateBasedOnModals();
  
    modal.classList.remove("hidden");
    updateBarcodeInputStateBasedOnModals();
    inputField.focus();
  }

  //listeners
    //manual countverification listener
    function setupManualCountVerificationListeners() {
      const modal = document.getElementById("modal-batch-threshold-reached");
      const confirmBtn = document.getElementById("btn-confirm-manual-count");
      const cancelBtn = document.getElementById("btn-cancel-manual-count");
      const input = document.getElementById("input-manual-count");
      const errorMsg = document.getElementById("manual-count-error-msg");
      const inputScanner = document.getElementById("input-to-search-inventory-item");
    
      confirmBtn.onclick = () => {
        const barcode = modal.dataset.barcode;
        const batchItem = currentBatch[barcode];
        const manualCount = parseInt(input.value.trim(), 10);
    
        if (isNaN(manualCount)) return;
    
        if (manualCount === batchItem.count) {
          showToast("✅ Manual count confirmed. Please assign location.");
          modal.classList.add("hidden");
          errorMsg.classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          inputScanner.disabled = false;
          inputScanner.blur();
    
          showAssignLocationModal(batchItem); // 👈 trigger next modal
        } else {
          errorMsg.classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();

          const mismatchModal = document.getElementById("modal-manual-count-mismatch");
          mismatchModal.dataset.barcode = barcode;
          modal.classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          mismatchModal.classList.remove("hidden");
          updateBarcodeInputStateBasedOnModals();

        }
      };
    
      cancelBtn.onclick = () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        errorMsg.classList.add("hidden");
        inputScanner.disabled = false;
        inputScanner.focus();
      };
    }

    //missmatch in count listener 
    function setupMismatchResetModalListener() {
      const modal = document.getElementById("modal-manual-count-mismatch");
      const okButton = document.getElementById("btn-reset-count-to-zero");
      const scannerInput = document.getElementById("input-to-search-inventory-item");
    
      okButton.onclick = () => {
        const barcode = modal.dataset.barcode;
        if (!barcode || !currentBatch[barcode]) return;
      
        const batchItem = currentBatch[barcode];
        batchItem.count = 0;
      
        // Reset UI counter
        const unitDisplay = batchItem.cardEl.querySelector(".units-scanned");
        if (unitDisplay) {
          unitDisplay.textContent = `Units Scanned: 0`;
        }
      
        // 🔴 Add red glow class
        batchItem.cardEl.classList.add("count-zero-alert");
      
        // Hide the modal and refocus scanner
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        scannerInput.disabled = false;
        scannerInput.focus();
      };
      
    }

    //event listener for assigning the location to item 
    function setupAssignLocationModalListeners() {
      const modal = document.getElementById("modal-assign-location");
      const confirmBtn = document.getElementById("btn-confirm-location-assign");
      const cancelBtn = document.getElementById("btn-cancel-location-assign");
      const quantityInput = document.getElementById("assign-location-quantity");
      const barcodeInput = document.getElementById("input-to-search-inventory-item");
      const trayInput = document.getElementById("assign-placement-tray-barcode");
      const parentInput = document.getElementById("assign-placement-parent-barcode");
      const containerInput = document.getElementById("assign-placement-container-barcode");

      document.querySelectorAll("[data-assign-placement-mode]").forEach((button) => {
        if (button.dataset.bound === "true") return;
        button.dataset.bound = "true";
        button.addEventListener("click", () => {
          setAssignPlacementMode(button.dataset.assignPlacementMode || "tray", { clear: true, focus: true });
        });
      });

      if (trayInput && trayInput.dataset.bound !== "true") {
        trayInput.dataset.bound = "true";
        trayInput.addEventListener("input", () => scheduleAssignBarcodeScan(trayInput, handleAssignTrayBarcodeScan));
        trayInput.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          flushAssignBarcodeScan(trayInput, handleAssignTrayBarcodeScan);
        });
      }

      if (parentInput && parentInput.dataset.bound !== "true") {
        parentInput.dataset.bound = "true";
        parentInput.addEventListener("input", () => scheduleAssignBarcodeScan(parentInput, handleAssignParentBarcodeScan));
        parentInput.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          flushAssignBarcodeScan(parentInput, handleAssignParentBarcodeScan);
        });
      }

      if (containerInput && containerInput.dataset.bound !== "true") {
        containerInput.dataset.bound = "true";
        containerInput.addEventListener("input", () => scheduleAssignBarcodeScan(containerInput, handleAssignContainerBarcodeScan));
        containerInput.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          flushAssignBarcodeScan(containerInput, handleAssignContainerBarcodeScan);
        });
      }

      if (quantityInput && quantityInput.dataset.enterBound !== "true") {
        quantityInput.dataset.enterBound = "true";
        quantityInput.addEventListener("keydown", (event) => {
          if (event.key !== "Enter") return;
          event.preventDefault();
          confirmBtn?.click();
        });
      }
    
      cancelBtn.addEventListener("click", () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        barcodeInput.disabled = false;
        barcodeInput.focus();
      });
    
      confirmBtn.addEventListener("click", async () => {
        const barcode = modal.dataset.barcode;
        const batchItem = currentBatch[barcode];
        const locationData = selectedAssignLocation;
        const quantityToAdd = parseInt(quantityInput?.value?.trim() || "", 10);
      
        if (!locationData?.id) {
          showToast(assignPlacementMode === "container" ? "Scan the parent and container barcodes first." : "Scan a tray barcode first.");
          focusAssignPlacementInput(assignPlacementMode === "container" ? "assign-placement-parent-barcode" : "assign-placement-tray-barcode");
          return;
        }
      
        if (!Number.isInteger(quantityToAdd) || quantityToAdd <= 0) {
          showToast("Enter a valid quantity to add.");
          quantityInput?.focus();
          return;
        }

        if (assignPlacementMode === "tray" && !isTrayAssignLocation(locationData)) {
          showToast("Scan an active tray barcode for tray placement.");
          focusAssignPlacementInput("assign-placement-tray-barcode");
          return;
        }

        if (assignPlacementMode === "container") {
          if (!isContainerAssignLocation(locationData)) {
            showToast("Scan a container or bag barcode for container placement.");
            focusAssignPlacementInput("assign-placement-container-barcode");
            return;
          }
          if (!selectedAssignParentLocation?.id || String(locationData.parentId || "") !== String(selectedAssignParentLocation.id)) {
            showToast("The container must belong to the scanned parent storage location.");
            focusAssignPlacementInput("assign-placement-parent-barcode");
            return;
          }
        }

        const parentCopy = assignPlacementMode === "container" && selectedAssignParentLocation
          ? ` via ${getAssignLocationLabel(selectedAssignParentLocation)}`
          : "";
        // selected location already resolved by barcode scan.
        await renderLocationIntelligence("assign-location-intelligence", locationData.id, {
          referenceWeight: Number(batchItem?.item?.weight),
          referenceLabel: batchItem?.item?.title || "this item",
        });

        window.showPasswordConfirmModal(
          batchItem,
          locationData.id,
          `${getAssignLocationLabel(locationData)}${parentCopy}`,
          quantityToAdd,
          {
            placement_type: assignPlacementMode,
            location_code: locationData.code || "",
            location_store_name: getAssignLocationStoreLabel(locationData) || "",
            parent_location_id: selectedAssignParentLocation?.id || null,
            parent_location_name: selectedAssignParentLocation?.name || null,
            parent_location_code: selectedAssignParentLocation?.code || null,
          }
        );
      });      
    }
    
    //#region 🔧 Location Modal Logic
    function setupLocationModalListeners() {
      const modal = document.getElementById("modal-add-location");
      const form = document.getElementById("form-add-location");
      const cancelBtn = document.getElementById("btn-cancel-location");
    
      const nameInput = document.getElementById("location-name");
      const barcodeInput = document.getElementById("location-barcode");
      const capacityInput = document.getElementById("location-capacity");
      const capacityNoLimitInput = document.getElementById("location-capacity-no-limit");
      const photoInput = document.getElementById("location-photo");
      const previewWrapper = document.getElementById("photo-preview-wrapper");
      const previewImage = document.getElementById("photo-preview-image");

      photoInput.addEventListener("change", () => {
        const file = photoInput.files?.[0];
        if (!file) {
          previewWrapper.classList.add("hidden");
          previewImage.src = "";
          return;
        }

        const reader = new FileReader();
        reader.onload = (e) => {
          previewImage.src = e.target.result;
          previewWrapper.classList.remove("hidden");
        };
        reader.readAsDataURL(file);
      });

      const notesInput = document.getElementById("location-notes");
      const generateBtn = document.getElementById("btn-generate-location-barcode");

      function syncLocationCapacityLimit() {
        if (!capacityInput || !capacityNoLimitInput) return;
        const unlimited = Boolean(capacityNoLimitInput.checked);
        capacityInput.disabled = unlimited;
        capacityInput.placeholder = unlimited ? "No limit" : "";
        if (unlimited) capacityInput.value = "";
      }
    
      // 🔁 Shared barcode generator
      function generateAndRenderLocationBarcode() {
        const generatedCode = `LOC-${Date.now().toString().slice(-6)}`;
        JsBarcode("#barcode-canvas-location", generatedCode, {
          format: "CODE128",
          displayValue: true,
          fontSize: 16,
          height: 60
        });
        barcodeInput.value = generatedCode;
      
        // ⬇️ Generate DYMO XML for location (only barcode)
        latestLocationDymoXml = `<?xml version="1.0" encoding="utf-8"?>
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
                    <DataString>${generatedCode}</DataString>
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
                      <X>0.34072888</X>
                      <Y>0.21541661</Y>
                    </DYMOPoint>
                    <Size>
                      <Width>2.8185425</Width>
                      <Height>0.68583345</Height>
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
        latestLocationDymoXml = buildLocationDymoXml(generatedCode, nameInput?.value || "");

        // Immediately upload DYMO file and show link
        (async () => {
          const labelPath = `labels/location_${Date.now()}.dymo`;
          const blob = new Blob([latestLocationDymoXml], { type: "application/octet-stream" });

          const { error: uploadError } = await supabase.storage
            .from("dymo-labels")
            .upload(labelPath, blob, { upsert: true });

          if (uploadError) {
            console.error("❌ Failed to upload DYMO file early:", uploadError);
            return;
          }

          const { data: signedData, error: urlError } = await supabase.storage
            .from("dymo-labels")
            .createSignedUrl(labelPath, 60 * 60 * 24 * 365 * 10); // 10 years

          if (urlError) {
            console.error("❌ Failed to get signed URL for DYMO file:", urlError);
            return;
          }

          latestLocationDymoUrl = signedData.signedUrl;

          // Inject the link into the modal
          const linkContainer = document.getElementById("dymo-link-preview");
          if (linkContainer) {
            linkContainer.innerHTML = `<a href="${latestLocationDymoUrl}" target="_blank">📎 View DYMO Label</a>`;
          }
        })();


      }
      
      //lazy dropdown creation
      let activeDropdown = null;
      document.addEventListener("click", async (e) => {
        const isToggle = e.target.id === "location-type-dropdown-toggle";
        if (!isToggle) return;

        const button = e.target;
        const menu = document.getElementById("location-type-dropdown-menu");

        // 🧹 Close any other dropdowns
        if (activeDropdown && activeDropdown !== menu) {
          activeDropdown.classList.remove("show");
        }

        // 🧠 Populate only once
        if (!menu.dataset.populated) {
          const types = await fetchUniqueLocationTypes();
          renderDropdownOptionsCustom({
            menuId: "location-type-dropdown-menu",
            options: types,
            searchId: "location-type-search",
            placeholder: "Search or create location type...",
            optionClass: "dropdown-option",
            dataAttribute: "type",
            optionsContainerClass: "location-type-dropdown-container",
            onClick: (value, isNew, el) => {
              document.getElementById("location-type").value = value;
              button.innerText = value;
              showToast(isNew ? `➕ Created new type: ${value}` : `🏷️ Selected type: ${value}`);
              menu.classList.remove("show");
              activeDropdown = null;
            }
          });
          menu.dataset.populated = "true";
        }

        // 👁️ Toggle visibility
        menu.classList.toggle("show");
        activeDropdown = menu.classList.contains("show") ? menu : null;
      });

      
      // Clear form fields
      function clearForm() {
        nameInput.value = "";
        barcodeInput.value = "";
        capacityInput.value = "";
        if (capacityNoLimitInput) capacityNoLimitInput.checked = true;
        syncLocationCapacityLimit();
        notesInput.value = "";
        photoInput.value = "";
        const storeSelect = document.getElementById("location-store");
        // Optionally clear canvas too:
        const canvas = document.getElementById("barcode-canvas-location");
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        const typeBtn = document.getElementById("location-type-dropdown-toggle");
        const typeMenu = document.getElementById("location-type-dropdown-menu");
        document.getElementById("location-type").value = "";
        if (storeSelect) storeSelect.value = "";
        typeBtn.innerText = "Select Location Type";
        typeMenu.dataset.populated = "";
        typeMenu.innerHTML = ""; // fully reset menu

      }
      window.clearForm = clearForm;
    
      // 🧲 Generate on button click
      populateLocationStoreSelect();
      syncLocationCapacityLimit();
      generateBtn.addEventListener("click", generateAndRenderLocationBarcode);
      capacityNoLimitInput?.addEventListener("change", syncLocationCapacityLimit);
    
      cancelBtn.addEventListener("click", async () => {
        pendingAssignLocationDraft = null;
        await toggleModal(false);
      });
    
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
    
        const location_name = nameInput.value.trim();
        const location_code = barcodeInput.value.trim();
        const max_capacity = capacityInput.value.trim();
        const capacityHasNoLimit = Boolean(capacityNoLimitInput?.checked);
        const notes = notesInput.value.trim();
        const photoFile = photoInput.files?.[0] || null;
        const store_id = document.getElementById("location-store")?.value?.trim() || null;

        if (activeStoreOptions.length > 0 && !store_id) {
          showToast("Select a store for this location.");
          return;
        }
    
        if (!location_name || !location_code) {
          showToast("⚠️ Name and barcode are required.");
          return;
        }
    
        showToast("Uploading...");
    
        let photo_url = null;
        let dymo_label_url = null;

        latestLocationDymoXml = buildLocationDymoXml(location_code, location_name);

        if (latestLocationDymoXml) {
          const labelPath = `labels/location_${Date.now()}.dymo`;
          const blob = new Blob([latestLocationDymoXml], { type: "application/octet-stream" });

          const { error: uploadError } = await supabase.storage
            .from("dymo-labels")
            .upload(labelPath, blob, { upsert: true });

          if (!uploadError) {
            const { data: signedData, error: urlError } = await supabase.storage
              .from("dymo-labels")
              .createSignedUrl(labelPath, 60 * 60 * 24 * 365 * 10); // 10 years

            if (!urlError) {
              dymo_label_url = signedData.signedUrl;
            }
          }
        }

        let photo_path = null;

        if (photoFile) {
          const { data, error } = await supabase.storage
            .from("location-assets")
            .upload(`photos/${Date.now()}_${photoFile.name}`, photoFile);

          if (error) {
            showToast("❌ Failed to upload photo.");
            return;
          }

          photo_url = data.path; // ✅ Save just the path
        }
    
        const { error: insertError } = await supabase.from("locations").insert({
          location_name,
          location_code,
          max_capacity: capacityHasNoLimit || !max_capacity ? null : parseInt(max_capacity, 10),
          notes,
          active: true,
          photo_url,
          dymo_label_url,
          store_id,
          type: document.getElementById("location-type").value || null,
          created_at: new Date().toISOString()
        });
    
        if (insertError) {
          console.error("❌ Error inserting location:", insertError);
          showToast("❌ Failed to save location.");
          return;
        }
    
        showToast("✅ Location saved!");
        await toggleModal(false);
        if (pendingAssignLocationDraft) {
          await populateAssignLocationStoreFilter(store_id || "");
          resetAssignLocationDropdownState();
          setAssignLocationSelection({
            locationName: location_name,
            locationCode: location_code,
          });

          const assignStore = document.getElementById("assign-location-store");
          if (assignStore && store_id) {
            assignStore.value = store_id;
          }

          document.getElementById("assign-location-quantity")?.focus();
          pendingAssignLocationDraft = null;
        } else {
          await populateLocationDropdown();
        }
      });

    }

    function getInventoryLabelPrintElements() {
      return {
        labelsPerOrderInput: document.getElementById("inventory-labels-per-order"),
        countEl: document.getElementById("inventory-label-print-count"),
        formulaEl: document.getElementById("inventory-label-print-formula"),
        statusEl: document.getElementById("inventory-label-print-status"),
        batchButton: document.getElementById("inventory-label-print-batch"),
        oneButton: document.getElementById("inventory-label-print-one"),
        laterButton: document.getElementById("inventory-label-print-later"),
      };
    }

    function getInventoryLabelsPerOrderValue() {
      const input = document.getElementById("inventory-labels-per-order");
      const value = Math.floor(Number(input?.value || 2));
      return Number.isFinite(value) && value > 0 ? value : 2;
    }

    function getInventoryRecommendedLabelCount() {
      const quantity = Math.max(1, Number(pendingInventoryLabelPrintState?.quantityAdded || 1));
      const labelsPerOrder = getInventoryLabelsPerOrderValue();
      return Math.max(1, Math.ceil(quantity / labelsPerOrder));
    }

    function updateInventoryLabelPrintEstimate() {
      const state = pendingInventoryLabelPrintState;
      const elements = getInventoryLabelPrintElements();
      if (!state) return;

      const quantity = Math.max(1, Number(state.quantityAdded || 1));
      const labelsPerOrder = getInventoryLabelsPerOrderValue();
      const recommendedCount = getInventoryRecommendedLabelCount();
      const labelWord = recommendedCount === 1 ? "label" : "labels";

      if (elements.countEl) {
        elements.countEl.textContent = `${recommendedCount.toLocaleString()} ${labelWord} recommended`;
      }
      if (elements.formulaEl) {
        elements.formulaEl.textContent = `${quantity.toLocaleString()} inventory unit${quantity === 1 ? "" : "s"} / ${labelsPerOrder.toLocaleString()} label${labelsPerOrder === 1 ? "" : "s"} per order = ${recommendedCount.toLocaleString()} ${labelWord}.`;
      }
      if (elements.batchButton) {
        elements.batchButton.textContent = `Print ${recommendedCount.toLocaleString()} ${labelWord}`;
      }
    }

    function setInventoryLabelPrintBusy(isBusy) {
      const elements = getInventoryLabelPrintElements();
      [elements.batchButton, elements.oneButton, elements.laterButton, elements.labelsPerOrderInput]
        .filter(Boolean)
        .forEach((element) => {
          element.disabled = Boolean(isBusy);
        });
    }

    function setInventoryLabelPrintStatus(message = "", type = "info") {
      const statusEl = document.getElementById("inventory-label-print-status");
      if (!statusEl) return;
      statusEl.textContent = message;
      statusEl.classList.toggle("is-muted", type !== "error" && type !== "success");
      statusEl.classList.toggle("is-error", type === "error");
      statusEl.classList.toggle("is-success", type === "success");
    }

    async function copyTextToClipboard(text) {
      const value = String(text || "").trim();
      if (!value) return false;

      try {
        await navigator.clipboard.writeText(value);
        return true;
      } catch (_) {
        const textarea = document.createElement("textarea");
        textarea.value = value;
        textarea.setAttribute("readonly", "");
        textarea.style.position = "fixed";
        textarea.style.left = "-9999px";
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand("copy");
        textarea.remove();
        return copied;
      }
    }

    function isMissingLabelPreferenceStorage(error) {
      const text = `${error?.message || ""} ${error?.details || ""} ${error?.hint || ""}`;
      return /set_item_label_print_preference|label_print_strategy|labels_per_order|label_print_quantity|collective_label_only|schema cache|could not find|function/i.test(text);
    }

    async function recordInventoryLabelPreference(strategy, printQuantity, labelsPerOrder, notes = "") {
      const state = pendingInventoryLabelPrintState;
      if (!state?.item?.id) return false;

      const payload = {
        _item_id: state.item.id,
        _strategy: strategy,
        _labels_per_order: labelsPerOrder,
        _label_print_quantity: printQuantity,
        _notes: notes,
      };

      const { error } = await supabase.rpc("set_item_label_print_preference", payload);
      if (!error) return true;

      if (!isMissingLabelPreferenceStorage(error)) throw error;

      const fallbackUpdate = {
        label_print_strategy: strategy,
        labels_per_order: labelsPerOrder,
        label_print_quantity: strategy === "deferred" ? null : printQuantity,
        label_printed_at: strategy === "deferred" ? null : new Date().toISOString(),
        label_printed_by: currentUser?.id || null,
        label_printed_by_email: currentUser?.email || null,
        collective_label_only: strategy === "collective_only",
        label_print_notes: notes || null,
      };

      const { error: updateError } = await supabase
        .from("item_types")
        .update(fallbackUpdate)
        .eq("id", state.item.id);

      if (updateError) {
        console.warn("Label print preference could not be recorded until migration is pushed:", updateError);
        return false;
      }

      return true;
    }

    async function recordInventoryLabelPrintAudit(strategy, printQuantity, labelsPerOrder, deliveryMode = "direct") {
      const state = pendingInventoryLabelPrintState;
      if (!state?.stockTransactionId) return false;

      const deliveryVerb = deliveryMode === "queued-download" ? "queued" : "printed";
      const decisionLabel = strategy === "individual_batch"
        ? `${deliveryVerb} ${printQuantity} recommended label${printQuantity === 1 ? "" : "s"}`
        : strategy === "collective_only"
          ? `${deliveryVerb} one collective label`
          : "deferred label printing and copied barcode";
      const auditNote = `label print decision: ${decisionLabel}; labels per order ${labelsPerOrder}; decided by ${currentUser?.email || "current user"}`;
      const nextNotes = [state.stockTransactionNotes || "", auditNote].filter(Boolean).join(" | ");

      const { error } = await supabase
        .from("stock_transactions")
        .update({ notes: nextNotes })
        .eq("id", state.stockTransactionId);

      if (error) {
        console.warn("Could not append label print decision to stock transaction:", error);
        return false;
      }

      state.stockTransactionNotes = nextNotes;
      return true;
    }

    function extractDymoStoragePath(value) {
      const text = String(value || "").trim();
      if (!text) return "";
      if (!/^https?:\/\//i.test(text)) {
        return text.replace(/^dymo-labels\//i, "");
      }

      try {
        const url = new URL(text);
        const match = url.pathname.match(/\/storage\/v1\/object\/(?:sign|public)\/dymo-labels\/(.+)$/);
        return match?.[1] ? decodeURIComponent(match[1]) : "";
      } catch (_) {
        return "";
      }
    }

    async function loadDymoLabelXmlForInventoryItem(item) {
      const labelReference = String(item?.dymo_label_url || "").trim();
      const storagePath = extractDymoStoragePath(labelReference);

      if (storagePath) {
        const { data, error } = await supabase.storage.from("dymo-labels").download(storagePath);
        if (!error && data) {
          return data.text();
        }
      }

      if (/^https?:\/\//i.test(labelReference)) {
        const response = await fetch(labelReference);
        if (!response.ok) {
          throw new Error(`Failed to load DYMO label (${response.status}).`);
        }
        return response.text();
      }

      throw new Error("No DYMO label is attached to this item.");
    }

    async function printInventoryItemLabels(copies) {
      const state = pendingInventoryLabelPrintState;
      if (!state?.item) throw new Error("No saved inventory item is ready for label printing.");
      if (!state.dymoXml) {
        state.dymoXml = await loadDymoLabelXmlForInventoryItem(state.item);
      }

      return window.dymoModule.printDymoLabelXml(state.dymoXml, {
        copies,
        barcode: state.item?.barcode || "",
        title: state.item?.title || "",
        labelKind: "InventoryLabel",
        listenerOnly: true,
        onProgress: (current, total, printer) => {
          setInventoryLabelPrintStatus(`Downloading helper label ${current} of ${total} for ${printer?.name || "local print helper"}...`);
        },
      });
    }

    function closeInventoryLabelPrintModal() {
      const modal = document.getElementById("inventory-label-print-modal");
      modal?.classList.add("hidden");
      modal?.setAttribute("aria-hidden", "true");
      pendingInventoryLabelPrintState = null;
      updateBarcodeInputStateBasedOnModals();
      document.getElementById("input-to-search-inventory-item")?.focus();
    }

    async function handleInventoryLabelPrintDecision(strategy) {
      const state = pendingInventoryLabelPrintState;
      if (!state) return;

      const labelsPerOrder = getInventoryLabelsPerOrderValue();
      const printQuantity = strategy === "individual_batch"
        ? getInventoryRecommendedLabelCount()
        : strategy === "collective_only"
          ? 1
          : null;

      setInventoryLabelPrintBusy(true);
      try {
        if (strategy === "deferred") {
          const copied = await copyTextToClipboard(state.item?.barcode);
          const recorded = await recordInventoryLabelPreference("deferred", null, labelsPerOrder, "Add inventory label printing deferred; barcode copied.");
          await recordInventoryLabelPrintAudit("deferred", null, labelsPerOrder);
          setInventoryLabelPrintStatus(`${copied ? "Barcode copied to clipboard." : "Could not copy barcode automatically."}${recorded ? "" : " Label preference will record after the migration is pushed."}`, copied ? "success" : "error");
          setTimeout(closeInventoryLabelPrintModal, copied ? 900 : 1800);
          return;
        }

        const printResult = await printInventoryItemLabels(printQuantity);
        const printVerb = printResult?.mode === "queued-download" ? "Queued" : "Printed";
        const notes = strategy === "collective_only"
          ? `${printVerb} one collective label after adding ${state.quantityAdded} inventory unit${Number(state.quantityAdded) === 1 ? "" : "s"} to ${state.locationName || "selected storage"}.`
          : `${printVerb} recommended label batch after adding ${state.quantityAdded} inventory unit${Number(state.quantityAdded) === 1 ? "" : "s"} to ${state.locationName || "selected storage"}.`;
        const recorded = await recordInventoryLabelPreference(strategy, printQuantity, labelsPerOrder, notes);
        await recordInventoryLabelPrintAudit(strategy, printQuantity, labelsPerOrder, printResult?.mode || "direct");
        const delivery = printResult?.mode === "queued-download"
          ? `Downloaded ${printResult.filename || "the DYMO label"} for the local print helper`
          : `Printed ${printQuantity} label${printQuantity === 1 ? "" : "s"}`;
        setInventoryLabelPrintStatus(`${delivery}.${recorded ? "" : " Label tag will record after the migration is pushed."}`, "success");
        setTimeout(closeInventoryLabelPrintModal, recorded ? 1000 : 1800);
      } catch (error) {
        console.error("Add inventory label print failed:", error);
        setInventoryLabelPrintStatus(`Could not complete label printing: ${error?.message || error}`, "error");
        setInventoryLabelPrintBusy(false);
      }
    }

    function bindInventoryLabelPrintControls() {
      const elements = getInventoryLabelPrintElements();
      elements.labelsPerOrderInput?.addEventListener("input", updateInventoryLabelPrintEstimate);
      if (elements.batchButton) {
        elements.batchButton.onclick = () => handleInventoryLabelPrintDecision("individual_batch");
      }
      if (elements.oneButton) {
        elements.oneButton.onclick = () => handleInventoryLabelPrintDecision("collective_only");
      }
      if (elements.laterButton) {
        elements.laterButton.onclick = () => handleInventoryLabelPrintDecision("deferred");
      }
    }

    function showInventoryLabelPrintModal({ item, quantityAdded, locationName, stockTransactionId = "", stockTransactionNotes = "" } = {}) {
      const modal = document.getElementById("inventory-label-print-modal");
      const summary = document.getElementById("inventory-label-print-summary");
      const labelsPerOrderInput = document.getElementById("inventory-labels-per-order");
      if (!modal) return false;

      pendingInventoryLabelPrintState = {
        item,
        quantityAdded: Math.max(1, Number(quantityAdded) || 1),
        locationName: locationName || "selected storage",
        stockTransactionId: stockTransactionId || "",
        stockTransactionNotes: stockTransactionNotes || "",
        dymoXml: "",
      };

      if (summary) {
        summary.textContent = `${pendingInventoryLabelPrintState.quantityAdded.toLocaleString()} unit${pendingInventoryLabelPrintState.quantityAdded === 1 ? "" : "s"} of ${item?.title || "this item"} were added to ${pendingInventoryLabelPrintState.locationName}. Choose how many physical labels should print now.`;
      }
      if (labelsPerOrderInput) labelsPerOrderInput.value = "2";

      updateInventoryLabelPrintEstimate();
      setInventoryLabelPrintStatus("Ready to send to the local print helper. Keep tools/start-dymo-print-helper.bat open.");
      setInventoryLabelPrintBusy(false);
      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
      updateBarcodeInputStateBasedOnModals();
      setTimeout(() => document.getElementById("inventory-label-print-batch")?.focus(), 80);
      return true;
    }

    //event listener to have a confirmation of who added the batch 
    function setupPasswordConfirmationModal() {
      const modal = document.getElementById("modal-password-confirm");
      const emailInput = document.getElementById("password-confirm-email");
      const passwordInput = document.getElementById("password-confirm-password");
      const errorMsg = document.getElementById("password-confirm-error");
      const confirmBtn = document.getElementById("btn-confirm-password");
      const cancelBtn = document.getElementById("btn-cancel-password");

      let pendingAssignment = null; // { batchItem, location_id, location_name, quantityToAdd, placementMeta }

      // 👇 Called from assign-location modal
      window.showPasswordConfirmModal = (batchItem, location_id, location_name, quantityToAdd = null, placementMeta = {}) => {
        pendingAssignment = {
          batchItem,
          location_id,
          location_name,
          placementMeta: placementMeta || {},
          quantityToAdd: Number.isInteger(quantityToAdd) && quantityToAdd > 0
            ? quantityToAdd
            : Math.max(1, Number(batchItem?.count) || 1),
        };
        emailInput.value = currentUser.email || "";
        passwordInput.value = "";
        errorMsg.style.display = "none";
        modal.classList.remove("hidden");
        updateBarcodeInputStateBasedOnModals();
        passwordInput.focus();
      };

      confirmBtn.onclick = async () => {
        const password = passwordInput.value.trim();
        if (!password) return;

        const { data, error } = await supabase.auth.signInWithPassword({
          email: currentUser.email,
          password: password,
        });

        if (error || !data.session) {
          errorMsg.style.display = "block";
          return;
        }

        const { batchItem, location_id, location_name, quantityToAdd } = pendingAssignment;
        const isBulkFlow = !!batchItem?.bag_info?.bulkPayload; 

        try {
          const { batchItem, location_id, location_name, quantityToAdd, placementMeta = {} } = pendingAssignment;
          const bagInfo = batchItem?.bag_info;
          const isBulkFlow = !!(bagInfo && bagInfo.bulkPayload);
          const signedAt = new Date().toISOString();
          const signedEmail = currentUser.email || "";
          const confirmationMethod = "password_stock_placement";
          let stockTransactionId = "";
          let stockTransactionNotes = "";

          if (!isBulkFlow) {
            // ── NON-BULK: generic stock write ───────────────────────────────
            // Check if stock already exists at this location
            const { data: existingStock, error: fetchError } = await supabase
              .from("item_stock_locations")
              .select("id, quantity")
              .eq("item_id", batchItem.item.id)
              .eq("location_id", location_id)
              .maybeSingle();

            if (fetchError) {
              console.error("❌ Failed to check existing stock:", fetchError);
              showToast("❌ Could not check existing stock.");
              return;
            }

            if (existingStock) {
              // Update existing stock
              const { error: updateError } = await supabase
                .from("item_stock_locations")
                .update({
                  quantity: existingStock.quantity + quantityToAdd,
                  last_updated: signedAt,
                  added_by: currentUser.id,
                  confirmation_email: signedEmail,
                  confirmation_method: confirmationMethod,
                  confirmed_at: signedAt,
                })
                .eq("id", existingStock.id);

              if (updateError) {
                console.error("❌ Failed to update existing stock:", updateError);
                showToast("❌ Failed to update existing stock.");
                return;
              }
            } else {
              // Insert new stock
              const { error: insertError } = await supabase
                .from("item_stock_locations")
                .insert({
                  item_id: batchItem.item.id,
                  location_id,
                  quantity: quantityToAdd,
                  added_by: currentUser.id,
                  confirmation_email: signedEmail,
                  confirmation_method: confirmationMethod,
                  confirmed_at: signedAt,
                });

              if (insertError) {
                console.error("❌ Failed to insert new stock:", insertError);
                showToast("❌ Failed to save stock assignment.");
                return;
              }
            }

            // Audit (non-bulk only)
            const { data: txData, error: txError } = await supabase.from("stock_transactions").insert({
              item_id: batchItem.item.id,
              location_id,
              quantity: quantityToAdd,
              action_type: "checkin",
              method: confirmationMethod,
              user_id: currentUser.id,
              email: signedEmail,
              timestamp: signedAt,
              confirmed_at: signedAt,
              notes: [
                "Added via Add Inventory Module",
                placementMeta.placement_type ? `destination type: ${placementMeta.placement_type}` : "",
                placementMeta.location_code ? `location barcode: ${placementMeta.location_code}` : "",
                placementMeta.parent_location_name ? `parent: ${placementMeta.parent_location_name}` : "",
                `signed by ${signedEmail}`,
              ].filter(Boolean).join(" | "),
            }).select("id, notes").maybeSingle();
            if (!txError) {
              stockTransactionId = txData?.id || "";
              stockTransactionNotes = txData?.notes || "";
            }

            if (txError) {
              console.error("❌ Failed to log transaction:", txError);
              showToast("⚠️ Stock saved, but audit log failed.");
            } else {
              showToast(`✅ Saved ${quantityToAdd} to ${location_name}`);
            }
          } else {
            // ── BULK BAG: per-bag stock only (no generic item stock write) ──
            const { bagBarcode, bulkPayload } = bagInfo || {};
            if (!bagBarcode || !bulkPayload) {
              showToast("❌ Missing bag info.");
              return;
            }

            // Create the bag registry row AND the per-bag stock row (batch_id)
            const res = await window.addItemBulkModule.saveRegistryForItem(
              batchItem.item.id,
              bagBarcode,
              location_id,
              {
                ...placementMeta,
                signed_by_email: signedEmail,
                signed_at: signedAt,
                confirmation_method: confirmationMethod,
                location_name,
              }
            );

            if (res?.error) {
              console.error("❌ Failed to save bulk bag:", res.error);
              showToast("❌ Failed to save bulk bag.");
              return;
            }

            // Audit (bulk)
            const { data: bulkTxData, error: bulkTxErr } = await supabase.from("stock_transactions").insert({
              item_id: batchItem.item.id,
              location_id,
              quantity: quantityToAdd,
              action_type: "checkin",
              method: "bulk_bag",
              user_id: currentUser.id,
              email: signedEmail,
              timestamp: signedAt,
              confirmed_at: signedAt,
              notes: [
                `Added via Bulk Bag ${bagBarcode}`,
                placementMeta.placement_type ? `destination type: ${placementMeta.placement_type}` : "",
                placementMeta.location_code ? `location barcode: ${placementMeta.location_code}` : "",
                placementMeta.parent_location_name ? `parent: ${placementMeta.parent_location_name}` : "",
                `signed by ${signedEmail}`,
              ].filter(Boolean).join(" | "),
            }).select("id, notes").maybeSingle();
            if (!bulkTxErr) {
              stockTransactionId = bulkTxData?.id || "";
              stockTransactionNotes = bulkTxData?.notes || "";
            }

            if (bulkTxErr) {
              console.warn("⚠️ Bulk saved, but audit log failed:", bulkTxErr);
              showToast("⚠️ Bulk saved, but audit log failed.");
            } else {
              showToast(`✅ Saved ${quantityToAdd} to ${location_name} (Bag ${bagBarcode})`);
            }
          }

          // ── Close modals & cleanup (shared) ───────────────────────────────
          modal.classList.add("hidden");
          document.getElementById("modal-assign-location").classList.add("hidden");
          updateBarcodeInputStateBasedOnModals();
          document.getElementById("input-to-search-inventory-item").focus();

          // Clean up UI and memory for this item
          batchItem.cardEl.remove();
          delete currentBatch[batchItem.item.barcode];

          await bumpInventoryVersion([batchItem.item.id]);
          showInventoryLabelPrintModal({
            item: batchItem.item,
            quantityAdded: quantityToAdd,
            locationName: location_name,
            stockTransactionId,
            stockTransactionNotes,
          });
        } catch (err) {
          console.error("❌ Unexpected error during stock confirmation:", err);
          showToast(`❌ Failed to confirm stock: ${err.message || err}`);
        }

      };

      cancelBtn.onclick = () => {
        modal.classList.add("hidden");
        updateBarcodeInputStateBasedOnModals();
        document.getElementById("input-to-search-inventory-item").focus();
      };
    }

    
    
//#endregion

    
  

//#endregion 

//#region Full logic to get an item from supabase and get the barcode
    //show toast function
    function showToast(message) {
        const container = document.getElementById("toast-container"); // Target container
        //-> you are accessing the div id= toast container node in the DOM (document object model)
        const toast = document.createElement("div"); //this is creating a new div element
        //-> in memory, not in the DOM per se, just a standalone javascript object for now
        //remember the div is just a box
        //and in here toast is not an html id, rather is just a varible holding the pointer to the
        //the object
        toast.className = "toast"; //it just gave the div you created called toast a class name
        toast.textContent = message; //injects the message into the container
        //<div class="toast">Item added!</div>
        container.appendChild(toast); //this is injecting the full javascript object into the 
        //node of the the DOM so now the user can see it live 
        // <div id="toast-container">
        //   <div class="toast">📦 Your toast message</div>
        // </div>
      
        // Remove toast after 4 seconds
        setTimeout(() => {
          toast.remove();
        }, 4000);
    }

    // 🚀 Fully revamped: extract item + stock quantities for Add Inventory
    async function ExtractItemWithBarcodeFromSupabase(barcode, table = "item_types", column = "barcode", debug = false) {
      try {
        // 1️⃣ Fetch item data
        const { data, error } = await supabase
          .from(table)
          .select("*")
          .eq(column, barcode)
          .single();

        if (debug) console.log("🔍 [DEBUG] Barcode Query Result:", data);

        if (error || !data) {
          if (debug) console.warn("⚠️ [DEBUG] Item not found or error occurred.", { error });
          return null;
        }

        // 2️⃣ Resolve photos to signed URLs
        if (Array.isArray(data.photos)) {
          const resolvedPhotos = await Promise.all(
            data.photos.map(async (photoPath) => {
              const { data: signed, error } = await supabase
                .storage
                .from("photos")
                .createSignedUrl(photoPath, 60 * 60); // valid 1 hour
              if (error) {
                console.warn("⚠️ Could not resolve signed URL for", photoPath, error);
                return null;
              }
              return signed?.signedUrl || null;
            })
          );
          data.photos = resolvedPhotos.filter(Boolean);
        } else {
          data.photos = [];
        }

        // 3️⃣ Fetch stock quantities for this item across all locations
        const { data: stockData, error: stockError } = await supabase
          .from("item_stock_locations")
          .select("quantity, location_id")
          .eq("item_id", data.id);

        if (stockError) {
          console.error("❌ Failed to fetch stock data:", stockError);
          data.stock = 0;
          data.stock_tooltip = "Failed to load stock info.";
          return data;
        }

        const { data: locations, error: locError } = await supabase
          .from("locations")
          .select("id, location_name");

        const locationMap = locError || !locations
          ? {}
          : Object.fromEntries(locations.map(loc => [loc.id, loc.location_name]));

        let totalStock = 0;
        const breakdown = {};

        stockData.forEach(({ quantity, location_id }) => {
          const locName = locationMap[location_id] || "Unknown Location";
          totalStock += quantity;
          breakdown[locName] = (breakdown[locName] || 0) + quantity;
        });

        data.stock = totalStock;
        data.stock_tooltip = Object.entries(breakdown).length > 0
          ? Object.entries(breakdown).map(([loc, qty]) => `${loc}: ${qty}`).join("\n")
          : "No stock found.";

        return data;
      } catch (err) {
        console.error("❌ [DEBUG] Unexpected error while querying Supabase:", err);
        showToast("Error contacting database.", "error");
        return null;
      }
    }

    //function to play sound after item is scanned
    function playScanSound() {
      const audio = document.getElementById("scan-sound");
      if (audio) audio.play();
    }
    
    //#region Rendering card item that matched barcode
        //#region buil image carousel
            //Move to next image in carousel for a given card
            function nextSlide({
              index,
              carouselTrackClass = "carousel-track",
              photoActualClass = "carousel-photo"
            }={}) {
                const carousel = document.getElementById(`carousel-${index}`);
                const track = carousel.querySelector(`.${carouselTrackClass}`);
                const images = track.querySelectorAll(`.${photoActualClass}`);
            
                // 🔍 Find currently active image
                const currentIndex = [...images].findIndex(img => img.classList.contains("active"));
                images[currentIndex].classList.remove("active");
            
                // 🔁 Move to next image (wrap around)
                const nextIndex = (currentIndex + 1) % images.length;
                images[nextIndex].classList.add("active");
            } //needs event listener
            
            //Move to previous image in carousel for a given card
            function prevSlide({
              index,
              carouselTrackClass = "carousel-track",
              photoActualClass = "carousel-photo"
            }={}) {
                const carousel = document.getElementById(`carousel-${index}`);
                const track = carousel.querySelector(`.${carouselTrackClass}`);
                const images = track.querySelectorAll(`.${photoActualClass}`);
            
                const currentIndex = [...images].findIndex(img => img.classList.contains("active"));
                images[currentIndex].classList.remove("active");
            
                // 🔁 Move to previous image (wrap around)
                const prevIndex = (currentIndex - 1 + images.length) % images.length;
                images[prevIndex].classList.add("active");
            } //needs event listener

            //carousel html block
            /**photos is going to be an array of photos URL 
            * Index is going to give you the position of the card in the main array
            * so you can see which carousel belongs to which item 
            */
            function buildCarousel({
                photos, 
                index,
                carouselContainerClass = "carousel",
                carouselBtnClass = "carousel-btn",
                iconOfNextCarouselButtonClass = "carousel-icon",
                carouselTrackClass = "carousel-track",
                photoActualClass = "carousel-photo"
            } = {}) {
            if (!photos.length) return `<div class="no-photo">No Photos</div>`;
            
            return `
                <div class="${carouselContainerClass}" id="carousel-${index}">
                    <button class="${carouselBtnClass} left" data-carousel-index="${index}" data-dir="prev">
                        <i data-lucide="chevron-left" class="${iconOfNextCarouselButtonClass}"></i>
                    </button>
                    <div class="${carouselTrackClass}">
                        ${photos.map((photo, i) => `
                        <img src="${photo}" class="${photoActualClass} ${i === 0 ? 'active' : ''}" />
                        `).join('')}
                    </div>
                    <button class="${carouselBtnClass} right" data-carousel-index="${index}" data-dir="next">
                        <i data-lucide="chevron-right" class="${iconOfNextCarouselButtonClass}"></i>
                    </button>
                </div>
            `;
           
            }    
        //#endregion
        
        //build the HTML of the card content
        function buildCardContent({
          item,
          chipCardDisplayClass = "category-chip",
          chipSectionTitleClass = "chip-section-label",
          chipContainerClass = "category-chips",
          cardContentOutsidePictureClass = "stock-content",
          hiddenFieldsCardContent = [],
          debug = false
        } = {}) {
          const stock = typeof item.stock === "number" ? item.stock : 0;
          const stockClass = stock === 0 ? "stock-zero" : "";
        
          const show = (field) => !hiddenFieldsCardContent.includes(field); // ✅ Clean utility
        
          const stockLabel = `<p class="stock-count ${stockClass}" title="${item.stock_tooltip || 'No breakdown available'}">
            ${stock === 0 
              ? `<i data-lucide="alert-circle" class="stock-alert-icon"></i> In Stock: 0`
              : `In Stock: ${stock}`
            }
          </p>`;
        
          const categoryChips = (item.categories || []).map(cat => `
            <div class="${chipCardDisplayClass}" data-cat="${cat}" data-id="${item.id}">
              ${cat}
            </div>
          `).join("");
        
          const html = `
            <div class="${cardContentOutsidePictureClass}">
              ${show("title") ? `<h2>${item.title}</h2>` : ""}
              ${show("description") ? `<p>${item.description}</p>` : ""}
              ${show("weight") ? `<p><strong>Weight:</strong> ${item.weight}</p>` : ""}
              ${show("cost") ? `<p><strong>Cost:</strong> $${item.cost.toLocaleString()}</p>` : ""}
              ${show("sale_price") ? `<p><strong>Sale Price:</strong> $${item.sale_price.toLocaleString()}</p>` : ""}
              ${show("barcode") ? `<p><strong>Barcode:</strong> ${item.barcode || "—"}</p>` : ""}
              ${show("created_at") ? `<p><strong>Last Updated:</strong> ${new Date(item.created_at).toLocaleString()}</p>` : ""}
              ${show("dymo_label_url") ? `<p><a href="${item.dymo_label_url}" target="_blank">📄 DYMO Label</a></p>` : ""}
              ${show("stock") ? stockLabel : ""}
              ${show("units_scanned") ? `<p class="units-scanned"><strong>Units Scanned:</strong> 1</p>` : ""}
              ${show("categories") ? `
                <p class="${chipSectionTitleClass}">Categories:</p>
                <div class="${chipContainerClass}">
                  ${categoryChips}
                </div>
              ` : ""}
            </div>
          `;
        
          if (debug) {
            console.log("[DEBUG] Generated Card HTML for barcode:", item.barcode, html);
          }
        
          return html;
        }
              
        //function to coordinate the rendering of one single item
        function renderInventoryItem({
            item,
            index, 
            CardContainerClass = "stock-card", 
            ImageContainerClass = "stock-image-container", 
            Identifier = "id",
            chipOneCardDisplayClass = "category-chip",
            chipOneSectionTitleClass = "chip-section-label",
            chipOneContainerClass = "category-chips",
            cardOneContentOutsidePictureClass = "stock-content",
            carouselOneContainerClass = "carousel",
            carouselOneBtnClass = "carousel-btn",
            iconOneOfNextCarouselButtonClass = "carousel-icon",
            carouselOneTrackClass = "carousel-track",
            photoOneActualClass = "carousel-photo",
            hiddenOneFieldsCardContent = []
        } = {}) { 
            const card = document.createElement("div");
            card.className = CardContainerClass;
            card.style.position = "relative"; /**This will ensure all children inside
            this cards are positioned related to it */
            card.dataset.itemId = item[Identifier]; /** this is going to give to that card 
            object a specific id, which is going to be in the id column (key) of the item
            (row from data array)
            now the good thing is that this can be used by an event listener*/
        
            const photoCarousel = buildCarousel({
              photos: item.photos || [], 
              index: index,
              carouselContainerClass: carouselOneContainerClass,
              carouselBtnClass: carouselOneBtnClass,
              iconOfNextCarouselButtonClass: iconOneOfNextCarouselButtonClass,
              carouselTrackClass: carouselOneTrackClass,
              photoActualClass: photoOneActualClass

            });
            const content = buildCardContent({
                item: item,
                chipCardDisplayClass: chipOneCardDisplayClass,
                chipSectionTitleClass: chipOneSectionTitleClass,
                chipContainerClass: chipOneContainerClass,
                cardContentOutsidePictureClass: cardOneContentOutsidePictureClass,
                hiddenFieldsCardContent: hiddenOneFieldsCardContent
            });
        
            card.innerHTML = `
            <div class="${ImageContainerClass}">
                ${photoCarousel}
            </div>
            ${content}
            `;
        
            return card;
        }
    //#endregion

    //function to reset the batch once it is done
    function resetBatch() {
        currentBatch = {};
        document.getElementById("batch-items-container").innerHTML = "";
    }

    //function to coordinate card animation on update
    function animateCardUpdate(cardElement) {
      // Remove any animation classes in case they’re still there
      cardElement.classList.remove("updated", "updated-flip", "flash-border");
    
      // Force reflow to restart animation
      void cardElement.offsetWidth;
    
      // Re-add animation classes
      cardElement.classList.add("updated", "updated-flip", "flash-border");
    
      // Clean up after animation
      setTimeout(() => {
        cardElement.classList.remove("flash-border");
      }, 500);
    
      setTimeout(() => {
        cardElement.classList.remove("updated");
        // Optional: keep flip for more visual flair, or remove it here
        cardElement.classList.remove("updated-flip");
      }, 500);
    
      playScanSound();
    }
    
    //function necessary to increment the stock count once the card has been already created
    function incrementCardCount(barcode) {
      const batchItem = currentBatch[barcode];
    
      if (batchItem.count >= batchItem.maxCount) {
        showToast("🚫 This item has already reached its batch limit.");
        showBatchThresholdModal(batchItem); // 🔁 Re-trigger modal every time
        return;
      }
    
      batchItem.count++;

      // 🧼 Remove red glow if previously flagged
      batchItem.cardEl.classList.remove("count-zero-alert");
    
      const unitDisplay = batchItem.cardEl.querySelector(".units-scanned");
      if (unitDisplay) {
        unitDisplay.textContent = `Units Scanned: ${batchItem.count}`;
      }
    
      animateCardUpdate(batchItem.cardEl);
    
      if (batchItem.count >= batchItem.maxCount) {
        showBatchThresholdModal(batchItem); // 👈 Initial trigger
      }
    }
    
    //function to render the card and put into the DOM
    function createCardForItem(item, ContainerForCardInjection = "batch-items-container") {
        const batchContainer = document.getElementById(ContainerForCardInjection); // your target div
        const index = Object.keys(currentBatch).length; // for carousel IDs etc
        const card = renderInventoryItem({ 
        item, 
        index,
        hiddenOneFieldsCardContent: ["dymo_label_url", "description", "barcode", "cost", "created_at"] });
        
        // 🔍 Log the full preview card DOM element and item data
        console.log(" Card Element:", card);

        batchContainer.appendChild(card);
        lucide.createIcons();  

        return card;
    }
      
    //function that will be used to initialize the card for the first time
    function handleScannedItem(item) {
      const card = createCardForItem(item);
    
      currentBatch[item.barcode] = {
        item,
        count: 1,
        maxCount: item.stock_batch_size_update || 10, // 🔢 Use item's custom batch size or default to 10
        cardEl: card
      };
    }
    

    // Function to hide the confirmation modal
    function hideModalToConfirmItem() {
      const modal = document.getElementById("modalToConfirmItem");
      modal.classList.add("hidden"); // Hide the modal
      updateBarcodeInputStateBasedOnModals();
      pendingItem = null; // Clear pending item
    
      // 👉 Refocus barcode input after modal closes
      document.getElementById("input-to-search-inventory-item").focus();
    }

    //function to create listener for the popup to appear
    function setupModalToConfirmItemListeners() {
        const confirmButton = document.getElementById("confirmAddItemBtn");
        const cancelButton = document.getElementById("cancelAddItemBtn");
    
        confirmButton.addEventListener("click", () => {
        if (pendingItem) {
            handleScannedItem(pendingItem);
            pendingItem = null;
        }
        hideModalToConfirmItem();
        });
    
        cancelButton.addEventListener("click", () => {
        hideModalToConfirmItem();
        });

        const bulkBtn = document.getElementById("btn-add-bulk-bag");
        bulkBtn.addEventListener("click", () => {
          if (!pendingItem) return;
          pendingBulkItem = pendingItem; // remember which item
          document.getElementById("modalToConfirmItem").classList.add("hidden");

          // ✅ Pass the item title so Save can enable once weights are valid
          window.addItemBulkModule?.openModal(pendingItem.title || "");
        });
    
        // Optional: Press "Enter" to confirm automatically
        document.addEventListener("keydown", (e) => {
        const modal = document.getElementById("modalToConfirmItem");
        if (!modal.classList.contains("hidden")) {
            if (e.key === "Enter") {
            e.preventDefault();
            confirmButton.click();
            } else if (e.key === "Escape") {
            e.preventDefault();
            cancelButton.click();
            }
        }
        });
    }

    //coorinating the rendering the pop up
    function showModalToConfirmItem(item) {
        pendingItem = item; // Save the item temporarily
    
        const modal = document.getElementById("modalToConfirmItem");
        const modalInfo = document.querySelector("#modalItemInfo"); // ✅ No change here
    
        // Clear any previous content
        modalInfo.innerHTML = "";
    
        // Build the card preview
        const previewCard = renderInventoryItem({
            item,
            index: 0, // Preview just uses index 0
            CardContainerClass: "stock-container-addstock", // 💡 IMPORTANT: match the clean class, not "stock-card" anymore!
            ImageContainerClass: "stock-image-container-addstock",
            Identifier: "id",
            chipOneCardDisplayClass: "category-chip-addstock",
            chipOneSectionTitleClass: "chip-section-label-addstock",
            chipOneContainerClass: "category-chip-containeraddstock",
            cardOneContentOutsidePictureClass: "stock-content-addstock",
            carouselOneContainerClass: "carousel-addstock",
            carouselOneBtnClass: "carousel-btn-addstock",
            iconOneOfNextCarouselButtonClass: "carousel-icon-addstock",
            carouselOneTrackClass: "carousel-track-addstock",
            photoOneActualClass: "carousel-photo-addstock",
            hiddenOneFieldsCardContent: ["dymo_label_url", "description", "barcode", "cost", "created_at"]
        });

        // 🔍 Log the full preview card DOM element and item data
        console.log("Preview Card Element:", previewCard);

    
        modalInfo.appendChild(previewCard);
    
        // Re-activate lucide icons inside the modal
        lucide.createIcons();
    
        // Show the modal
        modal.classList.remove("hidden");
        
        updateBarcodeInputStateBasedOnModals();

    }
    
    //processing of the barcode, if present add, if not, render
    async function processBarcode(barcode) {
      if (!barcode) return;
    
      const input = document.getElementById("input-to-search-inventory-item");
      input.value = "";     // Clear input field
      input.focus();        // Auto-focus back for next scan
    
      if (currentBatch[barcode]) {
        incrementCardCount(barcode);
      } else {
        const item = await ExtractItemWithBarcodeFromSupabase(barcode, "item_types", "barcode", true);
        if (item) {
          showModalToConfirmItem(item);
        }
      }
    }
      
    //listener for the barcode
    function searchForBarcodeListener() {
        const input = document.getElementById("input-to-search-inventory-item");
        let debounceTimer = null;
      
        input.addEventListener("input", () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            processBarcode(input.value.trim());
          }, 200);
        });
    }

    //manual verification listerner count 
    setupManualCountVerificationListeners();


//#endregion  
    
document.addEventListener("DOMContentLoaded", async () => {
    const { data: { session }, error } = await supabase.auth.getSession();
  
    if (!session) {
      showToast("Please log in to scan items.");
      console.error("Session not found.");
      // Redirect to login
      setTimeout(() => {
        window.location.href = "index.html";
      }, 1500);
      return;
    }

    try {
      const employee = await loadActiveInventoryWorker(session.user.id);
      if (!employee) {
        showToast("You must be an active worker to add inventory.");
        setTimeout(() => {
          window.location.href = "worker-dashboard.html";
        }, 1500);
        return;
      }
    } catch (workerError) {
      console.error("Failed to verify inventory worker access:", workerError);
      showToast("Could not verify your worker access.");
      setTimeout(() => {
        window.location.href = "index.html";
      }, 1500);
      return;
    }

    // Define currentUser globally for the existing inventory flow.
    window.currentUser = session.user;
  
    console.log("✅ Session loaded. User is authenticated.");
    searchForBarcodeListener();
    document.getElementById("input-to-search-inventory-item").focus();


    //event listeners
    document.addEventListener("click", (e) => {
        const id = e.target.dataset.id; // Common data-id used for most card actions

        // ⏪⏩ Carousel navigation: previous or next
        if (e.target.matches(".carousel-btn-addstock")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide({
              index: index,
              carouselTrackClass: "carousel-track-addstock",
              photoActualClass: "carousel-photo-addstock"
            }) : 
            nextSlide({
              index: index,
              carouselTrackClass: "carousel-track-addstock",
              photoActualClass: "carousel-photo-addstock"
            });      // go left or right
          }
        }

        if (e.target.matches(".carousel-btn")) {
          const index = parseInt(e.target.dataset.carouselIndex, 10); // which carousel
          const dir = e.target.dataset.dir;                            // "prev" or "next"
          if (!isNaN(index) && dir) {
            dir === "prev" ? prevSlide({
              index: index,
              carouselTrackClass: "carousel-track",
              photoActualClass: "carousel-photo"
            }) : 
            nextSlide({
              index: index,
              carouselTrackClass: "carousel-track",
              photoActualClass: "carousel-photo"
            });      // go left or right
          }
        }

    });

    //event listener for the home button
    document.getElementById("toggle-controller").addEventListener("click", () => {
      const header = document.querySelector(".container");
      const toggleBtn = document.getElementById("toggle-controller");
    
      // Toggle panel visibility
      header.classList.toggle("collapsed");
    
      // Trigger haptic pulse animation
      toggleBtn.classList.add("haptic");
      setTimeout(() => toggleBtn.classList.remove("haptic"), 1);
    }); 

    //event listener for the confirm manual count
    setupModalToConfirmItemListeners();

    //event listener for error if the manual count does not match scanned count
    setupMismatchResetModalListener();

    //event listener to assign the location to an item 
    setupAssignLocationModalListeners();

    //event listener to add locations to the locations table
    setupLocationModalListeners();

    let activeLocationDropdown = null;

    document.addEventListener("click", async (e) => {
      const isNameToggle = e.target.id === "assign-location-name-dropdown-toggle";
      const isBarcodeToggle = e.target.id === "assign-location-barcode-dropdown-toggle";

      if (!isNameToggle && !isBarcodeToggle) return;

      const button = e.target;
      const isName = isNameToggle;
      const menu = document.getElementById(isName ? "assign-location-name-dropdown-menu" : "assign-location-barcode-dropdown-menu");

      if (activeLocationDropdown && activeLocationDropdown !== menu) {
        activeLocationDropdown.classList.remove("show");
      }

      if (!menu.dataset.populated) {
        const selectedStoreId = document.getElementById("assign-location-store")?.value?.trim() || "";
        const assignableLocations = await fetchAssignableLocations(selectedStoreId);
        const options = [
          ...new Set(
            assignableLocations
              .map((location) => (isName ? location.location_name : location.location_code))
              .filter(Boolean)
          ),
        ].sort((a, b) => a.localeCompare(b));

        renderDropdownOptionsCustom({
          menuId: isName
            ? "assign-location-name-dropdown-menu"
            : "assign-location-barcode-dropdown-menu",
          options,
          searchId: isName
            ? "assign-location-name-search"
            : "assign-location-barcode-search",
          placeholder: isName
            ? "Search or create location..."
            : "Search by barcode...",
          optionClass: "dropdown-option",
          dataAttribute: isName ? "location" : "barcode",
          optionsContainerClass: isName
            ? "location-name-dropdown-container"
            : "location-barcode-dropdown-container",
            onClick: (value, isNew, el) => {
              const hiddenInputId = isName ? "assign-location-name" : "assign-location-barcode";
              const toggleBtnId = isName
                ? "assign-location-name-dropdown-toggle"
                : "assign-location-barcode-dropdown-toggle";
              const otherHiddenInputId = isName ? "assign-location-barcode" : "assign-location-name";
              const otherToggleBtnId = isName
                ? "assign-location-barcode-dropdown-toggle"
                : "assign-location-name-dropdown-toggle";
            
              const selectedLocation = assignableLocations.find((location) => {
                const compareValue = isName ? location.location_name : location.location_code;
                return String(compareValue || "") === String(value || "");
              });

              if (selectedLocation) {
                const locationName = selectedLocation.location_name || "";
                const locationCode = selectedLocation.location_code || "";
                document.getElementById("assign-location-name").value = locationName;
                document.getElementById("assign-location-barcode").value = locationCode;
                document.getElementById("assign-location-name-dropdown-toggle").innerText = locationName || "Select Location Name";
                document.getElementById("assign-location-barcode-dropdown-toggle").innerText = locationCode || "Select Barcode";

                const barcode = document.getElementById("modal-assign-location")?.dataset?.barcode || "";
                const batchItem = currentBatch[barcode];
                renderLocationIntelligence("assign-location-intelligence", selectedLocation.id, {
                  referenceWeight: Number(batchItem?.item?.weight),
                  referenceLabel: batchItem?.item?.title || "this item",
                });
              } else {
                document.getElementById(hiddenInputId).value = value;
                document.getElementById(toggleBtnId).innerText = value;
                document.getElementById(otherHiddenInputId).value = "";
                document.getElementById(otherToggleBtnId).innerText = isName
                  ? "Select Barcode"
                  : "Select Location Name";
                renderLocationIntelligenceEmpty("assign-location-intelligence");
              }
            
              if (isNew && isName) {
                // 🪄 Only open the Add Location modal if creating a new location by name
                pendingAssignLocationDraft = {
                  locationName: value,
                  storeId: selectedStoreId,
                };
                document.getElementById("location-name").value = value;
                toggleModal(true); // 👈 This is the key line that was missing
              } else {
                showToast(`🏷️ Selected ${isName ? "location" : "barcode"}: ${value}`);
              }
            
              menu.classList.remove("show");
              activeLocationDropdown = null;
            }
            
        });

        menu.dataset.populated = "true";
      }

      menu.classList.toggle("show");
      activeLocationDropdown = menu.classList.contains("show") ? menu : null;
    });

    //now the event listener for the button
    document.getElementById("btn-manual-assign").addEventListener("click", () => {
      const barcodes = Object.keys(currentBatch);
      if (barcodes.length === 0) {
        showToast("⚠️ No items scanned.");
        return;
      }

      const firstBarcode = barcodes[0];
      const batchItem = currentBatch[firstBarcode];

      showAssignLocationModal(batchItem);
    });


    //listerner for the password modal 
    setupPasswordConfirmationModal();
    bindInventoryLabelPrintControls();


    // 🔁 Always refocus on barcode input when clicking outside modal or toast
    document.addEventListener("click", (e) => {
      const input = document.getElementById("input-to-search-inventory-item");
      const modal = document.getElementById("modalToConfirmItem");

      const clickedInsideModal = modal && modal.contains(e.target);
      const clickedToast = e.target.closest("#toast-container");
      const clickedInput = e.target === input;

      if (!clickedInsideModal && !clickedToast && !clickedInput) {
        input.focus();
      }
    });

    window.addEventListener("bulkbag:captured", async (e) => {
  const detail = e.detail;
  const item = pendingBulkItem;
  if (!item || !detail) return;

  // Ensure the item has a card in the batch list
  if (!currentBatch[item.barcode]) {
    const card = createCardForItem(item);
    currentBatch[item.barcode] = {
      item,
      count: 0,
      maxCount: item.stock_batch_size_update || 10,
      cardEl: card
    };
  }

  // Increase the scanned count by the estimated qty from the bulk modal
  currentBatch[item.barcode].count += Number(detail.estimated_qty || 0);

  const unitDisplay = currentBatch[item.barcode].cardEl.querySelector(".units-scanned");
  if (unitDisplay) {
    unitDisplay.textContent = `Units Scanned: ${currentBatch[item.barcode].count}`;
  }

  // Generate a bag barcode + stash bulk payload so we can log the registry after location confirm
  const bagBarcode =
    window.addItemBulkModule?.generateBagBarcode?.() ||
    `BAG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

  currentBatch[item.barcode].bag_info = {
    bagBarcode,
    bulkPayload: detail.payload
  };

  showToast(`👜 Bulk bag captured: ${detail.estimated_qty} units`);
  // Go straight to location selection
  showAssignLocationModal(currentBatch[item.barcode]);

  // clear pointer until next time
  pendingBulkItem = null;
    });

    if (window.addItemBulkModule?.setupBulkModalOpeners) {
      window.addItemBulkModule.setupBulkModalOpeners();
    } else {
      console.warn("Bulk module not loaded.");
    }


});

