(() => {
  const INVENTORY_UPLOAD_BUCKET = "InventoryUpload";
  const INVENTORY_UPLOAD_LIST_FUNCTION_NAME = "list-inventory-upload-images";
  const AI_COPY_FUNCTION_NAME = "generate-inventory-copy";
  const CAPTURE_JOB_TABLE = "capture_jobs";
  const CAPTURE_STATION_TABLE = "capture_stations";
  const CAPTURE_POLL_INTERVAL_MS = 1500;
  const CAPTURE_POLL_TIMEOUT_MS = 120000;
  const MATERIAL_PURITY_OPTIONS = {
    Gold: ["10K", "14K", "18K", "22K", "24K"],
    Silver: ["925", "950", "Fine Silver"],
    Platinum: ["850", "900", "950", "999"],
    "Stainless Steel": ["316L", "304"],
  };

  const state = {
    initialized: false,
    activeWorkflow: "manual",
    recentUploadedImages: [],
    aiSelectedUploadedImage: null,
    aiSelectedUploadedImagePath: "",
    aiSelectedUploadedImageUrl: "",
    saveSelectedUploadedImagePaths: [],
    stableWeight: null,
    isReadingWeight: false,
    isGeneratingCopy: false,
    hasLoadedImagesOnce: false,
    activeCaptureJobId: "",
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
      notesInput: document.getElementById("assisted-notes"),
      readWeightButton: document.getElementById("assisted-read-weight"),
      scaleState: document.getElementById("assisted-scale-state"),
      weightDisplay: document.getElementById("assisted-weight-display"),
      captureState: document.getElementById("assisted-capture-state"),
      refreshImagesButton: document.getElementById("assisted-refresh-images"),
      imageStatus: document.getElementById("assisted-image-status"),
      selectedImagePreview: document.getElementById("assisted-selected-image-preview"),
      selectedImageEmpty: document.getElementById("assisted-selected-image-empty"),
      selectedImageName: document.getElementById("assisted-selected-image-name"),
      selectedImagePath: document.getElementById("assisted-selected-image-path"),
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

  function normalizeImageRow(image, fallbackIndex) {
    const path = asTrimmedString(image?.path);
    const name = asTrimmedString(image?.name) || `Upload ${fallbackIndex + 1}`;
    const updatedAt = asTrimmedString(image?.updatedAt);
    const createdAt = asTrimmedString(image?.createdAt);

    return {
      path,
      name,
      createdAt,
      updatedAt: updatedAt || createdAt,
      previewUrl: asTrimmedString(image?.previewUrl),
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

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
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

  async function resolveCaptureStation() {
    const { data, error } = await window.supabase
      .from(CAPTURE_STATION_TABLE)
      .select("id, name, active")
      .eq("active", true)
      .order("name", { ascending: true });

    if (error) {
      throw new Error(error.message || "Failed to resolve capture station.");
    }

    const activeStations = Array.isArray(data) ? data : [];
    if (!activeStations.length) {
      throw new Error("No active capture stations are available.");
    }

    const { stationId, stationName } = getPreferredCaptureStationHints();

    let selectedStation = null;
    if (stationId) {
      selectedStation = activeStations.find((station) => station.id === stationId) || null;
    }

    if (!selectedStation && stationName) {
      selectedStation = activeStations.find((station) => {
        return asTrimmedString(station.name).toLowerCase() === stationName.toLowerCase();
      }) || null;
    }

    if (!selectedStation) {
      selectedStation = activeStations[0];
      if (activeStations.length > 1) {
        console.warn("Multiple active capture stations found. Defaulting to the first active station.", activeStations);
      }
    }

    try {
      window.localStorage?.setItem("og.captureStationId", selectedStation.id);
      window.localStorage?.setItem("og.captureStationName", selectedStation.name || "");
    } catch (_) {}

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

  async function pollCaptureJob(jobId, stationName = "") {
    const startedAt = Date.now();

    while ((Date.now() - startedAt) < CAPTURE_POLL_TIMEOUT_MS) {
      const { data, error } = await window.supabase
        .from(CAPTURE_JOB_TABLE)
        .select(`
          id,
          status,
          storage_bucket,
          storage_path,
          capture_completed_at,
          upload_completed_at,
          mime_type,
          file_size_bytes,
          failure_code,
          failure_message
        `)
        .eq("id", jobId)
        .single();

      if (error || !data) {
        throw new Error(error?.message || "Failed to poll capture job.");
      }

      if (data.status === "completed" || data.status === "failed") {
        return data;
      }

      const captureState = document.getElementById("assisted-capture-state");
      if (captureState) {
        captureState.textContent = getCaptureStatusLabel(data.status, stationName);
      }

      await delay(CAPTURE_POLL_INTERVAL_MS);
    }

    throw new Error("Timed out waiting for capture completion.");
  }

  async function triggerIPhoneCapture(payload, elements) {
    console.log("triggerIPhoneCapture request", payload);

    const station = await resolveCaptureStation();
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

    const completedJob = await pollCaptureJob(createdJob.id, station.name || "");
    state.activeCaptureJobId = "";

    if (completedJob.status === "failed") {
      throw new Error(completedJob.failure_message || completedJob.failure_code || "Capture failed.");
    }

    elements.captureState.textContent = completedJob.storage_bucket
      ? `Photo captured and uploaded to ${completedJob.storage_bucket}.`
      : "Photo captured and uploaded.";

    if (state.hasLoadedImagesOnce) {
      await loadRecentInventoryUploadImages(elements, { refreshNotice: true });
    }

    return {
      station,
      job: completedJob,
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

  function getSelectedUploadedImagePathsForSave() {
    return [...state.saveSelectedUploadedImagePaths];
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
      elements.saveSelectionSummary.textContent = "No uploaded phone images are selected for final item save yet.";
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
              <img src="${escapeHtml(image.previewUrl)}" alt="${escapeHtml(image.name)}" loading="lazy" />
            </span>
            <span class="assisted-thumb-meta">
              <span class="assisted-thumb-name">${escapeHtml(image.name)}</span>
              <span class="assisted-thumb-subtext">${escapeHtml(formatTimestamp(image.updatedAt || image.createdAt))}</span>
              ${aiBadge}
            </span>
          </button>
          <button
            type="button"
            class="assisted-thumb-save-toggle${isSaveSelected ? " is-active" : ""}"
            data-assisted-save-toggle="${escapeHtml(image.path)}"
            aria-pressed="${isSaveSelected ? "true" : "false"}"
            aria-label="${isSaveSelected ? "Remove" : "Add"} ${escapeHtml(image.name)} ${isSaveSelected ? "from" : "to"} images saved with this item"
          >
            ${isSaveSelected ? "Saving" : "Save"}
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

    const previousAIPath = state.aiSelectedUploadedImagePath;
    const previousSaveSelections = new Set(state.saveSelectedUploadedImagePaths);

    state.hasLoadedImagesOnce = true;
    setButtonBusy(elements.refreshImagesButton, "Refreshing...", "Refresh Uploads", true);
    setInlineStatus(elements.imageStatus, "Loading recent uploaded phone images from InventoryUpload...", "is-waiting");

    try {
      const { data, error } = await window.supabase.functions.invoke(
        INVENTORY_UPLOAD_LIST_FUNCTION_NAME,
        {
          body: {
            bucket: INVENTORY_UPLOAD_BUCKET,
            limit: 12,
          },
        }
      );

      console.log("InventoryUpload backend image list response", data);

      if (error) {
        throw new Error(error.message || "Unable to load uploaded images.");
      }

      const normalizedImages = (Array.isArray(data?.images) ? data.images : [])
        .map(normalizeImageRow)
        .filter((image) => image.path && image.previewUrl)
        .sort(compareNewestFirst);

      state.recentUploadedImages = normalizedImages;
      state.saveSelectedUploadedImagePaths = normalizedImages
        .map((image) => image.path)
        .filter((path) => previousSaveSelections.has(path));

      const nextAIPath = normalizedImages.some((image) => image.path === previousAIPath)
        ? previousAIPath
        : getLatestUploadedImage(normalizedImages)?.path || "";

      setAISelectedImage(elements, nextAIPath, { silent: true });
      updateSaveSelectionSummary(elements);
      renderUploadedImages(elements);

      if (!normalizedImages.length) {
        setInlineStatus(
          elements.imageStatus,
          "No uploaded phone images were returned from the backend. Refresh after the iPhone upload finishes.",
          "is-error"
        );
        return;
      }

      if (options.refreshNotice) {
        setInlineStatus(
          elements.imageStatus,
          `Loaded ${normalizedImages.length} recent uploaded phone image(s) from InventoryUpload.`,
          "is-success"
        );
      } else {
        setInlineStatus(
          elements.imageStatus,
          `Latest uploaded phone image is ready for AI selection. ${state.saveSelectedUploadedImagePaths.length} image(s) are marked to save with this item.`,
          "is-success"
        );
      }
    } catch (error) {
      console.error("Failed to load InventoryUpload images:", error);
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
        `Could not load uploaded phone images from the backend: ${error.message || error}`,
        "is-error"
      );
    } finally {
      setButtonBusy(elements.refreshImagesButton, "Refreshing...", "Refresh Uploads", false);
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
    return {
      bucket: INVENTORY_UPLOAD_BUCKET,
      imagePath: state.aiSelectedUploadedImagePath,
      material: asTrimmedString(elements.materialSelect?.value),
      purity: asTrimmedString(elements.puritySelect?.value),
      weight: resolveCurrentWeight(elements),
      stoneType: asTrimmedString(elements.stoneTypeInput?.value),
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
      throw new Error(error.message || "AI generation failed.");
    }

    return data;
  }

  async function handleReadWeight(elements) {
    if (state.isReadingWeight) return;

    state.isReadingWeight = true;
    setButtonBusy(elements.readWeightButton, "Reading Weight...", "Read Weight", true);
    elements.scaleState.textContent = "Waiting for the scale placeholder to return a stable reading...";
    elements.captureState.textContent = "Waiting for stable weight";

    try {
      const stableWeight = await simulateStableScaleReading();

      state.stableWeight = stableWeight;
      elements.weightDisplay.textContent = formatWeight(stableWeight);
      elements.scaleState.textContent = `Stable weight locked at ${formatWeight(stableWeight)}.`;
      syncWeightIntoMainForm(elements, stableWeight);

      const captureResult = await triggerIPhoneCapture({
        material: asTrimmedString(elements.materialSelect?.value),
        purity: asTrimmedString(elements.puritySelect?.value),
        weight: stableWeight,
      }, elements);

      if (captureResult?.job?.storage_path) {
        setInlineStatus(
          elements.imageStatus,
          `Capture completed. Refresh ready for ${captureResult.job.storage_path}.`,
          "is-success"
        );
      }

      markGeneratedCopyNeedsRefresh(
        elements,
        "Stable weight updated. Generate again to use the latest assisted measurement."
      );
    } catch (error) {
      console.error("Scale placeholder failed:", error);
      elements.scaleState.textContent = "Unable to get a stable weight reading right now.";
      elements.captureState.textContent = error?.message || "Capture not triggered";
    } finally {
      state.activeCaptureJobId = "";
      state.isReadingWeight = false;
      setButtonBusy(elements.readWeightButton, "Reading Weight...", "Read Weight", false);
    }
  }

  async function handleGenerateCopy(elements) {
    if (state.isGeneratingCopy) return;

    const payload = collectAssistedWorkflowGenerationInputs(elements);

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
        "Read a stable weight before generating copy.",
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

    if (elements.materialSelect) elements.materialSelect.value = "";
    if (elements.puritySelect) updatePurityOptions(elements, "");
    if (elements.stoneTypeInput) elements.stoneTypeInput.value = "";
    if (elements.notesInput) elements.notesInput.value = "";
    if (elements.generatedTitleInput) elements.generatedTitleInput.value = "";
    if (elements.generatedDescriptionInput) elements.generatedDescriptionInput.value = "";
    if (elements.weightDisplay) elements.weightDisplay.textContent = "--";
    if (elements.scaleState) elements.scaleState.textContent = "Ready to read from the scale placeholder.";
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
      "Ready when you have an AI image selected and a stable weight.",
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

    if (isAssisted && !state.hasLoadedImagesOnce) {
      loadRecentInventoryUploadImages(elements);
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
        setAISelectedImage(elements, aiButton.getAttribute("data-assisted-ai-select"));
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
      markGeneratedCopyNeedsRefresh(
        elements,
        "Material changed. Generate again to refresh the AI copy."
      );
    });

    elements.puritySelect?.addEventListener("change", () => {
      markGeneratedCopyNeedsRefresh(
        elements,
        "Purity changed. Generate again to refresh the AI copy."
      );
    });

    elements.stoneTypeInput?.addEventListener("input", () => {
      markGeneratedCopyNeedsRefresh(
        elements,
        "Stone type changed. Generate again to refresh the AI copy."
      );
    });

    elements.notesInput?.addEventListener("input", () => {
      markGeneratedCopyNeedsRefresh(
        elements,
        "Assisted notes changed. Generate again to refresh the AI copy."
      );
    });

    elements.mainWeightInput?.addEventListener("input", () => {
      if (!state.isReadingWeight) {
        const currentWeight = Number(elements.mainWeightInput.value);
        state.stableWeight = Number.isFinite(currentWeight) ? currentWeight : null;
        elements.weightDisplay.textContent = formatWeight(state.stableWeight);
      }
    });
  }

  function exposeModule(elements) {
    window.addItemAssistedModule = {
      getSelectedUploadedImagePathsForSave,
      getAISelectedUploadedImagePath: () => state.aiSelectedUploadedImagePath,
      refreshUploadedImages: () => loadRecentInventoryUploadImages(elements, { refreshNotice: true }),
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
    updateSelectedImagePreview(elements);
    updateSaveSelectionSummary(elements);
    renderUploadedImages(elements);
    setupWorkflowTabs(elements);
    setupImageStripListeners(elements);
    setupFieldListeners(elements);

    elements.readWeightButton?.addEventListener("click", () => handleReadWeight(elements));
    elements.refreshImagesButton?.addEventListener("click", () => {
      loadRecentInventoryUploadImages(elements, { refreshNotice: true });
    });
    elements.generateCopyButton?.addEventListener("click", () => handleGenerateCopy(elements));
    elements.applyCopyButton?.addEventListener("click", () => handleApplyGeneratedCopy(elements));

    document.addEventListener("add-item-form:reset", () => {
      resetAssistedWorkflow(elements);
    });

    exposeModule(elements);
    resetAssistedWorkflow(elements);
    setActiveWorkflow(elements, "manual");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
