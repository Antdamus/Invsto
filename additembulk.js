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
    bagPhotoFile : null,
  };

  // ------- dom helpers -------
  function els() {
    const modal = document.getElementById("modal-bulk-bag");
    const bagPhoto = document.getElementById("bulk-bag-photo");
    const bagPhotoPreview = document.getElementById("bulk-bag-photo-preview");
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
      bagPhoto,
      bagPhotoPreview,
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
    saveBtn?.addEventListener("click", async () => {
      if (!state.valid) return;

      // Build payload and keep in memory
      state.payload = buildPayload();

      // Create a bag barcode now so the label matches this bag
      const bagBarcode =
        window.addItemBulkModule?.generateBagBarcode?.() ||
        `BAG-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,6).toUpperCase()}`;

      // ⚡ Generate & DOWNLOAD the label immediately (user gesture-safe)
      await generateAndDownloadBagLabel(bagBarcode);

      // Notify Add-Inventory (or whoever listens)
      window.dispatchEvent(new CustomEvent("bulkbag:captured", {
        detail: {
          bag_barcode: bagBarcode,
          estimated_qty: state.estimated_qty,
          payload: state.payload
        }
      }));

      window.showToast?.(`👜 Bulk bag captured (${state.estimated_qty}). Label generated.`);
      closeModal();
    });
  }

  // called from the add-item flow after item_types insert
  async function saveRegistryForItem(itemTypeId, bagBarcode, locationId = null, placementMeta = null) {
    if (!state.payload) return { skipped: true, data: null };

    // 1) Upload the DYMO label (if one was generated during Save click)
    let bagLabelUrl = null;
    try {
      if (
        window.dymoModule?.uploadFinalDymoLabel &&
        window.latestDymoXml &&
        window.latestDymoUrl &&
        window.latestDymoBarcode === bagBarcode
      ) {
        bagLabelUrl = await dymoModule.uploadFinalDymoLabel(); // uses latestDymoXml/Url
      }
    } catch (e) {
      console.warn("⚠️ Bag label upload failed:", e);
    }

    // 2) (optional) upload the bag photo
    let bagPhotoUrl = null;
    try {
      if (state.bagPhotoFile) {
        const safeName = state.bagPhotoFile.name.replace(/[^\w.\-]+/g, "_");
        const path = `bag_photos/${bagBarcode}-${Date.now()}-${safeName}`;
        const { error: upErr } = await supabase
          .storage
          .from("photos")
          .upload(path, state.bagPhotoFile, { upsert: true });
        if (upErr) throw upErr;
        bagPhotoUrl = path; // store raw path; sign on read
      }
    } catch (e) {
      console.warn("⚠️ Bag photo upload failed:", e);
    }

    // 3) insert the bulk batch row with label+photo
    const { data: bag, error: bagErr } = await supabase
      .from("bulk_batches")
      .insert({
        ...state.payload,               // weights, unit_used_g, estimated_qty, etc.
        item_type_id: itemTypeId,       // (keep item_id if your column is named that)
        bag_barcode: bagBarcode,
        location_id: locationId,
        bag_label_url: bagLabelUrl,
        bag_photo_url: bagPhotoUrl
      })
      .select()
      .single();
    if (bagErr) return { data: null, error: bagErr };

    // 4) per-bag STOCK row (only if you already collect a location here)
    if (locationId) {
      const { error: stockErr } = await supabase
        .from("item_stock_locations")
        .insert({
          item_id: itemTypeId,          // ← matches your table FK
          location_id: locationId,
          batch_id: bag.id,             // tie this stock to THIS bag
          quantity: state.estimated_qty,
          added_by: window.currentUser?.id || null,
          confirmation_email: placementMeta?.signed_by_email || window.currentUser?.email || null,
          confirmation_method: placementMeta?.confirmation_method || "password_stock_placement",
          confirmed_at: placementMeta?.signed_at || new Date().toISOString()
        });
      if (stockErr) {
        console.warn("⚠️ bag stock insert failed:", stockErr);
        // we still return the bag so the caller can decide what to do
      } else {
        const { error: stockTxErr } = await supabase
          .from("stock_transactions")
          .insert({
            item_id: itemTypeId,
            location_id: locationId,
            quantity: state.estimated_qty,
            action_type: "checkin",
            confirmed_at: placementMeta?.signed_at || new Date().toISOString(),
            user_id: window.currentUser?.id || null,
            email: placementMeta?.signed_by_email || window.currentUser?.email || null,
            notes: `Add item bulk stock placement into ${placementMeta?.placement_type || "location"} ${placementMeta?.location_name || locationId}`,
            method: placementMeta?.confirmation_method || "password_stock_placement",
            timestamp: placementMeta?.signed_at || new Date().toISOString()
          });
        if (stockTxErr) {
          console.warn("⚠️ bag stock transaction insert failed:", stockTxErr);
        }
      }
    }

    return { data: bag, error: null };
  }

  // ------- open/close & wiring -------
  function openModal(defaultTitle = "") {
    const { modal, itemTitle } = els();
    if (!modal) return;
    lastFocusedEl = document.activeElement;
    modal.classList.remove("hidden");
    document.body.classList.add("modal-open");

    // Prefill title when provided (Add Inventory flow)
    if (defaultTitle && itemTitle && !itemTitle.value) {
      itemTitle.value = defaultTitle;
    }

    recompute(); // will enable Save if title/weights are valid
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
    if (!modal) {
      console.warn("Bulk modal element not found; skipping init.");
      return;
    }
    if (openBtn) openBtn.addEventListener("click", openModal);
    closeBtn?.addEventListener("click", closeModal);
    cancelBtn?.addEventListener("click", closeModal);
    modal.addEventListener("click", handleBackdropClick);
    document.addEventListener("keydown", handleEsc);

    wireInputs();
    wirePhotoInput();    // ← add this line
    handleSaveClick();
  }

  // Build a QR payload for bags (distinct from item-type)
  function buildBagQr(bagBarcode) {
    // keep it simple; if you later want a deep link, replace this
    return `bag:${bagBarcode}`;
  }

  // Generate and upload the DYMO label for a BAG barcode
  async function generateAndUploadBagLabel(bagBarcode) {
    // If DYMO isn't available on this page, skip gracefully
    if (!window.dymoModule?.generateAndUploadDymoLabel) return null;

    const qr = `bag:${bagBarcode}`;
    const typeqr = "bag";
    const price = ""; // not used for bags

    // Reuse the exact same template generator you use for items
    const { templateXml, labelPath } = await dymoModule.generateAndUploadDymoLabel({
      barcode: bagBarcode, qr, price, typeqr
    });

    // Upload to storage (same bucket you use for labels)
    const blob = new Blob([templateXml], { type: "application/octet-stream" });
    const { error: uploadError } = await supabase
      .storage
      .from("dymo-labels")
      .upload(labelPath, blob, { upsert: true, contentType: "application/octet-stream" });
    if (uploadError) throw uploadError;

    // Optional: auto-download so you can print immediately
    try {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "OGJewelry-BagLabel.dymo";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (_) {}

    return labelPath; // save this into bulk_batches.bag_label_url
  }

  function wirePhotoInput() {
    const { bagPhoto, bagPhotoPreview } = els();
    if (!bagPhoto || !bagPhotoPreview) return;

    bagPhoto.addEventListener("change", () => {
      bagPhotoPreview.innerHTML = "";
      state.bagPhotoFile = null;

      const file = bagPhoto.files?.[0];
      if (!file) return;

      state.bagPhotoFile = file;

      const reader = new FileReader();
      reader.onload = (e) => {
        const div = document.createElement("div");
        div.className = "thumb";
        div.innerHTML = `<img src="${e.target.result}" alt="Bag photo preview" />`;
        bagPhotoPreview.appendChild(div);
      };
      reader.readAsDataURL(file);
    });
  }

  // Generate and DOWNLOAD a DYMO label for a bag barcode (uses your existing module)
  // This mirrors your Add-Item flow: download now, upload later.
  async function generateAndDownloadBagLabel(bagBarcode) {
    const statusEl = document.getElementById("bulk-dymo-status");
    if (!window.dymoModule?.generateAndUploadDymoLabel) {
      statusEl && (statusEl.textContent = "ℹ️ DYMO module not loaded; skipping label generation.");
      return { labelPath: null, downloaded: false };
    }

    const qr = `bag:${bagBarcode}`;
    const typeqr = "bag";
    const price = ""; // not used for bags

    // Reuse the same generator
    const { templateXml, labelPath } = await dymoModule.generateAndUploadDymoLabel({
      barcode: bagBarcode, qr, price, typeqr
    });

    // Auto-download (same as your Add-Item flow)
    try {
      const blob = new Blob([templateXml], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "OGJewelry-BagLabel.dymo";
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);

      // Store in globals so we can upload later with the SAME helper
      window.latestDymoXml = templateXml;
      window.latestDymoUrl = labelPath;
      window.latestDymoBarcode = bagBarcode;
      window.latestDymoGeneratedAt = new Date().toISOString();

      statusEl && (statusEl.textContent = "✅ DYMO label generated & downloaded. It will be saved on submit.");
      return { labelPath, downloaded: true };
    } catch (e) {
      statusEl && (statusEl.textContent = "⚠️ DYMO label generated, but download failed.");
      return { labelPath, downloaded: false };
    }
  }

  return {
    setupBulkModalOpeners,
    openModal,
    closeModal,
    saveRegistryForItem, // call this after item is created
    generateBagBarcode,   
  };
})();


