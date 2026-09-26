(() => {
  const form = document.getElementById("add-item-form");
  if (!form) return;

  // Mobile keyboards can shrink the visible area without resizing the layout viewport.
  function updateVisibleHeight() {
    document.documentElement.style.setProperty("--item-visible-height", `${window.visualViewport?.height || window.innerHeight}px`);
    document.documentElement.style.setProperty("--item-visible-top", `${window.visualViewport?.offsetTop || 0}px`);
  }
  window.visualViewport?.addEventListener("resize", updateVisibleHeight);
  window.visualViewport?.addEventListener("scroll", updateVisibleHeight);
  window.addEventListener("resize", updateVisibleHeight);
  updateVisibleHeight();

  const allSteps = [...form.querySelectorAll("[data-item-step]")];
  let steps = [...allSteps];
  const links = [...form.querySelectorAll("[data-item-step-target]")];
  const names = {information:"Identify", photos:"Photos", pricing:"Pricing", stock:"Stock", marketplace:"eBay", review:"Review"};
  let returnToReview = false;
  const back = document.getElementById("item-step-back");
  const next = document.getElementById("item-step-next");
  const error = document.getElementById("item-step-error");
  const watchKeys = ["name", "brand", "model", "department", "condition", "materials", "modifications"];
  const coinLabels = { name: "Name / series", year: "Year / date", country: "Issuing country", denomination: "Denomination", mint: "Mint / mint mark", metal: "Metal", fineness: "Purity (parts per 1,000)", condition: "Reported condition", variety: "Variety / reference", finish: "Strike / finish", fineMetalContent: "Fine metal content", composition: "Composition details", gradingStatus: "Grading status", grade: "Grade as stated", gradingService: "Grading service", certNumber: "Certification number", notes: "Condition notes / alterations" };
  const coinKeys = Object.keys(coinLabels);
  let current = 0;
  let furthest = 0;
  let jewelryAutoCost = true;

  const categoryInput = document.getElementById("category");
  const categoryToggle = document.getElementById("category-dropdown-toggle");
  const categoryPlaceholder = "Select or Create Category";
  function setCategory(category, { notify = true } = {}) {
    const selected = String(category ?? "").trim();
    const label = selected || categoryPlaceholder;
    const changed = categoryInput.value !== selected || categoryToggle.textContent.trim() !== label;
    categoryInput.value = selected;
    categoryToggle.textContent = label;
    if (changed && notify) {
      categoryInput.dispatchEvent(new Event("input", { bubbles: true }));
      categoryInput.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return selected;
  }
  function getCategory() {
    // Recover a visible selection left by an older draft/browser restore before validating it.
    const label = categoryToggle.textContent.trim();
    const selected = categoryInput.value.trim() || (label !== categoryPlaceholder ? label : "");
    return setCategory(selected, { notify: false });
  }
  window.addItemCategory = { get: getCategory, set: setCategory };
  const value = (id) => id === "category" ? getCategory() : document.getElementById(id)?.value?.trim() || "";
  const isWatch = () => form.querySelector('[name="item-kind"]:checked')?.value === "watch";
  const isCoin = () => form.querySelector('[name="item-kind"]:checked')?.value === "coin";
  const usesDirectPricing = () => isWatch() || isCoin();
  const getCoinDetails = () => {
    if (!isCoin()) return null;
    const coin = Object.fromEntries(coinKeys.map((key) => [key, value(`coin-${key}`)]));
    if (document.getElementById("coin-fineness").disabled) coin.fineness = "";
    if (coin.gradingStatus === "ungraded") coin.grade = "";
    if (coin.gradingStatus !== "certified") { coin.gradingService = ""; coin.certNumber = ""; }
    const ebay = window.coinEbayForm?.getDetails();
    if (ebay) coin.ebay = ebay;
    return coin;
  };
  const getWatchDetails = () => {
    if (!isWatch()) return null;
    const details = Object.fromEntries(watchKeys.map((key) => [key, value(`watch-${key}`)]));
    details.name = details.name || details.brand;
    const referenceLookup = window.addItemAssistedModule?.getWatchReferenceLookup?.();
    return referenceLookup ? { ...details, referenceLookup } : details;
  };

  function descriptionForSave() {
    const description = value("description");
    const coin = getCoinDetails();
    if (coin) {
      const statusNames = { ungraded: "Raw / ungraded", "self-assessed": "Seller-assessed (not third-party graded)", certified: "Third-party graded (as entered)" };
      const details = ["Coin details:", ...coinKeys.filter((key) => coin[key]).map((key) => `${coinLabels[key]}: ${key === "gradingStatus" ? statusNames[coin[key]] : coin[key]}`)].join("\n");
      return [description, details].filter(Boolean).join("\n\n");
    }
    const watch = getWatchDetails();
    if (!watch) return description;
    const details = [
      "Watch details:",
      `Name: ${watch.name}`,
      watch.brand && `Brand: ${watch.brand}`,
      watch.department && `Department: ${watch.department}`,
      watch.model && `Model / reference: ${watch.model}`,
      watch.materials && `Materials by component: ${watch.materials}`,
      watch.modifications && `Modifications / customizations: ${watch.modifications}`,
    ].filter(Boolean).join("\n");
    return [description, details].filter(Boolean).join("\n\n");
  }

  function updateMode({ restoring = false } = {}) {
    const watch = isWatch();
    const coin = isCoin();
    const directPricing = watch || coin;
    document.getElementById("coin-fields").hidden = !coin;
    coinKeys.forEach((key) => { document.getElementById(`coin-${key}`).disabled = !coin; });
    document.getElementById("coin-name").required = coin;
    updateCoinGrading();
    document.getElementById("watch-fields").hidden = !watch;
    document.getElementById("jewelry-material-fields").hidden = directPricing;
    watchKeys.forEach((key) => { document.getElementById(`watch-${key}`).disabled = !watch; });
    document.getElementById("watch-name").required = false;
    document.getElementById("weight").required = !directPricing;
    document.getElementById("item-weight-label").textContent = directPricing ? "Total weight (g, optional)" : "Weight (g)";
    document.getElementById("description").required = !directPricing;
    document.getElementById("watch-description-note").hidden = !watch;
    document.getElementById("use-watch-details").hidden = !watch;
    document.getElementById("coin-description-note").hidden = !coin;
    document.getElementById("use-coin-details").hidden = !coin;
    ["assisted-stone-type", "assisted-length"].forEach((id) => { document.getElementById(id).closest("label").hidden = coin; });

    const autoCost = document.getElementById("auto-cost-checkbox");
    if (directPricing && !autoCost.disabled && !restoring) jewelryAutoCost = autoCost.checked;
    autoCost.checked = directPricing ? false : jewelryAutoCost;
    autoCost.disabled = directPricing;
    document.getElementById("price-per-weight").disabled = directPricing;
    const salePrice = document.getElementById("sale-price");
    salePrice.readOnly = false;
    salePrice.required = true;
    salePrice.placeholder = "Enter retail price ($)";
    salePrice.inputMode = "decimal";
    document.dispatchEvent(new CustomEvent("add-item:mode-change", { detail: { isWatch: watch, isCoin: coin, restoring } }));
    document.getElementById("item-coin-photo-guide").hidden = !coin;
    document.getElementById("price-per-weight").closest("label").hidden = directPricing;
    document.getElementById("auto-cost-checkbox").closest(".form-field").hidden = directPricing;
    const category = getCategory();
    if (!category || (!restoring && ["Watches", "Coins"].includes(category))) {
      setCategory(watch ? "Watches" : coin ? "Coins" : "", { notify: !restoring });
    }
    rebuildRoute();
    renderReview();
  }

  function updateCoinGrading() {
    const coin = isCoin();
    const status = value("coin-gradingStatus");
    const grade = document.getElementById("coin-grade");
    grade.disabled = !coin || status === "ungraded";
    grade.required = coin && status !== "ungraded";
    const service = document.getElementById("coin-gradingService");
    service.disabled = !coin || status !== "certified";
    service.required = coin && status === "certified";
    document.getElementById("coin-certNumber").disabled = !coin || status !== "certified";
    document.getElementById("coin-fineness").disabled = !coin || !value("coin-metal") || ["Plated / clad", "Other / mixed"].includes(value("coin-metal"));
  }

  function rebuildRoute() {
    const active = steps[current]?.dataset.itemStep || 'information';
    steps = allSteps.filter(step => (step.dataset.itemStep !== 'marketplace' || document.getElementById('ebay-sync-enabled').checked)
      && (step.dataset.itemStep !== 'stock' || document.getElementById('item-assign-stock').checked));
    current = Math.max(0, steps.findIndex(step=>step.dataset.itemStep === active));
    showStep(current, {focus:false,persist:false});
  }

  function renderReview() {
    const summary = document.getElementById('item-review-summary');
    const photos = window.addItemAssistedModule?.getSelectedUploadedImagesForSave?.() || [];
    const rows = [
      ['Item', value('title') || (getWatchDetails()?.name) || getCoinDetails()?.name || 'Not entered','information'],
      ['Category',value('category') || 'Not selected','information'],
      ['Cost',value('cost') ? `$${value('cost')}` : 'Not entered','pricing'],
      ['Minimum sale',value('minimum-sale-price') ? `$${value('minimum-sale-price')}` : 'Not set','pricing'],
      ['Retail',value('sale-price') ? `$${value('sale-price')}` : 'Not entered','pricing'],
      ['Barcode',value('scanned-barcode') || 'Generated when saving','information'],
      ['Stock',!document.getElementById('item-assign-stock').checked || document.getElementById('assignment-preview-box').classList.contains('hidden') ? 'Not assigned' : ['assignment-location','assignment-quantity'].map(id=>document.getElementById(id).textContent).join(' · '),'stock'],
      ['eBay',document.getElementById('ebay-sync-enabled').checked ? document.getElementById('ebay-category-id').selectedOptions[0]?.textContent || 'Choose category' : 'Inventory only','marketplace'],
    ];
    summary.replaceChildren();
    for (const [label,text,target] of rows) {
      const row=document.createElement('div'),term=document.createElement('dt'),detail=document.createElement('dd'),edit=document.createElement('button');
      term.textContent=label;detail.textContent=text;edit.type='button';edit.textContent='Edit';edit.className='intake-review-edit';edit.setAttribute('aria-label',`Edit ${label}`);
      edit.addEventListener('click',()=>goTo(target,true));row.append(term,detail,edit);summary.append(row);
    }
    const gallery=document.getElementById('item-review-photos');gallery.replaceChildren();
    for (const photo of photos.slice(0,4)) {
      const img=document.createElement('img');img.src=photo.thumbnailUrl || photo.previewUrl || '';img.alt=photo.name || 'Item photo';gallery.append(img);
    }
    const photoEdit=document.createElement('button');photoEdit.type='button';photoEdit.textContent=`Edit photos (${photos.length})`;photoEdit.className='add-button-secondary';photoEdit.addEventListener('click',()=>goTo('photos',true));gallery.append(photoEdit);
    const issues=document.getElementById('item-review-issues');issues.replaceChildren();
    const readiness=window.collectAddItemEbayReadiness?.();
    if (readiness?.syncEnabled && readiness.missing.length) {
      const text=document.createElement('p');text.textContent='You can save this item to inventory. Before publishing to eBay, complete:';issues.append(text);
      for (const missing of [...new Set(readiness.missing)]) {
        const target=/stock/.test(missing)?'stock':/photo/.test(missing)?'photos':/price/.test(missing)?'pricing':/title|description/.test(missing)?'review':/brand|department|watch condition|material|purity|stone/.test(missing)?'information':'marketplace';
        const button=document.createElement('button');button.type='button';button.textContent=missing;button.addEventListener('click',()=>goTo(target,true));issues.append(button);
      }
    }
  }

  function showStep(index, {focus=true,persist=true}={}) {
    current=Math.max(0,Math.min(index,steps.length-1));furthest=Math.max(furthest,current);
    const active=steps[current];
    allSteps.forEach(step=>step.hidden=step!==active);
    links.forEach(link=>{
      const i=steps.findIndex(step=>step.dataset.itemStep===link.dataset.itemStepTarget);
      link.closest('li').hidden=i<0;
      link.disabled=i>furthest;link.querySelector('span').textContent=String(i+1);
      if(i===current)link.setAttribute('aria-current','step');else link.removeAttribute('aria-current');
      link.classList.toggle('is-visited',i<furthest);
    });
    document.querySelector('.item-progress ol').style.setProperty('--item-step-count',steps.length);
    back.disabled=current===0;next.hidden=current===steps.length-1;
    next.textContent=returnToReview?'Return to review':`Next: ${names[steps[current+1]?.dataset.itemStep] || 'Review'}`;
    document.getElementById('item-step-status').textContent=`Step ${current+1} of ${steps.length} · ${names[active.dataset.itemStep]}`;
    document.getElementById('item-step-hint').textContent=current===steps.length-1?'Review before saving':next.textContent;
    error.hidden=true;
    if(active.dataset.itemStep==='review')renderReview();
    if(focus){active.querySelector('h2')?.focus({preventScroll:true});form.scrollIntoView({block:'start',behavior:'instant'});}
    document.dispatchEvent(new CustomEvent('add-item:step-change',{detail:{step:active.dataset.itemStep}}));
    if(persist)document.dispatchEvent(new Event('add-item:wizard-change'));
  }

  function goTo(key, editing=false) {
    if(form.dataset.saving==='true')return;
    if(key==='stock' && !document.getElementById('item-assign-stock').checked){document.getElementById('item-assign-stock').checked=true;rebuildRoute();}
    if(key==='marketplace' && !document.getElementById('ebay-sync-enabled').checked){document.getElementById('ebay-sync-enabled').checked=true;document.getElementById('item-prepare-ebay').checked=true;rebuildRoute();}
    returnToReview=editing && key!=='review';
    const index=steps.findIndex(step=>step.dataset.itemStep===key);
    if(index>=0)showStep(index);
  }

  function fail(index, control, message) {
    showStep(index);
    error.textContent = message;
    error.hidden = false;
    // An optional disclosure may contain an invalid number or URL.
    let parent = control?.parentElement;
    while (parent && parent !== form) {
      if (parent.tagName === "DETAILS") parent.open = true;
      parent = parent.parentElement;
    }
    control?.focus();
    control?.reportValidity?.();
    return false;
  }

  function validateStep(index) {
    const key = steps[index].dataset.itemStep;
    if (key === "photos" && window.addItemAssistedModule?.isPhotoBusy?.()) {
      return fail(index, null, "Wait for the photo upload or processing to finish before continuing.");
    }
    for (const control of steps[index].querySelectorAll("input, select, textarea")) {
      if (control.disabled || !control.willValidate) continue;
      // Inactive workflow panels and mode-specific fields do not block progress.
      if (control.closest("[hidden]") && !control.closest("[hidden]").matches("[data-item-step]")) continue;
      if (!control.checkValidity()) return fail(index, control, "Complete the highlighted field to continue.");
      if (control.required && !control.value.trim()) return fail(index, control, "Enter a value to continue.");
    }
    if (key === "information" && !value("category")) {
      return fail(index, document.getElementById("category-dropdown-toggle"), "Select or create an item category.");
    }
    if (key === "pricing") {
      const price = Number(value("sale-price").replace(/,/g, ""));
      if (!Number.isFinite(price) || price <= 0) return fail(index, document.getElementById("sale-price"), "Enter a retail price greater than zero.");
    }
    if (key === "pricing" && value("minimum-sale-price")) {
      const minimum = Number(value("minimum-sale-price"));
      const retail = Number(value("sale-price").replace(/,/g, ""));
      if (!Number.isFinite(minimum) || minimum < 0 || minimum > retail) return fail(index, document.getElementById("minimum-sale-price"), "Minimum sale price must be between zero and retail price.");
    }
    if (key === "marketplace" && document.getElementById("ebay-sync-enabled").checked && !value("ebay-category-id")) {
      return fail(index, document.getElementById("ebay-category-id"), "Choose an eBay category or turn off eBay sync.");
    }
    if (key === 'information' && isWatch() && !value('watch-name') && !value('watch-brand')) return fail(index,document.getElementById('watch-brand'),'Enter the watch brand or model name.');
    if (key === 'information' && window.addItemBarcodeMatch) return fail(index,document.getElementById('scanned-barcode'),'This barcode already exists. Add quantity to that item or generate a new barcode.');
    if (key === 'stock' && document.getElementById('assignment-preview-box').classList.contains('hidden')) return fail(index,document.getElementById('btn-open-admin-stock'),'Assign and confirm a location, or turn off stock placement in Identify.');
    return true;
  }

  function moveTo(index) {
    if (form.dataset.saving === "true") return;
    if (index > current) {
      for (let i = current; i < index; i += 1) if (!validateStep(i)) return;
    }
    if (isWatch()) fillWatchTitle();
    if (isCoin()) fillCoinTitle();
    if(!isWatch() && !isCoin()){
      const material=document.getElementById('assisted-material').value,purity=document.getElementById('assisted-purity').value;
      if(!value('title'))document.getElementById('title').value=[purity,material,value('category')].filter(Boolean).join(' ');
      if(!value('description'))document.getElementById('description').value=[value('category'),material && `Material: ${purity} ${material}.`,value('weight') && `Weight: ${value('weight')} g.`].filter(Boolean).join(' ');
    }
    showStep(index);
  }

  function fillWatchTitle(overwrite = false) {
    const watch = getWatchDetails();
    const title = document.getElementById("title");
    if (!watch || (!overwrite && value("title") && title.value !== title.dataset.watchTitle && title.value !== title.dataset.coinTitle)) return;
    const name = watch.name.toLowerCase().startsWith(watch.brand.toLowerCase()) ? watch.name : [watch.brand,watch.name].filter(Boolean).join(" ");
    title.value = [name, watch.model].filter(Boolean).join(" ");
    title.dataset.watchTitle = title.value;
    title.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function fillCoinTitle(overwrite = false) {
    const coin = getCoinDetails();
    const title = document.getElementById("title");
    if (!coin || (!overwrite && value("title") && title.value !== title.dataset.coinTitle && title.value !== title.dataset.watchTitle)) return;
    title.value = [coin.year, coin.name, coin.mint, coin.gradingStatus === "certified" && coin.gradingService, coin.grade && `${coin.grade}${coin.gradingStatus === "self-assessed" ? " (seller assessed)" : ""}`].filter(Boolean).join(" ");
    title.dataset.coinTitle = title.value;
    title.dispatchEvent(new Event("input", { bubbles: true }));
  }

  back.addEventListener("click", () => moveTo(current - 1));
  next.addEventListener("click", () => { if(returnToReview){if(validateStep(current)){returnToReview=false;moveTo(steps.length-1);}}else moveTo(current+1); });
  links.forEach(link => link.addEventListener("click", () => { returnToReview=false;moveTo(steps.findIndex(step=>step.dataset.itemStep===link.dataset.itemStepTarget)); }));
  form.querySelectorAll('[name="item-kind"]').forEach((radio) => radio.addEventListener("change", () => updateMode()));
  document.getElementById("use-watch-details").textContent = "Use watch name as title";
  document.getElementById("use-watch-details").addEventListener("click", () => fillWatchTitle(true));
  document.getElementById("use-coin-details").addEventListener("click", () => fillCoinTitle(true));
  document.getElementById("coin-gradingStatus").addEventListener("change", updateCoinGrading);
  document.getElementById("coin-metal").addEventListener("change", updateCoinGrading);
  document.addEventListener("add-item-assisted:metadata-change", () => {
    if (current === steps.length - 1) renderReview();
  });

  // Run before the existing save handler. Enter on an earlier step only advances.
  form.addEventListener("submit", (event) => {
    if (current !== steps.length - 1) {
      event.preventDefault();
      event.stopImmediatePropagation();
      moveTo(current + 1);
      return;
    }
    for (let i = 0; i < steps.length; i += 1) {
      if (!validateStep(i)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
  }, true);

  document.addEventListener("add-item-form:reset", () => {
    setCategory("", { notify: false });
    returnToReview=false;
    jewelryAutoCost = true;
    delete document.getElementById("sale-price").dataset.manualRetail;
    furthest = 0;
    delete document.getElementById("title").dataset.watchTitle;
    delete document.getElementById("title").dataset.coinTitle;
    updateMode({ restoring: true });
    showStep(0, { focus: false, persist: false });
  });

  window.addItemWizard = {
    goTo, renderReview, rebuildRoute,
    isWatch,
    isCoin,
    usesDirectPricing,
    getWatchDetails,
    getCoinDetails,
    descriptionForSave,
    getDraft: () => ({
      version: 2,
      assignStock: document.getElementById("item-assign-stock").checked,
      autoCopy: document.getElementById("item-auto-copy").checked,
      step: steps[current].dataset.itemStep,
      furthest,
      itemKind: isWatch() ? "watch" : isCoin() ? "coin" : "jewelry",
      coinDetails: { ...Object.fromEntries(coinKeys.map((key) => [key, value(`coin-${key}`)])), ebay: window.coinEbayForm?.getDetails() },
      watchDetails: Object.fromEntries(watchKeys.map((key) => [key, value(`watch-${key}`)])),
      manualRetail: document.getElementById("sale-price").dataset.manualRetail === "true",
      autoCost: document.getElementById("auto-cost-checkbox").checked,
      autoWatchTitle: document.getElementById("title").dataset.watchTitle || "",
      autoCoinTitle: document.getElementById("title").dataset.coinTitle || "",
      jewelryAutoCost: usesDirectPricing() ? jewelryAutoCost : document.getElementById("auto-cost-checkbox").checked,
    }),
    restoreDraft: (draft = {}) => {
      document.getElementById("item-assign-stock").checked = Boolean(draft.assignStock);
      document.getElementById("item-auto-copy").checked = draft.autoCopy !== false;
      document.getElementById("item-prepare-ebay").checked = document.getElementById("ebay-sync-enabled").checked;
      const kind = ["watch", "coin"].includes(draft.itemKind) ? draft.itemKind : "jewelry";
      form.querySelector(`[name="item-kind"][value="${kind}"]`).checked = true;
      watchKeys.forEach((key) => { document.getElementById(`watch-${key}`).value = draft.watchDetails?.[key] || ""; });
      coinKeys.forEach((key) => { document.getElementById(`coin-${key}`).value = draft.coinDetails?.[key] || (key === "gradingStatus" ? "ungraded" : ""); });
      window.coinEbayForm?.reset(draft.coinDetails || {}, kind === "coin");
      document.getElementById("title").dataset.watchTitle = draft.autoWatchTitle || "";
      document.getElementById("title").dataset.coinTitle = draft.autoCoinTitle || "";
      document.getElementById("sale-price").dataset.manualRetail = String(Boolean(draft.manualRetail));
      jewelryAutoCost = (draft.jewelryAutoCost ?? draft.autoCost) !== false;
      updateMode({ restoring: true });
      furthest = Math.max(0, Math.min(Number(draft.furthest) || 0, steps.length - 1));
      const restoredStep = ["description", "labels"].includes(draft.step) ? "review" : draft.step;
      const index = steps.findIndex((step) => step.dataset.itemStep === restoredStep);
      showStep(index < 0 ? 0 : index, { focus: false, persist: false });
    },
  };
  document.getElementById('item-prepare-ebay').addEventListener('change',event=>{
    const enabled=document.getElementById('ebay-sync-enabled');enabled.checked=event.target.checked;enabled.dispatchEvent(new Event('change',{bubbles:true}));rebuildRoute();document.dispatchEvent(new Event('add-item:wizard-change'));
  });
  document.getElementById('ebay-sync-enabled').addEventListener('change',()=>{document.getElementById('item-prepare-ebay').checked=document.getElementById('ebay-sync-enabled').checked;rebuildRoute();});
  document.getElementById('item-assign-stock').addEventListener('change',()=>{rebuildRoute();document.dispatchEvent(new Event('add-item:wizard-change'));});
  document.getElementById('item-auto-copy').addEventListener('change',()=>document.dispatchEvent(new Event('add-item:wizard-change')));
  document.addEventListener('coin-ebay:change',()=>{if(steps[current]?.dataset.itemStep==='review')renderReview();});
  form.addEventListener('input',()=>{if(steps[current]?.dataset.itemStep==='review')renderReview();});
  updateMode({ restoring: true });
  showStep(0, { focus: false, persist: false });
})();
