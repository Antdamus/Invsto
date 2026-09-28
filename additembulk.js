/* ================= Bulk Bag Modal Module ============= */
window.addItemBulkModule = (function () {
  let lastFocusedEl = null;
  let capturing = false;
  let bagPrinting = false;
  let lastBagLabel = null;
  let currentCapture = null;
  const captures = new Map();


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

    const haveWeights = state.tare_g !== null && state.tare_g >= 0 && state.gross_g !== null && state.gross_g > state.tare_g;
    const haveUnit = state.unit_used_g && state.unit_used_g > 0;

    state.net_g = haveWeights ? +(state.gross_g - state.tare_g).toFixed(4) : null;

    if (haveWeights && haveUnit) {
      const est = Math.floor(Math.round(state.net_g * 10000) / Math.round(state.unit_used_g * 10000));
      state.estimated_qty = Math.max(est, 0);
      state.residual_g = +(state.net_g - (state.estimated_qty * state.unit_used_g)).toFixed(4);
      state.valid = state.item_title.length > 0 && state.estimated_qty > 0 && state.estimated_qty <= 999999;
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
      if (!state.valid || capturing || bagPrinting) return;
      capturing=true;saveBtn.disabled=true;
      try {
        state.payload = buildPayload();
        const payload = {...state.payload};
        const bagPhoto = state.bagPhotoFile;
        const bagBarcode = generateBagBarcode();
        await prepareBagLabel(bagBarcode);
        currentCapture = {bag_barcode:bagBarcode,estimated_qty:payload.estimated_qty,payload,label:lastBagLabel,photo:bagPhoto};
        captures.set(bagBarcode,currentCapture);
        window.dispatchEvent(new CustomEvent("bulkbag:captured", {
          detail: {bag_barcode:bagBarcode,estimated_qty:currentCapture.estimated_qty,payload:{...currentCapture.payload}}
        }));
        closeModal();
        window.showToast?.(`Bulk bag captured (${payload.estimated_qty}).${lastBagLabel?'':' Label could not be prepared.'}`);
        if(lastBagLabel)await printCapturedBagLabel();
      } finally {capturing=false;recompute();}
    });
  }

  // called from the add-item flow after item_types insert
  async function saveRegistryForItem(itemTypeId, bagBarcode, locationId = null, placementMeta = null) {
    const captured = captures.get(bagBarcode);
    if (!captured) return bagBarcode ? {data:null,error:{message:'Captured bag details are unavailable. Reopen Bulk Bag.'}} : {skipped:true,data:null};
    // Each captured bag owns its measurements and assets, even after another capture.
    const label = captured.label;

    // 1) Upload the DYMO label (if one was generated during Save click)
    let bagLabelUrl = null;
    try {
      if (label?.barcode === bagBarcode) {
        const {error}=await supabase.storage.from('dymo-labels').upload(label.labelPath,new Blob([label.xml],{type:'application/octet-stream'}),{upsert:true,contentType:'application/octet-stream'});
        if(error)throw error;
        bagLabelUrl=label.labelPath;
      }
    } catch (e) {
      console.warn("⚠️ Bag label upload failed:", e);
    }

    // 2) (optional) upload the bag photo
    let bagPhotoUrl = null;
    try {
      if (captured.photo) {
        const safeName = captured.photo.name.replace(/[^\w.\-]+/g, "_");
        const path = `bag_photos/${bagBarcode}-${safeName}`;
        const { error: upErr } = await supabase
          .storage
          .from("photos")
          .upload(path, captured.photo, { upsert: true });
        if (upErr) throw upErr;
        bagPhotoUrl = path; // store raw path; sign on read
      }
    } catch (e) {
      console.warn("⚠️ Bag photo upload failed:", e);
    }

    // Registry, per-bag stock, audit and retry receipt commit together on the server.
    const {data: receipt,error} = await supabase.rpc('receive_bulk_bag',{
      _item_id:itemTypeId,_bag_barcode:bagBarcode,_location_id:locationId,
      _payload:captured.payload,_bag_label_url:bagLabelUrl,_bag_photo_url:bagPhotoUrl
    });
    if(error)return {data:null,error};
    if(!receipt?.bag?.id)return {data:null,error:{message:'Bag save was not confirmed. Retry the same captured bag.'}};
    return {data:receipt.bag,error:null,receipt};
  }

  function clearCapture() {
    currentCapture=null;lastBagLabel=null;state.payload=null;state.bagPhotoFile=null;
    const e=els();[e.itemTitle,e.tare,e.gross,e.unitOverride,...e.s,e.bagPhoto].forEach(input=>{if(input)input.value='';});
    if(e.bagPhotoPreview)e.bagPhotoPreview.replaceChildren();
    const printButton=document.getElementById('bulk-print-label');if(printButton)printButton.hidden=true;
    recompute();
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
    document.getElementById("bulk-print-label")?.addEventListener("click",printCapturedBagLabel);
  }

  // Build a QR payload for bags (distinct from item-type)
  function buildBagQr(bagBarcode) {
    // keep it simple; if you later want a deep link, replace this
    return `bag:${bagBarcode}`;
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

  async function prepareBagLabel(bagBarcode) {
    const statusEl=document.getElementById('bulk-dymo-status');
    const button=document.getElementById('bulk-print-label');
    lastBagLabel=null;
    if(button)button.hidden=true;
    try {
      if(!window.dymoModule?.generateAndUploadDymoLabel)throw new Error('Label module is unavailable.');
      const {templateXml,labelPath}=await dymoModule.generateAndUploadDymoLabel({barcode:bagBarcode,qr:`bag:${bagBarcode}`,price:'',typeqr:'bag'});
      lastBagLabel={xml:templateXml,labelPath,barcode:bagBarcode};
      window.latestDymoXml=templateXml;window.latestDymoUrl=labelPath;window.latestDymoBarcode=bagBarcode;
      window.latestDymoGeneratedAt=new Date().toISOString();
      if(button){button.hidden=false;button.disabled=false;button.textContent=`Print bag label ${bagBarcode}`;}
      if(statusEl)statusEl.textContent='Bag label prepared. It will be saved with the bag.';
    } catch(error) {
      if(statusEl)statusEl.textContent=error.message || 'Could not prepare the bag label.';
    }
  }

  async function printCapturedBagLabel() {
    if(!lastBagLabel || bagPrinting)return;
    bagPrinting=true;
    const label=lastBagLabel,button=document.getElementById('bulk-print-label'),statusEl=document.getElementById('bulk-dymo-status');
    if(button)button.disabled=true;
    try {
      const result=await window.dymoModule.printDymoLabelXml(label.xml,{barcode:label.barcode,title:`Bulk bag ${label.barcode}`,labelKind:'BagLabel',listenerOnly:true});
      const message=window.printStations.deliveryMessage(result);
      if(statusEl)statusEl.textContent=message;window.showToast?.(message);
      return result;
    } catch(error) {
      const message=`Bag details are retained. ${error.message || 'Could not send the label.'} Reopen Bulk Bag and use Print bag label to try again.`;
      if(statusEl)statusEl.textContent=message;window.showToast?.(message);
    } finally {bagPrinting=false;if(button)button.disabled=false;}
  }

  return {
    setupBulkModalOpeners,
    openModal,
    closeModal,
    saveRegistryForItem, // call this after item is created
    getCapturedBag: () => currentCapture,
    clearCapture,
    generateBagBarcode,   
  };
})();


