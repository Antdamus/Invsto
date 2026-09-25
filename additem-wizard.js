(() => {
  const form = document.getElementById("add-item-form");
  if (!form) return;

  const steps = [...form.querySelectorAll("[data-item-step]")];
  const links = [...form.querySelectorAll("[data-item-step-target]")];
  const names = ["Information", "Photos", "Description", "Pricing", "Labels", "Stock", "Marketplace", "Review"];
  const back = document.getElementById("item-step-back");
  const next = document.getElementById("item-step-next");
  const error = document.getElementById("item-step-error");
  const watchKeys = ["name", "model", "materials", "modifications"];
  let current = 0;
  let furthest = 0;
  let jewelryAutoCost = true;

  const value = (id) => document.getElementById(id)?.value?.trim() || "";
  const isWatch = () => form.querySelector('[name="item-kind"]:checked')?.value === "watch";
  const getWatchDetails = () => {
    if (!isWatch()) return null;
    const details = Object.fromEntries(watchKeys.map((key) => [key, value(`watch-${key}`)]));
    const referenceLookup = window.addItemAssistedModule?.getWatchReferenceLookup?.();
    return referenceLookup ? { ...details, referenceLookup } : details;
  };

  function descriptionForSave() {
    const description = value("description");
    const watch = getWatchDetails();
    if (!watch) return description;
    const details = [
      "Watch details:",
      `Name: ${watch.name}`,
      watch.model && `Model / reference: ${watch.model}`,
      watch.materials && `Materials by component: ${watch.materials}`,
      watch.modifications && `Modifications / customizations: ${watch.modifications}`,
    ].filter(Boolean).join("\n");
    return [description, details].filter(Boolean).join("\n\n");
  }

  function updateMode({ restoring = false } = {}) {
    const watch = isWatch();
    document.getElementById("watch-fields").hidden = !watch;
    document.getElementById("jewelry-material-fields").hidden = watch;
    watchKeys.forEach((key) => { document.getElementById(`watch-${key}`).disabled = !watch; });
    document.getElementById("watch-name").required = watch;
    document.getElementById("weight").required = !watch;
    document.getElementById("item-weight-label").textContent = watch ? "Total weight (g, optional)" : "Weight (g)";
    document.getElementById("description").required = !watch;
    document.getElementById("watch-description-note").hidden = !watch;
    document.getElementById("use-watch-details").hidden = !watch;

    const autoCost = document.getElementById("auto-cost-checkbox");
    if (watch && !autoCost.disabled && !restoring) jewelryAutoCost = autoCost.checked;
    autoCost.checked = watch ? false : jewelryAutoCost;
    autoCost.disabled = watch;
    document.getElementById("price-per-weight").disabled = watch;
    const salePrice = document.getElementById("sale-price");
    salePrice.readOnly = !watch;
    salePrice.required = watch;
    salePrice.placeholder = watch ? "Enter sale price ($)" : "Sale Price (auto)";
    salePrice.inputMode = "decimal";
    document.dispatchEvent(new CustomEvent("add-item:mode-change", { detail: { isWatch: watch, restoring } }));
    renderReview();
  }

  function renderReview() {
    const summary = document.getElementById("item-review-summary");
    const selectedPhotos = window.addItemAssistedModule?.getSelectedUploadedImagesForSave?.() || [];
    const watch = getWatchDetails();
    const rows = [
      ["Mode", watch ? "Watch" : "Jewelry"],
      ["Title", value("title") || "Not entered"],
      ["Category", value("category") || "Not selected"],
      ["Description", descriptionForSave() || "Not entered"],
      ["Weight", value("weight") ? `${value("weight")} g` : "Not entered"],
      ["Photos", `${selectedPhotos.length} selected`],
      ["Cost", value("cost") ? `$${value("cost")}` : "Not entered"],
      ["Sale price", value("sale-price") ? `$${value("sale-price")}` : "Not entered"],
      ["Barcode", value("scanned-barcode") || "Generated when saving"],
      ["Stock", document.getElementById("assignment-preview-box").classList.contains("hidden")
        ? "No placement assigned" : ["assignment-location", "assignment-quantity"].map((id) => document.getElementById(id).textContent).join(" · ")],
      ["eBay sync", document.getElementById("ebay-sync-enabled").checked
        ? document.getElementById("ebay-category-id").selectedOptions[0]?.textContent || "Choose a category"
        : "Off"],
    ];
    summary.replaceChildren();
    for (const [label, text] of rows) {
      const row = document.createElement("div");
      const term = document.createElement("dt");
      const detail = document.createElement("dd");
      term.textContent = label;
      detail.textContent = text;
      row.append(term, detail);
      summary.append(row);
    }
  }

  function showStep(index, { focus = true, persist = true } = {}) {
    current = Math.max(0, Math.min(index, steps.length - 1));
    furthest = Math.max(furthest, current);
    steps.forEach((step, i) => { step.hidden = i !== current; });
    links.forEach((link, i) => {
      link.disabled = i > furthest;
      if (i === current) link.setAttribute("aria-current", "step");
      else link.removeAttribute("aria-current");
      link.classList.toggle("is-visited", i < furthest);
    });
    back.disabled = current === 0;
    next.hidden = current === steps.length - 1;
    next.textContent = `Next: ${names[current + 1] || "Review"}`;
    document.getElementById("item-step-status").textContent = `Step ${current + 1} of ${steps.length} · ${names[current]}`;
    document.getElementById("item-step-hint").textContent = current === steps.length - 1 ? "Ready to save" : `Up next: ${names[current + 1]}`;
    error.hidden = true;
    if (current === steps.length - 1) renderReview();
    if (focus) {
      steps[current].querySelector("h2")?.focus({ preventScroll: true });
      form.scrollIntoView({ block: "start", behavior: "instant" });
    }
    if (persist) document.dispatchEvent(new Event("add-item:wizard-change"));
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
    if (index === 1 && window.addItemAssistedModule?.isPhotoBusy?.()) {
      return fail(index, null, "Wait for the photo upload or processing to finish before continuing.");
    }
    for (const control of steps[index].querySelectorAll("input, select, textarea")) {
      if (control.disabled || !control.willValidate) continue;
      // Inactive workflow panels and mode-specific fields do not block progress.
      if (control.closest("[hidden]") && !control.closest("[hidden]").matches("[data-item-step]")) continue;
      if (!control.checkValidity()) return fail(index, control, "Complete the highlighted field to continue.");
      if (control.required && !control.value.trim()) return fail(index, control, "Enter a value to continue.");
    }
    if (index === 0 && !value("category")) {
      return fail(index, document.getElementById("category-dropdown-toggle"), "Select or create an item category.");
    }
    if (index === 3 && isWatch()) {
      const price = Number(value("sale-price").replace(/,/g, ""));
      if (!Number.isFinite(price) || price <= 0) return fail(index, document.getElementById("sale-price"), "Enter a sale price greater than zero.");
    }
    if (index === 6 && document.getElementById("ebay-sync-enabled").checked && !value("ebay-category-id")) {
      return fail(index, document.getElementById("ebay-category-id"), "Choose an eBay category or turn off eBay sync.");
    }
    return true;
  }

  function moveTo(index) {
    if (form.dataset.saving === "true") return;
    if (index > current) {
      for (let i = current; i < index; i += 1) if (!validateStep(i)) return;
    }
    if (isWatch()) fillWatchTitle();
    showStep(index);
  }

  function fillWatchTitle(overwrite = false) {
    const watch = getWatchDetails();
    const title = document.getElementById("title");
    if (!watch || (!overwrite && value("title") && title.value !== title.dataset.watchTitle)) return;
    title.value = [watch.name, watch.model].filter(Boolean).join(" ");
    title.dataset.watchTitle = title.value;
    title.dispatchEvent(new Event("input", { bubbles: true }));
  }

  back.addEventListener("click", () => moveTo(current - 1));
  next.addEventListener("click", () => moveTo(current + 1));
  links.forEach((link, i) => link.addEventListener("click", () => moveTo(i)));
  form.querySelectorAll('[name="item-kind"]').forEach((radio) => radio.addEventListener("change", () => updateMode()));
  document.getElementById("use-watch-details").textContent = "Use watch name as title";
  document.getElementById("use-watch-details").addEventListener("click", () => fillWatchTitle(true));
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
    jewelryAutoCost = true;
    furthest = 0;
    delete document.getElementById("title").dataset.watchTitle;
    updateMode({ restoring: true });
    showStep(0, { focus: false, persist: false });
  });

  window.addItemWizard = {
    isWatch,
    getWatchDetails,
    descriptionForSave,
    getDraft: () => ({
      step: steps[current].dataset.itemStep,
      furthest,
      itemKind: isWatch() ? "watch" : "jewelry",
      watchDetails: Object.fromEntries(watchKeys.map((key) => [key, value(`watch-${key}`)])),
      autoCost: document.getElementById("auto-cost-checkbox").checked,
      autoWatchTitle: document.getElementById("title").dataset.watchTitle || "",
      jewelryAutoCost: isWatch() ? jewelryAutoCost : document.getElementById("auto-cost-checkbox").checked,
    }),
    restoreDraft: (draft = {}) => {
      const kind = draft.itemKind === "watch" ? "watch" : "jewelry";
      form.querySelector(`[name="item-kind"][value="${kind}"]`).checked = true;
      watchKeys.forEach((key) => { document.getElementById(`watch-${key}`).value = draft.watchDetails?.[key] || ""; });
      document.getElementById("title").dataset.watchTitle = draft.autoWatchTitle || "";
      jewelryAutoCost = (draft.jewelryAutoCost ?? draft.autoCost) !== false;
      updateMode({ restoring: true });
      furthest = Math.max(0, Math.min(Number(draft.furthest) || 0, steps.length - 1));
      const index = steps.findIndex((step) => step.dataset.itemStep === draft.step);
      showStep(index < 0 ? 0 : index, { focus: false, persist: false });
    },
  };
  updateMode({ restoring: true });
  showStep(0, { focus: false, persist: false });
})();
