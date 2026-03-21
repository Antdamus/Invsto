(function () {
  const MATERIAL_PURITY_MAP = Object.freeze({
    Gold: ["10K", "14K", "18K", "22K", "24K"],
    Silver: ["925", "950", "Fine Silver"],
    Platinum: ["850", "900", "950", "999"],
    "Stainless Steel": ["316L", "304"],
  });

  const state = {
    activeWorkflow: "manual",
    isReadingWeight: false,
    lastStableWeight: null,
  };

  function getElements() {
    return {
      manualTab: document.getElementById("workflow-tab-manual"),
      assistedTab: document.getElementById("workflow-tab-assisted"),
      manualPanel: document.getElementById("workflow-panel-manual"),
      assistedPanel: document.getElementById("workflow-panel-assisted"),
      materialSelect: document.getElementById("assisted-material"),
      puritySelect: document.getElementById("assisted-purity"),
      readWeightButton: document.getElementById("assisted-read-weight"),
      scaleState: document.getElementById("assisted-scale-state"),
      weightDisplay: document.getElementById("assisted-weight-display"),
      captureState: document.getElementById("assisted-capture-state"),
      weightInput: document.getElementById("weight"),
    };
  }

  function initAssistedWorkflow() {
    const elements = getElements();
    if (!elements.manualTab || !elements.assistedTab || !elements.materialSelect) {
      return;
    }

    populateMaterialOptions(elements.materialSelect);
    updatePurityOptions(elements.materialSelect.value, elements.puritySelect);
    bindWorkflowTabs(elements);
    bindAssistedInputs(elements);

    document.addEventListener("add-item-form:reset", () => {
      resetAssistedWorkflow(elements);
    });
  }

  function populateMaterialOptions(materialSelect) {
    const materialOptions = Object.keys(MATERIAL_PURITY_MAP)
      .map((material) => `<option value="${material}">${material}</option>`)
      .join("");

    materialSelect.innerHTML = `<option value="">Select material</option>${materialOptions}`;
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
      tabButton.addEventListener("click", () => {
        const target = tabButton.dataset.workflowTarget;
        setActiveWorkflow(target, elements);
      });
    });
  }

  function setActiveWorkflow(target, elements) {
    const isManual = target === "manual";
    state.activeWorkflow = isManual ? "manual" : "assisted";

    elements.manualTab.classList.toggle("is-active", isManual);
    elements.assistedTab.classList.toggle("is-active", !isManual);
    elements.manualTab.setAttribute("aria-selected", String(isManual));
    elements.assistedTab.setAttribute("aria-selected", String(!isManual));

    elements.manualPanel.hidden = !isManual;
    elements.assistedPanel.hidden = isManual;
  }

  function bindAssistedInputs(elements) {
    elements.materialSelect.addEventListener("change", () => {
      updatePurityOptions(elements.materialSelect.value, elements.puritySelect);
      elements.puritySelect.value = "";
      resetWeightState(elements, {
        scaleMessage: "Select a purity, then request a stable weight reading.",
        captureMessage: "Idle",
      });
    });

    elements.puritySelect.addEventListener("change", () => {
      resetWeightState(elements, {
        scaleMessage: "Ready to read from the scale placeholder.",
        captureMessage: "Idle",
      });
    });

    elements.readWeightButton.addEventListener("click", async () => {
      await handleReadWeight(elements);
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
      const stableWeight = await readStableWeightFromScale({ material, purity, scaleStateEl: elements.scaleState });
      state.lastStableWeight = stableWeight;
      elements.weightDisplay.textContent = formatWeight(stableWeight);
      syncWeightToMainForm(stableWeight, elements.weightInput);

      const payload = { material, purity, weight: stableWeight };
      setScaleState(
        elements.scaleState,
        `Stable weight captured at ${formatWeight(stableWeight)} and synced into the Add Item weight field.`,
        "success"
      );

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
    const windowSize = 3;
    const tolerance = 0.03;
    const rollingWindow = [];

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
    resetWeightState(elements, {
      scaleMessage: "Waiting for a material and purity selection.",
      captureMessage: "Idle",
    });
    setActiveWorkflow("manual", elements);
  }

  function resetWeightState(elements, { scaleMessage, captureMessage }) {
    state.lastStableWeight = null;
    elements.weightDisplay.textContent = "—";
    elements.captureState.textContent = captureMessage;
    setScaleState(elements.scaleState, scaleMessage, "");
  }

  function setScaleState(element, message, status) {
    element.textContent = message;
    element.classList.remove("is-waiting", "is-success", "is-error");

    if (status) {
      element.classList.add(`is-${status}`);
    }
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

  function delay(ms) {
    return new Promise((resolve) => {
      window.setTimeout(resolve, ms);
    });
  }

  document.addEventListener("DOMContentLoaded", initAssistedWorkflow);
})();
