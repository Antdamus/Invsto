(() => {
  const INVENTORY_UPLOAD_BUCKET = "InventoryUpload";
  const CAPTURE_PHOTOS_BUCKET = "capture-photos";
  const INVENTORY_UPLOAD_LIST_FUNCTION_NAME = "list-inventory-upload-images";
  const AI_COPY_FUNCTION_NAME = "generate-inventory-copy";
  const IMAGE_PROCESS_FUNCTION_NAME = "process-inventory-image";
  const BACKGROUND_REMOVAL_MODULE_URL = "https://esm.sh/@imgly/background-removal@1.7.0?bundle";
  const CAPTURE_JOB_TABLE = "capture_jobs";
  const CAPTURE_PHOTO_TABLE = "capture_job_photos";
  const CAPTURE_STATION_TABLE = "capture_stations";
  const CAPTURE_POLL_INTERVAL_MS = 1500;
  const CAPTURE_POLL_TIMEOUT_MS = 300000;
  const CAPTURE_PHOTO_SETTLE_MS = 4500;
  const CAPTURE_FALLBACK_LOOKBACK_MS = 30000;
  const BACKGROUND_PROCESSING_MAX_SOURCE_SIDE = 1600;
  const IMAGE_EDITOR_OUTPUT_SIZE = 1200;
  const LOCAL_UPLOAD_MAX_DIRECT_BYTES = 7 * 1024 * 1024;
  const LOCAL_UPLOAD_MAX_SIDE = 2200;
  const DEFAULT_RECENT_PHOTO_RELOAD_LIMIT = 5;
  const PROCESSED_BACKGROUND_PREFIX = "processed-backgrounds";
  const THUMBNAIL_SIGNED_URL_TRANSFORM = {
    width: 240,
    height: 240,
    resize: "cover",
    quality: 55,
  };
  const AUTO_STRAIGHTEN_MIN_DEGREES = 1.25;
  const AUTO_STRAIGHTEN_MAX_DEGREES = 24;
  const ASSISTED_LAST_STONE_TYPE_KEY = "og.addItem.assisted.lastStoneType";
  const ASSISTED_STONE_TYPE_HISTORY_KEY = "og.addItem.assisted.stoneTypeHistory";
  const ASSISTED_LAST_LENGTH_KEY = "og.addItem.assisted.lastLength";
  const ASSISTED_LENGTH_HISTORY_KEY = "og.addItem.assisted.lengthHistory";
  const ASSISTED_UPPERCASE_TOKENS = new Set(["VVS", "VS", "VS1", "VS2", "SI", "SI1", "SI2", "CZ", "AAA", "AA"]);
  const ASSISTED_STONE_TYPE_MATCHERS = [
    ["Cubic Zirconia", ["cubic zirconia", "cz"]],
    ["Lab Diamond", ["lab diamond", "lab-grown diamond", "lab grown diamond"]],
    ["Mother of Pearl", ["mother of pearl", "mother-of-pearl"]],
    ["Lapis Lazuli", ["lapis lazuli"]],
    ["Diamond", ["diamond"]],
    ["Moissanite", ["moissanite"]],
    ["Ruby", ["ruby"]],
    ["Sapphire", ["sapphire"]],
    ["Emerald", ["emerald"]],
    ["Pearl", ["pearl"]],
    ["Opal", ["opal"]],
    ["Onyx", ["onyx"]],
    ["Amethyst", ["amethyst"]],
    ["Topaz", ["topaz"]],
    ["Garnet", ["garnet"]],
    ["Turquoise", ["turquoise"]],
    ["Jade", ["jade"]],
    ["Aquamarine", ["aquamarine"]],
    ["Peridot", ["peridot"]],
    ["Tanzanite", ["tanzanite"]],
    ["Morganite", ["morganite"]],
    ["Spinel", ["spinel"]],
    ["Tourmaline", ["tourmaline"]],
    ["Citrine", ["citrine"]],
    ["Quartz", ["quartz"]],
    ["Agate", ["agate"]],
    ["Coral", ["coral"]],
    ["Amber", ["amber"]],
    ["Zircon", ["zircon"]],
    ["Marcasite", ["marcasite"]],
    ["Rhinestone", ["rhinestone"]],
    ["Crystal", ["crystal"]],
    ["Enamel", ["enamel"]],
    ["No Stone", ["no stone", "no stones", "without stone", "without stones"]],
  ];
  let backgroundRemovalModulePromise = null;
  let backgroundRemovalPreloadQueued = false;
  const MATERIAL_PURITY_OPTIONS = {
    Gold: ["10K", "14K", "18K", "22K", "24K"],
    Silver: ["925", "950", "Fine Silver"],
    Platinum: ["850", "900", "950", "999"],
    "Stainless Steel": ["316L", "304"],
  };

  const state = {
    initialized: false,
    activeWorkflow: "assisted",
    recentUploadedImages: [],
    aiSelectedUploadedImage: null,
    aiSelectedUploadedImagePath: "",
    aiSelectedUploadedImageUrl: "",
    saveSelectedUploadedImagePaths: [],
    stableWeight: null,
    isReadingWeight: false,
    isGeneratingCopy: false,
    isProcessingImage: false,
    isAutoBlackProcessing: false,
    autoStraightenBackground: false,
    autoBlackProcessedSourcePaths: new Set(),
    hasLoadedImagesOnce: false,
    activeCaptureJobId: "",
    captureStations: [],
    selectedCaptureStationId: "",
    latestCaptureJob: null,
    imageEditor: {
      image: null,
      sourceUrl: "",
      sourceRevoke: null,
      imageElement: null,
      zoom: 1,
      rotation: 0,
      flipX: false,
      flipY: false,
      offsetX: 0,
      offsetY: 0,
      isDragging: false,
      dragStartX: 0,
      dragStartY: 0,
      dragOriginX: 0,
      dragOriginY: 0,
    },
  };

  function waitForSupabaseInit() {
    return new Promise((resolve) => {
      if (window.supabase) {
        resolve();
        return;
      }

      document.addEventListener("supabase-ready", resolve, { once: true });
    });
  }

  function getElements() {
    return {
      manualTab: document.getElementById("workflow-tab-manual"),
      assistedTab: document.getElementById("workflow-tab-assisted"),
      manualPanel: document.getElementById("workflow-panel-manual"),
      assistedPanel: document.getElementById("workflow-panel-assisted"),
      materialSelect: document.getElementById("assisted-material"),
      puritySelect: document.getElementById("assisted-purity"),
      stoneTypeInput: document.getElementById("assisted-stone-type"),
      stoneTypeDatalist: document.getElementById("assisted-stone-type-options"),
      lengthInput: document.getElementById("assisted-length"),
      lengthDatalist: document.getElementById("assisted-length-options"),
      notesInput: document.getElementById("assisted-notes"),
      captureStationSelect: document.getElementById("assisted-capture-station"),
      recentPhotoLimitSelect: document.getElementById("assisted-recent-photo-limit"),
      refreshStationsButton: document.getElementById("assisted-refresh-stations"),
      readWeightButton: document.getElementById("assisted-read-weight"),
      manualWeightInput: document.getElementById("assisted-manual-weight"),
      useManualWeightButton: document.getElementById("assisted-use-manual-weight"),
      scaleState: document.getElementById("assisted-scale-state"),
      weightDisplay: document.getElementById("assisted-weight-display"),
      captureState: document.getElementById("assisted-capture-state"),
      refreshImagesButton: document.getElementById("assisted-refresh-images"),
      localImageUploadInput: document.getElementById("assisted-local-image-upload"),
      imageStatus: document.getElementById("assisted-image-status"),
      selectedImagePreview: document.getElementById("assisted-selected-image-preview"),
      selectedImageEmpty: document.getElementById("assisted-selected-image-empty"),
      selectedImageName: document.getElementById("assisted-selected-image-name"),
      selectedImagePath: document.getElementById("assisted-selected-image-path"),
      bgAutoAlignButton: document.getElementById("assisted-bg-auto-align"),
      bgBlackButton: document.getElementById("assisted-bg-black"),
      bgWhiteButton: document.getElementById("assisted-bg-white"),
      openImageEditorButton: document.getElementById("assisted-open-image-editor"),
      bgStatus: document.getElementById("assisted-bg-status"),
      imageEditorModal: document.getElementById("assisted-image-editor-modal"),
      imageEditorCanvas: document.getElementById("assisted-editor-canvas"),
      imageEditorCanvasWrap: document.querySelector(".assisted-editor-canvas-wrap"),
      imageEditorClose: document.getElementById("assisted-editor-close"),
      imageEditorZoom: document.getElementById("assisted-editor-zoom"),
      imageEditorZoomIn: document.getElementById("assisted-editor-zoom-in"),
      imageEditorZoomOut: document.getElementById("assisted-editor-zoom-out"),
      imageEditorRotation: document.getElementById("assisted-editor-rotation"),
      imageEditorRotateLeft: document.getElementById("assisted-editor-rotate-left"),
      imageEditorRotateRight: document.getElementById("assisted-editor-rotate-right"),
      imageEditorFlipHorizontal: document.getElementById("assisted-editor-flip-horizontal"),
      imageEditorFlipVertical: document.getElementById("assisted-editor-flip-vertical"),
      imageEditorReset: document.getElementById("assisted-editor-reset"),
      imageEditorSave: document.getElementById("assisted-editor-save"),
      imageEditorStatus: document.getElementById("assisted-editor-status"),
      saveSelectionCount: document.getElementById("assisted-save-selection-count"),
      saveSelectionSummary: document.getElementById("assisted-save-selection-summary"),
      uploadedImageStrip: document.getElementById("assisted-uploaded-image-strip"),
      generateCopyButton: document.getElementById("assisted-generate-copy"),
      generateStatus: document.getElementById("assisted-generate-status"),
      generatedTitleInput: document.getElementById("assisted-generated-title"),
      generatedDescriptionInput: document.getElementById("assisted-generated-description"),
      applyCopyButton: document.getElementById("assisted-apply-copy"),
      mainTitleInput: document.getElementById("title"),
      mainDescriptionInput: document.getElementById("description"),
      mainWeightInput: document.getElementById("weight"),
      mainCategoryInput: document.getElementById("category"),
      categoryToggle: document.getElementById("category-dropdown-toggle"),
      qrTypeSelect: document.getElementById("qr-type"),
    };
  }

  function asTrimmedString(value) {
    return String(value || "").trim();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function formatWeight(value) {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return "--";
    return `${numericValue.toFixed(2)} g`;
  }

  function parseWeightInput(value) {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && numericValue > 0 ? Number(numericValue.toFixed(2)) : null;
  }

  function getRecentPhotoReloadLimit(elements) {
    const requestedLimit = Number(elements.recentPhotoLimitSelect?.value);
    if (!Number.isFinite(requestedLimit)) return DEFAULT_RECENT_PHOTO_RELOAD_LIMIT;
    return Math.min(25, Math.max(1, Math.trunc(requestedLimit)));
  }

  function formatTimestamp(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Uploaded recently";

    return new Intl.DateTimeFormat("en-US", {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  }

  function compareNewestFirst(a, b) {
    const aTime = new Date(a.updatedAt || a.createdAt || 0).getTime();
    const bTime = new Date(b.updatedAt || b.createdAt || 0).getTime();
    return bTime - aTime;
  }

  function normalizeStoneTypeLabel(value) {
    const text = asTrimmedString(value).replace(/\s+/g, " ");
    if (!text) return "";
    const known = ASSISTED_STONE_TYPE_MATCHERS.find(([label]) => label.toLowerCase() === text.toLowerCase());
    if (known) return known[0];
    return text
      .split(" ")
      .map((part) => {
        if (!part) return "";
        const normalizedPart = part.replace(/[.,;:]+$/g, "");
        const upper = normalizedPart.toUpperCase();
        if (ASSISTED_UPPERCASE_TOKENS.has(upper)) return upper;
        return `${normalizedPart.charAt(0).toUpperCase()}${normalizedPart.slice(1).toLowerCase()}`;
      })
      .join(" ");
  }

  function getStoredStoneTypeHistory() {
    try {
      const parsed = JSON.parse(window.localStorage?.getItem(ASSISTED_STONE_TYPE_HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.map(normalizeStoneTypeLabel).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveStoneTypePreference(value) {
    const normalized = normalizeStoneTypeLabel(value);
    if (!normalized) return;

    try {
      window.localStorage?.setItem(ASSISTED_LAST_STONE_TYPE_KEY, normalized);
      const history = [normalized, ...getStoredStoneTypeHistory().filter((entry) => entry.toLowerCase() !== normalized.toLowerCase())]
        .slice(0, 40);
      window.localStorage?.setItem(ASSISTED_STONE_TYPE_HISTORY_KEY, JSON.stringify(history));
    } catch (error) {
      console.warn("Could not store assisted stone type preference:", error);
    }
  }

  function getLastStoneTypePreference() {
    try {
      return normalizeStoneTypeLabel(window.localStorage?.getItem(ASSISTED_LAST_STONE_TYPE_KEY) || "");
    } catch {
      return "";
    }
  }

  function getStoredLengthHistory() {
    try {
      const parsed = JSON.parse(window.localStorage?.getItem(ASSISTED_LENGTH_HISTORY_KEY) || "[]");
      return Array.isArray(parsed) ? parsed.map(normalizeLengthLabel).filter(Boolean) : [];
    } catch {
      return [];
    }
  }

  function saveLengthPreference(value) {
    const normalized = normalizeLengthLabel(value);
    if (!normalized) return;

    try {
      window.localStorage?.setItem(ASSISTED_LAST_LENGTH_KEY, normalized);
      const history = [normalized, ...getStoredLengthHistory().filter((entry) => entry.toLowerCase() !== normalized.toLowerCase())]
        .slice(0, 40);
      window.localStorage?.setItem(ASSISTED_LENGTH_HISTORY_KEY, JSON.stringify(history));
    } catch (error) {
      console.warn("Could not store assisted length preference:", error);
    }
  }

  function getLastLengthPreference() {
    try {
      return normalizeLengthLabel(window.localStorage?.getItem(ASSISTED_LAST_LENGTH_KEY) || "");
    } catch {
      return "";
    }
  }

  function extractStoneTypesFromText(value) {
    const rawText = asTrimmedString(value);
    const text = rawText.toLowerCase();
    if (!text) return [];

    const explicitStoneLines = rawText
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*(?:stone|stones|gemstone|gemstones)\s*:\s*(.+)$/i)?.[1] || "")
      .map((line) => line.replace(/\s*\([^)]*\)\s*/g, " ").replace(/[.;]+$/g, "").trim())
      .filter(Boolean);

    const knownMatches = ASSISTED_STONE_TYPE_MATCHERS
      .filter(([, terms]) => terms.some((term) => {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
      }))
      .map(([label]) => label);

    return [...explicitStoneLines, ...knownMatches];
  }

  function normalizeLengthLabel(value) {
    const text = asTrimmedString(value).replace(/\s+/g, " ");
    if (!text) return "";

    return text
      .replace(/\binches\b/gi, "inch")
      .replace(/\bin\.\b/gi, "in")
      .replace(/\b(\d+(?:\.\d+)?)\s*"\b/g, "$1 inch")
      .replace(/\s+/g, " ")
      .trim();
  }

  function extractLengthsFromText(value) {
    const text = asTrimmedString(value);
    if (!text) return [];

    const options = [];
    const add = (valueToAdd) => {
      const normalized = normalizeLengthLabel(valueToAdd);
      if (normalized) options.push(normalized);
    };

    text.split(/\r?\n/).forEach((line) => {
      const explicit = line.match(/^\s*(?:length|chain length|necklace length|bracelet length)\s*:\s*(.+)$/i)?.[1];
      if (explicit) add(explicit.replace(/[.;]+$/g, ""));
    });

    const lengthRegex = /\b\d+(?:\.\d+)?\s*(?:inch|inches|in\.|in|cm|mm|")\b/gi;
    for (const match of text.matchAll(lengthRegex)) {
      add(match[0]);
    }

    return options;
  }

  function buildStoneTypeOptionsFromRows(rows = []) {
    const options = new Map();
    const addOption = (value) => {
      const normalized = normalizeStoneTypeLabel(value);
      if (normalized) options.set(normalized.toLowerCase(), normalized);
    };

    getStoredStoneTypeHistory().forEach(addOption);

    (Array.isArray(rows) ? rows : []).forEach((item) => {
      addOption(item?.stone_type);
      extractStoneTypesFromText(item?.title).forEach(addOption);
      extractStoneTypesFromText(item?.description).forEach(addOption);
      (Array.isArray(item?.categories) ? item.categories : []).forEach((category) => {
        extractStoneTypesFromText(category).forEach(addOption);
      });
    });

    return [...options.values()].sort((a, b) => a.localeCompare(b));
  }

  function buildLengthOptionsFromRows(rows = []) {
    const options = new Map();
    const addOption = (value) => {
      const normalized = normalizeLengthLabel(value);
      if (normalized) options.set(normalized.toLowerCase(), normalized);
    };

    getStoredLengthHistory().forEach(addOption);

    (Array.isArray(rows) ? rows : []).forEach((item) => {
      addOption(item?.item_length);
      extractLengthsFromText(item?.title).forEach(addOption);
      extractLengthsFromText(item?.description).forEach(addOption);
      (Array.isArray(item?.categories) ? item.categories : []).forEach((category) => {
        extractLengthsFromText(category).forEach(addOption);
      });
    });

    return [...options.values()].sort((a, b) => {
      const aNumber = Number(String(a).match(/\d+(?:\.\d+)?/)?.[0] || 0);
      const bNumber = Number(String(b).match(/\d+(?:\.\d+)?/)?.[0] || 0);
      return aNumber - bNumber || a.localeCompare(b);
    });
  }

  async function loadStoneTypeOptions(elements) {
    if (!elements.stoneTypeDatalist && !elements.lengthDatalist) return;

    let rows = [];
    try {
      const { data, error } = await window.supabase
        .from("item_types")
        .select("title, description, categories, stone_type, item_length")
        .limit(1000);

      if (error) throw error;
      rows = data || [];
    } catch (error) {
      console.warn("Could not load existing stone types from inventory:", error);
    }

    const options = buildStoneTypeOptionsFromRows(rows);
    if (elements.stoneTypeDatalist) {
      elements.stoneTypeDatalist.innerHTML = options
        .map((option) => `<option value="${escapeHtml(option)}"></option>`)
        .join("");
    }

    const lengthOptions = buildLengthOptionsFromRows(rows);
    if (elements.lengthDatalist) {
      elements.lengthDatalist.innerHTML = lengthOptions
        .map((option) => `<option value="${escapeHtml(option)}"></option>`)
        .join("");
    }
  }

  function addStoneTypeOption(elements, value) {
    const normalized = normalizeStoneTypeLabel(value);
    if (!normalized || !elements.stoneTypeDatalist) return;

    const exists = Array.from(elements.stoneTypeDatalist.options || [])
      .some((option) => option.value.toLowerCase() === normalized.toLowerCase());
    if (exists) return;

    const option = document.createElement("option");
    option.value = normalized;
    elements.stoneTypeDatalist.appendChild(option);
  }

  function applyLastStoneTypePreference(elements) {
    const lastStoneType = getLastStoneTypePreference();
    if (elements.stoneTypeInput) {
      elements.stoneTypeInput.value = lastStoneType;
    }
  }

  function addLengthOption(elements, value) {
    const normalized = normalizeLengthLabel(value);
    if (!normalized || !elements.lengthDatalist) return;

    const exists = Array.from(elements.lengthDatalist.options || [])
      .some((option) => option.value.toLowerCase() === normalized.toLowerCase());
    if (exists) return;

    const option = document.createElement("option");
    option.value = normalized;
    elements.lengthDatalist.appendChild(option);
  }

  function applyLastLengthPreference(elements) {
    const lastLength = getLastLengthPreference();
    if (elements.lengthInput) {
      elements.lengthInput.value = lastLength;
    }
  }

  function normalizeImageRow(image, fallbackIndex) {
    const path = asTrimmedString(image?.path);
    const name = asTrimmedString(image?.name) || `Upload ${fallbackIndex + 1}`;
    const updatedAt = asTrimmedString(image?.updatedAt);
    const createdAt = asTrimmedString(image?.createdAt);
    const numericSortOrder = Number(image?.sortOrder);
    const previewUrl = asTrimmedString(image?.previewUrl || image?.fullUrl || image?.fullPreviewUrl);
    const thumbnailUrl = asTrimmedString(image?.thumbnailUrl || image?.thumbUrl) || previewUrl;

    return {
      path,
      name,
      createdAt,
      updatedAt: updatedAt || createdAt,
      previewUrl,
      thumbnailUrl,
      storageBucket: asTrimmedString(image?.storageBucket || image?.storage_bucket) || INVENTORY_UPLOAD_BUCKET,
      sourceType: asTrimmedString(image?.sourceType) || "inventory-upload",
      sortOrder: Number.isFinite(numericSortOrder) ? numericSortOrder : fallbackIndex,
      isPrimary: Boolean(image?.isPrimary),
      captureJobId: asTrimmedString(image?.captureJobId || image?.capture_job_id),
      mimeType: asTrimmedString(image?.mimeType || image?.mime_type) || "image/jpeg",
    };
  }

  function getLatestUploadedImage(images) {
    return Array.isArray(images) && images.length > 0 ? [...images].sort(compareNewestFirst)[0] : null;
  }

  function setInlineStatus(element, message, tone) {
    if (!element) return;

    element.textContent = message;
    element.classList.remove("is-waiting", "is-success", "is-error");

    if (tone) {
      element.classList.add(tone);
    }
  }

  function setButtonBusy(button, busyLabel, idleLabel, isBusy) {
    if (!button) return;

    button.disabled = isBusy;
    button.textContent = isBusy ? busyLabel : idleLabel;
  }

  function setBackgroundProcessingBusy(elements, background, isBusy) {
    const blackLabel = background === "black" && isBusy ? "Processing..." : "Black Background";
    const whiteLabel = background === "white" && isBusy ? "Processing..." : "White Background";

    if (elements.bgAutoAlignButton) {
      elements.bgAutoAlignButton.disabled = isBusy;
    }

    if (elements.bgBlackButton) {
      elements.bgBlackButton.disabled = isBusy;
      elements.bgBlackButton.textContent = blackLabel;
    }

    if (elements.bgWhiteButton) {
      elements.bgWhiteButton.disabled = isBusy;
      elements.bgWhiteButton.textContent = whiteLabel;
    }
  }

  function updateAutoAlignButton(elements) {
    if (!elements.bgAutoAlignButton) return;

    elements.bgAutoAlignButton.textContent = state.autoStraightenBackground
      ? "Auto Align: On"
      : "Auto Align: Off";
    elements.bgAutoAlignButton.setAttribute("aria-pressed", state.autoStraightenBackground ? "true" : "false");
    elements.bgAutoAlignButton.classList.toggle("is-active", state.autoStraightenBackground);
  }

  function toggleAutoAlign(elements) {
    state.autoStraightenBackground = !state.autoStraightenBackground;
    updateAutoAlignButton(elements);
    setInlineStatus(
      elements.bgStatus,
      state.autoStraightenBackground
        ? "Auto align is on for the next black/white background process."
        : "Auto align is off. Background removal will keep the original rotation.",
      "is-waiting"
    );
  }

  function getCurrentCategory(elements) {
    const hiddenValue = asTrimmedString(elements.mainCategoryInput?.value);
    if (hiddenValue) return hiddenValue;

    const toggleText = asTrimmedString(elements.categoryToggle?.textContent);
    if (toggleText && toggleText !== "Select or Create Category") {
      return toggleText;
    }

    return "";
  }

  function syncWeightIntoMainForm(elements, stableWeight) {
    if (!elements.mainWeightInput) return;

    elements.mainWeightInput.value = Number(stableWeight).toFixed(2);
    elements.mainWeightInput.dispatchEvent(new Event("input", { bubbles: true }));
    elements.mainWeightInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function syncSilver925Pricing(elements) {
    const priceInput = document.getElementById("price-per-weight");
    if (!priceInput) return;

    const isSilver925 = asTrimmedString(elements.materialSelect?.value) === "Silver"
      && asTrimmedString(elements.puritySelect?.value) === "925";

    if (isSilver925) {
      priceInput.value = "7";
      priceInput.dataset.autoSilver925 = "true";
      priceInput.dispatchEvent(new Event("input", { bubbles: true }));
      priceInput.dispatchEvent(new Event("change", { bubbles: true }));
    } else if (priceInput.dataset.autoSilver925 === "true") {
      priceInput.value = "";
      delete priceInput.dataset.autoSilver925;
      priceInput.dispatchEvent(new Event("input", { bubbles: true }));
      priceInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function applyDefaultSilver925Selection(elements) {
    if (!elements.materialSelect || !elements.puritySelect) return;

    elements.materialSelect.value = "Silver";
    updatePurityOptions(elements, "Silver", "925");
    syncSilver925Pricing(elements);
  }

  function setAssistedWeight(elements, weight, options = {}) {
    const stableWeight = parseWeightInput(weight);
    if (!Number.isFinite(stableWeight)) return false;

    state.stableWeight = stableWeight;

    if (elements.weightDisplay) elements.weightDisplay.textContent = formatWeight(stableWeight);
    if (elements.manualWeightInput && elements.manualWeightInput.value !== stableWeight.toFixed(2)) {
      elements.manualWeightInput.value = stableWeight.toFixed(2);
    }

    syncWeightIntoMainForm(elements, stableWeight);

    if (options.message && elements.scaleState) {
      elements.scaleState.textContent = options.message;
    }

    markGeneratedCopyNeedsRefresh(
      elements,
      options.refreshMessage || "Weight updated. Generate again to use the latest assisted measurement."
    );

    return true;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  function releaseImagePreviewUrls(images = state.recentUploadedImages) {
    for (const image of images) {
      for (const previewUrl of [image?.previewUrl, image?.thumbnailUrl]) {
        const url = asTrimmedString(previewUrl);
        if (url.startsWith("blob:")) {
          try {
            URL.revokeObjectURL(url);
          } catch (_) {}
        }
      }
    }
  }

  function getSelectedCaptureStation() {
    return state.captureStations.find((station) => station.id === state.selectedCaptureStationId) || null;
  }

  function setSelectedCaptureStation(elements, stationId) {
    const station = state.captureStations.find((entry) => entry.id === stationId) || null;
    const nextId = station?.id || "";

    state.selectedCaptureStationId = nextId;

    if (elements.captureStationSelect && elements.captureStationSelect.value !== nextId) {
      elements.captureStationSelect.value = nextId;
    }

    try {
      if (nextId) {
        window.localStorage?.setItem("og.captureStationId", nextId);
        window.localStorage?.setItem("og.captureStationName", station?.name || "");
      } else {
        window.localStorage?.removeItem("og.captureStationId");
        window.localStorage?.removeItem("og.captureStationName");
      }
    } catch (_) {}

    return station;
  }

  function renderCaptureStations(elements) {
    if (!elements.captureStationSelect) return;

    if (!state.captureStations.length) {
      elements.captureStationSelect.innerHTML = '<option value="">No active stations</option>';
      elements.captureStationSelect.disabled = true;
      return;
    }

    elements.captureStationSelect.innerHTML = ['<option value="">Select station</option>']
      .concat(
        state.captureStations.map((station) => {
          return `<option value="${escapeHtml(station.id)}">${escapeHtml(station.name || station.id)}</option>`;
        })
      )
      .join("");

    elements.captureStationSelect.disabled = false;
    elements.captureStationSelect.value = state.selectedCaptureStationId || "";
  }

  async function loadActiveCaptureStations(elements, options = {}) {
    const { data, error } = await window.supabase
      .from(CAPTURE_STATION_TABLE)
      .select("id, name, active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      throw new Error(error.message || "Failed to load active capture stations.");
    }

    state.captureStations = Array.isArray(data) ? data : [];
    renderCaptureStations(elements);

    if (!state.captureStations.length) {
      state.selectedCaptureStationId = "";
      if (!options.silent) {
        elements.captureState.textContent = "No active capture stations are available.";
      }
      return [];
    }

    const { stationId, stationName } = getPreferredCaptureStationHints();
    const nextStation = state.captureStations.find((station) => station.id === state.selectedCaptureStationId)
      || state.captureStations.find((station) => station.id === stationId)
      || state.captureStations.find((station) => {
        return asTrimmedString(station.name).toLowerCase() === stationName.toLowerCase();
      })
      || state.captureStations[0];

    setSelectedCaptureStation(elements, nextStation?.id || "");

    if (!options.silent && nextStation) {
      elements.captureState.textContent = `Ready to route capture jobs to ${nextStation.name || nextStation.id}.`;
    }

    return state.captureStations;
  }

  function getPreferredCaptureStationHints() {
    const stationId = asTrimmedString(
      window.OG_CAPTURE_STATION_ID || window.localStorage?.getItem("og.captureStationId")
    );
    const stationName = asTrimmedString(
      window.OG_CAPTURE_STATION_NAME || window.localStorage?.getItem("og.captureStationName")
    );

    return { stationId, stationName };
  }

  async function resolveCaptureStation(elements) {
    if (!state.captureStations.length) {
      await loadActiveCaptureStations(elements, { silent: true });
    }

    if (!state.captureStations.length) {
      throw new Error("No active capture stations are available.");
    }

    const selectedStation = getSelectedCaptureStation() || state.captureStations[0];
    setSelectedCaptureStation(elements, selectedStation?.id || "");
    return selectedStation;
  }

  async function createCaptureJob(stationId) {
    const { data, error } = await window.supabase
      .from(CAPTURE_JOB_TABLE)
      .insert({
        station_id: stationId,
        status: "queued",
        requested_at: new Date().toISOString(),
      })
      .select("id, station_id, status, requested_at")
      .single();

    if (error || !data) {
      throw new Error(error?.message || "Failed to create capture job.");
    }

    return data;
  }

  function getCaptureStatusLabel(jobStatus, stationName = "") {
    const stationLabel = stationName ? ` on ${stationName}` : "";

    if (jobStatus === "queued") return `Capture queued${stationLabel}. Waiting for device...`;
    if (jobStatus === "capturing") return `Capture in progress${stationLabel}.`;
    if (jobStatus === "uploading") return `Photo captured${stationLabel}. Uploading file...`;
    if (jobStatus === "completed") return `Photo captured${stationLabel}.`;
    if (jobStatus === "failed") return `Capture failed${stationLabel}.`;
    return `Capture status: ${jobStatus || "unknown"}.`;
  }

  function captureJobHasUpload(job) {
    const bucket = asTrimmedString(job?.storage_bucket);
    const path = asTrimmedString(job?.storage_path);
    return Boolean((bucket && path) || job?.upload_completed_at);
  }

  async function getCaptureJobPhotoCount(jobId) {
    if (!jobId) return 0;

    const { count, error } = await window.supabase
      .from(CAPTURE_PHOTO_TABLE)
      .select("id", { count: "exact", head: true })
      .eq("capture_job_id", jobId);

    if (error) {
      console.warn("Could not check capture photo count:", error);
      return 0;
    }

    return count || 0;
  }

  async function findRecentCaptureCompletion(stationId, requestedAt) {
    if (!stationId || !requestedAt) return null;

    const requestedMs = new Date(requestedAt).getTime();
    const lookbackIso = Number.isFinite(requestedMs)
      ? new Date(requestedMs - CAPTURE_FALLBACK_LOOKBACK_MS).toISOString()
      : requestedAt;

    const { data, error } = await window.supabase
      .from(CAPTURE_JOB_TABLE)
      .select(`
        id,
        station_id,
        status,
        storage_bucket,
        storage_path,
        capture_completed_at,
        upload_completed_at,
        mime_type,
        file_size_bytes,
        failure_code,
        failure_message,
        requested_at
      `)
      .eq("station_id", stationId)
      .gte("requested_at", lookbackIso)
      .order("requested_at", { ascending: false })
      .limit(5);

    if (error) {
      console.warn("Could not check recent capture jobs:", error);
      return null;
    }

    const jobs = Array.isArray(data) ? data : [];
    for (const recentJob of jobs) {
      if (recentJob.status === "failed") continue;
      if (recentJob.status === "completed" || captureJobHasUpload(recentJob)) {
        return { ...recentJob, status: "completed" };
      }
    }

    return null;
  }

  async function pollCaptureJob(job, stationName = "") {
    const jobId = typeof job === "object" ? job.id : job;
    const stationId = typeof job === "object" ? job.station_id : "";
    const requestedAt = typeof job === "object" ? job.requested_at : "";
    const startedAt = Date.now();
    let lastPhotoCount = 0;
    let lastPhotoChangeAt = startedAt;

    while ((Date.now() - startedAt) < CAPTURE_POLL_TIMEOUT_MS) {
      const { data, error } = await window.supabase
        .from(CAPTURE_JOB_TABLE)
        .select(`
          id,
          station_id,
          status,
          storage_bucket,
          storage_path,
          capture_completed_at,
          upload_completed_at,
          mime_type,
          file_size_bytes,
          failure_code,
          failure_message,
          requested_at
        `)
        .eq("id", jobId)
        .single();

      if (error || !data) {
        throw new Error(error?.message || "Failed to poll capture job.");
      }

      if (data.status === "completed" || data.status === "failed") {
        return data;
      }

      const photoCount = await getCaptureJobPhotoCount(jobId);
      if (photoCount !== lastPhotoCount) {
        lastPhotoCount = photoCount;
        lastPhotoChangeAt = Date.now();
      }

      if (captureJobHasUpload(data)) {
        return { ...data, status: "completed" };
      }

      if (photoCount > 0 && (Date.now() - lastPhotoChangeAt) >= CAPTURE_PHOTO_SETTLE_MS) {
        return { ...data, status: "completed" };
      }

      const fallbackJob = await findRecentCaptureCompletion(stationId || data.station_id, requestedAt || data.requested_at);
      if (fallbackJob && fallbackJob.id !== jobId) {
        return fallbackJob;
      }

      const captureState = document.getElementById("assisted-capture-state");
      if (captureState) {
        const statusLabel = getCaptureStatusLabel(data.status, stationName);
        captureState.textContent = photoCount > 0
          ? `${statusLabel} ${photoCount} photo${photoCount === 1 ? "" : "s"} received; waiting for upload to finish...`
          : statusLabel;
      }

      await delay(CAPTURE_POLL_INTERVAL_MS);
    }

    throw new Error("Timed out waiting for capture completion.");
  }

  async function loadCaptureJobPhotos(jobId) {
    const { data, error } = await window.supabase
      .from(CAPTURE_PHOTO_TABLE)
      .select(`
        id,
        capture_job_id,
        sort_order,
        is_primary,
        storage_bucket,
        storage_path,
        file_size_bytes,
        image_width,
        image_height,
        mime_type,
        label,
        created_at
      `)
      .eq("capture_job_id", jobId)
      .order("sort_order", { ascending: true });

    if (error) {
      throw new Error(error.message || "Failed to load capture job photos.");
    }

    return Array.isArray(data) ? data : [];
  }

  function groupPathsByBucket(photos) {
    const bucketPaths = new Map();
    for (const photo of photos || []) {
      const bucket = asTrimmedString(photo?.storage_bucket);
      const path = asTrimmedString(photo?.storage_path);
      if (!bucket || !path) continue;
      if (!bucketPaths.has(bucket)) bucketPaths.set(bucket, []);
      bucketPaths.get(bucket).push(path);
    }
    return bucketPaths;
  }

  async function createSignedImageUrl(bucket, path, options = {}) {
    const transform = options.transform;

    try {
      const storage = window.supabase.storage.from(bucket);
      const { data, error } = transform
        ? await storage.createSignedUrl(path, 60 * 10, { transform })
        : await storage.createSignedUrl(path, 60 * 10);

      if (!error && data?.signedUrl) {
        return data.signedUrl;
      }

      if (!transform) {
        console.warn(`Could not create signed URL for ${bucket}/${path}:`, error);
        return "";
      }

      console.warn(`Could not create transformed signed URL for ${bucket}/${path}; using full image URL.`, error);
    } catch (error) {
      if (!transform) {
        console.warn(`Could not create signed URL for ${bucket}/${path}:`, error);
        return "";
      }

      console.warn(`Could not create transformed signed URL for ${bucket}/${path}; using full image URL.`, error);
    }

    return createSignedImageUrl(bucket, path);
  }

  async function createCapturePhotoSignedUrlMaps(photos) {
    const fullUrlByKey = new Map();
    const thumbnailUrlByKey = new Map();
    const groupedPaths = groupPathsByBucket(photos);

    for (const [bucket, paths] of groupedPaths.entries()) {
      for (const path of [...new Set(paths)]) {
        const key = `${bucket}:${path}`;
        const [fullUrl, thumbnailUrl] = await Promise.all([
          createSignedImageUrl(bucket, path),
          createSignedImageUrl(bucket, path, { transform: THUMBNAIL_SIGNED_URL_TRANSFORM }),
        ]);

        if (fullUrl) fullUrlByKey.set(key, fullUrl);
        if (thumbnailUrl) thumbnailUrlByKey.set(key, thumbnailUrl);
      }
    }

    return { fullUrlByKey, thumbnailUrlByKey };
  }

  async function loadCaptureJobPhotoImages(photos, options = {}) {
    const downloadedPhotos = [];
    const { fullUrlByKey, thumbnailUrlByKey } = await createCapturePhotoSignedUrlMaps(photos);

    for (let index = 0; index < photos.length; index += 1) {
      const photo = photos[index];
      const bucket = asTrimmedString(photo?.storage_bucket);
      const path = asTrimmedString(photo?.storage_path);

      if (!bucket || !path) {
        if (options.skipFailures) {
          console.warn("Skipping capture photo with missing bucket or path:", photo);
          continue;
        }
        throw new Error("Capture photo metadata is missing bucket or path.");
      }

      const signedKey = `${bucket}:${path}`;
      let previewUrl = fullUrlByKey.get(signedKey) || "";
      let thumbnailUrl = thumbnailUrlByKey.get(signedKey) || previewUrl;
      let mimeType = asTrimmedString(photo?.mime_type) || "image/jpeg";

      if (!previewUrl) {
        const { data, error } = await window.supabase.storage.from(bucket).download(path);
        if (error || !data) {
          if (options.skipFailures) {
            console.warn(`Skipping capture photo ${index + 1}:`, error);
            continue;
          }
          throw new Error(error?.message || `Failed to download capture photo ${index + 1}.`);
        }
        previewUrl = URL.createObjectURL(data);
        thumbnailUrl = previewUrl;
        mimeType = asTrimmedString(photo?.mime_type) || data.type || "image/jpeg";
      }

      downloadedPhotos.push(
        normalizeImageRow(
          {
            path,
            name: asTrimmedString(photo?.label) || `Capture ${index + 1}`,
            createdAt: asTrimmedString(photo?.created_at),
            updatedAt: asTrimmedString(photo?.created_at),
            previewUrl,
            thumbnailUrl,
            storageBucket: bucket,
            sourceType: asTrimmedString(options.sourceType) || "capture-job",
            sortOrder: Number(photo?.sort_order),
            isPrimary: Boolean(photo?.is_primary),
            captureJobId: asTrimmedString(photo?.capture_job_id),
            mimeType,
          },
          downloadedPhotos.length
        )
      );
    }

    return downloadedPhotos;
  }

  async function loadRecentStationCaptureImages(elements, limit = 16) {
    if (!state.captureStations.length) {
      await loadActiveCaptureStations(elements, { silent: true });
    }

    const station = getSelectedCaptureStation();
    if (!station?.id) {
      return [];
    }

    const { data, error } = await window.supabase
      .from(CAPTURE_PHOTO_TABLE)
      .select(`
        id,
        capture_job_id,
        sort_order,
        is_primary,
        storage_bucket,
        storage_path,
        file_size_bytes,
        image_width,
        image_height,
        mime_type,
        label,
        created_at,
        capture_jobs!inner(id, station_id, requested_at, status)
      `)
      .eq("capture_jobs.station_id", station.id)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      throw new Error(error.message || "Failed to load recent station capture photos.");
    }

    return loadCaptureJobPhotoImages(Array.isArray(data) ? data : [], {
      skipFailures: true,
      sourceType: "recent-station-capture",
    });
  }

  function getImageBasename(path) {
    return asTrimmedString(path).split("/").pop() || "";
  }

  function stripImageExtension(value) {
    return asTrimmedString(value).replace(/\.(png|jpe?g|webp|gif|heic|heif)$/i, "");
  }

  function safeProcessedSourceToken(value) {
    return stripImageExtension(value)
      .replace(/[^\w.\-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80)
      .toLowerCase();
  }

  function getProcessedSourceTokens(images) {
    const tokens = new Set();
    for (const image of images || []) {
      const basename = getImageBasename(image?.path);
      if (!basename) continue;
      tokens.add(basename.toLowerCase());
      tokens.add(stripImageExtension(basename).toLowerCase());
      tokens.add(safeProcessedSourceToken(basename));
    }
    return new Set([...tokens].filter((token) => token && token.length >= 8));
  }

  function imageLooksAssociatedWithSource(image, sourceTokens) {
    if (!sourceTokens?.size) return false;
    const haystack = `${image?.path || ""} ${image?.name || ""}`.toLowerCase();
    for (const token of sourceTokens) {
      if (token && haystack.includes(token)) return true;
    }
    return false;
  }

  async function loadAssociatedProcessedBackgroundImages(sourceImages, limit) {
    const sourceTokens = getProcessedSourceTokens(sourceImages);
    if (!sourceTokens.size) return [];

    const sourceBuckets = [
      ...new Set(
        sourceImages
          .map((image) => asTrimmedString(image?.storageBucket) || INVENTORY_UPLOAD_BUCKET)
          .concat([INVENTORY_UPLOAD_BUCKET, CAPTURE_PHOTOS_BUCKET])
      ),
    ];

    const processedImages = [];
    for (const bucketName of sourceBuckets) {
      const response = await window.supabase.functions.invoke(INVENTORY_UPLOAD_LIST_FUNCTION_NAME, {
        body: {
          bucket: bucketName,
          prefix: PROCESSED_BACKGROUND_PREFIX,
          limit: Math.min(80, Math.max(20, limit * 6)),
        },
      });

      if (response.error) {
        console.warn(`Unable to load associated processed images from ${bucketName}:`, response.error);
        continue;
      }

      const bucket = response.data?.bucket || bucketName;
      processedImages.push(
        ...(Array.isArray(response.data?.images) ? response.data.images : [])
          .map((image, index) => normalizeImageRow({
            ...image,
            storageBucket: bucket,
            sourceType: asTrimmedString(image?.name).includes("white")
              ? "processed-white-background"
              : "processed-black-background",
          }, processedImages.length + index))
          .filter((image) => image.path && image.previewUrl)
          .filter((image) => imageLooksAssociatedWithSource(image, sourceTokens))
      );
    }

    return processedImages;
  }

  function applyRecentUploadedImages(elements, images, options = {}) {
    const normalizedImages = Array.isArray(images) ? images : [];
    const previousAIPath = options.preserveSelection ? state.aiSelectedUploadedImagePath : "";
    const previousSaveSelections = options.preserveSelection
      ? new Set(state.saveSelectedUploadedImagePaths)
      : new Set();

    releaseImagePreviewUrls(state.recentUploadedImages);
    state.recentUploadedImages = normalizedImages;
    state.hasLoadedImagesOnce = normalizedImages.length > 0;
    state.saveSelectedUploadedImagePaths = options.preserveSelection
      ? normalizedImages
        .map((image) => image.path)
        .filter((path) => previousSaveSelections.has(path))
      : normalizedImages.map((image) => image.path).filter(Boolean);

    const defaultAIPath = options.defaultAIPath && normalizedImages.some((image) => image.path === options.defaultAIPath)
      ? options.defaultAIPath
      : "";

    const nextAIPath = defaultAIPath
      || (previousAIPath && normalizedImages.some((image) => image.path === previousAIPath) ? previousAIPath : "")
      || getLatestUploadedImage(normalizedImages)?.path
      || "";

    setAISelectedImage(elements, nextAIPath, { silent: true });
    updateSaveSelectionSummary(elements);
    renderUploadedImages(elements);
    if (options.autoProcess !== false) {
      autoProcessBlackBackgroundImages(elements, normalizedImages);
    }
  }

  async function hydrateCompletedCaptureJob(elements, completedJob, options = {}) {
    const capturePhotos = await loadCaptureJobPhotos(completedJob.id);
    const jobBucket = asTrimmedString(completedJob?.storage_bucket);
    const jobPath = asTrimmedString(completedJob?.storage_path);

    if (!capturePhotos.length && jobBucket && jobPath) {
      capturePhotos.push({
        capture_job_id: completedJob.id,
        sort_order: 0,
        is_primary: true,
        storage_bucket: jobBucket,
        storage_path: jobPath,
        file_size_bytes: completedJob.file_size_bytes,
        mime_type: completedJob.mime_type,
        label: "Camera capture",
        created_at: completedJob.upload_completed_at || completedJob.capture_completed_at || completedJob.requested_at,
      });
    }

    if (!capturePhotos.length) {
      throw new Error("Capture completed but no uploaded photos were returned for this job.");
    }

    const downloadedImages = await loadCaptureJobPhotoImages(capturePhotos);
    const primaryImage = downloadedImages.find((image) => image.isPrimary) || downloadedImages[0] || null;

    state.latestCaptureJob = completedJob;
    applyRecentUploadedImages(elements, downloadedImages, {
      preserveSelection: false,
      defaultAIPath: primaryImage?.path || "",
      autoProcess: options.autoProcess !== false,
    });

    if (options.refreshNotice) {
      setInlineStatus(
        elements.imageStatus,
        `Downloaded ${downloadedImages.length} capture photo(s) from the completed job. Choose one as the AI image.`,
        "is-success"
      );
    }

    return {
      photos: capturePhotos,
      images: downloadedImages,
      primaryImage,
    };
  }

  async function reloadCompletedCapturePhotos(elements, options = {}) {
    if (options.recentOnly || !state.latestCaptureJob?.id) {
      return loadRecentInventoryUploadImages(elements, {
        refreshNotice: true,
        preserveSelection: true,
        autoProcess: false,
      });
    }

    setButtonBusy(elements.refreshImagesButton, "Reloading...", "Reload Recent Photos", true);
    setInlineStatus(elements.imageStatus, "Reloading the completed capture photo set...", "is-waiting");

    try {
      return await hydrateCompletedCaptureJob(elements, state.latestCaptureJob, {
        refreshNotice: options.refreshNotice !== false,
        autoProcess: options.autoProcess !== false,
      });
    } catch (error) {
      console.error("Failed to reload capture photos:", error);
      setInlineStatus(
        elements.imageStatus,
        `Could not reload completed capture photos: ${error.message || error}`,
        "is-error"
      );
      return null;
    } finally {
      setButtonBusy(elements.refreshImagesButton, "Reloading...", "Reload Recent Photos", false);
    }
  }

  async function triggerIPhoneCapture(payload, elements) {
    console.log("triggerIPhoneCapture request", payload);

    const station = await resolveCaptureStation(elements);
    elements.captureState.textContent = `Routing capture to ${station.name || station.id}...`;

    const createdJob = await createCaptureJob(station.id);
    state.activeCaptureJobId = createdJob.id;

    window.dispatchEvent(
      new CustomEvent("assisted:iphone-capture-requested", {
        detail: {
          ...payload,
          stationId: station.id,
          stationName: station.name || "",
          jobId: createdJob.id,
        },
      })
    );

    const completedJob = await pollCaptureJob(createdJob, station.name || "");
    state.activeCaptureJobId = "";

    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || completedJob.failure_code || "Capture failed.");
    }

    const captureResult = await hydrateCompletedCaptureJob(elements, completedJob, { refreshNotice: true });
    const capturedCount = captureResult.images?.length || 0;
    elements.captureState.textContent = capturedCount
      ? `${capturedCount} photo${capturedCount === 1 ? "" : "s"} captured and uploaded.`
      : "Photo captured and uploaded.";

    return {
      station,
      job: completedJob,
      photos: captureResult.photos,
      images: captureResult.images,
    };
  }

  function updatePurityOptions(elements, materialValue, preserveValue = "") {
    if (!elements.puritySelect) return;

    const purities = MATERIAL_PURITY_OPTIONS[materialValue] || [];
    const nextValue = preserveValue && purities.includes(preserveValue) ? preserveValue : "";

    elements.puritySelect.innerHTML = ['<option value="">Select purity</option>']
      .concat(
        purities.map((purity) => `<option value="${escapeHtml(purity)}">${escapeHtml(purity)}</option>`)
      )
      .join("");

    elements.puritySelect.disabled = purities.length === 0;
    elements.puritySelect.value = nextValue;
  }

  function populateMaterialOptions(elements) {
    if (!elements.materialSelect) return;

    const materialOptions = Object.keys(MATERIAL_PURITY_OPTIONS)
      .map((material) => `<option value="${escapeHtml(material)}">${escapeHtml(material)}</option>`)
      .join("");

    elements.materialSelect.innerHTML = `<option value="">Select material</option>${materialOptions}`;
    updatePurityOptions(elements, "");
  }

  async function simulateStableScaleReading() {
    const baseWeight = 2 + Math.random() * 18;
    const samples = [
      baseWeight - 0.06,
      baseWeight - 0.02,
      baseWeight + 0.01,
      baseWeight,
      baseWeight + 0.01,
    ];

    await new Promise((resolve) => window.setTimeout(resolve, 1500));

    // TODO: Replace this mock stability check with real device sampling logic
    // once WebUSB, WebSerial, or another scale integration is available.
    const stableWeight = samples.reduce((total, sample) => total + sample, 0) / samples.length;

    return Number(stableWeight.toFixed(2));
  }

  function getSelectedUploadedImagesForSave() {
    return state.saveSelectedUploadedImagePaths
      .map((path) => getImageByPath(path))
      .filter(Boolean)
      .map((image) => ({
        path: image.path,
        name: image.name,
        storageBucket: image.storageBucket,
        sourceType: image.sourceType,
        previewUrl: image.previewUrl,
        mimeType: image.mimeType,
        captureJobId: image.captureJobId,
      }));
  }

  function getSelectedUploadedImagePathsForSave() {
    return getSelectedUploadedImagesForSave().map((image) => image.path);
  }

  function getImageByPath(path) {
    return state.recentUploadedImages.find((image) => image.path === path) || null;
  }

  function updateSelectedImagePreview(elements) {
    const image = state.aiSelectedUploadedImage;

    if (!image || !state.aiSelectedUploadedImageUrl) {
      elements.selectedImagePreview.hidden = true;
      elements.selectedImagePreview.removeAttribute("src");
      elements.selectedImageEmpty.hidden = false;
      elements.selectedImageName.textContent = "No AI image selected";
      elements.selectedImagePath.textContent = "Refresh after the phone upload finishes.";
      return;
    }

    elements.selectedImagePreview.src = state.aiSelectedUploadedImageUrl;
    elements.selectedImagePreview.alt = `${image.name} selected for AI copy generation`;
    elements.selectedImagePreview.hidden = false;
    elements.selectedImageEmpty.hidden = true;
    elements.selectedImageName.textContent = image.name;
    elements.selectedImagePath.textContent = image.path;
  }

  function updateSaveSelectionSummary(elements) {
    const selectedImages = state.saveSelectedUploadedImagePaths
      .map((path) => getImageByPath(path))
      .filter(Boolean);

    const count = selectedImages.length;
    const plural = count === 1 ? "image" : "images";
    elements.saveSelectionCount.textContent = `${count} ${plural} will be saved with this item.`;

    if (count === 0) {
      elements.saveSelectionSummary.textContent = "No assisted images are selected for final item save yet.";
      return;
    }

    const names = selectedImages.map((image) => image.name);
    const summaryNames = names.slice(0, 3).join(", ");
    const moreCount = names.length - 3;

    elements.saveSelectionSummary.textContent = moreCount > 0
      ? `${summaryNames}, and ${moreCount} more selected for final item save.`
      : `${summaryNames} selected for final item save.`;
  }

  function markGeneratedCopyNeedsRefresh(elements, reason) {
    const hasGeneratedCopy = asTrimmedString(elements.generatedTitleInput?.value)
      || asTrimmedString(elements.generatedDescriptionInput?.value);

    if (!hasGeneratedCopy) return;

    setInlineStatus(
      elements.generateStatus,
      reason || "Assisted inputs changed. Generate again to refresh the AI copy.",
      "is-waiting"
    );
  }

  function setAISelectedImage(elements, imagePath, options = {}) {
    const image = getImageByPath(imagePath);

    state.aiSelectedUploadedImage = image;
    state.aiSelectedUploadedImagePath = image?.path || "";
    state.aiSelectedUploadedImageUrl = image?.previewUrl || "";

    if (image?.path && options.autoSelectForSave) {
      const currentSelections = new Set(state.saveSelectedUploadedImagePaths);
      if (!currentSelections.has(image.path)) {
        currentSelections.add(image.path);
        state.saveSelectedUploadedImagePaths = state.recentUploadedImages
          .map((entry) => entry.path)
          .filter((path) => currentSelections.has(path));
        updateSaveSelectionSummary(elements);
      }
    }

    updateSelectedImagePreview(elements);
    renderUploadedImages(elements);

    if (!options.silent) {
      markGeneratedCopyNeedsRefresh(
        elements,
        "AI image changed. Generate again if you want copy based on the new AI image."
      );
    }
  }

  function toggleSaveSelectedImage(elements, imagePath) {
    const image = getImageByPath(imagePath);
    if (!image) {
      return;
    }

    const nextSelectedPaths = new Set(state.saveSelectedUploadedImagePaths);

    if (nextSelectedPaths.has(imagePath)) {
      nextSelectedPaths.delete(imagePath);
    } else {
      nextSelectedPaths.add(imagePath);
    }

    state.saveSelectedUploadedImagePaths = state.recentUploadedImages
      .map((image) => image.path)
      .filter((path) => nextSelectedPaths.has(path));

    updateSaveSelectionSummary(elements);
    renderUploadedImages(elements);
  }

  function renderUploadedImages(elements) {
    if (!elements.uploadedImageStrip) return;

    if (!state.recentUploadedImages.length) {
      elements.uploadedImageStrip.innerHTML = `
        <div class="assisted-selected-image-empty" role="listitem">
          No uploaded phone images are available yet.
        </div>
      `;
      return;
    }

    const saveSelections = new Set(state.saveSelectedUploadedImagePaths);
    const markup = state.recentUploadedImages.map((image) => {
      const isAISelected = image.path === state.aiSelectedUploadedImagePath;
      const isSaveSelected = saveSelections.has(image.path);
      const aiBadge = isAISelected
        ? '<span class="assisted-thumb-ai-badge">AI image</span>'
        : "";
      const saveButtonLabel = isSaveSelected ? "Included" : "Include";
      const saveButtonAriaLabel = `${isSaveSelected ? "Remove" : "Add"} ${escapeHtml(image.name)} ${isSaveSelected ? "from" : "to"} images saved with this item`;

      return `
        <div
          class="assisted-thumb${isAISelected ? " is-ai-selected" : ""}${isSaveSelected ? " is-save-selected" : ""}"
          role="listitem"
          data-uploaded-image-path="${escapeHtml(image.path)}"
        >
          <button
            type="button"
            class="assisted-thumb-main"
            data-assisted-ai-select="${escapeHtml(image.path)}"
            aria-pressed="${isAISelected ? "true" : "false"}"
            aria-label="Use ${escapeHtml(image.name)} as the AI description image"
          >
            <span class="assisted-thumb-image">
              <img src="${escapeHtml(image.thumbnailUrl || image.previewUrl)}" alt="${escapeHtml(image.name)}" loading="lazy" decoding="async" fetchpriority="low" />
              <span class="assisted-thumb-save-ribbon" aria-hidden="true">SAVE</span>
            </span>
            <span class="assisted-thumb-meta">
              <span class="assisted-thumb-name">${escapeHtml(image.name)}</span>
              <span class="assisted-thumb-subtext">${escapeHtml(formatTimestamp(image.updatedAt || image.createdAt))}</span>
              <span class="assisted-thumb-save-state">${isSaveSelected ? "Selected for final item photos" : "Not saved unless included"}</span>
              ${aiBadge}
            </span>
          </button>
          <button
            type="button"
            class="assisted-thumb-save-toggle${isSaveSelected ? " is-active" : ""}"
            data-assisted-save-toggle="${escapeHtml(image.path)}"
            aria-pressed="${isSaveSelected ? "true" : "false"}"
            aria-label="${saveButtonAriaLabel}"
          >
            ${saveButtonLabel}
          </button>
        </div>
      `;
    }).join("");

    elements.uploadedImageStrip.innerHTML = markup;
  }

  async function loadRecentInventoryUploadImages(elements, options = {}) {
    if (!window.supabase) {
      setInlineStatus(elements.imageStatus, "Supabase is not ready yet. Try again in a moment.", "is-error");
      return;
    }

    const preserveSelection = options.preserveSelection !== false;
    const previousAIPath = preserveSelection ? state.aiSelectedUploadedImagePath : "";
    const previousSaveSelections = preserveSelection
      ? new Set(state.saveSelectedUploadedImagePaths)
      : new Set();

    state.hasLoadedImagesOnce = true;
    setButtonBusy(elements.refreshImagesButton, "Refreshing...", "Reload Recent Photos", true);
    setInlineStatus(elements.imageStatus, "Loading recent station photos and their processed versions...", "is-waiting");

    try {
      const reloadLimit = getRecentPhotoReloadLimit(elements);
      const backendErrors = [];
      let stationCaptureImages = [];
      let processedImages = [];
      let fallbackCaptureImages = [];

      try {
        stationCaptureImages = await loadRecentStationCaptureImages(elements, reloadLimit);
      } catch (stationError) {
        backendErrors.push(stationError);
        console.warn("Could not load station capture images:", stationError);
      }

      if (stationCaptureImages.length) {
        try {
          processedImages = await loadAssociatedProcessedBackgroundImages(stationCaptureImages, reloadLimit);
        } catch (processedError) {
          backendErrors.push(processedError);
          console.warn("Could not load associated processed background images:", processedError);
        }
      }

      if (!stationCaptureImages.length) {
        try {
          const captureResponse = await window.supabase.functions.invoke(INVENTORY_UPLOAD_LIST_FUNCTION_NAME, {
            body: {
              bucket: CAPTURE_PHOTOS_BUCKET,
              limit: reloadLimit,
            },
          });
          if (captureResponse.error) {
            throw new Error(captureResponse.error.message || "Unable to load recent captured images.");
          }
          const bucket = captureResponse.data?.bucket || CAPTURE_PHOTOS_BUCKET;
          fallbackCaptureImages = (Array.isArray(captureResponse.data?.images) ? captureResponse.data.images : [])
            .map((image, index) => normalizeImageRow({
              ...image,
              storageBucket: bucket,
              sourceType: "recent-capture",
            }, index));
        } catch (captureError) {
          backendErrors.push(captureError);
          console.warn("Could not load fallback captured images:", captureError);
        }

        if (fallbackCaptureImages.length) {
          try {
            processedImages = await loadAssociatedProcessedBackgroundImages(fallbackCaptureImages, reloadLimit);
          } catch (processedError) {
            backendErrors.push(processedError);
            console.warn("Could not load fallback associated processed background images:", processedError);
          }
        }
      }

      const seenImages = new Set();
      const normalizedImages = [...stationCaptureImages, ...processedImages, ...fallbackCaptureImages]
        .filter((image) => image.path && image.previewUrl)
        .filter((image) => {
          const key = `${image.storageBucket}:${image.path}`;
          if (seenImages.has(key)) return false;
          seenImages.add(key);
          return true;
        })
        .sort(compareNewestFirst);

      releaseImagePreviewUrls(state.recentUploadedImages);
      state.recentUploadedImages = normalizedImages;
      state.saveSelectedUploadedImagePaths = preserveSelection
        ? normalizedImages
          .map((image) => image.path)
          .filter((path) => previousSaveSelections.has(path))
        : normalizedImages.map((image) => image.path).filter(Boolean);

      const nextAIPath = normalizedImages.some((image) => image.path === previousAIPath)
        ? previousAIPath
        : getLatestUploadedImage(normalizedImages)?.path || "";

      setAISelectedImage(elements, nextAIPath, { silent: true });
      updateSaveSelectionSummary(elements);
      renderUploadedImages(elements);
      if (options.autoProcess === true) {
        autoProcessBlackBackgroundImages(elements, normalizedImages);
      }

      if (!normalizedImages.length) {
        if (backendErrors.length) {
          throw backendErrors[0];
        }
        setInlineStatus(
          elements.imageStatus,
          "No uploaded or captured phone images were returned. Refresh after the iPhone upload finishes.",
          "is-error"
        );
        return;
      }

      if (options.refreshNotice) {
        const station = getSelectedCaptureStation();
        const stationText = station?.name ? ` from ${station.name}` : "";
        const processedText = processedImages.length ? `, including ${processedImages.length} processed version(s)` : "";
        setInlineStatus(
          elements.imageStatus,
          `Loaded ${normalizedImages.length} recent image(s)${stationText}${processedText}. Older reloaded images were not auto-processed.`,
          "is-success"
        );
      } else {
        setInlineStatus(
          elements.imageStatus,
          `Latest uploaded or captured image is ready. ${state.saveSelectedUploadedImagePaths.length} image(s) are marked to save with this item.`,
          "is-success"
        );
      }
    } catch (error) {
      console.error("Failed to load recent upload/capture images:", error);
      state.recentUploadedImages = [];
      state.aiSelectedUploadedImage = null;
      state.aiSelectedUploadedImagePath = "";
      state.aiSelectedUploadedImageUrl = "";
      state.saveSelectedUploadedImagePaths = [];
      updateSelectedImagePreview(elements);
      updateSaveSelectionSummary(elements);
      renderUploadedImages(elements);
      setInlineStatus(
        elements.imageStatus,
        `Could not load recent phone images from the backend: ${error.message || error}`,
        "is-error"
      );
    } finally {
      setButtonBusy(elements.refreshImagesButton, "Refreshing...", "Reload Recent Photos", false);
    }
  }

  function resolveCurrentWeight(elements) {
    if (Number.isFinite(state.stableWeight)) {
      return state.stableWeight;
    }

    const currentWeight = Number(elements.mainWeightInput?.value);
    return Number.isFinite(currentWeight) ? currentWeight : null;
  }

  function collectAssistedWorkflowGenerationInputs(elements) {
    const selectedImage = state.aiSelectedUploadedImage;

    return {
      bucket: asTrimmedString(selectedImage?.storageBucket) || INVENTORY_UPLOAD_BUCKET,
      imagePath: state.aiSelectedUploadedImagePath,
      material: asTrimmedString(elements.materialSelect?.value),
      purity: asTrimmedString(elements.puritySelect?.value),
      weight: resolveCurrentWeight(elements),
      stoneType: asTrimmedString(elements.stoneTypeInput?.value),
      length: asTrimmedString(elements.lengthInput?.value),
      notes: asTrimmedString(elements.notesInput?.value),
      category: getCurrentCategory(elements),
      qrType: asTrimmedString(elements.qrTypeSelect?.value),
      existingTitle: asTrimmedString(elements.mainTitleInput?.value),
      existingDescription: asTrimmedString(elements.mainDescriptionInput?.value),
    };
  }

  async function requestAIGenerationForSelectedImage(payload) {
    const { data, error } = await window.supabase.functions.invoke(AI_COPY_FUNCTION_NAME, {
      body: payload,
    });

    if (error) {
      let errorDetail = "";

      try {
        if (error.context && typeof error.context.clone === "function") {
          const clonedResponse = error.context.clone();
          const responseBody = await clonedResponse.json();
          errorDetail = asTrimmedString(
            responseBody?.detail
            || responseBody?.error
            || responseBody?.openaiErrorSummary
            || responseBody?.receivedBucket
          );
          console.error("AI generation invoke response body:", responseBody);
        }
      } catch (detailError) {
        console.warn("Could not parse AI generation error response body:", detailError);
      }

      console.error("AI generation invoke error:", error);
      throw new Error(errorDetail || error.message || "AI generation failed.");
    }

    return data;
  }

  async function getFunctionErrorDetail(error) {
    try {
      const response = error?.context;
      if (response && typeof response.clone === "function") {
        const payload = await response.clone().json();
        return asTrimmedString(payload?.detail || payload?.error || payload?.message);
      }
    } catch (detailError) {
      console.warn("Could not read Edge Function error body:", detailError);
    }

    return asTrimmedString(error?.message);
  }

  function readBlobAsDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(reader.error || new Error("Could not read normalized image."));
      reader.readAsDataURL(blob);
    });
  }

  function getExtensionFromFile(file) {
    const nameExtension = asTrimmedString(file?.name).split(".").pop()?.toLowerCase();
    if (["jpg", "jpeg", "png", "webp"].includes(nameExtension)) {
      return nameExtension === "jpeg" ? "jpg" : nameExtension;
    }

    const type = asTrimmedString(file?.type).toLowerCase();
    if (type.includes("png")) return "png";
    if (type.includes("webp")) return "webp";
    return "jpg";
  }

  function getSafeUploadName(file) {
    const baseName = asTrimmedString(file?.name)
      .replace(/\.[^.]+$/, "")
      .replace(/[^\w.-]+/g, "_")
      .replace(/_+/g, "_")
      .slice(0, 80) || "document-image";
    return `${baseName}.${getExtensionFromFile(file)}`;
  }

  function canvasToBlob(canvas, type, quality) {
    return new Promise((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          resolve(blob);
          return;
        }

        reject(new Error("Could not normalize the selected image for processing."));
      }, type, quality);
    });
  }

  async function createCompressedImageBlobFromFile(file) {
    const sourceUrl = URL.createObjectURL(file);

    try {
      const image = await loadImageElement(sourceUrl);
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;

      if (!sourceWidth || !sourceHeight) {
        throw new Error("Selected file has invalid image dimensions.");
      }

      const scale = Math.min(1, LOCAL_UPLOAD_MAX_SIDE / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Browser image upload preparation is not available.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      return await canvasToBlob(canvas, "image/jpeg", 0.94);
    } finally {
      URL.revokeObjectURL(sourceUrl);
    }
  }

  async function createLocalImageUploadPayload(file) {
    if (!file || !String(file.type || "").startsWith("image/")) {
      throw new Error("Choose a valid image file.");
    }

    const shouldUploadDirectly = file.size <= LOCAL_UPLOAD_MAX_DIRECT_BYTES
      && /image\/(png|jpe?g|webp)/i.test(file.type || "");
    const uploadBlob = shouldUploadDirectly ? file : await createCompressedImageBlobFromFile(file);
    const dataUrl = await readBlobAsDataUrl(uploadBlob);
    const processedImageBase64 = dataUrl.split(",")[1] || "";

    if (!processedImageBase64) {
      throw new Error("Could not prepare the selected image for upload.");
    }

    return {
      processedImageBase64,
      processedMimeType: uploadBlob.type || "image/jpeg",
      fileName: getSafeUploadName(file),
    };
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error("Could not load the selected image for normalization."));
      image.src = src;
    });
  }

  async function loadBackgroundRemoval() {
    if (!backgroundRemovalModulePromise) {
      backgroundRemovalModulePromise = import(BACKGROUND_REMOVAL_MODULE_URL)
        .then((module) => module.default || module.removeBackground || module)
        .catch((error) => {
          backgroundRemovalModulePromise = null;
          throw error;
        });
    }

    return backgroundRemovalModulePromise;
  }

  function preloadBackgroundRemoval(elements) {
    if (backgroundRemovalPreloadQueued || state.isProcessingImage || state.isAutoBlackProcessing) {
      return;
    }

    backgroundRemovalPreloadQueued = true;

    const runPreload = () => {
      loadBackgroundRemoval()
        .then(() => {
          if (!state.isProcessingImage && !state.isAutoBlackProcessing && elements.bgStatus) {
            const currentStatus = asTrimmedString(elements.bgStatus.textContent).toLowerCase();
            if (!currentStatus.includes("processing") && !currentStatus.includes("removing")) {
              setInlineStatus(
                elements.bgStatus,
                "Background tools are ready for faster black/white processing.",
                "is-success"
              );
            }
          }
        })
        .catch((error) => {
          backgroundRemovalPreloadQueued = false;
          console.warn("Background removal preload failed:", error);
        });
    };

    if ("requestIdleCallback" in window) {
      window.requestIdleCallback(runPreload, { timeout: 4000 });
      return;
    }

    window.setTimeout(runPreload, 600);
  }

  async function createObjectUrlForCanvas(previewUrl) {
    if (previewUrl.startsWith("blob:") || previewUrl.startsWith("data:")) {
      return {
        imageUrl: previewUrl,
        revoke: () => {},
      };
    }

    const response = await fetch(previewUrl);
    if (!response.ok) {
      throw new Error(`Could not download the selected image for normalization (${response.status}).`);
    }

    const imageBlob = await response.blob();
    const imageUrl = URL.createObjectURL(imageBlob);

    return {
      imageUrl,
      revoke: () => URL.revokeObjectURL(imageUrl),
    };
  }

  async function createScaledSourceBlobForBackgroundRemoval(selectedImage) {
    const previewUrl = asTrimmedString(selectedImage?.previewUrl);
    if (!previewUrl) {
      throw new Error("Selected image has no preview URL to process.");
    }

    const objectUrl = await createObjectUrlForCanvas(previewUrl);

    try {
      const image = await loadImageElement(objectUrl.imageUrl);
      const sourceWidth = image.naturalWidth || image.width;
      const sourceHeight = image.naturalHeight || image.height;

      if (!sourceWidth || !sourceHeight) {
        throw new Error("Selected image has invalid dimensions.");
      }

      const scale = Math.min(1, BACKGROUND_PROCESSING_MAX_SOURCE_SIDE / Math.max(sourceWidth, sourceHeight));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(sourceWidth * scale));
      canvas.height = Math.max(1, Math.round(sourceHeight * scale));

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Browser image normalization is not available.");
      }

      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);

      return await canvasToBlob(canvas, "image/png", 0.95);
    } finally {
      objectUrl.revoke();
    }
  }

  function normalizeRadians(value) {
    let angle = value;
    while (angle > Math.PI / 2) angle -= Math.PI;
    while (angle < -Math.PI / 2) angle += Math.PI;
    return angle;
  }

  function calculateForegroundAxisCorrection(context, width, height) {
    const imageData = context.getImageData(0, 0, width, height);
    const data = imageData.data;
    const alphaThreshold = 24;
    let weightTotal = 0;
    let sumX = 0;
    let sumY = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[((y * width + x) * 4) + 3];
        if (alpha <= alphaThreshold) continue;

        const weight = alpha / 255;
        weightTotal += weight;
        sumX += x * weight;
        sumY += y * weight;
      }
    }

    if (weightTotal < 80) {
      return 0;
    }

    const centerX = sumX / weightTotal;
    const centerY = sumY / weightTotal;
    let covXX = 0;
    let covXY = 0;
    let covYY = 0;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const alpha = data[((y * width + x) * 4) + 3];
        if (alpha <= alphaThreshold) continue;

        const weight = alpha / 255;
        const dx = x - centerX;
        const dy = y - centerY;
        covXX += weight * dx * dx;
        covXY += weight * dx * dy;
        covYY += weight * dy * dy;
      }
    }

    if (!Number.isFinite(covXX) || !Number.isFinite(covXY) || !Number.isFinite(covYY)) {
      return 0;
    }

    const objectAxis = 0.5 * Math.atan2(2 * covXY, covXX - covYY);
    const targetAxis = Math.round(objectAxis / (Math.PI / 2)) * (Math.PI / 2);
    const correction = normalizeRadians(targetAxis - objectAxis);
    const correctionDegrees = Math.abs(correction * 180 / Math.PI);

    if (correctionDegrees < AUTO_STRAIGHTEN_MIN_DEGREES || correctionDegrees > AUTO_STRAIGHTEN_MAX_DEGREES) {
      return 0;
    }

    return correction;
  }

  function createAutoStraightenedCutoutCanvas(cutoutImage, width, height) {
    const sourceCanvas = document.createElement("canvas");
    sourceCanvas.width = width;
    sourceCanvas.height = height;

    const sourceContext = sourceCanvas.getContext("2d", { willReadFrequently: true });
    if (!sourceContext) {
      throw new Error("Browser image alignment is not available.");
    }

    sourceContext.drawImage(cutoutImage, 0, 0, width, height);

    const correction = calculateForegroundAxisCorrection(sourceContext, width, height);
    if (!correction) {
      return {
        canvas: sourceCanvas,
        correctionDegrees: 0,
      };
    }

    const alignedCanvas = document.createElement("canvas");
    alignedCanvas.width = width;
    alignedCanvas.height = height;

    const alignedContext = alignedCanvas.getContext("2d");
    if (!alignedContext) {
      throw new Error("Browser image alignment is not available.");
    }

    const rotatedBoundsWidth = Math.abs(Math.cos(correction)) * width + Math.abs(Math.sin(correction)) * height;
    const rotatedBoundsHeight = Math.abs(Math.sin(correction)) * width + Math.abs(Math.cos(correction)) * height;
    const safeScale = Math.min(1, width / rotatedBoundsWidth, height / rotatedBoundsHeight);

    alignedContext.imageSmoothingEnabled = true;
    alignedContext.imageSmoothingQuality = "high";
    alignedContext.translate(width / 2, height / 2);
    alignedContext.rotate(correction);
    alignedContext.scale(safeScale, safeScale);
    alignedContext.drawImage(sourceCanvas, -width / 2, -height / 2);

    return {
      canvas: alignedCanvas,
      correctionDegrees: correction * 180 / Math.PI,
    };
  }

  async function createCompositedBackgroundBlob(cutoutBlob, background, options = {}) {
    const cutoutUrl = URL.createObjectURL(cutoutBlob);

    try {
      const cutoutImage = await loadImageElement(cutoutUrl);
      const width = cutoutImage.naturalWidth || cutoutImage.width;
      const height = cutoutImage.naturalHeight || cutoutImage.height;

      if (!width || !height) {
        throw new Error("Background removal returned an invalid image.");
      }

      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      const context = canvas.getContext("2d");
      if (!context) {
        throw new Error("Browser image compositing is not available.");
      }

      context.fillStyle = background === "black" ? "#000000" : "#ffffff";
      context.fillRect(0, 0, width, height);
      if (options.autoStraighten) {
        const alignedCutout = createAutoStraightenedCutoutCanvas(cutoutImage, width, height);
        context.drawImage(alignedCutout.canvas, 0, 0, width, height);
      } else {
        context.drawImage(cutoutImage, 0, 0, width, height);
      }

      return await canvasToBlob(canvas, "image/png", 0.95);
    } finally {
      URL.revokeObjectURL(cutoutUrl);
    }
  }

  async function createPixelPreservingBackgroundPayload(selectedImage, background, elements, options = {}) {
    setInlineStatus(
      elements.bgStatus,
      "Preparing object cutout. First run may take a little while while the model loads...",
      "is-waiting"
    );

    const sourceBlob = await createScaledSourceBlobForBackgroundRemoval(selectedImage);
    const removeBackground = await loadBackgroundRemoval();

    setInlineStatus(
      elements.bgStatus,
      "Removing only the background and keeping the original object pixels...",
      "is-waiting"
    );

    const cutoutBlob = await removeBackground(sourceBlob, {
      model: "isnet_fp16",
      output: {
        format: "image/png",
        quality: 0.95,
        type: "foreground",
      },
      progress: (key, current, total) => {
        if (!total) return;
        const percent = Math.round((current / total) * 100);
        setInlineStatus(elements.bgStatus, `Loading background removal assets: ${percent}%`, "is-waiting");
      },
    });

    const processedBlob = await createCompositedBackgroundBlob(cutoutBlob, background, {
      autoStraighten: Boolean(options.autoStraighten),
    });
    const dataUrl = await readBlobAsDataUrl(processedBlob);
    const processedImageBase64 = dataUrl.split(",")[1] || "";

    if (!processedImageBase64) {
      throw new Error("Background processor returned an empty image.");
    }

    return {
      processedImageBase64,
      processedMimeType: processedBlob.type || "image/png",
    };
  }

  function shouldAutoProcessBlackBackground(image) {
    const sourceType = asTrimmedString(image?.sourceType).toLowerCase();
    return Boolean(image?.path && image?.storageBucket)
      && !sourceType.startsWith("processed-")
      && sourceType !== "edited"
      && sourceType !== "cropped";
  }

  async function processImageBackgroundForImage(elements, selectedImage, background, options = {}) {
    const bucket = asTrimmedString(selectedImage?.storageBucket);
    const imagePath = asTrimmedString(selectedImage?.path);

    if (!bucket || !imagePath) {
      setInlineStatus(elements.bgStatus, "Select an image before processing the background.", "is-error");
      return null;
    }

    if (options.showBusy !== false) {
      setBackgroundProcessingBusy(elements, background, true);
    }
    setInlineStatus(
      elements.bgStatus,
      options.statusMessage || `Creating ${background} background version and uploading it back...`,
      "is-waiting"
    );

    try {
      const processedImagePayload = await createPixelPreservingBackgroundPayload(selectedImage, background, elements, {
        autoStraighten: state.autoStraightenBackground,
      });
      const { data, error } = await window.supabase.functions.invoke(IMAGE_PROCESS_FUNCTION_NAME, {
        body: {
          bucket,
          imagePath,
          background,
          ...processedImagePayload,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorDetail(error) || "Background processing failed.");
      }

      if (!data?.ok || !data?.path || !data?.bucket) {
        throw new Error(data?.detail || data?.error || "Background processor returned no image.");
      }

      const processedImage = normalizeImageRow(
        {
          path: data.path,
          name: data.name || `${background} background - ${selectedImage.name || "processed image"}`,
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt: data.createdAt || new Date().toISOString(),
          previewUrl: data.previewUrl || "",
          storageBucket: data.bucket,
          sourceType: `processed-${background}-background`,
          sortOrder: -1,
          mimeType: data.mimeType || "image/png",
        },
        0
      );

      state.recentUploadedImages = [
        processedImage,
        ...state.recentUploadedImages.filter((image) => image.path !== processedImage.path),
      ];

      if (options.selectResult !== false) {
        setAISelectedImage(elements, processedImage.path, {
          autoSelectForSave: true,
          silent: true,
        });
      }
      updateSaveSelectionSummary(elements);
      renderUploadedImages(elements);
      setInlineStatus(
        elements.bgStatus,
        `Processed image uploaded with a ${background} background. Review it in the preview and capture set.`,
        "is-success"
      );

      return processedImage;
    } catch (error) {
      console.error("Background processing failed:", error);
      setInlineStatus(
        elements.bgStatus,
        error?.message || "Could not process the background.",
        "is-error"
      );
      return null;
    } finally {
      if (options.showBusy !== false) {
        setBackgroundProcessingBusy(elements, background, false);
      }
    }
  }

  async function autoProcessBlackBackgroundImages(elements, images = []) {
    if (state.isAutoBlackProcessing) return;

    const candidates = (Array.isArray(images) ? images : [])
      .filter(shouldAutoProcessBlackBackground)
      .filter((image) => !state.autoBlackProcessedSourcePaths.has(image.path));

    if (!candidates.length) return;

    state.isAutoBlackProcessing = true;
    state.isProcessingImage = true;
    setBackgroundProcessingBusy(elements, "black", true);

    try {
      for (let index = 0; index < candidates.length; index += 1) {
        const image = candidates[index];
        state.autoBlackProcessedSourcePaths.add(image.path);
        await processImageBackgroundForImage(elements, image, "black", {
          showBusy: false,
          selectResult: true,
          statusMessage: `Auto-processing black background ${index + 1} of ${candidates.length}...`,
        });
      }
    } finally {
      state.isAutoBlackProcessing = false;
      state.isProcessingImage = false;
      setBackgroundProcessingBusy(elements, "black", false);
    }
  }

  async function processSelectedImageBackground(elements, background) {
    if (state.isProcessingImage) return;

    state.isProcessingImage = true;
    await processImageBackgroundForImage(elements, state.aiSelectedUploadedImage, background, {
      showBusy: true,
      selectResult: true,
    });
    state.isProcessingImage = false;
  }

  function resetImageEditorState() {
    if (typeof state.imageEditor.sourceRevoke === "function") {
      try {
        state.imageEditor.sourceRevoke();
      } catch (_) {}
    }

    state.imageEditor.image = null;
    state.imageEditor.sourceUrl = "";
    state.imageEditor.sourceRevoke = null;
    state.imageEditor.imageElement = null;
    state.imageEditor.zoom = 1;
    state.imageEditor.rotation = 0;
    state.imageEditor.flipX = false;
    state.imageEditor.flipY = false;
    state.imageEditor.offsetX = 0;
    state.imageEditor.offsetY = 0;
    state.imageEditor.isDragging = false;
    state.imageEditor.dragStartX = 0;
    state.imageEditor.dragStartY = 0;
    state.imageEditor.dragOriginX = 0;
    state.imageEditor.dragOriginY = 0;
  }

  function getEditorCanvasSize(elements) {
    const canvas = elements.imageEditorCanvas;
    return {
      width: canvas?.width || 900,
      height: canvas?.height || 900,
    };
  }

  function getEditorDrawRect(width, height) {
    const image = state.imageEditor.imageElement;
    if (!image) return null;

    const sourceWidth = image.naturalWidth || image.width;
    const sourceHeight = image.naturalHeight || image.height;
    if (!sourceWidth || !sourceHeight) return null;

    const baseScale = Math.max(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * baseScale * state.imageEditor.zoom;
    const drawHeight = sourceHeight * baseScale * state.imageEditor.zoom;

    return {
      x: ((width - drawWidth) / 2) + state.imageEditor.offsetX,
      y: ((height - drawHeight) / 2) + state.imageEditor.offsetY,
      width: drawWidth,
      height: drawHeight,
    };
  }

  function drawTransformedEditorImage(context, image, rect, outputWidth, outputHeight) {
    const centerX = rect.x + (rect.width / 2);
    const centerY = rect.y + (rect.height / 2);
    const rotation = (Number(state.imageEditor.rotation) || 0) * Math.PI / 180;
    const flipScaleX = state.imageEditor.flipX ? -1 : 1;
    const flipScaleY = state.imageEditor.flipY ? -1 : 1;

    context.save();
    context.translate(centerX, centerY);
    context.rotate(rotation);
    context.scale(flipScaleX, flipScaleY);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, -rect.width / 2, -rect.height / 2, rect.width, rect.height);
    context.restore();
  }

  function drawImageEditor(elements) {
    const canvas = elements.imageEditorCanvas;
    const image = state.imageEditor.imageElement;
    if (!canvas || !image) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const width = canvas.width;
    const height = canvas.height;
    const rect = getEditorDrawRect(width, height);
    context.clearRect(0, 0, width, height);

    if (!rect) return;
    drawTransformedEditorImage(context, image, rect, width, height);
  }

  function setEditorZoom(elements, zoom) {
    const nextZoom = Math.min(4, Math.max(1, Number(zoom) || 1));
    state.imageEditor.zoom = nextZoom;

    if (elements.imageEditorZoom) {
      elements.imageEditorZoom.value = String(nextZoom);
    }

    drawImageEditor(elements);
  }

  function resetEditorFraming(elements) {
    state.imageEditor.zoom = 1;
    state.imageEditor.rotation = 0;
    state.imageEditor.flipX = false;
    state.imageEditor.flipY = false;
    state.imageEditor.offsetX = 0;
    state.imageEditor.offsetY = 0;

    if (elements.imageEditorZoom) {
      elements.imageEditorZoom.value = "1";
    }

    if (elements.imageEditorRotation) {
      elements.imageEditorRotation.value = "0";
    }

    elements.imageEditorFlipHorizontal?.classList.remove("is-active");
    elements.imageEditorFlipVertical?.classList.remove("is-active");
    drawImageEditor(elements);
  }

  function setEditorRotation(elements, degrees) {
    const nextRotation = Math.min(45, Math.max(-45, Number(degrees) || 0));
    state.imageEditor.rotation = nextRotation;

    if (elements.imageEditorRotation) {
      elements.imageEditorRotation.value = String(nextRotation);
    }

    drawImageEditor(elements);
  }

  function toggleEditorFlip(elements, axis) {
    if (axis === "x") {
      state.imageEditor.flipX = !state.imageEditor.flipX;
      elements.imageEditorFlipHorizontal?.classList.toggle("is-active", state.imageEditor.flipX);
    }

    if (axis === "y") {
      state.imageEditor.flipY = !state.imageEditor.flipY;
      elements.imageEditorFlipVertical?.classList.toggle("is-active", state.imageEditor.flipY);
    }

    drawImageEditor(elements);
  }

  async function openImageEditor(elements) {
    const selectedImage = state.aiSelectedUploadedImage;

    if (!selectedImage?.path || !selectedImage?.previewUrl) {
      setInlineStatus(elements.bgStatus, "Select an image before opening the crop editor.", "is-error");
      return;
    }

    resetImageEditorState();
    state.imageEditor.image = selectedImage;
    setInlineStatus(elements.imageEditorStatus, "Loading selected image...", "is-waiting");

    elements.imageEditorModal?.classList.remove("hidden");
    elements.imageEditorModal?.setAttribute("aria-hidden", "false");
    document.body.classList.add("modal-open");

    try {
      const objectUrl = await createObjectUrlForCanvas(selectedImage.previewUrl);
      const imageElement = await loadImageElement(objectUrl.imageUrl);

      state.imageEditor.sourceUrl = objectUrl.imageUrl;
      state.imageEditor.sourceRevoke = objectUrl.revoke;
      state.imageEditor.imageElement = imageElement;
      resetEditorFraming(elements);
      setInlineStatus(
        elements.imageEditorStatus,
        "Drag the image to frame it, then save the crop as the final selected image.",
        ""
      );
    } catch (error) {
      console.error("Image editor failed to load:", error);
      setInlineStatus(
        elements.imageEditorStatus,
        error?.message || "Could not load the image editor.",
        "is-error"
      );
    }
  }

  function closeImageEditor(elements) {
    elements.imageEditorModal?.classList.add("hidden");
    elements.imageEditorModal?.setAttribute("aria-hidden", "true");
    document.body.classList.remove("modal-open");
    resetImageEditorState();
  }

  function getEditorPointerPosition(event, elements) {
    const canvas = elements.imageEditorCanvas;
    const bounds = canvas.getBoundingClientRect();
    const scaleX = canvas.width / bounds.width;
    const scaleY = canvas.height / bounds.height;

    return {
      x: (event.clientX - bounds.left) * scaleX,
      y: (event.clientY - bounds.top) * scaleY,
    };
  }

  function handleEditorPointerDown(event, elements) {
    if (!state.imageEditor.imageElement || !elements.imageEditorCanvas) return;

    const position = getEditorPointerPosition(event, elements);
    state.imageEditor.isDragging = true;
    state.imageEditor.dragStartX = position.x;
    state.imageEditor.dragStartY = position.y;
    state.imageEditor.dragOriginX = state.imageEditor.offsetX;
    state.imageEditor.dragOriginY = state.imageEditor.offsetY;
    elements.imageEditorCanvasWrap?.classList.add("is-dragging");
    elements.imageEditorCanvas.setPointerCapture?.(event.pointerId);
  }

  function handleEditorPointerMove(event, elements) {
    if (!state.imageEditor.isDragging) return;

    const position = getEditorPointerPosition(event, elements);
    state.imageEditor.offsetX = state.imageEditor.dragOriginX + (position.x - state.imageEditor.dragStartX);
    state.imageEditor.offsetY = state.imageEditor.dragOriginY + (position.y - state.imageEditor.dragStartY);
    drawImageEditor(elements);
  }

  function handleEditorPointerUp(event, elements) {
    if (!state.imageEditor.isDragging) return;

    state.imageEditor.isDragging = false;
    elements.imageEditorCanvasWrap?.classList.remove("is-dragging");
    elements.imageEditorCanvas?.releasePointerCapture?.(event.pointerId);
  }

  async function saveImageEditorCrop(elements) {
    const selectedImage = state.imageEditor.image;
    const bucket = asTrimmedString(selectedImage?.storageBucket);
    const imagePath = asTrimmedString(selectedImage?.path);

    if (!selectedImage || !bucket || !imagePath || !state.imageEditor.imageElement) {
      setInlineStatus(elements.imageEditorStatus, "Open an image before saving a crop.", "is-error");
      return;
    }

    setButtonBusy(elements.imageEditorSave, "Saving...", "Use This Crop", true);
    setInlineStatus(elements.imageEditorStatus, "Uploading cropped final image...", "is-waiting");

    try {
      const outputCanvas = document.createElement("canvas");
      outputCanvas.width = IMAGE_EDITOR_OUTPUT_SIZE;
      outputCanvas.height = IMAGE_EDITOR_OUTPUT_SIZE;

      const { width: editorWidth, height: editorHeight } = getEditorCanvasSize(elements);
      const scale = IMAGE_EDITOR_OUTPUT_SIZE / editorWidth;
      const context = outputCanvas.getContext("2d");
      const rect = getEditorDrawRect(editorWidth, editorHeight);

      if (!context || !rect) {
        throw new Error("Could not render the crop.");
      }

      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = "high";
      context.clearRect(0, 0, outputCanvas.width, outputCanvas.height);
      drawTransformedEditorImage(
        context,
        state.imageEditor.imageElement,
        {
          x: rect.x * scale,
          y: rect.y * scale,
          width: rect.width * scale,
          height: rect.height * scale,
        },
        outputCanvas.width,
        outputCanvas.height
      );

      const croppedBlob = await canvasToBlob(outputCanvas, "image/png", 0.95);
      const dataUrl = await readBlobAsDataUrl(croppedBlob);
      const processedImageBase64 = dataUrl.split(",")[1] || "";

      if (!processedImageBase64) {
        throw new Error("The crop rendered an empty image.");
      }

      const { data, error } = await window.supabase.functions.invoke(IMAGE_PROCESS_FUNCTION_NAME, {
        body: {
          bucket,
          imagePath,
          background: "edited",
          processedImageBase64,
          processedMimeType: croppedBlob.type || "image/png",
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorDetail(error) || "Could not upload cropped image.");
      }

      if (!data?.ok || !data?.path || !data?.bucket) {
        throw new Error(data?.detail || data?.error || "Crop upload returned no image.");
      }

      const croppedImage = normalizeImageRow(
        {
          path: data.path,
          name: data.name || `cropped - ${selectedImage.name || "final image"}`,
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt: data.createdAt || new Date().toISOString(),
          previewUrl: data.previewUrl || "",
          storageBucket: data.bucket,
          sourceType: "edited-crop",
          sortOrder: -2,
          mimeType: data.mimeType || "image/png",
        },
        0
      );

      state.recentUploadedImages = [
        croppedImage,
        ...state.recentUploadedImages.filter((image) => image.path !== croppedImage.path),
      ];

      setAISelectedImage(elements, croppedImage.path, { silent: true });
      state.saveSelectedUploadedImagePaths = [croppedImage.path];
      updateSaveSelectionSummary(elements);
      renderUploadedImages(elements);
      setInlineStatus(elements.bgStatus, "Cropped final image uploaded and selected.", "is-success");
      closeImageEditor(elements);
    } catch (error) {
      console.error("Image crop save failed:", error);
      setInlineStatus(
        elements.imageEditorStatus,
        error?.message || "Could not save the cropped image.",
        "is-error"
      );
    } finally {
      setButtonBusy(elements.imageEditorSave, "Saving...", "Use This Crop", false);
    }
  }

  async function handleLocalImageUpload(elements, event) {
    const file = event?.target?.files?.[0] || null;
    if (!file) return;

    if (elements.localImageUploadInput) {
      elements.localImageUploadInput.disabled = true;
    }

    setInlineStatus(elements.imageStatus, "Uploading selected document image into assisted images...", "is-waiting");

    try {
      const uploadPayload = await createLocalImageUploadPayload(file);
      const { data, error } = await window.supabase.functions.invoke(IMAGE_PROCESS_FUNCTION_NAME, {
        body: {
          bucket: INVENTORY_UPLOAD_BUCKET,
          imagePath: uploadPayload.fileName,
          background: "uploaded",
          processedImageBase64: uploadPayload.processedImageBase64,
          processedMimeType: uploadPayload.processedMimeType,
        },
      });

      if (error) {
        throw new Error(await getFunctionErrorDetail(error) || "Could not upload selected image.");
      }

      if (!data?.ok || !data?.path || !data?.bucket) {
        throw new Error(data?.detail || data?.error || "Upload returned no image.");
      }

      const uploadedImage = normalizeImageRow(
        {
          path: data.path,
          name: data.name || `uploaded - ${file.name}`,
          createdAt: data.createdAt || new Date().toISOString(),
          updatedAt: data.createdAt || new Date().toISOString(),
          previewUrl: data.previewUrl || "",
          storageBucket: data.bucket,
          sourceType: "document-upload",
          sortOrder: -4,
          mimeType: data.mimeType || uploadPayload.processedMimeType || "image/jpeg",
        },
        0
      );

      state.recentUploadedImages = [
        uploadedImage,
        ...state.recentUploadedImages.filter((image) => image.path !== uploadedImage.path),
      ];

      setAISelectedImage(elements, uploadedImage.path, {
        autoSelectForSave: true,
        silent: true,
      });
      updateSaveSelectionSummary(elements);
      renderUploadedImages(elements);
      autoProcessBlackBackgroundImages(elements, [uploadedImage]);
      setInlineStatus(
        elements.imageStatus,
        "Document image uploaded. A black-background version is being prepared automatically.",
        "is-success"
      );
    } catch (error) {
      console.error("Document image upload failed:", error);
      setInlineStatus(
        elements.imageStatus,
        error?.message || "Could not upload the selected image.",
        "is-error"
      );
    } finally {
      if (elements.localImageUploadInput) {
        elements.localImageUploadInput.disabled = false;
        elements.localImageUploadInput.value = "";
      }
    }
  }

  async function handleReadWeight(elements) {
    if (state.isReadingWeight) return;

    state.isReadingWeight = true;
    setButtonBusy(elements.readWeightButton, "Reading Weight...", "Read Weight", true);
    elements.scaleState.textContent = "Waiting for the scale integration point to return a stable reading...";
    elements.captureState.textContent = "Waiting for stable weight";

    try {
      const stableWeight = await simulateStableScaleReading();

      setAssistedWeight(elements, stableWeight, {
        message: `Stable weight locked at ${formatWeight(stableWeight)}.`,
        refreshMessage: "Stable weight updated. Generate again to use the latest assisted measurement.",
      });

      const captureResult = await triggerIPhoneCapture({
        material: asTrimmedString(elements.materialSelect?.value),
        purity: asTrimmedString(elements.puritySelect?.value),
        weight: stableWeight,
      }, elements);

      if (captureResult?.images?.length) {
        setInlineStatus(
          elements.imageStatus,
          `Capture completed. Loaded ${captureResult.images.length} photo${captureResult.images.length === 1 ? "" : "s"}.`,
          "is-success"
        );
      }

    } catch (error) {
      console.error("Scale or capture flow failed:", error);
      elements.scaleState.textContent = "Unable to get a stable weight reading right now.";
      elements.captureState.textContent = error?.message || "Capture not triggered";
    } finally {
      state.activeCaptureJobId = "";
      state.isReadingWeight = false;
      setButtonBusy(elements.readWeightButton, "Reading Weight...", "Read Weight", false);
    }
  }

  async function handleUseManualWeight(elements) {
    if (state.isReadingWeight) return;

    const manualWeight = parseWeightInput(elements.manualWeightInput?.value);
    if (!Number.isFinite(manualWeight)) {
      elements.scaleState.textContent = "Enter a manual weight greater than 0 grams.";
      return;
    }

    state.isReadingWeight = true;
    setButtonBusy(elements.useManualWeightButton, "Sending...", "Use Manual Weight", true);
    elements.captureState.textContent = "Sending manual weight to capture app";

    try {
      setAssistedWeight(elements, manualWeight, {
        message: `Manual weight locked at ${formatWeight(manualWeight)}.`,
        refreshMessage: "Manual weight updated. Generate again to use the latest assisted measurement.",
      });

      const captureResult = await triggerIPhoneCapture({
        material: asTrimmedString(elements.materialSelect?.value),
        purity: asTrimmedString(elements.puritySelect?.value),
        weight: manualWeight,
        weightSource: "manual",
      }, elements);

      if (captureResult?.images?.length) {
        setInlineStatus(
          elements.imageStatus,
          `Capture completed. Loaded ${captureResult.images.length} photo${captureResult.images.length === 1 ? "" : "s"}.`,
          "is-success"
        );
      }
    } catch (error) {
      console.error("Manual weight capture flow failed:", error);
      elements.scaleState.textContent = "Manual weight was saved, but the capture app was not triggered.";
      elements.captureState.textContent = error?.message || "Capture not triggered";
    } finally {
      state.activeCaptureJobId = "";
      state.isReadingWeight = false;
      setButtonBusy(elements.useManualWeightButton, "Sending...", "Use Manual Weight", false);
    }
  }

  async function handleGenerateCopy(elements) {
    if (state.isGeneratingCopy) return;

    const payload = collectAssistedWorkflowGenerationInputs(elements);
    if (payload.stoneType) {
      saveStoneTypePreference(payload.stoneType);
      addStoneTypeOption(elements, payload.stoneType);
    }
    if (payload.length) {
      saveLengthPreference(payload.length);
      addLengthOption(elements, payload.length);
    }

    if (!payload.imagePath) {
      setInlineStatus(elements.generateStatus, "Select an AI image before generating copy.", "is-error");
      return;
    }

    if (!payload.material || !payload.purity) {
      setInlineStatus(
        elements.generateStatus,
        "Choose both material and purity before generating copy.",
        "is-error"
      );
      return;
    }

    if (!Number.isFinite(payload.weight)) {
      setInlineStatus(
        elements.generateStatus,
        "Read or enter a weight before generating copy.",
        "is-error"
      );
      return;
    }

    state.isGeneratingCopy = true;
    setButtonBusy(elements.generateCopyButton, "Generating...", "Generate Title & Description", true);
    setInlineStatus(
      elements.generateStatus,
      "Generating inventory copy from the selected AI image, stable weight, and assisted fields...",
      "is-waiting"
    );

    try {
      const response = await requestAIGenerationForSelectedImage(payload);
      const generatedTitle = asTrimmedString(response?.generatedTitle);
      const generatedDescription = asTrimmedString(response?.generatedDescription);

      if (!generatedTitle || !generatedDescription) {
        throw new Error("The secure backend did not return both title and description.");
      }

      elements.generatedTitleInput.value = generatedTitle;
      elements.generatedDescriptionInput.value = generatedDescription;

      if (response?.mode === "openai") {
        setInlineStatus(
          elements.generateStatus,
          "AI-generated copy is ready from the selected AI image. Review and edit it before using it in the Add Item form.",
          "is-success"
        );
      } else {
        setInlineStatus(
          elements.generateStatus,
          "Generated copy is ready from secure backend placeholder mode. Review and edit it before using it in the Add Item form.",
          "is-waiting"
        );
      }
    } catch (error) {
      console.error("AI generation request failed:", error);
      setInlineStatus(
        elements.generateStatus,
        `Could not generate title and description: ${error.message || error}`,
        "is-error"
      );
    } finally {
      state.isGeneratingCopy = false;
      setButtonBusy(elements.generateCopyButton, "Generating...", "Generate Title & Description", false);
    }
  }

  function handleApplyGeneratedCopy(elements) {
    const generatedTitle = asTrimmedString(elements.generatedTitleInput?.value);
    const generatedDescription = asTrimmedString(elements.generatedDescriptionInput?.value);

    if (!generatedTitle && !generatedDescription) {
      setInlineStatus(
        elements.generateStatus,
        "Generate or enter assisted copy before using it in the Add Item form.",
        "is-error"
      );
      return;
    }

    if (generatedTitle) {
      elements.mainTitleInput.value = generatedTitle;
      elements.mainTitleInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (generatedDescription) {
      elements.mainDescriptionInput.value = generatedDescription;
      elements.mainDescriptionInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    window.showToast?.("AI copy applied to the Add Item form.");
    setInlineStatus(
      elements.generateStatus,
      "Generated copy was copied into the existing Add Item form. You can still edit it before saving.",
      "is-success"
    );
  }

  function resetAssistedWorkflow(elements) {
    state.stableWeight = null;
    state.isReadingWeight = false;
    state.isGeneratingCopy = false;
    state.saveSelectedUploadedImagePaths = [];

    applyDefaultSilver925Selection(elements);
    applyLastStoneTypePreference(elements);
    applyLastLengthPreference(elements);
    if (elements.notesInput) elements.notesInput.value = "";
    if (elements.generatedTitleInput) elements.generatedTitleInput.value = "";
    if (elements.generatedDescriptionInput) elements.generatedDescriptionInput.value = "";
    if (elements.manualWeightInput) elements.manualWeightInput.value = "";
    if (elements.weightDisplay) elements.weightDisplay.textContent = "--";
    if (elements.scaleState) elements.scaleState.textContent = "Ready to read from the scale integration point.";
    if (elements.captureState) elements.captureState.textContent = "Idle";

    const latestImage = getLatestUploadedImage(state.recentUploadedImages);
    setAISelectedImage(elements, latestImage?.path || "", { silent: true });
    updateSaveSelectionSummary(elements);
    renderUploadedImages(elements);
    setInlineStatus(
      elements.imageStatus,
      state.recentUploadedImages.length
        ? "Assisted workflow reset. Choose an AI image and any save images you want for the next item."
        : "Refresh uploads to load recent phone images for the next item.",
      state.recentUploadedImages.length ? "is-success" : "is-waiting"
    );
    setInlineStatus(
      elements.generateStatus,
      "Ready when you have an AI image selected and a weight.",
      null
    );
  }

  function setActiveWorkflow(elements, workflowName) {
    state.activeWorkflow = workflowName;

    const isManual = workflowName === "manual";
    const isAssisted = workflowName === "assisted";

    elements.manualTab.classList.toggle("is-active", isManual);
    elements.manualTab.setAttribute("aria-selected", isManual ? "true" : "false");
    elements.assistedTab.classList.toggle("is-active", isAssisted);
    elements.assistedTab.setAttribute("aria-selected", isAssisted ? "true" : "false");
    elements.manualPanel.hidden = !isManual;
    elements.assistedPanel.hidden = !isAssisted;

    if (isAssisted && !state.captureStations.length) {
      loadActiveCaptureStations(elements).catch((error) => {
        console.error("Failed to load capture stations:", error);
        setInlineStatus(
          elements.imageStatus,
          `Could not load active capture stations: ${error.message || error}`,
          "is-error"
        );
      });
    }

    if (isAssisted) {
      preloadBackgroundRemoval(elements);
    }
  }

  function setupWorkflowTabs(elements) {
    elements.manualTab?.addEventListener("click", () => {
      setActiveWorkflow(elements, "manual");
    });

    elements.assistedTab?.addEventListener("click", () => {
      setActiveWorkflow(elements, "assisted");
    });
  }

  function setupImageStripListeners(elements) {
    elements.uploadedImageStrip?.addEventListener("click", (event) => {
      const aiButton = event.target.closest("[data-assisted-ai-select]");
      if (aiButton) {
        setAISelectedImage(elements, aiButton.getAttribute("data-assisted-ai-select"), {
          silent: false,
        });
        return;
      }

      const saveButton = event.target.closest("[data-assisted-save-toggle]");
      if (saveButton) {
        toggleSaveSelectedImage(elements, saveButton.getAttribute("data-assisted-save-toggle"));
      }
    });
  }

  function setupFieldListeners(elements) {
    elements.materialSelect?.addEventListener("change", () => {
      updatePurityOptions(elements, elements.materialSelect.value);
      syncSilver925Pricing(elements);
      markGeneratedCopyNeedsRefresh(
        elements,
        "Material changed. Generate again to refresh the AI copy."
      );
    });

    elements.puritySelect?.addEventListener("change", () => {
      syncSilver925Pricing(elements);
      markGeneratedCopyNeedsRefresh(
        elements,
        "Purity changed. Generate again to refresh the AI copy."
      );
    });

    const persistCurrentStoneType = () => {
      const stoneType = asTrimmedString(elements.stoneTypeInput?.value);
      if (!stoneType) return;
      saveStoneTypePreference(stoneType);
      addStoneTypeOption(elements, stoneType);
    };

    elements.stoneTypeInput?.addEventListener("input", () => {
      markGeneratedCopyNeedsRefresh(
        elements,
        "Stone type changed. Generate again to refresh the AI copy."
      );
    });
    elements.stoneTypeInput?.addEventListener("change", persistCurrentStoneType);
    elements.stoneTypeInput?.addEventListener("blur", persistCurrentStoneType);

    const persistCurrentLength = () => {
      const length = asTrimmedString(elements.lengthInput?.value);
      if (!length) return;
      saveLengthPreference(length);
      addLengthOption(elements, length);
    };

    elements.lengthInput?.addEventListener("input", () => {
      markGeneratedCopyNeedsRefresh(
        elements,
        "Length changed. Generate again to refresh the AI copy."
      );
    });
    elements.lengthInput?.addEventListener("change", persistCurrentLength);
    elements.lengthInput?.addEventListener("blur", persistCurrentLength);

    elements.notesInput?.addEventListener("input", () => {
      markGeneratedCopyNeedsRefresh(
        elements,
        "Assisted notes changed. Generate again to refresh the AI copy."
      );
    });

    elements.manualWeightInput?.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      elements.useManualWeightButton?.click();
    });

    elements.useManualWeightButton?.addEventListener("click", () => handleUseManualWeight(elements));

    elements.captureStationSelect?.addEventListener("change", () => {
      const station = setSelectedCaptureStation(elements, elements.captureStationSelect.value);
      elements.captureState.textContent = station
        ? `Ready to route capture jobs to ${station.name || station.id}.`
        : "Choose a capture station before requesting a photo.";
    });

    elements.mainWeightInput?.addEventListener("input", () => {
      if (!state.isReadingWeight) {
        const currentWeight = parseWeightInput(elements.mainWeightInput.value);
        state.stableWeight = Number.isFinite(currentWeight) ? currentWeight : null;
        elements.weightDisplay.textContent = formatWeight(state.stableWeight);
        if (elements.manualWeightInput && Number.isFinite(currentWeight)) {
          elements.manualWeightInput.value = currentWeight.toFixed(2);
        }
      }
    });
  }

  function exposeModule(elements) {
    window.addItemAssistedModule = {
      getSelectedUploadedImagesForSave,
      getSelectedUploadedImagePathsForSave,
      getAISelectedUploadedImagePath: () => state.aiSelectedUploadedImagePath,
      refreshUploadedImages: () => reloadCompletedCapturePhotos(elements, {
        refreshNotice: true,
        autoProcess: false,
        recentOnly: true,
      }),
      loadActiveCaptureStations: () => loadActiveCaptureStations(elements, { silent: false }),
    };
  }

  async function init() {
    if (state.initialized) return;

    const elements = getElements();
    if (!elements.manualTab || !elements.assistedTab || !elements.assistedPanel) {
      return;
    }

    await waitForSupabaseInit();

    state.initialized = true;
    populateMaterialOptions(elements);
    applyDefaultSilver925Selection(elements);
    await loadStoneTypeOptions(elements);
    applyLastStoneTypePreference(elements);
    applyLastLengthPreference(elements);
    updateSelectedImagePreview(elements);
    updateSaveSelectionSummary(elements);
    renderUploadedImages(elements);
    setupWorkflowTabs(elements);
    setupImageStripListeners(elements);
    setupFieldListeners(elements);
    updateAutoAlignButton(elements);
    await loadActiveCaptureStations(elements, { silent: true });

    elements.readWeightButton?.addEventListener("click", () => handleReadWeight(elements));
    elements.refreshStationsButton?.addEventListener("click", () => {
      loadActiveCaptureStations(elements, { silent: false }).catch((error) => {
        console.error("Failed to refresh capture stations:", error);
        elements.captureState.textContent = error?.message || "Unable to refresh capture stations.";
      });
    });
    elements.refreshImagesButton?.addEventListener("click", () => {
      reloadCompletedCapturePhotos(elements, {
        refreshNotice: true,
        autoProcess: false,
        recentOnly: true,
      });
    });
    elements.localImageUploadInput?.addEventListener("change", (event) => {
      handleLocalImageUpload(elements, event);
    });
    elements.bgAutoAlignButton?.addEventListener("click", () => toggleAutoAlign(elements));
    elements.bgBlackButton?.addEventListener("click", () => processSelectedImageBackground(elements, "black"));
    elements.bgWhiteButton?.addEventListener("click", () => processSelectedImageBackground(elements, "white"));
    elements.openImageEditorButton?.addEventListener("click", () => openImageEditor(elements));
    elements.imageEditorClose?.addEventListener("click", () => closeImageEditor(elements));
    elements.imageEditorModal?.addEventListener("click", (event) => {
      if (event.target === elements.imageEditorModal) {
        closeImageEditor(elements);
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && !elements.imageEditorModal?.classList.contains("hidden")) {
        closeImageEditor(elements);
      }
    });
    elements.imageEditorZoom?.addEventListener("input", () => {
      setEditorZoom(elements, elements.imageEditorZoom.value);
    });
    elements.imageEditorZoomIn?.addEventListener("click", () => {
      setEditorZoom(elements, state.imageEditor.zoom + 0.12);
    });
    elements.imageEditorZoomOut?.addEventListener("click", () => {
      setEditorZoom(elements, state.imageEditor.zoom - 0.12);
    });
    elements.imageEditorRotation?.addEventListener("input", () => {
      setEditorRotation(elements, elements.imageEditorRotation.value);
    });
    elements.imageEditorRotateLeft?.addEventListener("click", () => {
      setEditorRotation(elements, state.imageEditor.rotation - 2.5);
    });
    elements.imageEditorRotateRight?.addEventListener("click", () => {
      setEditorRotation(elements, state.imageEditor.rotation + 2.5);
    });
    elements.imageEditorFlipHorizontal?.addEventListener("click", () => {
      toggleEditorFlip(elements, "x");
    });
    elements.imageEditorFlipVertical?.addEventListener("click", () => {
      toggleEditorFlip(elements, "y");
    });
    elements.imageEditorReset?.addEventListener("click", () => resetEditorFraming(elements));
    elements.imageEditorSave?.addEventListener("click", () => saveImageEditorCrop(elements));
    elements.imageEditorCanvas?.addEventListener("pointerdown", (event) => handleEditorPointerDown(event, elements));
    elements.imageEditorCanvas?.addEventListener("pointermove", (event) => handleEditorPointerMove(event, elements));
    elements.imageEditorCanvas?.addEventListener("pointerup", (event) => handleEditorPointerUp(event, elements));
    elements.imageEditorCanvas?.addEventListener("pointercancel", (event) => handleEditorPointerUp(event, elements));
    elements.generateCopyButton?.addEventListener("click", () => handleGenerateCopy(elements));
    elements.applyCopyButton?.addEventListener("click", () => handleApplyGeneratedCopy(elements));

    document.addEventListener("add-item-form:reset", () => {
      resetAssistedWorkflow(elements);
    });

    window.addEventListener("beforeunload", () => {
      releaseImagePreviewUrls();
    });

    exposeModule(elements);
    resetAssistedWorkflow(elements);
    setActiveWorkflow(elements, "assisted");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
