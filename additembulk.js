/* ================= Bulk Bag Modal Module ============= */
window.addItemBulkModule = (function () {
  let lastFocusedEl = null;

  // local state for the modal
  const state = {
    touched: false,
    valid: false,
    item_title: "",
    tare_g: null,
    gross_g: null,
    samples: [null, null, null, null, null],
    unit_override_g: null,
    unit_avg_g: null,
    unit_used_g: null,
    net_g: null,
    estimated_qty: null,
    residual_g: null,
    payload: null, // what we'll insert after item creation
  };

  // ------- dom helpers -------
  function els() {
    const modal = document.getElementById("modal-bulk-bag");
    return {
      openBtn: document.getElementById("open-bulk-modal"),
      modal,
      closeBtn: document.getElementById("close-bulk-modal"),
      cancelBtn: document.getElementById("bulk-cancel"),
      saveBtn: document.getElementById("bulk-save"),

      itemTitle: document.getElementById("bulk-item-title"),
      tare: document.getElementById("bulk-tare"),
      gross: document.getElementById("bulk-gross"),
      s: [
        document.getElementById("bulk-s1"),
        document.getElementById("bulk-s2"),
        document.getElementById("bulk-s3"),
        document.getElementById("bulk-s4"),
        document.getElementById("bulk-s5"),
      ],
      unitOverride: document.getElementById("bulk-unit-override"),

      unitAvg: document.getElementById("bulk-unit-avg"),
      unitUsed: document.getElementById("bulk-unit-used"),
      net: document.getElementById("bulk-net"),
      estQty: document.getElementById("bulk-estimated-qty"),
      residual: document.getElementById("bulk-residual"),
    };
  }

  function numberOrNull(v) {
    const n = parseFloat(String(v ?? "").trim());
    return Number.isFinite(n) ? n : null;
  }

  // ------- compute + UI reflect -------
  function recompute() {
    const e = els();
    state.touched = true;

    state.item_title = e.itemTitle?.value?.trim() || "";
    state.tare_g = numberOrNull(e.tare?.value);
    state.gross_g = numberOrNull(e.gross?.value);

    // samples
    const rawSamples = e.s.map(inp => numberOrNull(inp?.value));
    const validSamples = rawSamples.filter(n => n !== null && n > 0);
    state.samples = rawSamples;
    state.unit_avg_g = validSamples.length >= 3
      ? +(validSamples.reduce((a,b)=>a+b,0) / validSamples.length).toFixed(4)
      : null;

    // override
    state.unit_override_g = numberOrNull(e.unitOverride?.value);
    const overrideValid = state.unit_override_g && state.unit_override_g > 0;

    // unit used
    state.unit_used_g = overrideValid ? state.unit_override_g : state.unit_avg_g;

    const haveWeights = state.tare_g !== null && state.gross_g !== null && state.gross_g > state.tare_g;
    const haveUnit = state.unit_used_g && state.unit_used_g > 0;

    state.net_g = haveWeights ? +(state.gross_g - state.tare_g).toFixed(4) : null;

    if (haveWeights && haveUnit) {
      const est = Math.floor(state.net_g / state.unit_used_g);
      state.estimated_qty = Math.max(est, 0);
      state.residual_g = +(state.net_g - (state.estimated_qty * state.unit_used_g)).toFixed(4);
      state.valid = state.item_title.length > 0;
    } else {
      state.estimated_qty = null;
      state.residual_g = null;
      state.valid = false;
    }

    // reflect
    e.unitAvg.textContent = state.unit_avg_g ?? "—";
    e.unitUsed.textContent = state.unit_used_g ?? "—";
    e.net.textContent = state.net_g ?? "—";
    e.estQty.textContent = state.estimated_qty ?? "—";
    e.residual.textContent = state.residual_g ?? "—";

    e.saveBtn?.toggleAttribute("disabled", !state.valid);
  }

  function prefillFromMainTitle() {
    const mainTitle = document.getElementById("title")?.value?.trim() || "";
    const e = els();
    if (e.itemTitle && !e.itemTitle.value) e.itemTitle.value = mainTitle;
  }

  function buildPayload() {
    if (!state.valid) return null;
    return {
      // item_type_id: (fill later)
      // bag_barcode:  (fill later)
      // location_id:  (optional; fill later)
      tare_weight_g: state.tare_g,
      gross_weight_g: state.gross_g,
      sample_w1_g: state.samples[0],
      sample_w2_g: state.samples[1],
      sample_w3_g: state.samples[2],
      sample_w4_g: state.samples[3],
      sample_w5_g: state.samples[4],
      unit_override_g: state.unit_override_g,
      unit_source: state.unit_override_g && state.unit_override_g > 0 ? "override" : "samples",
      unit_weight_g: state.unit_used_g,
      estimated_qty: state.estimated_qty,
      // residual_g is generated in DB
      notes: null
    };
  }

  // save button in the modal only captures values (no DB insert yet)
  function handleSaveClick() {
    const { saveBtn } = els();
    saveBtn?.addEventListener("click", () => {
      if (!state.valid) return;
      state.payload = buildPayload();
      window.showToast?.("✅ Bulk data captured — will be saved with the item.");
      closeModal();
    });
  }

  // called from the add-item flow after item_types insert
  async function saveRegistryForItem(itemTypeId, bagBarcode, locationId = null) {
    if (!state.payload) return { skipped: true, data: null };

    const row = {
      ...state.payload,
      item_type_id: itemTypeId,
      bag_barcode: bagBarcode,
      location_id: locationId
    };

    const { data, error } = await supabase
      .from("bulk_batches")
      .insert(row)
      .select()
      .single();

    if (error) {
      console.error("❌ bulk_batches insert failed:", error);
      return { error, data: null };
    }
    return { error: null, data };
  }

  // ------- open/close & wiring -------
  function openModal() {
    const { modal } = els();
    if (!modal) return;
    lastFocusedEl = document.activeElement;
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");
    prefillFromMainTitle();
    recompute();
    modal.querySelector("input.bulk-input")?.focus();
  }

  function closeModal() {
    const { modal } = els();
    if (!modal) return;
    modal.classList.add("hidden");
    document.body.classList.remove("modal-open");
    lastFocusedEl?.focus?.();
    lastFocusedEl = null;
  }

  function handleBackdropClick(e) {
    const { modal } = els();
    if (e.target === modal) closeModal();
  }

  function handleEsc(e) {
    const { modal } = els();
    if (!modal || modal.classList.contains("hidden")) return;
    if (e.key === "Escape") closeModal();
  }

  function wireInputs() {
    const e = els();
    const inputs = [e.itemTitle, e.tare, e.gross, e.unitOverride, ...e.s].filter(Boolean);
    inputs.forEach(inp => inp.addEventListener("input", recompute));
  }

  // Make a unique, bag-only barcode (ephemeral)
    function generateBagBarcode() {
        // Example: BAG-<base36 timestamp>-<4 random>
        const ts = Date.now().toString(36).toUpperCase();
        const rnd = Math.random().toString(36).slice(2, 6).toUpperCase();
        return `BAG-${ts}-${rnd}`;
    }


  function setupBulkModalOpeners() {
    const { openBtn, modal, closeBtn, cancelBtn } = els();
    if (!openBtn || !modal) {
      console.warn("Bulk modal elements not found; skipping init.");
      return;
    }
    openBtn.addEventListener("click", openModal);
    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);
    modal.addEventListener("click", handleBackdropClick);
    document.addEventListener("keydown", handleEsc);

    wireInputs();
    handleSaveClick();
  }

  return {
    setupBulkModalOpeners,
    openModal,
    closeModal,
    saveRegistryForItem, // call this after item is created
    generateBagBarcode,   
  };
})();


