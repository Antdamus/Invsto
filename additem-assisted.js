(function () {
  const INVENTORY_UPLOAD_BUCKET = "InventoryUpload";
  const AI_COPY_FUNCTION_NAME = "generate-inventory-copy";
  const INVENTORY_UPLOAD_LIST_FUNCTION_NAME = "list-inventory-upload-images";

  const MATERIAL_PURITY_MAP = Object.freeze({
    Gold: ["10K", "14K", "18K", "22K", "24K"],
    Silver: ["925", "950", "Fine Silver"],
    Platinum: ["850", "900", "950", "999"],
    "Stainless Steel": ["316L", "304"],
  });

  const state = {
    activeWorkflow: "manual",
    isReadingWeight: false,
    isLoadingImages: false,
    isGeneratingCopy: false,
    hasLoadedImages: false,
    lastStableWeight: null,
    recentUploadedImages: [],
    selectedUploadedImage: null,
    selectedUploadedImagePath: "",
    selectedUploadedImageUrl: "",
    lastGeneratedCopy: null,
  };

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
      imageStrip: document.getElementById("assisted-uploaded-image-strip"),
      generateCopyButton: document.getElementById("assisted-generate-copy"),
      generateStatus: document.getElementById("assisted-generate-status"),
      generatedTitleInput: document.getElementById("assisted-generated-title"),
      generatedDescriptionInput: document.getElementById("assisted-generated-description"),
      applyCopyButton: document.getElementById("assisted-apply-copy"),
      weightInput: document.getElementById("weight"),
      titleInput: document.getElementById("title"),
      descriptionInput: document.getElementById("description"),
      categoryInput: document.getElementById("category"),
      qrTypeSelect: document.getElementById("qr-type"),
    };
  }

  async function waitForSupabaseInit() {
    if (window.supabase) return;

    await new Promise((resolve) => {
      document.addEventListener("supabase-ready", resolve, { once: true });
    });
  }

  async function initAssistedWorkflow() {
    await waitForSupabaseInit();

    const elements = getElements();
    if (!elements.manualTab || !elements.assistedTab || !elements.materialSelect) {
      return;
    }

    populateMaterialOptions(elements.materialSelect);
    updatePurityOptions(elements.materialSelect.value, elements.puritySelect);
    bindWorkflowTabs(elements);
    bindAssistedInputs(elements);
    resetGeneratedCopyFields(elements);
    updateGenerateActionAvailability(elements);

    document.addEventListener("add-item-form:reset", () => {
      resetAssistedWorkflow(elements);
    });
  }

  function populateMaterialOptions(materialSelect) {
    const options = Object.keys(MATERIAL_PURITY_MAP)
      .map((material) => `<option value="${material}">${material}</option>`)
      .join("");

    materialSelect.innerHTML = `<option value="">Select material</option>${options}`;
  }

  function updatePurityOptions(material, puritySelect) {
    const purityOptions = MATERIAL_PURITY_MAP[material] || [];
    puritySelect.innerHTML = [
      `<option value="">Select purity</option>`,
      ...purityOptions.map((purity) => `<option value="${purity}">${purity}</option>`),
    ].join("");
    puritySelect.disabled = purityOptions.length === 0;
  }

  function bindWorkflowTabs(elements) {
    [elements.manualTab, elements.assistedTab].forEach((tabButton) => {
      tabButton.addEventListener("click", async () => {
        const target = tabButton.dataset.workflowTarget;
        await setActiveWorkflow(target, elements);
      });
    });
  }

  async function setActiveWorkflow(target, elements) {
    const isManual = target === "manual";
    state.activeWorkflow = isManual ? "manual" : "assisted";

    elements.manualTab.classList.toggle("is-active", isManual);
    elements.assistedTab.classList.toggle("is-active", !isManual);
    elements.manualTab.setAttribute("aria-selected", String(isManual));
    elements.assistedTab.setAttribute("aria-selected", String(!isManual));
    elements.manualPanel.hidden = !isManual;
    elements.assistedPanel.hidden = isManual;

    if (!isManual) {
      await loadRecentInventoryUploadImages(elements);
    }
  }

  function bindAssistedInputs(elements) {
    elements.materialSelect.addEventListener("change", () => {
      updatePurityOptions(elements.materialSelect.value, elements.puritySelect);
      elements.puritySelect.value = "";
      resetWeightState(elements, {
        scaleMessage: "Select a purity, then request a stable weight reading.",
        captureMessage: "Idle",
      });
      invalidateGeneratedCopy(elements, "Assisted metadata changed. Generate fresh copy when ready.");
      updateGenerateActionAvailability(elements);
    });

    elements.puritySelect.addEventListener("change", () => {
      resetWeightState(elements, {
        scaleMessage: "Ready to read from the scale placeholder.",
        captureMessage: "Idle",
      });
      invalidateGeneratedCopy(elements, "Purity changed. Generate fresh copy when ready.");
      updateGenerateActionAvailability(elements);
    });

    [elements.stoneTypeInput, elements.notesInput].forEach((input) => {
      input?.addEventListener("input", () => {
        invalidateGeneratedCopy(elements, "Assisted notes changed. Generate fresh copy when ready.");
        updateGenerateActionAvailability(elements);
      });
    });

    elements.readWeightButton.addEventListener("click", async () => {
      await handleReadWeight(elements);
    });

    elements.refreshImagesButton.addEventListener("click", async () => {
      await loadRecentInventoryUploadImages(elements, { force: true });
    });

    elements.generateCopyButton.addEventListener("click", async () => {
      await handleGenerateCopy(elements);
    });

    elements.applyCopyButton.addEventListener("click", () => {
      applyGeneratedCopyToMainForm(elements);
    });

    [elements.generatedTitleInput, elements.generatedDescriptionInput].forEach((input) => {
      input?.addEventListener("input", () => {
        state.lastGeneratedCopy = {
          generatedTitle: elements.generatedTitleInput.value.trim(),
          generatedDescription: elements.generatedDescriptionInput.value.trim(),
        };
        updateGenerateActionAvailability(elements);
      });
    });
  }

  async function handleReadWeight(elements) {
    if (state.isReadingWeight) return;

    const material = elements.materialSelect.value.trim();
    const purity = elements.puritySelect.value.trim();

    if (!material || !purity) {
      setScaleState(elements.scaleState, "Choose both a material and a purity before reading weight.", "error");
      elements.captureState.textContent = "Idle";
      return;
    }

    state.isReadingWeight = true;
    elements.readWeightButton.disabled = true;
    elements.readWeightButton.textContent = "Reading Weight...";
    elements.captureState.textContent = "Waiting for stable weight";
    setScaleState(elements.scaleState, "Waiting for USB-connected scale placeholder...", "waiting");

    try {
      const stableWeight = await readStableWeightFromScale({
        material,
        purity,
        scaleStateEl: elements.scaleState,
      });

      state.lastStableWeight = stableWeight;
      elements.weightDisplay.textContent = formatWeight(stableWeight);
      syncWeightToMainForm(stableWeight, elements.weightInput);

      const payload = { material, purity, weight: stableWeight };
      setScaleState(
        elements.scaleState,
        `Stable weight captured at ${formatWeight(stableWeight)} and synced into the Add Item weight field.`,
        "success"
      );
      invalidateGeneratedCopy(elements, "Weight changed. Generate fresh copy when ready.");

      const captureResult = await triggerIPhoneCapture(payload);
      elements.captureState.textContent = captureResult.message;

      document.dispatchEvent(
        new CustomEvent("additem-assisted:weight-read", {
          detail: payload,
        })
      );
    } catch (error) {
      setScaleState(
        elements.scaleState,
        error?.message || "Unable to capture a stable scale reading.",
        "error"
      );
      elements.captureState.textContent = "Placeholder not triggered";
    } finally {
      state.isReadingWeight = false;
      elements.readWeightButton.disabled = false;
      elements.readWeightButton.textContent = "Read Weight";
      updateGenerateActionAvailability(elements);
    }
  }

  async function readStableWeightFromScale({ material, purity, scaleStateEl }) {
    const mockSampleStream = await waitForScaleConnection({ material, purity });
    setScaleState(scaleStateEl, "Scale connected. Checking for a stable reading...", "waiting");

    const stableWeight = await detectStableWeight(mockSampleStream, scaleStateEl);
    if (stableWeight === null) {
      throw new Error("Stable weight could not be determined from the placeholder scale feed.");
    }

    return stableWeight;
  }

  async function waitForScaleConnection({ material, purity }) {
    // TODO: Replace with real WebUSB/WebSerial device discovery and handshake logic.
    await delay(900);
    return buildMockScaleReadings(material, purity);
  }

  async function detectStableWeight(samples, scaleStateEl) {
    // TODO: Replace this placeholder with production-grade stable-weight detection from live device data.
    const rollingWindow = [];
    const windowSize = 3;
    const tolerance = 0.03;

    for (const sample of samples) {
      rollingWindow.push(sample);
      if (rollingWindow.length > windowSize) {
        rollingWindow.shift();
      }

      setScaleState(scaleStateEl, `Reading scale... ${sample.toFixed(2)} g`, "waiting");
      await delay(260);

      if (rollingWindow.length === windowSize && isStableWindow(rollingWindow, tolerance)) {
        return roundWeight(average(rollingWindow));
      }
    }

    if (rollingWindow.length === windowSize) {
      return roundWeight(average(rollingWindow));
    }

    return null;
  }

  async function loadRecentInventoryUploadImages(elements, { force = false } = {}) {
    if (state.isLoadingImages) return;
    if (!force && state.hasLoadedImages) {
      renderSelectedUploadedImage(elements);
      renderUploadedImageStrip(elements);
      updateGenerateActionAvailability(elements);
      return;
    }

    state.isLoadingImages = true;
    elements.refreshImagesButton.disabled = true;
    setInlineStatus(elements.imageStatus, "Loading recent uploads from InventoryUpload...", "waiting");

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

      if (error) throw error;

      const recentImages = Array.isArray(data?.images)
        ? data.images
            .map((item) => normalizeBackendImageRecord(item))
            .filter((item) => item.previewUrl)
            .slice(0, 12)
        : [];

      state.recentUploadedImages = recentImages;
      state.hasLoadedImages = true;

      const previouslySelected = state.recentUploadedImages.find(
        (item) => item.path === state.selectedUploadedImagePath
      );

      if (previouslySelected) {
        state.selectedUploadedImage = previouslySelected;
        state.selectedUploadedImagePath = previouslySelected.path;
        state.selectedUploadedImageUrl = previouslySelected.previewUrl;
      } else {
        const latestImage = getLatestUploadedImage(state.recentUploadedImages);
        if (latestImage) {
          setSelectedUploadedImage(latestImage.path, elements);
        } else {
          clearSelectedUploadedImage(elements);
        }
      }

      renderSelectedUploadedImage(elements);
      renderUploadedImageStrip(elements);

      if (state.recentUploadedImages.length > 0) {
        setInlineStatus(
          elements.imageStatus,
          `Loaded ${state.recentUploadedImages.length} recent upload${state.recentUploadedImages.length === 1 ? "" : "s"} from InventoryUpload.`,
          "success"
        );
      } else {
        setInlineStatus(
          elements.imageStatus,
          "The backend image list returned zero files from InventoryUpload. Upload a phone image, then press Refresh Uploads.",
          "error"
        );
      }
    } catch (error) {
      state.recentUploadedImages = [];
      clearSelectedUploadedImage(elements);
      renderUploadedImageStrip(elements);
      setInlineStatus(
        elements.imageStatus,
        `Unable to load recent InventoryUpload images: ${error?.message || error}`,
        "error"
      );
    } finally {
      state.isLoadingImages = false;
      elements.refreshImagesButton.disabled = false;
      updateGenerateActionAvailability(elements);
    }
  }

  function normalizeBackendImageRecord(item) {
    return {
      name: String(item?.name || ""),
      path: String(item?.path || ""),
      createdAt: item?.createdAt || item?.updatedAt || "",
      updatedAt: item?.updatedAt || item?.createdAt || "",
      previewUrl: String(item?.previewUrl || item?.signedUrl || item?.url || ""),
    };
  }

  function getLatestUploadedImage(images) {
    return [...images].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0] || null;
  }

  function setSelectedUploadedImage(imagePath, elements) {
    const previousPath = state.selectedUploadedImagePath;
    const selected = state.recentUploadedImages.find((item) => item.path === imagePath) || null;
    state.selectedUploadedImage = selected;
    state.selectedUploadedImagePath = selected?.path || "";
    state.selectedUploadedImageUrl = selected?.previewUrl || "";

    if (previousPath !== state.selectedUploadedImagePath) {
      invalidateGeneratedCopy(elements, "Selected image changed. Generate fresh copy when ready.");
    }

    renderSelectedUploadedImage(elements);
    renderUploadedImageStrip(elements);
    updateGenerateActionAvailability(elements);
  }

  function clearSelectedUploadedImage(elements) {
    state.selectedUploadedImage = null;
    state.selectedUploadedImagePath = "";
    state.selectedUploadedImageUrl = "";
    renderSelectedUploadedImage(elements);
    updateGenerateActionAvailability(elements);
  }

  function renderSelectedUploadedImage(elements) {
    const selected = state.selectedUploadedImage;

    if (!selected) {
      elements.selectedImagePreview.hidden = true;
      elements.selectedImagePreview.removeAttribute("src");
      elements.selectedImageEmpty.hidden = false;
      elements.selectedImageName.textContent = "No uploaded image selected";
      elements.selectedImagePath.textContent = "Refresh after the phone upload finishes.";
      return;
    }

    elements.selectedImagePreview.hidden = false;
    elements.selectedImagePreview.src = selected.previewUrl;
    elements.selectedImageEmpty.hidden = true;
    elements.selectedImageName.textContent = selected.name;
    elements.selectedImagePath.textContent = `${selected.path} • ${formatTimestamp(selected.createdAt)}`;
  }

  function renderUploadedImageStrip(elements) {
    elements.imageStrip.innerHTML = "";

    if (state.recentUploadedImages.length === 0) {
      const empty = document.createElement("div");
      empty.className = "assisted-selected-image-empty";
      empty.textContent = "No recent upload thumbnails available yet.";
      elements.imageStrip.appendChild(empty);
      return;
    }

    state.recentUploadedImages.forEach((image) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = `assisted-thumb${image.path === state.selectedUploadedImagePath ? " is-selected" : ""}`;
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(image.path === state.selectedUploadedImagePath));

      button.innerHTML = `
        <span class="assisted-thumb-image">
          <img src="${image.previewUrl}" alt="${escapeHtml(image.name)}" />
        </span>
        <span class="assisted-thumb-meta">
          <span class="assisted-thumb-name">${escapeHtml(image.name)}</span>
          <span class="assisted-thumb-subtext">${escapeHtml(formatTimestamp(image.createdAt))}</span>
          <span class="assisted-thumb-subtext">${escapeHtml(image.path)}</span>
        </span>
      `;

      button.addEventListener("click", () => {
        setSelectedUploadedImage(image.path, elements);
      });

      elements.imageStrip.appendChild(button);
    });
  }

  async function handleGenerateCopy(elements) {
    if (state.isGeneratingCopy) return;

    const generationInputs = collectAssistedWorkflowGenerationInputs(elements);
    if (!generationInputs.imagePath) {
      setInlineStatus(elements.generateStatus, "Select an uploaded image before generating copy.", "error");
      return;
    }

    if (!Number.isFinite(generationInputs.weight)) {
      setInlineStatus(elements.generateStatus, "Capture a stable weight before generating copy.", "error");
      return;
    }

    if (!generationInputs.material || !generationInputs.purity) {
      setInlineStatus(elements.generateStatus, "Choose material and purity before generating copy.", "error");
      return;
    }

    state.isGeneratingCopy = true;
    elements.generateCopyButton.disabled = true;
    elements.generateCopyButton.textContent = "Generating...";
    setInlineStatus(
      elements.generateStatus,
      "Generating inventory copy from the selected image, measured weight, and entered fields...",
      "waiting"
    );

    try {
      const response = await requestAIGenerationForSelectedImage(generationInputs);
      state.lastGeneratedCopy = response;
      elements.generatedTitleInput.value = response.generatedTitle || "";
      elements.generatedDescriptionInput.value = response.generatedDescription || "";

      const modeLabel = response.mode === "openai" ? "secure backend AI" : "secure backend placeholder";
      setInlineStatus(
        elements.generateStatus,
        `Generated copy is ready from ${modeLabel}. Review and edit it before using it in the Add Item form.`,
        "success"
      );
    } catch (error) {
      setInlineStatus(
        elements.generateStatus,
        `Unable to generate inventory copy: ${error?.message || error}`,
        "error"
      );
    } finally {
      state.isGeneratingCopy = false;
      elements.generateCopyButton.textContent = "Generate Title & Description";
      updateGenerateActionAvailability(elements);
    }
  }

  function collectAssistedWorkflowGenerationInputs(elements) {
    return {
      bucket: INVENTORY_UPLOAD_BUCKET,
      imagePath: state.selectedUploadedImagePath,
      imageUrl: state.selectedUploadedImageUrl,
      material: elements.materialSelect.value.trim(),
      purity: elements.puritySelect.value.trim(),
      weight: getCurrentWeight(elements),
      stoneType: elements.stoneTypeInput.value.trim(),
      notes: elements.notesInput.value.trim(),
      category: elements.categoryInput?.value?.trim() || "",
      qrType: elements.qrTypeSelect?.value?.trim() || "",
      existingTitle: elements.titleInput?.value?.trim() || "",
      existingDescription: elements.descriptionInput?.value?.trim() || "",
    };
  }

  async function requestAIGenerationForSelectedImage(payload) {
    const { data, error } = await window.supabase.functions.invoke(AI_COPY_FUNCTION_NAME, {
      body: payload,
    });

    if (error) throw error;
    if (!data?.generatedTitle || !data?.generatedDescription) {
      throw new Error("The copy generation function returned an incomplete response.");
    }

    return data;
  }

  function applyGeneratedCopyToMainForm(elements) {
    const generatedTitle = elements.generatedTitleInput.value.trim();
    const generatedDescription = elements.generatedDescriptionInput.value.trim();

    if (!generatedTitle && !generatedDescription) {
      setInlineStatus(elements.generateStatus, "Generate or enter title and description text before applying it.", "error");
      return;
    }

    if (generatedTitle) {
      elements.titleInput.value = generatedTitle;
      elements.titleInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    if (generatedDescription) {
      elements.descriptionInput.value = generatedDescription;
      elements.descriptionInput.dispatchEvent(new Event("input", { bubbles: true }));
    }

    window.showToast?.("Applied assisted title and description to the Add Item form.");
    setInlineStatus(
      elements.generateStatus,
      "Generated copy has been placed into the main Add Item title and description fields.",
      "success"
    );
  }

  async function triggerIPhoneCapture({ material, purity, weight }) {
    const payload = { material, purity, weight };

    // TODO: Replace this placeholder with the real desktop-to-phone transport contract.
    console.info("Placeholder iPhone capture trigger", payload);
    document.dispatchEvent(
      new CustomEvent("additem-assisted:iphone-capture-requested", {
        detail: payload,
      })
    );

    await delay(120);

    return {
      ok: true,
      message: `Placeholder signal sent for ${material} ${purity} at ${formatWeight(weight)}.`,
    };
  }

  function syncWeightToMainForm(weight, weightInput) {
    if (!weightInput) return;

    weightInput.value = weight.toFixed(2);
    weightInput.dispatchEvent(new Event("input", { bubbles: true }));
    weightInput.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function resetAssistedWorkflow(elements) {
    elements.materialSelect.value = "";
    updatePurityOptions("", elements.puritySelect);
    elements.puritySelect.value = "";
    elements.stoneTypeInput.value = "";
    elements.notesInput.value = "";

    state.hasLoadedImages = false;
    state.recentUploadedImages = [];
    state.selectedUploadedImage = null;
    state.selectedUploadedImagePath = "";
    state.selectedUploadedImageUrl = "";
    state.lastGeneratedCopy = null;

    resetWeightState(elements, {
      scaleMessage: "Waiting for a material and purity selection.",
      captureMessage: "Idle",
    });

    resetGeneratedCopyFields(elements);
    clearSelectedUploadedImage(elements);
    renderUploadedImageStrip(elements);
    setInlineStatus(elements.imageStatus, "Waiting for the assisted workflow to load recent uploads.", "");
    setActiveWorkflow("manual", elements);
  }

  function resetWeightState(elements, { scaleMessage, captureMessage }) {
    state.lastStableWeight = null;
    elements.weightDisplay.textContent = "—";
    elements.captureState.textContent = captureMessage;
    setScaleState(elements.scaleState, scaleMessage, "");
  }

  function resetGeneratedCopyFields(elements) {
    elements.generatedTitleInput.value = "";
    elements.generatedDescriptionInput.value = "";
    setInlineStatus(elements.generateStatus, "Ready when you have a selected uploaded image and a stable weight.", "");
    updateGenerateActionAvailability(elements);
  }

  function invalidateGeneratedCopy(elements, message) {
    const hadGeneratedCopy = Boolean(
      elements.generatedTitleInput.value.trim() || elements.generatedDescriptionInput.value.trim()
    );

    state.lastGeneratedCopy = null;

    if (hadGeneratedCopy) {
      elements.generatedTitleInput.value = "";
      elements.generatedDescriptionInput.value = "";
      setInlineStatus(elements.generateStatus, message, "");
    }
  }

  function updateGenerateActionAvailability(elements) {
    const hasSelectedImage = Boolean(state.selectedUploadedImagePath);
    const hasWeight = Number.isFinite(getCurrentWeight(elements));
    const hasMaterial = Boolean(elements.materialSelect.value.trim());
    const hasPurity = Boolean(elements.puritySelect.value.trim());
    const hasGeneratedCopy = Boolean(
      elements.generatedTitleInput.value.trim() || elements.generatedDescriptionInput.value.trim()
    );

    elements.generateCopyButton.disabled = state.isGeneratingCopy || !hasSelectedImage || !hasWeight || !hasMaterial || !hasPurity;
    elements.applyCopyButton.disabled = !hasGeneratedCopy;
  }

  function getCurrentWeight(elements) {
    if (typeof state.lastStableWeight === "number") return state.lastStableWeight;

    const parsedWeight = parseFloat(elements.weightInput?.value || "");
    return Number.isFinite(parsedWeight) ? parsedWeight : NaN;
  }

  function setScaleState(element, message, status) {
    element.textContent = message;
    element.classList.remove("is-waiting", "is-success", "is-error");

    if (status) {
      element.classList.add(`is-${status}`);
    }
  }

  function setInlineStatus(element, message, status) {
    element.textContent = message;
    element.classList.remove("is-waiting", "is-success", "is-error");

    if (status) {
      element.classList.add(`is-${status}`);
    }
  }

  function buildMockScaleReadings(material, purity) {
    const baseWeight = getDeterministicBaseWeight(material, purity);
    return [
      baseWeight - 0.42,
      baseWeight - 0.18,
      baseWeight - 0.08,
      baseWeight - 0.03,
      baseWeight - 0.01,
      baseWeight,
    ].map(roundWeight);
  }

  function getDeterministicBaseWeight(material, purity) {
    const seed = `${material}:${purity}`
      .split("")
      .reduce((total, char) => total + char.charCodeAt(0), 0);

    return 3.5 + ((seed % 950) / 100);
  }

  function isStableWindow(values, tolerance) {
    const max = Math.max(...values);
    const min = Math.min(...values);
    return (max - min) <= tolerance;
  }

  function average(values) {
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  function roundWeight(value) {
    return Number(value.toFixed(2));
  }

  function formatWeight(weight) {
    return `${weight.toFixed(2)} g`;
  }

  function formatTimestamp(value) {
    if (!value) return "Timestamp unavailable";

    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "Timestamp unavailable";

    return date.toLocaleString();
  }

  function escapeHtml(value) {
    return String(value || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    initAssistedWorkflow().catch((error) => {
      console.error("Failed to initialize assisted Add Item workflow:", error);
    });
  });
})();
