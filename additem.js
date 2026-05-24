

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
let selectedAdminParentLocation = null;
let stockPlacementMode = "tray";
const stockPlacementScanTimers = {};
const OG_WEBSITE_QR_URL = "https://www.og-jewelers.com/";
const IMAGE_PROCESS_FUNCTION_NAME = "process-inventory-image";
const ADD_ITEM_SOURCE_PHOTO_BUCKET = "photos";
const ADD_ITEM_PUBLIC_EBAY_PHOTO_BUCKET = "public-ebay-photos";
const ADD_ITEM_RELOAD_TOP_KEY = "og.addItem.reloadTopAfterSuccess";
const ADD_ITEM_EBAY_CATEGORY_OPTIONS = [
  { id: "261988", label: "Fine Jewelry > Bracelets & Charms", terms: ["bracelet", "bangle", "tennis"] },
  { id: "261989", label: "Fine Jewelry > Brooches & Pins", terms: ["brooch", "pin"] },
  { id: "261990", label: "Fine Jewelry > Earrings", terms: ["earring", "earrings", "stud", "hoop"] },
  { id: "261992", label: "Fine Jewelry > Jewelry Sets", terms: ["jewelry set", "set"] },
  { id: "261993", label: "Fine Jewelry > Necklaces & Pendants", terms: ["necklace", "pendant", "chain", "charm"] },
  { id: "261995", label: "Fine Jewelry > Toe Rings", terms: ["toe ring"] },
  { id: "261994", label: "Fine Jewelry > Rings", terms: ["ring"] },
];
let automaticDymoTimer = null;
let addItemSuccessReloadTimer = null;
let latestItemLabelPrintState = null;

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

  function scrollAddItemPageToTop() {
    try {
      window.history.scrollRestoration = "manual";
    } catch (_) {}

    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }

  function restoreTopAfterSuccessfulReload() {
    try {
      if (window.sessionStorage?.getItem(ADD_ITEM_RELOAD_TOP_KEY) !== "true") return;
      window.sessionStorage.removeItem(ADD_ITEM_RELOAD_TOP_KEY);
    } catch (_) {
      return;
    }

    scrollAddItemPageToTop();
    window.requestAnimationFrame(() => {
      scrollAddItemPageToTop();
    });
  }

  function reloadAddItemPageForNextItem() {
    if (addItemSuccessReloadTimer) {
      clearTimeout(addItemSuccessReloadTimer);
      addItemSuccessReloadTimer = null;
    }

    try {
      window.sessionStorage?.setItem(ADD_ITEM_RELOAD_TOP_KEY, "true");
    } catch (_) {}

    scrollAddItemPageToTop();
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    window.location.reload();
  }

  function getSavedInventoryQuantity(options = {}) {
    const stockQuantity = Number(options.stockInfo?.quantity);
    const bulkQuantity = Number(options.bulkInfo?.data?.estimated_qty);
    if (Number.isFinite(bulkQuantity) && bulkQuantity > 0) return Math.floor(bulkQuantity);
    if (Number.isFinite(stockQuantity) && stockQuantity > 0) return Math.floor(stockQuantity);
    return 1;
  }

  function getLabelPrintElements() {
    return {
      labelsPerOrderInput: document.getElementById("item-labels-per-order"),
      countEl: document.getElementById("item-label-print-count"),
      formulaEl: document.getElementById("item-label-print-formula"),
      statusEl: document.getElementById("item-label-print-status"),
      batchButton: document.getElementById("item-label-print-batch"),
      oneButton: document.getElementById("item-label-print-one"),
      laterButton: document.getElementById("item-label-print-later"),
    };
  }

  function getLabelsPerOrderValue() {
    const input = document.getElementById("item-labels-per-order");
    const value = Math.floor(Number(input?.value || 2));
    return Number.isFinite(value) && value > 0 ? value : 2;
  }

  function getRecommendedLabelCount() {
    const quantity = Math.max(1, Number(latestItemLabelPrintState?.inventoryQuantity || 1));
    const labelsPerOrder = getLabelsPerOrderValue();
    return Math.max(1, Math.ceil(quantity / labelsPerOrder));
  }

  function updateLabelPrintEstimate() {
    const state = latestItemLabelPrintState;
    const elements = getLabelPrintElements();
    if (!state) return;

    const quantity = Math.max(1, Number(state.inventoryQuantity || 1));
    const labelsPerOrder = getLabelsPerOrderValue();
    const recommendedCount = getRecommendedLabelCount();
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

  function setLabelPrintBusy(isBusy) {
    const elements = getLabelPrintElements();
    [elements.batchButton, elements.oneButton, elements.laterButton, elements.labelsPerOrderInput]
      .filter(Boolean)
      .forEach((element) => {
        element.disabled = Boolean(isBusy);
      });
  }

  function setLabelPrintStatus(message = "", type = "info") {
    const statusEl = document.getElementById("item-label-print-status");
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle("inline-status-muted", type !== "error" && type !== "success");
    statusEl.classList.toggle("inline-status-error", type === "error");
    statusEl.classList.toggle("inline-status-success", type === "success");
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

  async function recordItemLabelPreference(strategy, printQuantity, labelsPerOrder, notes = "") {
    const state = latestItemLabelPrintState;
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

  function scheduleReloadAfterLabelDecision(delayMs = 1200) {
    if (addItemSuccessReloadTimer) clearTimeout(addItemSuccessReloadTimer);
    addItemSuccessReloadTimer = window.setTimeout(reloadAddItemPageForNextItem, delayMs);
  }

  async function printSavedItemLabels(copies, strategy) {
    const state = latestItemLabelPrintState;
    if (!state?.dymoXml) {
      throw new Error("The saved DYMO label is not available for printing.");
    }

    return window.dymoModule.printDymoLabelXml(state.dymoXml, {
      copies,
      barcode: state.item?.barcode || "",
      title: state.item?.title || "",
      labelKind: "ItemLabel",
      listenerOnly: true,
      onProgress: (current, total, printer) => {
        setLabelPrintStatus(`Queueing automatic print label ${current} of ${total} for ${printer?.name || "local print helper"}...`);
      },
    });
  }

  async function handleLabelPrintDecision(strategy) {
    const state = latestItemLabelPrintState;
    if (!state) return;

    const labelsPerOrder = getLabelsPerOrderValue();
    const printQuantity = strategy === "individual_batch" ? getRecommendedLabelCount() : strategy === "collective_only" ? 1 : null;

    setLabelPrintBusy(true);
    try {
      if (strategy === "deferred") {
        const copied = await copyTextToClipboard(state.item?.barcode);
        const recorded = await recordItemLabelPreference("deferred", null, labelsPerOrder, "Label printing deferred; barcode copied.");
        setLabelPrintStatus(`${copied ? "Barcode copied to clipboard." : "Could not copy barcode automatically."}${recorded ? "" : " Label preference will record after the migration is pushed."}`, copied ? "success" : "error");
        scheduleReloadAfterLabelDecision(copied ? 1100 : 2200);
        return;
      }

      const printResult = await printSavedItemLabels(printQuantity, strategy);
      const printVerb = printResult?.mode === "queued-download" ? "Queued" : "Printed";
      const notes = strategy === "collective_only"
        ? `${printVerb} one collective label; item should not receive individual labels.`
        : `${printVerb} recommended label batch after add-item save.`;
      const recorded = await recordItemLabelPreference(strategy, printQuantity, labelsPerOrder, notes);
      const delivery = printResult?.mode === "queued-download"
        ? `Queued ${printResult.filename || "the DYMO label"} for automatic local printing`
        : `Printed ${printQuantity} label${printQuantity === 1 ? "" : "s"}`;
      setLabelPrintStatus(`${delivery}.${recorded ? " Reloading for the next item..." : " Label tag will record after the migration is pushed. Reloading..."}`, "success");
      scheduleReloadAfterLabelDecision(recorded ? 1300 : 2400);
    } catch (error) {
      console.error("Label print decision failed:", error);
      setLabelPrintStatus(`Could not complete label printing: ${error?.message || error}`, "error");
      setLabelPrintBusy(false);
    }
  }

  function bindItemLabelPrintModalControls() {
    const elements = getLabelPrintElements();
    elements.labelsPerOrderInput?.addEventListener("input", updateLabelPrintEstimate);
    if (elements.batchButton) {
      elements.batchButton.onclick = () => handleLabelPrintDecision("individual_batch");
    }
    if (elements.oneButton) {
      elements.oneButton.onclick = () => handleLabelPrintDecision("collective_only");
    }
    if (elements.laterButton) {
      elements.laterButton.onclick = () => handleLabelPrintDecision("deferred");
    }
  }

  function showItemSaveSuccessModal(item, options = {}) {
    const modal = document.getElementById("item-save-success-modal");
    const titleEl = document.getElementById("item-save-success-name");
    const barcodeEl = document.getElementById("item-save-success-barcode");
    const stockEl = document.getElementById("item-save-success-stock");
    const copyEl = document.getElementById("item-save-success-copy");
    const continueButton = document.getElementById("item-save-success-continue");
    const labelsPerOrderInput = document.getElementById("item-labels-per-order");

    if (!modal) {
      reloadAddItemPageForNextItem();
      return;
    }

    if (addItemSuccessReloadTimer) {
      clearTimeout(addItemSuccessReloadTimer);
      addItemSuccessReloadTimer = null;
    }

    const photoCount = Number(options.photoCount || 0);
    const stockInfo = options.stockInfo || null;
    const inventoryQuantity = getSavedInventoryQuantity(options);
    const photoLabel = `${photoCount} photo${photoCount === 1 ? "" : "s"}`;
    const stockLabel = stockInfo?.quantity
      ? ` Stock placement: ${stockInfo.quantity} unit${Number(stockInfo.quantity) === 1 ? "" : "s"} to ${stockInfo.location_name || "selected location"}.`
      : "";

    latestItemLabelPrintState = {
      item,
      dymoXml: options.dymoXml || "",
      dymoPath: options.dymoPath || item?.dymo_label_url || "",
      inventoryQuantity,
    };

    if (titleEl) titleEl.textContent = item?.title || "New item";
    if (barcodeEl) barcodeEl.textContent = item?.barcode ? `Barcode ${item.barcode}` : "Barcode ready";
    if (stockEl) stockEl.textContent = `${inventoryQuantity.toLocaleString()} inventory unit${inventoryQuantity === 1 ? "" : "s"} just added`;
    if (copyEl) {
      copyEl.textContent = `The item, DYMO label, and ${photoLabel} were saved successfully.${stockLabel} Choose how many physical labels should print before the form resets for the next item.`;
    }

    if (labelsPerOrderInput) labelsPerOrderInput.value = "2";
    bindItemLabelPrintModalControls();
    updateLabelPrintEstimate();
    setLabelPrintStatus("Ready to queue automatic printing through the local helper. Keep tools/start-dymo-print-helper.bat open.");
    setLabelPrintBusy(false);

    continueButton?.addEventListener("click", reloadAddItemPageForNextItem, { once: true });

    modal.classList.remove("hidden");
    modal.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");
    document.getElementById("item-label-print-batch")?.focus();
  }

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

  function clearAutomaticDymoGeneration() {
    if (automaticDymoTimer) {
      window.clearTimeout(automaticDymoTimer);
      automaticDymoTimer = null;
    }
  }

  async function ensureCurrentDymoLabelForSubmit(barcode) {
    const normalizedBarcode = String(barcode || "").trim();
    if (!normalizedBarcode) {
      throw new Error("Please generate or scan a barcode before submitting.");
    }

    const prepared = window.dymoModule?.getPreparedDymoLabel?.() || {
      xml: window.latestDymoXml || "",
      url: window.latestDymoUrl || "",
      barcode: window.latestDymoBarcode || "",
    };

    if (
      !prepared.xml ||
      !prepared.url ||
      !prepared.url.includes("labels/") ||
      prepared.barcode !== normalizedBarcode
    ) {
      await window.dymoModule.generateDymoLabelFromForm({
        downloadPreview: false,
        silent: true,
      });
    }

    const refreshed = window.dymoModule?.getPreparedDymoLabel?.() || {
      xml: window.latestDymoXml || "",
      url: window.latestDymoUrl || "",
      barcode: window.latestDymoBarcode || "",
    };

    if (!refreshed.xml || !refreshed.url || !refreshed.url.includes("labels/")) {
      throw new Error("The DYMO label could not be prepared. Please try again.");
    }

    if (refreshed.barcode && refreshed.barcode !== normalizedBarcode) {
      throw new Error(`The staged DYMO label belongs to ${refreshed.barcode}, but this item is using ${normalizedBarcode}.`);
    }

    return refreshed;
  }

  async function attachDymoLabelToSavedItem(itemId, barcode) {
    void itemId;
    return dymoModule.uploadFinalDymoLabel({
      expectedBarcode: barcode,
      skipItemPathCheck: true,
    });
  }

  function resetAddItemDraftStateAfterSuccess() {
    clearAutomaticDymoGeneration();
    document.getElementById("add-item-form")?.reset();
    document.dispatchEvent(new Event("add-item-form:reset"));
    if (previewContainer) previewContainer.innerHTML = "";
    uploadedImages = [];
    window.dymoModule?.clearPendingDymoLabel?.({
      statusMessage: "Fresh barcode and label will be prepared after the page reloads.",
    });
    window.latestDymoXml = "";
    window.latestDymoUrl = "";
    window.latestDymoBarcode = "";
    window.latestDymoGeneratedAt = "";
    latestDymoXml = "";
    if (pricePerWeightInput && pricePerWeightInput.dataset.autoSilver925 !== "true") {
      pricePerWeightInput.value = "";
    }
    if (autoCostCheckbox) autoCostCheckbox.checked = true;
    const ebaySyncEnabled = document.getElementById("ebay-sync-enabled");
    if (ebaySyncEnabled) ebaySyncEnabled.checked = true;
    const ebayCategorySelect = document.getElementById("ebay-category-id");
    if (ebayCategorySelect) ebayCategorySelect.value = "";
    updateAddItemEbayReadiness({ infer: false });
  }

  function normalizeInventoryMetal(value) {
    const normalized = String(value || "").trim().toLowerCase();
    if (!normalized) return null;
    if (normalized.includes("silver")) return "silver";
    if (normalized.includes("gold")) return "gold";
    return null;
  }

  function purityToBasisPoints(value) {
    const normalized = String(value || "").trim().toLowerCase();
    const exact = {
      "999": 9990,
      "fine silver": 9990,
      "950": 9500,
      "925": 9250,
      "900": 9000,
      "850": 8500,
      "24k": 10000,
      "22k": 9167,
      "18k": 7500,
      "14k": 5833,
      "10k": 4167,
      "316l": null,
      "304": null,
    };
    if (Object.prototype.hasOwnProperty.call(exact, normalized)) return exact[normalized];

    const numeric = Number(normalized.replace(/[^\d.]/g, ""));
    if (!Number.isFinite(numeric) || numeric <= 0) return null;
    if (numeric <= 24 && normalized.includes("k")) return Math.round((numeric / 24) * 10000);
    if (numeric <= 1000) return Math.round(numeric * 10);
    if (numeric <= 10000) return Math.round(numeric);
    return null;
  }

  function getAssistedMaterialPurityForSave() {
    const selected = window.addItemAssistedModule?.getSelectedMaterialPurity?.() || {};
    return {
      metal: normalizeInventoryMetal(selected.material),
      purity_basis_points: purityToBasisPoints(selected.purity),
    };
  }

  document.addEventListener("add-item-assisted:metadata-change", () => updateAddItemEbayReadiness());

  function escapeAddItemHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeAddItemRegExp(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function addItemTextMatchesTerm(text, term) {
    const pattern = escapeAddItemRegExp(term).replace(/\s+/g, "\\s+");
    return new RegExp(`\\b${pattern}\\b`, "i").test(text);
  }

  function getAddItemEbayCategoryOption(categoryId) {
    const normalized = String(categoryId || "").trim();
    return ADD_ITEM_EBAY_CATEGORY_OPTIONS.find((option) => option.id === normalized) || null;
  }

  function inferAddItemEbayCategory() {
    const text = [
      document.getElementById("title")?.value || "",
      document.getElementById("description")?.value || "",
      document.getElementById("category")?.value || "",
      document.getElementById("category-dropdown-toggle")?.textContent || "",
    ].join(" ").toLowerCase();

    return ADD_ITEM_EBAY_CATEGORY_OPTIONS.find((option) => (
      option.terms.some((term) => addItemTextMatchesTerm(text, term))
    )) || null;
  }

  function getAddItemEbayTextBlob() {
    return [
      document.getElementById("title")?.value || "",
      document.getElementById("description")?.value || "",
      document.getElementById("category")?.value || "",
      document.getElementById("category-dropdown-toggle")?.textContent || "",
      document.getElementById("assisted-stone-type")?.value || "",
      document.getElementById("assisted-material")?.value || "",
      document.getElementById("assisted-purity")?.value || "",
      document.getElementById("assisted-length")?.value || "",
    ].join(" ").toLowerCase();
  }

  function addItemAspectValue(value) {
    const normalized = String(value || "").trim();
    return normalized ? [normalized] : null;
  }

  function setAddItemAspect(aspects, name, value) {
    const normalized = addItemAspectValue(value);
    if (normalized) aspects[name] = normalized;
  }

  function inferAddItemEbayType(categoryId, text) {
    if (categoryId === "261988") return "Bracelet";
    if (categoryId === "261990") return "Earrings";
    if (categoryId === "261994" || categoryId === "261995") return "Ring";
    if (categoryId === "261992") return "Jewelry Set";
    if (addItemTextMatchesTerm(text, "bracelet") || addItemTextMatchesTerm(text, "tennis")) return "Bracelet";
    if (addItemTextMatchesTerm(text, "necklace")) return "Necklace";
    if (addItemTextMatchesTerm(text, "pendant") || addItemTextMatchesTerm(text, "charm")) return "Pendant";
    if (addItemTextMatchesTerm(text, "ring")) return "Ring";
    if (addItemTextMatchesTerm(text, "earring") || addItemTextMatchesTerm(text, "earrings")) return "Earrings";
    if (addItemTextMatchesTerm(text, "chain")) return "Chain";
    return "Jewelry";
  }

  function inferAddItemEbayStyle(categoryId, text) {
    if (addItemTextMatchesTerm(text, "tennis")) return "Tennis";
    if (addItemTextMatchesTerm(text, "halo")) return "Halo";
    if (addItemTextMatchesTerm(text, "heart")) return "Heart";
    if (addItemTextMatchesTerm(text, "cross")) return "Cross";
    if (addItemTextMatchesTerm(text, "cuban")) return "Cuban";
    if (addItemTextMatchesTerm(text, "link")) return "Link";
    if (categoryId === "261988") return "Tennis";
    if (categoryId === "261993") return "Pendant";
    return "Jewelry";
  }

  function inferAddItemEbayMetal(materialPurity, text) {
    const metal = String(materialPurity?.metal || "").toLowerCase();
    if (metal.includes("silver") || text.includes("silver") || text.includes("925")) return "Fine Silver";
    if (text.includes("white gold")) return "White Gold";
    if (text.includes("rose gold")) return "Rose Gold";
    if (metal.includes("gold") || text.includes("gold")) return "Yellow Gold";
    if (metal.includes("platinum") || text.includes("platinum")) return "Platinum";
    return "";
  }

  function inferAddItemEbayPurity(materialPurity, text) {
    const basisPoints = Number(materialPurity?.purity_basis_points || 0);
    if (basisPoints >= 10000 || text.includes("24k")) return "24k";
    if (basisPoints >= 9990 || text.includes("999")) return "999";
    if (basisPoints >= 9250 || text.includes("925") || text.includes("sterling silver")) return "925";
    if (basisPoints >= 9167 || text.includes("22k")) return "22k";
    if (basisPoints >= 7500 || text.includes("18k")) return "18k";
    if (basisPoints >= 5833 || text.includes("14k")) return "14k";
    if (basisPoints >= 4167 || text.includes("10k")) return "10k";
    return "";
  }

  function inferAddItemEbayMainStone(text) {
    const stone = String(document.getElementById("assisted-stone-type")?.value || "").trim();
    const stoneText = `${stone} ${text}`.toLowerCase();
    if (stoneText.includes("simulated diamond") || stoneText.includes("cubic zirconia") || /\bcz\b/i.test(stoneText)) return "Simulated Diamond";
    if (stoneText.includes("sapphire")) return "Sapphire";
    if (stoneText.includes("diamond")) return "Diamond";
    if (stoneText.includes("ruby")) return "Ruby";
    if (stoneText.includes("emerald")) return "Emerald";
    if (stoneText.includes("turquoise")) return "Turquoise";
    if (stoneText.includes("no stone") || stoneText.includes("without stone")) return "No Stone";
    return stone || "Unknown";
  }

  function inferAddItemEbayColor(text) {
    const colors = ["pink", "purple", "blue", "green", "red", "black", "white", "clear", "yellow", "gold", "silver", "turquoise", "multicolor", "rainbow"];
    const found = colors.find((color) => addItemTextMatchesTerm(text, color));
    if (!found) return "";
    if (found === "clear") return "White";
    return found.charAt(0).toUpperCase() + found.slice(1);
  }

  function buildAddItemEbayAspects(categoryId, materialPurity, weightValue = null, itemLengthValue = null) {
    const text = getAddItemEbayTextBlob();
    const aspects = {};

    setAddItemAspect(aspects, "Brand", "Unbranded");
    setAddItemAspect(aspects, "Type", inferAddItemEbayType(categoryId, text));
    setAddItemAspect(aspects, "Style", inferAddItemEbayStyle(categoryId, text));
    setAddItemAspect(aspects, "Main Stone", inferAddItemEbayMainStone(text));
    setAddItemAspect(aspects, "Metal", inferAddItemEbayMetal(materialPurity, text));
    setAddItemAspect(aspects, "Metal Purity", inferAddItemEbayPurity(materialPurity, text));

    const color = inferAddItemEbayColor(text);
    setAddItemAspect(aspects, "Main Stone Color", color);

    const weight = Number(weightValue);
    if (Number.isFinite(weight) && weight > 0) setAddItemAspect(aspects, "Item Weight", `${weight} g`);
    setAddItemAspect(aspects, "Item Length", itemLengthValue);

    return aspects;
  }

  function populateAddItemEbayCategorySelect() {
    const select = document.getElementById("ebay-category-id");
    if (!select) return;

    select.innerHTML = [
      '<option value="">Choose an eBay category...</option>',
      ...ADD_ITEM_EBAY_CATEGORY_OPTIONS.map((option) => (
        `<option value="${escapeAddItemHtml(option.id)}">${escapeAddItemHtml(option.label)} (${escapeAddItemHtml(option.id)})</option>`
      )),
    ].join("");
  }

  function collectAddItemEbayReadiness() {
    const syncEnabled = document.getElementById("ebay-sync-enabled")?.checked !== false;
    const categoryId = String(document.getElementById("ebay-category-id")?.value || "").trim();
    const materialPurity = getAssistedMaterialPurityForSave();
    const photoFiles = photoInput?.files || [];
    const assistedSelectedImages = window.addItemAssistedModule?.getSelectedUploadedImagesForSave?.() || [];
    const pendingStock = pendingStockAssignments[barcodeInput?.value?.trim() || ""] || null;
    const missing = [];

    if (!syncEnabled) return { syncEnabled, categoryId, missing };
    if (!getAddItemEbayCategoryOption(categoryId)) missing.push("eBay category");
    if (!String(document.getElementById("title")?.value || "").trim()) missing.push("title");
    if (!String(document.getElementById("description")?.value || "").trim()) missing.push("description");
    if (!(parseFloat(document.getElementById("sale-price")?.value?.replace(/,/g, "") || "0") > 0)) missing.push("sale price");
    if (!materialPurity.metal) missing.push("material");
    if (!materialPurity.purity_basis_points) missing.push("purity");
    if (!String(document.getElementById("assisted-stone-type")?.value || "").trim()) missing.push("stone type");
    if (!photoFiles.length && !assistedSelectedImages.length) missing.push("photo");
    if (!pendingStock || !(Number(pendingStock.quantity) > 0)) missing.push("stock quantity");

    return { syncEnabled, categoryId, missing };
  }

  function updateAddItemEbayReadiness(options = {}) {
    const select = document.getElementById("ebay-category-id");
    const enabled = document.getElementById("ebay-sync-enabled");
    const summary = document.getElementById("ebay-readiness-summary");
    if (!select || !enabled || !summary) return;

    select.disabled = !enabled.checked;
    if (enabled.checked && !select.value && options.infer !== false) {
      const inferred = inferAddItemEbayCategory();
      if (inferred) select.value = inferred.id;
    }

    const readiness = collectAddItemEbayReadiness();
    if (!readiness.syncEnabled) {
      summary.className = "form-field form-field-wide ebay-readiness-summary is-muted";
      summary.textContent = "This item will be saved internally but excluded from eBay sync.";
      return;
    }

    const category = getAddItemEbayCategoryOption(readiness.categoryId);
    if (!readiness.missing.length) {
      summary.className = "form-field form-field-wide ebay-readiness-summary is-ready";
      summary.textContent = `Ready for eBay sync as ${category.label}.`;
      return;
    }

    summary.className = "form-field form-field-wide ebay-readiness-summary is-warning";
    summary.textContent = `Needs before clean eBay publishing: ${readiness.missing.join(", ")}.`;
  }

  function setupAddItemEbayReadiness() {
    populateAddItemEbayCategorySelect();
    updateAddItemEbayReadiness();

    ["title", "description", "category", "assisted-material", "assisted-purity", "assisted-stone-type", "assisted-length", "sale-price", "scanned-barcode"].forEach((id) => {
      document.getElementById(id)?.addEventListener("input", () => updateAddItemEbayReadiness());
      document.getElementById(id)?.addEventListener("change", () => updateAddItemEbayReadiness());
    });

    document.getElementById("ebay-sync-enabled")?.addEventListener("change", () => updateAddItemEbayReadiness());
    document.getElementById("ebay-category-id")?.addEventListener("change", () => updateAddItemEbayReadiness({ infer: false }));
    document.addEventListener("click", (event) => {
      if (event.target?.closest?.("#category-dropdown-menu .dropdown-option")) {
        setTimeout(() => updateAddItemEbayReadiness(), 0);
      }
    });
  }


  // === MULTI-IMAGE PREVIEW & UPLOAD ===
  function setupPhotoUploadPreview() {
    if (!photoInput || !previewContainer) return;

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

  function normalizeAddItemPhotoPath(value) {
    return String(value || "").split("?")[0].replace(/^\/+/, "");
  }

  function addItemPhotoFilename(path) {
    return normalizeAddItemPhotoPath(path).split("/").pop() || "";
  }

  function addItemPublicEbayPhotoPath(itemId, sourcePath) {
    const filename = addItemPhotoFilename(sourcePath);
    return itemId && filename ? `${itemId}/${filename}` : "";
  }

  function addItemPhotoContentType(path, fallback = "image/jpeg") {
    const ext = addItemPhotoFilename(path).split(".").pop()?.toLowerCase();
    if (ext === "png") return "image/png";
    if (ext === "webp") return "image/webp";
    if (ext === "gif") return "image/gif";
    if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
    return fallback;
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

    try {
      const { data, error } = await supabase.functions.invoke(IMAGE_PROCESS_FUNCTION_NAME, {
        body: {
          bucket: sourceBucket,
          imagePath: sourcePath,
          background: "copy-to-photos",
        },
      });

      if (!error && data?.ok && data?.bucket === "photos" && data?.path) {
        return data.path;
      }

      console.warn("Server-side assisted image copy did not complete; trying browser fallback.", error || data);
    } catch (copyError) {
      console.warn("Server-side assisted image copy failed; trying browser fallback.", copyError);
    }

    let downloadedBlob = null;
    const { data: storageBlob, error: downloadError } = await supabase
      .storage
      .from(sourceBucket)
      .download(sourcePath);

    if (!downloadError && storageBlob) {
      downloadedBlob = storageBlob;
    } else if (image?.previewUrl) {
      const response = await fetch(image.previewUrl);
      if (!response.ok) {
        throw new Error(`Failed to download assisted image preview (${response.status}).`);
      }
      downloadedBlob = await response.blob();
    }

    if (!downloadedBlob) {
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

  async function copyItemPhotosToPublicEbayBucket(item, photoPaths) {
    const itemId = String(item?.id || "").trim();
    const paths = [...new Set((photoPaths || []).map(normalizeAddItemPhotoPath).filter(Boolean))];
    if (!itemId || !paths.length) return { copied: 0, failed: 0 };

    let copied = 0;
    let failed = 0;

    for (const sourcePath of paths.slice(0, 12)) {
      if (/^https?:\/\//i.test(sourcePath)) continue;

      const publicPath = addItemPublicEbayPhotoPath(itemId, sourcePath);
      if (!publicPath) continue;

      try {
        const { data: blob, error: downloadError } = await supabase
          .storage
          .from(ADD_ITEM_SOURCE_PHOTO_BUCKET)
          .download(sourcePath);

        if (downloadError || !blob) {
          throw new Error(downloadError?.message || "Photo was not available in the item photo bucket.");
        }

        const { error: uploadError } = await supabase
          .storage
          .from(ADD_ITEM_PUBLIC_EBAY_PHOTO_BUCKET)
          .upload(publicPath, blob, {
            upsert: true,
            contentType: blob.type || addItemPhotoContentType(sourcePath),
          });

        if (uploadError) throw uploadError;
        copied += 1;
      } catch (error) {
        failed += 1;
        console.warn(`Could not prepare eBay public photo for ${sourcePath}:`, error);
      }
    }

    return { copied, failed };
  }

  async function ensureItemPhotosSaved(item, photoPaths) {
    const itemId = item?.id;
    const paths = [...new Set((photoPaths || []).filter(Boolean))];
    if (!itemId || !paths.length) return item?.photos || [];

    const savedPhotos = Array.isArray(item?.photos) ? item.photos.filter(Boolean) : [];
    const missing = paths.filter((path) => !savedPhotos.includes(path));
    if (!missing.length) return savedPhotos;

    const { data, error } = await supabase.rpc("append_item_photos", {
      _item_id: itemId,
      _photo_paths: missing,
    });

    if (error) {
      throw new Error(error.message || "Item saved, but selected photos could not be attached.");
    }

    return Array.isArray(data) ? data : paths;
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
          if (hiddenInputId === "category") {
            updateAddItemEbayReadiness();
          }

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
      updateAddItemEbayReadiness();
    }
  }

  function scheduleAutomaticDymoGeneration(delayMs = 450) {
    if (automaticDymoTimer) {
      window.clearTimeout(automaticDymoTimer);
    }

    automaticDymoTimer = window.setTimeout(async () => {
      automaticDymoTimer = null;
      if (!barcodeInput?.value || !qrInput?.value || !window.dymoModule?.generateDymoLabelFromForm) return;

      try {
        await window.dymoModule.generateDymoLabelFromForm({
          downloadPreview: false,
          silent: true,
        });
      } catch (error) {
        console.warn("Automatic DYMO generation skipped:", error?.message || error);
      }
    }, delayMs);
  }

  //listeners for the calculation and calculation of the final prince
  function setupCostAndPriceListeners() {
    document.getElementById("weight")?.addEventListener('input', () => {
      updateCostFromWeight();
      scheduleAutomaticDymoGeneration();
    });
    pricePerWeightInput?.addEventListener('input', updateCostFromWeight);
    document.getElementById('cost')?.addEventListener('input', () => {
      const cost = parseFloat(document.getElementById('cost').value.replace(/,/g, ''));
      if (cost > 0) {
        const salePrice = Math.ceil((cost * 7.5) / 10) * 10;
        document.getElementById('sale-price').value = salePrice.toLocaleString("en-US");
      } else {
        document.getElementById('sale-price').value = '';
      }
      updateAddItemEbayReadiness();
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
      document.getElementById("qr-code").value = OG_WEBSITE_QR_URL;
      renderQR(OG_WEBSITE_QR_URL);
      scheduleAutomaticDymoGeneration();
    }
  });

  qrInput?.addEventListener('input', () => {
    const url = qrInput.value.trim();
    if (url) {
      renderQR(url);
      scheduleAutomaticDymoGeneration();
    }
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
  function generateNewItemBarcode(options = {}) {
    const code = 'OG' + Date.now();
    barcodeInput.value = code;
    renderBarcode(code);

    if (options.generateDymo !== false) {
      scheduleAutomaticDymoGeneration(options.dymoDelayMs ?? 250);
    }

    return code;
  }

  function applyDefaultQrWebsite() {
    if (qrTypeSelect) {
      qrTypeSelect.value = "website";
    }
    typeqr = "website";
    if (qrInput) {
      qrInput.value = OG_WEBSITE_QR_URL;
    }
    renderQR(OG_WEBSITE_QR_URL);
  }

  function applyDefaultItemAutomation(options = {}) {
    applyDefaultQrWebsite();

    if (options.generateBarcode !== false && !barcodeInput?.value) {
      generateNewItemBarcode({
        generateDymo: options.generateDymo !== false,
        dymoDelayMs: options.dymoDelayMs ?? 350,
      });
    } else if (options.generateDymo !== false) {
      scheduleAutomaticDymoGeneration(options.dymoDelayMs ?? 350);
    }
  }

  function setupBarcodeGeneration() {
    document.getElementById('generate-barcode')?.addEventListener('click', () => {
      generateNewItemBarcode({ generateDymo: true });
    });
  }

//#endregion

//#region functions needed for the add stock modal
  // === modal to add stock and location ===
  async function showAdminLocationStockModal(itemId, defaultQty = null) {
    const modal = document.getElementById("modal-admin-assign-location");

    const qtyEl = document.getElementById("admin-stock-quantity");
    // Only set/clear when explicitly given a default; otherwise keep whatever is there
    if (defaultQty !== null && Number.isFinite(defaultQty)) {
      qtyEl.value = String(defaultQty);
    } else {
      qtyEl.value = "1";
    }

    modal.dataset.itemId = itemId;
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    activeStoreOptions = activeStoreOptions.length ? activeStoreOptions : await fetchActiveStores();
    activeAdminLocationOptions = await fetchAdminLocationOptions();
    resetAdminStockPlacementFlow();
    focusPlacementInput(stockPlacementMode === "container" ? "placement-parent-barcode" : "placement-tray-barcode");
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
      .select("id, location_name, location_code, type, store_id, parent_location_id, location_role, is_tray, tray_current_store_id, max_capacity, active")
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

  function isTrayAdminLocation(location) {
    return Boolean(location?.isTray) || String(location?.role || "").toLowerCase() === "tray";
  }

  function isContainerAdminLocation(location) {
    return !isTrayAdminLocation(location) && (
      String(location?.role || "").toLowerCase() === "container" || Boolean(location?.parentId)
    );
  }

  function isParentStorageAdminLocation(location) {
    return Boolean(location) && !isTrayAdminLocation(location) && !isContainerAdminLocation(location);
  }

  function getAdminLocationStoreLabel(location) {
    if (!location) return "";
    return isTrayAdminLocation(location) ? location.currentStoreName : location.storeName;
  }

  function findAdminLocationByBarcode(barcode, predicate = null) {
    const normalized = String(barcode || "").trim().toLowerCase();
    if (!normalized) return null;

    const matches = activeAdminLocationOptions.filter((location) => {
      const isCodeMatch = String(location.code || "").trim().toLowerCase() === normalized;
      return isCodeMatch && (!predicate || predicate(location));
    });

    return matches.length === 1 ? matches[0] : null;
  }

  function setPlacementStepStatus(id, message, type = "info") {
    const element = document.getElementById(id);
    if (!element) return;

    element.textContent = message || "";
    element.classList.toggle("is-success", type === "success");
    element.classList.toggle("is-error", type === "error");
  }

  function setPlacementStepState(stepId, state = "") {
    const step = document.getElementById(stepId);
    if (!step) return;
    step.classList.toggle("is-active", state === "active");
    step.classList.toggle("is-complete", state === "complete");
  }

  function focusPlacementInput(id, options = {}) {
    const input = document.getElementById(id);
    if (!input) return;

    setTimeout(() => {
      if (options.scroll !== false) {
        input.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      input.focus({ preventScroll: true });
      input.select?.();
    }, options.delayMs ?? 90);
  }

  function resetStockPlacementScanInputs() {
    Object.keys(stockPlacementScanTimers).forEach((key) => {
      clearTimeout(stockPlacementScanTimers[key]);
      delete stockPlacementScanTimers[key];
    });
    ["placement-tray-barcode", "placement-parent-barcode", "placement-container-barcode"].forEach((id) => {
      const input = document.getElementById(id);
      if (input) input.value = "";
    });
    selectedAdminParentLocation = null;
    setPlacementStepStatus("placement-tray-status", "Waiting for tray scan.");
    setPlacementStepStatus("placement-parent-status", "Scan the selected parent storage label first.");
    setPlacementStepStatus("placement-container-status", "Container must belong to the scanned parent.");
  }

  function syncStockPlacementModeUI() {
    const flow = document.getElementById("placement-scan-flow");
    const trayStep = document.getElementById("placement-tray-step");
    const parentStep = document.getElementById("placement-parent-step");
    const containerStep = document.getElementById("placement-container-step");
    const isContainerMode = stockPlacementMode === "container";

    flow?.setAttribute("data-mode", stockPlacementMode);
    document.querySelectorAll("[data-placement-mode]").forEach((button) => {
      const isActive = button.dataset.placementMode === stockPlacementMode;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-checked", isActive ? "true" : "false");
    });

    trayStep?.classList.toggle("hidden", isContainerMode);
    parentStep?.classList.toggle("hidden", !isContainerMode);
    containerStep?.classList.toggle("hidden", !isContainerMode);

    if (isContainerMode) {
      setPlacementStepState("placement-parent-step", "active");
      setPlacementStepState("placement-container-step", "");
      setPlacementStepState("placement-tray-step", "");
    } else {
      setPlacementStepState("placement-tray-step", "active");
      setPlacementStepState("placement-parent-step", "");
      setPlacementStepState("placement-container-step", "");
    }
  }

  function setStockPlacementMode(mode = "tray", { clear = true, focus = true } = {}) {
    stockPlacementMode = mode === "container" ? "container" : "tray";
    try {
      window.localStorage?.setItem("og.addItem.stockPlacementMode", stockPlacementMode);
    } catch (_) {}

    if (clear) {
      setSelectedAdminLocation("");
      resetStockPlacementScanInputs();
      renderLocationIntelligenceEmpty("admin-location-intelligence");
    }

    syncStockPlacementModeUI();
    if (focus) {
      focusPlacementInput(stockPlacementMode === "container" ? "placement-parent-barcode" : "placement-tray-barcode");
    }
  }

  function restoreStockPlacementModePreference() {
    try {
      const saved = window.localStorage?.getItem("og.addItem.stockPlacementMode");
      stockPlacementMode = saved === "container" ? "container" : "tray";
    } catch (_) {
      stockPlacementMode = "tray";
    }
  }

  function setSelectedAdminLocation(location = null) {
    const locationObject = typeof location === "string"
      ? activeAdminLocationOptions.find((entry) => entry.name === location || entry.id === location || entry.code === location) || null
      : location;
    const locationName = locationObject?.name || "";
    const locationId = locationObject?.id || "";
    const locationCode = locationObject?.code || "";
    const storeName = getAdminLocationStoreLabel(locationObject);
    const typeName = locationObject?.type || "";
    const summary = document.getElementById("admin-location-selection-summary");

    selectedAdminLocation = locationObject || null;
    const locationNameInput = document.getElementById("admin-location-name");
    const locationIdInput = document.getElementById("admin-location-id");
    const dropdownToggle = document.getElementById("admin-location-dropdown-toggle");

    if (locationNameInput) locationNameInput.value = locationName;
    if (locationIdInput) locationIdInput.value = locationId;
    if (dropdownToggle) {
      dropdownToggle.innerText = locationObject ? getAdminLocationLabel(locationObject) : "Select Location";
    }

    if (summary) {
      summary.textContent = locationObject
        ? [
            locationCode ? `Barcode: ${locationCode}` : "",
            storeName ? `Store: ${storeName}` : "",
            typeName ? `Type: ${typeName}` : "",
          ].filter(Boolean).join(" | ")
        : "Scan a destination barcode to see the storage snapshot.";
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

  function focusAdminStockQuantityInput() {
    const quantityInput = document.getElementById("admin-stock-quantity");
    if (!quantityInput) return;

    setTimeout(() => {
      quantityInput.scrollIntoView({ behavior: "smooth", block: "center" });
      quantityInput.focus({ preventScroll: true });
      quantityInput.select?.();
    }, 80);
  }

  function selectAdminLocationForStock(location, { clearSearch = true } = {}) {
    if (!location) return;

    setSelectedAdminLocation(location);

    const searchInput = document.getElementById("admin-location-dropdown-search");
    if (clearSearch && searchInput) {
      searchInput.value = "";
    }
    renderAdminLocationDropdownOptions(searchInput?.value || "");
    focusAdminStockQuantityInput();
  }

  function completeTrayPlacementScan(location) {
    setSelectedAdminLocation(location);
    setPlacementStepState("placement-tray-step", "complete");
    setPlacementStepStatus(
      "placement-tray-status",
      `Selected ${location.name}${location.code ? ` (${location.code})` : ""}.`,
      "success"
    );
    focusAdminStockQuantityInput();
  }

  function completeParentPlacementScan(location) {
    selectedAdminParentLocation = location;
    setSelectedAdminLocation("");
    setPlacementStepState("placement-parent-step", "complete");
    setPlacementStepState("placement-container-step", "active");
    setPlacementStepStatus(
      "placement-parent-status",
      `Parent confirmed: ${location.name}${location.code ? ` (${location.code})` : ""}.`,
      "success"
    );
    setPlacementStepStatus("placement-container-status", "Now scan the container or bag inside that parent.");
    document.getElementById("placement-container-barcode").value = "";
    focusPlacementInput("placement-container-barcode");
  }

  function completeContainerPlacementScan(location) {
    setSelectedAdminLocation(location);
    setPlacementStepState("placement-container-step", "complete");
    setPlacementStepStatus(
      "placement-container-status",
      `Container selected: ${location.name}${location.code ? ` (${location.code})` : ""}.`,
      "success"
    );
    focusAdminStockQuantityInput();
  }

  function handleTrayBarcodeScan(value) {
    const location = findAdminLocationByBarcode(value, isTrayAdminLocation);
    if (!location) {
      setPlacementStepStatus("placement-tray-status", "No active tray matched that barcode.", "error");
      setSelectedAdminLocation("");
      return false;
    }

    completeTrayPlacementScan(location);
    return true;
  }

  function handleParentBarcodeScan(value) {
    const location = findAdminLocationByBarcode(value, isParentStorageAdminLocation);
    if (!location) {
      setPlacementStepStatus("placement-parent-status", "No active parent storage location matched that barcode.", "error");
      selectedAdminParentLocation = null;
      setSelectedAdminLocation("");
      setPlacementStepState("placement-parent-step", "active");
      setPlacementStepState("placement-container-step", "");
      return false;
    }

    completeParentPlacementScan(location);
    return true;
  }

  function handleContainerBarcodeScan(value) {
    if (!selectedAdminParentLocation?.id) {
      setPlacementStepStatus("placement-container-status", "Scan the parent storage barcode first.", "error");
      focusPlacementInput("placement-parent-barcode");
      return false;
    }

    const location = findAdminLocationByBarcode(value, (entry) => {
      return isContainerAdminLocation(entry) && String(entry.parentId || "") === String(selectedAdminParentLocation.id);
    });

    if (!location) {
      setPlacementStepStatus("placement-container-status", "No container matched that barcode under the scanned parent.", "error");
      setSelectedAdminLocation("");
      return false;
    }

    completeContainerPlacementScan(location);
    return true;
  }

  function schedulePlacementBarcodeScan(input, handler) {
    if (!input || !handler) return;
    const value = input.value.trim();
    clearTimeout(stockPlacementScanTimers[input.id]);
    if (!value) return;
    stockPlacementScanTimers[input.id] = window.setTimeout(() => {
      handler(input.value.trim());
      delete stockPlacementScanTimers[input.id];
    }, 650);
  }

  function flushPlacementBarcodeScan(input, handler) {
    if (!input || !handler) return;
    clearTimeout(stockPlacementScanTimers[input.id]);
    delete stockPlacementScanTimers[input.id];
    handler(input.value.trim());
  }

  function resetAdminStockPlacementFlow() {
    restoreStockPlacementModePreference();
    resetStockPlacementScanInputs();
    setSelectedAdminLocation("");
    renderLocationIntelligenceEmpty("admin-location-intelligence");
    syncStockPlacementModeUI();
  }

  function getFilteredAdminLocationOptions(searchTerm = "") {
    const normalizedSearch = String(searchTerm || "").trim().toLowerCase();
    const selectedStoreId = String(document.getElementById("admin-location-store-filter")?.value || "").trim();

    return activeAdminLocationOptions.filter((location) => {
      if (selectedStoreId && location.storeId !== selectedStoreId) return false;

      const haystack = [
        location.name,
        location.code,
        location.type,
        location.storeName,
      ].join(" ").toLowerCase();

      return !normalizedSearch || haystack.includes(normalizedSearch);
    });
  }

  function findScannedAdminLocationMatch(searchTerm = "") {
    const normalizedSearch = String(searchTerm || "").trim().toLowerCase();
    if (!normalizedSearch) return null;

    const filteredLocations = getFilteredAdminLocationOptions(searchTerm);
    const exactMatch = filteredLocations.find((location) => {
      return [location.name, location.code, location.id]
        .filter(Boolean)
        .some((value) => String(value).trim().toLowerCase() === normalizedSearch);
    });

    if (exactMatch) return exactMatch;
    return filteredLocations.length === 1 ? filteredLocations[0] : null;
  }

  function openAdminLocationScannerSearch({ clearSearch = false } = {}) {
    const menu = document.getElementById("admin-location-dropdown-menu");
    if (!menu) return;

    buildAdminLocationDropdownShell();

    const searchInput = document.getElementById("admin-location-dropdown-search");
    if (clearSearch && searchInput) {
      searchInput.value = "";
    }

    renderAdminLocationDropdownOptions(searchInput?.value || "");
    menu.classList.add("show");
    menu.scrollTop = 0;

    setTimeout(() => {
      const currentSearchInput = document.getElementById("admin-location-dropdown-search");
      currentSearchInput?.focus({ preventScroll: true });
      currentSearchInput?.select?.();
    }, 100);
  }

  function populateAdminLocationStoreFilter(locations, selectedStoreId = "") {
    const select = document.getElementById("admin-location-store-filter");
    if (!select) return;

    const currentValue = select.value;
    const storeOptions = activeStoreOptions
      .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));

    select.innerHTML = ['<option value="">All Stores</option>']
      .concat(storeOptions.map((store) => `<option value="${store.id}">${store.name}</option>`))
      .join("");

    const nextValue = selectedStoreId || currentValue;
    if (nextValue && storeOptions.some((store) => String(store.id) === String(nextValue))) {
      select.value = nextValue;
    } else {
      select.value = "";
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
      const similarTypeCount = data.similarItems.length;
      const similarItemCount = data.similarItems.reduce((sum, item) => sum + item.quantity, 0);
      const similarLabel = `${similarTypeCount} ${similarTypeCount === 1 ? "type" : "types"} / ${similarItemCount} total ${similarItemCount === 1 ? "item" : "items"} within 2 g`;
      const similarHtml = similarTypeCount
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
          <div class="location-intelligence-section-title">Similar Weight (±2 g) - ${escapeDropdownHtml(similarLabel)}</div>
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
    const filteredLocations = getFilteredAdminLocationOptions(searchTerm);

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

    input?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;

      event.preventDefault();
      const location = findScannedAdminLocationMatch(event.target.value);
      if (!location) {
        showToast("Scan or search a matching location, then select it.");
        return;
      }

      selectAdminLocationForStock(location);
      showToast(`Selected location: ${location.name}${location.code ? ` (${location.code})` : ""}`);
      menu.classList.remove("show");
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

      selectAdminLocationForStock(location);
      showToast(`Selected location: ${location.name}${location.code ? ` (${location.code})` : ""}`);
      menu.classList.remove("show");
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
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck="false"
            inputmode="search"
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
    const capacityNoLimitInput = document.getElementById("location-capacity-no-limit");
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
    if (capacityNoLimitInput) capacityNoLimitInput.checked = true;
    syncAddLocationCapacityLimit();
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

    latestLocationDymoXml = buildLocationDymoXml(
      generatedCode,
      document.getElementById("location-name")?.value || ""
    );

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
    const capacityNoLimitInput = document.getElementById("location-capacity-no-limit");
    const photoInput = document.getElementById("location-photo");
    const previewWrapper = document.getElementById("photo-preview-wrapper");
    const previewImage = document.getElementById("photo-preview-image");
    const notesInput = document.getElementById("location-notes");
    const storeSelect = document.getElementById("location-store");
    const generateBtn = document.getElementById("btn-generate-location-barcode");

    if (!modal || !form || form.dataset.bound === "true") return;
    form.dataset.bound = "true";
    populateLocationStoreSelect();
    syncAddLocationCapacityLimit();

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
    capacityNoLimitInput?.addEventListener("change", syncAddLocationCapacityLimit);
    cancelBtn?.addEventListener("click", () => toggleAddLocationModal(false));

    form.addEventListener("submit", async (event) => {
      event.preventDefault();

      const location_name = nameInput.value.trim();
      const location_code = barcodeInput.value.trim();
      const max_capacity = capacityInput.value.trim();
      const capacityHasNoLimit = Boolean(capacityNoLimitInput?.checked);
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
          max_capacity: capacityHasNoLimit || !max_capacity ? null : parseInt(max_capacity, 10),
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
      selectAdminLocationForStock(insertedLocation.location_name);
    });
  }

  //location dropdown only opening for admins
  async function populateAdminLocationDropdown(selectedValue = "", selectedStoreId = "") {
    activeStoreOptions = activeStoreOptions.length ? activeStoreOptions : await fetchActiveStores();
    activeAdminLocationOptions = await fetchAdminLocationOptions();
    buildAdminLocationDropdownShell();
    populateAdminLocationStoreFilter(activeAdminLocationOptions, selectedStoreId);
    renderAdminLocationDropdownOptions(document.getElementById("admin-location-dropdown-search")?.value || "");

    if (selectedValue) {
      setSelectedAdminLocation(selectedValue);
    }
  }

  function syncAddLocationCapacityLimit() {
    const capacityInput = document.getElementById("location-capacity");
    const capacityNoLimitInput = document.getElementById("location-capacity-no-limit");
    if (!capacityInput || !capacityNoLimitInput) return;

    const unlimited = Boolean(capacityNoLimitInput.checked);
    capacityInput.disabled = unlimited;
    capacityInput.placeholder = unlimited ? "No limit" : "";
    if (unlimited) capacityInput.value = "";
  }

  //allow the thing to be opened
  function setupAdminStockOpenButton() {
    document.getElementById("btn-open-admin-stock")?.addEventListener("click", () => {
      showAdminLocationStockModal("-1").catch((error) => {
        console.error("Failed to open stock placement modal:", error);
      });
      updateAddItemEbayReadiness();
    });
  }

  //event listener for the dropdown in the moddal
  function setupAdminLocationDropdownToggle() {
    document.addEventListener("click", (e) => {
      if (e.target.id === "admin-location-dropdown-toggle") {
        const menu = document.getElementById("admin-location-dropdown-menu");
        if (menu.classList.contains("show")) {
          menu.classList.remove("show");
        } else {
          openAdminLocationScannerSearch();
        }
      }
    });
  }

  async function validateAddItemPassword(password) {
    if (!currentUser?.email || !password) return false;

    const { error } = await supabase.auth.signInWithPassword({
      email: currentUser.email,
      password,
    });

    return !error;
  }

  function requestStockPlacementSignature({ location, quantity, mode, parentLocation } = {}) {
    return new Promise((resolve) => {
      const modal = document.getElementById("stock-placement-signature-modal");
      const summary = document.getElementById("stock-placement-signature-summary");
      const passwordInput = document.getElementById("stock-placement-password");
      const errorEl = document.getElementById("stock-placement-password-error");
      const confirmBtn = document.getElementById("stock-placement-password-confirm");
      const cancelBtn = document.getElementById("stock-placement-password-cancel");

      if (!modal || !passwordInput || !confirmBtn || !cancelBtn || !errorEl) {
        resolve(null);
        return;
      }

      const destinationLabel = location ? getAdminLocationLabel(location) : "selected destination";
      const parentLabel = parentLocation ? ` Parent: ${getAdminLocationLabel(parentLocation)}.` : "";
      if (summary) {
        summary.textContent = `Sign ${quantity} unit${quantity === 1 ? "" : "s"} into ${mode === "container" ? "container" : "tray"} ${destinationLabel}.${parentLabel}`;
      }

      passwordInput.value = "";
      errorEl.textContent = "";
      modal.classList.remove("hidden");
      modal.setAttribute("aria-hidden", "false");
      document.body.classList.add("modal-open");

      const cleanup = (result) => {
        confirmBtn.onclick = null;
        cancelBtn.onclick = null;
        passwordInput.onkeydown = null;
        modal.classList.add("hidden");
        modal.setAttribute("aria-hidden", "true");
        if (!document.querySelector(".modal:not(.hidden)")) {
          document.body.classList.remove("modal-open");
        }
        resolve(result);
      };

      cancelBtn.onclick = () => cleanup(null);
      confirmBtn.onclick = async () => {
        const password = passwordInput.value.trim();
        if (!password) {
          errorEl.textContent = "Password is required.";
          return;
        }

        confirmBtn.disabled = true;
        confirmBtn.textContent = "Checking...";
        try {
          const valid = await validateAddItemPassword(password);
          if (!valid) {
            errorEl.textContent = "Incorrect password.";
            return;
          }

          cleanup({
            signedByEmail: currentUser?.email || "",
            signedAt: new Date().toISOString(),
            confirmationMethod: "password_stock_placement",
          });
        } finally {
          confirmBtn.disabled = false;
          confirmBtn.textContent = "Sign Placement";
        }
      };

      passwordInput.onkeydown = (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        confirmBtn.click();
      };

      setTimeout(() => passwordInput.focus({ preventScroll: true }), 80);
    });
  }

  function setupAdminLocationModalListeners() {
    const confirmBtn = document.getElementById("btn-confirm-admin-stock");
    const cancelBtn = document.getElementById("btn-cancel-admin-stock");
    const trayInput = document.getElementById("placement-tray-barcode");
    const parentInput = document.getElementById("placement-parent-barcode");
    const containerInput = document.getElementById("placement-container-barcode");

    cancelBtn.onclick = () => {
      document.getElementById("modal-admin-assign-location").classList.add("hidden");
      if (!document.querySelector(".modal:not(.hidden)")) {
        document.body.classList.remove("modal-open");
      }
    };

    document.querySelectorAll("[data-placement-mode]").forEach((button) => {
      if (button.dataset.bound === "true") return;
      button.dataset.bound = "true";
      button.addEventListener("click", () => {
        setStockPlacementMode(button.dataset.placementMode || "tray", { clear: true, focus: true });
      });
    });

    if (trayInput && trayInput.dataset.bound !== "true") {
      trayInput.dataset.bound = "true";
      trayInput.addEventListener("input", () => schedulePlacementBarcodeScan(trayInput, handleTrayBarcodeScan));
      trayInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        flushPlacementBarcodeScan(trayInput, handleTrayBarcodeScan);
      });
    }

    if (parentInput && parentInput.dataset.bound !== "true") {
      parentInput.dataset.bound = "true";
      parentInput.addEventListener("input", () => schedulePlacementBarcodeScan(parentInput, handleParentBarcodeScan));
      parentInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        flushPlacementBarcodeScan(parentInput, handleParentBarcodeScan);
      });
    }

    if (containerInput && containerInput.dataset.bound !== "true") {
      containerInput.dataset.bound = "true";
      containerInput.addEventListener("input", () => schedulePlacementBarcodeScan(containerInput, handleContainerBarcodeScan));
      containerInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;
        event.preventDefault();
        flushPlacementBarcodeScan(containerInput, handleContainerBarcodeScan);
      });
    }

    const quantityInput = document.getElementById("admin-stock-quantity");
    if (quantityInput && quantityInput.dataset.enterBound !== "true") {
      quantityInput.dataset.enterBound = "true";
      quantityInput.addEventListener("keydown", (event) => {
        if (event.key !== "Enter") return;

        event.preventDefault();
        confirmBtn?.click();
      });
    }

    confirmBtn.onclick = async () => {
      const barcode = document.getElementById("scanned-barcode")?.value || "temp-barcode";
      const locationId = document.getElementById("admin-location-id").value.trim();
      const locationName = document.getElementById("admin-location-name").value.trim();
      const quantity = parseInt(document.getElementById("admin-stock-quantity").value.trim(), 10);

      if (!locationId || !locationName || !Number.isFinite(quantity) || quantity <= 0) {
        showToast("Please select a location and enter quantity.");
        return;
      }

      const location = selectedAdminLocation || activeAdminLocationOptions.find((entry) => entry.id === locationId);
      if (!location) {
        showToast("Location not found.");
        return;
      }

      if (stockPlacementMode === "tray" && !isTrayAdminLocation(location)) {
        showToast("Scan an active tray barcode for tray placement.");
        focusPlacementInput("placement-tray-barcode");
        return;
      }

      if (stockPlacementMode === "container") {
        if (!isContainerAdminLocation(location)) {
          showToast("Scan a container or bag barcode for container placement.");
          focusPlacementInput("placement-container-barcode");
          return;
        }
        if (!selectedAdminParentLocation?.id || String(location.parentId || "") !== String(selectedAdminParentLocation.id)) {
          showToast("The container must belong to the scanned parent storage location.");
          focusPlacementInput("placement-parent-barcode");
          return;
        }
      }

      const signed = await requestStockPlacementSignature({
        location,
        quantity,
        mode: stockPlacementMode,
        parentLocation: stockPlacementMode === "container" ? selectedAdminParentLocation : null,
      });

      if (!signed) return;

      pendingStockAssignments[barcode] = {
        location_name: location.name,
        quantity,
        location_id: location.id,
        location_code: location.code,
        placement_type: stockPlacementMode,
        parent_location_id: selectedAdminParentLocation?.id || null,
        parent_location_name: selectedAdminParentLocation?.name || null,
        signed_by_email: signed.signedByEmail,
        signed_at: signed.signedAt,
        confirmation_method: signed.confirmationMethod,
      };

      const previewBox = document.getElementById("assignment-preview-box");
      const parentCopy = stockPlacementMode === "container" && selectedAdminParentLocation
        ? ` via ${getAdminLocationLabel(selectedAdminParentLocation)}`
        : "";
      document.getElementById("assignment-location").textContent = `Location: ${getAdminLocationLabel(location)}${parentCopy}`;
      document.getElementById("assignment-quantity").textContent = `Quantity: ${quantity} | Signed by ${signed.signedByEmail || "current user"}`;
      previewBox.classList.remove("hidden");

      showToast(`Will assign ${quantity} to ${location.name} after item is saved`);
      document.getElementById("modal-admin-assign-location").classList.add("hidden");
      if (!document.querySelector(".modal:not(.hidden)")) {
        document.body.classList.remove("modal-open");
      }
      updateAddItemEbayReadiness();
    };
  }

  setupAddItemEbayReadiness();

  //== run the add location modal only if the user is an admin
  if (window.currentUser && window.currentUser.user_metadata?.role === "admin") {
    setupAdminLocationModalListeners();
  }

//#endregion

// === FORM SUBMIT ===
document.getElementById("add-item-form")?.addEventListener("submit", async (e) => {
  e.preventDefault();
  const addItemForm = e.currentTarget;
  if (addItemForm?.dataset.saving === "true") return;

  if (addItemForm) addItemForm.dataset.saving = "true";
  const submitButton = addItemForm?.querySelector('button[type="submit"]');
  const originalSubmitText = submitButton?.textContent || "";
  if (submitButton) {
    submitButton.disabled = true;
    submitButton.textContent = "Saving Item...";
  }
  const releaseAddItemSubmit = () => {
    if (addItemForm) delete addItemForm.dataset.saving;
    if (submitButton) {
      submitButton.disabled = false;
      submitButton.textContent = originalSubmitText;
    }
  };
  clearAutomaticDymoGeneration();

  // Check category selection
  const categoryValue = document.getElementById("category").value.trim();
  if (!categoryValue) {
    showToast("❌ Please select or create a category.");
    releaseAddItemSubmit();
    return;
  }

  const title = document.getElementById("title").value.trim();
  const description = document.getElementById("description").value.trim();
  const weight = parseFloat(document.getElementById("weight").value);
  const stone_type = document.getElementById("assisted-stone-type")?.value?.trim() || null;
  const item_length = document.getElementById("assisted-length")?.value?.trim() || null;
  const price_per_weight = parseFloat(pricePerWeightInput?.value || "0");
  const materialPurity = getAssistedMaterialPurityForSave();
  const ebay_sync_enabled = document.getElementById("ebay-sync-enabled")?.checked !== false;
  // force sync dropdown selection into hidden input if user typed or skipped selection
  const categoryButton = document.getElementById("category-dropdown-toggle");
  const categoryHiddenInput = document.getElementById("category");
  if (!categoryHiddenInput.value && categoryButton.innerText !== "Select or Create Category") {
    categoryHiddenInput.value = categoryButton.innerText.trim();
  }
  const categoryInput = document.getElementById("category").value.trim();
  const categories = categoryInput ? [categoryInput] : [];
  const selectedEbayCategoryId = String(document.getElementById("ebay-category-id")?.value || "").trim();
  const inferredEbayCategoryId = inferAddItemEbayCategory()?.id || "";
  const ebay_category_id = selectedEbayCategoryId || inferredEbayCategoryId || null;
  const ebay_aspects = ebay_sync_enabled
    ? buildAddItemEbayAspects(ebay_category_id, materialPurity, weight, item_length)
    : {};
  if (ebay_sync_enabled && !getAddItemEbayCategoryOption(ebay_category_id)) {
    showToast("Choose an eBay category, or turn off eBay sync for this item.");
    updateAddItemEbayReadiness({ infer: false });
    releaseAddItemSubmit();
    return;
  }
  const cost = parseFloat(document.getElementById("cost").value.replace(/,/g, ''));
  const sale_price = parseFloat(document.getElementById("sale-price").value.replace(/,/g, ''));
  const distributor_name = document.getElementById("distributor-name").value.trim();
  const distributor_phone = document.getElementById("distributor-phone").value.trim();
  const distributor_notes = document.getElementById("distributor-notes").value.trim();
  const qr_code = document.getElementById("qr-code").value.trim();
  let barcode = barcodeInput.value.trim();

  if (!barcode) {
    barcode = generateNewItemBarcode({ generateDymo: false });
  }

  try {
    const duplicateBarcode = await dymoModule.barcodeExists(barcode);
    if (duplicateBarcode) {
      window.dymoModule?.clearPendingDymoLabel?.({
        statusMessage: "That barcode already exists. A fresh barcode was generated.",
      });
      generateNewItemBarcode({ generateDymo: true });
      alert(`Barcode "${barcode}" already exists in inventory. I generated a new barcode for this item; please review it and submit again.`);
      releaseAddItemSubmit();
      return;
    }

    await ensureCurrentDymoLabelForSubmit(barcode);
  } catch (dymoPrepError) {
    console.error("DYMO preparation failed:", dymoPrepError);
    alert(`Failed to prepare DYMO label: ${dymoPrepError.message || dymoPrepError}`);
    releaseAddItemSubmit();
    return;
  }

  const photoFiles = photoInput?.files || [];
  const photoUrls = [];
  const assistedSelectedImages = window.addItemAssistedModule?.getSelectedUploadedImagesForSave?.() || [];
  let assistedCopySuccessCount = 0;
  let assistedCopyFailureCount = 0;
  const photoStatus = document.getElementById("photo-status");
  if (photoStatus) photoStatus.innerHTML = "";

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
      assistedCopySuccessCount += 1;
      if (photoStatus) {
        photoStatus.innerHTML += `Included assisted image <strong>${assistedImage.name || copiedPath}</strong><br>`;
      }
    } catch (assistedError) {
      assistedCopyFailureCount += 1;
      console.error(`Assisted image copy failed for ${assistedImage?.path}:`, assistedError);
      if (photoStatus) {
        photoStatus.innerHTML += `Failed to include assisted image <strong>${assistedImage?.name || assistedImage?.path || `#${index + 1}`}</strong>: ${assistedError.message || assistedError}<br>`;
      }
    }
  }

  const finalPhotoPaths = [...new Set(photoUrls.filter(Boolean))];
  if (assistedSelectedImages.length && assistedCopyFailureCount && !assistedCopySuccessCount && !photoFiles.length) {
    alert("The selected assisted photos could not be saved to the item. Please try again before adding the item.");
    releaseAddItemSubmit();
    return;
  }

  const { data: insertedItems, error } = await supabase
    .from("item_types")
    .insert({
      title,
      description,
      weight,
      stone_type,
      item_length,
      metal: materialPurity.metal,
      purity_basis_points: materialPurity.purity_basis_points,
      ebay_sync_enabled,
      ebay_category_id,
      ebay_condition: "NEW",
      ebay_aspects,
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
    if (error?.code === "23505" || /duplicate|unique/i.test(error?.message || "")) {
      window.dymoModule?.clearPendingDymoLabel?.({
        statusMessage: "That barcode was already saved. A fresh barcode was generated.",
      });
      generateNewItemBarcode({ generateDymo: true });
    }
    alert("Failed to save item: " + (error?.message || "Unknown error"));
    releaseAddItemSubmit();
    return;
  }

  const newItem = insertedItems[0];

  try {
    const finalDymoPath = await attachDymoLabelToSavedItem(newItem.id, barcode);
    newItem.dymo_label_url = finalDymoPath;
  } catch (err) {
    alert(`❌ Item was saved, but the DYMO label could not be attached: ${err.message || err}`);
    releaseAddItemSubmit();
    return;
  }

  const savedDymoXml = window.latestDymoXml || "";
  const savedDymoPath = newItem.dymo_label_url || window.latestDymoUrl || "";

  try {
    const savedPhotos = await ensureItemPhotosSaved(newItem, finalPhotoPaths);
    newItem.photos = savedPhotos;
  } catch (photoAttachError) {
    console.error("Final item photo attach failed:", photoAttachError);
    alert(photoAttachError.message || "Item saved, but selected photos could not be attached.");
    releaseAddItemSubmit();
    return;
  }

  if (ebay_sync_enabled && finalPhotoPaths.length) {
    const ebayPhotoPrep = await copyItemPhotosToPublicEbayBucket(newItem, finalPhotoPaths);
    if (photoStatus && ebayPhotoPrep.copied > 0) {
      photoStatus.innerHTML += `Prepared ${ebayPhotoPrep.copied} eBay public photo${ebayPhotoPrep.copied === 1 ? "" : "s"}.<br>`;
    }
    if (ebayPhotoPrep.failed > 0) {
      showToast(`Item saved, but ${ebayPhotoPrep.failed} eBay photo${ebayPhotoPrep.failed === 1 ? "" : "s"} still need prep.`);
    }
  }

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
  bulkRes = await window.addItemBulkModule.saveRegistryForItem(
    newItem.id,
    bagBarcode,
    locationId,
    pendingStockAssignments[newItem.barcode] || null
  );

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
    confirmation_email: stockInfo.signed_by_email || currentUser.email,
    confirmation_method: stockInfo.confirmation_method || "password_stock_placement",
    confirmed_at: stockInfo.signed_at || new Date().toISOString()
  });

  const stockLog = await supabase.from("stock_transactions").insert({
    item_id: newItem.id,
    location_id: stockInfo.location_id,
    quantity: stockInfo.quantity,
    action_type: "checkin",
    method: stockInfo.confirmation_method || "password_stock_placement",
    email: stockInfo.signed_by_email || window.currentUser?.email,
    user_id: currentUser.id,
    notes: `Add item stock placement into ${stockInfo.placement_type || "location"} ${stockInfo.location_name || stockInfo.location_id}${stockInfo.parent_location_name ? ` under ${stockInfo.parent_location_name}` : ""}`,
    timestamp: stockInfo.signed_at || new Date().toISOString()
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

  resetAddItemDraftStateAfterSuccess();
  await bumpInventoryVersion([newItem.id]);
  showItemSaveSuccessModal(newItem, {
    photoCount: finalPhotoPaths.length,
    stockInfo,
    bulkInfo: bulkRes,
    dymoXml: savedDymoXml,
    dymoPath: savedDymoPath,
  });
});

// === DOM Loader ===
document.addEventListener("DOMContentLoaded", async () => {
  restoreTopAfterSuccessfulReload();
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
  applyDefaultItemAutomation({ generateBarcode: true, generateDymo: true });
});
